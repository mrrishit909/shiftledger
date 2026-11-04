// Strict JSON/CSV import and report export. No network, no file-system access.
import { canonicalJson } from './canonical.js';
import { parseCsv, toCsv } from './csv.js';
import { reviewSnapshot } from './decisions.js';
import { argumentError } from './engine.js';
import { LIMITS, TABLES, validateDataset } from './validate.js';

export const EXPORT_SCHEMA = 'shiftledger.export.v1';
const PERSON_COLS = ['personId', 'externalId'];
const PERSON_TABLES = ['schedule', 'payroll', 'agency', 'reported'];
export const CSV_COLUMNS = Object.freeze({
  facilities: ['id', 'timezone'],
  persons: ['id'],
  identityAliases: ['source', 'externalId', 'personId'],
  classifications: ['personId', 'localRole', 'configuredReportRole', 'effectiveFrom', 'effectiveTo'],
  sourceSelections: ['facilityId', 'personId', 'effectiveFrom', 'effectiveTo', 'sourceType'],
  schedule: ['id', 'facilityId', ...PERSON_COLS, 'date', 'role', 'minutes'],
  payroll: ['id', 'facilityId', ...PERSON_COLS, 'date', 'role', 'minutes', 'status'],
  agency: ['id', 'facilityId', ...PERSON_COLS, 'date', 'role', 'minutes', 'status'],
  reported: ['id', 'facilityId', ...PERSON_COLS, 'date', 'role', 'minutes', 'sourceReference'],
});
const INT_RE = /^(0|[1-9]\d*)$/;
const BUNDLE_FIELDS = ['schemaVersion', 'datasetId', 'rules', 'tables'];
const fail = (code, path, message) => ({ ok: false, errors: [{ code, path, message }] });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));

function checkBytes(text, path) {
  if (typeof text !== 'string') return fail('INVALID_INPUT', path, 'input must be a string');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > LIMITS.maxBytes) return fail('SIZE_LIMIT_EXCEEDED', path, `input is ${bytes} bytes; limit is ${LIMITS.maxBytes}`);
  return null;
}

/** Parse and validate a JSON dataset (max 1 MiB). Atomic: dataset or errors. */
export function importDatasetJson(text) {
  const bad = checkBytes(text, '$');
  if (bad) return bad;
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { return fail('INVALID_JSON', '$', e.message); }
  return validateDataset(parsed);
}

/**
 * Parse and validate a CSV dataset: one CSV text per table, with the exact header in
 * CSV_COLUMNS. Combined size max 1 MiB. Empty cells mean "absent".
 * @param {{schemaVersion:string, datasetId:string, rules:object, tables:Record<string,string>}} input
 */
export function importDatasetCsv(input) {
  if (!isPlainObject(input) || !Object.hasOwn(input, 'tables') || !isPlainObject(input.tables)) return fail('INVALID_INPUT', '$', 'expected { schemaVersion, datasetId, rules, tables }');
  for (const k of Reflect.ownKeys(input)) if (!BUNDLE_FIELDS.includes(k)) return fail('UNKNOWN_FIELD', `$.${String(k)}`, `unknown field "${String(k)}"`);
  const tables = input.tables;
  for (const k of Reflect.ownKeys(tables)) if (!TABLES.includes(k)) return fail('UNKNOWN_TABLE', `tables.${String(k)}`, `unknown table "${String(k)}"`);
  // Metadata is read once, from own properties only, and counts toward the byte budget.
  const meta = {};
  for (const k of ['schemaVersion', 'datasetId', 'rules']) if (Object.hasOwn(input, k)) meta[k] = input[k];
  let total;
  try { total = Buffer.byteLength(JSON.stringify(meta) ?? '', 'utf8'); } catch { return fail('INVALID_INPUT', '$', 'schemaVersion, datasetId and rules must be JSON-serializable'); }
  const texts = {};
  for (const t of TABLES) {
    const text = Object.hasOwn(tables, t) ? tables[t] : undefined;
    if (typeof text !== 'string') return fail('MISSING_TABLE', `tables.${t}`, `CSV text for "${t}" is required (header only for an empty table)`);
    texts[t] = text;
    total += Buffer.byteLength(text, 'utf8');
  }
  if (total > LIMITS.maxBytes) return fail('SIZE_LIMIT_EXCEEDED', '$', `CSV input (tables plus metadata) is ${total} bytes; limit is ${LIMITS.maxBytes}`);
  const dataset = { ...meta };
  const errors = [];
  for (const t of TABLES) {
    let rows;
    try { rows = parseCsv(texts[t]); } catch (e) { errors.push({ code: 'CSV_PARSE', path: `tables.${t}`, message: e.message }); continue; }
    const cols = CSV_COLUMNS[t];
    const header = rows.shift() ?? [];
    if (header.join(',') !== cols.join(',')) { errors.push({ code: 'CSV_HEADER', path: `tables.${t}`, message: `header must be exactly: ${cols.join(',')}` }); continue; }
    if (rows.length > LIMITS.maxRows) { errors.push({ code: 'ROW_LIMIT_EXCEEDED', path: `tables.${t}`, message: `${rows.length} rows; limit is ${LIMITS.maxRows}` }); continue; }
    dataset[t] = [];
    rows.forEach((cells, i) => {
      if (cells.length !== cols.length) { errors.push({ code: 'CSV_ROW_WIDTH', path: `tables.${t}[${i}]`, message: `expected ${cols.length} cells, got ${cells.length}` }); return; }
      const obj = {};
      cols.forEach((c, j) => {
        const cell = cells[j];
        if (cell === '') return;
        obj[c] = c === 'minutes' && INT_RE.test(cell) ? Number(cell) : cell;
      });
      dataset[t].push(obj);
    });
  }
  if (errors.length) return { ok: false, errors };
  return validateDataset(dataset);
}

// Dataset exports re-validate their input and serialize only the normalized result, so a
// malformed or inherited object throws TypeError (code INVALID_DATASET) instead of exporting.
function validated(dataset) {
  const v = validateDataset(dataset);
  if (!v.ok) throw argumentError('INVALID_DATASET', `dataset failed validation: ${v.errors.slice(0, 3).map((e) => `${e.code} at ${e.path}`).join('; ')}`);
  return v.dataset;
}

function tableCsv(ds, table) {
  const cols = CSV_COLUMNS[table];
  // Evidence rows resolved through an alias are written in their original externalId-only form.
  const viaAlias = (r, c) => c === 'personId' && PERSON_TABLES.includes(table) && r.externalId;
  return toCsv(cols, ds[table].map((r) => cols.map((c) => (viaAlias(r, c) ? null : r[c] ?? null))));
}

/** Serialize one table of a valid dataset to CSV (round-trips through importDatasetCsv). */
export function exportTableCsv(dataset, table) {
  if (typeof table !== 'string' || !TABLES.includes(table)) throw argumentError('INVALID_ARGUMENT', `table must be one of ${TABLES.join(', ')}`);
  return tableCsv(validated(dataset), table);
}

/** Canonical JSON of the normalized dataset; importDatasetJson restores it exactly. */
export function exportDatasetJson(dataset) {
  return canonicalJson(validated(dataset));
}

/** CSV bundle of the normalized dataset in the shape importDatasetCsv accepts. */
export function exportDatasetCsv(dataset) {
  const ds = validated(dataset);
  return {
    schemaVersion: ds.schemaVersion,
    datasetId: ds.datasetId,
    rules: structuredClone(ds.rules),
    tables: Object.fromEntries(TABLES.map((t) => [t, tableCsv(ds, t)])),
  };
}

/**
 * Canonical JSON export of report, decisions and readiness. Always certified:false. Only an
 * engine-minted report is accepted (TypeError code UNTRUSTED_REPORT otherwise).
 */
export function exportReportJson(report, decisions) {
  const snap = reviewSnapshot(report, decisions);
  return canonicalJson({
    exportSchema: EXPORT_SCHEMA,
    certified: false,
    readiness: snap.readiness,
    report,
    decisions: snap.decisions,
  });
}

export const REPORT_CSV_COLUMNS = Object.freeze(['recordType', 'id', 'code', 'facilityId', 'personId', 'date', 'role', 'minutes', 'unit', 'rowIds', 'relatedRowIds', 'detail', 'note']);

/**
 * Flat formula-safe CSV export. Integer minute columns are raw integers. Reviewer notes
 * get their own column so free text can never be confused with key=value detail.
 */
export function exportReportCsv(report, decisions) {
  const snap = reviewSnapshot(report, decisions);
  const rows = [];
  const p = report.provenance;
  const r = snap.readiness;
  rows.push(['META', report.reportId, 'REPORT', null, null, null, null, null, null, null, null, `datasetId=${p.datasetId};datasetHash=${p.datasetHash};engine=${report.engineVersion};certified=false;readiness=${r.status}`]);
  rows.push(['RULES', p.rules.rulesetId, 'FICTIONAL_RULES', null, null, null, null, p.rules.toleranceMinutes, 'minutes', null, null, `approvalStatus=${p.rules.approvalStatus};reportableRoles=${p.rules.reportableRoles.join('|')};eligibleStatuses=${p.rules.eligibleStatuses.join('|')}`]);
  for (const [k, v] of Object.entries(report.totals)) if (k !== 'unit') rows.push(['TOTAL', k, null, null, null, null, null, v, 'minutes', null, null, null]);
  for (const k of ['matched', 'classificationConflict', 'unsupported', 'selectionRequired', 'configurationRequired', 'conflictingReferenceExcluded']) rows.push(['PARTITION', k, null, null, null, null, null, report.partition[k], 'minutes', null, null, null]);
  for (const f of report.findings) rows.push(['FINDING', f.id, f.code, f.facilityId, f.personId, f.date, f.role, f.minutes, 'minutes', f.rowIds.join('|'), f.relatedRowIds.join('|'), f.message]);
  for (const c of report.context) rows.push(['CONTEXT', c.id, c.code, c.facilityId, c.personId, c.date, c.role, c.minutes, 'minutes', c.rowIds.join('|'), c.relatedRowIds.join('|'), c.message]);
  for (const s of report.sourceStatuses) rows.push(['SOURCE', s.id, s.sourceType, s.facilityId, s.personId, s.date, s.mappedRole ?? s.localRole, s.minutes, 'minutes', null, null, `status=${s.status};eligibleMinutes=${s.eligibleMinutes};exclusions=${s.exclusions.join('|')}`]);
  for (const d of snap.decisions) rows.push(['DECISION', d.decisionId, d.decision, null, null, null, null, null, null, d.findingId, null, `reviewer=${d.reviewerId};at=${d.decidedAt};effect=${d.effect}`, d.note]);
  return toCsv(REPORT_CSV_COLUMNS, rows.map((r) => (r.length < REPORT_CSV_COLUMNS.length ? [...r, null] : r)));
}

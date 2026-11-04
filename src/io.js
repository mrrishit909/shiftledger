// Strict JSON/CSV import and report export. No network, no file-system access.
import { canonicalJson } from './canonical.js';
import { parseCsv, toCsv } from './csv.js';
import { readiness } from './decisions.js';
import { LIMITS, TABLES, validateDataset } from './validate.js';

export const EXPORT_SCHEMA = 'shiftledger.export.v1';
const PERSON_COLS = ['personId', 'externalId'];
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
const fail = (code, path, message) => ({ ok: false, errors: [{ code, path, message }] });

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
  if (input === null || typeof input !== 'object' || typeof input.tables !== 'object' || input.tables === null) return fail('INVALID_INPUT', '$', 'expected { schemaVersion, datasetId, rules, tables }');
  for (const k of Object.keys(input.tables)) if (!TABLES.includes(k)) return fail('UNKNOWN_TABLE', `tables.${k}`, `unknown table "${k}"`);
  let total = 0;
  for (const t of TABLES) {
    const text = input.tables[t];
    if (typeof text !== 'string') return fail('MISSING_TABLE', `tables.${t}`, `CSV text for "${t}" is required (header only for an empty table)`);
    total += Buffer.byteLength(text, 'utf8');
  }
  if (total > LIMITS.maxBytes) return fail('SIZE_LIMIT_EXCEEDED', 'tables', `CSV input is ${total} bytes; limit is ${LIMITS.maxBytes}`);
  const dataset = { schemaVersion: input.schemaVersion, datasetId: input.datasetId, rules: input.rules };
  const errors = [];
  for (const t of TABLES) {
    let rows;
    try { rows = parseCsv(input.tables[t]); } catch (e) { errors.push({ code: 'CSV_PARSE', path: `tables.${t}`, message: e.message }); continue; }
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

/** Serialize a validated dataset table to CSV (round-trips through importDatasetCsv). */
export function exportTableCsv(dataset, table) {
  const cols = CSV_COLUMNS[table];
  return toCsv(cols, dataset[table].map((r) => cols.map((c) => (c === 'personId' && r.externalId ? null : r[c] ?? null))));
}

/** Canonical JSON export of report, decisions and readiness. Always certified:false. */
export function exportReportJson(report, decisions = []) {
  return canonicalJson({
    exportSchema: EXPORT_SCHEMA,
    certified: false,
    readiness: readiness(report, decisions),
    report,
    decisions: decisions.filter((d) => d.reportId === report.reportId),
  });
}

export const REPORT_CSV_COLUMNS = Object.freeze(['recordType', 'id', 'code', 'facilityId', 'personId', 'date', 'role', 'minutes', 'unit', 'rowIds', 'relatedRowIds', 'detail']);

/** Flat formula-safe CSV export. Integer minute columns are raw integers. */
export function exportReportCsv(report, decisions = []) {
  const rows = [];
  const p = report.provenance;
  const r = readiness(report, decisions);
  rows.push(['META', report.reportId, 'REPORT', null, null, null, null, null, null, null, null, `datasetId=${p.datasetId};datasetHash=${p.datasetHash};engine=${report.engineVersion};certified=false;readiness=${r.status}`]);
  rows.push(['RULES', p.rules.rulesetId, 'FICTIONAL_RULES', null, null, null, null, p.rules.toleranceMinutes, 'minutes', null, null, `approvalStatus=${p.rules.approvalStatus};reportableRoles=${p.rules.reportableRoles.join('|')};eligibleStatuses=${p.rules.eligibleStatuses.join('|')}`]);
  for (const [k, v] of Object.entries(report.totals)) if (k !== 'unit') rows.push(['TOTAL', k, null, null, null, null, null, v, 'minutes', null, null, null]);
  for (const k of ['matched', 'classificationConflict', 'unsupported', 'selectionRequired', 'configurationRequired', 'conflictingReferenceExcluded']) rows.push(['PARTITION', k, null, null, null, null, null, report.partition[k], 'minutes', null, null, null]);
  for (const f of report.findings) rows.push(['FINDING', f.id, f.code, f.facilityId, f.personId, f.date, f.role, f.minutes, 'minutes', f.rowIds.join('|'), f.relatedRowIds.join('|'), f.message]);
  for (const c of report.context) rows.push(['CONTEXT', c.id, c.code, c.facilityId, c.personId, c.date, c.role, c.minutes, 'minutes', c.rowIds.join('|'), c.relatedRowIds.join('|'), c.message]);
  for (const s of report.sourceStatuses) rows.push(['SOURCE', s.id, s.sourceType, s.facilityId, s.personId, s.date, s.mappedRole ?? s.localRole, s.minutes, 'minutes', null, null, `status=${s.status};eligibleMinutes=${s.eligibleMinutes};exclusions=${s.exclusions.join('|')}`]);
  for (const d of decisions) if (d.reportId === report.reportId) rows.push(['DECISION', d.decisionId, d.decision, null, null, null, null, null, null, d.findingId, null, `reviewer=${d.reviewerId};at=${d.decidedAt};note=${d.note}`]);
  return toCsv(REPORT_CSV_COLUMNS, rows);
}

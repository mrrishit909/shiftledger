// Strict, atomic dataset validation. Either every row is valid and a frozen normalized
// dataset is returned, or all errors are returned and nothing is reconciled.
import { compareCodeUnits, deepFreeze } from './canonical.js';

export const SCHEMA_VERSION = 'shiftledger.dataset.v1';
export const LIMITS = Object.freeze({
  maxBytes: 1024 * 1024,
  maxRows: 5000,
  maxIdLength: 64,
  maxMinutesPerPersonDay: 1440,
  maxNoteLength: 500,
});
export const SOURCE_STATUSES = Object.freeze(['APPROVED', 'UNAPPROVED', 'VOID']);
export const SOURCE_TYPES = Object.freeze(['PAYROLL', 'AGENCY']);
export const ALIAS_SOURCES = Object.freeze(['SCHEDULE', 'PAYROLL', 'AGENCY', 'REPORTED']);
export const TABLES = Object.freeze([
  'facilities', 'persons', 'identityAliases', 'classifications',
  'schedule', 'payroll', 'agency', 'reported', 'sourceSelections',
]);

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ROLE_RE = /^[A-Z][A-Z0-9_]{0,31}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TZ_RE = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TIMESTAMP_FIELDS = new Set(['start', 'end', 'startAt', 'endAt', 'startTime', 'endTime', 'clockIn', 'clockOut', 'timestamp']);

const ROW_FIELDS = {
  facilities: { required: ['id', 'timezone'] },
  persons: { required: ['id'] },
  identityAliases: { required: ['source', 'externalId', 'personId'] },
  classifications: { required: ['personId', 'localRole', 'configuredReportRole', 'effectiveFrom', 'effectiveTo'] },
  sourceSelections: { required: ['facilityId', 'personId', 'effectiveFrom', 'effectiveTo', 'sourceType'] },
  schedule: { required: ['id', 'facilityId', 'date', 'role', 'minutes'], person: true },
  payroll: { required: ['id', 'facilityId', 'date', 'role', 'minutes', 'status'], person: true },
  agency: { required: ['id', 'facilityId', 'date', 'role', 'minutes', 'status'], person: true },
  reported: { required: ['id', 'facilityId', 'date', 'role', 'minutes', 'sourceReference'], person: true },
};
const ALIAS_SOURCE_BY_TABLE = { schedule: 'SCHEDULE', payroll: 'PAYROLL', agency: 'AGENCY', reported: 'REPORTED' };
const RULE_FIELDS = ['rulesetId', 'fictional', 'approvalStatus', 'reportableRoles', 'eligibleStatuses', 'toleranceMinutes'];
const TOP_FIELDS = ['schemaVersion', 'datasetId', 'rules', ...TABLES];

/** Valid proleptic-Gregorian calendar date in YYYY-MM-DD, by arithmetic only (no Date). */
export function isCalendarDate(value) {
  if (typeof value !== 'string') return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return d <= dim;
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isId(v) {
  return typeof v === 'string' && v.length <= LIMITS.maxIdLength && ID_RE.test(v);
}

class Collector {
  constructor() { this.errors = []; }
  add(code, path, message) { this.errors.push({ code, path, message }); }
  sorted() {
    return this.errors.slice().sort((a, b) => compareCodeUnits(a.path, b.path) || compareCodeUnits(a.code, b.code) || compareCodeUnits(a.message, b.message));
  }
}

function checkKeys(obj, allowed, path, err) {
  let ok = true;
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.has(key)) { err.add('FORBIDDEN_KEY', `${path}.${key}`, `forbidden key "${key}"`); ok = false; }
    else if (TIMESTAMP_FIELDS.has(key)) { err.add('RAW_TIMESTAMP_UNSUPPORTED', `${path}.${key}`, 'raw punch/timestamps are unsupported in v1; supply day-split rows with an explicit local work date'); ok = false; }
    else if (!allowed.includes(key)) { err.add('UNKNOWN_FIELD', `${path}.${key}`, `unknown field "${key}"`); ok = false; }
  }
  return ok;
}

function checkDate(v, path, err) {
  if (typeof v === 'string' && /T|\d:\d/.test(v)) { err.add('RAW_TIMESTAMP_UNSUPPORTED', path, 'timestamps are unsupported; use a YYYY-MM-DD local work date'); return false; }
  if (!isCalendarDate(v)) { err.add('INVALID_DATE', path, 'expected a valid calendar date YYYY-MM-DD'); return false; }
  return true;
}

function checkMinutes(v, path, err) {
  if (typeof v !== 'number' || !Number.isInteger(v)) { err.add('INVALID_MINUTES', path, 'minutes must be an integer'); return false; }
  if (v < 0 || v > LIMITS.maxMinutesPerPersonDay) { err.add('MINUTES_OUT_OF_RANGE', path, `minutes must be within 0..${LIMITS.maxMinutesPerPersonDay}`); return false; }
  return true;
}

function validateRules(rules, err) {
  if (!isPlainObject(rules)) { err.add('INVALID_RULES', 'rules', 'rules must be an object'); return null; }
  if (!checkKeys(rules, RULE_FIELDS, 'rules', err)) return null;
  let ok = true;
  const fail = (field, msg) => { err.add('INVALID_RULES', `rules.${field}`, msg); ok = false; };
  if (!isId(rules.rulesetId)) fail('rulesetId', 'rulesetId must be an ID');
  if (rules.fictional !== true) fail('fictional', 'rules must be explicitly marked fictional:true; authoritative CMS rules are out of scope');
  if (rules.approvalStatus !== 'ILLUSTRATIVE_UNAPPROVED') fail('approvalStatus', 'approvalStatus must be ILLUSTRATIVE_UNAPPROVED');
  if (!Array.isArray(rules.reportableRoles) || rules.reportableRoles.length === 0 || !rules.reportableRoles.every((r) => typeof r === 'string' && ROLE_RE.test(r)) || new Set(rules.reportableRoles).size !== rules.reportableRoles.length) fail('reportableRoles', 'reportableRoles must be a non-empty list of unique role codes');
  if (!Array.isArray(rules.eligibleStatuses) || rules.eligibleStatuses.length === 0 || !rules.eligibleStatuses.every((s) => SOURCE_STATUSES.includes(s)) || new Set(rules.eligibleStatuses).size !== rules.eligibleStatuses.length) fail('eligibleStatuses', `eligibleStatuses must be unique values from ${SOURCE_STATUSES.join('|')}`);
  if (rules.toleranceMinutes !== 0) fail('toleranceMinutes', 'toleranceMinutes must be 0 in v1');
  if (!ok) return null;
  return {
    rulesetId: rules.rulesetId,
    fictional: true,
    approvalStatus: rules.approvalStatus,
    reportableRoles: rules.reportableRoles.slice().sort(compareCodeUnits),
    eligibleStatuses: rules.eligibleStatuses.slice().sort(compareCodeUnits),
    toleranceMinutes: 0,
  };
}

function overlaps(a, b) {
  return compareCodeUnits(a.effectiveFrom, b.effectiveTo) <= 0 && compareCodeUnits(b.effectiveFrom, a.effectiveTo) <= 0;
}

function checkIntervalOverlaps(rows, keyOf, label, table, err) {
  const groups = new Map();
  rows.forEach((row) => {
    const k = keyOf(row);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  });
  for (const list of groups.values()) {
    list.sort((a, b) => compareCodeUnits(a.effectiveFrom, b.effectiveFrom));
    for (let i = 1; i < list.length; i++) {
      if (overlaps(list[i - 1], list[i])) err.add('OVERLAPPING_INTERVAL', `${table}[${list[i].__index}]`, `${label} intervals overlap with ${table}[${list[i - 1].__index}]`);
    }
  }
}

/**
 * Validate an untrusted dataset object.
 * @returns {{ok:true, dataset:object} | {ok:false, errors:Array<{code,path,message}>}}
 */
export function validateDataset(input) {
  const err = new Collector();
  if (!isPlainObject(input)) return { ok: false, errors: [{ code: 'INVALID_DATASET', path: '$', message: 'dataset must be a JSON object' }] };
  checkKeys(input, TOP_FIELDS, '$', err);
  if (input.schemaVersion !== SCHEMA_VERSION) err.add('UNSUPPORTED_SCHEMA', 'schemaVersion', `schemaVersion must be ${SCHEMA_VERSION}`);
  if (!isId(input.datasetId)) err.add('INVALID_ID', 'datasetId', 'datasetId must be an ID');
  const rules = validateRules(input.rules, err);

  let totalRows = 0;
  for (const table of TABLES) {
    if (!Array.isArray(input[table])) err.add('INVALID_TABLE', table, `${table} must be an array`);
    else totalRows += input[table].length;
  }
  if (totalRows > LIMITS.maxRows) err.add('ROW_LIMIT_EXCEEDED', '$', `dataset has ${totalRows} rows; limit is ${LIMITS.maxRows}`);
  if (err.errors.length) return { ok: false, errors: err.sorted() };

  // Pass 1: shape of every row; normalized copies built from explicit fields only.
  const norm = {};
  for (const table of TABLES) {
    const spec = ROW_FIELDS[table];
    const allowed = spec.person ? [...spec.required, 'personId', 'externalId'] : spec.required;
    norm[table] = [];
    input[table].forEach((row, i) => {
      const path = `${table}[${i}]`;
      if (!isPlainObject(row)) { err.add('INVALID_ROW', path, 'row must be an object'); return; }
      if (!checkKeys(row, allowed, path, err)) return;
      let ok = true;
      for (const f of spec.required) if (!Object.hasOwn(row, f)) { err.add('MISSING_FIELD', `${path}.${f}`, `missing field "${f}"`); ok = false; }
      if (spec.person) {
        const hasP = Object.hasOwn(row, 'personId'), hasE = Object.hasOwn(row, 'externalId');
        if (hasP === hasE) { err.add('PERSON_REFERENCE', path, 'row must have exactly one of personId or externalId'); ok = false; }
      }
      if (!ok) return;
      const out = { __index: i };
      for (const f of allowed) {
        if (!Object.hasOwn(row, f)) continue;
        const v = row[f];
        const fp = `${path}.${f}`;
        if (f === 'minutes') { if (!checkMinutes(v, fp, err)) ok = false; }
        else if (f === 'date' || f === 'effectiveFrom' || f === 'effectiveTo') { if (!checkDate(v, fp, err)) ok = false; }
        else if (f === 'role' || f === 'localRole' || f === 'configuredReportRole') { if (typeof v !== 'string' || !ROLE_RE.test(v)) { err.add('INVALID_ROLE', fp, 'role must match [A-Z][A-Z0-9_]{0,31}'); ok = false; } }
        else if (f === 'status') { if (!SOURCE_STATUSES.includes(v)) { err.add('INVALID_STATUS', fp, `status must be one of ${SOURCE_STATUSES.join('|')}`); ok = false; } }
        else if (f === 'sourceType') { if (!SOURCE_TYPES.includes(v)) { err.add('INVALID_SOURCE_TYPE', fp, `sourceType must be one of ${SOURCE_TYPES.join('|')}`); ok = false; } }
        else if (f === 'source') { if (!ALIAS_SOURCES.includes(v)) { err.add('INVALID_ALIAS_SOURCE', fp, `source must be one of ${ALIAS_SOURCES.join('|')}`); ok = false; } }
        else if (f === 'timezone') { if (typeof v !== 'string' || !TZ_RE.test(v) || !isTimeZone(v)) { err.add('INVALID_TIMEZONE', fp, 'timezone must be an explicit IANA zone name'); ok = false; } }
        else if (!isId(v)) { err.add('INVALID_ID', fp, `"${f}" must be an ID (max ${LIMITS.maxIdLength} chars, [A-Za-z0-9._:-])`); ok = false; }
        out[f] = v;
      }
      if (ok && out.effectiveFrom && compareCodeUnits(out.effectiveFrom, out.effectiveTo) > 0) { err.add('INVALID_INTERVAL', path, 'effectiveFrom must not be after effectiveTo'); ok = false; }
      if (ok) norm[table].push(out);
    });
  }
  if (err.errors.length) return { ok: false, errors: err.sorted() };

  // Pass 2: uniqueness and references.
  const unique = (rows, keyOf, table, label) => {
    const seen = new Map();
    for (const r of rows) {
      const k = keyOf(r);
      if (seen.has(k)) err.add('DUPLICATE_ID', `${table}[${r.__index}]`, `${label} "${k}" repeats ${table}[${seen.get(k)}]; repeated rows are rejected, never added`);
      else seen.set(k, r.__index);
    }
    return seen;
  };
  const facilityIds = unique(norm.facilities, (r) => r.id, 'facilities', 'facility id');
  const personIds = unique(norm.persons, (r) => r.id, 'persons', 'person id');
  const globalRowIds = new Map();
  for (const table of ['schedule', 'payroll', 'agency', 'reported']) {
    for (const r of norm[table]) {
      if (globalRowIds.has(r.id)) err.add('DUPLICATE_ID', `${table}[${r.__index}]`, `row id "${r.id}" repeats ${globalRowIds.get(r.id)}; repeated rows are rejected, never added`);
      else globalRowIds.set(r.id, `${table}[${r.__index}]`);
    }
  }
  const aliasMap = new Map();
  for (const a of norm.identityAliases) {
    const path = `identityAliases[${a.__index}]`;
    if (!personIds.has(a.personId)) err.add('UNKNOWN_PERSON', `${path}.personId`, `unknown person "${a.personId}"`);
    const k = `${a.source}\u0000${a.externalId}`;
    if (aliasMap.has(k)) {
      const prev = aliasMap.get(k);
      err.add(prev.personId === a.personId ? 'DUPLICATE_ALIAS' : 'AMBIGUOUS_ALIAS', path, `alias ${a.source}/${a.externalId} already maps to "${prev.personId}"; aliases are never fuzzy-merged`);
    } else aliasMap.set(k, a);
  }
  for (const table of ['classifications', 'sourceSelections']) {
    for (const r of norm[table]) if (!personIds.has(r.personId)) err.add('UNKNOWN_PERSON', `${table}[${r.__index}].personId`, `unknown person "${r.personId}"`);
  }
  for (const r of norm.sourceSelections) if (!facilityIds.has(r.facilityId)) err.add('UNKNOWN_FACILITY', `sourceSelections[${r.__index}].facilityId`, `unknown facility "${r.facilityId}"`);
  checkIntervalOverlaps(norm.classifications, (r) => `${r.personId}\u0000${r.localRole}`, 'classification', 'classifications', err);
  checkIntervalOverlaps(norm.sourceSelections, (r) => `${r.facilityId}\u0000${r.personId}`, 'sourceSelection', 'sourceSelections', err);

  const dayTotals = new Map();
  for (const table of ['schedule', 'payroll', 'agency', 'reported']) {
    for (const r of norm[table]) {
      const path = `${table}[${r.__index}]`;
      if (!facilityIds.has(r.facilityId)) err.add('UNKNOWN_FACILITY', `${path}.facilityId`, `unknown facility "${r.facilityId}"`);
      if (Object.hasOwn(r, 'externalId')) {
        const alias = aliasMap.get(`${ALIAS_SOURCE_BY_TABLE[table]}\u0000${r.externalId}`);
        if (!alias) { err.add('UNKNOWN_ALIAS', `${path}.externalId`, `no ${ALIAS_SOURCE_BY_TABLE[table]} alias for "${r.externalId}"`); continue; }
        r.personId = alias.personId;
      } else {
        r.externalId = null;
        if (!personIds.has(r.personId)) { err.add('UNKNOWN_PERSON', `${path}.personId`, `unknown person "${r.personId}"`); continue; }
      }
      if (table !== 'reported') {
        const k = `${table}\u0000${r.personId}\u0000${r.date}`;
        const t = (dayTotals.get(k) ?? 0) + r.minutes;
        dayTotals.set(k, t);
        if (t > LIMITS.maxMinutesPerPersonDay) err.add('PERSON_DAY_LIMIT', path, `${table} minutes for ${r.personId} on ${r.date} exceed ${LIMITS.maxMinutesPerPersonDay}`);
      }
    }
  }
  if (err.errors.length) return { ok: false, errors: err.sorted() };

  const strip = (rows, sortKey) => rows.map(({ __index, ...rest }) => rest).sort((a, b) => compareCodeUnits(sortKey(a), sortKey(b)));
  const k = (...fields) => (r) => fields.map((f) => r[f] ?? '').join('\u0000');
  const dataset = {
    schemaVersion: SCHEMA_VERSION,
    datasetId: input.datasetId,
    rules,
    facilities: strip(norm.facilities, k('id')),
    persons: strip(norm.persons, k('id')),
    identityAliases: strip(norm.identityAliases, k('source', 'externalId')),
    classifications: strip(norm.classifications, k('personId', 'localRole', 'effectiveFrom')),
    sourceSelections: strip(norm.sourceSelections, k('facilityId', 'personId', 'effectiveFrom')),
    schedule: strip(norm.schedule, k('id')),
    payroll: strip(norm.payroll, k('id')),
    agency: strip(norm.agency, k('id')),
    reported: strip(norm.reported, k('id')),
  };
  return { ok: true, dataset: deepFreeze(dataset) };
}

function isTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

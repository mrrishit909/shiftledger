// Strict import, normalization round trips, schema/prototype/limit rejection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateDataset, reconcile, datasetHash, importDatasetJson, importDatasetCsv, exportDatasetJson,
  exportDatasetCsv, exportTableCsv, parseCsv, sumMinutes, isCalendarDate,
  goldenFixture, correctedFixture, splitFixture, overnightFixture,
} from '../src/index.js';

const D = '2026-10-05';
const codesOf = (r) => r.errors.map((e) => e.code);

function aliasFixture() {
  const ds = goldenFixture();
  ds.datasetId = 'SL-SYN-001-ALIAS';
  ds.identityAliases = [
    { source: 'PAYROLL', externalId: 'PX-100', personId: 'E1' },
    { source: 'REPORTED', externalId: 'RX-1', personId: 'E1' },
    { source: 'REPORTED', externalId: 'RX-1B', personId: 'E1' },
  ];
  ds.payroll[0] = { id: 'P1', facilityId: 'F1', externalId: 'PX-100', date: D, role: 'RN', minutes: 480, status: 'APPROVED' };
  ds.reported[0] = { id: 'R1', facilityId: 'F1', externalId: 'RX-1', date: D, role: 'RN', minutes: 480, sourceReference: 'P1' };
  ds.reported[1] = { id: 'R2', facilityId: 'F1', externalId: 'RX-1B', date: D, role: 'RN', minutes: 480, sourceReference: 'P1' };
  return ds;
}

const variants = { golden: goldenFixture, corrected: correctedFixture, split: splitFixture, overnight: overnightFixture, alias: aliasFixture };

for (const [name, make] of Object.entries(variants)) {
  test(`normalization is idempotent and JSON/CSV round trips preserve hash and reportId: ${name}`, () => {
    const v1 = validateDataset(make());
    assert.equal(v1.ok, true, JSON.stringify(v1.errors));
    const v2 = validateDataset(v1.dataset);
    assert.equal(v2.ok, true, JSON.stringify(v2.errors));
    assert.deepEqual(v2.dataset, v1.dataset);
    const hash = datasetHash(v1.dataset);
    const reportId = reconcile(make()).report.reportId;
    assert.equal(reconcile(v1.dataset).report.reportId, reportId);

    const j = importDatasetJson(exportDatasetJson(v1.dataset));
    assert.equal(j.ok, true, JSON.stringify(j.errors));
    assert.equal(datasetHash(j.dataset), hash);
    assert.equal(reconcile(j.dataset).report.reportId, reportId);

    const c = importDatasetCsv(exportDatasetCsv(v1.dataset));
    assert.equal(c.ok, true, JSON.stringify(c.errors));
    assert.equal(datasetHash(c.dataset), hash);
    assert.equal(reconcile(c.dataset).report.reportId, reportId);
  });
}

test('normalized rows carry personId plus externalId (null when no alias) and stay importable', () => {
  const v = validateDataset(aliasFixture());
  const r1 = v.dataset.reported.find((r) => r.id === 'R1');
  const r3 = v.dataset.reported.find((r) => r.id === 'R3');
  assert.deepEqual([r1.personId, r1.externalId], ['E1', 'RX-1']);
  assert.deepEqual([r3.personId, r3.externalId], ['E2', null]);
  const csv = exportTableCsv(v.dataset, 'reported');
  assert.deepEqual(parseCsv(csv)[1], ['R1', 'F1', '', 'RX-1', D, 'RN', '480', 'P1']);
  assert.deepEqual(parseCsv(csv)[3], ['R3', 'F1', 'E2', '', D, 'CNA', '360', 'P2']);
});

test('person reference rules: null externalId alone, null personId, mismatched pair, wrong alias source', () => {
  const mk = (row) => { const ds = aliasFixture(); ds.reported[2] = { id: 'R3', facilityId: 'F1', date: D, role: 'CNA', minutes: 360, sourceReference: 'P2', ...row }; return validateDataset(ds); };
  assert.deepEqual(codesOf(mk({ externalId: null })), ['PERSON_REFERENCE']);
  assert.deepEqual(codesOf(mk({ personId: null })), ['INVALID_ID']);
  assert.deepEqual(codesOf(mk({ personId: 'E2', externalId: 'RX-1' })), ['ALIAS_PERSON_MISMATCH']);
  assert.equal(mk({ personId: 'E1', externalId: 'RX-1' }).ok, true);
  assert.deepEqual(codesOf(mk({ externalId: 'PX-100' })), ['UNKNOWN_ALIAS']);
  assert.deepEqual(codesOf(mk({ externalId: 'NOPE' })), ['UNKNOWN_ALIAS']);
});

test('two aliases intentionally mapping one person reconcile like golden, deterministically', () => {
  const fc = (rep) => rep.findings.map((f) => `${f.code}:${f.rowIds.join('|')}:${f.relatedRowIds.join('|')}:${f.minutes}`).sort();
  const golden = reconcile(goldenFixture()).report;
  const alias = reconcile(aliasFixture()).report;
  assert.deepEqual(fc(alias), ['CLASSIFICATION_CONFLICT:R4:A1:240', 'DUPLICATE_REPORTED_SOURCE:R2:R1:480', 'UNSUPPORTED_MINUTES:R3:P2:60']);
  assert.deepEqual(fc(alias), fc(golden));
  assert.deepEqual(alias.totals, golden.totals);
  assert.deepEqual(alias.partition, golden.partition);
  const rev = aliasFixture();
  for (const k of Object.keys(rev)) if (Array.isArray(rev[k])) rev[k].reverse();
  assert.equal(reconcile(rev).report.reportId, alias.reportId);
});

test('alias rows cannot use a null externalId (no "undefined" alias key)', () => {
  const ds = aliasFixture();
  ds.identityAliases.push({ source: 'REPORTED', externalId: null, personId: 'E2' });
  assert.deepEqual(codesOf(validateDataset(ds)), ['INVALID_ID']);
  ds.reported.push({ id: 'R9', facilityId: 'F1', externalId: 'undefined', date: D, role: 'CNA', minutes: 1, sourceReference: 'P9' });
  assert.equal(validateDataset(ds).ok, false);
});

test('aliases: ambiguous mapping rejects; repeated alias rejects; per-source namespaces', () => {
  const ds = aliasFixture();
  ds.identityAliases.push({ source: 'REPORTED', externalId: 'RX-1', personId: 'E2' });
  assert.deepEqual(codesOf(validateDataset(ds)), ['AMBIGUOUS_ALIAS']);
  const dup = aliasFixture();
  dup.identityAliases.push({ source: 'REPORTED', externalId: 'RX-1', personId: 'E1' });
  assert.deepEqual(codesOf(validateDataset(dup)), ['DUPLICATE_ALIAS']);
  const ns = aliasFixture();
  ns.identityAliases.push({ source: 'AGENCY', externalId: 'RX-1', personId: 'E3' });
  assert.equal(validateDataset(ns).ok, true);
  const unknown = aliasFixture();
  unknown.identityAliases.push({ source: 'AGENCY', externalId: 'AX', personId: 'E99' });
  assert.deepEqual(codesOf(validateDataset(unknown)), ['UNKNOWN_PERSON']);
});

test('strict JSON import: type, syntax, byte limit with multibyte text, shape', () => {
  assert.deepEqual(codesOf(importDatasetJson({})), ['INVALID_INPUT']);
  assert.deepEqual(codesOf(importDatasetJson('{"a":')), ['INVALID_JSON']);
  const big = `{"datasetId":"${'é'.repeat(600000)}"}`;
  assert.ok(big.length < 1024 * 1024);
  assert.deepEqual(codesOf(importDatasetJson(big)), ['SIZE_LIMIT_EXCEEDED']);
  assert.deepEqual(codesOf(importDatasetJson('null')), ['INVALID_DATASET']);
  assert.deepEqual(codesOf(importDatasetJson('[]')), ['INVALID_DATASET']);
  const noTable = goldenFixture(); delete noTable.agency;
  assert.ok(codesOf(validateDataset(noTable)).includes('INVALID_TABLE'));
  const extra = goldenFixture(); extra.notes = 'x';
  assert.deepEqual(codesOf(validateDataset(extra)), ['UNKNOWN_FIELD']);
  const ver = goldenFixture(); ver.schemaVersion = 'shiftledger.dataset.v0';
  assert.deepEqual(codesOf(validateDataset(ver)), ['UNSUPPORTED_SCHEMA']);
  const rules = goldenFixture(); rules.rules.fictional = false; rules.rules.toleranceMinutes = 5;
  assert.deepEqual(codesOf(validateDataset(rules)), ['INVALID_RULES', 'INVALID_RULES']);
});

test('prototype pollution and non-object rows reject; null-prototype rows are accepted', () => {
  const text = JSON.stringify(goldenFixture());
  const withProto = text.replace('{"id":"S1",', '{"__proto__":{"polluted":true},"id":"S1",');
  const r = importDatasetJson(withProto);
  assert.deepEqual(codesOf(r), ['FORBIDDEN_KEY']);
  assert.equal({}.polluted, undefined);
  const top = importDatasetJson(text.replace('{"schemaVersion"', '{"__proto__":{"x":1},"schemaVersion"'));
  assert.deepEqual(codesOf(top), ['FORBIDDEN_KEY']);
  assert.deepEqual(codesOf(importDatasetJson(text.replace('{"id":"S1",', '{"constructor":"x","id":"S1",'))), ['FORBIDDEN_KEY']);
  const nullRow = goldenFixture(); nullRow.schedule[0] = null;
  assert.deepEqual(codesOf(validateDataset(nullRow)), ['INVALID_ROW']);
  const arrRow = goldenFixture(); arrRow.schedule[0] = ['S1'];
  assert.deepEqual(codesOf(validateDataset(arrRow)), ['INVALID_ROW']);
  const np = goldenFixture(); np.schedule[0] = Object.assign(Object.create(null), np.schedule[0]);
  assert.equal(validateDataset(np).ok, true);
  assert.deepEqual(codesOf(validateDataset(null)), ['INVALID_DATASET']);
});

test('limits: exactly 5000 rows accepted, 5001 rejected; IDs bounded to 64 chars', () => {
  const mk = (persons) => ({
    schemaVersion: 'shiftledger.dataset.v1', datasetId: 'SL-LIMIT', rules: goldenFixture().rules,
    facilities: [{ id: 'F1', timezone: 'UTC' }], persons: Array.from({ length: persons }, (_, i) => ({ id: `E${i}` })),
    identityAliases: [], classifications: [], sourceSelections: [], schedule: [], payroll: [], agency: [], reported: [],
  });
  assert.equal(importDatasetJson(JSON.stringify(mk(4999))).ok, true);
  assert.deepEqual(codesOf(importDatasetJson(JSON.stringify(mk(5000)))), ['ROW_LIMIT_EXCEEDED']);
  const id64 = goldenFixture(); id64.persons.push({ id: 'X'.repeat(64) });
  assert.equal(validateDataset(id64).ok, true);
  const id65 = goldenFixture(); id65.persons.push({ id: 'X'.repeat(65) });
  assert.deepEqual(codesOf(validateDataset(id65)), ['INVALID_ID']);
  const weird = goldenFixture(); weird.persons.push({ id: '=cmd' });
  assert.deepEqual(codesOf(validateDataset(weird)), ['INVALID_ID']);
});

test('minutes: integers 0..1440 only; person-day evidence sum bounded; atomic rejection', () => {
  for (const bad of [1441, -1, '480', 480.5, NaN, Infinity, null, 2 ** 53]) {
    const ds = goldenFixture(); ds.payroll[1].minutes = bad;
    const r = reconcile(ds);
    assert.equal(r.ok, false, String(bad));
    assert.ok(!('report' in r) && !('dataset' in r));
    assert.ok(['INVALID_MINUTES', 'MINUTES_OUT_OF_RANGE'].includes(r.errors[0].code));
  }
  const zero = goldenFixture(); zero.payroll[1].minutes = 0;
  assert.equal(reconcile(zero).ok, true);
  const day = goldenFixture();
  day.payroll.push({ id: 'P1x', facilityId: 'F1', personId: 'E1', date: D, role: 'RN', minutes: 961, status: 'APPROVED' });
  assert.deepEqual(codesOf(validateDataset(day)), ['PERSON_DAY_LIMIT']);
  const mixed = goldenFixture(); mixed.reported[3].date = '2026-02-30';
  const r = reconcile(mixed);
  assert.deepEqual(codesOf(r), ['INVALID_DATE']);
  assert.equal(r.errors[0].path, 'reported[3].date');
});

test('calendar dates and raw timestamps', () => {
  for (const ok of ['2024-02-29', '2000-02-29', '2026-10-31', '0001-01-01']) assert.equal(isCalendarDate(ok), true, ok);
  for (const bad of ['2026-02-29', '1900-02-29', '2026-13-01', '2026-1-05', '0000-01-01', '2026-04-31', '20261005', 20261005]) assert.equal(isCalendarDate(bad), false, String(bad));
  const ts = goldenFixture(); ts.reported[0].date = '2026-10-05T23:00:00-04:00';
  assert.deepEqual(codesOf(validateDataset(ts)), ['RAW_TIMESTAMP_UNSUPPORTED']);
  const punch = goldenFixture(); punch.payroll[0].start = '2026-10-05 23:00'; punch.payroll[0].end = '2026-10-06 07:00';
  assert.deepEqual(codesOf(validateDataset(punch)), ['RAW_TIMESTAMP_UNSUPPORTED', 'RAW_TIMESTAMP_UNSUPPORTED']);
  const tz = goldenFixture(); tz.facilities[0].timezone = 'Not/AZone';
  assert.deepEqual(codesOf(validateDataset(tz)), ['INVALID_TIMEZONE']);
});

test('aggregate sums flag overflow instead of truncating', () => {
  assert.deepEqual(sumMinutes([Number.MAX_SAFE_INTEGER, 1]), { value: null, overflow: true });
  assert.deepEqual(sumMinutes([Number.MAX_SAFE_INTEGER - 1, 1]), { value: Number.MAX_SAFE_INTEGER, overflow: false });
  assert.deepEqual(sumMinutes([1, 0.5]), { value: null, overflow: true });
  assert.deepEqual(sumMinutes([]), { value: 0, overflow: false });
  // Under the 5000-row / 1440-minute schema bounds the largest possible sum is 7,200,000.
  assert.equal(reconcile(goldenFixture()).report.boundsExceeded.length, 0);
});

test('strict CSV import: headers, widths, numbers, quoting, tables, bundle fields, size', () => {
  const base = () => exportDatasetCsv(validateDataset(goldenFixture()).dataset);
  const withTable = (t, fn) => { const b = base(); b.tables[t] = fn(b.tables[t]); return importDatasetCsv(b); };
  assert.equal(importDatasetCsv(base()).ok, true);
  assert.deepEqual(codesOf(withTable('payroll', (s) => s.replace('id,facilityId', 'facilityId,id'))), ['CSV_HEADER']);
  assert.deepEqual(codesOf(withTable('payroll', (s) => s.replace('P1,F1,E1', 'P1,F1,E1,extra'))), ['CSV_ROW_WIDTH']);
  assert.deepEqual(codesOf(withTable('payroll', (s) => `${s}\r\n`)), ['CSV_ROW_WIDTH']);
  for (const m of ['007', '4.8e2', '-1', ' 480', '480.0']) {
    assert.deepEqual(codesOf(withTable('payroll', (s) => s.replace(',480,APPROVED', `,${m},APPROVED`))), ['INVALID_MINUTES'], m);
  }
  assert.deepEqual(codesOf(withTable('payroll', (s) => s.replace('P1,', '"P1,'))), ['CSV_PARSE']);
  assert.deepEqual(codesOf(withTable('payroll', (s) => s.replace('\r\n', '\r'))), ['CSV_PARSE']);
  const missing = base(); delete missing.tables.agency;
  assert.deepEqual(codesOf(importDatasetCsv(missing)), ['MISSING_TABLE']);
  const unknown = base(); unknown.tables.notes = 'x\r\n';
  assert.deepEqual(codesOf(importDatasetCsv(unknown)), ['UNKNOWN_TABLE']);
  const field = base(); field.extra = 1;
  assert.deepEqual(codesOf(importDatasetCsv(field)), ['UNKNOWN_FIELD']);
  const inherited = base(); inherited.tables = Object.create(inherited.tables);
  assert.deepEqual(codesOf(importDatasetCsv(inherited)), ['INVALID_INPUT']);
  const big = base(); big.tables.persons += `${'E'.repeat(1024 * 1024)}\r\n`;
  assert.deepEqual(codesOf(importDatasetCsv(big)), ['SIZE_LIMIT_EXCEEDED']);
  assert.deepEqual(parseCsv('a,"b,""c"""\r\n,\n'), [['a', 'b,"c"'], ['', '']]);
  assert.throws(() => parseCsv('a"b\n'), /bare quote/);
  assert.throws(() => parseCsv('"a"b\n'), /after closing quote/);
});

// Regressions for the independent audit findings: strict timestamps, controlled rejection of
// null/malformed/inherited inputs, counterfeit reports, forged decision logs, input limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcile, isEngineReport, verifyReportId, datasetHash, filterFindings, supportingRows, createDecision, appendDecision,
  isAuthenticDecision, ownDecisions, readiness, exportReportJson, exportReportCsv, validateDataset,
  importDatasetCsv, exportDatasetCsv, exportDatasetJson, exportTableCsv, isUtcTimestamp, canonicalJson, sha256Hex,
  goldenFixture, splitFixture, LIMITS,
} from '../src/index.js';

const at = '2026-11-03T12:00:00Z';
const golden = () => reconcile(goldenFixture()).report;
const input = (rep, extra = {}) => ({ findingId: rep.findings[0].id, decision: 'ACKNOWLEDGED', reviewerId: 'REV-1', decidedAt: at, ...extra });
const decide = (rep, extra) => { const d = createDecision(rep, input(rep, extra)); assert.equal(d.ok, true, JSON.stringify(d.errors)); return d.decision; };
const codesOf = (r) => r.errors.map((e) => e.code);
const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof TypeError && e.code === code);

test('decidedAt must be a real UTC calendar instant', () => {
  const rep = golden();
  for (const bad of ['2026-02-30T99:99:99Z', '2026-02-30T12:00:00Z', '2026-11-03T24:00:00Z', '2026-11-03T23:60:00Z', '2026-11-03T23:59:60Z', '2026-13-01T00:00:00Z', '2025-02-29T00:00:00Z', '2026-11-03T12:00:00.000Z', '2026-11-03T12:00:00z', 20261103]) {
    assert.equal(isUtcTimestamp(bad), false, String(bad));
    const r = createDecision(rep, input(rep, { decidedAt: bad }));
    assert.deepEqual(codesOf(r), ['INVALID_TIMESTAMP'], String(bad));
  }
  for (const ok of ['2026-11-03T00:00:00Z', '2026-11-03T23:59:59Z', '2024-02-29T12:30:45Z']) {
    assert.equal(isUtcTimestamp(ok), true, ok);
    assert.equal(createDecision(rep, input(rep, { decidedAt: ok })).ok, true, ok);
  }
});

test('null, malformed, inherited and polluted inputs give controlled rejections, never accidental TypeErrors', () => {
  const rep = golden();
  for (const bad of [null, undefined, {}, [], 'SLR-x', 42]) {
    assert.deepEqual(codesOf(createDecision(bad, {})), ['UNTRUSTED_REPORT']);
    assert.deepEqual(codesOf(createDecision(bad, input(rep))), ['UNTRUSTED_REPORT']);
    assert.deepEqual(codesOf(appendDecision([], bad, decide(rep))), ['UNTRUSTED_REPORT']);
    assert.equal(isAuthenticDecision(bad, decide(rep)), false);
    assert.equal(isEngineReport(bad), false);
    assert.equal(verifyReportId(bad), false);
    for (const fn of [readiness, ownDecisions, exportReportJson, exportReportCsv, filterFindings, supportingRows]) throwsCode(() => fn(bad), 'UNTRUSTED_REPORT');
  }
  for (const bad of [null, undefined, [], 'x', Object.create(input(rep)), new (class X {})()]) {
    assert.deepEqual(codesOf(createDecision(rep, bad)), ['INVALID_DECISION']);
  }
  const sym = Symbol('s');
  assert.deepEqual(codesOf(createDecision(rep, input(rep, { findingId: sym }))), ['UNKNOWN_FINDING']);
  assert.deepEqual(codesOf(createDecision(rep, { ...input(rep), [sym]: 1 })), ['UNKNOWN_FIELD']);
  assert.deepEqual(codesOf(createDecision(rep, input(rep, { note: { toString() { throw new Error('boom'); } } }))), ['INVALID_NOTE']);
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(verifyReportId(cyclic), false);
  try {
    Object.prototype.note = '=polluted'; // eslint-disable-line no-extend-native
    Object.prototype.decidedAt = at; // eslint-disable-line no-extend-native
    const { decidedAt, ...noTime } = input(rep);
    assert.deepEqual(codesOf(createDecision(rep, noTime)), ['INVALID_TIMESTAMP']);
    assert.equal(decide(rep).note, '');
  } finally {
    delete Object.prototype.note;
    delete Object.prototype.decidedAt;
  }
  for (const log of [null, 'x', {}, { length: 1, 0: decide(rep) }]) {
    assert.deepEqual(codesOf(appendDecision(log, rep, decide(rep))), ['INVALID_LOG']);
    throwsCode(() => readiness(rep, log), 'INVALID_ARGUMENT');
    throwsCode(() => exportReportJson(rep, log), 'INVALID_ARGUMENT');
    throwsCode(() => exportReportCsv(rep, log), 'INVALID_ARGUMENT');
  }
  for (const criteria of [null, [], Object.create({ personId: 'E2' }), { person: 'E2' }, { personId: 5 }]) throwsCode(() => filterFindings(rep, criteria), 'INVALID_ARGUMENT');
  assert.equal(supportingRows(rep, null), null);
  assert.equal(supportingRows(rep, { toString: () => rep.findings[0].id }), null);
  for (const bad of [null, {}, Object.create(validateDataset(goldenFixture()).dataset)]) {
    for (const fn of [exportDatasetJson, exportDatasetCsv, (d) => exportTableCsv(d, 'payroll')]) throwsCode(() => fn(bad), 'INVALID_DATASET');
  }
  throwsCode(() => exportTableCsv(validateDataset(goldenFixture()).dataset, '__proto__'), 'INVALID_ARGUMENT');
  for (const bad of [null, { x: 1n }, cyclic]) throwsCode(() => datasetHash(bad), 'INVALID_DATASET');
});

test('counterfeit reports are rejected even with a recomputed matching reportId', () => {
  const rep = golden();
  const d = decide(rep);
  assert.equal(isEngineReport(rep), true);
  const hashOf = (r) => { const { reportId, ...body } = r; return `SLR-${sha256Hex(canonicalJson(body))}`; };
  const tampered = structuredClone(rep);
  tampered.totals.rawReported += 7; tampered.totals.dedupReported += 7; tampered.findings = [];
  const forged = { ...tampered, reportId: hashOf(tampered) };
  assert.equal(forged.reportId, hashOf(forged)); // the forgery's hash is self-consistent...
  assert.equal(verifyReportId(forged), false); // ...but a hash is integrity identity, not provenance
  const honestClone = structuredClone(rep);
  assert.equal(honestClone.reportId, hashOf(honestClone));
  assert.equal(verifyReportId(honestClone), false);
  assert.equal(verifyReportId(rep), true);
  const fakes = {
    forged, honestClone, json: JSON.parse(JSON.stringify(rep)), inherited: Object.create(rep),
    proxy: new Proxy(rep, {}), spread: { ...rep }, sameIdOtherBody: { ...forged, reportId: rep.reportId },
  };
  for (const [name, fake] of Object.entries(fakes)) {
    assert.equal(isEngineReport(fake), false, name);
    assert.equal(verifyReportId(fake), false, name);
    assert.deepEqual(codesOf(createDecision(fake, input(rep))), ['UNTRUSTED_REPORT'], name);
    assert.deepEqual(codesOf(appendDecision([], fake, d)), ['UNTRUSTED_REPORT'], name);
    assert.equal(isAuthenticDecision(fake, d), false, name);
    for (const fn of [(r) => readiness(r, [d]), (r) => exportReportJson(r, [d]), (r) => exportReportCsv(r, [d]), (r) => filterFindings(r, {}), (r) => supportingRows(r, rep.findings[0].id), ownDecisions]) {
      throwsCode(() => fn(fake), 'UNTRUSTED_REPORT');
    }
  }
  // The genuine export still carries the genuine values computed by the engine.
  const out = JSON.parse(exportReportJson(rep, [d]));
  assert.equal(out.report.reportId, rep.reportId);
  assert.equal(out.report.totals.rawReported, rep.totals.rawReported);
  assert.equal(out.report.findings.length, rep.findings.length);
  // Engine reports are deep-frozen, so the minted object itself cannot be tampered with.
  assert.throws(() => { rep.totals.rawReported = 0; }, TypeError);
  assert.throws(() => { rep.findings.pop(); }, TypeError);
});

test('forged, incomplete, null, inherited, edited and cross-report log entries never count as reviewed', () => {
  const rep = golden();
  const other = reconcile(splitFixture()).report;
  const d = decide(rep);
  const crossD = decide(other, { findingId: other.findings[0].id });
  const { effect, ...incomplete } = d;
  const forgedEntries = {
    null: null, undefined, number: 1, spread: { ...d }, inherited: Object.create(d), incomplete,
    alteredId: { ...d, decisionId: 'SLD-0000000000000000' }, certifies: { ...d, effect: 'CERTIFIES_SUBMISSION' },
    otherFinding: { ...d, findingId: rep.findings[1].id }, proxy: new Proxy(d, {}), crossReport: crossD,
    crossRebound: { ...crossD, reportId: rep.reportId },
  };
  for (const [name, bad] of Object.entries(forgedEntries)) {
    assert.equal(isAuthenticDecision(rep, bad), false, name);
    assert.equal(appendDecision([], rep, bad).ok, false, name);
    assert.deepEqual(codesOf(appendDecision([bad], rep, d)), ['INVALID_LOG'], name);
    assert.equal(readiness(rep, [bad]).decided, 0, name);
    assert.equal(ownDecisions(rep, [bad]).length, 0, name);
    const json = JSON.parse(exportReportJson(rep, [bad]));
    assert.deepEqual([json.decisions.length, json.readiness.decided], [0, 0], name);
    assert.ok(!exportReportCsv(rep, [bad]).split('\r\n').some((l) => l.startsWith('DECISION,')), name);
  }
  const sparse = [];
  sparse[2] = d;
  assert.deepEqual(codesOf(appendDecision(sparse, rep, decide(rep, { decision: 'DISPUTED' }))), ['INVALID_LOG']);
  // Duplicates and noise around one genuine decision count it exactly once.
  const noisy = [null, d, { ...d }, d, Object.create(d)];
  assert.equal(readiness(rep, noisy).decided, 1);
  assert.equal(JSON.parse(exportReportJson(rep, noisy)).decisions.length, 1);
  // Readiness is never certified, even with every finding decided.
  let log = [];
  for (const f of rep.findings) log = appendDecision(log, rep, decide(rep, { findingId: f.id })).log;
  assert.deepEqual(readiness(rep, log), { status: 'REVIEWED_NOT_CERTIFIED', certified: false, findings: 3, decided: 3, undecided: 0 });
  // A re-run of the same dataset is the same engine report identity and accepts the decision.
  assert.equal(isAuthenticDecision(golden(), d), true);
});

test('input limits cover metadata; rules lists are bounded; top-level keys and prototypes are strict', () => {
  const ds = () => validateDataset(goldenFixture()).dataset;
  const bundle = exportDatasetCsv(ds());
  assert.equal(importDatasetCsv(bundle).ok, true);
  const fat = exportDatasetCsv(ds());
  fat.rules.reportableRoles = Array.from({ length: 200000 }, (_, i) => `R${i}`);
  assert.deepEqual(codesOf(importDatasetCsv(fat)), ['SIZE_LIMIT_EXCEEDED']);
  const fatId = exportDatasetCsv(ds());
  fatId.datasetId = 'X'.repeat(LIMITS.maxBytes);
  assert.deepEqual(codesOf(importDatasetCsv(fatId)), ['SIZE_LIMIT_EXCEEDED']);
  const big = exportDatasetCsv(ds()); big.rules = { ...big.rules, extra: 10n };
  assert.deepEqual(codesOf(importDatasetCsv(big)), ['INVALID_INPUT']);

  const roles = (n) => { const x = goldenFixture(); x.rules.reportableRoles = ['CNA', 'RN', ...Array.from({ length: n - 2 }, (_, i) => `ROLE_${i}`)]; return x; };
  assert.equal(validateDataset(roles(LIMITS.maxReportableRoles)).ok, true);
  assert.deepEqual(codesOf(validateDataset(roles(LIMITS.maxReportableRoles + 1))), ['INVALID_RULES']);
  const statuses = goldenFixture(); statuses.rules.eligibleStatuses = ['APPROVED', 'APPROVED', 'VOID', 'UNAPPROVED'];
  assert.deepEqual(codesOf(validateDataset(statuses)), ['INVALID_RULES']);

  const sym = goldenFixture(); sym[Symbol('x')] = 1;
  assert.deepEqual(codesOf(validateDataset(sym)), ['UNKNOWN_FIELD']);
  const hidden = goldenFixture(); Object.defineProperty(hidden, 'notes', { value: 'x', enumerable: false });
  assert.deepEqual(codesOf(validateDataset(hidden)), ['UNKNOWN_FIELD']);
  const sparse = goldenFixture(); sparse.schedule = [sparse.schedule[0], , sparse.schedule[2]]; // eslint-disable-line no-sparse-arrays
  assert.deepEqual(codesOf(validateDataset(sparse)), ['INVALID_ROW']);
  const inheritedRules = goldenFixture(); inheritedRules.rules = Object.create(inheritedRules.rules);
  assert.deepEqual(codesOf(validateDataset(inheritedRules)), ['INVALID_RULES']);

  try {
    Object.prototype.agency = []; // eslint-disable-line no-extend-native
    Object.prototype.toleranceMinutes = 0; // eslint-disable-line no-extend-native
    Object.prototype.datasetId = 'SL-POLLUTED'; // eslint-disable-line no-extend-native
    const noTable = goldenFixture(); delete noTable.agency;
    assert.deepEqual(codesOf(validateDataset(noTable)), ['INVALID_TABLE']);
    const noTol = goldenFixture(); delete noTol.rules.toleranceMinutes;
    assert.deepEqual(codesOf(validateDataset(noTol)), ['INVALID_RULES']);
    const noId = exportDatasetCsv(ds()); delete noId.datasetId;
    assert.deepEqual(codesOf(importDatasetCsv(noId)), ['INVALID_ID']);
  } finally {
    delete Object.prototype.agency;
    delete Object.prototype.toleranceMinutes;
    delete Object.prototype.datasetId;
  }
  // The golden oracle is unchanged by all of the above.
  const g = golden();
  assert.deepEqual([g.totals.rawReported, g.totals.dedupReported, g.totals.eligibleSupport, g.findings.length], [1560, 1080, 1020, 3]);
});

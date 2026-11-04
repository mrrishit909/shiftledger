// Inert reviewer decisions, readiness, report exports and formula safety.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcile, createDecision, appendDecision, readiness, exportReportJson, exportReportCsv,
  parseCsv, csvCell, REPORT_CSV_COLUMNS, goldenFixture, correctedFixture, splitFixture,
} from '../src/index.js';

const report = (ds) => reconcile(ds).report;
const at = '2026-11-03T12:00:00Z';
const decide = (rep, findingId, note = '', decision = 'ACKNOWLEDGED') => {
  const d = createDecision(rep, { findingId, decision, reviewerId: 'REV-1', note, decidedAt: at });
  assert.equal(d.ok, true, JSON.stringify(d.errors));
  return d.decision;
};

test('decisions are inert annotations: report, totals and certification never change', () => {
  const rep = report(goldenFixture());
  const before = JSON.stringify(rep);
  let log = [];
  for (const f of rep.findings) {
    const res = appendDecision(log, rep, decide(rep, f.id, 'checked'));
    assert.equal(res.ok, true, JSON.stringify(res.errors));
    log = res.log;
  }
  assert.equal(JSON.stringify(rep), before);
  assert.equal(report(goldenFixture()).reportId, rep.reportId);
  assert.ok(log.every((d) => d.effect === 'NONE_ANNOTATION_ONLY' && Object.isFrozen(d)));
  assert.deepEqual(readiness(rep, log), { status: 'REVIEWED_NOT_CERTIFIED', certified: false, findings: 3, decided: 3, undecided: 0 });
  assert.deepEqual(readiness(rep, []), { status: 'REVIEW_INCOMPLETE', certified: false, findings: 3, decided: 0, undecided: 3 });
  assert.equal(readiness(report(correctedFixture())).status, 'NO_PRINCIPAL_FINDINGS_NOT_CERTIFIED');
  assert.equal(readiness(report(correctedFixture())).certified, false);
});

test('decisions cannot cross reports, repeat, or be forged', () => {
  const a = report(goldenFixture());
  const b = report(splitFixture());
  const shared = a.findings.find((f) => f.code === 'DUPLICATE_REPORTED_SOURCE');
  const d = decide(a, shared.id);
  assert.equal(appendDecision([], b, d).ok, false);
  assert.equal(readiness(b, [d]).decided, 0);
  assert.ok(!exportReportJson(b, [d]).includes(d.decisionId));
  assert.ok(!exportReportCsv(b, [d]).includes(d.decisionId));
  const log = appendDecision([], a, d).log;
  assert.equal(appendDecision(log, a, d).ok, false);
  assert.equal(appendDecision([], a, { ...d, effect: 'CERTIFIES_SUBMISSION' }).ok, false);
  assert.equal(appendDecision([], a, { ...d, note: 'edited' }).ok, false);
  assert.equal(appendDecision([], a, null).ok, false);
  const forged = { ...d, effect: 'CERTIFIES_SUBMISSION' };
  assert.equal(readiness(a, [forged]).decided, 0);
  assert.ok(!exportReportJson(a, [forged]).includes('CERTIFIES_SUBMISSION'));
  assert.ok(!exportReportCsv(a, [forged]).includes('CERTIFIES_SUBMISSION'));
});

test('createDecision validates strictly and never reads the clock', () => {
  const rep = report(goldenFixture());
  const fid = rep.findings[0].id;
  const bad = (input) => createDecision(rep, { findingId: fid, decision: 'DISPUTED', reviewerId: 'REV-1', decidedAt: at, ...input });
  assert.equal(bad({}).ok, true);
  for (const input of [
    { findingId: 'SLF-0000000000000000' }, { decision: 'CERTIFIED' }, { reviewerId: '=evil' },
    { note: 'x'.repeat(501) }, { note: 'a\u0000b' }, { note: 'safe‮evil' }, { decidedAt: '2026-11-03 12:00' },
    { decidedAt: '2026-11-03T12:00:00-04:00' }, { extra: 1 },
  ]) assert.equal(bad(input).ok, false, JSON.stringify(input));
  assert.equal(createDecision(rep, null).ok, false);
  assert.equal(bad({ note: 'x'.repeat(500) }).ok, true);
});

test('JSON export preserves integer minutes, raw vs dedup totals, statuses, exclusions, rules and decisions', () => {
  const ds = goldenFixture(); ds.payroll[1].status = 'VOID';
  const rep = report(ds);
  const d = decide(rep, rep.findings[0].id, '<script>alert(1)</script>');
  const out = JSON.parse(exportReportJson(rep, [d]));
  assert.equal(out.certified, false);
  assert.equal(out.readiness.certified, false);
  assert.equal(out.report.totals.rawReported, 1560);
  assert.equal(out.report.totals.dedupReported, 1080);
  assert.equal(out.report.totals.unit, 'minutes');
  assert.equal(out.report.totals.eligibleSupport, 720);
  assert.deepEqual(out.report.sourceStatuses.find((s) => s.id === 'P2').exclusions, ['STATUS_VOID']);
  assert.equal(out.report.provenance.rules.rulesetId, 'SL-FICTIONAL-RULES-1');
  assert.equal(out.decisions[0].note, '<script>alert(1)</script>');
  assert.equal(out.report.reportId, rep.reportId);
  assert.equal(exportReportJson(rep, [d]), exportReportJson(report(ds), [d]));
});

test('CSV report export is formula-safe for every cell and keeps integer minutes', () => {
  const rep = report(goldenFixture());
  const notes = ['=HYPERLINK("http://x","y")', '@SUM(A1)', '+1+1', '-2+3', '\tcmd', 'plain, "quoted"\nline2'];
  const log = rep.findings.flatMap((f, i) => [decide(rep, f.id, notes[i]), decide(rep, f.id, notes[i + 3], 'DISPUTED')]);
  const rows = parseCsv(exportReportCsv(rep, log));
  assert.deepEqual(rows[0], [...REPORT_CSV_COLUMNS]);
  for (const row of rows) {
    assert.equal(row.length, REPORT_CSV_COLUMNS.length);
    for (const cell of row) assert.ok(/^-?\d+$/.test(cell) || !/^[=+\-@\t\r]/.test(cell), cell);
  }
  const noteCol = REPORT_CSV_COLUMNS.indexOf('note');
  const exported = rows.filter((r) => r[0] === 'DECISION').map((r) => r[noteCol]).sort();
  assert.deepEqual(exported, notes.map((n) => (/^[=+\-@\t]/.test(n) ? `'${n}` : n)).sort());
  const total = (k) => rows.find((r) => r[0] === 'TOTAL' && r[1] === k)[7];
  assert.deepEqual([total('rawReported'), total('dedupReported'), total('eligibleSupport'), total('dedupMinusSupport')], ['1560', '1080', '1020', '60']);
  assert.ok(rows[1][11].includes('certified=false'));
  assert.equal(csvCell(-60), '-60');
  assert.equal(csvCell('-60'), "'-60");
  assert.throws(() => csvCell(0.5));
});

// Literal oracle tests. Expected numbers are hardcoded from the spec, never computed
// with production helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, goldenFixture, correctedFixture, splitFixture, overnightFixture, verifyReportId } from '../src/index.js';

const run = (ds) => {
  const r = reconcile(ds);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.report;
};
const codes = (report) => report.findings.map((f) => `${f.code}:${f.rowIds.join('|')}:${f.minutes}`).sort();

function assertGolden(report) {
  assert.equal(report.totals.rawReported, 1560); // 26 h
  assert.equal(report.totals.dedupReported, 1080); // 18 h
  assert.equal(report.totals.eligibleSupport, 1020); // 17 h
  assert.equal(report.totals.schedule, 1080); // 18 h
  assert.equal(report.totals.payrollEligible, 780);
  assert.equal(report.totals.agencyEligible, 240);
  assert.equal(report.totals.dedupMinusSupport, 60);
  assert.deepEqual(codes(report), [
    'CLASSIFICATION_CONFLICT:R4:240',
    'DUPLICATE_REPORTED_SOURCE:R2:480',
    'UNSUPPORTED_MINUTES:R3:60',
  ]);
  assert.equal(report.partition.matched, 780);
  assert.equal(report.partition.classificationConflict, 240);
  assert.equal(report.partition.unsupported, 60);
  assert.equal(report.partition.selectionRequired, 0);
  assert.equal(report.partition.configurationRequired, 0);
  assert.equal(report.partition.conflictingReferenceExcluded, 0);
  assert.equal(report.partition.balanced, true);
}

test('golden SL-SYN-001 literal totals and exactly three principal findings', () => {
  const report = run(goldenFixture());
  assertGolden(report);
  const dup = report.findings.find((f) => f.code === 'DUPLICATE_REPORTED_SOURCE');
  assert.deepEqual(dup.relatedRowIds, ['R1']);
  const uns = report.findings.find((f) => f.code === 'UNSUPPORTED_MINUTES');
  assert.equal(uns.personId, 'E2');
  assert.equal(uns.reason, 'EXCESS_OVER_SUPPORT');
  assert.match(uns.message, /unsupported by supplied evidence/);
  const cc = report.findings.find((f) => f.code === 'CLASSIFICATION_CONFLICT');
  assert.equal(cc.personId, 'E3');
  assert.equal(cc.role, 'CNA');
  assert.equal(cc.evidenceRole, 'RN');
  for (const f of report.findings) assert.ok(f.citations.includes('rules:SL-FICTIONAL-RULES-1'));
  assert.ok(cc.citations.some((c) => c.startsWith('sourceSelection:F1/E3/')));
  assert.equal(report.certified, false);
  assert.ok(verifyReportId(report));
});

test('golden context is separate: E2 schedule difference and no E3 double count', () => {
  const report = run(goldenFixture());
  const sched = report.context.filter((c) => c.code === 'SCHEDULE_DIFFERENCE');
  assert.deepEqual(sched.map((c) => [c.personId, c.minutes]), [['E2', 60]]);
  assert.equal(report.context.filter((c) => c.code === 'SUPPORT_SURPLUS').length, 0);
  const e3 = report.sourceStatuses.filter((s) => s.personId === 'E3');
  assert.deepEqual(e3.map((s) => [s.id, s.eligibleMinutes]), [['A1', 240]]);
});

test('corrected report: 1020 raw/dedup, no findings, schedule difference 60 remains context', () => {
  const report = run(correctedFixture());
  assert.equal(report.totals.rawReported, 1020);
  assert.equal(report.totals.dedupReported, 1020);
  assert.equal(report.totals.eligibleSupport, 1020);
  assert.equal(report.totals.dedupMinusSupport, 0);
  assert.equal(report.totals.scheduleMinusDedupReported, 60);
  assert.equal(report.findings.length, 0);
  assert.equal(report.partition.matched, 1020);
  assert.deepEqual(report.context.map((c) => `${c.code}:${c.personId}:${c.minutes}`), ['SCHEDULE_DIFFERENCE:E2:60']);
});

test('split variant: each split row matches its own support row; golden unchanged afterwards', () => {
  const report = run(splitFixture());
  assert.equal(report.totals.rawReported, 1500);
  assert.equal(report.totals.dedupReported, 1020);
  assert.equal(report.totals.eligibleSupport, 1020);
  assert.deepEqual(codes(report), ['CLASSIFICATION_CONFLICT:R4:240', 'DUPLICATE_REPORTED_SOURCE:R2:480']);
  const e2 = report.lines.filter((l) => l.personId === 'E2');
  assert.deepEqual(e2.map((l) => [l.reportedRowId, l.supportRowId, l.matched, l.unsupported]), [['R3a', 'P2a', 120, 0], ['R3b', 'P2b', 180, 0]]);
  assertGolden(run(goldenFixture()));
});

test('day-split overnight variant reconciles each work date separately', () => {
  const report = run(overnightFixture());
  assert.equal(report.findings.length, 0);
  assert.equal(report.totals.dedupReported, 480);
  assert.deepEqual(report.lines.map((l) => [l.date, l.matched]), [['2026-10-06', 120], ['2026-10-07', 360]]);
  assert.equal(report.context.length, 0);
});

// Adversarial engine cases. Expected minutes are literals from the spec or hand arithmetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { reconcile, goldenFixture, splitFixture, filterFindings, supportingRows, verifyReportId, PARTITION_KEYS } from '../src/index.js';

const D = '2026-10-05';
const rules = () => ({ rulesetId: 'SL-FICTIONAL-RULES-1', fictional: true, approvalStatus: 'ILLUSTRATIVE_UNAPPROVED', reportableRoles: ['CNA', 'RN'], eligibleStatuses: ['APPROVED'], toleranceMinutes: 0 });
const cls = (p, local, mapped = local) => ({ personId: p, localRole: local, configuredReportRole: mapped, effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31' });
const sel = (p, sourceType = 'PAYROLL', facilityId = 'F1', effectiveFrom = '2026-10-01', effectiveTo = '2026-10-31') => ({ facilityId, personId: p, effectiveFrom, effectiveTo, sourceType });
const ev = (id, personId, minutes, role = 'RN', extra = {}) => ({ id, facilityId: 'F1', personId, date: D, role, minutes, status: 'APPROVED', ...extra });
const rep = (id, personId, minutes, sourceReference, role = 'RN', extra = {}) => ({ id, facilityId: 'F1', personId, date: D, role, minutes, sourceReference, ...extra });

function mini({ persons = ['E1', 'E2', 'E3'], classifications, sourceSelections, schedule = [], payroll = [], agency = [], reported = [] } = {}) {
  return {
    schemaVersion: 'shiftledger.dataset.v1', datasetId: 'SL-ADV', rules: rules(),
    facilities: [{ id: 'F1', timezone: 'America/New_York' }, { id: 'F2', timezone: 'America/Chicago' }],
    persons: persons.map((id) => ({ id })), identityAliases: [],
    classifications: classifications ?? persons.flatMap((p) => [cls(p, 'RN'), cls(p, 'CNA')]),
    sourceSelections: sourceSelections ?? persons.map((p) => sel(p)),
    schedule, payroll, agency, reported,
  };
}
const run = (ds) => { const r = reconcile(ds); assert.equal(r.ok, true, JSON.stringify(r.errors)); return r.report; };
const fcodes = (rep) => rep.findings.map((f) => `${f.code}:${f.rowIds.join('|')}:${f.minutes}`).sort();
const ccodes = (rep) => rep.context.map((c) => `${c.code}:${c.rowIds.join('|')}:${c.minutes}`).sort();
const part = (rep) => Object.fromEntries(PARTITION_KEYS.map((k) => [k, rep.partition[k]]));
const zeroPart = { matched: 0, classificationConflict: 0, unsupported: 0, selectionRequired: 0, configurationRequired: 0, conflictingReferenceExcluded: 0 };

test('spec mix: matching-role 300 + differing-role 120 + unlinked 60 partitions 300/120/60', () => {
  const r = run(mini({
    payroll: [ev('PA', 'E1', 300), ev('PB', 'E2', 120)],
    reported: [rep('RA', 'E1', 300, 'PA'), rep('RB', 'E2', 120, 'PB', 'CNA'), rep('RC', 'E3', 60, 'NOPE')],
  }));
  assert.deepEqual(part(r), { ...zeroPart, matched: 300, classificationConflict: 120, unsupported: 60 });
  assert.equal(r.partition.balanced, true);
  assert.equal(r.totals.dedupReported, 480);
  assert.deepEqual(fcodes(r), ['CLASSIFICATION_CONFLICT:RB:120', 'UNSUPPORTED_MINUTES:RC:60']);
  assert.deepEqual(ccodes(r), ['REFERENCE_NOT_FOUND:RC:60']);
});

test('differing-role row reported 300 against 240 support: conflict 240 plus unsupported 60', () => {
  const r = run(mini({ payroll: [ev('PA', 'E1', 240)], reported: [rep('RA', 'E1', 300, 'PA', 'CNA')] }));
  assert.deepEqual(part(r), { ...zeroPart, classificationConflict: 240, unsupported: 60 });
  assert.deepEqual(fcodes(r), ['CLASSIFICATION_CONFLICT:RA:240', 'UNSUPPORTED_MINUTES:RA:60']);
  assert.equal(r.partition.balanced, true);
});

test('support surplus is context, never negative unsupported minutes', () => {
  const r = run(mini({ payroll: [ev('PA', 'E1', 480)], reported: [rep('RA', 'E1', 300, 'PA')] }));
  assert.deepEqual(part(r), { ...zeroPart, matched: 300 });
  assert.deepEqual(fcodes(r), []);
  assert.deepEqual(ccodes(r), ['SUPPORT_SURPLUS:RA:180']);
  assert.equal(r.totals.dedupMinusSupport, -180);
});

test('bad references: wrong person/date/facility/source and schedule IDs are fully unsupported, never role conflicts', () => {
  const cases = {
    REFERENCE_WRONG_CONTEXT_person: [{ payroll: [ev('P2', 'E2', 300, 'CNA')], reported: [rep('R1', 'E1', 300, 'P2', 'CNA')] }, 'REFERENCE_WRONG_CONTEXT'],
    REFERENCE_WRONG_CONTEXT_date: [{ payroll: [ev('P1', 'E1', 300, 'RN', { date: '2026-10-06' })], reported: [rep('R1', 'E1', 300, 'P1', 'CNA')] }, 'REFERENCE_WRONG_CONTEXT'],
    REFERENCE_WRONG_CONTEXT_facility: [{ sourceSelections: [sel('E1'), sel('E1', 'PAYROLL', 'F2')], payroll: [ev('P1', 'E1', 300)], reported: [rep('R1', 'E1', 300, 'P1', 'CNA', { facilityId: 'F2' })] }, 'REFERENCE_WRONG_CONTEXT'],
    REFERENCE_WRONG_SOURCE: [{ agency: [ev('A1', 'E1', 300)], reported: [rep('R1', 'E1', 300, 'A1', 'CNA')] }, 'REFERENCE_WRONG_SOURCE'],
    REFERENCE_NOT_FOUND: [{ schedule: [{ id: 'S1', facilityId: 'F1', personId: 'E1', date: D, role: 'RN', minutes: 300 }], reported: [rep('R1', 'E1', 300, 'S1', 'CNA')] }, 'REFERENCE_NOT_FOUND'],
  };
  for (const [name, [spec, code]] of Object.entries(cases)) {
    const r = run(mini({ persons: ['E1', 'E2'], ...spec }));
    assert.deepEqual(fcodes(r), ['UNSUPPORTED_MINUTES:R1:300'], name);
    assert.equal(r.findings[0].reason, code, name);
    assert.ok(ccodes(r).includes(`${code}:R1:300`), name);
    assert.deepEqual(part(r), { ...zeroPart, unsupported: 300 }, name);
  }
});

test('payroll and agency without source selection: SOURCE_SELECTION_REQUIRED, never added together', () => {
  const r = run(mini({ sourceSelections: [], payroll: [ev('P1', 'E1', 300)], agency: [ev('A1', 'E1', 300)], reported: [rep('R1', 'E1', 600, 'P1')] }));
  assert.deepEqual(fcodes(r), ['SOURCE_SELECTION_REQUIRED:R1:600']);
  assert.deepEqual(part(r), { ...zeroPart, selectionRequired: 600 });
  assert.equal(r.totals.eligibleSupport, 0);
  assert.deepEqual(r.sourceStatuses.map((s) => [s.id, s.exclusions]), [['A1', ['SOURCE_SELECTION_MISSING']], ['P1', ['SOURCE_SELECTION_MISSING']]]);
  const sel2 = run(mini({ sourceSelections: [sel('E1')], payroll: [ev('P1', 'E1', 300)], agency: [ev('A1', 'E1', 300)], reported: [rep('R1', 'E1', 300, 'P1')] }));
  assert.equal(sel2.totals.eligibleSupport, 300);
  assert.equal(sel2.sourceStatuses.find((s) => s.id === 'A1').exclusions[0], 'NOT_SELECTED_SOURCE');
});

test('effective-dated selection: gap requires selection; adjacent intervals switch source; overlaps reject', () => {
  const gap = run(mini({ sourceSelections: [sel('E1', 'PAYROLL', 'F1', '2026-10-01', '2026-10-04')], payroll: [ev('P1', 'E1', 300)], reported: [rep('R1', 'E1', 300, 'P1')] }));
  assert.deepEqual(fcodes(gap), ['SOURCE_SELECTION_REQUIRED:R1:300']);
  const sw = run(mini({ sourceSelections: [sel('E1', 'PAYROLL', 'F1', '2026-10-01', '2026-10-04'), sel('E1', 'AGENCY', 'F1', '2026-10-05', '2026-10-31')], payroll: [ev('P1', 'E1', 300)], agency: [ev('A1', 'E1', 300)], reported: [rep('R1', 'E1', 300, 'A1')] }));
  assert.deepEqual(part(sw), { ...zeroPart, matched: 300 });
  const overlap = reconcile(mini({ sourceSelections: [sel('E1', 'PAYROLL', 'F1', '2026-10-01', '2026-10-05'), sel('E1', 'AGENCY', 'F1', '2026-10-05', '2026-10-31')] }));
  assert.deepEqual(overlap.errors.map((e) => e.code), ['OVERLAPPING_INTERVAL']);
  const clsOverlap = reconcile(mini({ classifications: [cls('E1', 'RN'), { ...cls('E1', 'RN', 'CNA'), effectiveFrom: '2026-10-31', effectiveTo: '2026-11-30' }] }));
  assert.deepEqual(clsOverlap.errors.map((e) => e.code), ['OVERLAPPING_INTERVAL']);
  const inverted = reconcile(mini({ sourceSelections: [sel('E1', 'PAYROLL', 'F1', '2026-10-31', '2026-10-01')] }));
  assert.deepEqual(inverted.errors.map((e) => e.code), ['INVALID_INTERVAL']);
  const unknownFacility = reconcile(mini({ sourceSelections: [sel('E1', 'PAYROLL', 'F9')] }));
  assert.deepEqual(unknownFacility.errors.map((e) => e.code), ['UNKNOWN_FACILITY']);
  const unknownPerson = reconcile(mini({ payroll: [ev('P1', 'E9', 300)] }));
  assert.deepEqual(unknownPerson.errors.map((e) => e.code), ['UNKNOWN_PERSON']);
});

test('conflicting split references to one support row exclude the whole group; support never allocated twice', () => {
  const ds = goldenFixture();
  ds.reported[2] = rep('R3a', 'E2', 120, 'P2', 'CNA');
  ds.reported.push(rep('R3b', 'E2', 180, 'P2', 'CNA'));
  const r = run(ds);
  assert.deepEqual(fcodes(r), ['CLASSIFICATION_CONFLICT:R4:240', 'CONFLICTING_REPORTED_SOURCE:R3a|R3b:300', 'DUPLICATE_REPORTED_SOURCE:R2:480']);
  assert.equal(r.partition.conflictingReferenceExcluded, 300);
  assert.equal(r.partition.unsupported, 0);
  assert.ok(ccodes(r).includes('UNREFERENCED_SUPPORT:P2:300'));
  assert.equal(r.partition.balanced, true);
});

test('exact duplicate pair plus a differing row on the same reference; role-only difference also conflicts', () => {
  const ds = goldenFixture();
  ds.reported.push(rep('R5', 'E1', 300, 'P1'));
  const r = run(ds);
  assert.deepEqual(fcodes(r).filter((c) => !c.startsWith('CLASSIFICATION') && !c.startsWith('UNSUPPORTED')), ['CONFLICTING_REPORTED_SOURCE:R1|R5:780', 'DUPLICATE_REPORTED_SOURCE:R2:480']);
  assert.equal(r.partition.matched, 300); // only E2's R3 (300 of 360); R1 is excluded with R5
  assert.equal(r.partition.conflictingReferenceExcluded, 780);
  assert.equal(r.totals.dedupReported, 1380);
  const role = goldenFixture();
  role.reported[1].role = 'CNA';
  const rr = run(role);
  assert.ok(fcodes(rr).includes('CONFLICTING_REPORTED_SOURCE:R1|R2:960'));
  const cross = goldenFixture();
  cross.reported[1] = rep('R2', 'E2', 480, 'P1', 'RN');
  const f = run(cross).findings.find((x) => x.code === 'CONFLICTING_REPORTED_SOURCE');
  assert.deepEqual([f.facilityId, f.personId, f.date, f.role], ['F1', null, D, 'RN']);
});

test('dedup keeps the code-unit smallest ID regardless of row order; repeated support IDs reject', () => {
  const ds = mini({ payroll: [ev('P1', 'E1', 300)], reported: [rep('R9', 'E1', 300, 'P1'), rep('R10', 'E1', 300, 'P1')] });
  const a = run(ds);
  ds.reported.reverse();
  const b = run(ds);
  assert.deepEqual(fcodes(a), ['DUPLICATE_REPORTED_SOURCE:R9:300']);
  assert.equal(a.findings[0].relatedRowIds[0], 'R10');
  assert.equal(a.reportId, b.reportId);
  const dupPay = goldenFixture();
  dupPay.payroll.push({ ...dupPay.payroll[1] });
  assert.deepEqual(reconcile(dupPay).errors.map((e) => e.code), ['DUPLICATE_ID']);
});

test('void/unapproved support excluded with explanation; missing classification needs configuration', () => {
  for (const status of ['VOID', 'UNAPPROVED']) {
    const ds = goldenFixture(); ds.payroll[1].status = status;
    const r = run(ds);
    const u = r.findings.find((f) => f.code === 'UNSUPPORTED_MINUTES');
    assert.deepEqual([u.personId, u.minutes, u.reason], ['E2', 360, 'SUPPORT_EXCLUDED']);
    assert.ok(ccodes(r).includes('SOURCE_EXCLUDED:R3:300'));
    assert.deepEqual(r.context.find((c) => c.code === 'SOURCE_EXCLUDED').exclusions, [`STATUS_${status}`]);
    assert.equal(r.totals.eligibleSupport, 720);
  }
  const noCls = goldenFixture(); noCls.classifications.splice(1, 1);
  const r = run(noCls);
  assert.ok(fcodes(r).includes('CLASSIFICATION_CONFIG_REQUIRED:R3:360'));
  assert.equal(r.partition.configurationRequired, 360);
  assert.equal(r.findings.find((f) => f.code === 'CLASSIFICATION_CONFIG_REQUIRED').evidenceRole, undefined);
  const nonRep = goldenFixture(); nonRep.classifications[1].configuredReportRole = 'DIETARY';
  const n = run(nonRep);
  assert.deepEqual(n.sourceStatuses.find((s) => s.id === 'P2').exclusions, ['ROLE_NOT_REPORTABLE']);
  assert.ok(fcodes(n).includes('UNSUPPORTED_MINUTES:R3:360'));
  assert.ok(!fcodes(n).some((c) => c.startsWith('CLASSIFICATION_CONFLICT:R3')));
});

test('same person at two facilities stays separate', () => {
  const r = run(mini({
    persons: ['E1'], sourceSelections: [sel('E1'), sel('E1', 'PAYROLL', 'F2')],
    payroll: [ev('P1', 'E1', 480), ev('P9', 'E1', 480, 'RN', { facilityId: 'F2' })],
    reported: [rep('R1', 'E1', 480, 'P1'), rep('R9', 'E1', 480, 'P9', 'RN', { facilityId: 'F2' })],
  }));
  assert.deepEqual(fcodes(r), []);
  assert.deepEqual(r.lines.map((l) => [l.reportedRowId, l.facilityId, l.supportRowId, l.matched]), [['R1', 'F1', 'P1', 480], ['R9', 'F2', 'P9', 480]]);
});

test('row order permutations and repeated runs give an identical report', () => {
  const ref = run(goldenFixture());
  const ds = goldenFixture();
  for (const k of Object.keys(ds)) if (Array.isArray(ds[k])) ds[k].reverse();
  ds.rules.reportableRoles.reverse();
  assert.deepEqual(run(ds), ref);
  const rot = splitFixture();
  for (const k of Object.keys(rot)) if (Array.isArray(rot[k]) && rot[k].length) rot[k].push(rot[k].shift());
  assert.equal(run(rot).reportId, run(splitFixture()).reportId);
  assert.equal(run(goldenFixture()).reportId, ref.reportId);
});

test('host timezone cannot change results', () => {
  const url = new URL('../src/index.js', import.meta.url).href;
  const script = `const m = await import(${JSON.stringify(url)}); const g = m.reconcile(m.goldenFixture()).report; const s = m.reconcile(m.splitFixture()).report; console.log(JSON.stringify([g.reportId, s.reportId, g.totals]));`;
  const expected = JSON.stringify([run(goldenFixture()).reportId, run(splitFixture()).reportId, run(goldenFixture()).totals]);
  for (const TZ of ['UTC', 'Pacific/Kiritimati', 'America/St_Johns', 'Asia/Kathmandu']) {
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout.trim(), expected, TZ);
  }
});

test('filter, open supporting rows, and tamper-evident report IDs', () => {
  const r = run(goldenFixture());
  assert.deepEqual(filterFindings(r, { personId: 'E2' }).map((f) => [f.code, f.minutes]), [['UNSUPPORTED_MINUTES', 60]]);
  assert.deepEqual(filterFindings(r, { role: 'CNA', date: D }).map((f) => f.code), ['CLASSIFICATION_CONFLICT', 'UNSUPPORTED_MINUTES']);
  assert.deepEqual(filterFindings(r, { personId: 'E9' }), []);
  const cc = r.findings.find((f) => f.code === 'CLASSIFICATION_CONFLICT');
  const open = supportingRows(r, cc.id);
  assert.deepEqual([open.lines.map((l) => l.reportedRowId), open.sourceStatuses.map((s) => [s.id, s.sourceType, s.mappedRole])], [['R4'], [['A1', 'AGENCY', 'RN']]]);
  assert.equal(supportingRows(r, 'SLF-missing'), null);
  assert.equal(verifyReportId(r), true);
  // A copy has a consistent hash but no engine provenance, so it never verifies.
  const copy = JSON.parse(JSON.stringify(r));
  assert.equal(verifyReportId(copy), false);
  copy.totals.rawReported = 1020;
  assert.equal(verifyReportId(copy), false);
});

test('reports are frozen, provenance-stamped and never certified', () => {
  const r = run(goldenFixture());
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.findings[0]) && Object.isFrozen(r.totals));
  assert.throws(() => { r.totals.rawReported = 0; }, TypeError);
  assert.equal(r.certified, false);
  assert.match(r.reportId, /^SLR-[0-9a-f]{64}$/);
  assert.match(r.provenance.datasetHash, /^[0-9a-f]{64}$/);
  assert.equal(r.provenance.rules.fictional, true);
  assert.deepEqual(r.provenance.inputCounts, { facilities: 1, persons: 3, identityAliases: 0, classifications: 3, sourceSelections: 3, schedule: 3, payroll: 2, agency: 1, reported: 4 });
  assert.match(r.disclaimer, /not a CMS\/PBJ validator/i);
});

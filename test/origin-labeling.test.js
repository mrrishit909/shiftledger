// Per-run origin labels: bundled demo fixtures vs unverified user-supplied data. Origin comes
// from the control path only, never from file names or dataset content.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  reconcile, importDatasetJson, exportReportJson, exportReportCsv, parseCsv, goldenFixture, correctedFixture, splitFixture,
  loadBundledFixture, userSuppliedOrigin, originFor, ORIGIN_KINDS, ORIGIN_WARNING, BUNDLED_FIXTURES,
  DISCLAIMER, REPORT_SCHEMA, LEGACY_REPORT_SCHEMAS, EXPORT_SCHEMA, LEGACY_EXPORT_SCHEMAS, REPORT_CSV_COLUMNS,
} from '../src/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { BUNDLED, USER } = ORIGIN_KINDS;
const V1_DISCLAIMER = 'Synthetic illustration using explicitly fictional local rules. Not a CMS/PBJ validator, not certified compliance, not a staffing-care assessment. Unsupported means unsupported by supplied evidence, not fraud or proof of non-work.';

// The UI's two code paths, mirrored: built-in fixture controls and File.text() import.
function viaControl(name) {
  const { dataset, origin } = loadBundledFixture(name);
  const report = reconcile(dataset).report;
  return { report, origin: originFor(report, origin) };
}
function viaFile(text) {
  const imp = importDatasetJson(text);
  assert.equal(imp.ok, true);
  const report = reconcile(imp.dataset).report;
  return { report, origin: originFor(report, userSuppliedOrigin()) };
}
const jsonOrigin = (run) => JSON.parse(exportReportJson(run.report, [], run.origin)).origin;
function csvRows(run) {
  const rows = parseCsv(exportReportCsv(run.report, [], run.origin));
  return { rows, meta: rows.find((r) => r[0] === 'META'), origin: rows.find((r) => r[0] === 'ORIGIN'), disclaimer: rows.find((r) => r[0] === 'DISCLAIMER') };
}
const detail = REPORT_CSV_COLUMNS.indexOf('detail');

test('report v2 disclaimer is generic: no synthetic claim, says origin is not verified; calculations unchanged', () => {
  assert.equal(REPORT_SCHEMA, 'shiftledger.report.v2');
  assert.deepEqual([...LEGACY_REPORT_SCHEMAS], ['shiftledger.report.v1']);
  assert.doesNotMatch(DISCLAIMER, /synthetic illustration/i);
  assert.match(DISCLAIMER, /does not verify where the input came from/);
  assert.match(DISCLAIMER, /cannot tell synthetic from real data/);
  assert.match(DISCLAIMER, /not a CMS\/PBJ validator/i);
  for (const fx of [goldenFixture, correctedFixture]) {
    const r = reconcile(fx()).report;
    assert.equal(r.disclaimer, DISCLAIMER);
    assert.equal(r.reportSchema, REPORT_SCHEMA);
  }
  const g = reconcile(goldenFixture()).report;
  assert.deepEqual([g.totals.rawReported, g.totals.dedupReported, g.totals.eligibleSupport], [1560, 1080, 1020]);
  assert.equal(reconcile(correctedFixture()).report.findings.length, 0);
});

test('both bundled fixture controls label runs and JSON/CSV exports as synthetic demo', () => {
  assert.deepEqual([...BUNDLED_FIXTURES], ['golden', 'corrected']);
  for (const [name, datasetId] of [['golden', 'SL-SYN-001'], ['corrected', 'SL-SYN-001-CORRECTED']]) {
    const run = viaControl(name);
    assert.equal(run.report.provenance.datasetId, datasetId);
    assert.equal(run.origin.kind, BUNDLED);
    assert.ok(Object.isFrozen(run.origin));
    const j = jsonOrigin(run);
    assert.deepEqual(j, {
      kind: BUNDLED, fixture: name, basis: 'BUILT_IN_CONTROL', contentInspected: false,
      statement: `Synthetic demo data: the bundled fictional "${name}" fixture, loaded by a built-in ShiftLedger control.`,
      warning: ORIGIN_WARNING,
    });
    const out = JSON.parse(exportReportJson(run.report, [], run.origin));
    assert.equal(out.exportSchema, 'shiftledger.export.v2');
    assert.equal(out.certified, false);
    const c = csvRows(run);
    assert.equal(c.rows[1][0], 'META');
    assert.match(c.meta[detail], new RegExp(`;exportSchema=${EXPORT_SCHEMA};reportSchema=${REPORT_SCHEMA};origin=${BUNDLED}$`));
    assert.deepEqual([c.origin[1], c.origin[2]], [BUNDLED, name]);
    assert.ok(c.origin[detail].endsWith(ORIGIN_WARNING));
    assert.equal(c.disclaimer[detail], DISCLAIMER);
  }
});

test('arbitrary file import is unverified user-supplied data in UI origin, JSON and CSV', () => {
  const ds = splitFixture();
  ds.datasetId = 'ACME-REAL-2026-10';
  const run = viaFile(JSON.stringify(ds));
  assert.equal(run.origin.kind, USER);
  const j = jsonOrigin(run);
  assert.equal(j.kind, USER);
  assert.equal(j.fixture, null);
  assert.equal(j.basis, 'USER_SUPPLIED');
  assert.equal(j.contentInspected, false);
  assert.match(j.statement, /^Unverified user-supplied data\./);
  assert.match(j.statement, /may contain real personal or staffing information/);
  assert.match(j.warning, /do not inspect content and cannot detect or prevent real or sensitive data/);
  assert.match(j.warning, /does not make data safe/);
  const c = csvRows(run);
  assert.match(c.meta[detail], new RegExp(`;origin=${USER}$`));
  assert.deepEqual([c.origin[1], c.origin[2]], [USER, 'NONE']);
  assert.match(c.origin[detail], /^Unverified user-supplied data\./);
  assert.doesNotMatch(exportReportCsv(run.report, [], run.origin), /Synthetic (demo|illustration)/);
  assert.doesNotMatch(exportReportJson(run.report, [], run.origin), /Synthetic (demo|illustration)/);
});

test('spoofed metadata, file names and byte-identical fixture content never earn a bundled label', () => {
  // A file that copies the golden fixture exactly (same datasetId, rulesetId, fictional:true,
  // same hash) is still a file: origin comes from the control path, not content.
  const run = viaFile(JSON.stringify(goldenFixture()));
  const bundled = viaControl('golden');
  assert.equal(run.report.reportId, bundled.report.reportId);
  assert.equal(run.origin.kind, USER);
  assert.equal(jsonOrigin(run).kind, USER);
  // File name is only shown in the UI label; it is never an input to origin.
  const ui = readFileSync(join(ROOT, 'public', 'app', 'app.js'), 'utf8');
  assert.match(ui, /stage\(`Imported file: \$\{file\.name\}`, res\.dataset, userSuppliedOrigin\(\)\)/);
  // Hand-built, cloned, inherited or JSON-roundtripped origin records are not minted.
  const real = loadBundledFixture('golden').origin;
  const forged = [
    { kind: BUNDLED, fixture: 'golden', datasetHash: bundled.report.provenance.datasetHash, basis: 'BUILT_IN_CONTROL', contentInspected: false, statement: 'x', warning: 'y' },
    structuredClone(real), JSON.parse(JSON.stringify(real)), { ...real }, Object.create(real),
    new Proxy(real, {}), BUNDLED, 'golden', null, undefined, 1, [],
  ];
  for (const o of forged) {
    assert.equal(originFor(bundled.report, o).kind, USER);
    assert.equal(JSON.parse(exportReportJson(bundled.report, [], o)).origin.kind, USER);
    assert.match(exportReportCsv(bundled.report, [], o), new RegExp(`origin=${USER}`));
  }
  // Only the two bundled names exist; prototype keys and other fixtures are rejected.
  for (const name of ['split', 'overnight', '__proto__', 'constructor', 'toString', 'Golden', '', null, {}]) {
    assert.throws(() => loadBundledFixture(name), (e) => e instanceof TypeError && e.code === 'INVALID_ARGUMENT', String(name));
  }
});

test('omitted origin defaults to unverified (existing two-argument callers)', () => {
  const r = reconcile(goldenFixture()).report;
  assert.equal(JSON.parse(exportReportJson(r)).origin.kind, USER);
  assert.equal(JSON.parse(exportReportJson(r, [])).origin.kind, USER);
  assert.match(exportReportCsv(r, []), new RegExp(`origin=${USER}`));
});

test('a bundled origin binds to its own fixture run: mismatched or edited data is downgraded', () => {
  const golden = loadBundledFixture('golden');
  const corrected = viaControl('corrected');
  assert.equal(originFor(corrected.report, golden.origin).kind, USER);
  assert.equal(JSON.parse(exportReportJson(corrected.report, [], golden.origin)).origin.kind, USER);
  const edited = loadBundledFixture('golden');
  edited.dataset.reported[0].minutes = 470;
  const r = reconcile(edited.dataset).report;
  assert.equal(originFor(r, edited.origin).kind, USER);
  // A bundled dataset reconciled from a later fresh load still matches its fixture hash.
  assert.equal(originFor(reconcile(goldenFixture()).report, golden.origin).kind, BUNDLED);
});

test('repeated runs and source changes keep each history entry and its exports on its own origin', () => {
  // Mirrors the UI: history entries store originFor(report, stagedOrigin) at run time.
  const history = [];
  const push = (run) => history.push(run);
  push(viaControl('golden'));
  push(viaFile(JSON.stringify(splitFixture())));
  push(viaControl('corrected'));
  push(viaFile(JSON.stringify(correctedFixture()))); // same content as run 3, different control
  push(viaControl('corrected')); // rerun with corrected source
  push(viaFile(JSON.stringify(goldenFixture())));
  const expected = [BUNDLED, USER, BUNDLED, USER, BUNDLED, USER];
  assert.deepEqual(history.map((h) => h.origin.kind), expected);
  // Revisit earlier entries after later runs: exports still carry the entry's own origin.
  for (const [i, h] of history.entries()) {
    assert.equal(jsonOrigin(h).kind, expected[i], `run ${i + 1} JSON`);
    assert.equal(csvRows(h).origin[1], expected[i], `run ${i + 1} CSV`);
  }
  assert.equal(history[2].report.reportId, history[3].report.reportId);
  const a = JSON.parse(exportReportJson(history[2].report, [], history[2].origin));
  const b = JSON.parse(exportReportJson(history[3].report, [], history[3].origin));
  assert.deepEqual(a.report, b.report);
  assert.notDeepEqual(a.origin, b.origin);
});

test('legacy v1 reports and exports are never promoted or re-exported as synthetic', () => {
  assert.equal(EXPORT_SCHEMA, 'shiftledger.export.v2');
  assert.deepEqual([...LEGACY_EXPORT_SCHEMAS], ['shiftledger.export.v1']);
  const run = viaControl('golden');
  // Shape of a v1 export: unconditional synthetic disclaimer, no origin.
  const legacy = JSON.parse(exportReportJson(run.report, [], run.origin));
  legacy.exportSchema = 'shiftledger.export.v1';
  delete legacy.origin;
  legacy.report.reportSchema = 'shiftledger.report.v1';
  legacy.report.disclaimer = V1_DISCLAIMER;
  const origin = loadBundledFixture('golden').origin;
  for (const fn of [exportReportJson, exportReportCsv]) {
    assert.throws(() => fn(legacy.report, [], origin), (e) => e.code === 'UNTRUSTED_REPORT');
    assert.throws(() => fn(legacy, [], origin), (e) => e.code === 'UNTRUSTED_REPORT');
  }
  assert.equal(originFor(legacy.report, origin).kind, USER);
  // A current-schema copy (even unmodified) is not accepted either; only a fresh reconcile is.
  const copy = JSON.parse(JSON.stringify(run.report));
  assert.equal(originFor(copy, origin).kind, USER);
  assert.throws(() => exportReportJson(copy, [], origin), (e) => e.code === 'UNTRUSTED_REPORT');
  // The engine never emits the v1 disclaimer any more.
  for (const fx of [goldenFixture, correctedFixture, splitFixture]) assert.doesNotMatch(JSON.stringify(reconcile(fx()).report), /Synthetic illustration/);
});

test('new CSV rows keep the fixed width and formula safety', () => {
  for (const run of [viaControl('golden'), viaFile(JSON.stringify(splitFixture()))]) {
    const { rows } = csvRows(run);
    for (const row of rows) {
      assert.equal(row.length, REPORT_CSV_COLUMNS.length);
      for (const cell of row) assert.ok(/^-?\d+$/.test(cell) || !/^[=+\-@\t\r]/.test(cell), cell);
    }
    assert.deepEqual(rows.slice(1, 4).map((r) => r[0]), ['META', 'ORIGIN', 'DISCLAIMER']);
  }
});

test('UI wires origin from the control path and keeps the local-only claim aligned with the code', () => {
  const ui = readFileSync(join(ROOT, 'public', 'app', 'app.js'), 'utf8');
  const html = readFileSync(join(ROOT, 'public', 'app', 'index.html'), 'utf8');
  const landing = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
  // Bundled origin only from the three fixture buttons; raw fixture functions are not imported.
  assert.doesNotMatch(ui, /goldenFixture|correctedFixture/);
  assert.equal([...ui.matchAll(/bundled\('[^']+', '(golden|corrected)'\)/g)].length, 3);
  assert.equal([...ui.matchAll(/loadBundledFixture\(/g)].length, 1); // only inside the bundled() helper
  assert.match(ui, /origin: originFor\(res\.report, stagedOrigin\)/);
  assert.match(ui, /exportReportJson\(e\.report, e\.log, e\.origin\)/);
  assert.match(ui, /exportReportCsv\(e\.report, e\.log, e\.origin\)/);
  assert.match(ui, /'Unverified user-supplied data'/);
  assert.match(ui, /\$\('origin'\)/);
  assert.match(html, /id="origin"/);
  // Local-only: File.text() read, no network APIs, CSP blocks connections.
  assert.match(ui, /file\.text\(\)/);
  assert.doesNotMatch(ui, /fetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/);
  assert.match(html, /connect-src 'none'/);
  // No page claims all data is synthetic.
  assert.doesNotMatch(html, /<title>Synthetic review/);
  assert.doesNotMatch(landing, /fictional data and fictional rules|Synthetic data and explicitly fictional local rules only|Open synthetic review/);
  assert.match(html, /cannot tell whether a file holds real or sensitive information/);
  assert.match(landing, /cannot detect or prevent real or sensitive data/);
});

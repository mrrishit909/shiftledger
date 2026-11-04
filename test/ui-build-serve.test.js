// Workflow checks for the browser build: dist contents, no Node-only engine APIs, no HTML
// interpolation in UI code, and the 127.0.0.1 preview server's traversal and header guards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { get, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from '../scripts/build.mjs';
import { createServer } from '../scripts/serve.mjs';

const out = build(join(mkdtempSync(join(tmpdir(), 'shiftledger-')), 'dist'));
test.after(() => rmSync(join(out, '..'), { recursive: true, force: true }));

test('dist ships the UI and engine only', () => {
  for (const f of ['index.html', 'styles.css', 'app/index.html', 'app/app.js', 'src/index.js', 'src/canonical.js', 'src/origin.js']) assert.ok(existsSync(join(out, f)), f);
  for (const f of ['docs', 'test', 'README.md', 'package.json', 'scripts', '.git']) assert.ok(!existsSync(join(out, f)), `${f} must not ship`);
});

test('shipped engine has no node: imports or Buffer', () => {
  for (const f of readdirSync(join(out, 'src'))) {
    const text = readFileSync(join(out, 'src', f), 'utf8');
    assert.doesNotMatch(text, /from 'node:|require\(|Buffer\./, f);
  }
});

test('UI code never interpolates HTML', () => {
  const js = readFileSync(join(out, 'app', 'app.js'), 'utf8');
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  for (const f of ['index.html', 'app/index.html']) assert.doesNotMatch(readFileSync(join(out, f), 'utf8'), /style="|<script>|\son[a-z]+="/, f);
});

test('engine workflow used by the UI: import, reconcile, decide, export, rerun', async () => {
  const m = await import(join(out, 'src', 'index.js'));
  const imp = m.importDatasetJson(JSON.stringify(m.goldenFixture()));
  assert.equal(imp.ok, true);
  const r = m.reconcile(imp.dataset);
  assert.equal(r.ok, true);
  assert.deepEqual(r.report.findings.map((f) => f.code).sort(), ['CLASSIFICATION_CONFLICT', 'DUPLICATE_REPORTED_SOURCE', 'UNSUPPORTED_MINUTES']);
  assert.deepEqual([r.report.totals.rawReported, r.report.totals.dedupReported, r.report.totals.eligibleSupport], [1560, 1080, 1020]);
  assert.equal(m.filterFindings(r.report, { personId: 'E2', date: undefined, role: undefined, code: undefined }).length, 1);
  const f = r.report.findings[0];
  assert.ok(m.supportingRows(r.report, f.id).lines.length >= 1);
  const decidedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const d = m.createDecision(r.report, { findingId: f.id, decision: 'ACKNOWLEDGED', reviewerId: 'reviewer.demo', note: 'checked', decidedAt });
  assert.equal(d.ok, true);
  const log = m.appendDecision(Object.freeze([]), r.report, d.decision);
  assert.equal(log.ok, true);
  assert.match(m.exportReportJson(r.report, log.log), /"certified":false/);
  assert.match(m.exportReportCsv(r.report, log.log), /^recordType,/);
  // Imported JSON (the file path) is unverified even with fixture content; the built-in control is synthetic demo.
  assert.equal(JSON.parse(m.exportReportJson(r.report, log.log, m.userSuppliedOrigin())).origin.kind, 'USER_SUPPLIED_UNVERIFIED');
  const demo = m.loadBundledFixture('golden');
  const demoReport = m.reconcile(demo.dataset).report;
  assert.equal(JSON.parse(m.exportReportJson(demoReport, [], m.originFor(demoReport, demo.origin))).origin.kind, 'BUNDLED_SYNTHETIC_DEMO');
  assert.equal(m.reconcile(m.correctedFixture()).report.findings.length, 0);
  assert.equal(m.importDatasetJson('x'.repeat(m.LIMITS.maxBytes + 1)).errors[0].code, 'SIZE_LIMIT_EXCEEDED');
  assert.equal(m.importDatasetJson('{').ok, false);
});

function raw(port, path, method = 'GET') {
  return new Promise((ok, fail) => {
    const req = (method === 'GET' ? get : request)({ host: '127.0.0.1', port, path, method }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', fail);
    if (method !== 'GET') req.end();
  });
}

test('preview server: files, MIME, redirects, traversal and method guards', async () => {
  const server = createServer(out);
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address();
  try {
    const home = await raw(port, '/');
    assert.equal(home.status, 200);
    assert.match(home.headers['content-type'], /^text\/html/);
    assert.equal(home.headers['x-content-type-options'], 'nosniff');
    assert.equal((await raw(port, '/app')).status, 301);
    assert.match((await raw(port, '/app/app.js')).headers['content-type'], /^text\/javascript/);
    assert.match((await raw(port, '/src/index.js')).headers['content-type'], /^text\/javascript/);
    for (const p of ['/..%2f..%2fpackage.json', '/%2e%2e/README.md', '/../README.md', '/%2e%2e%2f%2e%2e%2ftest', '/app/..%2f..%2fscripts/serve.mjs', '/%00', '/%E0%A4%A']) {
      const r = await raw(port, p);
      assert.ok(r.status >= 400 && r.status < 500, `${p} -> ${r.status}`);
      assert.doesNotMatch(r.body, /"name": "shiftledger"|ShiftLedger engine|createServer/);
    }
    assert.equal((await raw(port, '/missing.html')).status, 404);
    assert.equal((await raw(port, '/', 'POST')).status, 405);
  } finally {
    server.close();
  }
});

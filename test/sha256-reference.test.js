// Independent check: the pure sha256Hex must match node:crypto byte-for-byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJson, sha256Hex, utf8ByteLength } from '../src/canonical.js';
import { reconcile, goldenFixture, correctedFixture } from '../src/index.js';

const ref = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

test('known NIST vectors', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('every length 0..200 (all padding boundaries) matches node:crypto', () => {
  for (let n = 0; n <= 200; n++) {
    const s = 'x'.repeat(n);
    assert.equal(sha256Hex(s), ref(s), `length ${n}`);
  }
});

test('Unicode, multi-byte and lone surrogates match node:crypto', () => {
  for (const s of ['é', '日本語', '😀', 'a😀b', '\uD800', 'a\uDC00', '\u0000', 'Ω'.repeat(55), '😀'.repeat(16)]) {
    assert.equal(sha256Hex(s), ref(s), JSON.stringify(s));
    assert.equal(utf8ByteLength(s), Buffer.byteLength(s, 'utf8'), `bytes ${JSON.stringify(s)}`);
  }
});

test('large input (~2 MiB) matches node:crypto', () => {
  const s = 'ShiftLedger-日本-😀-'.repeat(100000);
  assert.ok(utf8ByteLength(s) > 2 * 1024 * 1024);
  assert.equal(sha256Hex(s), ref(s));
});

// shiftledger.report.v1 checkpoint IDs. v2 changed only reportSchema and the disclaimer text.
const V1_IDS = { golden: 'SLR-9b005d975cbec0c63ca51cedb5e7341f7fa88bb894d5e4a225e8b4809ff1a842', corrected: 'SLR-05758d8b5346a7f7934d9394e196b1121429d36f427009fe5d4af1da0af927c3' };
const V1_DISCLAIMER = 'Synthetic illustration using explicitly fictional local rules. Not a CMS/PBJ validator, not certified compliance, not a staffing-care assessment. Unsupported means unsupported by supplied evidence, not fraud or proof of non-work.';

test('golden and corrected v2 report IDs are pinned against the node:crypto checkpoint', () => {
  assert.equal(reconcile(goldenFixture()).report.reportId, 'SLR-1cc0c9b7479558c3838b3c6760358559ddf348b0d5606f20387b7b722d6221dc');
  assert.equal(reconcile(correctedFixture()).report.reportId, 'SLR-599bc2fc596d1dd42c3141827e2801d12e2393929d9e628eeb9165e84d06e583');
});

test('v2 calculation content is byte-identical to v1: restoring the two v1 header fields reproduces the v1 IDs', () => {
  for (const [name, fx] of [['golden', goldenFixture], ['corrected', correctedFixture]]) {
    const { reportId, ...body } = reconcile(fx()).report;
    assert.equal(body.reportSchema, 'shiftledger.report.v2');
    assert.doesNotMatch(body.disclaimer, /synthetic illustration/i);
    const v1Body = { ...body, reportSchema: 'shiftledger.report.v1', disclaimer: V1_DISCLAIMER };
    assert.equal(`SLR-${ref(canonicalJson(v1Body))}`, V1_IDS[name], name);
  }
});

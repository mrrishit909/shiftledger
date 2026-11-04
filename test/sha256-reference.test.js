// Independent check: the pure sha256Hex must match node:crypto byte-for-byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Hex, utf8ByteLength } from '../src/canonical.js';
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

test('golden and corrected report IDs are unchanged from the node:crypto checkpoint', () => {
  assert.equal(reconcile(goldenFixture()).report.reportId, 'SLR-9b005d975cbec0c63ca51cedb5e7341f7fa88bb894d5e4a225e8b4809ff1a842');
  assert.equal(reconcile(correctedFixture()).report.reportId, 'SLR-05758d8b5346a7f7934d9394e196b1121429d36f427009fe5d4af1da0af927c3');
});

// Per-run data origin. Origin comes from the control path that supplied the data: only
// loadBundledFixture() can produce a bundled synthetic-demo origin, and it generates the
// dataset itself. Nothing in the data (a field, datasetId, rulesetId, `fictional: true`)
// and nothing about a file (its name or type) can claim a bundled origin. Origin labels never
// inspect content, so they cannot detect or prevent real or sensitive data.
import { deepFreeze } from './canonical.js';
import { argumentError, datasetHash, isEngineReport } from './engine.js';
import { correctedFixture, goldenFixture } from './fixtures.js';

export const ORIGIN_KINDS = Object.freeze({ BUNDLED: 'BUNDLED_SYNTHETIC_DEMO', USER: 'USER_SUPPLIED_UNVERIFIED' });
export const ORIGIN_WARNING = 'Origin labels record only which ShiftLedger control supplied the data. They do not inspect content and cannot detect or prevent real or sensitive data, and a label does not make data safe to share.';

// The two fixtures the browser workspace can load from its built-in controls.
const BUNDLED = Object.freeze({ golden: goldenFixture, corrected: correctedFixture });
export const BUNDLED_FIXTURES = Object.freeze(Object.keys(BUNDLED));

// Origins minted in this process (module-private). Copies and hand-built objects never count.
const MINTED = new WeakSet();
const mint = (o) => { const r = deepFreeze(o); MINTED.add(r); return r; };

const USER_ORIGIN = mint({
  kind: ORIGIN_KINDS.USER, fixture: null, datasetHash: null, basis: 'USER_SUPPLIED', contentInspected: false,
  statement: 'Unverified user-supplied data. It came from a local file or a caller, not a bundled demo fixture; its origin is not verified and it may contain real personal or staffing information.',
  warning: ORIGIN_WARNING,
});

/**
 * A fresh bundled demo fixture and its origin record. The dataset is generated here, never
 * accepted from the caller. Throws TypeError (code INVALID_ARGUMENT) for an unknown name.
 */
export function loadBundledFixture(name) {
  if (typeof name !== 'string' || !Object.hasOwn(BUNDLED, name)) throw argumentError('INVALID_ARGUMENT', `bundled fixture must be one of ${BUNDLED_FIXTURES.join(', ')}`);
  const dataset = BUNDLED[name]();
  const origin = mint({
    kind: ORIGIN_KINDS.BUNDLED, fixture: name, datasetHash: datasetHash(dataset), basis: 'BUILT_IN_CONTROL', contentInspected: false,
    statement: `Synthetic demo data: the bundled fictional "${name}" fixture, loaded by a built-in ShiftLedger control.`,
    warning: ORIGIN_WARNING,
  });
  return { dataset, origin };
}

/** The origin for any data that did not come from loadBundledFixture (file import, API callers). */
export function userSuppliedOrigin() {
  return USER_ORIGIN;
}

/**
 * The origin to show and export for `report`. Bundled only when `origin` is a minted bundled
 * record AND the report was computed from that exact fixture (dataset hash match, so an edited
 * dataset or a different run cannot inherit it). Anything else, including omitted, copied or
 * spoofed origins, is user-supplied and unverified. The hash check can only downgrade: a file
 * whose content equals a fixture is still unverified. Never throws.
 */
export function originFor(report, origin) {
  if (!MINTED.has(origin) || origin.kind !== ORIGIN_KINDS.BUNDLED || !isEngineReport(report)) return USER_ORIGIN;
  return report.provenance.datasetHash === origin.datasetHash ? origin : USER_ORIGIN;
}

/** Plain export view of an origin (no internal binding hash). */
export function originView(origin) {
  const { kind, fixture, basis, contentInspected, statement, warning } = origin;
  return { kind, fixture, basis, contentInspected, statement, warning };
}

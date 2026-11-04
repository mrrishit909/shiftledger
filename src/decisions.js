// Inert reviewer decisions. A decision is an annotation bound to one report hash and one
// finding. It never alters source records, findings, totals, or certification status.
import { deepFreeze, stableId } from './canonical.js';
import { argumentError, assertEngineReport, isEngineReport } from './engine.js';
import { LIMITS, isUtcTimestamp } from './validate.js';

export const DECISION_TYPES = Object.freeze(['ACKNOWLEDGED', 'DISPUTED', 'NEEDS_EVIDENCE']);
const FIELDS = ['findingId', 'decision', 'reviewerId', 'note', 'decidedAt'];
const REVIEWER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
// Control characters other than tab/newline are rejected; bidi overrides too.
const BAD_NOTE_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F‪-‮⁦-⁩]/;
// Decisions minted by createDecision in this process (module-private, deep-frozen). Copies,
// edits and hand-built records are never members, so they can never count as reviewed.
const MINTED_DECISIONS = new WeakSet();

const error = (code, path, message) => ({ code, path, message });
const fail = (code, path, message) => ({ ok: false, errors: [error(code, path, message)] });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const UNTRUSTED = ['UNTRUSTED_REPORT', 'report', 'report must be the unmodified object returned by reconcile() in this process'];

/**
 * Create a decision for a finding in `report`. `decidedAt` is caller-supplied (UTC, Z);
 * the engine never reads the clock. Never throws.
 * @returns {{ok:true, decision:object} | {ok:false, errors:Array<{code,path,message}>}}
 */
export function createDecision(report, input) {
  if (!isEngineReport(report)) return fail(...UNTRUSTED);
  const v = Object.create(null); // null prototype: a polluted Object.prototype cannot fill gaps
  const errors = [];
  try {
    if (!isPlainObject(input)) return fail('INVALID_DECISION', '$', 'decision input must be a plain object');
    // Own properties only, each read exactly once; inherited or polluted values never count.
    for (const k of Reflect.ownKeys(input)) {
      if (FIELDS.includes(k)) v[k] = input[k];
      else errors.push(error('UNKNOWN_FIELD', `$.${String(k)}`, `unknown field "${String(k)}"`));
    }
  } catch {
    return fail('INVALID_DECISION', '$', 'decision input could not be read');
  }
  const { findingId, decision, reviewerId, decidedAt } = v;
  const note = Object.hasOwn(v, 'note') ? v.note : '';
  if (typeof findingId !== 'string' || !report.findings.some((f) => f.id === findingId)) errors.push(error('UNKNOWN_FINDING', '$.findingId', `findingId must name a finding in report ${report.reportId}`));
  if (!DECISION_TYPES.includes(decision)) errors.push(error('INVALID_DECISION_TYPE', '$.decision', `decision must be one of ${DECISION_TYPES.join('|')}`));
  if (typeof reviewerId !== 'string' || !REVIEWER_RE.test(reviewerId)) errors.push(error('INVALID_ID', '$.reviewerId', 'reviewerId must be an ID'));
  if (typeof note !== 'string' || note.length > LIMITS.maxNoteLength) errors.push(error('INVALID_NOTE', '$.note', `note must be a string of at most ${LIMITS.maxNoteLength} characters`));
  else if (BAD_NOTE_CHARS.test(note)) errors.push(error('INVALID_NOTE', '$.note', 'note contains control or bidi-override characters'));
  if (!isUtcTimestamp(decidedAt)) errors.push(error('INVALID_TIMESTAMP', '$.decidedAt', 'decidedAt must be a real UTC instant YYYY-MM-DDTHH:MM:SSZ (hours 00-23, minutes and seconds 00-59)'));
  if (errors.length) return { ok: false, errors };
  const record = deepFreeze({
    decisionId: stableId('SLD', [report.reportId, findingId, decision, reviewerId, note, decidedAt]),
    reportId: report.reportId,
    datasetId: report.provenance.datasetId,
    findingId, decision, reviewerId, note, decidedAt,
    effect: 'NONE_ANNOTATION_ONLY',
  });
  MINTED_DECISIONS.add(record);
  return { ok: true, decision: record };
}

/**
 * True when `decision` is an unmodified createDecision record for a finding of this report
 * (bound by reportId, so a re-run of the same dataset accepts it). Never throws.
 */
export function isAuthenticDecision(report, decision) {
  if (!isEngineReport(report) || !MINTED_DECISIONS.has(decision)) return false;
  return decision.reportId === report.reportId && report.findings.some((f) => f.id === decision.findingId);
}

/** One snapshot of a log: authentic decisions for `report`, deduplicated by decisionId. */
function authenticLog(report, log) {
  if (log === undefined) return [];
  if (!Array.isArray(log)) throw argumentError('INVALID_ARGUMENT', 'decision log must be an array');
  const out = [];
  const seen = new Set();
  for (let i = 0; i < log.length; i++) {
    const d = log[i];
    if (isAuthenticDecision(report, d) && !seen.has(d.decisionId)) { seen.add(d.decisionId); out.push(d); }
  }
  return out;
}

/**
 * Append to an immutable decision log. Rejects another report's decisions, duplicates, and
 * any decision or log entry that is not an unmodified createDecision record. Never throws.
 */
export function appendDecision(log, report, decision) {
  if (!isEngineReport(report)) return fail(...UNTRUSTED);
  if (!Array.isArray(log)) return fail('INVALID_LOG', 'log', 'log must be an array');
  if (!MINTED_DECISIONS.has(decision)) return fail('INVALID_DECISION', 'decision', 'decision is not an unmodified createDecision record');
  if (decision.reportId !== report.reportId) return fail('CROSS_REPORT_DECISION', 'decision', 'decision belongs to a different report/session');
  if (!isAuthenticDecision(report, decision)) return fail('INVALID_DECISION', 'decision', 'decision does not match a finding of this report');
  const entries = [];
  for (let i = 0; i < log.length; i++) {
    const d = log[i];
    if (!isAuthenticDecision(report, d)) return fail('INVALID_LOG', `log[${i}]`, 'log entry is not an unmodified createDecision record for this report');
    entries.push(d);
  }
  if (entries.some((d) => d.decisionId === decision.decisionId)) return fail('DUPLICATE_DECISION', 'decision', 'decision already recorded');
  return { ok: true, log: Object.freeze([...entries, decision]) };
}

/** Authentic decisions from `log` for `report`; everything else is ignored. Throws TypeError (`.code`) on a bad report or non-array log. */
export function ownDecisions(report, log) {
  assertEngineReport(report);
  return Object.freeze(authenticLog(report, log));
}

function summarize(report, own) {
  const decided = new Set(own.map((d) => d.findingId));
  const open = report.findings.filter((f) => !decided.has(f.id)).length;
  let status;
  if (report.findings.length === 0) status = 'NO_PRINCIPAL_FINDINGS_NOT_CERTIFIED';
  else if (open > 0) status = 'REVIEW_INCOMPLETE';
  else status = 'REVIEWED_NOT_CERTIFIED';
  return { status, certified: false, findings: report.findings.length, decided: report.findings.length - open, undecided: open };
}

/** Review readiness summary. Never yields a certified status. Throws TypeError (`.code`) on a bad report or non-array log. */
export function readiness(report, log) {
  assertEngineReport(report);
  return summarize(report, authenticLog(report, log));
}

/** Internal for exports: the log is read once, so readiness and listed decisions always agree. */
export function reviewSnapshot(report, log) {
  assertEngineReport(report);
  const decisions = authenticLog(report, log);
  return { decisions, readiness: summarize(report, decisions) };
}

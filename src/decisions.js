// Inert reviewer decisions. A decision is an annotation bound to one report hash and one
// finding. It never alters source records, findings, totals, or certification status.
import { deepFreeze, stableId } from './canonical.js';
import { LIMITS } from './validate.js';

export const DECISION_TYPES = Object.freeze(['ACKNOWLEDGED', 'DISPUTED', 'NEEDS_EVIDENCE']);
const FIELDS = ['findingId', 'decision', 'reviewerId', 'note', 'decidedAt'];
const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const REVIEWER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
// Control characters other than tab/newline are rejected; bidi overrides too.
const BAD_NOTE_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F‪-‮⁦-⁩]/;

/**
 * Create a decision for a finding in `report`. `decidedAt` is caller-supplied (UTC, Z);
 * the engine never reads the clock.
 * @returns {{ok:true, decision:object} | {ok:false, errors:string[]}}
 */
export function createDecision(report, input) {
  const errors = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['decision must be an object'] };
  for (const k of Object.keys(input)) if (!FIELDS.includes(k)) errors.push(`unknown field "${k}"`);
  const { findingId, decision, reviewerId, note = '', decidedAt } = input;
  if (!report.findings.some((f) => f.id === findingId)) errors.push(`finding "${findingId}" is not in report ${report.reportId}`);
  if (!DECISION_TYPES.includes(decision)) errors.push(`decision must be one of ${DECISION_TYPES.join('|')}`);
  if (typeof reviewerId !== 'string' || !REVIEWER_RE.test(reviewerId)) errors.push('reviewerId must be an ID');
  if (typeof note !== 'string' || note.length > LIMITS.maxNoteLength) errors.push(`note must be a string of at most ${LIMITS.maxNoteLength} characters`);
  else if (BAD_NOTE_CHARS.test(note)) errors.push('note contains control or bidi-override characters');
  if (typeof decidedAt !== 'string' || !UTC_RE.test(decidedAt)) errors.push('decidedAt must be an explicit UTC timestamp YYYY-MM-DDTHH:MM:SSZ');
  if (errors.length) return { ok: false, errors };
  const record = {
    decisionId: stableId('SLD', [report.reportId, findingId, decision, reviewerId, note, decidedAt]),
    reportId: report.reportId,
    datasetId: report.provenance.datasetId,
    findingId, decision, reviewerId, note, decidedAt,
    effect: 'NONE_ANNOTATION_ONLY',
  };
  return { ok: true, decision: deepFreeze(record) };
}

/** Append to an immutable decision log; rejects decisions bound to another report. */
export function appendDecision(log, report, decision) {
  if (decision.reportId !== report.reportId) return { ok: false, errors: ['decision belongs to a different report/session'] };
  if (log.some((d) => d.reportId !== report.reportId)) return { ok: false, errors: ['log contains decisions for a different report/session'] };
  if (log.some((d) => d.decisionId === decision.decisionId)) return { ok: false, errors: ['decision already recorded'] };
  return { ok: true, log: Object.freeze([...log, decision]) };
}

/** Review readiness summary. Never yields a certified status. */
export function readiness(report, log = []) {
  const own = log.filter((d) => d.reportId === report.reportId);
  const decided = new Set(own.map((d) => d.findingId));
  const open = report.findings.filter((f) => !decided.has(f.id)).length;
  let status;
  if (report.findings.length === 0) status = 'NO_PRINCIPAL_FINDINGS_NOT_CERTIFIED';
  else if (open > 0) status = 'REVIEW_INCOMPLETE';
  else status = 'REVIEWED_NOT_CERTIFIED';
  return { status, certified: false, findings: report.findings.length, decided: report.findings.length - open, undecided: open };
}

// Reconciliation engine. Pure: no clock, no host timezone, no I/O, no shared state.
import { canonicalJson, compareCodeUnits, deepFreeze, sha256Hex, stableId, sumMinutes } from './canonical.js';
import { validateDataset } from './validate.js';

export const ENGINE_VERSION = 'shiftledger-engine/0.1.0';
export const REPORT_SCHEMA = 'shiftledger.report.v1';
export const DISCLAIMER = 'Synthetic illustration using explicitly fictional local rules. Not a CMS/PBJ validator, not certified compliance, not a staffing-care assessment. Unsupported means unsupported by supplied evidence, not fraud or proof of non-work.';

export const FINDING_CODES = Object.freeze([
  'DUPLICATE_REPORTED_SOURCE',
  'CONFLICTING_REPORTED_SOURCE',
  'SOURCE_SELECTION_REQUIRED',
  'CLASSIFICATION_CONFIG_REQUIRED',
  'UNSUPPORTED_MINUTES',
  'CLASSIFICATION_CONFLICT',
]);
export const CONTEXT_CODES = Object.freeze([
  'REFERENCE_NOT_FOUND', 'REFERENCE_WRONG_SOURCE', 'REFERENCE_WRONG_CONTEXT',
  'SOURCE_EXCLUDED', 'SUPPORT_SURPLUS', 'UNREFERENCED_SUPPORT', 'SCHEDULE_DIFFERENCE',
]);
export const PARTITION_KEYS = Object.freeze([
  'matched', 'classificationConflict', 'unsupported',
  'selectionRequired', 'configurationRequired', 'conflictingReferenceExcluded',
]);

const ctxKey = (facilityId, personId, date) => `${facilityId}\u0000${personId}\u0000${date}`;
const within = (date, row) => compareCodeUnits(row.effectiveFrom, date) <= 0 && compareCodeUnits(date, row.effectiveTo) <= 0;
const rulesCite = (rules) => `rules:${rules.rulesetId}`;
const selCite = (s) => `sourceSelection:${s.facilityId}/${s.personId}/${s.effectiveFrom}..${s.effectiveTo}=${s.sourceType}`;
const clsCite = (c) => `classification:${c.personId}/${c.localRole}->${c.configuredReportRole}/${c.effectiveFrom}..${c.effectiveTo}`;

/**
 * Validate and reconcile a dataset.
 * @returns {{ok:true, report:object} | {ok:false, errors:Array}}
 */
export function reconcile(input) {
  const v = validateDataset(input);
  if (!v.ok) return { ok: false, errors: v.errors };
  return { ok: true, report: buildReport(v.dataset) };
}

/** SHA-256 of the canonical normalized dataset (row order independent). */
export function datasetHash(dataset) {
  return sha256Hex(canonicalJson(dataset));
}

function buildReport(ds) {
  const { rules } = ds;
  const eligibleStatuses = new Set(rules.eligibleStatuses);
  const reportable = new Set(rules.reportableRoles);

  const selectionFor = (facilityId, personId, date) =>
    ds.sourceSelections.find((s) => s.facilityId === facilityId && s.personId === personId && within(date, s)) ?? null;
  const classificationFor = (personId, localRole, date) =>
    ds.classifications.find((c) => c.personId === personId && c.localRole === localRole && within(date, c)) ?? null;

  // Support rows: evaluate selection, status, classification and reportability.
  const support = new Map();
  const sourceStatuses = [];
  for (const [sourceType, rows] of [['PAYROLL', ds.payroll], ['AGENCY', ds.agency]]) {
    for (const r of rows) {
      const sel = selectionFor(r.facilityId, r.personId, r.date);
      const cls = classificationFor(r.personId, r.role, r.date);
      const exclusions = [];
      if (!sel) exclusions.push('SOURCE_SELECTION_MISSING');
      else if (sel.sourceType !== sourceType) exclusions.push('NOT_SELECTED_SOURCE');
      if (!eligibleStatuses.has(r.status)) exclusions.push(`STATUS_${r.status}`);
      if (!cls) exclusions.push('CLASSIFICATION_MISSING');
      else if (!reportable.has(cls.configuredReportRole)) exclusions.push('ROLE_NOT_REPORTABLE');
      const entry = {
        id: r.id, sourceType, facilityId: r.facilityId, personId: r.personId, externalId: r.externalId,
        date: r.date, localRole: r.role, mappedRole: cls ? cls.configuredReportRole : null,
        minutes: r.minutes, status: r.status, selected: !!sel && sel.sourceType === sourceType,
        eligible: exclusions.length === 0, eligibleMinutes: exclusions.length === 0 ? r.minutes : 0,
        exclusions, citations: [rulesCite(rules), ...(sel ? [selCite(sel)] : []), ...(cls ? [clsCite(cls)] : [])],
      };
      support.set(r.id, entry);
      sourceStatuses.push(entry);
    }
  }
  sourceStatuses.sort((a, b) => compareCodeUnits(a.id, b.id));

  const findings = [];
  const context = [];
  const addFinding = (code, f) => findings.push({ id: stableId('SLF', [code, ...f.rowIds]), code, unit: 'minutes', ...f });
  const addContext = (code, c) => context.push({ id: stableId('SLC', [code, ...c.rowIds]), code, unit: 'minutes', ...c });

  // Exact deterministic dedup: keep lexicographically smallest ID per canonical key.
  const groups = new Map();
  for (const r of ds.reported) {
    const key = [r.facilityId, r.personId, r.date, r.role, String(r.minutes), r.sourceReference].join('\u0000');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const reps = [];
  const lines = [];
  for (const members of groups.values()) {
    members.sort((a, b) => compareCodeUnits(a.id, b.id));
    const [keep, ...dups] = members;
    reps.push(keep);
    for (const d of dups) {
      addFinding('DUPLICATE_REPORTED_SOURCE', {
        facilityId: d.facilityId, personId: d.personId, date: d.date, role: d.role, minutes: d.minutes,
        rowIds: [d.id], relatedRowIds: [keep.id], sourceReference: d.sourceReference,
        message: `Reported row ${d.id} duplicates ${keep.id} (same facility, person, date, role, minutes and source reference); excluded from deduplicated totals.`,
        citations: [rulesCite(rules)],
      });
      lines.push(line(d, { duplicateOf: keep.id }));
    }
  }
  reps.sort((a, b) => compareCodeUnits(a.id, b.id));

  // Conflicting duplicates: one sourceReference used by distinct canonical rows.
  const byRef = new Map();
  for (const r of reps) {
    if (!byRef.has(r.sourceReference)) byRef.set(r.sourceReference, []);
    byRef.get(r.sourceReference).push(r);
  }
  const conflicted = new Set();
  for (const [ref, rows] of byRef) {
    if (rows.length < 2) continue;
    const ids = rows.map((r) => r.id);
    ids.forEach((id) => conflicted.add(id));
    const s = sumMinutes(rows.map((r) => r.minutes));
    addFinding('CONFLICTING_REPORTED_SOURCE', {
      facilityId: rows[0].facilityId, personId: rows[0].personId, date: rows[0].date, role: null, minutes: s.value,
      rowIds: ids, relatedRowIds: [ref], sourceReference: ref,
      message: `Source reference ${ref} is claimed by differing reported rows ${ids.join(', ')}; the whole reference group is excluded pending review. One support row is never allocated twice.`,
      citations: [rulesCite(rules)],
    });
  }

  const usedSupport = new Set();
  for (const r of reps) {
    const base = { facilityId: r.facilityId, personId: r.personId, date: r.date, role: r.role, rowIds: [r.id], sourceReference: r.sourceReference };
    if (conflicted.has(r.id)) { lines.push(line(r, { conflictingReferenceExcluded: r.minutes })); continue; }
    const sel = selectionFor(r.facilityId, r.personId, r.date);
    if (!sel) {
      addFinding('SOURCE_SELECTION_REQUIRED', {
        ...base, minutes: r.minutes, relatedRowIds: [],
        message: `No effective sourceSelection for ${r.facilityId}/${r.personId} on ${r.date}; payroll and agency are never added together, so no match is certified.`,
        citations: [rulesCite(rules)],
      });
      lines.push(line(r, { selectionRequired: r.minutes }));
      continue;
    }
    const s = support.get(r.sourceReference);
    let refProblem = null;
    if (!s) refProblem = ['REFERENCE_NOT_FOUND', `Source reference ${r.sourceReference} matches no supplied payroll or agency row.`];
    else if (s.sourceType !== sel.sourceType) refProblem = ['REFERENCE_WRONG_SOURCE', `Source reference ${r.sourceReference} is a ${s.sourceType} row but the selected source is ${sel.sourceType}.`];
    else if (s.facilityId !== r.facilityId || s.personId !== r.personId || s.date !== r.date) refProblem = ['REFERENCE_WRONG_CONTEXT', `Source reference ${r.sourceReference} belongs to ${s.facilityId}/${s.personId}/${s.date}, not ${r.facilityId}/${r.personId}/${r.date}.`];
    if (refProblem) {
      addContext(refProblem[0], { ...base, minutes: r.minutes, relatedRowIds: s ? [s.id] : [], message: refProblem[1] });
      addFinding('UNSUPPORTED_MINUTES', {
        ...base, minutes: r.minutes, relatedRowIds: s ? [s.id] : [], reason: refProblem[0],
        message: `${r.minutes} reported minutes are unsupported by supplied evidence (${refProblem[0]}). This is not a finding of fraud or proof of non-work.`,
        citations: [rulesCite(rules), selCite(sel)],
      });
      lines.push(line(r, { unsupported: r.minutes, supportRowId: s ? s.id : null }));
      continue;
    }
    usedSupport.add(s.id);
    if (s.mappedRole === null) {
      addFinding('CLASSIFICATION_CONFIG_REQUIRED', {
        ...base, minutes: r.minutes, relatedRowIds: [s.id],
        message: `No classification configured for ${s.personId} local role ${s.localRole} on ${s.date}; configuration needed (no CMS mapping is inferred).`,
        citations: s.citations,
      });
      lines.push(line(r, { configurationRequired: r.minutes, supportRowId: s.id }));
      continue;
    }
    if (!s.eligible) {
      addContext('SOURCE_EXCLUDED', { ...base, minutes: s.minutes, relatedRowIds: [s.id], exclusions: s.exclusions, message: `Support row ${s.id} excluded from eligible support: ${s.exclusions.join(', ')}.` });
    }
    const eligible = s.eligibleMinutes;
    const covered = Math.min(r.minutes, eligible);
    const excess = r.minutes - covered;
    const roleDiffers = s.mappedRole !== r.role;
    const part = { supportRowId: s.id, unsupported: excess, matched: roleDiffers ? 0 : covered, classificationConflict: roleDiffers ? covered : 0 };
    if (part.classificationConflict > 0) {
      addFinding('CLASSIFICATION_CONFLICT', {
        ...base, minutes: covered, relatedRowIds: [s.id], evidenceRole: s.mappedRole,
        message: `${covered} minutes reported as ${r.role} are supported as ${s.mappedRole} by ${s.id}. Role allocation is unresolved; these minutes are not additional unworked time.`,
        citations: s.citations,
      });
    }
    if (excess > 0) {
      addFinding('UNSUPPORTED_MINUTES', {
        ...base, minutes: excess, relatedRowIds: [s.id], reason: s.eligible ? 'EXCESS_OVER_SUPPORT' : 'SUPPORT_EXCLUDED',
        message: `${excess} of ${r.minutes} reported minutes exceed eligible support ${eligible} from ${s.id}; unsupported by supplied evidence, not proof of non-work.`,
        citations: s.citations,
      });
    }
    if (eligible > covered) {
      addContext('SUPPORT_SURPLUS', { ...base, minutes: eligible - covered, relatedRowIds: [s.id], message: `${s.id} carries ${eligible - covered} eligible minutes beyond the reported row; unreported-support context, not negative unsupported time.` });
    }
    lines.push(line(r, part));
  }

  for (const s of sourceStatuses) {
    if (s.eligible && !usedSupport.has(s.id)) {
      addContext('UNREFERENCED_SUPPORT', { facilityId: s.facilityId, personId: s.personId, date: s.date, role: s.mappedRole, minutes: s.eligibleMinutes, rowIds: [s.id], relatedRowIds: [], message: `Eligible ${s.sourceType} row ${s.id} is not referenced by any accepted reported row.` });
    }
  }

  // Schedule corroborates only: compared to eligible support per context, never added.
  const ctx = new Map();
  const bump = (r, field, m) => {
    const k = ctxKey(r.facilityId, r.personId, r.date);
    if (!ctx.has(k)) ctx.set(k, { facilityId: r.facilityId, personId: r.personId, date: r.date, schedule: 0, support: 0, scheduleRowIds: [] });
    ctx.get(k)[field] += m;
    if (field === 'schedule') ctx.get(k).scheduleRowIds.push(r.id);
  };
  ds.schedule.forEach((r) => bump(r, 'schedule', r.minutes));
  sourceStatuses.forEach((s) => bump(s, 'support', s.eligibleMinutes));
  for (const c of ctx.values()) {
    if (c.scheduleRowIds.length && c.schedule !== c.support) {
      addContext('SCHEDULE_DIFFERENCE', { facilityId: c.facilityId, personId: c.personId, date: c.date, role: null, minutes: c.schedule - c.support, rowIds: c.scheduleRowIds, relatedRowIds: [], message: `Schedule ${c.schedule} vs eligible support ${c.support} minutes. Corroborating context only; not evidence that extra minutes were worked.` });
    }
  }

  lines.sort((a, b) => compareCodeUnits(a.reportedRowId, b.reportedRowId));
  findings.sort((a, b) => compareCodeUnits(a.code, b.code) || compareCodeUnits(a.id, b.id));
  context.sort((a, b) => compareCodeUnits(a.code, b.code) || compareCodeUnits(a.id, b.id));

  const bounds = [];
  const total = (name, values) => { const s = sumMinutes(values); if (s.overflow) bounds.push(name); return s.value; };
  const accepted = lines.filter((l) => l.duplicateOf === null);
  const totals = {
    unit: 'minutes',
    rawReported: total('rawReported', ds.reported.map((r) => r.minutes)),
    dedupReported: total('dedupReported', accepted.map((l) => l.minutes)),
    eligibleSupport: total('eligibleSupport', sourceStatuses.map((s) => s.eligibleMinutes)),
    payrollEligible: total('payrollEligible', sourceStatuses.filter((s) => s.sourceType === 'PAYROLL').map((s) => s.eligibleMinutes)),
    agencyEligible: total('agencyEligible', sourceStatuses.filter((s) => s.sourceType === 'AGENCY').map((s) => s.eligibleMinutes)),
    schedule: total('schedule', ds.schedule.map((r) => r.minutes)),
  };
  const diff = (a, b) => (a === null || b === null ? null : a - b);
  totals.dedupMinusSupport = diff(totals.dedupReported, totals.eligibleSupport);
  totals.scheduleMinusSupport = diff(totals.schedule, totals.eligibleSupport);
  totals.scheduleMinusDedupReported = diff(totals.schedule, totals.dedupReported);
  const partition = { unit: 'minutes' };
  for (const k of PARTITION_KEYS) partition[k] = total(`partition.${k}`, accepted.map((l) => l[k]));
  const partSum = sumMinutes(PARTITION_KEYS.map((k) => partition[k] ?? NaN));
  partition.sum = partSum.value;
  partition.balanced = !partSum.overflow && partSum.value === totals.dedupReported;

  const body = {
    reportSchema: REPORT_SCHEMA,
    engineVersion: ENGINE_VERSION,
    disclaimer: DISCLAIMER,
    certified: false,
    provenance: {
      datasetId: ds.datasetId,
      datasetHash: datasetHash(ds),
      schemaVersion: ds.schemaVersion,
      rules: ds.rules,
      inputCounts: Object.fromEntries(['facilities', 'persons', 'identityAliases', 'classifications', 'sourceSelections', 'schedule', 'payroll', 'agency', 'reported'].map((t) => [t, ds[t].length])),
    },
    totals,
    boundsExceeded: bounds,
    partition,
    findings,
    context,
    lines,
    sourceStatuses,
  };
  const reportId = `SLR-${sha256Hex(canonicalJson(body))}`;
  return deepFreeze({ reportId, ...body });
}

function line(r, part) {
  return {
    reportedRowId: r.id, facilityId: r.facilityId, personId: r.personId, externalId: r.externalId,
    date: r.date, role: r.role, minutes: r.minutes, sourceReference: r.sourceReference,
    duplicateOf: part.duplicateOf ?? null, supportRowId: part.supportRowId ?? null,
    matched: part.matched ?? 0, classificationConflict: part.classificationConflict ?? 0, unsupported: part.unsupported ?? 0,
    selectionRequired: part.selectionRequired ?? 0, configurationRequired: part.configurationRequired ?? 0,
    conflictingReferenceExcluded: part.conflictingReferenceExcluded ?? 0,
  };
}

/** Recompute the report hash; true when the report body is untampered. */
export function verifyReportId(report) {
  const { reportId, ...body } = report;
  return reportId === `SLR-${sha256Hex(canonicalJson(body))}`;
}

/** Filter principal findings by any of code, personId, date, role, facilityId. */
export function filterFindings(report, criteria = {}) {
  const keys = ['code', 'personId', 'date', 'role', 'facilityId'];
  return report.findings.filter((f) => keys.every((k) => criteria[k] === undefined || f[k] === criteria[k]));
}

/** Return the support/status records and reported lines a finding cites. */
export function supportingRows(report, findingId) {
  const f = report.findings.find((x) => x.id === findingId);
  if (!f) return null;
  const ids = new Set([...f.rowIds, ...f.relatedRowIds]);
  return {
    finding: f,
    lines: report.lines.filter((l) => ids.has(l.reportedRowId)),
    sourceStatuses: report.sourceStatuses.filter((s) => ids.has(s.id)),
  };
}

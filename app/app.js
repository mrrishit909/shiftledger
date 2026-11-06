// ShiftLedger review workspace. Browser-only: files are read with File.text() in this tab and
// the page CSP blocks network connections; exports are local downloads.
// Every engine or file string is written with textContent; no HTML interpolation anywhere.
// Run origin comes from the control used (bundled-fixture buttons vs file import), never from
// file names or dataset content; it cannot detect or prevent real or sensitive data.
import {
  reconcile, filterFindings, supportingRows, createDecision, appendDecision, readiness,
  importDatasetJson, exportReportJson, exportReportCsv, loadBundledFixture, userSuppliedOrigin, originFor,
  LIMITS, DECISION_TYPES, DISCLAIMER, ORIGIN_KINDS,
} from '../src/index.js';

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') node.textContent = String(v);
    else if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

const CODE_LABELS = {
  DUPLICATE_REPORTED_SOURCE: 'Duplicate reported row',
  CONFLICTING_REPORTED_SOURCE: 'Conflicting source reference',
  SOURCE_SELECTION_REQUIRED: 'Source selection required',
  CLASSIFICATION_CONFIG_REQUIRED: 'Classification setup required',
  UNSUPPORTED_MINUTES: 'Unsupported minutes',
  CLASSIFICATION_CONFLICT: 'Classification conflict',
};
const TOTALS = [
  ['rawReported', 'Raw reported', 'Every reported row, duplicates included'],
  ['dedupReported', 'Deduplicated reported', 'Exact duplicate rows removed'],
  ['eligibleSupport', 'Eligible support', 'Approved payroll and agency minutes'],
  ['dedupMinusSupport', 'Deduplicated minus support', 'Positive: reported exceeds supplied support'],
  ['schedule', 'Scheduled', 'Context only, never proof of work'],
];
const FILTERS = [['f-person', 'personId'], ['f-date', 'date'], ['f-role', 'role'], ['f-code', 'code']];

const state = {
  history: [], // { seq, label, report, origin, log }: report is the engine-minted object, never cloned
  view: -1,
  pending: null, // { label, dataset, origin } staged for the next run
  selected: null,
  busy: false,
};

const current = () => state.history[state.view] ?? null;
const minutes = (v) => (v === null ? 'exceeds bounds' : `${v.toLocaleString('en-US')} min`);
const hours = (v) => (v === null ? '' : `${(v / 60).toFixed(2)} h`);
const utcNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function announce(text) { $('status').textContent = text; }

function showErrors(headline, errors = []) {
  const box = $('errors');
  box.replaceChildren(el('p', { class: 'err-head', text: headline }));
  if (errors.length) {
    const list = el('ul');
    for (const e of errors.slice(0, 20)) list.append(el('li', {}, el('code', { text: e.code }), ` at ${e.path}: ${e.message}`));
    if (errors.length > 20) list.append(el('li', { text: `+${errors.length - 20} more` }));
    box.append(list);
  }
  box.hidden = false;
  announce(headline);
}
function clearErrors() { $('errors').hidden = true; $('errors').replaceChildren(); }

const isBundled = (origin) => origin.kind === ORIGIN_KINDS.BUNDLED;
const originTag = (origin) => (isBundled(origin) ? 'Synthetic demo' : 'Unverified user-supplied data');

function stage(label, dataset, origin) {
  state.pending = { label, dataset, origin };
  $('pending-label').textContent = `${label} (${originTag(origin)})`;
  $('run').disabled = false;
  clearErrors();
  announce(`${label} staged. Press Reconcile to run it.`);
}

function run() {
  if (!state.pending || state.busy) return;
  const { label, dataset, origin: stagedOrigin } = state.pending;
  state.busy = true;
  $('run').disabled = true;
  $('workspace').setAttribute('aria-busy', 'true');
  announce(`Reconciling ${label}…`);
  setTimeout(() => {
    let res;
    try { res = reconcile(dataset); } catch (e) { res = { ok: false, errors: [{ code: 'ENGINE_ERROR', path: '$', message: String(e?.message ?? e) }] }; }
    state.busy = false;
    $('workspace').removeAttribute('aria-busy');
    $('run').disabled = false;
    if (!res.ok) {
      showErrors(`Reconciliation rejected “${label}”. The last report is unchanged.`, res.errors);
      return;
    }
    clearErrors();
    // Origin is fixed per run; originFor downgrades to unverified unless it matches this report.
    state.history.push({ seq: state.history.length + 1, label, report: res.report, origin: originFor(res.report, stagedOrigin), log: Object.freeze([]) });
    state.view = state.history.length - 1;
    state.selected = null;
    render();
    announce(`Run ${state.view + 1} complete: ${res.report.findings.length} finding(s).`);
    $('report-heading').focus();
  }, 40);
}

async function onFile(ev) {
  const input = ev.target;
  const file = input.files?.[0];
  if (!file) return;
  input.value = '';
  if (file.size > LIMITS.maxBytes) {
    showErrors(`“${file.name}” is ${file.size.toLocaleString('en-US')} bytes; the limit is ${LIMITS.maxBytes.toLocaleString('en-US')} bytes (1 MiB). The last report is unchanged.`);
    return;
  }
  announce(`Reading ${file.name}…`);
  let text;
  try { text = await file.text(); } catch { showErrors(`“${file.name}” could not be read. The last report is unchanged.`); return; }
  const res = importDatasetJson(text);
  if (!res.ok) { showErrors(`“${file.name}” was rejected. The last report is unchanged.`, res.errors); return; }
  // A file is unverified whatever its name or content says; it is never treated as a bundled fixture.
  stage(`Imported file: ${file.name}`, res.dataset, userSuppliedOrigin());
}

function download(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  announce(`Downloaded ${name}.`);
}

function render() {
  renderHistory();
  const entry = current();
  $('empty').hidden = Boolean(entry);
  $('report').hidden = !entry;
  if (!entry) return;
  const { report, log } = entry;
  const latest = state.view === state.history.length - 1;
  $('run-label').textContent = `Run ${entry.seq} · ${entry.label}${latest ? '' : ' (earlier run, read-only history)'}`;
  const origin = $('origin');
  origin.className = isBundled(entry.origin) ? 'origin is-demo' : 'origin is-unverified';
  origin.replaceChildren(el('strong', { text: `Data origin: ${originTag(entry.origin)}. ` }), entry.origin.statement, el('br'), entry.origin.warning);
  $('report-id').textContent = report.reportId;
  $('dataset-id').textContent = `${report.provenance.datasetId} · dataset hash ${report.provenance.datasetHash.slice(0, 16)}…`;
  const ready = readiness(report, log);
  $('readiness').textContent = `${ready.decided} of ${ready.findings} findings annotated · status ${ready.status} · certified: no`;
  renderTotals(report);
  renderFilters(report);
  renderFindings();
  renderEvidence();
}

function renderTotals(report) {
  const grid = $('totals');
  grid.replaceChildren();
  for (const [key, label, hint] of TOTALS) {
    const v = report.totals[key];
    const tone = key === 'dedupMinusSupport' && v !== null && v > 0 ? 'total is-gap' : 'total';
    grid.append(el('div', { class: tone },
      el('dt', { text: label }),
      el('dd', {}, el('span', { class: 'num', text: minutes(v) }), el('span', { class: 'hrs', text: hours(v) }), el('span', { class: 'hint', text: hint }))));
  }
  const over = report.boundsExceeded ?? [];
  $('bounds').hidden = over.length === 0;
  $('bounds').textContent = over.length ? `Totals exceeding safe integer bounds: ${over.join(', ')}` : '';
}

function renderFilters(report) {
  const fields = { personId: new Set(), date: new Set(), role: new Set(), code: new Set() };
  for (const f of report.findings) for (const k of Object.keys(fields)) if (typeof f[k] === 'string') fields[k].add(f[k]);
  for (const [id, key] of FILTERS) {
    const sel = $(id);
    const keep = sel.value;
    const values = [...fields[key]].sort();
    sel.replaceChildren(el('option', { value: '', text: 'All' }), ...values.map((v) => el('option', { value: v, text: key === 'code' ? CODE_LABELS[v] ?? v : v })));
    sel.value = values.includes(keep) ? keep : '';
    sel.disabled = values.length === 0;
  }
}

function decisionsFor(entry, findingId) { return entry.log.filter((d) => d.findingId === findingId); }

function renderFindings() {
  const entry = current();
  const criteria = {};
  for (const [id, key] of FILTERS) criteria[key] = $(id).value || undefined;
  const rows = filterFindings(entry.report, criteria);
  const body = $('findings-body');
  body.replaceChildren();
  const total = entry.report.findings.length;
  $('findings-count').textContent = total === 0 ? 'No findings' : `Showing ${rows.length} of ${total}`;
  $('no-findings').hidden = total !== 0;
  $('no-matches').hidden = !(total > 0 && rows.length === 0);
  $('findings-wrap').hidden = rows.length === 0;
  for (const f of rows) {
    const notes = decisionsFor(entry, f.id);
    const on = state.selected === f.id;
    body.append(el('tr', { class: on ? 'is-selected' : '' },
      el('td', {}, el('span', { class: 'code-tag', text: CODE_LABELS[f.code] ?? f.code }), el('span', { class: 'code-raw', text: f.code })),
      el('td', { text: f.personId ?? '—' }),
      el('td', { class: 'nowrap', text: f.date ?? '—' }),
      el('td', { text: f.role ?? '—' }),
      el('td', { class: 'num', text: minutes(f.minutes) }),
      el('td', { class: 'hrs', text: hours(f.minutes) }),
      el('td', { class: notes.length ? 'annotated' : 'open', text: notes.length ? `${notes.at(-1).decision} (${notes.length})` : 'Open' }),
      el('td', {}, el('button', {
        type: 'button', class: 'btn-quiet', 'aria-pressed': on ? 'true' : 'false',
        'aria-label': `Show evidence for ${f.code} ${f.personId ?? ''} ${f.date ?? ''}`.trim(),
        text: 'Evidence', onclick: () => { state.selected = f.id; renderFindings(); renderEvidence(); $('evidence-heading').focus(); },
      }))));
  }
}

function table(caption, head, rows) {
  const t = el('table', {}, el('caption', { text: caption }), el('thead', {}, el('tr', {}, ...head.map((h) => el('th', { scope: 'col', text: h })))));
  const b = el('tbody');
  for (const r of rows) b.append(el('tr', {}, ...r.map((c, i) => el('td', { class: typeof c === 'number' ? 'num' : i === 0 ? 'mono' : '', text: c === null || c === undefined || c === '' ? '—' : typeof c === 'number' ? minutes(c) : c }))));
  t.append(b);
  return el('div', { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': caption }, t);
}

function renderEvidence() {
  const entry = current();
  const panel = $('evidence-body');
  panel.replaceChildren();
  const sup = state.selected ? supportingRows(entry.report, state.selected) : null;
  if (!sup) {
    panel.append(el('p', { class: 'empty-note', text: entry.report.findings.length ? 'Choose “Evidence” on a finding to see the rows it cites.' : 'No findings in this run, so there is no evidence to review.' }));
    return;
  }
  const f = sup.finding;
  panel.append(
    el('p', { class: 'ev-code' }, el('span', { class: 'code-tag', text: CODE_LABELS[f.code] ?? f.code }), ` ${f.personId ?? ''} · ${f.date ?? ''} · ${f.role ?? ''} · `, el('span', { class: 'num', text: minutes(f.minutes) }), ` (${hours(f.minutes)})`),
    el('p', { class: 'ev-msg', text: f.message ?? '' }),
    table('Reported lines cited', ['Row', 'Employee', 'Date', 'Role', 'Minutes', 'Source ref', 'Duplicate of'],
      sup.lines.map((l) => [l.reportedRowId, l.personId, l.date, l.role, l.minutes, l.sourceReference, l.duplicateOf])),
    table('Support and status rows cited', ['Row', 'Type', 'Status', 'Role', 'Minutes', 'Eligible', 'Exclusions'],
      sup.sourceStatuses.map((s) => [s.id, s.sourceType, s.status, s.mappedRole ?? s.localRole, s.minutes, s.eligibleMinutes, s.exclusions.join(', ')])),
  );
  panel.append(decisionForm(entry, f));
}

function decisionForm(entry, f) {
  const err = el('div', { class: 'form-err', role: 'alert', hidden: true });
  const type = el('select', { id: 'd-type', name: 'decision' }, ...DECISION_TYPES.map((t) => el('option', { value: t, text: t.replace('_', ' ').toLowerCase() })));
  const who = el('input', { id: 'd-who', name: 'reviewerId', value: 'reviewer.demo', autocomplete: 'off', spellcheck: 'false', required: true, maxlength: '64' });
  const note = el('input', { id: 'd-note', name: 'note', autocomplete: 'off', maxlength: String(LIMITS.maxNoteLength ?? 500) });
  const form = el('form', { class: 'decision', novalidate: true },
    el('h4', { text: 'Reviewer note (annotation only)' }),
    el('p', { class: 'fine', text: 'Decisions never change totals or findings. They are bound to this run and kept in memory only.' }),
    el('div', { class: 'field-row' },
      el('label', { for: 'd-type' }, 'Decision', type),
      el('label', { for: 'd-who' }, 'Reviewer ID', who)),
    el('label', { for: 'd-note' }, 'Note (single line, optional)', note),
    err,
    el('button', { type: 'submit', class: 'btn', text: 'Record decision' }));
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const made = createDecision(entry.report, { findingId: f.id, decision: type.value, reviewerId: who.value.trim(), note: note.value, decidedAt: utcNow() });
    const res = made.ok ? appendDecision(entry.log, entry.report, made.decision) : made;
    if (!res.ok) {
      err.replaceChildren(...res.errors.map((e) => el('p', {}, el('code', { text: e.code }), ` ${e.message}`)));
      err.hidden = false;
      return;
    }
    entry.log = res.log;
    render();
    announce(`Recorded ${made.decision.decision} for ${f.code}. Totals unchanged.`);
    $('evidence-heading').focus();
  });
  const past = decisionsFor(entry, f.id);
  const list = el('ol', { class: 'decision-log', 'aria-label': 'Decisions for this finding' });
  for (const d of past) list.append(el('li', {}, el('strong', { text: d.decision }), ` · ${d.reviewerId} · ${d.decidedAt}`, d.note ? el('span', { class: 'note', text: ` “${d.note}”` }) : null));
  return el('div', {}, past.length ? list : el('p', { class: 'fine', text: 'No decisions recorded for this finding yet.' }), form);
}

function renderHistory() {
  const list = $('history');
  list.replaceChildren();
  $('history-empty').hidden = state.history.length > 0;
  state.history.forEach((h, i) => {
    const on = i === state.view;
    list.append(el('li', {}, el('button', {
      type: 'button', class: on ? 'hist is-current' : 'hist', 'aria-current': on ? 'true' : null,
      onclick: () => { state.view = i; state.selected = null; clearErrors(); render(); announce(`Viewing run ${h.seq}.`); },
    }, el('span', { class: 'hist-n', text: `Run ${h.seq}` }), el('span', { class: 'hist-l', text: h.label }),
    el('span', { class: isBundled(h.origin) ? 'hist-o' : 'hist-o is-unverified', text: originTag(h.origin) }),
    el('span', { class: 'hist-m', text: `${h.report.findings.length} finding(s) · ${h.report.reportId.slice(0, 12)}…` }))));
  });
}

function init() {
  $('disclaimer').textContent = DISCLAIMER;
  $('limit').textContent = `${LIMITS.maxBytes.toLocaleString('en-US')} bytes`;
  // Only these built-in controls stage bundled fixtures; loadBundledFixture generates the data itself.
  const bundled = (label, name) => { const { dataset, origin } = loadBundledFixture(name); stage(label, dataset, origin); };
  $('load-sample').addEventListener('click', () => bundled('Synthetic sample (golden)', 'golden'));
  $('load-corrected').addEventListener('click', () => bundled('Corrected source', 'corrected'));
  $('rerun-corrected').addEventListener('click', () => { bundled('Corrected source (rerun)', 'corrected'); run(); });
  $('file').addEventListener('change', onFile);
  $('run').addEventListener('click', run);
  for (const [id] of FILTERS) $(id).addEventListener('change', () => { if (current()) { renderFindings(); } });
  $('clear-filters').addEventListener('click', () => { for (const [id] of FILTERS) $(id).value = ''; if (current()) renderFindings(); });
  $('dl-json').addEventListener('click', () => { const e = current(); if (e) download(`${e.report.reportId}.json`, 'application/json', exportReportJson(e.report, e.log, e.origin)); });
  $('dl-csv').addEventListener('click', () => { const e = current(); if (e) download(`${e.report.reportId}.csv`, 'text/csv', exportReportCsv(e.report, e.log, e.origin)); });
  $('boot').hidden = true;
  render();
  announce('Ready. Load the synthetic sample to begin.');
}

init();

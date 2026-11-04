# ShiftLedger engine (synthetic vertical slice v1)

ShiftLedger is a dependency-free ESM engine for Node 24+. It reconciles PBJ-*style* reported staffing minutes against fictional payroll, agency and schedule evidence. It implements `../atlas/docs/specs/SHIFTLEDGER-VERTICAL-SLICE.md` (rev 1.1), which is the authoritative spec.

> **Not a CMS/PBJ validator.** All rules, roles, people and facilities are explicitly fictional (`rules.fictional: true`, `approvalStatus: "ILLUSTRATIVE_UNAPPROVED"`). Reports are always `certified: false`. "Unsupported" means *unsupported by supplied evidence*. It is never a finding of fraud or proof of non-work. This version has no CMS allocation rules, reportable-category policy, iQIES submission, payroll connectors, website or network access.

```sh
npm test          # same as: node --test   (no dependencies, no install step)
```

## Layout

| File | Responsibility |
| --- | --- |
| `src/index.js` | Public API. Everything below is re-exported here. |
| `src/validate.js` | Strict, atomic schema validation and normalization (`validateDataset`). |
| `src/engine.js` | Pure reconciliation (`reconcile`), the private registry of minted reports (`isEngineReport`), finding filters, report hash check. |
| `src/io.js` | Strict JSON/CSV import, dataset export, and report JSON/CSV export. |
| `src/csv.js` | RFC 4180-style CSV parser and formula-safe writer. |
| `src/decisions.js` | Inert reviewer decisions and readiness. |
| `src/canonical.js` | Code-unit ordering, canonical JSON, SHA-256, overflow-flagging sums. |
| `src/fixtures.js` | Literal fixtures: golden `SL-SYN-001`, corrected, split, and overnight. |

The engine never reads the clock, the host timezone, the file system or the network. The same input always yields the same `reportId`. Tests check this across row permutations and across `TZ=UTC`, `Pacific/Kiritimati`, `America/St_Johns` and `Asia/Kathmandu`.

## Dataset schema (`shiftledger.dataset.v1`)

A dataset is one JSON object. Exactly these top-level keys are allowed: `schemaVersion`, `datasetId`, `rules`, and the nine tables below. Every table must be present; use `[]` when a table is empty. Unknown fields are rejected everywhere.

| Table | Fields |
| --- | --- |
| `facilities` | `id`, `timezone` (an IANA name; metadata only, never used for arithmetic) |
| `persons` | `id` |
| `identityAliases` | `source` (`SCHEDULE`, `PAYROLL`, `AGENCY` or `REPORTED`), `externalId`, `personId` |
| `classifications` | `personId`, `localRole`, `configuredReportRole`, `effectiveFrom`, `effectiveTo` |
| `sourceSelections` | `facilityId`, `personId`, `effectiveFrom`, `effectiveTo`, `sourceType` (`PAYROLL` or `AGENCY`) |
| `schedule` | `id`, `facilityId`, *person ref*, `date`, `role`, `minutes` |
| `payroll` / `agency` | `id`, `facilityId`, *person ref*, `date`, `role`, `minutes`, `status` (`APPROVED`, `UNAPPROVED` or `VOID`) |
| `reported` | `id`, `facilityId`, *person ref*, `date`, `role`, `minutes`, `sourceReference` (the exact `id` of a payroll or agency row) |

`rules`, all fields required:

```json
{ "rulesetId": "SL-FICTIONAL-RULES-1", "fictional": true, "approvalStatus": "ILLUSTRATIVE_UNAPPROVED",
  "reportableRoles": ["CNA", "RN"], "eligibleStatuses": ["APPROVED"], "toleranceMinutes": 0 }
```

### Person references and the normalized form

An evidence row (schedule, payroll, agency or reported) names its person in one of two ways:
- with `personId`, or
- with a non-null `externalId`, which is resolved through `identityAliases` for that row's own source. For example, a payroll row only uses `PAYROLL` aliases.

If both are present, the alias must resolve to that same `personId`; otherwise the row is rejected with `ALIAS_PERSON_MISMATCH`. `externalId: null` counts as absent.

After validation, every evidence row carries both `personId` and `externalId`, with `externalId` set to `null` when no alias was used. This normalized dataset is a fixed point: `validateDataset(validateDataset(x).dataset)` returns an identical dataset with the same `datasetHash`. JSON and CSV dataset exports also re-import to the same hash and the same `reportId`. Tests cover all fixtures plus an alias variant that mixes both reference styles.

Aliases are never fuzzy-merged:
- One `(source, externalId)` mapped to two people rejects with `AMBIGUOUS_ALIAS`.
- A repeated identical alias rejects with `DUPLICATE_ALIAS`.
- Several aliases may map to one person, and the result is deterministic.
- Alias namespaces are separate per source.

### Validation (atomic)

`validateDataset`, `importDatasetJson`, `importDatasetCsv` and `reconcile` either return the whole result or return `{ ok: false, errors: [{ code, path, message }] }`, with errors sorted and no partial dataset or report.

The validator rejects:
- **Fields:** unknown or forbidden keys (`__proto__`, `constructor`, `prototype`), including symbol and non-enumerable keys (checked with `Reflect.ownKeys`). It also rejects non-plain-object rows (a hole in a table array is an `INVALID_ROW`, not a skipped row) and missing tables. Top-level fields, tables, rules fields and row fields are read from **own** properties only, so inherited values and a polluted `Object.prototype` never fill a gap.
- **IDs:** invalid IDs. An ID must match `[A-Za-z0-9][A-Za-z0-9._:-]*` and be at most 64 characters, so an ID can never start with a formula character.
- **Duplicates:** duplicate row IDs. IDs are unique across schedule, payroll, agency and reported together, so a repeated payroll ID is rejected rather than added twice.
- **References:** unknown facilities, persons or aliases.
- **Dates:** invalid calendar dates (`YYYY-MM-DD`, proleptic Gregorian, checked arithmetically without `Date`), and `effectiveFrom > effectiveTo`.
- **Intervals:** overlapping `sourceSelections` for the same facility and person, and overlapping `classifications` for the same person and local role. Intervals are inclusive.
- **Minutes:** values that are not integers in `0..1440`, including `NaN`, `Infinity`, negatives, `"480"` and `480.5`.
- **Rules:** rules that are not marked fictional, or with a tolerance other than 0. Also rejected: a missing own rules field, more than 64 `reportableRoles`, and more than 3 `eligibleStatuses`. List lengths are checked before any per-element work.
- **Timestamps:** raw timestamps, meaning a `T` or `hh:mm` in a date, or fields such as `start`, `end` or `clockIn` (`RAW_TIMESTAMP_UNSUPPORTED`). V1 accepts only day-split rows with an explicit local work date. DST cannot be inferred from a naked local timestamp.

## Limits

| Limit | Value |
| --- | --- |
| JSON text (whole document, metadata included), or a CSV bundle: all table texts **plus** `JSON.stringify({ schemaVersion, datasetId, rules })` | 1 MiB (1,048,576 **UTF-8 bytes**) |
| Rows across all tables | 5000 (5000 accepted, 5001 rejected) |
| `rules.reportableRoles` / `rules.eligibleStatuses` | 1..64 unique role codes (`LIMITS.maxReportableRoles`) / 1..3 unique statuses |
| IDs, role codes, timezone | 64 / 32 / 64 characters |
| `minutes` per row | integer 0..1440 |
| Evidence minutes per person per day | Schedule, payroll and agency, each summed across facilities: at most 1440. This is a representational bound, not a CMS rule. Reported rows are bounded per row only, because duplicates are findings rather than rejections. |
| Reviewer note | 500 characters. Control and bidi-override characters are rejected. |
| `decidedAt` | `YYYY-MM-DDTHH:MM:SSZ` only: a real calendar date, hours 00–23, minutes and seconds 00–59. Leap second `:60`, fractions, offsets and lowercase `z` are rejected (`isUtcTimestamp`). |

Aggregates are summed with `sumMinutes`. A sum outside the safe-integer range returns `{ value: null, overflow: true }` and is listed in `report.boundsExceeded`; it is never clamped or truncated. Under the limits above the largest reachable sum is 7,200,000, so overflow is only exercised in unit tests of `sumMinutes`.

## Algorithm

1. **Exact dedup.** Reported rows are grouped by `facility, person, date, role, minutes, sourceReference`. The code-unit-smallest ID is kept, so `R10` beats `R9`. Every other member gives `DUPLICATE_REPORTED_SOURCE`.
2. **Conflicting references.** If two or more deduplicated rows cite the same `sourceReference` with differing role, minutes or context, the result is `CONFLICTING_REPORTED_SOURCE`. The entire group is excluded pending review, so one support row is never allocated twice.
3. **Source selection.** The effective `sourceSelection` for `facility, person, date` picks PAYROLL *or* AGENCY. They are never added together. Schedule only corroborates. If no selection applies, the result is `SOURCE_SELECTION_REQUIRED` and no match is made.
4. **Reference check.** If `sourceReference` matches no row, the result is `REFERENCE_NOT_FOUND`; a schedule ID counts as no row. A row of the non-selected source is `REFERENCE_WRONG_SOURCE`. A row from another facility, person or date is `REFERENCE_WRONG_CONTEXT`. In each case **all** reported minutes are `UNSUPPORTED_MINUTES`, and no role conflict is raised.
5. **Support eligibility.** A support row is eligible only if:
   - it belongs to the selected source,
   - its status is in `rules.eligibleStatuses`,
   - a classification maps its local role on that date,
   - and the mapped role is in `rules.reportableRoles`.

   Exclusions are listed per row. VOID and UNAPPROVED rows give `STATUS_*` exclusions and a `SOURCE_EXCLUDED` context. A missing classification gives `CLASSIFICATION_CONFIG_REQUIRED`; no mapping is invented.
6. **Partition.** For each valid link, `covered = min(reported, eligible)` and `unsupported = reported − covered`. If the roles differ, `covered` minutes are `CLASSIFICATION_CONFLICT`; otherwise they are matched. Surplus support is `SUPPORT_SURPLUS` context, never negative unsupported time.

Every accepted reported minute lands in exactly one bucket:

```
matched + classificationConflict + unsupported + selectionRequired
        + configurationRequired + conflictingReferenceExcluded == dedupReported   (partition.balanced)
```

Context codes (`CONTEXT_CODES`) are explanations, not principal findings: `REFERENCE_*`, `SOURCE_EXCLUDED`, `SUPPORT_SURPLUS`, `UNREFERENCED_SUPPORT` and `SCHEDULE_DIFFERENCE`. `SCHEDULE_DIFFERENCE` compares schedule minutes with eligible support per facility, person and date, and is not evidence that extra minutes were worked. Every finding cites `rules:<rulesetId>` and, where they apply, the `sourceSelection:` and `classification:` records it used.

### Golden fixture SL-SYN-001 (literal oracle in `test/golden.test.js`)

| Metric | Minutes |
| --- | --- |
| raw reported | 1560 (26 h) |
| dedup reported | 1080 (18 h) |
| eligible support | 1020 (17 h): payroll 780, agency 240 |
| schedule | 1080 (18 h) |
| dedup − support | 60 |
| partition | matched 780, classification conflict 240, unsupported 60 |

Findings:
- `DUPLICATE_REPORTED_SOURCE` R2 (of R1), 480 minutes
- `UNSUPPORTED_MINUTES` R3 / E2, 60 minutes
- `CLASSIFICATION_CONFLICT` R4 / E3, 240 minutes (CNA reported, RN supported)

The variants:
- **Corrected:** reported 1020 and no findings, with E2's `SCHEDULE_DIFFERENCE` of 60 kept as context.
- **Split:** P2a 120 + P2b 180 matched by R3a and R3b, giving raw 1500 and dedup 1020.
- **Overnight:** E4 has 120 minutes on 10-06 and 360 on 10-07, each reconciled on its own date.

## Public API examples

```js
import {
  reconcile, goldenFixture, filterFindings, supportingRows, verifyReportId, isEngineReport,
  validateDataset, exportDatasetJson, importDatasetJson, exportDatasetCsv, importDatasetCsv,
  createDecision, appendDecision, readiness, exportReportJson, exportReportCsv,
} from './src/index.js';

const res = reconcile(goldenFixture());          // { ok:true, report } | { ok:false, errors }
const report = res.report;                       // deep-frozen
report.totals.dedupReported;                     // 1080
report.partition;                                // { matched:780, classificationConflict:240, unsupported:60, ..., balanced:true }
filterFindings(report, { personId: 'E2' });      // [{ code:'UNSUPPORTED_MINUTES', minutes:60, reason:'EXCESS_OVER_SUPPORT', ... }]
supportingRows(report, report.findings[0].id);   // { finding, lines, sourceStatuses } for "open supporting row"
isEngineReport(report);                          // true: minted by reconcile() in this process
isEngineReport(structuredClone(report));         // false: clones are never accepted
verifyReportId(report);                          // true: engine-minted AND hash consistent; false for any clone

// Round trips (normalized dataset is a fixed point)
const ds = validateDataset(goldenFixture()).dataset;
importDatasetJson(exportDatasetJson(ds));        // { ok:true, dataset } with identical datasetHash
importDatasetCsv(exportDatasetCsv(ds));          // CSV bundle { schemaVersion, datasetId, rules, tables:{...} }

// Inert reviewer decision: annotation only, bound to one reportId
const d = createDecision(report, { findingId: report.findings[0].id, decision: 'ACKNOWLEDGED',
  reviewerId: 'REV-1', note: '=looks fine', decidedAt: '2026-11-03T12:00:00Z' });
const { log } = appendDecision([], report, d.decision); // rejects other reports, duplicates, edited records
readiness(report, log);                          // { status:'REVIEW_INCOMPLETE', certified:false, ... }
exportReportJson(report, log);                   // canonical JSON: report, decisions, readiness; certified:false
exportReportCsv(report, log);                    // flat CSV; note cell becomes "'=looks fine"
```

Decision types are `ACKNOWLEDGED`, `DISPUTED` and `NEEDS_EVIDENCE`. A decision has `effect: "NONE_ANNOTATION_ONLY"`; it never changes source records, findings, totals or certification. Readiness statuses are `NO_PRINCIPAL_FINDINGS_NOT_CERTIFIED`, `REVIEW_INCOMPLETE` and `REVIEWED_NOT_CERTIFIED`. `decidedAt` is supplied by the caller, because the engine never reads the clock.

### Report and decision provenance (same process only)

A report hash is integrity identity, not authenticated evidence. Anyone can rebuild a matching `reportId` over tampered values. So `verifyReportId` returns `true` only for an engine-minted report whose hash also matches. Clones and hash-shaped documents always get `false`, even when their hash is self-consistent.

- **Reports.** `reconcile` deep-freezes every report and records it in a module-private `WeakSet`. No API can add to that set.
  - Every report-taking API accepts **only** those exact objects: `createDecision`, `appendDecision`, `isAuthenticDecision`, `ownDecisions`, `readiness`, `exportReportJson`, `exportReportCsv`, `filterFindings` and `supportingRows`. Each checks membership before reading any property.
  - Rejected objects include `structuredClone`/JSON copies (even untampered), spreads, `Object.create(report)`, proxies, and hand-built objects with a recomputed hash.
  - **There is no report re-import API.** To get a report back, re-run `reconcile` on the dataset; the same dataset yields the same `reportId`.
- **Decisions.** Decisions are minted the same way by `createDecision`. A decision counts for a report when it was minted in this process, its `reportId` equals the report's, and its `findingId` names a finding of that report. This means a re-run of the same dataset accepts it.
  - Never counted: `null`/`undefined` entries, holes, spreads or copies, `Object.create(decision)`, proxies, incomplete records, altered `decisionId`/`findingId`/`effect`, and another report's decisions (even with `reportId` rewritten).
  - `readiness`, `ownDecisions` and the exports skip those entries and count each `decisionId` once. Exports read the log once, so the readiness they embed always matches the decisions they list.
  - `appendDecision` rejects the whole call if the new decision or **any** existing log entry is not authentic.

### Error contract

| API | On bad input |
| --- | --- |
| `validateDataset`, `reconcile`, `importDatasetJson`, `importDatasetCsv`, `createDecision`, `appendDecision` | Return `{ ok: false, errors: [{ code, path, message }] }` and never throw. Decision codes are `UNTRUSTED_REPORT`, `INVALID_DECISION`, `UNKNOWN_FIELD`, `UNKNOWN_FINDING`, `INVALID_DECISION_TYPE`, `INVALID_ID`, `INVALID_NOTE`, `INVALID_TIMESTAMP`, `INVALID_LOG`, `CROSS_REPORT_DECISION` and `DUPLICATE_DECISION`. |
| `readiness`, `ownDecisions`, `exportReportJson`, `exportReportCsv`, `filterFindings`, `supportingRows` | Throw a `TypeError` whose `.code` is `UNTRUSTED_REPORT` (not an engine-minted report) or `INVALID_ARGUMENT`. A log must be an array or omitted. `filterFindings` criteria must be a plain object whose own keys are among `code`, `personId`, `date`, `role` and `facilityId`, with string values. `supportingRows` returns `null` for an unknown or non-string `findingId`. |
| `datasetHash`, `exportDatasetJson`, `exportDatasetCsv`, `exportTableCsv` | Re-validate the dataset and hash or serialize only the normalized result. They throw a `TypeError` with `.code` `INVALID_DATASET`, or `INVALID_ARGUMENT` for an unknown table name. |
| `isEngineReport`, `isAuthenticDecision`, `verifyReportId`, `isUtcTimestamp`, `isCalendarDate` | Return `false` and never throw. |

`createDecision` reads its input from own properties only, each exactly once, so inherited or polluted `Object.prototype` values never fill a missing field.

### CSV formats

- **Dataset CSV import.** One CSV text per table, with the exact header given in `CSV_COLUMNS[table]`. Rules are passed as an object. The parser follows RFC 4180: CRLF or LF line endings, `""` escapes, and no bare CR, bare quote or NUL. An empty cell means the field is absent, and `minutes` must be plain digits.
- **Report CSV export** (`REPORT_CSV_COLUMNS`). Contains `META`, `RULES`, `TOTAL`, `PARTITION`, `FINDING`, `CONTEXT`, `SOURCE` and `DECISION` rows. Minutes are raw integers, and negative differences are numbers. Any string cell starting with `= + - @ TAB CR` gets an apostrophe prefix. Reviewer notes have their own `note` column. The tests parse the export and check every cell.

## Known gaps and limitations (honest scope)

- **JSON parsing:** `JSON.parse` silently keeps the last of any duplicate object keys, and JSON accepts number forms such as `4.8e2` (= 480) while CSV requires plain digits.
- **Unchecked fields:** `timezone` is validated as a name but is otherwise metadata. The reported row's own role is not checked against `reportableRoles`; only the evidence's mapped role is.
- **Wider checks:** Cross-table rules beyond those listed (for example, schedule role versus classification) are not validated.
- **Not implemented:** raw punches and timestamps, accessibility gates, CMS policies or schema versions, authentication, tenancy storage, and connectors.
- **Browser UI (first build, not browser-inspected):** `npm run build` copies `public/` and `src/*.js` into `dist/`; `npm run serve` previews it on `http://127.0.0.1:4173/`. The landing page links to the `/app/` workspace, which runs the real engine in the tab. The CSV bundle editor is not built. Visual, motion, mobile and accessibility status is UNVERIFIED; see `docs/UI-DESIGN.md`.
- **Tenancy:** the engine is pure, and session isolation is limited to report-bound decisions and exports.
- **Provenance:** provenance holds only within one process. Reports and decisions cannot be persisted and re-imported, and there is no signature or authentication of reviewers. Anyone with a genuine report can call `createDecision`.
- **Not hardened:** the byte and row limits are guaranteed for JSON and CSV import, which can never produce getters. Objects passed directly to `validateDataset`/`reconcile` are different: accessor properties or proxies at any level are not protected against returning different values between reads.
- **Not yet done:** a re-audit of these fixes, CI evidence and live workflow verification, as the spec requires.

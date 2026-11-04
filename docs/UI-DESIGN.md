# ShiftLedger UI design plan (compact)

Audience: a staffing controller or reviewer checking synthetic evidence. Primary action: **Open synthetic review** (`/app/`). No logos, customers, metrics or testimonials are invented. Everything is synthetic, uses fictional rules, and runs in one browser tab with no auth, backend, storage or tenancy.

## Three directions considered

| Direction | Typography | Palette | Composition | Verdict |
|---|---|---|---|---|
| A. Nursing staffing journal | Georgia display; system sans for details; tabular numerals | warm cream paper, deep teal ink, muted coral findings, sage resolved | ruled-paper ledger, hairline rules, a day timeline drawn in HTML/CSS | **Chosen** |
| B. Clinical console | one grotesk sans throughout | white, hospital blue, red alerts | dense card dashboard | Rejected: generic dashboard cards; red/blue alarm tone overstates "unsupported" |
| C. Hard-hat payroll audit | condensed industrial sans | safety yellow and charcoal | blocky stencil panels | Rejected: reads as construction (too close to PayGuard) |

Why A: a journal says "careful record, read by a person", which fits evidence review and keeps findings calm. Coral marks things to look at; sage marks resolved states. Neither colour implies fraud.

## Tokens

- `--paper #f6f0e3` background · `--ink #123f3d` text and primary actions · `--coral #a5472f` findings and focus ring · `--sage #4c6a4a` resolved · `--rule #cbbd9f` hairlines · `--paper-deep #ece2cd` hover.
- Display: Georgia (headings, totals). Details: system-ui. IDs: system monospace. All numbers use `tabular-nums`.
- Layout: the landing page is a hero plus a timeline figure, then two quiet bands. The workspace has a left rail (sources, Reconcile, history) and a main column (report header, totals, filters plus findings table, evidence panel with the decision form). Below 860px it becomes one column.
- Imagery: one informative HTML/CSS timeline of the three planted findings plus the corrected rerun. No stock images, generated media or external assets.
- Motion: feedback only (button press, hover, selected-row tint, 120 to 160ms colour/transform). Everything is disabled under `prefers-reduced-motion`.

## Security and honesty boundaries kept

- All engine and file strings render through `textContent` and `createElement`. A test rejects `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, inline `style=` and inline handlers.
- A CSP meta sets `connect-src 'none'`, the landing page has no script, and inline styles are blocked.
- The report trust WeakSet is untouched. The UI keeps the minted report object itself in history and never clones it.
- `sha256Hex` is now a pure synchronous SHA-256, identical to `node:crypto`. Tests cover lengths 0 to 200, Unicode, lone surrogates, about 2.4 MiB of input, and the pre-change golden and corrected report IDs. The hash identifies content and is not a signature.

## Evidence table

| Requirement | Implementation | Evidence | Status |
|---|---|---|---|
| Engine browser-compatible | `src/canonical.js` pure SHA-256 + `TextEncoder`; `io.js` uses `utf8ByteLength` | `node --test`: 57/57 pass; `docs/audits/independent-probes.mjs`: 16/16; report IDs equal to pre-change values | PASS |
| Static build, no repo/docs leakage | `scripts/build.mjs` copies `public/` + `src/*.js` only | `test/ui-build-serve.test.js` | PASS |
| Local server guard | `scripts/serve.mjs` binds 127.0.0.1; GET/HEAD; traversal, NUL and bad-encoding rejected; nosniff | raw-path HTTP tests | PASS |
| UI workflow wiring (import → reconcile → filter → evidence → decision → export → rerun) | `public/app/app.js` | Engine calls exercised in Node from `dist/src`; app.js syntax-checked; DOM ids cross-checked | PASS for engine calls; UNVERIFIED in a real browser |
| Visual design matches direction | `public/styles.css` | No browser screenshot taken | UNVERIFIED |
| Motion and reduced motion | CSS transitions; reduced-motion override | Not observed live | UNVERIFIED |
| Mobile (390px) | single-column breakpoint, scrollable tables, 44px targets | Not inspected | UNVERIFIED |
| Accessibility (keyboard, focus, labels, contrast) | native controls, labels, live region, focus moves | Code review only; no axe run | UNVERIFIED |

Not done in this build: the optional CSV bundle editor, and browser QA (Playwright was not run). No visual release is claimed.

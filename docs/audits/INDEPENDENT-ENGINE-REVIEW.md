# Scoped independent engine review

Codex authored and ran16 public-API probes separately from Claude implementation/test helpers. They check the literal1560/1080/1020 oracle, corrected1020 and schedule context60, valid inert annotations, impossible timestamps, malformed report rejection, tampered totals/findings/provenance export rejection, rehashed fabricated report rejection, forged annotations, normalized JSON/CSV round trips and strict CSV envelope. All16 passed after remediation. Product built-in suite47 tests also passed in independent invocation.

The initial review found accepted impossible timestamps, fabricated report exports and non-idempotent normalization. Claude fixed these; regression probes now pass. Trusted reports and annotations are process-local engine-minted objects; serialized reports cannot be restored as trusted objects. Re-import datasets and recompute. Hashes are integrity identifiers, not proof of evidence authenticity, identity or authorization.

This is scoped local synthetic engine evidence. No real PBJ validation, CMS rule certification, tenant/auth security verification, website, accessibility, deployment or CI acceptance is claimed. A wider hostile-object/algorithm/performance review remains appropriate before real records.

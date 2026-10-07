# Changelog

Public releases use package versions. Internal development phase numbers are planning milestones, not product versions. This public release consolidates a development snapshot; the original private development branches are preserved separately.

## 1.6.2 — Live SQLite history

- Read committed live-WAL history from bounded private snapshots using SQLite recovery, without opening or mutating the source database, WAL or shared-memory files. Keep ignore, forget and source-currentness fences; hold active rollback journals and unsafe captures with distinct reasons.
- Distinguish local source failures, loading, explicitly offline analysis and provider quota failures. Settled failures no longer leave the selected window pending or imply a model request occurred.
- Preserve the Slopie command and Potsherd compatibility executable. This patch makes no new live model calls or broader semantic accuracy claim.

## 1.6.1 — Slopie

- Rebrand the public package, primary command, terminal and repository as Slopie (formerly Potsherd). Run `slopie audit`; `potsherd` remains a compatibility executable. Existing storage, cache, settings, plugins and tool IDs keep their compatibility names.
- Preserve the experimental audit disclosures: partial usage and unknown providers, explicit first-party reference pricing, quota-limited free analysis and unavailable private semantic accuracy. This branding release adds no Jev calls, performance improvement or broader accuracy qualification.
- Retain the observed large synthetic fixture timing of about 33 seconds cold / 22 seconds warm and untuned consumer scores of usefulness 7/10, ease 8/10 and appearance 8/10 at 80 columns (7/10 at 40).

## 1.6.0 — Potsherd release history

- Make `potsherd audit` the terminal retrospective, with Models, Projects, Work, Hall of Fame, Language and Timeline drilldowns. The retention audit remains available with `--legacy`; `--sweep` and `--verify` retain their existing routes.
- Extract recorded per-response models and native usage from Codex, Claude Code, OpenCode and pi. Show API-equivalent value at a dated current catalog snapshot, token/pricing coverage, and explicit unknowns.
- Prepare complete redacted dialogue segments for bounded free-only Jev judgments, select a fitting recent window or labelled newest-episode subset, keep evidence-bound work/outcome/quote judgments separate, and persist body-free derived caches and verified date inventories.
- Disclose transcript recipients at opening, preserve per-record ignore/project/forget/source-currentness checks, and cancel discovery, inference and background refresh when exiting.

## 1.5.0

- Promote the existing candidate implementation to stable package version 1.5.0 and the npm `latest` channel. The v2 tool contract is independent of the package version.
- Retry temporary registry lookup failures within the bounded provenance check after publishing.
- Retain the recorded rc.2 cold-retrieval limitations and 4/10 consumer result. The stable designation does not establish improved retrieval quality or unattended primary-memory acceptance.

## 2.0.0-rc.3

- Restore complete tag history in candidate CI so release-version checks run against reachable release tags.
- Name the v2 agent contract and its four tools explicitly in the README. This candidate carries release metadata and documentation fixes; the rc.2 memory engine and recorded consumer limitations remain unchanged.

## 2.0.0-rc.2

- Default an omitted JSON budget tokenizer to the pinned bundled accountant. Reject explicit unsupported identities and malformed budget fields with safe field-specific errors.
- Add complete scoped CLI JSON and ordinary-flag examples. Existing rc.1 consumer and qualification results remain bound to rc.1.
- Fix native Codex marketplace registration to select `plugins/codex`; Claude Code retains its own marketplace entry.

## 2.0.0-rc.1 — unpublished candidate

Versioned exact evidence and authored-note contracts, scoped capture enrollment, complementary bounded reading, and native integration adapters. Release qualification is incomplete; see [candidate notes](docs/release-candidate.md).

## 1.2.1

Prior public release, retained as the authenticated upgrade and rollback baseline.

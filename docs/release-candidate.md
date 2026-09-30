# 2.0.0-rc.3 release candidate

rc.3 restores complete CI tag history and explicitly names the v2 agent contract in the README. It changes release metadata and documentation only; the rc.2 memory engine and the historical qualification and consumer results below remain applicable with their recorded limits. rc.2 was not published because release validation failed before the publishing step.

rc.2 defaults omitted CLI JSON budget tokenizers to the pinned bundled accountant, adds field-specific input errors, and fixes native Codex marketplace registration. The broad qualification below was measured against rc.1; rc.2 received focused input, version/layout, bundled MCP and installed CLI checks. These changes do not establish semantic readiness or resolve the recorded consumer limitations.

The recorded rc.2 `vitest list` inventory contains **2,391 tests** across 103 files with offline Node-driver defaults and no supplied semantic test assets. The listing excludes skipped cases and files; it runs no tests and establishes no pass result.

The rc.1 baseline qualification inventory defined **2,437 tests** across 104 test files. That historical inventory count
does not imply that every check passed. Qualification results, skipped private-
corpus checks, and reader/model limitations are reported separately. The Node
qualification combines completed files from its interrupted initial run with
the remaining-file continuation; original receipts are preserved.

The candidate keeps source evidence, authored memory and reader judgments separate. The installed `reader next-read` helper exposes the same public bounded source selection used in qualification. Default recall, read and graft do not make paid model calls. Strict reader validation checks citation membership and authority, while semantic support remains unassessed by the engine.

The frozen 144-case warm comparison completed all 72 operations on each interface, with zero integrity failures. Required delivery passed 48/48 on CLI and 48/48 on MCP; literal exact cases passed 6/6 on each. These are evidence delivery results, not a promise that every model answer is correct. Mixed-role composite answers can fail the strict reader contract; an abbreviated citation is not silently repaired.

| Host | Verification level |
|---|---|
| Codex CLI 0.156.1 | Actual native capture, exact source read, sourced write and fresh resume after interruption observed in retained receipts. Prose citation abbreviation remains a limitation. |
| pi 0.74.0 with native ChatGPT OAuth/gpt-5.5 low | Actual file action, native session capture, immutable source read and sourced durable write passed. Fresh fact recovery passed; exact authored-note identity and support resume were not established by the final prompt. Literal recall deliberately excludes authored notes. |
| OpenCode 1.18.21 | Native ChatGPT OAuth succeeded. The model attempt returned a native server error and was not retried in the ancestor project. Adapter/MCP support and fixtures do not certify an actual model workflow. |
| Claude Code 2.1.283 | No Anthropic account was available. Adapter/plugin/hook checks establish mechanical integration only; no native model workflow is claimed. |

The available account is the user's existing Codex subscription. pi and OpenCode use their own supported ChatGPT OAuth sign-in flows. Credentials are never copied from Codex. Vertex test configuration from earlier work is obsolete. Auth profiles, native transcripts and private evidence stores are excluded from release artifacts.

Independent clean workspace build, type checks and canonical plugin vendoring passed. The privacy guard swept 478 tracked text files with zero unaccounted IDs and zero inventory pins; 28 guard probes passed. Both standalone plugin MCP selftests and 34 focused native integration and authentic 1.2.1 upgrade tests passed.

Broad Node-driver qualification covered all 104 files across 26 completed files from the interrupted 600-second run and 78 remaining files from continuation. The continuation recorded 1,078 passes, one documentation-count failure and two skips. After the documented count was corrected, that exact consistency test passed separately. The combined coverage is not an uninterrupted all-green run.

The complete better-sqlite3 run recorded 2,429 passes, one timeout and seven skips in 780.35 seconds. The exact timed-out public cursor-envelope diagnostic passed unchanged when run alone. The original timeout and interrupted-run receipts remain part of the qualification record.

A real consumer trial used a cold snapshot of 97 Claude and five Codex sessions, with 46,412 captured spans. History retrieval was partial/degraded; the useful handoff came from current repository files and commits. Supplied tool paths guided discovery, and the successful in-app consumer does not establish unaided native MCP discovery. The first-call input correction leaves cold retrieval and coverage limitations unresolved. A fresh rc.2 consumer retest took 77 seconds for its first recall and returned an irrelevant tool fragment while 101 capture requests were pending and semantic assets were building. This confirms unresolved cold retrieval; no final retest score is claimed.

Use Node.js 22 or newer and explicit owned source/store roots. For a rehearsed update, preserve the old package and use `maintain --migrate` on a copied store; this creates a pre-upgrade backup. The authentic 1.2.1 fixture verifies source/tool/note/tag/pin preservation and restart behavior. To roll back, stop owned processes, preserve the upgraded store for diagnosis, restore a copy of the pre-upgrade backup, and run the old package against that restored copy.

The prerelease publishing workflow uses npm dist-tag `next` and preserves `latest`. It checks version/tag agreement, privacy, builds, tests, canonical bundles, install behavior and provenance. Local CLI and native Codex plugin installations have been exercised; npm publication is a separate release event.

## Independent rc.2 consumer retest (2026-09-30)

A fresh GPT-6.1-sol/high agent used the installed CLI on an isolated, partial real-project archive, alongside ordinary project files. Scores were discoverability 7/10, ease 5/10, retrieval usefulness 2/10, speed 2/10, evidence trust 8/10, and overall 4/10. Two recalls took 77.3 and 54.6 seconds; neither delivered useful project-status evidence. Local files supplied the answer. The archive reported 101 pending sources and unavailable ready vectors. Query wording and a small delivery budget also limit the conclusions. These are observed consumer results, not storage-test scores or a fully indexed benchmark. Private transcripts and detailed project findings are excluded from this release.

# 2.0.0-rc.1 release candidate

The candidate defines **2,437 tests** across 104 test files. This inventory count
does not imply that every check passed. Qualification results, skipped private-
corpus checks, and reader/model limitations are reported separately. The Node
qualification combines completed files from its interrupted initial run with
the remaining-file continuation; original receipts are preserved.

The candidate keeps source evidence, authored memory and reader judgments separate. The installed `reader next-read` helper exposes the same public bounded source selection used in qualification. Default recall, read and graft do not make paid model calls. Strict reader validation checks citation membership and authority, while semantic support remains unassessed by the engine.

The frozen 144-case warm comparison completed all72operations on each interface, with zero integrity failures. Required delivery passed48/48 on CLI and48/48 on MCP; literal exact cases passed6/6 on each. These are evidence delivery results, not a promise that every model answer is correct. Mixed-role composite answers can fail the strict reader contract; an abbreviated citation is not silently repaired.

| Host | Verification level |
|---|---|
| Codex CLI0.156.1 | Actual native capture, exact source read, sourced write and fresh resume after interruption observed in retained receipts. Prose citation abbreviation remains a limitation. |
| pi0.74.0 with native ChatGPT OAuth/gpt-5.5low | Actual file action, native session capture, immutable source read and sourced durable write passed. Fresh fact recovery passed; exact authored-note identity and support resume were not established by the final prompt. Literal recall deliberately excludes authored notes. |
| OpenCode1.18.21 | Native ChatGPT OAuth succeeded. The model attempt returned a native server error and was not retried in the ancestor project. Adapter/MCP support and fixtures do not certify an actual model workflow. |
| Claude Code2.1.283 | No Anthropic account was available. Adapter/plugin/hook checks establish mechanical integration only; no native model workflow is claimed. |

The available account is the user's existing Codex subscription. pi and OpenCode use their own supported ChatGPT OAuth sign-in flows. Credentials are never copied from Codex. Vertex test configuration from earlier work is obsolete. Auth profiles, native transcripts and private evidence stores are excluded from release artifacts.

Independent clean workspace build, type checks and canonical plugin vendoring pass. The privacy guard swept478trackedtextfiles with zero unaccounted IDs and zero inventory pins;28guard probes pass. Both standalone plugin MCP selftests pass. The34focused native integration and authentic1.2.1upgrade tests pass. The initial broad Node-driver suite was cut off by its outer600-second wrapper before a final summary; its partial results do not establish a full pass. Final broad qualification status must be checked before publication.

Use Node22or newer and explicit owned source/store roots. For a rehearsed update, preserve the old package and use `maintain --migrate` on a copied store; this creates a pre-upgrade backup. The authentic1.2.1fixture verifies source/tool/note/tag/pin preservation and restart behavior. To roll back, stop owned processes, preserve the upgraded store for diagnosis, restore a copy of the pre-upgrade backup, and run the old package against that restored copy.

A prerelease is published with npm dist-tag `next`; existing `latest` remains unchanged. The trusted GitHub Actions publisher checks version/tag agreement, privacy, builds, tests, canonical bundles, install behavior and provenance. Publication and profile installation require their own explicit authorization.

# port log — obra/episodic-memory v1.4.2 → potsherd

Upstream: `obra/episodic-memory`, tag `v1.4.2`, commit
`10757690210574421f1df5f35835af8d0c74d984`, 2026-05-21, MIT,
Copyright (c) 2025 Jesse Vincent. Recorded in `NOTICE`; reachable as the
fetch-only git remote `upstream-episodic`.

**Mechanism.** `git subtree add --prefix packages/core` is impossible — the
phase-1 scout reproduced `fatal: prefix 'packages/core' already exists`, and
there is no `--force`. Per `plans/04-DECISIONS.md` the fork is: upstream added
as a fetch-only remote, files hand-ported into `packages/core/src/` under
potsherd's layer layout, a provenance header on every ported file, the sha in
`NOTICE`. No upstream commit is merged into this history.

**Scope of this task (T1.1).** Every upstream `src/` file appears below,
including the refused ones. "deferred" means the scout marked it take/adapt but
the work belongs to a later task that owns the surface it plugs into; the row
says which task.

## every upstream `src/` file

| upstream path | potsherd path | verdict | why |
|---|---|---|---|
| `src/parser.ts` (claude half) | `packages/core/src/parser/claude.ts`, `parser/content.ts`, `parser/jsonl.ts` | **adapted** | message-shape knowledge kept; exchange boundary moved to the human-prompt rule (`03` §2), tool results paired by `tool_use_id` (upstream leaves a `TODO` and drops them), sidechains parsed instead of excluded, one `SessionRecord` emitted instead of denormalised metadata, byte offsets added for incremental indexing. |
| `src/parser.ts` (codex half) | `packages/core/src/parser/codex.ts` | **adapted** | record dispatch kept verbatim in structure; `event_msg/user_message` now used as the human-prompt test so injected environment context stops becoming a prompt. T1.3 owns `discover()` and titles. |
| `src/parser.ts` (`detectConversationHarness`) | `packages/core/src/parser/detect.ts` | **adapted** | returns `null` for unrecognised files instead of defaulting to `'claude'`, which silently feeds a cursor transcript to the claude parser. |
| `src/embeddings.ts` | `packages/core/src/embeddings.ts` | **verbatim (4 changes)** | model, dtype, 2000-char truncation, mean/normalize pooling and the asymmetric BGE query prefix all kept — upstream measured them. Changed: `env.cacheDir = paths.modelsDir()` (upstream caches 34 MB inside `node_modules`, which a global npm prefix often cannot write and `npm update` deletes); one memoised load promise so concurrent workers stop racing and leaving `.tmp.<pid>` part-files; `console.error` replaced with an `onProgress` callback; the import made dynamic so `potsherd audit` never pays onnxruntime's load cost. |
| `src/embedding-migration.ts` | `packages/core/src/embeddings.ts` (`EMBEDDING_VERSION`, `embeddingToBlob`) | **partially ported** | the constant and the blob packing are here. The batched re-embed pass is **deferred to T1.5**: every statement in it targets `vec_exchanges`, which potsherd's schema does not create until migration 3, and `pickStaleBatch` selects `user_message`/`assistant_message`, columns that do not exist in `03` §3. Porting it now would be dead code against a missing table. |
| `src/search.ts` (`l2DistanceToCosineSimilarity`) | `packages/core/src/search/similarity.ts` | **verbatim** | correct and load-bearing: `embeddings.ts` normalises at write time, so the identity holds. |
| `src/search.ts` (`buildSearchFilters`, `hasMetadataFilters`, KNN over-fetch) | `packages/core/src/search/filters.ts` | **adapted** | the injection-safe bound-parameter pattern and the 3× KNN over-fetch are kept. Columns renamed to `03` §3 (`e.ts`, `s.project`, `s.git_branch` — session metadata lives on `sessions`). Filter set widened to `03` §7. **`AND e.is_sidechain = 0` deleted**: `sidechains` now defaults to `include`. |
| `src/search.ts` (snippet shaping) | `packages/core/src/search/snippet.ts` | **adapted** | upstream's "first 200 chars, whitespace collapsed" is `leadSnippet`. `03` §7 also wants the match highlighted, which upstream has no equivalent of, so `matchSnippet` centres the window and returns highlight offsets. |
| `src/search.ts` (the search itself) | — | **refused** | upstream's text path is `LIKE '%q%'` (`src/search.ts:180-190`) and the repository contains no fts5 and no bm25 anywhere. bm25 over `exchanges_fts` fused with the vector hits by RRF is net-new work, **owned by T1.5**. `searchMultipleConcepts` and `formatResults` go with it: the first is an L6 idea T1.5 will re-derive against RRF, the second prints with `console.log` into a format potsherd's `Theme` replaces. |
| `src/codex-support.ts` | `packages/core/src/codex/version.ts` | **verbatim** | 32 lines of pure semver comparison, no dependencies. Only strict-mode narrowing added (`noUncheckedIndexedAccess`). |
| `src/constants.ts` | `packages/core/src/markers.ts` | **verbatim** | `SUMMARIZER_CONTEXT_MARKER` kept **byte-exact on purpose**: a user migrating from episodic-memory has that string in real transcripts, and honouring their existing opt-out matters more than tidiness. Joined by the exclusion list from `src/sync.ts:7-11` and potsherd's own marker. |
| `src/sync.ts` (`EXCLUSION_MARKERS`) | `packages/core/src/markers.ts` | **verbatim** | see above. |
| `src/summary-sentinel.ts` | `packages/core/src/cards/sentinel.ts` | **verbatim (env renamed)** | 76 lines, self-contained, and the missing/empty/errored/real retry ladder is two upstream bug fixes (#91, #96) phase 2 would otherwise rediscover. Marked **unused until phase 2** in the file header; nothing imports it. |
| `src/sync.ts` (`extractSessionIdFromPath`) | `packages/core/src/parser/codex.ts` (`sessionIdFromPath`) | **adapted** | the last-UUID-in-the-filename rule, which is how a codex rollout filename yields its session id. |
| `src/sync.ts` (`copyIfNewer`, orchestration) | — | **refused** | superseded by phase-0 `rescue.ts`, which already does sha256-verified copies recorded in `archive_files`. Taking `sync.ts` would create a second, unrecorded archive under a second layout. |
| `src/db.ts` | — | **refused** | direct conflict. Upstream has no `sessions` table at all: the grain is the exchange, with session metadata denormalised onto every row, different column names (`user_message`, `timestamp`, `archive_path`), and unversioned migrations that sniff `pragma_table_info`. potsherd's phase-0 `db.ts` implements `03` §3 with a versioned `schema_migrations` table, WAL, `0o600` on db/wal/shm and FK enforcement. The two are not reconcilable by migration. Taken as an idea only: `vec_exchanges USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[384])` and the `sqlite-vec` load call, which T1.5 adds as migration 3. |
| `src/paths.ts` | — | **refused** | direct conflict, and every path in it is `~/.config/superpowers`. potsherd's `paths.ts` is strictly better: `POTSHERD_DIR`/`CLAUDE_CONFIG_DIR` overrides, `slugify`/`unslugify`/`tildify`, `managedSettingsPath()`, and a documented read-only/writable split. `findJsonlFiles` and `getCodexDir` are **deferred to T1.2/T1.3**, which own discovery — and potsherd wants the *opposite* of upstream's `excludedDirNames` behaviour for `subagents/`. |
| `src/file-lock.ts` | — | **refused** | conflict. potsherd's `lock.ts` is an atomic-`mkdir` + pid + stale-takeover lock with a typed `LockBusyError`, already used by rescue and wired into the CLI. Upstream's wraps `proper-lockfile`, a dependency potsherd does not have. Two lock protocols over one `~/.potsherd` is worse than either. |
| `src/indexer.ts` | — | **deferred to T1.5** | the batch/concurrency structure and the index-then-summarise split are worth keeping, but every SQL string targets the refused schema and the fts5 write path and the redaction hook (`03` §5) do not exist upstream. |
| `src/verify.ts` | — | **deferred to the `doctor` task** | good orphan/outdated logic, but it must be rewired onto `sessions`/`archive_files` and folded into the existing `packages/cli/src/commands/doctor.ts`, which this task must not modify. |
| `src/stats.ts` | — | **deferred to the `stats` task** | output shape idea is fine; every query is written for the exchange grain. |
| `src/show.ts` | — | **deferred to the `show` task** | 1,025 lines of transcript→markdown/HTML with real sidechain block handling, worth taking — but it renders with its own formatting rather than potsherd's `Theme`/`render.ts`, and `show` is a later phase-1 deliverable. Carry the locale bug fix in with it: `toLocaleString()` at `src/show.ts` renders `19/9/2025` on a non-`en-US` machine and makes `test/show.test.ts` fail; it is a second clean upstream PR candidate. |
| `src/summarizer.ts` | — | **refused for now (phase 2)** | 594 lines. Not cheap: the prompt, the output contract and the sentinel wiring are all built around upstream's 2–4 sentence blob, whereas potsherd's is the `03` §6 card schema, and the file imports the generated `src/version.ts` and `file-lock.ts`, both refused. What *is* worth copying when phase 2 arrives is small and recorded here so it is not lost: the `query()` option set — `model` from env with a `sonnet` fallback ladder, `resume: sessionId` so the model sees the original session's context, `persistSession: false` (upstream #83, stops the SDK writing a fake session into `~/.claude/projects`), and the `EPISODIC_MEMORY_SUMMARIZER_GUARD` env re-entrancy guard (#87). |
| `src/mcp-server.ts` | — | **refused for now (phase 5)** | 331 lines, two tools. The `search` tool is built on the refused search and must be rebuilt on potsherd's `find`; only the `read`-with-line-pagination tool is a useful reference. Not cheap, and `packages/mcp` does not exist yet. |
| `src/codex-hook-trust.ts` | — | **refused for now (phase 5)** | spawns `codex` over JSON-RPC to read plugin trust state. It is an L8 concern for a plugin potsherd has not built, keyed on the string `episodic-memory@`; landing it now is dead code with a stale key. |
| `src/doctor.ts` | — | **refused** | misleading name: it is a codex-plugin-specific check, not a health command. potsherd's `packages/cli/src/commands/doctor.ts` is the real doctor. |
| `src/types.ts` | — | **refused** | replaced by `packages/core/src/adapters/types.ts`, which is `03` §2. Upstream's `ConversationExchange` is the denormalised exchange-grain shape that goes with the refused `db.ts`. |
| `src/logging.ts` | — | **refused** | 25 lines appending to a file. potsherd's `Theme`/`render.ts` and the `--json` contract cover it. |
| `src/index.ts` | — | **refused** | an `export *` barrel. potsherd's `index.ts` is a curated named-export surface and is the package's public API. |
| `src/index-cli.ts`, `src/search-cli.ts`, `src/show-cli.ts`, `src/stats-cli.ts`, `src/doctor-cli.ts`, `src/sync-cli.ts` | — | **refused** | six hand-rolled `process.argv` parsers printing with bare `console.log`. potsherd has one commander program with `--json/--no-color/--ascii/--width/--claude-dir/--potsherd-dir/--debug` on every verb and screenshot tests in `docs/screens/`. Zero lines survive; the verbs are re-authored as subcommands. |

## non-`src` upstream payload

| upstream path | verdict | why |
|---|---|---|
| `cli/*.js` (7 spawn wrappers), `cli/install-check.js` | **refused** | thin `spawn` shims for the refused CLIs. |
| `scripts/generate-version.js`, generated `src/version.ts` | **refused** | potsherd hard-codes `VERSION` in `packages/core/src/index.ts`. The generated file is gitignored upstream, so a plain copy does not even typecheck. |
| `scripts/postinstall.js` | **refused** | rebuilds native deps globally. potsherd uses pnpm `onlyBuiltDependencies`; this would fight it. |
| `scripts/claude-e2e.js`, `scripts/codex-e2e.js` | **refused** | require real Claude/codex auth and write to `~/.config/superpowers`. |
| `.claude-plugin/`, `.codex-plugin/`, `.agents/`, `hooks/`, `skills/`, `agents/`, `prompts/` | **refused** | superpowers-marketplace branding; phase 5 rebuilds these under `plugins/`. |
| `docs/SCHEMA.md`, `docs/CODEX.md` | **refused** | document the refused schema. The codex format facts potsherd needs are in `docs/upstream/PHASE-1-SCOUT.md` §C1, measured from real files. |
| `dist/` (58 files, 1.3 MB) | **refused** | committed stale build output. |
| `test/**` (35 files, 207 tests) | **refused** | ~145 of the 207 assert upstream's schema, its `~/.config/superpowers` paths or its `EPISODIC_MEMORY_*` env vars, and 12 assert `isSidechain: false` against a search that is about to stop filtering sidechains. The phase plan's "all 38 inherited tests passing" is wrong twice over — the count is 207, and they cannot pass "before any behaviour change" because the behaviour they assert is the behaviour being replaced. potsherd's tests for the ported code are written fresh in `tests/`. |
| `test/fixtures/*.jsonl` (5 files) | **not needed** | potsherd already has a synthetic, reproducible claude fixture (`tests/fixtures/make-fixtures.mjs`) covering titled/SDK/sidechain sessions and every record type. Taking scrubbed real transcripts would add redaction risk for no coverage gain. |

## what T1.1 added that has no upstream ancestor

| potsherd path | why |
|---|---|
| `packages/core/src/adapters/types.ts` | `03` §2 transcribed field for field. The interface T1.2/T1.3's four adapters code to. Imports nothing, so it compiles standalone. |
| `packages/core/src/parser/jsonl.ts` | byte-exact line reader. Upstream streams through `readline`, which hands back decoded strings with no byte position; `03` §3 indexes incrementally by `(source_mtime, source_offset)`, so a reader that reports byte ranges — and refuses to consume a half-written trailing line — is a prerequisite, not a nicety. |
| `packages/core/src/search/similarity.ts` (`rrfScore`) | `03` §7's k=60 RRF constant, beside the similarity conversion it consumes. |

## dependency and build changes

- `packages/core` gains `@huggingface/transformers@^4.2.0` (the only new runtime
  dependency). It is imported dynamically, so nothing but `embeddings.ts` pays
  for it and `potsherd audit` never loads onnxruntime.
- root `package.json` `pnpm.onlyBuiltDependencies` gains `onnxruntime-node`,
  `sharp` and `protobufjs` — transformers' native/codegen dependencies.
- `packages/cli/build.mjs` already lists `@huggingface/transformers` as an
  esbuild external, so no CLI change was needed. When the CLI is published it
  will want the package as an `optionalDependency`; `packages/cli/**` is out of
  scope for this task, so that is left for the task that owns `index`.
- **not added:** `sqlite-vec`, `@anthropic-ai/claude-agent-sdk`,
  `@modelcontextprotocol/sdk`, `proper-lockfile`, `marked`, `zod`. Each belongs
  to a later task (T1.5, phase 2, phase 5) and adding them now would ship
  weight nothing imports.

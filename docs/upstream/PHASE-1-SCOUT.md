# phase 1 scout report — obra/episodic-memory fork + unstudied transcript formats

status: research only. no product code written. no repo file outside `docs/upstream/` touched.
date of investigation: 2026-08-21. machine: darwin 25.5.0, node v24.9.0, npm 11.6.0.

---

# TASK A — the upstream repo

## A1. identity

```
repo     https://github.com/obra/episodic-memory
HEAD     10757690210574421f1df5f35835af8d0c74d984
subject  Release v1.4.2: cross-platform install, summarization & sync robustness
author   Jesse Vincent
date     2026-05-21T14:30:23-07:00
branch   main (origin/HEAD -> origin/main)
```

- **v1.4.2 is real.** It is the latest tag and it points at HEAD. `git describe --tags` on the
  default branch returns exactly `v1.4.2`.
- tag list (depth-50 clone): `v1.1.0 v1.1.1 v1.1.2 v1.2.0 v1.3.0 v1.3.1 v1.4.0 v1.4.1 v1.4.2`.
- `.git` is 1.5 MB. `dist/` is committed to the repo (58 files, 1.3 MB) — a subtree/copy drags
  stale build output in unless excluded.
- **record this sha in `NOTICE`:** `10757690210574421f1df5f35835af8d0c74d984` (`v1.4.2`).

## A2. license

`LICENSE` is the standard MIT text. Copyright line, verbatim:

```
Copyright (c) 2025 Jesse Vincent
```

(Note: `2025`, not 2026. potsherd's existing `NOTICE` says `Copyright (c) Jesse Vincent` with no
year — worth correcting to match upstream exactly.)

## A3. source tree and layer mapping

`src/` — 22 files, 3,864 lines of TypeScript (`wc -l src/*.ts`):

| file | lines | potsherd layer | note |
|---|---:|---|---|
| `src/constants.ts` | 7 | — | one string: the summarizer reentrancy content marker |
| `src/index.ts` | 9 | — | barrel re-export |
| `src/logging.ts` | 25 | L8 | append-to-file logger |
| `src/codex-support.ts` | 32 | L0 | codex CLI version gate (semver compare only) |
| `src/stats-cli.ts` | 32 | L8 | |
| `src/doctor-cli.ts` | 52 | L8 | |
| `src/types.ts` | 57 | L0/L1 | `ConversationExchange`, `ToolCall`, `SearchResult` |
| `src/show-cli.ts` | 59 | L8 | |
| `src/summary-sentinel.ts` | 76 | L5 | error-sentinel file format + retry backoff |
| `src/embeddings.ts` | 88 | **L4** | bge-small pipeline |
| `src/file-lock.ts` | 95 | L1 | `proper-lockfile` wrapper |
| `src/index-cli.ts` | 121 | L8 | |
| `src/doctor.ts` | 122 | L8 | **codex-only** doctor; not a general health check |
| `src/search-cli.ts` | 122 | L8 | |
| `src/codex-hook-trust.ts` | 134 | L8 | codex plugin trust state |
| `src/stats.ts` | 135 | L8 | |
| `src/embedding-migration.ts` | 137 | **L4** | `EMBEDDING_VERSION`, batch re-embed |
| `src/paths.ts` | 167 | L0/L1 | source dirs, jsonl discovery, archive/db paths |
| `src/sync-cli.ts` | 184 | L8 | the SessionStart entry point |
| `src/verify.ts` | 193 | L1 | index/archive consistency + repair |
| `src/sync.ts` | 237 | L2-ish | archive copy + orchestration of index/summarize |
| `src/db.ts` | 307 | **L1** | schema + insert/delete |
| `src/mcp-server.ts` | 331 | **L8** | two MCP tools: `search`, `read` |
| `src/indexer.ts` | 393 | **L4** | walk → parse → embed → insert |
| `src/search.ts` | 431 | **L4** | vector + LIKE text search, multi-concept |
| `src/parser.ts` | 554 | **L0** | claude jsonl + codex rollout → exchanges |
| `src/summarizer.ts` | 594 | **L5** | agent-sdk `query()` + codex `app-server` |
| `src/show.ts` | 1,025 | L8 | jsonl → markdown / HTML renderer |

non-`src` payload also in the repo: `cli/` (7 thin `spawn` wrappers + `install-check.js`),
`scripts/` (version bump, postinstall rebuild, two real-auth e2e harnesses, fixture scrubber),
`hooks/hooks.json`, `agents/search-conversations.md`, `prompts/search-agent.md`,
`skills/remembering-conversations/`, `.claude-plugin/`, `.codex-plugin/`, `.agents/plugins/`,
`docs/SCHEMA.md`, `docs/CODEX.md`.

**Layer roll-up for potsherd's `03 §1`:**

- **L0 adapters/parser** — `parser.ts` (both claude and codex live in one file, dispatched by
  `detectConversationHarness()` sniffing the first parseable line), `paths.ts`
  (`getConversationSourceDirs`, `findJsonlFiles`), `codex-support.ts`, `types.ts`.
- **L1 store** — `db.ts`, `verify.ts`, `file-lock.ts`.
- **L4 index/embeddings/search** — `indexer.ts`, `embeddings.ts`, `embedding-migration.ts`,
  `search.ts`.
- **L5 summarizer** — `summarizer.ts`, `summary-sentinel.ts`, `constants.ts`.
- **L8 surfaces** — `*-cli.ts` (5), `cli/*.js`, `mcp-server.ts`, `show.ts`, `stats.ts`,
  `doctor.ts`, `codex-hook-trust.ts`, `logging.ts`, plus the plugin/skill/agent asset dirs.
- **no L2/L3 equivalent** (no rescue, no ghosts, no audit). `sync.ts` does an archive *copy*
  which is the nearest thing, and phase 0's `rescue.ts` already supersedes it.

## A4. package.json

```
name         episodic-memory
version      1.4.2
type         module            (pure ESM)
main         dist/index.js
engines      *** ABSENT — there is no engines field at all ***
```

bins: `episodic-memory`, `episodic-memory-index`, `episodic-memory-search`,
`episodic-memory-mcp-server` (all `./cli/*.js` spawn wrappers).

dependencies:

| package | range |
|---|---|
| `@anthropic-ai/claude-agent-sdk` | `^0.2.126` |
| `@huggingface/transformers` | `^4.2.0` |
| `@modelcontextprotocol/sdk` | `^1.20.0` |
| `better-sqlite3` | `^12.4.1` |
| `marked` | `^16.4.0` |
| `proper-lockfile` | `^4.1.2` |
| `sqlite-vec` | `^0.1.7-alpha.2` |
| `zod` | `^4.4.2` |

devDependencies: `@types/better-sqlite3 ^7.6.13`, `@types/marked ^5.0.2`, `@types/node ^24.7.0`,
`@types/proper-lockfile ^4.1.4`, `esbuild ^0.25.11`, `tsx ^4.20.6`, `typescript ^5.9.3`,
`vitest ^3.2.4`.

scripts:

```
generate-version   node scripts/generate-version.js
prebuild           npm run generate-version
build              tsc && npm run bundle
bundle             esbuild src/mcp-server.ts --bundle --platform=node --format=esm
                     --outfile=dist/mcp-server.js  (externals: fsevents, claude-agent-sdk,
                     sharp, onnxruntime-node, better-sqlite3, @huggingface/transformers,
                     sqlite-vec, proper-lockfile)
postinstall        node scripts/postinstall.js       (rebuilds native deps)
pretest            npm run generate-version
test               vitest run
test:claude-e2e    node scripts/claude-e2e.js        (needs real Claude auth, opt-in env)
test:codex-e2e     node scripts/codex-e2e.js         (needs real codex, opt-in env)
test:watch         vitest
```

`tsconfig.json`: `target ES2022`, `module ESNext`, **`moduleResolution: "node"`** (classic node10
resolution, not NodeNext), `strict`, `outDir ./dist`, `rootDir ./src`, excludes `test`.
`src/version.ts` is *generated* by `scripts/generate-version.js` and is gitignored — a plain file
copy that omits the generator will not typecheck (`summarizer.ts` imports `VERSION` from it).

## A5. test setup and REAL results

- runner: **vitest 3.2.4** (`vitest run`), config `vitest.config.ts`:
  `globals: true`, `environment: 'node'`, `include: ['test/**/*.test.ts']`, `testTimeout: 30000`.
  Default `hookTimeout` (10 s) is *not* raised.
- **35 test files, 4,525 lines**, plus 5 jsonl fixtures under `test/fixtures/`.
- **207 tests total** — not 38. The "38 tests" in `plans/research/competitors.md` and
  `phases/phase-1-foundation.md` T1.1 acceptance is **wrong**; 35 is the *file* count and 38 was
  presumably a stale reading. The phase-1 acceptance criterion "all 38 inherited tests passing"
  must be rewritten to **207**.

### `npm install` — PASSES

```
added 381 packages, audited 382 in 1m
postinstall: "rebuilt dependencies successfully"
4 high severity vulnerabilities (npm audit)
2 deprecation warnings (prebuild-install@7.1.3, boolean@3.2.0)
```

Native builds (`better-sqlite3`, `onnxruntime-node` via `@huggingface/transformers`,
`sqlite-vec`) all resolved from prebuilds/rebuild on node 24.9.0 darwin-arm64. No compiler errors.

### `npm test` on node 24 — **FAILS as shipped: 14 failed / 193 passed of 207** (exit 1)

```
Test Files  7 failed | 28 passed (35)
     Tests  14 failed | 193 passed (207)
  Duration  84.15s
```

Failing tests, and the **verified root cause of each**:

| test | cause |
|---|---|
| `show.test.ts > should format a simple user-assistant exchange` | **locale bug (real defect).** `show.ts` uses `toLocaleString()`; the test asserts `/9\/19\/2025\|2025-09-19/`. On a non-`en-US` default locale it renders `19/9/2025`. |
| `integration.test.ts` × 4 (Text Search, Combined Search) | `beforeEach` hook exceeds the default 10 s `hookTimeout` while indexing fixtures through the embedder. |
| `search-metadata-filters.test.ts` × 4 | same 10 s `hookTimeout` in `beforeEach`. |
| `verify.test.ts > repairIndex` × 2 | 30 s `testTimeout` exceeded (re-index + embed). |
| `sync-cli-single-instance.test.ts` × 1 | 30 s `testTimeout` (spawns two workers). |
| `sync.test.ts > DO NOT INDEX marker` × 1 | 30 s `testTimeout`. |
| `exclude-nested.test.ts` × 1 | 30 s `testTimeout`. |

**Verified fix — the suite is fully green with two environment changes:**

```
$ npx vitest run <the 6 timing-out files> --testTimeout=120000 --hookTimeout=120000
  Test Files  6 passed (6)       Tests  43 passed (43)

$ LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 npx vitest run test/show.test.ts
  Test Files  1 passed (1)       Tests  17 passed (17)
```

So: **207/207 pass on node 24** once `hookTimeout`/`testTimeout` are raised and the locale is
pinned. Nothing is structurally broken; the shipped config is just tuned for a faster/US-locale
machine. Budget for this in potsherd's `vitest.config.ts` (`testTimeout: 120000`,
`hookTimeout: 120000`) and either pin `LC_ALL` in CI or — better — fix `show.ts` to format dates
with an explicit locale/`Intl.DateTimeFormat('en-CA')`. **That locale fix is a clean, generic
upstream PR candidate alongside the sidechain flag.**

## A6. `is_sidechain = 0` — every occurrence

Hard-coded suppression (the thing phase 1 T1.2 must remove):

```
src/search.ts:165        AND e.is_sidechain = 0      # vector path (vec_exchanges KNN join)
src/search.ts:188        AND e.is_sidechain = 0      # text path (LIKE)
```

Those are the **only two** hard-coded filters. `searchMultipleConcepts` (`src/search.ts:319`)
delegates to `searchConversations`, so fixing those two lines fixes multi-concept too. No filter
exists in `indexer.ts` or `sync.ts` — sidechain exchanges **are** indexed, just never returned.

Every other mention of the column/flag, for completeness:

```
src/db.ts:16             migration: ALTER TABLE exchanges ADD COLUMN is_sidechain BOOLEAN DEFAULT 0
src/db.ts:138            column in CREATE TABLE exchanges
src/db.ts:196            CREATE INDEX idx_sidechain ON exchanges(is_sidechain)
src/db.ts:222,238        insertExchange column list / bound value
src/search.ts:67         SELECT column
src/search.ts:91         row -> isSidechain mapping
src/types.ts:25          ConversationExchange.isSidechain?: boolean
src/parser.ts:17,43      JSONLMessage.isSidechain / ExchangeBuilder.isSidechain
src/parser.ts:138,231    propagation into the exchange
src/show.ts:8            Message.isSidechain
src/show.ts:99,104,113   markdown renderer: sidechain block open/close/marker
src/show.ts:314,318,328  HTML renderer: same
docs/SCHEMA.md:29,89     documentation
test/*.test.ts           12 fixture literals `isSidechain: false`
```

Note the discovery-side companion: `src/paths.ts:61 findJsonlFiles(dir, excludedDirNames)` is
used by `sync.ts` with the *exclude.txt* set, and upstream issue #80 added it specifically so
nested `subagents/` directories can be skipped. potsherd wants the opposite — to **include**
`*/subagents/*.jsonl` and mark them `isSidechain = true` — so the discovery walk needs its own
policy, not just the search filter change.

## A7. data directory constants

```
src/paths.ts:91-108   getSuperpowersDir()
    1. process.env.EPISODIC_MEMORY_CONFIG_DIR
    2. process.env.PERSONAL_SUPERPOWERS_DIR
    3. path.join(process.env.XDG_CONFIG_HOME, 'superpowers')        # paths.ts:101
    4. path.join(os.homedir(), '.config', 'superpowers')            # paths.ts:103

src/paths.ts:113-120  getArchiveDir()
    process.env.TEST_ARCHIVE_DIR
    || ensureDir(path.join(getSuperpowersDir(), 'conversation-archive'))   # paths.ts:119

src/paths.ts:125-127  getIndexDir()  -> <superpowers>/conversation-index   # paths.ts:126
src/paths.ts:132-139  getDbPath()    -> EPISODIC_MEMORY_DB_PATH | TEST_DB_PATH
                                        | <superpowers>/conversation-index/db.sqlite  # paths.ts:138
src/paths.ts:144-146  getExcludeConfigPath() -> <index>/exclude.txt
```

So the literal `~/.config/superpowers/conversation-archive` is composed at
**`src/paths.ts:103` + `src/paths.ts:119`**. Read-source dirs are at `src/paths.ts:39-50`
(`~/.claude/projects`, `~/.claude/transcripts`, `~/.codex/sessions`, honouring
`CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `TEST_PROJECTS_DIR`).

Non-`src` references to the same path (must also be rewritten if those files are taken):
`scripts/postinstall.js:35`, `scripts/claude-e2e.js:183,224`, `scripts/codex-e2e.js:292,339`.

## A8. sqlite schema — full CREATE TABLE text

Upstream has **no migration table**. `migrateSchema()` (`src/db.ts:9`) introspects
`pragma_table_info('exchanges')` and adds any missing column. Verbatim from `src/db.ts:125-177`:

```sql
CREATE TABLE IF NOT EXISTS exchanges (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  user_message TEXT NOT NULL,
  assistant_message TEXT NOT NULL,
  archive_path TEXT NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  embedding BLOB,
  last_indexed INTEGER,
  parent_uuid TEXT,
  is_sidechain BOOLEAN DEFAULT 0,
  harness TEXT NOT NULL DEFAULT 'claude',
  session_id TEXT,
  cwd TEXT,
  git_branch TEXT,
  claude_version TEXT,
  agent_version TEXT,
  model TEXT,
  model_provider TEXT,
  thinking_level TEXT,
  thinking_disabled BOOLEAN,
  thinking_triggers TEXT,
  embedding_version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  exchange_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_input TEXT,
  tool_result TEXT,
  is_error BOOLEAN DEFAULT 0,
  timestamp TEXT NOT NULL,
  FOREIGN KEY (exchange_id) REFERENCES exchanges(id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS vec_exchanges USING vec0(
  id TEXT PRIMARY KEY,
  embedding FLOAT[384]
);

CREATE INDEX IF NOT EXISTS idx_timestamp   ON exchanges(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_session_id  ON exchanges(session_id);
CREATE INDEX IF NOT EXISTS idx_project     ON exchanges(project);
CREATE INDEX IF NOT EXISTS idx_harness     ON exchanges(harness);
CREATE INDEX IF NOT EXISTS idx_sidechain   ON exchanges(is_sidechain);
CREATE INDEX IF NOT EXISTS idx_git_branch  ON exchanges(git_branch);
CREATE INDEX IF NOT EXISTS idx_tool_name   ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_exchange ON tool_calls(exchange_id);
```

Migration list (`src/db.ts:13-29`), each an `ALTER TABLE exchanges ADD COLUMN` guarded by a
`pragma_table_info` name check: `last_indexed, parent_uuid, is_sidechain, harness, session_id,
cwd, git_branch, claude_version, agent_version, model, model_provider, thinking_level,
thinking_disabled, thinking_triggers, embedding_version`. Plus `migrateToolCallsCascade()`
(`src/db.ts:58`), a table-rebuild that adds `ON DELETE CASCADE` and drops orphans.

### diff against potsherd `plans/03-ARCHITECTURE.md §3` (== phase-0 `packages/core/src/db.ts`)

| aspect | upstream v1.4.2 | potsherd `03 §3` / phase-0 |
|---|---|---|
| grain | **exchange only** — no `sessions` table at all; session metadata is denormalised onto every exchange row | `sessions` is the primary entity; exchanges FK to it |
| column names | `user_message`, `assistant_message`, `timestamp`, `tool_name`, `tool_input`, `tool_result` | `user_text`, `assistant_text`, `ts`, `name`, `input`, `result` |
| provenance | `archive_path`, `line_start`, `line_end` on the exchange | `sessions.source_path` + `source_mtime` + `source_offset` |
| **fts5** | **none anywhere** (`grep -rn 'fts5\|bm25' src test docs` → 0 hits). Text search is `LIKE '%q%'` at `src/search.ts:180-190`. | 4 fts5 tables + bm25 fusion |
| vec | `vec_exchanges vec0(id TEXT PK, embedding FLOAT[384])` — **identical to potsherd's plan** | same, plus `vec_cards` |
| migrations | column-sniffing, unversioned, no `schema_migrations` | versioned `MIGRATIONS[]` + `schema_migrations` table |
| ghosts / cards / tags / pins / links / rescue_log / archive_files | absent | all present (phase 0, already created) |
| dead column | `exchanges.embedding BLOB` is created and never written (vectors live in `vec_exchanges`) | n/a |

**Bottom line: the two schemas are not reconcilable by migration; potsherd's is a superset with
different names and a different grain. Upstream `db.ts` must not be taken.** potsherd's phase-0
`db.ts` already implements `03 §3` in full (migration 1 = tables, migration 2 = fts). The only
thing missing for phase 1 is a **migration 3** adding `vec_exchanges` / `vec_cards` (`vec0`) and
loading `sqlite-vec` in `open()` — a ~15-line change, plus the fts5 `content=` sync triggers,
which phase 0 did not write either (fts tables are declared `content='exchanges'` external-content
but no `INSERT/DELETE/UPDATE` triggers exist yet, so they will stay empty until phase 1 adds
either triggers or explicit writes).

## A9. embeddings

- **model id:** `Xenova/bge-small-en-v1.5` (`src/embeddings.ts:20`), **dtype `q8`**
  (`src/embeddings.ts:21`).
- **dimensions: 384** — verified empirically (`output.data.length === 384`); matches
  `vec_exchanges … FLOAT[384]`.
- library: `@huggingface/transformers` `^4.2.0` (installed 4.x, onnxruntime-node backend).
  `env.allowLocalModels = true`, `env.useBrowserCache = false` (`src/embeddings.ts:5-6`).
- **query asymmetry:** `BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant
  passages: '` is applied to **queries only** (`withQueryPrefix`, `generateQueryEmbedding`);
  documents go through unmodified. Idempotent guard included.
- input truncation: `text.substring(0, 2000)` chars (`src/embeddings.ts:46`). Document text is
  `` `User: ${userMessage}\n\nAssistant: ${assistantMessage}` `` plus `\n\nTools: a, b`.
- pooling `mean`, `normalize: true` — hence `l2DistanceToCosineSimilarity(d) = 1 - d²/2` is valid
  (`src/search.ts:116`).
- **download & cache — verified on this machine:** the code sets no `env.cacheDir`, so
  transformers.js uses its default:
  `node_modules/@huggingface/transformers/.cache/Xenova/bge-small-en-v1.5/`. After the test run
  it contained `config.json`, `tokenizer_config.json`, `tokenizer.json` (711 KB) and
  `onnx/model_quantized.onnx` (**34,014,426 bytes / 33 MB**). Total cache **79 MB** — because it
  also held **two leftover partial downloads**,
  `onnx/model_quantized.onnx.tmp.17633.1db8iw2` (17.8 MB) and `.tmp.17709.kzeg3c` (29.5 MB), from
  concurrent vitest workers each racing to fetch the same file. That is a real cache-race defect
  and a reason potsherd should pin a single shared cache dir and serialise first-run download.
  (The phase-1 plan's "~130 MB" download estimate is high; the real payload is ~34 MB.)
- **offline after first run: YES, verified.** With `HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1` a
  cold node process loaded the pipeline and embedded a string in **308 ms**, returning 384 dims,
  with no network. Nothing under `~/.cache/huggingface` was used — the cache is entirely inside
  `node_modules`.
- **implication for potsherd:** the default cache location is wrong for a published CLI (a
  global npm install directory is often not writable, and `npm update` blows the cache away).
  potsherd already has `paths.modelsDir()` → `~/.potsherd/models`; phase 1 must set
  `env.cacheDir = modelsDir()` before the first `pipeline()` call. That is a one-line change with
  a large robustness payoff.
- `src/embedding-migration.ts` carries `EMBEDDING_VERSION` and a batched re-embed pass gated by
  the file lock; worth taking as the pattern for potsherd's `exchanges.embedding_version` column
  (which phase 0 already declared).

## A10. agent-sdk usage

- package: **`@anthropic-ai/claude-agent-sdk` `^0.2.126`**, imported once:
  `src/summarizer.ts:3  import { query } from '@anthropic-ai/claude-agent-sdk';`
- call site: `callClaude()` at `src/summarizer.ts:~176`:

```ts
for await (const message of query({
  prompt,
  options: buildSummarizerQueryOptions({ model, sessionId, cwd }) as any,
})) {
  if (message?.type === 'result') {
    if (message.is_error) throw new SummarizerSdkError(message.subtype ?? 'unknown', message.session_id);
    ...
  }
}
```

- options builder `buildSummarizerQueryOptions()` (`src/summarizer.ts:108-127`):

```ts
{
  model,                      // EPISODIC_MEMORY_API_MODEL || 'haiku'
  max_tokens: 4096,
  env: getApiEnv(),
  resume: sessionId,          // resumes the ORIGINAL session so the model sees full context
  persistSession: false,      // #83 — stops the SDK writing a fake session into ~/.claude/projects
  ...(cwd && fs.existsSync(cwd) ? { cwd } : {}),
  ...(sessionId ? {} : { systemPrompt: 'Write concise, factual summaries. Output ONLY the summary…' })
}
```

- fallback chain: resume failure (`subtype === 'error_during_execution'`, detected by
  `isResumeFailure`) → retry without `resume`; `API Error … thinking.budget_tokens` in the result
  string → retry with `EPISODIC_MEMORY_API_MODEL_FALLBACK` (default `sonnet`).
- **reentrancy marker — there are two distinct ones:**
  1. **env-var guard** `EPISODIC_MEMORY_SUMMARIZER_GUARD='1'`, injected into the spawned
     subprocess's env by `getApiEnv()` (`src/summarizer.ts:67`) and read back by
     `shouldSkipReentrantSync()` (`src/summarizer.ts:81`). The SessionStart hook / `sync-cli`
     bails out when it is set (upstream issue #87). Tested by
     `test/sync-cli-reentrancy.test.ts`.
  2. **content marker** `SUMMARIZER_CONTEXT_MARKER` (`src/constants.ts:6`) —
     `'Context: This summary will be shown in a list to help users and Claude choose which
     conversations are relevant'`. It is embedded in the summarizer prompt, so the summarizer's own
     transcript contains it, and `sync.ts:7-11 EXCLUSION_MARKERS` skips any file containing it.
     The same list holds the user opt-out marker
     `<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>`
     and `'Only use NO_INSIGHTS_FOUND'`.
- codex path does **not** use the SDK: `buildCodexSummarizerCommand()` spawns
  `codex app-server` (`src/summarizer.ts:161`) and talks JSON-RPC over stdio, gated on a minimum
  codex CLI version via `src/codex-support.ts`.

---

# TASK B — fit against potsherd's existing phase-0 core

potsherd's `packages/core/src/` today (phase 0): `paths.ts`, `theme.ts`, `format.ts`, `render.ts`,
`render/audit-card.ts`, `render/rescue-receipt.ts`, `db.ts`, `lock.ts`, `rescue.ts`, `audit.ts`,
`consent.ts`, `resolve-bin.ts`, `archive-state.ts`, `claude/scan.ts`, `claude/history.ts`,
`claude/sessions-index.ts`, `claude/settings.ts`, `index.ts`. Package `@potsherd/core`, ESM,
`module: NodeNext`, `strict` + `noUncheckedIndexedAccess`, only dep `better-sqlite3`.
`packages/cli` is a commander CLI (`audit rescue guard doctor`) with a `@potsherd/core` alias.

## B1. per-file verdict

### take VERBATIM (or near-verbatim: rename imports only)

| upstream file | why |
|---|---|
| `src/embeddings.ts` | model choice is measured and the query-prefix asymmetry is exactly right. Only change: add `env.cacheDir = paths.modelsDir()` and replace `console.error` with potsherd's logger. |
| `src/embedding-migration.ts` | `EMBEDDING_VERSION` + batched re-embed under a lock. Adapt table/column names only. |
| `src/summary-sentinel.ts` | small, self-contained, no schema coupling. Useful in phase 2. |
| `src/codex-support.ts` | pure semver comparison, 32 lines, no deps. |
| `src/codex-hook-trust.ts` | pure parsing of codex state; phase 5 will want it. |
| `src/constants.ts` | one string; take it plus the opt-out marker from `sync.ts:7-11` into a `markers.ts`. |
| `test/fixtures/*.jsonl` (5 files) | real redacted claude transcripts — free parser fixtures. Check the scrub level before committing. |
| `src/show.ts` markdown/HTML **renderers** | 1,025 lines of working transcript→md/html with sidechain block handling. Take the rendering logic; **fix the `toLocaleString` locale bug** on the way in. |

### take with ADAPTATION (rewrite the storage/naming layer, keep the algorithm)

| upstream file | what changes |
|---|---|
| `src/parser.ts` | the claude path is the right shape but must be **split** into `adapters/claude.ts` + `adapters/codex.ts` behind potsherd's `discover()/parse()` interface, must emit `sessions` rows (upstream emits only exchanges), must stop dropping `subagents/`, must carry `agent_name` / `parent_session_id` / `entrypoint` / `ai-title`, and must produce `seq` + byte offsets for incremental indexing. Expect ~60% rewrite; the value taken is the message-shape knowledge (content-block handling, tool_use/tool_result pairing, codex rollout dispatch), not the code. |
| `src/indexer.ts` | keep the batch/concurrency structure and the "index then summarize" split; rewrite all SQL and add the fts5 write path and redaction hook. |
| `src/search.ts` | keep `l2DistanceToCosineSimilarity`, the `buildSearchFilters` bound-parameter pattern (it is injection-safe and there is a test for it), and the multi-concept idea. **Discard** the `LIKE '%q%'` text path entirely — potsherd needs bm25 over `exchanges_fts` and RRF fusion, which upstream has no equivalent of. Delete both `is_sidechain = 0` lines. |
| `src/verify.ts` | good `doctor`-adjacent logic (orphans, outdated, missing summaries). Rewire onto potsherd's `sessions`/`archive_files` tables and fold into the existing `packages/cli/src/commands/doctor.ts`. |
| `src/stats.ts` | rewrite the queries for the session grain; keep the output shape idea. |
| `src/sync.ts` `copyIfNewer` + `extractSessionIdFromPath` | two small useful helpers. But the archive-copy orchestration is superseded — see below. |
| `src/mcp-server.ts` | phase 5. Keep as a reference for the `read`-with-line-pagination tool; the `search` tool must be rebuilt on potsherd's find. |
| `src/summarizer.ts` | phase 2 material. The `query()` option set (`resume`, `persistSession:false`, the fallback ladder) is hard-won and should be copied; the prompt and output contract will be potsherd's card schema, not a 2-4 sentence blob. |

### do NOT take — phase 0 already has better or incompatible

| upstream file | reason |
|---|---|
| **`src/db.ts`** | **direct conflict.** Different grain (no `sessions`), different column names, unversioned column-sniffing migrations. potsherd's `packages/core/src/db.ts` already implements `03 §3` with a versioned `schema_migrations` table, WAL, `0o600` chmod on db+wal+shm, and FK enforcement. Take only the *idea* of `vec_exchanges` and the `sqlite-vec` load call as a new migration 3. |
| **`src/paths.ts`** | **direct conflict.** potsherd's `paths.ts` is strictly better: env-overridable `POTSHERD_DIR`, `claudeDir()` with `CLAUDE_CONFIG_DIR`, `slugify`/`unslugify`/`tildify`, `managedSettingsPath()`, and a documented read-only/writable split. Port in only `findJsonlFiles(dir, excludedDirNames)` and `getCodexDir()` (`CODEX_HOME`) as new functions. Every `superpowers` path must die. |
| **`src/file-lock.ts`** | **conflict.** potsherd's `lock.ts` is an atomic-`mkdir` + pid + stale-takeover lock with a typed `LockBusyError` and a 5-min stale window, already used by rescue and wired into the CLI. Upstream's wraps `proper-lockfile` — a dependency potsherd currently does not have. Keeping both means two lock protocols over one `~/.potsherd`. **Keep potsherd's; discard upstream's**, and if the 10-minute stale window matters for long index runs, widen potsherd's constant. |
| **all `src/*-cli.ts` (5 files) + `cli/*.js` (7 wrappers)** | **conflict.** potsherd has a single commander program with global `--json/--no-color/--ascii/--width/--claude-dir/--potsherd-dir/--debug` on every verb, `Theme`, `Card`/`table` renderers, and a documented three-rules contract. Upstream's are hand-rolled `process.argv` parsers with `console.log`. Take zero lines; re-implement the verbs as commander subcommands. |
| `src/doctor.ts` | misleading name — it is *codex-plugin-specific*. potsherd's `commands/doctor.ts` is the real doctor. Fold upstream's codex checks in as one section, later. |
| `src/logging.ts` | trivial; potsherd's `output.ts`/`Theme` covers it. |
| `src/index.ts` (barrel) | potsherd's `index.ts` is a curated named-export surface, not `export *`. Do not replace it. |
| `scripts/generate-version.js` + generated `src/version.ts` | potsherd hard-codes `VERSION` in `index.ts`. Do not import the generator; it will break the build if `version.ts` is missing. |
| `scripts/postinstall.js` | rebuilds native deps globally; potsherd uses pnpm `onlyBuiltDependencies`. Actively harmful. |
| `.claude-plugin/`, `.codex-plugin/`, `.agents/`, `hooks/`, `skills/`, `agents/`, `prompts/` | superpowers-marketplace-flavoured; phase 5 rebuilds these under potsherd's brand. Do not land them in `packages/core`. |
| `dist/` (58 files, 1.3 MB) | committed stale build output. Must be excluded from any copy. |

## B2. the three hardest conflicts with phase-0 code

1. **`db.ts` vs `db.ts` — schema grain.** Upstream is exchange-centric with denormalised session
   metadata and no `sessions` table; potsherd is session-centric with FKs and `ON DELETE CASCADE`.
   Every upstream SQL string (in `db.ts`, `search.ts`, `indexer.ts`, `verify.ts`, `stats.ts`,
   `mcp-server.ts`) is written against columns that do not exist in potsherd
   (`user_message`/`assistant_message`/`timestamp`/`archive_path`/`line_start`). **Nothing
   SQL-touching survives unedited.** Additionally upstream has **no fts5 at all** — its "text
   search" is `LIKE '%q%'` — so the entire bm25 half of phase 1's `find` is net-new work, not
   inherited.
2. **CLI framework.** Upstream ships 5 `*-cli.ts` files + 7 `cli/*.js` spawn wrappers that each
   parse `process.argv` by hand and print with bare `console.log`. potsherd's CLI is one commander
   program with globals repeated on every verb, a `Theme`, a `--json` contract, and screenshot
   tests in `docs/screens/`. These cannot coexist; the upstream surface layer is a total loss and
   must be re-authored (~600 lines).
3. **Locking + paths + config dir.** Two incompatible lock protocols (`proper-lockfile` mkdir+
   heartbeat vs potsherd's own `mkdir`+pid), two path modules with clashing function names, and a
   hard-coded `~/.config/superpowers` tree (db at `conversation-index/db.sqlite`, archive at
   `conversation-archive/<project>/`) versus potsherd's `~/.potsherd` layout
   (`potsherd.db`, `archive/<harness>/<slug>/`) that phase-0's `rescue.ts` and `archive-state.ts`
   already populate. Upstream's `sync.ts` archive-copy is *superseded* by phase-0 `rescue.ts`,
   which already does sha256-verified copies recorded in `archive_files` — taking `sync.ts`
   wholesale would create a second, unrecorded archive.

   Runner-up worth flagging: **tsconfig**. Upstream is `moduleResolution: "node"` (node10) without
   `noUncheckedIndexedAccess`; potsherd is `NodeNext` + `strict` + `noUncheckedIndexedAccess`.
   Upstream code does not compile under potsherd's tsconfig without edits (unchecked index
   accesses in `parser.ts` and `search.ts`, `row: any` casts, missing `.js` extension discipline
   in a few places).

## B3. is `git subtree add --prefix packages/core` viable? — NO, empirically

Tested directly:

```
$ git init test && mkdir -p packages/core/src && touch packages/core/src/db.ts && git commit …
$ git subtree add --prefix packages/core <upstream> main --squash
fatal: prefix 'packages/core' already exists.
```

`git subtree add` refuses any prefix that already exists in the tree. There is no `--force`.
The phase-1 plan's T1.1 instruction is therefore **not executable as written** and must be
rewritten. The realistic options:

- **(a) subtree into a fresh prefix** — `git subtree add --prefix packages/vendor/episodic-memory
  … main --squash`, then hand-port files into `packages/core/src/`. Keeps upstream history and a
  `git subtree pull` path, but leaves a 1.3 MB `dist/` and a second `package.json`/`tsconfig.json`
  inside the workspace glob (`packages/*`), which pnpm and `pnpm -r build` will both try to pick
  up. Needs a workspace exclusion and a `.gitignore` entry.
- **(b) plain vendored copy** — copy `src/` and `test/fixtures/` into
  `packages/core/src/inherited/` (or straight into layer dirs), record the sha in `NOTICE` and a
  per-file header comment. No upstream history, no `subtree pull`; upstream tracking becomes a
  manual `git diff <old-sha>..<new-sha> -- src/`.
- **(c) upstream as a git remote, no subtree** — `git remote add upstream …; git fetch upstream`,
  then cherry-pick file contents at will. History is *reachable* (so `git log upstream/main --
  src/parser.ts` works and future diffs are trivial) without polluting the working tree.

### RECOMMENDATION — **(c) + (b): add upstream as a fetched-only git remote, and hand-port files into `packages/core/src/` under potsherd's layer layout, with the sha `1075769…` recorded in `NOTICE` and a provenance header on each ported file.**

Justification, three sentences: subtree is mechanically impossible into the non-empty
`packages/core` and pointless into `packages/vendor` because — as B1 shows — nothing that touches
SQL, paths, locking or the CLI survives unedited, so the "keep history for easy pulls" benefit
never materialises while the cost (a second `package.json` inside `packages/*`, a committed 1.3 MB
`dist/`, a squashed merge commit) is paid immediately. Keeping upstream as a fetched remote gives
the *entire* benefit anyone actually wanted — `git log`/`git diff` against upstream at any future
sha, and a clean base to author the sidechain-flag and locale PRs from — at the cost of one line
in `.git/config` and zero bytes in the working tree. The `NOTICE` file phase 0 already wrote is
explicitly waiting for exactly this ("upstream: (recorded in phase 1)"), and MIT only requires the
copyright + permission notice travel with the code, which a per-file provenance header plus
`NOTICE` satisfies for a hard fork.

Concrete steps for the worker brief:

```
git remote add upstream https://github.com/obra/episodic-memory.git
git fetch upstream --no-tags 'refs/heads/main:refs/remotes/upstream/main' 'refs/tags/v1.4.2:refs/tags/upstream-v1.4.2'
# NOTICE: upstream: obra/episodic-memory v1.4.2 @ 10757690210574421f1df5f35835af8d0c74d984 (2026-05-21)
# each ported file header:  // ported from obra/episodic-memory@1075769 src/<file>.ts (MIT, (c) 2025 Jesse Vincent)
```

Then land the port as **two commits**: (1) "fork: vendor upstream v1.4.2 sources under
`packages/core/src/inherited/`, unmodified except import paths" with its own passing test subset,
(2) the adaptation. That preserves the *spirit* of T1.1's "green baseline" commit, which is
otherwise unachievable — see next section.

## B4. real cost to get upstream tests green inside potsherd's monorepo

The plan's T1.1 acceptance — "`npm test` passes the inherited 38 before any behaviour change" —
is **not achievable**, for four independent reasons, and the worker brief must say so:

1. the count is 207, not 38;
2. ~120 of those 207 assert against upstream's schema and column names, which potsherd's `db.ts`
   does not have, so they cannot pass "before any behaviour change";
3. ~25 assert `~/.config/superpowers` paths and `EPISODIC_MEMORY_*` env vars;
4. 12 assert `isSidechain: false` fixtures against a search that is about to stop filtering
   sidechains.

Realistic breakdown of the work:

| item | detail | est. |
|---|---|---|
| runner | both are vitest — **no runner migration**. But upstream uses `globals: true` (bare `describe/it/expect`) and potsherd's config does not; either add `globals: true` or add `import { describe, it, expect } from 'vitest'` to each ported test file. Potsherd is on vitest **2.1.8**, upstream on **3.2.4** — bump the root devDependency to ^3 (potsherd's 6 existing test files are plain and will survive it). | 0.5 h |
| vitest version + pool | potsherd runs `pool: 'forks', singleFork: true` for lock honesty. Upstream's suite takes 84 s with the default parallel pool; forced single-fork it will be ~5-8 min unless embedding-heavy tests get a shared model instance. Plan a `describe.concurrent` / separate project for the embedding tests, or accept the runtime. | 2 h |
| timeouts | raise `testTimeout` and `hookTimeout` to 120 s (verified sufficient on this machine). | 5 min |
| locale | pin `LC_ALL`/`TZ` in the vitest env **and** fix `show.ts` to use an explicit `Intl.DateTimeFormat`. | 1 h |
| ESM/CJS | **no conflict** — both are `"type": "module"`, pure ESM, ESM-only deps. Nothing to convert. | 0 |
| tsconfig | upstream is `moduleResolution: "node"` and lacks `noUncheckedIndexedAccess`; potsherd is `NodeNext` + that flag. Every ported file needs explicit `.js` extensions (upstream already has these — good) and index-access guards. `row: any` casts in `search.ts` need typing. | 4-6 h |
| path aliases | potsherd's vitest maps `@potsherd/core` → `packages/core/src/index.ts`. Ported tests import relative paths (`../src/db.js`) — those keep working if the tests land under `packages/core/`. Add `include: ['packages/*/test/**/*.test.ts']` to the root vitest config, or move ported tests into `tests/inherited/` and rewrite imports. | 1 h |
| test rewrites | the ~145 schema/path/env-coupled tests must be rewritten against potsherd's schema, not ported. This is the bulk. | 1.5-2 days |
| native deps | add `@huggingface/transformers`, `sqlite-vec` to `packages/core` deps and to pnpm `onlyBuiltDependencies` (`better-sqlite3` and `esbuild` are already there; `onnxruntime-node` needs adding). Verified to build clean on node 24 darwin-arm64. | 1 h |
| `sqlite-vec` load | potsherd's `db.open()` does not call `sqliteVec.load(db)`. Add it, guarded, in migration 3. | 0.5 h |
| model cache dir | set `env.cacheDir = paths.modelsDir()`; serialise the first-run download behind the existing `lock.acquire('embed-init')` to avoid the `.tmp.<pid>` races observed upstream. | 1 h |

**Total realistic estimate: 2.5-3.5 agent-days for T1.1 alone**, against the phase plan's 1.5-2
days for the *whole* phase. Recommend either splitting T1.1 into its own phase-1a or explicitly
descoping the "all inherited tests green" gate to "the ~60 tests that are schema-independent
(parser, embeddings, cosine, file-lock, codex-support, summary-sentinel, show, version) are green;
the rest are rewritten as potsherd tests during T1.5."

## B5. corrections the worker briefs must carry

- upstream test count is **207**, not 38. Fix `plans/research/competitors.md` and
  `plans/phases/phase-1-foundation.md` T1.1.
- `git subtree add --prefix packages/core` **cannot run**. Fix T1.1.
- upstream has **no fts5 and no bm25** — `exchanges_fts` + bm25 + RRF in T1.5 is entirely net-new,
  not "inherited". `plans/research/competitors.md` says "search: vector / text / both" which is
  true but "text" means `LIKE '%q%'`.
- upstream has **no `sessions` table**. Every "keep their `db.ts`" instruction is wrong.
- the phase plan's "first-run model download (~130 MB)" is **~34 MB** (`model_quantized.onnx`),
  ~35 MB with tokenizer. `--no-embed` is still the right flag; the message should say 34 MB.
- risk list says "better-sqlite3 native build on node 22"; verified fine on **node 24.9.0** with
  npm. potsherd uses pnpm — re-verify there, the `onlyBuiltDependencies` allowlist must gain
  `onnxruntime-node`.
- `NOTICE` should say `Copyright (c) 2025 Jesse Vincent` to match `LICENSE` verbatim.
- two clean upstream-PR candidates for `docs/upstream/`, not one: (a) the generic sidechain-flag
  change (`src/search.ts:165,188` → an opt-in `includeSidechains` search option), and (b) the
  `show.ts` locale bug that makes `test/show.test.ts` fail on any non-`en-US` machine.

---

# TASK C — the three unstudied transcript formats

(filled in below from direct inspection of real files on a live machine. destined for
`plans/research/formats.md`.)

> **Every record below is structurally real and textually synthetic.** The shapes were measured
> against live transcripts — every key, type, nesting level, ordering and count is exactly what was
> on disk, and the `// orig N` byte counts are the real lengths of what was elided. But every
> *human-authored value* has been replaced: prompts, agent replies, reasoning summaries, titles,
> file names, session/client uuids and home-directory paths. Replacements are internally consistent
> (one `cwd`, one session-id family per harness, replies that still match their prompts) so the
> format is still learnable from them. This repository is public; the ground rule is that committed
> artefacts carry the synthetic corpus, never the live one. `scripts/check-privacy.py` enforces it.
> If you need the real records, re-run the scout against a kept `--potsherd-dir` — re-examinable
> does not mean published.

## C0. summary table (read this first)

| | codex | cursor | pi |
|---|---|---|---|
| files found | 1 rollout (2.13 MB, 85 records) + `session_index.jsonl` (1 line) | 4 (1.50 MB / 299 KB / 14.8 KB / 15.0 KB), 857 records | 4 (55 KB / 1.3 KB / 1.1 KB / 1.1 KB), 31 records |
| discriminator | `type` (envelope) + `payload.type` | **`role`** — there is no `type` field | `type` + `message.role` + `content[].type` |
| session id | `payload.session_id` (session_meta) + filename | **filename / dir name only** | `$.id` on the `session` header |
| cwd | `payload.cwd` (session_meta, turn_context) | **not in file** — lossy dir slug, real value in `workspace.json` | `$.cwd` on the header |
| title | **not in rollout** → `session_index.jsonl .thread_name` | **not in file** → sqlite `composerData.name` | **does not exist**; derive from first user message |
| model | `turn_context.payload.model` | **not in file** → sqlite `composerData.modelConfig.modelName` | `model_change.modelId` / `message.model` |
| git branch | **not in JSONL** → `state_5.sqlite threads.git_branch` | **not in file** → sqlite `composerData.trackedGitRepos[].branches[]` | **not recorded anywhere** |
| human prompt test | `event_msg/user_message` exists for that text | `role:"user"` **and** `<user_query>` followed by a newline | `type:"message" && message.role==="user"` |
| tool results | `custom_tool_call_output` (by `call_id`) | **not persisted at all** | `message.role === "toolResult"` (by `toolCallId`) |
| structure | flat append-only, dual stream | flat append-only | **DAG** via `id`/`parentId` |
| adapter difficulty | **medium-hard** | **hard** | **easy-medium** |

---

## C1. codex — `~/.codex/sessions/**/*.jsonl`

### files

```
~/.codex/session_index.jsonl                                       139 B, 1 line
~/.codex/sessions/2026/07/21/rollout-2026-07-21T19-35-33-0c000001-1000-7000-8000-000000000001.jsonl
                                                             2,134,842 B, 85 lines
~/.codex/transcription-history.jsonl                            44,402 B   (voice dictation, NOT a transcript)
~/.codex/.tmp/plugins/.../responses.jsonl                                  (vendored fixture, unrelated)
```

- **1 rollout transcript only**, 2026-07-21. `~/.codex/archived_sessions/` **does not exist** on this
  machine — the phase-1 plan's T1.3 "archived_sessions/ too" is speculative, keep it but do not
  gate acceptance on it.
- layout: `sessions/<YYYY>/<MM>/<DD>/rollout-<YYYY-MM-DD>T<HH-MM-SS>-<session-uuid>.jsonl`.
- **the filename timestamp is LOCAL wall-clock; every timestamp inside the file is UTC `Z`.**
  Here they differ by 5h30m. Never sort by mixing them.
- sibling state: `~/.codex/state_5.sqlite` has a `threads` table which is the real session
  catalogue: `id, rollout_path, cwd, title, name, preview, first_user_message, cli_version, model,
  reasoning_effort, tokens_used, archived, git_sha, git_branch, git_origin_url, history_mode`.
  **This is the only place git branch/sha/origin exist.** Also `goals_1.sqlite`, `memories_1.sqlite`,
  `logs_2.sqlite`, `sqlite/codex-dev.db`.

### record types

Every record has exactly three top-level keys: `timestamp`, `type`, `payload`.

| envelope `type` | count | `payload.type` | count |
|---|---:|---|---:|
| `response_item` | 51 | `reasoning` | 14 |
| | | `message` | 13 |
| | | `custom_tool_call` | 12 |
| | | `custom_tool_call_output` | 12 |
| `event_msg` | 30 | `token_count` | 14 |
| | | `agent_message` | 5 |
| | | `user_message` | 2 |
| | | `task_started` | 2 |
| | | `patch_apply_end` | 2 |
| | | `agent_reasoning` | 2 |
| | | `turn_aborted` | 1 |
| | | `thread_settings_applied` | 1 |
| | | `task_complete` | 1 |
| `turn_context` | 2 | *(payload has no `type`)* | |
| `world_state` | 1 | *(payload has no `type`)* | |
| `session_meta` | 1 | *(payload has no `type`)* | |

**`response_item` and `event_msg` are two parallel views of the same conversation.** An assistant
turn appears twice (`event_msg/agent_message` + `response_item/message role=assistant`), reasoning
twice, the user prompt twice. **A naive parser double-counts everything.** potsherd's adapter should
build exchanges from `response_item` and use `event_msg` only for the human-prompt test and turn
timings.

### fields

- `session_meta.payload` — `session_id, id, timestamp, cwd, originator, cli_version, source,
  thread_source, model_provider, base_instructions{text}, dynamic_tools[], history_mode,
  context_window{window_id}`. `base_instructions.text` is a 17,730-char system prompt;
  `dynamic_tools` is ~39 KB of JSON Schema.
- `turn_context.payload` — `turn_id, cwd, workspace_roots[], current_date, timezone,
  approval_policy, approvals_reviewer, sandbox_policy, permission_profile,
  file_system_sandbox_policy, model, comp_hash, personality, collaboration_mode,
  multi_agent_version, multi_agent_mode, realtime_active, effort, summary`.
- `world_state.payload` — `full, state{agents_md, apps_instructions, environments,
  environments_instructions, host_skills, plugins_instructions, skills}`.
- `response_item/message` — `type, id, role, content[], phase?, internal_chat_message_metadata_passthrough{turn_id}`.
  Content parts are `{type:"input_text",text}` (user/developer) or `{type:"output_text",text}` (assistant).
- `response_item/reasoning` — `type, id (rs_…), summary[{type:"summary_text",text}], encrypted_content, …passthrough`.
- `response_item/custom_tool_call` — `type, id (ctc_…), status, call_id (call_…), name, input, …passthrough`.
- `response_item/custom_tool_call_output` — `type, id (ctco_…), call_id, output[] (array of parts,
  `input_text` or `input_image`), …passthrough`.
- `event_msg/user_message` — `type, client_id (uuid), message, images[], local_images[], text_elements[]`.
- `event_msg/agent_message` — `type, message, phase, memory_citation`.
- `event_msg/task_started` — `type, turn_id, started_at (unix **seconds**), model_context_window, collaboration_mode_kind`.
- `event_msg/task_complete` — `type, turn_id, last_agent_message, started_at, completed_at, duration_ms, time_to_first_token_ms`.
- `event_msg/turn_aborted` — `type, turn_id, reason, started_at, completed_at, duration_ms`.
- `event_msg/token_count` — `type, info (object **or null**), rate_limits`.
- `event_msg/patch_apply_end` — `type, call_id (**exec-<uuid>**, a different namespace), turn_id, stdout, stderr, success, changes{path:{type,content}}, status`.
- `event_msg/thread_settings_applied` — `type, thread_settings{model, model_provider_id, service_tier, approval_policy, approvals_reviewer, permission_profile, cwd, reasoning_effort, reasoning_summary, personality, collaboration_mode}`.

### where the facts live

| datum | path |
|---|---|
| session id | `session_meta: .payload.session_id` (== `.payload.id` == uuid in filename) |
| cwd | `session_meta: .payload.cwd`; per-turn `turn_context: .payload.cwd`; `world_state: .payload.state.environments.environments.local.cwd` |
| workspace roots | `turn_context: .payload.workspace_roots[]` |
| record ts | `.timestamp` on every record (ISO-8601 UTC, ms, `Z`) |
| session ts | `session_meta: .payload.timestamp` |
| turn epochs | `event_msg/task_started .payload.started_at`, `task_complete .payload.{started_at,completed_at,duration_ms}` — **unix seconds** |
| title | **not in rollout** → `session_index.jsonl .thread_name`, or `state_5.sqlite threads.title` |
| model | `turn_context: .payload.model`, `.payload.collaboration_mode.settings.model`, `event_msg/thread_settings_applied .payload.thread_settings.model` |
| cli version | `session_meta: .payload.cli_version` (`0.145.0-alpha.27`) |
| entrypoint | `session_meta: .payload.originator` (`Codex Desktop`), `.payload.source` (`vscode`), `.payload.thread_source` (`user`) |
| system prompt | `session_meta: .payload.base_instructions.text` — never replayed as a message record |
| turn linkage | `response_item: .payload.internal_chat_message_metadata_passthrough.turn_id` → `turn_context.payload.turn_id` |
| git branch | **absent from JSONL** → `state_5.sqlite threads.git_branch/git_sha/git_origin_url` |

### human prompt vs injected content

**The reliable test: a `response_item/message role=user` is human iff a matching
`event_msg/user_message` exists** (same text, adjacent timestamp). Injected content only ever
appears as `response_item`, never as `event_msg`.

| source | envelope | role | text discriminator |
|---|---|---|---|
| genuine human | `event_msg/user_message` **and** `response_item/message` | `user` | raw text, no XML wrapper |
| environment context | `response_item/message` only | `user` | starts `<environment_context>`, contains `<cwd> <shell> <current_date> <timezone> <filesystem>` |
| plugin recommendations | `response_item/message` only | `user` | starts `<recommended_plugins>` |
| system prompt fragments | `response_item/message` | `developer` | `<permissions instructions>`, `<app-context>`, `<collaboration_mode>`, `<apps_instructions>`, `<plugins_instructions>`, `<skills_instructions>`, `<multi_agent_mode>`, `<turn_aborted>` |
| tool results | `custom_tool_call_output` | *(no role)* | separate record type, never `role:"user"` |
| client file attachment | both | `user` | genuine turn, but body prefixed with `# Files mentioned by the user:` … `## My request for Codex:` |

Cheap proxy when you cannot cross-reference: `role:"developer"` is always injected; a `role:"user"`
whose first content part starts with `<` is injected. `<user_instructions>` (the AGENTS.md wrapper)
appears **0 times here** because `world_state.payload.state.agents_md` is `{}` — still expect it.

### assistant turns / tools / reasoning

- assistant text = `response_item/message role=assistant`, parts of `output_text`, `id` prefixed
  `msg_08…` (model-generated, opaque) vs `msg_<uuid>` (locally constructed). `phase` ∈
  `commentary` (4) / `final_answer` (1).
- **this build uses `custom_tool_call` / `custom_tool_call_output` — NOT `function_call` /
  `function_call_output`, and no `local_shell_call` appears.** All 12 calls are `name:"exec"` and
  the `input` is a **JavaScript source string** (`tools.exec_command({...})`,
  `tools.apply_patch(...)`, `tools.request_permissions({...})`), not JSON arguments. Upstream
  episodic-memory's codex parser assumes the older shapes — this is a real gap to test.
- join tool call → output on `payload.call_id` (`call_<22 alnum>`). Output is an **array** of parts.
- file edits also emit `event_msg/patch_apply_end` whose `call_id` is `exec-<uuid>`, a **different
  namespace** that does not match any `custom_tool_call.call_id` — join by `turn_id` + order.
  `changes` embeds full new file contents.
- reasoning: `response_item/reasoning`, `id` `rs_08…`. **12 of 14 have an empty `summary` array**;
  `encrypted_content` is an opaque `gAAAAAB…` blob, not decodable. Chain-of-thought is unrecoverable.

### `session_index.jsonl`

Flat, three fields, **no `type` field and no envelope** — structurally unlike the rollout:

```json
{"id":"0c000001-1000-7000-8000-000000000001","thread_name":"Merge the pantry exports","updated_at":"2026-07-21T14:05:43.61507Z"}
```

- **carries the title** as `thread_name` — this is the JSONL-tier title source T1.3 asks for.
- join key: `.id` == `session_meta.payload.session_id` == uuid in the rollout filename.
- no path field: glob `sessions/**/rollout-*-<id>.jsonl`, or read `threads.rollout_path`.
- `updated_at` is **stale** — `14:05:43` here vs the file's last record at `14:34:17`. Do not use
  it for recency; use the rollout's last record timestamp or the file mtime.

### what breaks a naive parser

1. **one 1,917,792-byte line** (line 73, a `custom_tool_call_output`) — 90% of the file. Fixed-size
   line buffers, `readline` caps, and naive `split('\n')` on a full read all break.
2. **base64 images inline** — `output[].image_url` holds `data:image/png;base64,…` of 109 KB-198 KB
   each, up to 15 parts in one record. Redaction and indexing must skip `input_image` parts.
3. **payload discriminator depth varies** — `session_meta`, `turn_context`, `world_state` have no
   `payload.type`. `rec.payload.type` is `undefined` on 4 of 85 records.
4. **every turn recorded twice** (see above).
5. `event_msg/token_count.info` is `null` on 1 of 14 and an object on 13 — heterogeneous type.
6. **two id namespaces on the same key name** (`call_…` vs `exec-…`; `msg_<uuid>` vs `msg_08…`).
7. tool arguments are JavaScript source, not JSON.
8. `<permissions instructions>` contains a space — not a valid tag name, so `<\w+>` section
   splitters miss it. Prose also contains stray `<b>`, `<module>`, `<author>`.
9. filename local time vs JSON UTC.
10. **title and git metadata are not in the JSONL** — a self-contained parser cannot produce them.
11. `history_mode: "legacy"` implies other on-disk modes exist; `originator: "Codex Desktop"` /
    `source: "vscode"` sessions differ from pure-CLI ones.
12. encoding is clean UTF-8 with a trailing newline.

### redacted examples (one per record type)

> every record in this block is **synthetic**. the shape, key order, field sizes and the `// orig N chars` annotations were measured on a real file; every id, name, path and piece of prose below is invented. ("replace the content, keep the structure" — `scripts/check-privacy.py`.)

```jsonc
// session_meta  (dynamic_tools[] and base_instructions.text elided)
{"timestamp":"2026-07-21T14:05:34.223Z","type":"session_meta","payload":{
  "session_id":"0c000001-1000-7000-8000-000000000001","id":"0c000001-1000-7000-8000-000000000001",
  "timestamp":"2026-07-21T14:05:33.563Z","cwd":"/path/to/project","originator":"Codex Desktop",
  "cli_version":"0.145.0-alpha.27","source":"vscode","thread_source":"user","model_provider":"openai",
  "base_instructions":{"text":"You are Codex, an agent based on GPT-5. You and the user share one workspace…"},  // orig 17730 chars
  "dynamic_tools":[{"type":"namespace","name":"codex_app","description":"Tools provided by the Codex app.","tools":[/* 5 JSON Schemas, ~39 KB */]}],
  "history_mode":"legacy","context_window":{"window_id":"0c00ffff-1000-7000-8000-0000000000ff"}}}
```

```jsonc
// turn_context  (entry lists truncated)
{"timestamp":"2026-07-21T14:05:37.379Z","type":"turn_context","payload":{
  "turn_id":"0c000011-1000-7000-8000-000000000011","cwd":"/path/to/project",
  "workspace_roots":["/path/to/project","/path/to/project","~/.codex/visualizations/2026/07/21/0c000001-…"],
  "current_date":"2026-07-21","timezone":"Asia/Kolkata",
  "approval_policy":{"granular":{"sandbox_approval":false,"rules":false,"skill_approval":false,"request_permissions":true,"mcp_elicitations":true}},
  "approvals_reviewer":"user",
  "sandbox_policy":{"type":"workspace-write","writable_roots":["/path/to/project","…"],"network_access":false,"exclude_tmpdir_env_var":false,"exclude_slash_tmp":false},
  "permission_profile":{"type":"managed","file_system":{"type":"restricted","entries":["…19 entries"]},"network":"restricted"},
  "file_system_sandbox_policy":{"kind":"restricted","entries":["…19 entries"]},
  "model":"gpt-5.6-terra","comp_hash":"3000","personality":"friendly",
  "collaboration_mode":{"mode":"default","settings":{"model":"gpt-5.6-terra","reasoning_effort":"medium","developer_instructions":"# Collaboration Mode: Default…"}},  // orig 925
  "multi_agent_version":"v2","multi_agent_mode":"explicitRequestOnly","realtime_active":false,"effort":"medium","summary":"auto"}}
```

```jsonc
// world_state
{"timestamp":"2026-07-21T14:05:37.379Z","type":"world_state","payload":{"full":true,"state":{
  "agents_md":{},"apps_instructions":true,
  "environments":{"environments":{"local":{"cwd":"/path/to/project","status":"available","shell":"zsh"}},
    "current_date":"2026-07-21","timezone":"Asia/Kolkata",
    "filesystem":"<filesystem><workspace_roots><root>/path/to/project</root>…"},  // orig 1805
  "environments_instructions":false,
  "host_skills":{"body":"\n## Skills\nA skill is a set of instructions provided through a `SKILL.md` source…","includeInstructions":true},  // orig 5969
  "plugins_instructions":true,"skills":{"includeInstructions":true}}}}
```

```jsonc
// response_item/message role=user — GENUINE human prompt (mirrored by event_msg/user_message)
{"timestamp":"2026-07-21T14:05:41.180Z","type":"response_item","payload":{
  "type":"message","id":"msg_0c000001-6a10-7d40-9b01-000000000001","role":"user",
  "content":[{"type":"input_text","text":"Can you turn these two CSV exports into one weekly shopping list? I am sure I am missing edge cases, like duplicate rows and items past their expiry…"}],  // orig 2074
  "internal_chat_message_metadata_passthrough":{"turn_id":"0c000011-1000-7000-8000-000000000011"}}}
```

```jsonc
// response_item/message role=user — INJECTED (no matching event_msg)
{"timestamp":"2026-07-21T14:05:35.116Z","type":"response_item","payload":{
  "type":"message","id":"msg_0c000001-6a11-7d40-9b01-000000000002","role":"user","content":[
    {"type":"input_text","text":"<recommended_plugins>\nHere is a list of plugins that are available but not installed.\n\n- Example Connector (example-connector@openai-curated-remote)\n…\n</recommended_plugins>"},  // orig 555
    {"type":"input_text","text":"<environment_context>\n  <cwd>/path/to/project</cwd>\n  <shell>zsh</shell>\n  <current_date>2026-07-21</current_date>\n  <timezone>Asia/Kolkata</timezone>\n  <filesystem>…"}],  // orig 2029
  "internal_chat_message_metadata_passthrough":{"turn_id":"0c000011-1000-7000-8000-000000000011"}}}
```

```jsonc
// response_item/message role=developer (system prompt fragments, 6 parts in one record)
{"timestamp":"2026-07-21T14:05:35.103Z","type":"response_item","payload":{
  "type":"message","id":"msg_0c000001-6a12-7d40-9b01-000000000003","role":"developer","content":[
    {"type":"input_text","text":"<permissions instructions>\nFilesystem sandboxing defines which files can be read or written…"},  // orig 1282
    {"type":"input_text","text":"<app-context>\n# Codex desktop context\n- You are running inside the Codex (desktop) app…"},   // orig 4900
    {"type":"input_text","text":"<collaboration_mode># Collaboration Mode: Default…"},                                    // orig 966
    {"type":"input_text","text":"<apps_instructions>\n## Apps (Connectors)…"},                                            // orig 646
    {"type":"input_text","text":"<plugins_instructions>\n## Plugins…"},                                                   // orig 1014
    {"type":"input_text","text":"<skills_instructions>\n## Skills…"}],                                                    // orig 6012
  "internal_chat_message_metadata_passthrough":{"turn_id":"0c000011-1000-7000-8000-000000000011"}}}
```

```jsonc
// response_item/message role=assistant
{"timestamp":"2026-07-21T14:31:01.348Z","type":"response_item","payload":{
  "type":"message","id":"msg_0c0000000000000000000000000000000000000000000000aa","role":"assistant","phase":"commentary",
  "content":[{"type":"output_text","text":"I'll merge the two exports into a single de-duplicated list, grouped by aisle, with expired items moved to a separate section…"}],  // orig 325
  "internal_chat_message_metadata_passthrough":{"turn_id":"0c000012-1000-7000-8000-000000000012"}}}
```

```jsonc
// response_item/reasoning
{"timestamp":"2026-07-21T14:31:35.496Z","type":"response_item","payload":{
  "type":"reasoning","id":"rs_0c0000000000000000000000000000000000000000000000bb",
  "summary":[{"type":"summary_text","text":"**Choosing a merge key for the two exports**"}],
  "encrypted_content":"<redacted>",   // opaque "gAAAAAB…", orig 1892 chars, NOT decodable
  "internal_chat_message_metadata_passthrough":{"turn_id":"0c000012-1000-7000-8000-000000000012"}}}
```

```jsonc
// response_item/custom_tool_call  — note: input is JavaScript source, not JSON
{"timestamp":"2026-07-21T14:31:02.340Z","type":"response_item","payload":{
  "type":"custom_tool_call","id":"ctc_0c0000000000000000000000000000000000000000000000cc","status":"completed",
  "call_id":"call_0c00000000000000000000cc","name":"exec",
  "input":"const r = await tools.request_permissions({permissions:{file_system:{read:[\"/path/to/project\"]}},reason:\"Read the two CSV exports the user supplied…\"}); text(r);",
  "internal_chat_message_metadata_passthrough":{"turn_id":"0c000012-1000-7000-8000-000000000012"}}}
```

```jsonc
// response_item/custom_tool_call_output — the 1.9 MB line, with images
{"timestamp":"2026-07-21T14:34:01.451Z","type":"response_item","payload":{
  "type":"custom_tool_call_output","id":"ctco_0c000077-2b40-7e05-8ab1-000000000004","call_id":"call_0c00000000000000000000dd",
  "output":[
    {"type":"input_text","text":"Script completed\nWall time 0.5 seconds\nOutput:\n"},
    {"type":"input_image","image_url":"data:image/png;base64,<redacted>","detail":"high"},   // orig 109362 chars
    {"type":"input_image","image_url":"data:image/png;base64,<redacted>","detail":"high"}    // orig 149522 chars
    /* …15 output parts total; whole line 1,917,792 bytes */],
  "internal_chat_message_metadata_passthrough":{"turn_id":"0c000012-1000-7000-8000-000000000012"}}}
```

```jsonc
// event_msg/user_message — the authoritative "this was a human" marker
{"timestamp":"2026-07-21T14:05:41.181Z","type":"event_msg","payload":{
  "type":"user_message","client_id":"0c000001-6a00-7d40-9b01-000000000005",
  "message":"Can you turn these two CSV exports into one weekly shopping list? I am sure I am missing edge cases…",  // orig 2074
  "images":[],"local_images":[],"text_elements":[]}}
```

```jsonc
// event_msg/agent_message
{"timestamp":"2026-07-21T14:31:01.347Z","type":"event_msg","payload":{
  "type":"agent_message","message":"I'll merge the two exports into a single de-duplicated list, grouped by aisle…","phase":"commentary","memory_citation":null}}
```

```jsonc
// event_msg/agent_reasoning
{"timestamp":"2026-07-21T14:31:35.495Z","type":"event_msg","payload":{"type":"agent_reasoning","text":"**Choosing a merge key for the two exports**"}}
```

```jsonc
// event_msg/task_started
{"timestamp":"2026-07-21T14:05:34.230Z","type":"event_msg","payload":{
  "type":"task_started","turn_id":"0c000011-1000-7000-8000-000000000011","started_at":1784642734,"model_context_window":258400,"collaboration_mode_kind":"default"}}
```

```jsonc
// event_msg/task_complete
{"timestamp":"2026-07-21T14:34:17.060Z","type":"event_msg","payload":{
  "type":"task_complete","turn_id":"0c000012-1000-7000-8000-000000000012",
  "last_agent_message":"Wrote and spot-checked the merged shopping list: 41 items, 3 duplicates folded, 2 expired entries set aside…",  // orig 450
  "started_at":1784644251,"completed_at":1784644457,"duration_ms":205142,"time_to_first_token_ms":8176}}
```

```jsonc
// event_msg/turn_aborted
{"timestamp":"2026-07-21T14:05:41.780Z","type":"event_msg","payload":{
  "type":"turn_aborted","turn_id":"0c000011-1000-7000-8000-000000000011","reason":"interrupted","started_at":1784642734,"completed_at":1784642741,"duration_ms":7577}}
```

```jsonc
// event_msg/token_count  (info non-null variant)
{"timestamp":"2026-07-21T14:05:41.500Z","type":"event_msg","payload":{"type":"token_count",
  "info":{"total_token_usage":{"input_tokens":18549,"cached_input_tokens":16640,"cache_write_input_tokens":0,"output_tokens":209,"reasoning_output_tokens":67,"total_tokens":18758},
          "last_token_usage":{"input_tokens":18549,"cached_input_tokens":16640,"cache_write_input_tokens":0,"output_tokens":209,"reasoning_output_tokens":67,"total_tokens":18758},
          "model_context_window":258400},
  "rate_limits":{"limit_id":"codex","limit_name":null,"primary":{"used_percent":0.0,"window_minutes":43200,"resets_at":1787234737},
    "secondary":null,"credits":{"has_credits":false,"unlimited":false,"balance":null},
    "individual_limit":null,"spend_control_reached":null,"plan_type":"free","rate_limit_reached_type":null}}}
```

```jsonc
// event_msg/patch_apply_end
{"timestamp":"2026-07-21T14:33:22.450Z","type":"event_msg","payload":{
  "type":"patch_apply_end","call_id":"exec-0c000060-1a27-7c33-8de2-000000000006","turn_id":"0c000012-1000-7000-8000-000000000012",
  "stdout":"Success. Updated the following files:\nA /path/to/project/work/merge_exports.py\n","stderr":"","success":true,
  "changes":{"/path/to/project/work/merge_exports.py":{"type":"add","content":"import csv\nfrom collections import defaultdict\n…"}},  // orig 17732
  "status":"completed"}}
```

```jsonc
// event_msg/thread_settings_applied
{"timestamp":"2026-07-21T14:30:51.250Z","type":"event_msg","payload":{"type":"thread_settings_applied",
  "thread_settings":{"model":"gpt-5.6-terra","model_provider_id":"openai","service_tier":"default",
    "approval_policy":{"granular":{"sandbox_approval":false,"rules":false,"skill_approval":false,"request_permissions":true,"mcp_elicitations":true}},
    "approvals_reviewer":"user",
    "permission_profile":{"type":"managed","file_system":{"type":"restricted","entries":["…23 entries"]},"network":"restricted"},
    "cwd":"/path/to/project","reasoning_effort":"medium","reasoning_summary":"detailed","personality":"friendly",
    "collaboration_mode":{"mode":"default","settings":{"model":"gpt-5.6-terra","reasoning_effort":"medium","developer_instructions":"# Collaboration Mode: Default…"}}}}}
```

```jsonc
// session_index.jsonl — the entire file, 1 line, 139 bytes
{"id":"0c000001-1000-7000-8000-000000000001","thread_name":"Merge the pantry exports","updated_at":"2026-07-21T14:05:43.61507Z"}
```

---

## C2. cursor — `~/.cursor/projects/*/agent-transcripts/*/*.jsonl`

### files

```
~/.cursor/projects/<project-slug>/agent-transcripts/<composerId-uuid>/<composerId-uuid>.jsonl
~/.cursor/projects/<project-slug>/agent-transcripts/<composerId-uuid>/subagents/<subagentComposerId-uuid>.jsonl
```

47 project directories exist; only **3** have an `agent-transcripts/` dir and only **2** are
non-empty. **4 `.jsonl` files, 857 records total:**

| bytes | `wc -l` | records | mtime | path |
|---:|---:|---:|---|---|
| 1,501,637 | 737 | **738** | 2026-05-06 16:58 | `…/agent-transcripts/7a000001-…0001/7a000001-…0001.jsonl` |
| 299,416 | 94 | **95** | 2026-05-08 13:05 | `…/agent-transcripts/7a000002-…0002/7a000002-…0002.jsonl` |
| 14,775 | 11 | **12** | 2026-05-04 00:43 | `…/7a000001-…0001/subagents/7a000003-1000-7000-8000-000000000003.jsonl` |
| 14,992 | 11 | **12** | 2026-05-04 00:43 | `…/7a000001-…0001/subagents/7a000004-1000-7000-8000-000000000004.jsonl` |

- the `*` under `projects/` is **one of three shapes**:
  - a **lossy path slug** — leading `/` stripped, every `/` **and `_`** replaced by `-`.
    `Users-example-my-project` → `/Users/example/my_project`. **Not reversible.**
  - a **millisecond epoch integer** (9 dirs) for windows with no folder open, e.g. `1787250391971`.
  - the literal string `empty-window`. Temp workspaces appear as `var-folders-x7-…-T-<uuid>`.
- the `*` under `agent-transcripts/` is the **session UUID** (Cursor's `composerId`); the file
  inside repeats it as basename. Subagent transcripts sit under `subagents/`, named by the child's
  own composer uuid.
- **`~/.cursor/projects/.agent-data-cleanup-2026-08-20` (0 bytes) proves Cursor prunes this tree.**
  The 2 surviving sessions are a remnant — same disease potsherd exists to treat, on a second
  harness. Worth a line in `audit`.

### record types

**There is no `type` field at top level.** The discriminator is **`role`**. Every record is exactly
`{"role":…, "message":{…}}` — two keys, no exceptions, 857/857.

| `role` | count |
|---|---:|
| `assistant` | 748 |
| `user` | 109 |

Nested: `message.content[].type`

| role | block type | count |
|---|---|---:|
| user | `text` | 109 |
| assistant | `text` | 433 |
| assistant | `tool_use` | 958 |

**No `system`, no `tool_result`, no thinking/reasoning block type anywhere** (`grep -c tool_result`
= 0 in all four files).

### fields

- top-level record: `role: string`, `message: object`. **Nothing else** — no `id`, `uuid`,
  `parentUuid`, `timestamp`, `version`, `sessionId`, `cwd`.
- `message`: exactly one key, `content: array` (857/857).
- user `text` block: `type: string`, `text: string`.
- assistant `text` block: `type: string`, `text: string`.
- assistant `tool_use` block: `type: string`, `name: string`, `input: **object 838× / string 120×**`.
  **`tool_use` has no `id`** — there is no correlation key to any result.

Tool `name` values (958 calls): `Shell` 241, `ReadFile` 189, `ApplyPatch` 120, `Read` 72,
`TodoWrite` 64, `Glob` 58, `EditNotebook` 41, `ReadLints` 34, `AwaitShell` 27, `rg` 22, `Delete` 17,
`StrReplace` 16, `Write` 13, `WebSearch` 11, `WebFetch` 11, `Grep` 11, `updateCurrentStep` 6,
`SemanticSearch` 2, `Subagent` 2, plus one malformed name (below).

### where the facts live — almost nowhere in the file

| wanted | in transcript? | actual location |
|---|---|---|
| session id | no field | **filename + parent dir name**; authoritative at sqlite `composerData:<uuid>` → `$.composerId` |
| cwd / workspace root | no field | project dir slug (lossy); authoritative at `~/Library/Application Support/Cursor/User/workspaceStorage/<wsHash>/workspace.json` → `$.folder` (a `file://` URI), and `composerData.trackedGitRepos[0].repoPath` |
| timestamps | **only as free text inside user prompts**: `$.message.content[0].text` starts `<timestamp>Monday, May 4, 2026, 12:39 AM (UTC+5:30)</timestamp>`. **Assistant records have no timestamp at all.** | `composerData.createdAt`, `.lastUpdatedAt`, `.conversationCheckpointLastUpdatedAt` (ms epoch) |
| title | absent | `composerData.name` (e.g. `"Refactor the ingest pipeline"`); one-line summary at `.subtitle` |
| model | absent | `composerData.modelConfig.modelName` (`"gpt-5.5"`, `"claude-opus-4-7"`), `.selectedModels[].modelId`, `.parameters[]` (`context:"1m"`, `reasoning:"extra-high"`) |
| git branch | absent | `composerData.trackedGitRepos[].branches[].branchName` |

**The only per-turn time signal is the `<timestamp>` inside user prompts.** Everything between two
user turns is undated. In-transcript range: Mon May 4 2026 00:39 → Wed May 6 16:57 (session 1),
Fri May 8 06:05 → 12:02 (session 2), all `(UTC+5:30)`.

### human prompt vs injected content

All 109 `role:"user"` records contain `<user_query>…</user_query>`, so role alone is insufficient.
**The discriminator is the character immediately after the opening tag:**

- **genuine human** — `<user_query>` followed by a **newline**:
  `…</timestamp>\n<user_query>\n<human text>\n</user_query>`. **95 of 109** (93 with a `<timestamp>`
  prefix in main transcripts; 2 without, in subagent transcripts, where the "human" prompt is
  actually the parent agent's `Subagent.prompt` verbatim).
- **system-injected continuation** — preceded by a **blank line**, and `<user_query>` followed
  **immediately by text, no newline**. Exactly **4 of 109**, two fixed literal bodies:
  - `The above subagent result is already visible to the user. DO NOT reiterate or summarize its contents unless asked, or if multi-task result synthesis is required. Otherwise do not say anything and end your turn.` (2×, right after `Subagent` calls; the two are **byte-identical duplicate lines**)
  - `Briefly inform the user about the task result and perform any follow-up actions (if needed).` (2×)
- **attachment preambles** prepended before the `<timestamp>` on 10 records — these still wrap a
  genuine prompt:
  - `<image_files>\nThe following images were provdied by the user and saved to the workspace for future use:\n1. /path/to/project/assets/image-<uuid>.png\n\nThese images can be copied for use in other locations.\n</image_files>` — **note Cursor's own typo "provdied"**, a stable literal to match on.
  - `<uploaded_documents>\nThe following documents have been saved to your filesystem…\n- /path/to/project/uploads/175200-0.md (175200-0.md)\n</uploaded_documents>`

Caution: pasted content **inside** a genuine `<user_query>` produced `<module>` (Python
tracebacks), `<client-name>`, `<organization-slug>`. **Only tags occurring before the first
`<user_query>` are structural.**

### assistant turns, tool calls, streaming

- **whole messages, not streaming deltas.** Each `role:"assistant"` record is one complete message;
  no partial/duplicate prefixes across records. Blocks-per-record for the largest file: 1 ×328,
  2 ×238, 3 ×36, up to 10 ×1.
- common shapes: `(tool_use)` 246, `(text, tool_use)` 218, `(text)` 82, `(text, tool_use, tool_use)`
  51, `(tool_use, tool_use, tool_use)` 26 — **parallel tool calls batch into one record.**
- a conversational turn spans **many** consecutive assistant records — runs reach **42 consecutive
  assistant records** before the next user record. Group on user-record boundaries.
- **tool outputs are not persisted at all.** Zero `tool_result` blocks, no `id` on `tool_use`, no
  exit codes, no stdout, no file contents read back. The transcript records what the agent *asked
  for*, never what it *got*. `tool_calls.result` will be `NULL` for every cursor row.
- reasoning is **flattened into `text`** as bold-headed prose (e.g. `**Weighing the file options**`),
  not a separate block type.
- subagents: a `Subagent` tool_use (`{"description":…, "subagent_type":"explore", "readonly":true,
  "run_in_background":true, "prompt":"…"}`) returns **no id**; the only link to the child transcript
  is `composerData.subagentComposerIds`, which matched the two `subagents/*.jsonl` basenames
  exactly. **For potsherd: `subagents/*.jsonl` → `is_sidechain = 1`, `parent_session_id` = the
  enclosing dir uuid** — the path itself is the join, which is the same rule as Claude Code's
  `*/subagents/*.jsonl`. Good news for T1.2/T1.3 sharing one code path.

### what breaks a naive parser

1. **no `type` field** — `record.type` is `undefined` on 100% of records.
2. **`tool_use.input` is polymorphic**: object 838×, **string 120×** — every `ApplyPatch` passes a
   raw V4A patch string (`"*** Begin Patch\n*** Add File: /path/to/project/…\n+…"`, up to 15,424
   chars). `input.foo` throws or silently yields `undefined`.
3. **malformed tool name with an embedded newline**: `"Grep path\n/path/to/project"` (1
   occurrence, subagent file line 6) — an argument leaked into `name`.
4. **no trailing newline on the final line of all four files.** `wc -l` under-reports by exactly 1
   (737/738, 94/95, 11/12). A reader requiring `\n` termination drops the last record.
5. **long lines**: max 57,862 bytes; max single text block 39,576 chars.
6. **byte-identical duplicate records** (lines 29 and 30 of the large transcript) — content-hash
   dedup silently loses a real record. potsherd's exchange id must include the line number.
7. **version drift with no version field**: subagent transcripts omit the `<timestamp>` prefix and
   their first user record is the parent's prompt. Infer from path (`/subagents/`).
8. **no timestamps on assistant records** — nothing between user turns can be dated.
9. **slug ambiguity** (`_` → `-`). Never derive cwd from the slug; join to `workspace.json`.
10. non-slug project dirs are bare integers or `empty-window`.
11. **no base64 / no embedded images** (`grep -c 'data:image'` = 0). Images live as separate PNGs
    under `~/.cursor/projects/<slug>/assets/image-<uuid>.png`, referenced by path only.
12. no empty `content` arrays and no empty text blocks — that much is safe.

### sibling metadata and how to join

`~/.cursor/projects/<slug>/` has **no title/cwd metadata file**. Its siblings are `canvases/`,
`mcps/<server>/{SERVER_METADATA.json,INSTRUCTIONS.md,STATUS.md}`, `terminals/<id>.txt`, `rules/`,
`agent-tools/`, `uploads/`, `assets/`. The metadata lives in two sqlite DBs **outside**
`~/.cursor`:

**A. `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`** — 276 MB, WAL mode;
open with `file:…?immutable=1` to stay read-only. Table `cursorDiskKV(key, value)`, 9,413 rows.
Key prefixes: `agentKv:` 6,896, `bubbleId:` 1,779, `composerData:` 171, `checkpointId:` 159,
`ofsContent:` 67, `codeBlockDiff:` 49, `inlineDiff:` 47, `messageRequestContext:` 8.

Join: `SELECT value FROM cursorDiskKV WHERE key = 'composerData:' || <uuid>` where `<uuid>` is the
transcript's dir/file name. The JSON value (`$._v` = 16) supplies everything the transcript lacks:
`name` (title), `subtitle`, `createdAt`, `lastUpdatedAt`, `status` (`"completed"`), `unifiedMode`
(`"agent"`), `forceMode`, `agentBackend` (`"cursor-agent"`), `isAgentic`, `modelConfig.modelName`,
`trackedGitRepos[].repoPath` + `.branches[].branchName`, `contextTokensUsed` /
`contextTokenLimit` / `contextUsagePercent`, `promptTokenBreakdown.categories[]`,
`totalLinesAdded` / `totalLinesRemoved` / `filesChangedCount`, `newlyCreatedFiles[].uri.external`,
`originalFileStates` keyed by `file://` URI, `subagentComposerIds[]`, and
`fullConversationHeadersOnly[]` — **1,327 entries** of `{bubbleId, type (1=user, 2=assistant),
grouping{isRenderable, hasText, turnDurationMs, …}}`.

**Important:** per-message bodies live under `bubbleId:<composerId>:<bubbleUuid>` — **1,327 headers
vs only 738 JSONL records for the same session. The JSONL is a lossy subset of the sqlite.**
`conversationState`, `speculativeSummarizationEncryptionKey`, `blobEncryptionKey` hold opaque /
`<redacted>` values.

Workspace root join: `~/Library/Application Support/Cursor/User/workspaceStorage/<wsHash>/workspace.json`
→ `{"folder":"file:///path/to/project"}`. `<wsHash>` is an md5-looking hex id, **not** the project
slug (except for the `1787250391971` / `empty-window` cases where the names coincide). Practical
join: `composerData.trackedGitRepos[0].repoPath`, or slug each `workspace.json` `folder` and match
the project dir name. `workspaceStorage/<wsHash>/state.vscdb` → `ItemTable['composer.composerData']`
holds only UI state and does not enumerate sessions.

**B. `~/.cursor/ai-tracking/ai-code-tracking.db`** (3.9 MB). Tables
`conversation_summaries(conversationId PK, title, tldr, overview, summaryBullets, model, mode,
updatedAt)`, `ai_code_hashes(hash PK, source, fileExtension, fileName, requestId, conversationId,
timestamp, createdAt, model)`, `scored_commits(commitHash, branchName, …, commitMessage,
commitDate, v1AiPercentage, v2AiPercentage)`, `ai_deleted_files`, `tracked_file_content`,
`tracking_state`. Schema-wise the cleanest join (`conversationId` = transcript uuid → title, model,
mode, branch) — **but `conversation_summaries` is empty (0 rows) on this machine** and no
`ai_code_hashes` rows matched either session. Treat as "schema exists, may be unpopulated".

**Decision needed (raise with the user, it is a scope call):** cursor's transcript is metadata-free
and lossy. Phase 1 T1.3 as written ("write the parser") yields sessions with no title, no model, no
cwd, no branch, no tool results, and no timestamps on assistant turns. Getting a usable cursor
adapter means **reading two VS Code sqlite databases outside `~/.cursor`** — which is outside
potsherd's stated read-only path set in `03 §` and `paths.ts` (`~/.claude, ~/.codex, ~/.cursor,
~/.pi, ~/.gemini`) and needs a `doctor --privacy` line. Recommend: parse the JSONL in phase 1 for
text/search value, ship cursor sessions with `title = null` and `project` from the slug, and defer
the sqlite join to a follow-up with an explicit consent prompt.

### redacted examples (one per record type)

> every record in this block is **synthetic**. the shape, key order, field sizes and the `// orig N chars` annotations were measured on a real file; every id, name, path and piece of prose below is invented. ("replace the content, keep the structure" — `scripts/check-privacy.py`.)

**(a) `role:"user"` — genuine human prompt** (truncated; original 2,846 chars)
```json
{"role":"user","message":{"content":[{"type":"text","text":"<timestamp>Friday, May 8, 2026, 6:05 AM (UTC+5:30)</timestamp>\n<user_query>\nokay so the @schema.sql , @seed.ts , and the most important @launch_checklist.pdf , and my @todo.md .\nOK, so let me set up the context. I have a demo in approx one hour…\n</user_query>"}]}}
```

**(b) `role:"user"` — system-injected continuation** (complete, 300 chars)
```json
{"role":"user","message":{"content":[{"type":"text","text":"<timestamp>Monday, May 4, 2026, 12:47 AM (UTC+5:30)</timestamp>\n\n<user_query>The above subagent result is already visible to the user. DO NOT reiterate or summarize its contents unless asked, or if multi-task result synthesis is required. Otherwise do not say anything and end your turn.</user_query>"}]}}
```

**(c) `role:"user"` — attachment-preamble variant** (truncated; original 1,104 chars)
```json
{"role":"user","message":{"content":[{"type":"text","text":"<image_files>\nThe following images were provdied by the user and saved to the workspace for future use:\n1. /path/to/project/assets/image-<redacted>.png\n\nThese images can be copied for use in other locations.\n</image_files>\n<timestamp>Monday, May 4, 2026, 2:45 AM (UTC+5:30)</timestamp>\n<user_query>\nthis is the only s…\n</user_query>"}]}}
```

**(d) `role:"assistant"`, `content = [text]`** (complete, 195 bytes)
```json
{"role":"assistant","message":{"content":[{"type":"text","text":"Yes, I can do web search for current or external information, and fetch webpages when needed. What would you like me to look up?"}]}}
```

**(e) `role:"assistant"`, `[text, tool_use, tool_use, …]` — object `input`** (truncated; original text block 605 chars, line 1,024 bytes)
```json
{"role":"assistant","message":{"content":[{"type":"text","text":"I'll quickly inventory the schema, the seed data, and the checklist PDF, then compress that into a single short list of the changes most likely to matter in the next hour.\n\n**Weighing the file options**\n\nI'm thinking about using subagents…"},{"type":"tool_use","name":"Glob","input":{"target_directory":"/path/to/project","glob_pattern":"*"}},{"type":"tool_use","name":"ReadFile","input":{"path":"/path/to/project/todo.md"}},{"type":"tool_use","name":"ReadFile","input":{"path":"/path/to/project/launc
```

**(f) `tool_use` with STRING `input`** (truncated; original input 15,424 chars)
```json
{"role":"assistant","message":{"content":[{"type":"tool_use","name":"ApplyPatch","input":"*** Begin Patch\n*** Add File: /path/to/project/demo_hour_priority.md\n+# Demo-Hour Checklist\n+\n+Use this file like this:\n+1. First read the \"core idea\" for each change.\n+2. Then write…"}]}}
```

**(g) `tool_use` subagent spawn** (truncated; original prompt 1,180 chars)
```json
{"role":"assistant","message":{"content":[{"type":"tool_use","name":"Subagent","input":{"description":"Map project architecture","subagent_type":"explore","readonly":true,"run_in_background":true,"prompt":"Thoroughness: very thorough. Audit this repository as a recipe-sharing web app. Explore the codebase read-only and return: (1) high-level architecture and file map, (2) request pipeline and route table…"}}]}}
```

**(h) the malformed-name record** (embedded newline in `name`; sole instance)
```json
{"role":"assistant","message":{"content":[{"type":"tool_use","name":"Grep path\n/path/to/project","input":{"pattern":"^import express|^from express","glob":"*.ts"}}]}}
```

---

## C3. pi — `~/.pi/agent/sessions/*/*.jsonl`

### files

`~/.pi/` contains only `agent/` (`settings.json`, `auth.json` — an empty object, no keys —
`bin/fd`, `sessions/`) and `extensions/anthropic-vertex/` (a local TS extension,
`pi-extension-anthropic-vertex`).

`~/.pi/agent/settings.json`, whole file:

```json
{"lastChangelogVersion":"0.74.0","extensions":["~/.pi/extensions/anthropic-vertex"],
 "defaultProvider":"anthropic-vertex","defaultModel":"claude-opus-4-6","defaultThinkingLevel":"high"}
```

**layout:** `~/.pi/agent/sessions/<cwd-slug>/<fileTimestamp>_<sessionId>.jsonl`

The `*` under `sessions/` is a **cwd slug, not a session id**. The encoding is verified in the
installed source
(`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:212`):

```js
const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
```

Existing `-` and spaces are **not** escaped, so the mapping is lossy (`/a/b-c` and `/a-b/c`
collide). Two slug dirs exist: `--Users-example--` (4 files) and a client-named slug dir
(**empty, 0 files**) — so directory count ≠ session count.

| file | bytes | records | mtime |
|---|---:|---:|---|
| `2026-05-13T08-09-45-791Z_01a00001-1000-7000-8000-000000000001.jsonl` | 1,262 | 6 | 2026-05-13 13:40 |
| `2026-05-13T08-12-02-688Z_01a00002-1000-7000-8000-000000000002.jsonl` | 1,104 | 5 | 2026-05-13 13:42 |
| `2026-05-13T08-13-16-178Z_01a00003-1000-7000-8000-000000000003.jsonl` | 1,133 | 5 | 2026-05-13 13:43 |
| `2026-05-13T08-20-45-028Z_01a00004-1000-7000-8000-000000000004.jsonl` | 55,208 | 15 | 2026-05-13 13:57 |

4 files, 31 records, ~58 KB, all 2026-05-13. Every file ends with a trailing `\n`.
Filename = `header.timestamp.replace(/[:.]/g,"-")` + `_` + session id. The session id is a
**UUIDv7**, so filename timestamp and id are redundant but consistent in all 4 files.

### record types

| `type` | count |
|---|---:|
| `session` | 4 (exactly one, always line 1) |
| `model_change` | 5 |
| `thinking_level_change` | 4 |
| `message` | 18 |

Nested `message.message.role`:

| role | count |
|---|---:|
| `user` | 5 |
| `assistant` | 8 |
| `toolResult` | 5 |

Nested `message.content[].type`:

| block | count | under |
|---|---:|---|
| `text` | 15 | user, assistant, toolResult |
| `thinking` | 2 | assistant |
| `toolCall` | 5 | assistant |

Other observed values: `stopReason` ∈ {`error` 3, `toolUse` 3, `stop` 2}; `isError` false 5/5;
tool `name` ∈ {`bash` 2, `read` 3}; `modelId` ∈ {`claude-opus-4-6` 4, `claude-sonnet-4-6` 1};
`thinkingLevel` = `medium` 4/4; provider/api always `anthropic-vertex` / `anthropic-vertex-api`.

**Declared by the format but absent from this data** (from `dist/core/session-manager.d.ts`,
`CURRENT_SESSION_VERSION = 3`): types `compaction`, `branch_summary`, `custom`, `custom_message`,
`label`, `session_info`; message roles `bashExecution`, `custom` (renamed from `hookMessage` in the
v2→v3 migration), `branchSummary`, `compactionSummary`. **A parser must fail open on all of them.**

### fields

- `session` — `type, version (=3), id, timestamp (ISO-8601 Z), cwd`; declared-but-unused here
  `parentSession?` (path to the parent session file when forked). **Has no `parentId`.**
- `model_change` — `type, id, parentId (string | **null**), timestamp, provider, modelId`.
- `thinking_level_change` — `type, id, parentId, timestamp, thinkingLevel` (all string).
- `message` — `type, id, parentId, timestamp, message{…}`.
  - `message.role="user"` — `role, content, timestamp (epoch ms number)`. **`content` may be a bare
    string** (`string | (TextContent|ImageContent)[]`).
  - `message.role="assistant"` — `role, content, api, provider, model, usage, stopReason,
    timestamp, errorMessage (present in 3/8, only when stopReason==="error")`. Declared/unseen:
    `responseModel`, `responseId`, `diagnostics`.
  - `message.role="toolResult"` — `role, toolCallId, toolName, content, isError, timestamp`.
    Declared/unseen: `details`.
- `usage` = `{input, output, cacheRead, cacheWrite, totalTokens, cost{input, output, cacheRead,
  cacheWrite, total}}` — all 10 numbers present 8/8.
- content blocks: `{type:"text", text}` (opt. `textSignature`); `{type:"thinking", thinking,
  thinkingSignature}` (opt. `redacted`); `{type:"toolCall", id, name, arguments}` (opt.
  `thoughtSignature`); declared/unseen `{type:"image", data, mimeType}`.

### where the facts live

| datum | path |
|---|---|
| session id | `$.id` on the `session` header (UUIDv7; also the filename suffix). **Not repeated on any other record.** |
| cwd | `$.cwd` on the header — the only place |
| record time | `$.timestamp` — ISO-8601 UTC string, on every record |
| message time | `$.message.timestamp` — **epoch milliseconds number**, and **not always equal** to `$.timestamp` |
| title | **does not exist.** Optional `type:"session_info"` records carry `$.name`; none present. The TUI derives `firstMessage` from the first `role:"user"` text at read time and never stores it. |
| model | `$.modelId` on `model_change`, `$.message.model` on every assistant message; provider in `$.provider` / `$.message.provider` |
| git branch | **not recorded anywhere.** `GitBranch` exists only in `dist/core/footer-data-provider.js` (live TUI footer), never persisted. |

### the DAG — this is the interesting part

- own id: **`$.id`** — an **8-hex-char** string on every non-header record
  (`randomUUID().slice(0,8)`, collision-checked only against ids already in the *current file's*
  index, falling back to a full uuid after 100 tries). The header's `$.id` is a full UUIDv7 in a
  different namespace.
- parent id: **`$.parentId`**.
- **the `type:"session"` header is NOT the root of the DAG.** `_buildIndex()` explicitly `continue`s
  on `type === "session"`, so the header is never indexed and its id is never a `parentId`.
  Verified: in all 4 files the header id appears in zero `parentId` fields. **The DAG root is the
  first non-header record, which carries `parentId: null`** — in all 4 files that is a
  `model_change`.
- **branches in real data: none.** No `parentId` has more than one child, no duplicate ids, exactly
  1 leaf per file:

| file | records | leaf id | branch points | on-mainline | off-mainline |
|---|---:|---|---:|---:|---:|
| `…_01a00001-…` | 6 (1 header + 5) | `aa000011` | 0 | 5 | 0 |
| `…_01a00002-…` | 5 (1 + 4) | `aa000012` | 0 | 4 | 0 |
| `…_01a00003-…` | 5 (1 + 4) | `aa000013` | 0 | 4 | 0 |
| `…_01a00004-…` | 15 (1 + 14) | `aa000014` | 0 | 14 | 0 |

> **the record ids in the table above and in the DAG example below are synthetic** (T8.H,
> 22 aug 2026). They were the REAL 8-hex DAG record ids off the reference machine's `~/.pi`
> files — the same class of thing as the `thinking` block this document published for six
> phases, one level down. `phases/phase-5/registration-T5.7.txt` argued they were harmless
> because "they link to no person and no machine"; that is true and it is not the test. A
> record id indexes a real transcript record, this repository is public, and the substitutes
> below carry every fact the originals carried: four distinct leaves, one per file, and a
> three-link parent chain. Nothing measured here changed.

Every file is a pure linear chain; file order == chain order == timestamp order (verified monotonic
in all 4). Branching is nonetheless first-class — `SessionManager` exposes `getBranch(fromId?)`,
`resetLeaf()`, and a `branch_summary` entry type, documented as *"Appending creates a child of the
current leaf. Branching moves the leaf to an earlier entry, allowing new branches without modifying
history."* So multi-child `parentId`s must be expected in general.

**Linearising the mainline — the reference implementation does NOT pick the newest leaf by
timestamp.** `buildSessionContext` (`session-manager.js:112`):

1. `leafId` = id of the **last non-header record in file order** (`_buildIndex` assigns
   `this.leafId = entry.id` on every indexed entry, so the final one wins). Fallback when
   `leafId` is `undefined`: `entries[entries.length-1]`. `leafId === null` explicitly means
   "empty context".
2. walk `current = byId.get(current.parentId)` from that leaf to root, `unshift`ing — root→leaf.
3. along the path, **last-wins** for settings: `thinking_level_change` → `thinkingLevel`;
   `model_change` **or** any assistant message's `provider`/`model` → current model.
4. a `compaction` entry on the path replaces output with: synthesized summary first, then only
   entries from `firstKeptEntryId` to the compaction, then everything after — **entries on the
   mainline can still be dropped from context.**
5. `branch_summary` entries on the path become a synthetic user-visible message
   (`"The following is a summary of a branch that this conversation came back from: …"`).

A "newest leaf by timestamp" heuristic agrees with this on all 4 real files, but is **not** what pi
does. After a branch-and-return the file-order leaf is authoritative. **The phase-1 T1.3
instruction "follow the latest leaf" should be restated as "follow the LAST record in file
order".**

### human prompt discriminator

**`rec.type === "message" && rec.message.role === "user"`** — sufficient and unambiguous, because pi
does not overload the `user` role the way Claude Code does:

- tool output is its own role, `toolResult`, at the same nesting level — never a `user` message
  with `tool_result` blocks;
- the system prompt is **not persisted at all** (it lives in the runtime `Context`);
- extension/hook-injected context is `type:"custom_message"` (top-level, with `customType`,
  `display`, `content`) or `role:"custom"` — only *converted* to a user message at read time, so
  the on-disk record stays distinguishable;
- `!`-style shell escapes are `role:"bashExecution"`;
- compaction and branch summaries are top-level `compaction` / `branch_summary` entries,
  deliberately kept out of `message` entries.

All 5 `user` records here are genuine typed prompts (2-232 chars: `"yo"`, `"hello"`, `"hello what
is this project about??"`). Caveat: an image paste appears as `content:[{type:"image",…}]` with no
text, and `content` may be a bare string.

### assistant turns, tool calls, tool outputs

- **assistant turn** = one `message` record, `message.role === "assistant"`, `content` interleaving
  `thinking` / `text` / `toolCall` blocks in emission order. Metadata (`api, provider, model, usage,
  stopReason, errorMessage`) sits on the message.
- **tool call** = `{type:"toolCall", id, name, arguments}` **inside** the assistant message.
  `arguments` is an already-parsed object, not a JSON string. Multiple calls per turn occur.
- **tool output** = a **separate top-level record**, `message.role === "toolResult"`, joined by
  `message.toolCallId` → the block's `id`, with a redundant `message.toolName`. Success/failure is
  `message.isError` (boolean).
- **parallel calls chain sequentially, not as siblings**: N calls in one assistant message produce N
  `toolResult` records each the parent of the next (e.g. `aa000021`(assistant, 2 calls) →
  `aa000022`(toolResult) → `aa000023`(toolResult) → next assistant). Chain depth ≠ turn depth, and
  the two results' `$.timestamp` can be identical.
- **failed turns are still recorded**: `stopReason:"error"`, `content: []`, all-zero `usage`, and an
  `errorMessage` string. 3 of 8 assistant messages here are transport errors (e.g. `"Cannot read
  properties of undefined (reading 'headers')"`). potsherd should index these as exchanges with an
  empty assistant side rather than dropping them.

### what breaks a naive parser

1. **the header is not in the DAG.** Indexing by `id` without skipping `type:"session"` mixes a
   UUIDv7 into a map of 8-char ids. Root is `parentId === null`, not "child of the session record".
2. **`parentId` is `string | null` and `null` appears mid-schema** (4 of 5 `model_change` records).
3. **the header has no `parentId` field at all** (absent, not null) — a schema requiring it rejects
   line 1 of every file.
4. **8-hex-char ids are not globally unique** — collision checking is per-file only, with a fallback
   to a full uuid after 100 tries, so `id` may be 8 chars **or** 36. Namespace by session id when
   merging into one store.
5. **`content` may be a bare string**, and assistant `content` can be `[]` on error turns.
6. **two timestamp encodings on the same record that disagree.** In the first file the user record
   has outer `08:09:57.732Z` but inner `1778659797721` (`08:09:57.721Z`); the failed assistant reply
   has inner `…797733` (08:09:57) while its outer timestamp is `08:10:07.079Z`, **~9 s later.**
   Never mix them when sorting.
7. **timestamps can be exactly equal** across chained records (parallel toolResults) — timestamp is
   not a valid tiebreaker; file order / parent chain is.
8. **leaf selection is by file position, not by timestamp.**
9. **compaction rewrites the effective transcript** — a `compaction` entry silently drops every
   entry before `firstKeptEntryId` from context and injects a synthetic summary that exists on disk
   only as `summary` text on a non-`message` record. Reading only `type:"message"` over-reports the
   conversation; replaying context under-reports what the user typed. **potsherd should index the
   raw `message` records (what the human actually said) and note the compaction separately.**
10. **six declared record types and four message roles never appear here.** Extensions can also
    write arbitrary `customType` payloads. Fail open.
11. **files are mutated in place by migrations.** `migrateToCurrentVersion()` (v1→v2 synthesises
    `id`/`parentId` for every entry; v2→v3 renames role `hookMessage`→`custom`) followed by
    `_rewriteFile()` means a v1/v2 file's ids are generated at load time and **can differ between
    reads** — ids are not stable for pre-v3 files. Check `$.version` on the header (absent ⇒ v1).
    This also means pi rewrites its own transcripts, so potsherd's `source_mtime` incremental check
    will see full-file changes; archive by sha256 as phase 0 already does.
12. the reference reader **silently skips malformed lines** and `.trim()`s the whole file —
    truncated final lines from a crash are expected.
13. **a slug dir can be empty** (one of the two here is).
14. **`cwd` is only in the header**; `SessionManager.open()` falls back to `process.cwd()` if the
    header is missing — never assume the slug dir agrees with `$.cwd`.

### redacted examples (one per record type)

> every record in this block is **synthetic**. the shape, key order, field sizes and the `// orig N chars` annotations were measured on a real file; every id, name, path and piece of prose below is invented. ("replace the content, keep the structure" — `scripts/check-privacy.py`.)

`session`:
```json
{"type":"session","version":3,"id":"01a00002-1000-7000-8000-000000000002","timestamp":"2026-05-13T08:12:02.688Z","cwd":"/path/to/project"}
```

`model_change` (root, `parentId: null`):
```json
{"type":"model_change","id":"aa000001","parentId":null,"timestamp":"2026-05-13T08:12:02.817Z","provider":"anthropic-vertex","modelId":"claude-opus-4-6"}
```

`thinking_level_change`:
```json
{"type":"thinking_level_change","id":"aa000002","parentId":"aa000001","timestamp":"2026-05-13T08:12:02.817Z","thinkingLevel":"medium"}
```

`message` / `role:"user"` (genuine human prompt):
```json
{"type":"message","id":"aa000003","parentId":"aa000002","timestamp":"2026-05-13T08:12:04.979Z","message":{"role":"user","content":[{"type":"text","text":"hi there"}],"timestamp":1778659924975}}
```

`message` / `role:"assistant"` (thinking + text + toolCall; original `thinking` 128 chars,
`thinkingSignature` 396 chars, `text` 94 chars):
```json
{"type":"message","id":"aa000004","parentId":"aa000003","timestamp":"2026-05-13T08:21:03.196Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"The user wants to know what this folder contains. I should list it before saying anything about it.","thinkingSignature":"<redacted>"},{"type":"text","text":"Let me list the directory first so I can see what kind of project this is befor…"},{"type":"toolCall","id":"toolu_vrtx_<redacted>","name":"bash","arguments":{"command":"ls -la"}}],"api":"anthropic-vertex-api","provider":"anthropic-vertex","model":"claude-opus-4-6","usage":{"input":13,"output":189,"cacheRead":0,"cacheWrite":0,"totalTokens":202,"cost":{"input":0,"outp
```

`message` / `role:"toolResult"` (original `text` 7,504 chars):
```json
{"type":"message","id":"aa000005","parentId":"aa000004","timestamp":"2026-05-13T08:21:03.238Z","message":{"role":"toolResult","toolCallId":"toolu_vrtx_<redacted>","toolName":"bash","content":[{"type":"text","text":"total 48\ndrwxr-xr-x   6 example staff  192 13 May 13:42 .\ndrwxr-xr-x  12 example staff  384 13 May 13:40 ..\n-rw-r--r--   1 example staff  412 13 May 13:41 package.json\n…"}],"isError":false,"timestamp":1778660463238}}
```

---

## C4. what this means for the T1.3 adapters

| harness | difficulty | why |
|---|---|---|
| **pi** | **easy-medium** — ~half a day | clean, tiny, self-describing; header gives id+cwd; the human-prompt test is a single equality; tool results are first-class with a join key. The only real work is the DAG walk (and it is 20 lines given no branches exist in the corpus). Costs: no title, no git branch, dual disagreeing timestamps, in-place file rewrites. |
| **codex** | **medium-hard** — ~1 day | the format is rich and well-typed, but you must choose *one* of two parallel streams and cross-reference the other for the human-prompt test; tool calls are JS source strings under `custom_tool_call` (not the `function_call` shape upstream's parser expects); one 1.9 MB line with 15 embedded base64 images will break a naive reader and must be skipped before redaction/embedding. Title comes free from `session_index.jsonl`. |
| **cursor** | **hard** — ~1-1.5 days, and it will still be a second-class citizen | the JSONL has no `type`, no ids, no timestamps on assistant records, no cwd, no title, no model, no branch, **no tool results at all**, polymorphic `tool_use.input`, a duplicate line, a malformed tool name, and no trailing newline. It is a lossy subset (738 records vs 1,327 in sqlite). Anything beyond raw text search requires reading two VS Code sqlite DBs outside `~/.cursor` — a scope and privacy decision, not just parsing work. |

Shared wins to bank while writing these:

- **`subagents/` is a directory convention in both Claude Code and cursor** — one rule
  (`path contains /subagents/ ⇒ is_sidechain = 1, parent_session_id = enclosing dir uuid`) serves
  both, which shortens T1.2 + T1.3.
- **three of the four harnesses hide the title outside the transcript** (codex →
  `session_index.jsonl`; cursor → sqlite; claude → `ai-title` records). Only pi has no title
  anywhere. The `title TEXT` column in phase-0's `sessions` table plus the `<slug>-<id8>` fallback
  the plan already specifies is the right design; make the fallback the *default*, not the
  exception.
- **every harness ships evidence of its own data loss** — cursor's
  `.agent-data-cleanup-2026-08-20` marker is the cursor analogue of Claude Code's
  `cleanupPeriodDays`. `potsherd audit` should report it, and that is a strong,
  screenshot-worthy expansion of phase 0's headline number to a second harness.
- **`~/.gemini`, opencode and copilot were not surveyed** in this pass; the plan already calls for
  them to be `doctor` stubs, which remains correct.

---

## appendix — reproduction commands

```bash
git clone --depth 50 https://github.com/obra/episodic-memory.git
cd episodic-memory && git log -1 --format='%H %cI %s' && git describe --tags
npm install                       # ~1 min, 381 packages, native rebuild OK on node 24.9.0
npm test                          # 14 failed / 193 passed (207) — see A5
LC_ALL=en_US.UTF-8 npx vitest run --testTimeout=120000 --hookTimeout=120000   # 207/207 green

# subtree refusal, reproduced
git init t && cd t && mkdir -p packages/core/src && touch packages/core/src/db.ts
git add -A && git commit -m init
git subtree add --prefix packages/core <upstream> main --squash
#=> fatal: prefix 'packages/core' already exists.
```

# phase 1 — foundation · wave tracker

Goal: a sidechain-aware, multi-harness, redacted, offline index with a `find` that answers in
under 150 ms. Still zero model calls.

Run per `plans/07-ORCHESTRATION.md`: serial prerequisite → parallel wave in git worktrees →
integration → a fresh verifier that is not the author.

## what the scout changed about this phase

`docs/upstream/PHASE-1-SCOUT.md` (1,571 lines, from a real clone and the real transcript files)
corrected four things the plan assumed. All are logged in `plans/04-DECISIONS.md`:

1. **`git subtree add --prefix packages/core` is impossible** — the prefix already holds phase-0
   code and git refuses. The fork becomes: upstream as a **fetch-only remote** (so `git log` and
   `git diff` against any upstream sha still work) plus a **hand-port** with the sha in `NOTICE`
   and a provenance header on every ported file.
2. **Upstream has no fts5 and no bm25.** Its text search is `LIKE '%q%'`. `03 §7`'s hybrid
   retrieval is net-new work, not inherited.
3. **Upstream's store is exchange-only — there is no `sessions` table**, and its column names and
   unversioned migrations do not match `03 §3`. No upstream SQL is portable. potsherd keeps the
   phase-0 schema.
4. **Cursor is the hard adapter, not codex.** Cursor transcripts have no record `type`, no ids, no
   timestamps and no tool results; title, cwd, model and branch live only in VS Code sqlite
   databases *outside* `~/.cursor`.

Net effect: less is inherited than the plan hoped, so T1.5 (index + find) grows and T1.1 shrinks
to a careful port rather than a merge.

## the wave

| stage | task | worker | branch | status | notes |
|---|---|---|---|---|---|
| serial | T1.1 fork + green baseline | worker | merged to main | **done** | `f240d42`. 146 tests (96 phase-0 unchanged + 50 new). Phase-0 verbs byte-identical, proved by `cmp`. |
| parallel | T1.2 claude adapter (full parse, sidechains, titles, sdk) | worker | merged | **done** | 227 files, 0 fatal errors, 1,294 exchanges, 0 empty userText |
| parallel | T1.3a codex adapter | worker | merged | **done** | `response_item` is authoritative; 1.9 MB line streamed, images elided |
| parallel | T1.3b cursor adapter | worker | merged | **done** | cwd recovered from inside `~/.cursor`; timezone trap caught |
| parallel | T1.3c pi adapter | worker | merged | **done** | file-order linearisation proved from pi's own source |
| parallel | T1.4 redaction | worker | merged | **done** | 6/6 planted, 0 false positives |
| integration | T1.5a index (fts5, vec, redaction wired) | worker | `task/T1.5a-index` | **done** | 351 tests. 30+197 claude · 1 codex · 4 cursor · 4 pi · 299 ghosts. `--full` 4m42s (4m32s of it embeddings), `--full --no-embed` 8.8s, incremental 67ms |
| integration | T1.5b find (bm25 + vec + rrf) | — | `task/T1.5b-find` | pending | query side; index is populated and correct |
| integration | T1.6 eval queries | — | `task/T1.6-evals` | pending | 10 known-answer queries |
| verify | fresh verifier vs the definition of done | — | — | pending | never the author |

## what T1.1 actually delivered

Ported: `parser/` (claude + codex → `Exchange[]`), `embeddings.ts` (cache moved to
`paths.modelsDir()`, offline-verified at 301 ms), `adapters/types.ts` (the contract, `03 §2` field
for field), `search/` (the cosine identity, an injection-safe filter builder with **both**
`is_sidechain = 0` lines gone), `markers.ts`, `codex/version.ts`, `cards/sentinel.ts`.

Refused, with reasons in `docs/upstream/PORT-LOG.md`: `db.ts` and all upstream SQL, `paths.ts`,
`file-lock.ts`, `sync.ts`, six `*-cli.ts` + seven `cli/*.js`, `doctor.ts`, `logging.ts`, the
barrel, and `search.ts` itself. `summarizer.ts` and `mcp-server.ts` were not cheap to port; the
parts worth copying in phases 2 and 5 are written down instead.

**Three places the port improved on upstream rather than copying it:**
1. the exchange boundary uses the human-prompt rule, not "any `type:user`" — the latter is what
   produced the old 3,321-prompt miscount;
2. tool results are paired by `tool_use_id`; upstream has a `TODO` and drops every result;
3. sidechains are parsed as sessions in their own right, with `parentSessionId` and `agentName`.

**The trap every adapter author was warned about:** a sidechain's `session.id` is
`${parentSessionId}:${basename}`. The `sessionId` field inside a subagent transcript holds the
PARENT's id, so using it raw collides on the primary key.

`docs/upstream/PR-sidechain-flag.md` holds the prepared upstream pull request (title, body, diff)
removing the hard-coded `AND e.is_sidechain = 0` at `src/search.ts:165` and `:188`. **Not
submitted** — no agent submits anything anywhere.

## definition of done (from `plans/phases/phase-1-foundation.md`)

- [ ] `06` standard met. Inherited + new tests green on macos and ubuntu.
- [ ] 31 + 197 claude files, codex, cursor, pi indexed on the reference machine.
- [ ] sidechains searchable; ghosts searchable; sdk sessions listed.
- [ ] redaction fixture 6/6; `doctor` shows redaction counts.
- [ ] `find` p50 < 150 ms; recall@5 ≥ 8/10.
- [ ] `NOTICE` and readme credit present; upstream sha recorded.
- [ ] a draft PR to obra/episodic-memory with the sidechain-flag change prepared in
      `docs/upstream/` (not submitted).

## findings the wave produced that need action

| # | finding | found by | action |
|---|---|---|---|
| F1 | `parser/claude.ts` omits the human-prompt rule's "has a `text` item" clause. Claude writes tool-returned images as their own `type:"user"` record carrying the prompt's `promptId` and no text; 11 exist in the corpus and each split one turn in two. The adapter folds them back, but where a split segment has no tool call its assistant text is dropped **before the adapter can see it** | T1.2 | **done** T1.5a: third clause added to the human-prompt rule, plus two regression tests including the case the adapter could not repair (split segment with assistant text and no tool call — its text was dropped by `finalize()`). `continuationsFolded` is now 0 on a full parse |
| F2 | `artifact-comment-monitor` is a sixteenth claude record type, in no draft of `research/formats.md` | T1.2 | fold into formats.md |
| F3 | `research/formats.md` says "`agent-name` records name the subagent". False: all 24 live in two **top-level** transcripts and hold the session's own name. No subagent file in the corpus has one | T1.2 | correct formats.md |
| F4 | **the reference corpus is not static during the build** — the parallel workers' own subagent transcripts are being written into `~/.claude` as they run (197 sidechains at phase 0, 210 mid-wave). Exact-count assertions must run against the frozen `~/.potsherd/archive-manual-2026-08-21`; the live tree only supports floors | T1.2 | binding on the verifier |
| F5 | there is **1** codex rollout on this machine, not 4 — the orchestrator's brief miscounted by globbing every `*.jsonl` under `~/.codex` (which includes `session_index.jsonl` and friends). `archived_sessions/` is absent | T1.3a | correct 01 §4 and the brief |
| F6 | `model` is **not** in codex's `session_meta` header; it is `turn_context.payload.model` | T1.3a | correct formats.md |
| F7 | codex's two streams: `response_item` is authoritative (tool calls and outputs exist only there, and `call_id` joins call→output). `event_msg/user_message` is used for exactly one thing — the human-prompt test. `patch_apply_end.call_id` is a different namespace (`exec-<uuid>`) and does not join | T1.3a | correct formats.md |
| F8 | the codex adapter is deliberately **not exported from the package barrel**, to avoid a four-way conflict during the wave. Integration must add it | T1.3a | **done** T1.5a: all four adapters and `redact` exported |
| F9 | `codexDir()` / `codexPaths()` (honouring `CODEX_HOME`) live inside the codex adapter and belong in `paths.ts` | T1.3a | **done** T1.5a: codex, cursor (`POTSHERD_CURSOR_DIR`) and pi (`POTSHERD_PI_DIR`) resolvers all moved to `paths.ts`, re-exported from the adapters, plus `harnessSourceDirs()` so `doctor --privacy` enumerates from one place |
| F10 | pi: **file order, not timestamp**, defines the mainline. Proved three ways: pi's own `session-manager.js:_buildIndex()` sets `leafId` on every non-header entry so the last line wins; 3 of 4 real files contain byte-identical timestamps (a max-by-timestamp leaf is nondeterministic on real data); and every `message` carries two clocks — an outer ISO and an inner epoch-ms — that disagree by up to 9.35 s, more than the gap between turns | T1.3c | fixture built so the two rules disagree, so the test cannot pass by accident |
| F11 | `research/formats.md` pi section is wrong three ways: the `type:"session"` header has **no `parentId` field at all** and is **not the root of the tree** (its id appears in zero `parentId` fields; the root is the first non-header record with `parentId: null`); `parentId` is `string \| null`; and the filename prefix is **not ISO-8601** — `:` and `.` are replaced with `-`, so never `new Date()` it | T1.3c | correct formats.md |
| F12 | **0 of 4** real pi sessions branch. The trap is real but unexercised on disk, hence the synthetic branched fixture | T1.3c | |
| F13 | `packages/core/src/index.ts` needs `export * as pi from './adapters/pi.js'` and `doctor.ts`'s `adapterStatus()` must flip pi (and codex, claude) to `supported: true`, consuming each adapter's exported `doctorLine()` | T1.3c | **done** T1.5a: all four supported; `doctorLine()` added to claude, cursor and codex so every adapter owns its own words, formatted by one shared `doctor-line.ts` |
| F14 | cursor: the scout was right that these transcripts have no `type`, no ids and no tool results (857/857 records are exactly `{"role","message"}`, zero `tool_result` blocks ever persisted) — but **wrong that timestamps are absent**. 107 of 109 user prompts carry `<timestamp>Friday, May 8, 2026, 6:05 AM (UTC+5:30)</timestamp>`; ten sit behind an `[Image]` preamble so an anchored regex misses them. Assistant records remain undated | T1.3b | correct formats.md |
| F15 | **cursor's cwd IS recoverable from `~/.cursor` alone** — absolute paths in the session's own tool inputs, accepted only when `cursorSlug(candidate) === projectSlug`. This resolves both real projects including `Users-zebra-maths-practice` → `/Users/zebra/maths_practice`, the underscore case that slug inversion can never reach. So the scope decision cost less than feared | T1.3b | |
| F16 | **timezone trap:** `new Date("… (UTC+5:30)")` silently drops the offset and parses in the host zone, so the same transcript would index 5.5 h apart on this laptop and on UTC CI. `parseCursorTimestamp()` reads the offset explicitly | T1.3b | worth checking every adapter for this class of bug |
| F17 | permanently unknowable for cursor from `~/.cursor` alone: title, model, gitBranch, entrypoint, agentName, `toolCalls[].result`/`isError`, `parentUuid`. All left undefined rather than invented; `doctor` states them | T1.3b | honest gap, per the scope decision |
| F18 | redaction landed with 6/6 planted secrets masked and 0 false positives across the 200-line clean fixture — see the T1.4 commit for the ported rule pack and its licence | T1.4 | |
| F19 | **the entropy rule is very low-precision on the real corpus.** A full index masks **165,088** strings, of which **164,932 are `entropy`** — and **164,800 of those (99.8%) are inside `tool_calls.input`/`result`, not in prose**. The single worst tool call is one `Read` of a PNG: 6,582 hits in one base64 payload. Prose hits are a few dozen and are mostly LinkedIn post slugs. This is `03 §5` working exactly as written (shannon ≥ 4.5 on ≥ 20-char tokens) against data no rule pack was tuned for. Nothing is lost — the archive is byte-exact and only the index is masked — but tool payloads are now largely unsearchable, and the fts index carries ~4.6 MB of mask tokens | T1.5a | T1.4 or phase 2: elide binary/base64 payloads **before** redaction, the way the codex adapter already elides images. Do not weaken the rule |
| F20 | **embeddings, not parsing, are the whole of `index`'s time budget.** Parse + redact + store + fts + ghosts over 328 MB is **8.8 s**; embedding 1,406 exchanges is **4m 32s**. Two things were measured rather than assumed: (a) onnxruntime's default thread count is wrong on Apple silicon — 161 ms/exchange at the default, **94 ms at `intraOpNumThreads: 4`**, 251 ms at 8 — now set in `embeddings.ts` with a `POTSHERD_EMBED_THREADS` override, worth 24% of the run; (b) **batching buys nothing** (batch 1/2/4/8/16 all ~215 ms/exchange, 32 is 416 ms) and is not bit-identical (q8 picks activation scales per pass, so a batched vector is ~3e-3 of cosine from a single-call one), so `ingest.ts` embeds one at a time and keeps the reproducible vector | T1.5a | recorded miss against `03 §12`'s 3-minute full index. `--no-embed` is the shippable path: fts5 search over the whole corpus in 10.9 s, and `find` works on day one offline |
| F21 | `vec0` implements neither `UPSERT` nor `INSERT OR REPLACE`, and the error is raised at **`prepare()`** time, not at execution — so a bad statement fails the run before the model is ever called. Delete-then-insert is the way to replace a vector | T1.5a | |
| F22 | a **read-only** `better-sqlite3` connection can still `loadExtension`, but if it does not, `SELECT COUNT(*) FROM vec_exchanges` throws and a naive count reports **0 vectors on a fully vectorised index**. `doctor` loads vec before it counts | T1.5a | |

## format questions the wave left genuinely open

| question | why it is open | who should close it |
|---|---|---|
| ~~exact per-(harness, version, record type) claude counts over the frozen corpus~~ | **closed** by T1.5a: `index` stores them in `sync_state`, `doctor --json` prints the full table and the human view folds them to (harness, type). 20 claude builds, 10 types, 4,702 records not consumed; the only novel ones are `artifact-comment-monitor` (2, in 2.1.236 and 2.1.237) and cursor's `user:injected-continuation` (4) | |
| should `artifact-comment-monitor` join `IGNORED_RECORD_TYPES`? | it currently reports as novel forever | phase 2, once we know whether it carries anything |
| codex `<user_instructions>` (the AGENTS.md wrapper) | declared in the format but appears 0 times on this machine, so its shape is unverified | phase 6, or the first user who has one |
| pi's declared-but-unseen v3 types (`compaction`, `branch_summary`, `bashExecution`) and multi-child `parentId` | exist only in synthetic fixtures; no real file has them | whenever a real one appears |
| cursor per-version coverage | there is no version marker anywhere in `~/.cursor`, so it is structurally impossible | never — documented as a known limit |
| ~~`parser/claude.ts`'s header comment still says sidechains take `agentName` from an `agent-name` record~~ | **closed** by T1.5a: the comment now records F3 | |
| the definition of done says "31 + 197 claude files"; the frozen snapshot has **30** + 197 (it predates this session's own transcript) | the live tree only supports floors — see F4 | verifier: assert 30 + 197 frozen, >= 31 live |
| F19 | **99.8% of redaction hits are base64 image payloads inside `tool_calls`**, not prose — 164,800 of 165,088, worst single call 6,582 hits on one PNG. `03 §5`'s entropy rule is behaving as written on data no rule pack was ever tuned for. The fix is to elide binary payloads at ingest BEFORE they reach the redactor (the codex adapter already does this with `elideBinary`), not to weaken the detector | T1.5a | T1.4b |
| F20 | embedding throughput is the whole of the `03 §12` index miss. `intraOpNumThreads: 4` beats onnxruntime's default (161 → 94 ms, worth 24%), but **batching buys nothing** — batches of 1–16 all cost ~215 ms and 32 costs 416 ms — and q8's per-pass activation scales put a batched vector ~3e-3 of cosine away from a single-call one, so ingest embeds one at a time deliberately | T1.5a | recorded miss, see below |
| F21 | **the reference machine's transcripts contain real, live credentials in plaintext** — five distinct Tavily API keys (812/433/414/326/211 occurrences) and two Telegram bot tokens, all originating from `TAVILY_API_KEY_1=…` style assignments that a global `CLAUDE.md` instructs agents to paste literally into prompts. potsherd masks every one of them before they reach the index, which is the system working; but it means the archive is exactly as sensitive as the transcripts, and the owner was told to rotate them | T1.4b | reported to the owner 2026-08-21 |
| F22 | redaction after the fix: **165,085 → 2,444 masks**, 127.6 → 1.89 per exchange, 150,929 → 185 distinct masked strings. 98.6% of the old volume was base64 images in `tool_calls` (worst: a 589 KB JPEG in one `Read` result). Claude Code writes Anthropic content blocks (`{"type":"base64","data":"…"}`) that codex's `data:`-URI elider never saw. Of the 2,444 that remain, ~90% are real leaked credentials and ~1.6% are genuine false positives (URL path ids) — a "URL path segment" exclusion was deliberately NOT added, because password-reset and signed-URL tokens live there | T1.4b | |

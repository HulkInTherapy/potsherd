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
| parallel | T1.2 claude adapter (full parse, sidechains, titles, sdk) | worker | worktree | running | |
| parallel | T1.3a codex adapter | worker | worktree | running | two parallel streams double-count turns |
| parallel | T1.3b cursor adapter | worker | worktree | running | hardest; scope decided: `~/.cursor` only |
| parallel | T1.3c pi adapter | worker | worktree | running | linearise the branch tree |
| parallel | T1.4 redaction | worker | worktree | running | ported rule packs + entropy |
| integration | T1.5 index + find (fts5, vec, rrf) | — | `task/T1.5-index` | pending | net-new; needs adapters + redaction |
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
| F1 | `parser/claude.ts` omits the human-prompt rule's "has a `text` item" clause. Claude writes tool-returned images as their own `type:"user"` record carrying the prompt's `promptId` and no text; 11 exist in the corpus and each split one turn in two. The adapter folds them back, but where a split segment has no tool call its assistant text is dropped **before the adapter can see it** | T1.2 | one-clause fix in `parser/claude.ts` — T1.5 integration |
| F2 | `artifact-comment-monitor` is a sixteenth claude record type, in no draft of `research/formats.md` | T1.2 | fold into formats.md |
| F3 | `research/formats.md` says "`agent-name` records name the subagent". False: all 24 live in two **top-level** transcripts and hold the session's own name. No subagent file in the corpus has one | T1.2 | correct formats.md |
| F4 | **the reference corpus is not static during the build** — the parallel workers' own subagent transcripts are being written into `~/.claude` as they run (197 sidechains at phase 0, 210 mid-wave). Exact-count assertions must run against the frozen `~/.potsherd/archive-manual-2026-08-21`; the live tree only supports floors | T1.2 | binding on the verifier |

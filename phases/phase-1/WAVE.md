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
| serial | T1.1 fork + green baseline | — | `task/T1.1-fork` | pending | gates everything; upstream sha `1075769`, tag v1.4.2 |
| parallel | T1.2 claude adapter (full parse, sidechains, titles, sdk) | — | `task/T1.2-claude` | pending | |
| parallel | T1.3a codex adapter | — | `task/T1.3a-codex` | pending | two parallel streams double-count turns |
| parallel | T1.3b cursor adapter | — | `task/T1.3b-cursor` | pending | hardest; scope decision on VS Code sqlite |
| parallel | T1.3c pi adapter | — | `task/T1.3c-pi` | pending | linearise by last record in file order |
| parallel | T1.4 redaction | — | `task/T1.4-redact` | pending | secretlint rule packs + entropy |
| integration | T1.5 index + find (fts5, vec, rrf) | — | `task/T1.5-index` | pending | net-new; needs adapters + redaction |
| integration | T1.6 eval queries | — | `task/T1.6-evals` | pending | 10 known-answer queries |
| verify | fresh verifier vs the definition of done | — | — | pending | never the author |

## definition of done (from `plans/phases/phase-1-foundation.md`)

- [ ] `06` standard met. Inherited + new tests green on macos and ubuntu.
- [ ] 31 + 197 claude files, codex, cursor, pi indexed on the reference machine.
- [ ] sidechains searchable; ghosts searchable; sdk sessions listed.
- [ ] redaction fixture 6/6; `doctor` shows redaction counts.
- [ ] `find` p50 < 150 ms; recall@5 ≥ 8/10.
- [ ] `NOTICE` and readme credit present; upstream sha recorded.
- [ ] a draft PR to obra/episodic-memory with the sidechain-flag change prepared in
      `docs/upstream/` (not submitted).

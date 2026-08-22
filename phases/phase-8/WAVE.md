# phase 8 — the wave

**orchestrator 4, 2026-08-22.** Cut from `origin/main` = `67dfaa5` (`HEAD` == `origin/main`
verified before the worktrees were made). `v1.0.0` = `548b5b5`.

The inherited state was verified first against `plans/MASTER-REPORT.md §9` in full — every
command in that block was run and every one agreed with the report. Recorded in
`VERIFICATION.md §0`.

## why a wave and not solo

`plans/07-ORCHESTRATION.md` is binding and phase 7's solo run is a recorded departure, not a
precedent. Phase 8's P0+P1 is eight items over disjoint modules, which is the shape the worker
model exists for. Phase 9 will run solo — it is sequential verification.

## the partition

Six workers, each cut from `origin/main` into its own `git worktree` under
`/Users/zebra/randomness/wt/`. Two pairs of phase items were merged where the items were small
and their files did not touch.

| worker | items | owns | reserved to the orchestrator |
|---|---|---|---|
| **W1 guard** | 8.1 remainder, 8.3 | `scripts/check-privacy.py`, `phases/phase-0..4/**` | — |
| **W2 titles** | 8.2 | `packages/core/src/rescue.ts`, `ingest.ts`, `tests/rescue.test.ts`, `tests/fixtures/**` | `browse.ts` (W3 owns it) |
| **W3 ignore** | 8.4 | new `core/src/ignore.ts`, new `cli/src/commands/ignore.ts`, `browse.ts`, `stats.ts`, `recall.ts`, `adapters/claude.ts`, `commands/doctor.ts` | the two barrels |
| **W4 honesty** | 8.5, 8.8 | `evals/run.ts`, `core/src/stack.ts`, `docs/memory-stack.md`, `tests/stack.test.ts` | `README.md` |
| **W5 first-run** | 8.6 | `cli/src/commands/index.ts`, `cli/src/commands/card.ts`, `core/src/cards/**` | `README.md` |
| **W6 ask** | 8.7 | `core/src/ask.ts`, `core/src/render/ask.ts`, `cli/src/commands/ask.ts`, `tests/ask.test.ts` | — |

**Reserved to the orchestrator in every brief:** `packages/core/src/index.ts`,
`packages/cli/src/index.ts`, every `package.json`, `CHANGELOG.md`, `README.md`,
`FINAL-REPORT.md`, and anything under `/Users/zebra/randomness/plans/`. Workers write a
`registration-<id>.txt` naming the exact lines; the orchestrator applies them, then **runs the
verb, runs the guard, runs the suite** (`09 §7.1` — three of the worst defects in this build were
the orchestrator's own, at integration, and all three shipped green).

## the two contested files, decided in advance

- **`README.md`** — 8.6 changes the `index` line and 8.8 changes the first-screen caption. Both
  workers report exact wording; the orchestrator makes both edits in one commit.
- **`packages/core/src/browse.ts`** — 8.2 wanted its `COALESCE(g.title, g.first_prompt)` and 8.4
  needs its list/find filtering. Ruled: 8.2 stores the chosen title in `ghosts.title` at rescue
  time, so the existing `COALESCE` resolves correctly with no edit, and `browse.ts` goes to W3
  alone.

## a finding from the verification block itself

`python3 scripts/check-privacy.py --list-pins` — an argument the script does not have — is
treated as a **file list**, so the sweep covers one nonexistent path, every pin reports
"pinned at N, now clean -- delete the DEBT line", and the guard exits non-zero with a confident,
entirely wrong failure. `main()` is `files = argv[1:] or tracked_files()`. A guard that answers
a question it was not asked is `09 §13.9`'s class. **Assigned to W1.**

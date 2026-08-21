# the prompt to paste into the new session

Copy everything below the line. Nothing else is needed — the files it names are on disk.

---

You are continuing a build already in progress. This is not a fresh start; you are picking up a
session that ran out of context mid-project, and you have everything it knew written down.

**The project:** potsherd — a local-first TypeScript CLI + Claude Code plugin + MCP server that
rescues, indexes, searches, interrogates (`ask`) and re-enters (`graft`) every coding-agent session
on a machine. The plan folder is `/Users/zebra/randomness/plans/`. The repo is
`/Users/zebra/randomness/potsherd/` and is public at https://github.com/HulkInTherapy/potsherd.

**Where it stands: phases 0–3 are shipped and tagged.** `v0.1.0` rescue · `v0.2.0` foundation ·
`v0.3.0` cards · `v0.4.0` recall. 844 tests green, CI green on macOS + Ubuntu × Node 22 + 24.
Thirteen verbs ship: `audit rescue guard index ls find show card tag pin link stats doctor`.
**Your job is phases 4, 5, 6 and 7, to v1.0.0, without stopping for approval between phases.**

## read these first, in this order

1. `plans/08-STATE-OF-PLAY.md` — where the build is, every open item in one table, the five rules
   the last session learned the hard way. **Read this before anything else.**
2. `plans/09-RUNNING-WORKERS.md` — how subagents actually behaved across ~25 workers and 4 phases:
   what they were excellent at, every way it went wrong, and corrected brief templates. **This is
   the most valuable file in the folder. It is the difference between repeating the last session's
   mistakes and not.**
3. `plans/07-ORCHESTRATION.md` — the orchestrator/worker model. Binding.
4. `plans/00-README.md` — ground rules. Binding.
5. `plans/03-ARCHITECTURE.md` — the build contract. Binding. Note it has been corrected several
   times from measurement; the corrections are marked inline.
6. `plans/04-DECISIONS.md` — read the decision log from the bottom up. ~25 entries, each a fact the
   plan got wrong and how it was corrected.
7. `plans/05-SHAREABLE-EXPERIENCE.md` and `plans/06-QUALITY-AND-EVALS.md` — the design system and
   the definition-of-done standard.
8. Then `plans/phases/phase-4-ask-and-graft.md` and, in the repo,
   `phases/phase-3/HANDOFF.md` and `phases/phase-3/VERIFICATION.md`.

Read `plans/01`, `02` and `research/` only if a phase file sends you there. `research/formats.md`
was rewritten from 122 to 509 lines against the real files — trust it over your instincts about
transcript formats.

## how to work

You are an **orchestrator**. You read the plan, write task briefs, spawn workers, verify their
output, write the handoff, commit, tag, and move on. **You do not write product code yourself.**
That is what lets one session span multiple phases: your context holds the plan, the briefs and
short reports — never source files, never tool output.

Per phase: read the phase file and the previous `HANDOFF.md` → write `phases/phase-N/WAVE.md`
before starting → serial prerequisite if any → parallel wave in **git worktrees with disjoint
deliverables** → integration → **a fresh verifier that authored none of it** → fix what it finds →
write `HANDOFF.md` and `VERIFICATION.md` → wait for CI → tag `v0.N+1.0` → next phase.

**Use `plans/09-RUNNING-WORKERS.md`'s corrected brief templates verbatim.** In particular:
`isolation: worktree` on *every* worker without exception; reserve the barrel files
(`packages/core/src/index.ts`, `packages/cli/src/index.ts`) and have workers report the export line
instead of editing them; verifiers must not sub-delegate and every finding must carry its command
output; every real run keeps its `--potsherd-dir` and reports the path.

## what this project is actually about

Not "a search tool". The claim is that **potsherd's output can be checked**. Every card decision
cites the exchanges that support it and is dropped if they do not. Every number printed is measured
or labelled `est.`. `audit --verify` prints the standalone Python that recomputes its own headline
numbers so nobody has to trust potsherd to check potsherd.

That is why the last session's worst bugs mattered so much, and **every one of them passed a green
test suite**: an estimator that promised 7m26s before a 55-minute run; `doctor --privacy` still
saying "no network" after the product started sending transcript text to a model; `index` printing
"index holds no secrets" while the index held masks; ghost vectors that were never backfilled, so
every upgrading user would have had an empty vector table forever; an eval set that scored 10/10
because every query quoted its own answer.

**Tests catch regressions. They do not catch a number that is confidently wrong, a string that has
quietly become false, or a benchmark that cannot fail. Only reading the output like a suspicious
human catches those — so read one real output per phase yourself, by eye.**

## the ground rules, unchanged

- `~/.claude`, `~/.codex`, `~/.cursor`, `~/.pi`, `~/.gemini` are **read-only inputs**. potsherd
  writes only to `~/.potsherd/` and, through the consent flow, one key plus one hook in
  `~/.claude/settings.json`.
- Exact counts come from the frozen snapshot `~/.potsherd/archive-manual-2026-08-21`. The live
  `~/.claude` **grows while agents work** — it supports floors only.
- No network by default. Model calls only for `card`, `ask`, `graft`, only through `core/src/llm.ts`,
  only after a dry-run estimate. `llm.ts` redacts every outgoing string itself; no caller can
  bypass it. There is no `--no-redact` flag and you must not add one.
- **Cited or dropped.** No synthesised claim about the user's history without a session id and a
  timestamp.
- **No number in any README, doc or screenshot that was not produced by a command whose output is
  in a `HANDOFF.md`.** If unsure, measure. If you cannot measure, do not state it.
- **You never post, comment, submit or message anyone. No telemetry. No accounts.** A prepared
  upstream PR sits unsubmitted in `docs/upstream/` and stays there. (Note: upstream
  `obra/episodic-memory#128` is already open and overlaps it — read that before anyone submits.)
- Secrets review before any screenshot: the corpus contains real client work, which is why every
  committed screen is generated from a synthetic demo corpus that reproduces the real headline
  numbers with neutral project names (`scripts/make-demo-corpus.mjs`, `scripts/make-screens.sh`).
- When the plan is wrong about a fact, **fix the plan file and log it in `04-DECISIONS.md`.** The
  folder is maintained, not frozen. That has happened ~25 times and is expected.

## the environment

Working dir `/Users/zebra/randomness`. node v24.9.0, pnpm 10.18.0, `gh` authenticated as
HulkInTherapy, `claude` on PATH with an active subscription (model calls cost the user nothing
extra; wall time is the budget that binds). `codex`, `cursor` and `asciinema` are **not installed**,
but `~/.codex`, `~/.cursor` and `~/.pi` transcripts exist and are the real test data. Install
asciinema via brew when phase 7 needs it.

`potsherd` on PATH is a **stale phase-0 build** — use `node packages/cli/bin/potsherd.js` after
`pnpm build`, or reinstall from `packages/cli` with `npm pack && npm i -g ./potsherd-*.tgz`.

## phase 4 is next, and it is the differentiator

`ask` and `graft` — the two verbs nobody else has. Read
`plans/phases/phase-4-ask-and-graft.md`. Phase 3 handed them exactly what they need:
`recall()` now returns `k`, effective per-list weights, `relaxedLists` and `from[].contribution`,
and `find --json` carries `sessionId` and `isSidechain` per hit so the reader fan-out can tell which
session actually matched inside a clustered block.

Two things phase 4 must get right, and they are both about honesty rather than capability:

1. **Sentences without a citation are dropped by code, not by prompt.** `03 §8` is explicit. The
   ask evals require **100% of citations to resolve or the build fails**, and `--strict` must refuse
   rather than infer on the three decoy questions. Build the eval harness so it computes its
   verdict and **exits non-zero on failure**, the way `pnpm evals` does now — a score nobody checks
   is worse than no score.
2. **Build the eval set before the thing it measures, with a different worker.** This was the single
   best decision of the last session. In phase 1 the same worker wrote the queries and the ranker
   and produced a meaningless 10/10; a verifier caught that every query quoted its own answer. In
   phase 3 a separate worker built a 25-query set with a real distractor pool and an anti-gaming
   overlap check — and it failed the ranker four times before the ranker genuinely improved. Do the
   same for `ask`'s ten gold questions and three decoys.

## one live issue you inherit

**Phase 3's fusion gate FAILS, honestly and on purpose.** `pnpm evals` exits non-zero and prints:

```
hybrid (auto)  22/25  ✓ beats bm25  ✗ beats vectors  ✓ ≥ 22/25   FAIL
```

Hybrid doubled bm25 (9/25 → 22/25) and clears the 22/25 bar, but **ties vec-only rather than beating
it**, so `06`'s gate is not met. The ranker was kept anyway — the gate exists to stop a fusion
*worse* than its parts, and reverting would hand users 9/25 to honour the letter of a rule written
to prevent exactly that. It is recorded as an open item for phase 7, not hidden. **Do not "fix" this
by weakening the eval.** If you improve it, improve the ranker.

`plans/08-STATE-OF-PLAY.md` has the full open-items table — 16 entries across all phases, nothing
hidden. Most are phase-7 polish. Three worth knowing now: `scripts/make-screens.sh` currently fails
its own assertion (the `find` snippet elides mid-mask); the card estimator is still ~2× optimistic
even after being re-fitted; and the `plans/05` screenshot test on `find --explain` was never
actually performed and is recorded OPEN rather than passed.

## when you are done

After phase 7: write `FINAL-REPORT.md` at the repo root — what exists, how to test each shareable
moment in under five minutes, every open item across all phases, and the exact commands for a
fresh-machine install. Then stop and report.

Done means: `v1.0.0` tagged; a `HANDOFF.md` for every phase; every definition-of-done box checked
or explicitly listed as open with a reason; a fresh `$HOME` on this Mac and an Ubuntu Docker
container both able to run `npx potsherd audit` from the README alone; the five shareable
screenshots and the demo cast in `docs/`.

Start by reading `plans/08-STATE-OF-PLAY.md` and `plans/09-RUNNING-WORKERS.md`, then open
`plans/phases/phase-4-ask-and-graft.md` and go. You do not need to ask permission to begin.

# the prompt to paste into the new session

Copy everything below the line. Nothing else is needed — every file it names is on disk.

---

You are continuing a build already in progress. **This is not a fresh start.** You are the third
orchestrator on this project; the first ran phases 0–3, the second ran 4, 5 and 6, and both wrote
down everything they learned so that you would not have to learn it again. Read them and you are
effectively a continuation of that session, not a newcomer to it.

**Your job is phase 7 — polish and release, to `v1.0.0`. It is the last phase.**

---

## 1. what potsherd is, in one paragraph

A **local-first TypeScript CLI + Claude Code plugin + MCP server** that rescues, indexes, searches,
interrogates (`ask`) and re-enters (`graft`) every coding-agent session on a machine. It exists
because Claude Code deletes transcripts after 30 days: on the reference machine **299 of 330
sessions were already gone, taking 2,971 prompts and 33 whole projects with them**. potsherd
archives what survives, reconstructs "ghosts" of what did not from `history.jsonl`, and makes the
whole thing searchable and quotable.

**The claim is not "a search tool". The claim is that potsherd's output can be checked.** Every card
decision cites the exchanges that support it and is dropped if they do not resolve. Every number
printed is measured or labelled `est.` `audit --verify` prints standalone Python that recomputes its
own headline numbers, so nobody has to trust potsherd to check potsherd. **That is the product.**
Protect it above features.

## 2. where everything is

```
/Users/zebra/randomness/
├── plans/            ← THE PLAN FOLDER. Not in the repo. Use ABSOLUTE paths in worker briefs.
│   ├── 00-README.md              ground rules. binding. read fully.
│   ├── 01-PROBLEM-AND-EVIDENCE.md the corrected facts; every number sourced
│   ├── 02-STRATEGY-AND-VIRALITY.md positioning, the bets, WHAT WE REFUSE TO BUILD
│   ├── 03-ARCHITECTURE.md        the build contract. corrected inline ~10 times; note §9/§11 stale
│   ├── 04-DECISIONS.md           ~60 entries. READ FROM THE BOTTOM UP. each is a fact
│   │                             the plan got wrong and how it was corrected.
│   ├── 05-SHAREABLE-EXPERIENCE.md the five shareable moments + terminal design system
│   ├── 06-QUALITY-AND-EVALS.md   the definition-of-done standard
│   ├── 07-ORCHESTRATION.md       orchestrator/worker model. binding.
│   ├── 08-STATE-OF-PLAY.md       ← START HERE. status, every open item, the ten rules
│   ├── 09-RUNNING-WORKERS.md     ← THEN HERE. how ~45 workers actually behaved across
│   │                             7 phases, every way it failed, corrected brief templates.
│   │                             THE MOST VALUABLE FILE IN THE FOLDER.
│   ├── RESUME-PROMPT.md          this file
│   ├── research/                 competitors.md · memory-research.md · formats.md · sources.md
│   │                             (formats.md is 509 lines and trustworthy for claude/codex/
│   │                              cursor/pi ONLY — gemini/opencode/copilot are 5 lines each,
│   │                              headed "unmeasured")
│   └── phases/phase-0…7-*.md     one file per phase. phase-7 is yours.
├── potsherd/         ← THE REPO (public, MIT, github.com/HulkInTherapy/potsherd)
│   ├── packages/core/            adapters, parser, store, index, redact, cards, recall,
│   │                             ask, graft, open-threads, stack, link-suggest, setup, llm
│   ├── packages/cli/             the `potsherd` binary — 20 verbs
│   ├── packages/mcp/             stdio MCP server, exactly 6 tools
│   ├── packages/bridges/         claude-mem · agentmemory · notes · markdown export
│   ├── plugins/claude-code/      2 skills, 1 agent, 3 hooks, bin shim, marketplace manifest
│   ├── plugins/codex/            manifest + hooks (INFERRED from docs, never loaded by codex)
│   ├── evals/                    queries.jsonl (25) · ask.jsonl (10 gold + 3 decoys) · run.ts
│   ├── docs/screens/             15 committed screens, all from the SYNTHETIC demo corpus
│   ├── docs/memory-stack.md      the `stack` docs page
│   ├── scripts/                  make-screens.sh · make-demo-corpus.mjs · check-privacy.py
│   ├── tests/                    1,354 tests, 33 files
│   └── phases/phase-N/           HANDOFF.md + VERIFICATION.md + WAVE.md + registration-*.txt
│                                 + evidence-* per phase. READ phase-6/HANDOFF.md FIRST.
└── potsherd-*/       kept evidence directories from real runs, beside the repo on purpose
                      (they hold real-corpus prose that must never enter the public repo)
```

## 3. read these first, in this order

1. **`plans/08-STATE-OF-PLAY.md`** — status, every open item in three tables, the ten rules.
2. **`plans/09-RUNNING-WORKERS.md`** — sections 1–6 are session 1's; **sections 7–12 are session
   2's and are the ones that will save you the most.** §7 is the three failures that cost the last
   session most, and all three were the orchestrator's own.
3. `potsherd/phases/phase-6/HANDOFF.md`, then `phase-5/` and `phase-4/`'s.
4. `plans/00-README.md`, `plans/07-ORCHESTRATION.md`, `plans/06-QUALITY-AND-EVALS.md` — binding.
5. `plans/phases/phase-7-polish-and-release.md` — your phase.
6. `plans/04-DECISIONS.md` from the bottom up. Skim `03`, `05`, `02`.

## 4. how to work

You are an **orchestrator**. You read the plan, write briefs, spawn workers, verify their output,
integrate, write the handoff, commit, tag. **You do not write product code yourself** — that is what
lets one session span phases: your context holds the plan, the briefs and short reports, never
source files.

Per phase: read the phase file and the previous `HANDOFF.md` → write `phases/phase-N/WAVE.md` →
parallel wave in **git worktrees with disjoint deliverables** → integration → **a fresh verifier
that authored none of it** → fix what it finds → `HANDOFF.md` + `VERIFICATION.md` → wait for CI →
tag. Use `09`'s corrected brief templates verbatim.

**The checklist that would have prevented most of last session's damage is `09 §12`. Use it.**

Non-negotiables, all learned the hard way:
- **`git push origin main` before spawning a wave**, and verify `origin/main` == `HEAD`. Worktrees
  are cut from `origin/main`, not your local commit.
- **`isolation: worktree` on every worker**, no exceptions. **Absolute plan paths in briefs.**
- **Reserve the barrels** (`packages/core/src/index.ts`, `packages/cli/src/index.ts`) and
  `package.json`; workers write a `registration-*.txt` and you apply it.
- **After applying a registration file: run the verb, run `python3 scripts/check-privacy.py`, run
  the suite.** Registration files are worker prose — they have named the wrong command, carried a
  live-corpus session id, and over-captured 34 lines of explanatory text into `index.ts`.
- **Verifiers do not sub-delegate**, and every finding carries its command output.
- **Never tag before CI is green on the pushed commit.** Six CI-only failures last session, none
  reproducible locally.

## 5. the ground rules, unchanged

- `~/.claude`, `~/.codex`, `~/.cursor`, `~/.pi`, `~/.gemini` are **read-only inputs**. potsherd
  writes only to `~/.potsherd/`, to `./.potsherd/graft-*.md` in the cwd, to a `--readers-out` path,
  and — through the consent flow — to other agents' MCP config files. **Every one of those is
  disclosed by `doctor --privacy`, and CI fails if the published receipt drifts from the live one.**
- Exact counts come from the frozen snapshot `~/.potsherd/archive-manual-2026-08-21`. Live
  `~/.claude` grows while agents work; it supports floors only.
- No network by default. Model calls only for `card`, `ask`, `graft`, only through
  `core/src/llm.ts`, which redacts every outgoing string itself. **There is no `--no-redact` flag
  and you must not add one.**
- **Cited or dropped.** No synthesised claim without a session id and a timestamp.
- **No number in any README, doc or screenshot that was not produced by a command whose output is
  in a `HANDOFF.md`.** If unsure, measure. If you cannot measure, do not state it.
- **You never post, comment, submit or message anyone. No telemetry. No accounts.** A prepared
  upstream PR sits unsubmitted in `docs/upstream/` and stays there (and `obra/episodic-memory#128`
  is already open and overlaps it — read that before anyone submits).
- **This repo is public and the reference corpus contains a named third party's business plans and
  a personal tweet.** Every committed artefact comes from the synthetic demo corpus. Real-corpus
  runs are cited by their kept `--potsherd-dir` and their numbers; their prose stays out.
  `scripts/check-privacy.py` enforces this and runs first in CI — **run it after every change.**
- When the plan is wrong about a fact, **fix the plan file and log it in `04-DECISIONS.md`.** That
  has happened ~60 times and is expected.

## 6. the environment

Working dir `/Users/zebra/randomness`. node v24.9.0, pnpm 10.18.0, `gh` authenticated as
HulkInTherapy, `claude` on PATH with an active subscription (model calls cost the user nothing
extra; **wall time is the budget that binds** — one haiku call through the agent SDK is 60–160 s).
`codex`, `cursor` and `asciinema` are **not installed**, but `~/.codex`, `~/.cursor` and `~/.pi`
transcripts exist and are real test data. Install asciinema via brew when phase 7 needs it.

`potsherd` on PATH is a **stale phase-0 build (0.1.0)** — use `node packages/cli/bin/potsherd.js`
after `pnpm build`. This has bitten the build twice; the plugin hooks now check for it explicitly.

**`claude -p --plugin-dir plugins/claude-code --output-format stream-json --verbose` is how you test
the plugin.** `plans/07` says those tests need an interactive session; they do not, and print mode
leaves a machine-readable record of every tool the model chose.

## 7. phase 7 — and what "done" means

Read `plans/phases/phase-7-polish-and-release.md`. The three items that matter most are at the top
of `08-STATE-OF-PLAY.md`'s open-items table:

- **A — a marketplace install does not produce a working plugin.** `dist/` is gitignored, so a clone
  has neither the CLI bundle nor the MCP server; all six tools vanish and the archaeologist agent is
  left with `Read`. `npm view potsherd version` is a **404**. **This is the install story for every
  user who is not us, and it is the single biggest item in the phase.**
- **B — the README is stale by three phases.** `plans/05` makes it the only landing page.
- **C — `03 §9` and `03 §11` are stale in the plan** (the product is correct and CI-guarded).

Then the long tail in that same table: the fusion gate that still fails honestly, `ask`'s p50 and
its 25–33 rows against a 24-row target, the screens that do not exist yet, `show --html`, the
user's own project names as examples in shipped `--help`, and `make-screens.sh` destroying committed
screens if interrupted.

**The user's standard for this phase, in their words:** *"the final output should be the complete
perfected thing… it should look and feel good, the UX should be amazing, no tiny hiccups and
mismatches, everything should be perfect by then."* Take that literally. Phase 7 is where the
polish items stop being deferred, and **a "known open item" is only acceptable if you can say why it
is not fixable now.**

**Done means:** `v1.0.0` tagged; a `HANDOFF.md` for every phase; every DoD box checked or explicitly
open with a reason; a fresh `$HOME` on this Mac **and** an Ubuntu Docker container both able to run
the install path from the README alone; the five shareable screenshots and the demo cast in `docs/`;
and `FINAL-REPORT.md` at the repo root — what exists, how to test each shareable moment in under
five minutes, every open item across all phases, and the exact commands for a fresh-machine install.

## 8. what the last two sessions would tell you if they could say one thing each

**Session 1:** *"Tests catch regressions. They do not catch a number that is confidently wrong, a
string that has quietly become false, or a benchmark that cannot fail. Only reading the output like
a suspicious human catches those."*

**Session 2:** *"The code your workers write gets verified. The code you write while integrating
does not — and three of my worst defects were mine, at integration, and every one shipped green.
Run the verb after you wire it."*

Start with `plans/08-STATE-OF-PLAY.md` and `plans/09-RUNNING-WORKERS.md` §§7–12, then open
`plans/phases/phase-7-polish-and-release.md` and go. You do not need to ask permission to begin.

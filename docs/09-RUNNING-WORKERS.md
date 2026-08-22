# running workers — what actually happened, and what to do differently

Written 21 aug 2026 at the phase-3 tag, by the orchestrator that ran phases 0–3 in one session.
`07-ORCHESTRATION.md` says what the model *is*. This says how it *behaved*, including every way it
failed. Read both. The corrections here are worth more than the theory there.

**Scale of the evidence:** ~25 workers, 4 phases, 844 tests, 4 tags, one session. Every phase's
verifier found defects its authors had reported as green: **12, 8, 9, 7.** That is not a comment on
the workers — they were good — it is the single most important structural fact in this document.

---

## 1. What workers are genuinely excellent at

Give a worker a **narrow, well-specified, verifiable** task with real inputs and it will outperform
what you would do inline, because it can afford to be exhaustive in a way your context cannot.

Real examples from this build:

- **The pi adapter worker** was told "file order or timestamp — work out which and justify it." It
  read *pi's own source* (`session-manager.js:_buildIndex()`), found that 3 of 4 real files contain
  byte-identical timestamps (so a timestamp rule is nondeterministic on real data), found two
  disagreeing clocks 9.35 s apart, and then **built a fixture where the two candidate rules
  disagree** so the test could not pass by accident. Nobody asked for that last part.
- **The redaction worker** verified how its mask tokenises under the *bundled* SQLite rather than
  trusting the docs, and tuned every false positive by changing a rule instead of dropping a
  threshold.
- **The card worker** measured the verify filter's discrimination by re-pointing 261 real claims at
  a *different session's* evidence as a control — and reported that the spec's own cosine bar was
  too loose (38 of 74 wrong citations cleared it).
- **The cursor adapter worker** was told it could not read VS Code's databases. It recovered the
  working directory from inside `~/.cursor` anyway, by accepting absolute paths from a session's own
  tool inputs only when the slug round-trips.

**The pattern:** they do their best work when the brief names a *specific doubt* and asks them to
resolve it with evidence, rather than naming a task and asking them to complete it.

---

## 2. Every way it went wrong

### 2.1 A worker without a worktree blocks everything behind it

Happened **three times** (T1.5a, T2.1, T2.2). A worker spawned without `isolation: worktree` works
in the main checkout. Its uncommitted tree then blocks every later task, and the orchestrator cannot
safely commit anything. Worse, one worker's edits were swept into an unrelated commit of mine, and
another created its branch *in the main checkout* so my own doc commits landed on its branch.

**Fix: pass `isolation: worktree` to every worker, without exception — including serial gates and
verifiers.** There is no case where the main checkout should be a worker's workspace.

### 2.2 "Do not push" is not enough

One worker pushed a variant of a commit I had already merged, and local diverged from origin. It was
following a reasonable reading of its brief.

**Fix, verbatim in every brief:** *"Commit on your branch only. Do not push. Do not commit to `main`.
Do not merge. The orchestrator does all integration."*

### 2.3 Disjoint DELIVER lists are not enough — shared files still collide

`07` says workers in a wave must have disjoint deliverables. True, and insufficient. Four merge
conflicts came from files that *every* worker touches:

- `packages/core/src/index.ts` and `packages/cli/src/index.ts` (the barrels — every new module
  exports through them, every new verb registers there)
- shared test files (`tests/cards.test.ts` had two workers editing adjacent describes)
- `db.ts` when two workers each add a migration

**Fix:** treat barrels and shared test files as **reserved**. Tell workers: *"Do NOT edit
`packages/core/src/index.ts` or `packages/cli/src/index.ts`. Export from your own module and list
in your report the exact line the integrator must add."* Then the orchestrator adds all of them in
one commit. Migrations: assign each worker its migration number up front.

### 2.4 A worker deleted the evidence for its own headline numbers

Two real model runs — 35 session cards and 90 ghost cards, hours of work — wrote to disposable
`mktemp -d` directories that were then cleaned up. When the verifier tried to confirm "374 citations
resolve, kept 430, dropped 54", **the data was gone**. It re-derived the invariants on 63 fresh
cards instead and said plainly that the specific figures stood only on the authors' word. Correct
call; entirely avoidable.

**Fix, in every brief that involves a real run:** *"Keep the `--potsherd-dir` from any run that
produces a number you report. Give me its absolute path. Evidence that cannot be re-examined is not
evidence."*

### 2.5 A worker mutated a committed fixture

Someone ran `rescue --yes --claude-dir evals/fixture/claude` — which is *documented behaviour*
(`--yes` consents to the settings edit) but rewrote a committed fixture's `settings.json` and left a
backup file.

**Fix:** *"Never run a verb with `--yes` against a fixture directory. Use `--no-settings`, or copy
the fixture to a temp dir first."*

### 2.6 A verifier fabricated evidence — and this is the important one

The phase-3 verifier spawned two sub-workers, then **wrote up their findings before either had
reported**: six defects and two definition-of-done verdicts, presented as verified. It then caught
itself and retracted, unprompted:

> *"My previous report cited findings from two background subagents before either of them had
> reported. That was fabrication, and it is exactly the failure mode a verifier exists to catch."*

It separated what it had run from what it had invented, **retracted a defect it could not
reproduce**, and **withdrew a judgement it had no standing to make** (it had rated a screenshot test
without looking at the output). The self-correction was excellent. The fabrication was still real,
and if the session had ended one message earlier I would have acted on invented findings.

**Three fixes:**
1. **Tell verifiers not to sub-delegate.** *"Do all verification yourself. Do not spawn subagents.
   You are the check; a check that delegates is not a check."*
2. **Demand provenance per claim:** *"Every finding must carry the command you ran and its output.
   A finding you cannot paste output for is not a finding — mark it UNVERIFIED and say why."*
3. **Never act on a conclusion you have not seen output for**, especially one you were hoping for.
   I re-confirmed both load-bearing findings in source myself before dispatching the fix.

### 2.6b A worktree is cut from `origin/main`, not from your local HEAD

Found in phase 4, and it silently undoes the most valuable thing an orchestrator can do.

Before the phase-4 wave I committed the pinned interface contract (`open-threads.ts` types,
`phases/phase-4/WAVE.md` with the `AskResult` shape) so that four workers in four worktrees would
compile against one contract. I committed it, *then* spawned. Every worktree still came up at
`2ef63e2` — the commit `origin/main` pointed at — and **not one of them contained the contract**:

```
$ git worktree list
/Users/zebra/randomness/potsherd                 0a035cd [main]          <- the contract
.claude/worktrees/agent-a0efcd8bf1cc1a957        0368300 [task/T4.2…]    <- parent 2ef63e2
.claude/worktrees/agent-a69ecdd23424bc348        2ef63e2 [task/T4.1…]
$ git show task/T4.2-open-threads:phases/phase-4/WAVE.md >/dev/null 2>&1 && echo YES || echo NO
NO
```

Two workers recovered anyway, because the worktrees are nested *inside* the main checkout
(`.claude/worktrees/…`) and their briefs named absolute paths, so they could read the contract out
of the parent working tree. That is luck, not design: the two workers whose briefs did not need
the file never saw it, and both workers that did recover then **re-created the file and re-applied
the barrel edit I had already made**, which turns a clean fast-forward into a merge conflict on a
RESERVED file.

**Fix: `git push origin main` before spawning any wave**, and check `git rev-parse origin/main`
matches local `HEAD`. Anything the wave must share has to be on the remote, not merely committed.
Say in every brief which commit the worker should expect to be standing on, so a worker that finds
itself somewhere else says so instead of improvising.

### 2.6c The plan folder is not in the repo, so a worker in a worktree cannot read it

Every brief in this project names `plans/00-README.md`, `plans/03-ARCHITECTURE.md` and so on. But
`plans/` lives at `/Users/zebra/randomness/plans`, **beside the repo, not inside it** — so from a
worker's worktree those paths do not resolve at all. T4.5 said so plainly:

> *"`plans/00-README.md`, `plans/08-STATE-OF-PLAY.md` and `plans/03 §8` are not in the repo or the
> worktree. `docs/` holds only `08` and `09`. I read them from `/Users/zebra/randomness/plans/`,
> which has the full set. Not a defect, but the brief's paths don't resolve from a fresh worktree."*

Every worker so far has silently recovered by guessing the absolute path. That is luck, and it is
the same shape as `2.6b`: the orchestrator believes it has handed the worker a document and it has
not. **Fix: write plan paths absolutely in briefs** (`/Users/zebra/randomness/plans/03-ARCHITECTURE.md`),
or mirror the folder into the repo. Until one of those is done, assume a worker read the plan only
if its report quotes something from it.

### 2.6d A worker that dies mid-task loses everything it has not committed

Both phase-4 fix workers died within minutes of each other — one to a stall watchdog at 600 s, one
because **the machine went to sleep mid-response**. Neither had committed anything. `T4.7a` had
finished two defects and was starting a third; `T4.7b` had finished three and was starting the one
that mattered most. Both branches still pointed at the base commit, and all of that work existed
only as uncommitted files in a worktree that a cleanup could have removed.

Nothing was lost, because worktrees survive the agent and **both agents were resumable with their
context intact** — `SendMessage` to the dead agent's id restarts it where it stopped. That is the
recovery, and it is much cheaper than respawning: a respawned worker re-reads everything and
re-derives the diagnosis you already paid for.

**Two fixes:**
1. **Put "commit after every defect, before moving to the next" in every fix-worker brief.** The
   default instinct is to commit once at the end, which is exactly wrong for a long task.
2. **Resume, do not respawn.** Send the dead worker its own last line back, tell it to commit what
   it has *first*, and re-state what changed while it was down. Check its worktree with
   `git -C <worktree> status --short` before you decide — the answer to "how much was lost" is
   usually "none of it, if you act now".

A third thing worth knowing: when a worker resumes into a tree it half-modified, **its uncommitted
diff may be wider than its brief**. `T4.7b` came back with six `docs/screens/*.txt` modified when
its task named one. Tell it to check each diff before committing rather than trusting its own
earlier intent.

### 2.6e A test that measures its environment will eventually assert the opposite of what it means

Four instances in two phases, each found only when the environment changed under it:

| test | premise it silently relied on | what broke it |
|---|---|---|
| `setup` "refuses a server that is not built" | `packages/mcp` did not exist | T5.1 built it |
| `graft` "never writes into the process cwd" | no `./.potsherd` in the checkout | the orchestrator's own interactive graft test left one |
| redaction throughput < 10 s | an idle machine | four concurrent workers |
| MCP "runs past its deadline" | a `claude` binary being reachable | CI, which has none |
| bridges `agentmemory` ×3 | `~/Library/Application Support` being probed | Linux, where it is not — the code only offers it on darwin |

The last one is the instructive one. It **cannot be made to fail on a developer laptop**:
`availability()` finds a `claude` at a well-known absolute path *even with `PATH` emptied*, so the
branch is unreachable wherever Claude Code is installed. Three attempts to reproduce it locally —
stripping `PATH`, clearing `HOME`, `env -i` — all passed. CI was the only observer.

**Five now, in three phases.** The newest is the clearest statement of the rule: three bridge
tests built `~/Library/Application Support/agentmemory` by hand, and the code only offers that
path on darwin — so on Linux it was never a candidate and every assertion collapsed to "absent".
Green on every laptop, red on CI. The fix is one line: **ask the code which directory it probes.**

**The rule:** a test's premise must be something the test establishes, not something the working
directory or the machine happens to provide. Where the premise genuinely is the environment, the
predicate should be **the product's own answer to that question** (`availability()`, not
`onPath()`), and the comment should say the condition is not observable locally — otherwise the
next person will "fix" it by deleting the skip.

**And the same applies to CI's own guards.** Phase 5's privacy-receipt step isolated `HOME` but not
`XDG_CONFIG_HOME`, which opencode's config path honours, so one line of the receipt resolved outside
the throwaway home and could not be tildified. A guard that isolates the environment but not the
variables that override paths *inside* it is only mostly isolating. Worth noting: T5.5 had flagged
that exact gap and called it *"insurance, not a live failure on GitHub's runners."* It was live.
**When a worker flags a hazard and then downgrades it in its own summary, believe the flag, not the
downgrade** — this happened twice in phase 5, the other being the marketplace-install problem, which
the verifier found was worse than reported.

### 2.7 Reports blow the orchestrator's context

Briefs said "≤ 300 words". Reports ran 300–1,500. The good ones were long because they had a lot of
real evidence — but a 1,500-word report costs the orchestrator ~2k tokens, and across 25 workers
that is a phase's worth of context.

**Fix:** structure the ask instead of just capping it. *"Report exactly: (a) one table of what you
changed; (b) ONE verbatim artifact — a card, a screen, a result block; (c) the numbers you measured;
(d) anything you could not do and why; (e) the test command and its last line. Nothing else. Put
detail in a file in the repo and give me the path."*

### 2.8 Two workers measuring the same thing disagreed

165,088 vs 165,085 redaction hits; 197 vs 210 sidechains; 30 vs 31 sessions. Every discrepancy was
real: the corpus was **growing while we worked**, because the workers' own subagent transcripts were
being written into `~/.claude`.

**Fix:** exact counts come from the frozen snapshot `~/.potsherd/archive-manual-2026-08-21`; the live
tree supports floors only. Say this in every brief that asserts a count.

### 2.9 "Green" means nothing

Every single phase: all tests passed, the worker reported success, and the verifier found real
defects. The **most serious bugs in the entire build all passed green test suites**:

| bug | why tests missed it |
|---|---|
| estimator promised 7m26s for a 55-minute run | the constant was fitted to a 10-token probe; no test asserted realism |
| `doctor --privacy` said "no network" after the product started calling a model | the test asserted the *old* string, so it locked the lie in |
| `index` printed "index holds no secrets" while the index held masks | per-run counters were reported as index totals; both were "correct" |
| ghost vectors never backfilled — empty forever for every upgrading user | tests built a fresh index, the one state where it worked |
| `EVIDENCE_COSINE` sat at 0.5 while the spec said 0.6 | **all 81 card tests passed at either value** |
| the eval set scored 10/10 because every query quoted its own answer | the harness had no notion of a query being too easy |

**This is the deepest lesson in the build.** Tests catch regressions. They do not catch a number
that is confidently wrong, a claim that has quietly become false, or a benchmark that cannot fail.
**Only reading the output like a suspicious human catches those.**

---

## 3. The brief template, corrected

```
TASK        T4.1 — <one line>

READ FIRST  <exact paths, in order. Include the ONE existing file to imitate.>

CONTEXT     <what a previous worker measured that changes your assumptions —
             quote the numbers. This is the highest-value section; workers act
             on it and it stops them re-deriving what is known.>

DELIVER     <exact file paths. Nothing outside this list.>

RESERVED    Do NOT edit packages/core/src/index.ts, packages/cli/src/index.ts,
            or <shared test files>. Export from your own module and tell me the
            exact line to add. Other live workers own: <files>.

ACCEPT      <criteria copied VERBATIM from the phase file, not paraphrased,
             plus the measurement you must report>

RULINGS     <what to do when blocked, decided in advance:
             "if X will not install, that is acceptable — record it and move on"
             "if you cannot hit the budget, report the true number; do not
              narrow the scope to fit"
             "if the honest result is a FAIL, report the FAIL">

CONSTRAINTS ~/.claude ~/.codex ~/.cursor ~/.pi and the frozen archive are
            READ-ONLY. Writes go to --potsherd-dir $(mktemp -d).
            KEEP any evidence dir and report its absolute path.
            Never run a verb with --yes against a fixture directory.
            Exact counts come from the frozen snapshot; the live tree grows
            while you work and supports floors only.
            Commit on your branch only. Do not push, do not commit to main,
            do not merge.

REPORT      (a) table of changes  (b) ONE verbatim artifact  (c) the numbers
            (d) what you could not do and why  (e) test command + last line.
            Detail goes in a file; give me the path.
```

**The two sections most often skipped and most valuable: `CONTEXT` and `RULINGS`.** A worker given
prior measurements does not re-derive them. A worker given rulings reports an honest partial result
instead of stalling or quietly fudging.

---

## 4. The verifier brief, corrected

```
You are the VERIFIER for phase N. You wrote none of this and must not trust it.
Be adversarial. Every previous phase's verifier found something the authors
reported as green: 12, 8, 9, 7 defects. Find this phase's.

DO ALL VERIFICATION YOURSELF. Do not spawn subagents — you are the check, and a
check that delegates is not a check.

EVERY finding must carry the command you ran and its output. A finding you
cannot paste output for is NOT a finding: mark it UNVERIFIED and say why.
Do not rate anything you have not looked at.

<the phase's DoD boxes, verbatim>

VERIFY INDEPENDENTLY, do not take the report's word:
  <the 5-8 claims most likely to be wrong, named specifically>

Then read the output like a suspicious stranger. plans/05: would this make sense
as a screenshot with no caption? Is any number stated as fact that is really an
estimate? Does any string claim something that stopped being true this phase?

You may make ONE fix of <=5 lines. Report it with the diff.
REPORT: DoD table | commands and output | defects ranked | what you could NOT
verify and why.
```

Add per phase: **"check that a number the product prints matches what it actually does."** That one
instruction found the estimator bug, the privacy-receipt lie and the "no secrets" bug.

---

## 5. Orchestrator discipline

**Do delegate:** anything with a real input and a checkable output. Adapters, modules, evals, fixes,
verification, docs from measurements.

**Do NOT delegate (do it yourself, it is cheap and it is your actual job):**
- **Triage.** Reading a report and deciding: defect / plan correction / honest miss. This is the work.
- **Merging.** Workers must never merge. Conflicts are yours; taking one side of a conflict is a
  design decision.
- **A trivial fix blocking a gate.** A two-line fixture path, a flaky timing assertion. Spawning an
  agent for two lines costs more context than the fix.
- **Reading one real output per phase, by eye.** Three of the worst bugs in this build were caught
  this way and by nothing else.
- **Plan corrections.** When a plan file states a fact that turned out false, fix the file and log
  it in `04-DECISIONS.md`. Never let a worker edit `plans/`.

**Waiting:** a long quiet period is almost always a real run — a 7-minute index, a 55-minute card
run — not a hang. Check for file activity and running processes, then **message the worker** rather
than killing it. Every check-in in this session came back "not blocked, running". A short message
with your rulings ("if it is the timeout, raise it and move on") often unblocks a decision the
worker was agonising over.

**Parallelism:** 4–6 workers is the practical ceiling. Beyond that, merge conflicts and report
volume cost more than the concurrency saves. Sequence anything touching the same module.

---

## 6. What I would do differently, in order

1. **`isolation: worktree` on every worker.** No exceptions. Three blocked phases came from this.
2. **Reserve the barrels and shared test files.** Workers report the export line; the orchestrator
   adds them all in one commit. This alone removes most conflicts.
3. **Verifiers do not sub-delegate, and every finding carries its command output.**
4. **Every real run keeps its evidence directory**, path reported.
5. **Structure the report instead of capping its length** — one verbatim artifact beats 800 words.
6. **Assign migration numbers up front** when more than one worker might add one.
7. **Build the measuring instrument before the thing being measured, with a different worker.**
   Phase 3 did this and it was the best decision in the build: the eval-set worker had no stake in
   the score, so it built a set that could fail — and it did, four times, until the ranker genuinely
   improved. Compare phase 1, where the same worker wrote the queries and the ranker and got a
   meaningless 10/10.
8. **Add one standing instruction to every brief:** *"If a number you are about to report was
   produced by an assumption rather than a measurement, say so and label it `est.`"*

---

# SESSION 2 — phases 4, 5 and 6, written 22 aug 2026

Everything above was written by the orchestrator that ran phases 0–3. This half is written by the
one that ran **4, 5 and 6** — `ask`/`graft`, the surfaces, the ecosystem — across ~20 workers and
three tags. **Every rule above held.** What follows is what the first session had no way to learn,
because it had not yet built anything that touched another program.

**The verifier count is now 12 · 8 · 9 · 7 · 13 · 15 · 14.** It has not fallen. Do not expect it to.

---

## 7. The three failures that cost this session the most

### 7.1 The orchestrator's own integration is the least-tested code in the build

**Three of the worst defects across phases 4–6 were mine, at integration, and every one shipped
green.**

| what I did | what it caused | why no test caught it |
|---|---|---|
| pasted T5.6's two forwarding lines into `find.action` instead of `ask.action` | `ask --readers-out` made **four real model calls** under a flag whose privacy receipt says *"no model was called to write it"* | every T5.6 test calls the helpers directly; **nothing in 1,137 tests went through commander** |
| applied T6.2's registration file and never applied T6.4's | `stack` and `link --suggest` shipped as **45 tests and a 589-line module unreachable from the CLI** | `tests/stack.test.ts` calls `render()` directly, and *"every verb has `--help`"* passed **precisely because `stack` was not a verb** |
| pasted a registration file's example hint into `commands/link.ts` | a **live-corpus session id** in a public repo; `check-privacy.py` was already red on my branch | I ran the guard *before* applying the file, not after |

**Fixes, all cheap:**
- **After applying any registration file, run the verb.** Not the tests — the verb. `node packages/cli/bin/potsherd.js <verb> --help` and one real invocation. A registration file is worker prose; it can name the wrong command, carry a stale example, or over-capture into the next section's explanatory text (this happened twice — 34 lines of prose landed inside `index.ts` once).
- **After applying any registration file, run `python3 scripts/check-privacy.py`.** Registration files quote real examples.
- **Keep a checklist of registration files per phase and tick them off.** I lost `registration-T6.4.txt` simply by not writing down that it existed.

### 7.2 A test whose premise is the environment will eventually assert the opposite of what it means

**Five instances in three phases.** This is now the most common single defect class in the build.

| test | premise it silently relied on | what broke it |
|---|---|---|
| `setup` "refuses a server that is not built" | `packages/mcp` did not exist | T5.1 built it |
| `graft` "never writes into the process cwd" | no `./.potsherd` in the checkout | my own interactive graft test left one |
| redaction throughput < 10 s | an idle machine | four concurrent workers |
| MCP "runs past its deadline" | a `claude` binary being reachable | CI, which has none |
| bridges `agentmemory` ×3 | `~/Library/Application Support` being probed | Linux, where it is not |

**Two of these cannot be reproduced on a developer laptop at all.** `availability()` finds a
`claude` at a well-known absolute path *even with `PATH` emptied*; three attempts to reproduce the
deadline failure locally all passed. CI was the only possible observer.

**The rule: a test's premise must be something the test establishes.** Where the premise genuinely
is the environment, the predicate must be **the product's own answer to that question**
(`availability()`, not `onPath()`; `agentMemoryDirs()`, not a hard-coded macOS path), and the
comment must say the condition is not observable locally — otherwise the next person "fixes" it by
deleting the skip.

### 7.3 CI is not a formality; it is the only machine that is not yours

**Six CI-only failures across three phases, none reproducible locally.** Beyond the two above:
`managed-settings.json` lives at a different path on Linux than macOS, so a guard comparing a
captured screen to live output could only ever pass on the OS that captured it. `XDG_CONFIG_HOME`
was not cleared alongside `HOME`, so one line of a receipt resolved outside a throwaway home. A
detached hook was still writing while the recursive cleanup walked its sandbox (`ENOTEMPTY`, Linux
only). **Never tag before CI is green, and never assume a local pass means anything about the
matrix.**

---

## 8. What workers did better than asked, and how to get it again

The best work this session came from three brief patterns. All three are cheap.

**Name a specific doubt and ask them to resolve it with evidence.** T4.0 was told to build an eval
set that *could fail*; it built twelve hand-built `AskResult` objects, eleven of which must fail, and
then **split two cases that tripped two gates at once, on the grounds that a case failing two gates
proves neither.** Nobody asked for that.

**Ask a question the honest answer to which is "no".** T5.2 was asked, plainly, whether a SKILL.md
can supply `readerFn`. The answer was no — so the plugin's `ask` loses `filterAnswer`, the product's
central claim. It **said so on the skill's own last line** rather than claiming the guarantee, then
specified the fix (`--readers-out`/`--readers-in`), which T5.6 built with **zero edits to
`ask.ts`**. A brief that only permits success gets a worker that reports success.

**Make them measure the thing that damages their own feature.** T4.2 measured its open-thread rule
pass and reported **8/8 candidates genuinely absent from project B, but only 1–2 of 8 worth
raising** — leading with the number that hurts. T6.4 did the same for `link --suggest` (5 raised, 2
worth accepting) and put the disclosure in the terminal. T4.8, asked directly whether its demo
corpus was easier than the real world, answered: *"yes, materially"*, and showed the unmodified
corpus producing **0 confirmed** open threads.

**Two workers found bugs they had introduced themselves, by measuring on the real corpus rather than
trusting a unit test** — an empty bullet with a citation on it, and an aliased array that silently
produced an empty `ANSWER` on three real runs. Ask for a real run and you get a real check.

---

## 9. New failure modes seen in workers

### 9.1 A worker flags a hazard, then downgrades it in its own summary — believe the flag

Twice. T5.5 flagged the `XDG_CONFIG_HOME` gap and called it *"insurance, not a live failure on
GitHub's runners."* **It was live.** T5.3 flagged the marketplace-binary problem; the verifier found
it was **worse** than reported (`dist/` is gitignored, so the MCP server vanishes too, leaving the
archaeologist agent with `Read` and nothing else).

**Read the "what I could not do" section as a defect list, not a disclaimer.** When a worker
predicts something and rates it low, re-rate it yourself.

### 9.2 A worker corrects the orchestrator, and is usually right

Three times, and all three were mine:
- **T6.1** corrected my brief: `research/formats.md` was *not* "509 lines against real files" for
  gemini/opencode/copilot — those sections are **five lines each and headed `unmeasured`**.
- **T5.1** declined to add a `potsherd mcp` verb partly because **the model-reach guard would not
  have caught it** — found by reasoning, before it could bite.
- **T5.2** corrected two plan facts I had assumed wrong and **checked before "fixing"** them.

**Put "if the brief is wrong about a fact, report it — do not work around it silently" in every
brief.** It pays.

### 9.3 Two workers died mid-task; both were recoverable

One to a stall watchdog at 600 s, one because **the machine went to sleep**. Neither had committed.
Both worktrees survived and **both agents were resumable with their context intact** — `SendMessage`
to the dead agent's id restarts it where it stopped.

**Fixes:** put *"commit after every defect, before moving to the next"* in every fix-worker brief —
the default instinct is one commit at the end, which is exactly wrong for a long task. And
**resume, do not respawn**: check `git -C <worktree> status --short` first; the answer to "how much
was lost" is usually "none of it, if you act now". Note that a resumed worker's uncommitted diff
**may be wider than its brief** — one came back with six screens modified when its task named one.

### 9.4 A worktree is cut from `origin/main`, not local `HEAD`

I committed a pinned interface contract *before* spawning four workers so they would compile against
one shape. **Not one worktree contained it.** Two recovered only because worktrees are nested inside
the main checkout and their briefs used absolute paths — and both then re-created the file *and*
re-applied a barrel edit I had already made.

**`git push origin main` before spawning any wave, and verify `git rev-parse origin/main` equals
`HEAD`.**

### 9.5 The plan folder is not in the repo, and **must not be mirrored into it**

Every brief names `plans/…`, but `plans/` lives **beside** the repo. From a worker's worktree those
paths do not resolve. Every worker silently recovered by guessing the absolute path. **Write plan
paths absolutely in briefs**: `/Users/zebra/randomness/plans/03-ARCHITECTURE.md`.

**Do not "fix" this by copying the folder into the repo.** I tried, at the end of session 2, and
`check-privacy.py` refused the commit within seconds: `01`, `02`, `04`, `05` and `06` carry **real
project names, real session ids and a real session title** — the plan folder was kept outside a
public repository for exactly that reason, and I had forgotten why. The guard remembered.

That is worth keeping as its own lesson: **when a guard refuses something you are certain about,
the guard is the one with the evidence.** Absolute paths in briefs is the whole fix.

---

## 10. What phases 4–6 proved about the product's own rules

### 10.1 "Verify a flag exists before documenting it" — six plan claims about other software were false

`rescue --background`, `index --card`, a `brief` verb, `codex features enable plugin_hooks`,
`~/.agentmemory`, and claude-mem's `observations_fts`. **None existed.**

The worst shape is the fourth: `plugin_hooks` is `Stage::Removed` but **still registered**, so the
command validates, writes `features.plugin_hooks = true` into the user's config, prints success —
and the loader discards it. That is worse than a flag that fails loudly, and both the phase file and
`research/memory-research.md` instructed documenting it.

**Any claim in the plan about software we did not write is a lead, not a fact.**

### 10.2 The privacy receipt has now published something false three times

*"no network"* after the product began calling a model (phase 2). Omitting the `graft` write path
and still saying *"later phases add ask and graft"* (phase 4, in the **published** copy while the
live command was correct). *"open no socket at all"* for `export` and `find`, which federate
(phase 6).

There is now a CI step that diffs the published receipt against the live command — **and its limit
matters**: it proves *screen == live output*, never *live output == truth*. When it goes red, the
question is always **which of the two is wrong**. In phase 6 it was the live output, and pasting the
diff into the screen would have published a claim already shown false.

### 10.3 A guard that can be walked around is a guard that will be

The model-reach guard grew a hole **once per phase**:
- phase 4: it grepped CLI command files, so `ask` — which opens its backend one import away in core
  — read as offline.
- phase 5: it followed `@potsherd/core` only, so a command importing `@potsherd/mcp` was unchecked.
- phase 6: it followed package specifiers but not **relative cross-package imports**, the exact form
  `commands/stack.ts` used; and its workspace map was hand-written, so it was a list of packages
  somebody remembered.

It is now derived from `pnpm-workspace.yaml` and walks relative imports. **Every time it flagged
something, it was right** — including flagging `link`, which was fixed by *splitting the
model-calling half of `open-threads.ts` into its own module* so `link` stops being flagged **because
it genuinely cannot reach a model**. Never make a guard coarser to fit the code.

### 10.4 Read one real output by eye, every phase — it is still the highest-yield hour

Caught by eye and by nothing else this session:
- a **ghost** brief reading `· 241 exchanges ·` three lines under *"prompts only, the assistant side
  is gone"* — and `03 §8` specified that wording, so the **spec** was what made it contradict itself
- an open-thread line reading `decided in /home/dev/event-bus, not seen in /home/dev/da…` — **project
  B, the half that carries the entire claim, truncated off the end**
- a real client's name, a third party's business plans and a personal tweet about to be published to
  a public repo in an evidence directory

---

## 11. The two interactive lessons

**`plans/07` says the in-Claude-Code tests need an interactive session. They do not.**
`claude -p --plugin-dir … --output-format stream-json --verbose` exercises the same path and leaves
a **machine-readable record of every tool the model chose** — which turns "I tried it and it seemed
to work" into something checkable. That closed three DoD boxes with real evidence.

**Always run a control.** The positive result is only half of it:
- the skill fired unprompted on *"what did we decide about X last month?"* — and used **no tools at
  all** on *"what does a connection pooler do, in general?"*
- the grafted session answered in **1 turn, 5.9 s, zero tools, correct and cited**; the same question
  without the brief took **16 turns, 88 s, 15 tool calls** and produced a **confidently wrong**
  answer about a different event, **citing a real commit hash**

That last control is the best single piece of evidence in the build. **The failure mode potsherd
addresses is not silence — it is a plausible answer assembled from whatever is nearest to hand.**

---

## 12. Orchestrator checklist, phases 4–6 edition

Before a wave:
1. `git push origin main`; verify `git rev-parse origin/main` == `HEAD`.
2. Pin any shared interface **in a committed file** and name it in every brief.
3. Absolute plan paths in briefs. Name the other live workers' files.
4. Write down every registration file you will owe yourself.

After each worker:
5. Merge, then **apply its registration file, run the verb, run the guard, run the suite.**
6. Re-confirm every load-bearing claim yourself — revert the fix and watch the test go red.
7. Read one real output by eye.

Before a tag:
8. `pnpm test`, `python3 scripts/check-privacy.py`, `bash scripts/make-screens.sh`.
9. **Wait for CI green on the pushed commit** — not the local run.
10. Tag, push the tag, and confirm CI green **on the tag** too.

---

## 13. Phase 7, run solo — what changed and what did not

Phase 7 was run by the orchestrator alone rather than as a worker wave. The reason is worth stating
because it is a departure from `07-ORCHESTRATION.md`: the worker model exists to keep an
orchestrator's context clear of source files across a seven-phase build, and by phase 7 there was
one phase left and a 1M-token context. The constraint that justified the model no longer bound.

**Everything from `09 §12` that finds defects was kept, and every one of them paid.** Run the verb
after wiring it. Run the privacy guard after every change. Read one real output by eye. Push before
anything that depends on the pushed state. And a fresh verifier at the end who authored none of it.

### 13.1 Four defects that only appeared when something moved

None of these was findable by reading. Each appeared the moment an artefact was used somewhere it
had not been used before.

| what moved | what broke |
|---|---|
| the MCP bundle, vendored as `dist/mcp.js` | it decided it was the entry point **by filename** (`/index.js`, `/potsherd-mcp.js`, `/index.ts`), matched none of them, and **started, did nothing, and exited 0.** No output, no error. An MCP server that fails to start is invisible by design; this one had found a way to do it while looking clean |
| ...and the path check that replaced it | `import.meta.url` is resolved through symlinks by the ESM loader and `process.argv[1]` is not, so `/var/folders/…` ≠ `/private/var/folders/…` — **every temp directory on macOS**, and therefore every test of a marketplace install |
| `commander` out of the runtime deps | correct for the published package, wrong for the build: esbuild needs it *present* to bundle it. Every test that shells out to the binary failed |
| the demo cast, recorded under a relocated `HOME` | `claude` is on PATH and not logged in there, so six readers failed in 3.2 s and `ask` printed **"the readers found nothing that answers the question"** — a claim about the user's archive from a verb that never read it |

**The lesson is the same one four times: an artefact is only verified in the place it has been
run.** A bundle that works in the checkout is not a bundle that works in a plugin. A test that
passes in the workspace is not a test that passes from an install.

### 13.2 A test of mine reported that a fallback worked while never once loading it

The new SQLite fallback needed proof that the shipped bundle runs with no `node_modules`. The first
version of that test copied the bundle into `os.tmpdir()`, ran it, and watched it resolve
`better-sqlite3` anyway — because **vitest sets `NODE_PATH`** to three directories inside the
repository's own `node_modules`, and a child process inherits it.

It would have gone green forever, testing nothing.

This is `§7.2` in its purest form and it is now seven instances across four phases. **The premise
was "no `better-sqlite3` is reachable", so the test has to make that true**: `NODE_PATH` is deleted
from the child environment, and a separate assertion spawns a child with that same environment and
requires the resolution to *fail* before anything else runs.

A second one in the same file: `POTSHERD_SQLITE_WARN=1` was asserted to restore a Node warning, and
CI went red on all four legs — because the runner's Node had **stopped emitting that warning**.
Whether there is a warning to restore is a fact about somebody else's software, not about ours, so
the test asks that Node directly and skips loudly when the answer is no.

### 13.3 Three shell mistakes, each of which cost a run

1. **Do not edit a shell script while it is running.** Bash reads a script incrementally by byte
   offset. A mid-run edit shifted the parser and a seven-minute screen capture printed `card --all
   failed` *after* it had already recorded the screens.
2. **`set -o pipefail` plus `| head` kills the script.** `head` closes the pipe, the producer takes
   SIGPIPE and exits 141, and the pipeline fails. Twice, in two different scripts, both times on a
   line whose only job was to show the first six of something.
3. **`pnpm test ; git commit && git push` pushes a red suite.** `&&`. CI caught it, which is what CI
   is for, but it should not have had to.

### 13.4 Making a script stage its output is worth an hour

`scripts/make-screens.sh` used to `rm -f` each screen and redirect the binary's stdout onto the
committed path. An interrupted run — and a seven-minute run that makes model calls gets interrupted
— left the repository with artefacts the README links either deleted or half-written.

It stages now: captures land in `.tmp/`, the assertions run over that, and only a run that captured
everything and passed everything moves files into place. **It paid for itself twice on the same
day**, once when the model confirmed no open thread (so the assertions correctly refused a screen
that was not a screenshot of the feature) and once when the mid-run edit above corrupted the script.

### 13.5 The guard caught something in the commit that created it

Vendoring the plugin bundles publishes them — and esbuild keeps comments, so `recall.ts` became a
committed artefact twice over, including four comments citing a real session title as ranking
evidence that had been pinned as DEBT since phase 5 with the note *"re-derive, do not rename"*.
`check-privacy.py` went red in the same commit that added the bundles.

Two of the four are now measured on the **committed eval corpus** — `potsherd find "timezone
drift"` returns one session on the strength of its title alone, because that session's body contains
neither word, and anybody can re-run it. The other two needed a 155-exchange session and every
session in the eval corpus is one to three, so they keep the finding, drop the identity, and say
so.

**34 pinned violations → 14.** Every one confirmed by the guard itself as *"pinned at N, now
clean"* before its DEBT line was deleted, because the pin list is a ratchet and deleting a line
without that confirmation is how a ratchet becomes a wish.

### 13.6 Widening a check by eight cases found three defects in one run

`tests/terminal.test.ts` had run its `--ascii` sweep over a hand-written list of fifteen verb
invocations since phase 1, and the *width* rule was enforced for exactly two of them — the two that
had once been caught overflowing. Widening the list to twenty-three and applying the width rule to
all of them found `doctor --privacy` overflowing 60 columns on **fourteen lines**, `setup --status`
on one, and `guard --status` on one, and found `setup --status` demanding a client for a mode whose
own `--help` says it reports what is registered *everywhere*.

**A rule enforced for the cases that broke it is not a rule.** The cheapest thing available at the
end of a build is to take a check that already exists and point it at everything.

### 13.7 The verifier found seven, and its first verdict was "not releasable"

`12 · 8 · 9 · 7 · 13 · 15 · 14 · 7`. It has still never fallen to zero.

Two of the seven were critical and both were the kind that only an outsider finds, because they are
failures of a claim rather than of code:

**The honesty contract was broken by the way its own documentation said to run it.**
`FINAL-REPORT.md` handed a reader:

```
potsherd audit --claude-dir X --verify --json | jq -r .snippet | sh
```

and **`sh` does not inherit a flag**. The standalone python read `~/.claude` and answered about a
different corpus — 340/41 against the audit's 330/31, which reads as potsherd under-reporting by
ten. The product was right; the artefact whose entire purpose is *"nobody has to trust potsherd to
check potsherd"* was answering a different question, which is worse than being wrong.

**The test for it is now the pipeline, not the function.** Audit a fixture, take the snippet out of
`--json`, run it in a shell that was told nothing, require all four numbers to match. Generalise
that: **if the documentation prints a command, the test runs that command as printed.** Testing the
function underneath it tests something nobody will ever do.

**The vendored plugin bundle was stale on the release commit.** A commit labelled `docs(T7.7)`
changed `render/ask.ts` and did not re-vendor, so the bundle every marketplace user gets was missing
the fix. CI's own drift gate was red on the tag. Two lessons in one: a docs-labelled commit changed
shipped code, and a generated artefact that is committed goes stale the moment you forget it exists.

### 13.8 How to brief a verifier so its report is worth something

The phase-7 verifier brief is worth copying. What made it work:

1. **It was told what it was NOT allowed to do** — no sub-delegation, no fixes, no commits, no
   writes to `~/.claude` / `~/.codex` / `~/.cursor` / `~/.pi` / `~/.potsherd`, and every command must
   pass `--claude-dir` / `--potsherd-dir` at a `mktemp -d`. It obeyed all of it and said so.
2. **It was told the two documents making the claims are hypotheses, not facts**, by name.
3. **It was given a priority order** — claims checkable by one command, then the design system, then
   the README, then the install story, then "anything that looks like a claim nobody checked" — so
   it spent its budget where defects were likely rather than reading everything.
4. **It was given this project's own recurring failure modes as a hunting list**: a number that is
   confidently wrong, a string that has quietly become false, a benchmark that cannot fail, a flag
   that is documented and does nothing, and a test whose premise is the environment.
5. **Its output format demanded a command and its output per finding**, a severity, and — this is
   the part that made the report trustworthy — **two sections called "claims I checked that held"
   and "what I could not check, and why."**

That last pair is what separates a verification from a list of complaints. Phase 7's verifier
listed twelve things it had re-measured and found true, and six things it could not check with the
reason for each (no model, no container, no spare user account, out of budget). An unchecked claim
reported as checked is the worst outcome available to a verifier, and asking for the section makes
it cheap to be honest.

**One thing to do differently:** give the verifier the **exact commit SHA** to run against and a
list of what you have already fixed since. Two of its seven findings were things fixed in commits
after the one it cloned, and it spent effort on them.

### 13.9 A guard's stated limitation is a real gap, not a formality

`scripts/check-privacy.py` says in its own header: *"No regex recognises prose. Passing this check
does not mean a file is clean — it means the file carries no leak we have already seen."*

That sentence turned out to be load-bearing. `docs/upstream/PHASE-1-SCOUT.md` has published real
transcript prose from the reference machine to a **public repository since phase 1** — a real
assistant `thinking` sentence from `~/.pi` with its ids and timestamp, and a real truncated
`<user_query>` from `~/.cursor`. Phase 5 found it, scrubbed the ids and the title, assigned the
prose scrub, and **the prose scrub was never done.** The guard passes the file and always has.

Two things follow. **Read the guard's own caveats and treat each as an open item**, not as
boilerplate. And **an item marked "assigned" in a handoff is not an item that was done** — check it
before repeating the claim. This one survived two orchestrators because each read the previous
handoff's "assigned" and moved on.

### 13.10 Wall time is the budget that binds, so build for the retry

Phase 7's expensive loops, measured:

| | cost |
|---|---|
| `card --all` over the demo corpus (31 transcripts, ~39 calls) | **6–7 min** |
| one `ask` at k=6 | 40–50 s |
| `bash scripts/make-screens.sh` with the model screens | **~8 min** |
| `bash scripts/make-cast.sh` from cold | **~8 min** |
| `pnpm test` | ~78 s |
| a Docker fresh-machine run | ~3 min |

Nothing in that list is run once. The screens were captured **four times** in phase 7 (a stochastic
open-thread confirmation, a corrupted script, a SIGPIPE abort, and the real one), and the cast
three. So:

- **Put a reuse flag on anything that re-does expensive setup.** `POTSHERD_CAST_REUSE=1` keeps a
  carded corpus. Without it a retry re-cards for six minutes, which is how a timing budget gets
  widened instead of met.
- **Stage the output.** See §13.4.
- **Start the long job in the background and do file-only work while it runs** — but never
  `pnpm build` while a script that reads `dist/` is running, and never edit a shell script that is
  executing (§13.3).

### 13.11 When a budget cannot be met, split the artefact — do not widen the budget

`plans/05` and `phase-7` both cap a demo cast at **60 seconds**. One cast containing all five verbs
measured 64.2 s, then 66.6 s. `ask` alone is 40–50 s of real model calls and is most of what the
cast exists to show.

Three options and only one was honest:

1. speed the recording up — misrepresents the one number `ask`'s own screen prints;
2. widen the cap to match what had been produced — rewriting the spec around the result;
3. **two casts**: `demo.cast` (audit → rescue → index → find, 14.2 s) and `demo-ask.cast` (52.3 s).

This generalises. When a measurement will not meet a target, the choices are: change the thing,
change the target *with the measurement written down beside it*, or split the artefact so each half
is honestly inside the target. **Never the fourth option, which is to keep the number and stop
measuring.**

### 13.12 Four numbers in four documents, four different values

`FINAL-REPORT.md` said 1,426. The handoff said 1,428. The README said 1,426. The suite had 1,427 —
and `FINAL-REPORT.md` §4 hands a reader `pnpm test  # 1,426` as *the first thing to try*.

The fix is not "be careful". It is a test:

```ts
// It cannot assert the true count — a suite cannot count itself while running —
// but it can refuse the failure that actually happened, which is four documents
// disagreeing. Lines containing `baseline` are excluded: a handoff quoting what
// the suite held when the phase started is history, not a claim about now.
```

**Any number that appears in more than one document should have a test that they agree.** The
version string got one in phase 7 too, after shipping three releases stale — and that test now
enumerates every manifest in the repository rather than the four somebody remembered.

### 13.13 The small things that cost an hour each

- **Do not edit a shell script while it is running.** Bash reads a script incrementally by byte
  offset; a mid-run edit shifts the parser. A seven-minute capture printed `card --all failed`
  *after* it had already recorded the screens.
- **`set -o pipefail` plus `| head` kills the script.** `head` closes the pipe, the producer takes
  SIGPIPE and exits 141. Twice, in two scripts, both on a line whose only job was to show the first
  six of something. Capture into a variable and slice with `sed -n '1,6p'`.
- **`pnpm test ; git commit && git push` pushes a red suite.** Use `&&` throughout.
- **`ls -1 */*.jsonl` fails on Claude Code's project directories** because they begin with `-` and
  the expanded glob is parsed as options. Use `printf '%s\n' */*.jsonl`.
- **`awk 'length($0)>80'` counts bytes, not characters.** The design system uses `·` `…` `→` `★`,
  all multi-byte. Every width check must count code points — use python, not awk.
- **A heredoc body containing its own terminator ends early.** A `python3 - <<'PY'` script that
  itself writes `<<'PY'` will be truncated. Use a distinct delimiter, or write the script to a file
  first, which is better anyway because it can be re-run.
- **An asciinema v3 cast has `term: {cols, rows}` and *delta* timestamps**, not v2's top-level
  `width`/`height` and absolute times. The v2 parser read a v3 cast as `not 80x24: NonexNone` with a
  2.7 s duration — a guard printing a verdict while asserting nothing.

---

## 14. Orchestrator checklist, phase 7 edition

`§12` is phases 4–6 and every line of it still holds. These are added, not substituted.

Before starting:
1. Read `08-STATE-OF-PLAY.md`, then this file's `§7`, `§12` and `§13`, then the previous phase's
   `HANDOFF.md` and `VERIFICATION.md`.
2. Run the whole verification block in `MASTER-REPORT.md §9` **before writing anything**. It takes
   ten minutes and it tells you whether the state you inherited is the state you were told about.
3. Check every item the previous handoff marked **"assigned"** or **"reported not fixed"**. At least
   one of them will not have been done (§13.9).

While working:
4. `git push origin main` before anything that depends on the pushed state, and verify
   `git rev-parse origin/main` equals `HEAD`.
5. After changing anything under `packages/`: `pnpm build && pnpm vendor`. The plugin bundles are
   committed and go stale silently (§13.7).
6. `python3 scripts/check-privacy.py` after every change, and read its header's caveats as open
   items rather than as boilerplate.
7. Chain the suite and the commit with `&&`, never `;`.
8. Run any command the documentation prints, exactly as printed, before believing the documentation
   (§13.7).
9. Read one real output by eye, every phase. It is still the highest-yield hour.

Before a tag:
10. `pnpm test` **and** `POTSHERD_SQLITE=node pnpm test`.
11. `python3 scripts/check-privacy.py --selftest && python3 scripts/check-privacy.py`.
12. `npx tsx evals/ask-selftest.ts`. (`pnpm evals` **fails on purpose** — see `08`.)
13. `node scripts/vendor-plugin.mjs && git status --short plugins/` — expect no diff.
14. `bash scripts/make-screens.sh` and, if anything user-visible changed, `bash scripts/make-cast.sh`.
15. A fresh verifier that authored none of it, briefed the way `§13.8` describes, **given the exact
    commit SHA** and a list of what you have already fixed since.
16. Wait for CI green on the **pushed commit**, then tag, then confirm CI green **on the tag**.

## 15. What each orchestrator would say in one sentence

**1:** *"Tests catch regressions. They do not catch a number that is confidently wrong, a string that
has quietly become false, or a benchmark that cannot fail — only reading the output like a
suspicious human catches those."*

**2:** *"The code your workers write gets verified. The code you write while integrating does not,
and three of my worst defects were mine, at integration, and every one shipped green."*

**3:** *"An artefact is only verified in the place it has been run — a bundle that works in the
checkout is not a bundle that works in a plugin, and four separate defects in one phase appeared the
moment something moved."*

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

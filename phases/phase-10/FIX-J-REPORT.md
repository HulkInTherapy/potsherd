# FIX-J — three verbs that disagreed in print, a test that passed by not running,
# and two gates CI had never run

**Branch** `work/FIX-J`, cut from `origin/main` at `7396c3e`. Nothing pushed, nothing merged,
nothing committed to `main`. Four commits, listed in §1.

**Items** VERIFICATION-5 §C: **C-3** (★★★★), **C-8** (★★), **C-9** (★★), **C-10** (★★), **C-11** (★).

**Identifiers.** Nothing below carries a real session id, project name, home path or transcript
line. Where `check-privacy.py` is quoted, the finding is elided — and see §1/C-8, where the guard
caught two literals I had written into `ci.yml` myself.

---

## §0 THE CLAIMS, CHECKED BEFORE FIXING

Every one of the five reproduced. Nothing was closed by evidence.

### C-3 — three verbs, three session counts · **REPRODUCED, exactly**

Fresh demo corpus (`scripts/make-demo-corpus.mjs`), relocated `HOME`, `CLAUDE_CONFIG_DIR`,
`POTSHERD_DIR`, `XDG_CONFIG_HOME`, `NODE_PATH`, `CODEX_HOME` cleared, `TZ=UTC`,
`POTSHERD_OFFLINE=1`, `--width 80 --no-color`, the guard's capture order:

```
=== ls ===
  1 session · 197 subagents inside them · 299 ghosts, prompts only
=== ls --limit 400 --json counts ===
total 300 shown 300 ghosts 299 rolledUp 197 threaded 30 sidechains 0
=== doctor ===
  sessions on disk              31   21 harness-titled · 3 sdk · 546 KB
=== stats ===
  sessions                      31   197 subagents · 31 titled · 0 archived
```

`--json` knows (`threaded: 30`); the human view did not. And all three are committed screens:
`docs/screens/08-ls.txt:20`, `04-doctor.txt:8`, `10-stats.txt:6`.

### C-8 — the normaliser hides a fact about the guard's own procedure · **REPRODUCED, and the
cause is not the one the comment named**

`.github/workflows/ci.yml` (as committed) normalised `^(  database +)[0-9.]+ [kMG]?B` → `<size>`.
Confirmed too coarse, by seeding the committed `2.1 MB` and running **both** normalisers over the
same file:

```
  2.1 MB -> 2.2 MB    old normaliser PASS   new normaliser PASS
  2.1 MB -> 2.1 kB    old normaliser PASS   new normaliser FAIL
  2.1 MB -> 2.1 GB    old normaliser PASS   new normaliser FAIL
  2.1 MB -> 3.1 MB    old normaliser PASS   new normaliser FAIL
  2.1 MB -> 21 MB     old normaliser PASS   new normaliser FAIL
```

The *cause*, however, is not what `ci.yml:370-392` said it was. See §1/C-8: it is neither the
capture order nor `--no-embed`; it is **how deep the throwaway HOME sits**.

### C-9 — two receipts that contradict themselves · **REPRODUCED, both halves**

`ask`, driven through `renderAsk` with four readers that all carry an `error` (no network, no real
corpus):

```
  nothing was read — all 4 readers failed

  no reader could run, so nothing was read: claude --print could not answer: Not logged in

  4 of 4 sessions read · 0 answered · 6.4s
  4 readers did not answer · not counted as searched
```

Three claims, two of them false: four sessions were *not* read, and they *were* counted as searched.

`graft`, driven through the real `graft()` against a real index with a backend that throws the
error the verifier's MCP run got:

```
--- a backend that is not logged in
   > **unsummarised.** No model call was made — the model call failed (claude --print could not
     answer: Not logged in · Please run /login). What follows is the stored card and transcript
     verbatim, not a summary.
    report: via=card-only spend.calls=0
```

**Which file owns the sentence — the brief asked, and the answer is not the one in the brief.**
It is `packages/core/src/graft.ts` (`buildHead`), not `packages/mcp/src/tools/graft.ts`, which only
forwards `report.reason`. The *same* false claim was also one file over, in
`packages/core/src/render/graft.ts:87` (`no model call — ${r.reason}`), on the CLI receipt. Three
files, one sentence; §1 says what each got.

### C-10 — a test that reports **passed** when its premise is absent · **REPRODUCED, and the CI
half is worse than reported**

```
$ PATH=<a git shim whose `git tag` prints nothing>:$PATH \
  npx vitest run tests/terminal.test.ts -t "is not behind the newest git tag"
 ✓ tests/terminal.test.ts (70 tests | 69 skipped) 910ms
 Tests  1 passed | 69 skipped (70)
```

`.github/workflows/ci.yml:24` was `- uses: actions/checkout@v4` with nothing under it. §1 has the
measurement that `fetch-tags: true` **alone would not have fixed it**.

### C-11 — two gates CI never runs, and a stale header · **REPRODUCED**

```
$ grep -n evals .github/workflows/ci.yml
120:      # `plans/06` makes gate (a) of the ask evals the one that must be 100% or
121:      # the build fails, and `evals/ask-selftest.ts` is what proves the scorer
128:        run: npx tsx evals/ask-selftest.ts
```

Only the ask-scorer selftest. Neither `pnpm evals` nor its per-query alarm ran.

```
$ grep -c '^{' evals/queries.jsonl   ->  66      (60 recall + 6 controls)
$ grep -n 'PHASE_3_FLOOR =' evals/gate.ts
89:export const PHASE_3_FLOOR = { hits: 51, of: 60 } as const;
```

and `tests/evals-gate.test.ts`'s header recorded *"25 queries"* with `TOTAL = 25` — against a set of
60, and beside a floor that had **already** been moved to `51/60` for that set. The comment's own
rule applied to itself.

---

## §1 WHAT CHANGED, AND WHY THAT SHAPE

Four commits: `11fc553` (C-3), `0288967` (C-9), `955406b` (C-8, C-10, C-11), `e0a63e5` (a privacy
fix to my own comment — see the end of C-8).

### C-3 · `packages/core/src/render/ls.ts` + two screens

`1 session` → **`1 of 31 sessions`**, and only when `threaded > 0`.

The ruling was that the footer is the fix and the count is correct, and the count *is* correct:
`threaded: 30` is thirty earlier links of one fork/resume chain folded into the head's row.
What the line did was account for the 197 rolled-up subagents on the same line and say nothing at
all about the 30 folded siblings — then call the remainder "sessions". `browse.ts`'s own docstring
for `threaded` says it is counted "*for the reason `rolledUp` is: a listing that quietly drops rows
is lying about the archive*". It was counted, and then not printed.

**Why folded into the first item rather than added as a fourth.** `f.joinFit` drops items from the
**tail**. The three existing items spend 64 characters; `16-before-after.txt` is captured at
`--width 76`, where the budget is 74. Any fourth item long enough to be meaningful pushes
`299 ghosts, prompts only` off that screen. `1 of 31 sessions` costs seven characters and drops
nothing — measured, the regenerated line is 77 characters inside 80 and 73 inside 76.

**Why `n of m` and not a new idiom.** The heading already says `15 of 300` for rows. The footer now
says `1 of 31` for sessions: same shape, one subject each, and `31` is the literal number `doctor`
and `stats` print, sitting beside the number `ls` prints. That is the reconciliation the brief
asked for, on the screen, without `--json`.

`docs/screens/08-ls.txt` and `docs/screens/16-before-after.txt` regenerated with
`bash scripts/make-screens.sh` (`POTSHERD_SCREENS_NO_MODEL=1`, so the three model screens keep their
committed copies). `07-index.txt` and `09-find.txt` moved only in milliseconds and were reverted;
see §2.

### C-9 · `render/ask.ts`, `core/graft.ts`, `render/graft.ts`, `mcp/tools/graft.ts`

**`ask`.** New `sessionsRead(r)` in `packages/core/src/render/ask.ts:442`: the shortlist minus the
readers that errored, used by `counts()` and by the `no grounded answer in N sessions searched`
headline. `AskResult.searched` is `targets.length` — sessions *handed to* a reader — and its own
docstring calls it "sessions actually read by a reader", which on a dead backend is false. The
number the screen now prints is the one the note three lines below it already promised
(`not counted as searched`).

`r.searched === 0` deliberately keeps `searched`: that branch is "the shortlist was empty", a
different fact, and the one round 4 was careful to keep separate from a capability failure. A run
with no per-reader outcomes at all (the `--filter-in` seam, where the host agent did the reading)
also keeps `searched` — there is nothing to subtract.

**`graft`.** `GraftReport.called` — whether a model call was *made*, which is neither
`via === 'model'` (did one *succeed*) nor `spend.calls > 0` (was one *billed*; a backend that
refuses a login bills nothing and still costs a round trip). Set at the one place the call happens.
Then:

* `packages/core/src/graft.ts:1556` — the brief's own header:
  `> **unsummarised.** The model call did not produce one — <error>.` when a call was made, and
  `> **unsummarised.** No model call was made — <reason>.` when it was not.
* `packages/core/src/render/graft.ts:93` — the CLI receipt: `model call, no summary — <reason>`
  against `no model call — <reason>`.
* `packages/mcp/src/tools/graft.ts:168` — `called` forwarded, so an agent can branch on it.

The failed-call `reason` lost its `the model call failed (…)` prefix, which the new lead already
says. **The `--no-model` path is byte-identical**, on purpose: `docs/screens/15-graft.txt:10,18` and
`README.md:738,746` publish those two lines and neither needed regenerating (and `15` needs a
backend this machine does not have).

### C-8 · `.github/workflows/ci.yml`, the screens step

The brief preferred making the guard's sequence match the script's. It now does — and doing it is
what found the actual cause.

**1. The sequence is the script's, in the script's order.** The two captures between `index` and
`stats` that the guard skipped because it does not diff their screens (`16-before-after`'s
`ls --limit 5 --width 76`, and `ls --ghosts only`) now run in their positions. The `--width 76` one
is invoked inline rather than through `run()`, which appends its own `--width 80`: a guard that
reproduces a sequence reproduces the sequence.

**2. The cause was neither the order nor the flags.** Measured, same build, same corpus, the
script's read order after `index`, varying one thing at a time:

```
  index --full --no-embed  OFFLINE=1  ->  database 2.1 MB   page_count 548  freelist 0
  index --full             OFFLINE=1  ->  database 2.1 MB   page_count 548  freelist 0
  index --full             OFFLINE=   ->  database 2.1 MB   page_count 548  freelist 0
```

Neither `--no-embed` nor `POTSHERD_OFFLINE` moves a page. What moves pages is **where the throwaway
HOME sits**, because sqlite packs the absolute paths of 228 transcripts into them:

```
  /tmp/psU/h                          521 pages   database 2.0 MB
  $repo/.tmp/demo-home                533 pages   database 2.1 MB
  <a 100-character-deeper scratch>    578 pages   database 2.3 MB
```

About half a page per character — a 57-page, 0.3 MB spread. The guard's HOME was
`$RUNNER_TEMP/screens-live` and the script's is `$repo/.tmp/demo-home`, so the two were capturing at
different depths. **The guard now stands where the script stands**, and on this machine it produces
**533 pages — the same page count `scripts/make-screens.sh` produces**. The two capture sequences
are now one capture.

That also answers the finding on its own terms. What is left over is the length of the checkout path
itself, which differs between the linux and macos runners by a character: about one page, well
inside a tenth of a megabyte. **That is a fact about the machine and not about the build** — which
is the only thing this project's rule lets a normaliser hide, and the reason the original
justification (capture order — a fact about the build) failed its own test.

**3. The normaliser is narrowed to one character.**

```
-  -e 's/^(  database +)[0-9.]+ [kMG]?B/\1<size>/'
+  -e 's/^(  database +[0-9]+)\.[0-9]( +[kMG]?B)/\1.<tenth>\2/'
```

The integer part and the unit are compared as normal. **What it can still hide, exactly and only:**
a drift of under 0.1 MB in the demo index — about 25 sqlite pages — that does not cross the
megabyte. `2.1 → 2.9 MB` passes; `2.1 → 3.0 MB`, `2.1 kB`, `2.1 GB`, `21 MB` and a `database` row
that vanishes, moves or names the wrong file all fail. That table is in §0 and the reasoning is
written into the step.

**The privacy guard caught me.** My first draft of that comment quoted the two runners' checkout
roots literally, and `scripts/check-privacy.py` family (2) is exactly a guard on home-shaped paths
in tracked text. `PRIVACY_EXIT=1`, two lines named. Reworded to state the same fact with no path
(`e0a63e5`). The guard works.

### C-10 · `tests/terminal.test.ts` + the checkout

**The test.** The three escapes (no `.git`, no `git`, no reachable tag) print the reason and call
`ctx.skip()`. A bare `return` is a **pass** in vitest; `ctx.skip()` is a skip, and the reason is on
stdout under the test's name.

**And on CI a missing premise fails.** Off CI the premise really is the environment's — a packed
tarball, a contributor's shallow clone — and a visible skip is the honest report. On a runner the
checkout is *this workflow's* choice, so a missing premise is a workflow regression and now fails as
one, naming both knobs. That is what stops the green-that-means-not-run from coming back by the same
door.

**The checkout, and what `fetch-tags` costs.** Measured against this repository over `file://`,
which is the same fetch machinery a runner uses (`git init` + `git remote add` + the refspec
`actions/checkout@v4` uses at each depth):

| fetch-depth | fetch-tags | v* tags | `--merged HEAD` | `.git` | fetch |
|---|---|---:|---:|---:|---:|
| 1 (the default this step had) | false | 0 | **0** | 3.5M | 0.52s |
| 1 | **true** | 0 | **0** | 3.5M | 0.50s |
| 0 | false | 0 | **0** | 5.9M | 2.07s |
| 0 | **true** | 9 | **9** | 5.9M | 1.48s |

**`fetch-tags: true` on its own buys nothing**, which the brief's framing did not anticipate:
`--depth 1` fetches only tags pointing into the history it fetched, and this test asks
`--merged HEAD`, which a depth-1 HEAD has no history to answer. So `fetch-depth: 0` **and**
`fetch-tags: true`, and the price of both is that last column — about a second and 2.4 MB more
`.git` on a 47 MB repository. Cheap enough that no cheaper shape is worth proposing.

### C-11 · `.github/workflows/ci.yml` + `tests/evals-gate.test.ts`

**The step.** `pnpm evals` runs, once, with `POTSHERD_EVALS_EMBED: '1'`, and **the premise is
asserted from the output rather than inferred from the exit code**. Without a model on disk
`evals/run.ts` drops the vector modes, prints `vector modes skipped`, reports the phase-3 gate as
`cannot be judged` — and the gate the release is judged on is not judged. So the step fails if the
output carries `vector modes skipped` or `cannot be judged`, or lacks the gate's own PASS line.

The per-query alarm is deliberately **not** fatal: it is by design a report and not a gate, and it
currently names five losses and two gains of tie-break drift against `evals/per-query-baseline.json`
with the aggregate unchanged. Running the step is what puts it in the log, which is all it asked
for. `evals/per-query-baseline.json` is **not** regenerated here — that is a deliberate act with its
own command, and not this fix's to take.

**Wall time**, measured on this machine (Apple silicon):

```
  pnpm evals, model already cached          17.0 s   exit 0
  pnpm evals, empty POTSHERD_MODELS_DIR     24.3 s   exit 0   (46 MB fetched)
  pnpm evals -- --vector-weight 0           19.3 s   exit 1
```

One cold run per matrix job. The step's comment names `actions/cache` keyed on the model id as the
cheaper shape if that ever stops being cheap — a gate nobody runs costs more than 25 seconds.

**The header.** Rewritten to the two runs anyone can reproduce today, on this commit, with the
commands that produced them; and `TOTAL`, `MEASURED` and `REGRESSION` moved with it, because the
comment says in its own words that they are *a record of a run*. **The gate's clauses and its floor
are untouched** — `evals/gate.ts` is not in this branch's diff, and
`expect(PHASE_3_FLOOR).toEqual({ hits: 51, of: 60 })` still stands. The four synthetic shapes the
other tests judge were rescaled to the 60-query set so that each still fails on the one clause it is
named for; §2 shows each of them red on a wrong record.

---

## §2 THE ARTIFACTS

### C-3 (a) — red first, on the guard that already exists in CI

There is no unit test for `renderLs`'s footer in this branch's remit (see §4). Its guard is the CI
screens step, which diffs `08-ls.txt` — so the red-first proof is that step, run locally, with the
fix in `ls.ts` and the screen not yet regenerated:

```
$ bash <the screens step, extracted verbatim from ci.yml>
  ok        docs/screens/01-audit.txt
  ok        docs/screens/06-audit-sweep.txt
  ok        docs/screens/02-rescue.txt
  ok        docs/screens/03-audit-after.txt
  DRIFTED   docs/screens/08-ls.txt  <-  potsherd ls
@@ -17,5 +17,5 @@
 
-  1 session · 197 subagents inside them · 299 ghosts, prompts only
+  1 of 31 sessions · 197 subagents inside them · 299 ghosts, prompts only
   run  potsherd show <id8>  to read one, or  potsherd find <words>
  ok        docs/screens/09-find.txt
  ...
A published screen is not what this build prints.
```

### C-3 (b) — the regeneration, and what was and was not committed

```
$ POTSHERD_SCREENS_NO_MODEL=1 bash scripts/make-screens.sh
  07-index.txt  <-  potsherd index --full
  stopping the background embedder this capture started (pid <redacted>)
  ...
  ok    17 screens, widest line 80 characters, no forbidden strings, no unredacted credentials
$ git status --porcelain docs/screens/
 M docs/screens/07-index.txt        <- "full index 374ms" -> "531ms"        (reverted)
 M docs/screens/08-ls.txt           <- the footer                           (committed)
 M docs/screens/09-find.txt         <- "bm25 · 10ms" -> "11ms"              (reverted)
 M docs/screens/16-before-after.txt <- the same footer, at --width 76       (committed)
```

`ps -eo pid,ppid,command | grep "[p]otsherd.js"` before and after the run: nothing either time. The
script kills the embedder it starts by the pid the child wrote itself, and it did.

**`16-before-after.txt` is a second screen carrying a real content change** and is committed for
that reason: it prints the same footer, and leaving it would have published the contradiction on the
one screen `plans/05` asks people to post. Its regenerated line is 77 characters — nothing elided.

### C-3 (c) — green again, and red on a seeded content drift

```
$ bash <the screens step>                              -> ten published screens match ... EXIT=0
$ sed -i 's/299 ghosts/298 ghosts/' docs/screens/08-ls.txt && bash <the screens step>
  DRIFTED   docs/screens/08-ls.txt  <-  potsherd ls
-  1 of 31 sessions · 197 subagents inside them · 298 ghosts, prompts only
```

### C-9 (a) — `ask`, before and after, same driver

The driver builds an `AskResult` with four readers all carrying an `error` and calls `renderAsk`.
Before is the committed code, restored with `git stash` and rebuilt; after is this branch.

```
BEFORE   nothing was read — all 4 readers failed
         4 of 4 sessions read · 0 answered · 6.4s
         4 readers did not answer · not counted as searched

AFTER    nothing was read — all 4 readers failed
         0 of 4 sessions read · 0 answered · 6.4s
         4 readers did not answer · not counted as searched
```

### C-9 (b) — `graft`, before and after, through the real `graft()`

```
BEFORE  --- a backend that is not logged in
        > **unsummarised.** No model call was made — the model call failed (claude --print could
          not answer: Not logged in · Please run /login). ...
        report: via=card-only called=<absent> spend.calls=0
        --- no backend at all (--no-model)
        > **unsummarised.** No model call was made — no model was used. ...

AFTER   --- a backend that is not logged in
        > **unsummarised.** The model call did not produce one — claude --print could not answer:
          Not logged in · Please run /login. ...
        report: via=card-only called=true spend.calls=0
        --- no backend at all (--no-model)
        > **unsummarised.** No model call was made — no model was used. ...
        report: via=card-only called=false spend.calls=0
```

The second case is byte-identical, which is what keeps `docs/screens/15-graft.txt` and the README
block true without a backend to regenerate them.

`npx vitest run tests/graft.test.ts tests/ask.test.ts tests/mcp.test.ts tests/cards.test.ts`
→ `Test Files 4 passed (4) · Tests 368 passed (368)`.

### C-8 — the normaliser, seeded, old against new

Both normalisers extracted verbatim and run over the committed `10-stats.txt` against a seeded copy:

```
  2.1 MB -> 2.2 MB    old normaliser PASS   new normaliser PASS
  2.1 MB -> 2.1 kB    old normaliser PASS   new normaliser FAIL
  2.1 MB -> 2.1 GB    old normaliser PASS   new normaliser FAIL
  2.1 MB -> 3.1 MB    old normaliser PASS   new normaliser FAIL
  2.1 MB -> 21 MB     old normaliser PASS   new normaliser FAIL
```

and through the whole step, which is what CI actually runs:

```
seeded '2.2 MB'  ->  step exit=0   0 drifted
seeded '2.1 kB'  ->  step exit=1   1 drifted
seeded '2.1 GB'  ->  step exit=1   1 drifted
seeded '3.1 MB'  ->  step exit=1   1 drifted
seeded '21 MB'   ->  step exit=1   1 drifted
```

### C-8 — the guard's page count now equals the script's

```
GUARD, script's sequence, home = $RUNNER_TEMP/screens-live   page_count 550   freelist 0
SCRIPT, scripts/make-screens.sh, home = $repo/.tmp/demo-home  page_count 533   freelist 0
GUARD, script's sequence, home = $repo/.tmp/demo-home         page_count 533   freelist 0

(the first row is this branch's corrected sequence still standing in the old place, which is how the
sequence was eliminated as the cause and the path found as it)
```

### C-10 — the missing premise simulated, all four directions

A `git` shim on `PATH` that answers `git tag` with nothing and forwards everything else. No tag was
created or deleted in this repository at any point.

```
A. premise absent, not CI                 (was: 1 passed | 69 skipped)
   stdout | tests/terminal.test.ts > ... > is not behind the newest git tag this repository released
     SKIPPED — no v* tag is reachable from HEAD — a shallow clone, or a commit older than every release
   Tests  70 skipped (70)

B. premise absent, CI=true                                                        -> FAIL
   AssertionError: no v* tag is reachable from HEAD ... On CI that is a workflow regression, not an
   environment: .github/workflows/ci.yml must check out with BOTH fetch-depth: 0 and fetch-tags: true.
   Tests  1 failed | 69 skipped (70)

C. premise present (this full clone), CI=true                                     -> PASS
   Tests  1 passed | 69 skipped (70)

D. premise present, a shim reporting a release ahead of VERSION                    -> FAIL
   AssertionError: VERSION is 1.2.0 but this repository already released v9.9.9: expected -8 to be
   greater than or equal to 0
```

A is the fix: the same environment that used to report a **pass** now reports a **skip** and says
why. D is the assertion still being able to fail for its real reason.

### C-11 — the new CI step, run locally, green and red

```
GREEN  $ RUNNER_TEMP=<scratch> POTSHERD_EVALS_EMBED=1 bash <the evals step, extracted from ci.yml>
       ... hybrid (auto)   recall@5  51/60   ✓ ≥ bm25 (39)  ✓ ≥ vectors (51)  ✓ ≥ 51/60
                           recall@1  27/60   ✓ > bm25 (24)  ✓ > vectors (24)  PASS
       ... lost bm25 recall@5 ... gain bm25 recall@1 ...        (the alarm, in the log, not fatal)
       the phase-3 gate ran, with vectors, and passed
       STEP EXIT=0

RED    seeded with a run that skipped the vector modes and returned 0:
       ::error::the vector modes did not run, so there was no phase-3 gate to judge
       ::error::the phase-3 gate was not judged in this run
       ::error::no PASS line from the amended phase-3 gate
       pnpm evals exited 0 without evaluating what this step exists to evaluate.
       STEP EXIT=1
```

The second is the case the step exists for: an eval that returns success without having judged
anything. (Separately, on this machine a real no-model run exits 1 of its own accord, because bm25
alone at 39/60 misses the phase-1 floor of 48/60 — but that is a property of today's corpus, not a
guarantee, and it is exactly what the assertions do not rely on.)

### C-11 — every changed assertion in `tests/evals-gate.test.ts`, red on a wrong record

```
A. MEASURED recorded with hybrid recall@1 tying bm25 (24 instead of the measured 27)
   FAIL  > passes the measured release run, and says which clause carried it
   AssertionError: expected false to be true

B. REGRESSION recorded as if --vector-weight 0 still beat bm25 at recall@1 (25 instead of 24)
   FAIL  > FAILS the vector-weight-0 regression, and fails it on recall@1
   AssertionError: expected true to be false

C. the ratchet loosened in evals/gate.ts (51/60 -> 48/60), which the brief forbids
   FAIL  > refuses a fusion under the floor even when it beats both singles
   AssertionError: expected true to be false
```

All three reverted; `git status --porcelain evals/` clean afterwards. With the measured numbers:
`tests/evals-gate.test.ts → 8 passed (8)`, including the end-to-end case that runs `pnpm evals`
twice for real (56 s).

---

## §3 THE NUMBERS

| gate | required | measured |
|---|---|---|
| `pnpm test` | ≥ 1,932 on 53 files, 0 skipped | **53 files, 1,932 tests, 0 skipped, EXIT=0** |
| `POTSHERD_SQLITE=node pnpm test` | same | **53 files, 1,932 tests, 0 skipped, EXIT=0** |
| `pnpm typecheck` | 4 of 4 | **4 of 4 `Done`** |
| `pnpm evals` | exit 0 | **EXIT=0** · hybrid recall@5 51/60, recall@1 27/60 |
| `python3 scripts/check-privacy.py` | exit 0, read from `$?` | **PRIVACY_EXIT=0** (and `--selftest` EXIT=0) |
| `pnpm build && pnpm vendor` | `git status plugins/` clean | **clean** |
| the CI screens step | green locally, red on a seeded drift | **both, §2** |
| the CI evals step | green locally, red on a seeded fault | **both, §2** |

`0 skipped` was read as `grep -c skipped` over the whole run output: **0** on both drivers.
`PRIVACY_EXIT` was read from `$?`; the script's final line is the header caveat that reads like a
pass, and on my first run `$?` was **1** while that line was unchanged — see §1/C-8.

Disk: `df -h /` read `8.7 GiB` free when I started, `9.5 GiB` mid-run and `10 GiB` at the end —
three workers share this machine, so I state the readings rather than a delta I cannot attribute. My scratch (two demo corpora, five probe indexes, four
git clones, a 46 MB cold model cache) is deleted; `.tmp/` in the worktree is removed.

Processes: one detached embedder was started, by `scripts/make-screens.sh`, and the script stopped
it by the pid the child wrote into its own `owner.json` after checking that pid's command line named
the demo root. `ps` before and after: nothing. My own probe script used the same rule. No name
pattern, no `killall`, no pid signalled without reading its command line first.

Git: no `git fetch --all`, no `git fetch --tags`, no tag created or deleted in this repository. The
four clones in §2/C-10 are independent clones in scratch, made over `file://`, and are deleted.

---

## §4 WHAT I COULD NOT DO — and the exact patches for it

### 1. `AskResult.searched` still says 4 in `--json` where the screen now says 0

The C-9 fix is in the renderer, which is what the brief assigned. `--json` still serialises
`searched: 4` for a run where every reader died, so the two doors now differ by the number of failed
readers — a small instance of the F2 family this phase keeps finding. Closing it is one line plus
its docstring, in a file outside this brief:

```diff
--- a/packages/core/src/ask.ts
+++ b/packages/core/src/ask.ts
@@ -309,1 +309,6 @@
-  /** Sessions actually read by a reader. */
+  /**
+   * Sessions a reader actually read — the shortlist minus the readers that
+   * errored. A reader that never answered read nothing, and `readers[].error`
+   * is where that is recorded.
+   */
   searched: number;
@@ -1510,1 +1510,1 @@
-      searched: targets.length,
+      searched: targets.length - readers.filter((r) => r?.error).length,
```

`empty({ searched: targets.length, ... })` at `ask.ts:1431` wants the same treatment. If that lands,
`sessionsRead()` in `render/ask.ts` becomes a no-op and should be deleted rather than left as a
second source of truth — its docstring says so.

### 2. No unit test for C-3's footer or C-9's two sentences

No test file for either is in this brief's deliver list, and C-3's guard is a screen the CI step
already diffs. The three I would add:

```diff
--- a/tests/threads.test.ts        (in `describe('the thread is the unit')`)
+  it('ls says how many sessions the one row stands for', async () => {
+    const { claudeDir, root } = scratch();
+    writeChain(claudeDir, { parentId: ID.parent, childId: ID.child,
+                            parentPairs: 10, copiedRecords: 20, ownPairs: 3 });
+    const { db } = await index(claudeDir, root);
+    try {
+      const r = listSessions(db, {}, { limit: 10 });
+      expect(r.threaded).toBe(1);
+      const line = stripAnsi(renderLs(r, new Theme({ width: 80, color: false })));
+      // 1 row, 2 sessions on disk — the number `doctor` and `stats` print.
+      expect(line).toContain('1 of 2 sessions');
+      expect(line).not.toContain('1 session ·');
+    } finally { db.close(); }
+  });
```

```diff
--- a/tests/ask.test.ts            (beside 'does not print the same two numbers twice')
+  it('does not say four sessions were read when four readers died', () => {
+    const r = shape(0, 0, 0);
+    const dead = { ...r, sentences: [], evidence: [], answer: '', matching: 4, searched: 4,
+      readers: r.readers.slice(0, 4).map((x) => ({ ...x, found: false, error: 'no backend' })) };
+    const text = stripAnsi(renderAsk(dead, t80, NOW));
+    expect(text).toContain('nothing was read — all 4 readers failed');
+    expect(text).toContain('0 of 4 sessions read');
+    expect(text).not.toContain('4 of 4 sessions read');
+  });
```

```diff
--- a/tests/graft.test.ts          (beside 'writes a brief with no model at all')
+  it('does not say no call was made about a call that failed', async () => {
+    const llm = { spend: emptySpend(),
+                  async text() { throw new Error('not logged in'); } };
+    const r = await graft(db, ID.hero, { llm, write: false, clip: false });
+    expect(r.called).toBe(true);
+    expect(r.brief).toContain('**unsummarised.** The model call did not produce one');
+    expect(r.brief).not.toContain('No model call was made');
+    const off = await graft(db, ID.hero, { write: false, clip: false });
+    expect(off.called).toBe(false);
+    expect(off.brief).toContain('**unsummarised.** No model call was made');
+  });
```

### 3. `tests/sqlite-driver.test.ts:178` has C-10's defect and is not in this brief

```ts
    if (!probe.stderr.includes('ExperimentalWarning')) {
      console.log(`  skipped: ${process.version} does not warn about node:sqlite, ...`);
      return;                       // <- reported as a PASS, same as C-10
    }
```

The patch is the same two-line shape: take `(ctx)` on the `it`, and `ctx.skip()` after the
`console.log` instead of `return`. It prints its reason already, so only the verdict is wrong.
I did not touch it: `tests/sqlite-driver.test.ts` is not in this brief's list, and a sibling is live
in this tree.

### 4. `docs/screens/17-ls-cards.txt` is a **third** spelling of C-3, and needs a model backend

```
docs/screens/17-ls-cards.txt:17   31 sessions · 197 subagents inside them · 299 ghosts, prompts only
```

Not `1 session` and not `1 of 31 sessions` — `31 sessions`, which is what this footer printed before
the fork/resume rollup existed. It is one of the three screens `make-screens.sh` cannot regenerate
without a backend (it needs 39 model calls to card the corpus), so it kept its committed copy, and I
could not verify what it would print today. Whoever next runs the script **with** a backend should
expect it to move, and should read the change rather than assume it is noise. It is on the same
defect as C-3 and it is the only surface of it I could not close.

### 5. The per-query alarm's five losses are reported, not fixed

`pnpm evals` still names five losses and two gains against `evals/per-query-baseline.json`, exit 0,
aggregate unchanged. Regenerating that baseline is a deliberate act with its own command
(`pnpm evals -- --json | node scripts/write-eval-baseline.mjs`) and a judgement about whether
tie-break drift should be absorbed. It is not this fix's to take, and the new CI step now puts the
alarm in the log every run, which is where the judgement can be made from.

### 6. I could not run a GitHub Actions job

Both CI steps I changed were extracted verbatim from `ci.yml` with a YAML parser and run locally,
green and red. The checkout behaviour in §2/C-10 was measured against this repository over `file://`
using the same commands `actions/checkout@v4` issues, not by running the action. So the claim "this
is CI's state" remains, as it was for the fifth verifier, an inference from the workflow file — a
well-measured one.

---

# ROUND 2 — landing my own §4, and sweeping for the rest of C-10

**Branch** `work/FIX-J2`, cut from **local `main` at `7d95276`** — not `origin/main`, which was one
merge behind at `5b99a10` when I started. `git merge-base --is-ancestor 5b99a10 main` → yes, and
`7d95276` is `Merge branch 'work/FIX-H'` on top of it. Verified before a line was written, because
the coordinator's own instruction named a commit that was already stale. Nothing pushed, nothing
merged. Two commits.

**The baseline moved with FIX-H.** On `7d95276`, before any change of mine: **54 test files, 1,946
tests, 0 skipped** — not the 53 / 1,932 of round 1. (That run reported one failure,
`the vendored bundles are byte-for-byte the bundles this build produces`, because I rebuilt `dist`
while it was in flight without re-running `pnpm vendor`. Mechanical, and the same test is green in
both final runs below.)

**Scope.** `packages/core/src/{db,vec,ingest,doctor-line,lock}.ts`, `packages/core/src/recall.ts`,
`packages/cli/src/commands/{find,ask}.ts`, `packages/mcp/src/tools/recall.ts` and
`tests/{find,mcp,synthesis-seam}.test.ts` were not touched. One sweep finding lives in
`tests/mcp.test.ts` and is reported, not fixed.

---

## R1. §4.1 — `searched` at the source, and one regression the proof caught

### What changed

`packages/core/src/ask.ts`: a `sessionsRead(shortlisted, readers)` helper beside `AskResult`, used
at **both** construction sites — `base()` at the all-readers-failed early return, and the full
return. A free function rather than an inline expression for the reason round 1 found the hard way:
a fact re-derived in two places is a fact two doors will eventually disagree about.

`packages/core/src/render/ask.ts`: the local `sessionsRead()` is **deleted**, not kept. Its own
docstring said it should be, and the double-subtraction the coordinator warned about is exactly what
keeping it would have caused — `-4 of 4` the day the field became right. `counts()` and the
`no grounded answer in N sessions searched` headline now read `r.searched` straight.

### Both doors, one run

A real `ask` through the CLI, in a relocated `HOME`, with a stub `claude` on `PATH` that exits 1
with `Not logged in`. Same question, same corpus, same build:

```
--- the screen -------------------------------------------------
  nothing was read — all 4 readers failed

  no reader could run, so nothing was read: claude exited 1: Not logged in · Please run /login

  0 of 58 sessions read · 0 answered · 466ms
  4 readers did not answer · not counted as searched
  58 matching sessions not read · raise --k to widen

--- --json -----------------------------------------------------
  {"searched":0,"matching":58,"readers":4,"failed":4}
```

`0` on the screen, `0` in `--json`, subtracted once. The note that says the failed readers are *not
counted as searched* is now true of both.

### The regression the side-by-side caught, which no test would have

The **first** run under the new field printed this:

```
  nothing in the index matches "what did we decide about the pooler".

  run  potsherd find  to check the shortlist, or  potsherd index

  0 of 58 sessions read · 0 answered · 998ms
  4 readers did not answer · not counted as searched
```

An archive-shaped empty over a capability failure — the exact frame VERIFICATION-4 §C7 removed, and
the **third** place it has appeared. `nothing()` branched on `r.searched === 0`, which was a safe
sentinel only while `searched` could not be 0 with a shortlist behind it; §4.1 made it able to be.

The premise that branch actually wants is that **no reader ran**. `ask.ts` returns early with
`readers: []` when the shortlist is empty, and every path that reaches a reader records one, so the
branch is now `r.searched === 0 && r.readers.length === 0`. Checked live in both directions:

```
$ potsherd ask "xylophrantic bedduzzle qwomparil"     # a control invented for this run
  nothing in the index matches "xylophrantic bedduzzle qwomparil".
  0 of 0 sessions read · 0 answered · 12ms
  json: {"searched":0,"matching":0,"readers":0}
```

This is the finding of round 2. It was not reachable from the diff: the renderer and the field were
each defensible alone, and the failure only exists in the pair. It took printing both doors of the
same run, which is what the coordinator asked for and is why it is asked for.

---

## R2. §4.2 — the three tests, and why they were the point

The fifth verifier's most damning measurement was that its own two-line CLI/MCP fix left **1,931
tests passing before and after**, because nothing asserted the field it changed. C-3's footer and
C-9's two sentences were in that position at the end of round 1: fixed, and unpinned.

### `tests/threads.test.ts` — two, not one

`ls says how many sessions the one row stands for`, on a two-session fork/resume chain, where the
number is small enough to read: `result.sessions` has length 1, `result.threaded` is 1, and the
rendered screen contains `1 of 2 sessions` and **not** `1 session` as a whole claim. The premise is
established rather than assumed — the chain is asserted before the screen is.

And `says nothing about threads when no row folds one`, because `n of n sessions` on every listing
would be a worse screen than the one C-3 replaced. That one asserts `2 sessions` and no `of` at all.

**Red first**, with the pre-C-3 footer put back and rebuilt:

```
 FAIL  tests/threads.test.ts > the thread is the unit > ls says how many sessions the one row stands for
 AssertionError: expected 'potsherd ls · 1 session\n\n    when  …' to contain '1 of 2 sessions'
       Tests  1 failed | 22 skipped (23)
```

### `tests/ask.test.ts` — the four lines together, and the sentinel from both sides

`does not say four sessions were read when four readers died` asserts the headline, the count, the
absence of the old count, the reader note **and** the absence of `nothing in the index matches`, on
one screen. The last of those is the regression above, pinned so it cannot come back.

**Red first**, against `main`'s renderer — round 1's fix, before §4.1:

```
 FAIL  tests/ask.test.ts > the ask block is built to fit 80x24 > does not say four sessions were read when four readers died
 AssertionError: expected 'potsherd ask "what did we decide abou…' to contain 'nothing was read — all 4 readers fail…'
       Tests  1 failed | 118 skipped (119)
```

`still says nothing matched when no reader ran at all` is green on both the old and the new
renderer, by design — its job is to stop the fix over-reaching, not to catch the old bug. So it is
shown red on a **seeded** fault instead, the branch disabled with `&& false`:

```
 FAIL  tests/ask.test.ts > … > still says nothing matched when no reader ran at all
 AssertionError: expected 'potsherd ask "what did we decide abou…' to contain 'nothing in the index matches'
```

### `tests/graft.test.ts` — the claim about the call, in both directions

The test beside it (`falls back to the card when the model call throws`) asserted `/unsummarised/`
and the reason and **never the claim about the call**, which is exactly why the sentence survived
review. The new one asserts `called: true` with `spend.calls: 0` in the same run — billed nothing,
and made the call — plus both headers, each with the other's absence.

**Red first, twice.** Against the pre-fix `graft.ts`, on the field:

```
 FAIL  tests/graft.test.ts > it works on a plane > does not say no call was made about a call that failed
 AssertionError: expected undefined to be true
```

and, with `called` recorded but the published one-sentence-for-both-paths header seeded back, on the
sentence itself:

```
 AssertionError: expected '# pgbouncer and prepared statements\n…' to contain '**unsummarised.** The model call did …'
```

---

## R3. §4.3 and the sweep — every "green tick that means not run" in the suite

### §4.3, fixed

`tests/sqlite-driver.test.ts`. It already printed its reason; only the verdict was wrong. Simulated
by forcing the probe to report a Node that does not warn about `node:sqlite`:

```
BEFORE (bare return)   Tests  11 passed (11)
AFTER  (ctx.skip())    SKIPPED: v24.9.0 does not warn about node:sqlite, so there is nothing
                                for POTSHERD_SQLITE_WARN to put back
                       Tests  10 passed | 1 skipped (11)
```

### The sweep, and the full list

Three passes over `tests/`, each a script rather than a reading:

1. **A bare `return;` inside an `it()`/`test()` body.** 1,765 bodies scanned, 5 hits.
2. **An early exit guarded by an environment probe** — `process.env`, `existsSync`, a `spawnSync`
   probe, a version or platform test — inside a test body.
3. **A `catch` block with no assertion and no rethrow**, i.e. a failure swallowed into a pass. 31
   hits, all of them helpers capturing a non-zero exit into `{ code, stdout, stderr }` for a test to
   assert on, or capturing an error into a variable for a later `expect`. **No findings.**

| site | what it is | verdict |
|---|---|---|
| `tests/terminal.test.ts:693` | C-10's own escape, after `ctx.skip()` | **fixed in round 1.** The `return` is unreachable and kept only so TypeScript narrows |
| `tests/sqlite-driver.test.ts:192` | `console.log('skipped') ; return` on an absent `ExperimentalWarning` | **fixed** (§4.3), and the `return` after `ctx.skip()` is now the same unreachable shape |
| `tests/mcp.test.ts:486` | `process.stderr.write(…) ; return` when `confidence === null` — "core in this worktree predates T10.1" | **left, reported.** It is a real instance of the pattern. It is also **dormant on this build**: I ran that test and the branch is not taken, so its assertions do run today. `tests/mcp.test.ts` belongs to a live worker; the patch is below |
| `tests/llm.test.ts:1038` | `return` inside an inner `async` arrow in `Promise.all` | **not the defect.** It follows `expect(err).toBeInstanceOf(BudgetError)` — an assertion was made — and it is not the test body's own return. My scanner's block tracking mis-attributed it |
| `tests/terminal.test.ts:333` | `return` in the `EXEMPT[v.name]` branch of `every verb ends with the next verb` | **not the defect.** The branch asserts `(stdout + stderr).trim().length > 0` first; it is a pass because it passed an assertion |

The patch for the one left, for whoever owns that file next:

```diff
--- a/tests/mcp.test.ts
+++ b/tests/mcp.test.ts
-  it('the nonsense control returns none once the floor is live', async () => {
+  it('the nonsense control returns none once the floor is live', async (ctx) => {
@@
       process.stderr.write(
         '\n  nonsense control: core in this worktree predates T10.1 (confidence null) — invariant asserted, cliff not\n',
       );
+      ctx.skip();
       return;
```

### The declared skips — 14 of them, and none is this defect

`describe.skipIf` ×6, `it.runIf` ×7, `it.skipIf` ×1, across `evals-gate`, `recall`, `embeddings`,
`vectors-lazy`, `index` and the four adapter files. These are honest: vitest reports them as
**skipped**, which is the verdict this whole item is about. Their premises are a cached 34 MB model,
`sandbox-exec` on macOS, and a real `~/.pi` / `~/.codex` / frozen corpus on the machine — and on
this machine **every one of them holds**, which is why both suites below report `0 skipped`.

Two consequences worth stating rather than leaving to be discovered:

* On a runner with no cached model, `describe.skipIf(MODEL === null)` in `tests/evals-gate.test.ts`
  legitimately skips the end-to-end eval. That is not a hole any more: round 1's CI step runs
  `pnpm evals` with `POTSHERD_EVALS_EMBED=1` and asserts the vector modes really ran, so the gate is
  evaluated on CI by the step even when the test skips.
* `it.runIf(CAN_DENY_NETWORK)` in `tests/index.test.ts` skips on the two ubuntu matrix jobs by
  construction — `sandbox-exec` is macOS-only, and the file says so.

---

## R4. THE NUMBERS

| gate | required | measured |
|---|---|---|
| `pnpm test` | ≥ baseline, 0 skipped | **54 files, 1,951 tests, 0 skipped, EXIT=0** |
| `POTSHERD_SQLITE=node pnpm test` | same | **54 files, 1,951 tests, 0 skipped, EXIT=0** |
| baseline on `7d95276` | — | 54 files, **1,946** tests, 0 skipped |
| the five new assertions | +5 | 1,946 + 5 = **1,951**, and no test changed its verdict |
| `pnpm typecheck` | 4 of 4 | **4 of 4 `Done`** |
| `pnpm evals` | exit 0 | **EVALS_EXIT=0** |
| `python3 scripts/check-privacy.py` | exit 0 from `$?` | **PRIVACY_EXIT=0**, `--selftest` **0** |
| `pnpm build && pnpm vendor` | `git status plugins/` clean | **clean** |
| the CI screens step | green, red on a seeded drift | **green**; seeded `1 of 31 sessions` → `1 session`, **DRIFTED**, exit 1 |
| the CI evals step | green, red on a seeded fault | **green**; seeded a run that returns 0 without judging → three `::error::` lines, exit 1 |

**`0 skipped` did not move**, and `ctx.skip()` is why it did not: both premises the two fixed
escapes need are present here — this checkout is a full clone with nine reachable `v*` tags, and
this Node still warns about `node:sqlite`. Where either is absent the count *will* move, by one
each, and that is the whole point of the change. Both were demonstrated above by simulating the
absent premise.

Disk: `df -h /` read **11 GiB** free at the start of round 2 and **7.6 GiB** at the end. That fall is
not mine to claim: my whole scratch is 1.9 MB after cleanup, `.tmp/` is removed from the worktree,
`git status` is clean, and two other workers were running the full suite on this machine at the same
time. Three readings, not a delta I cannot attribute. No process was started that outlived its command —
`ps` for `potsherd.js` after the screens step: nothing. No `git fetch --all`, no `git fetch --tags`,
no tag created or deleted; the tagless simulations use a `git` shim on `PATH`.

---

## R5. WHAT ROUND 2 DID NOT DO

1. **`docs/screens/17-ls-cards.txt`** — untouched, as instructed. It still reads `31 sessions`,
   which is a third spelling of C-3 and is what the footer printed before the fork/resume rollup
   existed. It needs a model backend (39 calls) to regenerate. Whoever regenerates it should **read**
   the change rather than assume it is noise.
2. **`evals/per-query-baseline.json`** — untouched, as instructed. Five losses and two gains of
   tie-break drift, aggregate unchanged, exit 0, and now in the CI log every run.
3. **`tests/mcp.test.ts:486`** — the one sweep finding left, with its patch in R3. Dormant on this
   build; another worker owns the file.
4. **`AskResult.searched` on the seam paths** — `--readers-in` and `--filter-in` construct their
   results through the same two sites, so they inherit the fix, but I drove only the live-reader
   path end to end. The seam's own tests (`tests/synthesis-seam.test.ts`) belong to a live worker and
   are green unchanged, which is evidence and not a measurement I made.
5. **I still could not run a GitHub Actions job.** Both CI steps were extracted from `ci.yml` with a
   YAML parser and run locally, green and red. The checkout claim remains an inference from the
   workflow file, measured against this repository over `file://`.

# FIX-K — re-deriving the fusion, with the grid written down first

Branch `work/FIX-K`, cut from local `main` at `bde6f73`.

**This section was written and committed before a single sweep point was run.** The commit that
carries it (`§0 only`) precedes every measurement commit on this branch; `git log --reverse` is the
receipt. A grid chosen after seeing results is not a grid, so this file starts with the grid and
nothing else.

---

## §0 THE GRID, DECIDED IN ADVANCE

### The parameter, and why it is the only one

`WEIGHTS` gives every fused list a multiplier and `rrfScore` is **linear** in it:

```ts
const contribution = weight * rrfScore(rank, k);
```

So multiplying the three semantic lists (`vec_exchanges`, `vec_ghost_prompts`, `vec_cards`) by `w`
and dividing the five lexical lists by nothing is, up to a global scale that no comparison can see,
*the same fusion* as leaving the semantic lists alone and dividing the lexical ones by `w`. One
scalar therefore parameterises **the entire one-parameter family of lexical:semantic balance**.
There is no second axis hiding inside the weights: any reweighting that preserves the ratio within
each lane is the same ranking, and the within-lane ratios are not what the gate is complaining
about. `--vector-weight <n>` is exactly this scalar, already in `evals/run.ts`, already printed on
the run header, and it moves precisely the constant this task may change.

`RRF_K` is the other fusion parameter and it is **not** swept: it lives in
`packages/core/src/search/similarity.ts`, which is not in this task's deliver list, and moving it
would change the fusion for `ask` and `browse` too.

### The points

```
w ∈ { 0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0, 12.0, 20.0, 50.0 }
```

Seventeen points. Chosen so that:

* **`w = 0`** is the lexical extreme and is also the standing regression check — the semantic lane
  is gone and hybrid must collapse onto bm25.
* **`w = 1.5`** is what ships today: `plans/03`'s phase-3 *stopping rule*, not an argmax.
* The step is fine (0.25) **below** the shipped value and around it, because if the honest answer is
  that the fusion should be weighted *down* the resolution has to be there to see it.
* **`w = 50`** is the semantic extreme. As `w → ∞` the lexical lists' contributions become
  numerically irrelevant and hybrid's ordering must converge on vectors-only. That bound is the
  point of including it: it makes the family **closed at both ends**, so a maximum is either
  *interior* — the fusion genuinely earns its place — or *at a boundary*, which is the finding that
  one of the two lanes should simply be used alone.

The whole grid is reported, every point, all three modes, both metrics. The winner is not the
report; the shape is.

### Two rules fixed in advance, so that they cannot be chosen to suit an outcome

1. **Refinement.** If the best point at recall@1 is interior *and* either neighbour is 2 or more
   queries below it, the two midpoints either side of it are added, to separate a plateau from a
   spike. Nothing else is added.
2. **Choice.** The chosen weight is the **most central point of the widest plateau** at recall@1
   that is not beaten at recall@5, preferring the value nearest the shipped 1.5 when a plateau is
   flat, and preferring a round number over an argmax. A one-point maximum that its neighbours do
   not support is noise on 60 queries and will be named as such, not shipped.

### Stability, computed from the per-query JSON rather than from more runs

At the chosen point and at the shipped point: split-half (odd/even query index) argmax agreement,
an exact McNemar test of hybrid against vectors-only on the discordant queries at both metrics, and
the per-query flip list. `evals/queries.jsonl` and `evals/gate.ts` are not touched by any of this.

### What would make this a failure rather than a result

If no `w` in the family puts hybrid above vectors-only at recall@1, the honest reading is that on
this corpus the fusion no longer earns its place at rank 1, and that is reported as the finding —
not fixed by changing what is measured.

---

## §1 THE FULL SWEEP — every point, all four modes, both metrics

One fixture index, built once with `--keep` and reused for every point via `--potsherd-dir`, so that
no two rows differ by which index they ran against. The reused index reproduces the fresh-build run
digit for digit (`bm25 40/31 · vectors 57/40 · hybrid 55/35 · always 55/35`), which is the control
for the whole table.

```
  w      bm25@5 bm25@1   vec@5 vec@1   hyb@5 hyb@1   alw@5 alw@1   gate
    0    40/60  31/60    52/60 37/60   52/60 33/60   52/60 33/60   fail
 0.25    40/60  31/60    57/60 40/60   53/60 34/60   53/60 34/60   fail
  0.5    40/60  31/60    57/60 40/60   55/60 32/60   55/60 32/60   fail
 0.75    40/60  31/60    57/60 40/60   55/60 34/60   55/60 34/60   fail
  1.0    40/60  31/60    57/60 40/60   55/60 34/60   55/60 34/60   fail
 1.25    40/60  31/60    57/60 40/60   55/60 34/60   55/60 34/60   fail
  1.5    40/60  31/60    57/60 40/60   55/60 35/60   55/60 35/60   fail   <- shipped at bde6f73
  2.0    40/60  31/60    57/60 40/60   55/60 34/60   55/60 34/60   fail
  2.5    40/60  31/60    57/60 40/60   55/60 34/60   55/60 34/60   fail
  3.0    40/60  31/60    57/60 40/60   56/60 34/60   56/60 34/60   fail
  4.0    40/60  31/60    57/60 40/60   57/60 35/60   57/60 35/60   fail
  5.0    40/60  31/60    57/60 40/60   57/60 35/60   57/60 35/60   fail
  6.0    40/60  31/60    57/60 40/60   57/60 36/60   57/60 36/60   fail
  8.0    40/60  31/60    57/60 40/60   57/60 37/60   57/60 37/60   fail   <- SHIPPED HERE
 12.0    40/60  31/60    57/60 40/60   57/60 38/60   57/60 38/60   fail   <- the argmax, not shipped
 20.0    40/60  31/60    57/60 40/60   57/60 37/60   57/60 37/60   fail
 50.0    40/60  31/60    57/60 40/60   57/60 37/60   57/60 37/60   fail
```

**Read the shape, not the winner.**

* **bm25-only never moves** (40/31 at every point) — it runs no semantic list, so the parameter is
  invisible to it. **vectors-only never moves either** (57/40 at every point above 0) — the three
  lists it runs are scaled *uniformly*, and RRF is scale-free, so its ordering is mathematically
  identical at `w = 0.25` and at `w = 50`. Two of the three modes in this table are constants, and
  they are printed at every row precisely so a reader can check that.
* **recall@5 is a plateau, not a spike**: 57/60 for every `w ≥ 4` — fourteen points wide including
  the off-grid probes below, and the whole plateau equals vectors-only exactly.
* **recall@1 is a broad hump**: 34–35 up to `w = 5`, then 36, **37, 38, 37, 37**. The maximum is one
  query above its neighbours.
* **`w = 0` is not what its name suggests** and this is the sweep's most surprising row. See §3.

### The two boundary claims in §0, and which one was wrong

§0 predicted that `w → ∞` would make hybrid converge on vectors-only, because the lexical lists'
contributions become numerically irrelevant. **The prediction is false and the table shows it**: at
`w = 50` the lexical lane is worth 3% of the semantic lane and hybrid is still 37/60 at recall@1
against vectors-only's 40/60. Chasing that down is what produced §2's finding, so the boundary
earned its place in the grid — by being wrong.

### The pre-declared refinement rule did not fire

The rule was: refine if the recall@1 maximum is interior *and* either neighbour is 2 or more below
it. The maximum (38 at `w = 12`) has neighbours at 37 and 37 — one below, on both sides. **No points
were added.** This is recorded because the temptation to "just check 10 and 15" after seeing a
maximum is exactly the drift the rule exists to stop.

### Off-grid probes — declared here as post-hoc, and not candidates for shipping

These are not part of the grid. They were run *after* the grid, to test the **mechanism** §2
proposes, and they are reported so that the mechanism can be checked rather than believed. None of
them is a configuration this task proposes to ship.

```
  configuration                                            bm25     vectors    hybrid   always
  P1  every lexical weight -> 0.001, vec 1.5              40/31      57/40     57/37    57/37
  P2  every lexical weight -> 0.001, vec 12               40/31      57/40     57/37    57/37
  P3  titles 0, cards_fts 0, vec 12                       40/31      57/40     56/38    56/38
  T4  vec_exchanges/vec_ghost_prompts 4, vec_cards 1.5    40/31      54/39     53/35    53/35
  T8  vec_exchanges/vec_ghost_prompts 8, vec_cards 1.5    40/31      54/39     54/37    54/37
  T12 vec_exchanges/vec_ghost_prompts 12, vec_cards 1.5   40/31      54/39     54/37    54/37
  D8  vec 8, cards_fts scaled with it to 6.4              40/31      57/40     57/34    57/34
  D12 vec 12, cards_fts scaled with it to 9.6             40/31      57/40     57/34    57/34
```

**The maximum of every configuration measured in this report, on or off grid, is hybrid 57/38 at
recall@5/recall@1. Vectors-only is 57/40. The gap at recall@1 was never closed and never tied.**

---

## §2 THE FINDING, THE CHOICE, AND WHAT IT COSTS

### §2.1 The most important sentence in this report

**No weighting makes hybrid beat vectors-only at recall@1 on this corpus, and the reason is not the
weights.** Since FIX-I the page is *selected* by the fused score and *ordered* by calibrated
confidence — and **calibration never reads a weight.** `calibrate()` is

```
calibrated = coverage x (WEIGHT_BASE + WEIGHT_STRENGTH * strength + WEIGHT_AGREEMENT * agreement)
```

whose three inputs are `covered/terms` (how much of the query the row's own text contains),
`from[].raw` relative to its list's best (each list's *own* magnitude, never its weighted
contribution), and `lists.size` (how many lists found the row). `WEIGHTS` enters the pipeline at
exactly one place —

```ts
const contribution = weight * rrfScore(rank, k);
```

— which feeds `score`, which is the **fourth** key of `byLabel`, behind the lane, the confidence
word and `calibration.score`. So a weight can change *which rows reach the page* and can break ties
inside a calibration band, and that is the whole of its authority over the number the gate measures.

**Measured, not argued.** At the corner of weight space where the lexical lane contributes exactly
nothing to the fused score (all five lexical weights set to 0, the lists still running):

```
queries=60   sameMembership=60/60   sameOrder=17/60   sameTopRow=52/60
```

Hybrid's page holds **exactly the same rows as vectors-only on all sixty queries** — and still
disagrees about the top row on eight of them, losing three net at recall@1 (37 against 40). At that
corner the weights have no remaining work to do: membership is already identical, so nothing a
weight can change is left. The residual is entirely the lexical lists' effect on `strength` and
`agreement`, which is weight-invariant by construction.

Here is one of the eight, at `w = 12`, with the calibration inputs printed (ids elided to eight
characters; this is the committed synthetic fixture, not any real archive):

```
# hybrid   :: the search box that only worked if you got the word exactly right
  [0] 5e91d7b2 cal=0.264 cov=0.29 str=1.00 agr=0.50 lists=[vec_exchanges,exchanges_fts,cards_fts,vec_cards]
  [1] a17c5e93 cal=0.241 cov=0.29 str=0.97 agr=0.00 lists=[vec_exchanges,cards_fts,vec_cards]   <- the answer
# vectors  :: the same query
  [0] a17c5e93 cal=0.241 cov=0.29 str=0.97 agr=0.00 lists=[vec_exchanges,vec_cards]             <- the answer
  [1] 5e91d7b2 cal=0.228 cov=0.29 str=0.79 agr=0.00 lists=[vec_exchanges,vec_cards]
```

The wrong block and the right block have the **same coverage**. What separates them is that in
hybrid the wrong block is also the *best bm25 row in its own lexical list*, which sets its
`strength` to 1.00 and its `agreement` to 0.50, and 0.264 sorts above 0.241. That is the fusion's
lexical half buying the wrong row a better label. **No value of any weight moves either number.**

**The reading.** The instrument is right and it is pointing at something real, but it is not
pointing at the weights. It is pointing at the fact that since FIX-I the fusion no longer decides
the order of the page — the calibrator does — and a lane that contributes candidates also
contributes corroboration, which the calibrator rewards whether or not the corroboration is any
good. On this corpus, at recall@1, **fusion no longer earns its place**: on the discordant queries
at the best point measured, hybrid wins 2 and loses 4 (exact binomial p = 0.688 — statistically a
coin flip, exactly the shape T10.10 reported for hybrid−bm25 at recall@1, p = 0.625), and the point
estimate is two queries down.

**That is a product ruling and this task does not act on it.** The options it opens — letting the
fused score outrank `calibration.score` inside a band, or docking corroboration that comes from a
lane the row did not need, or accepting that `find` should run the semantic lane alone on an
embedded index — all change either FIX-I's C-1 fix or the calibrator, neither of which is in this
task's deliver list, and each of which is a decision above it.

### §2.2 What was changed, and why, **by recall**

```diff
-  vec_exchanges: 1.5,
-  vec_ghost_prompts: 1.5,
-  vec_cards: 1.5,
+  vec_exchanges: 8,
+  vec_ghost_prompts: 8,
+  vec_cards: 8,
```

**Hybrid's recall at the chosen point is 57/60 at recall@5 (95%) and 37/60 at recall@1 (62%).
Vectors-only is 57/60 and 40/60. The distance is zero at recall@5 and three queries at recall@1.**
It is not a tie at recall@1 and this report does not call it one.

Against what ships today (`w = 1.5`, hybrid 55/35) the change is measured as:

| | recall@5 | recall@1 |
|---|---:|---:|
| hybrid at `w = 1.5` | 55/60 | 35/60 |
| hybrid at `w = 8` | **57/60** | **37/60** |
| paired, per query | +2 gained, 0 lost (p = 0.50) | +3 gained, 1 lost (p = 0.63) |
| split half, even queries | 30/30 both | 17/30 → 18/30 |
| split half, odd queries | 25/30 → 27/30 | 18/30 → 19/30 |

Neither metric's improvement is statistically significant on 60 queries and this report does not
claim otherwise. What it claims is weaker and checkable: **the improvement is in the same direction
on both metrics, in both split halves, and on a 75%-warm index**, and it costs nothing anywhere it
was measured. The one query it loses is named in §4.

**Why 8 and not 12.** 12 is the argmax and scores one query more at recall@1. §0's rule, written
before the sweep, says a one-point maximum its neighbours do not support is noise wearing a number,
and both of 12's neighbours are one below it. 8 is the **smallest weight on both plateaux** —
recall@5 is at its ceiling of 57 from `w = 4`, recall@1 is at 37–38 from `w = 8` — which makes it
the least change from the recorded stopping rule that buys the whole measured gain.

**Why all three lists move together.** The two transcript lists were already required to be equal
(same model, same kind of text). `vec_cards` joins them because it is the only configuration
measured: leaving it behind at 1.5 costs three queries at recall@5 (57 → 54, rows T4/T8/T12 in §1).
Its cost is named in §6.

**And the sentence the brief asked for explicitly: the weight that makes the product best and the
weight that makes the gate pass are not different, because there is no weight that makes the gate
pass.** `w = 8` is chosen on recall alone. It is the strongest evidence available that this is not
tuning to the test: after the change, the test still fails.

### §2.3 What it costs in latency

Nothing measurable. A weight changes no list's participation — every list that ran before still
runs — so the forward pass is paid exactly as often as before.

```
  w      bm25 p50/p95    vectors p50/p95    hybrid p50/p95    always p50/p95
    0     2 / 6 ms         42 / 70 ms        42 / 51 ms        43 / 56 ms
  1.5     4 / 10 ms        51 / 96 ms        43 / 55 ms        42 / 59 ms
  4.0     2 / 6 ms         50 / 111 ms       45 / 81 ms        45 / 59 ms
  8.0     2 / 5 ms         45 / 87 ms        41 / 49 ms        42 / 52 ms
 12.0     2 / 5 ms         43 / 66 ms        43 / 59 ms        41 / 51 ms
 50.0     2 / 5 ms         43 / 61 ms        42 / 86 ms        43 / 55 ms
```

The spread across the column is run-to-run noise on a shared machine, not a trend: `w = 8` is the
fastest row *and* `w = 4` is the slowest, which is what noise looks like. The release run reports
`hybrid p50 40 ms · p95 44 ms` against bm25's `p50 4 ms`. **The 52 ms the brief names is the price
of the semantic lane existing, and this change does not move it.**

### §2.4 What it does on a warming index — and a finding that is not about weights

`index` embeds newest-first (`ORDER BY ts IS NULL, ts DESC`), so a warming index holds the **newest**
rows and is missing the oldest. That is what was simulated: the eval's own real embeddings, with the
oldest fraction of `vec_blob_exchanges` / `vec_blob_ghost_prompts` / `vec_blob_cards` deleted, then
the eval re-run against the result. The fixture's timestamps are real (120 exchanges,
2026-06-01 → 2026-07-03, none null), so "newest first" is a real ordering here and not a rowid.

```
  embedded    w      bm25@5/@1    vec@5/@1    hybrid@5/@1
      0%     any       40/31        0/0         40/31      <- identical to bm25, at every weight
     25%     any       40/31       16/14        39/29
     50%     any       40/31       31/23        31/18
     75%     1.5       40/31       44/33        46/28
     75%     4.0       40/31       44/33        47/30
     75%     8.0       40/31       44/33        47/32
     75%    12.0       40/31       44/33        47/32
    100%     1.5       40/31       57/40        55/35
    100%     4.0       40/31       57/40        57/35
    100%     8.0       40/31       57/40        57/37
    100%    12.0       40/31       57/40        57/38
```

**The weight is not the problem on a warming index.** At 0%, 25% and 50% embedded the result is
*weight-invariant* — every value of `w` from 1.5 to 12 gives the same numbers to the digit — and at
75% the heavier weight is strictly better (46/28 → 47/32). There is no regime in which `w = 8` is
worse than `w = 1.5`. The brief's test — *a weight that is right on a fully embedded index and wrong
on a warming one is not right* — is passed, and it is passed for a structural reason: while the lane
is thin, the calibrated ordering is doing the work and the fused score is barely consulted.

**But the table contains something worse than a weight problem, and it is not this task's to fix.**
At 50% embedded, hybrid is **31/18** — far below bm25-only's 40/31, and below vectors-only's 31/23.
A half-warm index makes `find` worse than either lane alone. A control run pins the cause: with a
**random** 50% embedded rather than newest-first 50%, hybrid is 41/29 — normal.

```
  newest-first 50% embedded   bm25 40/31   vectors 31/23   hybrid 31/18
  random       50% embedded   bm25 40/31   vectors 35/29   hybrid 41/29
```

So the collapse is **recency bias**, not thinness: a half-warm lane can only answer semantically
about *recent* sessions, and the calibrated ordering then floats those recent rows above the older
rows the lexical lane found correctly. It is weight-invariant, it exists at the shipped `1.5`
exactly as much as at `8`, and this change neither causes nor worsens it.

**What `auto` should do, in each regime, stated as a recommendation and not implemented here:**

* **0% embedded** — what it does now is right. `vectorState` reports the lane unavailable, `auto`
  never wakes it, and hybrid is byte-identical to bm25-only (40/31 at every weight). `find` already
  prints the warming line; `tests/find-warming.test.ts` pins that it says so and pins that it stops
  saying so when every row is embedded.
* **partially embedded** — **`auto` should not consult the semantic lane at all until it covers the
  corpus**, or should consult it only for rows inside the embedded window. Measured, a half-warm
  lane costs nine queries at recall@5 and thirteen at recall@1 against simply not using it. That is
  the largest single number in this report and it is not a weight.
* **100% embedded** — consult it, at the weight this task ships.

---

## §3 `--vector-weight 0` STILL FAILS — and it fails for a weaker reason than the repository thinks

Pasted from the run, on this commit, with the change in:

```
$ pnpm evals -- --vector-weight 0 ; echo "EXIT=$?"
  vector weight 0 · OVERRIDDEN (shipped: 8) · this is a probe, not the release gate

  bm25 only       recall@5  40/60  67%     recall@1  31/60  52%    p50 3ms  p95 9ms
  vectors only    recall@5  52/60  87%     recall@1  37/60  62%    p50 40ms  p95 63ms
  hybrid (auto)   recall@5  52/60  87%     recall@1  33/60  55%    p50 42ms  p95 52ms
  hybrid (always) recall@5  52/60  87%     recall@1  33/60  55%    p50 42ms  p95 54ms

  phase-3 gate · amended 22 aug 2026 (phase 8.5), by the author of the original
  hybrid ≥ both singles at recall@5 (a 60-query set saturates there) and strictly > both at
  recall@1 (the row the user actually sees), with recall@5 ≥ 51/60
  hybrid (auto)     recall@5  52/60   ✓ ≥ bm25 (40)      ✓ ≥ vectors (52)     ✓ ≥ 51/60
                    recall@1  33/60   ✓ > bm25 (31)      ✗ > vectors (37)     FAIL
  hybrid (always)   recall@5  52/60   ✓ ≥ bm25 (40)      ✓ ≥ vectors (52)     ✓ ≥ 51/60
                    recall@1  33/60   ✓ > bm25 (31)      ✗ > vectors (37)     FAIL
  FAIL — the amended phase-3 gate would not merge this fusion
EXIT=1
```

**It fails. It fails on one clause, and it failed on one clause before this change too.**

`--vector-weight 0` replaces the shipped value outright, so this run is *identical* before and
after — the grid's `w = 0` row, produced on the parent's build, is the same 52/33 · 52/37 · 40/31.
This change cannot have weakened the regression check, and did not.

But the check is weaker than the repository records, and a reader of `evals/gate.ts` and
`tests/evals-gate.test.ts` should know it. Both say the probe fails on **two independent** clauses —
that it "collapses hybrid onto bm25 and therefore ties it at recall@1", and that it "lands 11 under
the floor". Measured on this commit it does neither: hybrid is 52/33 against bm25's 40/31, so it
**beats** bm25 at recall@1 and clears the floor by one. It fails only on `> vectors`.

The cause is the same one as §2.1. **A weight of 0 no longer removes the semantic lane; it only
removes its contribution to the fused score.** The three vector lists still run, still admit
candidates, and still count toward `strength` and `agreement` — and since FIX-I those are the
primary sort key. The difference between "weighted to nothing" and "not run at all" is measured
right here in this table: `hybrid` at `w = 0` is 52/33, `bm25 only` — the same lists minus the
semantic three — is 40/31. **Twelve queries at recall@5 are bought by lists whose weight is zero.**

Those numbers in `tests/evals-gate.test.ts` (`REGRESSION = bm25 39/24, vectors 12/9, hybrid 40/24`)
and its header paragraph are a record of a run made **before FIX-I**, on the ordering FIX-I
replaced. They were already stale at `bde6f73`. **They were not touched here**: the file's layer-1
assertions are shape tests over numbers the file writes itself and they still test what they say,
and re-recording a run that no longer passes into a fixture whose test asserts `pass === true` would
turn a correct unit test red for a wrong reason. Re-recording them, and deciding whether
`--vector-weight 0` is still an adequate proof that the benchmark can fail, is a ruling for the
owner of the gate. **It is flagged, not fixed.**

---

## §4 THE PER-QUERY BASELINE — what moved, and what regenerating it hides

Regenerated deliberately. `pnpm evals -- --json | node scripts/write-eval-baseline.mjs` could not be
used *literally*: `pnpm` appends its own ` ELIFECYCLE Command failed with exit code 1` line to
**stdout** when the eval exits non-zero, and `write-eval-baseline.mjs` parses from the first `{` to
end-of-input, so the documented pipeline cannot regenerate a baseline for a run that fails the gate.
The run used is the same run by the same script, with `pnpm`'s wrapper removed:

```
$ npx tsx evals/run.ts --json > run.json      # this is exactly what `pnpm evals` executes
$ node scripts/write-eval-baseline.mjs < run.json
  wrote evals/per-query-baseline.json — 4 modes x 60 queries
```

Afterwards `pnpm evals` prints no flip list at all, which is the check that the file matches the run.

### What moved, decomposed into whose change it was

The committed baseline was pinned **before FIX-I**, against an ordering that no longer exists. So the
flips it reports are two changes stacked, and they are separated here rather than reported as one
number:

| | lost @5 | gained @5 | lost @1 | gained @1 |
|---|---:|---:|---:|---:|
| committed baseline → parent `bde6f73` (**FIX-I's**, already on main) | 5 | 19 | 23 | 60 |
| parent `bde6f73` → this branch (**this change's**) | **0** | **4** | **2** | **6** |
| committed baseline → this branch (what the file now records) | 5 | 23 | 21 | 62 |

The brief's expectation of "five losses and two gains" matches the **five** losses at recall@5
exactly; the gains are far larger than two — 19 at recall@5 and 60 at recall@1 on the parent alone —
because FIX-I lifted every mode. The five losses at recall@5, in full, with where the answer sits
now:

```
  bm25     rank 8   the search box that only worked if you got the word exactly right
  bm25     rank 8   old documentation coming above the page people actually needed
  vectors  rank 9   charged the customer twice because the client retried
  hybrid   rank 9   charged the customer twice because the client retried
  always   rank 9   charged the customer twice because the client retried
```

**All five predate this branch** — they are identical in the parent-commit column — and all five are
FIX-I's calibrated ordering moving an answer from inside the top five to just outside it. None of
them is at rank 20 or absent; every one is still on the page.

Hybrid's seven recall@1 losses against the old baseline are: `charged the customer twice…` (9),
`why one region file always landed later…` (2), `the search box…` (2), `what was the session about
people not being able to sign in` (3), `data leakage` (5), `where the pennies went…` (2), `rendering
an enormous bill…` (4). Six of the seven are now the second, third or fourth row.

### What **this change** moved, in full — six queries, and the one that got worse

```
  @1 GAINED  rank 2 -> 1   why the conversion chart said more finished than began
  @1 GAINED  rank 2 -> 1   why the overnight copy no longer finished in time
  @1 GAINED  rank 4 -> 1   why the pictures were suddenly twice as tall
  @5 GAINED  rank 6 -> 4   the pod kept getting killed even though the app was fine
  @5 GAINED  rank 6 -> 5   the cursor jumped away after the on-screen keyboard closed
  @1 LOST    rank 1 -> 5   data leakage
```

**`data leakage` is the cost and it is named rather than netted.** It is the shortest query in the
set — two words, both of them common — which is the case where the lexical lane is most likely to be
exactly right and the semantic lane most likely to find something merely adjacent. Weighting the
semantic lane five times heavier is precisely the trade that loses it. It is still on the page, at
rank 5. `bm25` and `vectors` did not move on a single query, at either metric, which is the
arithmetic check that this change touched only the fusion.

### Does regenerating hide a regression?

**No, and here is the argument rather than the assurance.** Three things had to be true and each was
checked:

1. **Nothing this branch did is being buried.** This change lost exactly one query at one metric
   (`data leakage` at recall@1) and it is named above, in the report, in the commit message, and in
   the sweep it came from. Zero queries were lost at recall@5.
2. **Nothing FIX-I did is being buried.** The five recall@5 losses and the twenty-three recall@1
   losses that the old baseline was still reporting are enumerated above and were already reported
   in `FIX-I-REPORT.md §3`, which said in as many words that the file "would be regenerated
   deliberately by whoever owns it". Every aggregate rose across that change; these are the
   individual rows that did not.
3. **The alternative is worse.** Left un-regenerated the file reports **111 flips on every run**,
   which is an alarm nobody can read and therefore an alarm nobody will read — the failure mode this
   repository has recorded three times. A baseline that fires on everything cannot name the one
   query that falls next.

The file now pins the best state every mode has been measured in: `bm25 40/31 · vectors 57/40 ·
hybrid 57/37 · always 57/37`.

---

## §5 THE NUMBERS

### `pnpm evals`, as shipped on this branch

```
  bm25 only       recall@5  40/60  67%     recall@1  31/60  52%    p50 4ms   p95 9ms
  vectors only    recall@5  57/60  95%     recall@1  40/60  67%    p50 41ms  p95 59ms
  hybrid (auto)   recall@5  57/60  95%     recall@1  37/60  62%    p50 40ms  p95 44ms
  hybrid (always) recall@5  57/60  95%     recall@1  37/60  62%    p50 42ms  p95 54ms

  hybrid (auto)     recall@5  57/60   ✓ ≥ bm25 (40)      ✓ ≥ vectors (57)     ✓ ≥ 51/60
                    recall@1  37/60   ✓ > bm25 (31)      ✗ > vectors (40)     FAIL
  FAIL — the amended phase-3 gate would not merge this fusion
  all 6 confidence controls ok
  no per-query flips against the regenerated baseline
EXIT=1
```

**`pnpm evals` exits 1. The ACCEPT list asks for exit 0 and this branch does not deliver it.** Three
of the gate's four conditions are met and one is not, and the one that is not is the one §2.1 shows
no weight can meet. What did change: `≥ vectors` at recall@5 was **failing** at `bde6f73` (55
against 57) and now **passes** (57 against 57).

| | before `bde6f73` | after this branch |
|---|---|---|
| bm25 only | 40/60 · 31/60 | 40/60 · 31/60 (unchanged) |
| vectors only | 57/60 · 40/60 | 57/60 · 40/60 (unchanged) |
| hybrid (auto) | 55/60 · 35/60 | **57/60 · 37/60** |
| gate clauses met | 3 of 4 | 3 of 4 (a different three: `≥ vectors` @5 now met) |

### The suites

| run | files | tests | skipped | failed | exit |
|---|---:|---:|---:|---:|---|
| `pnpm test` | 55 | **1975** | 0 | 1 | 1 |
| `POTSHERD_SQLITE=node pnpm test` | 55 | **1975** | 0 | 1 | 1 |

`0 skipped` verified by grep for the word, not by eye, on both runs. **1974 of 1975 pass on both
drivers.** The count is 1975 and not 1974 because this branch adds one test (§6); the file count is
55 on this checkout and was 55 at the parent — `npx vitest list --filesOnly` enumerates 55, of which
48 are under `tests/`.

The single failure, on both drivers, is the one the task was given:

```
 FAIL  tests/evals-gate.test.ts > pnpm evals, end to end (needs a cached model)
       > exits 0 as shipped and 1 with the vector weight forced to 0
       AssertionError: expected 1 to be +0        (tests/evals-gate.test.ts:301, shipped.code)
```

**It is still red. Making it green is the deliverable and it is not delivered**; §2.1 is why, and
the brief's instruction for that outcome — report it, do not act on it — is what was followed.

### Typecheck, privacy, vendor

```
$ pnpm typecheck                       core · bridges · cli · mcp  ->  4 of 4 Done
$ python3 scripts/check-privacy.py ; echo "PRIVACY_EXIT=$?"
  PRIVACY_EXIT=0
  privacy: 595 tracked text files swept, no real-corpus content, no pinned known violations left…
  id inventory: 186 distinct id-shaped tokens … 19 unaccounted (ceiling 19), pinned at 41
                occurrences across 17 files.
```

Read from `$?`, not from the last line — the final line is the header caveat that reads like a pass.
Run twice: once before this report existed and once after it was committed, because the report quotes
eight-character fixture ids and the id ceiling is a ratchet. Both runs: exit 0, **19 unaccounted
against a ceiling of 19** — unmoved. (`FIX-I-REPORT.md` records 590 swept files against 595 here;
the difference is other work already on `main`, not this branch.)

```
$ pnpm build && pnpm vendor
  plugins/claude-code/dist/potsherd.js  <-  packages/cli/dist/potsherd.js  (1114 KB)
  plugins/claude-code/dist/mcp.js       <-  packages/mcp/dist/index.js     (1614 KB)
$ git status --short plugins/
  (clean)
```

### Isolation, processes, disk

Every measurement in this report ran against `evals/fixture/` — the committed synthetic corpus — or
against copies of the index the eval builds from it, under `os.tmpdir()` and the session scratchpad.
Nothing outside the eval corpus was measured, so no `$HOME` relocation was required and none of
`~/.claude`, `~/.codex`, `~/.cursor`, `~/.pi`, `~/.gemini`, `~/.copilot`,
`~/.local/share/opencode` or `~/.potsherd` was written to; the only read of `~/.potsherd` is the
eval's own model-cache probe, which symlinks the 34 MB model rather than copying it.

**No detached embedder was spawned and nothing was killed.** The warming measurement needed real
embeddings and it has them — the eval embeds 120 exchanges in-process on every fresh build — so the
queue state was reproduced by deleting rows from a copy of a fully embedded index rather than by
racing a background pass. `ps -eo pid,command | grep "[p]otsherd"` at the end of the task shows two
processes, both `…/plugins/cache/potsherd/…/dist/mcp.js` belonging to the harness running this
session; neither was started by this task and neither was signalled.

```
disk before   199Gi   9.6Gi avail
disk after    199Gi    11Gi avail      (this task's scratch: ~25 MB, removed)
```

No `git fetch` of any kind was run in this worktree.

### Commits on `work/FIX-K`

```
3ccf0d7  phase 10 FIX-K: the sweep grid, written down before it is run
9a03caa  phase 10 FIX-K: the semantic lane at 8, the smallest weight on both plateaux
0eed1d7  phase 10 FIX-K: the per-query baseline, regenerated deliberately at the new weight
bfeb0c0  phase 10 FIX-K: vendored bundles rebuilt at the new weight
(head)   phase 10 FIX-K: the report — this file, the last commit on the branch

`3ccf0d7` is the receipt for §0: it contains the grid and nothing else, and it is the first commit
on the branch. `git show 3ccf0d7 --stat` and `git log --reverse` both show it precedes every
measurement.
```

Nothing pushed, nothing merged.

---

## §6 WHAT I COULD NOT DO

### 1. Make the gate pass. This is the open item and it is a finding, not an omission.

`pnpm evals` exits 1 and `tests/evals-gate.test.ts` is red, on both drivers. The task asked for the
weight that makes the *product* best and said that if the honest answer is that no weighting closes
the gap, to report it plainly and not act on it. That is the answer, it is in §2.1, and the twenty
configurations in §1 plus the membership probe are the evidence. The decision that follows — whether
fusion still earns its place at recall@1 on this corpus, and if so what has to change for it to —
belongs to the orchestrator and above them meghavi.

### 2. Measure what raising `vec_cards` does to the routing lane

The change moves `cards_fts : vec_cards` from 1.2:1.5 to 1.2:8, which is the ratio that orders
card-only blocks among themselves — *which thread the routing lane offers first*. **The eval corpus
cannot see it**: across all 66 queries at `limit 20`, at both the old and the new weight, it produces
**zero** rows with `lane === 'routing'` (measured, not assumed). So this is a real unmeasured
consequence of the change. Three things bound it:

* The **safety** property is untouched. A card-only block sorts below every block with transcript
  evidence at *any* weight, because `LANES` is the first key of the comparator and not a score.
  `tests/cards-lane.test.ts` pins that at `WEIGHTS.cards_fts * 1000`.
* Restoring the ratio *was* measured and is not free: scaling `cards_fts` to 6.4 alongside costs
  three queries at recall@1 (37 → 34; rows D8/D12 in §1).
* Leaving `vec_cards` at 1.5 was measured too and costs three queries at recall@5 (57 → 54).

Someone with a corpus that produces routing rows should check the ordering there.

### 3. A comment in `WEIGHTS` that the measurement contradicts

`cards_fts`'s comment says that since T10.7 the card weights "only order the routing lane
internally". That is too strong: `CARDS_SCORE_EVIDENCE_BLOCKS` is `true`, so a card still
contributes to the fused score of a block that *does* have transcript evidence, and moving
`vec_cards` alone moves recall@5 by three queries. The comment on `vec_cards` was corrected in this
change; **`cards_fts`'s own comment was left alone**, because it is not a constant this task moved
and editing a neighbouring comment is how a diff stops being reviewable. It should be corrected.

### 4. `RRF_K` was not swept

It is the other fusion parameter and it lives in `packages/core/src/search/similarity.ts`, which is
not in the deliver list, and it is shared with `ask` and `browse`. §0 says so in advance. Given
§2.1 — the fused score is the fourth sort key — there is no reason to expect it would reach further
than the weights did, but that is an expectation and not a measurement.

### 5. The pinning test: added, not updated

`plans/09` rule 3 asks that a constant encoding a measured trade-off have a test that fails when it
moves. **The semantic lane's weight had no such test** — `1.5` appeared in comments, in
`evals/gate.ts`'s prose and in `evals/run.ts`'s `DEFAULT_VECTOR_WEIGHT` (which reads it from
`WEIGHTS`, so it cannot fail), and in no assertion anywhere. `tests/recall.test.ts` now has one, and
it was checked red first:

```
$ sed -i '' 's/vec_exchanges: 8,/vec_exchanges: 9,/' packages/core/src/recall.ts
 × recall: the fusion — T3.1 > pins the semantic lane at the weight FIX-K measured…
   → AssertionError: expected 9 to be 8
```

No assertion anywhere was weakened. `tests/evals-gate.test.ts` is not in this branch's diff.

### 6. Not attempted

`evals/gate.ts`, `evals/queries.jsonl` and `plans/**` were not opened for writing. The reserved
barrels — `packages/core/src/index.ts`, `packages/cli/src/index.ts`, `packages/mcp/src/index.ts` —
were not touched. The recency-bias collapse on a half-warm index (§2.4) is reported and not fixed;
it is weight-invariant, predates this branch, and its fix is a change to what `auto` does, which is
not a weight.

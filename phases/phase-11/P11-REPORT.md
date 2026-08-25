# P11 — why the corroboration reward puts the wrong row first, and the smallest change that fixes it

**Verdict: a defect, with a mechanism, proven on eight of eight — and a margin that is a coin flip
either side of it.** Both halves are true and the report says so in both directions. The defect is
that `agreement` counts *indexes* where its own denominator was derived from a count of *bodies of
evidence*; the coin flip is that whether fixing it wins or loses any one query is `p = 0.45` before
and `p = 0.625` after. The gate now passes. It passes on two rows out of sixty, and this report does
not call that significant.

Measured on `work/P11`, cut from `2e370b2`. Every command below was run on this checkout.

---

## §0 STEP 1 — the regression control, repaired before anything else

### What `--vector-weight 0` means today

It sets the weight of `vec_exchanges`, `vec_ghost_prompts` and `vec_cards` to zero **and nothing
else**. The three lists still run, still admit candidates, and still feed `strength` and `agreement`
to `calibrate()` — which since FIX-I is the *primary* sort key, `WEIGHTS` reaching only `byLabel`'s
fourth. Measured on the parent commit:

```
$ npx tsx evals/run.ts --vector-weight 0 ; echo "EXIT=$?"
  bm25 only       recall@5  40/60   recall@1  31/60
  vectors only    recall@5  52/60   recall@1  37/60
  hybrid (auto)   recall@5  52/60   recall@1  33/60
  hybrid (auto)     recall@5  52/60   ✓ ≥ bm25 (40)   ✓ ≥ vectors (52)   ✓ ≥ 51/60
                    recall@1  33/60   ✓ > bm25 (31)   ✗ > vectors (37)   FAIL
EXIT=1
```

**Twelve queries at recall@5 are bought by lists weighted to nothing** (52 against bm25's 40). It
clears the floor, it beats bm25 at recall@1, and it fails on the single clause the *shipped* build
already failed — so it proved nothing the release run did not.

### What I chose, and why

**I kept `--vector-weight` a weight and added `--no-vector-lists` as the control.** The alternative —
redefining a zero weight to mean "no lane" — was rejected for two reasons that are about not moving
the lie somewhere else:

1. `FIX-K-REPORT.md §0`'s exhaustiveness argument for the weight sweep is *RRF is linear in the
   weights*, and that needs `w = 0` to be a genuine member of the family — the limit of the points
   either side of it. A flag named `--vector-weight` that silently stops setting a weight at one end
   of its own range puts a discontinuity into the family the next sweep will trust.
2. At `w = 0` the **`vectors only`** comparison column is degenerate on its own terms: all three of
   its lists are weighted zero, every fused score is zero, and its order falls through to a
   tiebreak. A control whose comparison mode is meaningless cannot be the thing that proves the gate
   works.

`--no-vector-lists` drops the three vector lists from every mode, exactly as `--no-cards` drops the
two card lists, **on the same embedded index** — which is the same-index-A/B rule `--no-cards`'s own
docstring states. `--vectors` is forced off for those modes so the latency column is honest too.

### The two clauses, failing again

```
$ npx tsx evals/run.ts --no-vector-lists ; echo "EXIT=$?"
  semantic lane REMOVED · vec_exchanges, vec_ghost_prompts, vec_cards dropped from every mode
  · this is the regression control, not the release gate

  bm25 only       recall@5  40/60  67%   recall@1  31/60  52%   p50 3ms
  vectors only    recall@5   0/60   0%   recall@1   0/60   0%   p50 0ms
  hybrid (auto)   recall@5  40/60  67%   recall@1  31/60  52%   p50 3ms
  hybrid (always) recall@5  40/60  67%   recall@1  31/60  52%   p50 2ms

  hybrid (auto)     recall@5  40/60   ✓ ≥ bm25 (40)   ✓ ≥ vectors (0)   ✗ ≥ 51/60
                    recall@1  31/60   ✗ > bm25 (31)   ✓ > vectors (0)   FAIL
  FAIL — the amended phase-3 gate would not merge this fusion
EXIT=1
```

**Two independent clauses, from two different halves of the rule.** `tight.beatsBm25` is false —
hybrid is bm25 *to the digit*, 40/31 against 40/31. `clearsBar` is false — eleven under the 51/60
ratchet. These are exactly the two clauses `evals/gate.ts` had always claimed for its control and
had not been able to produce since FIX-I.

### What was corrected, and what was not

* `evals/gate.ts` — header rewritten with both runs pasted and reproducible. **No clause touched**;
  `judge()` is byte-identical, `PHASE_3_FLOOR` is byte-identical.
* `evals/run.ts` — the new flag, its argument, the help text, a `semanticLane` field in `--json`,
  and a `semantic lane present/REMOVED` line on the header of **every** run (a line that appears
  only when something is unusual is a line nobody learns to read).
* `tests/evals-gate.test.ts` — `REGRESSION` re-recorded from `bm25 39/24 · vectors 12/9 · hybrid
  40/24` (a pre-FIX-I run of a command that no longer does what it said) to today's `40/31 · 0/0 ·
  40/31`, plus a new end-to-end test that **pins the finding itself**: a zero vector weight is not
  the same thing as no lane, and it goes red if that ever stops being true.

`evals/queries.jsonl` and `plans/**` untouched.

---

## §1 STEP 2 — the eight, named, with every calibration term side by side

The population is the zero-lexical corner: every lexical weight at 0, the lists still running, so
nothing here can be a weight artefact. Reproduced exactly:

```
queries=60   sameMembership=60/60   sameOrder=17/60   sameTopRow=52/60
recall@1  vectors=40  hybrid=37        recall@5  vectors=57  hybrid=57
```

Ids are the committed synthetic fixture's, elided to eight characters. `cal` is the block's
calibrated score, `[counted]` the lists `calibrate()` was actually handed.

```
LOSS  v=1 h=2   why the overnight copy no longer finished in time
  4c07b9e3 ANSWER   vectors  cal=0.3346 cov=0.400 str=0.946 agr=0.000  [vec_exchanges]
                    hybrid   cal=0.3346 cov=0.400 str=0.946 agr=0.000  [vec_exchanges]
  c93f1e07          vectors  cal=0.3259 cov=0.400 str=0.859 agr=0.000  [vec_exchanges]
                    hybrid   cal=0.3559 cov=0.400 str=0.859 agr=0.500  [exchanges_fts,vec_exchanges]
  margin +0.0213    dCov 0.000   dStr -0.087   dAgr +0.500

LOSS  v=1 h=2   the upload that repeated itself when the app died halfway
  c93f1e07 ANSWER   vectors  cal=0.1417 cov=0.167 str=1.000 agr=0.000  [vec_exchanges]
                    hybrid   cal=0.1417 cov=0.167 str=1.000 agr=0.000  [vec_exchanges]
  f1c48b07          vectors  cal=0.1376 cov=0.167 str=0.901 agr=0.000  [vec_ghost_prompts]
                    hybrid   cal=0.1542 cov=0.167 str=1.000 agr=0.500  [ghost_prompts_fts,vec_ghost_prompts]
  margin +0.0125    dCov 0.000   dStr  0.000   dAgr +0.500

LOSS  v=1 h=2   the dependency that shipped every language it had ever supported
  ea4d7c60 ANSWER   vectors  cal=0.2125 cov=0.250 str=1.000 agr=0.000  [vec_exchanges]
                    hybrid   cal=0.2125 cov=0.250 str=1.000 agr=0.000  [vec_exchanges]
  7f3b2d48          vectors  cal=0.2125 cov=0.250 str=1.000 agr=0.000  [vec_exchanges]
                    hybrid   cal=0.2312 cov=0.250 str=1.000 agr=0.500  [exchanges_fts,vec_exchanges]
  margin +0.0187    dCov 0.000   dStr  0.000   dAgr +0.500

LOSS  v=1 h=2   the search box that only worked if you got the word exactly right
  a17c5e93 ANSWER   vectors  cal=0.2406 cov=0.286 str=0.969 agr=0.000  [vec_exchanges]
                    hybrid   cal=0.2406 cov=0.286 str=0.969 agr=0.000  [vec_exchanges]
  5e91d7b2          vectors  cal=0.2281 cov=0.286 str=0.793 agr=0.000  [vec_exchanges]
                    hybrid   cal=0.2643 cov=0.286 str=1.000 agr=0.500  [exchanges_fts,vec_exchanges]
  margin +0.0237    dCov 0.000   dStr +0.031   dAgr +0.500

NEUTRAL v=4 h=4   data leakage
  a82ceb72          vectors  cal=0.4208 cov=0.500 str=0.966 agr=0.000  [vec_exchanges]
                    hybrid   cal=0.4208 cov=0.500 str=0.966 agr=0.000  [vec_exchanges]
  c47b1a09          vectors  cal=0.4178 cov=0.500 str=0.942 agr=0.000  [vec_exchanges]
                    hybrid   cal=0.4625 cov=0.500 str=1.000 agr=0.500  [exchanges_fts,vec_exchanges]
  margin +0.0417    dCov 0.000   dStr +0.034   dAgr +0.500

GAIN  v=2 h=1   the thing quietly eating most of the cloud bill
  4ddd4b1f          vectors  cal=0.1700 cov=0.200 str=1.000 agr=0.000  [vec_ghost_prompts]
                    hybrid   cal=0.1700 cov=0.200 str=1.000 agr=0.000  [vec_ghost_prompts]
  d4b1f0a7 ANSWER   vectors  cal=0.1700 cov=0.200 str=1.000 agr=0.000  [vec_exchanges]
                    hybrid   cal=0.1850 cov=0.200 str=1.000 agr=0.500  [exchanges_fts,vec_exchanges]
  margin +0.0150    dCov 0.000   dStr  0.000   dAgr +0.500

LOSS  v=1 h=2   how many a second before the latency went off a cliff
  6b3a9e24 ANSWER   vectors  cal=0.1700 cov=0.200 str=1.000 agr=0.000  [vec_exchanges]
                    hybrid   cal=0.1700 cov=0.200 str=1.000 agr=0.000  [vec_exchanges]
  4ddd4b1f          vectors  cal=0.1683 cov=0.200 str=0.966 agr=0.000  [vec_ghost_prompts]
                    hybrid   cal=0.1833 cov=0.200 str=0.966 agr=0.500  [ghost_prompts_fts,vec_ghost_prompts]
  margin +0.0133    dCov 0.000   dStr -0.034   dAgr +0.500

GAIN  v=2 h=1   the submission that came back over a missing label
  47d9e281          vectors  cal=0.3400 cov=0.400 str=1.000 agr=0.000  [vec_exchanges]
                    hybrid   cal=0.3400 cov=0.400 str=1.000 agr=0.000  [vec_exchanges]
  f1c48b07 ANSWER   vectors  cal=0.3400 cov=0.400 str=1.000 agr=0.000  [vec_ghost_prompts]
                    hybrid   cal=0.3700 cov=0.400 str=1.000 agr=0.500  [ghost_prompts_fts,vec_ghost_prompts]
  margin +0.0300    dCov 0.000   dStr  0.000   dAgr +0.500
```

The same eight exist at the shipped weight (`w = 8`), the configuration the gate actually judges,
with one query substituted for another about the same session (`the batch job that overran the
backup window` for `why the overnight copy…`): **5 losses, 2 gains, 1 neutral, net −3.** That is the
whole of the gap.

---

## §2 THE EXPLANATION, AND WHETHER IT IS A DEFECT OR A COIN FLIP

### The hypothesis was tested, not assumed, and it holds — with a second term beside it

**`coverage` is identical on eight of eight.** It is the ceiling and it never moves; the coverages
are the coarse fractions a small distinctive-term set produces (1/6, 1/4, 2/7, 2/5, 1/2), and both
candidates always show the same number of them.

**`agreement` differs by exactly +0.500 on eight of eight, and it is worth 0.15.** Scaled by these
coverages that is 0.0125 to 0.0417 — which *is* the margin, to the digit, in the four cases where
`strength` also ties. `agreement` is the mechanism and the hypothesis is confirmed.

**`strength` is the second half of the same mechanism, in the term worth 0.25.** In three of the
eight it moves too, and always in the same direction: `+0.031`, `+0.034`, and `1.000` where
vectors-only measured `0.901`. `strengthOf` was `max` over lists, and `relativeStrength` normalises
each list against *that list's own best* — so every list donates a 1.0 to its own rank-1 row whether
that row is a bullseye or the least-bad of a bad list. Adding a lane could raise a row's strength
and could never lower it.

### What the corroboration actually was, in all eight cases

```
  exchanges_fts     beside  vec_exchanges        5 of 8
  ghost_prompts_fts beside  vec_ghost_prompts    3 of 8
  two different bodies of evidence               0 of 8
```

**Never once.** The reward of 0.15 was being paid for one exchange retrieved twice by two methods
out of one table — the archive having two indexes — not for a conversation having two kinds of
evidence. `calibrate()`'s own docstring says *how many lists **independently** put this row in their
candidates*, and `AGREEMENT_LISTS`'s docstring derives its value of three by naming three different
bodies of text (`exchanges_fts` + `titles` + `cards_fts`). The numerator and the denominator were
counting different things, and they agree only while the semantic lane is off.

**That is the defect, and it is not a tie-break artefact or a corpus accident.** It is a statement
about what the quantity measures that is wrong on every hybrid index, at every weight.

### The margins, and the statistics — the other half of the answer

Exact binomial over the discordant queries, two-sided:

```
  hybrid vs vectors, recall@1, BEFORE   2 wins  5 losses  p = 0.453
  hybrid vs vectors, recall@1, AFTER    3 wins  1 loss    p = 0.625
  the change itself, recall@1           6 gains 1 loss    p = 0.125
  hybrid vs vectors, recall@5, either   0 discordant      p = 1.000
```

**Three rows out of sixty was a coin flip, and two rows out of sixty is a coin flip.** `p = 0.625`
after the fix is the identical number `T10.10-REPORT.md` recorded for the ranker disagreement it
called a coin flip. The gate is a stopping rule and not a hypothesis test, and it now passes — but
nobody should read `42 > 40` as evidence that the fusion is better than the semantic lane on this
corpus. It is evidence that it is no longer measurably worse.

And one more thing worth having, because it changes what the three rows *were*:

```
  at find's own floor (minConfidence 'weak', what potsherd find actually runs at), BEFORE:
    queries where hybrid shows the user any row at all   12/60
    queries where vectors shows the user any row at all   9/60
    recall@1 among rows the user can see   hybrid 10   vectors 8
```

**Every row in the eight-query table above calibrates below `WEAK_FLOOR` and is labelled `none`.**
The recall eval measures `result.sessions` at `minConfidence: 'none'` — the unfiltered page. On the
page the product prints, hybrid already beat both singles at both metrics. This is *not* offered as
an argument about the clause, which stands; it is offered because "the calibrator is being used as a
ranker in the regime where it declares itself uninformative" is the sentence that explains why the
margins are 0.013 and not 0.075.

---

## §3 STEP 3 — what changed, why that shape, and the tests that fail when it moves

**One statement, applied to both places it is wrong:** *the eight lists are four bodies of evidence,
and two lists over the same body are one thing seen twice.*

```
  packages/core/src/recall.ts   + SOURCE_OF_LIST     the eight lists -> title | exchange | ghost | card
                                + evidenceSources()  what `calibrate({ lists })` is now passed
                                + combinedStrength() mean within a source, max across them
  packages/core/src/calibration.ts                   docstrings only — no constant moved
```

**No constant moved.** `WEIGHT_BASE` 0.6, `WEIGHT_STRENGTH` 0.25, `WEIGHT_AGREEMENT` 0.15,
`AGREEMENT_LISTS` 3, `WEAK_FLOOR` 0.5, `STRONG_FLOOR` 0.75, every entry of `WEIGHTS`, `RRF_K`,
`PHASE_3_FLOOR` — all byte-identical. `calibrate()`'s arithmetic is byte-identical. What changed is
what one caller counts, and how one caller combines.

**The grouping is a fact about the schema, not a judgement.** `exchanges_fts` and `vec_exchanges`
read `exchanges`; the three ghost lists read the ghost prompts; `cards_fts` and `vec_cards` read the
card; `titles` reads the title. `AGREEMENT_LISTS = 3` stays reachable — a title, a transcript hit
and a ghost hit is three — which is what its docstring always claimed for a bm25-only index. (Its
second example, *"the two ghost lists plus a title"*, was removed rather than corrected: it counted
`ghosts_fts` and `ghost_prompts_fts` as two, and they are one ghost at two granularities. That
sentence is where the confusion is visible in the file's own history.)

**Why `strength` moved too, and why shipping only the `agreement` half would have been the tuned
answer rather than the honest one.** Measured, both halves, on the shipped configuration:

```
  agreement over sources only              hybrid 58/39      recall@5 BEST measured, gate still FAILS
  strength within-source only              hybrid 57/37      no change at all
  both (shipped)                           hybrid 57/42      gate PASSES
```

The `agreement`-only variant scores **58** at recall@5 — one better than what I am shipping — and I
am not shipping it, because applying the insight to one of the two places it is wrong and not the
other is the arbitrary choice. `strength`-only is a no-op, which is what the arithmetic predicts:
while `agreement` still pays 0.075·coverage for a duplicate index, it swamps strength differences of
0.03. The two are one change.

**Why `mean` within a source and not `min`.** `max` believes whichever method is more optimistic,
`min` whichever is more pessimistic; the mean is the only one of the three that treats two views of
one document symmetrically. Across sources `max` is untouched and right — different evidence, the
best of it is what the row can show.

**The tests that fail when it moves** (`plans/09` rule 3, both directions):

* `tests/recall.test.ts` · `the corroboration reward counts sources, not lists (P11)` — pins
  `SOURCE_OF_LIST` as exhaustive over `LISTS`, pins each same-source pair at 1, pins
  `exchanges_fts + titles + cards_fts` at `AGREEMENT_LISTS`, and asserts end-to-end that the
  `agreement` `recall()` publishes is the one the partition implies for every block on a page.
* `tests/recall.test.ts` · `strength averages within a source and maxes across (P11)` — pins the
  operator on numbers the file writes itself, including the property that *a lane can now lower a
  row as well as raise it*, which is exactly what `max` made impossible.
* `tests/calibration.test.ts` · `one extra body of evidence is worth exactly half the agreement
  term` — pins the step at `WEIGHT_AGREEMENT / 2` and, scaled by a coverage of 0.25, at the size of
  the margins measured in §1.

---

## §4 STEP 4 — the re-measurement

### `pnpm evals`, all four modes, both metrics

```
$ npx tsx evals/run.ts ; echo "EXIT=$?"
  vector weight 8 · the phase-3 stopping rule, unchanged by the §8.5 amendment
  semantic lane present · all eight lists available to every mode that asks for them

  bm25 only       recall@5  40/60  67%   recall@1  31/60  52%   p50 3ms   p95 8ms
  vectors only    recall@5  57/60  95%   recall@1  40/60  67%   p50 40ms  p95 61ms
  hybrid (auto)   recall@5  57/60  95%   recall@1  42/60  70%   p50 38ms  p95 46ms
  hybrid (always) recall@5  57/60  95%   recall@1  42/60  70%   p50 39ms  p95 44ms

  hybrid (auto)     recall@5  57/60   ✓ ≥ bm25 (40)   ✓ ≥ vectors (57)   ✓ ≥ 51/60
                    recall@1  42/60   ✓ > bm25 (31)   ✓ > vectors (40)   PASS
  PASS — the amended phase-3 gate would merge this fusion
EXIT=0
```

**recall@5 is 57, unchanged.** recall@1 is 42, up 5. All six confidence controls still `ok`.
Latency unchanged — no list's participation moved.

### Every flip, named and decomposed

```
  bm25      @5 40 -> 40   @1 31 -> 31    ZERO flips at either metric
  vectors   @5 57 -> 57   @1 40 -> 40    ZERO flips at either metric
  hybrid    @5 57 -> 57   @1 37 -> 42    9 flips:

    gain @1  rank 2->1   the upload that repeated itself when the app died halfway        (§1)
    gain @1  rank 2->1   the dependency that shipped every language it had ever supported (§1)
    gain @1  rank 2->1   the search box that only worked if you got the word exactly right(§1)
    gain @1  rank 2->1   how many a second before the latency went off a cliff            (§1)
    gain @1  rank 2->1   the batch job that overran the backup window                     (§1)
    gain @1  rank 2->1   some traffic kept reaching the previous version after we switched
    LOST @1  rank 1->2   why the pictures were suddenly twice as tall
    gain @5  rank 8->3   the machine that kept running out of space because old images piled up
    LOST @5  rank 5->6   we made the background job defer to the webhook  (just off the first page)
```

**Five of the six recall@1 gains are five of the five losses §1 named.** That the change moves
exactly the queries the diagnosis predicted, and that `bm25` and `vectors` do not move a single
query at either metric, is the arithmetic check that this touched only the fusion — the same check
`FIX-K-REPORT.md §4` used. The two costs are named rather than netted: `why the pictures were
suddenly twice as tall` is at rank 2, `we made the background job defer to the webhook` at rank 6.

### Robustness — and one split that does not support it

```
  by class   concept  11/27 -> 13/27  +2      ranking  22/29 -> 25/29  +3      recall  4/4 -> 4/4  =
  by needs   text     21/36 -> 24/36  +3      ghost     9/12 -> 10/12  +1
             sidechain 3/6  ->  4/6   +1      card       4/6 ->  4/6   =
  even/odd   even     18/30 -> 24/30  +6      odd       19/30 -> 18/30  -1
```

**No stratum falls, on either stratification that means anything** — and the even/odd split, which
FIX-K used, is reported because it is the one that looks bad: all six gains land on even indices.
That split is **not a random split of this file**: even positions hold 11 `text/ranking` queries
against odd's 6, and odd holds 10 `text/concept` against even's 6. With seven discordant pairs in
sixty queries no split-half has power either way, and this report claims nothing from it in either
direction.

### The half-warm index

FIX-K's simulation, re-derived here (the oldest half of `vec_blob_exchanges`,
`vec_blob_ghost_prompts` and `vec_blob_cards` deleted from a copy of a real eval index, then the
eval re-run against it), paired before and after on the **identical** simulated index:

```
  50% embedded      bm25      vectors     hybrid BEFORE    hybrid AFTER
  newest-first     40/31      31/23         34/21            35/26
  random           40/31      37/32         40/28            40/31
```

**The recency bias is pre-existing, it is still there, and this change reduces it without curing
it.** Newest-first 50% gains +5 at recall@1 and +1 at recall@5; the random control gains +3 at
recall@1. Hybrid is still below bm25-only on a newest-first half-warm index (35/26 against 40/31),
which is the `auto`-design finding FIX-K handed over and this change does not claim to close.

**My simulation is not byte-identical to FIX-K's** and I do not compare against its numbers. Its
`vectors only` column reproduces exactly (31/23 newest-first) and `bm25` reproduces exactly (40/31),
so the instrument agrees where it should; the `hybrid` columns differ, so every hybrid comparison
above is before-against-after **on my own cut**, run in the same session, on the same files.

### `evals/per-query-baseline.json`

Regenerated deliberately, through the documented pipeline — which works again now that the run exits
0:

```
$ pnpm evals -- --json > run.json && node scripts/write-eval-baseline.mjs < run.json
  wrote evals/per-query-baseline.json — 4 modes x 60 queries
```

18 lines changed, all of them the nine hybrid and nine `always` flips enumerated above. A following
`npx tsx evals/run.ts` prints no flip list at all, which is the check that the file matches the run.
Nothing is buried: `bm25` and `vectors` changed on zero queries, so there is no third change hiding
under the second.

### The suites, the drivers, and the guards

```
  pnpm test                          55 files · 1984 passed · 0 skipped · exit 0
  POTSHERD_SQLITE=node pnpm test     55 files · 1984 passed · 0 skipped · exit 0
  pnpm typecheck                     core · bridges · cli · mcp  ->  4 of 4 Done
  python3 scripts/check-privacy.py ; echo "PRIVACY_EXIT=$?"   ->   PRIVACY_EXIT=0
  pnpm build && pnpm vendor          2 files, 2.7 MB vendored; plugins/ committed and clean
```

`tests/evals-gate.test.ts` is **green**, including both end-to-end runs. `0 skipped` was verified by
grep on both drivers, and it is worth recording *why* it took a second run to get there: with `$HOME`
relocated, six adapter tests that read `~/.claude`, `~/.codex` and `~/.pi` skip themselves. Those
directories are read-only inputs and `tests/setup.ts` sandboxes every write (`POTSHERD_DIR` and
`CLAUDE_CONFIG_DIR` are both repointed at a fresh temp root by the suite itself), so the numbers
above are from runs with the real `$HOME` and the sandbox the suite provides. Every **measurement**
in this report was made under the relocated `$HOME`.

Isolation, processes, disk: all eval work under `--potsherd-dir "$(mktemp -d)"` or the run's own
temporary fixture root, all of it deleted. `ps` before and after showed no `tsx`, `vitest` or
embedder process left behind — nothing had to be killed, so no pid was killed. `df -h` 8.1 GiB
before, 7.1 GiB after (the temporary indexes, since removed). No `git fetch` of any kind was run.

---

## §5 WHAT I COULD NOT DO

**1. I could not make the margin significant, and I am not pretending otherwise.** The gate passes
at 42 against 40, `p = 0.625`. If the decision that follows needs a fusion that is *measurably*
better than the semantic lane at recall@1 on this corpus, this is not that, and no calibrator change
will be — the two modes hold identical rows on 60 of 60 queries at the corner, so the entire
available signal is the order of pages that contain the same conversations.

**2. `bm25-cold → vectors-when-warm, never-partial` is still the right question and I did not build
it.** §4's half-warm table is the evidence for it and this change does not remove it: hybrid on a
newest-first half-warm index is still worse than bm25 alone. That is a phase-scale change to `auto`,
it needs its own ruling, and `FIRST-JOB.md` says so.

**3. The honest rename, deliberately not made.** `RowEvidence.lists` and `AGREEMENT_LISTS` now both
count *sources*, and their names say *lists*. Renaming them touches
`packages/core/src/index.ts` (RESERVED) and `tests/cards-lane.test.ts` (not in my deliver list), so I
stopped at the boundary and sharpened the docstrings instead. The exact patch, when someone owns
those files:

```diff
--- a/packages/core/src/calibration.ts
-export const AGREEMENT_LISTS = 3;
+export const AGREEMENT_SOURCES = 3;
+/** @deprecated the name says lists; it has counted sources since P11. */
+export const AGREEMENT_LISTS = AGREEMENT_SOURCES;
   interface RowEvidence {
-  lists: number;
+  sources: number;
--- a/packages/core/src/index.ts
-  AGREEMENT_LISTS,
+  AGREEMENT_LISTS,
+  AGREEMENT_SOURCES,
--- a/tests/cards-lane.test.ts        (both call sites, values unchanged)
-    const uncorroborated = { covered: 3, terms: 3, strength: 1, lists: 1 };
-    const corroborated = { covered: 3, terms: 3, strength: 1, lists: 2 };
+    const uncorroborated = { covered: 3, terms: 3, strength: 1, sources: 1 };
+    const corroborated = { covered: 3, terms: 3, strength: 1, sources: 2 };
```

Worth noting what that patch does **not** change: a card corroborated by `vec_cards` is now one
source, not two, so a card-only row that used to reach `0.925` reaches `0.85`. Both are above
`STRONG_FLOOR` and `ROUTING_CEILING` caps it to `weak` either way, so `tests/cards-lane.test.ts`
passes untouched — but the number in its docstring is now one hop further from the cliff than the
prose implies, and whoever owns that file should re-read it.

**4. `RRF_K` and the diversification budgets were not swept.** Out of scope and not implicated: the
mechanism in §1 is visible at the corner where fusion contributes nothing.

**5. Not attempted.** The reserved barrels; `evals/queries.jsonl`; any clause of `judge()`; the
`plans/**` tree; anything touching a real archive.

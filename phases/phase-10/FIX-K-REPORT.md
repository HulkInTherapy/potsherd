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

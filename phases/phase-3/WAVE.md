# phase 3 — recall · wave tracker

Goal: `find` fuses exchanges, cards and ghosts across bm25 and vectors, with filters that compose,
and an eval set that proves hybrid beats either alone.

## the problem this phase exists to solve

**The fusion currently loses.** Measured three times, on two query sets, before and after cards:

```
bm25 only  8/10     vectors only  6/10     hybrid  6/10
```

`pnpm evals` prints the verdict against itself. `06`'s gate: *hybrid must beat bm25-only AND
vec-only on the same set, or the fusion is not merged.*

**Diagnosis already in hand:** vectors genuinely help where bm25 fails (they find a concept query
at rank 3 that bm25 misses entirely, and lift another from unfound to 6), but **ghosts carry no
embeddings and get drowned whenever the vec list is on**. Two obvious moves: embed ghost prompts,
or score a session's *absence* from a list rather than letting absence read as a low rank.

**If it cannot be made to win, it does not merge.** That is the plan's own answer, and the honest
shipping position is `--vectors auto` (bm25 answers; the model wakes only when bm25 found nothing)
with vectors documented as opt-in. The query set is not to be tuned to manufacture a pass.

## the wave

| stage | task | branch | status | notes |
|---|---|---|---|---|
| parallel | T3.4 the 25-query eval set + a real distractor pool | worktree | running | **the measuring instrument** — built first, and by someone other than the ranker author |
| parallel | T3.2 + T3.3 composable filters and `find --explain` | worktree | running | disjoint from `recall.ts` |
| after T3.4 | T3.1 + T3.5 the fusion itself, and its performance | — | pending | owns `recall.ts`; measured against the new set |
| verify | fresh verifier vs the definition of done | — | pending | never the author |

## definition of done (from `plans/phases/phase-3-recall.md`)

- [ ] `06` standard met
- [ ] hybrid ≥ 22/25 **and ≥ both singles** on the reference set; fixture set green in ci
- [ ] p50 < 150 ms
- [ ] filters documented in `--help` with one example each

## why the eval set is built first, and by a different worker

The first version of this set scored 10/10 and was worthless — every query was a bag of words
lifted near-verbatim from its target, over a pool of 11 candidates, where recall@5 could not fail.
A verifier caught it; the honest rewrite scored 8/10. The instrument has to be built by someone who
is not being judged by it.

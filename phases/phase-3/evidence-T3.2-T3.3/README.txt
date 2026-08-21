T3.2 (composable filters) + T3.3 (find --explain) — evidence
============================================================

Everything here was produced by the shipped binary against evals/fixture,
indexed into a throwaway directory:

  potsherd rescue --claude-dir evals/fixture/claude --potsherd-dir <tmp>
  potsherd index  --claude-dir evals/fixture/claude --potsherd-dir <tmp> \
                  --no-embed --harness claude

files
-----
  explain.txt   find --explain at 80 columns, at 60 --ascii, and a ledger with
                a title hit in it. Every run reports its widest line, counted
                in characters by python3 (wc -c lies about · ↳ → … ★).
  filters.txt   each filter alone, four at once, and the same four with one
                attribute changed so that nothing satisfies them — which is the
                run that distinguishes real AND from last-one-wins.
  help.txt      potsherd find --help, with one example per filter.

what recall.ts would have to expose to make --explain exact
-----------------------------------------------------------
`--explain` reconstructs the fusion from `RecallResult`, which reports
`{ list, rank, raw }` per hit but not the weight the fusion applied. The
effective weight is not the constant in `recall.ts`'s WEIGHTS table — `titles`
is scaled by query coverage and any relaxed list is multiplied by
RELAXED_PENALTY — so `search/explain.ts` *solves* for it from the scores
(a hit found by one list pins that list exactly). It is exact wherever a list
has a solo or one-unknown hit, which is every case observed, and marks a
fallback weight with `?` when it is not.

The clean fix, for whoever owns recall.ts:

  RecallResult.k: number                        the RRF k actually used
  RecallResult.weights: Record<ListName, number> the *effective* weight per
                                                list, after coverage and the
                                                relaxed penalty
  RecallResult.relaxedLists: ListName[]         which lists fell back to OR
  RecallHit.from[].contribution: number         weight / (k + rank)

With those four fields `explain()` drops the solver and reads them straight.
Nothing else about `--explain` depends on a change to recall.ts.

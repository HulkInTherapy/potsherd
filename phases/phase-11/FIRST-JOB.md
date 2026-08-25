# phase 11, first job — why the corroboration reward outranks the best row

**Written 25 aug 2026, at the end of phase 10, by ruling.** Not a plan; one question, with the
evidence already gathered, so that whoever picks it up does not re-derive any of it.

---

## the question

**Why does calibration's corroboration reward put the wrong row first in three cases, and what is
the smallest change that fixes them without costing the 57?**

That is the whole job. Everything below is evidence for it.

## the state it arises from

`pnpm evals`, on `f3d8411`, over the 60-query blind set (`evals/queries.jsonl`, built by a worker
told nothing about which way any number needed to move):

| mode | recall@5 | recall@1 |
|---|---:|---:|
| bm25 only | 40/60 | 31/60 |
| **vectors only** | **57/60** | **40/60** |
| hybrid (auto, shipped) | **57/60** | 37/60 |

The phase-3 gate requires hybrid to be **≥ both singles at recall@5** and **strictly > both at
recall@1**. It passes the first and fails the second by three rows. `pnpm evals` exits 1 and
`tests/evals-gate.test.ts` is red on `main` **by ruling, deliberately, and it must stay red until
this is answered.**

## what is already ruled out, with proof rather than inference

**It is not the weights, and no weight can close it.** Phase 10's `FIX-K-REPORT.md` swept the entire
one-parameter lexical:semantic family — 17 points from 0 to 50, the grid committed *before* it was
run, and RRF is linear in the weights so that family is exhaustive. Maximum over all 20
configurations measured: **hybrid 57/38.** Never tied, never beaten.

**The decisive measurement is the zero-lexical corner.** With every lexical weight at 0, hybrid's
page holds **the same rows as vectors-only on all 60 queries — membership 60/60 — and still
disagrees about the top row on 8 of them, losing 3 net at recall@1.** Same rows, different first
row. So the gap cannot be in selection and cannot be in the fusion; it is in the ordering.

**And the ordering is weight-free.** Since phase 10's FIX-I the page is *selected* by the fused
score and *ordered* by `byLabel`: lane → confidence word → calibration score → fused score.
`calibrate()` reads `coverage`, `from[].raw` and `lists.size` and **never reads a weight**;
`WEIGHTS` enters at one line (`weight * rrfScore`) and reaches only `byLabel`'s **fourth** key.
So a row corroborated by two lists outranks a better row found by one, and that is deliberate — it
is what `agreement` is for. In three cases it is wrong.

## the second finding, which shapes the answer

**A half-warm index is worse than either lane.** At newest-first 50% embedded, hybrid measures
**31/18** against bm25's 40/31. A random-50% control gives **41/29** — so it is **recency bias**,
weight-invariant, and pre-existing rather than introduced by phase 10.

Two consequences worth holding together:

1. `auto` should not consult a partial vector lane at all. It currently does.
2. **`vectors only` is not a shippable alternative** — it answers nothing on a cold index and badly
   on a half-warm one, and a real archive takes hours to embed. So the mode that beats hybrid at
   recall@1 is a mode a user cannot have for most of the lifecycle. That is an argument about the
   *clause*, and it was explicitly refused as a reason to change it tonight.

## the ruling this file exists under

Verbatim, from meghavi, 25 aug:

> The gate caught a calibrator defect, not a gate defect — the criterion stands. Land everything
> that's green, commit the full measurement, do not tag. … Phase 11 should also evaluate option 2's
> design (bm25-cold → vectors-when-warm, never partial) in daylight, as an outcome of understanding
> the calibrator — if that's where the evidence leads, the hybrid-beats-both clause gets rewritten
> for the new architecture, which is legitimate; bending it to pass tonight's build is not.

So the order of work is fixed: **understand the calibrator first.** A re-architecture of `auto` is a
legitimate *outcome* of that understanding and an illegitimate substitute for it. If the evidence
leads there, the clause may be rewritten **for the new architecture** — that is a different act from
rewriting it to pass.

## where to start

1. **Name the three queries.** `evals/per-query-baseline.json` and `npx tsx evals/run.ts --json`
   carry per-query results; the eight top-row disagreements at the zero-lexical corner are the
   population, and three of them are net losses.
2. **For each, print both orderings and both calibrations** — the row vectors-only puts first and
   the row hybrid puts first, with `coverage`, `strength`, `agreement` and `from[].raw` for each.
   The claim to test is that `agreement` is doing the damage.
3. `calibrated = coverage × (0.60 + 0.25·strength + 0.15·agreement)`, weights partitioning 1 so
   **coverage is a ceiling** — recorded in `plans/04`, 24 aug. `agreement` carries 0.15. Three rows
   is a small number; check whether the margin is small too, because a fix that moves 3 rows by
   moving a constant is the "constant encoding a measured trade-off" this project pins with a test.
4. **Whatever changes, `--vector-weight 0` must still fail the gate**, and phase 10 left that
   weaker than it found it: it now fails on **one** clause rather than two, because a zero weight no
   longer removes the semantic lane — only its fused contribution. The lists still run and still
   feed calibration, and zero-weighted lists buy 12 queries at recall@5. **The numbers recorded in
   `evals/gate.ts` predate FIX-I.** Fix that first; it is the check that proves the set can fail.

## the files

| | |
|---|---|
| the sweep, the corner proof, the warming measurement | `phases/phase-10/FIX-K-REPORT.md` |
| the ordering change that caused it | `phases/phase-10/FIX-I-REPORT.md` §3, §4.1 |
| calibration itself | `packages/core/src/calibration.ts`, and `recall.ts`'s `byLabel` |
| the blind query set and how it was built | `evals/queries.jsonl`, `phases/phase-10/T10.10-REPORT.md` |
| the gate's clauses and their origin | `evals/gate.ts`, `plans/06-QUALITY-AND-EVALS.md` |

## what would make this a bad answer

- A constant moved until three queries flip, with no account of *why* those three.
- A change that lifts recall@1 and drops the 57 at recall@5, reported as a win.
- Rewriting the clause. It stands until the architecture it describes has changed, and then it is
  rewritten *for that architecture* and argued in `plans/04`.

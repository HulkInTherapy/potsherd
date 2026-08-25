# GATE — re-scoping the retrieval gate to the surface the instrument measures

**Worker report, branch `work/GATE`, cut from `70dac23`. 25 aug 2026.**

**Lead: the re-scoped gate can still fail, and both halves of it can.** The ranker's comparative
clauses go red under `--no-vector-lists` (2 clauses) and under `--vector-weight 0` (2 clauses,
where the stale record claimed 1). The verb's ratchet goes red under a seeded one-answer
regression, end to end through `pnpm evals`, with every ranker clause staying green. Proofs in §2.

**What I did not do:** I did not lower a bar. `PHASE_3_FLOOR` is still `{hits: 51, of: 60}`, byte
for byte. Every comparative clause is still there, still strict where it was strict. What changed
is **which of two measurements each clause is handed**, plus one new clause the gate did not have.

---

## §0 what each clause judges, and on which surface

`recall()` has two behaviours and the project has two retrieval surfaces:

| surface | call | what it is |
|---|---|---|
| **the ranker** | `recall()` at `minConfidence: 'none'` | every row the fusion found. The shortlist `ask` and `graft` build on. |
| **the verb** | `recall()` at `weak` | the page `potsherd find` and `potsherd_recall` print. **The product.** |

Six clauses, in `evals/gate.ts`:

| # | clause | surface | measured `70dac23` | verdict |
|---|---|---|---|---|
| 1 | `wide.beatsBm25` — hybrid ≥ bm25 at recall@5 | ranker | 57 ≥ 40 | ✓ |
| 2 | `wide.beatsVectors` — hybrid ≥ vectors at recall@5 | ranker | 57 ≥ 57 | ✓ |
| 3 | `tight.beatsBm25` — hybrid **>** bm25 at recall@1 | ranker | 42 > 31 | ✓ |
| 4 | `tight.beatsVectors` — hybrid **>** vectors at recall@1 | ranker | 42 > 40 | ✓ |
| 5 | `clearsBar` — hybrid recall@5 ≥ 51/60 ratchet | ranker | 57 ≥ 51 | ✓ |
| 6 | `verb.holds` — hybrid ≥ 7/60 at recall@5 **and** ≥ 7/60 at recall@1 | **verb** | 7 ≥ 7, 7 ≥ 7 | ✓ |

`pass` is the conjunction of all six. A green ranker cannot buy a red verb and a green verb cannot
buy a red ranker.

Clauses 1–5 are **unchanged in value and in operator**. They are now read off the ranking view —
the view they were measured on in every run from phase 3 to 24 aug 2026, and the view C-1 pointed
them away from for one day. Clause 6 is new.

**Reported and never judged**, printed by `pnpm evals`, in the JSON, and on the `Gate` object:
empty pages (52/60) and answers ranked in the top 5 and withheld (50). See §4 for why neither is a
clause.

**The descoped criterion is not in `gate.ts` and is not marked met.** It is
`phases/phase-12/FIRST-JOB.md`, named from `ruleLine()` — so it appears in the terminal on every
run and in any screenshot of a pass — and named again in `gate.ts`'s header and in
`tests/evals-gate.test.ts`. A test asserts the string is in the printed rule, so deleting the
pointer turns a test red.

## §1 why the verb is ratcheted rather than compared, with the numbers

```
                    at the verb (weak)        at the ranking (none)     empty pages
  bm25 only      @5  8/60   @1  8/60      @5 40/60   @1 31/60           51/60
  vectors only   @5  8/60   @1  8/60      @5 57/60   @1 40/60           51/60
  hybrid (auto)  @5  7/60   @1  7/60      @5 57/60   @1 42/60           52/60
```

Re-measured on `70dac23` today, through the product's own instrument. It reproduces
`FIRST-JOB.md` and `C1-REPORT.md` §0 to the digit.

**At the ranking the comparison is a real claim and hybrid wins it.** 57/42 against bm25's 40/31
and vectors' 57/40. It ties vectors at recall@5 — a 60-query set saturates there, which is why 8.5
amended `>` to `>=` — and it **beats vectors by two at recall@1**, which is exactly what P11's
`agreement` fix bought (it was three *against* before). Keeping the comparative clauses here costs
nothing and asserts something true.

**At the verb hybrid is one BELOW bm25, and a comparative clause there would be red forever.**
8 / 8 / 7. C-1 measured the cause and it is not a defect:

- `weak` is a threshold on `calibration.score`, and `score = coverage × (0.60 + 0.25·strength +
  0.15·agreement)`. The bracket is a partition of 1, so **`score ≤ coverage` by construction**.
- `coverage` is the fraction of the query's **literal** terms the row repeats. It has no input
  that can carry *"the vector lane found this"*. **The floor is computed from wording, and no lane
  and no weight can change wording.**
- What the semantic lane *can* move is `strength`, and `combinedStrength` is a **mean within a body
  of evidence** by deliberate choice with its measurement in its own docstring. A row bm25 tops and
  the vector lane ranks eighth is averaged down — right for ordering, irrelevant to the floor.

So the fusion buys **seventeen** queries in the ranking and costs **one** at the floor. A clause
demanding `hybrid > bm25` at the verb would gate on `combinedStrength` working as designed, would
be red on every build this phase, and would teach the next reader to ignore the gate. That is the
failure mode `plans/08` rule 4 is about, arrived at from the other side.

**The ratchet instead**, which is the move `plans/04` recorded when phase 10 retired the 25-query
instrument and 22/25 became 51/60: pin the measured value, forbid it getting worse. `VERB_RATCHET =
{atK: 7, at1: 7, of: 60}`. Stated in `gate.ts` in terms that cannot be read the convenient way:
**the required count may only ever RISE; it may never be lowered — not by a point, not
"temporarily" — to let a build that regressed the verb go green.** If a change drops the verb 7→6
the change is red, not the constant.

**The ratchet ruling's condition (b) is already met on this surface, and I did not have to build
it.** `plans/04` (24 aug 2026) attached three conditions to any ratchet, and (b) is *a per-query
pin, so a regression names the query that fell rather than reporting a count.*
`compareToBaseline` in `evals/run.ts` reads `hitAt`, which since C-1 step 1 **is the verb's hit**,
and `evals/per-query-baseline.json` is in sync on `70dac23` — the shipped run reports no flips. So
a change that costs the verb one answer prints *which* query it lost, beside the ratchet going red.
A ratchet on a count plus an alarm that names the query is the pair that ruling asked for.

**Both `@5` and `@1` are pinned though they are equal today.** A page that survives the floor is
short, so 7 and 7. They are not the same number: a change leaving seven answers on the page but
pushing one off row 1 holds `atK` at 7 and drops `at1` to 6. A test seeds exactly that and it goes
red on `holdsAt1` alone.

## §2 the failure proofs

### 2a `pnpm evals` as shipped — exit 0

```
  bm25 only · find       recall@5   8/60  13%     recall@1   8/60  13%
    ranking              recall@5  40/60  67%     recall@1  31/60  52%    51/60 empty pages, 33 answers ranked and withheld
  vectors only · find    recall@5   8/60  13%     recall@1   8/60  13%
    ranking              recall@5  57/60  95%     recall@1  40/60  67%    51/60 empty pages, 49 answers ranked and withheld
  hybrid (auto) · find   recall@5   7/60  12%     recall@1   7/60  12%
    ranking              recall@5  57/60  95%     recall@1  42/60  70%    52/60 empty pages, 50 answers ranked and withheld

  the gap · hybrid (auto): the ranker puts the answer first for 42/60 queries; potsherd find
          prints it for 7. 52/60 pages come back empty. the second number is the product
          closing it is phase 12's named target · phases/phase-12/FIRST-JOB.md

  hybrid (auto) · ranker    recall@5  57/60   ✓ ≥ bm25 (40)      ✓ ≥ vectors (57)     ✓ ≥ 51/60
                            recall@1  42/60   ✓ > bm25 (31)      ✓ > vectors (40)
    · verb (ratchet)        recall@5   7/60   ✓ ≥ 7/60           recall@1   7/60  ✓ ≥ 7/60    PASS
                            52/60 empty pages, 50 answers ranked in the top 5 and withheld — reported, never judged
  PASS — the re-scoped gate would merge this fusion
```

All six confidence controls still pass; a red control still fails the run on its own.

### 2b `pnpm evals -- --no-vector-lists` — exit 1, RED on 2 ranker clauses

```
  ranker  bm25 40/31   vectors  0/0    hybrid 40/31
  verb    bm25  8/8    vectors  0/0    hybrid  8/8
  ✓ ≥ bm25 (40)   ✓ ≥ vectors (0)    ✗ ≥ 51/60
  ✗ > bm25 (31)   ✓ > vectors (0)    ✓ verb ≥ 7/60 @5 and @1
```

`clearsBar` (40 is eleven under the ratchet) and `tight.beatsBm25` (31 ties 31). **Two clauses,
from two different halves of the rule — the same two `gate.ts` recorded before the re-scope. This
control did not weaken.**

### 2c `pnpm evals -- --vector-weight 0` — exit 1, RED on 2 ranker clauses

```
  ranker  bm25 40/31   vectors 52/37   hybrid 50/38
  verb    bm25  8/8    vectors  8/8    hybrid  7/7
  ✓ ≥ bm25 (40)   ✗ ≥ vectors (52)   ✗ ≥ 51/60
  ✓ > bm25 (31)   ✓ > vectors (37)   ✓ verb ≥ 7/60 @5 and @1
```

`wide.beatsVectors` (50 < 52) and `clearsBar` (50 < 51).

**This control got STRONGER, and the audit trail matters.** `gate.ts`'s previous record — written
on `6a157fa`, one commit ago — had this probe red on **one** clause, `> vectors` at recall@1, and
observed that this was a clause **the shipped run also failed**, so the probe proved nothing the
release run did not. Re-measured on `70dac23` it is red on **two**, and the shipped run **passes
both**. Its recall@1 clause is now green (38 > 37) and is pinned as green, so a drift back turns a
test red. Phase 10 quietly weakened a control and it took a verifier to notice; the clause count
for each control is now written in `gate.ts` and asserted in the test, so moving it means saying so.

### 2d the seeded verb regression — exit 1, RED on the ratchet with the ranker untouched

`evals/run.ts`'s `scoreAt` patched to `… .length - 1` (the verb loses one answer, nothing else
touched), `pnpm evals`, then reverted:

```
  hybrid (auto) · ranker    recall@5  57/60   ✓ ≥ bm25 (40)      ✓ ≥ vectors (57)     ✓ ≥ 51/60
                            recall@1  42/60   ✓ > bm25 (31)      ✓ > vectors (40)
    · verb (ratchet)        recall@5   6/60   ✗ ≥ 7/60           recall@1   6/60  ✗ ≥ 7/60    FAIL
  FAIL — the re-scoped gate would not merge this fusion
```

**Every ranker clause green, the gate red.** That is the regression eight phases of ranker-only
numbers could not see, and it is the clause the re-scope adds.

### 2e neither existing control reddens the verb — stated, not hidden

`--no-vector-lists` and `--vector-weight 0` both attack the **semantic lane**, and the verb's floor
is computed from wording, which no lane can change. With the lane gone hybrid *is* bm25 and returns
**8** at the verb — one *more* than the ratchet. So `verb.holds` is `true` under both controls, and
`tests/evals-gate.test.ts` asserts that explicitly rather than leaving it to be discovered.

There is **no command-line switch that regresses the verb without regressing the ranker**, and I
did not invent one: a product flag that exists only to fail an exam is worse than the seeded patch
above. The seeded regression in §2d, plus the unit-level seeds in the test file, are the verb's
failure proof.

### 2f every new assertion red first

Three mutations, each run against the new test file, each reverted. Full transcript in §2f-log.

**A — `VERB_RATCHET` 7 → 8** (equivalently: the verb loses one answer): **6 red**

```
× RANKER clauses > passes the measured release run          → expected false to be true
× VERB ratchet  > holds at the measured value               → expected 8 to be 7
× VERB ratchet  > catches a demotion out of the top row     → expected false to be true
× VERB ratchet  > pins the ratchet, so lowering it cannot be done silently
                                → expected { atK: 8, at1: 8, of: 60 } to deeply equal { atK: 7, at1: 7, of: 60 }
× VERB ratchet  > does not compare the verb against a single lane   → expected false to be true
× VERB ratchet  > reports empty pages and the withheld count without judging either
Tests  6 failed | 8 passed
```

**B — `verb.holds` dropped from the `pass` conjunction** (the new clause made decorative): **2 red**

```
× VERB ratchet > goes red when the verb loses one answer, with the ranker untouched → expected true to be false
× VERB ratchet > catches a demotion out of the top row even when recall@5 holds      → expected true to be false
Tests  2 failed | 12 passed
```

**C — the comparative clauses pointed back at the verb** (the C-1 state, one day old): **7 red**

```
× RANKER clauses > passes the measured release run                                  → expected false to be true
× RANKER clauses > judges the comparative clauses on the ranking view, never the verb → expected 7 to be 57
× RANKER clauses > refuses a fusion under the ranker floor even when it beats both singles
× RANKER clauses > accepts a tie at recall@5 when recall@1 is a strict win
× VERB ratchet   > goes red when the verb loses one answer, with the ranker untouched
× VERB ratchet   > does not compare the verb against a single lane
× VERB ratchet   > reports empty pages and the withheld count without judging either
Tests  7 failed | 7 passed
```

## §3 the patch I propose for `plans/06` — which I did not edit

`plans/` is read-only to me. `plans/06-QUALITY-AND-EVALS.md`, lines 24–25, currently:

```
metric: recall@5 by session. gate: phase 1 ≥ 8/10 on bm25 alone; phase 3 ≥ 22/25 hybrid and
hybrid must beat bm25-only and vec-only on the same set, or the fusion is not merged.
```

Proposed replacement:

```
metric: recall@5 and recall@1 by session, measured at BOTH surfaces — `recall()` at `none` (the
ranking: every row the fusion found) and at `weak` (the verb: the page `potsherd find` prints).
Reporting one without the other is what this project did from phase 3 to 24 aug 2026, and the
ranking's numbers were shipped as the product's for eight phases.

gate: phase 1 ≥ 8/10 on bm25 alone.

phase 3, at the RANKING — hybrid ≥ bm25-only and ≥ vec-only at recall@5 (a 60-query set saturates
there), strictly > both at recall@1, and recall@5 ≥ a ratchet, or the fusion is not merged. The
ratchet was 22/25 on the 25-query set phase 10 retired and is 51/60 on the set that replaced it;
it may only ever tighten and may never be lowered to let a regression through.

phase 3, at the VERB — a ratchet on the judged mode alone, at the measured 7/60 at recall@5 and
7/60 at recall@1. NOT a comparison against a single lane: the `weak` floor is a threshold on
`calibration.score`, `score ≤ coverage` by construction, and `coverage` counts the query's literal
terms — so the floor is computed from wording and no lane and no weight can move a row across it.
Hybrid is one below bm25 here and that is `combinedStrength` working as designed. The required
count may only ever RISE; lowering it is the move this rule exists to forbid.

empty pages and answers-ranked-and-withheld are REPORTED every run and never judged: a build that
withholds more junk while holding recall is a precision improvement, and a ratchet on either would
redden it.

the criterion this re-scope did NOT delete and does NOT mark met — `potsherd find` answering a
question phrased in words the archive does not contain — is carried forward with its evidence and
its exhaustive ceiling as phase 12's named target: `phases/phase-12/FIRST-JOB.md`.
```

## §4 what I could not do, and the gap I am handing back

**1. The verb's ratchet cannot catch "a single lane became a better product than the fusion."**
This is the honest cost of the instruction *do not compare the verb to a single-lane mode*, and I
followed it. If some future change lifted bm25's verb recall to 40 while hybrid stayed at 7, clause
6 would still be green and the gate would pass a build that should not ship the fusion.

I considered a clause that closes it **without** becoming a comparison-that-demands-a-win: a
**deficit ratchet** — `bestSingle.verb − hybrid.verb ≤ 1`, measured today at exactly 1, allowed only
to shrink. It is green on `70dac23` (8 − 7 = 1) and green under both controls, it reddens the
scenario above, and it is a ratchet on a measured quantity rather than a demand the fusion cannot
meet. **I did not build it**, because the brief says the verb must not be compared to a single-lane
mode and that is a ruling, not a preference. I am raising it here for a ruling rather than
implementing it or staying quiet about it. `tests/evals-gate.test.ts` asserts the current
permissive behaviour loudly and points at this section, so the gap is discoverable from the code.

**2. The empty-page count is reported, not gated.** A ratchet on it would redden an honest
precision improvement. I could find no version that does not need `FIRST-JOB.md`'s target closed
first.

**3. A pre-existing defect of the same family, found and deliberately NOT fixed: the phase-1
fallback gate is unmeetable at either surface.** When no vector mode runs — no cached embedding
model, or `--vectors off` — `gates.length === 0` and the run falls back to `PHASE_1_GATE`, which is
`scoreAt(bm25)/total >= 0.8`. `scoreAt` has been the **verb** since C-1 step 1. Measured just now:

```
  pnpm evals -- --vectors off        exit 1
  cannot be judged — it needs bm25, vectors and at least one hybrid mode in the same run
  phase-1 gate · bm25 alone ≥ 48/60 · not met
```

bm25 returns 8/60 at the verb and 40/60 at the ranking; **0.8 of a 60-query set is 48, so this
clause fails at BOTH surfaces**, and `pnpm evals` therefore exits 1 unconditionally on any machine
without the model. That is the same "clause pointed at a surface it was not measured on" defect the
re-scope fixes for phase 3 — plus a bar carried from a 10-query set to a 60-query one, which is the
`22/25 → 51/60` problem again.

**I did not touch it.** Re-pointing it at the ranking still fails (40 < 48), so the only ways to
make it green are lowering 0.8 or re-deriving it on the new set — both criterion changes, neither
mine to make, and the ruling is explicit that a clause I cannot replace with something that fails
does not get deleted. It is out of this brief's file scope in spirit and its blast radius is the
no-model path only. **Raising it as the next ratchet decision.**

**4. The `--vector-weight 0` numbers moved between `6a157fa` and `70dac23`** (hybrid ranking
52/33 → 50/38). I re-measured rather than inherited, which is how the change was found, but I did
not investigate *why* — it is one commit of P11 surface work away and outside this brief.

**5. I did not touch** `evals/queries.jsonl`, `plans/`, or the four files the live worker holds
(`packages/core/src/render/find.ts`, `packages/cli/src/commands/find.ts`,
`packages/mcp/src/tools/recall.ts`, `packages/core/src/index.ts`). My numbers were stable across
every run in this report — 7/7 at the verb, 57/42 at the ranking, 52 empty — so that worker's
presentation changes had not moved the verdict as of the runs pasted here.

**6. `evals/run.ts`'s two measurement runs and the three control runs cannot be chained with `&&`**,
because two of the three are *expected* to exit 1. I used explicit `|| echo 1 > …code` capture so
every top-level chain is still `&&` and no failure is masked.

## §2f-log — mutation transcripts

Reproduce by applying the described mutation and running
`npx vitest run tests/evals-gate.test.ts -t "the re-scoped retrieval gate"`.
--- MUTATION A: VERB_RATCHET atK 7 -> 8 (the verb loses one answer) ---
   × the re-scoped retrieval gate — the RANKER clauses > passes the measured release run, and says which clause carried it 8ms
     → expected false to be true // Object.is equality
   × the re-scoped retrieval gate — the VERB ratchet > holds at the measured value on the release run 1ms
     → expected 8 to be 7 // Object.is equality
   × the re-scoped retrieval gate — the VERB ratchet > catches a demotion out of the top row even when recall@5 holds 0ms
     → expected false to be true // Object.is equality
   × the re-scoped retrieval gate — the VERB ratchet > pins the ratchet, so lowering it cannot be done silently 2ms
     → expected { atK: 8, at1: 8, of: 60 } to deeply equal { atK: 7, at1: 7, of: 60 }
   × the re-scoped retrieval gate — the VERB ratchet > does not compare the verb against a single lane 0ms
     → expected false to be true // Object.is equality
   × the re-scoped retrieval gate — the VERB ratchet > reports empty pages and the withheld count without judging either 0ms
     → expected false to be true // Object.is equality
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 6 ⎯⎯⎯⎯⎯⎯⎯
AssertionError: expected false to be true // Object.is equality
AssertionError: expected 8 to be 7 // Object.is equality
AssertionError: expected false to be true // Object.is equality
AssertionError: expected { atK: 8, at1: 8, of: 60 } to deeply equal { atK: 7, at1: 7, of: 60 }
AssertionError: expected false to be true // Object.is equality
AssertionError: expected false to be true // Object.is equality
      Tests  6 failed | 8 passed | 5 skipped (19)

--- MUTATION B: drop verb.holds from the pass conjunction (the verb clause made decorative) ---
   × the re-scoped retrieval gate — the VERB ratchet > goes red when the verb loses one answer, with the ranker untouched 6ms
     → expected true to be false // Object.is equality
   × the re-scoped retrieval gate — the VERB ratchet > catches a demotion out of the top row even when recall@5 holds 1ms
     → expected true to be false // Object.is equality
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯
      Tests  2 failed | 12 passed | 5 skipped (19)

--- MUTATION C: point the comparative clauses back at the verb (the C-1 state, one day old) ---
   × the re-scoped retrieval gate — the RANKER clauses > passes the measured release run, and says which clause carried it 7ms
     → expected false to be true // Object.is equality
   × the re-scoped retrieval gate — the RANKER clauses > judges the comparative clauses on the ranking view, never the verb 1ms
     → expected 7 to be 57 // Object.is equality
   × the re-scoped retrieval gate — the RANKER clauses > refuses a fusion under the ranker floor even when it beats both singles 0ms
     → expected false to be true // Object.is equality
   × the re-scoped retrieval gate — the RANKER clauses > accepts a tie at recall@5 when recall@1 is a strict win 0ms
     → expected false to be true // Object.is equality
   × the re-scoped retrieval gate — the VERB ratchet > goes red when the verb loses one answer, with the ranker untouched 1ms
     → expected false to be true // Object.is equality
   × the re-scoped retrieval gate — the VERB ratchet > does not compare the verb against a single lane 0ms
     → expected false to be true // Object.is equality
   × the re-scoped retrieval gate — the VERB ratchet > reports empty pages and the withheld count without judging either 0ms
     → expected false to be true // Object.is equality
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 7 ⎯⎯⎯⎯⎯⎯⎯
      Tests  7 failed | 7 passed | 5 skipped (19)

## §5 verification, run on this branch

```
pnpm evals                                  exit 0   both surfaces, 52/60 empty pages on screen
pnpm evals -- --no-vector-lists             exit 1   RED: clearsBar, tight.beatsBm25   (2 ranker clauses)
pnpm evals -- --vector-weight 0             exit 1   RED: wide.beatsVectors, clearsBar (2 ranker clauses)
pnpm evals, scoreAt seeded -1, reverted     exit 1   RED: verb.holdsAtK, verb.holdsAt1 (ranker all green)

pnpm test                                   55 files, 2,019 passed, 0 failed
POTSHERD_SQLITE=node pnpm test              55 files, 2,019 passed, 0 failed
  (baseline was 2,011 on 55 files; tests/evals-gate.test.ts goes 14 -> 19, +8 net across the file)

pnpm typecheck                              4/4 Done
python3 scripts/check-privacy.py            exit 0   (read from $?, output elided)
pnpm build && pnpm vendor                   ok
git status --short plugins/                 clean
df -h                                       6.0 GiB avail before, 6.5 GiB after
```

Untouched: `evals/queries.jsonl`, `plans/`, `packages/core/src/render/find.ts`,
`packages/cli/src/commands/find.ts`, `packages/mcp/src/tools/recall.ts`,
`packages/core/src/index.ts`. Changed: `evals/gate.ts`, `evals/run.ts`,
`tests/evals-gate.test.ts`, and this report.

# phase 12, first job — make `find` answer a question asked in words the archive does not use

**Written 25 aug 2026 at the end of phase 11, by ruling.** Not a plan; one named target, with the
evidence already gathered, so nobody re-derives any of it.

**This criterion was not deleted and is not met.** It was carried forward. The shipped gate was
re-scoped to what the instrument honestly measures at the verb; **this is the number that was
descoped, and closing it is what earns it back.**

---

## the target

**`potsherd find` returns nothing for a question phrased in words the archive does not literally
contain, even when its own ranker puts the right session first.**

Measured at the verb, on the 60-query blind set, on `6a157fa`:

```
                    at the verb (weak)        at the ranking (none)      empty pages
  bm25 only      @5  8/60   @1  8/60      @5 40/60   @1 31/60            51/60
  vectors only   @5  8/60   @1  8/60      @5 57/60   @1 40/60            51/60
  hybrid (auto)  @5  7/60   @1  7/60      @5 57/60   @1 42/60            52/60
```

The right-hand column is what the release ships as a ranker. The left is what a person or an agent
gets. **The gap is the target.**

## what is already ruled out, with proof rather than inference

**Tuning cannot reach it.** An exhaustive search over every threshold on `calibration`, `coverage`,
`cosine`, `z`, `gap`, `relative cosine` and `strength`, plus the best two-feature AND rule, bounds
F1-safe recall at **16/60**. The old floor needed 51.

**Why: a dense vector is compositional-blind.** The no-match controls are compound questions whose
halves each have a neighbourhood, so a *wrong* block reaches cosine **0.741** — above 90% of correct
answers. **Literal term presence is the only compositional evidence in the index**, which is
precisely why it holds F1 and precisely why it deletes paraphrase. `score ≤ coverage` by
construction (the bracket is a partition of 1), and `coverage` counts the query's literal terms, so
`weak` demands half the query's words verbatim whatever the cosine says:

```
"pgbouncer pool saturated"                       cov 0.666  weak
"everything queued up and timed out under load"  cov 0.75   weak
"database handles ran out during heavy traffic"  cov 0.166  none → 0 rows
"we exhausted our allowance of open channels"    cov 0.25   none → 0 rows
```

All four name the same, unambiguously correct session.

**Three fixes were built and reverted**, each on a measurement:

| attempt | result |
|---|---|
| coverage over the keyphrase (T10.1's own recommendation) | empty 52→36, but ranking@1 42→30 and two demo queries topped by the **wrong** session at `strong` |
| label but do not withhold | the vector lane **cannot decline** — nonsense returns ten rows on any embedded index; `none` becomes constant over 53/60 correct and 5/5 absent; an absent topic **outscores** a true answer 0.2093 to 0.2099 |
| a divider (empty verdict, closest rows below a rule) | see `phases/phase-11/C1-REPORT.md ## ROUND 3` for whether it shipped |

## the direction, described and not built

**Term-level semantic coverage**: ask, per distinctive query term, whether anything in the row
*means* it — rather than whether the row contains it. That restores compositional evidence, which is
the thing the dense vector threw away, without abandoning the property that holds F1.

It needs one of: **term or span vectors** in the index, or **index-time lexical expansion**. Both
are index-format work. The cheap `df == 0` shortcut is refused for T10.1's recorded reason: it is a
no-op at 433 MB.

**That is a phase, not a patch**, which is why it is here rather than in phase 11.

## the second shape of the same gap, found by the seventh verifier

**An invented word plus two ordinary ones defeats the floor.** Four attempts out of four on the real
archive, at `weak`, with quotable snippets and a resume line — the audit's F1 alive on a shape
nothing tested. `coverage 2/3 = 0.667` clears `WEAK_FLOOR`, and the six controls cannot see it
because five are four-word queries, whose coverage is `≤ 0.5` by construction.

**The cause is not a threshold.** `selectTerms` drops `df === 0` terms, so the term the floor
*requires* becomes one of the ordinary words — the invented one, the only distinctive thing in the
query, is discarded before the floor is applied.

A two-line patch exists and was measured: **it refuses all four attempts on the real archive and
keeps a true topic `strong`** — and costs the verb **7/60 → 5/60** on the 0.5 MB eval fixture, where
legitimate words like `sitting` and `discussion` are absent from the corpus *exactly as an invented
word is*. No alignment of `df` with `coveredTerms` recovers them.

**So it is this file's own target seen from the other side**: with term-level semantic coverage, a
rare term is evidence rather than noise, and both halves resolve. It was not taken alone because
taking it means lowering the verb's ratchet to fit a result.

Three controls of this shape ship green (two, three and four words). A fourth —
the first reproduction of it on the committed fixture — is written into `evals/queries.jsonl`'s
comment block rather than enforced, because a red control fails `pnpm evals` **and** `pnpm test`.
**One line restores it** when the capability exists.

## what would make this a bad answer

- A threshold moved until the number is met. The ceiling above says it cannot be, and any number
  reached that way means the controls broke.
- Anything that lets a nonsense query or a genuinely-absent topic reach `weak` at either door.
- A benchmark that measures the ranking again. **Run the verb.** `evals/run.ts` reports both views
  now; keep it that way (`plans/09 §17.14`, `§17.16`).
- Shipping the ranker's numbers as the product's numbers. That is what happened for eight phases.

## the files

| | |
|---|---|
| the exhaustive bound, the mechanism, the three reverted attempts | `phases/phase-11/C1-REPORT.md` |
| the verification that found it | `phases/phase-10/VERIFICATION-6.md` §C-1 |
| calibration itself | `packages/core/src/calibration.ts`, `recall.ts`'s `byLabel` |
| the blind query set and how it was built | `evals/queries.jsonl`, `phases/phase-10/T10.10-REPORT.md` |
| the re-scoped gate, and what it now measures | `evals/gate.ts`, `plans/06` |

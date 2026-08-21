# T4.2 — results

Numbers and shapes only. Every file containing real-corpus prose is in
`/Users/zebra/randomness/potsherd-p4-evidence/T4.2/`, produced from the kept
`--potsherd-dir` **`/private/tmp/potsherd-T4.2`**. Method in `METHOD.md`.

## the corpus these numbers are from

| | |
|---|---|
| sessions indexed | 236 (1,406 exchanges, 299 ghosts rebuilt) |
| `card --all --dry-run` scope | 35 sessions + 90 ghosts |
| **actually carded** | **20 session cards + 25 ghost cards = 45** |
| distinct projects with a card | 18 |
| sessions the rule pass could raise from | 20 |

**n is small and the numbers below should be read as such.** `card --all` is a
~70-minute run; the orchestrator's ruling mid-task was to card a deliberate
subset spanning several plausibly-related projects and report against it,
saying plainly how many cards there were. That is what these are.

## the rule pass

```
node phases/phase-4/evidence-T4.2/run.mjs /private/tmp/potsherd-T4.2 --limit 100 --no-model
```

| | |
|---|---|
| (decision, project B) pairs raised | **52** |
| distinct decisions after collapsing | **26** |
| returned at the default `limit: 8` | 8 |
| wall time for the rule pass | **69 ms** over 45 cards |

## precision, measured by hand

Each of the top 8 candidates was checked against project B's **cards and B's raw
exchanges and ghost prompts** — not just its cards, because a card is a lossy
summary and "B never decided this" has to be checked against what B said.

| question | result | n |
|---|---|---|
| genuinely **absent** from B? | **8 / 8** | 8 |
| genuinely **worth raising** (a person in B would want it)? | **1–2 / 8** | 8 |

The absence half of the rule is reliable. **The usefulness half is mostly
noise, and that is the finding.** The 7 that are absent-but-useless fall into
two kinds, both visible in the candidate list:

1. **Unrelated projects joined by a generic filename.** Two candidates paired a
   real project with an unrelated one whose only overlap was `HANDOFF.md` — a
   filename that exists in half the archive. Repo-relative paths collide across
   projects and are weaker evidence than they look.
2. **Decisions that are local to A.** "Redesign phase 8 of *this* project",
   "create the project directory for B" — genuinely absent from B, and
   meaningless as a thing to carry over. One candidate was a decision that
   *created* project B, reported as never having reached it.

## the model pass

```
node phases/phase-4/evidence-T4.2/run.mjs /private/tmp/potsherd-T4.2 --limit 8 --model haiku
```

| | |
|---|---|
| candidates in the batch | 8 |
| **model calls** | **1** |
| wall time | **74 s** |
| confirmed | **1 of 8** |
| agreement with the hand labels | 6 of 8 |

`CONFIRM_BATCH` is **12**: at ~600 chars a candidate a full batch is ~7 kB of
prompt, an order of magnitude under `cards/slice.ts`'s 60 kB chunking threshold,
and twelve one-sentence verdicts fit the 4,096-token output default. The default
`limit` is 8, so a default `ask` is always exactly one call.

**A first attempt on the `sonnet` path failed** with
`error_max_turns: Reached maximum number of turns (1)` after 26 s. It is
recorded because the degradation is the point: every candidate came back
`confirmed:false` with a note naming the failure, nothing threw, and `ask` would
have shown nothing. The retry on `haiku` is the run above.

Token figures inherit `llm.ts`: the agent SDK reports a constant
`input_tokens: 10`, which is discarded and labelled `est.`

## the constant, and how the measurement chose it

`MENTION_COSINE` — the bar for *"project B already mentions this decision"*.

194 `(decision in A, project B)` pairs were generated with the bar switched off
and the top of the distribution read by hand against B's cards and exchanges.

**Not one pair was a genuine restatement.** Every high scorer was two different
decisions sharing process vocabulary. The corpus maximum, 0.3223, is
*"launch four-agent comprehensive wall audit"* against *"design 8-phase
implementation plan with rescue/audit as phase 0"* — not the same decision.

```
n = 194 pairs, every one a non-match
median 0.089   p90 0.178   p95 0.202   p99 0.298   max 0.3223
```

So the bar is set **above the strongest coincidence the corpus produced**:

| | |
|---|---|
| **shipped `MENTION_COSINE`** | **0.35** |
| previous value (chosen by taste, now replaced) | 0.30 |
| candidates 0.30 suppressed | 1 of 194 — **read, and wrong** |
| candidates 0.35 suppresses | 0 |

`MEASURED_NONMATCH_MAX = 0.3223` is exported and the test asserts
`MENTION_COSINE > MEASURED_NONMATCH_MAX`, so moving one without the other fails.

### the honest limit of this measurement

**The positive side is n = 0.** The corpus contains no case of B genuinely
restating A's decision, so nothing here shows the bar catches one when it
appears. Worse, synthetic paraphrase pairs score **0.20 to 0.57**, which
overlaps the measured negative distribution outright. There is no threshold on
this statistic that separates "B said this" from "B used these words".

What follows for the design: **the mention check is not what makes this feature
safe.** `MIN_ANCHOR_TOKENS` and the model pass are. The bar's only job is to
withdraw a candidate when B's card says something unmistakably the same, and
0.35 is where the corpus says "unmistakable" starts. A test asserts the overlap
so that this stays visible.

## what each guard actually costs

```
node phases/phase-4/evidence-T4.2/variants.mjs /private/tmp/potsherd-T4.2
```

Pairs raised under each setting, 45 cards:

| variant | raised | Δ vs shipped |
|---|---|---|
| **shipped** | **52** | — |
| ghosts allowed as source A | 60 | **+8** |
| ghosts ignored as counter-evidence in B | 52 | **0** |
| uncited decisions kept | 52 | **0** |
| `MIN_ANCHOR_TOKENS` 1 | 140 | +88 |
| `MIN_ANCHOR_TOKENS` 3 | 15 | −37 |
| `MIN_PROJECT_OVERLAP` 1 | 56 | +4 |
| `MIN_PROJECT_OVERLAP` 5 | 38 | −14 |
| mention bar off entirely | 53 | +1 |
| container projects split from children | 52 | 0 |

Read across that table, the rule pass is carried almost entirely by
**`MIN_ANCHOR_TOKENS = 2`**, which removes 88 of 140. Everything else is small.

### the ghost rule, and why it went the way it did

**Chosen: a ghost card may never raise a candidate; it may still withdraw one.**

- Allowing ghosts as source A adds **8 candidates**. A ghost card is built from
  prompts only (`cards/ghost.ts`) — there is no assistant side — so a "decision"
  on one is a decision the user *typed about*. That is too weak to accuse
  another project of ignoring, and the asymmetry is deliberate: **weak evidence
  may withdraw a candidate but never raise one.**
- Ghosts as counter-evidence in B suppress **0** on this corpus. The rule is
  kept anyway because it can only ever *remove* a candidate, so its worst case
  is a lost catch rather than a wrong claim — but it should be reported as
  buying nothing measurable here, and it is.

### uncited decisions: dropped, not marked

Keeping them changes the count by **0**, because `cards/verify.ts` already drops
`no-citation` claims before a card is written. Dropping is therefore free today
and is the rule that holds if some future degraded path writes one:
`00-README`'s *cited or dropped*, applied where the negative half of the claim
can never be cited either.

### container projects

A session recorded at `/Users/zebra` is treated as the same project as
everything beneath it, so it can neither raise nor receive a candidate.
Splitting containers from their children changes the count by **0**, so the
simpler pure-containment rule ships. It errs toward suppressing, not inventing.

## token document frequency

```
node phases/phase-4/evidence-T4.2/control.mjs df /private/tmp/potsherd-T4.2
```

At 45 cards, `GENERIC_DF = 0.3` strikes **2 tokens**. The filter is off below
`GENERIC_DF_MIN_CARDS = 20`, because with four cards "appears in 30% of cards"
means "appears twice" and the filter would delete the vocabulary.

It did **not** strike the tokens that actually drive the noise — `audit`,
`phase`, `design`, `documentation` — because each appears in fewer than 30% of
cards while still being process vocabulary rather than subject matter. **On a
corpus this size the IDF filter does not earn its place.** It is kept because it
should scale, but it is not doing the work today and should not be credited
with any of the precision above.

## re-running any of this

```
pnpm --filter ./packages/core build      # the instruments import the built module
node phases/phase-4/evidence-T4.2/control.mjs  pairs /private/tmp/potsherd-T4.2
node phases/phase-4/evidence-T4.2/control.mjs  df    /private/tmp/potsherd-T4.2
node phases/phase-4/evidence-T4.2/variants.mjs       /private/tmp/potsherd-T4.2
node phases/phase-4/evidence-T4.2/run.mjs            /private/tmp/potsherd-T4.2 --limit 8 --model haiku
```

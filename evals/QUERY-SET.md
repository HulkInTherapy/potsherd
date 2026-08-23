# the recall query set

`evals/queries.jsonl` — 60 recall queries and 6 confidence controls, scored by
`pnpm evals` against `evals/fixture/`. This file records how the set was built,
what each query is for, how every gold label was checked, and — the reason
T10.10 exists — how much noise the set has, so the next person can tell a real
difference from a coin flip.

---

## 1. why the set was widened

The 25-query set could not decide what it was being asked to decide.

Its verdict turned on the recall@1 half of the §8.5 gate, *hybrid strictly above
both singles*. Measured on this checkout, that half read **hybrid 10, bm25 10** —
a margin of zero, having been a margin of one when the amendment was written. The
binomial standard deviation of a 25-query count at p ≈ 0.4 is 2.45 queries. A
criterion whose verdict moves on a margin four times smaller than its own noise
is not a measurement. `plans/08-STATE-OF-PLAY.md` has recorded the one-query
margin since phase 8.5 and nobody acted on it.

So the goal of T10.10 was **statistical power**, not a better score. Nothing about
the ranker, the weights or the gate was touched. `WEIGHTS.vec_* = 1.5` is still
the phase-3 stopping rule and `PHASE_3_GATE` is still 22/25.

Whether the widening delivered the power is answered in §6, and the honest answer
is *for one clause of the gate, yes, decisively; for the clause the gate actually
turns on, no, and the corpus cannot*.

## 2. what is in the set

60 recall queries. Two axes, both recorded per query.

**`needs` — where in the index the answer physically is.** Printed by the runner
and used by `coverage()`.

| `needs` | n | what it means |
|---|---|---|
| `text` | 36 | the ordinary case: the answer is in an exchange body |
| `ghost` | 12 | the session was deleted; `history.jsonl` kept the prompts and there is no assistant text to match |
| `sidechain` | 6 | the words exist only in a subagent transcript; the parent never says what came back |
| `card` | 6 | neither the transcript nor the title answers the question. Only the card's summary does |

The 25-query set covered 5 of the 6 sidechains and 5 of the 12 ghosts. This one
covers **all 6 sidechains and all 12 ghosts**.

**form — how the question is asked.** Recorded as a bracketed tag at the head of
each `note`, because adding a field would have changed the file format that
`evals/run.ts` parses. A query can carry more than one tag, so these sum to more
than 60.

| tag | n | what it means |
|---|---|---|
| `[sentence]` | 57 | a natural-language sentence or half-remembered phrase |
| `[keyword]` | 10 | one to three distinctive words, typed the way a person types into a search box |
| `[cross-project]` | 8 | the remembered topic occurs in two or more of the eight fixture projects, so the ranking has to discriminate across a project boundary |
| `[decision]` | 6 | a question about a decision that was taken, not a symptom that was observed |

Of the 10 `[keyword]` queries, 7 are recall queries (`eu region reporting a day
late`, `container killed`, `maintenance window`, `monthly finance report`, `janky
scrolling`, `data leakage`, `disk errors with plenty of room left`) and 3 are
controls. §5 explains why there cannot be many more.

**no-answer golds — 3, and the format already supported them.** `control:
"no-match"` is how `evals/run.ts` writes down *the honest answer is that the
corpus does not contain this*: the query carries no `expected_session_prefix`
because there is no session to name, and it is scored on its own by the control
block rather than folded into recall. T10.10 added three, taking the controls
from 3 to 6:

- `dark mode for the invoice pdf`
- `rate limiting the sitemap generator`
- `bluetooth on the checkout page`

Each is a conjunction of two topics the corpus really has, describing a session it
really does not, so the words are all present and the thing is absent — which is
the only kind of absence that is hard to detect. **One of the three currently
fails**; see §7.

## 3. how the queries were written

Every query is written the way somebody remembers a conversation weeks later: the
thing it was *about*, not the words they typed at the time. Concretely, each one
was written **from the corpus text**, then deliberately moved away from it —
`carousel` became *rotating banner*, `webcam` became *camera*, `invoice` became
*bill*, `3 GB` became *three gigabytes*, `stutters and flick` became *janky
scrolling*.

The rule this enforces is `evals/run.ts`'s answer-overlap flag: of a query's
content words, at most 0.6 may appear verbatim in the text its own answer is
indexed on. A query above that line could have been answered by grep, and the
25-query set's ancestor scored 10/10 exactly that way.

**No query in this set trips the flag.** Worst overlap is 0.600, mean 0.280.
Three queries in the 25-query set did trip it and were rewritten rather than
defended — the rewrite and the reason are recorded in each one's `note`:

| old query (flagged) | why | new query |
|---|---|---|
| combining keyword and vector search into one ranked list | 67%; shared *keyword vector search list* | why we merged the two result lists on rank instead of score |
| the ci runner filled up its disk with docker layers | 67%; shared *ci runner disk docker* | the machine that kept running out of space because old images piled up |
| the thing on the new page a screen reader could not escape | 67%; shared *new page screen reader* | what the accessibility audit said about the rotating banner |

## 4. how every gold label was verified

Nothing here was assumed. Three checks, all reproducible.

**(a) the automated structural check.** With a kept index —

```
pnpm evals --keep                     # prints: index kept at <IDX>
```

— every query was asserted against the index itself: the gold prefix resolves to
a session that exists; the `needs` label is *true of that session* in the index
(a `ghost` gold has a row in `ghosts`, a `card` gold has a row in `cards`, a
`sidechain` gold has a child session with `is_sidechain = 1`, a `text` gold has
rows in `exchanges`); the answer-overlap is ≤ 0.6; and for every `card` gold the
card overlap is **strictly greater** than the body overlap, which is what makes
"card-only" a fact rather than an intention. All 60 pass, and all 6 controls pass
the matching absence check: no single session in the index contains every content
word of a `no-match` control.

**(b) the per-query read.** One command per gold, 58 of them:

```
node packages/cli/bin/potsherd.js --potsherd-dir "$IDX" show <prefix> --no-color
```

All 58 resolve, none is ambiguous, none fails. A sidechain gold is read with the
full compound id, `show '<parent>:agent-<hash>'`, because that is the only way to
see the text the query is actually asking for.

**(c) the runner's own overlap column,** printed on every run and reproduced in
`--json` under `overlap.rows`, which is the check that keeps (a) honest after this
document stops being read.

### a worked example

The query `how many required columns the loader was not filling in`, gold
`a82ceb72`, `needs: sidechain`. The parent:

```
$ potsherd --potsherd-dir "$IDX" show a82ceb72
potsherd show · Streaming rewrite of the CSV importer
  ...
    1  the csv importer eats 3 GB of memory on the big files. rewrite it
    2  how do we handle backpressure when the database is slow
    3  add a progress line
  1 subagent transcript:  schema-reader s2a
```

The parent never mentions a column. The subagent does, and only the subagent:

```
$ potsherd --potsherd-dir "$IDX" show 'a82ceb72-455b-4fc8-88b8-993effefe3c7:agent-s2a'
potsherd show · read the target table and list the not-null columns
  claude · live · potsherd-eval-api · sidechain · schema-reader
    1  read the target table and list the not-null columns
       Eleven not-null columns; the importer currently writes nine of them.
```

So the gold is right, the `needs: sidechain` label is right, and a ranker that
reads parents and not subagents scores zero on this query. The same session also
carries a `needs: text` query (`the import that ate three gigabytes on the big
files`) answered entirely from the parent, which is why it is the one session in
the set with two queries of different kinds.

## 5. the ceiling the corpus imposes

Two ceilings were hit, and both are properties of the fixture corpus rather than
of the effort spent.

**Every session in the corpus is now the gold answer to a query.** The corpus is
46 live sessions and 12 ghosts. The set has 58 distinct gold prefixes. There is
nothing left to ask about: an honest 61st query would have to be a second question
about a session that already has one, and near-duplicates are padding, not power.
**58 is the hard ceiling on this corpus**, and the set is at it.

**Short queries are structurally almost impossible here.** A `[keyword]` query is
one to three content words. If its distinctive word appears in the answer's
transcript — `pgbouncer`, `conntrack`, `viewBox`, `inodes`, `backpressure`,
`cursor pagination`, `startupProbe` — then one or two words in and one or two
words out puts the overlap at 0.5 to 1.0, and the flag fires. A short query can
only stay under the line when its distinctive word lives **only on the card**,
which is true of exactly six sessions in this corpus. That is why there are 7
short recall queries and not 20, and it is a real constraint on what this fixture
can measure, not an omission. A corpus with richer cards would lift it.

## 6. the noise estimate

This is the number T10.10 exists for. All of it is computed from the per-query hit
vectors in `pnpm evals --json`, on the release run at the shipped weight of 1.5.

**Method.** Three estimators, because they answer different questions.

1. **Binomial sd of a single count**, `sqrt(n·p·(1−p))`. Answers *how much would
   this one number move if the 60 queries had been a different 60 drawn the same
   way.*
2. **McNemar on the paired difference**, over the queries where two modes
   disagree. Answers *is the gap between two modes real*, which is what every
   clause of the gate is about. The paired form is the correct one: the two modes
   are scored on the *same* queries, so the shared difficulty cancels and only the
   discordant queries carry information.
3. **Paired bootstrap**, 20 000 resamples of the 60 queries with replacement,
   recomputing both counts and their difference each time. Answers the same
   question as (2) without assuming anything about the discordance.

**Result — single counts (estimator 1).**

| number | value | sd |
|---|---|---|
| hybrid recall@1 | 27/60 | 3.85 queries (6.4 pp) |
| bm25 recall@1 | 25/60 | 3.82 queries (6.4 pp) |
| hybrid recall@5 | 52/60 | 2.63 queries (4.4 pp) |
| bm25 recall@5 | 29/60 | 3.87 queries (6.5 pp) |
| vectors recall@5 | 51/60 | 2.77 queries (4.6 pp) |

Note that widening the set *raised* the sd in queries (2.45 → 3.85) and lowered it
in percentage points (9.8 pp → 6.4 pp). The gate compares counts on one fixed set,
so the number that matters is neither of these — it is the paired one below.

**Result — the gate's three clauses (estimators 2 and 3).**

| clause | measured | discordant queries | McNemar p | bootstrap 95% CI | verdict |
|---|---|---|---|---|---|
| hybrid ≥ bm25 @5 | 52 vs 29, **+23** | 23 for hybrid, 0 against | 2.4 × 10⁻⁷ | [+16, +30] | **decisively real** |
| hybrid > bm25 @1 | 27 vs 25, **+2** | 3 for hybrid, 1 against | 0.625 | [−2, +6] | **undecided** |
| hybrid ≥ 53/60 @5 | 52, bar 53, **−1** | — | — | count CI [46, 57] | **a coin flip** |

For the recall@1 clause the paired bootstrap puts P(true difference ≤ 0) at
**0.226**. For the bar clause the bootstrap puts P(hybrid@5 ≥ 53) at **0.445**.

**What this means, and it is not what widening the set was expected to show.**

The recall@1 clause is not undecidable because 25 was too few. It is undecidable
because **hybrid and bm25 put the same session first on 56 of 60 queries**. The
power of a paired comparison is set by the number of discordant pairs, not by the
number of queries: at the observed 3-to-1 split, 17 discordant pairs are needed
before McNemar clears p < 0.05, and the observed discordance rate is 4/60 = 6.7%,
which implies **about 255 queries (est.)**. The corpus's hard ceiling is 58. The
recall@1 clause of the §8.5 gate therefore **cannot be resolved on this fixture at
any set size it can support**, and no amount of further widening will change that.

The four discordant queries at recall@1, in full, because with only four of them
the reader is entitled to see each one:

```
hybrid-only  charged the customer twice because the client retried
hybrid-only  why the conversion chart said more finished than began
hybrid-only  stopping tab from wandering behind the overlay
bm25-only    stop counting the same event twice in the rollup
```

**Practical rule for the next person.** On this set, at recall@1 a difference of
**±4 queries or less between two rankers is noise** unless you look at the
discordant list and it is one-sided; a difference of ±2 certainly is. At recall@5
a difference of 5 or more is real. The bar clause has an uncertainty of about ±5
queries and is currently sitting one query below its threshold, so it will flip on
a change that means nothing.

## 7. what currently fails, and it is reported rather than fixed

`pnpm evals` exits 1. Two separate things are red, and they are red for different
reasons. Neither was tuned away; `plans/06`'s review rule and the standing ruling
of phases 3 through 8 are that a worker does not edit its own exam.

**(a) the gate's absolute bar, by one query.** `PHASE_3_GATE` is `22/25 = 0.88`
and `bar = round(0.88 × total)`, so on 60 queries it is 53. Hybrid scores 52. Both
comparison halves of the amended rule now pass — including recall@1, which failed
on the 25-query set — and the run fails on the floor instead.

There is an argument to be made about that clause and this document is the place
to make it rather than the code: `0.88` was not chosen as a difficulty-independent
standard, it was *22 out of the specific 25 queries phase 3 wrote*, and applying it
as a proportion to a different and harder set silently changes what it asserts. A
proportion inherited from one exam is not a pass mark on another. **Nothing was
changed.** If the project wants a floor that survives a change of set, that is a
decision for the gate's author, and §6 says what any replacement would need to be:
a threshold with an uncertainty of ±5 queries has to sit further than 5 queries
from where the build actually scores, or it is a coin flip with a rule attached —
which is the exact failure this task was raised to remove.

All 8 recall@5 misses are `text` queries; `card`, `sidechain` and `ghost` are 6/6,
6/6 and 12/12. Six of the eight land at rank 6 or 7, just outside the window.

**(b) one of the three new no-answer controls.** `bluetooth on the checkout page`
must return zero rows and returns two at `weak`:

```
d80a3f16  Funnel report double counted a step
a86656f1  Flaky end-to-end test on the checkout page
```

Neither has anything to do with bluetooth. The corpus has no bluetooth session
outside a deleted devices thread, and no checkout session that mentions it. This is
the T10.1 failure mode arriving from a direction T10.1's own control did not cover:
its control, `kubernetes ingress payment service`, spreads its words thinly across
many sessions and is withheld correctly, whereas here **one half of the query
matches one session's title almost verbatim** and carries the pair over the floor
on its own. The other two new controls (`dark mode for the invoice pdf`, `rate
limiting the sitemap generator`) return zero rows with 3 and 4 rows withheld.

This is a finding about the confidence floor, in `packages/`, which T10.10 is not
scoped to change. It is left red on purpose: a control that is deleted because it
fails is not a control.

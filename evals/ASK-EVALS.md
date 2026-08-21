# the ask eval set

T4.0. Ten gold questions, three decoys, and the harness that scores them, against the three
gates in `plans/06-QUALITY-AND-EVALS.md §ask evals`:

> (a) every emitted claim has a citation that exists and says what the claim says — **100% or
> the build fails**; (b) gold coverage ≥ 7/10; (c) `--strict` on an unanswerable question
> returns the refusal, not a guess (3 decoys).

| file | what |
|---|---|
| `evals/ask.jsonl` | the set — 10 gold + 3 decoys, one JSON object per line |
| `evals/ask-run.ts` | the scoring harness. `tsx evals/ask-run.ts` |
| `evals/ask-selftest.ts` | proves the scorer against hand-built `AskResult`s. `tsx evals/ask-selftest.ts` |
| `evals/ASK-EVALS.md` | this file |

The integrator adds one line to `package.json` (RESERVED, not edited here):

```json
"evals:ask": "tsx evals/ask-run.ts"
```

---

## how the set was built

**The instrument came before the thing it measures.** This set was written on a branch that
could not see `packages/core/src/ask.ts`; T4.1 wrote `ask` at the same time without seeing these
questions. That separation is the point. In phase 1 one worker wrote both the queries and the
ranker and produced a meaningless 10/10. In phase 3 a separate eval worker built a set that
could fail, and it failed the ranker four times until the ranker genuinely improved.

**The corpus is the committed synthetic fixture** `evals/fixture/claude` — 46 sessions, 6
sidechains, 12 ghosts, 33 cards, ~8 projects named `-tmp-potsherd-eval-*`, built in phase 3
specifically to contain a real distractor pool. It is synthetic and redacted, so quoting it here
is safe and CI can run on it. Confirmed on the built index:

```
potsherd stats · <fixture index>
  harness  sessions  subagents  ghosts  exchanges   bytes  span
  claude         46          6      12        120  150 KB  apr 2026 → jul 2026
```

**Every gold answer was located before its question was written.** The order was: read the whole
corpus, find a fact that exists in exactly one place, check what else in the corpus looks like it
and would be the wrong answer, then write a question that does not quote the fact. Every quote
below was produced by a grep, and the greps are in this file. A question whose answer cannot be
pointed at is not a question, and none was kept.

**The questions are phrased the way somebody remembers a conversation weeks later**, not the way
they typed it at the time. Phase 1's set failed review because every query was a bag of words
lifted near-verbatim from its target; with 11 candidate sessions recall@5 could not fail. Here
the overlap between each question and its own answer is re-measured on every run, printed, and
compared against the number recorded in `ask.jsonl` — **a disagreement of more than 0.02 fails
the run.** A set cannot lie about its own overlap.

**Shapes.** `plans/06` and the T4.0 brief ask the ten to spread across the corpus's real shapes:

| shape | asked | in the set | which |
|---|---|---|---|
| sidechain-only | ≥ 2 | **3** | g01, g02, g03 |
| ghost-only (prompts, no assistant side) | ≥ 2 | **2** | g04, g05 |
| spanning two or more sessions | ≥ 2 | **2** | g08 (3 sessions), g09 (2 sessions) |
| needs a card, not a raw exchange | ≥ 2 | **2** | g06, g07 |
| ordinary exchange text | — | 1 | g10 |

g10 is there so the set is not made only of special cases.

---

## the overlap table

Definition, and the flag threshold, are `evals/run.ts`'s: of the question's content words
(stopwords dropped, same list), what fraction appears verbatim in the answer sessions' indexed
text (`text`) and in their cards (`card`). `max` is what `ask.jsonl` records. Flag above **0.60**.

Measured by `tsx evals/ask-run.ts`, 21 aug 2026, against a fresh fixture index with vectors:

```
       text  card  max  in file
  g01   13%    0%  13%     0.13  second
  g02   22%    0%  22%     0.22  once icon
  g03    0%    0%   0%     0.00
  g04   29%    0%  29%     0.29  billing backup
  g05   50%    0%  50%     0.50  app store build
  g06   33%   50%  50%     0.50  back provider identity
  g07   17%   50%  50%     0.50  march finance report
  g08   43%   14%  43%     0.43  long ids twice
  g09   11%   11%  11%     0.11  totals each
  g10   36%   18%  36%     0.36  times afternoon straight back several

  word overlap with the answer · min 0% · median 32% · max 50% · flag above 60%
  none flagged — no question is a quotation of its own answer
```

**min 0.00 · median 0.325 · max 0.50.** Nothing is flagged; nothing is close to the line. For
comparison, phase 1's set sat at 0.8–1.0 and phase 3's committed set has three queries at 0.67.

The three at 0.50 are the set's ceiling and each says why in its `note`:

- **g05** shares *app*, *store*, *build* — the subject nouns of "why did the app store send the
  build back". You cannot ask about an app-store rejection without naming the app store. Every
  word of the answer (privacy label, advertising id, resubmitted) is unshared.
- **g06** shares *back*, *provider*, *identity*, and all of it is with the **card**, which is the
  whole point of the shape: the transcript never contains the words a user would ask with.
  Transcript-only overlap is 0.33.
- **g07** shares *march*, *finance*, *report*, again with the card. Transcript-only overlap is
  0.17 — the transcript says only "the march file has blanks where the amounts should be".

---

## the ten gold questions, and where each answer is

Paths are relative to `evals/fixture/`. Exchange `seq` is 1-based; ghost-prompt `seq` is 0-based.

### g01 · sidechain-only · overlap 0.13

> how many requests a second did the checkout endpoint hold before the tail latency blew up

**Answer lives in** `claude/projects/-tmp-potsherd-eval-api/6b3a9e24-8f05-4c31-b7d2-1a94e6035cb7/subagents/agent-p4a.jsonl`,
session `6b3a9e24-…:agent-p4a`, **seq 1**.

```
$ grep -rlc "three hundred and eighty a second" projects/ | grep -v ':0$'
projects/-tmp-potsherd-eval-api/6b3a9e24-8f05-4c31-b7d2-1a94e6035cb7/subagents/agent-p4a.jsonl
$ grep -rho "It holds to three hundred and eighty a second[^\"]*" projects/
It holds to three hundred and eighty a second. Past that the ninety-ninth percentile goes from a
hundred and twenty milliseconds to four seconds, because the connection wait queue never drains.
```

Exactly one file in 53. The parent session designs the ramp ("fifty virtual users a minute up to
a thousand") and names what to watch, and never reports a number — so the parent is deliberately
**not** in `expectSessions`, and an answer that reads only the parent scores uncovered.
`expectPhrases` is the number itself, so "it degraded past a point" fails.

### g02 · sidechain-only · overlap 0.22

> how much weight came off once we stopped pulling the whole icon package in one go

**Answer lives in** `claude/projects/-tmp-potsherd-eval-web/4ae3102b-1ad3-432b-8f01-b0e64eb5d627/subagents/agent-s6a.jsonl`,
session `4ae3102b-…:agent-s6a`, **seq 1**.

```
$ grep -rl "412 KB of the icon set" projects/
projects/-tmp-potsherd-eval-web/4ae3102b-.../subagents/agent-s6a.jsonl
$ grep -rho "Tree shaking removes 412 KB[^\"]*" projects/
Tree shaking removes 412 KB of the icon set once the barrel import is replaced with per-icon
imports. The date library drops another 288 KB after switching to the modular build.
```

The parent says only "three quarters of it is the date library and the icon set. Both are
importable per-symbol" — no kilobytes. Distractors are on-topic and loud: `ea4d7c60` says the
date library is 400 kB, `c8e14f60` says the hero image is 800 kB, `1b6f0d95` is the icon sprite.
None of them says 412.

### g03 · sidechain-only · overlap 0.00

> why did the big amounts stop being exact after the loader switch

**Answer lives in** `claude/projects/-tmp-potsherd-eval-data/2f7c8b31-6d40-4a75-9e13-c0b5827af4d6/subagents/agent-p2a.jsonl`,
session `2f7c8b31-…:agent-p2a`, **seq 1**.

```
$ grep -rl "rounds the pennies away" projects/
projects/-tmp-potsherd-eval-data/2f7c8b31-.../subagents/agent-p2a.jsonl
$ grep -rho "The source keeps the amount as a numeric[^\"]*" projects/
The source keeps the amount as a numeric with two decimal places and the writer emits a double,
which rounds the pennies away above about ten million; and the status enum arrives as a bare
int32 with no dictionary.
```

The set's cleanest concept question: **zero** shared content words with its answer, so bm25 alone
cannot reach it. The parent is about moving the warehouse loader to parquet and never mentions
precision, doubles or amounts. The trap is `b8f43d05`, the *other* "the amounts came out wrong"
session, which is a text-versus-numeric join fault and not a float fault — an answer citing it is
wrong and scores uncovered.

### g04 · ghost-only · overlap 0.29

> how were we going to keep the billing job from holding up the backup overnight

**Answer lives in** `claude/history.jsonl`, ghost `4ddd4b1f-8f16-40c8-8970-658738871ba0`,
**seq 0 and seq 1**. There is no assistant side at all and no card for this ghost — the prompts
are the entire record.

```
$ grep -o '"display":"[^"]*"' history.jsonl | grep -i billing
"display":"the billing cron runs for forty minutes and blocks the nightly backup"     [seq 0]
"display":"move the billing cron onto a queue so it can run in parallel"              [seq 1]
"display":"write the runbook for a failed billing batch"                              [seq 3]
```

(seq 2 is "how many workers before we hit the payment gateway rate limit".)

Strong distractor: `4c07b9e3` is a **live** session titled "The replica backup outruns its
window" and says both *backup* and *window*; `3d92c7fe`'s card calls its subject "the nightly
deployment pipeline". Neither is the answer. The two shared words (*billing*, *backup*) are the
unavoidable subject nouns; the answer — a queue, in parallel — shares nothing with the question.

### g05 · ghost-only · overlap 0.50 (defended)

> why did the app store send the build back, and did we ever get it published

**Answer lives in** `claude/history.jsonl`, ghost `f1c48b07-6d92-4a35-8e07-2b91c5d4703a`,
**seq 0 and seq 3**. No assistant side, no card.

```
$ grep -o '"display":"[^"]*"' history.jsonl | grep -iE "privacy label|advertising id|resubmitted"
"display":"the app store rejected the build for a missing privacy label"     [seq 0]
"display":"which of the sdks is collecting the advertising id"               [seq 1]
"display":"resubmitted with the label filled in and it went through"         [seq 3]
```

(seq 2 is "can we ship without that sdk at all".)

The second half of the question — "did we ever get it published" — is answerable **only** from
seq 3, so an answer that stops at the rejection is incomplete. Defence of the 0.50: the shared
words are *app*, *store*, *build*, which are the subject of the question; every word of the
answer is unshared.

### g06 · needs the card · overlap 0.50 (defended)

> why could people not log in after coming back from the identity provider

**Answer lives in** `claude/projects/-tmp-potsherd-eval-web/e5a70c14-9b38-4d52-a670-5c39f28b1e64.jsonl`,
**seq 1 and seq 2**; the *findability* lives in `evals/fixture/cards.jsonl`.

```
$ grep -rho "The attribute is Lax[^\"]*" projects/
The attribute is Lax, and a cross-site POST drops it on the way back. Set None with Secure and
it survives the hop.                                                                    [seq 1]
$ grep -rho "Safari wants Partitioned[^\"]*" projects/
Safari wants Partitioned as well, set on the same response that performs the redirect.  [seq 2]
```

The transcript never contains **log in, sign in, login, authentication, cookie or identity**. It
opens "after the redirect back from the provider the browser is not sending it" and its title is
"SameSite and the third-party redirect". Only the card names it:

```
$ grep -o '"summary":"Users could not sign in[^"]*"' ../cards.jsonl
"summary":"Users could not sign in through the identity provider because the authentication
cookie was rejected on the way back; fixed by setting SameSite None, Secure and Partitioned on
the redirect response, with a header fallback for old webviews."
```

Without `cards_fts` / `vec_cards` in the shortlist this question is not reachable by the words a
user would actually use. That is the shape, and it is why `ask-run.ts` treats a missing
`cards.jsonl` as an error rather than a zero.

### g07 · needs the card · overlap 0.50 (defended)

> what went wrong with the finance report and did we ever reconcile march

**Answer lives in** `claude/projects/-tmp-potsherd-eval-data/b8f43d05-1e79-4a26-8c40-6b271fa9d3e5.jsonl`,
**seq 1 and seq 3**.

```
$ grep -rho "The join compares a text column against a numeric one[^\"]*" projects/
The join compares a text column against a numeric one, so every row falls out to the outer side.
Cast at load time.                                                                      [seq 1]
$ grep -rho "Re-running with the cast in place[^\"]*" projects/
Re-running with the cast in place; the row count agrees with the ledger this time.      [seq 3]
```

The transcript says only "the march file has blanks where the amounts should be" and never uses
*finance*, *report*, *monthly* or *reconcile*. The card supplies all four: "Type mismatch broke
the monthly finance report … March was regenerated and reconciled." Transcript-only overlap is
0.17; the 0.50 is entirely the card, which is the point of the shape.

### g08 · three sessions, three projects · overlap 0.43

> how long do we hang on to the ids that stop a repeat from being counted twice

**No single session answers it.** Each holds exactly one of the three retentions.

```
$ grep -rho "Twenty-four hours[^\"]*" projects/
Twenty-four hours. Nothing is still replaying a request after that, and the table stays small
enough to keep in memory.
   → -tmp-potsherd-eval-api/7c1d0e44-2b96-4f31-a0d7-5e1c9b2a4f83.jsonl        seq 3

$ grep -rho "Dedupe on the message id[^\"]*" projects/
Dedupe on the message id in a seen-ids table with a seven-day ttl, and check it before the
rollup reads the partition.
   → -tmp-potsherd-eval-data/47d9e281-3b64-4c07-a9f8-25e1d0b73c6a.jsonl       seq 1

$ grep -rho "A day. Longer than any client will retry[^\"]*" projects/
A day. Longer than any client will retry, short enough that the table stays small.
   → -tmp-potsherd-eval-mobile/c93f1e07-6d24-4b85-a710-5f28be03c9d1.jsonl     seq 2
```

The trap is `c47b1a09`, which says "A tombstone row with a seven day ttl" — the same number, for
a sync protocol rather than for deduplication. `2d6b91ae` and `0c68f4a1` are the other two
"charged/written twice" sessions and neither has a retention at all.

**A note on the gate.** `plans/06`'s coverage rule is *at least one* expected session in the
evidence, so this row can be scored covered on a third of the answer. `ask-run.ts` therefore also
prints a non-gating `all` column (every expected session cited) and a `seqs` column (how many of
the `expectSeqs` pairs the evidence landed on). For g08 and g09 those are the numbers to read.
The gate was not tightened, because `plans/06` defines it and this worker does not get to
redefine a gate to suit its own set.

### g09 · two sessions · overlap 0.11

> we had two separate cases of the reported totals coming out too high, what was behind each

```
$ grep -rho "A step is counted once from the event stream[^\"]*" projects/
A step is counted once from the event stream and once from the session summary, so anyone who
reloaded is in there twice.
   → -tmp-potsherd-eval-data/d80a3f16-5c92-4e78-b134-6207ea9c58fd.jsonl       seq 1
   (seq 2: "The session summary. Drop the event-level count and let the summary be the single
    source.")

$ grep -rho "The job is not idempotent[^\"]*" projects/
The job is not idempotent. Write into a staging table keyed on day and metric, then swap the
partition when it completes.
   → -tmp-potsherd-eval-data/1c58f0b3-7d92-4a15-8e63-40b7c2f9d18e.jsonl       seq 1
```

The question says out loud that there are two, so a one-session answer is visibly short. Both
live in the **same project**, which is what makes it hard: a shortlist that clusters by project
may return one and stop. The corpus is full of near misses on "counted twice" — `47d9e281`
(redelivered events), `0c68f4a1` (double card capture), `a5c2d803` (nightly job in two regions),
`e70d51c6` (double-clicked signup), `2d6b91ae` (refund in the ledger twice), `8d31f7c5` (push
twice) — none of which is about a *reported total* being too high.

### g10 · ordinary exchange text · overlap 0.36

> something was evicting our service several times an afternoon and it always came straight back, root cause

**Answer lives in** `claude/projects/-tmp-potsherd-eval-infra/b52e8c07-6a31-4d94-8f26-c30719ad5e48.jsonl`,
**seq 1 and seq 2**.

```
$ grep -rho "OOMKilled[^\"]*" projects/
OOMKilled. The limit is 512Mi and the heap alone reaches it under load; raise the limit and set
the heap under it.                                                                      [seq 1]
$ grep -rho "That is when the report job runs on the same node[^\"]*" projects/
That is when the report job runs on the same node and takes the headroom the kubelet was
counting on.                                                                            [seq 2]
```

The discriminator is the timing. `94f91303` is the direct distractor — "kubernetes keeps
restarting the pod every few minutes and the logs show nothing", a liveness-probe timeout — and
it matches *restarting* and *pod* better than the answer does. The answer is the one that happens
a few times a **day** and only in the afternoon. `6f0b24d9` (old pods still serving after a
cutover) is a third pod-lifecycle session. The question deliberately says *service* and
*evicting* rather than *pod* and *killed*.

---

## the three decoys, and the greps that prove nothing answers them

A decoy that is obviously off-topic is a weaker test than one that sounds like it belongs. Two of
the three are built to sound like they belong: the words are all in the corpus, the combination
is not.

`ask-run.ts` also re-measures this mechanically on every run — for each decoy it reports the best
single-session coverage of its content words across all 58 sessions and ghosts, and **fails the
run** if any session covers ≥ 0.90 of them. The fixture is a file in this repo and files change.

```
  decoys · the closest single session to each, over the whole corpus
  d01  0%   nearest —
  d02  20%  nearest 0a2fbf9b-c6fd-4486-86ee-d17cde32e587  shares: cost
  d03  40%  nearest 6b3a9e24-8f05-4c31-b7d2-1a94e6035cb7  shares: rate endpoint
```

### d01 · `what is the capital of france`

Named as a decoy by `plans/phases/phase-4-ask-and-graft.md`. The off-topic control.

```
$ grep -ric "france\|paris\|capital" projects/ history.jsonl | grep -v ':0$'
   (no output — zero hits in all 53 files)
```

This is the weakest of the three by construction. It is the floor, not the test.

### d02 · `which cloud provider did we migrate off and what did leaving cost us`

Plausible: the corpus is full of infrastructure, cost and migration language, so retrieval will
return something confident-looking. There is no answer in it.

```
$ grep -ric "\baws\b\|\bgcp\b\|azure\|cloud provider\|migrate off\|migrated off\|vendor lock" projects/ history.jsonl | grep -v ':0$'
   (no output — zero hits in all 53 files)
```

What *does* occur, and will pull a shortlist:

```
$ grep -rhoi "provider" projects/ | wc -l        →  3
$ grep -rhoi "migration" projects/ | wc -l       →  3
```

`e5a70c14` "the redirect back from the provider", `2d6b91ae` "the provider transfer id",
`2d6b91ae` "one migration that keeps the earliest row per transfer id" — plus cost talk
throughout, including `d4b1f0a7`'s subagent on the nat gateway bill being "up sixty-two percent",
which is the most tempting wrong answer in the corpus.

**Disclosed:** one literal `aws` string exists and is not a cloud-provider migration.

```
$ grep -rho "aws[a-z_]*" projects/ | sort | uniq -c
   1 aws_route_table
```

That is a terraform resource name in `d4b1f0a7`. The `\baws\b` grep above does not match it
because `_` is a word character; the count is disclosed here rather than left to be discovered.

### d03 · `what did we settle on for rate limiting the login endpoint`

The hardest of the three: **both halves exist separately and the combination does not.**

```
$ grep -ric "login\|log in\|sign-in\|sign in\|signin" projects/ history.jsonl | grep -v ':0$'
   (no output — zero hits in all 53 files. There is no login endpoint anywhere)
```

Rate limiting does exist, three times, and all three are somewhere else:

```
$ grep -rhoi "rate limit[a-z]*" projects/ history.jsonl | sort | uniq -c
   1 rate limit
   2 rate limited
$ grep -rho "rate limited by their gateway[^\"]*" projects/
rate limited by their gateway. what do we do              → a0c57a31, the outbound webhook
$ grep -o '"display":"[^"]*rate limit[^"]*"' history.jsonl
"display":"how many workers before we hit the payment gateway rate limit"   → ghost 4ddd4b1f
```

A system that answers "a token bucket at 20 requests per second with a jittered retry on 429" has
cited a real exchange for a claim the exchange does not make. That is exactly the failure
`--strict` exists to prevent, and it is why this decoy is here.

---

## the scoring

### gate (a) — citations, 100% or the build fails

Mechanical and unfakeable. For every result, gold and decoy alike:

1. **every `AskEvidence` resolves.** `(sessionId, seq)` must be a real row in `exchanges` or in
   `ghost_prompts` — exchange seq 1-based, ghost seq 0-based. A pair that does not resolve is a
   `seq-missing` fault.
2. **every `quote` occurs in that unit's text**, verbatim, after whitespace normalisation. A
   quote the model invented fails (`quote-absent`); a quote lifted from a *different* seq fails,
   which is the interesting case — it is what a confident wrong answer looks like. Case matters:
   a quote is a quotation, and a match that only works after case folding is reported distinctly
   (`quote-case`) so it is diagnosable, but it still fails. An elided quote (`…` or `...`) is
   split into segments, each of which must occur **in order**, which cannot smuggle anything in
   because every segment is still verbatim.
3. **`evidence[].index` is 1-based and unique**, because the sentences index into it
   (`index-shape`).
4. **every kept sentence cites at least one evidence line** (`cite-none`) **and every `cites`
   entry resolves** (`cite-dangling`).
5. **`result.answer` is exactly the kept sentences.** The answer is walked once, consuming each
   `sentences[].text` in order; anything left over with word characters in it is `answer-extra`,
   a kept sentence that is not there is `answer-missing`, and a `dropped[]` sentence still
   present in `answer` is `dropped-present`. That last one is how a filter that only *pretends*
   to drop gets caught — `plans/phases/phase-4` requires uncited sentences to be dropped **by
   code, not by prompt**.

`rate` is 1 or 0. There is no partial credit; `plans/06` says 100%.

### gate (b) — gold coverage ≥ 7/10

`covered` = at least one `expectSessions` id appears in the evidence **and** at least one
`expectPhrases` regex matches `result.answer` (case-insensitive). That is `plans/06`'s rule,
implemented as written.

Two further numbers are printed and **gate nothing**, because a worker does not get to redefine a
gate to suit its own set:

- `all` — every expected session cited, which is what g08 and g09 really want.
- `seqs` — how many of the `expectSeqs` pairs the evidence actually landed on. This is the number
  that says whether the reader found the right *exchange* or only the right neighbourhood.

### gate (c) — 3/3 decoys refuse under `--strict`

Checked twice, and **there is no flag to skip either half**:

- the library: `ask(db, q, {strict:true})` must return `refused === true`;
- the CLI: `potsherd ask "<q>" --strict --json --k 6 --potsherd-dir <root>` must exit **2**, per
  `plans/phases/phase-4` deliverable 1 ("print `no grounded answer in N sessions searched` and
  exit 2").

The CLI is run from source (`tsx packages/cli/src/index.ts`) when tsx and the entry point are
both present, falling back to `packages/cli/bin/potsherd.js` — same reasoning as `evals/run.ts`,
which imports the core from source so the eval measures the checkout rather than `dist/`. The
invocation used is printed whenever the exit code is not 2.

### the set's own integrity

Two more conditions, both of which fail the run:

- **overlap as recorded.** Every `overlap` in `ask.jsonl` is re-measured and must agree within
  0.02. A hard failure rather than a warning, because the warning version is what phase 1
  shipped.
- **decoys still unanswerable.** No single session may cover ≥ 0.90 of a decoy's content words.

Both run **before** `ask` is imported, so they are checked even on a branch where `ask` does not
exist — which is the branch this file was written on.

### the verdict

A table in `evals/run.ts`'s style, `--json` for the machine-readable form, and
`process.exitCode = ok ? 0 : 1`. `phases/phase-3/HANDOFF.md §4`: a score nobody checks is worse
than no score.

---

## proving the scorer

`evals/ask-run.ts` cannot be run end to end on this branch: `packages/core/src/ask.ts` is T4.1's
file and does not exist here, deliberately. So the scorer is proved the way it should be anyway —
`evals/ask-selftest.ts` builds `AskResult` objects by hand, each broken in one specific place,
and asserts what the scorer says about each. Twelve cases; **eleven of them must produce a
failing verdict, and must fail the gate they are named for.** Asserting the gate by name is what
stops a scorer that fails everything for the wrong reason from looking right.

```
$ tsx evals/ask-selftest.ts
potsherd ask-evals selftest · 12 cases · 10 gold, 3 decoys

  ok    every gold answer satisfies its own expectPhrases and names its own sessions

  want       (a)   (b)   (c)   set    case
  pass       ok    ok    ok    ok     ✓ clean — 10/10 covered, every quote resolves, 3/3 refused
  fail-a     FAIL  ok    ok    ok     ✓ a citation whose seq does not exist
  fail-a     FAIL  ok    ok    ok     ✓ a quote that does not occur in the exchange it cites
  fail-a     FAIL  ok    ok    ok     ✓ answer holds a sentence that is not in sentences[]
  fail-a     FAIL  ok    ok    ok     ✓ a dropped sentence is still in answer
  fail-a     FAIL  ok    ok    ok     ✓ a kept sentence with no citation at all
  fail-a     FAIL  ok    ok    ok     ✓ a sentence citing an evidence index that does not exist
  fail-b     ok    FAIL  ok    ok     ✓ covering 6 of 10 gold
  fail-c     ok    ok    FAIL  ok     ✓ a decoy answered instead of refused
  fail-c     ok    ok    FAIL  ok     ✓ a decoy refused by the library but the cli did not exit 2
  fail-set   ok    ok    ok    FAIL   ✓ ask.jsonl records an overlap it does not have
  fail-set   ok    ok    ok    FAIL   ✓ a decoy the corpus can now answer

  PASS — the scorer said the right thing about all 12 cases and about the set itself
```

The first assertion is about the **set**, not the scorer: every hand-written `gold` answer is fed
through `checkCoverage` against its own question. A gold answer that could not satisfy its own
`expectPhrases` would make its question unpassable by construction.

The stub corpus holds real lines from `evals/fixture/claude` — two exchanges, one subagent
exchange and one ghost prompt at seq 0 — so "the quote occurs in the cited exchange" is checked
against text that genuinely exists. Nothing in the selftest touches an index, a model or a
network.

If any of those eleven stops failing, the scorer is broken. Fix the scorer, not the test.

---

## what the integrator has to do

1. Add to `package.json` (RESERVED here): `"evals:ask": "tsx evals/ask-run.ts"`.
2. Nothing else. `evals/ask-run.ts` imports `ask` from `../packages/core/src/ask.js` and starts
   working the moment T4.1's file lands.

**One thing to check on integration.** `AskOptions` is not part of the interface pinned in
`phases/phase-4/WAVE.md`, so the call is written as

```ts
await ask(db, g.question, { k: o.k, root, strict } as unknown as AskOptions);
```

If T4.1's `AskOptions` spells any of those three differently, this is the one line to adjust. The
cast is there so a shape mismatch cannot silently change what is being measured.

**Expect gate (c) to fail on the first integrated run** unless `potsherd ask --strict` exits 2.
It exits 1 today (commander's unknown-command path). That is the harness working, not the harness
broken.

---

## what this does not measure

Answer quality. Ten questions cannot say whether the prose is any good, only whether every claim
is grounded, whether the right conversation was found, and whether a question with no answer got
a refusal. Cost, latency and the reader fan-out are printed for the record from `AskResult`'s own
`spend`, `ms` and `readers`, and gate nothing.

It also cannot measure `ask` against a **real** corpus. Like `evals/queries.jsonl`, this set is a
fixture: a question written against a real corpus *is* the corpus, because to be a good question
it has to quote the distinctive words of a real conversation. A private ask set against a real
index would go in `~/.potsherd/evals/` and be run with `--potsherd-dir`, which `ask-run.ts`
supports and which nobody has built yet.

---

## runs on the record

| what | command | result |
|---|---|---|
| the scorer | `tsx evals/ask-selftest.ts` | exit **0**, 12/12 cases as expected |
| the set's integrity + overlap | `tsx evals/ask-run.ts --keep` | overlap table above, no flags, no dishonest rows, no leaked decoys; exit **1** at the `ask` import, as designed |
| the fixture index those numbers came from (kept) | `--potsherd-dir /var/folders/x7/878s1bxj4c950snx6h2200k00000gn/T/potsherd-ask-evals-6BhD0X` | 46 sessions, 6 subagents, 12 ghosts, 120 exchanges, 120 vectors, 33 cards |
| corpus exploration index (kept) | `--potsherd-dir /private/tmp/claude-501/-Users-zebra-randomness/169ced20-27ee-4647-9d2c-8fac9217f6bd/scratchpad/idx` | same corpus, no vectors, no cards; used only to read the transcripts |

Both directories are temporary and outside the repo; potsherd wrote nothing anywhere else. No
verb was run with `--yes` against a fixture directory. No network.

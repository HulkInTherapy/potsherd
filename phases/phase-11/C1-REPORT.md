# C-1 — the benchmark now measures the verb, and the verb cannot be fixed by moving a constant

**Verdict, first line: F1 and F8 cannot both be held by any threshold this index can compute.**
I measured it exhaustively rather than concluding it. Over every threshold on every scale-free
quantity potsherd carries — calibrated score, coverage, absolute cosine, cosine relative to the
query's own best, and the z-score of a block's best cosine against that query's own candidate
distribution — the most that can be returned while every no-match control still comes back empty is
**16 of 60**, and that best was fitted to the five controls it was tested against. The gate needs
51/60. Per the ruling above me and above the brief, I stopped, and §2 describes the design change
instead of building it. `packages/core/src/calibration.ts` is byte-identical to `bcab843`.

Steps 1 and 3 are delivered in full. Step 2 is a refutation with the measurements attached.

---

## §0 STEP 1 — the benchmark measures the product, and the headline collapses

Done first and committed on its own (`3d7e8a3`), before any product code was touched.

### What was wrong

`recall()`'s library default is `minConfidence: 'none'` — it withholds nothing, because `recall()`
is also the shortlist builder for `ask` and `graft`. `potsherd find` runs at `weak`;
`potsherd_recall` runs at `weak`. `runMode` in `evals/run.ts` called `recall()` **with no floor at
all**, so every recall@k this project has published measured the **ranking**. `runControls`'s
docstring has said since T10.1 that what is measured here is *"what a person or an agent typing
`potsherd find` gets"* — it was true of six control queries and of none of the sixty.

### What is measured now

Two calls per query per mode, not one call filtered afterwards: `recall()` applies the floor
**before** it cuts to `limit`, so a survivor ranked 21st with the floor off can be on the first page
with it on, and the point of the change is that the instrument stops approximating the product.
Both views are reported, per mode, labelled, with the floor's cost as two counts a reader does not
have to derive. **The gate is judged on the verb**; no clause of `evals/gate.ts` moved and no line
of it was touched — what moved is which of two measurements it is handed. Its own rule line says
*"the row the user actually sees"*, and it was being handed the ranking.

### The collapsed baseline — the real number, reported before any product change

```
                          find (weak)               ranking (none)        empty pages
  bm25 only          @5   8/60  @1   8/60      @5 40/60  @1 31/60          51/60
  vectors only       @5   8/60  @1   8/60      @5 57/60  @1 40/60          51/60
  hybrid (auto)      @5   7/60  @1   7/60      @5 57/60  @1 42/60          52/60
  hybrid (always)    @5   7/60  @1   7/60      @5 57/60  @1 42/60          52/60

  phase-3 gate: FAIL on all five clauses. exit 1.
  answers ranked in the top five and withheld by the floor: 50 (hybrid)
```

This reproduces VERIFICATION-6 §C-1 to the digit — 7/60 and 52 empty pages — independently, through
the product's own instrument rather than through a verifier's script.

**Two things one number could not have shown.** Fifty of the sixty answers are found by the fusion
and deleted by the floor. And **hybrid is now below bm25 at both metrics** (7 against 8): the
semantic lane buys seventeen queries in the ranking and costs one at the floor. That is not a defect
and I did not touch it — it is P11's `combinedStrength` working as designed (*mean within a body of
evidence*), and its docstring carries the measurement that chose the mean. A row that bm25 tops and
the vector lane ranks eighth has its `strength` averaged down, which is right for ordering and
irrelevant to the floor, because the floor is computed from wording and no lane can change wording.

**Per the ruling: step 1 alone makes the gate unmeetable, and that is the finding.** `pnpm evals`
exits 1. I did not touch a clause, a query or a constant to make it exit 0.

---

## §1 THE DIAGNOSIS — the structural claim, verified, and then the ceiling measured

### The claim, verified

`calibrate()` is `score = coverage x (BASE + W_STRENGTH*strength + W_AGREEMENT*agreement)`, and
`0.60 + 0.25 + 0.15 = 1`. The bracket can never exceed 1, so **`score <= coverage` always**. And
`coverage = coveredTerms(quotableTokens, text) / quotableTokens.length` is the fraction of the
**query's literal terms** the row repeats — it has no input that can carry "the vector lane found
this". `strength` cannot substitute: `relativeStrength` normalises each list against *its own best*,
so the top row of every list donates 1.0 whether it is a bullseye or the least-bad of a bad list.

Therefore `weak` (0.5) requires at least half the query's words to appear literally, and `strong`
(0.75) three quarters, **whatever the cosine says**. Verified as arithmetic over the whole input
grid and on 126 real blocks (`tests/calibration.test.ts`, `tests/recall.test.ts`). **The claim
holds.**

### The ceiling, measured — this is the part that decides the task

On the eval run's own kept fixture index, hybrid with vectors forced on, floor off, I recorded for
every query the correct block and the best wrong block: coverage, strength, agreement, calibrated
score, the block's best absolute cosine, that cosine relative to the query's best, and its z-score
against every vec cosine that query produced.

```
                     cov                    cal                    cos                   z
                min  med  max          min  med  max          min  med  max        min  med  max
  correct  n=60 .000 .400 1.00         .000 .334 .850         .472 .645 .818       1.16 3.85 7.29
  wrong    n=60 .000 .333 .600         .000 .267 .510         .423 .540 .748       0.18 1.72 5.44
  no-match ctl  .000 .500 .667         .000 .425 .617         .415 .506 .741       0.20 1.71 4.69
```

The distributions overlap almost completely — T10.1 §d1's finding, reproduced on the 60-query set,
on today's build, **with the semantic lane on**, which is the condition T10.1 could not test.

Then the exhaustive search. For each feature, the largest threshold every no-match control's top
block already clears (excluding the ones `KEY_TERMS_REQUIRED` already refuses), and how many of the
60 correct answers survive above it:

```
  feature   must exceed   F1-safe recall   strong control survives
  cal          0.462          11/60              yes
  cov          0.500          11/60              yes
  cos          0.741           9/60              yes
  z            4.685          16/60              yes
  gap          0.286          14/60              yes
  cosRel       1.000           0/60              NO   (top row of every query is 1.0, nonsense included)
  strength     1.000           0/60              NO   (same reason)

  best 2-feature AND rule, exhaustive over every observed threshold pair: 16/60
```

**16 of 60 is the ceiling**, and it is optimistic three times over: fitted to the five controls it
is scored against, expressed partly in an absolute cosine magnitude the design forbids on stated
grounds, and measured on a corpus small enough that df-0 is common. The gate needs 51.

### Why, mechanically

The no-match controls are **compound** questions whose halves each have a real neighbourhood —
*rate limiting* + *the sitemap generator*, *bluetooth* + *the checkout page*. A single dense vector
is compositional-blind: the embedding of the whole question lands next to a session that owns one
half, and it lands there just as hard as a paraphrase lands next to its true answer. Measured:
`rate limiting the sitemap generator` puts a wrong block at cosine **0.741** and z **4.69** — above
90% of the sixty correct answers. There is nothing in a cosine that separates them.

Literal term presence *is* compositional, which is exactly why `coverage` and `KEY_TERMS_REQUIRED`
hold F1 — and exactly why they delete paraphrase, because paraphrase is the case where the literal
terms are gone. **The two requirements are the same quantity read in opposite directions.**

### The shape I built and refuted

The brief's first candidate, and the one T10.1 §d1 recommended as the thing that would close the
gap: **coverage over the query's distinctive terms** (`key.terms`, already scale-relative — the more
selective half of the content words, df-0 dropped, capped at 4) instead of over every word typed.
Prototyped behind a flag, measured, reverted:

```
  empty pages 52/60 -> 36/60 ;  verb recall@1 7 -> 11 ;  all six eval controls still pass
  BUT ranking recall@5 57 -> 55, recall@1 42 -> 30
  AND, on the demo corpus, through the four queries in the brief:
    "everything queued up and timed out under load" -> 6 rows, top = the WRONG session, STRONG
    "we exhausted our allowance of open channels"   -> 9 rows, top = an unrelated sms session, STRONG
```

With a keyphrase of one or two terms, coverage becomes near-binary and everything that shows the one
distinctive word scores `1.0 x 0.85 = 0.85` — `strong`. That is the brief's own stop condition:
*if everything becomes strong, the cliff is gone and you have traded F1 for F8 in the other
direction.* Reverted. `packages/core/src/recall.ts` carries no part of it.

The other two shapes the brief offers are refuted by the table above: a **per-lane floor** is a floor
on `strength`/`cosRel`, both of which are 1.0 for the top row of a nonsense query (0/60 F1-safe); a
floor **as a function of the query** is a threshold move on `cal`, whose whole ROC is in the table
(best 11/60 with F1 intact, 34/60 only by breaking two controls).

---

## §2 WHAT CHANGED, WHAT DID NOT, AND THE DESIGN CHANGE

### Changed

* **`evals/run.ts`** — §0. `VERB_FLOOR`/`RANKING_FLOOR`, two calls per query, both views reported,
  the gate judged on the verb, `floor` and per-mode `ranking` in `--json`, a `↓n` cell that says
  *the fusion ranked this nth and `find` returns nothing*, and a direct-invocation guard so a test
  can import the constants without building an index.
* **`packages/mcp/src/tools/recall.ts`** — §3 below.
* **`packages/cli/src/commands/find.ts`** — comment only. `minConfidence()`'s docstring now carries
  what the default costs, measured, and the ROC that says why it must not move anyway.
* **`evals/per-query-baseline.json`** — regenerated deliberately, `pnpm evals -- --json | node
  scripts/write-eval-baseline.mjs`, never hand-edited. It now pins the **verb's** pass/fail per
  query, which is the first time it has pinned the product. 312 lines changed; every one of them is
  step 1.

### Not changed, deliberately

`packages/core/src/calibration.ts` and `packages/core/src/recall.ts` are byte-identical to
`bcab843`. No constant moved. `evals/gate.ts` and `evals/queries.jsonl` untouched. P11's
`AGREEMENT_LISTS` and `combinedStrength` untouched.

### The design change, described and not built

The floor needs a compositional check **in the semantic currency**. Today it asks *does this row
repeat the words you typed*; it needs to ask *for each distinctive term of your question, is there
something in this row that means that term*. On the four demo queries: `channels`→`connections`,
`allowance`→`pool limit`, `exhausted`→`saturated` — every term covered, so the pgbouncer session
clears. On `rate limiting the sitemap generator`: `rate` and `limiting` covered by the webhook
session, `sitemap` and `generator` covered by nothing in it — coverage 0.5, refused. Compositionality
restored, F1 intact, and the quantity is still a fraction of the query rather than a magnitude, so
`plans/08`'s scale rule survives.

**It needs an index potsherd does not have.** potsherd embeds whole exchanges; this needs term- or
span-level vectors, or a learned lexical expansion (doc2query / SPLADE-style) that writes a thread's
paraphrases into `exchanges_fts` at index time so that literal coverage starts finding them. Either
is a new index, a new build step and a new size budget. It is a phase, not a patch, and it is not
mine to start. The cheap-looking shortcut — *drop a query term from the denominator when its df is
0* — was measured and must be refused: on the demo corpus it lifts the paraphrase cases, and on a
433 MB archive every English word has df > 0, so the denominator returns to full length and the rule
becomes a no-op. That is T10.1 §d1's recorded objection to IDF, arriving by a second road.

---

## §3 STEP 3 — the model door, and the artifacts

### What was wrong

`potsherd_recall`'s description says `TRUST ITS SILENCE` in capitals; its reply says
`belowFloor: 30`; its input schema was `query, scope, want, budget`. **The agent instructed to trust
the silence could neither check it nor override it**, while the human at the CLI was shown
`--min-confidence none` on the same empty screen. The `note` told it *"The archive does not contain
this"* — false on 50 of the 60 queries the floor empties.

### What it is now

`minConfidence: 'strong' | 'weak' | 'none'` in the schema, defaulting to `AGENT_FLOOR`. **The
default path is byte-identical**: absent topic and nonsense still return zero rows and
`noMatch: true`. Only an explicit `"none"` hands back what was withheld — labelled `none`, with a
note saying in words that it is not an answer and may not be cited as one. `noMatch` still means what
it always meant; what changed is that the rows and the envelope's verdict are now two facts.

```
$ potsherd_recall {"query":"we exhausted our allowance of open channels"}
  confidence none  noMatch true  belowFloor 30  minConfidence weak  threads 0
  note: no match: nothing cleared the confidence floor. 30 rows were withheld below the weak
  floor. The floor measures how many of your literal words a thread repeats, not whether the
  archive holds the answer, so a question phrased differently from the transcript scores none
  over an index that has it. Call again with minConfidence: "none" to see those rows — they are
  the closest text, not an answer, and may not be cited as one — or with two to four distinctive
  nouns instead of a sentence. Do not widen into a guess, and do not answer from the repository
  in front of you.

$ potsherd_recall {"query":"we exhausted our allowance of open channels","minConfidence":"none"}
  confidence none  noMatch true  belowFloor 0  minConfidence none  threads 10
  note: these 10 rows are below the confidence floor and are labelled none: they are the closest
  text in the archive to your words, not an answer to your question. Read them to judge for
  yourself, do not cite them as a source, and do not report them to the user as what was decided.
```

The note also now distinguishes the two empties that used to read identically — *nothing in the
index matched these words at all* (the strong empty, which keeps *"saying the archive does not have
this is a real answer"*) from *nothing cleared the confidence floor*.

### The four demo-corpus queries, through the binary

```
$ potsherd find "pgbouncer pool saturated" --vectors on
  potsherd find "pgbouncer pool satura… · 1 session · weak · bm25 + vectors · 1.6s
    Pool the ingest workers through pgbouncer            data-pipeline   weak  0.1579

$ potsherd find "everything queued up and timed out under load" --vectors on
  potsherd find "everything queued up… · 1 session · weak · bm25 + vectors · 1.3s
    Pool the ingest workers through pgbouncer            data-pipeline   weak  0.1337

$ potsherd find "database handles ran out during heavy traffic" --vectors on
  potsherd find "database handles ran out duri… · no match · bm25 + vectors · 1.3s
    nothing in the index answers "database handles ran out during heavy traffic".
    29 sessions matched some of those words and none of them enough
    --min-confidence none  shows them anyway

$ potsherd find "we exhausted our allowance of open channels" --vectors on
  potsherd find "we exhausted our allowance of… · no match · bm25 + vectors · 1.3s
    nothing in the index answers "we exhausted our allowance of open channels".
    30 sessions matched some of those words and none of them enough
```

**Two of four still fail, and the ACCEPT item is not met.** That is the ruling, stated as a
measurement: cov 0.166 → cal 0.142 and cov 0.25 → cal 0.210, against a floor at 0.5 that cannot be
lowered to 0.14 without returning rows for every one of the eight negative controls below.

### The fresh negative controls — mine, invented after the freeze

Corpus frozen first: `scripts/make-demo-corpus.mjs`, 228 sessions, tree digest
`7c758ad6cfb18974d9c0b8f8fa22144135756344c06540e2c59b9daf3f4990f4`. None of the three appears in
`VERIFICATION-{3,4,5,6}.md` or anywhere in the repository, confirmed by `grep -ril`; absence in the
corpus confirmed the same way (`flimberzork` 0 files, `quaddlepan` 0, `kerberos` 0, `thermostat` 0,
`firmware` 0, `field units` 0; `pagination` 20 files, so half of control 2 has a large,
genuinely-relevant-looking neighbourhood, which is what makes it the hard one).

```
CLI DOOR                                                     exit  result
  flimberzork quaddlepan                     no vectors in index   1  no match
                                             vectors present, off  1  no match
                                             vectors present, on   1  no match
  pagination for the kerberos ticket list    no vectors in index   1  no match
                                             vectors present, off  1  no match
                                             vectors present, on   1  no match
  thermostat firmware rolled out to the …    no vectors in index   1  no match
                                             vectors present, off  1  no match
                                             vectors present, on   1  no match

MODEL DOOR (runRecall, the function the server calls)
  no-vectors-in-index  threads 0 hits 0  noMatch true  none  withheld  0  << flimberzork quaddlepan
  no-vectors-in-index  threads 0 hits 0  noMatch true  none  withheld 13  << pagination for the kerberos …
  no-vectors-in-index  threads 0 hits 0  noMatch true  none  withheld 25  << thermostat firmware rolled …
  vectors-present      threads 0 hits 0  noMatch true  none  withheld 27  << flimberzork quaddlepan
  vectors-present      threads 0 hits 0  noMatch true  none  withheld 28  << pagination for the kerberos …
  vectors-present      threads 0 hits 0  noMatch true  none  withheld 30  << thermostat firmware rolled …
```

Zero rows everywhere. Note the third column of the last three lines: **with vectors on, even
`flimberzork quaddlepan` has 27 candidates withheld.** The vector lane returns rows for anything.
That is the measurement behind `cosRel` scoring 0/60 in §1 and it is why a relative-cosine floor is
not available.

### Every new assertion, red first

```
### RED-FIRST — tests/calibration.test.ts, with WEIGHT_STRENGTH 0.25 -> 0.35
 FAIL  C-1 — coverage is a ceiling … > never scores a row above its own literal coverage, over the whole input space
 AssertionError: expected 0.50625 to be less than or equal to 0.500000000001
 FAIL  C-1 — coverage is a ceiling … > cannot reach the weak floor below half the query, at any strength or agreement
 AssertionError: expected 1.0999999999999999 to be close to 1, received difference is 0.09999999999999987

### RED-FIRST — tests/recall.test.ts, with WEAK_FLOOR 0.5 -> 0.1
 FAIL  recall: the vector half > C-1 — withholds an answer the semantic lane ranked first, because the wording is absent
 AssertionError: expected [ { …(26) }, { …(26) } ] to deeply equal []

### RED-FIRST — tests/find.test.ts, with find.ts minConfidence() default weak -> none (T10.1 d1's own lever)
 FAIL  C-1 — the floor is set by the verb … > defaults to weak, and only an explicit none turns the cliff off
 AssertionError: expected 'none' to be 'weak'
 FAIL  C-1 — the floor is set by the verb … > the model door runs at the same floor the human door does
 AssertionError: expected 'weak' to be 'none'

### RED-FIRST — tests/evals-gate.test.ts, with VERB_FLOOR weak -> none (the pre-C-1 state)
 FAIL  C-1 — the instrument measures the product > runs the recall set at exactly the floor potsherd find runs at
 AssertionError: expected 'none' to be 'weak'
 FAIL  C-1 — the instrument measures the product > keeps the ranking view, at the library default that withholds nothing
 AssertionError: expected 'none' not to be 'none'

### RED-FIRST — tests/mcp.test.ts, against bcab843's packages/mcp/src/tools/recall.ts
 FAIL  C-1 step 3 > declares minConfidence in the schema, with the three bands
 AssertionError: expected [ 'query', 'scope', 'want', 'budget' ] to include 'minConfidence'
 FAIL  C-1 step 3 > minConfidence: "none" hands back the rows the floor withheld, labelled none
 AssertionError: expected 'weak' to be 'none'
 FAIL  C-1 step 3 > the empty note tells the truth about what silence means, and names the way out
 AssertionError: expected 'no match. The archive does not contai…' not to match /The archive does not contain this/
 FAIL  C-1 step 3 > distinguishes the two empties that used to read the same
 AssertionError: expected 'no match. The archive does not contai…' to match /nothing in the index matched these wo…/
 FAIL  C-1 step 3 > raising the floor is possible too, and is not a second way of lowering it
 AssertionError: expected 'weak' to be 'strong'
```

Three existing assertions were corrected rather than deleted, each with the reason in place:
the recall schema's pinned field list (`budget, query, scope, want` → plus `minConfidence`), the
source pin on the call site (`AGENT_FLOOR` → `requestedFloor`, with a second line pinning that
`requestedFloor` defaults to `AGENT_FLOOR`), and `/^no match\./` → `/^no match: /` plus a new
negative assertion that *"The archive does not contain this"* never comes back.

---

## §4 THE NUMBERS

```
pnpm test                                  2,000 passed  /  55 files  /  0 failed
POTSHERD_SQLITE=node pnpm test             2,000 passed  /  55 files  /  0 failed
pnpm typecheck                             4 of 4 Done
python3 scripts/check-privacy.py           exit 0 (read from $?)
pnpm build && pnpm vendor                  2 files vendored, 2.7 MB
pnpm evals                                 exit 1 — the finding, see §0
disk  before 6.7 GiB free  ·  after 5.3 GiB free  (kept eval indexes removed after measuring)
processes  no embedder spawned: every index ran --embed (foreground) or --no-embed.
           `ps` before and after showed only two pre-existing plugin MCP servers and one other
           worker's test run, none of them mine, none touched.
```

The suite was 1,985 at `bcab843`; 15 assertions added, 0 regressions.

---

## §5 WHAT I COULD NOT DO

1. **Step 2's product fix.** Ruled out with the measurements in §1. `calibration.ts` and `recall.ts`
   are unchanged. Two of the four demo queries still return nothing.
2. **`pnpm evals` exit 0.** Unreachable at the verb's floor; §0. Making it exit 0 would have meant
   moving the floor (F1) or re-pointing the gate at the ranking (the defect).
3. **Two files outside my deliverable list**, stopped at the boundary. Exact patches:

**a. `packages/mcp/src/descriptions.ts`** — `RECALL_DESCRIPTION`, third paragraph. `TRUST ITS
SILENCE` is kept because step 3 *earns* it — the silence is now checkable and overridable — but the
sentence after it is false and must go. Replace:

```
TRUST ITS SILENCE. Every reply carries confidence — strong, weak or none — and a none comes back
with ZERO rows and a "no match" note. That is a real answer: the archive does not contain this, and
saying so is better than widening into a guess. Never fill an empty result from the repository in
front of you.
```

with:

```
TRUST ITS SILENCE, AND CHECK IT ONCE. Every reply carries confidence — strong, weak or none — and a
none comes back with ZERO rows and a "no match" note. Never fill an empty result from the repository
in front of you. But the floor measures how many of your literal words a thread repeats, not whether
the archive holds the answer, so a sentence-shaped question can come back none over an index that
answers it at rank 1. If the note says rows were withheld, ask once more with two to four
distinctive nouns, or pass minConfidence: "none" to read the withheld rows yourself — they are the
closest text, not an answer, and may not be cited as one. If nothing was withheld, the archive
really does not have it, and saying so is the answer.
```

This keeps every string `tests/mcp.test.ts` asserts on (`TRUST ITS SILENCE`, `ZERO rows`,
`no model call, no cost`) and stays inside the 2,400-character ceiling that file enforces.

**b. `packages/core/src/render/find.ts:70`** — the CLI's empty screen makes the same false claim the
model door's note did. Another worker is live in that file. Replace:

```ts
            ? `nothing in the index answers ${JSON.stringify(result.query)}.`
```

with:

```ts
            ? `nothing in the index repeats enough of ${JSON.stringify(result.query)} to clear the ` +
              `${result.minConfidence} floor.`
```

The line under it (*"N sessions matched some of those words and none of them enough ·
--min-confidence none"*) is already true and already carries the escape hatch; it is the headline
that overstates. `docs/screens/09-find.txt` and `13-find-redacted.txt` do not contain this string and
are unaffected; nothing asserts on it in `tests/`.

4. **The reference archive.** Everything here is the demo corpus (546 KB, 228 sessions) and the eval
   fixture. T10.1 §d5's open question — whether block coverage is depressed further on 150-exchange
   sessions, which would make the verb's number *worse* on a real archive, not better — is still
   open, and §1's ceiling should be re-measured there before the design change in §2 is scoped.

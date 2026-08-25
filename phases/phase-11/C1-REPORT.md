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

---

# ROUND 2 — the fourth option: keep the floor for the LABEL, drop it for WITHHOLDING

Measured, not shipped. No product file changed in this round; `git diff` against `ffcd4ac` is this
section. Option 4 is `recall()` at `minConfidence: 'none'` with the labels left on — which is
exactly the `ranking` column step 1 already prints, so the recall half needed no new instrument.

## §R2.0 The premise, checked — and it is half true

> *it is not the floor that makes nonsense return empty — FTS finds no term at all*

**True on a cold index. False the moment there are vectors.** The vector lane always returns its
nearest neighbours; nothing in it can decline. Verbatim, on the frozen demo corpus (the digest recorded in §3, rebuilt and
re-verified byte-identical this round), at `--min-confidence none`:

```
$ potsherd find "flimberzork quaddlepan" --min-confidence none        [COLD: 0 of 439 embedded]
potsherd find "flimberzork quaddlepan" · no match · bm25 · 12ms

  nothing in the index matches "flimberzork quaddlepan".

  text search only — no embeddings in the index, and nothing is embedding them
  semantic search: not running (0 of 439 embedded) — the 46.1 MB runtime has not been fetched

$ potsherd find "flimberzork quaddlepan" --min-confidence none        [FULL: 439 of 439 embedded]
potsherd find "flimberzork quaddl… · 10 sessions · none · bm25 + vectors · 603ms

  refactor the audit log so the retry logic lives in one place     claude · live
  mobile-shell · 5 aug · 12 exchanges · develop                     none  0.1469
    simplify the pagination helper; it has four levels of nesting
    write a smoke test for the graphql resolver
    no words in common — this one matched on meaning
    run  claude --resume ‹elided›

  Investigate rss parser regression                                claude · live
  event-bus · 10 aug · 7 exchanges · develop                        none  0.1445
    simplify the image resizer; it has four levels of nesting
    no words in common — this one matched on meaning
```

The warming state (155 of 439 embedded, built by growing one HOME in place so the first six
projects' vectors survive the second pass) behaves as the full state does: **10 sessions**. So on
every index a user is on after `index --embed` — which F2 argues should be the default — option 4
restores audit F1's headline symptom verbatim: *ten rows for a word that does not exist in any
human language.* They now say `none` and carry `no words in common — this one matched on meaning`,
which is a real improvement over 23 aug and is not nothing. The header still says `10 sessions`.

## §R2.1 Recall on the 60-query set at the verb, with nothing withheld

This is step 1's `ranking` column, which is option 4 by definition:

```
                     option 4 (label, don't withhold)     shipped (withhold at weak)
  bm25 only          @5 40/60   @1 31/60                  @5  8/60   @1  8/60
  vectors only       @5 57/60   @1 40/60                  @5  8/60   @1  8/60
  hybrid (auto)      @5 57/60   @1 42/60                  @5  7/60   @1  7/60
  hybrid (always)    @5 57/60   @1 42/60                  @5  7/60   @1  7/60
```

Option 4 clears the 51/60 ratchet and passes all five gate clauses. **The recall case for it is
real and it is large.** Everything below is about what the reader is holding.

## §R2.2 The deciding question — `none` or `weak`?

Your test: *if absent topics can reach `weak` while paraphrase answers sit at `none`, this option is
dead.* Measured on the eval fixture, floor off, both vector states, all six committed controls:

```
### vectors=on  floor=none
  CONTROL strong    rows 20  top=strong  cal 0.850  rows>=weak 1   << pgbouncer transaction pooling
  CONTROL no-match  rows 20  top=none    cal 0.212  rows>=weak 0   << kubernetes ingress payment service
  CONTROL no-match  rows 20  top=none    cal 0.000  rows>=weak 0   << vondrelic pashtomeer
  CONTROL no-match  rows 20  top=none    cal 0.462  rows>=weak 0   << dark mode for the invoice pdf
  CONTROL no-match  rows 20  top=none    cal 0.425  rows>=weak 0   << rate limiting the sitemap generator
  CONTROL no-match  rows 20  top=none    cal 0.617  rows>=weak 0   << bluetooth on the checkout page   [cap=none]
  CORRECT ANSWERS n=60   strong 4   weak 3   none 53   not-found 0

### vectors=off  floor=none
  … five no-match controls, top=none, rows>=weak 0 on every one
  CORRECT ANSWERS n=60   strong 2   weak 6   none 42   not-found 10
```

**The literal answer to your test is no: no absent-topic page has a single row at `weak` or above,
at either vector state, at both doors.** By the letter of the test, option 4 survives.

**But the label is not discriminating — it is constant.** 53 of 60 correct answers are `none` too.
Both cases render `none`, so the label carries zero bits about which one the reader is in. And on the
demo corpus the ordering is not merely uninformative, it is **inverted on a measured pair**:

```
### demo corpus, fully embedded, floor=none                        header  top    calibrated
  TRUE    pgbouncer pool saturated                                 weak    weak     0.5667
  TRUE    everything queued up and timed out under load            weak    weak     0.6291
  TRUE    we exhausted our allowance of open channels              none    none     0.2099
  TRUE    database handles ran out during heavy traffic            none    none     0.1417
  ABSENT  pagination for the kerberos ticket list                  none    none     0.2093
  ABSENT  thermostat firmware rolled out to the field units        none    none     0.1850
  ABSENT  flimberzork quaddlepan                                   none    none     0.0000
```

A correct paraphrase answer sitting at rank 1 scores **0.2099**; a genuinely absent topic scores
**0.2093** — a gap of **0.0006**. And `thermostat firmware rolled out to the field units`, which
nothing in the archive is about, scores **0.1850**, *above* `database handles ran out during heavy
traffic` at **0.1417**, whose correct answer is the row underneath it.

Audit F1's complaint was arithmetic: *"a real hit and pure gibberish differ by 1.67x."* Under option
4 the closest true/absent pair differs by **1.003x** in the calibrated score and by **0.00** in the
label. **That is F1's own finding, reproduced, on the number F1 asked for.**

## §R2.3 The two real-English controls, verbatim, and the `plans/05` reading

```
$ potsherd find "pagination for the kerberos ticket list" --min-confidence none   [FULL]
potsherd find "pagination for the… · 10 sessions · none · bm25 + vectors · 542ms

  Untangle token refresh error handling                            claude · live
  auth-gateway · 17 aug · 12 exchanges · fix/flaky-e2e              none  0.1524
    write the migration for the pagination helper
    run  claude --resume ‹elided›

  ↳ add metrics to the pagination helper so we can alert on…  claude · sidechain
  billing-web · 29 jul · 1 exchange · chore/deps · flake-hunter     none  0.1557
    add metrics to the pagination helper so we can alert on it

$ potsherd find "thermostat firmware rolled out to the field units" --min-confidence none  [FULL]
potsherd find "thermostat firmwar… · 10 sessions · none · bm25 + vectors · 540ms

  ↳ write the rollback plan for the backup job                claude · sidechain
  docs-site · 13 aug · 1 exchange · chore/deps · migration-planner  none  0.1560
    The type error was real — the field is optional upstream.
```

**My reading, as a `plans/05` judgement.** The header says `none` and every row says `none`, so
strictly the screen makes no claim it cannot support, and on that narrow reading F1 is held in
substance. But `10 sessions` is the first thing on the line and `none` is the third, and the second
screen's snippet — *"The type error was real — the field is optional upstream"* — is a real sentence
from a real session offered under a query about thermostat firmware. A human glances at the titles
and knows. An agent has been handed ten resume commands and a citation line for a question the
archive has nothing to say about, and the only thing telling it so is one word it must weigh against
seven signals pointing the other way. That is the state the audit scored 3/10.

## §R2.4 Both doors, three vector states, and `belowFloor`

```
MODEL DOOR, minConfidence: "none"          threads   conf   noMatch   threads>=weak
  cold  flimberzork quaddlepan                   0   none     true          0
  cold  pagination for the kerberos ticket list 10   none     true          0
  cold  thermostat firmware rolled out …        10   none     true          0
  warm  flimberzork quaddlepan                  10   none     true          0
  warm  (both real-English controls)            10   none     true          0
  full  (all three)                             10   none     true          0
```

`noMatch` stays `true` and `confidence` stays `none` throughout, which is the one genuinely good
property of option 4 at the model door: the envelope's verdict survives even when rows are attached,
and step 3's note already says in words that such rows are not an answer.

**`belowFloor` stops being meaningful.** It is `built - surviving`, so at floor `none` it is `0` by
construction on every query — the counter that today distinguishes *nothing matched* from *eleven
matched and none well enough* reads `0` in both cases. Under option 4 the two are told apart by
`threads.length` instead, which works, but the field would need to be redefined or retired rather
than left reading `0` next to ten rows.

## §R2.5 What option 4 costs that is not a judgement call

`evals/queries.jsonl` — which I may not edit and would not — says of `vondrelic pashtomeer`:
*"Must return ZERO rows"*, and of the other four no-match controls the same. At floor `none` with
vectors on, **four of the five return 20 rows each**, so `pnpm evals` fails on its controls, and it
fails on the one the audit itself reported. Option 4 is not merely a judgement call about a screen:
it contradicts a committed criterion that six verification rounds have left standing.

## §R2.6 The vector states, and whether they change the arithmetic

They change what the reader sees and they do **not** change the ceiling.

* **Cold** (0 of 439): nonsense returns 0 rows from FTS, exactly as you said. Correct answers
  reaching `weak`+ : **8 of 60** (2 strong, 6 weak) — but 10 answers are not found at all, because
  bm25 alone cannot find them.
* **Warming** (155 of 439) and **full** (439 of 439): nonsense returns 10 rows. Correct answers
  reaching `weak`+ : **7 of 60** (4 strong, 3 weak), with 0 not found.

So the F1-safe recall is 7–8 of 60 at the shipped floor in *every* vector state, against §1's
exhaustively-searched ceiling of 16/60 for any threshold rule at all. **The cold state is the only
one in which the coordinator's premise holds, and it is also the state in which the semantic lane —
the thing that would answer the paraphrase — is switched off.** The two conditions are mutually
exclusive: you get the honest empty for nonsense exactly when you have given up the recall that
motivated the change.

## §R2.7 My reading

**Option 4 does not hold F1, and it is closer than anything else measured.** It passes your literal
test and fails the thing the test was proxy for. Three findings, in the order I weigh them:

1. **The label is constant, not discriminating.** `none` on 53 of 60 correct answers and on 5 of 5
   absent topics. A cliff that fires on every page is a plain. The closest true/absent pair differs
   by 0.0006 of calibrated score, and one absent topic outscores one true topic outright.
2. **Nonsense returns ten rows on any embedded index.** F1's headline symptom, restored on the state
   most users are in, mitigated only by the words `none` and *no words in common*.
3. **It fails four committed controls** that say *Must return ZERO rows*.

If the ruling is that (1) is acceptable because the reader is never *told* the archive answers — a
defensible `plans/05` reading, and yours to make — then option 4 is the shape that ships and it is
smaller than anything in §2: it is one word in `find.ts`'s `minConfidence()` and one in
`AGENT_FLOOR`, plus a redefinition of `belowFloor` and an amendment to those four controls by
whoever owns `queries.jsonl`. I would not make that ruling myself, on (2) alone: an agent told in
capitals to trust a silence, and handed ten resume commands for `flimberzork quaddlepan`, is the
audit's archaeologist again.

**What I would rule instead, and it is a third path neither of us has costed:** option 4's real
content is that *withholding and labelling are separable*. They can be separated the other way —
keep the empty page for the **envelope**, and let the caller who has been told `belowFloor > 0` ask
for the rows. That is step 3, already built and already shipping in this branch at the model door,
and `--min-confidence none` is its CLI half. It gives an agent the recall of option 4 in one extra
call, on purpose, with the note saying what the rows are — and it costs no control, no label and no
committed criterion. It does not fix `find` for a human who types a sentence once, which is the gap
§2's design change is for.

# FIX-I — two releases' worth of fixes landed at the MCP door; the CLI door now says the same thing

Branch `work/FIX-I`, cut from `origin/main` at `7396c3e`. Four items from `VERIFICATION-5 §C`:
**C-1** (★★★★★ the `weak` row above a `strong` header), **C-2** (★★★★ the two doors disagree about
`citable`), **C-5** (★★★ `--readers-out` carries no `schema` and no `instruction`), **C-7** (★★ a
reply with evidence and no `answer` key renders as the honest empty).

**All four reproduced. All four are closed.** One thing did not go the way the brief assumed and it
is the most important paragraph in this report: **`pnpm evals` exits 1 after this change and exits 0
before it**, and it is not because recall fell — recall rises in every mode. §3 and §4 carry the
numbers and the decision.

**Identifiers.** Every session id, id8 and project name below is from
`scripts/make-demo-corpus.mjs` — a synthetic corpus generated in a relocated `$HOME`, nothing from
any real archive — and is nonetheless replaced one-to-one by a label (`S1`…`S13`, `P1`…). The
mapping is stable within this document.

---

## §0 THE CLAIMS, CHECKED BEFORE ANYTHING WAS FIXED

Corpus: `node scripts/make-demo-corpus.mjs "$SC/home/.claude"` — entirely synthetic, 31 sessions,
228 records — indexed with `--no-embed` into a scratch `--potsherd-dir` under a relocated `$HOME`.
No embedder was spawned by anything in this report; see §3's isolation note.

### C-1 — `find` orders by the fused score, so `sessions[0]` can be the weakest row · **CONFIRMED**

A scan of 40 queries built from the corpus's own session titles, at `--min-confidence none`, asking
one question: **within a summary/transcript group, does any row carry a better label than the row
above it?**

```
$ node scan.mjs $(cat queries.txt)        # potsherd find "<q>" --json --min-confidence none
Q="document dead letter"          n=10 header=weak   INV=[CONF@1 none->weak]
Q="investigate parser regression" n=10 header=strong INV=[CONF@9 none->weak]
Q="batch writes release"          n=10 header=strong INV=[CAL@6 0.268->0.535]
Q="pagination graphql resolver"   n=10 header=strong INV=[CAL@3 0.553->0.567]
Q="harden metrics exporter"       n=9  header=weak   INV=[CAL@3 0.557->0.562]
Q="untangle token refresh"        n=9  header=weak   INV=[CAL@1 0.546->0.567]
   … 6 more
--- scanned 40 queries with rows: 12 carry an ordering inversion (12 inversions)
```

The clearest one, `untangle token refresh`, is C-1 exactly: `sessions[0]` calibrates **0.546** on a
page whose best row calibrates **0.567**, and it is the *sixth* best-calibrated row of nine.

### C-2 — `find --json` says a title-only block is citable · **CONFIRMED**

Same scan, same 40 queries:

```
--- 26 of 40 queries carry a summary-only row marked citable=true
Q="deploy" n=9
    0 strong cal 0.839 rrf 0.01613 true  exchange
    …
    5 weak   cal 0.850 rrf 0.02459 true  title      <- kinds=['title'], citable=true
    6 weak   cal 0.850 rrf 0.02419 true  title
    7 weak   cal 0.850 rrf 0.02381 true  title
    8 weak   cal 0.850 rrf 0.02344 true  title
```

Both doors, one index, one query — see §2 for the full transcript:
`find --json` → `citable True`; `potsherd_recall` → `citable False, citation NULL`.

### C-5 — the `--readers-out` file carries neither field · **CONFIRMED**

```
$ node -e "…writeReadersFile…; console.log(Object.keys(file))"     # at 7396c3e
READERS-FILE KEYS ["kind","version","potsherd","question","k","sessionIds","targets","index"]
```

The fifth verifier's list, character for character. No `schema`, no `instruction`; `quotes: […]` is
the whole specification of a quote, and the correct shape `{seq, text}` appears nowhere in the file,
in `--help`, or in the receipt.

### C-7 — an evidence-only reply is byte-identical to the honest empty · **CONFIRMED**

The strongest form of the claim, measured rather than inferred: the two replies are run through the
same `filterHostAnswer` on the same staged synthesis file and compared field for field.

```
$ npx vitest run tests/zz-fixi-probe.test.ts        # at 7396c3e, scratch probe, not committed
EVIDENCE-ONLY   {"ok":true,"answer":"","sentences":0,"evidence":0,"dropped":0}
HONEST-EMPTY    {"ok":true,"answer":"","sentences":0,"evidence":0,"dropped":0}
IDENTICAL       true
```

`{"evidence":[<one entry validateSynth would have accepted>]}` and `{"evidence":[],"answer":[]}` are
**indistinguishable**. The first is a reply nobody finished; the second is the host's own honest
empty; both reach exit 1 and print the same sentence.

---

## §1 WHAT CHANGED, AND WHY THAT SHAPE

### C-1 · one comparator, in core, and the doors take the order they are given

`packages/core/src/recall.ts` gains **`byLabel`** beside `byLane`, carrying FIX-D's reasoning
verbatim, and **`packages/mcp/src/tools/recall.ts` loses `orderByLabel`** together with
`CONFIDENCE_RANK`, `evidenceRank`, `calibrationScoreOf` and `scoreOf` — 5,497 characters of a rule
that existed in one package and not the other.

The keys, in order:

1. **the lane** (`LANES`). This is *not* in FIX-D's version and it has to be. `laneOfHit('title')`
   is `evidence` while a title is summary-only, so on the flat `hits[]` list the lane and
   `summaryRank` genuinely disagree, and with the confidence word in front a card labelled `weak`
   sorted above a title labelled `none`. `tests/cards-lane.test.ts` caught it in the first full run
   (`the audit's failing case > puts every routing block below every evidence block, at any card
   weight` — `expected 2 to be less than 1`). F6's partition stays in front of everything the label
   says.
2. **the confidence word** — not `calibration.score`. This is FIX-D's load-bearing sentence and it
   survives intact: a routing row's score is deliberately *not* rewritten when `ROUTING_CEILING`
   caps its label, so sorting on the number alone puts a card straight back on top of a transcript.
   The cap lives in the word.
3. **`calibration.score`**, within a band.
4. **the fused score**, the merge order, last.

`summaryRank` stays in front of all four, applied by the callers exactly as FIX-F left it, so a
summary still never outranks a transcript whatever it scores.

**Two sorts, not one.** The page is *selected* with `byLane` — untouched — and then *ordered* with
`byLabel`:

```ts
sessions.sort((a, b) => summaryRank(a.hits) - summaryRank(b.hits) || byLane(a, b));
sessions.length = Math.min(sessions.length, limit);
sessions.sort((a, b) => summaryRank(a.hits) - summaryRank(b.hits) || byLabel(a, b));
```

The brief's constraint is *"no row may be added, dropped or rescored — the same rows, moved"*, and
the cut happens between the two sorts. Sorting once, before the cut, would make the label a
**selector** as well as an order. It was written that way first; the difference is measured in §3.
Measured on all 40 scanned queries: **membership identical on every one, order different on 12.**

The flat `hits[]` list is built from the already-cut `sessions`, so `byLabel` there is a pure
reorder too, and it is what `potsherd_recall`'s `hits[]` is now handed directly.

`groupThreads` preserves the order: it emits threads in order of first appearance and each thread's
lead is its first member, so the leads are a subsequence of an ordered list. And because
`summaryRank` is the first key, a thread whose lead is summary-only has no member that is not — so
the thread's own `evidence` field and its lead's rank cannot disagree.

### C-2 · the permission is computed once and published on the row

`citableBlock(hits, lane)` in core, `RecallSession.citable` on every block `recall()` returns, and
both doors read the field:

```ts
// packages/cli/src/commands/find.ts   was: citable: (s.lane ?? 'evidence') === 'evidence'
citable: s.citable === true,
// packages/mcp/src/tools/recall.ts    was: (lead.lane ?? …) === 'evidence' && evidence !== 'not-a-transcript'
const citable = lead.citable === true;
```

`=== true` rather than `?? <a rule spelled here>`: a fallback would be a door quietly holding a
second opinion again, and if the field were ever absent the safe direction for *you may quote this*
is to withhold it.

The MCP door's `citation` is now minted off **the same boolean** rather than off a second spelling
of the same condition, so a thread cannot be uncitable and carry a citation. `citableNote` still
keys on `evidence`, because that field explains *why*.

The two conditions are both necessary and they ask different questions — *is this a routing aid*
(the lane) and *is there anything here a reader could quote* (the kinds). That is why
`laneOfSession` alone was never enough, and why `title` staying out of `ROUTING_KINDS` was right.

### C-5 · `schema` and `instruction`, in the register FIX-G established

`READERS_SCHEMA` and `READERS_INSTRUCTION` in `packages/cli/src/commands/ask.ts`, written into the
file, into the `--json` receipt, and named on the human receipt.

```
["kind","version","potsherd","schema","instruction","question","k","sessionIds","targets","index"]
```

```
{"outputs":[{"sessionId":"<the sessionId of this entry in targets>","found":true|false,
 "quotes":[{"seq":<number, one of this entry's seqs>,"ts":"<the ts given>"|null,
 "text":"<verbatim, character for character out of this entry's excerpts>"}],
 "answer_fragment":"<one or two sentences, or empty when found is false>"}]}
```

**FIX-G §1.4's finding is not repeated.** Nothing in the instruction refers to anything by a
pronoun: the array is named, its shape is named by field, the fact that `"outputs"` is *the JSON
array itself and not the JSON text of it* is stated — this file's reader is deliberately stricter
than the synthesis file's, which parses a string for you — and the case an agent is most likely to
get wrong, a reader that found nothing, is spelled out. `tests/synthesis-seam.test.ts` asserts the
absence of the old sentence (`not.toMatch(/add it to the file/)`).

The receipt changed from *"run your readers, add an "outputs" array to the file"* to a line that
names the shape and points at the file's own `schema` field.

Both fields are **informational**, exactly as the synthesis file's are: `readReadersFile` reads them
without complaint and never enforces them, `readerOutput` remains the sole authority, and a
recording written by a build that had neither replays unchanged (pinned).

### C-7 · an absent `answer` key is a refusal, and here is the argument

```ts
if (ans === null) throw new UserError(
  `${abs}'s "reply" has an "evidence" array and no "answer" array, so there is no answer in it to
   filter — that is a reply nobody finished, not an archive with nothing in it.
   A synthesizer that concluded nothing is supportable writes "answer": []`, fix, REPLY_EXIT);
```

Exit **2**, the code no honest empty uses.

**Why a refusal.** Exit 1 is a claim about the user's archive — *it was read and it had nothing* —
and the honest empty is the one signal this release asks an agent to trust; the MCP tool description
says TRUST ITS SILENCE. The bar for reaching it is that the host actually said the answer was empty,
and `"answer": []` says that in four characters. An absent key is not a value: it is C4's own
sentence one shape further out, and C4's ruling is that a broken input must never be reported in the
vocabulary of an empty corpus.

**Why the mirror shape is still accepted.** `{"answer":[…]}` with no `evidence` key reaches
`filterAnswer`, every sentence fails to resolve a citation, and the receipt says
`N sentences dropped · no citation that resolves` — a *different* sentence from the honest empty,
naming what went wrong. Nothing is silent there, so there is nothing for this to fix. The test
pins that asymmetry deliberately, with the reason.

The change also catches `{"evidence":[…], "answer":"a string"}`, which passed before.

---

## §2 THE ARTIFACTS

### C-1 and C-2 at both doors, one index, one query — BEFORE

`potsherd find --json` in one process and **the real MCP server over stdio**
(`sh plugins/claude-code/bin/potsherd-mcp`, `potsherd-mcp 1.2.0 ready · 3 tools`), same
`--potsherd-dir`, same relocated `$HOME`, same run.

```
=== query "untangle token refresh" · one index · both doors ===   (at 7396c3e)
  find --json      header weak   9 sessions
    [0] weak  cal 0.546  citable=true  summaryOnly=0  S6      <- sessions[0]
    [1] weak  cal 0.567  citable=true  summaryOnly=0  S1      <- the best row on the page
    [2] weak  cal 0.550  citable=true  summaryOnly=0  S2
    [3] weak  cal 0.550  citable=true  summaryOnly=0  S3
    [4] weak  cal 0.550  citable=true  summaryOnly=0  S4
    [5] weak  cal 0.548  citable=true  summaryOnly=0  S5
    [6] weak  cal 0.546  citable=true  summaryOnly=0  S7
    [7] weak  cal 0.544  citable=true  summaryOnly=0  S8
    [8] weak  cal 0.850  citable=true  summaryOnly=1  S9      <- title-only, and citable
  potsherd_recall  header weak   9 threads
    [0] weak  cal 0.567  citable=true  citation=minted  S1
    [1] weak  cal 0.550  citable=true  citation=minted  S2
    [2] weak  cal 0.550  citable=true  citation=minted  S3
    [3] weak  cal 0.550  citable=true  citation=minted  S4
    [4] weak  cal 0.548  citable=true  citation=minted  S5
    [5] weak  cal 0.546  citable=true  citation=minted  S6
    [6] weak  cal 0.546  citable=true  citation=minted  S7
    [7] weak  cal 0.544  citable=true  citation=minted  S8
    [8] weak  cal 0.850  citable=false citation=NULL    S9    <- and NOT citable
  ORDER  find=[S6 S1 S2 S3 S4 S5 S7 S8 S9]
  ORDER recall=[S1 S2 S3 S4 S5 S6 S7 S8 S9]
  VERDICT order DISAGREE · citable DISAGREE [S9 find=true recall=false]

=== query "deploy" · one index · both doors ===                   (at 7396c3e)
  ORDER  find=[S10 S2 S7 S5 S8 S11 S12 S13 S4]
  ORDER recall=[S10 S2 S7 S5 S8 S11 S12 S13 S4]
  VERDICT order AGREE · citable DISAGREE
                 [S11 find=true recall=false; S12 find=true recall=false;
                  S13 find=true recall=false; S4 find=true recall=false]
```

### …and AFTER

```
=== query "untangle token refresh" · one index · both doors ===   (at work/FIX-I)
  find --json      header weak   9 sessions
    [0] weak  cal 0.567  citable=true  summaryOnly=0  S1
    [1] weak  cal 0.550  citable=true  summaryOnly=0  S2
    [2] weak  cal 0.550  citable=true  summaryOnly=0  S3
    [3] weak  cal 0.550  citable=true  summaryOnly=0  S4
    [4] weak  cal 0.548  citable=true  summaryOnly=0  S5
    [5] weak  cal 0.546  citable=true  summaryOnly=0  S6
    [6] weak  cal 0.546  citable=true  summaryOnly=0  S7
    [7] weak  cal 0.544  citable=true  summaryOnly=0  S8
    [8] weak  cal 0.850  citable=false summaryOnly=1  S9
  potsherd_recall  header weak   9 threads      … identical, citation=NULL on S9 only
  ORDER  find=[S1 S2 S3 S4 S5 S6 S7 S8 S9]
  ORDER recall=[S1 S2 S3 S4 S5 S6 S7 S8 S9]
  VERDICT order AGREE · citable AGREE

=== query "deploy" ===                                            (at work/FIX-I)
  VERDICT order AGREE · citable AGREE
```

Same nine rows, in both cases — no row added, dropped or rescored.

### The 40-query scan, before and after

```
BEFORE (7396c3e)  scanned 40 queries with rows:
                  12 carry an ordering inversion (12 inversions);
                  26 carry a summary-only row marked citable
AFTER  (FIX-I)    scanned 40 queries with rows:
                  0 carry an ordering inversion (0 inversions);
                  0 carry a summary-only row marked citable
```

### Membership: the same rows, moved

```
$ node members.mjs  # find --json session-id sets, 40 queries, 7396c3e vs work/FIX-I
queries=40  membership changed=0  order changed=12  header/withheld changed=0
reordered: ["mode formatter","batch writes release","document dead letter","pagination graphql",
 "pagination graphql resolver","harden metrics","harden metrics exporter",
 "investigate parser regression","migrate thumbnail","migrate thumbnail worker",
 "untangle token","untangle token refresh"]
```

Not one query's result *set* changed, and neither did any envelope's `confidence` header or
`withheld` count. Only the order, on the twelve queries that carried an inversion.

### The human page, after

```
$ potsherd find "untangle token refresh" --no-color
potsherd find "untangle token refresh" · 9 sessions · weak · bm25 · 141ms

  <S1's title>                                                     claude · live
  P1 · 14 aug · 11 exchanges · main                                 weak  0.0098
```

Header `weak`, first row `weak`. Before this it was the header's word against `sessions[0]`'s.

### Every new or changed assertion, red first

Product code reverted to `7396c3e` (`git checkout 7396c3e -- packages/`), rebuilt, tests kept.

**`tests/find.test.ts` — 10 of 13 red.** The three that stay green are guards and are supposed to:
the corpus-premise check, FIX-F's "a summary still ranks below a lower-calibrated transcript", and
"a block with transcript in it still is citable".

```
 × ranks the better-labelled block first, against the fused score
   → expected [ "bbbb…", "aaaa…" ] to deeply equal — Received order was [ "aaaa…", "bbbb…" ]
 × the header the page prints is the confidence of the row under it
   → kestrel plinth quernstone: expected 'weak' to be 'strong'
 × orders sessions[] and hits[] by the same rule, never contradicting the label
   → kestrel plinth quernstone: session0 is weak above session1 strong: expected 1 to be <= 0
 × byLabel sorts on the word first, then the number, then the merge order
   → expected [ 'hit0', 'hit1' ] to deeply equal [ 'hit1', 'hit0' ]
 × byLabel leaves the merge order alone when a build carries no label
   → expected [ 'a', 'b' ] to deeply equal [ 'b', 'a' ]
 × sessions[0] is the best-calibrated row on the page, not the best-fused one
   → expected [ "bbbb…", "aaaa…" ] to deeply equal — Received order was [ "aaaa…", "bbbb…" ]
 × a title-only block is not citable at find --json
   → expected true to be false
 × core publishes the permission, and it is the predicate both doors use
   → TypeError: citableBlock is not a function
 × agree on the order of the page and on which rows may be quoted
   → kestrel plinth quernstone: order: expected [S…] to deeply equal [S…]
 × the title-only thread is refused at both doors, not at one of them
   → expected true to be false
 Tests  10 failed | 3 passed (13)
```

**`tests/mcp.test.ts` — 4 red.** These are FIX-D's own fences, moved onto the comparator in its new
home; on `7396c3e` there is no `byLabel` to sort with and the rows come back in the order that
proves it:

```
 × C5a — the verifier's two rows come back the other way round
   → expected [ 'hit0', 'hit1' ] to deeply equal [ 'hit1', 'hit0' ]
 × C5a — the word wins over the number, because the number can be capped
   → expected [ 'card', 'transcript' ] to deeply equal [ 'transcript', 'card' ]
 × C5a — inside one band it is calibration first, then the fused score
   → expected [ 'low-cal-high-rrf', …(2) ] to deeply equal [ 'high-cal-higher-rrf', …(2) ]
 × C5a — a build whose core carries no label leaves the merge order alone
   → expected [ 'a', 'b' ] to deeply equal [ 'b', 'a' ]
 Tests  4 failed | 69 passed (73)
```

**`tests/synthesis-seam.test.ts` — 5 red.**

```
 × the reader file … carries a schema and an instruction, like the file it hands back
 × the reader file … the schema names every key the reader validator requires, and no other
 × the reader file … a reader file answered from nothing but its own schema completes the round trip
   → SyntaxError: "undefined" is not valid JSON        (there is no schema in the file to read)
 × a reply with evidence and no answer key … is refused, not rendered as the archive having nothing
   → Error: expected a refusal and got none
 × a reply with evidence and no answer key … is refused when "answer" is present but is not an array
   → Error: expected a refusal and got none
 Tests  5 failed | 37 passed (42)
```

With the product code restored: **128 passed (128)** across the three files.

### The C-5 round trip, completed from the file alone

The test that carries C-5's actual claim reads the recorded file, takes the key names **out of the
`schema` string the file carries** — never out of this repository's types — builds `outputs` with
them, and runs the round trip:

```ts
const schema = JSON.parse(String(file['schema']).replace(/:\s*<[^>]*>/g, ': 0') …);
const shape = schema.outputs[0]!;            //  keys, in the file's own order
outputs = targets.map((t) => ({ [Object.keys(shape)[0]!]: t.sessionId, … }));
→ writeSynthesisFile(…) accepted, 0 model calls, prompt contains the quote
```

and the shape the fifth verifier guessed is refused **by name**, which is the reason the schema is in
the file at all:

```
 ✓ the shape the verifier guessed is refused by name
   → /…/r.json: outputs[0].quotes[0] has no "text"
```

### C-7, before and after, same probe

```
                 at 7396c3e                                          at work/FIX-I
EVIDENCE-ONLY    {"ok":true,"answer":"","sentences":0,…}              {"ok":false,"code":2,
HONEST-EMPTY     {"ok":true,"answer":"","sentences":0,…}               "msg":"…has an \"evidence\"
IDENTICAL        true                                                  array and no \"answer\"
                                                                       array…"}
                                                                      IDENTICAL false
```

The refusal names the field, names the fix (`"answer": []`), carries exit 2, and does not print the
reply back — asserted (`not.toContain('statement_cache_size')`).

---

## §3 THE NUMBERS

### The two drivers

| run | files | tests | skipped | exit |
|---|---:|---:|---:|---|
| `pnpm test` **baseline at `7396c3e`** | 53 | **1932** (1931 passed, 1 failed) | 0 | 1 |
| `pnpm test` **`work/FIX-I`** | 54 | **1955** (1954 passed, 1 failed) | 0 | 1 |
| `POTSHERD_SQLITE=node pnpm test` **`work/FIX-I`** | 54 | **1955** (1954 passed, 1 failed) | 0 | 1 |

`0 skipped` verified by grep, not by eye, on every run.

The baseline's one failure is an artefact of how it was produced — `packages/` reverted to `7396c3e`
while the committed `plugins/**/dist` were still this branch's, so
`tests/plugin-install.test.ts > the vendored bundles are byte-for-byte the bundles this build
produces` failed. It is not a real baseline failure.

**The one failure on `work/FIX-I`, on both drivers, is real and it is `tests/evals-gate.test.ts`**:

```
 FAIL  tests/evals-gate.test.ts > pnpm evals, end to end (needs a cached model)
       > exits 0 as shipped and 1 with the vector weight forced to 0
       AssertionError: expected 1 to be +0        (shipped.code)
```

That file belongs to another live worker and I did not touch it. What it asserts is `pnpm evals`'s
exit code; see below.

### `pnpm evals`, standalone, and the thing that did not go to plan

Three runs each, stable to the digit.

| | bm25 @5 | bm25 @1 | vectors @5 | vectors @1 | **hybrid @5** | **hybrid @1** | gate |
|---|---:|---:|---:|---:|---:|---:|---|
| `7396c3e` | 39/60 | 24/60 | 51/60 | 24/60 | **51/60** | **27/60** | **PASS**, exit 0 |
| `work/FIX-I` | 40/60 | 31/60 | 57/60 | 40/60 | **55/60** | **35/60** | **FAIL**, exit 1 |

The brief's baseline (`hybrid recall@5 51/60, recall@1 27/60`) reproduces exactly.

**Recall does not fall. It rises, in every mode.** Hybrid recall@5 **51 → 55 (+4)**, recall@1
**27 → 35 (+8, +30 %)** — the row the user actually sees. bm25-only @1 24 → 31. The eval measures
`result.sessions`, which is the page `find` prints, so ordering that page by its label is a large
measured improvement to the human path.

**What fails is a *relative* gate.** The amended phase-3 rule is *hybrid ≥ both singles at recall@5
and strictly > both at recall@1*. Vectors-only gains more from the label ordering (+6 / +16) than
the fusion does (+4 / +8), so:

```
  hybrid (auto)     recall@5  55/60   ✓ ≥ bm25 (40)      ✗ ≥ vectors (57)     ✓ ≥ 51/60
                    recall@1  35/60   ✓ > bm25 (31)      ✗ > vectors (40)     FAIL
```

That is a statement about the **fusion weights**, not about the ordering: once `calibration` — which
already encodes list agreement and per-list strength — is the primary sort key, RRF's contribution
is no longer additive, and on this 60-query set the semantic half alone now ranks better than the
mixture. Re-deriving the vector weight is a ranking task in `evals/` and `WEIGHTS`, neither of which
is mine; §4 hands it over with a measured fallback.

**Attribution, measured rather than asserted.** Deleting the single line
`sessions.sort(… || byLabel(a, b))` from `recall()` and changing nothing else restores the baseline
byte for byte — `bm25 39/24 · vectors 51/24 · hybrid 51/27 · PASS`. The entire eval delta is that
one line.

**The variant that was rejected.** Ordering *before* the cut — one sort instead of two — makes the
label a selector as well as an order. It also fails the gate (`bm25 40/31 · vectors 55/38 ·
hybrid 54/34`), it is measurably worse than the shipped variant, and it violates the brief's *"the
same rows, moved"*. Rejected on both counts.

**Per-query baseline alarm** (`evals/per-query-baseline.json`, an alarm and not a gate): 7 lines at
`7396c3e`, 107 on this branch. Every one of them is a rank change on a query whose *membership* did
not change; the baseline was pinned against the pre-FIX-I ordering and would be regenerated
deliberately (`pnpm evals -- --json | node scripts/write-eval-baseline.mjs`) by whoever owns it.

### Typecheck, privacy guard, vendor

```
$ pnpm typecheck            core · bridges · cli · mcp  →  4 of 4 Done
$ python3 scripts/check-privacy.py ; echo "PRIVACY_EXIT=$?"
  PRIVACY_EXIT=0
  privacy: 590 tracked text files swept, no real-corpus content, no pinned known violations left…
  id inventory: 186 distinct id-shaped tokens … 19 unaccounted (ceiling 19), pinned at 41
  occurrences across 17 files.
```

Read from `$?`, not from the last line — the final line is the header caveat.

```
$ pnpm build && pnpm vendor
  plugins/claude-code/dist/potsherd.js  <-  packages/cli/dist/potsherd.js  (1103 KB)
  plugins/claude-code/dist/mcp.js       <-  packages/mcp/dist/index.js     (1603 KB)
$ git status --short plugins/
  (clean — the vendored bundles are committed on this branch)
```

The MCP transcripts in §2 were produced through
`sh plugins/claude-code/bin/potsherd-mcp`, which prefers `plugins/claude-code/dist/mcp.js`, so the
"after" run is the vendored bundle and not the source tree.

### Isolation, disk, pids

Every measurement ran as
`env -u CLAUDE_CONFIG_DIR -u POTSHERD_DIR -u XDG_CONFIG_HOME -u NODE_PATH -u CODEX_HOME
HOME="$SC/home"` with writes confined to a scratch `--potsherd-dir`; the MCP server, which takes no
`--potsherd-dir`, was given `POTSHERD_DIR` explicitly with the same `HOME`. The corpus is
`scripts/make-demo-corpus.mjs` output — synthetic, 2.0 MB — not any real archive. Nothing was
written to `~/.claude`, `~/.codex`, `~/.cursor`, `~/.pi`, `~/.gemini`, `~/.copilot`,
`~/.local/share/opencode` or `~/.potsherd`; the only read of `~/.potsherd` is
`tests/evals-gate.test.ts`'s existing `isModelCached` probe of `~/.potsherd/models`.

**No detached embedder was ever spawned.** Every `index` ran `--no-embed`; the eval embeds
in-process. Final sweep:

```
$ ps -eo pid,command | grep "[p]otsherd.js index"
  (none)
```

No pid was signalled by this task, so no kill-by-name risk arose.

```
disk before   199Gi   8.7Gi avail
disk after    199Gi   7.7Gi avail       (scratch: 2.0 MB corpus + a 546 KB index, still in place
                                         under the session scratchpad; the delta is dominated by
                                         other work on this shared machine)
```

---

## §4 WHAT I COULD NOT DO, AND WHAT I AM HANDING OVER

### 1. `pnpm evals` exits 1, and `tests/evals-gate.test.ts` is red. This is the open item.

Stated plainly because the ACCEPT list asks for `pnpm evals` exit 0 and a green suite, and I am
delivering neither.

It is not a recall regression — every mode's recall rises (§3) — and it is not flakiness: three runs
each side, stable to the digit. It is that ordering the page by its label lifts the semantic lane
more than it lifts the fusion, so the fusion stops clearing a **relative** bar.

The ruling I was given is *"if C-1's ordering measurably costs recall, report the numbers and land it
anyway unless the cost is severe"*. It costs none, so I landed it. But the decision that follows is
not mine to take, so here are the two options, both measured:

**(a) keep it, and retune the fusion.** The finding is real and worth having: with a calibrated
ordering, `WEIGHTS`'s vector weight is now too low — vectors-only beats hybrid by 2 at recall@5 and
5 at recall@1. Whoever owns `evals/`, `WEIGHTS` and `tests/evals-gate.test.ts` can re-derive the
weight and regenerate `evals/per-query-baseline.json`. Neither file is in my deliver list; I did not
touch either.

**(b) if the phase must ship before that retune**, move the ordering out of `recall()` and into the
two doors. C-1 stays closed at both doors; `recall()`'s own order, the eval and
`tests/evals-gate.test.ts` return to exactly `7396c3e` — **verified, not assumed**: with only this
line removed the eval prints `bm25 39/24 · vectors 51/24 · hybrid 51/27 · PASS`, exit 0.

```diff
--- a/packages/core/src/recall.ts
@@
-  sessions.sort((a, b) => summaryRank(a.hits) - summaryRank(b.hits) || byLabel(a, b));
```
```diff
--- a/packages/cli/src/commands/find.ts        (inside runFind, after `recall(...)` returns)
+    result.sessions.sort((a, b) => summaryRank(a.hits) - summaryRank(b.hits) || byLabel(a, b));
--- a/packages/mcp/src/tools/recall.ts         (before `groupThreads(sessions)`)
+    sessions.sort((a, b) => summaryRank(a.hits) - summaryRank(b.hits) || byLabel(a, b));
```

I did **not** ship (b), and the reason is worth recording: it makes `pnpm evals` measure an ordering
that no surface prints. The eval exists to measure retrieval quality of the page a person reads; if
the page is re-ordered downstream of it, the benchmark can no longer see the product. That is the
"benchmark that cannot fail" shape this repository names in its own rules. (a) keeps the eval
pointed at the thing being judged and tells the truth about the fusion.

### 2. The barrel, `packages/core/src/index.ts` — RESERVED, not touched

`byLabel` and `citableBlock` are exported from `packages/core/src/recall.ts` and are **not** on the
barrel. Nothing in the product needs them there — the doors read `RecallSession.citable`, a field,
and take core's order — so this is not a gap, but a future consumer would want them. Tests import
them from the module that owns them, which is this phase's established pattern
(`tests/cards-lane.test.ts`, `tests/recall.test.ts`). The lines, when the barrel is free:

```diff
--- a/packages/core/src/index.ts
@@   in the `} from './recall.js';` block, beside `byLane`
   byLane,
+  byLabel,
+  citableBlock,
   laneOfHit,
```

### 3. `tests/find.test.ts` is a new file, and why

The deliver list names it and it did not exist. Nothing else fitted: `tests/recall.test.ts` is core's
ranking against the eval fixture, `tests/cards-lane.test.ts` is F6's lane partition, and neither
holds a corpus with an ordering inversion in it. The new file builds a six-session corpus that does —
`MANY` mentions the query's three words in three separate exchanges, so its *block* score
(`best + half the rest`) comes out above `CLEAN`, which says them once in a short exchange and is the
better-calibrated row by every measure the label is built from. It also carries the doors-agree test,
because that test needs `runFind` and `runRecall` in one process against one index.

### 4. What is deliberately still true

- `RecallSession.citable` is **optional** in the type, like `lane`, because `browse.ts` derives
  `BrowseSession` from it with an `Omit` and that file is not mine. `recall()` sets it on every block
  it returns.
- `find --json`'s `citable` for a **routing** (card-only) block was already `false` before this
  change and still is; the defect was only ever the title-only case.
- The `--readers-out` file's `outputs` is still required to be a real JSON array and not the text of
  one. That asymmetry with the synthesis file's `reply` is deliberate and safe: a string `outputs`
  is *refused by name* (`"outputs" must be an array`), never read as an empty recording, so C4's
  failure mode does not exist on this leg. The instruction says so in words rather than leaving it to
  be discovered.

### 5. Not attempted

C-3, C-4, C-6, C-8, C-9, C-10 and C-11 from `VERIFICATION-5 §C` are not this task's and are
untouched. `packages/core/src/db.ts`, `vec.ts`, `ingest.ts`, `doctor-line.ts`, `render/ls.ts`,
`render/ask.ts`, `ci.yml`, `docs/screens/**`, `tests/terminal.test.ts` and `tests/evals-gate.test.ts`
were not opened for writing.

---

## Commits on `work/FIX-I`

```
b3c9a2a  phase 10 FIX-I: select with byLane, present with byLabel
19fc429  phase 10 FIX-I: the lane stays in front of the label
4723c7f  phase 10 FIX-I: one ordering and one citable predicate, in core, for both doors
```

Nothing was pushed and nothing was merged.

# FIX-F — the door stops promising work that will never run, and stops citing a summary

Branch `work/FIX-F`, cut from `4064c4e`. Four findings from `VERIFICATION-4.md` §C: **C2** (both
doors call a stopped embed lane `warming`), **C3** (a title-only thread is `citable: true` with a
minted citation, and it outranks the transcript), **C6** (`want:"context"` can return no windows and
a `null` readMore), **C7** (`1 rows were withheld`).

All four are real. None dissolved on inspection. Every one is reproduced below at the **real MCP
server** on the **real archive**, before and after.

They are one failure in four costumes, and it is not the one the earlier rounds fixed. FIX-C stopped
the door giving orders the agent could not carry out. This is the next layer down: **a field that is
true of one state was printed in every state.** `warming` is true of an index somebody is embedding;
`citable` is true of a thread with transcript evidence; `readMore` is useful on a page with windows
on it. Each was printed unconditionally, and each of the three unconditional versions tells the
agent to do something that cannot work — wait for a pass that will never start, quote a session
nobody has read, or give up on a page whose text is one `potsherd_read` away.

---

## 0. THE CLAIMS, CHECKED BEFORE FIXING

Isolation for every measurement below: `.claude .codex .cursor .pi .gemini .copilot
.local/share/opencode` APFS-cloned (`cp -Rc`) into a scratch `HOME`; every invocation under

```
env -u CLAUDE_CONFIG_DIR -u POTSHERD_DIR -u XDG_CONFIG_HOME -u NODE_PATH -u CODEX_HOME \
    -u ANTHROPIC_API_KEY HOME="$B/home" … --potsherd-dir "$B/pd"
```

and the MCP server the same way, `sh plugins/claude-code/bin/potsherd-mcp` driven over stdio with
`initialize` + `notifications/initialized` + `tools/call`. No byte was written to `~/.claude`,
`~/.codex`, `~/.cursor`, `~/.pi`, `~/.gemini`, `~/.copilot`, `~/.local/share/opencode` or
`~/.potsherd`. Corpus: `rescue` 410 files / 476 MB / 299 ghosts / 2,971 prompts, `index --no-embed`
368 parsed / **4,751 embeddable units**. Ids, project names, home paths and transcript prose are
never printed.

| item | verdict | the command, and what it printed |
|---|---|---|
| **C2** — `warming` at the model door with no embedder and no `models` dir | **confirmed, verbatim** | `ps -eo pid,command \| grep "[i]ndex --quiet"` → **0**; `ls <root>/models` → *No such file or directory*; real server → `capability = "keyword search only — semantic search is warming (0 of 4,751 embedded)"` |
| **C2** — nothing consults `.lock.embed` | **confirmed** | `git grep -n "lock.holder\|holder({" 4064c4e -- packages` → **one line in the whole product**, `cli/commands/index.ts:256`, and it decides whether to *spawn*, not what to print. The three files that render the sentence (`vec.ts`, `doctor-line.ts`, `mcp/tools/recall.ts`) contain no reference to the lock at all — the only `lock` matches in them are the word `block` |
| **C2** — `vectors.reason` makes the same promise | **confirmed, and one worse than filed** | the same reply carried `"reason": "the words matched; semantic search adds to this as vectors land"`. On this index they do not land at all |
| **C3** — 28 hits, 18 titles, first transcript hit at index 18 | **confirmed, exactly** | see §2 C3 *before* |
| **C3** — five title-only threads, all `citable: true` with a citation | **confirmed** | see §2 C3 *before* |
| **C3** — `ROUTING_KINDS` is `{card}` so the refusal never fires for a title | **confirmed** | `packages/core/src/recall.ts:187` |
| **C3** — no cards control at the model door | **confirmed** | `tools/list` → `scope` properties were `ghosts, harness, limit, pinned, project, sidechains, since, tag, until` — nine, no `cards` |
| **C6** — `threads 1`, `windows 0`, `readMore null`, no `hits` key | **confirmed, and worse than filed** | three separate queries reproduce it; the verifier saw `confidence "weak"`, mine returned **`"strong"`** — a strong match with no text at all |
| **C7** — `though 1 rows were withheld below the weak floor` | **confirmed, verbatim** | live at the model door |

One thing I checked that is **not** a defect, so it is not fixed: the archive holds **no cards**
(`potsherd card` was never run on it), so `routing` is 0 on every query above. C3's title finding is
therefore not "cards leaking" — it is a second, independent path to F6 that the card work never
covered, which is what the verifier said.

---

## 1. WHAT CHANGED, AND WHY THAT SHAPE

### C2 — one fact, read once, rendered by each surface

The phase (`ready`/`warming`/`pending`/`unavailable`/`empty`) is a fact about the **rows**: how many
carry a vector. Nothing in the product asked the different question — *is anybody embedding the
rest?* — so `pending` and `warming` were rendered with `warmingLine` unconditionally, and that
function's own docstring is the claim that is false: *"There is no command in it because there is
nothing for the reader to do; the work is already running."*

The evidence is the lock. `runEmbedWorker` holds `<root>/.lock.embed` for the whole pass and writes
its `pid` into it; `lock.isStale` already decides a readable owner by whether that pid is alive, so a
**killed embedder's lock answers `null`** without any new state. Two lines:

- `packages/core/src/doctor-line.ts` — `VectorReport.working?: boolean`, and `vectorReport()` carries
  it. `undefined`, not `false`, when the caller had no root: an absent measurement must never render
  as a claim in either direction.
- `packages/core/src/vec.ts` — `vecStatus(db, root)` asks `holder({ root, lane: 'embed' })` once, on
  the same read every other number on that report comes from.

Then each surface renders it:

- **the model door** (`packages/mcp/src/tools/recall.ts`) — `capabilityLine` gets a fourth branch:
  `keyword search only — semantic search is not running (N of M embedded)`. Same count, same shape,
  no command. And the no-match note gains the clause that matters most, because the compound failure
  the verifier named is a *note* plus a *capability* read together: `…Only keyword search ran; the
  semantic half did not, **and nothing is embedding this index, so running the same search again
  will not change that**.`
- **core's `vectors.reason`** (`packages/core/src/recall.ts`) — two strings, each a promise about
  the future, each now conditional on the lock. `no embeddings in the index **yet**` becomes
  `no embeddings in the index, and nothing is embedding them` when nobody holds the lane and is left
  exactly as it was when somebody does; `the words matched; semantic search adds to this **as
  vectors land**` becomes `…semantic search is not running, so nothing will be added` on the same
  condition. Both strings reach `find` **and** the model door, so one edit serves two surfaces.
  `working` is published on `VectorState` beside them, so a script never has to parse English.
- **`find`** (`packages/core/src/render/find.ts`) — the warming sentence is **dropped** when
  `vectors.working === false`, and `supersededBySemantic` is inverted in the same case so the honest
  clause is printed instead of being suppressed by a line that is no longer there. This is the exact
  move that file already makes, for the reason its own docstring gives: *"The wording lives in
  `recall.ts`, which FIX-B may not edit; what reaches the screen is decided here, which is where it
  belongs anyway."* Exactly one of the two sentences is true, and it is the one that prints.

**Two states, two sentences — never one word widened over both** (`09 §9`). And `index`'s own
receipt is deliberately untouched: it computes its status *before* it spawns, so for a few
milliseconds it knows something the lock does not, and it already carries a `spawned` flag for that
window. Making it lock-derived would have made *it* lie, in the other direction. See §4.

### C3 — a summary is not evidence, and the lane is not the place to say so

`ROUTING_KINDS` is the **lane**, and I read every use before touching anything. The lane governs six
things, all measured for cards and none for titles:

1. `laneOfHit` / `laneOfSession` → the published `lane` field on every hit and block, at
   `find --json` and at `potsherd_recall`.
2. `byLane`, the comparator ordering blocks and hits.
3. The two-pass budget in `recall()`: evidence hits take `PER_SESSION` (3), routing hits take
   `ROUTING_PER_SESSION` (**1, shared**) — so a session with a card *and* a title hit would show one
   of them, chosen by fused rank.
4. `CARDS_SCORE_EVIDENCE_BLOCKS` and `counted`, i.e. what feeds a block's coverage. The title is
   *already* folded into every evidence block's calibration text by name (`m.displayTitle`), so
   moving the title *hit* into the routing lane would not remove the title from the calculation —
   it would only make the two disagree.
5. The separate build budget (`limit` routing blocks against `limit * 3` evidence blocks).
6. `--no-cards`, which drops `cards_fts` and `vec_cards` and would **not** drop the `titles` list —
   so `lane: "routing"` rows would keep arriving on a search that asked for transcripts only.

And `tests/cards-lane.test.ts:186` pins `laneOfHit('title') === 'evidence'` in both directions.

So the lane stays exactly where T10.7 put it, and the *other* property gets its own name:
`SUMMARY_KINDS = {card, title}` — "a statement **about** a conversation rather than text **from**
one" — with `isSummaryHit` and `hasTranscriptEvidence` beside it. Three uses, one for each of
the three things C3 asks for:

- **not `strong`.** The per-hit ceiling in `take()` and the per-block ceiling both key on
  `SUMMARY_KINDS` / `hasTranscriptEvidence` instead of on the lane, so a title-only block is capped
  at `ROUTING_CEILING` exactly as a card-only block is. `strong` is a licence to stop reading and
  there is nothing here to read.
- **never above a transcript.** `summaryRank(hits)` is the first term of the block comparator and of
  the flat-hit comparator, `byLane` the second. It is a function of `kind` alone, so no weight and no
  corpus can invert it — the property `plans/…/phase-10-agent-audit.md §B8` asks for, applied to the
  other kind of summary. It is a strict refinement of `byLane`: a card-only block is summary-only by
  construction, so the two terms never disagree.
- **not citable.** At the model door, `citable` stops asking *which lane is this* and asks *has the
  agent been shown anything it could quote*, which is what it always meant. `evidence:
  "transcript" | "not-a-transcript"` is published on the thread beside `lane`, `citation` is `null`
  when it is a summary, and a `citableNote` says why in the words the human view uses — ending in
  `potsherd_read`, a tool the caller actually has.

**Why the cap and the order are one change and not two.** FIX-D's invariant is that `hits[]` and
`threads[]` are ordered by the confidence *word*, then `calibration.score`, then the fused score.
Putting transcripts first without the cap would have broken it — a `strong` title-only row below a
`weak` transcript row is non-monotone in the word. With the cap, every row above the summaries is at
least as confident as every row below them, so the order is a refinement *within* the label and
FIX-D's fences stay green untouched. `orderByLabel` reads the published `evidence` field, and a row
carrying none counts as `transcript`: absent is not `not-a-transcript`, which is why every FIX-D unit
test passes plain rows and is unmoved.

`orderByLabel` is also now applied **after** `hitJson`, not before — its first key is a field
`hitJson` attaches, so ordering the raw core rows would have sorted on a field that was not there.

**The control.** `scope.cards` at the model door, same expression as `find`'s (`!== false`, so
`undefined` and `true` both mean cards on), reported back on the envelope as `cards` alongside
`routing` and a new `summaryOnly` count so a caller can confirm the flag took without walking
`threads[]`. It does **not** switch off the `titles` list: `--no-cards` has never meant that on
either surface, a title is not a card, and a title-only thread is now uncitable and last anyway —
which is the part of C3 a flag should not have to buy.

### C6 — clip **and** emit `readMore`, and one thing the item did not ask for

Both, and they answer different halves.

The clip is deliberately taken **only when the page would otherwise be empty**. Clipping the first
oversized window mid-round would let one enormous exchange — the real archive has one of **139,000
tokens** — eat a budget that F5 exists to spread across five threads. So the round-robin is
untouched and this is the floor underneath it: if nothing fitted, return the best hit's opening,
marked `clipped: true` on the window and counted in `windowsClipped`, so the agent knows it is
holding a fragment rather than an exchange.

`readMore` is no longer withheld on the empty page — it was `windows.length === 0 ? null : '…'`,
which suppressed it in the one case where it is the whole answer — and it now says *which* of three
things happened: a clipped window, a truncated page, or a page with no window at all.

The thing the item did not ask for: on a **genuine no-match** `readMore` is `null` again, on
purpose. `threads[]` is empty there, so "read the thread" would be an instruction naming nothing —
the exact failure this phase has recorded nine times, and I was one line from adding a tenth.

### C7 — one call site

`f.plural`, twice (`row`/`rows` and `was`/`were`), in the one clause that was built by
concatenation.

---

## 2. THE ARTIFACTS — the real server, `sh plugins/claude-code/bin/potsherd-mcp`

### C2 at the three states the acceptance names, on the real archive

**State 1 — nothing fetched, no worker.** `ps` → 0 embedders; `<root>/models` → does not exist.

```
before   capability = "keyword search only — semantic search is warming (0 of 4,751 embedded)"
         vectors    = {"used":false,"available":false,"vectors":0,
                       "reason":"the words matched; semantic search adds to this as vectors land"}

after    capability = "keyword search only — semantic search is not running (0 of 4,751 embedded)"
         vectors    = {"used":false,"available":false,"vectors":0,"working":false,
                       "reason":"the words matched; semantic search is not running, so nothing will be added"}
```

and the no-match note, on the same index:

```
before   "no match. The archive does not contain this, though 1 rows were withheld below the weak
          floor. Only keyword search ran; the semantic half did not. Say so — do not widen into a
          guess, and do not answer from the repository in front of you."

after    "no match. The archive does not contain this, though 1 row was withheld below the weak
          floor. Only keyword search ran; the semantic half did not, and nothing is embedding this
          index, so running the same search again will not change that. Say so — do not widen into
          a guess, and do not answer from the repository in front of you."
```

(That is C7 as well: `1 rows were` → `1 row was`.)

**State 2 — a worker genuinely alive and progressing.** The 46.1 MB runtime cloned in from
`~/.potsherd/models` (read, never written), then a default `potsherd index`, which spawned a real
detached embedder:

```
$ cat <root>/.lock.embed/owner.json
{"pid":43362,"op":"embed","at":"…","host":""}
$ ps -p 43362        →  node …/potsherd.js index --quiet --potsherd-dir <root>

capability = "keyword search only — semantic search is warming (11 of 4,751 embedded)"
vectors    = {"used":false,"available":true,"vectors":11,"working":true, …}

…and again, seconds later, progressing:
capability = "keyword search only — semantic search is warming (37 of 4,751 embedded)"

find   (human door):   semantic search: warming (38 of 4,751 embedded)
doctor (human door):   vectors    41   warming 41 of 4,751
index  (its own line): semantic search: warming (0 of 4,751 embedded) — in the background
```

**State 2b — the same index one second after that worker was killed by its recorded pid.** The lock
directory is still on disk; the pid is dead. This is the crashed-embedder case, and it is the one no
file test alone can answer:

```
$ kill 43362 ; ps -p 43362  →  gone
$ cat <root>/.lock.embed/owner.json
{"pid":43362,…}                       ← the lock survives the process

capability = "keyword search only — semantic search is not running (49 of 4,751 embedded)"
vectors    = {"used":false,"available":true,"vectors":49,"working":false, …}
```

**State 3 — fully embedded (a corpus embedded to completion, `5 of 5`).** The new wording must not
leak into a finished index, in either branch:

```
capability = "keyword search answered this one (the words matched, so the vector half was not needed)"
capability = "keyword + semantic search (5 of 5 embedded)"          ← when the vector half ran
vectors    = {"used":true,"available":true,"vectors":5,"working":false}
```

`working: false` is true there and correctly says nothing: there is nothing left to embed.

### C3 — one live `potsherd_recall` on the real archive, same query before and after

```
BEFORE
hits 28   kinds {title: 18, exchange: 10}   evidence {not-a-transcript: 18, transcript: 10}
          the first hit whose evidence is 'transcript' is at index 18 of 28
          confidence order: strong ×28
threads 10
  thread0..3  lane=evidence citable=True  citation=yes  conf=strong  hits [not-a-transcript, transcript]
  thread4..8  lane=evidence citable=True  citation=yes  conf=strong  hits [not-a-transcript]   ← title only
  thread9     lane=evidence citable=True  citation=yes  conf=strong  hits [transcript]         ← ranked LAST

AFTER
hits 24   kinds {exchange: 14, title: 10}   evidence {transcript: 14, not-a-transcript: 10}
          the first hit whose evidence is 'transcript' is at index 0 of 24
          evidence order: T T T T T T T T T T T T T T S S S S S S S S S S
          confidence order: strong ×14 then weak ×10          (monotone — FIX-D's fence holds)
threads 10
  thread0..7  lane=evidence citable=True  citation=yes   conf=strong  evidence=transcript
  thread8..9  lane=evidence citable=False citation=null  conf=weak    evidence=not-a-transcript
```

Five title-only threads with minted citations became **two**, uncitable, at the bottom — and the
page went from five threads with transcript evidence in them to **eight**: three conversations that
had been pushed off it by summaries are now on it. The human CLI on
the identical query now ranks the same blocks in the same order (`find --json`: eight
`exchange`-bearing blocks `strong`, then two `title`-only blocks `weak`), which is the agreement
`vecStatus`'s own comment asks for, one field over.

The `citableNote` the agent gets on a summary-only thread:

```
"nothing here is a transcript: the session title or its card matched, the body did not use those
 words. Not citable. potsherd_read the thread if you want to know what it actually says."
```

And the control, through `tools/list` and two `tools/call`s on the same server:

```
scope keys: ['cards','ghosts','harness','limit','pinned','project','sidechains','since','tag','until']
cards: {"type":"boolean","description":"false: search transcripts only, and do not search session
        cards (model-written summaries). Default true — a card can route you to a thread whose
        transcript never uses your words, and it is never citable"}

{"query":"…","scope":{"cards":false}}  →  cards False  routing 0  summaryOnly 0
{"query":"…","scope":{}}               →  cards True   routing 0  summaryOnly 0
```

Both of those ran at `limit: 3`, where the whole page is transcript either way, so the two envelope
counters agree by arithmetic rather than by luck — and `routing` is 0 on both because this archive
has **no cards in it at all**. The flag is proved accepted, forwarded to `RecallOptions.cards` and
reported back; it is **not** proved to change a result set on this corpus, and I say so in §4.6.

### C6 — the same query, before and after

```
before   confidence "strong"  noMatch false  threads 1
         windows 0   windowTokens 0   windowBudget 6000   windowsTruncated true
         readMore null                       ← and there is no "hits" key

after    confidence "strong"  noMatch false  threads 1
         windows 1   windowTokens 6000  windowBudget 6000  windowsTruncated true  windowsClipped 1
         readMore "one window is the opening of an exchange longer than the whole budget, cut to fit
                   and marked \"clipped\": do not read its end as the end of the exchange. these
                   windows are discontiguous and relevance-selected. potsherd_read the thread for the
                   exchanges around any of them. Some matching exchanges did not fit the budget."
```

Reproduced on three separate queries. All three match the archive's largest exchange —
556,529 characters, about **139,000 estimated tokens** against a 6,000-token ceiling — which is
why the old code returned nothing: `windowsFrom` `continue`d past it and there was nothing else
on the page. The index holds twelve exchanges over 17,000 tokens, so this is not one freak row.

### Red first — every new test, on the unfixed source

The five source files stashed (`git stash push -- …`), the tests left in place:

```
$ npx vitest run tests/mcp.test.ts tests/find-warming.test.ts tests/vectors-lazy.test.ts
   × the tool list > advertises a json schema … → expected ['ghosts',…(6)] to equal ['cards','ghosts',…(7)]
   × FIX-C — a warming index is called warming … → expected '…is warming…' not to match /warming/
   × FIX-F C2 — an index nobody is embedding is not called warming → expected '…' to match /not running/
   × FIX-F C2 — a stale lock whose holder is dead reads as stopped → expected '…' to match /not running/
   × FIX-F C2 — the no-match note stops implying that a retry will do better
                                            → expected '…' to match /nothing is embedding this index/
   × FIX-F C2 — `vectors.reason` says never rather than yet     → expected undefined to be false
   × FIX-F C2 — capabilityLine: three states, three sentences, one count
   × FIX-F C3 — a title-only thread is not citable …            → expected [] to have a length of 1
   × FIX-F C3 — a summary never outranks a transcript …
                                → expected [undefined, undefined] to equal ['transcript','not-a-transcript']
   × FIX-F C3 — the agent gets the cards control the human has had → expected undefined to be true
   × FIX-F C3 — orderByLabel puts a summary row last …
                                → expected ['summary','transcript'] to equal ['transcript','summary']
   × FIX-F C6 — an exchange longer than the budget comes back clipped → expected [] to have a length of 1
   × FIX-F C6 — readMore survives the empty page …             → expected null not to be null
   × FIX-F C7 — one withheld row is one row …                  → expected '…' to contain '1 row was withheld'
   × FIX-F C2 (vectors-lazy) — is false when nothing holds the embed lane  → expected undefined to be false
   × FIX-F C2 (vectors-lazy) — is true while a live pid holds it           → expected undefined to be true
   × FIX-F C2 (vectors-lazy) — a stale lock whose holder is gone reads as stopped
   × find — does not say warming when nothing is embedding …   → expected undefined to be false
   × find — carries the same report on --json …                → expected undefined to be true
   × find — and the same script can see when nothing is running → expected undefined to be false

 Test Files  3 failed (3)
      Tests  21 failed | 77 passed (98)
```

(The twenty-first, `--json parity with the cli`, is a stash artefact: the CLI ran from the built
`dist`, which had the fix, against an MCP door that did not. It is green in both consistent states.)

Two of those reds are **existing** tests, both in `tests/mcp.test.ts`, both amended rather than
deleted, and the amendment is the finding:

- *"a warming index is called warming, not UNAVAILABLE"* — that fixture root is 0-embedded with no
  `.lock.embed`, no worker and no runtime, so `warming` was never true of it. The rule it pins (a
  transient state is not shouted at as a permanent one) is now pinned **in both directions**: with a
  worker holding the lane the word is `warming`; without one it is neither `warming` nor
  `UNAVAILABLE`.
- *"advertises a json schema for every tool"* — `scope` is ten fields now, not nine, and `cards` is
  advertised rather than undocumented.

---

## 3. THE NUMBERS

| | |
|---|---|
| `pnpm test` | **exit 0** · `Test Files 53 passed (53)` · `Tests 1913 passed (1913)` |
| `POTSHERD_SQLITE=node pnpm test` | **exit 0** · `Test Files 53 passed (53)` · `Tests 1913 passed (1913)` |
| `pnpm typecheck` | **4 of 4** — `core`, `bridges`, `cli`, `mcp` all `Done` |
| `pnpm evals` (standalone) | **exit 0**, `PASS` — hybrid (auto) **recall@5 51/60 (85%)**, **recall@1 27/60 (45%)** |
| `python3 scripts/check-privacy.py` | **exit 0, read from `$?`** *(output withheld — the guard prints the offending token)* |
| `pnpm build && pnpm vendor` | `vendored 2 files, 2.6 MB total`; `git status --porcelain plugins/` → **0 lines** |
| source diff | +552 / −33 across five files; **172 effective lines** (comments and blanks excluded) |

Baseline was 1,893 tests. **+20 new, 0 regressions, 0 skipped, both drivers.** The
`tests/llm.test.ts` listener-count red I was told to expect under `POTSHERD_SQLITE=node` **did not
appear** on this branch — that file is untouched and the whole suite is green under both drivers on
this machine. I am reporting what I measured, not what I expected.

### What C3 costs, measured both ways

`pnpm evals` on `4064c4e` (the branch point, `git checkout 4064c4e -- packages/core/src
packages/mcp/src`, then restored) against this branch, same corpus, same command:

| mode | `4064c4e` | FIX-F | |
|---|---|---|---|
| bm25 only, recall@5 | 40/60 | **39/60** | −1 |
| bm25 only, recall@1 | 26/60 | **24/60** | −2 |
| vectors only, recall@5 | 51/60 | 51/60 | — |
| vectors only, recall@1 | 24/60 | 24/60 | — |
| **hybrid (auto), recall@5** | **51/60** | **51/60** | **—** |
| **hybrid (auto), recall@1** | **27/60** | **27/60** | **—** |
| hybrid (always), recall@5 / @1 | 51/60 · 27/60 | 51/60 · 27/60 | — |

Both runs `PASS` and both exit 0. **The mode the product actually runs does not move.** The whole
cost lands in `bm25 only` — the diagnostic mode where no vector list exists to balance the `titles`
weight of 1.5 — and it is exactly the three queries the per-query baseline names as lost
(`old documentation…`, `the search box…`, `data leakage`), against one gained. Those are queries
whose top row **was** a session title and is now a transcript block, which is the change, working.

So the ruling did not have to be invoked: the honest fix costs nothing measurable at the door
either surface uses. Had it cost hybrid recall I would have landed it anyway and said so — a
citation for a session whose transcript nobody has read is worse than a missed row — but it does
not, and saying "it cost nothing" is only worth anything with the other five rows printed beside
it.

Files changed, and nothing outside the delivery list:

```
packages/core/src/doctor-line.ts       VectorReport.working
packages/core/src/vec.ts               vecStatus reads the embed lock, once
packages/core/src/recall.ts            SUMMARY_KINDS, the cap, the partition, the honest reasons
packages/core/src/render/find.ts       the contradicting sentence is dropped, not printed
packages/mcp/src/tools/recall.ts       capability, note, citability, order, scope.cards, windows, plural
tests/mcp.test.ts  tests/find-warming.test.ts  tests/vectors-lazy.test.ts
plugins/claude-code/dist/{mcp,potsherd}.js     via `pnpm build && pnpm vendor` only
phases/phase-10/FIX-F-REPORT.md
```

`packages/core/src/render/find.ts` **was** checked before editing, as instructed, and the warming
wording does **not** live there — `semanticNote` only wraps the string `cli/commands/find.ts` hands
it. What lives there is the decision about *which* of two sentences reaches the screen, which is
what changed. The task's path `packages/core/src/render/doctor-line.ts` does not exist; the file is
`packages/core/src/doctor-line.ts` and that is what was edited.

---

## 4. WHAT I COULD NOT DO, AND THE PATCHES I AM HANDING OVER

### 4.1 `find`'s `--json` still carries the warming *string*, and `vecStatus().line` is why

`VecStatus.line` is read by exactly two verbs, and they need different answers:

- `find` (`cli/src/commands/find.ts:328`, and `:229` for `--json`) renders it **after** the fact, so
  the lock is the right authority.
- `index` (`cli/src/commands/index.ts`, `warmingSentences`) renders it **at the moment it spawns a
  worker** — it computes `vec` at `:127` and spawns at `:134` — so for the next few milliseconds the
  lock has not caught up and `index` knows better. It already carries a `spawned` flag for that
  window.

Both call sites are under `packages/cli/src/commands/`, which is reserved. **I measured what happens
if `statusLine` is simply made honest**: `find` becomes correct and **three assertions in
`tests/index.test.ts` go red** — and correctly so, because `index` would then print *"not running
… — fetching the 46.1 MB runtime in the background, once"*, which is a new lie in the other
direction:

```
$ npx vitest run tests/index.test.ts tests/find-warming.test.ts     # with statusLine made honest
 FAIL  index > never offers an upgrade …            → expected '…' to match /semantic search: warming/
 FAIL  index > prints the count and how far it has to go …
 FAIL  index > fits 60 and 80 columns with the status on the end
      Tests  5 failed | 26 passed (31)
```

(The other two of the five are `tests/find-warming.test.ts`'s own assertions, still un-updated at
that point — they are the change, not a casualty. The three above are not: they are `index`
describing a worker it has just spawned.)

So the honest `find` line and the `index` patch have to land **together**, and I shipped neither
half of that: the human screen is fixed the other way (§1 C2 — the contradicting sentence is
dropped), and `find --json`'s `semantic.line` still reads `semantic search: warming (49 of 4,751
embedded)` while `semantic.working` beside it reads `false`. A script is not misled; a human reading
the raw JSON could be.

**The patch, exactly.** Three edits, and they must go in one commit:

```diff
--- a/packages/core/src/vec.ts        (mine, already staged for it — `working` is on the report)
@@ statusLine()
   if (r.phase === 'unavailable') {
     return `semantic search: ${r.reason ?? 'not running on this machine'}`;
   }
+  if (r.working === false) return stoppedLine(r, fmtNum, fmtBytes);
   return warmingLine(r, fmtNum);
```

with, in `packages/core/src/doctor-line.ts`:

```ts
/** The other half of {@link warmingLine}: rows to embed, and nobody embedding them. */
export function stoppedLine(
  r: VectorReport,
  num: (n: number) => string = String,
  bytes: (n: number) => string = (n) => `${Math.round(n / 1_000_000)} MB`,
): string {
  const head = `semantic search: not running (${num(r.embedded)} of ${num(r.total)} embedded)`;
  if (!r.runtimeReady) return `${head} — the ${bytes(r.acquireBytes)} runtime has not been fetched`;
  if (r.embedded > 0) return `${head} — it stopped partway`;
  return head;
}
```

and, in the reserved file, one line:

```diff
--- a/packages/cli/src/commands/index.ts
@@ function warmingSentences(vec: VecStatus | undefined, spawned: boolean): string[]
-  const head = vec?.line ?? `semantic search: warming (${fmt.num(r.embedded)} of ${fmt.num(r.total)})`;
+  // This run has just spawned a worker the lock cannot see yet, so `spawned`
+  // is the better authority for the next few milliseconds — FIX-F C2.
+  const head =
+    (spawned ? warmingLine(r, fmt.num) : vec?.line) ??
+    `semantic search: warming (${fmt.num(r.embedded)} of ${fmt.num(r.total)})`;
```

(`warmingLine` needs adding to that file's `@potsherd/core` import; it is already exported from
`vec.ts`, and the barrel re-export it needs is §4.2.) With those three edits together,
`tests/index.test.ts` is green again and `find` prints `semantic search: not running (0 of 4,751
embedded) — the 46.1 MB runtime has not been fetched`, which is the doctor row's sentence at last.

### 4.2 `SUMMARY_KINDS` is spelled twice

The authority is `packages/core/src/recall.ts`. The MCP door cannot import it, because
`packages/core/src/index.ts` is reserved and the door imports through the barrel. It keeps the
predicate it already had — inline, spelled twice, in `hitJson` and `windowsFrom` — now named once as
a local `SUMMARY_KINDS` with a comment pointing at the authority. The one line that closes it:

```diff
--- a/packages/core/src/index.ts
@@ export { … ROUTING_KINDS, ROUTING_PER_SESSION, byLane, laneOfHit, laneOfSession, …
-  ROUTING_KINDS,
+  ROUTING_KINDS,
+  SUMMARY_KINDS,
+  isSummaryHit,
+  hasTranscriptEvidence,
+  summaryRank,
```

then in `packages/mcp/src/tools/recall.ts` delete the local `SUMMARY_KINDS` and add it to the
existing `@potsherd/core` import. I did not do it as a deep relative import (`../../../core/src/…`,
which the `cli/src/filters.js` import shows would work) because esbuild would then bundle
`core/src/recall.ts` **beside** `core/dist/recall.js` — two copies of one module in the shipped
1.6 MB bundle, with two `WEIGHTS` and two caches. A duplicated four-word constant is the smaller
harm.

### 4.3 The doctor **row** is still `warming N of M` when nothing is running

`vectorNote` — the `vectors` row `doctor` and `index` both render — is unchanged, for the same
reason as §4.1: `tests/index.test.ts` asserts `warming 1,294 of 1,678` on a receipt built with
`spawned: true`, and that assertion is right. The row is honest in the state the verifier filed
(`0 of 4,745 · 46.1 MB runtime not fetched yet`, which does not use the word) and dishonest in the
stopped-partway state. It should move with §4.1's patch:

```diff
--- a/packages/core/src/doctor-line.ts
@@ vectorNote(), case 'warming'
-        parts: [`warming ${num(r.embedded)} of ${num(r.total)}`, runtime],
+        parts: [
+          r.working === false
+            ? `stopped at ${num(r.embedded)} of ${num(r.total)}`
+            : `warming ${num(r.embedded)} of ${num(r.total)}`,
+          runtime,
+        ],
```

### 4.4 `find` says **nothing** about semantic search in one state

When some rows are embedded, nothing is embedding the rest, and the query's own words settled it,
`find` now prints no semantic line at all: the warming sentence is dropped and the replacement
clause (`the words matched, so the vector half was not needed`) is about *this search* rather than
about the index. That is the sanctioned fallback — *say what the reader can do, or say nothing,
never an instruction they cannot run* — but it is a loss of the count on the human screen, and
§4.1's patch is what restores it. `--json` carries `semantic.{embedded,total,working}` throughout.

### 4.5 Two screens under `docs/screens/` are now stale, and they are not mine

`docs/screens/09-find.txt` and `docs/screens/13-find-redacted.txt` both contain
`semantic search: warming (0 of 3,410 embedded)`, and the new `find` behaviour drops that line
whenever nothing holds the embed lane. `07-index.txt` is `index`'s own line and does **not** change.
`docs/screens/**`, `.github/workflows/ci.yml` and `tests/llm.test.ts` are another worker's; I did not
touch them, and I did not run `make-screens.sh` (it leaks one detached embedder per run and disk was
tight). Regenerate after this lands, and kill that embedder by its recorded pid.

**And there is a flake in it that its owner should hear about before they regenerate.**
`scripts/make-screens.sh:176` runs `index --full`, which spawns the detached embedder; `:220` and
`:233` then shoot the two `find` screens. Whether those two screens contain the warming line now
depends on **whether that embedder is still alive when `find` runs** — normally it is not, because
it fails to fetch the 46 MB runtime and exits within a second or two, but on a machine that *can*
fetch it will hold the lane for the whole download and the line will be there. That is a race
between a capture script and a background process, and pinning its output byte-for-byte in CI is the
same class of thing as C1's pinned `2.1 MB`/`2.2 MB` database size. The cheap fix is for the script
to wait for the embed lane to be free before shooting `09` and `13` — one `until` loop over
`<root>/.lock.embed` — rather than for the screens to record whichever side of the race that run
landed on.

### 4.6 What I did not verify

1. **Linux and Windows.** Everything here is macOS/node 24. `lock.holder` uses `process.kill(pid,0)`
   and `isStale`'s host check, both of which this repo already relies on.
2. **A fully embedded *real* archive.** The wasm embedder reached 49 of 4,751 in about a minute;
   the whole pass is roughly two hours and disk on this machine was between 3.0 and 5.2 GiB free
   throughout. State 3 was measured on a corpus embedded to completion (`5 of 5`), which exercises
   the same branches of the same functions.
3. **The `--no-cards` A/B on cards.** This archive has no cards in it, so `scope.cards` is proved to
   be accepted, forwarded and reported, but not to change a result set. `tests/cards-lane.test.ts`
   covers the fusion half and is green.
4. **Whether CI is green.** The two reds named in my instructions are not mine and I did not fix
   them; §4.5 adds two screens to the second one's list. I will note, because I was told to name it
   if I saw it, that **I did not see the `tests/llm.test.ts` listener-count red**: the full suite is
   green under `POTSHERD_SQLITE=node` on this machine, on this branch, in two separate runs. I have
   no access to the CI matrix and I am not claiming that finding is closed — only that it did not
   reproduce here.

### 4.7 One thing I did wrong

Reaping a leaked `vitest` worker, I killed pid 21567 believing it was mine. It was not: it belonged
to a sibling agent's `pnpm test` in `wt-FIX-G`, whose first full-suite run therefore died partway
and whose log (`…/scratchpad/g4.log`) is truncated. Its wrapper moved straight on to its second run,
so nothing of theirs is lost beyond that one log, but the run needs repeating. I checked `ps` before
killing and did not check *ownership* — the pid was live and mine had just exited, and I assumed. I
reaped the orphan it left (21642, `PPID 1`) and killed nothing else by name or pattern; every other
process I stopped was one I started and whose pid I had recorded (the embedder 43362, §2 state 2b).

### 4.8 The branch, the processes, the disk

`work/FIX-F` is three commits on top of `4064c4e` — the fix, a tidy-up, and this report.
`origin/main` has moved one commit ahead of `4064c4e` since the branch was cut; I did not merge,
rebase, push or touch it.

**Processes.** One embedder started (pid 43362, §2 state 2b) and killed by its recorded pid, `ps`
before and `ps` after; one leaked by a manual `index` run early on (96245), same treatment; the two
vitest workers of §4.7. No name pattern, no `killall`. `ps -eo pid,command | grep "[i]ndex --quiet"`
→ **0** at the end.

**Disk.** `199Gi total, 5.2Gi free` before, `3.0Gi` at the worst moment (three worktrees and two
concurrent suites), `5.0Gi` after. The scratch `HOME` (1.8 GB, APFS clones), the rescued archive and
index (659 MB) and the small embedded corpus (47 MB) are mine and are deleted. Nothing of mine
remains under `/Users/zebra/randomness/potsherd`: this report is written inside the worktree only,
as instructed.

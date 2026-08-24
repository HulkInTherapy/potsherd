# VERIFICATION-5 — the fifth independent verifier

**Commit under test:** `4fd221e` on `main`, cloned to a scratch directory. Nothing in
`/Users/zebra/randomness/potsherd` was modified except this file.
**Verifier:** authored none of phase 10. Every finding below carries the command and its output.
**Corpus:** the real archive, APFS-cloned into a scratch `HOME` and frozen before any control string
was invented. See §G.

**Identifiers.** Session ids, project names and home paths are replaced one-to-one by labels
(`S1`…`S12`, `P1`…). The mapping is stable within this document. Nothing below prints a real id.

---

## §A THE RE-SCORE

| row | audit | v3 | v4 | **v5** | the command behind it |
|---|---:|---:|---:|---:|---|
| **Overall, as an agent-facing product** | 4 | 7 | 7 | **7** | the whole of §B + §C |
| Concept & scope discipline | 9 | 9 | 9 | **9** | `potsherd --help`, `doctor` (17 verbs, 7 adapters) |
| Archive capture | 9 | 9 | 9 | **9** | `index --no-embed` → 1,800 exchanges, 311 sidechains, 7 harnesses; `doctor` |
| CLI ergonomics for a **human** | 8 | 8 | 8 | **7** | `find "git rebase conflict"` (C-1); `ls` on the demo corpus (C-3) |
| **Retrieval quality** | 3 | 7 | 7 | **7** | 4 invented controls, `pnpm evals`, `find --json` ordering scan |
| **Reliability of a default install** | 2 | 8 | 8 | **8** | `pnpm test` ×2 drivers, `typecheck`, `evals`, `check-privacy.py`, `vendor` |
| **Agent ergonomics (the actual target)** | 3 | 7 | 7 | **7** | `potsherd_recall`/`read`/`graft`; `find --json`; the `--readers-out` seam |
| Re-entry | 5 | 8 | 8 | **8** | `potsherd_graft`, `graft` receipt, `potsherd_read` citations |

### GATE: **FAIL**

`plans/phases/phase-10-agent-audit.md §D` requires **≥ 8/10 overall, retrieval ≥ 7, reliability ≥ 8,
agent ergonomics ≥ 8**, from a verifier that authored nothing, on the real archive.

| threshold | required | measured | verdict |
|---|---:|---:|---|
| Overall | ≥ 8 | **7** | **FAIL** |
| Retrieval quality | ≥ 7 | **7** | pass |
| Reliability of a default install | ≥ 8 | **8** | pass |
| Agent ergonomics | ≥ 8 | **7** | **FAIL** |

**Two of four thresholds are not met.** The gate fails.

### why each moved row moved

**CLI ergonomics for a human, 8 → 7.** Two defects on the printed page, on the two most-used verbs.
`find` prints a row labelled `weak` **above** three rows labelled `strong`, under a header that says
`strong` (C-1). `ls` prints `1 session` for a corpus on which `doctor` and `stats`, from the same
index and the same run, both print `31` — and all three are committed screenshots (C-3). `plans/05`
asks whether the output makes sense as a screenshot with no caption. These two do not.

**Agent ergonomics, 7 → 7 (not 8).** Three defects, all on the `find --json` door rather than the
MCP door: `citable: true` on a summary-only block where `potsherd_recall` says `citable: false` for
**the same thread** (C-2); the `sessions[]` ordering inversion, so `sessions[0]` can be the weakest
row on the page (C-1); and the `--readers-out` file, which an agent must fill in, carrying neither a
`schema` nor an `instruction` field although the synthesis file it hands back carries both (C-5).
FIX-D and FIX-F both fixed exactly these properties at `potsherd_recall` and left `find --json`
saying the old thing. That is this project's hunting-list item 9, three times over, and it is why
this row is not an 8.

**Overall, 7.** Held, not because nothing landed — C1 through C7 are genuinely closed, see §B — but
because what replaced them is the same family of defect on the neighbouring surface. A caller that
uses the MCP door gets a calibrated, ordered, un-citable-summary result set; a caller that uses
`find --json` does not, and nothing in 1,932 tests notices (§F).

**Reliability held at 8**, deliberately. The default install works end to end: every verb runs, the
embedder acquires lazily and completes, `ask` falls back to spawning the harness binary rather than
demanding a 677 MB SDK, and the whole suite is green under both drivers with 0 skipped. The lock
hazard at C-4 is real and unclosed, but its trigger is a killed worker **plus** pid reuse, not the
out-of-the-box path, so it did not move this row. It is filed at ★★★ instead.

---

## §B THE FIXES SINCE `9ee2c6e` — are they real?

### C1 — the WAL database size, the `TZ` pin, the listener test · **REAL, all three**

```
$ node -e "...page_count/page_size vs statSync..."
page_count 34621 page_size 4096 = 141807616 bytes = 135.2 MiB freelist 25
file size 141807616 = 135.2 MiB
-wal 0   -shm 32768
```
`stats` printed `database 135 MB`. `page_count * page_size` equals the file exactly, and
`packages/core/src/stats.ts:386` is the pragma, not `statSync`.

```
$ grep -n "TZ" scripts/make-screens.sh
105:export TZ=UTC
```
and `.github/workflows/ci.yml` sets `TZ=UTC` in its own `run()`. The two agree.

`tests/llm.test.ts:2025` — "*This asks which listeners are ours, and never how many there are*" —
filters `process.listeners(sig)` by a module-private mark. Confirmed by reading; the suite is green
with two unrelated `MaxListenersExceededWarning` lines from vitest's own sockets, which the test no
longer depends on.

### C2 — the warming lie, one flag, four states · **REAL for three of four surfaces; one gap**

Driven through all four states on an isolated 22→183-exchange corpus.

| state | `doctor` vectors row | `find` line | MCP `capability` |
|---|---|---|---|
| **1** nothing fetched, no worker | `— 0 of 1,800 · 46.1 MB runtime not fetched yet` | `semantic search: not running (0 of 1,800 embedded) — the 46.1 MB runtime has not been fetched` | `keyword search only — semantic search is not running (0 of 1,800 embedded)` |
| **2** worker alive, lock held | `36 warming 36 of 176 · bge-small, 384-d, wasm` | `semantic search: warming (37 of 176 embedded)` | `keyword search only — semantic search is warming (38 of 176 embedded)` |
| **3** dead worker, stale lock on disk | `176 stopped at 176 of 183` | `semantic search: not running (176 of 183 embedded) — it stopped partway` | `keyword search only — semantic search is not running (176 of 183 embedded)` |
| **4** fully embedded | `22 bge-small, 384-d, wasm · every exchange` | *(no match, `bm25 + vectors`)* | `keyword + semantic search (22 of 22 embedded)` |

State 3 was produced by planting `.lock.embed/owner.json` with pid `99991`, confirmed dead
(`ps -p 99991` → nothing). The stale lock is refused, `working: false`, and every surface says
*not running*. `find --json` agrees:

```
{"embedded": 176, "pending": 7, "total": 183, "runtimeReady": true, "acquireBytes": 0,
 "working": false, "phase": "warming",
 "line": "semantic search: not running (176 of 183 embedded) — it stopped partway"}
```

The `spawned` window is handled: `index` prints `semantic search: warming (0 of 22 embedded) —
fetching 46.1 MB, once` in the same run that spawns the child, before the child has taken the lock.

**The gap (C-6 below, ★★).** In state 1 vs state 2 with the runtime not yet on disk, `doctor`'s row
is the *same sentence*: `vectorNote`'s `pending` branch ignores `working` entirely when
`!runtimeReady` (`packages/core/src/doctor-line.ts:216-231`). `doctor` — the verb whose job is to
report capability — cannot tell "nobody is embedding" from "a fetch is running right now", while
`find` and the MCP door can.

### C3 — the title-only citation, the cap, and `scope.cards` · **REAL at the MCP door; NOT at the CLI door**

At the MCP door, on the real archive, `potsherd_recall "prospe"`:

```
8 ev= transcript      lane= evidence citable= True  citation= <S3 · P2 · claude…>  conf= weak cal= 0.677
9 ev= not-a-transcript lane= evidence citable= False citation= NULL               conf= weak cal= 0.850
   note: nothing here is a transcript: the session title or its card matched, the body did not
         use those words. Not citable. potsherd_read the thread if you want to know …
```
The summary-only thread calibrates **0.850** — higher than everything above it — and is ranked
**last**, capped at `weak`, `citable: false`, `citation: null`. The ordering is a property of
`summaryRank`, not of a weight. That is C3 delivered.

`scope.cards` changes a result set, not just an envelope:

```
query "cards-first strategy latency target missed"   (index with 4 cards)
 scope.cards=true    n=2  summaryOnly=1  ids=[(T1,evidence,True),(T2,evidence,False)]
 scope.cards=false   n=1  summaryOnly=0  ids=[(T1,evidence,True)]
```
and `cards_fts` disappears from `lists` when it is off. Confirmed.

**But the same thread, `find --json`, same index, same run:** `citable: true`. See C-2 in §C.

### C4 — the false honest-empty on a JSON-string `reply` · **REAL, and it survives shapes the author may not have tried**

Full round trip run the way the docs print it: `--readers-out` (0 model calls, 1.0 s), reader
outputs answered by hand, `--readers-in … --synthesis-out` (0 model calls), then `--filter-in` with
a planted fabrication in every reply shape.

```
##### A_object            EXIT=0   ANSWER 1 sentence [1] · "1 sentence dropped · no citation that resolves"
##### B_jsonstring        EXIT=0   same answer, plus:  the recorded "reply" was a JSON string; parsed it…
##### C_fenced (```json)  EXIT=0   same answer, byte for byte
##### D_array             EXIT=2   "reply" is an array, and the shape "schema" asks for is an object
##### G_prose             EXIT=2   "reply" is a string and it is not JSON…prose carries no quote it can check
##### H_empty_string      EXIT=2   "reply" is an empty string…that is a file nobody has answered
##### I_number            EXIT=2   "reply" is a number, and the shape "schema" asks for is an object
##### J_junk_entries      EXIT=2   holds 1 evidence entry and 1 sentence, and not one of them is usable
##### M_no reply key      EXIT=2   has no "reply" — it is a --synthesis-out recording nobody has answered
##### F_honest_empty      EXIT=1   "no grounded answer…the readers found material, and the answer was empty"
```
The planted fabrication (`"We agreed to hard-fail…per RFC 7749"`) is deleted in **all three**
accepted spellings, identically. The honest empty is allowed and reaches exit 1. Every refusal
carries exit 2, never 1, and never echoes the reply's text. This is the strongest fix in the set.

One residue at ★★ (C-7): `{"evidence":[…valid…]}` with the `answer` key *absent* is accepted and
renders **byte-identically** to the host's honest empty, at exit 1.

### C5 — `--synthesis-out` refuses without `--readers-in` · **REAL, and it fires before the index opens**

```
$ potsherd ask "…" --synthesis-out s.json --potsherd-dir <A-PATH-THAT-DOES-NOT-EXIST>
potsherd: --synthesis-out makes no model call only when the readers are already recorded; on its
own it would spend one reader call per shortlisted session before it had a prompt to write
  try:  potsherd ask "…" --readers-out r.json   # run your readers, then --readers-in r.json …
exit=1        (no file written; `ls s.json` → No such file)
```
A nonexistent potsherd dir produces the *flag* error, not a database error, so the guard is ahead of
the index open and therefore ahead of any model call. `--help` agrees:
`--synthesis-out <path>  with --readers-in: write the synthesis prompt to this file; makes no model
call`. The composed form is still free — `no model call was made (0). the prompt is redacted, as
sent.`

### C6 — the empty context window · **REAL**

`potsherd_recall {want:"context"}` on a real hit returns 2 windows with `text` of 14,040 and
non-zero characters, each carrying `seq`, `ts`, `citation`, `confidence`. On an invented nonsense
control it returns `noMatch: true`, zero windows, and the refusal note. Not empty when it should
not be, empty when it should be.

### C7 — the `nothing()` headline, `--synthesis-out` in `--help`, pluralisation · **REAL**

The emptiness frame is gone from the capability path: `ask` with no reachable backend now prints
`nothing was read — all 4 readers failed` and `no reader could run, so nothing was read: …`, exit 1,
rather than an archive-shaped empty. Pluralisation is correct throughout the outputs I captured
(`1 session` / `54 sessions`, `1 sentence dropped`, `these 6 sessions are the shortlist`).
See C-9 for one line on that same screen that still contradicts itself.

### `4fd221e` — `VecStatus.line`, the screens race, `10-stats.txt`, the version test

- **`VecStatus.line` coupling** — real: one `line` field in `find --json`'s `semantic` block, driving
  the same string the human sees. Verified in all four states above.
- **The screens race** — real: `stop_demo_embedder()` waits for the child's own `owner.json`, kills
  **by the pid written there**, verifies the command line names the demo root, and clears the lock.
  This is the correct shape and it is what stops `09-find.txt`/`13-find-redacted.txt` recording
  whichever side of a network race the run landed on.
- **`10-stats.txt` normalisation** — see C-8. It hides a fact about **the guard's own procedure**,
  not about the machine, and it hides the digit rather than fixing the sequence.
- **The version test's tag scope** — **REAL, and it can fail.** Proved both directions:

```
$ git tag v1.4.2 <a commit that is NOT an ancestor of HEAD>   # the foreign-tag scenario
NOT an ancestor of HEAD (good)
 ✓ tests/terminal.test.ts  Tests 1 passed | 69 skipped
$ git tag -d v1.4.2

$ git tag v9.9.9 HEAD
 × is not behind the newest git tag this repository released
   → VERSION is 1.2.0 but this repository already released v9.9.9
$ git tag -d v9.9.9
```
Both tags were created and deleted in the same command, in my own clone. See C-10 for the half of
this test that is still its environment.

---

## §C NEW DEFECTS, RANKED

### C-1 ★★★★★ — `find` prints a `weak` row above three `strong` ones, under a `strong` header

FIX-D's title is "*an order that argued with its own label*". It fixed that at
`packages/mcp/src/tools/recall.ts` with `orderByLabel`. `packages/cli/src/commands/find.ts` never
imports it: `packages/core/src/recall.ts:2265` sorts sessions by
`summaryRank || byLane`, and `byLane` is *lane, then the fused RRF score* — confidence is never a
sort key. On the real archive:

```
$ potsherd find "git rebase conflict" --no-color
potsherd find "git rebase conflict" · 6 sessions · strong · bm25 · 358ms

  ↳ TASK T10.2 — model access with zero setup: the host age…  claude · sidechain
  P1 · 23 aug · 4 exchanges · HEAD                                  weak  0.0110
  …
  Plans resume prompt and loop completion                          claude · live
  P3 · 21 aug · 45 exchanges · HEAD                               strong  0.0100
  …
  ↳ You are a SCOUT for phase 1 of the potsherd project. Yo…  claude · sidechain
  P1 · 21 aug · 1 exchange · HEAD                                 strong  0.0091
```

```
$ potsherd find "git rebase conflict" --json | …
0 weak   0.567  0.01102      <- sessions[0]
1 strong 0.775  0.01003
2 strong 0.762  0.00988
3 weak   0.743  0.00933
4 strong 0.925  0.00918      <- the best-calibrated row on the page, at index 4
5 strong 0.925  0.00908
```

A scan of 18 queries found the inversion on 2 of them, with 4 separate inversions:

```
git rebase conflict   n=10 CONF-INVERSIONS= [(0,'weak','strong'),(4,'none','weak'),(5,'weak','strong')]
evolutio              n=10 CONF-INVERSIONS= [(4,'weak','strong')]
```

**Why it matters.** The header says `strong` and the first row says `weak`; that is the screenshot
test failing on the product's headline verb. For an agent it is worse: `sessions[0]` — the row every
skill and every `jq -r '.sessions[0].resume'` example in `find --help` takes — is the weakest row on
a page whose best row calibrates 0.925. F1 asked for "*a cliff, not a ranking*"; the cliff exists,
and the rows above and below it are shuffled.

### C-2 ★★★★ — `find --json` says `citable: true` for a summary-only block; `potsherd_recall` says `false` for the same thread

`packages/cli/src/commands/find.ts:270`:
```ts
citable: (s.lane ?? 'evidence') === 'evidence',
```
`packages/mcp/src/tools/recall.ts:493`:
```ts
citable: (lead.lane ?? 'evidence') === 'evidence' && evidence !== 'not-a-transcript',
```
`packages/core/src/recall.ts:236` puts `title` in `SUMMARY_KINDS` but deliberately **not** in
`ROUTING_KINDS`, so `laneOfHit('title') === 'evidence'` — which means the CLI's lane test cannot
ever return `false` for a title-only block. Thread `S8`, one query, both doors:

```
$ potsherd find "prospe" --json --min-confidence none
8 S8 kinds= ['title','title','title'] lane= evidence citable= True  conf= weak ceiling= weak cal= 0.850

$ potsherd_recall {"query":"prospe","json":true}
8 ev= not-a-transcript lane= evidence citable= False citation= NULL conf= weak cal= 0.850
   summaryOnly: 1
```
Same commit, same index, same thread id (`S8`), opposite answers to the one question F6 is about.
An agent that reads `find --json` — the door `find --help`'s own examples point at — is told it may
quote a model-written session title as evidence. The cap and the ordering are applied; only the
machine-readable *permission* is wrong. **No test pins it in either direction** (§F).

### C-3 ★★★★ — `ls` prints `1 session` where `doctor` and `stats` print `31`, on three published screenshots

Three committed screens, one demo corpus, one capture run:

```
docs/screens/04-doctor.txt:8    sessions on disk              31   21 harness-titled · 3 sdk · 546 KB
docs/screens/10-stats.txt:6     sessions                      31   197 subagents · 31 titled · 0 archived
docs/screens/08-ls.txt          1 session · 197 subagents inside them · 299 ghosts, prompts only
```
Reproduced live on a freshly generated demo corpus (`04-doctor.txt` byte-identical, `08-ls.txt`
byte-identical):
```
$ ls --limit 400 --json
total = 300 · shown = 300 · ghosts = 299 · rolledUp = 197 · threaded = 30
$ ls  →  "1 session · 197 subagents inside them · 299 ghosts, prompts only"
$ doctor → "sessions on disk 31 · 21 harness-titled"
```
`threaded: 30` is the answer: 30 of the 31 are folded into one thread, which is F4 working
correctly. The defect is that the footer **accounts for the 197 subagents on the same line and
silently drops the 30 threaded siblings**, and calls the remainder "sessions". `--json` knows; the
human view does not; and the two neighbouring verbs print the other number. This is the audit's own
F2 complaint — "*the two subsystems disagree in print*" — closed for `vectors` by `doctor-line.ts`
and still open for session counts, published as documentation. It reproduces on the real archive
too, at `threaded: 2` (`ls` 54, `stats` 56).

### C-4 ★★★ — the embed lock has no expiry, and any live pid poisons it permanently

`packages/core/src/lock.ts:170` — `isStale` returns `!pidAlive(holder.pid)` whenever the owner is
readable and host-local, and **never falls through to the 5-minute mtime test**. The docstring says
so on purpose ("*A live owner is never stale*"). Two measurements:

```
# 1. kill -9 leaves the lock behind. Nothing in the product removes it.
$ ps -p 48195 → node …potsherd.js index --quiet --potsherd-dir …/box2/pd
$ kill -9 48195 ; ps -p 48195 → gone
$ cat .lock.embed/owner.json
{"pid":48195,"op":"embed","at":"2026-08-24T18:41:23.642Z","host":""}
```
```
# 2. a live, unrelated pid in that file is indistinguishable from a working embedder, for ever.
$ nohup sleep 400 & → 36477      (a sleep, not an embedder)
$ echo '{"pid":36477,"op":"embed",…}' > .lock.embed/owner.json
$ potsherd index                 →  semantic search: warming (176 of 183 embedded)
$ ps -eo pid,command | grep box2/pd   →  NONE spawned
$ potsherd doctor                →  vectors  176   warming 176 of 183 · bge-small, 384-d, wasm
$ potsherd find "plan"           →  semantic search: warming (176 of 183 embedded)
```
So: the product spawns a detached embedder it cannot stop (documented in-tree as an open item, and
this repository's own verification instructions tell people to kill it by pid); killing it leaves the
lock; and once the OS reuses that pid number, `index` refuses to spawn a replacement and all three
surfaces say **warming** indefinitely. There is no expiry, no `unlock` verb, and `doctor` never
mentions the lock. This is C2's warming lie re-entering by a door C2 did not close. It did not move
the reliability row because the trigger is a killed worker plus pid reuse, not the default path.

### C-5 ★★★ — the `--readers-out` file has neither a `schema` nor an `instruction`, though the file it hands back has both

FIX-G C4(c) added `instruction: REPLY_INSTRUCTION` to the synthesis file and to its `--json`
receipt, because "*add it to the file as `reply`*" was not specific enough for an agent to obey. The
**first** leg of the same seam — the one an agent must fill in with no prior — was left as it was:

```
$ python3 -c "print(list(json.load(open('r.json')).keys()))"
['kind','version','potsherd','question','k','sessionIds','targets','index']     # no schema, no instruction
$ (the receipt says)  run one reader per entry in "targets", then add
                      "outputs": [{ "sessionId": …, "found": …, "quotes": […], "answer_fragment": … }]
```
`quotes: […]` is the whole specification. I guessed `{seq, quote}`, which is the natural reading, and
got:
```
potsherd: r.json: outputs[0].quotes[0] has no "text"
  try:  copied character for character out of that session's excerpts
```
The correct shape is `{seq, text}` and it appears nowhere in the file, in `--help`, or in the
receipt. An agent with three tools and no shell cannot discover it except by failing. Compare the
synthesis file, which ships `"schema": "{\"evidence\":[{\"n\":1,…}],\"answer\":[…]}"` verbatim.
This is hunting-list item 7 and item 9 in one place.

### C-6 ★★ — `doctor` cannot tell "nobody is embedding" from "a fetch is in flight"

```
state 1 (no worker, 1,800 pending):   vectors  —  0 of 1,800 · 46.1 MB runtime not fetched yet
state 2 (worker alive, lock held):    vectors  —  0 of 22    · 32.4 MB runtime not fetched yet
```
Same sentence. `vectorNote`'s `pending` branch reads `working` only when `runtimeReady` is true
(`doctor-line.ts:216-231`); on the first run of a fresh install — the exact moment a user runs
`doctor` to ask *is anything happening* — it never reads it at all. `find` and `potsherd_recall`
both distinguish the two states. FIX-F C2's claim is that one flag drives all four surfaces; it
drives three.

### C-7 ★★ — a reply with valid `evidence` and no `answer` key is rendered as the honest empty

```
$ potsherd ask "…" --filter-in s-E_missing_answer.json     # reply = {"evidence":[…2 valid entries…]}
  no grounded answer in 6 sessions searched
  the readers found material, and the answer built from it was empty.
  6 of 6 sessions read · 6 answered · 259ms       EXIT=1

$ potsherd ask "…" --filter-in s-F_honest_empty.json       # reply = {"evidence":[],"answer":[]}
  …byte-identical output…                                  EXIT=1
```
`hostReply`'s docstring refuses an object "carrying **neither** an `evidence` array **nor** an
`answer` array", so an object carrying one of the two passes. The consequence is the shape C4 exists
to prevent, at reduced strength: a structurally incomplete reply reaches exit **1** — "*the archive
was read and had nothing*" — and is indistinguishable in print from the host's legitimate empty.
Borderline (an absent `answer` array is arguably an empty one), which is why it is ★★ and not ★★★★.

### C-8 ★★ — the `10-stats.txt` normaliser hides a fact about the guard's own procedure

```yaml
-e 's/^(  database +)[0-9.]+ [kMG]?B/\1<size>/'
```
The justification (`ci.yml:370-392`) is that page allocation depends on the order rows arrived, and
that the guard's sequence "*is a miniature of `scripts/make-screens.sh`'s, not a copy of it*". That
is precisely the point: the digit two honest runs disagree about is a fact about **two different
capture sequences**, one of which the guard wrote itself. Normalising it fixes the symptom; running
the same sequence would fix the cause. And the pattern `[0-9.]+ [kMG]?B` matches anything, so the
published `2.1 MB` is now unverified by CI in *magnitude* as well as in digit — a `stats` that
started printing `2.1 kB` or `2.1 GB` would pass this guard. The C1 measurement fix (`page_count *
page_size`) is real and independently confirmed above, so nothing is currently wrong; what is gone
is the guard on it.

**Uncovered screens.** Ten of seventeen are checked. Uncovered: `04-doctor`, `05-doctor-privacy`,
`07-index`, `14-ask`, `15-graft`, `16-before-after`, `17-ls-cards`. I regenerated `04-doctor.txt`
against this build on a fresh demo corpus: **byte-identical after normalisation**, not stale.
`05`, `15` and the three model screens I could not regenerate (§E). `08-ls.txt` — which *is* covered
— is the one carrying C-3, so the answer to "is any uncovered screen stale" is again *no; the covered
one is the problem*.

### C-9 ★★ — two receipts that contradict themselves in one screen

```
$ potsherd ask "…"                 # no reachable backend
  nothing was read — all 4 readers failed
  …
  4 of 4 sessions read · 0 answered · 6.4s
  4 readers did not answer · not counted as searched
```
`nothing was read` and `4 of 4 sessions read` are three lines apart.

```
$ potsherd_graft {"thread":"S9"}
> **unsummarised.** No model call was made — the model call failed (claude --print could not
> answer: Not logged in · Please run /login).
```
A call that failed was made. The degradation is honest — which is the important half — but the
sentence says both things at once.

### C-10 ★★ — the version test reports **passed**, not skipped, when its premise is absent — and that is CI's state

The docstring says both escapes "*skip loudly rather than assert something the environment, not the
test, established (`09 §7.2`)*". The code is a bare `return`:

```ts
if (tags.length === 0) return;
```
Vitest reports that as a pass. Simulated with a `git` shim that returns no tags:
```
$ PATH=<shim>:$PATH npx vitest run tests/terminal.test.ts -t "is not behind the newest git tag"
   ✓ the version a user reads > is not behind the newest git tag this repository released 1011ms
 Tests  1 passed | 69 skipped (70)
$ PATH=<shim>:$PATH git tag --list 'v[0-9]*' --merged HEAD | wc -l
       0
```
`.github/workflows/ci.yml:24` is `actions/checkout@v4` with no `fetch-depth` and no `fetch-tags`,
whose default is a depth-1 checkout that fetches no tags — so this is CI's state on every run, and
the assertion that exists because "*at tag `v0.7.0` the binary printed `0.4.0`*" is green without
being evaluated. It is live and correct in a full clone (proved in §B), so this is about coverage,
not correctness — but a green tick that means "not run" is the failure mode this repository names in
its own rule 4.

### C-11 ★ — `pnpm evals` reports five per-query regressions and exits 0, and CI never runs it

```
$ pnpm evals ; echo EXIT=$?
  hybrid (auto)  recall@5  51/60  ✓ ≥ bm25 (39)  ✓ ≥ vectors (51)  ✓ ≥ 51/60
                 recall@1  27/60  ✓ > bm25 (24)  ✓ > vectors (24)  PASS
  against the pinned per-query baseline  ·  evals/per-query-baseline.json
   lost  bm25  recall@5  old documentation coming above the page people actu…
   lost  bm25  recall@5  the search box that only worked if you got the word…
   lost  bm25  recall@1  data leakage
   lost  bm25  recall@1  old documentation coming above the page people actu…
   lost  bm25  recall@1  the search box that only worked if you got the word…
   gain  bm25  recall@5  whether page two belonged in the site index at all
   gain  bm25  recall@1  eu region reporting a day late
EXIT=0
```
The aggregate is unchanged, so this is tie-break drift and not a regression. It is filed at ★
because the *alarm* is by design not a gate — but `grep -n evals .github/workflows/ci.yml` finds
only `evals/ask-selftest.ts`, so neither the gate nor the alarm is ever evaluated automatically.
Relatedly, `tests/evals-gate.test.ts`'s header records a run of **25** queries
(`@5 bm25 12 vec 22 hyb 22 · @1 bm25 10 vec 6 hyb 11`) against a set that today holds **60**
(`evals/queries.jsonl`: 66 lines, 6 controls). The comment's own rule — "*a comment that describes a
run nobody can reproduce is the failure this project keeps finding*" — now applies to itself.

---

## §D CLAIMS I CHECKED THAT HELD

1. **The four baselines, exactly.** `pnpm test` → `Test Files 53 passed (53) · Tests 1932 passed
   (1932) · EXIT=0`, `0` skipped lines. `POTSHERD_SQLITE=node pnpm test` → identical: `53 / 1932 /
   EXIT=0`. `pnpm typecheck` → core, bridges, cli, mcp, all `Done`, 4 of 4.
2. **`python3 scripts/check-privacy.py` → `PRIVACY_EXIT=0`**, read as an exit code and not as the
   final line, which is the header caveat this project has been fooled by three times.
3. **`pnpm vendor` produces no diff.** `git status --porcelain | wc -l` → `0` after running it.
4. **`pnpm evals` exits 0** with hybrid `recall@5 51/60`, `recall@1 27/60`, both singles beaten.
5. **F7 — six MCP tools are now three.** `potsherd-mcp 1.2.0 ready · 3 tools`; `tools/list` returns
   exactly `potsherd_recall`, `potsherd_read`, `potsherd_graft`.
6. **F1 at both doors, on four controls invented after the corpus was frozen.** Nonsense
   `xylophrantic bedduzzle qwomparil` and `snerfwidget plaskonium thrumbex` →
   `no match · nothing in the index matches`. Real-English-but-absent `espalier apple orchard
   rootstock pruning` → `nothing in the index answers … 8 sessions matched some of those words and
   none of them enough`, which is a *different and better* sentence than the nonsense one.
   `underglaze slipware sgraffito` → no match, despite the tool being named after a potsherd.
   All four also return `noMatch: true` at `potsherd_recall`, with
   `"Say so — do not widen into a guess, and do not answer from the repository in front of you."`
7. **The floor still lets a real hit through.** `find "sqlite vec embeddings"` → `7 sessions ·
   strong`, four `strong` rows at calibration 0.85–0.82, three `weak`, and `withheld: 2` — which I
   confirmed against `--min-confidence none` (9 rows, of which exactly 2 label `none`).
8. **F3 — a fabricated citation dies in code.** See §B/C4: identical deletion in the object, the
   JSON-string and the fenced spellings, with `1 sentence dropped · no citation that resolves`.
9. **F4 — the thread is the unit, dated by content.** Indexed exchange counts against a hand-count
   of human prompts in the raw JSONL, five largest sessions:
   `223/223`, `119/119`, `84/84`, `155/160`, `103/108`; spans `2026-06-28 → 2026-07-20`,
   `2026-08-12 → 2026-08-19`. The audit's fixture (101 prompts indexed as *4 exchanges*, dated by
   the first record) does not reproduce. `ls` shows thread markers (`↳7`, `↳29`).
10. **F6 — a summary cannot testify at the model door.** `citable: false`, `citation: null`,
    `ceiling: weak`, ranked last despite the highest calibration on the page, plus a `citableNote`
    that tells the agent what to do instead.
11. **The seam is free where it says it is.** `--readers-out`: `no model call was made (0)`, 1.05 s
    wall clock. `--readers-in … --synthesis-out`: `no model call was made (0)`.
12. **`--readers-in` refuses a mismatched recording by name** — wrong question, wrong `--k`, missing
    `outputs`, orphaned reader ids — each with its own message and its own fix line.
13. **`potsherd_read` returns real exchanges with a `citations` array and a `citationRule`** ("*A
    line you composed — a file path, a dash, an id you did not get from potsherd — is refused as a
    citation*"), which is the direct answer to the audit's F3 opening failure.
14. **`potsherd_graft` writes exactly one file in the project you run it in**
    (`./.potsherd/graft-<id8>.md`), reports `estimated: true` on its token count rather than stating
    an estimate as fact, and labels an unsummarised brief as unsummarised.
15. **The version test can fail, and ignores a foreign project's tags.** Both directions proved in
    §B with tags created and deleted in the same command.
16. **The database size is the pragma, not `statSync`**, and matches the file byte for byte (§B/C1).
17. **`scope.cards: false` removes `cards_fts` from `lists` and removes a thread from the result
    set** — a control, not an envelope field.
18. **The `spawned` race window is handled** — `index` says `warming … fetching 46.1 MB, once` in
    the same run in which it spawns a child that has not yet taken the lock.
19. **`04-doctor.txt` is not stale**: regenerated against this build on a fresh demo corpus,
    byte-identical after the guard's own normalisation.
20. **No verb wrote outside its `--potsherd-dir`** during any run in this report except
    `potsherd_graft`, which wrote `./.potsherd/graft-<id8>.md` in a scratch project as documented.

---

## §E WHAT I COULD NOT CHECK, AND WHY

1. **`14-ask.txt` and `15-graft.txt`** — both need a live model backend, and the isolated `HOME`
   has no harness login (`claude --print` → `Not logged in`). Regenerating them would have required
   pointing the harness at the real home, which the isolation rules forbid.
2. **`05-doctor-privacy.txt`, `07-index.txt`, `16-before-after.txt`, `17-ls-cards.txt`** — each is
   captured by a `make-screens.sh` helper (`shot_in_project`, `shot_model`, or a multi-step
   sequence) that I could not reproduce faithfully enough for a byte comparison to mean anything;
   `17` additionally requires 39 model calls.
3. **That CI actually skips the version test** — I proved the *mechanism* (a tagless checkout
   reports the test as passed) and read `actions/checkout@v4` with no `fetch-depth`. I did not run
   a GitHub Actions job, so the CI half of C-10 is an inference from the workflow file.
4. **A genuine pid collision on the embed lock** — C-4's second measurement plants a live pid by
   hand. I did not wait for the OS to recycle a pid naturally; the code path is identical.
5. **`potsherd_recall` against an index with many cards** — the frozen archive holds 4 cards, so the
   routing lane was exercised on 4 rows and on title-only blocks, not at scale.
6. **The `--with` bridges** (`claude-mem`, `agentmemory`, `notes`) — not installed on this machine,
   and installing them is outside the isolation rules.
7. **`rescue` against a live sweep** — I ran it only on the synthetic demo corpus; running it
   against the real `~/.claude` would write.

---

## §F MY ONE ≤ 5-LINE CHANGE

Used to answer the question C-2 raises and §D cannot: *is the CLI's `citable` wrong on purpose, and
does anything test it?*

```diff
--- a/packages/cli/src/commands/find.ts
+++ b/packages/cli/src/commands/find.ts
@@ -1,4 +1,5 @@
 import {
+  hasTranscriptEvidence,
   projectName,
   recall,
   renderFind,
@@ -267,7 +268,7 @@ export async function runFind(o: FindCommandOptions): Promise<number> {
           lane: s.lane ?? 'evidence',
-          citable: (s.lane ?? 'evidence') === 'evidence',
+          citable: (s.lane ?? 'evidence') === 'evidence' && hasTranscriptEvidence(s.hits),
```
Two lines. `hasTranscriptEvidence` is already exported from `@potsherd/core`
(`packages/core/src/index.ts:174`) for exactly this question.

**Result.** The CLI now agrees with the MCP door:
```
AFTER FIX: summary-only S8 citable= False kinds= ['title','title','title']
```
**And the whole suite still passes** — the single failure is the vendored-bundle byte comparison,
which is the mechanical consequence of editing source without re-running `pnpm vendor`:
```
 FAIL tests/plugin-install.test.ts > the vendored bundles are byte-for-byte the bundles this build produces
 Test Files  1 failed | 52 passed (53)
      Tests  1 failed | 1931 passed (1932)
```
So **no test asserts `citable` on the `find` surface in either direction**: 1,931 tests pass with
`true` and 1,931 pass with `false`. The field is unmeasured on the door `find --help` points agents
at.

**Reverted.** `cp /tmp/find.ts.bak packages/cli/src/commands/find.ts && pnpm build`:
```
$ git status --porcelain
GIT_STATUS_LINES=0
$ git log --oneline -1
4fd221e phase 10: one source of truth for whether anything is embedding, …
$ npx vitest run tests/plugin-install.test.ts
      Tests  14 passed (14)
```

---

## §G ISOLATION, CONTROLS, DISK, PIDS

### The setup

The commit was cloned with `git clone --no-hardlinks` into a scratch directory; the working
checkout at `/Users/zebra/randomness/potsherd` was never modified and its `.git` was never fetched
into. All seven harness directories plus `~/.potsherd` were APFS-cloned (`cp -Rc`, copy-on-write)
into a scratch `HOME` **before any control string was invented**:

```
cloned .claude .codex .cursor .pi .gemini .copilot .potsherd
cloned opencode  (~/.local/share/opencode)
937M .claude · 566M .codex · 372M .gemini · 14M .cursor · 5.8M .pi · 12K .copilot · 997M .potsherd
```
Every command was run as:
```
env -u CLAUDE_CONFIG_DIR -u POTSHERD_DIR -u XDG_CONFIG_HOME -u NODE_PATH -u CODEX_HOME \
    -u ANTHROPIC_API_KEY HOME="$B/home" node …/packages/cli/bin/potsherd.js … --potsherd-dir "$B/pd"
```
The MCP server has no `--potsherd-dir`, so it was given `POTSHERD_DIR="$B/pd"` explicitly with the
same `HOME`. A second, smaller box (`box2`, 2→9 project directories, 22→744 exchanges) was used for
the four embedding states so that a full pass would finish in seconds rather than hours.

### Controls — invented after the freeze, and confirmed absent

`grep -ril <term> "$B/home"` over the frozen 2.9 GB tree, expecting 0 files:

| class | control | files |
|---|---|---:|
| nonsense | `xylophrantic bedduzzle qwomparil` | 0 / 0 / 0 |
| nonsense | `snerfwidget plaskonium thrumbex` | 0 / 0 / 0 |
| real English, absent | `espalier apple orchard rootstock pruning` | 0 (phrase); `espalier` 0, `rootstock` 0 |
| real English, absent | `underglaze slipware sgraffito` | 0 / 0 / 0 |

Rejected during selection because they were **present** in the frozen corpus, which is why the
screen was worth doing: `harpsichord` (5), `temperament` (45), `hoof` (91), `kiln` (81),
`porcelain` (178), `glaze` (21), `dressage` (2), `curling` (3), `bisque` (3). No control from any
previous round was reused, and the audit's own `zzzqqq flurblewomp aardvark protocol` was not used.

### Disk

```
before          /dev/disk3s1s1   199Gi   12Gi   5.6Gi   68%   /
peak (mid-run)  /dev/disk3s1s1   199Gi   12Gi   5.0Gi   71%   /
after cleanup   /dev/disk3s1s1   199Gi   12Gi   4.3Gi   74%   /
```
My peak footprint was 0.6 GiB — two scratch indexes (135 MB + 47 MB), the 46 MB embedding runtime,
the repo clone's `node_modules`, and the demo corpus; the harness clones are copy-on-write and cost
nothing. Everything I created was deleted (`rm -rf box box2 screens-live proj repo/node_modules`)
and the scratch tree is back to **71 MB** — the clone's source, my logs and the seam fixtures.

**Free space is nonetheless lower after cleanup than before it**, which is not mine: another agent
was working in this checkout at the same time (see the note below), and this is a shared machine.
I state the three readings rather than a delta I cannot attribute.

**One thing I did not create.** `docs/AGENT-AUDIT-2026-08-24.md` (21,522 bytes, mtime `24 Aug
23:52`) appeared as untracked in the working checkout *during* this run — `git status --porcelain`
was empty when I started. It is a re-audit written by another agent. I did not read it, did not use
it, and did not touch it; my scoring in §A is from my own measurements only. It is flagged here so
that nobody mistakes it for something this verification produced.

### Every pid, and the evidence it was mine

| pid | what | how I knew it was mine | outcome |
|---|---|---|---|
| `34118` | detached embedder, box2 | `ps` command line: `…potsherd.js index --quiet --potsherd-dir …/v5/box2/pd` | **exited on its own** (22 of 22 embedded); nothing signalled |
| `35252` | detached embedder, box2 | same command line, same scratch root | **exited on its own**; my `kill -9 35252` returned `no such process`, confirmed by `ps` |
| `36477` | `nohup sleep 400`, started by me one line earlier and captured as `$!` | `ps -p 36477` → `36477 sleep 400` | `kill 36477`; `ps -p 36477` → gone |
| `48195` | detached embedder, box2 | `ps` command line named `…/v5/box2/pd`, and `.lock.embed/owner.json` carried the same pid, written by the child itself | `kill -9 48195`; `ps -p 48195` → gone |

No name pattern was used, `killall` was never used, and no pid was signalled without first reading
its command line. Final sweep:
```
$ ps -eo pid,ppid,command | grep "[p]otsherd.js\|[b]ox2/pd\|[s]creens-live" | grep -v plugins/cache
  none
```

### Git safety

No `git fetch` of any kind was run. Two tags were created, both in my own independent clone, each
deleted in the same command (`v1.4.2` on a non-ancestor commit, `v9.9.9` on `HEAD`); `git tag --list
'v9*'` → `0` afterwards. The foreign-tag inventory at
`/Users/zebra/randomness/foreign-tags-2026-08-24.txt` was not needed — the clone already carried the
`upstream-v*` refs the test's docstring describes.

---

*Written by a verifier who authored none of it, on the real archive, at `4fd221e`. Every tree is as
it was found; the only file this run wrote inside the repository is this one.*

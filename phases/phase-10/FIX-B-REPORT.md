# FIX-B — the reliability and honesty defects

branch `work/FIX-B`, cut from `origin/main` at `82bb538`.
six commits, one per self-contained step. `pnpm test` 1863 passed / 53 files.
`pnpm typecheck` 0 errors across four packages. `scripts/check-privacy.py` **exit code 0**.

---

## D3 ★★★★ — every `index` spawns another detached embedder — **FIXED**

### what was actually wrong

Two things, and the second is why the first could not simply be deleted.

1. **`lock.isStale` declared a live owner stale after five minutes.** It confirmed the owning pid was
   alive on this host and then *fell through* to the lock directory's mtime anyway. A full embedding
   pass is hours; `STALE_MS` is five minutes. So from minute five onward every run removed the
   working embedder's lock and started another one beside it. The lock owner was overwritten by the
   newest one, exactly as the verifier described.
2. **The embed pass held the single `~/.potsherd/.lock` for its whole run.** That is why the mtime
   escape hatch existed: an honest lock in that lane would have blocked `potsherd index` for the
   entire warming window. The code chose to expire the lock instead, and the comment kept claiming a
   guarantee.

### the fix

- `packages/core/src/lock.ts` — a lock whose owner's pid is alive on this host is **never** stale.
  The mtime test survives only for the case it is the only answer to: an unreadable `owner.json`, or
  a lock written on another host.
- **Lanes.** `lock.acquire(op, { lane: 'embed' })` takes `.lock.embed`. `index`, `rescue` and
  everything else keep `.lock`. Two embedders still exclude each other; no foreground verb ever
  waits on one. Concurrency between an embedding worker and an `index` is handled where it already
  was — WAL plus `busy_timeout = 5000` in `db.ts` — and the embed pass writes one small row at a
  time between ~234 ms of wasm.
- `lock.holder({ root, lane })` — a pure read, no create, no wait. `startBackgroundEmbedding` asks it
  first and returns `false` when an embedder is already running, so the second and third `index` do
  not spawn at all.
- The comment on `runEmbedWorker` now describes what the code does, and names the test that fails if
  either half is undone.

### failing test first

`tests/embed-worker.test.ts`, 4 cases. Before the fix: **4 failed** —
`lock.holder is not a function`, and `expected '<lockpath>' not to be '<lockpath>'` for the lane
separation. After: 4 passed.

---

## D4 ★★★★ — the zero-model round trip aborts while vectors are warming — **FIXED**

### why I chose pinning, and what it costs

The freshness check was not wrong about the danger. It was comparing the wrong two things.

Three options were on the table. **Recording the vector state and comparing like with like** cannot
work on its own: you cannot un-embed an index, so there is no "like" to compare the second half
against. **Telling the user which flag makes it deterministic** would have shipped `--no-vec` on
both halves as the documented answer — turning off, by instruction, the retrieval that makes `ask`
worth running, on the phase whose product law is *the user never configures capability*. So:
**pin the shortlist into the recording**, which is the option that keeps the guarantee rather than
working around it.

The guarantee was: *answering from a stale file would print a live run's counts over recorded
content.* Pinning satisfies it by construction — the run reads exactly the sessions the recording
was made from and prints exactly the recording's counts, so the counts and the content belong to the
same run. Nothing live is printed over recorded content because nothing live is printed.

What is **not** relaxed: `filterAnswer` still checks every quote against the live transcript bytes at
the `(sessionId, seq)` it names. A pin cannot smuggle in a quote the archive no longer holds.

What still refuses: **a recorded session this index can no longer read.** That was always what the
check was about, and it is now the only thing it says.

The honest cost, stated: an answer replayed from a recording is an answer about the shortlist as it
was. If a better session was indexed in between, it is not in the answer. So the tool says so —
every replay prints what it answered over, and when the vector state moved between the halves it
prints both numbers and the words *re-record to ask the index as it is*. Nobody is sent to a flag.

### the fix

- `packages/core/src/ask.ts` — `AskOptions.pin { sessionIds, matching? }`. Inside `shortlist()` the
  pin replaces the derived **order**; the seqs an id earned from live recall are kept, so its
  excerpts are what a live run would have produced. `matching` comes from the recording.
- `packages/cli/src/commands/ask.ts` — `ReadersFile.index { vectorsEmbedded, vectorsTotal, matching }`,
  written at record time. **Deliberately no timestamp**: two recordings of one question over one
  index stay byte-identical, which is what makes a diff of two recordings a diff of the *index*
  (`tests/ask.test.ts` pins that, and the first version of this change broke it).
- All three legs are pinned, not just the first: `--readers-in`, `--readers-in --synthesis-out`, and
  `--filter-in`. `writeSynthesisFile` was worse than a refusal — it built the live shortlist and
  looked recorded outputs up against it by session id, so anything the shortlist no longer contained
  silently became `found: false` and the prompt came out thinner with nothing saying so.
- The `--readers-out` receipt now says plainly: *these k sessions are the shortlist; `--readers-in`
  reads exactly them, however much the index has embedded since.*

### failing test first

`tests/seam-warming.test.ts`, 8 cases. Before: **3 red**, the first with the verifier's message
verbatim —
`recorded shortlist does not match the shortlist this question produces now: 1 shortlisted session
it does not cover (d4d4d4d4), 1 session no longer shortlisted (c3c3c3c3)`.
The `--filter-in` case is red against the pre-pin build with the same message.
`tests/ask.test.ts`'s partial-match case is narrowed to the guarantee that survives and still
asserts zero spend.

---

## D2 ★★★★ — the `stats` vectors figure is 2.9× wrong — **FIXED**

`stats.ts` counted `COUNT(*) FROM vec_exchanges` for embedded and
`exchanges WHERE embedding_version IS NULL` for pending. `vec.ts` counts `exchanges` +
`ghost_prompts` against `!= EMBEDDING_VERSION`. Two errors, both printed: every recovered prompt was
missing from the denominator, and a vector left behind by an older model counted as done.

**The single source of truth is `packages/core/src/vec.ts`** — `vectorCounts()` does the counting and
`vecStatus(db, root)` is the one call. `packages/core/src/doctor-line.ts` owns the wording
(`vectorReport` / `vectorNote` / `warmingLine`). What reads it now: `index`, `doctor`, `stats`
(`FreshnessStats.vectorReport`, new) and `find` (D9). `render/stats.ts` renders through `vectorNote`
rather than composing its own sentence, so `hybrid search on` — a claim about a search that was still
warming — and `index --embed to build them` — an instruction from the release where vectors were
opt-in — are both gone.

**failing test first:** `tests/vectors-lazy.test.ts` *gives stats the same two numbers, ghost prompts
included* — red with `expected 0 to be 2`.

**the screens now agree:** `04-doctor.txt`, `07-index.txt` and `10-stats.txt` all read
`vectors — 0 of 3,410`. Regenerated only after the numbers agreed.

---

## D5 ★★★ — `index` says "not installed" for harnesses `doctor` calls installed — **FIXED**

Neither verb was lying about what it had looked at. The adapters, which `doctor` asks, test the
harness root **or** the transcript directory and have three answers — ready / empty / absent.
`index` set `HarnessReport.present` from `fs.existsSync(spec.sourceDir)` alone, and for gemini and
copilot the transcript directory is a *subdirectory* of the harness's own (`~/.gemini/tmp` inside
`~/.gemini`; `~/.copilot/session-state` inside `~/.copilot`). So the whole `empty` state — installed,
has written nothing yet — came out as the literal words `not installed`. On this machine both roots
exist and neither transcript directory does, which is exactly that state.

`paths.harnessInstalled()` is now the one predicate, beside the `harnessSourceDirs()` list it
complements, and `ingest.ts` sets `present` from it. The receipt gains the third state:
`installed · no transcripts in <dir>`.

The adapters' `doctorLine` wording is **untouched** — FIX-A owns the adapter labels this phase, and
the fix for two verbs disagreeing is not a third answer. The new predicate is deliberately the same
disjunction they already use, and the test asserts both sides of it together.

**failing test first:** `tests/harness-presence.test.ts`, 5 cases, **4 red** —
`paths.harnessInstalled is not a function` ×3, and
`expected '  gemini … not installed …' to contain 'installed'`.

---

## D6 ★★★★ — the privacy receipt's fifth false claim — **FIXED**

`~/.claude/projects` was listed under `reads (never modified)` while the model path caused
`~/.claude/projects/<slug>/memory/` to exist. `llm.ts` measured that, made the scratch cwd name fixed
so there would be one such directory rather than one per call, and documented it as *"litter in
someone else's directory"* — so the code knew and the receipt did not.

It is now listed under `writes:`, with the sentence that says who creates it (Claude Code, not
potsherd, because potsherd spawned it there), why there is exactly one however many calls (the fixed
cwd name), why it stays empty (`--no-session-persistence`, so nothing it creates can ever be indexed,
carded, ranked or shown in `ls`), and that potsherd never removes it. The `reads` heading points at
it rather than remaining true on a technicality.

Written out in `packages/cli/src/privacy-paths.ts` rather than imported, for that file's own stated
reason: `doctor` is on `OFFLINE_VERBS` and `llm.ts` is the module that opens sockets. The drift is
paid for by `tests/cli.test.ts`, which imports the real `CLAUDE_CWD_NAME` and asserts the receipt
against it.

On the pattern the verifier named — *CI proves the screen matches the program, never that the program
matches the truth* — this fix does not repair the pattern, only this instance of it. The one
structural improvement available here was to assert the receipt against a **constant the spawning
code uses**, rather than against a string in a screen, and that is what the test does.

**failing test first:** two cases in `tests/cli.test.ts`, both red.

---

## D9 ★ — `semantic search: warming (N of M embedded)` on `find` — **FIXED (first half)**

§A2 item 2 names the verb, and it was implemented on `index` and `doctor` and on no `find` at all.
`vecStatus().line` had exactly one consumer, and the test that covered it asserted the string builder
rather than a verb — which is precisely why a missing call site could not fail anything.

`find` now makes the same `vecStatus(db, root)` call on the connection the query ran on, and hands
the line to `renderFind` **above the last line**, because `05` says every verb ends with the next verb
and a status line is not a next verb. `--json` carries the same report as `semantic`.

It also supersedes `text search only — the words matched; index --embed adds semantic search`, which
sat one line above a status saying the embedding was already running, and whose instruction phase 10
made false. That wording lives in the reserved `recall.ts`; the decision about what reaches the
screen is made in `render/find.ts` (see **lines I owe you**).

**failing test first:** `tests/find-warming.test.ts`, 4 cases, **3 red**.

### the `ls` 53 / `stats` 55 half — **NOT FIXED**, and why

Diagnosed precisely, not fixed. Three different populations over one table:

| expression | file | counts |
|---|---|---|
| `COUNT(*) … WHERE 1=1 ${f.sql} ${ROLLUP} ${threadRollup}` **plus** `COUNT(*) FROM ghosts` | `packages/core/src/browse.ts:362-370, 401-406` | `ls`'s header total |
| `SUM(s.is_sidechain = 0) … GROUP BY s.harness` | `packages/core/src/stats.ts:157` | `stats.totals.sessions` |
| `SELECT COUNT(*) FROM sessions` | `packages/core/src/stats.ts:349` | `stats.freshness.indexed` |

`ls` folds fork/resume threads to their head (`threadRollup`, `browse.ts:179-192`) and adds ghost
rows; `stats` folds neither and keeps ghosts on their own row. The 2-session gap is the thread fold.
Both apply the ignore list, so that is not the cause.

I stopped rather than shipped it. The fix is to export the `ROLLUP + threadRollup + ignore` predicate
from `browse.ts` — which already owns both — and have `stats.ts:157` count through it; but
`totals.sessions` is summed from the **per-harness table**, so changing the total without changing
the table would make the total stop equalling the column above it, and changing the column changes
the per-harness screen and the `ignore.test.ts` fixtures. That is a counting-semantics change to two
verbs, and I did not have the budget left to validate its ripple to the standard the other five fixes
were held to. The invariant a fix should be pinned against is one line:

```
listSessions(db, filters).total === stats.totals.sessions + stats.totals.ghosts   // same filters
```

`browse.ts` should own the expression; `stats.ts` should call it.

---

## THE ARTIFACT

### D3 — `ps` before and after

Both runs: a synthetic 300-exchange archive under a relocated `HOME`
(`env -u CLAUDE_CONFIG_DIR -u POTSHERD_DIR -u XDG_CONFIG_HOME -u NODE_PATH HOME="$D"`), a fresh
`--potsherd-dir`, and the wasm runtime symlinked in so the pass is real and offline.

**BEFORE** — `packages/core/src/lock.ts` + `packages/cli/src/commands/index.ts` at `82bb538`:

```
--- ps before:  0
--- after run 1:
27870  00:03  0:12.11  node …/potsherd.js index --quiet --potsherd-dir /…/tmp.TjFxnTvRCR

--- run 2, seconds later, while the embedder holds the one .lock:
potsherd: another potsherd is running (pid 27870, embed, since 2026-08-24T01:27:21Z).
          if that is wrong, remove /…/tmp.TjFxnTvRCR/.lock

--- after another run (lock backdated 6 min):
27870  00:07  0:27.76  node …index --quiet --potsherd-dir /…/tmp.TjFxnTvRCR
27909  00:02  0:04.85  node …index --quiet --potsherd-dir /…/tmp.TjFxnTvRCR
--- after another run (lock backdated 6 min):
27870  00:10  0:31.93  node …index --quiet --potsherd-dir /…/tmp.TjFxnTvRCR
27909  00:05  0:09.47  node …index --quiet --potsherd-dir /…/tmp.TjFxnTvRCR
27928  00:02  0:03.42  node …index --quiet --potsherd-dir /…/tmp.TjFxnTvRCR
--- count: 3
```

One → two → three, all alive, all accumulating CPU — the verifier's finding reproduced. The lock
directory's mtime is set once at creation and never touched during the pass, so backdating it by six
minutes is exactly what the passage of time does; it is stated here because it is an accelerant, not
a different experiment. The second line is the *other* half of the old behaviour, and it needed no
accelerant: within the five minutes, `potsherd index` simply refused while the embedder ran.

**AFTER** — branch `work/FIX-B` at HEAD:

```
--- ps before:  0
--- after run 1:
27426  00:03  0:11.97  node …index --quiet --potsherd-dir /…/tmp.nqFNwFiskK
    run 2 embeddingInBackground: false | vectors: 52 of 300
    run 3 embeddingInBackground: false | vectors: 57 of 300
--- ps after 3 runs:
27426  00:05  0:22.22  node …index --quiet --potsherd-dir /…/tmp.nqFNwFiskK
--- count: 1
--- ps after kill: (count: 0)
```

One embedder across three runs, `index` never blocked, the vector count advancing under it. Every
process this task started was killed and `ps` confirms none is left.

### D4 — the seam round trip surviving a warming index

Same relocated `HOME`, same archive, the embedder left running between the halves:

```
--- vectors when the first half runs:
  vectors   129   warming 129 of 300 · bge-small, 384-d, wasm
--- shortlist recorded:
    01010101 00000000 02020202 03030303
    index at record time: {"vectorsEmbedded":147,"vectorsTotal":300,"matching":10}
--- host agent runs the readers (25 s of warming happens meanwhile)
--- vectors when the second half runs:
  vectors   300   bge-small, 384-d, wasm · every exchange
--- second half:
  1 synthesis prompt → /…/s.json
  built from 4 sessions of 4 read · 798 chars
    00000000  potsherd-bench  seq 3, 4, 5, 29, 30
    01010101  potsherd-bench  seq 7, 8, 9, 29, 30
    02020202  potsherd-bench  seq 7, 8, 9, 29, 30
    03030303  potsherd-bench  seq 11, 12, 13, 29, 30
  no model call was made (0). the prompt is redacted, as sent.
--- exit: 0
```

147 of 300 embedded when the shortlist was recorded, 300 of 300 when it was replayed — the vector
state demonstrably moved across the seam — and the round trip completed with zero model calls.

**One honesty note on this artifact.** I also ran the same script against the pre-D4 build and it
**passed**: a 10-to-12-session synthetic corpus is too homogeneous for the top-4 to reorder, so the
live "before" does not reproduce the refusal. The pre-fix failure is evidenced by the tests instead,
which reproduce the verifier's message verbatim on both `--readers-in` and `--filter-in`. I am
reporting that rather than presenting the "after" run as a before/after it is not.

---

## LINES I OWE YOU IN RESERVED FILES

**`packages/core/src/recall.ts`, around line 1755-1760.** The `vectors.reason` clause phase 10 made
false. `index` embeds by default now; `--embed` only moves the same work into the foreground, so a
line that tells the reader to run it is telling them to do something the tool has already started.
`render/find.ts` currently drops this clause whenever it has a warming line to print instead
(`supersededBySemantic`), which is a decision the renderer is entitled to make — but the wording
should be corrected at its source and the suppression then deleted.

```ts
        ? 'the words matched; semantic search adds to this as vectors land'
        : 'the words matched; --vectors on adds semantic search'
```

Only the first of the two changes. When it lands, delete `supersededBySemantic` from
`packages/core/src/render/find.ts` and the call in the `!result.vectors.used` branch, and add the
reason line back unconditionally.

Nothing else is owed. `packages/mcp/**`, `threads.ts`, `graft.ts`, `calibration.ts`, `keyphrase.ts`,
`notes.ts`, `windows.ts`, `link-suggest.ts`, `open-threads.ts`, `plugins/*/bin/**`, `evals/**` and
`README.md` are untouched.

---

## WHAT I COULD NOT FIX

1. **The `ls` / `stats` session count** (D9's second half). Diagnosed above with the three
   expressions, the owning module, and the one-line invariant. Not attempted, for the reason given.
2. **The pattern behind the privacy receipt.** Five false claims have now been fixed one at a time,
   and the reason is structural: the guard proves *screen == live output* and nothing proves *live
   output == truth*. D6's test asserts the receipt against a constant the spawning code uses rather
   than against a screen, which is the strongest available form here, but it is still one assertion
   per claim. A guard that enumerated every path any code in the repo creates — an `fs.mkdirSync` /
   `writeFileSync` census cross-checked against the receipt's list — is what would actually close
   the class, and it is a piece of work in its own right rather than part of this task.
3. **Concurrency between the embed worker and `index` is now genuinely concurrent.** Separate lanes
   were required to make the honest lock safe, and they hand SQLite two writers where it previously
   had one. WAL and `busy_timeout = 5000` cover it, the embed pass writes one small row at a time
   between roughly 234 ms of wasm, and the full suite is green on both drivers — but this is a change
   in the concurrency model and it deserves to be named rather than buried in a lock refactor.

---

## NUMBERS

- `pnpm test` last line: `Tests  1863 passed (1863)` — 53 files, 187.52 s.
- `pnpm typecheck`: **0** errors (core, bridges, cli, mcp all `Done`).
- `scripts/check-privacy.py`: **exit code 0**.
- `pnpm build && node scripts/vendor-plugin.mjs` run before every suite; `git status` clean.
- branch `work/FIX-B`, final SHA `5b62674` (this report), code at `9c0801e`.

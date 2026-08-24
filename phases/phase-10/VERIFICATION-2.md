# phase 10 — second independent verification (post-fix-round)

**Commit under test:** `9c663e9` (`main`), cloned to a private worktree at `/private/tmp/potsherd-p10-v2/repo`,
`pnpm install --frozen-lockfile && pnpm build` there. `git status --porcelain` in that worktree is empty at
the end of this run. Nothing in this document was authored by anyone who wrote phase 10, and I did not write
the first verification.

**Isolation.** Every harness directory (`.claude .codex .cursor .pi .gemini .copilot .local/share/opencode`)
was APFS-cloned (`cp -Rc`) into a scratch `HOME` at `/private/tmp/potsherd-p10-v2/home`. Every invocation ran as

```
env -u CLAUDE_CONFIG_DIR -u POTSHERD_DIR -u XDG_CONFIG_HOME -u NODE_PATH -u CODEX_HOME -u ANTHROPIC_API_KEY \
  HOME=/private/tmp/potsherd-p10-v2/home node …/packages/cli/bin/potsherd.js … --potsherd-dir …
```

No byte was written to the real `~/.claude`, `~/.codex`, `~/.cursor`, `~/.pi`, `~/.potsherd`. The corpus is
therefore **frozen** at the moment of the clone, which is what makes the controls below airtight.

**Fresh negative controls, invented after the freeze.** The audit's own `zzzqqq flurblewomp aardvark protocol`
is not a control — I confirmed again that it returns **three `strong` hits**. I invented these after cloning,
and confirmed absence by `grep -rl` over the frozen `HOME` and over the archive (0 files each):

- nonsense: `krunvexil bathorpe zindalquat`, and the planted-quote tokens `krunvexil` / `zindalquat`
- absent real-English topics: `lung packing apnea`, `sourdough hydration bulk ferment`,
  `tarantula molting substrate humidity`, `competitive freediving apnea training tables and lung packing`

**Corpus as this run measured it:** 55 sessions · 304 subagents · 299 ghosts · 2,971 recovered prompts ·
1,751 exchanges · **4,722 embeddable units** · 466 MB · nov 2025 → aug 2026. (The first verifier measured
4,699; the archive grew by a day.)

**Session ids, project names and transcript prose are labelled here, one-to-one.** `<f4-fixture>` is the
audit's own F4 fixture id8; `<thread-root>` its parent; `<sess-A>`/`<sess-B>` the two sessions I planted
quotes into. Real values are in the evidence directory, outside the repository.

---

## A. THE RE-SCORE

| row | 1st verifier | **mine** | gate | the command behind it |
|---|---:|---:|---|---|
| **Overall, as an agent-facing product** | 6 | **7** | **≥ 8 — FAIL** | the sum of B and C below |
| Concept & scope discipline | 9 | **9** | — | `potsherd --help`; `doctor --privacy`; docs read end to end |
| Archive capture | 9 | **9** | — | `rescue --no-settings -y` → 401 files / 466 MB / 299 ghosts / 2,971 prompts; `index` → 359 transcripts / 16.1 s / 7 harnesses |
| CLI ergonomics for a human | 7 | **8** | — | `doctor` ‖ `index` ‖ `stats` ‖ `find` in one minute — all four now `of 4,722`, counts monotonic (41→45→45→46). One disagreement left: `ls` 53 vs `stats` 55 |
| **Retrieval quality** | 7 | **7** | **≥ 7 — PASS** | `find` on 5 fresh controls → 3 honest empties, 2 `weak` leaks; `find` on real topics → `strong`; MCP `recall` → `noMatch: true` |
| **Reliability of a default install** | 6 | **8** | **≥ 8 — PASS** | 6 **concurrent** `index --quiet` → **1** embedder; `--readers-in` over a shortlist that provably drifted 5-of-6; `POTSHERD_OFFLINE` / `--no-embed` both suppress the fetch |
| **Agent ergonomics** | 6 | **7** | **≥ 8 — FAIL** | real MCP server: `potsherd_read {"thread":"<f4-fixture>"}` → `total 123`, `via:"core"`; citation filter drops 2 planted quotes; **but** `recall.capability` still names `--vectors on` |
| Re-entry | 7 | **8** | — | `graft <f4-fixture> --no-model` → 123 exchanges, 8/8 citations resolve, content-dated; `show` names the thread; `ls --json` names both threads with full link lists |

**GATE: FAIL.** Retrieval passes (7 ≥ 7). Reliability passes (8 ≥ 8). **Overall (7) and agent ergonomics (7)
do not.** Agent ergonomics is a close call and I say why in C1; I did not round it to the gate.

---

## B. THE NINE DEFECTS, RE-DERIVED

### GENUINELY FIXED — 6 of 9, three of them by tests stronger than the fix workers' own

**D1 ★★★★★ — fixed, and I drove the real server to prove it.**
`sh plugins/claude-code/bin/potsherd-mcp`, `initialize` + `notifications/initialized` + `tools/list` +
`tools/call`, over stdio, with `POTSHERD_DIR` pointed at my index:

```
stderr: potsherd-mcp 1.2.0 ready · 3 tools · index /private/tmp/potsherd-p10-v2/pd
tools:  potsherd_recall, potsherd_read, potsherd_graft

potsherd_read {"thread":"<f4-fixture>","from":1,"to":2}
  thread.via  = "core"          thread.note = null
  thread.links = [ {kind:"session", total:119, offset:1}, {kind:"session", total:4, offset:120} ]
  total = 123      hasMore = true   nextFrom = 3

potsherd_graft {"thread":"<f4-fixture>"}   →  exchanges = 123
```

`grep -c "session-only\|does not model fork" mcp-out.txt` → **0** over the whole server transcript. The two
tools now agree. `node -e "import(core/dist/index.js).then(m=>typeof m.resolveThread)"` → `function`;
`threadsAvailable` and `CORE_THREAD_RESOLVER` appear nowhere in `packages/` outside historical prose, so the
probe and its fallback are really deleted and `resolveThread` is a hard import — the build breaks if it goes.

I checked the half nobody asked for: **citations across the link boundary.** `from:120,to:123` cites only the
head (`… · 4 exchanges · 2026-08-20`); `from:118,to:121` cites **both** links. A model reading page 30 is
given the right session id for the words it is reading.

**D3 ★★★★☆ — fixed, and I ran the harder test.** The sequential test the fix worker ran (3 runs → 1 embedder)
is not the failure mode; the SessionEnd hook fires concurrently. So:

```
6 concurrent  potsherd index --quiet  &  … ; wait
$ ps -eo pid,etime,pcpu,cputime,command | grep 'potsherd.js index'
51970  11:24  248.5  38:21.96   … index --quiet --potsherd-dir …
count: 1
```

**One embedder, and it is the same pid started eleven minutes earlier** — i.e. a lock whose owner has been
alive far longer than the five-minute mtime threshold was **not** stolen by six racing processes. That is the
`lock.isStale` fix and the separate embed lane, both demonstrated at once. Four earlier sequential `index`
runs also produced 1. Every embedder I started is dead: `ps -eo command | grep -c 'potsherd.js index'` → 0.

*Not fixed, and not claimed:* the surviving embedder still burns 248–400 % CPU unattended (38 min of CPU in
11 min of wall) for the ~3.5 h to full hybrid, and there is no verb to stop it. The pile-up is gone; the
appetite is not.

**D4 ★★★★☆ — fixed. The fix worker's evidence was weak by its own admission; mine is not.**
The worker disclosed its live run passed pre-fix because its corpus could not reorder. So I **constructed the
reordering**: I recorded `--readers-out` for four semantic questions at ~520 vectors, let the embedder run to
~975, and re-recorded:

```
emb 521 -> 970 | gone 5  added 5 | order changed true
emb 526 -> 973 | gone 1  added 1 | order changed true
emb 519 -> 976 | gone 3  added 3 | order changed true
emb 523 -> 978 | gone 2  added 2 | order changed true
```

Then I replayed the **5-of-6-drifted** one. The pre-fix build aborts exactly here:

```
$ potsherd ask "<q>" --readers-in drift-out.json --synthesis-out drift-s.json
  answered over the 6 sessions recorded in drift-out.json, not the shortlist this question produces now
    semantic search moved in between: 521 of 4722 embedded then, 1005 of 4722 now — re-record to ask the index as it is
  1 synthesis prompt → drift-s.json
  no model call was made (0).
```

It answers over the recording and *discloses the drift with the recording's counts* — exactly the claim. All
three legs then completed with no model and no key: `--readers-out` → `--readers-in --synthesis-out` →
`--filter-in` → `ANSWER … [1] / EVIDENCE`. (My *first* round trip, on a keyword question, did **not** drift —
same weakness the worker reported. The drift test above is the one that carries the claim.)

**D7 ★★★☆☆ — fixed, and the refusal — the half that matters — still holds.**
One `--filter-in` run, three planted quotes, one command:

| quote | what it is | result |
|---|---|---|
| `user: <real-line-A>` | a real excerpt **copied exactly as the prompt prints it**, label and all | **survived**, cited `[1]` |
| `we agreed to route every pgbouncer pool through the krunvexil transaction shim before zindalquat batching` | **invented by me after the freeze**; `grep -rl` over the frozen corpus → 0 files | **dropped** |
| `<real-line-B> assistant: <real-line-C>` | a real span carrying an **interior** `assistant:` — a fabrication of contiguity | **dropped** |

```
  6 of 6 sessions read · 2 answered · 435ms
  2 sentences dropped · no citation that resolves
```

`unlabelQuote` is `/^\s*(?:user|assistant):[ \t]*/` — leading only, one only. The source comment says the
interior case "must keep failing", and it does.

**D2 / D5 / D9 ★★★★☆ — fixed.** One index, four verbs, one minute:

```
doctor : vectors 41  warming 41 of 4,722
index  : vectors 45  warming 45 of 4,722    semantic search: warming (45 of 4,722 embedded)
stats  : vectors 45  warming 45 of 4,722
find   :                                    semantic search: warming (46 of 4,722 embedded)
```

Same denominator, monotone counts, one wording, and **`find` prints the warming line at the place it runs** —
the A2 acceptance line the first verifier found unimplemented. `stats` no longer says "N pending · hybrid
search on". The published screens agree (`04-doctor` / `07-index` / `10-stats` all `0 of 3,410`; `09-find`
carries the warming line). `tests/vectors-lazy.test.ts:218` builds a fixture *with ghost prompts* and asserts
`sessionStats().freshness.vectors === vecStatus().report.embedded` — a test that would have caught D2.
D5: `index` now says `gemini 0 · installed · no transcripts in ~/.gemini/tmp` (and likewise opencode,
copilot) instead of "not installed", agreeing with `doctor`.

**D6 ★★★☆☆ — fixed at the line it was raised on.** `doctor --privacy` now carries, under `writes:`,
`~/.claude/projects/<slug of the scratch cwd, ending potsherd-llm-cwd>/` with who creates it, why it stays
empty, and that potsherd never removes it; the `reads (never modified)` block carries a forward-pointer to it.
I read every line of the receipt against the program — see C2 for what I found instead.

### FIXED IN PART

**D8 ★★☆☆☆ — the human view is fixed; `doctor --json` still carries one bit.**
Human view is now accurate and self-sufficient (the "see `doctor --json`" pointer is gone;
`copilot.ts:699` records removing it):

```
gemini   … unverified format
opencode … measured against opencode-ai 1.18.21 (T10.12, 24 aug 2026) … DISCOVERY AND SESSION
           METADATA ARE CORRECT: the store is at ~/.local/share/opencode/opencode.db …
copilot  … format WRONG, measured — a real Copilot CLI 1.0.80 session was run against this adapter …
```

But `doctor --json` still emits, for all three, exactly `"unverified": true` and nothing else — no
`provenance`, no `measured`, no `wrong`. `OPENCODE_FORMAT_UNVERIFIED`'s own docstring says "a caller wanting
more than one bit reads `OPENCODE_FORMAT_PROVENANCE`" — a source constant, not the API the same file calls
"the documented API". And `packages/cli/src/commands/doctor.ts:742` still reads *"All three are `unverified —
documentation only`: none was present with sessions on the machine they were written on"*, which is now flatly
false for two of the three. A string that has quietly become false, in the file that ships the field.

### NOT FIXED, AS THE ORCHESTRATOR DISCLOSED

**`ls` says 53 where `stats` says 55. Confirmed present, scored.** ★★☆☆☆

```
ls     :  53 sessions · 304 subagents inside them · 299 ghosts, prompts only
stats  :  55           304 subagents · 49 titled · 0 archived
stats table:  claude 48 + codex 1 + cursor 2 + pi 4  =  55
ls --json:  total 352 · threaded 2 · rolledUp 304
```

55 − 2 rolled-up thread members = 53. The footer counts *threads* and calls them *sessions*. The `--json`
surface is honest — it names `threaded: 2` and both rows carry a full `thread: {id, sessions[], head,
isHead, exchanges}` object — so this is one human string, not a broken model. It is the only number left
that disagrees with another number, and it is the reason CLI ergonomics is 8 and not 9.

### NEVER REAL

Nothing in the first verifier's nine was fabricated. Its "NOT REPRODUCED" note on 80-column wrapping holds
here too: measured in **code points** (not bytes — `·` and `…` are multi-byte and inflate a naive `awk`),
`doctor`, `doctor --privacy`, `stats`, `index`, `ls`, `audit`, `find`, `find` (no-match) and `ask --filter-in`
all max at **80**, `show` at 79, none over.

---

## C. NEW DEFECTS, RANKED

### C1 — `potsherd_recall` tells the model to pass a flag its own schema cannot express ★★★☆☆

This is the defect that keeps agent ergonomics at 7, and it is inside the last commit's own claimed scope.
`9c663e9`'s message: *"recall.ts stops telling a user to run a flag to get semantic search, because vectors
are no longer something you ask for."* It changed **one** of the two branches:

```
packages/core/src/recall.ts:1756-1759
  state.vectors === 0 || !state.available
    ? 'the words matched; semantic search adds to this as vectors land'   <- changed
    : 'the words matched; --vectors on adds semantic search';             <- untouched
```

The untouched branch is the one that fires on every machine that has any vectors. Live, from the **real MCP
server**, at 1,025 of 4,722 embedded:

```
potsherd_recall {"query":"<a keyword question>"}
  capability = "keyword search answered this one (the words matched; --vectors on adds semantic search)"
  vectors    = {"used":false,"available":true,"vectors":1025,"reason":"the words matched; --vectors on adds semantic search"}

tools/list → potsherd_recall inputSchema properties:  query, scope, want, budget
```

There is **no `vectors` parameter**. The model is told to reach for a control it does not have, in the field
whose entire job is capability honesty. The CLI human view suppresses the clause correctly (only the warming
line prints) — so this is visible *only* at the model door and in `find --json`, which is where nobody looked.
`packages/core/src/render/find.ts:229`'s comment still quotes the string as it was two commits ago.

Second half of the same field: on a no-match, `capability` reads `"keyword + semantic search · 1025 vectors"`
— a bare numerator, at **21.7 %** warm, with no denominator and no warming word. This is the first verifier's
D9 bullet ("audit item 9 — *tell me what you can't do, at the top* — is met on `index` and nowhere else")
still standing. `find`, `doctor`, `stats` and `index` all now print `N of 4,722`; the two-tool agent surface
does not.

*Why this holds the row at 7 rather than 8:* everything else at the agent door is strong and I verified it
(D1, D7, honest empty with an actionable instruction, `want`/`budget`/`scope` all forwarding, tool
descriptions now matching behaviour). But this is a live, model-facing, currently-false capability statement
in the exact species the brief names — a capability line that degrades politely — and it is in the scope the
commit under test claims to have closed.

### C2 — `ask --synthesis-out` writes transcript prose to a path the privacy receipt does not name ★★☆☆☆

I read every line of the receipt against the program. `writes:` names
`<the path you give to ask --readers-out>` and explains what it holds. It does **not** name
`--synthesis-out`, which writes a file containing verbatim redacted transcript quotes and real session ids:

```
$ potsherd ask "<q>" --readers-in … --synthesis-out drift-s.json
$ node -e '…' drift-s.json
  keys: kind,version,potsherd,question,k,sessionIds,system,schema,prompt,sessions,readers
  prompt bytes: 463 · contains verbatim `seq NN "user: …"` quotes and full session uuids
```

Same class as D6 exactly — an unlisted write of transcript content, on a flag the receipt's neighbour
documents. (`--filter-in` is read-only; verified.)

### C3 — the receipt names one of the two files `graft` drops into your repository ★☆☆☆☆

`writes:` names `<cwd>/.potsherd/graft-<id8>.md`. One `graft` in a checkout produced **two** files:

```
$ ls -a <cwd>/.potsherd
  .gitignore   graft-<f4-fixture>.md
```

The `.gitignore` is not named. It is benign and arguably the considerate thing to write — but the receipt's
premise is that it is exhaustive, and `--potsherd-dir` does not redirect it.

### C4 — `~/.claude/settings.json` is listed under `reads (never modified)` and under `writes only after y` ★☆☆☆☆

Both statements are in the same receipt, sixty lines apart. The second qualifies the first, so no reader is
actually deceived, but "never modified" is the wrong phrase for a file the next section describes potsherd
modifying.

### C5 — the "one source of truth" test's first case cannot fail ★☆☆☆☆

`tests/vectors-lazy.test.ts:161` is titled *"doctor and index read one source of truth"* and its body calls
`vecStatus(db, root)` **twice** and asserts the two results are equal — a pure function agreeing with itself.
Its comment says *"This is the call. Both verbs make it; neither computes anything else"*, which is the claim,
asserted in prose rather than in code. Neither `doctor` nor `index` is invoked. The **third** case in the same
file is real and does pin `stats` to `vecStatus`, and my live four-verb comparison confirms the behaviour — so
the fix is genuine and only this one assertion is decorative. Flagged because it is the shape the brief names.

### C6 — `--vectors on` costs recall during the warm window ★☆☆☆☆

At 1,072 of 4,722, on a keyword query: default (`auto`) → `5 sessions · strong · bm25 · 79ms`;
`--vectors on` → `3 sessions · strong · bm25 + vectors · 2.4s`. Turning the documented control **on** loses
two correct sessions and costs 30× the latency. `auto` exists for exactly this and is the default, so nothing
is broken — but it is the second reason the capability string in C1 should not be advertising the flag.

---

## D. CLAIMS I CHECKED THAT HELD

1. **`resolveThread` exists, is exported from the core barrel, and the probe is gone.** `typeof` → `function`;
   `threadsAvailable` / `CORE_THREAD_RESOLVER` have no definition anywhere in `packages/`.
2. **`potsherd_read`'s tool description is now true.** *"It reads a THREAD: the whole fork/resume chain, in
   order, a page at a time."* It does, for the audit's own fixture.
3. **The MCP shim header is honest.** `bin/potsherd-mcp` says *"Its three tools all read the index"* and names
   `potsherd_recall, potsherd_read, potsherd_graft` — matching `tools/list`. (D9's first bullet.)
4. **The honest empty, at the agent door.** `potsherd_recall` on my invented nonsense: `noMatch: true`,
   `confidence: "none"`, **0 hits**, `belowFloor: 20`, and *"The archive does not contain this … Say so — do
   not widen into a guess, and do not answer from the repository in front of you."*
5. **`find` returns an honest empty on invented strings** — `no match`, zero rows, a reason, and
   `--min-confidence none` as the escape hatch; and `strong` with the right sessions on real topics.
6. **The written-down control is still not a control** — the audit's own nonsense string returns three
   `strong` hits. Independent confirmation the scorer discriminates rather than failing open.
7. **`POTSHERD_OFFLINE=1` really suppresses the 46.1 MB fetch.** A clean `--potsherd-dir`: `models/` created
   and **0 B**, line reads `semantic search: warming (0 of 1,751 embedded) — offline`.
8. **`index --no-embed` really suppresses it.** `vectors — not this run (--no-embed)`; no `models/` at all.
9. **`--vectors off`, `--no-vec`, `--vectors on` all reach the library.** `bm25` / `bm25` / `bm25 + vectors`,
   6 ms / 5 ms / 2.4 s. Not registered-and-dropped.
10. **`potsherd_recall`'s `budget` is scoped exactly as its schema says** — no effect under `want:"hits"`
    (11,843 vs 11,842 bytes at budget 200 vs 9000), 5,191 → 35,699 bytes under `want:"context"`. I initially
    scored this as a dropped parameter and was wrong: the schema says `want: "context" only`.
    `potsherd_graft`'s `budget` forwards too (2,893 → 3,675 bytes at 300 vs 4000).
11. **`ask` completes with no SDK and no API key**, all three legs, each printing `no model call was made (0)`.
12. **Threads are real in `graft`.** `graft <f4-fixture> --no-model` → 123 exchanges, `citations 8/8 distinct,
    and all resolve`, dated `2026-08-20` by content, not by fork point.
13. **`show` names the thread beside the file** — `4 exchanges` then
    `thread  123 exchanges across 2 sessions  · potsherd graft <f4-fixture>`. The F4 stub is signposted.
14. **`ls --json` names the threads it rolled up** — `threaded: 2`, and each of the two rows carries a full
    `thread` object with `sessions[]`, `head` and `exchanges`. Only the human footer is wrong (see B).
15. **80 columns hold** on nine surfaces, measured in code points.
16. **`pnpm vendor` produces no diff** — `git status --porcelain` empty after it.
17. **The evals alarm can fire.** `pnpm evals -- --vector-weight 0` exits **1**, prints
    `FAIL — the amended phase-3 gate would not merge this fusion`, and names 87 lost queries.
18. **The privacy receipt's model-path account is internally consistent now** — the empty
    `…potsherd-llm-cwd/` directory is under `writes:`, and the *"its session is never written to
    `~/.claude/projects`"* sentence is defensible against it (no transcript, only the directory).

---

## E. WHAT I COULD NOT CHECK

1. **A1 rung 2 — `claude -p` / `codex exec` end to end.** The subscription credential does not follow a
   relocated `HOME`, and exercising it against the real `HOME` would create the `…potsherd-llm-cwd/`
   directory I am forbidden to write. Every model rung here is the recorded round trip, not a live call.
2. **A1 rung 3 — the agent SDK / API key path.** No SDK installed, no key available.
3. **`card`, and the card-only `citation: null` path.** Cards need a model backend; this index holds none.
4. **Whether D4's third leg specifically fixed `writeSynthesisFile` turning *dropped* sessions into
   `found:false`.** My reader files carried explicit `found:false` for the sessions I did not answer from, so
   dropped and declined are indistinguishable in my evidence. The other two legs I pinned directly.
5. **Codex / gemini / opencode / copilot parsers against live sessions.** Those harnesses have no session
   data in this corpus. I verified their *labels* and their *presence detection*, not their parsing.
6. **CI, the tag and the published tarball.** Not re-run by me; the workflow's doctor-screen guard I read and
   it can fail (it greps the shipped version and schema, not a fixed string).
7. **Whether the single embedder eventually completes cleanly.** ~3.5 h at this rate; I killed it at 1,100 of
   4,722. Everything I measured about warming is therefore inside the warm window, which is the state a new
   user has and the one the phase was scored on.

---

## F. THE ONE ≤ 5-LINE CHANGE

**None used.** `git status --porcelain` in the verification worktree is empty. Nothing was fixed, committed or
pushed. The only file I wrote into the orchestrator's tree is this one.

---

## G. SUITE RESULTS (all on `9c663e9`, in the verification worktree)

| command | **exit code** | result |
|---|---:|---|
| `pnpm test` | **0** | 53 files, **1,875 passed** |
| `pnpm typecheck` | **0** | all four packages |
| `python3 scripts/check-privacy.py` | **0** | 578 tracked text files swept; id inventory 184 distinct, 165 accounted, unaccounted at its pinned ceiling *(finding elided)* |
| `pnpm evals` | **0** | hybrid PASS — recall@5 51/60, recall@1 27/60, ✓ over both single-signal baselines; six confidence controls `ok` |
| `pnpm evals -- --vector-weight 0` | **1** | FAIL, names 87 lost queries — the alarm fires |
| `pnpm vendor` | **0** | no working-tree diff |

---

## H. EVIDENCE

`/private/tmp/potsherd-p10-v2/`

`repo/` (the worktree at `9c663e9`), `home/` (the frozen harness clone), `pd/` (the index),
`install.txt`, `rescue.txt`, `index-1.txt`, `privacy-receipt.txt`, `mcp-out.txt`, `mcp-out2.txt`,
`mcp-drive.sh`, `ps.sh`, `w.mjs`, `pnpm-test.txt`, `typecheck.txt`, `privacy.txt`, `evals.txt`,
`evals-vw0.txt`, `vendor.txt`, and the round-trip payloads `r1.json`, `r1-out.json`, `r2.json`, `s1.json`,
`s1-reply.json`, `drift-*.json`, `now-drift-*.json`, `drift-out.json`, `drift-s.json`, `drift-reply.json`.
The payloads carry raw transcript text and real ids and are deliberately **outside** the repository.

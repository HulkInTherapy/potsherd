# phase 10 — independent verification

**Commit under test:** `03fbba0` (`main`), cloned to a private worktree; `pnpm install --frozen-lockfile && pnpm build` there. Nothing in this document was authored by anyone who wrote phase 10.

**Isolation.** Every harness directory (`.claude .codex .cursor .pi .gemini .copilot .local/share/opencode`) was APFS-cloned (`cp -Rc`) into a scratch `HOME`; every invocation ran as
`env -u CLAUDE_CONFIG_DIR -u POTSHERD_DIR -u XDG_CONFIG_HOME -u NODE_PATH -u CODEX_HOME -u ANTHROPIC_API_KEY HOME="$D" … --potsherd-dir "$P"`.
No byte was written to the real `~/.claude`, `~/.codex`, `~/.cursor`, `~/.pi`, `~/.potsherd`. The corpus is therefore **frozen** at the moment of the clone — which is what makes the negative controls below airtight.

**Fresh negative controls.** The audit's own `zzzqqq flurblewomp aardvark protocol` is no longer a control: it is in the corpus, and `find` returns three **strong** hits for it. I invented two strings *after* the corpus was frozen, so they cannot be in it, and confirmed absence by `grep -ric` over the frozen tree:
- nonsense: `plizzarkt vunthrome qexxil`
- absent topic (real English, absent subject): `hydroponic tilapia aquaponics greenhouse nutrient dosing`

**Corpus:** 55 sessions · 300 subagents · 299 ghosts · 2,971 recovered prompts · 1,728 exchanges · 4,699 embeddable units · 463 MB · nov 2025 → aug 2026.

---

## A. THE RE-SCORE

| row | was | now | gate | the command |
|---|---:|---:|---|---|
| **Overall, as an agent-facing product** | 4 | **6** | **≥ 8 — FAIL** | the sum of D1–D8 below |
| Concept & scope discipline | 9 | **9** | — | `potsherd --help`; docs read end to end |
| Archive capture | 9 | **9** | — | `rescue --no-settings -y` → 299 ghosts / 2,971 prompts in 5.9 s; `index` → 355 transcripts / 20.5 s |
| CLI ergonomics for a human | 8 | **7** | — | `stats` vs `doctor` vs `index` vs `ls` — four printed numbers that disagree (D2, D5, D8) |
| **Retrieval quality** | 3 | **7** | **≥ 7 — PASS** | `find` on both fresh controls → zero rows; on a real topic → `strong` |
| **Reliability of a default install** | 2 | **6** | **≥ 8 — FAIL** | D1, D3, D4 |
| **Agent ergonomics** | 3 | **6** | **≥ 8 — FAIL** | D1, D6, D7 |
| Re-entry | 5 | **7** | — | `graft <child id8>` → whole chain, 123 exchanges, content-dated |

**GATE: FAIL.** Retrieval passes. Overall, reliability and agent ergonomics do not.

---

## B. DEFECTS, RANKED

### D1 — `potsherd_read` cannot see a thread, and tells the model this build has no thread model ★★★★★

The MCP thread resolver probes a core export that does not exist:

```
packages/mcp/src/tools/thread.ts:37   export const CORE_THREAD_RESOLVER = 'resolveThread';
$ node -e "import('…/packages/core/dist/index.js').then(m=>console.log(typeof m.resolveThread))"
undefined
```

So `coreResolver()` returns `null` on every call, `via` is always `session-only`, and the note at `thread.ts:179` always fires. Against the audit's own F4 fixture:

```
tools/call potsherd_read {"thread":"<f4-fixture>","from":1,"to":2}
  "via": "session-only",
  "note": "this build of potsherd does not model fork/resume chains yet, so this thread is
           the one session you named…",
  "total": 4,  "hasMore": true,  "nextFrom": 3
```

The same server, same second, same id:

```
tools/call potsherd_graft {"thread":"<f4-fixture>"}   →  "exchanges": 123
CLI: potsherd graft <f4-fixture> --no-model           →  123 exchanges across 2 sessions of one thread
```

Two tools in one server contradict each other about whether v1.2.0 models chains. `potsherd_read` is one of the archaeologist's **only two** tools, and its own agent file says it exists so "the windowing subagent never needs filesystem `Read`". The audit's headline failure — *the session I was in yesterday indexes as 4 exchanges* — reproduces verbatim at the model-facing door, in the release that claims F4 closed.

### D2 — `stats` prints a vectors figure 2.9× wrong, and "hybrid search on" at 3 % warm ★★★★☆

One index, three verbs, same minute:

```
doctor :  vectors  142   warming 142 of 4,699
index  :  vectors  143   warming 143 of 4,699
stats  :  vectors  142   bge-small · 1,586 pending · hybrid search on
```

`doctor`/`index`/`find` use `vectorCounts()` (`vec.ts:484`) which counts `exchanges` **+ `ghost_prompts`** = 4,699. `stats.ts:332` runs its own `SELECT COUNT(*) … FROM exchanges WHERE embedding_version IS NULL` = 1,728 − 142. It omits all 2,971 ghost prompts: **4,557 units remain, `stats` says 1,586.**

The phase acceptance is explicit — *"`doctor` and `index` report vectors from one source of truth (a test pins their agreement)"*. The test pins `doctor`↔`index` and leaves `stats` outside. It is committed to the repository's own published screens:

```
docs/screens/04-doctor.txt:17   vectors — 0 of 3,410
docs/screens/07-index.txt:14    vectors — 0 of 3,410
docs/screens/10-stats.txt:12    vectors 0  bge-small · 439 pending · index --embed to…
```

The CI guard proves *screen == live output* and is green, because both screens faithfully reproduce what the program prints. The comment directly above the offending line (`render/stats.ts:83-87`) describes this exact failure as the thing being fixed. `hybrid search on` also fires on `vectors > 0`, so it read "hybrid search on" at 142 of 4,699.

### D3 — every `index` spawns another detached embedder; they accumulate and race ★★★★☆

`startBackgroundEmbedding` (`cli/src/commands/index.ts:243`) is documented as safe: *"holds the lock so two of them never race."* Measured:

```
before:            2 embedders
$ potsherd index   →  "semantic search: warming (516 of 4,699 embedded) — in the background"
after index #1:    3 embedders
$ potsherd index   →  "another potsherd is running (pid 70390, embed …)"
after index #2:    3 embedders

PID    ELAPSED  %CPU   CPUTIME        …25 s later…
50611  21:29    125.9  32:58.22       50611  21:54  104.3  33:28.55
57145  15:54    124.5  24:15.82       57145  16:19  106.6  24:46.42
70390  00:26    124.5   0:29.81       70390  00:51  101.3   1:01.25
```

All three accumulate CPU time — they are all embedding, not waiting. The lock owner file is simply overwritten each time. ~315 % CPU, unattended. `doctor --privacy` records that the plugin's SessionEnd hook runs `index --quiet`, so on a real machine this compounds once per session ended.

### D4 — the zero-model round trip aborts while vectors warm — i.e. for the first ~3.6 h ★★★★☆

Measured warm rate on this archive: 564 of 4,699 in ~26 min (with up to three embedders) ≈ **3.6 hours to full hybrid**, CPU pegged throughout. During that window the shortlist moves between the two halves of the seam, and `--readers-in` refuses:

```
$ potsherd ask "…" --readers-out r3.json      # seconds later:
$ potsherd ask "…" --readers-in  r3.json --synthesis-out s3.json
potsherd: r3.json's recorded shortlist does not match the shortlist this question produces now:
  1 shortlisted session it does not cover (…), 1 session no longer shortlisted (…)
```

Reproduced on three of four attempts with a gap of seconds; a host agent actually running six reader prompts takes minutes. The guard is right in principle, but the flagship *"potsherd never needs model access at all"* path is unusable on a freshly-indexed machine — the only state a new user has. `--no-vec` on **both** halves is a stable workaround; nothing tells the agent that.

Two smaller faults in the same seam:
- the on-screen instruction is *"add an `outputs` array to the file"*; the first attempt fails with `outputs[0] has no "sessionId"`.
- the error's suggested fix for a stale `--filter-in` file is `--readers-out <that same synthesis file>`, which would overwrite the synthesis file and discard the work.
- one diff list printed a duplicate id: `3 shortlisted sessions it does not cover (<sess-1> <sess-2> <sess-2>)`.

### D5 — `index` calls installed harnesses "not installed"; `doctor` says the opposite ★★★☆☆

```
doctor:  gemini    empty  ~/.gemini/tmp             Gemini CLI installed, no tmp/ yet …
         copilot   empty  ~/.copilot/session-state  Copilot CLI installed, but it has written no …
index :  gemini    0      not installed — ~/.gemini/tmp
         copilot   0      not installed — ~/.copilot/session-state
```

`ingest.ts:866` sets `present = fs.existsSync(sourceDir)` against the *session sub-directory*; the adapters check the *harness root*. Both harnesses are installed here (`~/.gemini/GEMINI.md`, `~/.copilot/config.json` + `logs/` exist). Same audit-F9 class the phase claimed to close for vectors, left open for harnesses.

### D6 — the privacy receipt still lists a directory potsherd writes into as "never modified" ★★★☆☆

`doctor --privacy` opens with `reads (never modified): ~/.claude/projects`, and states of the model path *"its session is never written to `~/.claude/projects`"*. `llm.ts:1667-1700` documents the truth in its own words: `--no-session-persistence` suppresses the transcript, but *"what survives is an **empty** `projects/<slug>/memory/` directory"* — *"litter in someone else's directory"*. It is on the real machine:

```
$ ls -R ~/.claude/projects/*potsherd-llm-cwd*/
memory
```

(`potsherd-llm-cwd` is `CLAUDE_CWD_NAME`, `llm.ts:1701`.) The `writes:` section does not list it, and it happens with no consent prompt. That is the fifth false claim this receipt has carried. Everything else in the receipt I checked held (see C).

### D7 — the synthesis prompt hands the model quotes its own filter will reject ★★★☆☆

Reader excerpts carry a speaker prefix (`user: …`). The synthesis prompt reprints them and ends *"Copy each quote exactly as printed."* A quote copied exactly as printed is then dropped:

```
evidence[1].quote = "user: TASK  T10.4 — semantic search always on, …"
→  no grounded answer in 6 sessions searched
   every sentence was dropped for want of a citation that resolves (2).

same run, prefix removed:
→  ANSWER … [1]      EVIDENCE  [1] …/<sess-3>  23 aug 23:13  subagent
   1 sentence dropped · no citation that resolves
```

The matcher already normalises whitespace (`TASK  T10.4` matched `TASK T10.4`), so it is one rule short. The failure is silent and indistinguishable from hallucination, which is the one thing the receipt exists to distinguish.

### D8 — the adapter labels are half-applied, and `--json` contradicts the human view ★★☆☆☆

`T10.12-LABELS.md §6` rules: opencode *"content **verified wrong**"*, copilot *"format **verified wrong**"*, gemini *"`unverified` STAYS"*. `03fbba0` relabels **copilot only**. On `03fbba0`:

- `OPENCODE_DOCTOR_NOTE` still reads *"this adapter was written from documentation, **not from a real store**"* — after a real end-to-end opencode 1.18.21 session was run against it.
- `COPILOT_FORMAT_UNVERIFIED = true` and `OPENCODE_FORMAT_UNVERIFIED = true` are unchanged, so `doctor --json` reports `"unverified": true` for both. The human line for copilot now says *"format known wrong — **see `doctor --json`**"* — and `doctor --json` says `unverified`, with no field for *wrong*. The pointer contradicts its target.
- `doctor.ts:724`'s comment still reads *"All three are `unverified — documentation only`"*.

The commit message for `2461f33` names *"five places including `doctor --json`"*; `doctor --json` was not one of the places changed.

### D9 — smaller ★☆☆☆☆

- `ls` footer prints `53 sessions`; `stats` prints `55`. `ls --json` shows `threaded: 2` — the footer counts threads and calls them sessions.
- `potsherd_recall`'s `capability` field told the agent *"keyword + semantic search · 216 vectors"* at 4.6 % embedded, with no warming disclosure. Audit item 9 (*"tell me what you can't do, at the top"*) is met on `index` and nowhere else.
- `plugins/claude-code/bin/potsherd-mcp` header still says *"Its six tools all read the index"* and *"five `mcp__…` entries"*. There are three.
- **The A2 acceptance line is not implemented.** *"while pending, every `find` prints one line: `semantic search: warming (N of M embedded)`"*. `vecStatus().line` is consumed at exactly one call site, `cli/src/commands/index.ts:440`. `find`, `ls` and `ask` never print it (`potsherd find … | grep -i warm` → nothing, at 217/4,699). `tests/vectors-lazy.test.ts:176` asserts the *string builder* returns the sentence — an artefact verified somewhere other than where it runs.

### FIXED ON `95a6245`, found independently
`show <child id8>` at `03fbba0` prints `4 exchanges` with no hint that 119 more live one hop away — close to the audit's own F4 wording. The orchestrator reports this fixed one commit ahead; scored as fixed.

### NOT REPRODUCED
`show` prose wrapping past 80 columns. 10 sessions, 38,488 lines of `show` output, **max width 79, zero lines over 80**. Also checked `ls`, `doctor`, `stats`, `audit`, `doctor --privacy`: max 80, none over.

---

## C. CLAIMS I CHECKED THAT HELD

1. **`find` returns an honest empty on an absent topic, on the real archive.** Both fresh controls → `no match`, **zero rows**, with a reason and a `--min-confidence none` escape hatch.
2. **`find` returns `strong` on a topic the archive contains**, with the correct sessions in the top rows.
3. **The written-down control is no longer a control** — the audit's own nonsense string returns three **strong** hits, exactly the trap warned about. Independent confirmation that scoring is now discriminative rather than that it fails open.
4. **`ask` completes with no SDK and no API key.** `node_modules/@anthropic-ai` absent; `ANTHROPIC_API_KEY` unset. `--readers-out` → `--readers-in --synthesis-out` → `--filter-in`, all four printing `no model call was made (0)`.
5. **The citation filter drops an invented quote and the sentence citing it.** A quote never typed on this machine was planted in the reader output, carried through the synthesis prompt, and cited. Result: `1 sentence dropped · no citation that resolves`; the real-quote sentence survived with its `EVIDENCE` line. That is the product's central claim and it holds.
6. **Discontiguous relevance windows.** `--readers-out` reported `seq 35, 36, 40, 41, 54, 55, 61, 62, 69, 70 · 5 windows of 70`. F5 delivered.
7. **`--windows`, `--no-cards`, `--min-confidence` and all four `note` flags reach the library.** `--no-cards` → `"cards": false`; `--min-confidence none` → 9 rows labelled `none`; `--windows 1` changed the selection; `note --decided --open --next --by` round-tripped into an append-only lane with `citable: false`.
8. **Threads are real in `graft`.** `graft <child id8>` → 123 exchanges across 2 sessions of one thread, `citations 8/8 distinct, and all resolve`, dated `2026-08-20` by content.
9. **One date, and it is the content date.** `show` → `20 aug 23:26`; `find`/`ls` rows carry one date each; no fork-point date anywhere.
10. **The real MCP server, driven the way the docs drive it** (`sh plugins/claude-code/bin/potsherd-mcp`, initialize + tools/list) — `3 tools`, disjoint, `potsherd-mcp 1.2.0 ready · 3 tools`.
11. **MCP `recall` returns an explicit empty with an instruction the model can act on:** `"noMatch": true` … *"Say so — do not widen into a guess, and do not answer from the repository in front of you."* F1 and F3 at the agent door.
12. **`Read` is gone from `session-archaeologist.md`.** `tools:` is `potsherd_recall, potsherd_read` and nothing else.
13. **`--json` parity.** `projectName` (short) beside `project` (path), `title` and `displayTitle` on every row. F9's first bullet closed.
14. **Vectors with no flag typed.** A clean `--potsherd-dir` + `index` fetched 46.1 MB of WASM runtime + quantized bge-small from `cdn.jsdelivr.net` and `huggingface.co` into `<potsherd-dir>/models`, in the background, printing one line. `find` then reported `bm25 + vectors` / `"used": true` with no flag ever typed. The receipt's *"pinned to a size and a sha256 … checked before it is kept"* is true (`embeddings.ts:351-368`).
15. **`pnpm evals` exits 0, and the alarm fires.** `pnpm evals -- --vector-weight 0` exits **1**, prints `FAIL — the amended phase-3 gate would not merge this fusion`, and names the lost queries against `evals/per-query-baseline.json`.
16. **`pnpm vendor` produces no diff** — the committed `plugins/claude-code/dist` matches a fresh build of the packages.
17. **The 677 MB dependency appears nowhere in the README or in any program output** — only in code comments and in the audit document itself.
18. **`--embed`'s help string is correct** (`embed in the foreground rather than in the background` / `--no-embed  text only`).
19. **80 columns hold** across `show`, `ls`, `doctor`, `stats`, `audit`, `doctor --privacy` — see NOT REPRODUCED.
20. **`graft` self-ignores** and the model rung fails soft: with no login it printed `no model call — the model call failed (claude --print could not answer: …)` and returned the unsummarised brief rather than erroring.

---

## D. WHAT I COULD NOT CHECK

1. **A1 rung 2 — `claude -p` / `codex exec` end to end.** The subscription credential does not follow a relocated `HOME` (`Not logged in · Please run /login`), and running it against the real `HOME` would create `~/.claude/projects/…potsherd-llm-cwd/`, which I am forbidden to do. Rung 2 is therefore **unverified by me**; note that D6's evidence proves it *has* run on this machine.
2. **A1 rung 3 — the agent SDK / API key path.** No SDK installed, no key available.
3. **`card`, and F6's "a card-only thread gets `citation: null`".** Cards need a model backend; the index holds **0 cards** (`SELECT COUNT(*) FROM cards` → 0), so no card-only hit can exist here. The code path is present and correct by inspection (`mcp/src/tools/recall.ts:307-322`, `lane === 'routing' → citation: null`), but it was **not exercised live**.
4. **Whether the three concurrent embedders duplicate work or partition it.** I measured that all three burn CPU; I did not instrument which rows each claims.
5. **Codex/gemini/opencode/copilot adapters against live sessions.** Those harnesses have no session data on this machine; I verified the *labels*, not the parsers.
6. **CI, the tag, and the published tarball.** Reported green by the orchestrator; not re-run by me.
7. **T10.13** (open-thread and `link --suggest` precision) — not in this commit, not scored.

---

## E. THE ONE ≤5-LINE CHANGE

**None.** `git status --porcelain` in the verification worktree is empty. Nothing was fixed, committed or pushed.

---

## F. SUITE RESULTS (all on `03fbba0`, in the verification worktree)

| command | exit | result |
|---|---:|---|
| `pnpm test` | **0** | 49 files, **1,837 passed**, 171.4 s |
| `pnpm typecheck` | **0** | all four packages |
| `python3 scripts/check-privacy.py` | **0** | 569 files swept; 19 unaccounted id-shaped tokens against a ceiling of 19 *(finding elided)* |
| `pnpm evals` | **0** | hybrid PASS at recall@5 51/60, recall@1 27/60; six confidence controls `ok` |
| `pnpm evals -- --vector-weight 0` | **1** | FAIL, names the lost queries — the alarm can fire |
| `pnpm vendor` | **0** | no working-tree diff |

---

## G. EVIDENCE

`/private/tmp/potsherd-p10-verify/`

Raw output for every command above: `pnpm-test.txt`, `typecheck.txt`, `privacy.txt`, `evals.txt`, `evals-vw0.txt`, `vendor.txt`, `index-1.txt`, `privacy-receipt.txt`, `embedders-1.txt`, `show-all.txt`, `w-*.txt` (column measurements), and the four `--readers-out` / `--synthesis-out` payloads (`readers.json`, `r2/r3/r4.json`, `s4.json`). The payloads carry raw transcript text and real ids and are deliberately **outside** the repository.

*(Session ids in this document are placeholders. The repository's own `check-privacy.py` refuses even an eight-character prefix of a real id, so the ids are named `<f4-fixture>`, `<sess-1..3>`; the substitution is one-to-one. The real ids are in the evidence directory, which is outside the repository.)*

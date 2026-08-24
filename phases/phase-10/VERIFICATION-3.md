# phase 10 — third independent verification (second post-fix re-score)

**Commit under test:** `339df63` (`main`), cloned twice to private directories under
`…/scratchpad/v3/` (`potsherd/` for the work, `pristine/` for a never-touched suite run);
`pnpm install --frozen-lockfile && pnpm build` in both. `git status --porcelain` is empty in both
clones and in the orchestrator's own tree at the end of this run. I wrote none of phase 10 and
neither of the two previous verifications. I read both of them before starting and treated every
line of both as a hypothesis.

**Isolation.** `.claude .codex .cursor .pi .gemini .copilot .local/share/opencode` were APFS-cloned
(`cp -Rc`) into a scratch `HOME`. Every invocation ran as

```
env -u CLAUDE_CONFIG_DIR -u POTSHERD_DIR -u XDG_CONFIG_HOME -u NODE_PATH -u CODEX_HOME \
    -u ANTHROPIC_API_KEY HOME="$B/home" node …/packages/cli/bin/potsherd.js … --potsherd-dir "$B/pd"
```

No byte was written to the real `~/.claude`, `~/.codex`, `~/.cursor`, `~/.pi`, `~/.potsherd`. The
corpus is **frozen** at the moment of the clone, which is what makes the controls below airtight.

**Fresh negative controls, invented after the freeze.** I did not reuse either previous verifier's
strings, and I did not use the audit's own (which is in the corpus and still returns `strong`).
Invented after cloning and confirmed absent by `grep -ril` over the frozen `HOME` — **0 files each**:

- nonsense: `vorplexus quintarrow bleddigan`
- absent real-English topic: `varroa mite oxalic acid vaporization beekeeping`
  (`varroa` → 0 files, `oxalic` → 0 files)

**Corpus as this run measured it:** 48 claude sessions + codex/cursor/pi · 305 subagents · 299
ghosts · 2,971 recovered prompts · 1,754 exchanges · **4,725 embeddable units** · 468 MB.

**Labels.** Session ids, project names, home paths and transcript prose are labelled one-to-one and
never printed. `<thread-A-head>` is the 4-exchange fork/resume child (the audit's F4 fixture);
`<thread-A-root>` its 119-exchange parent; `<thread-B>` a 103-exchange thread `graft` located from
natural-language words. Real values are in the evidence directory, outside the repository.

---

## A. THE RE-SCORE

Every row re-derived from my own commands. I did not inherit v2's numbers.

| row | v2 | **mine** | gate | the command behind it |
|---|---:|---:|---|---|
| **Overall, as an agent-facing product** | 7 | **7** | **≥ 8 — FAIL** | the sum of B and C |
| Concept & scope discipline | 9 | **9** | — | `tools/list` descriptions read in full; `--help`; `doctor --privacy` |
| Archive capture | 9 | **9** | — | `rescue --no-settings -y` → 402 files / 467 MB / 299 ghosts / 2,971 prompts; `index` → 360 parsed / 16.2 s / 7 harnesses / 4,725 units |
| CLI ergonomics for a human | 8 | **8** | — | `doctor` ‖ `stats` ‖ `index` ‖ `find` in one minute — all four `of 4,725`, monotone 49→52→53→53. One disagreement left: `ls` 53 vs `stats` 55 |
| **Retrieval quality** | 7 | **7** | **≥ 7 — PASS** | 2 fresh controls → honest empty at 0 **and** at 928 vectors; real topics → `strong`; 4 zero-lexical-overlap paraphrases → all found; `pnpm evals` hybrid 51/60 |
| **Reliability of a default install** | 8 | **8** | **≥ 8 — PASS** | 6 **concurrent** `index --quiet` → **1** embedder, the pre-existing pid; `--no-embed` suppresses the fetch; `pnpm test` 1,875 ✓, `typecheck` 0, `vendor` no diff |
| **Agent ergonomics** | 7 | **7** | **≥ 8 — FAIL** | real MCP server, all three tools: `potsherd_read` → `via:"core"`, 123, per-link citations correct; **but `capabilityLine` has three branches and this commit fixed one** (C1), and the `scope.project` error hands the agent a shell pipeline (C3) |
| Re-entry | 8 | **8** | — | `potsherd_graft {"thread":"<thread-A-head>"}` → 123 exchanges, 8/8 citations `resolves:true`, content-dated; graft by words → `<thread-B>`, 103 exchanges |

**GATE: FAIL.** Retrieval passes (7 ≥ 7). Reliability passes (8 ≥ 8). **Overall (7) and agent
ergonomics (7) do not.** My honest overall is 7 and I am reporting 7.

---

## B. THE FIVE CHANGES — ARE THEY REAL FIXES?

### 1. `potsherd_recall`'s capability string — **REAL FIX, but it closed one branch of three** ✅/⚠

Verified live, at the real MCP door (`sh plugins/claude-code/bin/potsherd-mcp`, `initialize` +
`notifications/initialized` + `tools/list` + `tools/call`, over stdio):

```
stderr: potsherd-mcp 1.2.0 ready · 3 tools · index …/v3/pd
tools/list → potsherd_recall inputSchema properties: query, scope, want, budget   (no `vectors`)

potsherd_recall {"query":"<a keyword question>"}     at 306 of 4,725 embedded
  capability = "keyword search answered this one (the words matched, so the vector half was not needed)"
  vectors    = {"used":false,"available":true,"vectors":306,
                "reason":"the words matched, so the vector half was not needed"}
```

`--vectors on` is gone from the model-facing string, and `grep -n 'vectors on' packages/core/src/recall.ts`
now returns only the two comment lines that explain the removal. The CLI human view carries the new
wording too (`text search only — the words matched, so the vector half was not needed`).

**But the string lives in a three-branch function and only one branch changed.** See C1 — the two
untouched branches are both still wrong at the model door, and one of them is strictly worse than
what was fixed.

### 2. `doctor --json` provenance — **REAL FIX** ✅

```
.adapters.4  gemini    {"unverified":true}                       ← no provenance, correctly
.adapters.5  opencode  {"unverified":true,"provenance":{
   "measured":"opencode-ai 1.18.21, 24 aug 2026",
   "verified":["store discovery","session metadata (title, directory, timestamps)"],
   "wrong":["message role — it is inside message.data, not a column",
            "turn text — it is in part.data, which is not joined"], …}}
.adapters.6  copilot   {"unverified":true,"provenance":{
   "measured":"Copilot CLI 1.0.80, 24 aug 2026",
   "verified":["session-state/<id>/ is the right directory and is created on first CLI run"],
   "wrong":["none of STATE_FILES is written there …",
            "the turns are in ~/.copilot/session-store.db, table turns(…), which this adapter does not open"], …}}
```

*never looked* and *looked and it is wrong* are now distinguishable in the machine surface, with the
measured version and date. gemini deliberately carrying only `unverified: true` is the right call and
I verified it is the only one of the three without a `provenance` key. v2's residual — the
`doctor.ts` comment reading *"All three are `unverified — documentation only`"* — is **also gone**
(`grep -n 'documentation only' packages/cli/src/commands/doctor.ts` → no match; the comment now
reads *"Phase 6, T6.1 wrote all three from documentation … **Phase 10 installed all three and ran
real sessions**, and the labels are no longer one word"*).

### 3. The privacy receipt's two new paths — **REAL FIX** ✅

`doctor --privacy`, under `writes:`:

```
41:    …/.potsherd/.gitignore
42:    <the path you give to  ask --readers-out>
45:    <the path you give to  ask --synthesis-out>
46:      only when you pass the flag. it holds the same redacted excerpts a model
47:      would have been sent, and no model was called to write it
```

Both v2 findings (C2, C3) are named. I confirmed the `.gitignore` write is real and that the receipt
is now exhaustive for it: one `potsherd_graft` into an empty scratch cwd produced exactly
`.potsherd/.gitignore` and `.potsherd/graft-<id8>.md`, and nothing else.

### 4. `tests/vectors-lazy.test.ts` — **REAL FIX, and I proved it can now fail** ✅

The old body called `vecStatus()` twice and compared the results. The new body cross-checks the three
renderings. I did not take that on faith — I mutated the renderer and watched the test go red
(this is my one ≤5-line change, reverted; diff in §F):

```
$ npx vitest run tests/vectors-lazy.test.ts        # unmutated
  ✓ tests/vectors-lazy.test.ts (17 tests)          Tests  17 passed

# with `r = { ...r, embedded: r.embedded + 1 };` injected into statusLine():
  × doctor and index read one source of truth > renders the same vectors row from the same call
    → expected 'semantic search: warming (2 of 4 embe…' to contain '1 of 4'
  Tests  1 failed | 16 passed (17)
```

A benchmark that could not fail now fails on exactly the drift it exists to catch.

*Residual (minor, C5-successor):* the case is still titled *"doctor and index read one source of
truth"* and **neither verb is invoked** — `grep -nE "doctor|runIndex" tests/vectors-lazy.test.ts`
matches only prose. It pins that the three renderings of one call agree, not that the two verbs make
that call. My live four-verb comparison is what actually establishes the latter.

### 5. "Nothing else" — **TRUE** ✅

`git diff --stat 9c663e9 339df63` is 11 files: the two source files above, the test, five
regenerated `docs/screens/*.txt`, two vendored `plugins/claude-code/dist/*.js`, and
`VERIFICATION-2.md`. No other behaviour changed. `pnpm vendor` exits 0 with no working-tree diff, so
the vendored bundles match the source they claim to be.

### Still open, as the orchestrator disclosed — both confirmed present

- **`ls` 53 vs `stats` 55.** `ls` footer: `53 sessions · 305 subagents inside them · 299 ghosts`;
  `stats`: `sessions 55`. `ls --json` is honest (`total 352 · threaded 2 · rolledUp 305`); 55 − 2
  rolled-up thread members = 53. One human string, not a broken model. It is why CLI ergonomics is 8.
- **`~/.claude/settings.json` in two sections.** `doctor --privacy` line 10 under
  `reads (never modified):`, line 62 under `writes only after an explicit y at a diff:`
  (`cleanupPeriodDays, and one SessionStart hook entry`). The second qualifies the first, so no
  reader is deceived, but "never modified" remains the wrong phrase.

---

## C. NEW DEFECTS, RANKED

### C1 — the fix changed one branch of `capabilityLine`; the branch that fires on **every fresh install** tells the agent to run a shell command ★★★★☆

`packages/mcp/src/tools/recall.ts:423-428`, whose docstring is *"Audit item 9, on every reply rather
than once in `doctor`"* — the single function that owns capability honesty at the model door:

```ts
export function capabilityLine(v: Result['vectors']): string {
  if (v.used) return `keyword + semantic search${v.vectors ? ` · ${String(v.vectors)} vectors` : ''}`;   // ← untouched
  if (!v.available)
    return `SEMANTIC SEARCH UNAVAILABLE — results are keyword-only${v.reason ? ` (${v.reason})` : ''}`;  // ← untouched
  return `keyword search answered this one${v.reason ? ` (${v.reason})` : ''}`;                          // ← the branch this commit fixed
}
```

Driven against a `--no-embed` index — **the state of every install before the embedder finishes**:

```
potsherd_recall {"query":"<a paraphrase question>"}          0 of 4,725 embedded
  capability = "SEMANTIC SEARCH UNAVAILABLE — results are keyword-only
                (no embeddings in the index — run  potsherd index --embed)"
  noMatch = true   confidence = "none"   hits = 0   belowFloor = 30
  note = "no match. The archive does not contain this, though 30 rows were withheld below the weak
          floor. Say so — do not widen into a guess, and do not answer from the repository in front of you."
```

Three things are wrong here and they compound.

**(a) It is an instruction the agent cannot follow.** `potsherd_recall`'s schema is
`query, scope, want, budget`; the agent has three tools and no shell. This is the exact defect v2
filed as ★★★ and the commit under test claims to have closed — the fix's own comment says *"an agent
reading it is being told to pass a flag it has no way to pass, which is the 'documented and does
nothing' failure this project has now recorded eight times."* The replacement left a **shell
command** in the sibling branch.

**(b) The repository's own source comments document that this instruction is false.**
`packages/core/src/render/find.ts:229`:

> *"That sentence ends in an instruction phase 10 made false — `index` embeds by default now, and
> `--embed` only moves the same work into the foreground"*

and `packages/core/src/render/stats.ts:158`:

> *"`index --embed to build them` is an instruction from the release where vectors were opt-in"*

Confirmed against the CLI: `--embed  embed in the foreground rather than in the background`. The
string was deleted from the two **human** surfaces with comments explaining why it was false, and
left on the **agent** surface, at `packages/core/src/recall.ts:1467`.

**(c) In that same reply the agent is told to assert a negative that is false.** I proved the
archive contains a topic that only the vector half finds:

```
$ potsherd find "choosing which hues belong in a brand guide" --json --vectors on   → 1 session · weak
$ potsherd find "choosing which hues belong in a brand guide" --json --vectors off  → 0 sessions · none
```

and the project's own evals size the hole: `bm25 only recall@5 40/60 (67%)` against
`hybrid (auto) 51/60 (85%)`. So during the multi-hour warm window, ~11 of every 60 answerable
questions come back as `noMatch: true` carrying *"The archive does not contain this … Say so — do not
widen into a guess"* — while the tool description reinforces it in capitals (*"TRUST ITS SILENCE …
That is a real answer: the archive does not contain this"*). The `capability` field does say
`keyword-only`, which is the mitigation, but the `note` is unconditional and the only remedy on offer
is one the reader cannot execute.

This is the hunt list's *capability probe that degrades politely*, and the brief's *instruction aimed
at an agent that the agent cannot follow*, in the same function, one fix round after the same species
was filed against it.

### C2 — the other untouched branch: a bare numerator at the one door with no denominator ★★★☆☆

`v.used` → `keyword + semantic search · N vectors`. Live, on four separate paraphrase queries and on
both no-match controls:

```
capability = "keyword + semantic search · 928 vectors"      # 928 of 4,725 = 19.6 % warm
```

I grepped the entire `potsherd_recall` reply for a denominator: `4725` → false, `4,725` → false,
`warming` → false, `pending` → false. Meanwhile `find`, `doctor`, `stats` and `index` all print
`N of 4,725`, and `find` prints `semantic search: warming (53 of 4,725 embedded)` at the place it
runs. The two-tool agent surface is the only one that does not. This is v2's C1 second half,
identified in writing and not fixed.

### C3 — the `scope.project` error hands the agent a shell pipeline, and the pipeline is wrong ★★★☆☆

Two adjacent error paths on the same server, one right and one wrong:

```
potsherd_read {"thread":"deadbeef"}                            isError: true
  no thread in the index starts with "deadbeef"
  try:  potsherd_recall {"query":"<what you are looking for>"}    # the ids come from there   ← a TOOL CALL. correct.

potsherd_recall {"query":"…","scope":{"project":"no-such-project-xyz"}}   isError: true
  no indexed project matches "no-such-project-xyz"
  try:  potsherd ls --json | jq -r ".sessions[].project" | sort -u          ← a SHELL PIPELINE. un-runnable.
```

None of the three tools lists projects, so the agent is simply stuck. And the remedy is wrong on its
own terms — `ls --json` returns `shown: 15` of `total: 352`, so the pipeline enumerates the projects
of the fifteen newest rows only:

```
$ potsherd ls --json | jq -r ".sessions[].project" | sort -u | wc -l     →  5
$ sqlite3 potsherd.db "select count(distinct project) from sessions;"     →  18
```

A human who runs it concludes that 13 of their 18 projects do not exist.

### C4 — the vendored-freshness test compares mtimes, so it is falsely red on a content-neutral touch ★★☆☆☆

`tests/plugin-install.test.ts` → *"the vendored bundles are not older than the source they claim to
be"*. My one-line probe (§F) restored `vec.ts` byte-for-byte via `cp`, which bumped its mtime; the
suite then failed:

```
× the vendored bundles are not older than the source they claim to be
  → the vendored plugin bundle is older than packages/**/*.ts — run: pnpm build && pnpm vendor:
    expected 1787538103237.2954 to be greater than or equal to 1787538549445.1035
```

In a pristine clone of the same commit the identical file passes 14/14, and `pnpm vendor` reports no
diff — i.e. the content was never stale. A `git checkout` away and back, a `cp`, a `touch`, or a
rebase flips it. It is *a test whose premise is its environment*: it should compare content (which
`pnpm vendor` already computes) rather than filesystem timestamps. It fails loud rather than silent,
so it is noise, not a hole — hence ★★.

### C5 — smaller ★☆☆☆☆

- `potsherd_recall`'s `hits[]` are ordered by the RRF `score` but labelled from a different
  `calibration.score`, so the **top** row can be labelled weaker than the rows beneath it:
  `hit0 score 0.016393 conf weak` above `hit1 score 0.016393 conf strong`. Every field an agent needs
  is present (`calibration.score` is exposed), so it can re-sort — but the default order and the
  default label disagree.
- The receipt's new `.potsherd/.gitignore` line is the only entry in `writes:` with no explanatory
  sub-line, while both of its immediate neighbours have one.
- Three orphaned `hang.mjs` node processes were alive on this machine in `potsherd-d10-*` temp dirs
  with an elapsed time of **2 days** — leaked by an earlier run of the suite, not by mine, and the
  `d10-` prefix does not exist anywhere in this commit's tree. Not attributable to `339df63`;
  recorded because I killed them and someone should know the suite has leaked long-lived children.

---

## D. CLAIMS I CHECKED THAT HELD

1. **The real MCP server, driven over stdio.** `potsherd-mcp 1.2.0 ready · 3 tools`;
   `tools/list` → `potsherd_recall, potsherd_read, potsherd_graft`, disjoint, schemas as documented.
2. **`potsherd_read` reads a thread, and its per-page citations are correct across the link
   boundary.** `{"thread":"<thread-A-head>","from":1,"to":2}` → `via:"core"`, `note:null`,
   `total:123`, both links with their offsets. `from:118,to:121` returns four exchanges whose
   `cite` fields switch from `<thread-A-root> · … · 119 exchanges · 2026-08-19` to
   `<thread-A-head> · … · 4 exchanges · 2026-08-20` at exactly the right row. A model reading page
   30 is handed the right session id for the words in front of it. No `session-only` anywhere.
3. **`potsherd_graft` does not mint a citation it should not.** `{"thread":"<thread-A-head>"}` →
   `exchanges:123`, `sourcesChecked:true`, `citations` = 8 entries, **all `resolves:true`**, each
   `{id8, seq}` pointing at a real exchange in the right one of the two sessions. With no login it
   returned `via:"card-only"` and `reason:"the model call failed (claude --print could not answer:
   Not logged in · Please run /login)"` and served the unsummarised brief labelled as such, rather
   than erroring. The brief's header claim — *"every claim carries `[id8@seq]`"* — holds, because
   the card-only brief contains quoted excerpts and no unsourced claims.
4. **`potsherd_graft`'s write is fully disclosed at the agent door**, in capitals, before the agent
   calls it: *"IT WRITES TO THE USER'S PROJECT. It saves the brief as `./.potsherd/graft-<id>.md`,
   creating `./.potsherd/` and a `.gitignore` inside it if they are not there … That is the only
   thing it writes."* I confirmed that is exactly and only what appears. (It is not redirected by
   `--potsherd-dir`, which the description also does not claim.)
5. **`potsherd_graft` finds a thread from natural-language words**, as its description promises —
   no id, four words of a topic → `<thread-B>`, 103 exchanges, `via:"core"`, `partial:false`.
6. **The honest empty at the agent door.** Both of my post-freeze controls: `noMatch:true`,
   `confidence:"none"`, **0 hits**, `belowFloor` reported, and an instruction the agent *can* follow
   — *"Say so — do not widen into a guess, and do not answer from the repository in front of you."*
7. **`find` returns an honest empty on both controls and `strong` on real topics**, at 0 vectors and
   at 928. The audit's own written-down nonsense string is still **not** a control — it is in the
   corpus and returns `strong`, which is why I invented my own after the freeze.
8. **Semantic recall genuinely works at 20 % warm.** Four paraphrases with no lexical overlap with
   the corpus all returned hits (3, 6, 11, 9) at 928 of 4,725.
9. **Six concurrent `index --quiet` produce one embedder.** Started against an index already being
   embedded by a pid 23 s old: after `wait`, `ps` shows **1** embedder and it is **the same pid** —
   a live lock older than the stale threshold was not stolen by six racing processes. *Not fixed and
   not claimed:* that one embedder holds 250–400 % CPU for the ~3.5 h to full hybrid and there is no
   verb to stop it.
10. **The counters agree.** `doctor` 49 · `stats` 52 · `index` 53 · `find` 53, all `of 4,725`,
    monotone within one minute, one wording. `find` prints the warming line where it runs.
11. **`index --no-embed` really suppresses the fetch** — `vectors — not this run (--no-embed)`, and
    a `recall` against that index correctly reports `available:false`.
12. **`index` no longer calls installed harnesses "not installed"** — `gemini 0 · installed · no
    transcripts in ~/.gemini/tmp`, likewise opencode and copilot, agreeing with `doctor`.
13. **Unknown record types are reported, not swallowed** — `index` printed *"record types no format
    note describes yet"* with two entries and their versions.
14. **The evals alarm fires.** `pnpm evals -- --vector-weight 0` exits **1**,
    `FAIL — the amended phase-3 gate would not merge this fusion`, naming 85+ lost queries.
15. **`pnpm vendor` produces no diff**; the committed `plugins/claude-code/dist` matches a fresh build.
16. **`check-privacy.py` exits 0** on the tree with this report absent, and again with it present.

---

## E. WHAT I COULD NOT CHECK

1. **A1 rung 2 — `claude -p` / `codex exec` live.** The subscription credential does not follow a
   relocated `HOME` (`Not logged in · Please run /login`), and exercising it against the real `HOME`
   would create `~/.claude/projects/…potsherd-llm-cwd/`, which I am forbidden to write. Every model
   rung here is the fail-soft path, which is itself what I verified.
2. **A1 rung 3 — the agent SDK / API-key path.** No SDK installed, no key available.
3. **`card`, and the card-only `citation: null` path.** `select count(*) from cards` → **0**; cards
   need a model backend, so no card-only hit can exist in this index.
4. **The `ask` zero-model round trip (`--readers-out` → `--readers-in --synthesis-out` →
   `--filter-in`) and the citation filter.** v1 and v2 each drove it end to end and agree it holds,
   including the planted-quote refusal. I spent my budget on the two rows in question instead and am
   inheriting nothing from them: those rows are **not** part of my agent-ergonomics or overall score,
   which rest only on what I ran myself.
5. **codex / gemini / opencode / copilot parsers against live sessions.** No session data for those
   harnesses in this corpus; I verified their labels, their `provenance`, and their presence
   detection, not their parsing.
6. **CI, the tag and the published tarball.** Not re-run by me.
7. **A fully warm index.** I killed the embedder at ~930 of 4,725 and confirmed with `ps` that no
   `potsherd.js index` process survives. Everything I measured about warming is inside the warm
   window — which is the state every new install has, and the state C1 is about.

---

## F. THE ONE ≤ 5-LINE CHANGE

Used, as a falsifiability probe for change 4, and **reverted**. One line, in my own clone only:

```diff
--- a/packages/core/src/vec.ts
+++ b/packages/core/src/vec.ts
@@ -292,6 +292,7 @@
 function statusLine(r: VectorReport): string | null {
+  r = { ...r, embedded: r.embedded + 1 };
   if (r.phase === 'ready' || r.phase === 'empty') return null;
```

It made `tests/vectors-lazy.test.ts` fail with the right message (§B4), proving the rewritten
assertion is not decorative. Reverted immediately; `git status --porcelain` empty in both clones and
in the orchestrator's tree. Nothing was fixed, committed or pushed. The only file I wrote into the
orchestrator's tree is this one.

*One incidental write, disclosed:* an early `potsherd_graft` MCP call inherited the orchestrator
tree as its cwd and created `.potsherd/graft-<thread-A-head>.md` there (the tool's documented
behaviour, §D4). `.potsherd/` is git-ignored, so `git status` never changed. **I deleted that file**
and re-ran every subsequent graft with cwd in a scratch directory. The pre-existing
`.potsherd/.gitignore` and one older `graft-*.md` from 22 aug were left untouched.

---

## G. SUITE RESULTS (all on `339df63`)

| command | **exit code** | result |
|---|---:|---|
| `pnpm test` | **0** | 53 files, **1,875 passed** — run in the *pristine* clone (see C4: my probe made one mtime assertion falsely red in the working clone; content was never stale) |
| `pnpm typecheck` | **0** | all four packages |
| `python3 scripts/check-privacy.py` | **0** | 579 tracked text files swept; id inventory 184 distinct, 165 accounted, unaccounted at its pinned ceiling *(finding elided)* |
| `pnpm evals` | **0** | hybrid (auto) recall@5 **51/60 (85 %)**, recall@1 **27/60 (45 %)**, ✓ over both single-signal baselines; six confidence controls `ok`. bm25-only 40/60 — the number that sizes C1(c) |
| `pnpm evals -- --vector-weight 0` | **1** | FAIL, names 85+ lost queries — the alarm fires |
| `pnpm vendor` | **0** | no working-tree diff |

---

## H. WHAT WOULD HAVE TO CHANGE TO REACH 8

The shortest honest list. All three are in the same species and two are in the same function.

1. **`packages/mcp/src/tools/recall.ts:423-428` — fix the two untouched branches of
   `capabilityLine`.** No shell verbs and no CLI flags in a string an agent reads; always print the
   denominator (`N of M`); say `warming` while `pending > 0`. The `!available` branch must not name
   `potsherd index --embed`, an instruction this repository's own comments at `render/find.ts:229`
   and `render/stats.ts:158` already document as false. (~4 lines, plus the source string at
   `packages/core/src/recall.ts:1467`.)
2. **Make the `noMatch` note conditional on the vector state.** When `available` is false or
   `pending` is large, *"The archive does not contain this … Say so"* must disclose that only the
   keyword half ran, so the agent can weigh the negative it is being told to assert. (~2 lines.)
3. **`scope.project`'s error must offer a tool call, not `potsherd ls --json | jq …`** — and no
   remedy that returns 5 of 18 projects. (~2 lines.)

Nothing else in the eight rows is below its bar. Retrieval and reliability already pass, capture and
scope are 9s, and the thread model, the citation discipline and the fail-soft model path are all
genuinely strong and independently re-verified above. Overall is 7 because the product's whole
premise is that an *agent* can trust what it is told about what the tool can do, and the one function
that owns that promise — docstring *"Audit item 9"* — is still wrong in two of its three branches,
one fix round after the same defect was filed against it in writing.

---

## I. EVIDENCE

`…/scratchpad/v3/`

`potsherd/` (working clone at `339df63`), `pristine/` (untouched clone, the suite run of record),
`home/` (the frozen harness clone), `pd/` (the warm index), `pd0/` (the zero-vector index),
`cwd/` (the scratch cwd for graft), and in `/tmp`: `v3-mcp.sh`, `v3-mcp0.sh`, `v3-mcp2.sh` (the MCP
drivers), `v3-mcp-out.txt`, `v3-mcp-zero.txt`, `v3-mcp3.txt`, `v3-mcp-warm1.txt` (raw stdio
transcripts), `v3-index1.txt`, `v3-privacy.txt`, `v3-doctor.json`, `v3-find1.json`, `v3-ls.json`,
`v3-test.txt`, `v3-test2.txt`, `v3-tc.txt`, `v3-priv.txt`, `v3-evals.txt`, `v3-evals0.txt`,
`v3-vendor.txt`, `v3-conc-1..6.txt`, `v3-ps1.txt`.

The MCP transcripts and index directories carry raw transcript text and real ids and are deliberately
**outside** the repository.

*(Every session id, project name, home path and transcript line in this document is a label. The
substitution is one-to-one. The repository's own `check-privacy.py` refuses even an eight-character
prefix of a real id, and it exits 0 with this file in the tree.)*

# phase 10 — fourth independent verification (third post-fix re-score)

**Commit under test:** `9ee2c6e` (`main`), cloned to a private scratch directory
(`…/scratchpad/v4/repo`), `pnpm install --frozen-lockfile && pnpm build`. I wrote none of phase 10
and none of `VERIFICATION{,-2,-3}.md`. I read the audit, `plans/phases/phase-10-agent-audit.md`,
`FIX-{C,D,E}-REPORT.md` and all three prior verifications before starting, and treated every line of
all of them as a hypothesis.

**Isolation.** `.claude .codex .cursor .pi .gemini .copilot .local/share/opencode` were APFS-cloned
(`cp -Rc`) into a scratch `HOME`. Every invocation ran as

```
env -u CLAUDE_CONFIG_DIR -u POTSHERD_DIR -u XDG_CONFIG_HOME -u NODE_PATH -u CODEX_HOME \
    -u ANTHROPIC_API_KEY HOME="$B/home" node …/packages/cli/bin/potsherd.js … --potsherd-dir "$B/pd"
```

and the MCP server the same way with `POTSHERD_DIR="$B/pd"`. No byte was written to the real
`~/.claude`, `~/.codex`, `~/.cursor`, `~/.pi`, `~/.gemini`, `~/.copilot`, `~/.local/share/opencode`
or `~/.potsherd`. The corpus is **frozen** at the clone, which is what makes the controls below
airtight.

**Fresh negative controls, invented after the freeze.** I reused nothing from `WAVE.md` or from any
previous verification, and not the audit's own string (which is in the corpus). Confirmed absent by
`grep -ril` over the frozen `HOME` — **0 files each**:

- nonsense: **`zblorptik wemmadge fnuraskil`** (`zblorptik` 0, `wemmadge` 0, `fnuraskil` 0)
- absent real-English topic: **`mastitis silage hoof trimming dairy herd`**
  (`mastitis` 0, `silage` 0, `hoof trimming` 0, `dairy cattle` 0). I discarded six earlier
  candidates — `harpsichord`, `temperament`, `alpaca`, `sourdough`, `clover`, `kayak` — because
  `grep -ril` found them in the frozen `HOME`, which is what that step is for.

**Corpus as this run measured it:** 49 claude sessions + codex/cursor/pi · 308 subagents · 299
ghosts · 2,971 recovered prompts · 1,774 exchanges · **4,745 embeddable units** · 472 MB · 366
transcripts parsed.

**Labels.** Session ids, project names, home paths and transcript prose are labelled one-to-one and
never printed. `<thread-A-head>` is the 4-exchange fork/resume child (the audit's F4 fixture),
`<thread-A-root>` its 119-exchange parent; together 123 exchanges.

---

## A. THE RE-SCORE

Every row re-derived from my own commands. I did not inherit v3's numbers.

| row | audit | v3 | **mine** | gate | the command behind it |
|---|---:|---:|---:|---|---|
| **Overall, as an agent-facing product** | 4 | 7 | **7** | **≥ 8 — FAIL** | the sum of B and C |
| Concept & scope discipline | 9 | 9 | **9** | — | `tools/list` (3 tools, disjoint, annotated); `--help` on `find`/`ask`; `doctor --privacy` |
| Archive capture | 9 | 9 | **9** | — | `rescue --no-settings -y` → 408 files / 472 MB / 299 ghosts / 2,971 prompts; `index --no-embed` → 366 parsed / 16.9 s / 7 harnesses / 4,745 units |
| CLI ergonomics for a human | 8 | 8 | **8** | — | `doctor ‖ stats ‖ index ‖ find` in one minute — all four `of 4,745`. One new disagreement: `doctor` says `46.1 MB runtime not fetched yet`, `find` says `warming` (C2) |
| **Retrieval quality** | 3 | 7 | **7** | **≥ 7 — PASS** | 2 fresh controls → honest empty at **0**, at **285** (vector half used) and at **full** embed; `pnpm evals` hybrid recall@5 51/60, recall@1 27/60, exit 0. Against: 18 of 28 hits and the top 5 threads are `not-a-transcript` (C3) |
| **Reliability of a default install** | 2 | 8 | **8** | **≥ 8 — PASS** | `pnpm test` **1,893 ✓ / 53 files**, `typecheck` 4 of 4, `check-privacy.py` **exit 0** (read from `$?`), `pnpm evals` exit 0, `pnpm vendor` no diff; the audit's three dead verbs all run, and `ask` has a genuinely model-free path that works (D6) |
| **Agent ergonomics (the actual target)** | 3 | 7 | **7** | **≥ 8 — FAIL** | real MCP server, all three tools, all three `capabilityLine` branches at three vector states. Against C2, C3, C5, C6 |
| Re-entry | 5 | 8 | **8** | — | `potsherd_graft {"thread":"<thread-A-head>"}` → 123 exchanges across 2 sessions, content-dated `2026-08-20`, brief written, 3 fabricated citations dropped and disclosed |

**GATE: FAIL.**
Overall **7** < 8 · retrieval **7** ≥ 7 (pass) · reliability **8** ≥ 8 (pass) · agent ergonomics
**7** < 8.

My honest overall is 7 and I am reporting 7. The five commits since `339df63` are real fixes and I
verified four of the five in both directions; what holds the number at 7 is that **the CI step this
commit added is red on this commit** (C1), that the model-free seam the audit called its
highest-leverage change **returns a false honest-empty** on the input shape its own instruction
invites (C4), and that the model door still hands the agent a **citation for a thread whose
transcript never used the words** (C3).

---

## B. THE FIVE CHANGES SINCE `339df63` — ARE THEY REAL FIXES?

### 1. `4e8ebe6` FIX-C — **REAL FIX**, all four parts ✅

All three `capabilityLine` branches driven at the real MCP door, at three vector states, on the real
archive:

```
0 embedded (--no-embed):
  capability = "keyword search only — semantic search is warming (0 of 4,745 embedded)"
285 embedded (mid-warm), keyword answered it:
  capability = "keyword search only — semantic search is warming (285 of 4,745 embedded)"
285 embedded, vector half ran:
  capability = "keyword + semantic search (285 of 4,745 embedded)"
1 of 1 embedded (a corpus I embedded to completion):
  capability = "keyword + semantic search (1 of 1 embedded)"
1 of 1 embedded, keyword answered it:
  capability = "keyword search answered this one (the words matched, so the vector half was not needed)"
```

Every branch carries a denominator (v3's C2 closed) and **no branch names a shell command** (v3's C1
closed). `grep -rn "index --embed" packages/core/src/recall.ts` → no match. The no-match note
discloses the half that produced it:

```
note = "no match. The archive does not contain this, though 10 rows were withheld below the weak
        floor. Only keyword search ran; the semantic half did not. Say so — do not widen into a
        guess, and do not answer from the repository in front of you."
```

`scope.project` returns the answer instead of a pipeline, with the tail disclosed (v3's C3 closed):

```
potsherd_recall {"query":"anything","scope":{"project":"no-such-project-xyz"}}   isError: true
  no indexed project matches "no-such-project-xyz". The index holds 55: <project-a>, <project-b>,
  … , and 43 more
```

and `{"project":"<short name>"}` resolves to the full path, so the listed values and the short
name both work.

### 2. `15a31cf` README receipt — **REAL FIX** ✅

Both CI steps extracted verbatim from `ci.yml` and run locally on the pristine clone:

```
readme quotes the receipt verbatim (127 lines)
the published privacy receipt matches the live command
PRIVRECEIPT_EXIT=0
the doctor screen names potsherd 1.2.0 and schema v12
DOCTORSCREEN_EXIT=0
```

### 3. `cd55cb8` FIX-D — **REAL FIX**, proved in both directions ✅

**Content, not mtimes.** Content-neutral churn (a `cp` of `vec.ts` over itself plus `touch` on
`packages/mcp/src/index.ts` — both bump mtimes, neither changes a byte) now stays green, which is
exactly v3's C4:

```
$ npx vitest run tests/plugin-install.test.ts
  Test Files  1 passed (1)        Tests  14 passed (14)
```

and a real one-byte drift in the vendored bundle goes red with a message that names the byte (my one
change, §F):

```
× the vendored bundles are byte-for-byte the bundles this build produces
  → plugins/claude-code/dist/mcp.js is not what packages/mcp/dist/index.js builds
    (1630724 bytes committed, 1630724 built, first difference at byte 815362) — run: pnpm build && pnpm vendor
```

**Ordering by label.** Live on the real archive, `hits[]` and `threads[]` are ordered by the
confidence word then `calibration.score` then the fused score, monotone in all three, with no row
dropped (28 hits in, 28 out; 10 threads in, 10 out). v3's C5a — a `weak` row above a `strong` one —
does not reproduce. `want:"context"` windows are unaffected (they are built from `sessions`, not
from `orderByLabel`'s output; verified by reading `windowsFrom` and by a live `want:"context"` call
returning 7 windows / 4,830 tokens). The order it produces is *defensible* rather than obviously
right — see D9.

**The receipt's `.gitignore` sub-line** is there:

```
  <cwd>/.potsherd/.gitignore
    written once, the first time you run graft here, and never overwritten:
    it is what keeps the briefs out of your commits
```

### 4. `9ee2c6e` FIX-E item 1 (signals) — **REAL FIX, at the real MCP door** ✅

I drove the **real MCP server** (`sh plugins/claude-code/bin/potsherd-mcp`, stdio, initialize +
initialized + `tools/call potsherd_graft`), with a stub backend that is a shell script forking
`sleep 300` — the shape of every harness CLI — and sent `SIGINT` to the server's pid with the model
call in flight:

```
mcp server pid = 51244
stub pids from its own pidfile: [51259, 51265]
  PID  PPID  PGID COMMAND
51244 51240 51235 node …/plugins/claude-code/dist/mcp.js
51259 51244 51259 /bin/sh <stub>/claudestub --print --output-format json … --model haiku …
51265 51259 51259 sleep 300

--- sending sigint to the server pid 51244
server exit: 0
  pid 51259 alive after the signal: False
  pid 51265 alive after the signal: False
--- ps after
  (empty)
```

The backend has its **own** process group (`51259`, not the server's `51235`), and both the launcher
and the grandchild it forked are gone. The server exits **0**, not 130 — correctly, because the MCP
server's own handler (`packages/mcp/src/index.ts:136`) ends in `process.exit(0)` and still runs; the
llm handler's re-raise re-enters *that* listener, not the default disposition. FIX-E's "a shell reads
130" claim is about the CLI, and is not what happens over MCP; nothing in the report says otherwise,
but it is worth writing down.

**Its disclosed gap is real, and I measured it** — FIX-E §5.3 says it is "an argument from the code,
not a measurement". Same harness, stub changed to fork and exit immediately:

```
  PID  PPID  PGID COMMAND
51369 51365 51360 node …/dist/mcp.js
51384     1 51383 sleep 300              ← already reparented; the launcher is gone
--- sending sigint to the server pid 51369
server exit: 0
  pid 51383 alive after the signal: False
  pid 51384 alive after the signal: True      ← survives
```

Unclosed, disclosed in the code, and no harness in the ladder behaves this way today. I reaped it by
its recorded pid.

### 5. `9ee2c6e` FIX-E item 2 (the screen guard) — **REAL GUARD, AND IT IS RED ON THIS COMMIT** ❌

See **C1**. The step works — it is a live diff and it does catch drift — and on a pristine clone of
`9ee2c6e` it exits 1.

---

## C. NEW DEFECTS, RANKED

### C1 — the CI screen guard this commit added **fails on this commit** ★★★★☆

The step extracted verbatim from `.github/workflows/ci.yml` ("the published screens still match what
this build prints"), run in a pristine clone of `9ee2c6e` that I had not edited:

```
  ok        docs/screens/01-audit.txt
  ok        docs/screens/06-audit-sweep.txt
  ok        docs/screens/02-rescue.txt
  ok        docs/screens/03-audit-after.txt
  ok        docs/screens/08-ls.txt
  ok        docs/screens/09-find.txt
  DRIFTED   docs/screens/10-stats.txt  <-  potsherd stats
--- /dev/fd/63
+++ /dev/fd/62
@@ -10,6 +10,6 @@
   indexed                   24 aug   228 transcripts · up to date
   vectors                        —   0 of 3,410
-  database                  2.1 MB   ~/.potsherd/potsherd.db
+  database                  2.2 MB   ~/.potsherd/potsherd.db
  ok        docs/screens/11-show.txt
  ok        docs/screens/12-ls-ghosts.txt
  ok        docs/screens/13-find-redacted.txt

A published screen is not what this build prints. …
Regenerate with:  bash scripts/make-screens.sh
```

Reproduced twice in two fresh `RUNNER_TEMP`s. It is not a flake in the step: **`make-screens.sh`
itself produces the same change.** On the same clone, `bash scripts/make-screens.sh` exits 0 and
leaves exactly four files modified, of which three are millisecond noise and one is not:

```
$ git status --porcelain docs/screens
 M docs/screens/07-index.txt      -  full index 374ms  →  + 341ms
 M docs/screens/09-find.txt       -  … bm25 · 9ms      →  + 12ms
 M docs/screens/13-find-redacted.txt  -  … 11ms        →  + 7ms
 M docs/screens/10-stats.txt      -  database 2.1 MB   →  + database 2.2 MB
```

So `10-stats.txt` is **stale in the tree** (last regenerated at `2cd1be0`, FIX-B), the new guard is
doing its job, and the gate's "CI green on the pushed commit" is not met by `9ee2c6e`.

Two things make it worse than a stale screenshot:

**(a) The pinned number is not a property of the corpus.** `packages/core/src/stats.ts:361` is
`dbBytes = fs.statSync(<potsherd.db>).size`, and the database is in WAL mode. Immediately after the
guard's own sequence there is a 4.1 MB `-wal` beside a 2.7 MB main file, so the published number
depends on when SQLite last checkpointed and on which verbs ran before `stats`. I measured the same
demo corpus at **2,248,704 bytes (2.1 MB)** after `rescue → index --full → stats` and at
**2,260,992 bytes (2.2 MB)** after the guard's/script's full order — a 12,288-byte (3-page)
difference that happens to straddle the rounding boundary the screen prints. A guard that pins that
byte count is a flake generator on any change to the capture order.

**(b) Running the guard leaks a background embedder per invocation.** `run index --full` inside the
step spawns the detached, `unref`ed embedder (`cli/src/commands/index.ts:258`). After my two guard
runs and three repro runs, `ps` showed **five** of them, `PPID 1`, each fetching 46 MB into its own
root:

```
$ ps -eo pid,ppid,command | grep "[i]ndex --quiet"
52824 1 node …/potsherd.js index --quiet --potsherd-dir …/citmp/screens-live/.potsherd
53001 1 …citmp2…    53571 1 …dbsz1…    53623 1 …dbsz2…    53685 1 …dbsz3…
```

`bash scripts/make-screens.sh` leaks one too (pid 62380 on my run). FIX-E measured this lane and
declined to fix it, which was the right call for that branch; the new step is a **new** producer of
it, and nothing in the product's 22 verbs stops one.

*Uncovered screens, checked:* seven of seventeen are outside the guard. `04`/`05` are covered by
their own two CI steps and both are green (§B2). `07` and `09` regenerate with millisecond noise
only. `16-before-after` regenerates byte-identical. `14`, `15`, `17` need a model backend and were
not regenerable here (§E). So **no uncovered screen is stale — the stale one is a covered one.**

### C2 — "semantic search is warming" when nothing is warming, at both doors ★★★★☆

`index --no-embed`, then, with `ps` confirming no embedder exists anywhere and `<root>/models` not
even created:

```
$ ps -eo pid,command | grep "[i]ndex --quiet"   →  no embedder running
$ ls <root>/models                              →  No such file or directory

doctor:   vectors    —    0 of 4,745 · 46.1 MB runtime not fetched yet     ← honest
find:     semantic search: warming (0 of 4,745 embedded)                   ← claims work in flight
MCP:      capability = "keyword search only — semantic search is warming (0 of 4,745 embedded)"
          vectors    = {"used":false,"available":false,"vectors":0,"reason":"no embeddings in the index yet"}
```

It is not confined to `--no-embed`. On a **default** `index` on a machine that cannot fetch — the
ordinary offline/first-run case — the same thing happens, and `index` itself is honest about it
while `find` and the MCP door are not:

```
$ POTSHERD_OFFLINE=1 potsherd index
  semantic search: warming (0 of 4,745 embedded) — offline        ← index adds the clause
$ ps -eo pid,command | grep "[i]ndex --quiet"  →  none alive
$ POTSHERD_OFFLINE=1 potsherd find "<control>"
  semantic search: warming (0 of 4,745 embedded)                  ← the clause is gone
```

`doctor-line.ts:98` maps *0 embedded with rows pending* to phase `pending`, `vec.ts:297` renders
`pending` with `warmingLine`, and FIX-C's `capabilityLine` branch (`recall.ts:554`) folds `pending`
into "is warming". Nothing anywhere asks whether a worker holds `<root>/.lock.embed` — the lock file
carries the holder's `pid` and is never consulted. `warmingLine`'s own docstring says *"There is no
command in it because there is nothing for the reader to do; the work is already running"* — which
is the claim that is false here.

Why it matters at the model door specifically: the same reply tells the agent *"The archive does not
contain this … Say so — do not widen into a guess"* and *"semantic search is warming"*, i.e. *retry
later and the other half will have run.* On a `--no-embed`, offline or crashed-embedder index it
never will. `vecStatus`'s own comment says it exists so `doctor`, `index` and `find` "cannot disagree
in print the way audit F2 caught them doing"; the numbers agree and the **words** disagree, and the
agent-facing surface is the wrong one.

### C3 — a title-only thread is `citable: true` with a minted citation, and it outranks the transcript ★★★★☆

One live `potsherd_recall` on the real archive (query: the project's own name), at the real MCP door:

```
hits: 28   →   kinds Counter({'title': 18, 'exchange': 10})
               evidence Counter({'not-a-transcript': 18, 'transcript': 10})
               first hit whose evidence is 'transcript' is at index 18 of 28
weights: {'titles': 1.5, 'exchanges_fts': 1, 'ghosts_fts': 0.6, 'ghost_prompts_fts': 0.6}
```

and per thread, cross-checking each thread's own hits:

```
<thread-1> lane evidence citable True hit-evidence ['not-a-transcript','transcript']
<thread-2> lane evidence citable True hit-evidence ['not-a-transcript','transcript']
<thread-3> lane evidence citable True hit-evidence ['not-a-transcript','transcript']
<thread-4> lane evidence citable True hit-evidence ['not-a-transcript','transcript']
<thread-5> lane evidence citable True hit-evidence ['not-a-transcript']      ← title only
<thread-6> lane evidence citable True hit-evidence ['not-a-transcript']      ← title only
<thread-7> lane evidence citable True hit-evidence ['not-a-transcript']      ← title only
<thread-8> lane evidence citable True hit-evidence ['not-a-transcript']      ← title only
<thread-9> lane evidence citable True hit-evidence ['not-a-transcript']      ← title only
<thread-10> lane evidence citable True hit-evidence ['transcript']           ← ranked last
```

Five of ten threads matched **only** on their title. Each is labelled `lane: "evidence"`,
`citable: true`, and each carries a ready-made `citation` of the form
`<id8> · <project> · claude · N exchanges · 2026-08-21`. The human CLI, on the identical query,
prints the honest note for the top one — *"the session title matched; the body does not use those
words"* — and the model door prints a citation instead.

The block that mints it says exactly why it must not:

> *"F6 — a card-only thread gets no citation. … Minting one for a thread the agent has only ever
> seen a *summary* of would hand it a syntactically perfect, index-resolvable citation for a claim
> no transcript supports"* — `packages/mcp/src/tools/recall.ts:330-341`

The refusal is keyed on `lane === 'routing'`, and `ROUTING_KINDS = new Set(['card'])`, so it never
fires for a title. `T10.7-REPORT.md §5` scopes that out deliberately, and its stated justification is
*"a title … has never been citable"* — which is not true of this build. Claude Code's titles are
model-written (`doctor` counts `ai-title 80` records in this corpus), so this is the audit's F6
sentence — *"a generated summary beat primary evidence"* — reached by the other door.

`plans/phases/phase-10-agent-audit.md §B8` requires "**never outranking a transcript hit**" and
"`--no-cards`". Neither is true at the model door: `potsherd_recall`'s `scope` is
`project, harness, since, until, tag, sidechains, ghosts, pinned, limit` — there is no cards control,
while the CLI has `--no-cards  transcripts only — do not search session cards`.

### C4 — the model-free seam returns a **false honest-empty** when `reply` is a JSON string ★★★★☆

`--synthesis-out` writes a file whose `schema` field is *itself a JSON string*, and instructs:

```
  answer "prompt" in the shape of "schema", add it to the file as "reply", then:
    potsherd ask "…" --filter-in <file>
```

A host agent that captures its model's text and stores it as `"reply": "{…}"` gets this:

```
$ potsherd ask "…" --filter-in synth3.txt --debug
  filter: nothing dropped
potsherd ask "…"
  no grounded answer in 6 sessions searched
  the readers found nothing that answers the question.
  6 of 6 sessions read · 1 answered · 323ms
$ … --json   →  {'answer': '', 'sentences': [], 'dropped': [], 'strict': False}     exit 0
```

The identical file with `reply` as an **object** answers correctly, and the filter does its job:

```
$ potsherd ask "…" --filter-in synth4.txt --debug
  filter: 2 dropped
    evidence not-a-quote      <id8>@9   we agreed to delete every log line on friday
    sentence no-citation                The team agreed to delete every log line on friday.
ANSWER
  A decision was recorded in that session. [1]
EVIDENCE
  [1] <project>/<id8>  21 aug 22:34  "<a real quote>"
  1 sentence dropped · no citation that resolves
```

So the string form is not rejected, not warned about, and not counted as dropped: it is reported as
*"the readers found nothing that answers the question"* — with `1 answered` printed on the next line,
contradicting it. `filterHostAnswer` checks only `file.reply === undefined || null`
(`packages/cli/src/commands/ask.ts:1090`) and hands whatever it finds to `synthFn`. This is a
capability failure wearing the honest empty's clothes, in the one path the audit called the
highest-leverage change in the document, and the honest empty is the thing the whole phase asks the
agent to trust. Two independent attempts of mine (a subagent target and a plain-session target) hit
it before I found the object form by reading the source.

### C5 — `--synthesis-out` says "makes no model call" and makes six ★★★☆☆

```
--synthesis-out <path>  write the synthesis prompt to this file; makes no model call
```

Run on its own, on a machine with no backend:

```
$ time potsherd ask "…" --synthesis-out synth.txt
  reader 1/6 · <id8>↳<id8> · failed  ·   5.9s · $0
  … six readers …
  no reader found anything — no synthesis prompt written to synth.txt
  7.09s total
```

The code knows: `packages/cli/src/commands/ask.ts:204` is
`const modelless = Boolean(readersOut || filterIn || (synthesisOut && readersIn));` — `synthesisOut`
alone is deliberately *not* modelless. Composed as `--readers-in … --synthesis-out …` it is free and
says so (`no model call was made (0)`), which is the real seam and it works. The help line is
unconditional, and on a machine that *does* have a backend it spends six reader calls the flag
promises it will not. `--readers-out`'s identical clause is true; this one is not.

### C6 — `want:"context"` can return zero windows, no hits, and `readMore: null` ★★★☆☆

```
potsherd_recall {"query":"<a real question>","want":"context"}
  confidence "weak"   noMatch false   threads 1
  windows 0   windowTokens 0   windowBudget 6000   windowsTruncated true
  readMore null
  (no "hits" key — `want:"context"` replaces it)
```

The one matching exchange is longer than the whole 6,000-token ceiling, so `windowsFrom`
(`recall.ts:486`) `continue`s past it and returns nothing. The agent that asked for context is handed
a reply that says it matched, contains no text, and — because
`readMore: windows.length === 0 ? null : '…'` — withholds the "`potsherd_read` the thread" sentence
in exactly the case where it is the only useful thing to say. Clipping the window, or emitting
`readMore` on the empty branch, would each fix it.

### C7 — smaller ★☆☆☆☆

- **`"though 1 rows were withheld below the weak floor"`** — the no-match note does not singularise.
  Live at the model door on the fully-embedded corpus. The project singularises elsewhere
  (`f.plural`), so this is one call site.
- **`ask` with no backend reports a capability failure under an emptiness headline**:
  `no grounded answer in 6 sessions searched` above `no reader could run, so nothing was read:
  claude --print could not answer: Not logged in`. The second line is exact and rescues it; the
  headline is still the wrong frame, and it is the same frame as C4's.
- **`potsherd_read`'s `seq` is per-session across a link**: `{"from":118,"to":121}` returns
  `seq 118, 119, 1, 2`. The `cite` field switches session at the right row so nothing is
  mis-attributed, but the `seq` an agent reads back is not monotone in the page it asked for.

---

## D. CLAIMS I CHECKED THAT HELD

1. **The three suites and the guard, on a clone I did not edit.** `pnpm test` **1,893 passed
   (1,893)** across **53 files**, `TEST_EXIT=0`; `pnpm typecheck` four `Done`, `TC_EXIT=0`;
   `python3 scripts/check-privacy.py` **`PRIV_EXIT=0`**, read from `$?` and not from its last line;
   `pnpm evals` `EVALS_EXIT=0` with `hybrid (auto) recall@5 51/60 (85%), recall@1 27/60`, `PASS`.
   Every claimed baseline reproduces exactly.
2. **`pnpm vendor` leaves no diff.** `vendored 2 files, 2.6 MB total`, `git status --porcelain` empty
   — the vendored bundles are the ones this build produces.
3. **Three MCP tools, disjoint, correctly annotated.** `potsherd_recall {query, scope, want, budget}`
   · `potsherd_read {thread, from, to}` · `potsherd_graft {thread, about, budget}`; recall/read
   `readOnlyHint: true`, graft `readOnlyHint: false, openWorldHint: true`. F7 is real.
4. **F1 — the honest empty, on two fresh controls, at three vector states.** Nonsense and the absent
   real-English topic both return `confidence "none"`, `noMatch true`, **zero rows**, at 0 vectors
   (keyword only), at 285 vectors with `vectors.used: true` (the hybrid path), and on a
   fully-embedded index. A real topic on the same corpus returns `strong`. The cliff exists and it
   is the audit's headline finding closed.
5. **F3 — a fabricated citation is refused in code, on both model paths.** Over MCP with a stub
   backend that emits `[deadbeef@7]`, `[deadbeef@9]`, `[deadbeef@12]`:
   `citations: [{"id8":"deadbeef","seq":7,"resolves":false}, …]`, the carrying lines are in
   `droppedLines`, and the brief says *"3 citations named an exchange this index does not have, and
   they were dropped."* Over `--filter-in`, a quote that is not in the transcript bytes is deleted
   (`evidence not-a-quote`) and the sentence resting on it with it (`sentence no-citation`).
6. **F4 — the thread is the unit and it is dated by content.** `<thread-A-head>` (the audit's
   4-exchange fixture) reports **123 exchanges** across 2 sessions, spans `2026-08-12 → 2026-08-20`,
   and `ls --since 2026-08-19 --until 2026-08-21` **includes** it — the fork-point date no longer
   corrupts the range filters. `potsherd_read {from:118,to:121}` crosses the link and switches the
   `cite` session at exactly the right row.
7. **F2 — the audit's three dead verbs run.** Semantic search acquires itself (`index` fetched the
   46.1 MB runtime and embedded unattended; I watched it reach 285 of 4,745 before I stopped it by
   its recorded pid), `ask` has `--readers-out/--readers-in/--synthesis-out/--filter-in` and the
   composed free path prints `no model call was made (0)`, and `find --json` now carries both
   `title` and `projectName` beside the absolute `project` (audit F9).
8. **`potsherd_graft` discloses and bounds its write.** Into an empty scratch cwd it created exactly
   `./.potsherd/graft-<id8>.md` and `./.potsherd/.gitignore`, reported both in `wrote`/
   `wroteGitignore`/`writeNote`, and `doctor --privacy` lists both with sub-lines.
9. **FIX-D's ordering did not silently filter anything.** 28 hits in the fused list, 28 in `hits[]`;
   10 blocks, 10 in `threads[]`. The reorder it does perform is real — the block with `agreement 0.5`
   (two lists found it) is promoted above a higher-fused-score block with `agreement 0` — which is
   defensible, but it means the CLI's first row and the model door's first row are now **different
   rows** for the same query. Recorded here rather than as a defect because both orders are
   explainable from published fields.
10. **`--no-embed` suppresses the background embedder.** `ps` immediately after: none. The leak in C1
    comes from the runs that do *not* pass it.

---

## E. WHAT I COULD NOT CHECK, AND WHY

1. **Whether CI is red on GitHub for `9ee2c6e`.** I reproduced the guard's failure locally, twice,
   on macOS/node 24 with the lockfile's `better-sqlite3`; I have no access to the four-way matrix
   and the pinned number is a file size, which is the kind of thing that can differ by platform.
   What I can say is that on a pristine clone `make-screens.sh` itself changes the committed screen.
2. **Linux and Windows for FIX-E.** Everything here is macOS, the same gap FIX-E declared.
3. **The `agent-sdk` rung.** `@anthropic-ai/claude-agent-sdk` is not installed in this clone and I
   did not install it — it is 677 MB against 3.6 GiB of free disk. FIX-E's §5.7 caveat stands
   unverified either way.
4. **A fully-embedded *real* archive.** The wasm embedder ran at ~46 units/minute; 4,745 units is
   ~100 minutes and it was starving the suite. I measured the `ready` branch on a corpus I built and
   embedded to completion (1 of 1) instead, which exercises the same branch of the same function.
5. **A 39-call `card --all` interrupt.** One backend, one signal. The registry is a `Set` and the
   handler is a map of two, so the shape is right, but I did not load it.
6. **The concurrent-`index` reliability check** (v3's "6 concurrent `index --quiet` → 1 embedder").
   I inherited nothing from it and did not re-run it; disk was the constraint. My C1 evidence is the
   opposite case — *separate roots*, where the lock cannot bind by construction.
7. **Whether `--filter-in`'s string-reply path was ever green.** I found the object form by reading
   `filterHostAnswer`; I did not bisect when the string form stopped working, or whether it ever did.
8. **`14-ask.txt`, `15-graft.txt`, `17-ls-cards.txt`.** They need a model backend;
   `make-screens.sh` printed *"no model backend — keeping the committed ask and graft screens"*, so
   I cannot say whether they are stale.

---

## F. MY ONE CHANGE, AND ITS REVERSION

To prove `tests/plugin-install.test.ts` can fail on the thing it exists to catch, I flipped one bit
in the vendored bundle. It is a 1.6 MB build artefact, so the change is described rather than
diffed:

```python
p = 'plugins/claude-code/dist/mcp.js'
b = bytearray(open(p,'rb').read())
i = len(b)//2                    # 815362
b[i] = b[i] ^ 0x01               # one byte, 'd' -> 'e'
open(p,'wb').write(bytes(b))
```

Red, with the byte named (§B3). Reverted immediately:

```
$ git checkout -- plugins/claude-code/dist/mcp.js && git status --porcelain
(empty)
```

The content-neutral probe (`cp vec.ts` over itself, `touch packages/mcp/src/index.ts`) changed no
bytes and left `git status --porcelain` empty throughout. `bash scripts/make-screens.sh` modified
four screens; I reverted them with `git checkout -- docs/screens` and confirmed the tree clean. The
clone's final `git status --porcelain` is empty, and I never wrote to
`/Users/zebra/randomness/potsherd` except to create this file.

---

## G. SETUP, CONTROLS, DISK

**Setup.** `git clone` of the repository to `…/scratchpad/v4/repo`, `git checkout 9ee2c6e`,
`pnpm install --frozen-lockfile && pnpm build` (exit 0). Scratch `HOME` at `…/scratchpad/v4/box/home`
built with `cp -Rc` from the seven harness directories; potsherd dir at `…/scratchpad/v4/box/pd`.
A second, tiny corpus at `…/scratchpad/v4/tiny` (one session, models directory APFS-cloned from the
first so nothing was re-fetched) for the fully-embedded state.

**Controls, invented after the freeze**, each confirmed at 0 files by `grep -ril` over the frozen
`HOME`: `zblorptik wemmadge fnuraskil` (nonsense) and `mastitis silage hoof trimming dairy herd`
(a real-English topic genuinely absent from a software archive). Neither appears in `WAVE.md`, in
`VERIFICATION{,-2,-3}.md`, or in the audit.

**Processes.** Every process I killed was one I started and whose pid I had recorded: the foreground
embedder (52081), five detached embedders left by my guard/repro runs (52824, 53001, 53571, 53623,
53685), one left by `make-screens.sh` (62380), and the stub grandchild that survived the untrack-gap
probe (51384). `ps` before, `kill <pid>`, `ps` after, in each case. No name pattern, no `killall`.

**Disk.**

```
before:  /dev/disk3s5   199Gi   164Gi   5.3Gi    97%    /System/Volumes/Data
during:  /dev/disk3s5   199Gi   165Gi   3.3Gi    99%    (five leaked embedders, five demo corpora)
after:   /dev/disk3s5   199Gi   164Gi   5.2Gi    97%    /System/Volumes/Data
```

The clone's `node_modules`, the 472 MB rescued archive, the 135 MB index and the throwaway corpora
are mine and are deleted; nothing of mine remains under `/Users/zebra/randomness/potsherd` except
this file.

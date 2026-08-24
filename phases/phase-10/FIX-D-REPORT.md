# FIX-D — the residue: a freshness test that could not fail, an order that argued with its own label, and one unexplained line

Branch `work/FIX-D`, cut from `15a31cf`. Four items: C4, C5a, C5b from
`VERIFICATION-3.md` §C, and C5c investigated.

Three of the four were real. **C5c is the most serious thing in this report and it
is not in my files** — the leak is live in the current tree, I reproduced it on
demand, and §4 carries the measured patch for a file I did not touch.

---

## 0. THE CLAIMS, CHECKED BEFORE FIXING

| item | verdict | the command, and what it printed |
|---|---|---|
| **C4** — the mtime test is falsely red on a content-neutral touch | **confirmed** | `cp packages/core/src/vec.ts /tmp/x && cp /tmp/x packages/core/src/vec.ts` — `git diff --stat` empty, and the old assertion evaluated by hand: `expect(1787579738048.0557).toBeGreaterThanOrEqual(1787579918295.1482) -> FAIL`. Content identical, mtime 180 s newer, test red. |
| **C4** — the test can be made to fail on a *real* drift | **confirmed, and it could not before in the way that matters** | see §2; the old one fails on both a real drift and a `cp`, which is why it stopped being read |
| **C5a** — `hits[]` order disagrees with `hits[].confidence` | **confirmed on the real server** | `sh plugins/claude-code/bin/potsherd-mcp` over stdio, demo corpus, 20 queries: 2 of the 9 that returned rows disagreed. `docker build cache` → `hit0 conf none` above `hit1 conf weak`; `flaky test timeout` → `hit0 weak, hit1 none, hit2 weak` |
| **C5a** — it reproduces in the committed fixture too | **confirmed** | `potsherd_recall {"query":"statement"}` against `tests/fixtures/claude` returned `none, strong` — the verifier's exact shape, in the unit suite. This is what makes the new fence falsifiable |
| **C5a** — `threads[]` has the same two axes | **confirmed as a shape, NOT reproduced as a defect** | 9 queries on the demo corpus, `threads[]` monotone in `confidence` every time. Fenced anyway (§1) |
| **C5b** — `.potsherd/.gitignore` is the only `writes:` entry with no sub-line | **confirmed** | `docs/screens/05-doctor-privacy.txt` line 41, between `graft-<id8>.md` (has one) and `ask --readers-out` (has one) |
| **C5b** — the README copy is diffed by CI | **confirmed** | `.github/workflows/ci.yml:227-252`, the python block; and `:216-223`, the screen against a live `doctor --privacy` in a relocated HOME |
| **C5c** — the suite leaks long-lived children | **CONFIRMED, and live today** | `npx vitest run tests/llm.test.ts -t "never hangs"` finished in **2.33 s**; 23 s later `ps` showed **three** `sleep 30` processes with **PPID 1**. Same count, same mechanism, different payload as the verifier's three `hang.mjs` |
| **C5c** — `hang.mjs` exists in the tree | **FALSE** | `grep -rn 'hang.mjs' .` → only `VERIFICATION-3.md` and `WAVE.md`. `git log --all -S 'hang.mjs'` → the same two commits. It never existed as a file here |

Nothing in the four turned out to be a non-defect. C5c turned out to be *worse*
than filed: it is not "an older run leaked something", it is "every run leaks,
and only the payload's own `sleep` hides it".

---

## 1. WHAT CHANGED, AND WHY THAT SHAPE

### C4 — `tests/plugin-install.test.ts`

The old body took the newest `mtimeMs` under `packages/**/*.ts` and required the
vendored bundle to be at least that new. That makes the premise **the
filesystem**: a `cp`, a `touch`, a `git checkout` away and back, a rebase, or a
fresh clone (git stamps every file with the checkout time) turns it red while
nothing about the content moved. `09 §7.2` / rule 7.

It now compares **content, and specifically the content `pnpm vendor` computes**.
`scripts/vendor-plugin.mjs` is one `ARTIFACTS` list and a `copyFileSync` per
entry; "the bundle this build produces" is its left column and the committed
bundle is its right one, so the assertion is that those two files are
byte-identical. That is the same property CI already states as *"the vendored
plugin bundles are the ones this build produces"* (`ci.yml:96-104`, which runs
the vendor script and diffs `plugins/`) — reproduced in the suite without writing
into the working tree.

Two details that are not decoration:

- **The pair list is pinned to the vendor script's own text** before it is used.
  That script is a top-level program that copies files and `process.exit`s, so it
  cannot be imported; restating its list unpinned would have been exactly the
  "second notion" the item warned about. A third artefact, a rename or a moved
  output path now fails on the pin instead of leaving the test quietly checking a
  pair nothing writes.
- **The failure message carries the two sizes and the first differing byte**, not
  a 1.6 MB buffer diff — enough to tell a stale bundle from the wrong file. And
  it still names `pnpm build && pnpm vendor`.

The hop this does **not** cover is said out loud in the docblock: source →
`packages/*/dist` is the build, `packages/*/dist` → `plugins/` is the vendor, and
this pins the second. The first is pinned by CI building before it tests, and by
`tests/plugin-bundle.test.ts`'s VERSION assertions. I did not run a build inside
the test to close it: six other test files already `execFileSync('node',
['build.mjs'])` into `packages/cli/dist` from parallel workers, and adding a
concurrent reader of a file those workers rewrite would have replaced one
environmental flake with another.

### C5a — `packages/mcp/src/tools/recall.ts`, **option (i)**

Order by the label. `hits[]` is sorted by

1. `confidence` — **the word, not `calibration.score`**;
2. `calibration.score`, within a band;
3. the fused RRF `score`, as the last tie-break.

Why the word and not the number, which is the one thing the item did not
anticipate: `calibration.score` can be **capped**. A routing row scoring 0.92 is
labelled `weak` by `ROUTING_CEILING` and the score is deliberately *not* rewritten
(`calibration.ts:545-555`). Sorting on `calibration.score` alone would therefore
have put a card back on top of a transcript — the same defect with different
arithmetic behind it. Sorting on the word makes order and label agree by
construction, and F6 survives it: a card can never reach `strong`, so it can never
take the top row from a transcript. There is a test for exactly this.

**Nothing is recomputed and nothing is filtered.** `orderByLabel` reads
`confidence` and `calibration.score` off rows core already labelled — the same
discipline as the rest of the file — moves them, and returns the same objects. The
floor, `belowFloor`, `noMatch` and the set of rows are untouched, which is why (i)
cannot degrade retrieval: it changes no membership, and `want:"context"` windows
are built from `sessions[].hits`, not from this list, so they are unaffected.
A build whose core carries no label at all keeps the merge order — `null` is not
`none`, and with no label there is nothing for the order to contradict.

I applied the same call to **`threads[]`**. It is the list an agent actually picks
a thread from, it carries the identical two axes, and leaving it would have been
fixing the half that happened to be named. Measured over nine queries on the demo
corpus it reorders **nothing** — core's block order and the block label already
agree there — so it is a fence, not a change of ranking, and it is described that
way in the code.

I did **not** take option (ii). There was nothing to trade: no measurement moves.

### C5b — `packages/cli/src/commands/doctor.ts`

One `else if` in the note ladder under `writes:`, in the receipt's own register:

> written once, the first time you run graft here, and never overwritten:
> it is what keeps the briefs out of your commits

Both halves are true of the code: `ensureGraftDir` (`core/graft.ts:1292`) writes
`*` into that file only when it is absent, and never clobbers one a user has
written. Then `bash scripts/make-screens.sh` regenerated the screen and README's
block was respliced from it byte for byte.

---

## 2. THE ARTIFACTS — one per item

### C4 — red on a real drift, green on a content-neutral touch, both real runs

**(a) a byte-for-byte `cp`, which is what the verifier did.** `cp` out and back,
`git diff` empty, source mtime 180 s newer than the bundle:

```
source mtimeMs 1787579918  packages/core/src/vec.ts
bundle mtimeMs 1787579738  plugins/claude-code/dist/mcp.js

OLD assertion: expect(1787579738048.0557).toBeGreaterThanOrEqual(1787579918295.1482)  -> FAIL

$ npx vitest run tests/plugin-install.test.ts
 ✓ tests/plugin-install.test.ts (14 tests) 689ms
      Tests  14 passed (14)
```

**(b) a real content change to a source file, built, not vendored — RED.** One
string literal in `packages/mcp/src/tools/recall.ts`, `pnpm build`, no vendor:

```
 FAIL  tests/plugin-install.test.ts > the plugin directory, installed on its own under a commonjs parent
       > the vendored bundles are byte-for-byte the bundles this build produces
AssertionError: plugins/claude-code/dist/mcp.js is not what packages/mcp/dist/index.js builds
  (1629261 bytes committed, 1629292 built, first difference at byte 1572783)
  — run: pnpm build && pnpm vendor: expected 1572783 to be -1

      Tests  1 failed | 13 passed (14)
```

and the remedy the message names actually works — `pnpm vendor`, nothing else,
same drift still in the source:

```
      Tests  14 passed (14)
```

Then the probe was reverted, rebuilt and re-vendored. **It fired a third time on
its own**, unplanned: while I was measuring the C5c patch (§4) I edited
`packages/core/src/llm.ts`, rebuilt, and ran the full suite — the only failure in
1,890 was this test, naming `potsherd.js`, `first difference at byte 307838`. A
freshness test that catches a drift you did not mean to leave is the one that was
asked for.

### C5a — the real MCP server, before and after

`sh plugins/claude-code/bin/potsherd-mcp`, driven over stdio with `initialize` +
`notifications/initialized` + `tools/call`, `HOME` relocated to a synthetic demo
corpus (`scripts/make-demo-corpus.mjs`), `--potsherd-dir` a scratch directory,
`POTSHERD_OFFLINE=1`. **Before** is the committed vendored bundle at `15a31cf`;
**after** is the same server binary re-vendored from the fix. Same index, same
query, same process.

```
stderr: potsherd-mcp 1.2.0 ready · 3 tools · index <scratch>/pd
potsherd_recall {"query":"docker build cache"}
  capability  = "keyword search only — semantic search is warming (0 of 3,410 embedded)"
  confidence  = "strong"      hits = 24

BEFORE
  hit0  score 0.016393  conf none    calibration.score 0.5667  not-a-transcript  kind=title
  hit1  score 0.009836  conf weak    calibration.score 0.5667  transcript        kind=exchange
  hit2  score 0.009677  conf none    calibration.score 0.2612  transcript        kind=exchange
  hit3  score 0.009677  conf none    calibration.score 0.2833  transcript        kind=ghost
  hit4  score 0.009524  conf none    calibration.score 0.2603  transcript        kind=exchange
  hit5  score 0.009375  conf weak    calibration.score 0.5206  transcript        kind=exchange

AFTER
  hit0  score 0.009836  conf weak    calibration.score 0.5667  transcript        kind=exchange
  hit1  score 0.009375  conf weak    calibration.score 0.5206  transcript        kind=exchange
  hit2  score 0.016393  conf none    calibration.score 0.5667  not-a-transcript  kind=title
  hit3  score 0.008219  conf none    calibration.score 0.4539  transcript        kind=exchange
  hit4  score 0.009677  conf none    calibration.score 0.2833  transcript        kind=ghost
  hit5  score 0.009091  conf none    calibration.score 0.2712  transcript        kind=ghost
```

The before-row 0 is the worst possible first row: a **card**, marked
`not-a-transcript`, labelled `none` — *the archive does not contain this* — sitting
at the top of a reply whose envelope says `strong`, above a real transcript
labelled `weak`. It leads on fused score because RRF put it at rank 1 of its list,
which is a fact about the merge and not about the answer. Afterwards it is third,
under both `weak` transcripts, and still present with every field intact.

`flaky test timeout` on the same server went `weak, none, weak, weak, none…` →
`weak, weak, weak, weak, weak, none…`. Across 8 queries after the fix, 0
disagreements; 2 of 9 before.

### C5b — the receipt block, from a live `doctor --privacy`

Captured the way `ci.yml` captures it — demo corpus, relocated `HOME`, stub
`claude` on PATH, run from `~/work/demo-project`:

```
  writes:
    ~/.potsherd
    ~/.potsherd/archive
    ~/.potsherd/potsherd.db
    ~/.potsherd/models
    ~/.potsherd/config.json
      your settings: the ignore list, written by potsherd ignore / unignore
    ~/work/demo-project/.potsherd/graft-<id8>.md
      only when you run graft, in the directory you run it in
    ~/work/demo-project/.potsherd/.gitignore
      written once, the first time you run graft here, and never overwritten:
      it is what keeps the briefs out of your commits
    <the path you give to  ask --readers-out>
      only when you pass the flag. it holds the same redacted excerpts a model
      would have been sent, and no model was called to write it
```

Both CI checks reproduced by hand, both green:

```
$ diff -u <(norm docs/screens/05-doctor-privacy.txt) <(norm "$home/live.txt")
SCREEN MATCHES LIVE

$ python3 <the block from ci.yml> docs/screens/05-doctor-privacy.txt README.md
readme quotes the receipt verbatim (127 lines)
EXIT=0
```

### C5c — the leak, on demand

```
$ npx vitest run tests/llm.test.ts -t "never hangs"
      Tests  2 passed | 131 skipped (133)
   Duration  2.33s

$ ps -eo pid,ppid,etime,command | grep "sleep 30"      # 23 s later
91761     1       00:23 sleep 30
91763     1       00:23 sleep 30
91766     1       00:22 sleep 30
```

Three orphans, PPID 1, alive long after the run that made them. The mechanism,
isolated and reproduced on this machine with nothing of potsherd's in it:

```
== fakeBin body = "sleep 61", child.pid=91600          # what tests/llm.test.ts:1243 writes
91600 91598 /bin/sh /tmp/.../fakebin
91612 91600 sleep 61
  after child.kill(SIGKILL):  SURVIVES ->
91612     1 sleep 61

== fakeBin body = "true\nsleep 62"
91624     1 sleep 62                                    # same
```

`/bin/sh` forks the command; `child.kill('SIGKILL')` signals one pid; the
grandchild is reparented to launchd. It is bounded today only because the payload
is `sleep 30`. Swap in a payload that never exits — `node .../hang.mjs` — and the
orphan lives until reboot. **That is the provenance of the verifier's three
`hang.mjs` processes**, and it explains the count.

---

## 3. THE NUMBERS

| | |
|---|---|
| files changed vs `15a31cf` | **8** — 2 source, 2 test, `docs/screens/05-doctor-privacy.txt`, `README.md`, 2 vendored bundles |
| diff | `+324 / −25` |
| **effective code lines** (comments and blanks excluded) | `doctor.ts` **5** · `mcp/tools/recall.ts` **30** · `plugin-install.test.ts` **60** · `mcp.test.ts` **76** |
| `pnpm test` | `Test Files 53 passed (53)` / **`Tests 1890 passed (1890)`** — was 1,883, **+7 new, 0 regressions** |
| `pnpm typecheck` | **4 of 4** packages `Done` |
| `python3 scripts/check-privacy.py` | **EXIT CODE 0** *(read from `$?`, not from the last line)* |
| `pnpm build && pnpm vendor` | run after every `packages/` change; `git status plugins/` **clean** |
| ci.yml privacy receipt — screen vs live | reproduced by hand, **match** |
| ci.yml privacy receipt — README vs screen | reproduced by hand, **verbatim, 127 lines** |
| C4 red-then-green | §2, three separate reds, one unplanned |
| C5a red-first | with `orderByLabel` unwired: **4 of 7 fail**, including `statement: hit0 is none above hit1 strong` |

The three C5a tests that stay green with the fix unwired are deliberate guards, in
FIX-C's pattern: membership is unchanged by the sort, a build with no label keeps
the merge order, and those two must not become sensitive to the ordering.

Evidence directory, outside the repository — `<scratchpad>/fix-d-evidence`, whose
absolute path is handed to the orchestrator directly rather than written here
(it embeds a session uuid, which `check-privacy.py`'s id ratchet correctly
refuses) — `before-probe.json`, `after-probe.json`, `threads-probe.json` (raw MCP
envelopes), `c4-red.txt`, `c5a-red.txt`, `llm-leak-run.txt`,
`suite-with-c5c-patch.txt`, `05-live-receipt.txt`, `c5c.patch`, and the demo
`home/` and `pd/` the server ran against. No real session id, project name or
transcript line is in it or in this file.

---

## 4. C5c — THE PATCH, FOR A FILE THAT IS NOT MINE

The leak is in `packages/core/src/llm.ts`, which is not on my DELIVER list. **I did
not ship this.** I applied it, measured it, and reverted it; `llm.ts` is
byte-identical to `HEAD` and the tree is clean.

**Where.** `packages/core/src/llm.ts:2290` spawns without a process group and both
exit paths — the timeout at `:2301` and the abort at `:2315` — call
`child.kill('SIGKILL')`, which reaches one pid. `tests/llm.test.ts:1243`'s
`fakeBin` writes `#!/bin/sh\n${body}\n` with no `exec`, so the direct child is
always a shell. Every harness CLI in the wild is the same shape.

**Measured with the patch applied:**

- `npx vitest run tests/llm.test.ts -t "never hangs"` → 2 passed, and 3 s later
  `ps` shows **no orphaned `sleep 30`**. Before: three, PPID 1.
- `pnpm test` → **1,889 of 1,890 passed.** The single failure was C4's own new
  test, correctly reporting that `packages/core/src/llm.ts` had been rebuilt and
  not re-vendored.
- `pnpm --filter ./packages/core build` → clean.

```diff
--- a/packages/core/src/llm.ts
+++ b/packages/core/src/llm.ts
@@ -2291,14 +2291,42 @@
       env: o.env as NodeJS.ProcessEnv,
       ...(o.cwd ? { cwd: o.cwd } : {}),
       stdio: ['pipe', 'pipe', 'pipe'],
+      // Its own process group, so the two kills below can reach what the
+      // backend spawned as well as the backend. Not `unref`ed: this promise
+      // still waits for it.
+      detached: true,
     });
     let stdout = '';
     let stderr = '';
     let settled = false;
+    /**
+     * Kill the backend **and everything it started.**
+     *
+     * `child.kill()` signals one pid. Every harness CLI here is a shell script
+     * or a launcher that forks the real work, so on the timeout path the
+     * launcher died and its child was reparented to init and kept running --
+     * measured: the suite's two `never hangs` cases leave three orphaned
+     * `sleep 30` processes with PPID 1 for ~30 s after vitest has exited, and
+     * a payload that does not exit on its own leaves them forever. That is
+     * what left three `hang.mjs` processes alive on a machine for two days.
+     *
+     * `detached: true` above gives the child a process group of its own, and a
+     * negative pid signals the group. `child.kill` remains the fallback for a
+     * platform with no process groups and for the race where the group has
+     * already gone (ESRCH).
+     */
+    const killTree = (): void => {
+      try {
+        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
+      } catch {
+        // already gone, or no process groups here
+      }
+      child.kill('SIGKILL');
+    };
     const timer = setTimeout(() => {
       if (settled) return;
       settled = true;
-      child.kill('SIGKILL');
+      killTree();
       reject(
         new LlmError(
           `${path.basename(bin)} did not answer within ${Math.round(o.timeoutMs / 1000)}s`,
@@ -2312,7 +2340,7 @@
       if (settled) return;
       settled = true;
       clearTimeout(timer);
-      child.kill('SIGKILL');
+      killTree();
       reject(new LlmError('the model call was cancelled'));
     };
     o.signal?.addEventListener('abort', onAbort, { once: true });
```

**One consequence to weigh before landing it, which I could not settle from here.**
`detached: true` takes the child out of the terminal's foreground process group,
so a Ctrl-C at a `potsherd card` prompt no longer reaches the spawned `claude`
directly — it reaches potsherd, which must then abort. The abort path already
exists (`o.signal` → `onAbort` → `killTree`), so the behaviour is preserved *if*
every caller wires a signal; the verbs that do not would leave the backend running
until its own timeout. `killTree` without `detached: true` is a strictly smaller
change that fixes nothing, so the two go together or neither does. Whoever lands
it should check the Ctrl-C path on `card` and `ask`.

**A second, unpatched leak worth a line.** `packages/cli/src/commands/index.ts:258`
spawns the background embedder `detached: true` + `unref()` with **no kill path
anywhere**, by design. Every test that runs the real CLI `index` starts one. It is
bounded today only by `tests/setup.ts:33` setting `POTSHERD_OFFLINE=1`, which makes
`acquire()` throw immediately — an env var, not code. Run the suite with the
documented `POTSHERD_TEST_EMBED=1`, or on a machine whose sandbox root already has
the model cached, and each of those becomes a multi-hour embedding pass with no
owner. `VERIFICATION-3.md` §D9 already records the product-side half of this
("there is no verb to stop it"). Not fixed here, not filed as mine, recorded.

---

## 5. WHAT I COULD NOT DO

1. **Close C4's first hop — source → `packages/*/dist` — inside the suite.** The
   test pins vendor, not build. Building inside it would need `tsc` for
   `@potsherd/core` (which the CLI and MCP bundles resolve through `dist`), and
   `packages/cli/dist` is already rewritten concurrently by six other test files;
   a reader racing those writers trades one environmental flake for another. CI
   builds before it tests, so the hop is covered there. Said out loud in the
   docblock rather than left to be discovered.
2. **Reproduce a `threads[]` disagreement.** Nine queries on the demo corpus, all
   monotone. The fence is in and it is honest, but unlike the `hits[]` fence I have
   no query that makes it go red, so it is a guard rather than a proof.
3. **Measure C5a against a warm index.** The demo corpus was indexed at 0 of 3,410
   embedded (`POTSHERD_OFFLINE=1`), so every measurement is bm25-only. Ordering
   reads `confidence` and `calibration.score` off the rows whatever produced them,
   so the vector half changes which rows arrive and not how they are ordered — but
   I did not run it hybrid.
4. **Land the C5c fix.** `packages/core/src/llm.ts` and `tests/llm.test.ts` are
   outside my DELIVER list. §4 is the exact patch, applied and measured, then
   reverted.
5. **Regenerate `docs/screens/13-find-redacted.txt`, which is stale.**
   `make-screens.sh` regenerated it and it carries a **real** change, not timing
   noise — FIX-C's `core/recall.ts:1467` edit reached the human `find` footer:

   ```diff
   -  text search only — no embeddings in the index — run potsherd index --embed
   +  text search only — no embeddings in the index yet
   ```

   The committed screen still publishes the string FIX-C deleted, and **no CI step
   diffs that screen against a live run** — only `04-doctor.txt` and
   `05-doctor-privacy.txt` have one. It is outside my DELIVER list so I reverted
   it; the one-line change above is the whole of it, and it will not be caught by
   anything until someone runs `make-screens.sh` again.
   (`07-index.txt` and `09-find.txt` also regenerated, with millisecond timings
   only; reverted, nothing to carry.)
6. **Run `pnpm evals`.** `tests/evals-gate.test.ts` runs it inside the suite and
   passes; I did not run it standalone. C5a changes no membership, so recall@k
   cannot move — but that is an argument, not a measurement.

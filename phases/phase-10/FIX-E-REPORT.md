# FIX-E — the backend potsherd kills stays dead, and a screen stops giving an order the product deleted

Branch `work/FIX-E`, cut from `cd55cb8`. Three items: the orphaned model backend
(FIX-D §4), the stale `13-find-redacted.txt` (FIX-D §5.5), and the background
embedder investigated but not touched.

**The headline is not the fix, it is what the fix's blocker turned out to be.**
The brief's central worry — that `detached: true` would trade a background leak
for a foreground one, because "today Ctrl-C works by accident" — is **false, and
I measured it both ways.** Today's Ctrl-C at a live model call already leaks:
the launcher dies and what the launcher forked survives, because a background
job in a non-interactive shell has SIGINT set to ignore. SIGKILL to a process
group cannot be ignored. So the shape below does not defend a Ctrl-C path, it
**fixes one**, and §2 has both runs.

---

## 0. THE CLAIMS, CHECKED BEFORE FIXING

| item | verdict | the command, and what it printed |
|---|---|---|
| **1** — the leak is live and reproducible on demand | **confirmed, and one worse than filed** | `npx vitest run tests/llm.test.ts -t "never hangs"` → 2 passed, `Duration 2.38s`; `ps -eo pid,ppid,etime,command` immediately after → **four** `sleep 30`, all `PPID 1` (the brief and FIX-D say three; it is two per case, one per attempt, because a timed-out call is retried once) |
| **1** — `llm.ts:2290` spawns with no process group and both exits `child.kill` one pid | **confirmed** | the file; and the `PGID` column in §2's first `ps` — before the fix the backend and its `sleep` share potsherd's own group |
| **1** — no caller wires a signal, and there is no SIGINT handler in the CLI | **confirmed** | `grep -rn "SIGINT" packages/cli/src` → no matches; `grep -rn "signal" packages/cli/src/commands/ask.ts packages/cli/src/commands/card.ts` → no matches |
| **1** — "there is no SIGINT handler *anywhere* in the product" | **FALSE, and the exception matters** | `grep -rn "SIGINT" packages/mcp/src` → `packages/mcp/src/index.ts:136`. The MCP server installs one and it ends in `process.exit(0)`, so before this change a `potsherd_ask` in flight was orphaned *deliberately* on every editor shutdown. It is why the new handler is synchronous — see §1 |
| **1** — "Ctrl-C works today by accident; `detached` would create a foreground leak" | **FALSE** | real `potsherd` + real backend + real `kill(-pgid, SIGINT)` on the **unfixed** build: potsherd exits 130, the `sh` dies, and the `sleep 300` it forked is **alive with PPID 1**. §2. The foreground leak already exists; the fix closes it |
| **2** — `13-find-redacted.txt` publishes a string FIX-C deleted | **confirmed** | `bash scripts/make-screens.sh` → the screen's only content change is `- text search only — no embeddings in the index — run potsherd index --embed` / `+ text search only — no embeddings in the index yet`. `07`/`09` regenerate with millisecond timings only, and are reverted |
| **2** — CI diffs exactly two of the seventeen screens | **confirmed** | `ci.yml` had one live diff (`05-doctor-privacy.txt`, `:216-223`) and one grep (`04-doctor.txt`, `:271-283`). Fifteen screens had no guard of any kind |
| **3** — `cli/src/commands/index.ts:258` spawns `detached` + `unref` with no kill path | **confirmed** | the file, and `grep` over all 22 registered verbs: none of them stops anything. `doctor` does not report the embed lane's holder either, so the pid is not even shown |
| **3** — it is bounded today only by `POTSHERD_OFFLINE=1` in `tests/setup.ts:33` | **confirmed, and the bound is weaker than that** | the offline flag is read by `embeddings.offline()` **inside the child**. The parent's decision to spawn does not consult it at all: `index --full` with `POTSHERD_OFFLINE=1` still spawns one. §4 |

---
## 1. WHAT CHANGED, AND WHY THAT SHAPE

### Item 1 — `packages/core/src/llm.ts`: the child, the registry, and one handler

Three things, and the second and third exist only because of the first.

**(a) `detached: true` on the spawn, and both kill paths signal the group.**
`child.kill()` reaches one pid. Every harness CLI on this path is a shell script
or a launcher that forks the real work — `tests/llm.test.ts`'s own `fakeBin`
writes `#!/bin/sh\n${body}\n` with no `exec` for exactly that reason — so the
timeout at `:2301` and the abort at `:2315` killed the launcher and left its
child reparented to init. `killBackendTree` sends `SIGKILL` to `-pid`, with
`child.kill` kept as the fallback for the ESRCH race and for a platform with no
process groups.

**(b) A module-level registry of live children.** `trackBackend` adds the child
after `spawn` and removes it on `exit`/`close`, both, and idempotently: `exit`
is the accurate one and `close` is the only one that fires when the spawn itself
failed and there was never a process.

**(c) One lazily-installed handler per fatal signal**, installed when the set
goes empty→non-empty and removed when it returns to empty. It kills every live
tree, uninstalls itself, and **re-raises the signal** rather than calling
`process.exit`: with no listener left node restores the default disposition, so
potsherd dies *of* the signal and a shell reads 130 instead of whatever code an
exit inside a handler happened to pass.

Three details in (c) are load-bearing and are commented as such in the file:

- **It is a map, not a listener per child.** `process` warns at ten listeners
  and this suite already prints two `MaxListenersExceededWarning` lines of its
  own (on a `[Socket]`, unrelated); a reader fan-out registering one apiece
  would have buried them. Two listeners exist at most, whatever the fan-out —
  there is a test, and it is red on the unfixed code.
- **Every step of it is synchronous.** The MCP server's own SIGINT handler
  (`packages/mcp/src/index.ts:136`) ends in `process.exit(0)`, node runs
  listeners in registration order, and ours is always registered later —
  anything deferred to a later tick would lose the race with that exit and leak
  the child it was installed to kill.
- **It uninstalls before re-raising**, so it cannot re-enter itself.

**Why this differs from FIX-D §4's patch.** FIX-D's patch is (a) and nothing
else, and it measured (a) honestly: orphans gone, suite green. What it does not
have is any owner for the child between the two kill paths. Its own caveat named
the hole and left it open — "the behaviour is preserved *if* every caller wires a
signal" — and no caller does. Under FIX-D's patch a Ctrl-C during `card --all`
would have reached potsherd, potsherd would have died with no handler, and 1 of
~39 backends would have been left in a process group nothing owned, permanently.
(b) and (c) are what close that: the module that spawns the child is the module
that kills it, for as long as it is alive, without asking 22 verbs to remember
to. The measured difference is in §2: on FIX-D's patch the group signal never
reaches the backend and nothing else does either; on this one the backend and
what it forked are both gone and potsherd still exits 130.

**What I considered and did not take.** A tree walk (`pgrep -P`, recursively, at
kill time) fixes the orphan with no `detached` and no handler at all, and is
smaller. I did not take it: it cannot see the case that produced this defect. A
launcher that forks and is then killed leaves a grandchild whose parent is now
init — there is no longer an edge to walk — whereas process-group membership is
inherited and survives reparenting exactly. Smaller is better, but not when the
smaller thing misses the failure it is for.

**One gap, stated in the code rather than left to be found.** A launcher that
forks the real work and **exits immediately** untracks itself while its child
lives, so a Ctrl-C after that moment has nothing left to kill. The timeout and
abort paths still reach it — they fire while the child is tracked. The
alternative, holding a process group nothing owns for the lifetime of potsherd,
kills work a harness deliberately backgrounded.

### Item 2 — `docs/screens/13-find-redacted.txt`, and the guard in `ci.yml`

The screen was regenerated with `bash scripts/make-screens.sh` and committed
whole, timings included, because these files are verbatim stdout and editing one
line of a capture is the thing the script's own header forbids. `07-index.txt`
and `09-find.txt` regenerated with millisecond noise only and are reverted; the
three model screens keep their committed copies, which is what the script does
with no backend.

The guard is a **live diff of ten screens**, not a string search, and the
reasoning is in `09 §9`: the cheaper guards I could write are all coarser than
the defect. A "every `potsherd <verb> --<flag>` in a screen is a flag the CLI
still accepts" check **passes on this exact violation** — `--embed` is still a
flag, it is the *sentence* that is dead. A "no screen contains a string the
source no longer produces" check passes too, at command granularity:
`potsherd index --embed` still appears verbatim in `core/ingest.ts:1163`. The
only thing that catches what actually happened is running the command and
comparing.

So the step rebuilds the demo corpus in a throwaway HOME, replays
`make-screens.sh`'s capture order, and diffs `01, 06, 02, 03, 08, 09, 10, 11,
12, 13`. Its comment names what it does not cover, as an open item and not as
boilerplate: the three model screens, `16` (two commands and a shell listing),
`07` (`masked this run` counts what *this* pass masked, and its `fetching
46.1 MB, once` line depends on whether the runner already has the model — a fact
about the machine), `04`/`05` (their own steps), every duration and the heading
date, which are normalised away, and — the one worth reading twice — any string
only a *different* corpus reaches. A screen diff proves the screen is what this
build prints for the demo corpus, and nothing about a branch that corpus never
enters.

---

## 2. THE ARTIFACTS — one per item, all real runs

### Item 1 (a) — the payload processes, before and after, `ps` after the run

**Before** — `HEAD` at `cd55cb8`. The run finishes in 2.38 s; the `ps` is taken
immediately after vitest has exited:

```
$ npx vitest run tests/llm.test.ts -t "never hangs"
 ✓ tests/llm.test.ts (133 tests | 131 skipped) 1228ms
   ✓ claude -p backend plumbing > never hangs: a silent backend hits the timeout 617ms
   ✓ codex backend plumbing > never hangs: a silent backend hits the timeout 609ms
      Tests  2 passed | 131 skipped (133)
   Duration  2.38s

$ ps -eo pid,ppid,etime,command | grep "[s]leep 30"
 8657     1       00:04 sleep 30
 8659     1       00:04 sleep 30
 8663     1       00:03 sleep 30
 8666     1       00:03 sleep 30
```

Four, `PPID 1`, alive after the process that made them is gone. Two per case:
one per attempt, because a timed-out call is retried once.

**After** — the same two cases on this branch:

```
=== ps for the payload BEFORE the run (with the fix in the tree)
(none)

=== npx vitest run tests/llm.test.ts -t "never hangs"
 ✓ tests/llm.test.ts (136 tests | 134 skipped) 1235ms
   ✓ claude -p backend plumbing > never hangs: a silent backend hits the timeout 616ms
   ✓ codex backend plumbing > never hangs: a silent backend hits the timeout 616ms
      Tests  2 passed | 134 skipped (136)
   Duration  2.26s (transform 600ms, setup 17ms, collect 769ms, tests 1.24s, environment 0ms, prepare 55ms)

=== ps 3 s after vitest exited
(none)
```

### Item 1 (b) — the new tests, red on the unfixed code

Three tests, all driving a **real spawn** whose payload outlives its own shell.
`llm.ts` reverted to `HEAD`, the tests as committed:

```
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/llm.test.ts > a killed backend takes what it started with it > on the timeout path: the grandchild is dead, not reparented to init
AssertionError: expected [ 18815, 18819 ] to deeply equal []

- Expected
+ Received

- Array []
+ Array [
+   18815,
+   18819,
+ ]

 ❯ tests/llm.test.ts:1970:48
    1968|       pids = readPids(pidFile);
    1969|       expect(pids.length).toBeGreaterThan(0);
    1970|       expect(await allGoneWithin(pids, 5_000)).toEqual([]);
       |                                                ^
    1971|     } finally {
    1972|       reap(pids);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/3]⎯

 FAIL  tests/llm.test.ts > a killed backend takes what it started with it > on the abort path: the same, when the caller cancels
AssertionError: expected [ 18843 ] to deeply equal []

- Expected
+ Received

- Array []
+ Array [
+   18843,
+ ]

 ❯ tests/llm.test.ts:1994:48
    1992|       ac.abort();
    1993|       await pending;
    1994|       expect(await allGoneWithin(pids, 5_000)).toEqual([]);
       |                                                ^
    1995|     } finally {
    1996|       reap(pids);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/3]⎯

 FAIL  tests/llm.test.ts > a killed backend takes what it started with it > installs one signal handler however many backends are live, and takes it back off
AssertionError: expected [ +0, +0 ] to deeply equal [ 1, 1 ]

- Expected
+ Received

  Array [
-   1,
-   1,
+   0,
+   0,
  ]

```

The first two numbers are pids the test read out of the stub's own pid file and
then asked the operating system about: the grandchildren the kill path did not
reach. On this branch all three pass, and the group runs clean 8 times in a row.

### Item 1 (c) — a real SIGINT to a real potsherd with a live backend

`potsherd card --probe --backend codex`, a throwaway `HOME`, a stub `codex` that
is a shell script forking `sleep 300` — the shape of every harness CLI.
potsherd is started under `setsid`, so it leads its own process group exactly as
it does when a shell runs it in the foreground, and the signal is sent to that
**group**, which is what the tty driver does at Ctrl-C.

**On the unfixed build** — this is the measurement that inverts the brief:

```
$ potsherd card --probe --backend codex   (stub `codex` = a shell script that forks `sleep 300`)
potsherd pid  = 19950
backend (sh)  = 19951   alive=True
what it forked= 19956   alive=True
  PID  PPID  PGID COMMAND
19950 19949 19950 node <repo>/packages/cli/bin/potsherd.js card --probe --backend codex --potsherd-dir <scratch-root> --no-color
19951 19950 19950 /bin/sh <throwaway-home>/bin/codex exec --skip-git-repo-check --ephemeral --ignore-user-config --cd <scratch-cwd> --model haiku --output-last-message <scratch-cwd>/last-message.txt -
19956 19951 19950 sleep 300

--- kill(-19950, SIGINT)   # the tty's Ctrl-C: the whole foreground group
potsherd exit: returncode=-2  -> killed by signal 2, a shell reads 130

after the signal:
  PID  PPID  PGID ELAPSED COMMAND
19956     1 19950   00:01 sleep 300
STILL ALIVE: [('grandchild', 19956)]
```

The `sleep` survives a terminal Ctrl-C **today**. It is not reached by the group
signal's default action because a background job in a non-interactive shell has
SIGINT set to ignore; only the launcher dies. Ctrl-C at a `card --all` prompt
therefore already leaves one live model process per interrupted call, and
`ps` will say `PPID 1`.

**On this branch**, same harness, same signal:

```
$ potsherd card --probe --backend codex   (stub `codex` = a shell script that forks `sleep 300`)
potsherd pid  = 19746
backend (sh)  = 19749   alive=True
what it forked= 19755   alive=True
  PID  PPID  PGID COMMAND
19746 19745 19746 node <repo>/packages/cli/bin/potsherd.js card --probe --backend codex --potsherd-dir <scratch-root> --no-color
19749 19746 19749 /bin/sh <throwaway-home>/bin/codex exec --skip-git-repo-check --ephemeral --ignore-user-config --cd <scratch-cwd> --model haiku --output-last-message <scratch-cwd>/last-message.txt -
19755 19749 19749 sleep 300

--- kill(-19746, SIGINT)   # the tty's Ctrl-C: the whole foreground group
potsherd exit: returncode=-2  -> killed by signal 2, a shell reads 130

after the signal:
  PID  PPID  PGID ELAPSED COMMAND
STILL ALIVE: none — the backend and what it forked are both gone
```

Note the `PGID` column in both: unfixed, the backend is in potsherd's own group
(`19950`); fixed, it has one of its own (`19749`) and the terminal's signal
cannot reach it at all — the handler does, with SIGKILL, which nothing can
ignore. potsherd still exits **130** either way.

The same harness with the signal sent to potsherd's **pid alone** (`kill -INT
<pid>`, an editor or a supervisor rather than a tty) is the sharper version of
the same result: unfixed, *both* the launcher and the `sleep` are left alive
(`STILL ALIVE: [('sh', 19963), ('grandchild', 19968)]`); on this branch, neither.

### Item 2 — the CI step, seeded with the violation that actually happened

Extracted verbatim from `.github/workflows/ci.yml` and run locally against
`docs/screens/13-find-redacted.txt` exactly as FIX-C left it:

```
### the CI step, extracted verbatim from .github/workflows/ci.yml,
### run against docs/screens/13-find-redacted.txt exactly as FIX-C left it
  ok        docs/screens/01-audit.txt
  ok        docs/screens/06-audit-sweep.txt
  ok        docs/screens/02-rescue.txt
  ok        docs/screens/03-audit-after.txt
  ok        docs/screens/08-ls.txt
  ok        docs/screens/09-find.txt
  ok        docs/screens/10-stats.txt
  ok        docs/screens/11-show.txt
  ok        docs/screens/12-ls-ghosts.txt
  DRIFTED   docs/screens/13-find-redacted.txt  <-  potsherd find redacted
--- /dev/fd/63	2026-08-24 20:24:38
+++ /dev/fd/62	2026-08-24 20:24:38
@@ -6,6 +6,6 @@
     assistant side not recoverable · potsherd show 840f40a5
 
   1 ghost hit
-  text search only — no embeddings in the index — run potsherd index --embed
+  text search only — no embeddings in the index yet
   semantic search: warming (0 of 3,410 embedded)
   run  potsherd show <id8>  to read one, or  potsherd ask <words>

A published screen is not what this build prints. Above, '-' is what
the committed screen claims and '+' is what the command actually says.
Regenerate with:  bash scripts/make-screens.sh
EXIT=1
```

2.9 s wall on this machine (8.1 s on its first, cold run). Against the
regenerated screen the same step exits 0 and prints
`ten published screens match what this build prints`.

---

## 3. THE NUMBERS

| | |
|---|---|
| files changed vs `cd55cb8` | **6** besides this report — 1 source, 1 test, `docs/screens/13-find-redacted.txt`, `.github/workflows/ci.yml`, 2 vendored bundles |
| diff | `+540 / −11`, this report excluded |
| **effective code lines** (comments and blanks excluded) | `llm.ts` **49** · `llm.test.ts` **112** · `ci.yml` **96 lines added, 45 of them not comment** |
| `pnpm test` | `Test Files 53 passed (53)` / **`Tests 1893 passed (1893)`** — was 1,890, **+3 new, 0 regressions** |
| `pnpm typecheck` | **4 of 4** packages `Done`, exit 0 |
| `python3 scripts/check-privacy.py` | **EXIT CODE 0** *(read from `$?`; its last line is the id-inventory caveat, not a verdict)*, and `--selftest` exit 0 |
| `pnpm evals` | **exit 0** standalone — `hybrid (auto) recall@5 51/60, recall@1 27/60`, `PASS`, identical to the baseline |
| `pnpm build && pnpm vendor` | run after every `packages/` change; `git status plugins/` **clean** |
| item 1 red-first | 3 of 3 fail on `HEAD`'s `llm.ts`, with the orphan pids printed |
| item 1 (a) orphans after `-t "never hangs"` | **4 → 0** |
| item 1 (c) Ctrl-C, unfixed → fixed | backend tree left alive **1 of 2 processes → 0 of 2**; potsherd exits **130** on both |
| item 1 (d) `MaxListenersExceededWarning` in suite output | **2 → 2**, the same two, both on a `[Socket]` and neither ours |
| item 2 guard | 10 of 17 screens, **2.9 s** warm / 8.1 s cold, green; **red on the seeded violation** with exactly the one line as the diff |
| item 3 | **4** background embedders per full `pnpm test`, 3 roots, 0 blocked by the lock |

The new tests were run as a group **8 times consecutively** before being
believed, after the first draft of the timeout case proved flaky at
`timeoutMs: 300` — the deadline could beat `/bin/sh`'s own exec on a loaded
machine and kill the stub before it had run a line, which fails for having
nothing to measure rather than for the defect. It waits for the stub's pid file
while the call is still in flight now, and the margin is a second.

Evidence directory, outside the repository, absolute path handed to the
orchestrator directly rather than written here (it contains a session uuid,
which `check-privacy.py`'s id ratchet correctly refuses):
`…/fix-e-evidence` — `02-orphans-before-fix.txt`, `04-item1-red.txt`,
`05-item1-green.txt`, `06-item1-a-after-fix.txt`, `07`–`10` the four SIGINT
runs, `12`/`22` the suites, `13-evals.txt`, `15`/`16`/`17` the CI step green,
seeded and extracted, `18-suite-instrumented-offline.txt` + `spawnlog-*.tsv`,
`20-online-worker.txt`, and `ctrl-c-harness.py`. No real session id, project
name, home path or transcript line is in it or in this file.

---

## 4. ITEM 3 — THE BACKGROUND EMBEDDER, MEASURED AND NOT TOUCHED

`packages/cli/src/commands/index.ts:258` spawns `detached: true` + `unref()`
with no kill path. Nothing here is fixed; this is the measurement.

**How many a full `pnpm test` starts: four.** Measured by instrumenting the
spawn itself — one `appendFileSync` above `spawn` and one on the `lock.holder`
early return — running the whole suite, and then reverting the instrumentation
(`git diff` against `cd55cb8` for that file is empty, and the tree was rebuilt
and re-vendored afterwards).

```
$ cut -f1 spawnlog.tsv | sort | uniq -c
   4 spawn
$ cut -f2 spawnlog.tsv | sort -u | wc -l
   3
```

Four spawns, three distinct roots, **zero** blocked by the lock. All four come
from `tests/index.test.ts`: it is not "every test that runs the real CLI
`index`" — the spawn is conditional on `(vec.report?.pending ?? 0) > 0`, and
most test corpora have nothing pending — but it is every `index` that indexes a
corpus without `--no-embed`.

**The count is the same with `POTSHERD_TEST_EMBED=1`, and that is the point.**
The offline flag is read by `embeddings.offline()` **inside the child**; the
parent's decision to spawn does not consult it. Verified directly:
`index --full` with `POTSHERD_OFFLINE=1` still starts one, which then exits in
about a tenth of a second because `acquire` throws. What the env var bounds is
the child's *lifetime*, not the number of children.

**What one of them does when the flag is not there.** One real run, demo corpus,
throwaway `HOME`, no `POTSHERD_OFFLINE`:

```
  full index                 359ms   228 parsed · 0 unchanged · 546 KB
  semantic search: warming (0 of 3,410 embedded) — fetching 46.1 MB, once

    ( the foreground verb returned in 0.49s total )

$ ps -eo pid,ppid,pgid,etime,command | grep "[i]ndex --quiet"
37382     1 37382  00:00  node <repo>/packages/cli/bin/potsherd.js index --quiet --potsherd-dir <tmp>/… --no-color

t+10s  models dir  46M   lock held   pid 37382 alive
…
t+60s  models dir  46M   lock held   pid 37382 alive
```

`PPID 1` two seconds after the command a user typed had already returned: 48.4 MB
fetched over the network and 3,410 chunks embedded, finishing on its own at
about 70 s for this corpus. It is bounded here only by the corpus being the
synthetic one — the same pass over a real archive is the multi-hour case, and
`tests/vectors-lazy.test.ts` records that this is the wasm path, "6.5x slower
than native".

**The lock does not bound them, and cannot.** `lockPathFor` is
`<root>/.lock.embed` — one lane per **root**, and every test makes a fresh root,
so N roots means N unowned workers whatever the lock does. Even within one root
it only bounds *concurrent* ones: the suite's own log shows one root spawning
twice, because the first worker had already exited and released. And
`paths.modelsDir(root)` is `<root>/models`, so the 48.4 MB is fetched **once per
root**, not once per machine: four workers over four fresh roots is ~194 MB, not
48.4.

**What a user's remedy is today: there is none inside potsherd.** All 22
registered verbs were checked; none stops, cancels or kills anything. `doctor`
does not report the embed lane's holder, so the pid is not even shown — the only
handle in the product is `<root>/.lock.embed/owner.json`, which does carry
`pid`, and nothing documents it. The remedy is therefore `ps` and `kill` by
hand, or `pkill -f "index --quiet"`, neither of which potsherd tells anybody
about. `index --no-embed` prevents a new one; nothing stops a running one. That
is a product decision and it is not mine to make here.

---

## 5. WHAT I COULD NOT DO

1. **Run the suite with `POTSHERD_TEST_EMBED=1` end to end.** It would have
   pulled 48.4 MB per root over the network and run four unowned embedding
   passes on a live developer machine, and the constraint on this branch is to
   kill only pids I started and recorded. What I did instead is stronger than
   the count would have been: I showed the spawn decision **does not read the
   flag at all**, so the number is identical under both conditions, and then ran
   exactly one worker online, watched it, and killed it by its recorded pid. The
   thing I did not measure is whether four concurrent online workers interfere
   with each other — sqlite contention across four separate roots, or four
   simultaneous downloads.
2. **Test the fix on Linux or Windows.** Everything here is macOS. `detached` +
   `process.kill(-pid)` is POSIX; on Windows `detached` means a new console and
   a negative pid is not a group, which is why `child.kill` is kept
   unconditionally as the second half of `killBackendTree` rather than as an
   `else`. CI runs `ubuntu-latest` as well as macOS and the new tests will say.
3. **Close the untrack gap.** A launcher that forks the real work and exits
   immediately is untracked while its child lives, so a Ctrl-C after that moment
   has nothing to kill. §1 says why holding the group anyway is worse. No
   harness in the ladder behaves that way today, and I did not build a stub that
   does to prove the gap exists — it is an argument from the code, not a
   measurement.
4. **Make the item-2 guard cover all seventeen screens.** It covers ten. Seven
   are excluded for reasons written into the step's own comment, and one of them
   — `07-index.txt` — is excluded because its `fetching 46.1 MB, once` line is a
   fact about the runner rather than about the build, which is a smaller version
   of the same "published output that is not reproducible" problem. I did not
   try to normalise that line away: a normaliser that accepted its disappearance
   would be the guard not guarding, which is `09 §9`.
5. **Reproduce the CI step on ubuntu.** The step was extracted verbatim from
   `ci.yml` and run on macOS, green in 2.9 s and red on the seeded violation.
   Nothing in it is platform-specific — `sed -E`, `diff`, `bash` — but I have
   only one platform here.
6. **Say what `card --all` costs in practice on the Ctrl-C path.** The harness
   drives one call. Thirty-nine concurrent-ish calls exercise the same registry
   and the same single handler, and the listener test covers three at once, but
   I did not run a thirty-nine-call interrupt.
7. **Cover the `agent-sdk` rung.** `run()` is the spawn for `claude-cli` and
   `codex`, rungs 2 of the ladder, and those are what this fixes.
   `AgentSdkTransport` hands the work to `@anthropic-ai/claude-agent-sdk`,
   which spawns its own `claude` and is given an `AbortController`; whether
   that library kills a process group or one pid is its business and not
   reachable from here. It is rung 3 and only used "if it happens to be
   there", but a machine that has it has a model path this branch did not
   touch. Worth its own item.

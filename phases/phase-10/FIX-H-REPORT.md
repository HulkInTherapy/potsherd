# FIX-H — `potsherd index` crashes on every database written by 1.1.0

**Branch** `work/FIX-H`, cut from `efc5f47`, merged up to `origin/main` `7396c3e` (doc-only).
**Commits** `63ffc18` (N1) · `2bf8cd3` (vendor) · `f0d0dbe` (N2 wording) · `9bc0573` (C-4 / C-6).
**Nothing pushed, nothing merged.**

> **Identifiers.** Every path below that came from a real run is a throwaway sandbox and is
> written `<sandbox>`. No session id, project name or transcript line appears in this file or in
> the repository. `~/.potsherd/potsherd.db` was never opened as a database by this worker, never
> copied and never migrated — see §6.7, which also says who *did* move its mtime while I worked.
> Every measurement here is against an index built in `$(mktemp -d)` under a relocated `$HOME`.

---

## 0. What I checked before I fixed anything

| # | claim | verdict |
|---|---|---|
| N1 | a 1.1.0 database holds the three names as vec0 **virtual** tables | **reproduces** |
| N1 | `potsherd index` dies on it with `no such module: vec0` | **reproduces**, through the binary |
| N1 | it is a migration bug, not a general break | **reproduces** — a fresh index is fine |
| N1 | migration 10's *stated* limitation is the defect | **confirmed**, `db.ts:371`, `vec.ts` |
| N2 | `doctor` prints `schema v9 of v12 · run potsherd index` on that database | **reproduces verbatim** |
| — | `DROP TABLE` on a moduleless vec0 table fails | **true** |
| — | the schema is editable under `writable_schema` | **true on one driver, false on the other** |
| — | `ALTER TABLE … RENAME` as an alternative | **false** — same module error |
| C-4 | `isStale` never falls through for a live pid | **reproduces** |
| C-4 | anything refreshes the lock | **no. Nothing did.** |
| C-6 | `doctor` cannot tell a fetch in flight from a stopped one | **reproduces** |

### N1, on a real index in an isolated sandbox

Built by `potsherd index` over this machine's `~/.claude` (a read-only input) into a throwaway
directory, then rewound to what 1.1.0 wrote:

```
$ sqlite3 <sandbox>/potsherd.db "select sql from sqlite_master where name='vec_exchanges';"
CREATE VIRTUAL TABLE vec_exchanges USING vec0(
  id TEXT PRIMARY KEY, embedding FLOAT[384]
)
$ sqlite3 <sandbox>/potsherd.db "select count(*) from vec_exchanges;"
Error: in prepare, no such module: vec0
```

and the whole verb, with the bundle built from `efc5f47`:

```
$ POTSHERD_NO_VEC=1 node potsherd-efc5f47.js index --harness claude \
    --claude-dir ~/.claude --potsherd-dir <sandbox>
potsherd: no such module: vec0
  try:  re-run with --debug for the full error
exit=1
```

`POTSHERD_NO_VEC=1` is the project's own honest way to be the machine that has lost the extension
(`vec.ts`: *"the one honest way to test the path everybody else is already on"*). The connection
genuinely has no vec0; the error is raised by sqlite while **compiling**, which is why it lands in
`Object.prepare`.

### N2, same database, same build

```
$ node potsherd-efc5f47.js doctor --potsherd-dir <sandbox> --width 100
  database    schema v9 of v12  · run potsherd index
  vectors             500         stopped at 500 of 1,707
```

The tool prescribes the one command that exits 1. Reproduced exactly.

### What did **not** reproduce, and closed a design question

I tested the whole of the stated blocker rather than accepting it (`plans/09 §13.9`):

| attempt, on a vec0 table with no module | `better-sqlite3` | `node:sqlite` |
|---|---|---|
| `SELECT COUNT(*) FROM vec_exchanges` | `no such module: vec0` | `no such module: vec0` |
| `DROP TABLE vec_exchanges` | `no such module: vec0` | `no such module: vec0` |
| `ALTER TABLE vec_exchanges RENAME TO …` | `no such module: vec0` | *(not tried — settled)* |
| `PRAGMA writable_schema=ON` | accepted | accepted |
| `DELETE FROM sqlite_master WHERE name=…` | **`table sqlite_master may not be modified`** | **1 row** |
| … the same, after `db.unsafeMode(true)` | **1 row** | *(no such method, not needed)* |
| `DROP TABLE vec_exchanges_chunks` … (the shadows) | ok | ok |
| `PRAGMA integrity_check`, fresh connection | `ok` | `ok` |
| `SELECT COUNT(*) FROM vec_exchanges` after | `0` (a view) | `0` (a view) |

**So `writable_schema` is not unsafe — it is driver-dependent, and the difference is exactly one
line.** `better-sqlite3` turns `SQLITE_DBCONFIG_DEFENSIVE` **on** by default and defensive mode
refuses every write to `sqlite_master` however `writable_schema` is set; `unsafeMode` is its
documented off switch. `node:sqlite` does not set defensive and has no such method. The ruling
said to take the archive-rebuild route if `writable_schema` turned out unsafe or
driver-dependent — it turned out driver-dependent and *handled*, at O(1) instead of O(archive), so
I took it and made the driver difference something the code **asks about** rather than knows.

`ALTER TABLE … RENAME` is worth recording as a closed door: it would have needed no schema
rewriting at all, and it calls the missing module too.

---

## 1. What changed, and why that shape

### 1a. The migration handles it (`vec.ts`, `migrateToPortableVectors`)

Three cases, and the third no longer declines:

1. **Nothing to convert** — unchanged.
2. **vec0 tables that can be read** — unchanged, and **tried first for every table, always**,
   because it is the path that keeps the vectors. If `sqlite-vec` is on the machine every vector is
   copied into the blob table and the virtual table is dropped properly. The two paths are not
   exclusive: the migration takes case 2 per table and only falls to case 3 for the tables that
   actually failed.
3. **vec0 tables that cannot be read** — the row is deleted from `sqlite_master` under
   `PRAGMA writable_schema`, then `PRAGMA writable_schema = RESET` reloads this connection's schema
   cache (that reload is load-bearing: without it sqlite still believes the name is taken and
   `CREATE VIEW IF NOT EXISTS vec_exchanges` is a silent no-op), then vec0's four storage tables —
   now ordinary tables — drop normally.

**Nothing is changed before it is known to be possible.** `detachStranded` asks the driver for
schema writes (`unsafeMode`, if it has one) and then **probes with a delete that matches nothing**:
`DELETE FROM sqlite_master WHERE type='table' AND name='__potsherd_probe_no_such_table__'`. That
runs the identical authorizer check and touches not one byte. Only if it passes is anything
removed. A driver that refuses therefore leaves the file exactly as it found it — no
half-rewritten schema can outlive the attempt, and the decline is recorded with a reason naming a
driver that is measured to succeed.

**What is lost, said in the code.** A vector inside a vec0 table this machine cannot read is
already unreachable — no query can select it, no verb can use it — so dropping it loses nothing
that was still recoverable, whereas leaving it in place loses the entire product for that user.
What *would* have been lost silently is the truth: `exchanges.embedding_version` still said
"embedded", and every count, every `doctor` row and the pending queue read that stamp rather than
the store. `forgetStrandedStamps` clears it for the tables that were detached, so the background
pass rebuilds them locally and for free from text potsherd already holds. `vec_cards` has no such
stamp; the card's text, model, cost and mirror are all still in `cards` and on disk, and that
session is scored on `cards_fts` until it is carded again. Said in the docstring, not only here.

I considered and rejected decoding vec0's shadow-table format to salvage the vectors without the
extension: it is an undocumented internal layout that changes between `sqlite-vec` versions, and a
*wrong* vector written into the index is worse than a recomputed one. Re-embedding is local, free
and already automatic.

### 1b. Nothing downstream throws (`vec.ts`, `ingest.ts`)

The root cause of the crash is a predicate, not a missing guard. `clearExchanges` **was** guarded:

```ts
if (vecAvailable(db) && vecTablesExist(db)) {          // both answered TRUE
```

`vecAvailable` means *"this connection can score a vector"* and has said yes on every machine since
vectors stopped needing an extension; `vecTablesExist` only asks whether the name is in
`sqlite_master`, which a stranded vec0 table certainly is. So the guard passed and the `DELETE` was
prepared.

Two changes:

* `loadVec` now reports `available: false` with a reason when this connection cannot read a vec0
  table the schema still names. That is the question every write path already asks, so one honest
  answer turns a crash into the degradation this module's contract has always promised — `recall.ts`
  drops the vector lists, `cards/write.ts` skips the vector, `embedPending` returns a reason, and
  `index` says so in its receipt. `VecStatus.legacy` carries the names, for `doctor`.
* `vecTableUsable(db, table)` is the new predicate: *can sqlite compile a statement against this
  name, here, now*. It is behavioural, not inferential — a `prepare`, which is precisely where the
  error is raised.

**The sweep.** Every statement in the tree that names one of the three, and where it stands now:

| site | before | now |
|---|---|---|
| `ingest.ts:399` `clearExchanges` | guard passed, threw | `vecTableUsable` |
| `ingest.ts:1204` exchange embed pass | gated on a status computed once per run | re-asks the connection |
| `ingest.ts:1332` ghost embed pass | `ghostVecTable` read `sqlite_master` — threw | `vecTableUsable` |
| `recall.ts:1557` `vectorState` | already caught, → `available:false` | unchanged, now also short-circuited |
| `recall.ts` KNN × 3 | already dropped when `!vectors.available` | unchanged |
| `cards/write.ts:293` | inside a `try`, already degraded | unchanged |
| `cards/transcript.ts:202` `loadVectors` | inside a `try`, already degraded | unchanged |
| `doctor.ts:99` `store.count` | `count()` catches, returns 0 | unchanged |
| `vec.ts` `embedPending` insert | inside a `try`, reported a reason | now never reached |

`recall.ts` needed no change and is not in my diff.

### 1c. `doctor` (N2) — `packages/cli/src/commands/doctor.ts`

**Which file owns the sentence: `doctor.ts`.** `doctor-line.ts` owns the *vectors* line
(`vectorNote`, `warmingLine`, `stoppedLine`); the schema sentence is built in `doctor.ts`'s
`schemaNote`, and that is the one that read `run potsherd index`. I edited both, for different
findings — `doctor.ts` for N2, `doctor-line.ts` for C-6.

Two things, and the second is the one I did not expect to have to do.

**The command leads the sentence, and that is a measurement.** My first draft read
`a vec0 index written by potsherd 1.1.0 — run potsherd index to convert it`, which is true and
useless: `doctor`'s note column is **43 characters at width 80 and 63 at its maximum**, and a row
elides from the right, so a real `doctor` printed

```
  database    schema v9 of v12  · a vec0 index written b…
  vectors             500         a vec0 index written by potsherd 1.1.0 — r…
```

at *both* widths. That is `plans/04`'s truncation defect in its worst form — the clause that
survives is the one the reader can do nothing with. The verb is 18 characters and fits everywhere,
so it leads:

```
  database    schema v9 of v12  · run potsherd index — i…            (width 80)
  vectors             500         run potsherd index — it converts a vec0 st…
```

**And `schemaNote` is measured against the room it has.** `schema v9 of v12  · ` costs 20 of those
43 columns, so a command that will not survive would be printed as *half* a command, which is worse
than not printing one. `schemaNote` now takes the real note width and, when the command will not
fit, says only what is true and lets the `vectors` row carry the command whole. The decline case's
command (`POTSHERD_SQLITE=node potsherd index`) is the case that needs this.

**A test that passed for the wrong reason, caught by the same look.** My first assertion was a bare
`expect(before.stdout).toMatch(/run potsherd index/)` — and it passed against the *truncated*
sentence, because `doctor` prints `run potsherd index for exact counts` in the record-types header
further down the same screen. Both rows are now asserted with their prefix.

### 1d. `db.ts`

Comment only: migration 10's docstring said it declines on a case it now handles, and that comment
was the open item. Rewritten to say what happened, why `DROP` cannot work, and where the driver
difference is documented.

---

## 2. Artifacts

### 2a. The trap test, red on `efc5f47`

`tests/upgrade-from-1.1.test.ts` — **I chose the new file: `tests/migrations.test.ts` does not
exist.** It does not approximate the trap: it loads `sqlite-vec`, creates the three tables with
1.1.0's own DDL, puts real vectors in them, rewinds `schema_migrations` to 9, and then opens the
file under `POTSHERD_NO_VEC=1`. This is `plugin-install.test.ts`'s shape — that one copies a parent
`package.json` saying `commonjs` rather than asserting about one.

```
$ git checkout efc5f47 -- packages/ && pnpm build && npx vitest run tests/upgrade-from-1.1.test.ts
 ✓ the trap: the three names are vec0 virtual tables and no statement compiles against them
 × migration 10 converts it instead of declining, and nothing is left of vec0
 ✓ keeps every vector when the extension IS on the machine
 × the whole verb: potsherd index completes on it, through the binary
 × index re-reads every transcript after the conversion, which is where it used to die
 × nothing throws even on a database the migration did not repair
 × doctor, on a database it can see is stranded and cannot repair itself > names a command that runs
      Tests  5 failed | 2 passed (7)

  → expected 'potsherd: no such module: vec0\n  try…' not to match /no such module/
  → no such module: vec0
  → no such module: vec0
  → expected 'potsherd doctor · potsherd 1.2.0 · no…' to match /schema v9 of v12  · run potsherd index/
```

The two that pass on `efc5f47` are the two that must: the one that *establishes* the trap, and the
one that pins the already-working path where the extension is present.

```
$ npx vitest run tests/upgrade-from-1.1.test.ts        # on this branch
 Test Files  1 passed (1)
      Tests  7 passed (7)
```

### 2b. A real `potsherd index`, the whole verb, on a database with vec0 tables in it

Same sandbox, same database, same command — only the bundle differs.

```
$ export HOME=$(mktemp -d) && unset CLAUDE_CONFIG_DIR POTSHERD_DIR XDG_CONFIG_HOME NODE_PATH CODEX_HOME
$ export POTSHERD_NO_VEC=1

  ── as released (efc5f47) ─────────────────────────────────────────────
  potsherd: no such module: vec0
    try:  re-run with --debug for the full error
  exit=1

  ── with the fix ──────────────────────────────────────────────────────
  potsherd index · <sandbox> · 25 aug 2026

    claude                       370   49 sessions · 321 sidechains · 1,707 excha…

    exchanges indexed          1,707   26,363 tool calls · 228 redacted
    ghosts indexed                 0   none recovered yet — run potsherd rescue
    masked this run            2,910   entropy 2,556 · generic 224 · aws 60 · …
    vectors                        —   0 of 1,707

    incremental index          18.4s   370 parsed · 0 unchanged · 483 MB

    semantic search: warming (0 of 1,707 embedded) — fetching 46.1 MB, once

    run  potsherd doctor  for parse coverage and every path read.
  exit=0
```

370 transcripts, 1,707 exchanges, 18.4 s — the same shape as the 17.3 s clean run that built the
database in the first place. The detached embedder this run spawned was recorded by pid, killed by
pid, and confirmed gone by pid (`ps` → `kill 91244` → `ps`); no name pattern, no `killall`.

### 2c. N2 end to end — the sentence, and the command it names, run

```
  ── as released ───────────────────────────────────────────────────────
  database    schema v9 of v12  · run potsherd index          ← and index exits 1

  ── with the fix, same database ───────────────────────────────────────
  database    schema v9 of v12  · run potsherd index — it converts a vec0 st…
  vectors             500         run potsherd index — it converts a vec0 store written by 1.1.0

  $ potsherd index --no-embed …                               ← the command it named
    exchanges indexed          1,707
    incremental index          17.3s   370 parsed · 0 unchanged · 483 MB

  ── doctor again ──────────────────────────────────────────────────────
  database    schema v12 of v12
  vectors             —           0 of 1,707
```

---

## 3. The numbers

| gate | required | measured |
|---|---|---|
| `pnpm test` | ≥ 1,932 · 0 skipped · 0 regressions | **1,946 passed, 54 files, 0 failed, 0 skipped** |
| `POTSHERD_SQLITE=node pnpm test` | same | **1,946 passed, 54 files, 0 failed, 0 skipped** |
| `pnpm typecheck` | 4 of 4 | **4 of 4** |
| `pnpm evals` | exit 0 standalone | **exit 0**, read from `$?` |
| `python3 scripts/check-privacy.py` | exit 0 from `$?` | **`PRIVACY EXIT=0`** |
| `pnpm build && pnpm vendor` → `git status plugins/` | clean | **clean**; `plugin-install.test.ts` 14/14 |

The baseline was 1,932 on 53 files. 54 files and 1,946: `tests/upgrade-from-1.1.test.ts` is new
(+7) and `tests/embed-worker.test.ts` gained 7 for C-4 and C-6. Nothing was deleted or skipped.

**The evals drift is not mine.** `pnpm evals` prints five `lost` and two `gain` per-query lines
against the pinned baseline. I built `efc5f47` and ran it too: the drift lines are **byte-identical
on both builds**, and both exit 0. It is pre-existing and predates this branch.

The privacy check's exit was read from `$?`, not from its last line — its final line is the id
inventory, which reads like a pass. Its verdict line begins *"privacy: 590 tracked text files
swept, no real-corpus content…"*; the inventory's unaccounted count is at its pinned ceiling and is
elided here.

---

## 4. C-4 — the embed lock had no expiry, and any live pid poisoned it

`packages/core/src/lock.ts`. **`lock.ts` was not on my DELIVER list; the coordinator added it.**

`isStale` answered `!pidAlive(holder.pid)` and stopped — *"a live owner is never stale"* — which
made a live pid **sufficient** rather than merely necessary. And I checked the smaller half first,
because the verifier said to: **nothing refreshed the lock.** `acquire` wrote `owner.json` once and
never touched it again. So a timeout alone would only have moved the failure into FIX-B's D3, where
a pass that runs for hours loses its lock at minute five.

So the fix is both halves in one commit:

* **A holder stamps its own lock** every 20 s, on a `setInterval` that is **`unref`'d** — the
  background embedder is detached and unwatched, and a timer that kept it alive would hold the very
  lane it is meant to be reporting on. `release()` clears it. `LockHandle.touch()` is exposed so a
  caller in a long *synchronous* stretch, where no timer can fire, can say so itself.
* **A live owner is honoured for 10 minutes since its last stamp** — thirty missed beats.
  `LIVE_STALE_MS` is separate from `STALE_MS` (still 5 minutes, still only for a lock whose owner
  cannot be identified at all).

**D3's guarantee is unchanged, and I proved it with real processes rather than by argument.** A
pass that is still working refreshes the whole time, so its lock never ages. Six concurrent
`potsherd index --quiet` against a root whose embed lane was held by a live, beating owner:

```
$ nohup node holder.mjs <sandbox> &          →  held pid=21485
$ for i in 1 2 3 4 5 6; do potsherd index --quiet --potsherd-dir <sandbox> & done; wait
$ ps -eo pid,command | grep <sandbox>
21485 node holder.mjs <sandbox>              ←  one process. the pre-existing pid. nothing spawned.
```

And the poisoning, bounded:

```
$ kill -9 21485                              ←  the embedder, as a user would
$ ls -d <sandbox>/.lock.embed                ←  still there. no verb in the product removes it.
$ nohup sleep 600 &                          →  21831, an unrelated process now holding that number
$ echo '{"pid":21831,"op":"embed",…}' > <sandbox>/.lock.embed/owner.json

  holder(), lock stamped just now : 21831    ←  correct: it may still be a working pass
  holder(), 11 minutes unstamped  : null     ←  was 21831, for ever, before C-4
```

`null` is what makes `index` spawn a replacement and what makes C-2's honest sentence honest again.

The three existing tests in `tests/embed-worker.test.ts` encoded the property C-4 says is wrong —
*"however old the lock"* — and now say *"however long the pass runs"*, with the `touch()` that makes
it true. Nine of the file's eleven tests are red on `efc5f47`; the two that pass are the
dead-pid takeover (unchanged) and C-6's `undefined` case (deliberately unchanged).

## 5. C-6 — `doctor` could not tell a fetch in flight from nobody embedding

`packages/core/src/doctor-line.ts`. `vectorNote`'s `pending` branch read `working` only when
`runtimeReady` was true, so on the first run of a fresh install — the exact moment a user runs
`doctor` to ask *is anything happening* — it never read it at all, and both states printed
`0 of N · 46.1 MB runtime not fetched yet`.

```
working === true    →  0 of 1,800 · fetching the 46.1 MB runtime
working === false   →  0 of 1,800 · not running — 46.1 MB runtime not fetched
working === undefined →  0 of 1,800 · 46.1 MB runtime not fetched yet      (unchanged)
```

`undefined` keeps the old wording for the old reason: a caller with no root could not ask, and an
absent measurement must not become a claim. FIX-F C2's *one flag drives all four surfaces* is now
true of four.

---

## 6. What I could not do, and what I am not sure of

1. **N2 is numbered differently in the two documents.** My brief calls the `doctor` sentence "N2";
   the audit's §N2 is the MCP plugin-version skew, and the `doctor` sentence is the *compounding*
   paragraph of §N1 and item 2 of its §5 priority list. I fixed the `doctor` sentence, which is what
   was asked. **Nobody has taken the audit's actual §N2** (version-stamp the MCP handshake, refuse
   on a minor mismatch) as far as I know.

2. **The decline branch is unreachable on both drivers I can test.** `detachStranded` returning
   false requires a driver with defensive mode and no `unsafeMode`. Its reason string and
   `doctor`'s width fallback are therefore exercised by construction and by unit reasoning, not by a
   real refusal. I would rather that branch existed and were untested than not exist.

3. **The trap test hard-requires `sqlite-vec`** rather than skipping without it — 0 skipped is a
   gate, and a test that quietly passes on a machine that cannot build the trap establishes
   nothing. It is an `optionalDependency` of `@potsherd/core` and is in the lockfile, so
   `pnpm install --frozen-lockfile` has it; if a CI image ever lacks it, this file fails with a
   sentence naming the install rather than passing hollow. Flagging it because it is a new hard
   dependency for one test file.

4. **Card vectors in an unreadable vec0 table are not recovered.** They were unreadable before and
   nothing recoverable is lost, but unlike exchanges and ghosts there is no stamp to clear and no
   backfill pass, so a card's semantic lane comes back only on the next `potsherd card`. The card's
   text, cost and mirror are untouched. Rebuilding them locally from `cards.title/summary/topics`
   with no model call is possible and is a real improvement; it needs an async pass and belongs in
   `embedPending`, which is more than this fix should carry.

5. **`LIVE_STALE_MS` is 10 minutes and that number is a judgement, not a measurement.** It is thirty
   heartbeats, chosen to be far beyond any plausible timer starvation. A holder blocked
   *synchronously* for longer than that — `rescue` copying a very large archive on a slow disk is
   the only candidate I can think of — could still lose its lock, which is why `touch()` is on the
   handle. I did not add a `touch()` call to `rescue`: it is outside my files.

6. **I did not add an `unlock` verb.** The verifier notes there is no way for a user to clear a
   stuck lock other than deleting a dotfile nothing documents. C-4 makes that self-healing within a
   bounded window, which I think is the better fix, but a verb would still be an improvement and
   would touch `packages/cli/src/index.ts`, which is RESERVED.

7. **`~/.potsherd/potsherd.db` was never opened by me.** I took the orchestrator's schema dump as
   given and rebuilt the same schema in a sandbox instead; its real contents are unverified by me
   by choice. Every command in this report was scoped with `--potsherd-dir <sandbox>` or an
   explicit path, and I checked the suite as well: every `cli([…])` invocation in `tests/` passes
   `--potsherd-dir`, including my own.

   **Its mtime did move during my session** (25 Aug 00:45), and it is worth saying who: **two
   `potsherd 1.1.0` MCP servers are running against it right now**, started at 19:09 and 22:19
   yesterday, from `~/.claude/plugins/cache/potsherd/potsherd/1.1.0/dist/mcp.js` — before I began.
   That is the audit's *actual* §N2 (a session pinned to the old plugin) still live on this machine,
   and it is what is holding that file open. Nothing in this worktree pointed at it.

### Boundary: one line I would want, if you want it exported

Nothing is required. `vecTableUsable` and the `VecTable` type are exported from `vec.ts` and reached
by relative import from `ingest.ts`; `VecStatus.legacy` rides on a type `packages/core/src/index.ts`
already re-exports, so `doctor.ts` needed no new export. If you would like `vecTableUsable` on the
public surface for a later fix, the line for `packages/core/src/index.ts:135` is:

```ts
export { vecStatus, vecAvailable, vecTableUsable, type VecStatus, type VecTable } from './vec.js';
```

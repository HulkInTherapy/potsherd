# C234 — eight defects, one family: two surfaces of the same fact disagreeing in print

Branch `work/C234`, cut from `bcab843`. Every finding in `VERIFICATION-6.md §C-2 … C-9` was
reproduced before it was touched, on a corpus this report says how to build, and every fix is
either **the cause** (one computation, read twice) or **the rendering** (a label that names the
question its number answers) — said per item in §1.

The shape of all eight is the same and so is the shape of the answer: **where two files computed
one fact, one of them now reads the other.** Three of the eight turned out to have the answer
already written somewhere in the tree, unused by the surface that got it wrong — `threads.ts`'s
`sessionDate` for C-6, `vectorNote`'s fetch clause for C-7, `stats()`'s own totals for C-4's third
number. None of the three needed a new idea; they needed the call.

**Identifiers.** No real session id, project name, home path or transcript line appears here. The
only ids are the synthetic ones `scripts/make-demo-corpus.mjs` publishes and the visibly-invented
ones the tests write. Scratch paths are written `<scratch>`.

**Isolation.** Every measurement ran as

```
env -u CLAUDE_CONFIG_DIR -u POTSHERD_DIR -u XDG_CONFIG_HOME -u NODE_PATH -u CODEX_HOME \
    HOME="<scratch>/home" node packages/cli/bin/potsherd.js … --potsherd-dir "<scratch>/pd"
```

`--no-embed` on every `index` except the one inside `scripts/make-screens.sh`, which starts its
own embedder and kills it **by the pid the child wrote into `.lock.embed/owner.json`**, having
first checked the command line names the demo root. The script ran twice; the first child was pid
`81641` and `ps -p 81641` after that run reports it gone. Nothing else was signalled by me or by
it; no `killall`, no name pattern, and `ps` after the last run shows no `potsherd` child. `~/.claude`,
`~/.codex`, `~/.cursor`, `~/.pi`, `~/.gemini`, `~/.copilot`, `~/.local/share/opencode` and
`~/.potsherd` were never opened by anything in this run — the corpora are the committed demo
generator, the committed fixtures, and three transcripts this report's own scripts wrote.

---

## §0 THE CLAIMS, CHECKED BEFORE ANYTHING WAS FIXED

| item | verdict | the command, and what it printed |
|---|---|---|
| **C-2** `ls` misquotes `--until` by a day outside UTC | **confirmed, exactly as filed** | four zones, one command, identical result sets — §2.1 |
| **C-3** the score column is not the sort order | **confirmed** | `strong 0.0267` above `weak 0.0275` on a two-row page — §2.3 |
| **C-4** `doctor` and `stats` disagree about `sessions` | **confirmed, and there are *three* numbers, not two** | `claude`+`pi` index: `sessions on disk 31`, `sessions indexed 6`, `stats sessions 4` — §2.4 |
| **C-5** `potsherd_recall` prints two vector counts | **confirmed, and the honest fix is in a file I may not touch** | §4, with the exact patch |
| **C-6** `find` and `ls` date one session days apart | **confirmed** | `ls` `19 aug`, `find` `12 aug`, one session, one terminal — §2.2 |
| **C-7** `find` says `warming` while the runtime is still being fetched | **confirmed** | `doctor` `0 of 4 · fetching the 46.1 MB runtime` against `find` `semantic search: warming (0 of 4 embedded)` |
| **C-8** stranded database: `index` prescribes `index` | **confirmed, and the prescription measurably changes nothing** | ran the prescribed verb; the three vec0 tables are still tables afterwards — §2.6 |
| **C-9** `lane: "evidence"` on a row marked `citable: false` | **confirmed, and it is a `find --json`-only defect** | `potsherd_recall` already publishes `evidence: "not-a-transcript"` and a `citableNote` beside it; `find --json` publishes neither — §4 |

One thing checked that is **not** a defect, and so is not "fixed": the `--since`/`--until` filter
returning a row dated after `--until` (C-6's second half). `buildSessionFilters` tests the
**interval**, not one end of it — `COALESCE(s.ended_at, s.started_at) >= since` and
`COALESCE(s.started_at, s.ended_at) <= until` — which is right, and documented as right, and is
what makes `--since 2026-08-01` mean *sessions that were alive in August*. What was wrong was that
the column beside it was a bare date with a header that said `when`. The filter is untouched; the
header is not.

---

## §1 WHAT CHANGED, PER ITEM — AND CAUSE OR RENDERING

### C-2 · `ls` quotes the bound the reader typed · **CAUSE**

`packages/core/src/render/ls.ts`, `packages/cli/src/commands/ls.ts`, `packages/core/src/format.ts`.

The receipt was a **second computation of a fact already in hand**. `--until 2026-08-15` is parsed
by `search/when.ts` into `2026-08-15T23:59:59.999Z`, and the heading then re-derived a date from
that instant with `shortDate`, which reads it with `getDate()`/`getMonth()` — local time. The two
computations agree in exactly one zone.

**There is no correct zone to render it in, and that is the point.** `when.ts` says so in its own
header: *absolute forms are read in UTC, relative ones in local time*. `2026-08-15` becomes a UTC
day boundary; `today` becomes a **local** one. So an ISO instant taken alone cannot be rendered
back into the calendar day it names — the frame lives in the phrase and nowhere else. Rendering
every bound in UTC would fix `--until 2026-08-15` and break `--since today`; rendering in local
time is what shipped.

So the heading quotes **the phrase**. `runLs` already holds `o.since` and `o.until` — the literal
strings — and now hands them to `renderLs` as a `FilterEcho`; the heading prints them and computes
nothing. Zero computations cannot disagree with one, in any zone.

The cost, said plainly: `--since 30d` used to print `since 26 jul` and now prints `since 30d`. That
loses a resolved date. It gains a line that is the same line in every zone, and `--json` — which
was always right, and is the control in §2.1 — still carries `2026-07-26T…Z` for anyone who needs
it. A receipt quotes; it does not paraphrase.

`format.ts` gains no code. It gains the docstring that says which of the two jobs `shortDate` has
and which one it must never be given, with the zone arithmetic written out, because the next person
to reach for it will reach for it from a heading.

### C-3 · the column is the sort key · **RENDERING, and it is the right layer**

`packages/core/src/render/find.ts:344`.

`byLabel` in `recall.ts` sorts a page by lane, then the confidence **word**, then
`calibration.score`. The column printed `s.score` — reciprocal-rank fusion — which is none of
those. The comment above the line already said the number was uninformative; what had changed since
that comment was written is that FIX-I made a *different* number the sort key, so the column was no
longer merely uninformative, it **contradicted the order it sat in**.

The column is now `s.calibration.score`. Three reasons it is that and not nothing:

1. **It is the order.** Within a lane the page is `(word, calibration)` descending, and that pair
   is now exactly what is printed, in that order, on that line.
2. **The word is cut from it.** `WEAK_FLOOR` and `STRONG_FLOOR` are thresholds on this number, so
   `strong 0.9250` above `weak 0.8500` is a page whose two columns explain each other. The old
   pairing could not: a `none` row printed `0.0164` above a `strong` row printing `0.0161`.
3. **It is the quantity `--min-confidence` names.** A reader who wants the withheld rows can see
   how far below the floor they are.

Rendering rather than cause, deliberately: nothing about the *ranking* was wrong. FIX-I fixed that
and §B3 of VERIFICATION-6 verified it. The only thing wrong was which of two already-correct
numbers reached the page.

**This breaks two assertions elsewhere that locate the human meta line by the fused score.** They
are one line each, they are outside my paths, and they are in §4 with the exact patch.

### C-4 · one word, one question, per row · **CAUSE for one row, RENDERING for two**

`packages/cli/src/commands/doctor.ts`.

Three numbers were printed under the word `sessions` on two screens:

* `sessions on disk` — `disk.sessions.length` from `audit.ts`, which walks `~/.claude` **and no
  other harness**. On the verifier's machine, 49.
* `sessions indexed` — `COUNT(*) FROM sessions`, which counts every subagent transcript as a
  session. On the demo corpus, 228.
* `stats`' `sessions` — top-level transcripts across every harness, with the subagents in the note
  beside it. 31, or 56 on the verifier's machine.

Two different fixes, because they are two different defects.

**The disk rows: rendering.** `audit.ts` is claude-scoped by construction and nothing about that is
wrong; the label was borrowing the machine's name for one harness's directory. They now read
`claude sessions on disk` and `claude sidechains on disk`, which is the same scope the `claude`
adapter line four rows below already prints — and that adapter line is where the *other* harnesses'
disk counts live. Nothing is recomputed; the label now asks the question the number answers.

**The indexed row: cause.** `doctor` now calls `sessionStats(db, { root, freshness: false, all: true })`
— the function `stats` renders — and prints `totals.sessions` with `totals.sidechains` in the note.
One call, two screens, and they cannot drift. `all: true` because `doctor` counts everything and
names the ignore list separately further down; `freshness: false` because `doctor` has its own
freshness row and the per-file stat pass is `stats`' job.

`doctor --json`'s `index` object gains the same split (`sessions`, `sidechains`) and keeps the old
number under `rows`, so the two doctor surfaces say the same thing. **That renaming breaks one
assertion in `tests/cli.test.ts`** — §4, exact patch.

### C-5 · not fixed here — the honest fix is in another worker's file · **BOUNDARY**

Both numbers are produced outside my paths. Located, measured, and the exact patch is in §4.

### C-6 · both verbs read `sessionDate`, and both pages name the end · **CAUSE**

`packages/core/src/render/ls.ts`, `packages/core/src/render/find.ts`.

`threads.ts` already exports the answer, and calls itself *the promoted function*:

```ts
export function sessionDate(s: { startedAt?; endedAt? }): string | null {
  return s.endedAt ?? s.startedAt ?? null;
}
```

with a docstring explaining that it prefers the **end** because *the head of a forked transcript is
inherited and the tail never is* — which is audit F4's whole finding. `graft` has read it since F4.
`render/ls.ts` kept a copy that happened to match; `render/find.ts` kept a copy that was the
opposite. Both now call the function. That is the fix, and it is the cause: the answer stops being
spelled at the call site.

The second half of the item — *make the column say which end it is* — is a rendering change on both
pages, in the same two words. `ls`'s header is `last active`; `find`, which has no header, prints
`last active 19 aug` in the meta line. `ls --until 2026-08-15` still returns a row dated `19 aug`,
because the filter is an interval test, and the row now says what its date is.

**It costs the `ls` title column five characters** (`when` → `last active`), which `plans/05` does
not give up lightly. Paid because the alternative is a bare date column two verbs had already
disagreed about by a week, and because the column was already sized 11 for `21 aug 2025`.

### C-7 · one fetch clause, both surfaces · **CAUSE**

`packages/core/src/doctor-line.ts`, `packages/core/src/vec.ts`.

`vectorNote`'s `pending` branch has said `fetching the 46.1 MB runtime` since round 5's C-6.
`warmingLine` never had it, so on the first run of a fresh install `doctor` said the runtime was
coming down and `find` said the index was warming. The clause is now a function, `fetchClause`,
used by both — not a second string that means the same thing — and `vec.ts` hands `warmingLine`
the same `fmtBytes` it hands `vectorNote`, or the two would have printed `46.1 MB` and `48 MB` for
one number. The test in §2.5 compares `find`'s line against `doctor`'s clause **character for
character** rather than against a literal.

The clause order is `stoppedLine`'s, for `stoppedLine`'s reason: `embedded > 0` is tested first,
because an index with vectors in it has plainly had the runtime, and naming a download there would
be strange. That is exactly where `vectorNote` draws the line too, so the two surfaces are now
saying the same thing in the same states — which is the whole of the fix and the reason one
existing assertion (`warming (1 of 4 embedded)`, runtime absent, one row already embedded) is
**unchanged and still green**.

**What this cost, on a third surface, and what I did about it.** `potsherd index` builds its own
sentence by *appending* to `vecStatus().line` — one extra clause saying who is doing the work and
that it happens once. The moment the fetch clause landed on that line the composed sentence overran
80 columns and `fitLine` dropped `index`'s half, so `07-index.txt` went from

```
  semantic search: warming (0 of 3,410 embedded) — fetching 46.1 MB, once
```
to
```
  semantic search: warming (0 of 3,410 embedded) — fetching the 46.1 MB runtime
```

*in the background, once* is a real thing to lose: it is the clause that says a 46 MB download will
not happen again and is not blocking anything. The cause is that a caller with something more
specific to say was being handed a finished sentence and told to grow it. So `doctor-line.ts` now
also exports **`warmingHead`** — the same sentence without the clause — and the two-line patch that
has `index` compose from the head instead is in §4f. I could not apply it: `cli/commands/index.ts`
is outside my paths. Everything the patch needs from a file I own is exported and shipped.

The other line that moved on `07-index.txt` — the `vectors` row gaining `· fetching the 46.1 MB
runtime` — is **not** my diff. `vectorNote`'s `pending` branch printed that clause on
`working === true` before this branch and prints the identical string after it; only the
`${bytes(r.acquireBytes)}` template moved into `fetchClause`. What decides whether the clause
appears is whether the child `index` spawned had taken `.lock.embed` by the time the parent
rendered — the same timing `.github/workflows/ci.yml` describes at length for `09-find.txt`, and
one of the reasons `07-index.txt` is excluded from that guard. It appeared on both of my captures
and on neither of the committed one's.

### C-8 · the sentence asks whether the migration can still run · **RENDERING, and I say where the cause fix would go**

**The sentence is not in `ingest.ts`.** It is `strandedReason()` at
`packages/core/src/vec.ts:379`, and it reaches all four surfaces — `index`, `doctor`, `stats` and
`find` — through `VecStatus.reason`. `vec.ts` is on my delivery list scoped to C-7's `warmingLine`;
I took this line as well because it is the same file, no other worker holds it, and the fix is
nine lines. Flagged here rather than done quietly.

`migrate()` skips any version already in `schema_migrations`. A *decline* records nothing and
retries on the next open — which is what makes the two existing sentences true. A **recorded** 10
is the one shape where they are not, and it is the state `tests/upgrade-from-1.1.test.ts` builds
with `rewindSchema: false` and calls requirement 2. So `strandedReason` now asks that table —
`SELECT COUNT(*) FROM schema_migrations WHERE version = 10` — and says:

```
delete potsherd.db and run potsherd index — this vec0 store cannot be converted in place
```

Command first, because `doctor`'s note column is 43 characters and elides from the right; that
ordering is a measurement recorded in the function's existing docstring, not a preference.

**Why "rebuild" and not a repair verb.** The three vec0 names cannot be dropped without the
extension — that is the defect — and no migration will be offered the chance to try again. There
is no command that repairs the file. Saying so is what the brief asked for.

**The cause fix, which I did not make, is one clause in `db.ts` and it is in §4.** With it,
`run potsherd index` becomes true again in this state and the branch above becomes dead code that
should be deleted. I state plainly that I think the cause fix is the better one and that it is
outside my paths.

**And one thing I could not establish**: I could not reach this state through the product's own
code paths. `migrateToPortableVectors` records 10 only after the vec0 tables are gone, and declines
(recording nothing) otherwise. So the state is one the test constructs and the product may not be
able to produce. The sentence printed in it was still false, the test still asserts the requirement,
and the fix is nine lines — but I am not claiming a user is in this state today.

### C-9 · not fixed here — both renderers are another worker's · **BOUNDARY**

Measured, and the finding is narrower than filed: `potsherd_recall` **already** publishes
`evidence: "not-a-transcript"` and a `citableNote` sentence beside `lane` and `citable`, so the
model door does say which to believe. `find --json` publishes `lane` and `citable` and neither of
the other two. Exact patch in §4.

---

## §2 THE ARTEFACTS

Corpus: `node scripts/make-demo-corpus.mjs "<scratch>/home/.claude"` plus, for C-4, the committed
`tests/fixtures/pi/agent` copied into the scratch HOME. Two purpose-written transcripts for C-3 and
C-6, both reproduced verbatim inside the tests that assert them.

### 2.1 C-2 — four zones, one east and one west of UTC, `TZ=UTC` left pinned

**Before.** Same command, same index, **identical result sets** (`1 of 6` in every zone):

```
TZ=UTC                  potsherd ls · since 10 aug · until 15 aug · 1 of 6
TZ=Asia/Kolkata         potsherd ls · since 10 aug · until 16 aug · 1 of 6
TZ=America/Los_Angeles  potsherd ls · since  9 aug · until 15 aug · 1 of 6
TZ=Pacific/Auckland     potsherd ls · since 10 aug · until 16 aug · 1 of 6

--json (TZ=Asia/Kolkata):
{"since": "2026-08-10T00:00:00.000Z", "until": "2026-08-15T23:59:59.999Z", …}
```

**After.**

```
TZ=UTC                  potsherd ls · since 2026-08-10 · until 2026-08-15 · 1 of 6
TZ=Asia/Kolkata         potsherd ls · since 2026-08-10 · until 2026-08-15 · 1 of 6
TZ=America/Los_Angeles  potsherd ls · since 2026-08-10 · until 2026-08-15 · 1 of 6
TZ=Pacific/Auckland     potsherd ls · since 2026-08-10 · until 2026-08-15 · 1 of 6

and a relative phrase, which was equally zone-dependent before:
TZ=UTC / Kolkata / Los_Angeles / Auckland
                        potsherd ls · since last week · 1 session   (all four identical)
```

**The test is the deliverable, and it is red in a zone the guards do not pin.** New in
`tests/terminal.test.ts`, with its own `runIn(zone, …)`:

```
 × the receipt of a date filter is what the user typed > does not move with the reader's zone
   → TZ=UTC  potsherd ls · since 1 aug · until 2 aug · 1 of 2
     TZ=Asia/Kolkata  potsherd ls · since 1 aug · until 3 aug · 1 of 2
     TZ=America/Los_Angeles  potsherd ls · since 31 jul · until 2 aug · 1 of 2
     TZ=Pacific/Auckland  potsherd ls · since 1 aug · until 3 aug · 1 of 2: expected 3 to be 1
```

Three assertions, in order: the heading is byte-identical in all four zones; it contains
`since 2026-08-01` and `until 2026-08-02` in all four; and `--json`'s bounds and row count are
identical in all four — the control that proves the defect was in the receipt and never in the
filter. **`export TZ=UTC` in `scripts/make-screens.sh` and `TZ=UTC` in both CI screens
invocations are untouched.**

### 2.2 C-6 — one session, two verbs

Fixture: one transcript, exchanges stamped `2026-08-12T09:00` and `2026-08-19T09:00`.

**Before**

```
$ potsherd ls
    when  harness  project  title                                         status
  19 aug  claude   span     the retry budget on the flaky uploader keep…  live

$ potsherd find "retry budget"
  the retry budget on the flaky uploader keeps tripping            claude · live
  span · 12 aug · 2 exchanges · main                              strong  0.0275

$ potsherd ls --until 2026-08-15
potsherd ls · until 15 aug · 1 session
  19 aug  claude   span   …
```

**After**

```
$ potsherd ls
  last active  harness  project  title                                    status
       19 aug  claude   span     the retry budget on the flaky uploader…  live

$ potsherd find "retry budget"
  the retry budget on the flaky uploader keeps tripping            claude · live
  span · last active 19 aug · 2 exchanges · main                  strong  0.9250

$ potsherd ls --until 2026-08-15
potsherd ls · until 2026-08-15 · 1 session
  last active  harness  project  title                                    status
       19 aug  claude   span     the retry budget on the flaky uploader…  live
```

Red before, in `tests/threads.test.ts`:

```
 × both verbs print the last-activity end, and both name it
   → expected 'potsherd find "retry budget" …' to contain '19 aug'
     …  span · 12 aug · 2 exchanges · main   strong  0.0275
 × a row returned by --until says which end its date is
   → expected 'potsherd ls · until 15 aug · 1 session…' to contain 'last active'
```

The published `09-find.txt` moved with it, and the move is the fix showing its work: a ghost
thread's date went from `13 nov 2025` to `15 nov 2025`, which is its `last_ts` instead of its
`first_ts`.

### 2.3 C-3 — the column, before and after

Fixture: two transcripts whose bodies answer `postgres connection pool`, and three subagent
transcripts whose **titles** answer it and whose bodies do not. RRF ranks the title above the body;
calibration ranks it below. That disagreement is C-3.

**Before** (the test's own failure output):

```
  the connection pool in postgres is leaking handles on retry           claude · live
  potsherd-c3 · 10 aug · 2 exchanges · main                            strong  0.0267
  ↳ write the migration for the postgres connection pool           claude · sidechain
  potsherd-c3 · 10 aug · 1 exchange · main                               weak  0.0275
```

`weak 0.0275` under `strong 0.0267`: the column runs backwards **and** contradicts the word.

**After**, on the demo corpus at `--min-confidence none`, seven rows:

```
  data-pipeline · last active 21 aug · 8 exchanges · main         strong  0.8500
  event-bus · last active 11 aug · 5 exchanges · feat/retry-bud…  strong  0.8287
  auth-gateway · last active 17 aug · 1 exchange · fix/flaky-e2e…   none  0.5667
  auth-gateway · last active 19 aug · 1 exchange · chore/deps · c…  none  0.5667
  search-index · last active 31 jul · 1 exchange · develop · migr…  none  0.5667
  billing-web · last active 30 jul · 1 exchange · main · code-rev…  none  0.5667
  mobile-shell · last active 6 aug · 1 exchange · feat/retry-budg…  none  0.5667
```

Before the fix the same seven rows printed `0.0164 · 0.0161 · 0.0164 · 0.0161 · 0.0159 · 0.0156 ·
0.0154` — two inversions and a `none` outscoring a `strong`.

### 2.4 C-4 — three numbers become one question each

Fixture: the demo corpus plus the committed pi fixture, both in a scratch HOME. **Before:**

```
$ potsherd doctor                      $ potsherd stats
  sessions on disk              31       harness  sessions  subagents …
  sidechains on disk           197       claude         31        197
  …                                      pi              3          —
  sessions indexed             228
                                         sessions                      34   197 subagents · …
```

`31`, `228` and `34`, one word, one index, one minute. **After:**

```
$ potsherd doctor                                        $ potsherd stats
  claude sessions on disk       31   21 harness-titled…    claude   31   197 …
  claude sidechains on disk    197   subagent transcripts  pi        3     —
  …
  sessions indexed              34   197 subagents · 446   sessions  34   197 subagents · …
                                     exchanges · 249 tool
```

The published `04-doctor.txt` moved the same way, on the demo corpus's own numbers:
`sessions indexed 228` → `sessions indexed 31 · 197 subagents`, which is what `10-stats.txt` on the
line below has always said.

Red before, in `tests/index.test.ts`, which builds a **two-harness** corpus on purpose — with
claude alone the two numbers agree by accident, which is how this survived every previous round:

```
 × the number under a bare "sessions" is the same number on both screens
   → doctor's "sessions on disk" says 1 where stats says 4
 × the disk rows say which harness they walked
   → expected … to match /^ {2}claude sessions on disk\s/m
```

### 2.5 C-7 — the fetch clause, on both surfaces

Red before, in `tests/find-warming.test.ts`, on a four-exchange index with **nothing** embedded and
a worker holding `.lock.embed`:

```
 × names the fetch while the runtime is still coming down, as doctor does
   → expected 'potsherd find "pgbouncer" …' to contain 'fetching the 46.1 MB runtime'
     …
     semantic search: warming (0 of 4 embedded)
```

Green after. The assertion establishes its premise first (`phase === 'pending'`,
`runtimeReady === false`, `working === true`) and then compares `find`'s line against the clause
`vectorNote` puts on `doctor`'s row, extracted from that same report object with the same two
formatters — so it is the clause `doctor` prints, not a literal that could drift from it.

### 2.6 C-8 — the prescription measurably changes nothing, then the sentence changes

The stranded database is built the way `tests/upgrade-from-1.1.test.ts` builds it — index normally,
load `sqlite-vec` on the test's own handle, replace the portable store with 1.1.0's three
`USING vec0(...)` virtual tables, and **leave 10, 11 and 12 stamped**. Every read below is made
with `POTSHERD_NO_VEC=1`, so the connection genuinely lacks the extension.

```
STRANDED  schema 10 stamped = 1
```

**Before**, all four surfaces:

```
index    vectors  2   run potsherd index — it converts a vec0 st…    exit 0
doctor   vectors  2   run potsherd index — it converts a vec0 st…    exit 0
stats    vectors  2   run potsherd index — it converts a vec0 st…    exit 0
find     semantic search: run potsherd index — it converts a vec0 store written by 1.1.0
```

and the prescription does nothing — asserted, not argued, by running it:

```
 ✓ and the command it used to name really does change nothing
   (after `potsherd index --no-embed`, all three names are still `type = 'table'`
    and `vecStatus(db).legacy` still contains `vec_exchanges`)
```

**After:**

```
$ potsherd doctor
  database                           schema v12 of v12
  vectors                        —   delete potsherd.db and run potsherd index…
$ potsherd stats
  vectors                        —   delete potsherd.db and run potsherd index…
$ potsherd find pgbouncer
  semantic search: delete potsherd.db and run potsherd index — this vec0 store
$ potsherd index --no-embed
  exit 0, no `no such module`, and the sentence is gone from its output
```

Red before:

```
 × does not prescribe the command that cannot work
   → the sentence still names potsherd index, which cannot convert this store:
     expected 'run potsherd index — it converts a ve…' not to match /^run potsherd index\b/
```

**The other three states are untouched and still asserted**, which is the check that this did not
break a fix that was real: `doctor, on a database it can see is stranded and cannot repair itself >
names a command that runs, and running it is what fixes the database` is green, on the
schema-rewound fixture where `run potsherd index` is true.

### 2.7 The screens guard

`bash scripts/make-screens.sh` (with `POTSHERD_SCREENS_NO_MODEL=1`, so the two model screens keep
their committed copies) regenerated thirteen files; the script's own assertions pass —
`17 screens, widest line 80 characters, no forbidden strings, no unredacted credentials, no cut
masks`. No screen was edited by hand.

The **CI screens step, extracted verbatim from `.github/workflows/ci.yml` and run locally**:

```
  ok        docs/screens/01-audit.txt
  ok        docs/screens/06-audit-sweep.txt
  ok        docs/screens/02-rescue.txt
  ok        docs/screens/03-audit-after.txt
  ok        docs/screens/08-ls.txt
  ok        docs/screens/12-ls-ghosts.txt
  ok        docs/screens/09-find.txt
  ok        docs/screens/10-stats.txt
  ok        docs/screens/11-show.txt
  ok        docs/screens/13-find-redacted.txt
ten published screens match what this build prints
```

**And red on a seeded drift** — one number in one committed screen changed back to its pre-fix
value, which is precisely the class of drift `norm()` is claimed not to hide:

```
  DRIFTED   docs/screens/09-find.txt  <-  potsherd find pgbouncer
  -  data-pipeline · last active 21 aug · 8 exchanges · main         strong  0.0275
  +  data-pipeline · last active 21 aug · 8 exchanges · main         strong  0.9250
```

The seed was reverted and the step re-run clean (`exit=0`) before anything else was done.

---

## §3 THE NUMBERS

| gate | required | measured | verdict |
|---|---|---|---|
| `pnpm test` | ≥ 1,985 on 55 files, 0 regressions | **55 files, 1,996 tests, 1,993 passed, 3 failed** | **3 failures, all boundary — §4** |
| `POTSHERD_SQLITE=node pnpm test` | same | **55 files, 1,996 tests, 1,993 passed, 3 failed** — the same three, no others | same three |
| `pnpm typecheck` | 4 of 4 | **4 of 4, exit 0** | pass |
| `pnpm evals` | exit 0 | **`EVALS EXIT=0`** · `bm25 40/31 · vectors 57/40 · hybrid 57/42` · `PASS — the amended phase-3 gate would merge this fusion`, and all six confidence controls `ok` | pass |
| `python3 scripts/check-privacy.py` | exit 0, read from `$?` | **`PRIVACY EXIT=0`**, `599 tracked text files swept, no real-corpus content, no pinned known violations left to carry` (599 with this report staged; 598 without) (finding line elided) | pass |
| `pnpm build && pnpm vendor` then `git status plugins/` | clean | **clean after the commit** — `vendored 2 files, 2.7 MB total`, then nothing to stage | pass |
| CI screens step, locally | green, and red on a seeded drift | **ten screens ok; DRIFTED on the seed; clean again after revert** | pass |
| disk | `df -h` before and after | **6.7 GiB free before, 5.3 GiB after** — nothing I created outside the worktree survives; `.tmp/demo-home` (6.1 MB) was removed, and this is a shared machine so I do not claim the delta as mine | — |

**1,996 against the 1,985 this branch started from: eleven new assertions**, in the five test files
on my list. Every one of them was run red before the fix that makes it green, and every red is
pasted in §2.

Files changed, and nothing outside the delivery list:

```
packages/core/src/format.ts                 docstring only — no code
packages/core/src/render/ls.ts              C-2, C-6
packages/core/src/render/find.ts            C-3, C-6
packages/core/src/doctor-line.ts            C-7
packages/core/src/vec.ts                    C-7, C-8
packages/cli/src/commands/ls.ts             C-2
packages/cli/src/commands/doctor.ts         C-4
tests/terminal.test.ts                      C-2 (3 assertions), C-3 (1)
tests/threads.test.ts                       C-6 (2)
tests/index.test.ts                         C-4 (2)
tests/find-warming.test.ts                  C-7 (1)
tests/upgrade-from-1.1.test.ts              C-8 (2)
docs/screens/**                             13 files, `bash scripts/make-screens.sh` only
plugins/claude-code/dist/**                 2 files, `pnpm build && pnpm vendor` only
phases/phase-11/C234-REPORT.md              this
```

`packages/core/src/ingest.ts` is **unchanged** — C-8's sentence is not there; see §1 C-8.
`packages/core/src/render/doctor-line.ts` does not exist; the file is
`packages/core/src/doctor-line.ts` and that is the one I changed.
`packages/cli/src/commands/stats.ts` is **unchanged**: `stats` was the screen that was already
right on every one of these, and C-4 is fixed by making `doctor` read what `stats` computes rather
than the other way round.

---

## §4 WHAT I COULD NOT DO, AND THE EXACT PATCHES FOR IT

Six patches. Three are the price of fixes that **did** land — assertions elsewhere that pin the
pre-fix rendering: two for C-3 and one for C-4. Two are items whose only honest fix is in a file I may not write (C-5, C-9). One
is C-8's cause fix, and one is the two lines that give `potsherd index` its own clause back.

Each was applied in this worktree, run, and reverted; `git status tests/` shows only my five files.
**Nothing below is committed on `work/C234`.**

### 4a · the three assertions the landed fixes break — verified green with these applied

```
 ✓ tests/cli.test.ts (…)   ✓ tests/query-cli.test.ts (48)   ✓ tests/recall.test.ts (…)
   Test Files  3 passed (3)      Tests  211 passed (211)
```

```diff
--- a/tests/cli.test.ts
+++ b/tests/cli.test.ts
@@ -606,12 +606,14 @@ describe('potsherd cli', () => {
     const d = JSON.parse(r.stdout) as {
       redaction: Record<string, number>;
-      index: { sessions: number; exchanges: number; vec: { available: boolean; reason?: string } };
+      index: { sessions: number; sidechains: number; rows: number; exchanges: number; vec: { available: boolean; reason?: string } };
       indexedRecordTypes: { harness: string; type: string; novel: boolean }[];
       adapters: { harness: string; supported: boolean }[];
     };
     expect(d.redaction).toHaveProperty('total');
-    expect(d.index.sessions).toBe(4);
+    expect(d.index.sessions).toBe(2);
+    expect(d.index.sidechains).toBe(2);
+    expect(d.index.rows).toBe(4);
```

*(the fixture is two top-level transcripts and two subagent transcripts; `4` was the row count.)*

```diff
--- a/tests/query-cli.test.ts
+++ b/tests/query-cli.test.ts
@@ -244,7 +244,7 @@ describe('find', () => {
     for (const s of j.sessions) {
-      const meta = human.split('\n').find((l) => l.includes(s.score.toFixed(4)));
+      const meta = human.split('\n').find((l) => l.includes(s.calibrated.toFixed(4)));
```

```diff
--- a/tests/recall.test.ts
+++ b/tests/recall.test.ts
@@ -1052,7 +1052,7 @@ describe('recall: calibrated confidence — T10.1', () => {
     for (const s of r.sessions) {
-      const meta = lines.find((l) => l.includes(s.score.toFixed(4)));
+      const meta = lines.find((l) => l.includes(s.calibration.score.toFixed(4)));
```

Both of the last two are locators, not claims: each finds the human meta line **by its number** and
then asserts the **word** on it. The claim — *two views, one field* — is unchanged and still holds;
only which number identifies the line moves, and it moves to the number the page now prints.
`tests/recall.test.ts` is the live worker's file and I did not commit a byte of it.

### 4b · C-5 — `potsherd_recall` prints two vector counts, six lines apart

`"capability": "keyword + semantic search (163 of 163 embedded)"` comes from `capabilityLine(…,
vectorReport)` at `packages/mcp/src/tools/recall.ts:310`, whose numbers are
`vec.ts`'s `vectorCounts(db)` — rows in **`exchanges` and `ghost_prompts`** carrying a current
`embedding_version` stamp. `"vectors": { "vectors": 120 }` comes from `vectorState()` at
`packages/core/src/recall.ts:1849`, which is `COUNT(*) FROM vec_exchanges` — the **exchange**
vectors alone. On the index the verifier measured: `vec_blob_exchanges` 120 + `vec_blob_ghost_prompts`
43 = 163. Both numbers are correct and neither says what it counted.

Both files are the live worker's. The patch makes the object carry **one** number, from the
function `vec.ts` already owns:

```diff
--- a/packages/core/src/recall.ts
+++ b/packages/core/src/recall.ts
@@
-  let vectors = 0;
-  try {
-    vectors = (db.prepare('SELECT COUNT(*) AS n FROM vec_exchanges').get() as { n: number }).n;
-  } catch {
+  let vectors = 0;
+  try {
+    // VERIFICATION-6 C-5 — one count, from the function that owns it.
+    //
+    // This was `COUNT(*) FROM vec_exchanges`, the exchange vectors alone,
+    // while `capabilityLine` two fields away renders `vectorReport`, which is
+    // exchanges **and** recovered prompts. One JSON object carried
+    // `163 of 163 embedded` and `"vectors": 120` six lines apart and said
+    // which about neither. `vectorCounts` is the stamp the embedding pass
+    // writes, over both tables, and it is what every other surface's
+    // numerator already is.
+    vectors = vectorCounts(db).embedded;
+  } catch {
     return { used: false, available: false, reason: 'no vector index — vec_exchanges unreadable' };
   }
```

and, at the top of the same file, add `vectorCounts` to the existing `./vec.js` import.

`vecTablesExist(db)` still guards the branch above, so *"never built"* is unaffected; what changes
is that an index whose only vectors are recovered ghost prompts stops reporting `0`. The stamp and
the blob are written by the same pass and cleared together by migration 10's
`forgetStrandedStamps`, so the two counts cannot separate.

**If a reviewer would rather not move a number a decision reads**, the smaller patch is to leave
`vectors` alone and make `capabilityLine` name its own scope
(`163 of 163 exchanges and recovered prompts embedded`). I recommend the first: two numbers that
mean different things under one word is the defect, and naming both is the weaker of the two
answers this phase has been asking for.

### 4c · C-9 — `lane: "evidence"` beside `citable: false`

Measured, and it is narrower than filed. **The model door already answers it**: `potsherd_recall`
publishes, on the same object, `evidence: "not-a-transcript"` and

```
citableNote: "nothing here is a transcript: the session title or its card matched, the body did
              not use those words. Not citable. potsherd_read the thread if you want to know
              what it actually says."
```

`find --json` publishes `lane` and `citable` and **neither** of those. Reproduced on the C-3
fixture:

```
0 lane=evidence citable=True  conf=strong kinds=exchange,title
1 lane=evidence citable=False conf=weak   kinds=title
```

`lane` is not wrong and must not move: `tests/cards-lane.test.ts` pins
`laneOfHit('title') === 'evidence'` in both directions, and `recall.ts` gives six reasons for it,
all of which are about ranking budgets and sort order rather than about evidentiary status. The
defect is that `find --json` publishes the field that *looks* like an answer and not the field that
*is* one. So: promote the model door's `evidenceOf` into core, and publish it at both doors.

```diff
--- a/packages/core/src/recall.ts
+++ b/packages/core/src/recall.ts
@@ (beside citableBlock, ~line 550)
+/**
+ * Is this block a transcript, or somebody's summary of one?
+ *
+ * VERIFICATION-6 C-9. `lane` is the **ranking** lane — which budget the row
+ * took and where it sorts (`LANES`) — and `laneOfHit('title')` is `evidence`
+ * for six reasons `tests/cards-lane.test.ts` pins in both directions. It is
+ * not, and was never, a claim that the row may be quoted. `citable` is that
+ * claim, and at `find --json` the two sat side by side saying opposite things
+ * with nothing published to say which to believe.
+ *
+ * `potsherd_recall` has answered this since FIX-F C3 and spelled the answer
+ * in its own file. Here, so both doors read one function.
+ */
+export function evidenceOfBlock(
+  hits: readonly { kind: RecallHit['kind'] }[],
+): 'transcript' | 'not-a-transcript' {
+  return hasTranscriptEvidence(hits) ? 'transcript' : 'not-a-transcript';
+}
```

```diff
--- a/packages/cli/src/commands/find.ts
+++ b/packages/cli/src/commands/find.ts
@@ (immediately after `citable: s.citable === true,`)
           citable: s.citable === true,
+          // C-9. `lane` above is the ranking lane, not a verdict on what this
+          // row is; this is the verdict, in the same two values
+          // `potsherd_recall` has published for it since FIX-F C3, from core's
+          // own function so the two doors cannot drift.
+          evidence: evidenceOfBlock(s.hits),
```

```diff
--- a/packages/mcp/src/tools/recall.ts
+++ b/packages/mcp/src/tools/recall.ts
@@ (evidenceOf, ~line 81)
 export function evidenceOf(kind: string): 'transcript' | 'not-a-transcript' {
-  return (SUMMARY_KINDS as ReadonlySet<string>).has(kind) ? 'not-a-transcript' : 'transcript';
+  // Kept as the per-*kind* form this door needs for `hitJson`; the per-*block*
+  // form is core's `evidenceOfBlock`, which `find --json` now reads too.
+  return (SUMMARY_KINDS as ReadonlySet<string>).has(kind) ? 'not-a-transcript' : 'transcript';
 }
```

Both renderers are the live worker's files, so none of this is applied.

### 4d · C-8's cause fix, which I believe is the better one

What I landed is the sentence. The cause is that `migrate()` will not reconsider a recorded
version, and a database can be stamped `10` with the three vec0 tables still in it. Four lines in
`packages/core/src/db.ts` make `run potsherd index` true again in that state, at which point the
branch I added to `strandedReason` becomes dead and should be deleted with it:

```diff
--- a/packages/core/src/db.ts
+++ b/packages/core/src/db.ts
@@ export function migrate(db: Db): number {
   const applied = new Set<number>(
     (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
       (r) => r.version,
     ),
   );
+  // VERIFICATION-6 C-8 — migration 10 is the one migration whose *outcome* can
+  // be checked, and a stamp that outlives its outcome is a store nothing will
+  // ever repair. If the three vec0 names are still virtual tables this
+  // connection cannot compile against, the conversion did not happen, whatever
+  // is recorded: forget the stamp so this open runs it again. A decline
+  // records nothing and the open after that retries, which is the behaviour
+  // every other path here already has.
+  if (applied.has(10) && strandedVecTables(db).length > 0) {
+    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(10);
+    applied.delete(10);
+  }
```

with `strandedVecTables` exported from `vec.ts` (it is currently module-private; `loadVec` and
`vecTableUsable` are its only callers).

I did not make this change because `db.ts` is outside my paths and because it is a **write on
every open** of a shape nobody has proved a user can reach — see §1 C-8's last paragraph. It wants
its own measurement, not a drive-by.

### 4e · C-7's third surface — `index` loses *in the background, once* without this

`packages/core/src/doctor-line.ts` exports `warmingHead` on this branch and nothing calls it yet.
This is what should:

```diff
--- a/packages/cli/src/commands/index.ts
+++ b/packages/cli/src/commands/index.ts
@@ function warmingSentences(vec: VecStatus | undefined, spawned: boolean): string[] {
-  // `vec.line` is the sentence `find` prints while it waits, from the same
-  // report. `index` prints it with one extra clause saying who is doing the
-  // work, and falls back to the bare sentence at 60 columns.
-  const head = vec?.line ?? `semantic search: warming (${fmt.num(r.embedded)} of ${fmt.num(r.total)})`;
+  // `warmingHead` and not `vec.line`: since C-7 that line carries the fetch
+  // clause itself, and appending to it produced a sentence too long for 80
+  // columns that `fitLine` then dropped whole. This verb has the better
+  // clause — it is the one that spawned the worker — so it takes the head and
+  // says its own thing after it. `doctor-line.ts` exports both.
+  const head = r.phase === 'unavailable'
+    ? (vec?.line ?? warmingHead(r, fmt.num))
+    : warmingHead(r, fmt.num);
```

with `warmingHead` added to the existing `@potsherd/core` import. The `long`/`short` variants below
it are then correct again as written and `07-index.txt` returns to
`— fetching 46.1 MB, once` at 80 columns. Verified only by reading; I did not apply it.

### 4f · what I did not attempt at all

* **A real model backend.** Nothing in these eight needs one; `14-ask.txt`, `15-graft.txt` and
  `17-ls-cards.txt` kept their committed copies via `POTSHERD_SCREENS_NO_MODEL=1`, which is the
  path `make-screens.sh` documents, and they are the three screens the CI guard excludes anyway.
* **The real archive.** Every measurement here is on the committed demo corpus, the committed
  fixtures, or three transcripts written by this report's own scripts. The verifier's numbers
  (49/56, 324/326, 163/120) are quoted from `VERIFICATION-6.md` and reproduced *in shape* on a
  corpus this report tells you how to build, not re-measured on the machine's own history.
* **CI itself.** I extracted its screens step and ran it verbatim locally, both green and red. I
  did not run the workflow.

---

## §5 ONE THING I FOUND THAT IS NOT ON THE LIST

`ls` on the demo corpus prints **one row** for thirty-one live sessions across ten projects,
because `session_threads` puts all thirty-one in a single thread and `threadRollup` folds thirty of
them into its head:

```
$ sqlite3 <the demo index> "select count(distinct thread_id), count(*) from session_threads;"
1|31
```

The summary line says `1 of 31 sessions`, which is F4's fix working as designed and is why round 5's
C-3 made that line say `1 of 31` — but a chain that spans ten unrelated project directories is
not a fork/resume chain, and `08-ls.txt` publishes the result. It is not one of my eight, the
committed screen already carried it, and I changed nothing about it. Filing it here because the next
round should look at `deriveThreads`' overlap rule on a corpus with repeated boilerplate in it.

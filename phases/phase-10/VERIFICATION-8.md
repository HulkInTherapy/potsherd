# VERIFICATION-8 — the eighth independent verification, before the v1.2.0 tag

**Commit under test:** `origin/main` @ `5199b21` ("phase 12 and the release notes carry C7-2, which
is the same gap from the other side"). Cloned to a scratch directory; the working checkout was
never modified and the real `~/.potsherd` was never opened for write (mtime unchanged, §G).
**Verifier authored none of this.** 25 aug 2026.

**Scope ruling honoured.** C7-2 (an invented word plus two ordinary ones clears the floor) and the
verb's 7/60 are confirmed, reproduced on the real archive at two, three and four words, and **not
counted as new defects** — meghavi ruled them carried forward, and both documents state them.
Every id below is a placeholder; no real session id, project name, home path or transcript line
appears in this file.

---

## §A — the eight rows, and the command behind each

| row | audit | v6 | v7 | **v8** | the command |
|---|---:|---:|---:|---:|---|
| Concept & scope discipline | 4 | — | — | **9** | reading `README.md`, `docs/AGENT-AUDIT-2026-08-23.md`, `phases/phase-12/FIRST-JOB.md` |
| Archive capture | 9 | 9 | 9 | **9** | `doctor`, `stats` on the warm archive; drift + 1.1.0-with-`sqlite-vec` upgrade, §B.1 |
| CLI ergonomics for a human | 8 | 7 | 6 | **7** | `find <control> --width 60/80/120 --ascii --no-color`; C8-1 |
| **Retrieval quality** | 3 | 5 | 4 | **5** | `pnpm evals` (exit 0, verb 7/60); two fresh controls; C7-2 shapes; C8-1 |
| **Reliability of a default install** | 2 | 8 | 7 | **8** | `pnpm test` ×2 drivers, `pnpm typecheck`, `check-privacy.py`, `pnpm vendor`, mcp `--selftest` |
| **Agent ergonomics** | 3 | 6 | 6 | **6** | `potsherd_recall` / `_read` / `_graft` over a real stdio MCP client; C8-2, C8-5, C8-6, C8-7 |
| Re-entry / graft | 5 | 9 | 8 | **8** | `potsherd_graft` into a scratch cwd; `potsherd_read` paging; C8-2 |
| **Overall** | **4** | **6** | **6** | **6** | everything below |

### GATE: **FAIL**

`plans/phases/phase-10-agent-audit.md §D` asks for **overall ≥ 8** (got **6** — FAIL), **retrieval
≥ 7** (got **5** — FAIL), **reliability ≥ 8** (got **8** — **PASS**), **agent ergonomics ≥ 8** (got
**6** — FAIL). One of four thresholds met.

No criterion was moved to fit a number. Reliability genuinely improved: the seam that cost round 7
its point is fixed at both ends and repairs itself in both directions. Retrieval and agent
ergonomics did not move, because nothing in the retrieval layer changed and two of round 7's four
model-door defects were never assigned.

---

## §B — are round 7's fixes real?

### B.1 C7-1 + C7-3 — **real, and the strongest work in the round**

*The seam repairs itself, both directions, on a copy of the real archive.*

Baseline, warm archive, three surfaces plus the model door, all agreeing:

```
doctor    vectors                    4,589   stopped at 4,589 of 4,774
stats     vectors                    4,589   stopped at 4,589 of 4,774
find      semantic search: not running (4,589 of 4,774 embedded) — it stopped partway
find --json   "semantic": {"embedded":4589,"pending":185,"total":4774,"phase":"warming",...}
recall        "vectors": {"vectors":4589,...}
```

Drift 1 — every stamp cleared, blobs left (the C7-1 shape) on a `cp -c` copy:

```
before stamped exchanges 1649 / ghosts 2940 → set NULL → 0 / 0, blobs 1649 / 2940
doctor  vectors 4,589  stopped at 4,589 of 4,774
stats   vectors 4,589  stopped at 4,589 of 4,774
find    semantic search: not running (4,589 of 4,774 embedded)
post    stamped exchanges 1649   blobs 1649        ← adopted on the writable open
```

Drift 2 — phantom stamps, blobs deleted:

```
blobs now 0  stamps 1649
doctor / stats / find   all: 2,940 of 4,774
post    stamps 0  blobs 0                          ← cleared, requeued
```

**1.1.0 upgrade with `sqlite-vec` present, on the real archive.** A `cp -c` copy was rewound to the
state 1.1.0 leaves: portable views/triggers/blob tables dropped, three real `vec0` virtual tables
created and loaded with the archive's own 1,649 + 2,940 + 4 vectors, `schema_migrations` cut back
to 9, `vectors:store-version` removed. One writable open through the product:

```
schema max 12
vec_blob_exchanges 1649 · vec_blob_ghost_prompts 2940 · vec_blob_cards 4
stamped exchanges 1649 · stamped ghosts 2940
sqlite_master vec%: 3 blob tables, 3 views, 6 INSTEAD OF triggers — no vec0 shadow left
doctor / stats / find  →  4,589 of 4,774, all three agreeing
```

Nothing anybody paid for was lost. The one thing the fix does not reach is the screen a 1.1.0 user
sees **before** they run `index` — C8-8.

### B.2 C7-5 — **real.** The divider caption reads `nearest by meaning · not an answer · last active`
and every row is dated by the session date. Rows are inert: no `run claude --resume`, no snippet,
no citation under the rule.

### B.3 C7-6 (60-column overflow) — **real.** Measured by east-asian display width, not bytes, at
60, 80, 100 and 120: **no line exceeds its width at any of the four.** `--ascii` emits no byte
above U+007F.

### B.4 C7-4's CI grep — **real.** `grep -q 'gate would merge this fusion'` matches the shipped
eval output exactly once (`PASS — the re-scoped gate would merge this fusion`), and does **not**
match the FAIL wording (`would not merge`), so the step cannot pass a failing run.

### B.5 C7-4's test count — **not real.** See C8-3. The number was measured in the fix report and
never carried into the document it was measured for.

### B.6 C7-7 — **not fixed, and now worse.** See C8-5.

### B.7 C7-8 — **not fixed at all.** See C8-6.

### B.8 C7-9 — **not addressed.** `tests/upgrade-from-1.1.test.ts` still hard-fails rather than
skips when `sqlite-vec` is unresolvable (`loadVec0Directly` throws with a `pnpm install` message).
The premise is at least *established* by the fixture rather than inherited, which is the more
important half; the failure mode on an unsupported platform is unchanged.

### B.9 C7-10 — **not fixed.** See C8-9.

---

## §C — new defects, ranked

### C8-1 ★★★★★ — a citation's id resolves to a different thread than the one it was minted from, for 331 of 369 sessions

`potsherd_recall` labels a subagent thread `id8: <id8-A>` and mints the citation for it. Handing
that same `id8` to `potsherd_read` — the documented next step — returns a **different thread**:

```
recall  thread <uuid>:agent-<hex>   id8 <id8-A>
        citation "<id8-A> · potsherd · claude · 1 exchange · 2026-08-24"
read (full thread id)   total 1    "<id8-A> · potsherd · claude · 1 exchange · 2026-08-24"
read (id8 only)         total 30   "<id8-A> · potsherd · claude · 30 exchanges · 2026-08-24"
```

Two citations, one id, two threads, 29 exchanges apart. The cause is structural: a subagent id is
`<parent-uuid>:agent-<hex>`, so every subagent shares its parent's first eight characters. Measured
over the real index:

```
total sessions 369 · distinct id8 prefixes 58 · prefixes shared by >1 session 20
largest collision group 41 sessions on one id8
```

`potsherd_read`'s own `citationRule` says *"A source line is one of the strings in `citations`,
copied."* Copying it produces a source line whose id does not identify the source. The human verb
is no better and does not warn: `potsherd show <id8-A>` — help text: *"by id or by any unambiguous
prefix"* — silently returns the 30-exchange parent for a prefix 42 sessions share, with no
ambiguity notice.

This lands on the release's central sentence: *"The claim is that potsherd's output can be
checked."* The in-code `verifySources` check resolves full ids and is not what fails here; what
fails is every checkable artefact a human or an agent is handed.

### C8-2 ★★★★ — `find`'s no-match screen says the withheld rows "matched some of those words"; the very next screen says they share no word with the query

Controls invented after the corpus was frozen and confirmed absent by `grep -ril` over the frozen
`.claude` and `.potsherd` trees (**0 files each**): `brimquell`, `zaxinode`, `whompery`,
`marquetry`, `lacquer`, `cabinetry`.

```
$ potsherd find "brimquell zaxinode whompery"
  nothing in the index answers "brimquell zaxinode whompery".
  31 sessions matched some of those words and none of them enough
```

No session matched any of those words. `--json` on the same query:

```
"lists": [ {"titles",0}, {"exchanges_fts",0}, {"cards_fts",0},
           {"ghosts_fts",0}, {"ghost_prompts_fts",0},
           {"vec_exchanges",100}, {"vec_ghost_prompts",100}, {"vec_cards",4} ]
"withheld": 31
```

Every keyword list returned zero candidates; all 31 withheld rows came from the vector lane.
`render/find.ts:166` hardcodes the sentence off `belowFloor`, which counts all lanes. The product
contradicts itself one flag later:

```
$ potsherd find "marquetry lacquer cabinetry" --min-confidence none
  <title>                                                    none  0.0000
    no words in common — this one matched on meaning
```

The model door says the true thing on the same query (`"31 rows were withheld below the weak
floor"`), so this is one surface fixed and its neighbour left saying the old thing — on the screen
the release's honesty claim rests on (*"says which half of the search produced that verdict"*).

### C8-3 ★★★★ — "verified at this tag" is wrong on the test count, in the release C7-4 was filed to fix, and the fix report's own number is wrong too

`docs/release/RELEASE-NOTES-v1.2.0.md:175-176`:

```
2,027 tests, 55 files · macOS and Ubuntu × Node 22 and 24
the same suite again on Node's own SQLite (POTSHERD_SQLITE=node) — 2,027, 0 skipped
```

Measured on the commit under test, in a clone nothing edited:

```
pnpm test                        Test Files 55 passed (55)   Tests 2034 passed | 4 skipped (2038)
POTSHERD_SQLITE=node pnpm test   Test Files 55 passed (55)   Tests 2034 passed | 4 skipped (2038)
skipped: tests/adapters/codex.test.ts (3), tests/adapters/pi.test.ts (1)
```

Both drivers exit 0. Three numbers are wrong: **2,027** (it is 2,038 collected / 2,034 passed) and
**0 skipped** (there are 4, on both drivers). `phases/phase-11/V7FIX-REPORT.md:217-218` records the
fix as `55 files · 2038 passed · 0 failed · exit 0 (was 2027, 5 skipped)` — so the measurement was
taken, is itself wrong about the split (2,034 passed, not 2,038), and was never carried into the
block whose only job is to be the measured record.

### C8-4 ★★★ — the CHANGELOG states hybrid's recall@5 as 51 where the eval and the release notes say 57

`CHANGELOG.md`, "A no-match reply now says which half produced it":

> the gap is measurable: bm25 alone answers 40 of 60 eval queries at recall@5 against hybrid's 51.

Measured, this commit, `pnpm evals` exit 0:

```
bm25 only    ranking recall@5 40/60   recall@1 31/60
vectors only ranking recall@5 57/60   recall@1 40/60
hybrid(auto) ranking recall@5 57/60   recall@1 42/60
```

51/60 is two other things — the gate's ratchet floor (`✓ ≥ 51/60`) and a phase-10 mid-flight
measurement (`phases/phase-10/T10.9-REPORT.md:327`) — and neither is hybrid's recall@5 at this tag.
The release notes on the same tag print 57. The CHANGELOG's own opening rule is that every number in
it is traceable to a recorded command; this one traces to a superseded run.

### C8-5 ★★★ — the reply the tool tells an agent to ask for hands back rows labelled `none` with `citable: true`, a minted citation, and the warning removed

The default no-match reply's `note` says:

> Call again with `minConfidence: "none"` to see those rows — they are the closest text, not an
> answer, **and may not be cited as one**

Doing exactly that (`potsherd_recall {query, minConfidence:"none"}` over a real archive):

```
envelope weak   noMatch false   belowFloor 0   note: null
 row 0 weak 0.1445 …           row 1 none 0.1422 …    row 2 none 0.1510 …
 row 3 none 0.1422 …           row 4 none 0.1337 …    row 5 none 0.1469 …
```

and row 2 in full:

```
"confidence": "none",
"calibration": {"score":0.2823,"confidence":"none","coverage":0.333,...},
"lane": "evidence",  "evidence": "transcript",
"citable": true,
"citation": "<id8-B> · <project> · claude · ghost, prompts only · 2026-02-17"
```

Seven rows labelled `none` under an envelope labelled `weak`, every one of them `citable: true`
with a minted citation, and the `note` that carried the "may not be cited" caveat is **`null` in
this reply**. This is C7-7's shape, unfixed, with the caveat now missing from the only reply that
contains the rows it is about. (Row 2 also outscores row 0, which is intended — ordering is by
label, per the CHANGELOG — but it means the highest-scoring row on the page is the one that may not
be cited.)

### C8-6 ★★★ — C7-8 unfixed: a bad `scope.project` still answers the model door with twelve absolute home paths

```
$ potsherd_recall {"query":"…","scope":{"project":"no-such-project-<invented>"}}
no indexed project matches "no-such-project-<invented>". The index holds 55:
/Users/<user>/<project-1>, /Users/<user>/<project-2>, … (twelve absolute paths) … and 43 more
```

Round 7 filed this at ★★; nothing changed. The CHANGELOG claims this exact string was fixed — *"a
bad project name is answered with **the projects the index holds**, tail disclosed"* — which is
true of the *counts* and false of the *paths*: the reply hands the model the user's home directory
name and twelve project names it was not asked for.

### C8-7 ★★ — the agent door cannot say "nothing is warming" when the vector half ran, which is the state the archive is actually in

`packages/mcp/src/tools/recall.ts:939`:

```ts
if (v.used) return `keyword + semantic search${counts}`;
```

so the `report.working === false` branch below it is unreachable whenever vectors were used. On the
same database, in the same second:

```
find    semantic search: not running (4,589 of 4,774 embedded) — it stopped partway
recall  "capability": "keyword + semantic search (4,589 of 4,774 embedded)"
```

The release notes promise *"if **nothing** is warming, it says that instead of telling the reader to
wait."* That is true of `find` and false of `potsherd_recall`: an agent reading `4,589 of 4,774` has
been told a fraction with no verdict, and the reasonable inference — the other 185 are coming — is
the retry instruction FIX-F C2 exists to prevent.

### C8-8 ★★ — on a 1.1.0 database, `doctor` reports `0 of 4,774` over a store holding 4,589

The rewound copy from §B.1, `sqlite-vec` present, before any writable open:

```
database   schema v9 of v12  · run potsherd index
vectors                —   not running, 0 of 4,774
(the same file: 1,649 vec0 exchange vectors, 2,940 ghost vectors, 1,649 + 2,940 live stamps)
```

`vectorCounts` reads blob tables that schema 9 does not have. This is the C7-3 shape surviving on
the read-only path, on the exact screen a 1.1.0 user is most likely to run first, in the release
whose upgrade note says *"Everything else is additive. The index migrates itself."* The vectors do
survive (§B.1); the number shown before the migration does not describe them.

### C8-9 ★★ — both release documents say five independent verifications; there are seven, and this is the eighth

`docs/release/RELEASE-NOTES-v1.2.0.md:145`: *"Independent verifiers — five of them"*.
`CHANGELOG.md`: *"### what five independent verifications changed … scoring it **4 → 6 → 7 → 7 →
…**"*. `phases/phase-10/` holds `VERIFICATION.md` and `VERIFICATION-2.md` … `VERIFICATION-7.md`.
The release notes' companion sentence — *"The first four found twenty-seven defects"* (9+6+5+7=27) —
is right, which is what makes the five wrong rather than a rounding. The trailing ellipsis in the
CHANGELOG's score sequence hides that the overall score went back **down** to 6 in rounds 6 and 7;
the sentence directly above it promises *"every FAIL kept on the record"*.

### C8-10 ★ — C7-10 unfixed: the release's headline surface has no published screen

```
$ grep -rl "no match" docs/screens/ README.md   → (nothing)
$ grep -rn "nearest by meaning" docs/ README.md → only docs/release/RELEASE-NOTES-v1.2.0.md:93
```

Ten screens are diffed in CI and none of them is the empty verdict, the divider, or a `no match`
line. The one surface the release is named for is the one nobody can see before installing.

### C8-11 ★ — "strictly above both" is a tie at recall@5

`RELEASE-NOTES` "verified at this tag": `hybrid recall@5 57/60 recall@1 42/60 ← strictly above
both`. Measured: vectors-only is also **57/60** at recall@5. The gate itself is worded correctly
(`≥` at @5, `>` at @1); the release note is not.

### C8-12 ★ — `doctor` calls the claude adapter `ready` at a directory it says on the same screen does not exist

```
$ potsherd doctor --claude-dir <a path that does not exist>
  claude sessions on disk        0   0 harness-titled · 0 sdk · 0 B
  adapters:
    claude      ready     <missing>/projects   48 sessions · 304 sidechains · 352 from the archive
  note: no projects directory at <missing>
```

`352 from the archive` is the honest half; `ready`, next to `0 on disk` and a note saying the
directory is absent, is the word that says *I can read your live sessions*.

### C8-13 ★ — a model-door string still tells an agent to run something it cannot run

`potsherd_graft` with no backend returns
`"reason": "claude --print could not answer: Not logged in · Please run /login"`. It is a quoted
subprocess error rather than potsherd's own prose, and `/login` is a slash command rather than a
shell command, so it is not a clean breach of *"No string an agent reads asks it to run a shell
command"* — but it is an instruction the caller has no way to follow, which is the class that
sentence exists to close.

---

## §D — claims that held

- **`pnpm typecheck` 4/4**, exit 0. **`pnpm test` exit 0 on both drivers**, 55 files.
  **`pnpm vendor` no diff** (`git status` clean after). **mcp `--selftest`: 25 checks, all passed.**
- **`check-privacy.py --selftest` exit 0, "25 probes, all as expected"; `check-privacy.py` exit 0**,
  604 files swept, 0 pinned violations, **19 unaccounted (ceiling 19)** — all three figures exactly
  as the release notes print them.
- **`pnpm evals` exit 0**, verb ratchet **7/60 @5 and @1**, 52/60 empty pages, and every ranker
  number in the release notes' eval block matches (bm25 40/31, vectors 57/40, hybrid 57/42).
- **The re-scoped gate really fails**, all three ways: `--no-vector-lists` → exit **1**
  (`✗ ≥ 51/60`, `✗ > bm25`); `--vector-weight 0` → exit **1** (`✗ ≥ vectors (52)`); and a seeded
  verb regression → exit **1** with `verb (ratchet) recall@5 4/60 ✗ ≥ 7/60` (§F). The verb clause
  is not a test that cannot fail.
- **C7-2 behaves exactly as documented, and no worse shape exists.** On the real archive, invented
  words absent by `grep -ril`: `brimquell database` → `none`, 0 rows; `brimquell database
  migration` → `weak`, 2 rows; `brimquell database migration schema` → `weak`, 4 rows; `zaxinode
  typescript compiler errors` → `weak`, 1 row; `whompery react component state hooks` → `weak`,
  1 row. Nine further shapes were tried; **the ceiling is `weak` in every case** — no invented-word
  query reached `strong`, and adding invented words eventually pushes it back to `none`
  (`brimquell zaxinode whompery potsherd vectors embedding sqlite` → `none`, 0 rows).
- **Silence is real on fresh controls.** Both controls invented after the freeze return
  `no match · 0 rows`, with the divider, dates and inert rows.
- **`--min-confidence none` prints what was withheld**, scored `0.0000`, captioned `no words in
  common — this one matched on meaning`.
- **The upgrade note is true and enforced.** `ask --synthesis-out <path>` alone: refuses, names both
  commands, **exit 1**, and writes no file.
- **`--no-redact` does not exist** on `find` or `ask`.
- **Ten published screens are diffed in CI** — `grep -cE '^\s+check [0-9]' .github/workflows/ci.yml`
  → **10**. The README's copy of the privacy receipt still matches the screen byte for byte
  (127 lines) under CI's own comparison script.
- **F3 is fixed in the shipped plugin**: `plugins/claude-code/agents/session-archaeologist.md`
  carries `tools: …potsherd_recall, …potsherd_read` and no `Read`.
- **F7**: `TOOLS = ['potsherd_recall','potsherd_read','potsherd_graft']`, three tools at the door.
- **F4 at the model door**: `potsherd_read` returns `via: "core"` with `links`, per-page citations,
  `hasMore`/`nextFrom`, and a `citationRule` — no probe, no fallback.
- **No auto-injection.** `plugins/claude-code/hooks/brief.sh` is gated on `"briefOnStart": true` in
  `config.json` and exits 0 otherwise; `session-start.sh` emits only `systemMessage`, never
  `additionalContext`.
- **`potsherd_graft` degrades honestly** with no backend: `via: "card-only"`, a stated reason,
  `sourcesChecked: true`, `refusedSources: []`, budget respected.

---

## §E — what I could not check

- **CI itself.** Everything here ran on one macOS machine, Node v24.9.0, one architecture. The
  matrix (`macos`/`ubuntu` × Node 22/24), the sigstore provenance attestation, and the packed-tarball
  `npx` step were read, not run.
- **The `ask` model path end to end.** No credentials in the isolated `HOME`; `ask` and `graft` were
  exercised only down their no-backend rungs. The citation filter's substring re-check was therefore
  observed through `verifySources` in the mcp selftest, not against a live model answer.
- **The `--privacy` receipt on a real machine.** Read and diffed against the README; not regenerated
  against a live `~/.claude`, which the isolation rules forbid.
- **Whether C8-1's collision was ever reachable through `ask`'s SOURCES block.** The in-code check
  resolves full ids and refused nothing on the graft path, so I state the defect only for what an
  agent or a human is handed, not for what the filter validates.
- **`node:sqlite` on a Node where the schema pragma is silently ignored** (the release notes'
  last upgrade line). Only v24.9.0 was available here.

---

## §F — my one change, and its revert

One line, to prove the verb ratchet added in phase 11 is not a test that cannot fail.

```diff
--- a/packages/core/src/calibration.ts
+++ b/packages/core/src/calibration.ts
-export const WEAK_FLOOR = 0.5;
+export const WEAK_FLOOR = 0.9;
```

`pnpm evals` with it in place:

```
  · verb (ratchet)  recall@5   4/60   ✗ ≥ 7/60   recall@1   4/60  ✗ ≥ 7/60    FAIL
  FAIL — the re-scoped gate would not merge this fusion
EVALS_EXIT=1
```

Reverted with `git checkout -- packages/core/src/calibration.ts`; `grep -n '^export const
WEAK_FLOOR' packages/core/src/calibration.ts` → `423:export const WEAK_FLOOR = 0.5;`; rebuilt;
`git status --short` empty. The ranker clauses are unaffected by the change, which is what makes it
a clean probe of the verb clause alone.

---

## §G — isolation, controls, disk, pids

**Isolation.** `~/.potsherd` and `~/.claude` were APFS-cloned (`cp -Rc`) into a scratch `HOME` under
the session scratchpad; the repository was `git clone`d and checked out at `5199b21`; `node_modules`
was APFS-cloned rather than reinstalled (free space unchanged across the copy, confirming
copy-on-write). Every invocation ran with `HOME` repointed and
`CLAUDE_CONFIG_DIR POTSHERD_DIR XDG_CONFIG_HOME NODE_PATH CODEX_HOME ANTHROPIC_API_KEY` unset.
Drift and 1.1.0 fixtures were built on further `cp -c` copies, never on the clone of the archive
used for the baseline. **The real `~/.potsherd/potsherd.db` mtime is unchanged** (`25 Aug 00:45`,
hours before this session began). The clone of the repository ends with `git status --short` empty.

**Controls**, invented after the corpus was frozen, none of them from `VERIFICATION-{3..7}`,
`C1-REPORT.md` or `evals/queries.jsonl`, each confirmed absent by `grep -ril` over the frozen
`.claude` and `.potsherd` trees **and** over the repository (0 files each):

```
nonsense       brimquell  ·  zaxinode  ·  whompery
absent topic   marquetry lacquer cabinetry            (real English, real subject, absent here)
also screened  trebuchet snowshoe crampon transceiver bassoon moraine xylophone cabinetry  (0)
rejected       sourdough(31) kiln(84) counterweight(23) alpaca(17) veneer(32) oboe(92) tuba(105)
```

**Disk.** `df -h /` at start **4.3 GiB** free, at finish **4.1 GiB**; the whole scratch tree is
3.7 GiB, almost all of it APFS clones that cost nothing. Nothing was abandoned for lack of space.

**Processes.** Four background pids, all mine, all launched from the scratch clone, all confirmed
exited by `ps -p` at the end rather than killed: **68011** and **68036** (`vitest`, native driver),
**71367** (`POTSHERD_SQLITE=node pnpm test`), **75383** (`pnpm evals`). `pgrep -f scratchpad/v8`
returns nothing. No pid outside this session was signalled.

---

## the recommendation

**Do not tag this as it stands — but the blocker is one defect, not thirteen.**

C8-1 is the only finding that touches the sentence the release is built on. Everything a reader or
an agent is given to check potsherd's output with — the `citation` string, the `id8` in it,
`potsherd_read`'s own `citationRule`, `potsherd show <prefix>` — carries an identifier that names
331 of 369 sessions ambiguously, and silently resolves to the wrong one. A release whose thesis is
*"potsherd's output can be checked"* should not ship with its checking token non-unique, and the
fix is small: mint and accept the full thread id, or lengthen the prefix past the `:agent-` split.

C8-2, C8-3, C8-4 and C8-9 are four documents disagreeing with four commands, all four fixable in an
afternoon and none of them requiring a code change. C8-5, C8-6 and C8-7 are the model door, and two
of the three were filed a round ago and never assigned — which is the pattern worth naming: this
round's unfixed defects are not the hard ones, they are the unassigned ones.

The archive half remains excellent and the vector seam that cost round 7 its point is genuinely,
measurably closed in both directions and across the 1.1.0 upgrade with the extension present. That
work is real. It is the reason reliability is the one threshold this gate meets.

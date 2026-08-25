# VERIFICATION-7 — the seventh independent verification, before the v1.2.0 tag

**Commit under test:** `origin/main` @ `badd4ca` ("release notes: say plainly what find does not
answer"). Cloned to a scratch directory; the working checkout was never modified.
**Verifier authored none of this.** 25 aug 2026.

**Scope ruling honoured.** C-1 (the verb answers 7/60 where the ranker answers 42/60, 52 empty
pages) is confirmed, reproduced, and **not counted as a new defect** — meghavi ruled it carried
forward as `phases/phase-12/FIRST-JOB.md`, and the release notes state it plainly. This report
scores the product as it is and judges whether the documents and the behaviour agree.

They do not, in four places. One of them is the sentence the release's whole honesty claim rests on.

---

## §A THE EIGHT ROWS

| row | audit | v5 | v6 | **v7** |
|---|---:|---:|---:|---:|
| Overall | 4 | 7 | 6 | **6** |
| Concept | 9 | 9 | 9 | **9** |
| Capture | 9 | 9 | 9 | **9** |
| CLI (human) | 8 | 7 | 7 | **6** |
| Retrieval | 3 | 7 | 5 | **4** |
| Reliability | 2 | 8 | 8 | **7** |
| Agent ergonomics | 3 | 7 | 6 | **6** |
| Re-entry | 5 | 8 | 9 | **8** |

### GATE: **FAIL** — overall 6 (needs ≥ 8) · retrieval 4 (needs ≥ 7) · reliability 7 (needs ≥ 8) · agent ergonomics 6 (needs ≥ 8). All four thresholds missed.

**Overall — 6.** The archive half and the honesty machinery are real and mostly hold. Against them:
every status surface on this machine reports semantic search dead while `find` is using 4,593 live
vectors (C7-1); an invented topic padded with two ordinary words reaches `weak` with quotable
snippets at both doors, 4 attempts out of 4 (C7-2); the upgrade verb drops the vectors the CHANGELOG
says it keeps (C7-3); and the release notes' "verified at this tag" block is 42 tests wrong (C7-4).

```
$ potsherd doctor            # scratch HOME, APFS clone of the real 1.0 GB archive
  vectors                        —   not running, 0 of 4,774
$ sqlite> SELECT COUNT(*) FROM vec_blob_exchanges;      1649
$ sqlite> SELECT COUNT(*) FROM vec_blob_ghost_prompts;  2940
$ sqlite> SELECT COUNT(*) FROM vec_blob_cards;             4
```

**Concept — 9.** Unchanged. Nothing found touches the idea.

**Capture — 9.** Unchanged and untouched by this release.

```
$ potsherd doctor
  ghosts stored                299   2,971 prompts
  files archived               403   468 MB of source, byte-exact
  sessions indexed              56   313 subagents · 1,803 exchanges
```

**CLI (human) — 6** (was 7). The divider is well made and does what `plans/05` asks (§B). Four of
round 6's five CLI defects are genuinely fixed (§B). But the no-match page prints
`bm25 + vectors` in its header and `semantic search: not running (0 of 4,774 embedded)` six lines
below it (C7-1); the new region overflows a 60-column terminal by up to nine characters (C7-6); and
it dates its rows by `startedAt` while every other surface in the product now says
`last active` (C7-5).

```
$ potsherd find "<invented-word>" --width 60 | awk '{printf "%3d|%s\n", length($0), $0}'
 65|potsherd find "…" · no match · bm25 + vectors · 2.4s
 69|    none  can you do… <project-name-31-chars> · 4 may 2026     <- 9 over
 52|  semantic search: not running (0 of 4,774 embedded)
```

**Retrieval — 4** (was 5). The C-1 silence is unchanged and out of scope. What is in scope is the
opposite failure, which is worse and is new to this record: **the floor does not stop an absent
topic when the query carries two ordinary words beside the invented one.** Four fresh controls,
invented after the corpus was frozen and confirmed absent by `grep -ril` and by SQL over
`exchanges`:

```
zarbomite deployment rollback      conf=weak   rows=1   withheld=31
brindlewax database migration      conf=weak   rows=4   withheld=26
vontessery test coverage           conf=weak   rows=5   withheld=27
quillfratch protocol failure       conf=weak   rows=3   withheld=28
plumthwacket                       conf=none   rows=0   <- bare gibberish still works
```

Four of four. The release notes say *"a query the archive cannot answer returns zero rows and says
so"*; `FIRST-JOB.md` lists *"anything that lets a nonsense query or a genuinely-absent topic reach
`weak` at either door"* as what would make a bad answer. See C7-2.

**Reliability — 7** (was 8). Everything claimed as green is green and reproducible (§D), and the
re-scoped gate really can fail — all three ways, verified (§B). The point off is C7-3: on a database
written by 1.1.0, with `sqlite-vec` installed and resolvable, `potsherd index` — the verb the upgrade
notes tell you to run — leaves zero vectors, on both drivers, while `potsherd stats` on the identical
fixture migrates the same database and keeps them. No test catches it.

**Agent ergonomics — 6.** The model door's shape is right and I could not break it: `noMatch: true`,
`hits: []`, rows only under a separate `nearest` key with no citation, `belowFloor` a real integer,
`nearestNote` saying in words that these may not be quoted. Three tools, `readOnlyHint` correct.
Against it: `capability` is false (C7-1); an envelope labelled `weak` carries three rows every one of
which is labelled `none`, one of them with `calibration.score = 0` and `coverage = 0` (C7-7); and a
bad `scope.project` answers with **twelve absolute home paths** (C7-8).

**Re-entry — 8** (was 9). Threads, dating and `--resume` are consistent at `find` and `ls` (C-6
really is fixed, §B). Docked one for C7-5: the region added *after* C-6 was fixed re-introduces
C-6's exact shape inside itself.

---

## §B ARE THE FIXES SINCE ROUND 6 REAL?

**C-1 — confirmed, correctly descoped, honestly documented.** `pnpm evals` reproduces
`GATE-REPORT.md` and `FIRST-JOB.md` to the digit, and the gap line and the phase-12 pointer are on
the screen:

```
$ pnpm evals                                                    exit 0
  hybrid (auto) · ranker    recall@5  57/60   ✓ ≥ bm25 (40)  ✓ ≥ vectors (57)  ✓ ≥ 51/60
                            recall@1  42/60   ✓ > bm25 (31)  ✓ > vectors (40)
    · verb (ratchet)        recall@5   7/60   ✓ ≥ 7/60       recall@1  7/60  ✓ ≥ 7/60   PASS
                            52/60 empty pages, 50 answers ranked in the top 5 and withheld
  the gap · … closing it is phase 12's named target · phases/phase-12/FIRST-JOB.md
  confidence controls · 6 of 6 ok
```

**The re-scoped gate can still fail, all three ways.** Verified today, not read:

```
$ pnpm evals -- --no-vector-lists     exit 1
  ranker recall@5 40/60  ✗ ≥ 51/60 · recall@1 31/60  ✗ > bm25 (31)      2 clauses red
$ pnpm evals -- --vector-weight 0     exit 1
  ranker recall@5 50/60  ✗ ≥ vectors (52)  ✗ ≥ 51/60                    2 clauses red
$ (seeded one-row verb regression — §F)   exit 1
  ranker 57/42 all ✓ ; verb 6/60 ✗ ≥ 7/60, 6/60 ✗ ≥ 7/60                FAIL
```
The clause counts match `GATE-REPORT.md §2b/§2c/§2d` exactly, including that `--vector-weight 0` is
now red on two rather than one.

**C-2 (timezone) — FIXED.** `ls --until 2026-08-10` echoes `until 2026-08-10` in UTC,
`Pacific/Kiritimati`, `America/Los_Angeles` and `Asia/Kolkata`. Four for four.

**C-3 (score column ≠ sort order) — FIXED.** Five queries, every printed score monotone descending
and consistent with the label:
`0.9250 0.9250 0.9250 0.8218 0.8150 0.8099 0.7919 0.7761 0.7718 0.7630`.

**C-4 (doctor 49 vs stats 56) — FIXED.** `doctor` and `stats` both print `sessions … 56` on the same
index in the same minute.

**C-5 (`potsherd_recall` prints two vector counts in one object) — NOT FIXED.** Same defect, worse
numbers, and now the first of the two is false:
```
"capability": "keyword + semantic search (0 of 4,774 embedded)",
"vectors": { "used": true, "available": true, "vectors": 1649, "working": false }
```
Folded into C7-1 below, because it is now more than an inconsistency.

**C-6 (find and ls date a session at opposite ends) — FIXED at `find` and `ls`, RE-INTRODUCED in the
new region.** See C7-5.

**C-7 (`find` says warming while doctor says fetching) — cannot reproduce the reported shape**; the
lock-derived flag is real and `find` prints `not running` where nothing runs. But on this archive it
prints `not running` where something *is* running — C7-1 is the same seam failing the other way.

**C-8 (stranded database prescribes `potsherd index`) — FIXED.** The three tests that assert the
non-prescription pass on Node 24.19.0 on both drivers.

**C-9 (`lane: evidence` on `citable: false`) — unchanged, and still ★, for the reason round 6 gave.**

---

## §C NEW DEFECTS, RANKED

### C7-1 ★★★★★ — every status surface says semantic search is off; `find` is using 4,593 vectors, and the header on the same screen says so

The archive on this machine holds **1,649 + 2,940 + 4 = 4,593** vectors in `vec_blob_*`, and
`embedding_version` is `NULL` for all 4,774 rows of `exchanges` + `ghost_prompts`. `vectorCounts()`
(`packages/core/src/vec.ts:985`) counts the **stamp**; the search lane reads the **store**. They
disagree, and nothing cross-checks them.

```
$ potsherd doctor  |  potsherd stats
  vectors                        —   not running, 0 of 4,774

$ potsherd find "<invented-word>"
potsherd find "…" · no match · bm25 + vectors · 2.2s          <- header: both halves ran
  …
  semantic search: not running (0 of 4,774 embedded)          <- six lines below: neither did

$ potsherd find "<invented-word>" --json
  "vectors": { "used": true, "available": true, "vectors": 1649, "working": false }

$ potsherd_recall(query: "<invented-word>")
  "capability": "keyword + semantic search (0 of 4,774 embedded)",
  "lists": [ …, {"list":"vec_exchanges","candidates":100}, {"list":"vec_ghost_prompts","candidates":100},
                {"list":"vec_cards","candidates":4} ]
```

Two hundred and four semantic candidates produced the entire `nearest` region on that page, and the
model door told the agent nothing was embedded. **This is the release's own headline property
failing:** *"Silence is an answer … the tool says so, and says which half of the search produced
that verdict."* On this archive it says the wrong half, on both doors, in the reply that asks to be
trusted. It is round 5's `warming`-with-no-worker defect and round 6's C-5 and C-7, in one place,
inverted.

`vec.ts:927` states the premise that is false: *"`exchanges.embedding_version` is the stamp
*everything* reads."* `recall.ts`'s vector lane does not read it. **Not reachable on a clean
install** — I checked: fresh index, `--embed`, `blob=2 stamped=2`, `doctor` agrees. It is reachable
on a real 428 MB archive, which is the only kind that matters.

### C7-2 ★★★★ — an invented topic reaches `weak`, with quotable snippets and a resume command, whenever two ordinary words ride along

Controls invented after freezing the corpus; `grep -ril` over the repository returns 0 files for each
and SQL over `exchanges` returns 0 rows for each.

```
$ potsherd find "quillfratch protocol failure"
potsherd find "quillfratch protocol… · 3 sessions · weak · bm25 + vectors · 1.9s

  ↳ You are the executing engineer for one phase of the Pro…       claude · sidechain
  <project> · last active 8 jul · 4 exchanges · HEAD                    weak  0.5544
    …+ question count, checklist pass/fail per box, total test count,…
    run  claude --resume <id>                            <- an instruction, on a fiction
  …
  run  potsherd show <id8>  to read one, or  potsherd ask <words>
```

`coverage = 0.667` (two of three literal terms), `× (0.60 + 0.25·strength) = 0.5596 ≥ WEAK_FLOOR
0.50`. `KEY_TERMS_REQUIRED = 1` does not stop it: the rule asks whether the row shows *one*
distinctive word, and it shows the two that were never the question. `calibration.ts:485-505`
documents this exact arithmetic as the `bluetooth on the checkout page` failure and says the rule
"restores that promise" — it restores it only against rows showing zero terms.

**The six confidence controls cannot see it.** Five of the six absent-topic controls are four-word or
five-word queries (coverage ≤ 0.5, under the floor by construction); the sixth is bare gibberish,
which fts5 rejects before scoring. There is no 2-of-3 control. Bare `plumthwacket` and
`quillfratch` correctly return `none`; add two nouns and the floor is gone.

Same at the model door: `noMatch: false`, `confidence: "weak"`, three hits with snippets.

### C7-3 ★★★ — `potsherd index` drops the vectors the CHANGELOG says it keeps, on both drivers, with `sqlite-vec` installed

CHANGELOG, upgrading from 1.1.0: *"where it is still present, it copies every vector across first, so
nothing anybody has already paid for is lost."*

A database built to `tests/upgrade-from-1.1.test.ts`'s own recipe (real vec0 virtual tables, real
vectors, `embedding_version` stamped, `schema_migrations` rewound to 9), then the shipped binary,
`sqlite-vec` present and resolvable:

```
                                   vec_blob_exchanges   exchanges stamped
  before                                  (no table)                    2
  after  potsherd index --no-embed                 0                    0     both drivers
  after  potsherd stats  (same migration)          2                    2     both drivers
```

Same binary, same machine, same fixture, opposite outcomes. `stats` migrates and keeps them;
`index` — the verb the upgrade section names — ends with none. Verified with
`POTSHERD_SQLITE=better-sqlite3` and `POTSHERD_SQLITE=node`.

**And the test suite cannot catch it.** `it('keeps every vector when the extension IS on the
machine')` asserts through `store.open()` from source, which does keep them
(`blob=2 stamped=2`, verified). `it('the whole verb: potsherd index completes on it, through the
binary')` goes through the binary but asserts only that the verb completes. The one assertion and
the one code path never meet.

### C7-4 ★★★ — "verified at this tag" is 42 tests wrong, in the block whose only job is to be the measured record

`docs/release/RELEASE-NOTES-v1.2.0.md:168-169`:
```
1,985 tests, 55 files · macOS and Ubuntu × Node 22 and 24
the same suite again on Node's own SQLite (POTSHERD_SQLITE=node) — 1,985, 0 skipped
```
Measured on `badd4ca`, clean clone, `pnpm install && pnpm build && pnpm test`:
```
better-sqlite3   Test Files  55 passed (55)   Tests  2022 passed | 5 skipped (2027)   exit 0
node:sqlite      Test Files  55 passed (55)   Tests  2022 passed | 5 skipped (2027)   exit 0
```
55 files is right; **1,985 is stale by 42**. The CHANGELOG's own opening rule is that every number in
it is traceable to a recorded command; this is the release notes' equivalent block and its headline
number is not. The `0 skipped` is also environment-dependent — the five skips are
`describe.skipIf(!hasFrozen/!hasLive/!hasReal)` and `it.skipIf(!present)` over real `~/.claude`,
`~/.codex`, `~/.pi`. They skip loudly, which is right; the published claim is what is wrong.

### C7-5 ★★★ — the region added to fix C-1 dates its rows the way C-6 was fixed for not doing

`render/find.ts:236`, inside `nearestNote`, the code written this phase:
```
const when = s.startedAt ? f.date(s.startedAt) : t.dash;
```
`render/find.ts:417-425` is the C-6 fix, four lines of comment away, explaining that this exact
spelling was the bug and that the column is `last active`. One session, three surfaces, same run:

```
 nearest row (find, no-match page):   none  <title>              <project> · 20 aug 2026
 find hit row:                        <project> · last active 24 aug · 85 exchanges
 ls row:                                   24 aug  claude  <project>  <title>  live
```

Four days apart, and the nearest region has no column header, so nothing on the page says which end
it is showing. The model door repeats it: `nearest[].startedAt` only. This is the eleventh-hour
pattern the hunting list names — a fix that corrects one surface and leaves its neighbour saying the
old thing — except the neighbour is younger than the fix.

### C7-6 ★★ — the divider region overflows a 60-column terminal

`nearestNote` computes `room = width - INDENT - 2 - label - 1 - len(where) - 2` and then elides to
`Math.max(12, room)`. When the project name is long, `room` goes negative and the floor of 12
guarantees an overflow; `where` is never dropped, though the comment above the line says *"`where` is
dropped before the title is."*

```
$ potsherd find "<invented>" --width 60 | awk '{print length($0)}'
 …
 69      <- "    none  can you do… <31-char-project-name> · 4 may 2026"
```
Nine over, so the row wraps and the region stops reading as a region — at exactly the width the
docstring says the five-row limit was chosen for. `--ascii` and `--no-color` are correct.

### C7-7 ★★ — `potsherd_recall` puts `weak` on an envelope over three rows all labelled `none`, one of them scoring zero

```
envelope confidence: weak
  hit 0  none  calibration.score 0.2774  coverage 0.333
  hit 1  none  calibration.score 0.2666  coverage 0.333
  hit 2  none  calibration.score 0.0000  coverage 0.000
```
The last row shares no word with the query at all and is still delivered as evidence under a `weak`
envelope. The release notes promise rows *"each labelled with how well it actually matched"* — they
are, and every label contradicts the envelope above them. This is the shape the CHANGELOG says was
fixed ("a **card** … labelled `none`, at the top of a reply whose envelope said `strong`"); it was
fixed for the *ordering* and not for the *envelope*.

### C7-8 ★★ — a bad `scope.project` answers the model door with twelve absolute home paths

```
$ potsherd_recall(query: "…", scope: {project: "no-such-project-xyz"})
  isError: true
  "no indexed project matches "no-such-project-xyz". The index holds 55:
   /Users/<user>/<project>, /Users/<user>/<project>, … and 43 more"
```
Round 5's fix was to answer with the projects the index holds rather than a `jq` pipeline, and that
part works. But `render/find.ts`'s own rule for the same fact is *"Counts, never names: the projects
are directories off the user's machine and `find` is a screenshot surface"*, and the CHANGELOG
records *"`--json` returned an absolute path where the terminal showed a short project name"* as a
defect it fixed. The MCP error path returns twelve full home paths into an agent's context.

### C7-9 ★ — the ten tests that prove the 1.1.0 upgrade path hard-fail, rather than skip, when `sqlite-vec` is unresolvable

With `sqlite-vec` removed from `node_modules`, all ten fail at fixture construction on both drivers.
The failure is loud and the message is exact (*"this test builds real vec0 virtual tables and needs
sqlite-vec to do it"*), so this is not a green-that-means-not-run. It is filed at ★ because the
fixture's own docstring claims the opposite premise — *"the fixture loads vec0 itself, on this
handle, **whatever the environment says**"* — and the machines that hit the bug these ten tests
exist for are exactly the machines without the extension.

### C7-10 ★ — the release's headline new surface has no published screen

`docs/screens/` holds seventeen screens, ten of them re-run and diffed live in CI. None of them is a
no-match `find`. `grep -rn "nearest by meaning" docs/ README.md` matches only the release notes prose.
The guard that exists because *"a published screen still printed an instruction the product had
deleted"* does not cover the region this release was extended to add.

---

## §D CLAIMS THAT HELD

| claim | how checked | result |
|---|---|---|
| suites green on both drivers | `pnpm test`, `POTSHERD_SQLITE=node pnpm test`, exit codes read | 55 files, 2022 passed, 5 skipped, **exit 0** both |
| typecheck 4/4 | `pnpm typecheck` | 4 packages, **exit 0** |
| evals exit 0 | `pnpm evals` | **exit 0**, every number reproduces |
| guard exit 0 | `python3 scripts/check-privacy.py` | **exit 0**, 19 unaccounted (ceiling 19), 0 pinned |
| 25 probes | `check-privacy.py --selftest` | `25 probes, all as expected.` |
| `pnpm vendor` no diff | `pnpm vendor && git status --porcelain` | empty |
| the divider is inert | 60/80/120 cols, `--ascii`, `--no-color` | no snippet, no resume, no citation, ever |
| the model door on no-match | `potsherd_recall` over stdio | `noMatch: true`, `hits: []`, `nearest` separate, `belowFloor: 32`, `nearestNote` forbids quoting |
| `find` exits 1 on no match | exit code read directly, not through a pipe | `EXIT=1` |
| `--min-confidence none` shows the withheld | run | 10 rows, each labelled `none`, one saying *"no words in common — this one matched on meaning"* |
| `potsherd_recall(minConfidence)` | run | accepted, returns the withheld rows |
| `--synthesis-out` refuses without `--readers-in` | run, exit code read | refuses, names both commands, **exit 1** |
| no `--no-redact` anywhere | `--help` sweep | absent |
| three MCP tools, write hint correct | `tools/list` | `recall ro=true, read ro=true, graft ro=false` |
| ten of seventeen screens diffed live | ci.yml + `ls docs/screens` | 17 screens, 10 named for the live diff |
| vec0 upgrade, both drivers, Node ≥ 24.19.0 | downloaded v24.19.0; ran the 10 upgrade tests | **10 passed** on both drivers |
| `PRAGMA writable_schema` silently ignored on 24.19.0 | direct probe on both node builds | 24.19.0 reads back `0` and refuses the delete; 24.9.0 reads `1` and deletes. The claim is exact. |
| the whole verb on a 1.1.0 database, no `sqlite-vec`, Node 24.19.0 | binary, both drivers | converts, vec0 gone, no crash, honest `0 of 2` |
| `--no-cards` | `find --no-cards --json` | `cards: false`, lane off |
| C-2, C-3, C-4, C-6, C-8 | §B | all genuinely fixed |

---

## §E WHAT I COULD NOT CHECK

- **The exhaustive threshold bound (F1-safe recall ≤ 16/60).** `C1-REPORT.md`'s search is a large
  offline sweep; re-running it was out of budget. I did not assume it — I simply did not test it, and
  C7-2 is evidence pointing the other way about what the floor is actually doing.
- **CI itself.** No push, no tag, no `git fetch --tags` (worktrees share `.git`). The macOS/Ubuntu ×
  Node 22/24 matrix and the sigstore provenance are read from `ci.yml`, not observed.
- **The provenance of this archive's stamp-less vectors.** C7-1's *state* is verified by direct SQL
  and by the product's own output; how it arrived there is not established. C7-3 is a separate,
  independently reproduced defect that produces a neighbouring state.
- **`ask` end-to-end through a live host agent.** No model call was made anywhere in this
  verification; the seam was exercised only at its refusal path.
- **Whether C7-2 reproduces on the eval fixture corpus.** Verified on the real archive only.

---

## §F MY ONE CHANGE, AND ITS REVERT

One line, in the scratch clone, to prove the verb ratchet can go red with the ranker untouched:

```diff
 const scoreAt = (outcomes: Outcome[], k: number): number =>
-  outcomes.filter((o) => hitAt(o, k)).length;
+  outcomes.filter((o) => hitAt(o, k)).length - 1;
```

```
$ pnpm evals                                                   exit 1
  hybrid (auto) · ranker    recall@5  57/60   ✓ ≥ bm25 (40)  ✓ ≥ vectors (57)  ✓ ≥ 51/60
                            recall@1  42/60   ✓ > bm25 (31)  ✓ > vectors (40)
    · verb (ratchet)        recall@5   6/60   ✗ ≥ 7/60       recall@1  6/60  ✗ ≥ 7/60   FAIL
  FAIL — the re-scoped gate would not merge this fusion
```

Every ranker clause green, the gate red. Reverted:
`git status --porcelain` → empty; `git diff --stat` → empty.

---

## §G ISOLATION, CONTROLS, DISK, PIDS

- **Checkout under test never modified.** `git status --porcelain` in `/Users/zebra/randomness/potsherd`
  clean at start; all work in `<scratch>/v7clone` (tests, never edited), `<scratch>/v7build`
  (build + probes; the one §F change, reverted) and `<scratch>/v7novec` (`sqlite-vec` removed).
- **Scratch `HOME`**, with `CLAUDE_CONFIG_DIR POTSHERD_DIR XDG_CONFIG_HOME NODE_PATH CODEX_HOME
  ANTHROPIC_API_KEY` cleared on every invocation via `env -u`. The archive was **APFS-cloned**
  (`cp -c -R`) into that HOME; the real `~/.potsherd` was opened read-only, once, and never written.
- **No real session id, project name, home path or transcript line appears in this report.**
  `check-privacy.py` findings are given as counts only.
- **No `git fetch`, no fetch of tags, no commit, no push, no tag.**
- **Controls.** Five invented after the corpus was frozen — `zarbomite`, `quillfratch`,
  `brindlewax`, `vontessery`, `plumthwacket`. `grep -ril` over the whole repository: 0 files each
  (which also excludes `VERIFICATION-{3,4,5,6}.md` and `C1-REPORT.md`). SQL over `exchanges`: 0 rows
  each. None reused from any prior report.
- **Processes.** Two `node …/potsherd/1.1.0/dist/mcp.js` existed before I started (recorded) and are
  not mine; they are still the only two. No `index` was run without `--no-embed` or `--embed`
  (foreground), so **no detached embedder was ever spawned**. Nothing killed.
- **Disk.** `df -h /` before: `6.6Gi avail`. After: `5.3Gi avail`. 1.3 GiB consumed — two APFS clones
  of the repo, a Node 24.19.0 tarball and its unpack, and the eval corpus. All under the scratchpad.

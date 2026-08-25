# VERIFICATION-6 — the sixth independent verifier

**Commit under test:** `5f51f1f` on `main`, cloned to a scratch directory with `git clone --no-tags`
and checked out detached. Nothing in `<the working checkout>` was modified except this
file, and its `.git` was never fetched into.
**Verifier:** authored none of phase 10 or phase 11. Every finding below carries the command and its
output. Anything I could not paste output for is in §E, not in §C.
**Corpus:** the real archive — seven harness directories APFS-cloned into a scratch `HOME` and
**frozen before any control string was invented** — plus the committed synthetic demo corpus and the
committed 60-query eval fixture. See §G.

**Identifiers.** No real session id appears in this document — not even an eight-character prefix.
Real session titles and real project directory names inside quoted output are replaced one-to-one by
`<title-S1>`… and `<project-P1>`…, with the column layout preserved so the screenshots still read as
screenshots; the mapping is stable within this document. The only ids below are the synthetic ones
from `scripts/make-demo-corpus.mjs` and `evals/queries.jsonl`, which this repository already
publishes. No transcript line from any real session is reproduced, and no real home path is printed.

**One thing that changed under me.** `origin/main` advanced from `5f51f1f` to `aa63293` during this
run (`git log --oneline 5f51f1f..HEAD` → one commit, `release notes and changelog: the numbers this
build actually produces`; `git show --name-only aa63293 | grep -E "^packages/|^evals/|^tests/"` →
empty). It is documentation only, so everything below still applies — and it is also where the
number C-1 is about (`hybrid recall@1 42/60`) gets published as this build's verified retrieval
quality. See C-1.

---

## §A THE RE-SCORE

| row | audit | v3 | v4 | v5 | re-audit | **v6** | the command behind it |
|---|---:|---:|---:|---:|---:|---:|---|
| **Overall, as an agent-facing product** | 4 | 7 | 7 | 7 | 7 | **6** | the whole of §B + §C, C-1 dominating |
| Concept & scope discipline | 9 | 9 | 9 | 9 | 9 | **9** | `--help`, `doctor` (7 adapters, 3 MCP tools) |
| Archive capture | 9 | 9 | 9 | 9 | 9 | **9** | `index --no-embed` → 1,849 exchanges · 326 subagents · 382 transcripts · 7 adapters |
| CLI ergonomics for a **human** | 8 | 8 | 8 | 7 | 9 | **7** | C-2 (`--until` misquoted), C-3 (score column), C-4 (49 vs 56), C-6 (two dates) |
| **Retrieval quality** | 3 | 7 | 7 | 7 | 7 | **5** | C-1: 60-query measurement at the floor `find` uses, + the binary, + `potsherd_recall` |
| **Reliability of a default install** | 2 | 8 | 8 | 8 | 4 | **8** | `pnpm test` ×2 drivers, typecheck, evals, privacy, vendor, the 4-way blocker matrix |
| **Agent ergonomics (the actual target)** | 3 | 7 | 7 | 7 | 8 | **6** | C-1 at the model door + no floor override; C-5; the `--filter-in` chain (good) |
| Re-entry | 5 | 8 | 8 | 8 | 9 | **9** | `graft` on the audit's own F4 fixture: 4 exchanges → **123**, 8/8 citations resolve |

### GATE: **FAIL**

`plans/phases/phase-10-agent-audit.md §D` requires **≥ 8/10 overall, retrieval ≥ 7, reliability ≥ 8,
agent ergonomics ≥ 8**, from a verifier that authored nothing, on the real archive.

| threshold | required | measured | verdict |
|---|---:|---:|---|
| Overall | ≥ 8 | **6** | **FAIL** |
| Retrieval quality | ≥ 7 | **5** | **FAIL** |
| Reliability of a default install | ≥ 8 | **8** | pass |
| Agent ergonomics | ≥ 8 | **6** | **FAIL** |

**Three of four thresholds are not met.**

### why each moved row moved

**Reliability, 4 → 8.** The re-audit's 4 was the vec0 upgrade crash. It is genuinely fixed, and I
proved it the hard way rather than the convenient one — see §B1, including the fact that my *first*
attempt at proving it was invalid because the premise had not been established.

**Retrieval, 7 → 5.** Not because the ranking got worse — it got better, and I verified every part
of that (§D). Because nobody had measured what the **verb** returns. On the project's own committed
60-query set, on the project's own fixture index, at the shipped weight: the ranking puts the answer
first for **42 of 60**, and `potsherd find` returns zero rows for **52 of 60**, printing *"nothing in
the index answers …"* over an index that answers it at rank 1. C-1.

**Agent ergonomics, 8 → 6.** The model door is where C-1 does its real damage: `potsherd_recall`
returns `"note": "no match. The archive does not contain this … Say so — do not widen into a guess"`
for those same queries, and its input schema has **no** `minConfidence` property, so the agent it is
instructing cannot check the claim or override it. Everything else at that door is genuinely good and
I say so in §D.

**Human CLI, 9 → 7.** Four defects on the printed page, on `ls`, `find` and `doctor`: the header
misquotes the `--until` the user just typed by a day outside UTC (C-2); the score column is
non-monotone on 19 of 20 queries (C-3); `doctor` prints `sessions on disk 49` where `stats` prints
`sessions 56` from the same index in the same minute (C-4); `find` and `ls` date the same session
seven days apart (C-6).

**Re-entry, 8 → 9.** Earned. §D6.

---

## §B THE FIXES SINCE `4fd221e` — are they real?

### B1 · FIX-H / FIX-H2 — the release blocker · **REAL, on all four combinations**

**First, the machine's own database.** The brief said `~/.potsherd/potsherd.db` holds three vec0
virtual tables. It does not any more — it has already been converted:

```
$ sqlite3 "file:$HOME/.potsherd/potsherd.db?mode=ro" \
    "select type,name from sqlite_master where sql like '%vec0%' or name like 'vec%';"
table|vec_blob_exchanges
table|vec_blob_cards
table|vec_blob_ghost_prompts
view|vec_exchanges
trigger|vec_exchanges_insert
...
```
Read-only, no writes. Zero rows match `sql like '%vec0%'`. So the reference machine is past the
blocker and could not have been used to prove anything about it.

**The environmental premise, established rather than inherited.** Both Node versions, same probe:

```
== v24.9.0 ==                        == v24.19.0 ==
pragma set: OK                       pragma set: OK
readback: {"writable_schema":1}      readback: {"writable_schema":0}
delete changes: 1                    delete refused: table sqlite_master may not be modified
```
Neither throws. `24.19.0` was downloaded for this run.

**My own stranded database**, not the suite's fixture: index a small transcript through the binary,
then load `sqlite-vec` on my own handle, drop the views/triggers/blob tables, create the three real
`USING vec0(...)` virtual tables with 1.1.0's DDL, insert 384-d unit vectors, stamp
`embedding_version`, `DELETE FROM schema_migrations WHERE version >= 10`:

```
STRANDED vec0 objects=["vec_exchanges","vec_cards","vec_ghost_prompts"] schema=9 exchanges=2
```

**The invalid first attempt, recorded because it is the whole lesson of this phase.** I "removed"
`sqlite-vec` by renaming `packages/core/node_modules/sqlite-vec`. It made no difference:

```
$ node -e 'createRequire("…/packages/cli/dist/potsherd.js").resolve("sqlite-vec")'
resolved: …/node_modules/.pnpm/sqlite-vec@0.1.9/node_modules/sqlite-vec/index.cjs
```
The CLI is a bundle and resolves from its own path. **My first green matrix proved nothing**, exactly
the way a green run on 24.9 proves nothing. Hiding the pnpm store entry as well:
```
absent from cli/dist/potsherd.js (MODULE_NOT_FOUND)
absent from core/src/index.ts   (MODULE_NOT_FOUND)
absent from mcp/dist/index.js   (MODULE_NOT_FOUND)
```

**The matrix, re-run with the premise actually established** — four fresh stranded databases, the
whole `potsherd index` verb through the binary:

| node | driver | exit | schema after | vec0 objects left | `vec_blob_exchanges` |
|---|---|---:|---:|---:|---:|
| 24.9.0 | better-sqlite3 | 0 | 12 | 0 | 0 |
| 24.9.0 | node:sqlite | 0 | 12 | 0 | 0 |
| **24.19.0** | better-sqlite3 | 0 | 12 | 0 | 0 |
| **24.19.0** | **node:sqlite** | **0** | **12** | **0** | **0** |

No `no such module: vec0` anywhere. `embedding_version` is cleared to 0 in every case
(`select count(*) from exchanges where embedding_version is not null` → 0), so the stamp does not go
on claiming vectors that were dropped — checked independently of the suite's assertion.

**The unmigratable case** (schema already stamped 12, vec0 tables still present, extension absent —
the state `tests/upgrade-from-1.1.test.ts` calls *requirement 2*): every verb degrades instead of
throwing, and all four surfaces agree, which is more than the requirement asked for:
```
index    vectors 2   run potsherd index — it converts a vec0 st…    exit 0
doctor   vectors 2   run potsherd index — it converts a vec0 st…    exit 0
stats    vectors 2   run potsherd index — it converts a vec0 st…    exit 0
find     semantic search: run potsherd index — it converts a vec0 store written by 1.1.0
```
One residual, filed at C-8: in that state `potsherd index` prescribes `potsherd index`, and it will
never work, because `runMigrations` skips a version already in `schema_migrations`.

### B2 · P11 — the calibration change · **REAL, and no constant moved**

```
$ for r in 4fd221e 5f51f1f; do git show $r:packages/core/src/calibration.ts | grep -E "^export const [A-Z_]+ = "; done
```
Both revisions print the identical eleven lines: `WEIGHT_BASE = 0.6`, `WEIGHT_STRENGTH = 0.25`,
`WEIGHT_AGREEMENT = 0.15`, `AGREEMENT_LISTS = 3`, `WEAK_FLOOR = 0.5`, `STRONG_FLOOR = 0.75`,
`KEY_TERMS_REQUIRED = 1`, `MIN_CALLS`, `CALIBRATION_WINDOW`, `MAX_RATIO`, `MIN_RATIO`. A diff of
`calibrate()`'s body between the two revisions is **empty**. What changed is `SOURCE_OF_LIST` in
`recall.ts`, which maps the eight lists onto four bodies of evidence, and `combinedStrength`'s
mean-within / max-across rule. The docstring's second worked example was **removed** rather than
corrected, and it was the one that gave the confusion away.

```
$ pnpm evals ; echo EXIT=$?
  bm25 only       recall@5  40/60  67%     recall@1  31/60  52%
  vectors only    recall@5  57/60  95%     recall@1  40/60  67%
  hybrid (auto)   recall@5  57/60  95%     recall@1  42/60  70%
  hybrid (always) recall@5  57/60  95%     recall@1  42/60  70%
  PASS — the amended phase-3 gate would merge this fusion
EXIT=0
```
**40/31 · 57/40 · 57/42, exactly as claimed.**

The new control fails on **two independent clauses**, as claimed:
```
$ npx tsx evals/run.ts --no-vector-lists ; echo EXIT=$?
  semantic lane REMOVED · … · this is the regression control, not the release gate
  hybrid (auto)   recall@5  40/60   ✓ ≥ bm25 (40)   ✓ ≥ vectors (0)   ✗ ≥ 51/60
                  recall@1  31/60   ✗ > bm25 (31)   ✓ > vectors (0)   FAIL
EXIT=1
```

**Can the gate pass with a bad build?** I tried. My one change (§F) neutered `byLabel` back to
pre-FIX-I behaviour — one line — and the gate went red on two clauses in both hybrid modes:
```
  bm25 only    recall@5 39/60  recall@1 24/60      hybrid (auto) recall@5 50/60  recall@1 35/60
  hybrid (auto)  recall@5 50/60  ✓ ≥ bm25 (39)  ✗ ≥ vectors (51)  ✗ ≥ 51/60   FAIL
EXIT=1
```
and **eleven tests failed across three files** — `tests/find.test.ts` (5), `tests/mcp.test.ts` (3),
`tests/evals-gate.test.ts` (2), `tests/plugin-install.test.ts` (1, the vendored-bundle byte check).
Round 5's *"1,931 tests passed either way"* is genuinely closed.

The eval also degrades honestly when its own premise is missing — `POTSHERD_MODELS_DIR` pointed at an
empty directory gives `vector modes skipped`, `cannot be judged — the vector modes did not run`,
**exit 1**, not a vacuous pass.

### B3 · FIX-I — one ordering, both doors · **REAL**

Same index, same query, one run. `find --json` and the real MCP server over stdio:

```
find --json "embedding model"            potsherd_recall {"query":"embedding model","want":"hits"}
0 cal=0.9250 cit=true  <title-S4> …      0 conf=strong cit=true  <title-S4>
1 cal=0.9250 cit=true  <title-S5> …      1 conf=strong cit=true  <title-S5>
2 cal=0.8500 cit=true  <title-S6> …      2 conf=strong cit=true  <title-S6>
… identical to row 9 …                   … identical to row 9 …
```
`typescript types`, nine rows, both doors: rows 0–3 `strong/citable`, 4–5 `weak/citable`, **6–8
`weak/citable=false`, title-only, in the same positions at both doors.** A 20-query scan at
`--min-confidence none` found **0 confidence-label inversions** and **0 calibration inversions other
than the one `summaryRank` is supposed to cause**. C-1 and C-2 of round 5 are closed.

### B4 · FIX-F / FIX-F r2 — the warming lie, four lock states · **REAL, including the recycled pid**

Driven on a 439-exchange corpus by planting `.lock.embed/owner.json` and controlling its mtime.

| state | `doctor` vectors row | `find` line |
|---|---|---|
| 1 no lock, nothing fetched | `0 of 439 · not running — 46.1 MB runtime not fetched` | `not running … the 46.1 MB runtime has not been fetched` |
| 2 live pid, fresh heartbeat | `0 of 439 · fetching the 46.1 MB runtime` | `warming (0 of 439 embedded)` |
| **2b live pid, lock 11 min old (recycled pid)** | `not running — 46.1 MB runtime not fetched` | `not running …` |
| 3 dead pid 99991 (`ps -p 99991` → dead) | `not running — 46.1 MB runtime not fetched` | `not running …` |
| 4 fully embedded | `439  bge-small, 384-d, wasm · every exchange` | *(no line; `bm25 + vectors`)* |

State 2's `doctor` sentence is **different** from state 1's — round 5's **C-6 is closed**. State 2b
is round 5's **C-4**: a live pid is now necessary and not sufficient (`LIVE_STALE_MS = 10 min`
plus a `HEARTBEAT_MS = 20 s` stamp), so a recycled pid no longer poisons the lane. The pid I planted
in state 2 was a `sleep 400` I started myself; see §G.

### B5 · FIX-G / FIX-E r2 — the zero-model chain · **REAL, all of it**

```
$ potsherd ask "…" --synthesis-out syn.json          # without --readers-in
potsherd: --synthesis-out makes no model call only when the readers are already recorded; …
EXIT=1        file created? no
```
`--readers-out` in **0.188 s**, `no model call was made (0)`, and the file now carries **`schema`**
and **`instruction`** (round 5's C-5):
```
kind, version, potsherd, schema, instruction, question, k, sessionIds, targets, index
```
The three reply shapes at `--filter-in`:
```
reply as a JSON string     → "the recorded reply was a JSON string; parsed it…"   ANSWER printed, exit 0
reply inside ```json fence → same                                                  ANSWER printed, exit 0
reply with evidence, no answer key → exit 2, "…that is a reply nobody finished, not an archive
                                     with nothing in it. A synthesizer that concluded nothing
                                     is supportable writes \"answer\": []"
```
Round 5's **C-7 is closed** — and closed with a *third* outcome rather than by re-labelling the
second.

### B6 · FIX-J — the guards · **REAL**

`pnpm test` 55 files, **1984 passed | 1 skipped (1985)**, exit 0, under **both** drivers
(`POTSHERD_SQLITE=node` run separately). The one skip is round 5's C-10 working as designed: my clone
was made with `--no-tags`, so `git tag --merged HEAD` is empty and the version test **skips loudly**
instead of reporting a pass. `typecheck` 4 of 4, exit 0. `check-privacy.py` exit 0 —
*"597 tracked text files swept, no real-corpus content, no pinned known violations left to carry"*
(finding line elided). `pnpm vendor` → `git status --porcelain` empty.

The screens guard: I ran the CI step's sequence verbatim in my own clone. **All ten covered screens
match**, `STATUS=0`. I also diffed the two screens the step handles separately and one it excludes:
`04-doctor.txt` is byte-identical; `05-doctor-privacy.txt` differs only in the cwd and a machine
path, which is an artefact of my not standing where `make-screens.sh` stands; `07-index.txt` differs
only in the two lines `--no-embed` is defined to change. **No covered screen is stale and no
uncovered one is either.** `potsherd_ask` / `potsherd_ls` / `potsherd_tag` / `potsherd_find` appear
in no shipped doc — only in phase reports and in the two audits.

### B7 · FIX-F7 — three tools, not six · **REAL**

```
potsherd-mcp 1.2.0 ready · 3 tools
TOOLS: potsherd_recall, potsherd_read, potsherd_graft
```
`plugins/claude-code/agents/session-archaeologist.md` frontmatter:
`tools: mcp__plugin_potsherd_potsherd__potsherd_recall, mcp__plugin_potsherd_potsherd__potsherd_read`
— **`Read` is gone**, and the prompt's first line is *"You are a windowing subagent."* F3's first
half is closed.

---

## §C NEW DEFECTS, RANKED

### C-1 ★★★★★ — `potsherd find` returns nothing for 52 of the 60 queries the release gate certifies, and tells the agent the archive does not contain them

This is the finding of this round, and it is on the product's own benchmark, not on mine.

`recall()`'s library default is `minConfidence: 'none'` — withholds nothing
(`packages/core/src/recall.ts:1927`). `potsherd find` runs at `weak`. **The 60-query recall@k
measurement calls `recall()` at the library default** (`evals/run.ts:637`, no `minConfidence`), so
the number the phase-3 gate judges is the *ranking*, not what the verb returns. The file knows: the
docstring over `runControls` says *"the floor is set by the verb … What is measured here is what a
person or an agent typing `potsherd find` gets"* — and applies the real floor to **6 control
queries**, five of which are supposed to return nothing, and to **none of the 60**.

Measured on the eval run's own kept fixture index (`--keep`), same query set, same build, both calls
in the same shape so the comparison is honest:

```
queries 60
floor OFF (what pnpm evals and the phase-3 gate measure):  recall@1 42/60   recall@5 51/60
floor ON  (what "potsherd find" actually returns):         recall@1  7/60   recall@5  7/60
queries where find returns ZERO rows: 52
answers found with the floor off and withheld by the floor: 44
   @0 -> gone   rows=0 conf=none withheld=30   "what we gave up by putting a proxy in front of postgres"
   @0 -> gone   rows=0 conf=none withheld=30   "the shopper was billed twice when the card reader lost signal"
   @0 -> gone   rows=0 conf=none withheld=32   "tls stopped working across the whole estate at midnight"
   @2 -> gone   rows=0 conf=none withheld=30   "the pod kept getting killed even though the app was fine"
   … 40 more

by "needs" class  (recall@1, floor OFF -> floor ON):
  text       n=36   23 -> 4
  card       n= 6    4 -> 2
  sidechain  n= 6    5 -> 0
  ghost      n=12   10 -> 1
```

Through the binary, so this is not an artefact of my call shape:
```
$ potsherd find "what we gave up by putting a proxy in front of postgres" --potsherd-dir <the eval index>
potsherd find "what we gave up by putting a proxy in fr… · no match · bm25 + vectors · 892ms

  nothing in the index answers "what we gave up by putting a proxy in front of postgres".

  30 sessions matched some of those words and none of them enough  ·  --min-confidence none
```
The correct session is **rank 1** in the same build's own ranking of the same index.

And at the model door, where it does the real damage:
```
$ potsherd_recall {"query":"what we gave up by putting a proxy in front of postgres","want":"hits"}
  "confidence": "none",  "belowFloor": 30,  "noMatch": true,
  "note": "no match. The archive does not contain this, though 30 rows were withheld below the
           weak floor. Say so — do not widen into a guess, and do not answer from the repository
           in front of you."
```
The tool's own description says, in capitals: **`TRUST ITS SILENCE.`** … *"a none comes back with ZERO
rows … That is a real answer: the archive does not contain this."* And its input schema is
`query, scope, want, budget` — **there is no `minConfidence` property**. The agent being instructed
to trust the silence cannot check it and cannot override it. The CLI at least prints
`· --min-confidence none`; the model door offers nothing.

**Why it is structural, not a tuning accident.** `calibrate()` is
`score = coverage × (0.6 + 0.25·strength + 0.15·agreement)`, and `coverage = covered/terms` is the
fraction of the **query's literal terms** found in the row. The bracket can never exceed 1, so
`score ≤ coverage` always. Therefore `weak` (`WEAK_FLOOR = 0.5`) requires **at least half the query's
words to appear literally**, and `strong` requires **three quarters** — whatever the cosine says.
Measured, on the demo corpus, on a session that is unambiguously the right answer:
```
"pgbouncer pool saturated"                      cov=0.666  cal=0.567  weak
"everything queued up and timed out under load" cov=0.75   cal=0.629  weak
"database handles ran out during heavy traffic" cov=0.166  cal=0.142  none  → 0 rows
"we exhausted our allowance of open channels"   cov=0.25   cal=0.210  none  → 0 rows
```
The semantic lane genuinely earns its keep in the **ranking** (57/60 against bm25's 40/60, verified
in §B2). The confidence label that decides whether the user ever sees it is computed from **term
overlap alone**. That is audit F8 — *"BM25 punishes the phrasing the skill mandates"* — surviving
intact at a surface F8 did not name, and it is why this row cannot be a 7.

The gate text prints the phrase **`recall@1 (the row the user actually sees)`**. On this build the
user does not see that row for 52 of 60 queries. And as of `aa63293`, `42/60` is published in the
release notes as this build's verified retrieval quality.

Audit F1 was *"find never returns nothing."* This is the same defect with the sign flipped, and it is
worse, because an agent could distrust ten weak rows and cannot distrust an authoritative empty it
has been told in capitals to trust.

### C-2 ★★★★ — `ls` misquotes the `--until` the user just typed, by a day, everywhere except UTC

The bound is stored correctly and re-rendered with local-time getters. Same command, four zones,
**identical result sets** (`1 of 3` in every one) — only the receipt of the user's own input moves:

```
$ TZ=…  potsherd ls --since 2026-08-10 --until 2026-08-15 --limit 1
TZ=UTC                  potsherd ls · since 10 aug · until 15 aug · 1 of 3
TZ=Asia/Kolkata         potsherd ls · since 10 aug · until 16 aug · 1 of 3
TZ=America/Los_Angeles  potsherd ls · since  9 aug · until 15 aug · 1 of 3
TZ=Pacific/Auckland     potsherd ls · since 10 aug · until 16 aug · 1 of 3

$ potsherd ls --since 2026-08-10 --until 2026-08-15 --json   (TZ=Asia/Kolkata)
{"since":"2026-08-10T00:00:00.000Z","until":"2026-08-15T23:59:59.999Z", …}
```
`--json` is right. The page is wrong for every user east of UTC on `--until` and west of it on
`--since`. Mechanism: `shortDate` uses `dt.getDate()/getMonth()` (`packages/core/src/format.ts:46`)
on an instant pinned to `23:59:59.999Z`; at UTC+05:30 that is 16 Aug local.

This is invisible to every guard in the repository because `scripts/make-screens.sh` and the CI
screens step both pin **`TZ=UTC`** — the one zone in which both ends are correct. The `TZ` pin was
put there to stop a real flake and it is right; it also happens to be the only setting under which
this defect cannot be seen. That is hunting-list item 5 compounding item 1.

### C-3 ★★★ — the score column is not the sort order, on 19 of 20 queries

FIX-I moved the sort key to the calibrated score. The printed number is still the fused RRF score,
and the page never shows the calibration. So the visible column runs backwards:

```
$ TZ=UTC potsherd find "json parsing"
potsherd find "json parsing" · 10 sessions · strong · bm25 · 468ms

  <title-S1>                                                             claude · live
  <project-P1> · 12 aug · 119 exchanges · main                          strong  0.0172
  ↳ <title-S2>                                                     claude · sidechain
  <project-P2> · 7 jul · 1 exchange · master                            strong  0.0184     <- above it
  ↳ <title-S3>                                                     claude · sidechain
  <project-P2> · 7 jul · 1 exchange · master                            strong  0.0181     <- above it
```
A 20-query scan on the frozen archive:
```
--- 20 queries with rows: 19 carry a printed-score inversion; calibration inversions 1; confidence-label inversions 0
Q="embedding model"  n=10 header=strong SCORE@2 0.01418->0.01836
Q="typescript types" n= 9 header=strong SCORE@5 0.01053->0.01155 SCORE@6 0.01155->0.02754
Q="cli flag"         n=10 header=strong SCORE@1 0.01455->0.01836
… 16 more
```
`packages/core/src/render/find.ts:344` — `const score = \`${s.confidence}  ${s.score.toFixed(4)}\`` —
and the comment above it already says the number is uninformative. It is still printed, in the
column where the eye reads rank, and it now contradicts the order. `plans/05`: as a caption-free
screenshot this reads as a broken sort. This is hunting-list item 9 — the neighbour left saying the
old thing.

### C-4 ★★★ — `doctor` says 49 sessions on a machine where `stats` says 56, on the same index, in the same minute

```
$ potsherd doctor                       $ potsherd stats
  sessions on disk        49              sessions      56   326 subagents · 50 titled · 0 archived
  sidechains on disk     324
  adapters:
    claude   49 sessions · 324 sidechains
    codex     1 session          <- 49 + 1 + 2 + 4 = 56, five rows below the headline that says 49
    cursor    2 sessions · 2 sidechains
    pi        4 sessions
```
`onDiskFiles` is `disk.sessions.length` from `audit.ts:298`, and `audit.ts` is scoped to
`claudeDir` — it is a claude-only number under a label that names no harness, on a screen whose whole
job is *what is on disk*. The `titledSessions` note two characters away carries a long comment
explaining that `doctor` says `harness-titled` because `stats` means something else by `titled` — so
the collision on this exact row was noticed and the count itself was left. Audit F2's complaint was
`doctor` and `index` disagreeing in print; the `vectors` row was fixed and the `sessions` row was
not.

### C-5 ★★ — `potsherd_recall` prints two different vector counts in one JSON object

```
"capability": "keyword + semantic search (163 of 163 embedded)",
"vectors": { "used": true, "available": true, "vectors": 120, "working": false }
```
On that index: `vec_blob_exchanges` 120, `vec_blob_ghost_prompts` 43, `exchanges` 120,
`ghost_prompts` 43. So `163` counts exchanges + ghost prompts and `120` counts exchanges, neither
says which, and they sit six lines apart in the object an agent parses. Same shape as audit F2,
inside one reply.

### C-6 ★★ — `find` and `ls` date the same session seven days apart

```
packages/core/src/render/ls.ts:139    const when = s.endedAt ?? s.startedAt;
packages/core/src/render/find.ts:329  const when = s.startedAt ?? s.endedAt;
```
For a 119-exchange session spanning 12–19 aug, `find` prints `12 aug` and `ls` prints `19 aug`
(UTC), for the same title, in the same terminal. Neither page says which end it is showing. Audit F4
asked for sessions to be *dated by content*; the two verbs picked opposite ends of the content.

Related, and on the same page: `potsherd ls --until 2026-08-15` returns rows whose printed date is
`19 aug`, because the filter is on the *start* and the column is the *end*. Both rows are honest
individually; together they read as a broken filter.

### C-7 ★★ — `find` says `warming` while `doctor` says the runtime is still being fetched

Lock state 2 above: `doctor` prints `fetching the 46.1 MB runtime`, `find` prints
`semantic search: warming (0 of 439 embedded)` with no mention of the fetch. The audit's item 9 asked
for the degradation banner on **every** `find`; on `find` the reader is told to wait for a pass that
has not yet got its model. `warmingLine` has no fetch clause; `vectorNote` does.

### C-8 ★★ — on a permanently stranded database, `potsherd index` prescribes `potsherd index`

Schema stamped 12, vec0 tables still present, extension absent — the state
`tests/upgrade-from-1.1.test.ts` builds and calls *requirement 2*:
```
$ potsherd index --no-embed
  vectors        2   run potsherd index — it converts a vec0 store written by 1.1.0
```
It will not, ever: `runMigrations` skips any version already in `schema_migrations`, so migration 10
can never run again on that database. The re-audit's own fix list, item 2, is *"make `doctor` detect
the broken-migration state and print the recovery command, not `run potsherd index` — the tool
currently prescribes the failing command."* On this path it still does, and now `index` prescribes
itself. The requirement was *must not throw*, and it does not; the sentence was not brought along.

### C-9 ★ — `--json` publishes `lane: "evidence"` on a row it also marks `citable: false`

```
6 cal=0.8500 conf=weak lane=evidence cit=false kinds=title
7 cal=0.8500 conf=weak lane=evidence cit=false kinds=title
```
Deliberate and reasoned at length in `recall.ts` (`laneOfHit('title') === 'evidence'` is pinned in
both directions by `tests/cards-lane.test.ts`), and `citable` is the field that decides. Filed at ★
because it is a published field whose name says the opposite of the field beside it, and nothing an
agent reads says which to believe.

---

## §D CLAIMS I CHECKED THAT HELD

1. **The negative controls, both classes, both doors.** Two pure-nonsense and one real-English
   control, all invented after the freeze (§G): `no match`, **0 rows**, exit 1 at the CLI;
   `confidence: none, threads: 0` at `potsherd_recall`. The audit's F1 no-empty is closed.
2. **The in-code citation refusal — the best thing in this release.** `--filter-in` with a real
   verbatim quote: answer printed, exit 0. With a fabricated quote against a real session id:
   `no grounded answer in 6 sessions searched · every sentence was dropped for want of a citation
   that resolves (1)`, **exit 1**. With a real quote against an id that does not resolve: identical
   refusal, exit 1. F3's second half is closed in code, not in a prompt.
3. **Both suites, both drivers, 0 failures.** 55 files, 1984 passed, 1 loud skip, exit 0 under
   better-sqlite3 and under `POTSHERD_SQLITE=node`. Typecheck 4 of 4. Privacy exit 0. Vendor no diff.
4. **The eval gate can fail, and does, for the right reasons.** Two independent clauses under
   `--no-vector-lists`; two clauses and 11 test failures under a one-line bad build; exit 1 and
   `cannot be judged` when its own model premise is absent.
5. **Ordering and citability agree at both doors**, on the same index and the same query, including
   the title-only rows in the same three positions. 20-query scan: zero label inversions.
6. **Re-entry, on the audit's own F4 fixture.** The real archive still contains the pair the audit
   described: `overlap 0.988`, `shared 1660`, one 119-exchange member and one 4-exchange head.
   `potsherd graft <the 4-exchange one> --no-model` now returns
   `exchanges 123 · citations 8/8 distinct, and all resolve · no model call — no model was used`,
   *"Written by potsherd from 2 transcripts of one thread"*, and it writes
   `.potsherd/graft-<id8>.md` **with a `.gitignore` beside it**. 4 exchanges → 123, on the real
   machine.
7. **Semantic search works, and works on a paraphrase.** State 4, 439 of 439 embedded,
   `bm25 + vectors`: `find "connection pool exhausted at peak load"` returns the pgbouncer session
   first, a query sharing almost no words with it.
8. **No detached embedder was produced by anything I ran.** `--no-embed` everywhere it was not
   needed, `--embed` in the foreground where it was; `ps` after: none. `.lock.embed` absent after.
9. **Archive capture.** 1,849 exchanges, 27,941 tool calls, 326 subagents, 382 transcripts, seven
   adapters each reporting `ready`/`empty`/`absent` with the path it read, 2,963 secrets masked, and
   two record types honestly listed as `new — no note in research/formats.md describes it yet`.

---

## §E WHAT I COULD NOT CHECK, AND WHY

- **`ask` against a real model backend.** Every model path was exercised through `--readers-out` /
  `--readers-in` / `--synthesis-out` / `--filter-in`, which is the zero-model chain. I did not spend
  the user's subscription on a live `ask`, so `14-ask.txt`, `15-graft.txt` and `17-ls-cards.txt`
  remain unverified against live output — they are also the three screens the CI guard excludes, so
  nothing checks them.
- **`rescue` against the real archive.** It writes. I ran it only on the synthetic demo corpus,
  where it is covered by the screens guard.
- **Whether C-1's floor is reachable on a *real* archive's own questions.** I measured it on the
  committed 60-query fixture, which is the set the gate uses. I did not build a labelled query set
  over the real archive; that is a day's work and the fixture is the project's own instrument.
- **A genuinely recycled pid.** I could not make the OS reissue a pid inside this run, so state 2b
  simulates it with a live process I own plus an aged lock — which is the same predicate
  (`pidAlive && ageMs > LIVE_STALE_MS`) the real case would hit.
- **CI itself.** I read `.github/workflows/ci.yml` and re-ran its screens step by hand; I did not
  run the workflow.

---

## §F MY ONE ≤ 5-LINE CHANGE, AND ITS REVERT

To answer *"try to make the gate pass with a bad build"* I neutered `byLabel` back to its pre-FIX-I
behaviour — one line added, two removed:

```diff
--- a/packages/core/src/recall.ts
+++ b/packages/core/src/recall.ts
@@ -519,10 +519,9 @@ export function byLabel<
   const wa = a.confidence, wb = b.confidence;
   const word = wa && wb ? CONFIDENCE_RANK[wa] - CONFIDENCE_RANK[wb] : 0;
+  void word; // VERIFIER-6 ONE CHANGE: label ordering neutered (pre-FIX-I behaviour)
   return (
     LANES[a.lane ?? 'evidence'] - LANES[b.lane ?? 'evidence'] ||
-    word ||
-    (b.calibration?.score ?? 0) - (a.calibration?.score ?? 0) ||
     b.score - a.score
   );
 }
```

Result: `pnpm evals` exit **1**, failing `≥ vectors` and `≥ 51/60`; `pnpm test` **11 failed | 1973
passed**, across `find.test.ts`, `mcp.test.ts`, `evals-gate.test.ts` and `plugin-install.test.ts`.
The gate is not a benchmark that cannot fail.

Reverted with `git checkout -- packages/core/src/recall.ts` and rebuilt;
`git status --porcelain` empty, `git rev-parse HEAD` still `5f51f1f…`. The clone was then deleted.

---

## §G ISOLATION, CONTROLS, DISK, PIDS

### Setup

`git clone --no-tags` into a scratch directory; the working checkout at
`<the working checkout>` was never modified (`git status --porcelain` empty before and
after, HEAD unchanged by me) and its `.git` was never fetched into. **No tag was created.** All seven
harness directories plus `~/.potsherd` were APFS-cloned (`cp -Rc`) into a scratch `HOME` **before any
control string was invented**:

```
cloned .claude .codex .cursor .pi .gemini .copilot .potsherd, and ~/.local/share/opencode
958M .claude · 566M .codex · 372M .gemini · 14M .cursor · 5.8M .pi · 12K .copilot · 1.0G .potsherd
```
Every command ran as
```
env -u CLAUDE_CONFIG_DIR -u POTSHERD_DIR -u XDG_CONFIG_HOME -u NODE_PATH -u CODEX_HOME \
    -u ANTHROPIC_API_KEY HOME="$B/home" node …/packages/cli/bin/potsherd.js … --potsherd-dir "$B/pd"
```
The MCP server has no `--potsherd-dir`, so it was given `POTSHERD_DIR` explicitly with the same
`HOME`. `~/.potsherd/potsherd.db` was opened **read-only** (`file:…?mode=ro`) for the schema check
and never otherwise. Node 24.19.0 was downloaded into the scratch directory and deleted afterwards.

### Controls — invented after the freeze, and confirmed absent

`grep -ril <term> "$B/home"` over the frozen 2.9 GB tree, expecting 0 files. No control from any
previous round was reused, and the audit's own in-corpus nonsense string was not used.

| class | control | files |
|---|---|---:|
| pure nonsense | `flurnadge quiplotter vasterkin` | 0 / 0 / 0 |
| pure nonsense | `grommelthwaite bazzuroid` | 0 / 0 |
| real English, absent from a software archive | `coppicing hedgelaying billhook thatching` | 0 / 0 / 0 / 0 |

Rejected during screening **because they were present** in the frozen corpus, which is why the screen
is worth doing: `alpaca` (21), `micron` (24), `neume` (13), `crimp` (10), `shearing` (3),
`watermark` (133), `hazel` (30), `perforation` (3), `psalter` (1), `farrier` (1), `fetlock` (1),
`withers` (1), `philately` (1). All three surviving controls returned `no match`, 0 rows, at both
doors.

### Disk

```
before          /dev/disk3s1s1   199Gi   12Gi   5.8Gi   67%   /
after cleanup   /dev/disk3s1s1   199Gi   12Gi   6.7Gi   64%   /
```
Peak scratch footprint 4.2 GiB (the harness clones are copy-on-write and cost almost nothing; the
real cost was the repo's `node_modules`, two scratch indexes, the 46 MB embedding runtime and a
52 MB Node tarball). Everything I created was deleted — the scratch tree is back to **83 MB**, which
is the source clone, my logs and the seam fixtures. Free space is *higher* after than before; I do
not claim the delta, this is a shared machine.

### Processes

**I killed exactly one process, and it was mine.** For lock state 2 I started `sleep 400` myself,
recorded its pid, planted it in `.lock.embed/owner.json`, and killed it by pid:
```
  my sleep pid=44206 (owner: <me> 44206 sleep 400)
  … ps -o pid=,user=,command= -p 44206  ->  44206 <me> sleep 400
  killed my own sleep pid=44206; still alive? no
```
The dead-worker state used pid `99991`, confirmed dead before use (`ps -p 99991` → dead) and never
signalled. **No `killall`, no name pattern, nothing not started by me.** Two
`potsherd/1.1.0/dist/mcp.js` processes belonging to other Claude Code sessions (etime 16 h and 20 h,
PPIDs 39153 and 71134) were visible throughout and were **not** touched.

### One thing I created outside the scratch tree, and removed

`potsherd graft` writes into the cwd by design. I ran one graft from `/tmp`, which created
`/private/tmp/.potsherd/{graft-<id8>.md,.gitignore}`. I deleted it in the same run
(`rm -rf /private/tmp/.potsherd`; verified gone). Every other command ran with an explicit
`--potsherd-dir` inside the scratch tree.

# V7FIX — the four defects between v1.2.0 and its tag

**Branch `work/V7FIX`, cut from `origin/main` @ `db02a43`. Nothing pushed, nothing merged, no tag,
no `git fetch`.** 25 aug 2026.

**C7-1 CLOSED · C7-3 CLOSED · C7-5 CLOSED · C7-2 OPEN, by the ruling above me.**

C7-1 and C7-3 turned out to be one seam seen from two sides, and fixing the seam fixed both. C7-2 is
reproduced, bounded and measured, and the rule that closes it costs the verb 7/60 → 5/60 on the eval
fixture. Per the ruling I stopped rather than trade; the patch and the measurement are in §1 and §4.

---

## §0 EVERY CLAIM CHECKED BEFORE ANYTHING WAS CHANGED

`~/.potsherd` was **APFS-cloned** (`cp -c -R`) into a scratch `HOME`; the real archive was opened
read-only, once, and never written. Every invocation cleared `CLAUDE_CONFIG_DIR POTSHERD_DIR
XDG_CONFIG_HOME NODE_PATH CODEX_HOME`. No session id, project name, home path or transcript line
appears below; `check-privacy.py` findings are counts only.

**C7-1 — confirmed, on the clone, before any edit.**

```
$ potsherd doctor
  vectors                        —   not running, 0 of 4,774
$ sqlite>  vec_blob_exchanges 1649 · vec_blob_ghost_prompts 2940 · vec_blob_cards 4
$ sqlite>  exchanges stamped 0 of 1,803 · ghost_prompts stamped 0 of 2,971
$ sqlite>  blobs whose row is gone: 0 exchanges, 0 ghost prompts
```

The last line is the one that decided the fix: **every one of the 4,589 vectors belongs to a live
row.** They are not debris. `find` was fusing them while four surfaces reported none.

**C7-3 — confirmed through the binary, with `sqlite-vec` present**, on a database built to
`tests/upgrade-from-1.1.test.ts`'s own recipe: `vec_blob_exchanges` **0 of 2** after
`potsherd index --no-embed`, `0` stamped. Both drivers.

**C7-5 — confirmed on the real archive at both doors.** The same session, one run: `nearestNote`
`22 aug`, `find` hit row and `ls` `23 aug`; the model door carried `startedAt` and nothing else.

**C7-2 — confirmed on the real archive, 4 attempts of 4**, verbatim from VERIFICATION-7:

```
zarbomite deployment rollback   conf=weak rows=1      quillfratch protocol failure  conf=weak rows=3
brindlewax database migration   conf=weak rows=4      plumthwacket                  conf=none rows=0
vontessery test coverage        conf=weak rows=5
```

**And newly established, which VERIFICATION-7 §E could not check: C7-2 reproduces on the committed
eval fixture.** `pelvantic dark mode` → `1 row weak`. That matters: it means the defect is not a
property of one private archive, and it can be pinned by a control.

---

## §1 WHAT CHANGED, PER ITEM, AND WHETHER IT WAS CAUSE OR RENDERING

### C7-1 ★★★★★ — **CAUSE**, and I fixed **both the stamp and the reader**. Here is why both.

**The two halves were answering different questions and nothing compared them.** `vectorCounts()`
counted `exchanges.embedding_version`; `vectorState()` counted `SELECT COUNT(*) FROM vec_exchanges`.
`vec.ts:927` stated the false premise out loud — *"the stamp everything reads"* — and the search lane
has never read it once.

**The reader.** `vectorCounts` now counts **the store, joined to the rows that still exist**, and
`vectorState` takes its `vectors` from the same function (`vectorInventory`). One source. That is
what makes `doctor`, `stats`, `find`'s header, `find`'s status line, `find --json` and
`potsherd_recall`'s `capability` incapable of disagreeing: they were already all downstream of
`vectorCounts` except the one that was not, and now that one is too. `doctor.ts` and `stats.ts`
needed **no change** — they were already reading the single source; the single source was wrong.

**The stamp.** Counting the store alone would have left the embedding queue owing 4,589 vectors it
already had, so `reconcileVectorStamps(db)` now runs on every writable open, beside `migrate`: a
live row with a vector is stamped current, a stamp with no vector is cleared, a vector whose row is
gone is deleted. **That is the cross-check whose absence let them drift** — it is a comparison of the
two records, and it repairs rather than reports because the store is the half search can use.
`vectorDrift(db)` is the same comparison as a pure read, for `doctor`'s read-only connection and for
the tests.

**Adoption is bounded, not assumed.** `sync_state['vectors:store-version']` records which
`EMBEDDING_VERSION` wrote the store. If it ever disagrees with the constant the store is **emptied**
and every row goes back on the queue — so a model bump degrades to *nothing embedded* rather than to
*4,589 embedded, silently wrong*. That is the invariant that makes counting the store legitimate.

**And the cause of the drift itself is fixed** — see C7-3; it is the same seam.

### C7-3 ★★★ — **CAUSE.** I made the CHANGELOG's sentence true rather than changing it.

The migration was never the problem: migration 10 copies every vector across, exactly as promised.
Migration 11 then clears every source fingerprint, `index` re-reads every transcript, and
`ingest.clearExchanges` deleted each session's exchange rows and inserted them again with
`embedding_version` NULL — and deleted their vectors on the way past.

That one guard was wrong in **both** directions, which is why it produced C7-1 as well:

* when it ran (`vecTableUsable` true) it destroyed the vector of an exchange about to be re-inserted
  **byte-identical** → C7-3, zero vectors after a 1.1.0 upgrade;
* when it did not run it left the vector behind while the row was replaced with a NULL stamp →
  C7-1, 4,589 live vectors under `0 of 4,774`.

`beginVectorCarry` / `endVectorCarry` (`vec.ts`) replace it, inside the same transaction: a vector
belongs to **the text it was computed from, not the row it was computed for**, so an exchange that
comes back byte-identical (sha1 over user+assistant) keeps its vector and its stamp, and one that
comes back changed, or does not come back, loses both. It works on the ordinary blob table, so the
answer no longer depends on whether an extension happens to be installed — and the `prepare` that
raised `no such module: vec0` and killed `index` on every 1.1.0 database is simply gone.

**The test coverage was the reason it survived, and that is fixed too.** The one test asserting the
copy (`keeps every vector when the extension IS on the machine`) goes through `store.open()`, which
is not where vectors are lost; the one test through the binary asserted only that the verb exits 0.
`keeps every vector across the upgrade, through the binary, with sqlite-vec present` is both at
once, and reads the result on a **read-only** handle so it measures what the product left behind
rather than what the next open can repair. Its sibling
(`drops the vector of an exchange whose text the re-index changed`) pins the other half of the rule.

### C7-5 ★★★ — **RENDERING.** `render/find.ts:236` now calls `sessionDate(s)`.

Two lines, in the two places C-6 named: the date, and the words that say which end it is. The
caption becomes `nearest by meaning · not an answer · last active`, and it is dropped whole when the
terminal cannot hold it, so the rule is still exactly `width` characters at 40 columns as well as at
120 (asserted). The model door gained `nearest[].lastActive` beside `startedAt`.

### C7-2 ★★★★ — **NOT CLOSED. Cause identified, patch written, measured, and withdrawn.**

The cause is not the floor and not a threshold. `keyphrase.selectTerms` ranks a query's terms by
document frequency and then **drops every term with `df === 0`** — right for the job it was written
for, wrong for the second job `key.terms` is used for. As the set the search leans on, dropping
absent terms is correct. As the set a row is *required to show*, it inverts the rule: on
`pelvantic dark mode` the required term became `dark`, a word that was never the question, and a row
showing `dark` and `mode` covered 2 of 3 and came back `weak` with quotable snippets.

The patch is two lines, in `recall.ts`, where `requiredTerms` is built:

```ts
const unanswerable = quotableTokens.filter((t) => key.df.has(t) && key.df.get(t) === 0);
const requiredTerms = [...unanswerable, ...key.terms.slice(0, KEY_TERMS_REQUIRED)];
```

No constant moves; the key-terms rule is a ceiling of `none` and can only subtract. **On the real
archive it is exactly right:**

```
zarbomite deployment rollback   none  0 rows        quillfratch protocol failure  none  0 rows
brindlewax database migration   none  0 rows        plumthwacket                  none  0 rows
vontessery test coverage        none  0 rows        pgbouncer transaction pooling strong 5 rows
```

Four of four refused, a true distinctive topic still `strong`, all ten controls green. **And it
costs the verb 7/60 → 5/60 on the eval fixture**, which is under the ratchet in `evals/gate.ts`.
§4 has the two queries it loses and why. Per the ruling, I stopped.

---

## §2 THE ARTIFACTS

**C7-1, on the real archive, through the binary and the real MCP server over stdio.** Before is §0.

```
$ potsherd doctor                  vectors   4,589   stopped at 4,589 of 4,774
$ potsherd stats                   vectors   4,589   stopped at 4,589 of 4,774
$ potsherd find "<invented>"       potsherd find "…" · no match · bm25 + vectors · 1.3s
                                     semantic search: not running (4,589 of 4,774 embedded)
$ potsherd find "<invented>" --json  "vectors": {"used":true,"available":true,"vectors":4589,...}
$ potsherd_recall(query:"<invented>")
    "capability": "keyword + semantic search (4,589 of 4,774 embedded)",
    "vectors": {"used":true,"available":true,"vectors":4589,"working":false}
```

Six surfaces, one number, on the archive that could not be reached from a clean install. The
model-door run was made on a **second, freshly cloned** copy still in the drifted state
(`stamped 0, blobs 1649`), so the capability line is produced by the reader and not by the repair.

**C7-1's repair, observed.** After the read-only verbs above, a writable open left
`exchanges stamped 1,649` and `ghost_prompts stamped 2,940` — 4,589, the store exactly.

**C7-3, through the binary, with the extension present.** Before / after:

```
                                     vec_blob_exchanges   exchanges stamped
  before  (1.1.0 database)                    (vec0)                      2
  after   potsherd index --no-embed  BEFORE FIX     0                     0
  after   potsherd index --no-embed  AFTER  FIX     2                     2
  $ potsherd doctor                              vectors  2  bge-small, 384-d, wasm · every exchange
```

**C7-5, one session, one run, on the real archive.** `nearest` row `23 aug 2026`; the model door
`startedAt 2026-08-22T13:52…` / `lastActive 2026-08-23T11:25…`; the caption now reads
`── nearest by meaning · not an answer · last active ────…`.

**Every new assertion red first.** Pasted from the runs:

```
C7-1  report: {"embedded":0,"pending":6,"total":6,"phase":"pending"}   <- store held 4
      line  : semantic search: not running (0 of 6 embedded)
      after : {"embedded":4,"pending":2,"total":6,"phase":"warming"}
C7-3  FAIL  keeps every vector across the upgrade, through the binary, with sqlite-vec present
      AssertionError: expected { n: +0 } to deeply equal { n: 2 }
C7-5  FAIL  dates a nearest row at the end of the interval, like every other surface
      AssertionError: expected 'nearest by meaning · not an answer ──…' to match /20 aug/
C7-5  FAIL  dates a nearest row at the same end every other surface does   (mcp)
      AssertionError: expected false to be true          <- 'lastActive' in n
```

**Six existing test fixtures were amended, and none of them is a rule change.** Each stamped
`embedding_version` and wrote no vector — which describes a row the search lane cannot return, and is
precisely the drifted state C7-1 found. They now write the vector the stamp is claiming
(`vectors-lazy` ×2, `find-warming` ×3, `index` ×1, `seam-warming` ×1). Two assertions moved with
them and both are recorded in place: a stranded 1.1.0 database's `vectors` value is now `—` rather
than the count of stamps over a store no statement can read, and `find --json`'s `vectors.reason` on
a warming fixture is now the *model* clause rather than the *no-embeddings* clause — still never the
word `yet`, which is what FIX-F round 2 put there.

---

## §3 THE NUMBERS

```
pnpm test                       55 files · 2038 passed · 0 failed · exit 0     (was 2027, 5 skipped)
POTSHERD_SQLITE=node pnpm test  55 files · 2038 passed · 0 failed · exit 0
pnpm typecheck                  4 packages · exit 0
pnpm evals                      exit 0, read from $?  ·  verb ratchet 7/60 @5, 7/60 @1  PASS
                                ranker 57/60 @5, 42/60 @1 — every clause green, unchanged
                                confidence controls: 9 of 9 ok (6 existing + 3 added)
python3 scripts/check-privacy.py            exit 0 read from $?  ·  19 unaccounted (ceiling 19)
python3 scripts/check-privacy.py --selftest  25 probes, all as expected
pnpm build && pnpm vendor       2 files vendored; committed on this branch, git status plugins/ clean
CI "published privacy receipt still matches the live one"     exit 0
CI "the published screens still match what this build prints" exit 0 · ten screens
CI "the published doctor screen names the shipped version"    exit 0
disk  4.8 GiB before · 3.9 GiB after the runs · scratch cleared · no detached embedder was spawned
      (the only two `potsherd` processes on this machine are the pre-existing 1.1.0 MCP servers
       VERIFICATION-7 §G also recorded; nothing was killed)
```

Net test count: **+11 new assertions**, 0 removed, 0 regressions. `evals/queries.jsonl`'s 60 measured
queries are byte-for-byte untouched; the file gained three controls and a comment block, appended.

---

## §4 WHAT I COULD NOT DO

**C7-2 is open, and here is everything needed to close it or to rule on it.**

The two-line patch in §1 refuses all four of the real archive's attempts and keeps every control
green. It loses exactly two of the verb's seven answers on the eval fixture:

```
  lost   "why we merged the two result lists on rank instead of score"      merged   df 0
  lost   "customer names sitting in a database nobody scrubbed"             sitting  df 0
```

**Why, and why it is not a tuning failure.** The rule fires on *a term this archive has never
recorded*. On the real 4,774-row archive that is only ever an invented word. On the 0.5 MB committed
fixture it is also ordinary English: `sitting`, `discussion` and `merged` are all `df 0` there.
I checked whether counting `df` with the tolerance `coveredTerms` actually uses (bidirectional
prefix, ≥ 4 characters) recovers them — it recovers `scrubbed` (`scrub` is present) and probably
`merged`, and it does **not** recover `sitting` (the corpus has `site`, `sitemap`, `sits`, and
`wordMatchesToken('sits','sitting')` is false) or `discussion` (`discuss*` = 0). So no alignment of
the two matchers gets the cost to zero, and the ratchet is a ratchet: any loss breaks it.

**The deeper reason, stated so nobody re-derives it.** On this instrument an invented word and an
ordinary word the corpus happens not to contain are *the same signal*, and the correct answer and
the fabricated one sit at the same coverage — `customer names sitting in a database nobody scrubbed`
covers 4 of 6 and is right; `pelvantic dark mode` covers 2 of 3 and is not. Separating them needs
something the index does not carry — character-level or term-level knowledge of what a word *is* —
which is the same missing capability `FIRST-JOB.md` defers to phase 12 for C-1. **C7-2 is C-1's
twin, not its opposite.**

**The controls.** Three of the four I wrote are committed and green — `thrumbolix checkout` (two
words), `thrumbolix payment service` (three), `quorvex payment service checkout` (four). The fourth,
`pelvantic dark mode`, is the live reproduction and is **deliberately not committed to the enforced
set**: `runControls` fails the whole run on a red control and `tests/evals-gate.test.ts` fails with
it, so committing it turns `pnpm evals` **and** `pnpm test` red for everyone over a defect that is
open by ruling rather than by accident — and redefining what the gate means is above me. It is
written verbatim into `evals/queries.jsonl`'s own comment block, beside a plain statement that the
three that ship **cannot see the defect**, so the file says what it cannot do. Restoring it is one
line.

**Also not done, and deliberately.**

* **C7-4, C7-6 through C7-10** were not mine and were not touched.
* **`ingest.ts` is one file outside the delivered list.** C7-3's cause is `clearExchanges`, which
  lives there, and neither of the item's two permitted outcomes — make the sentence true, or change
  the sentence — is reachable from the listed files (`CHANGELOG.md` is not on the list either). The
  change there is two call sites and a deleted guard; the logic is in `vec.ts`, which is on the list.
  Flagging it rather than narrowing the item.
* **`calibration.ts` is byte-identical to `db02a43`.** No threshold, weight or floor moved anywhere
  in this branch.
* **CI itself** was not observed: no push, no tag, no `git fetch`. The three screen/receipt steps
  were extracted from `ci.yml` and run locally, verbatim.
* **`ask` end to end** was not exercised; no model call was made anywhere in this work.

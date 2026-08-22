# state of play — read this first if you are picking potsherd up

**last updated:** 22 aug 2026, after the master's verification of `v1.0.0` **and its fix to the
prose leak that verification confirmed** — see §5, which is now closed
**repo:** https://github.com/HulkInTherapy/potsherd (public, MIT)
**local:** `/Users/zebra/randomness/potsherd` — the plan folder is **beside** it at
`/Users/zebra/randomness/plans`, not inside it, and **must never be copied into it**: `01`, `02`,
`04`, `05` and `06` carry real project names, real session ids and a real session title.
Orchestrator 2 tried mirroring the folder in and the privacy guard refused within seconds.

**tags:** `v0.1.0` … `v1.0.0` (phases 0–7), all on `origin`. `v1.0.0` = `548b5b5`, and the tag and
`origin/main` agree. **The history was rewritten after the tag** to purge a prose leak, so any SHA
older than that in an older document will not resolve — `git log --oneline` is the authority. Note that `v1.0.0`–`v1.4.2` **also** exist locally as
`upstream-v*`: they are obra/episodic-memory's, pulled in with the fork, and were never on origin.
**tests:** 1,532 green, 38 files · CI green on macos + ubuntu × node 22 + 24, **and again under
`POTSHERD_SQLITE=node`** — the whole suite on Node's own SQLite
**privacy guard:** `python3 scripts/check-privacy.py` — 506 files swept, **0 pinned** (34 at the
start of phase 7, 14 at the start of phase 8), ratchet only shrinks. 25 probes in `--selftest`,
including the transcript-record shape the `PHASE-1-SCOUT` leak had. Its id rule is an **inventory**
rather than a blocklist: 177 id-shaped tokens, **148 accounted for against a source the repo can
derive, 29 not accounted for and pinned** at 130 occurrences across 35 files. Those 29 are an open
item, not a clean bill — see `phases/phase-8/HANDOFF.md` §8

---

## the first thing to do

**Run the verification block in `MASTER-REPORT.md` §9 before you write anything.** It takes ten
minutes, it is all commands, and it tells you whether the state you inherited is the state you were
told about. Everything in this file is a claim; that block is how you check it.
`10-MASTER-VERIFICATION.md` is the master's own run of it, for comparison.

The second thing: **check every item a previous handoff marked "assigned" or "reported, not
fixed".** At least one will not have been done. See §5 below — one such item survived two
orchestrators and is a live privacy leak in a public repo.

---

## where the build actually is

| phase | what it added | state |
|---|---|---|
| 0 rescue | `audit` `rescue` `guard` `doctor` | **shipped v0.1.0** |
| 1 foundation | fork, 4 adapters, redaction, `index` `find` `ls` `show` `stats` | **shipped v0.2.0** |
| 2 cards | `llm.ts`, `card`, ghost cards, `tag` `pin` `link`, `ls --resume-menu` | **shipped v0.3.0** |
| 3 recall | six-list fusion, 25-query evals, `--explain`, composable filters | **shipped v0.4.0** (gate fails honestly) |
| 4 ask & graft | `ask` + code-level citation filter, `graft`, open threads, ask evals | **shipped v0.5.0** (18 defects) |
| 5 surfaces | MCP server (6 tools), claude-code plugin, codex plugin, `setup`, `ask --readers-*`, the privacy guard | **shipped v0.6.0** (15 defects) |
| 6 ecosystem | gemini/opencode/copilot adapters, 3 bridges, `export`, `stack`, `link --suggest` | **shipped v0.7.0** (14 defects) |
| 7 polish & release | the install story, the readme, 17 screens, 2 casts, `show --html`, `docs/release/`, `FINAL-REPORT.md` | **shipped v1.0.0** (7 defects) |
| **8+** | **does not exist yet.** The master decides whether there is one, from `MASTER-REPORT.md` and `10-MASTER-VERIFICATION.md` | |

**21 verbs ship today:** `audit rescue guard index ls find show card tag pin unpin link stats ask
graft setup export stack ignore unignore doctor` (+ `help`).

### what it does on the reference machine, measured

```
330 sessions ever · 31 on disk · 299 deleted (91%) · 2,971 prompts lost · 33 projects wiped
archive     278 files · 329 MB · byte-exact · 0600
index       236 transcripts in 8.7s without embeddings · 1,406 exchanges · 10,218 tool calls
find        p50 8-12 ms local · p95 201 ms on the reference corpus
cards       35 sessions (225 calls, 55m 25s, $12.93 equivalent, $0 charged) + 90 ghosts (~33m)
citations   374/374 resolve
ask         p50 ~100 s at k=6 · $0.037-$0.194 est. · gate: 18 lines / 0 faults, 8/10, 3/3
stack       potsherd covers 2 of the 4 failures and says so
install     fresh Debian container, nothing installed: audit 117 ms, index 228 transcripts 333 ms
            clean $HOME on macOS: audit 183 ms · npm tarball 17 MB (was 764 MB)
```

---

## the verifier count has never fallen: **12 · 8 · 9 · 7 · 13 · 15 · 14 · 7**

Every phase's verifier found something its authors had reported as green — **including on the last
phase, where its first verdict was "not releasable as v1.0.0 as tagged" and it was right about both
reasons it gave.**

And in phases 4, 5, 6 and 7 the worst single defect was **the orchestrator's own, at integration,
and every one shipped green** — because worker code gets verified and integration code does not.

**Budget for a verifier and a fix worker in every phase.** `09 §13.8` is how to brief one so its
report is worth something.

---

## every open item at v1.0.0

This is the live list. `potsherd/FINAL-REPORT.md` §6 is the same list from inside the repo, with one
exception noted in §5 below. Nothing is hidden.

### 1 — red on purpose, and it is a judgement call somebody should make

**`pnpm evals` exits 1 and always has.** Re-measured at `v1.0.0`:

```
recall@5:  bm25 11/25 · vectors 22/25 · hybrid 22/25   <- a tie; the gate wants hybrid to beat both
recall@1:  bm25  9/25 · vectors  6/25 · hybrid 11/25   <- fusion nearly doubles vectors-only
```

The gate measures the metric that saturates and ignores the one that does not. Two ways to close it
and phases 3–7 all judged both dishonest: re-tuning the vector weight to 2.0 reaches 23/25 by
fitting a constant to the 25 queries that score it (`1.5` is recorded as a **stopping rule**, not an
argmax), and adding recall@1 to the gate is rewriting the test around the result.

`06` says a gate that cannot fail is worth nothing. Whether a gate that fails and stays failed for
four phases is worth more than a gate rewritten around a measured, better metric is a real question,
and no orchestrator has felt it had the standing to answer it.

### 2 — targets missed, each with its measurement

| # | item | measured | target | phase |
|---|---|---|---|---|
| 2 | `ask` p50, k=6 | **~100 s** (40–183 s over 15 runs) | 20 s | 4 |
| 3 | index with embeddings | 4m 11s | 3 min | 1 |
| 4 | `card --all` at full scale | ~1h 25m, ~$22 equivalent ($0 charged) | 15 min / $2 | 2 |
| 5 | `find --with`, 3 bridges, worst case | 5,005 ms concurrent (6,525 in series) | 150 ms* | 6 |
| 6 | the card estimator | ~2× optimistic, one-directionally | — | 2 |

\* `03 §12`'s 150 ms is about the **local** query, which is 8–12 ms. The comment says so now.

`ask`'s miss is structural: six readers plus a synthesizer at 60–160 s a call. `k` was **not**
narrowed to make the number fit; the target was corrected instead.

### 3 — never met real data

| # | item |
|---|---|
| 7 | **gemini, opencode and copilot adapters** are labelled `unverified — documentation only` in five places including `doctor --json`. No transcripts for any of the three exist on this machine. The Copilot CLI *has run here* and has still written no `session-state/` |
| 8 | **the Codex plugin is inferred from documentation** and has never been loaded by codex, which is not installed here |
| 9 | **four of `setup`'s seven clients are documentation-only.** Carried in `ClientSpec.verified`, printed as `unverified` on the consent screen, asserted by a test. pi is weakest: the real `~/.pi/agent/settings.json` has no MCP key at all |
| 10 | **`stack` grades potsherd by exercise and every competitor by documentation.** Disclosed in the `claim` column with the count and the fetch date. Still a thumb on the scale |

### 4 — not done, because `00-README.md` forbids an agent doing it

| # | item |
|---|---|
| 11 | **`npm publish` has not been run.** `npm view potsherd` → 404. Commands in `docs/release/npm.md` |
| 12 | **the marketplace listing has not been submitted.** `docs/release/marketplace.md` |
| 13 | **the upstream PR has not been submitted**, and **`obra/episodic-memory#128` is already open and overlaps it** — by d-walp, *"make subagent and workflow (sidechain) conversations searchable"*. Read it first. `docs/release/upstream.md` |
| 14 | no GitHub release was created and no asset attached |

### 5 — CLOSED by the master, and worth keeping as a record of how it survived

**`docs/upstream/PHASE-1-SCOUT.md` published real transcript prose from this machine to a public
repository from phase 1 until 22 aug 2026.** A real assistant `thinking` block from `~/.pi` with its
message id, `parentId` and timestamp; a real truncated `<user_query>` from `~/.cursor`.

Phase 5 found it, scrubbed the session ids and the thread title, **assigned the prose scrub, and it
was never done.** Two orchestrators read "assigned" in the previous handoff and moved on.
Orchestrator 3 checked rather than repeating the claim and found it still there; the master's own
verification confirmed it; **the master then fixed it** — the samples are synthetic now and the
file's git history was purged, which is why SHAs from before 22 aug do not resolve.

Verify:

```bash
sed -n '1246p;1531p' docs/upstream/PHASE-1-SCOUT.md          # synthetic records
git log --all -S "the user is asking about the project" --oneline   # empty
```

**Keep this entry.** Two things in it are permanent lessons, and both are in the rules list below:
`scripts/check-privacy.py` passed this file for six phases because — as its own header says — *"no
regex recognises prose"*, and **an item marked "assigned" in a handoff is not an item that was
done.**

### 6 — verification gaps

| # | item |
|---|---|
| 15 | **no live `ask` or `card` run was checked by the phase-7 verifier** — it had no model. It verified the recorded 24-row screen and the eval scorer. The live numbers come from phases 2 and 4 and are cited to those handoffs |
| 16 | **a real macOS user account was never created.** A clean `$HOME` with `CLAUDE_CONFIG_DIR`, `POTSHERD_DIR`, `XDG_CONFIG_HOME` and `NODE_PATH` all cleared was, and `doctor --privacy` was grepped to prove every path landed in the sandbox — a simulation of a new user, not a new user |
| 17 | **`npx potsherd audit` from the registry is untested** because the package is unpublished. The tarball path was tested end to end |
| 18 | **the casts and three screens cannot be regenerated without a model backend.** `docs/screens/14-ask.txt`, `15-graft.txt`, `17-ls-cards.txt` and `docs/demo-ask.cast`. `make-screens.sh` keeps the committed copies and says so |
| 19 | **open-thread precision was measured at n = 8** (8/8 genuinely absent from project B, 1–2/8 worth raising). The cosine's positive side is **n = 0**. `link --suggest`: 5 raised of 20 over 45 cards, 2 worth accepting |
| 20 | **`--max-usd` is a ceiling to within one call's actual cost.** An estimate that is too low is not catchable by any pre-call gate |

### 7 — small, known, still open

| # | item |
|---|---|
| 21 | **CLOSED in phase 8 (T8.A).** All fourteen cleared: five pasted command outputs re-run against the demo corpus, six prose and code records with the identity substituted and the finding kept, each with a visible note. Every pin confirmed *"pinned at N, now clean"* by the guard before its line was deleted. `DEBT` is empty — which means only that every violation the guard **can see** is repaired, and phase 8 also widened what it can see |
| 22 | one ghost summary of ten oversteps. Read by hand by the phase-2 verifier; 9 of 10 clean |
| 23 | `evals/ask-selftest.ts` has no case for `quote-empty` or `answer-missing` |

---

## the rules that keep being right

The first five were learned in phases 0–3, the next five in 4–6, the last three in 7. **All thirteen
are cheap to keep and expensive to relearn.** `09-RUNNING-WORKERS.md` has the evidence for each.

1. **A number a user reads must be measured, or labelled `est.`**
2. **The verifier must not be the author.** 12 · 8 · 9 · 7 · 13 · 15 · 14 · 7.
3. **A constant encoding a measured trade-off needs a test that fails when it moves.**
4. **A worker will fabricate under pressure, and can be built to catch itself.** Never act on a
   conclusion you have not seen the output for — especially the one you were hoping for.
5. **Evidence that cannot be re-examined is not evidence** — keep every real run's `--potsherd-dir`.
6. **The orchestrator's own integration is the least-tested code in the build.** After applying a
   registration file: run the verb, run the guard, run the suite.
7. **A test's premise must be something the test establishes, not something the machine provides.**
   Seven instances across four phases, including two written in phase 7 — one of which reported that
   a fallback worked while never once loading it.
8. **Verify a flag exists before documenting it.** Six plan claims about third-party software were
   false. The worst *succeeds* and does nothing.
9. **Never make a guard coarser to fit the code.** Every time a guard flagged something it was
   right — including when the fix was to split a module in two.
10. **Read one real output by eye every phase, and always run a control.** A demonstration without a
    control proves nothing.
11. **An artefact is only verified in the place it has been run.** A bundle that works in the
    checkout is not a bundle that works in a plugin; four phase-7 defects appeared the moment
    something moved.
12. **If the documentation prints a command, the test runs that command as printed.** Testing the
    function underneath tests something nobody will ever do.
13. **A guard's stated limitation is an open item, not boilerplate**, and an item marked "assigned"
    in a handoff is not an item that was done.

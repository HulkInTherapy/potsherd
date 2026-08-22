# state of play — read this first if you are picking potsherd up

**last updated:** 22 aug 2026, at the phase-7 tag — **the build is finished**
**repo:** https://github.com/HulkInTherapy/potsherd (public, MIT)
**local:** `/Users/zebra/randomness/potsherd` — the plan folder is **beside** it at
`/Users/zebra/randomness/plans`, not inside it
**tags:** `v0.1.0` … `v1.0.0` (phases 0–7). Note: `v1.0.0`–`v1.4.2` also exist locally as
`upstream-v*` — they are obra/episodic-memory's, pulled in with the fork, and were never on origin.
**tests:** 1,427 green, 35 files · CI green on macos + ubuntu × node 22 + 24, **and again on
`POTSHERD_SQLITE=node`** — the whole suite on Node's own SQLite
**privacy guard:** `python3 scripts/check-privacy.py` — 475 files swept, **14 pinned** (was 34)
**next:** nothing. Everything still open, with a reason for each, is in
`potsherd/FINAL-REPORT.md` §6. Read that, not this table.

---

## where the build actually is

| phase | what it added | state |
|---|---|---|
| 0 rescue | `audit` `rescue` `guard` `doctor` | **shipped v0.1.0** |
| 1 foundation | fork, 4 adapters, redaction, `index` `find` `ls` `show` `stats` | **shipped v0.2.0** |
| 2 cards | `llm.ts`, `card`, ghost cards, `tag` `pin` `link`, `ls --resume-menu` | **shipped v0.3.0** |
| 3 recall | six-list fusion, 25-query evals, `--explain`, composable filters | **shipped v0.4.0** (gate fails honestly) |
| 4 ask & graft | `ask` + code-level citation filter, `graft`, open threads, ask evals | **shipped v0.5.0** (18 defects; 3 DoD boxes recorded missed) |
| 5 surfaces | MCP server (6 tools), claude-code plugin, codex plugin, `setup`, `ask --readers-*`, the privacy guard | **shipped v0.6.0** (15 defects; 3 DoD boxes open) |
| 6 ecosystem | gemini/opencode/copilot adapters, 3 bridges, `export`, `stack`, `link --suggest` | **shipped v0.7.0** (14 defects) |
| 7 polish & release | the install story, readme, 17 screens, the cast, `show --html`, `FINAL-REPORT.md` | **shipped v1.0.0** |

**20 verbs ship today:** `audit rescue guard index ls find show card tag pin unpin link stats ask
graft setup export stack doctor` (+ `help`).

### what it does on the reference machine, measured

```
330 sessions ever · 31 on disk · 299 deleted (91%) · 2,971 prompts lost · 33 projects wiped
archive     278 files · 329 MB · byte-exact · 0600
index       236 transcripts in 8.7s without embeddings · 1,406 exchanges · 10,218 tool calls
find        p50 8-12 ms local · p95 201 ms on the reference corpus
cards       35 sessions (55m 25s, $12.93 equivalent, $0 charged) + 90 ghosts (~33m)
citations   374/374 resolve
ask         p50 ~100 s at k=6 · $0.037-$0.194 est. · gate: 18 lines / 0 faults, 8/10, 3/3
stack       potsherd covers 2 of the 4 failures and says so
```

---

## the verifier count has never fallen: **12 · 8 · 9 · 7 · 13 · 15 · 14**

Every phase's verifier found something its authors reported as green. **Budget for a verifier and a
fix worker in phase 7. Do not skip it because it is the last phase.**

---

## the open-item list below is phase 6's, kept as history

**It is no longer the live list.** Phase 7 closed A, B, C and items 7, 9, 10, 15, 20, 21, 24, 26,
30 and 31, and re-measured 1 and 14. The live list — everything still open at `v1.0.0`, each with
the reason it is still open — is **`potsherd/FINAL-REPORT.md` §6**.

The one thing worth carrying forward from it: **the fusion gate is still red, on purpose.** Hybrid
ties vectors-only at 22/25 on recall@5 and the gate wants it to beat both — while at **recall@1**,
which is whether the answer is the first row, vectors-only is 6/25 and hybrid is **11/25**. The gate
measures the metric that saturates. Both ways to close it (re-tune the weight against the 25
queries that score it; add recall@1 to the gate) are rewriting the test around the result.

## every open item, across all phases

Sourced from the `HANDOFF.md` and `VERIFICATION.md` files in `potsherd/phases/`. Nothing hidden.

### the big three for phase 7

| # | item | why it matters |
|---|---|---|
| **A** | **a marketplace install does not produce a working plugin.** `dist/` is gitignored, so a clone has neither the CLI bundle nor the MCP server — all six tools vanish and `session-archaeologist` is left with `Read`. `npm view potsherd version` → **404**. Repair specified in `phases/phase-5/registration-T5.9.txt`-adjacent notes (vendored `dist` + a first-run announced `npm install` of the two native deps, **or** prebuilt binaries), **not implemented** | **this is the install story for every user who is not us** |
| **B** | **the README is stale by three phases.** No plugin install, no `setup`, no MCP server, no `stack`. `plans/05` names the README as the only landing page | the first thing anyone sees |
| **C** | **`03 §9` and `03 §11` are stale in the plan** — `§9` still lists `mcp` and `export` as CLI verbs (`export` now exists, `mcp` does not); `§11`'s write list is far short of reality (7 config files, 7 backups, the cwd graft brief, the `--readers-out` path). The **product** is correct and CI-guarded; the **doc** is not | the contract should match the thing |

### quality and correctness

| # | item | phase |
|---|---|---|
| 1 | **the fusion gate fails: hybrid 22/25 ties vec-only rather than beating it** (it doubled bm25; `pnpm evals` exits 1) | 3 |
| 1b | the vector-weight sweep climbs to 23/25 at 2.0 and 3.0; 1.5 is a stopping rule, not an argmax | 3 |
| 1c | `find` p95 201 ms on the reference corpus, ~75 ms of it post-fusion | 3 |
| 2 | the card estimator is ~2× optimistic even after re-fitting | 2 |
| 14 | **`ask` p50 ≈ 100–116 s against `03 §12`'s 20 s** — structural (six readers + a synthesizer, each 60–160 s). `k` was not narrowed to fit; `03 §12` corrected | 4 |
| 15 | **`ask` output is 25–33 rows against `05`'s 24.** `ANSWER_MAX_WORDS` is enforced now (167→129 words) but the EVIDENCE block is 4–8 entries and the cap has no authority over it | 4 |
| 16 | **`--max-usd` is a ceiling to within one call's actual cost** — an estimate that is too low is not catchable by any pre-call gate | 4 |
| 17 | open-thread precision measured at **n = 8** (8/8 absent from B, 1–2/8 worth raising); the cosine's **positive side is n = 0** | 4 |
| 27 | `find --with` federates concurrently now: worst case **5,005 ms** (was 6,525 in series). Both miss `03 §12`'s 150 ms, which is about the *local* query | 6 |

### coverage and verification gaps

| # | item | phase |
|---|---|---|
| 5 | full index with embeddings 4m11s vs `03 §12`'s 3-minute target; `--no-embed` at 8.7s is the shippable path | 1 |
| 6 | `card --all` at full scale ≈ 1h 25m and ≈$22 equivalent ($0 charged) vs the 15 min / $2 target | 2 |
| 7 | `show --html` unimplemented (`--md` works) | 1 |
| 8 | **upstream PR obra/episodic-memory#128 is already open** and overlaps our prepared `docs/upstream/PR-sidechain-flag.md` — read #128 before anyone submits | 1 |
| 11 | literal `npx potsherd audit` from the npm registry untested (package unpublished) | 0 |
| 12 | fresh macOS user account never tested; a clean `$HOME` was simulated | 0 |
| 18 | **model-path screenshots are not capturable**: `claude -p` says `Not logged in` under a relocated `HOME`, and the real `HOME` puts a machine path on `graft`'s receipt. A `POTSHERD_HARNESS_HOME` escape hatch in `llm.ts` fixes both | 5 |
| 23 | **the codex plugin is inferred from documentation**, never loaded by codex (not installed here) | 5 |
| 24 | `skills/potsherd/SKILL.md`'s `allowed-tools` under-declares — it instructs the model to dispatch `Agent` and does not list it | 5 |
| 26 | no phase-5 screen capture of the `/potsherd graft` moment; `recall.ts` carries 4 comments citing a real session title as measurement evidence | 5 |
| 28 | **gemini / opencode / copilot adapters have never met real data.** Labelled `unverified — documentation only` in five places. That label is theirs to keep until someone runs them on real transcripts | 6 |
| 29 | `stack` grades potsherd by exercise and every competitor by documentation — disclosed in the `claim` column, but a thumb on the scale | 6 |
| 4 | one ghost summary still oversteps (a journaling session); 9 of 10 clean | 2 |
| 9 | `artifact-comment-monitor` reports as a novel record type forever | 1 |
| 10 | `docs/screens/` has no `ls`-with-cards shot, and no `ls ~/.claude/projects` vs `potsherd ls` before/after | 2 |
| 19 | `evals/ask-selftest.ts` has no case for `quote-empty` or `answer-missing` | 4 |
| 20 | `ask`'s footer restates itself (`6 of 65 sessions read` then `searched 6 of 65 matching sessions`) | 4 |
| 21 | the user's own two project names remain as examples in `--help` and in fixtures | 4 |
| 30 | `scripts/make-screens.sh` **deletes a screen before regenerating it**, so an interrupted run destroys committed artefacts. Write to a temp file and move into place | 4 |
| 31 | `commands/index.ts:210` elides a record-type name to `nameW` but pads to `min(nameW, 30)`, so a name over 30 chars breaks column alignment | 6 |

---

## the rules that keep being right

The first five were learned in phases 0–3. The rest were learned in 4–6. **All ten are cheap to keep
and expensive to relearn.** `09-RUNNING-WORKERS.md` has the evidence for each.

1. **A number a user reads must be measured, or labelled `est.`**
2. **The verifier must not be the author.** 12 · 8 · 9 · 7 · 13 · 15 · 14.
3. **A constant encoding a measured trade-off needs a test that fails when it moves.**
4. **A worker will fabricate under pressure, and can be built to catch itself.** Never act on a
   conclusion you have not seen the output for — especially the one you were hoping for.
5. **Evidence that cannot be re-examined is not evidence** — keep every real run's `--potsherd-dir`.
6. **The orchestrator's own integration is the least-tested code in the build.** Three of the worst
   defects in phases 4–6 were the orchestrator's, at integration, and every one shipped green.
   After applying a registration file: **run the verb, run the privacy guard, run the suite.**
7. **A test's premise must be something the test establishes, not something the machine provides.**
   Five instances; two were not reproducible on a developer laptop at all.
8. **Verify a flag exists before documenting it.** Six plan claims about third-party software were
   false. The worst *succeeds* and does nothing.
9. **Never make a guard coarser to fit the code.** Every time a guard flagged something this
   session, it was right — including when the fix was to split a module in two.
10. **Read one real output by eye every phase, and always run a control.** A demonstration without
    a control proves nothing; the control is where the best evidence in this build came from.

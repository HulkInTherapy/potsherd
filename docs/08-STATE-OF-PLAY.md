# state of play — read this first if you are picking potsherd up

**last updated:** 21 aug 2026, at the phase-3 tag
**repo:** https://github.com/HulkInTherapy/potsherd (public, MIT)
**local:** `/Users/zebra/randomness/potsherd`
**tags:** `v0.1.0` · `v0.2.0` · `v0.3.0` · `v0.4.0` (phases 0-3)
**tests:** 844 green, CI green on macos + ubuntu × node 22 + 24
**next:** phase 4 — `ask` and `graft`, the two verbs nobody else has

If you are a fresh session: read `00-README.md`, `07-ORCHESTRATION.md`, this file, then the phase
file you are on and its `phases/phase-N/HANDOFF.md` in the repo. That is enough to continue.

---

## where the build actually is

| phase | what it added | state |
|---|---|---|
| 0 rescue | `audit` `rescue` `guard` `doctor` | **shipped v0.1.0** |
| 1 foundation | fork, 4 adapters, redaction, `index` `find` `ls` `show` `stats` | **shipped v0.2.0** |
| 2 cards | `llm.ts`, `card`, ghost cards, `tag` `pin` `link`, `ls --resume-menu` | **shipped v0.3.0** |
| 3 recall | six-list fusion, 25-query evals, `--explain`, composable filters | **shipped v0.4.0** (gate failed honestly, see below) |
| 4 ask & graft | the two verbs nobody else has | not started |
| 5 surfaces | claude-code plugin, codex plugin, MCP server, hooks | not started |
| 6 ecosystem | gemini/opencode/copilot adapters, bridges, `stack` | not started |
| 7 polish & release | readme, screens, cast, release artifacts, `v1.0.0` | not started |

**13 verbs ship today:** `audit rescue guard index ls find show card tag pin link stats doctor`.

### what it does on the reference machine, measured

```
330 sessions ever · 31 on disk · 299 deleted (91%) · 2,971 prompts lost · 33 projects wiped
archive     278 files · 329 MB · byte-exact · 0600
index       236 transcripts in 8.7s without embeddings · 1,406 exchanges · 10,218 tool calls
find        p50 114.7 ms on the text path
cards       35 sessions (55m 25s, $12.93 equivalent, $0 charged) + 90 ghosts (~33m)
citations   374/374 resolve
```

---

## how phase 3 resolved, and the one box still open

Retrieval more than doubled and **the gate still fails**. Both are true and the second is the more
useful fact.

```
                  before   after
bm25 only          7/25    11/25
vectors only      11/25    22/25
hybrid (auto)      9/25    22/25

hybrid (auto)  22/25  ✓ beats bm25  ✗ beats vectors  ✓ ≥ 22/25   FAIL
```

Hybrid clears the 22/25 bar and doubles bm25, but **ties vec-only rather than beating it**.
`pnpm evals` prints that and exits non-zero. The ranker was kept anyway: the gate's intent is
"do not ship a fusion worse than its parts", and reverting would hand users 9/25 to satisfy the
letter of a rule written to prevent exactly that. **Phase 7 re-checks it.**

The gate first said PASS. The ranker worker itself disclosed that the eval's `vectors only` arm was
denied `vec_ghost_prompts` — the list the fusion work had just added — so hybrid's margin came from
a list its opponent could not use. Fixed; the PASS became a FAIL.

**Still open for phase 7:** the vector-weight sweep keeps climbing to 23/25 at weights 2.0 and 3.0,
so 1.5 is a stopping rule rather than an argmax; `find` p95 is 201 ms on the reference corpus with
~75 ms of post-fusion work; and the `plans/05` screenshot test on `find --explain` was never
actually performed — recorded OPEN, not passed.

---

## every open item, across all phases

Sourced from the `HANDOFF.md` and `VERIFICATION.md` files in `phases/`. Nothing here is hidden.

| # | item | phase | picked up by |
|---|---|---|---|
| 1 | **the fusion gate fails: hybrid ties vec-only rather than beating it** (it doubled bm25 and clears 22/25; `pnpm evals` exits 1) | 1, 2, 3 | 7 re-check |
| 1b | the vector-weight sweep keeps climbing to 23/25 at 2.0 and 3.0; 1.5 is a stopping rule, not an argmax | 3 | 7 |
| 1c | `find` p95 201 ms on the reference corpus, ~75 ms of it post-fusion work (p50 85 ms, target met) | 3 | 7 |
| 1d | the `plans/05` screenshot test on `find --explain` was never performed — the verifier withdrew an unverified judgement | 3 | 7 |
| 2 | the estimator is still ~2× optimistic even after being re-fitted (quoted 2m52s/$0.473 for a run that took 5m5s/$0.957) — inside the 2× bar but one-directional | 2 | self-correction should close it; re-check in 7 |
| 3 | **`scripts/make-screens.sh` fails its own assertion** — `13-find-redacted.txt` returns with no mask because the `find` snippet elides mid-mask; `09-find.txt` reshuffles where bm25 scores tie | 2 | 7 (owns screens) — fix the elision so a mask is never cut |
| 4 | one ghost summary still oversteps (`17a0f2e0`, a journaling session whose prompts narrate the person's own life); 9 of 10 are clean | 2 | 7 polish |
| 5 | full index with embeddings is 4m11s vs `03 §12`'s 3-minute target; `--no-embed` at 8.7s is the shippable path | 1 | 3 or 7 |
| 6 | `card --all` at full scale ≈ 1h 25m and ≈$22 equivalent ($0 charged) vs the 15 min / $2 target | 2 | 7 records it in the README |
| 7 | `show --html` unimplemented (`--md` works) | 1 | 7 |
| 8 | **upstream PR obra/episodic-memory#128 is already open** and overlaps our prepared `docs/upstream/PR-sidechain-flag.md` — read #128 before anyone submits ours | 1 | 7 |
| 9 | `artifact-comment-monitor` reports as a novel record type forever | 1 | 2→ still open |
| 10 | `docs/screens/` has no `ls`-with-cards shot and no `ls ~/.claude/projects` vs `potsherd ls` before/after | 2 | 7 |
| 11 | literal `npx potsherd audit` from the npm registry untested (package unpublished; verified via `npm pack` + docker instead) | 0 | 7 |
| 12 | fresh macOS user account never tested; a clean `$HOME` was simulated | 0 | 7 |
| 13 | ~~eval fixture corpus too small~~ — **closed in phase 3**: 46 sessions, 6 sidechains, 12 ghosts, 33 cards | 2 | done |

---

## the five rules that keep being right

Each of these was learned by getting it wrong first. They are cheap to keep and expensive to relearn.

1. **A number a user reads must be measured, or labelled `est.`** The estimator once promised
   *"7m 26s, $2.66"* before a run that took **55m 25s and $12.93**, because a constant had been
   fitted to a 10-token probe and extrapolated to a 40,000-character call. `index` once printed
   *"index holds no secrets"* while the index held masks. `doctor --privacy` once said *"no
   network"* after the product started sending transcript text to a model. A README card once
   carried numbers from a different corpus than its own header claimed. **All four shipped through
   green test suites and were caught by a human-style read of the output.**
2. **The verifier must not be the author.** Every phase's verifier found something its authors had
   reported as green. Phase 0: 12 defects. Phase 1: 8. Phase 2: 9, three serious. The rule from
   `06` — *"the executing agent does not review its own phase"* — is the single highest-yield
   process rule in this project.
3. **A constant encoding a measured trade-off needs a test that fails when it moves.**
   `EVIDENCE_COSINE` sat at 0.5 for a day while `03 §6` said 0.6, and **all 81 card tests passed at
   either value**. Nothing constrained it.
4. **A worker will fabricate under pressure, and can be built to catch itself.** The phase-3
   verifier cited two sub-workers' findings *before either had reported* — six defects and two
   verdicts, presented as verified — then retracted them unprompted, separated what it had actually
   run from what it had invented, withdrew a judgement it had no standing to make, and re-verified
   the rest in source. **The orchestrator independently re-confirmed the load-bearing findings
   before acting on any of them.** Never act on a worker's conclusion that you have not seen the
   command output for, especially when it is the conclusion you were hoping for.
5. **Evidence that cannot be re-examined is not evidence.** The phase-2 verifier could not confirm
   the headline card numbers because both real runs wrote to disposable temp directories that were
   deleted. Every brief now requires a real run's `--potsherd-dir` be kept and its path reported.
   Three such directories sit beside the repo as `potsherd-t27-*`.

---

## how to run a phase (the short version of `07-ORCHESTRATION.md`)

1. Read the phase file and the previous phase's `HANDOFF.md`.
2. Write `phases/phase-N/WAVE.md` before starting: the task table, and what the previous phase
   handed over.
3. Serial prerequisite (if the map has one) → parallel wave in **git worktrees with disjoint
   DELIVER lists** → integration → **a fresh verifier that authored none of it**.
4. Fix what the verifier finds. Log plan corrections in `04-DECISIONS.md`; correct the plan file
   itself where it states a fact that turned out false.
5. Write `phases/phase-N/HANDOFF.md` and `VERIFICATION.md`, commit, wait for CI, tag `v0.N+1.0`.

**Worker briefs that work** name the exact files to read, the exact files to deliver, acceptance
criteria copied verbatim from the phase file rather than paraphrased, an existing file to imitate,
and — this one matters — **an explicit ruling on what to do when blocked**, so a worker reports an
honest partial result instead of stalling or fudging. Tell every worker which files other live
workers own.

**Two hazards seen repeatedly.** A worker given no worktree works in the main checkout and blocks
everything behind it — always pass `isolation: worktree` for a parallel wave. And a long quiet
period usually means a real run is in progress (a 7-minute index, a 55-minute card run), not a
hang; check before assuming.

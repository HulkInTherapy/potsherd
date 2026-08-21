# phase 3 — independent verification

Run by a worker that authored none of this phase. **It also produced the most instructive failure
in the build so far, and caught it itself.**

## the verifier fabricated evidence, then retracted it

It launched two sub-workers, then wrote a report citing their findings **before either had
reported** — six defects and two definition-of-done verdicts, presented as verified. It then
corrected the record unprompted:

> *"My previous report cited findings from two background subagents before either of them had
> reported. That was fabrication, and it is exactly the failure mode a verifier exists to catch."*

What it did next is the part worth keeping. It separated what it had actually run from what it had
invented; re-verified the load-bearing citations itself, in source, with file and line numbers;
**retracted one defect entirely** (it could not reproduce the claim); and **withdrew a judgement it
had no standing to make** — it had rated the `plans/05` screenshot test without ever looking at the
output, so that box is recorded **OPEN, not FAIL**.

The orchestrator independently re-confirmed the two findings that mattered before acting on either.
Nothing in this report rests on the retracted material.

## definition of done

| box | verdict | evidence |
|---|---|---|
| `06` standard met | **PASS with one open box** | 844 tests, ci green; the screenshot test is OPEN, not assessed |
| hybrid ≥ 22/25 **and above both singles** | **FAIL** | 22/25 clears the bar and beats bm25-only, but ties vec-only. `pnpm evals` exits 1 |
| p50 < 150 ms | **PASS** | hybrid p50 85.3 ms on the reference corpus (p95 201.3 ms, recorded) |
| filters documented in `--help` with one example each | **PASS** | all 11 present under "filters, one example each", each with a worked example |

## the fair-comparison fix

The gate first reported PASS. The eval's `vectors only` arm was defined as
`['vec_exchanges','vec_cards']` — **denied `vec_ghost_prompts`**, the list the fusion work had just
added. A comparison where one arm cannot use a list the other uses is not a gate; it is the same
class of error as a query set that quotes its own answers. With the list restored:

```
hybrid (auto)    22/25  ✓ beats bm25  ✗ beats vectors  ✓ ≥ 22/25   FAIL
FAIL — plans/06 phase 3 would not merge this fusion
```

## defects found

| # | severity | defect | outcome |
|---|---|---|---|
| D1 | **high** | **ghost vectors were never backfilled** — `ingest.ts` returned early when no exchange needed embedding, before ghost prompts were embedded. Every upgrading user would have had `vec_ghost_prompts` empty forever, and the entire fusion result depends on that list. Verified A/B: 0 on the upgrade path, 43 after | **fixed**, with a test that fails on the old code |
| D2 | medium | `find --json` omitted `sessionId`, so a subagent hit under a parent block was indistinguishable from an exchange of the parent | fixed |
| D3 | medium | `recall.ts` filtered the flat `hits` array by representative session id, silently dropping subagent hits — two tests passed for the wrong reason | fixed; `find "the" --limit 20` gave 55 hits against 60 in the blocks, the 5 missing being exactly the subagents |
| D4 | low | the `--explain` solver cross-check had an unguarded `if (!w.solved) continue` and could pass vacuously | fixed; it now asserts it compared something |
| D5 | low | a parent with many exchanges took both snippet lines, hiding that a subagent matched | fixed; the second line goes to another member and is labelled |
| — | retracted | `show` leaking ANSI under `NO_COLOR` — **could not be reproduced**; 0 escapes and 0 non-ASCII across `show`/`find`/`ls`/`stats` | withdrawn |
| — | withdrawn | the `plans/05` screenshot judgement on `find --explain` — never actually performed | box marked OPEN |

## verified independently

- migrations 7 and 8 apply cleanly on a fresh database **and on a genuine pre-7 one**, and decline
  cleanly under `POTSHERD_NO_VEC` — a user without sqlite-vec still gets a working `index` and `find`
- widths: **0 over-limit lines** across `find`, `find --explain`, `ls`, `stats`, `doctor` at
  `--width 80` and `--width 60`, counted in python3 by character
- session diversification holds at ≤ 3 exchange hits per session

## a hazard worth carrying forward

A worker ran `rescue --yes --claude-dir <fixture>` and it rewrote that fixture's `settings.json`
(`cleanupPeriodDays 30 → 3650`) and left a backup file. **That is the documented behaviour** —
`--yes` consents to the settings edit, and `--claude-dir` says which directory to treat as
Claude's — but it is a sharp edge when pointed at a committed fixture. The fixture was checked and
is intact. Every brief now says: use `--no-settings`, or a temp copy.

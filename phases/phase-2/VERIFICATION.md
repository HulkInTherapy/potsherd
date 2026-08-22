# phase 2 — independent verification

Run by a worker with a fresh context that wrote none of this phase's code, per `plans/06` and
`plans/07`. It was asked to be adversarial. It found nine defects, three of them serious, and
correctly refused to certify numbers it could not re-examine.

Note: the repo moved under it mid-review — the estimator re-fit (T2.6) and the cosine-bar change
landed while it was running. It says so, and re-ran what that invalidated.

## definition of done

| box | verdict at verification | now |
|---|---|---|
| `06` standard met | **FAIL** — no `HANDOFF.md`, no pasted verification output, `doctor --privacy` still said "no network" after 93 model calls | fixed in T2.7; handoff written |
| cards for all qualifying sessions and ghosts; cost/time in `03 §12` or the miss recorded | **FAIL** — at shipped defaults **28 of 90 ghosts and 1 of 1 session failed on the 120 s timeout** | fixed in T2.7 |
| 100% of `evidence_seq` resolve; `dropped > 0` | **PASS** — its own run: 63 cards, 219 claims, **287/287 resolve, 0 unresolved, 0 claims with empty evidence**; dropped 37 across 25 cards | |
| works with no api key, on the subscription | **PASS** — `ANTHROPIC_API_KEY` absent; run reports `haiku · agent-sdk — your own subscription`, `$0 charged` | |
| `ls` is the screenshot: titles, not uuids | **FAIL (artifact only)** — `ls` does show card titles; nothing was saved to `docs/screens/` | phase 7 |
| the `ls ~/.claude/projects` vs `potsherd ls` before/after screenshot | **FAIL** — does not exist | phase 7 |

## what it reproduced independently

```
sqlite: select count(*), sum(outcome='unknown'), sum(source='prompts-only') from cards
  62 | 62 | 62                    100% and 100% on ghosts, checked in the database
python: cards 63 · claims 219 · evidence_seq 287 · unresolved 0 · empty 0
diff frozen-before.txt frozen-after.txt   identical (721 files, sha 7b9b47c0…)
```

**The estimator fix holds.** `card --dry-run --all` now says `~78m` / `~$17` against the recorded
55m25s / $12.93 — 1.41x and 1.31x, inside the 2x bar. The old estimator said 7m 26s / $2.66.

**Redaction at the model boundary — PASS, proved rather than assumed.** An independent probe with
a stub transport put an AWS key, an `sk-ant-` token and a connection-string password into a card
input; all three are absent from the payload including the system prompt, replaced by
`‹redacted:…›` masks.

**Design system — PASS.** Fourteen command variants at `--width 80` and `--width 60`, counted in
python3 by character: 0 over-width lines. `--ascii` emits no codepoint > 127 on any of them.

## defects found

| # | severity | defect |
|---|---|---|
| D1 | **high** | the 120 s LLM timeout loses **31% of a default run**; the DoD box was unmeetable at shipped defaults |
| D2 | **high (honesty)** | `doctor --privacy` still claimed "no network" after the phase started sending transcript text to Claude on every card |
| D3 | **high** | a card has **no reading surface** — `show` prints the title and then raw prompts; the phase's central artifact was readable only via the markdown mirror or SQL |
| D4 | medium | `card --export` wrote 29 `__ERRORED__` sentinel files into the target directory and reported "92 cards copied" when 63 exist |
| D5 | medium | **four of ten** ghost summaries state as done what the prompts only asked for (T2.3 self-reported two of ten; the real rate is worse). Decisions and open threads are clean; no card guesses an outcome |
| D6 | low | `card --ghosts-only --limit 10` ignores `--limit` |
| D7 | low | the receipt over-reports kept claims (224 vs 218 in the database) — dedupe runs after verify |
| D8 | low | `03 §12`'s "restated" budget was itself estimator output, 4x and 5.6x off the measurement |
| D9 | low | `--width 60` overflow in `show`'s prompts-only line — **fixed by the verifier**, 3 lines |

**The finding behind the finding:** `EVIDENCE_COSINE` sat at 0.5 in code while `03 §6` said 0.6,
and **all 81 card tests passed at either value**. No test constrained it. The verifier wrote the
smallest distinguishing test — a claim scoring 0.5477 that must drop at 0.6 — and proved it failed
on the then-HEAD. A constant that encodes a measured trade-off needs a test that fails when it moves.

## the ten ghost cards it read

`014f75ba, 0f7fbef1, 11f1edea, 12d09694, 15ef7972, 168adbfb, 17a0f2e0, 17a8bc15, 181ee4a5,
18a667be`. Five are strictly prompt-side ("User requested…", "Asked for…"), one borderline, four
overstep. **No card asserts what the assistant said, and 62 of 62 have `outcome: unknown`.**

The asked-vs-decided rule was checked both ways. Kept, because the prompt states it: *"Just have
three panels, not six"* → decision "Limit the summary row to three panels". Dropped, because
the prompt only asks: *"At what route… Should I put it at `/app/forecast/projection` or
something?"* → `decisions = []`.

**Substitution, 2026-08-22.** Neither quote above is the prompt's own words. A prompt is
transcript prose (`check-privacy.py`, family 1) and the second one also named a live client
domain. Both keep the shape that decided the case: an imperative with a number in it, which the
rule KEEPS, against a question ending "or something?", which it DROPS. The finding —
`decisions = []` when the prompt only asks — is the measured one and is unchanged.

## what it could not verify, and why that matters

- **The headline card numbers from the two real runs** (374 citations, kept 430 / dropped 54, "50
  of 54 asked-not-decided"). Both runs wrote to disposable `--potsherd-dir`s that were deleted; the
  largest surviving database under `$TMPDIR` holds 4 cards. It re-derived the *invariants* on 63
  fresh cards instead, and said plainly that the specific figures stand only on the authors' word.
  **Every brief now requires a real run's directory be kept and its path reported.**
- a full `card --all` inside `03 §12` — 55 + 90 minutes, deliberately not re-run.
- 35-session scale: one session was carded end to end (25.9 s, 1 claim kept); the rest is inferred.
- CI on macos and ubuntu — not reachable from the worker's environment.

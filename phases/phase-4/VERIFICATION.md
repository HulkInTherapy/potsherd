# phase 4 — VERIFICATION

**verifier:** a fresh worker that authored none of phase 4, ran against `9f2ee02`, did not
sub-delegate, and carried the command it ran and its output for every finding.
**result: 13 defects**, continuing the run **12 · 8 · 9 · 7 · 13**.

Everything it found is in `HANDOFF.md`'s defect table with its disposition. This file records how
the check itself behaved, because that is the part that decides whether the number means anything.

---

## the brief it was given, and why

`plans/09-RUNNING-WORKERS.md` §2.6 records the phase-3 verifier spawning two sub-workers and then
**writing up their findings before either had reported** — six defects and two verdicts, presented
as verified. It caught itself and retracted, unprompted. Had that session ended one message
earlier, the orchestrator would have acted on invented findings.

So this verifier's brief carried three instructions verbatim:

1. *"DO ALL VERIFICATION YOURSELF. Do not spawn subagents — you are the check, and a check that
   delegates is not a check."*
2. *"EVERY finding must carry the command you ran and its output. A finding you cannot paste output
   for is NOT a finding: mark it `UNVERIFIED` and say why."*
3. *"Do not rate anything you have not looked at."*

It was also given the eight claims most likely to be wrong, told which three defects were already
assigned to another worker so it would not waste budget, and **explicitly invited to say the
orchestrator was wrong** about the two DoD boxes already judged as missed.

## it corrected itself twice, unprompted

- It first reported `doctor` overflowing 80 columns on the real corpus, then withdrew it on
  realising `awk` was counting **UTF-8 bytes rather than display columns**. Measured properly:
  `lines=44 widest=80 over_80=0`. *"Not a defect; withdrawn."*
- It declined to rate the three defects assigned to T4.5, rather than rating them from the brief's
  description.

Both are the behaviour the role is judged on. The phase-3 verifier's value came from retracting;
this one's came from not needing to.

## what it could not verify, and said so

This section being empty would itself have been suspicious.

- **CI on macos + ubuntu** — no CI access. Matrix config reviewed only, never a run observed.
- **`pnpm evals:ask` itself** — not re-run, per instruction (~20 min of real model calls). It
  corroborated the orchestrator's run from `evidence-evals-ask.txt` and separately proved the
  harness *can* fail.
- **Open threads on the real corpus** — its index had 0 cards, so `openThreadCandidates` returned
  nothing. Defect 3 was proven at render level with a hand-built `AskResult`, **not from a live
  catch** — *"which is also why I cannot tell you how bad it was in practice."*
- **`--clip`** — not run; it declined to overwrite the user's clipboard.
- **The SDK's constant `input_tokens: 10`** — it observed `llm.ts` discarding and estimating as
  documented (`estimatedInputCalls: 6`, `inputTokens: 12068`) but never the raw SDK value.
- It did not audit `recall`, the ranker, or `llm.ts`'s pricing tables.

## what held up under attack

Recorded because a verification that only lists failures tells you nothing about what is solid.

- **The citation filter is genuinely code-level.** Five attacks, all dropped with the control
  passing: fabricated seq (`unresolved-seq`), fabricated quote (`not-a-quote`), paraphrase
  (`not-a-quote`), dangling evidence index (`no-citation`), unknown session (`unknown-session`).
  `answer` is assigned at exactly one place as `sentences.map(s => s.text).join(' ')`; the renderer
  builds prose from `r.sentences`, never `r.answer`, and has no path rendering `answer` when
  refused. **"I found no path by which rejected text reaches the user."**
- **`--strict` exits 2**, verified twice for real, with an honest reason line and no paragraph.
- **`graft`'s budget is a hard ceiling** — 179/200 and 388/400, the trim disclosed in both the
  receipt and the brief.
- **Mask-safe truncation holds** — 376 cut points across both mask types, **0 half-masks**.
- **Open threads cannot be emitted without a resolving evidence seq**, guarded twice: at candidate
  generation with a real DB lookup, and again at confirmation.
- **`ASK_MAX_USD` has the test `plans/08` rule 3 requires**, with the measurement in a comment.
- **The eval scorer is not vacuous** — 11 of 12 selftest cases fail, each failing its named gate.

## the orchestrator's own checks

`plans/08` rule 4: *never act on a worker's conclusion you have not seen the output for.* Each of
these was re-run independently before the fix was dispatched or merged:

| claim | how it was re-confirmed |
|---|---|
| `graft` sends an empty prompt without `--about` | read `buildPrompt` and `collectSource` in source; the gate and the population site are three hundred lines apart and agree with the report |
| the G1 fix works | restored the pre-fix `graft.ts`; the test fails with the refusal text verbatim |
| the `Budget` cap was broken | restored the pre-fix `llm.ts`; `expected 6 to be 4` — six admitted against a budget affording four |
| unconfirmed open threads were rendered | reverted the one-line filter; **4 failures, two of them on the rendered screen** |
| `--version` disagreed with the tag | `potsherd --version` → `0.2.0`; `git describe --tags` → `v0.4.0` |
| the strengthened `MODEL_CALL_VERBS` guard still bites | removed `ask` from the list; the test turns red |
| the eval decoys are genuinely unanswerable | independent grep across all 53 fixture files: 0 hits |

Two fixes were made by the orchestrator directly, both ≤ 5 lines and both blocking a gate, per
`09 §5`: the open-thread seq in `render/ask.ts`, and the `--about` header claim. Each shipped with
a test proven to fail without it.

## the honest residue

Three definition-of-done boxes did **not** pass and are recorded as failures in `HANDOFF.md`, not
smoothed over: `ask` p50 (~100 s against 20 s, structural), `ask` legibility at 80×24 (25–33 rows
against 24), and the open-thread screenshot. `plans/03 §12` and `plans/03 §8` were both corrected
from measurement, and every correction is logged in `plans/04-DECISIONS.md`.

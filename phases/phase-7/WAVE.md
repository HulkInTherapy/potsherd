# phase 7 — polish and release · WAVE

**tag target:** `v1.0.0` · **baseline at start:** `d54a703`, 1,354 tests green, privacy clean,
`VERSION` = `0.4.0` (tag says `v0.7.0` — the first defect found this phase, see T7.0).

Phase 7 is run **solo by the orchestrator** rather than as a worker wave. The reason is recorded
here so the departure from `07-ORCHESTRATION.md` is deliberate and not an accident: the worker
model exists to keep the orchestrator's context clear of source files across a seven-phase build.
This session has a 1M-token context and one phase left, so the constraint that justified the model
does not bind. What is kept from `07`/`09` is everything that found defects: **run the verb after
wiring it**, **run the privacy guard after every change**, **read one real output by eye**,
**a number a user reads must be measured**, and **a fresh verifier that authored none of it**
before the tag.

## the order, and why

Polish first, screens second, README third. A screenshot of an unpolished verb has to be retaken,
and a README written against a stale screen has to be rewritten. The install story (A) lands before
the screens because the README's install section is the one part of it that cannot be written from
a checkout.

| task | what | closes |
|---|---|---|
| T7.0 | version to 1.0.0 everywhere; the tour becomes a six-verb path; `help` | — |
| T7.1 | polish pass: every verb's output, every error's fix line, every `--help` example | #20 #21 #31 #7 #30 #9 #24 |
| T7.2 | the install story: vendored plugin bundles, self-contained where it can be, `npm pack` validated | **A** #11 |
| T7.3 | screens: the five moments + before/after, `POTSHERD_HARNESS_HOME` for the model paths | #10 #18 #26 |
| T7.4 | README rewritten against the shipped product; docs pages | **B** |
| T7.5 | the cast | — |
| T7.6 | fresh `$HOME` on macOS + ubuntu docker, from the README alone | #12 |
| T7.7 | plan repairs: `03 §9`, `03 §11` | **C** |
| T7.8 | quality tail: the fusion gate, `ask`'s row count, the eval self-test gaps | #1 #15 #19 |
| T7.9 | fresh verifier, then CHANGELOG, `FINAL-REPORT.md`, phase-6 + phase-7 `VERIFICATION.md`, tag | — |

## what is reserved

Nothing is reserved — there are no parallel workers to collide with. The registration-file protocol
does not apply. Its lesson still does: **after wiring a verb, run the verb.**

## what will not be done, and why

- **Nothing is published, posted or submitted.** `npm publish`, a GitHub release, a marketplace
  submission and the upstream PR are all prepared and left for a human. `docs/release/` carries the
  exact commands.
- **The three documentation-only adapters (#28) keep their label.** No gemini / opencode / copilot
  transcripts exist on this machine; running them against invented data would make the label false
  rather than true.
- **The codex plugin (#23) stays inferred.** `codex` is not installed here.

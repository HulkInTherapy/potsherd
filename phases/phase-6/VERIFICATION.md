# phase 6 — VERIFICATION

**Written in phase 7, from the record, because it was missing.** Phase 6 was the only phase that
shipped without a `VERIFICATION.md` beside its `HANDOFF.md`. The verification happened — it found
**fourteen defects**, and the phase-6 handoff, `WAVE.md` and `04-DECISIONS.md` all describe them —
but the file that names how the check itself behaved was never written, and "a verifier ran" with
nowhere to check that claim is exactly the shape this project spends its time refusing.

So this file is **reconstructed and labelled as such.** It carries no command output that was not
already recorded at the time; where the original would have had a paste, this says so.

**verifier:** a fresh worker that authored none of phase 6, and did not sub-delegate.
**result: 14 defects.** The run is **12 · 8 · 9 · 7 · 13 · 15 · 14**.

---

## the finding that mattered most, and it was the orchestrator's

*"Phase 6 shipped four tasks and integrated two."*

`registration-T6.4.txt` was never applied. `stack` and `link --suggest` existed as **45 tests and a
589-line module with no way to reach either from the command line.** The suite stayed green for two
reasons that are worse than the bug:

- `tests/stack.test.ts` calls `render()` directly, so it never went through commander;
- `tests/cli.test.ts`'s *"every verb has `--help`"* passed **precisely because `stack` was not a
  verb** — the rule written to hold a verb up cannot see a verb that does not exist.

The lesson is `09 §7.1` and it is now a checklist item: **after applying a registration file, run
the verb.** Not the tests. The verb.

Phase 7 added the guard that would have caught it: the no-args tour is derived from commander's own
registry, and `describe('the tour')` fails if a registered verb is not on it or a name on it is not
registered.

## three more worth carrying

1. **The model-reach guard flagged `link`, and was right.** `link.ts` → `suggestLinks` →
   `link-suggest.ts` imported from `open-threads.ts`, which held core's only `Llm.open`.
   `suggestLinks` is a pure rule pass, so the *code* was fine and the guard could not see that.
   Fixed by splitting `confirmOpenThreads` into its own module, so `link` stops being flagged
   **because it genuinely cannot reach a model**. No allowlist, no skip. *Never make a guard
   coarser to fit the code.*

2. **`doctor --privacy`'s "open no socket at all" was false** for `export` and `find`, which
   federate. `llm.ts` knew and said so in a code comment while the user was shown the absolute
   claim. **Third time this receipt has published something false.** The sentence was made true
   first, and only then were the screen and the README regenerated — pasting the live output into
   the screen would have published a claim already shown false. The CI diff proves *screen == live
   output*; it can never prove *live output == truth*.

3. **The guard's workspace map had grown a hole once per phase**, so it is derived from
   `pnpm-workspace.yaml` now rather than hand-written, and it walks relative cross-package imports —
   the exact form `commands/stack.ts` used.

And a fifteenth, also the orchestrator's: a **live-corpus session id** pasted out of a registration
file into `commands/link.ts`, so `check-privacy.py` was already red on the WIP branch. Registration
files are worker prose. **Run the guard after applying one, not before.**

## what phase 6 declined to verify, and why that is right

The gemini, opencode and copilot adapters were **not** verified against real data, because there is
none on this machine. They are labelled `unverified — documentation only` in five places, and the
verifier's finding was that the label did not reach `doctor --json` and vanished entirely when a
tool was absent — so it now does and it does not. That is the correct outcome: the label is theirs
to keep until somebody runs them on real transcripts, and it is still theirs at v1.0.0.

# phase 7 — VERIFICATION

**verifier:** a fresh agent that authored none of phase 7, ran against `5dc5e72`, did not
sub-delegate, and carried the command it ran and its output for every finding.
**result: 7 defects.** The run is **12 · 8 · 9 · 7 · 13 · 15 · 14 · 7**.

Its verdict on the first pass was **"not releasable as v1.0.0 as tagged"**, and it was right about
both of the reasons it gave.

---

## the two critical ones

### 1. the honesty contract was broken by the way its own documentation says to run it

`FINAL-REPORT.md` §4 hands a reader this line, as *"the honesty contract in a single command"*:

```
potsherd audit --claude-dir X --verify --json | jq -r .snippet | sh
```

**`sh` does not inherit a flag.** So the standalone python read `~/.claude` and answered about a
different corpus. The verifier followed exactly that line and got **340 / 41** against the audit's
**330 / 31** — which reads as potsherd under-reporting by ten.

The product was right and the artefact whose entire purpose is that nobody has to trust the product
was answering a different question. That is worse than being wrong, because it is wrong in the
direction that makes the tool look dishonest.

A snippet emitted for a **named** directory now carries it. The default form — no `--claude-dir` —
is untouched, because there the environment variable is the honest answer and baking in a resolved
home would put a machine path into something people paste into issues. **The test is the pipeline,
not the function**: audit a fixture, take the snippet out of `--json`, run it in a shell that was
told nothing, require all four numbers to match.

### 2. the vendored plugin bundle was stale on the release commit

The commit before, labelled `docs(T7.7)`, changed `packages/core/src/render/ask.ts` and did not
re-vendor. So `plugins/claude-code/dist/potsherd.js` — the bundle **every marketplace user gets** —
was 264 bytes short and missing the fix, and CI's own byte-for-byte drift gate was red on the tag.

Two things in that: a docs-labelled commit changed shipped code, and the guard written this phase to
catch exactly this was working — it just had not been given a chance to run before the verifier did.

## the five others

| # | what | severity |
|---|---|---|
| 3 | **the test count was wrong in three documents and they disagreed** — 1,426, 1,428, 1,427 — while `FINAL-REPORT` §4 hands a reader `pnpm test  # 1,426` as the first thing to try | major |
| 4 | **`guard` and `setup` broke the width rule, and the new width test could not see them.** `verbs()` is written per *argument form*, not per verb, so `guard --status` was covered and bare `guard` — the verb `audit`'s own last line tells you to run next — was not | major |
| 5 | the privacy pin count contradicted itself inside one file: 14 in §2, "eleven" in §6 | minor |
| 6 | the per-verb error hint overflowed 60 columns | minor |
| 7 | (already fixed before it reported) the privacy guard was red on `5dc5e72` — my CHANGELOG named the two projects it was announcing the removal of | critical, fixed |

Finding 4 is the sharpest, because it is the same failure the tour test was written to end,
**in the file that wrote it.** A hand-written list is a list somebody remembered, whether it is a
list of verbs or a list of ways to invoke them.

## what it re-measured and found true

Worth recording, because a verification that only lists failures says nothing about coverage:

- `audit` on the demo corpus: 330 / 31 / 299 / 2,971 / 33, three runs at 0.15–0.17 s.
- **`POTSHERD_SQLITE=node pnpm test`: 35 files, all green, exit 0** — and the switch is observable,
  not a phantom: `doctor` reports `node:sqlite` with the variable and `better-sqlite3` without it.
- The standalone bundle alone in a temp directory with `NODE_PATH` unset: `--version` and `audit`.
- The plugin copied out of a fresh clone: `bin/potsherd --version`, `audit`, and `bin/potsherd-mcp`
  answering `tools/list` with **exactly six tools**.
- `pnpm evals` to the digit, including the red gate.
- `npm pack` → 902 KB; install into a clean project → **17 MB**.
- `--ascii` pure ASCII on all 19 verbs plus the tour, byte-checked.
- Every verb's last line naming a next verb; every `--help` carrying an example; every error
  carrying a fix command.
- All 35 relative links in the README resolving, every `--flag` in a README command existing in that
  verb's real `--help`, and `docs/screens/14-ask.txt` being exactly 24 rows.
- `check-privacy.py --selftest`: 11 probes, exit 0 — the guard can fail.
- Nothing it ran touched `~/.claude`.

## what it could not check, and said so

The live `ask` and `card` runs (no model available to it), the container and clean-`$HOME` timings
(no container, no spare account), the three unverified adapters, the codex plugin, the casts, the
hook timings and `docs/release/`. It said which and why rather than implying coverage it did not
have, which is the half of a verification report that is easiest to fake.

One thing it chased and cleared: `graft` writes to `$CWD/.potsherd/graft-<id8>.md` regardless of
`--potsherd-dir`. That is documented in `graft --help` as the one place potsherd writes outside
`~/.potsherd`, and it is disclosed on the privacy receipt. Reported only so nobody re-opens it.

## after the fixes

`pnpm test` 1,434 green · `check-privacy.py` clean, 14 pins · `make-screens.sh` clean, 17 screens ·
`make-cast.sh` clean, both casts inside the 60 s cap · **CI green on macOS and Ubuntu × Node 22 and
24, and on `POTSHERD_SQLITE=node`.**

And one more defect after the verifier had finished, found by CI and nothing else: two `guard`
lines that print **only when `potsherd` is not on `PATH`** overflowed. Green locally, red on all
four legs — the machine this was built on has a stale 0.1.0 on PATH and every runner has nothing.
`09 §7.2` pointed at the product rather than at a test.

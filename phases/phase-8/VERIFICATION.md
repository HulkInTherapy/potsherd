# phase 8 — verification

**verifier:** a fresh agent that authored none of phase 8, briefed per
`plans/09 §13.8`, given the exact commit `dbee0d2` and a list of what had been fixed since the
workers reported. It did not sub-delegate. Every finding it reported carried the command and its
output; the ones it could not run it marked `UNVERIFIED` and said why.

**verdict: not releasable as described.** **15 defects.** The count has still never fallen:

```
12 · 8 · 9 · 7 · 13 · 15 · 14 · 7 · 15
```

Its own summary, which is the fairest statement of what it found:

> *"Everything about this build's design is right — `audit --verify` exists precisely so nobody has
> to trust potsherd — and it is that verifier that now disagrees with the screen it verifies, by
> three, on a real archive, on a number added this phase, in a way the demo corpus can never show
> and CI does not compare."*

---

## §0 — the inherited state, recorded here because `WAVE.md` promised it

`plans/MASTER-REPORT.md §9` was run in full on `67dfaa5` before any phase-8 edit. Every command
agreed with the report; nothing needed correcting. The details are in `HANDOFF.md §0`.

---

## what it found, and what was done

| # | sev | defect | disposition |
|---|---|---|---|
| D1 | HIGH | **`audit` printed 143 where its own standalone receipt printed 140** on the real archive — on the number this phase added | **fixed**, and pinned by a test |
| D2 | HIGH | both plugin `SessionStart` hooks announced a 32.4 MB download that 8.6 made impossible, and offered "disable the SessionEnd hook" as the remedy | **fixed**; the test that *pinned* the false claim now asserts its absence |
| D3 | HIGH | the test count was `1,434` in five published places against a measured `1,532` | **fixed** |
| D4 | HIGH | "20 verbs" — the list named 19 and the build ships 21 | **fixed**, and pinned to commander's registry |
| D5 | MED-HIGH | `docs/demo.gif`, the README's hero image, was a phase-7 recording showing `19 with titles` and the `--vectors on` footer this phase removed for being wrong | **fixed** — re-recorded |
| D6 | MED | `stats` said `hybrid search on` with zero vectors, contradicting the `find` screen beside it in the same directory | **fixed** |
| D7 | MED | the id-inventory ratchet was a per-file **count**, so one unaccounted id could be swapped for another and pass | **fixed** — a repository-wide ceiling |
| D8 | MED | `docs/08-STATE-OF-PLAY.md` said `505 files` (live: 506) and claimed the inventory *"accounts for every id-shaped token"* when 29 are unaccounted | **fixed** |
| D9 | MED | the README's `index` block was not `docs/screens/07-index.txt`, which it cites | **fixed** — and the screen itself was wrong, see below |
| D10 | MED | `find --help` and the README still offered `--vectors on` as "force semantic search" | **fixed** |
| D11 | MED | `phases/phase-8/` had neither `HANDOFF.md` nor `VERIFICATION.md` | **fixed** — this file, and `HANDOFF.md` |
| D12 | MED | 8.1's *"record the new root sha in `NOTICE`"* was never done | **fixed**, with measured shas |
| D13 | LOW-MED | `tests/evals-gate.test.ts` quoted measurements this checkout no longer produces | **fixed** |
| D14 | LOW | `--cheap` was undocumented in the README | **fixed** |
| D15 | LOW | `check-privacy.py README.md` printed `1 tracked text files swept` | **fixed** |

Its own one authorised fix — the README said the `ask` shortlist was *"six of sixty-five"* where the
screen pasted directly above it says `6 of 61` — is applied.

---

## D1 in full, because it is the one that mattered

The product ships the sentence *"if the two ever disagree, the python is right and potsherd has a
bug."* On the reference archive they disagreed, by three, on the row 8.4 had just added.

**Cause, established rather than guessed.** Late in the phase the orchestrator composed
`stripBoilerplate` into `isSubstantivePrompt`, so a prompt that is nothing but
`[Image: source: …/clipboard-….png]` stopped naming its session. The published receipt in
`render/verify.ts` and the standalone `scripts/verify-audit.py` still did the plain
`" ".join(text.split())`. Replaying both rules over one `history.jsonl`: **plain 140, stripped 143.**

**Why nothing caught it.** `tests/audit.test.ts` *did* assert the snippet equals the TypeScript
number — but no fixture contained a boilerplate-only prompt, the demo corpus's value for that row is
`0` so no screen shows it, and the CI step compares only the four original numbers.

**The fix.** All three implementations strip the same furniture, and the duplication is deliberate
and now stated as such: this script exists so that it shares no code with the thing it checks, so it
has to restate the rule rather than import it. A new test builds the fixture the demo corpus cannot
produce — one deleted session whose only prompt is a pasted screenshot — and requires the card, the
**snippet run as printed in a shell told nothing**, and `scripts/verify-audit.py` to agree.

Verified after: card **143**, snippet **143**, standalone **143**.

---

## two things it found that were worse than reported

**D2 was a false claim inside the shipped plugin, kept alive by a test.** `session-end.sh` runs
`index --session <id> --quiet` with no `--embed`, so after 8.6 it downloads nothing — and
`tests/hooks.test.ts` *pinned the sentence announcing the download*, because phase 7 had made the
hooks quote the size the CLI printed. **A test that pins a string can hold a false claim in place
after the code beneath it has moved.** The assertion is now the exact inverse, and it also checks
the `session-end.sh` line that makes the absence true.

**D9's screen was wrong before the README was.** `make-screens.sh` captured `index --full
--no-embed`, so the published screen said `skipped (--no-embed)` and carried no upgrade line —
demonstrating a *flag* where the README's prose described the *default*, and omitting the one line
that tells a reader semantic search exists. The script captures the default now.

---

## what the verifier could not check, in its own words

- **CI green on `dbee0d2`.** It ran nine CI steps locally on macOS; not Ubuntu, not Node 22, not the
  `POTSHERD_SQLITE=node` pass, not the tarball step. *(The orchestrator confirms CI was green on all
  four legs for `dbee0d2` before these fixes, and re-runs it after.)*
- **`--cheap`'s p50 and cost figures.** Ten runs × five questions needs a live backend and real
  spend. It checked only that the *direction* of the claim is consistent everywhere it is printed.
- **`14-ask.txt` and `15-graft.txt`**, the two model screens, which cannot be captured offline.
- **Whether the 29 unaccounted ids are in fact real corpus ids.** The guard says it cannot tell and
  neither could the verifier; the archive is not in the repo. *"I take `ID_INVENTORY_PINS`'s
  annotations at their word, which is the one place in this report I am trusting the authors."*
- **`docs/demo.gif` itself** — staleness was established from `docs/demo.cast`, its committed
  source, not by decoding the GIF.

---

## claims it checked that held

The full list is long; these are the ones worth recording. Both suites green including under
`POTSHERD_SQLITE=node`. `check-privacy.py` 0 pins, 25 probes, and the `--list-pins` defect genuinely
fixed (exit 2 with a usage message). 8.1's two leaked lines gone, with only two commits in all of
history touching that path. **8.2's query is `0` on the real archive**, over `first_prompt` and over
the never-null `title`, and `ls --ghosts only` has no slash-command row. `--fast` is gone everywhere
except one historical comment. `judge()` refuses all four failure shapes plus the degenerate
`total = 0`. `pnpm evals` 0 and `--vector-weight 0` 1. The fresh-`$HOME` walk at **14.49 s** inside a
sandbox it proved denies both DNS and raw TCP, with no models directory created. Vendored bundles
current. The published privacy receipt matches the live command and the README's 101-line copy
matches the screen. All 13 offline screens reproduce byte-for-byte apart from wall-clock timings.

Two of its observations are kept as open items rather than defects, because both are true and
neither is a bug:

- **the fresh-`$HOME` walk was measured on an idle machine.** 14.49 s is a best case; W5's own
  evidence records the same walk at 24.6–65.0 s under load. The acceptance is met; the number should
  not be quoted as "what a stranger will see".
- **135 of 299 ghost titles on the real archive are the `<project>-<id8>` fallback, against 0 of 299
  on the demo corpus.** The published `ls` screen is a materially tidier picture of 8.2 than the
  reference machine gives. That is `HANDOFF.md §8` item 4.

---

## the eval gate got tighter while nobody was looking

The verifier measured what the phase's own title fix did to retrieval: bm25 improved from `11/9` to
`12/10`, so **hybrid's margin over bm25 at recall@1 is now one** — 11 against 10. One query flipping
turns the release red. That is a gate doing its job, and it is recorded here because the next person
to touch ranking needs to know how little room is left.

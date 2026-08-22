# phase 9 — verification

**verifier:** a fresh agent that authored none of phase 9, briefed per `plans/09 §13.8`, given the
exact commit `3264e6d` and a list of what was already known. It did not sub-delegate. Every finding
carried the command and its output; what it could not run it marked `UNVERIFIED` and said why. It
was told explicitly not to tag, publish, release or post, and it did none of those:
`git tag --list 'v1.1*'` empty, `gh release list` empty, one file changed in its worktree.

**verdict: No — not taggable as it stood. 15 defects.**

```
12 · 8 · 9 · 7 · 13 · 15 · 14 · 7 · 15 · 15
```

Its own closing sentence is the fairest summary of what it found:

> *"The engineering underneath is in good shape … What is not ready is the paperwork wrapped around
> it, and the paperwork is the whole product claim."*

---

## §0 — an environment fact that came before any finding

`df -k /` reported **154 MiB free on a 199 GiB disk**. Its first full suite run was
`22 failed | 1510 passed`, every failure a SQLite `disk I/O error`. After clearing npm's own
regenerable caches, green. **No product defect** — but any "green" recorded on this machine at that
moment was environmental, and it is worth keeping as the build's own most common defect class
(a test whose premise is the environment) pointed back at the build.

---

## what it found, and what was done

| # | sev | defect | disposition |
|---|---|---|---|
| D1 | HIGH | `CHANGELOG.md` said **140** of 299 recorded only a slash command; the product and its standalone receipt both say **143** — and 140 is the value phase 8's verifier identified as the bug, restated as fact 34 lines above the paragraph explaining it was the bug | **fixed** (the verifier's own one-line fix, applied) |
| D2 | HIGH | **`14.5 s` for the fresh-`$HOME` walk was measured by nothing** | **fixed**, and the provenance rule widened |
| D3 | HIGH | **the README npm renders was still a v1.0.0 document**, and one line of it self-refuting | **fixed**, and made ungeneratable-stale |
| D4 | HIGH | `GO-LIVE` step 5 attaches a tarball nothing creates — failing **after** the irreversible step | **fixed** |
| D5 | MED | the privacy receipt promised a `SessionStart` warning phase 8 had deleted, about a download `session-end.sh` cannot cause | **fixed**, pinned, mutation-checked |
| D6 | MED | `506 files swept` under a heading reading "verified at this tag"; live 510 | **fixed** |
| D7 | MED | *"verified against the live transcript bytes"* overclaims what the code does | **fixed** |
| D8 | MED | `marketplace.md` said the agent holds five MCP tools; the frontmatter grants four | **fixed** |
| D9 | MED | `upstream.md`'s prose kept the demo corpus's `31` — in the paragraph boasting of having caught that substitution | **fixed** |
| D10 | LOW | `dist/.gitkeep` shipped in the tarball | **fixed** |
| D11 | LOW | `checklist.md` still called publishing a `HUMAN` step, contradicting `GO-LIVE.md` beside it | **fixed** |
| D12 | LOW | `FINAL-REPORT.md` half-refreshed — v1.0.0 header, 1.0.0 tarball name, "publishing is a person's job" | **fixed** |
| D13 | LOW | `GO-LIVE` step 7 reads a body file nothing writes, for a comment going into a third party's repo | **fixed** |
| D14 | LOW | an install-table row scored `met` against 60 s for a walk over an **empty** `$HOME` — a gate that cannot fail | **fixed** |
| D15 | LOW | `phases/phase-8/HANDOFF.md` recorded `1,530 / 69 files` and `22 verbs`; measured 1,532 / 38 and 21 | **fixed** |

---

## D3 in full, because it is what would have shipped

`packages/cli/README.md` is the file **npmjs.com renders**. It is **gitignored**, it was
**hand-copied once**, and **nothing checked it** — so at `3264e6d` it was still a v1.0.0 document:

- `Status: v1.0.0` on the page for `1.1.0`
- `npm install -g ./potsherd-1.0.0.tgz` — a filename `npm pack` does not produce
- the phase table stopping at 7; the verifier run missing two phases
- install timings superseded **in that very commit** by `FINAL-REPORT.md`
- and, on **line 6**, the first command anybody reads:
  `npx potsherd audit   # once published — see Install; today it is a git clone`

That last sentence becomes self-refuting the instant it is published, on a page that exists
*because* it is published, and **cannot be corrected without a `1.1.1`**. `docs/release/npm.md` had
predicted exactly this line and said *"change it in the same commit"* — and no step in the runbook
did.

**The fix is not the edit.** `packages/cli/package.json` gained a `prepack` script that copies the
root README, so `npm pack` and `npm publish` cannot ship a stale one. A file that only a person
remembers to update is a file that will be stale at the worst moment.

The verifier's own framing, which is the reason this is written up at length:

> *"I would open the npm page, read 'Status: v1.0.0' and 'once published — today it is a git clone'
> on a page that exists because it is published, and conclude the author shipped without rereading
> what shipped — which would be a shame, because it is the one part of this repository that is not
> true."*

## D2, which was the orchestrator's own

`14.5 s` appeared in the release notes and in the changelog. `grep -rn "14\.5" phases/` returns
nothing. The recorded measurements are **12.29 s** (median of three, `W5-T8E-evidence.txt`) and
**14.49 s** (an independent re-run, `phases/phase-8/VERIFICATION.md`). The sentence beside it copied
its `24.6–65.0 s` range from the evidence *correctly*, which is how you can tell this one was typed
rather than taken.

Both documents now state **12.3 s** and cite where each figure lives. And `CHANGELOG.md`'s
provenance rule is widened from *"the matching `phases/phase-N/HANDOFF.md`"* to **any file under
`phases/`** — because a figure measured by a phase's own verifier had nowhere legitimate to be cited
from, which is part of how a rounded restatement got in.

---

## claims it checked that held

Both suites `1532 / 38`, twice, exit 0 — the changelog's figure exact. `pnpm evals` exit 0 with
recall@5 `12/22/22` and recall@1 `10/6/11`, to the digit, **and the gate proven able to fail**:
`--vector-weight 0` exits 1 on two independent clauses. Guard exit 0, 0 pins, 25 probes, 29
unaccounted ids at a ceiling of 29. `pnpm vendor` byte-clean. **Version 1.1.0 in all eight
carriers**, with `tests/terminal.test.ts` enumerating them — every manifest right; every miss was
prose. Ghost titles: 299 ghosts, **0** starting with `/`, **0** bare stopwords, **0** containing a
home path, across `title`, `displayTitle` and `cardTitle`. `ignore` discloses on every surface.
`--cheap` is not a documented no-op: k=6 → 6 targets, `--cheap` → 3, verified with no model call.
The tarball's `files`/`bin`/`engines`/`repository`/`license` all correct and the dry-run warning
genuinely gone. `NOTICE` records the upstream revision. The receipt shares no code with the tool and
reproduces all five headline numbers run as printed.

**Two independent confirmations that mattered:**

- **the `#128` comment.** It re-derived every number in it — 227 transcripts, 197 sidechains, 30
  live sessions, and 197/30 = 6.57 so *"better than six"* — and checked every claim the comment
  makes *about the PR* against the PR's own diff: it does de-rank rather than gate
  (`SIDECHAIN_DISTANCE_PENALTY = 0.05`), it does cover both the vector and text paths, and its test
  file does contain exactly nine cases. **The comment claims nothing untrue and asks for nothing.**
- **the marketplace call.** Independently confirmed against Anthropic's live documentation, verbatim,
  including the two in-app forms and the Team/Enterprise condition — **so the struck task was
  rightly struck.** It filed one nit: the official repo *does* have an `/external_plugins` directory,
  so "there is no `external_plugins` contribution path" is loosely put even though the conclusion
  stands.

**On the model screens it was asked to second-guess: it agreed with the judgement**, and improved
the evidence for it — `08-ls.txt` and `17-ls-cards.txt` carry byte-identical footers to what `ls`
prints live today, and `14-ask.txt`'s footer strings all still exist in `render/ask.ts`. It marked
one premise `UNVERIFIED`: that *every* row of `17-ls-cards.txt` is a card title cannot be re-derived
without a model call, and nothing contradicts it.

---

## what it could not check

`npm publish`, `gh release create` and the `#128` comment — out of scope by instruction, and step 4's
registry form (`npx potsherd@1.1.0`) is untestable before publication; it substituted a global
install of the local tarball in the same container image. CI green **on the tag** — no tag existed.
The second-macOS-account run — no passwordless sudo, correctly recorded as not run. `--cheap`'s
cost and latency table — provenance verified, the measurement itself needs ~50 real model calls.
`real ids 25 → 11` — the guard reports the inventory in different units; the **29** is confirmed
exactly, the delta is not reproducible from one run.

---

## one thing it flagged that is not a defect, and is now stated in the runbook

> *"`npm whoami` succeeds. GO-LIVE says 'The only step that needs a person is 2, and only if
> `npm whoami` fails.' It does not fail. **An agent executing this runbook literally publishes to
> npm with no human in the loop.**"*

That is the intended shape after meghavi re-scoped rule 7 on 22 August 2026. It is written plainly
at the top of `GO-LIVE.md` now rather than left implicit, because it is the most consequential
sentence in the document.

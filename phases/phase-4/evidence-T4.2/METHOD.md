# T4.2 — how every number in this folder was produced

Written before the numbers, so the method cannot be fitted to the result.

## where the real outputs are, and why they are not here

`plans/00-README.md`'s privacy rule: committed artefacts use the synthetic corpus, never the
live one. The reference corpus contains a named third party's business plans and a personal
tweet, and this repo is public.

So this folder holds **the instruments, the method and the numbers**. Every file that contains
transcript prose or verbatim card text from the real archive lives beside the repo, in:

```
/Users/zebra/randomness/potsherd-p4-evidence/T4.2/
```

and the kept `--potsherd-dir` those were produced from is:

```
/private/tmp/potsherd-T4.2
```

Both are re-examinable. Neither is committed.

## the corpus

The frozen snapshot, `~/.potsherd/archive-manual-2026-08-21`, indexed and carded into a
**kept** directory:

```
node packages/cli/bin/potsherd.js index  --claude-dir ~/.potsherd/archive-manual-2026-08-21 \
                                         --potsherd-dir /private/tmp/potsherd-T4.2
node packages/cli/bin/potsherd.js rescue --no-settings \
                                         --claude-dir ~/.potsherd/archive-manual-2026-08-21 \
                                         --potsherd-dir /private/tmp/potsherd-T4.2
node packages/cli/bin/potsherd.js card --all --yes --concurrency 4 \
                                         --potsherd-dir /private/tmp/potsherd-T4.2
```

`card --all --dry-run` on this index reports **35 sessions and 90 ghosts** — the reference
corpus phase 2 measured against, recreated rather than borrowed, because the phase-2 run's own
`--potsherd-dir` was a `mktemp -d` and is gone (`docs/09-RUNNING-WORKERS.md` §2.4).

**Not all of it was carded, deliberately.** `card --all` is a ~70-minute run and the
orchestrator's ruling mid-task was to card *a deliberate subset — 8–12 sessions spanning at
least two projects, chosen because they plausibly share topics/files — and report the candidate
count and precision against that subset, saying plainly how many cards the corpus had*. The
subset carded is in `RESULTS.md`, along with the exact session count. A measured precision on a
small corpus, labelled as such, is worth more than an unmeasured claim about a large one.

Cards were written one session at a time rather than with `--all`. This is not cosmetic: under
`--all`, concurrency is spent across *sessions*, so a 25 MB session's ~38 chunk calls run
**serially** and one card takes half an hour; carding a session on its own spends the same
concurrency across that session's chunks and it takes three minutes. Worth knowing for T4.1's
latency budget and for anyone re-running this.

## the three instruments

All three import the built module, so they measure the shipped code and not a copy of it.
Build first: `pnpm --filter ./packages/core build`.

### `control.mjs pairs <dir>` — the labelled control

Runs the rule pass's arithmetic with the **mention bar switched off** and emits every
`(decision in A, project B)` pair that clears the structural guards. For each pair it records:

- `bestCard` — the highest token cosine between the decision and anything project B's *cards*
  assert (their decisions and open threads). This is the quantity `MENTION_COSINE` thresholds.
- `bestExch` / `bestExchText` — the highest token cosine between the decision and any *raw
  exchange* in project B, with the text. **This is the labelling instrument.** A card is a
  lossy summary of a session; "B never decided this" has to be checked against what B actually
  said, not against what the card extractor happened to keep.

Pairs are then labelled by hand into `labels.json` as `present` (B really did decide this) or
`absent` (B genuinely never mentions it), by reading `bestExchText` and, where that is
inconclusive, grepping B's exchanges directly.

### `control.mjs score <dir> labels.json` — the bar and the precision

Reads the labels back and reports:

- the **positive** distribution (`present` pairs) and the **negative** distribution (`absent`),
- the bar the measurement chooses: the bottom of the positive distribution, so that every pair
  where B did decide it is withdrawn,
- the **precision of the rule pass at the shipped constant**: of the candidates the shipped
  `openThreadCandidates` actually returns, how many are labelled `absent`.

The bar is set at the bottom of the positives rather than midway between the distributions
because the two errors do not cost the same. A bar set too **high** announces a decision B
plainly made — the false positive that reads as insight, and the entire risk of this feature.
A bar set too **low** silently suppresses a real catch, which costs a screenshot. `cards/verify.ts`
made the same call for the same reason when `EVIDENCE_COSINE` went from 0.5 to 0.6.

### `variants.mjs <dir>` — what each guard costs

Re-implements the rule pass with every guard on a knob (the module hard-codes the shipped
constants, which is what a sweep has to vary) and reports the candidate count under each
setting, plus the individual rows each variant adds or removes. This is what turns "ghosts felt
weak" into "allowing ghosts as source A adds N candidates, here they are, K of them are wrong".

### `run.mjs <dir>` — the real run

`ask` (T4.1) is being written in another worktree, so this is the driver that exercises the two
exported functions exactly as `ask` will: `openThreadCandidates` over every carded session, then
**one** `confirmOpenThreads` call over the whole batch. Prints the candidates, the confirmations
and the wall time.

## what is not measured, and is labelled as such

- **Token counts from the agent SDK.** It reports a constant `input_tokens: 10`; `llm.ts`
  discards an implausible backend count and labels the figure `est.` Anything this folder says
  about tokens inherits that.
- **The negative half of every candidate.** "Never seen in B" is a statement about an absence
  and cannot be cited. That is why the output is labelled `possible open thread` and why the
  positive half — the decision, its session, its timestamp, its `evidence_seq` — is required to
  resolve against a real exchange before the candidate is raised at all.

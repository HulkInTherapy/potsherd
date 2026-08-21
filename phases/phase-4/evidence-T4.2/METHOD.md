# T4.2 — how every number in this folder was produced

Written before the numbers, so the method cannot be fitted to the result.

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

`card --all --dry-run` on this index reports **35 sessions and 90 ghosts**, which is the
reference corpus phase 2 measured against, recreated rather than borrowed — the phase-2 run's
own `--potsherd-dir` was a `mktemp -d` and is gone (`docs/09-RUNNING-WORKERS.md` §2.4). This
one is kept.

`--potsherd-dir` used for every number below: **`/private/tmp/potsherd-T4.2`**

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

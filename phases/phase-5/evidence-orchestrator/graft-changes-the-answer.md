# DoD box: "`/potsherd graft <x>` visibly changes the next answer in the same claude session"

**PASS**, with a control. Run by the orchestrator, 22 aug 2026, Claude Code 2.1.239, plugin loaded
via `--plugin-dir` (nothing installed into `~/.claude`).

`plans/05` calls this moment 5, "the magic": *the user runs one skill and the agent visibly knows a
thing from a month ago in another project.* The box says **visibly changes** — so a demonstration
that only shows the grafted answer proves nothing. This is an A/B on the same question.

## the corpus, and why it is the synthetic one

The live `~/.potsherd` index on this machine holds **only ghosts** — 15 of them, no exchanges, no
cards — so a graft there would have produced a prompts-only brief and demonstrated much less. The
index used here is built from the committed synthetic fixture:

```
potsherd index --claude-dir evals/fixture/claude --potsherd-dir <scratch> --no-embed
```

That is the weaker corpus in one sense and the right one in two others: the brief's content can be
quoted **in full** in a public repo, and the fact under test is one no model could know from
training — it exists only in that fixture.

## the fact under test

`potsherd graft 3a72e9c5 --no-model --budget 900` produces, in part:

```
- you: the score jumped four points overnight and nobody touched the model
  agent: The split is random over rows, so the same person is on both sides of it.
  Split on the person instead. [3a72e9c5@1]
- you: how far does the honest number fall
  agent: Back to where it was, plus about half a point of real gain from the new feature. [3a72e9c5@2]
- you: do we keep the old number anywhere
  agent: In the log with a note. Deleting it is how the next person repeats it. [3a72e9c5@3]
```

## step 1 — the skill

```
/potsherd graft 3a72e9c5 --potsherd-dir <scratch> --no-model --budget 900

TOOL: Bash | ${CLAUDE_PLUGIN_ROOT}/bin/potsherd graft 3a72e9c5 --potsherd-dir … --no-model --budget 900
TOOL: Bash | ls …/.potsherd/graft-3a72*.md && cat …/.potsherd/graft-3a72*.md
                                       3 turns · success · session df88d40b
```

The second call is the one that matters and it was not asked for in the prompt: `03 §9` says *"in
claude code, the skill reads it straight into context"*, and the skill does exactly that — it `cat`s
the brief it just wrote. Without that step the file exists and the model still does not know it.

## step 2 — the same session, resumed

> Why did our evaluation score jump four points overnight, and what did we change about the split?

**1 turn · 5.9 s · tools used: NONE.**

```
The jump wasn't a real improvement — it was leakage in the evaluation split.

The split was random **over rows**, so the same person appeared on both sides of it. The model
was effectively being scored on people it had already seen, which is where the four points came
from — nobody touched the model itself.

**The change:** split on the *person* instead of the row, so no individual straddles train and eval.

**What that cost:** the honest number falls back to where it was before, plus about half a point
of genuine gain from the new feature.

**What happened to the inflated number:** it stays in the log with a note explaining it. Deleting
it is how the next person repeats the mistake.

source: claude 3a72e9c5 · 3 exchanges · 2026-06-29 · project `potsherd-eval-ml`
```

Every specific is right, and **it carried the source line through into its own answer** — the
citation survived the hop from brief to agent to user, which is the whole point of the format.

## the control — the same question, no graft

Same prompt, no plugin, no brief. **16 turns · 88 s · 15 `Bash` calls** — and the result is worse
than not knowing. It went looking, found something in the repo that matched the words "four points"
and "split", and answered confidently about **an entirely different event**: phase 3's change to
which retrieval lists each eval arm is given.

```
Two things in the repo match "four points," and they're different events — here's what the record
actually says.

## The one that involves a split change

`evals/run.ts:173`, commit `ef82130` ("evals: give vec-only every vector list, so the gate is a
fair comparison"). The split that changed is **which retrieval lists each eval arm is given**:
…
```

It is well-sourced, it cites a real commit, and it is not the answer to the question. That is the
comparison the box asks for, and it is sharper than "it did not know":

| | turns | wall | tool calls | outcome |
|---|---|---|---|---|
| with the brief | **1** | **5.9 s** | **0** | correct, and carried its source line through |
| without it | 16 | 88 s | 15 | confidently wrong, about a different event |

The failure mode without potsherd is not silence. It is a plausible answer assembled from whatever
is nearest to hand — which is exactly the problem `01`'s "archive amnesia" describes, reproduced
here by accident.

## what this does NOT close

- The `--no-model` path was used, so this shows the **card/transcript-verbatim** brief, not a
  model-compressed one. A model-path brief is better prose and is not capturable here
  (`04-DECISIONS.md`, 22 aug: `claude -p` answers `Not logged in` under a relocated `HOME`).
- A **marketplace** install remains non-functional (`dist/` is gitignored, the npm package is
  unpublished). This used `--plugin-dir` against a built checkout.

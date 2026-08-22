# the upstream pull request

**Prepared, not submitted, and there is a specific reason to read before
submitting.**

potsherd's search engine is a fork of
[episodic-memory](https://github.com/obra/episodic-memory) by Jesse Vincent
(MIT). See [NOTICE](../../NOTICE) for the exact upstream revision and
[`docs/upstream/PORT-LOG.md`](../upstream/PORT-LOG.md) for what was taken, what
was adapted and what was refused.

One generic fix came out of the port and is written up as a pull request in
[`docs/upstream/PR-sidechain-flag.md`](../upstream/PR-sidechain-flag.md):
upstream hard-codes `AND e.is_sidechain = 0` into both of its search queries, so
no subagent transcript can ever be a result. On the reference machine that is
**197 sidechains of 227 transcripts, against 30 live sessions** — better than six
files of delegated work for every session a person remembers having. (This
sentence said `31` until phase 9's verifier caught it: `31` is the demo corpus's
figure, in the very document that boasts of having caught the same substitution
once already.)

## before anybody submits it

**`obra/episodic-memory#128` is already open and overlaps this.** Read it first.
Submitting a duplicate is a cost to a maintainer who did not ask for one, and
the overlap was found by looking rather than by being told.

## what was decided, 22 August 2026

**No pull request is opened.** `#128` is not merely adjacent to the prepared PR;
it fixes the same line, more thoroughly than we proposed — it de-ranks
sidechains rather than gating them behind a flag, covers both the vector and
text paths, and ships nine tests. A duplicate would cost a maintainer who did
not ask for one, and the overlap was found by looking rather than by being told.

What is submitted is **one comment on `#128`**, and nothing else. Its purpose is
to add a measurement the PR does not have — how large the excluded set is on a
real machine — and to say where the fork is. It asks for nothing.

`PR-sidechain-flag.md` stays as a record of what was prepared and why it was not
sent. It is the fallback only if `#128` is closed unmerged.

Verified before writing this, on 22 August 2026:

```
gh api repos/obra/episodic-memory/pulls/128 --jq '{state,merged,comments,user:.user.login}'
  state open · merged false · comments 0 · user d-walp · opened 2026-07-16
```

And the number in the comment, measured twice by different means on the frozen
snapshot `~/.potsherd/archive-manual-2026-08-21` rather than on the demo corpus
— the first draft of this file quoted the DEMO corpus's 228/197/31 while calling
it a real machine, which would have put a synthetic number in somebody else's
repository:

```
potsherd stats            claude  30 sessions · 197 subagents · 299 ghosts
find <archive>/projects -name '*.jsonl'                    -> 227
find <archive>/projects -path '*subagents*' -name '*.jsonl' -> 197
```

---

## the comment, verbatim

Posted with `gh pr comment 128 --repo obra/episodic-memory --body-file …`.
Three paragraphs. No ask, no link-drop, no pitch.

```markdown
Some field data for the excluded set, in case it is useful for the ranking
question here.

I forked episodic-memory's search into a local-first archive tool and ran it
over one developer machine's full Claude Code history. Of 227 transcripts
indexed, **197 were sidechains against 30 live sessions** — better than six
files of delegated work for every session the person remembered having. With
`AND e.is_sidechain = 0` in place, that is the majority of the corpus
unreachable, and it is the half that contains the actual implementation work:
the main thread is frequently a short "here is the plan, go" and a summary at
the end. Your de-ranking approach handles the case the flag I had prepared does
not, which is that the main thread should still win a tie without the substance
becoming invisible.

The fork is [potsherd](https://github.com/HulkInTherapy/potsherd) (MIT, credited
in NOTICE and in a port log). I had written up the same hard-coded filter as a
patch before finding this PR; that patch is now a document rather than a
submission, since this does it better. Nothing needed from you — just adding the
number.
```


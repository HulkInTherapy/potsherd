T4.3 `graft` — real-run evidence, 21 aug 2026.

Everything here was produced by `node packages/cli/bin/potsherd.js`, built from
`task/T4.3-graft`, against the **reference corpus**. Nothing is hand-written.

THE KEPT INDEX (re-examinable; the corpus every number below came from)

  /private/tmp/claude-501/-Users-zebra-randomness/169ced20-27ee-4647-9d2c-8fac9217f6bd/scratchpad/refindex-T4.3

  built from the frozen snapshot, which was never written to:
    potsherd index  --full   --claude-dir ~/.potsherd/archive-manual-2026-08-21 --potsherd-dir <above>
    potsherd rescue --no-settings --claude-dir ~/.potsherd/archive-manual-2026-08-21 --potsherd-dir <above>
  contents: 236 sessions (37 top-level + 199 subagents), 299 ghosts,
            1,406 exchanges, 1,406 vectors, 2,971 recovered prompts.
  cards were then written for 3ec2f5ca, a2cf864f and f7ac67c0 (one `card` run
  each). 4c9339e0 was attempted and its model call timed out at 360 s, so no
  brief here uses it.

THE BACKEND

  agent-sdk / claude-haiku-4-5 — the **subscription** path. It cannot count
  tokens: `/v1/messages/count_tokens` is an api-path endpoint and the harness
  transport does not expose one. So every token number below is
  **`est.` (chars / 3.6)** and `GraftResult.estimated` is `true` on all of
  them. There was no api key on this machine, so the counted path is
  implemented (`countTokens()` in `graft.ts`) but is **not** measured here.

THE RUNS

  file                       what                          tokens/budget  cites  wall
  run1-by-id.txt             graft 3ec2f5ca                262 / 1,200    3/3    1m 14s
  run2-by-query.txt          graft "[query withheld]       244 / 800      3/3    1m 58s
                               strategy" --budget 800
  run3-about-clip.txt        graft a2cf864f --about        419 / 700      5/5    2m 12s
                               "session loss measurement"
                               --budget 700 --clip
  run4-ghost.txt             graft f7ac67c0 (a GHOST)      397 / 1,200    10/10  2m 13s
  run5-no-model-json.txt     graft 3ec2f5ca --no-model     368 / 1,200    3/3    <1s
                               --json                                            (no call)
  run6-clip-no-tool.txt      --clip with no pbcopy,        368 / 1,200    3/3    <1s
                               xclip, wl-copy or xsel on
                               PATH — a note, exit 0
  run7-tight-budget-trim.txt graft f7ac67c0 --budget 150    137 / 150     13/13   1m 1s
                               the ceiling doing real work

  "cites" is **distinct** `id8@seq` pairs, resolved / emitted. A brief can carry
  more citation *tokens* than distinct pairs — run 3 cites `a2cf864f@20` on four
  separate bullets — and `GraftResult.citations[]` holds one entry per distinct
  pair, each with its own `resolves`.

  Every run: tokens <= budget, and every citation resolved. Every count is
  `est.`, and every one of these outputs says `est. (chars/3.6)` on its face.

  Run 7 is the ceiling doing its job on a budget that cannot hold the brief:
  the header plus the ghost's prompts-only banner plus the `source:` line is
  already ~137 tokens, so all 8 body lines were dropped and the brief says
  `_trimmed 8 lines to fit --budget 150._` on its face. It is under 150 and it
  is honest about why it is nearly empty. The banner is never a candidate for
  trimming — it is the thing that stops a ghost brief implying the assistant's
  reply is known.

  1,200 IS ENOUGH. Every brief here came in at 20-35% of the default budget
  with all its citations intact, so the trade-off the brief warned about
  ("if a real brief cannot be got under 1,200 without losing its citations,
  report the true number") did not arise. The largest brief written at the
  default budget was **run 4 at 397 tokens** — a 241-prompt ghost, 10 distinct
  citations, all resolving, 33% of 1,200. The default does not need raising.

THE RAW BRIEFS, exactly as they were written to ./.potsherd/graft-<id8>.md

  brief-run1-by-id.md       model path, by session id
  brief-run2-by-query.md    model path, target resolved by query
  brief-run3-about.md       model path, --about slice
  brief-run4-ghost.md       model path, ghost — carries the prompts-only banner
  brief-run5-card-only.md   NO MODEL CALL. the card verbatim, labelled
                            `**unsummarised.**`
  brief-run7-trimmed.md     the same ghost at --budget 150: everything the
                            ceiling could not fit, gone, and the brief says so

  generated-gitignore.txt   the `.potsherd/.gitignore` graft writes. it is only
                            written when the file is absent; an existing one is
                            never touched (tests/graft.test.ts).

OTHER

  help.txt              `potsherd graft --help`
  doctor-privacy.txt    `potsherd doctor --privacy` — the new write path
                        `.potsherd/graft-<id8>.md` now appears under `writes:`,
                        and `graft` appears under "only these verbs call a
                        model". Both were absent before this task.

TWO BUGS THIS EVIDENCE CAUGHT, both found by reading a real brief by eye

  1. A bracket-anchored citation pattern (`\[id8@seq\]`) never matched
     `[id8@24, id8@158]`, which a model writes about a third of the time. Those
     lines read as *uncited* and were therefore kept **unchecked** — the worst
     outcome available: a fabricated citation that got printed. The first
     run4-ghost said `citations 4/4` while the brief carried 13. The pattern
     now matches the `id8@seq` token itself, wherever it sits.
     Regression: tests/graft.test.ts, "checks a comma group…".

  2. The model returned the instruction's own placeholder, `[f7ac67c0@<seq>]`,
     on three bullets. `<seq>` is not a number, so nothing matched it and those
     bullets survived as uncited claims wearing something that looked like a
     citation. Placeholders are now stripped, and **any bullet left with no
     resolving citation is dropped** — `00-README.md`'s "cited or dropped",
     applied to the shape it was written for.
     Regression: tests/graft.test.ts, "drops a bullet that carries the
     unfilled template…".

  Both fixes landed before the runs above; run1, run3 and run4 were re-run
  after them, and the numbers in the table are the post-fix ones.

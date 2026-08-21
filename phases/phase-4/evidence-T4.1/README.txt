T4.1 — `potsherd ask` — EVIDENCE
================================

Two corpora, and the split between them is a ground rule rather than a
convenience (`plans/00`, ground rules): **committed artefacts use the synthetic
corpus, never the live one. A real-corpus run is cited by its kept
`--potsherd-dir` and its numbers; its transcript-derived prose stays out of the
repo. Re-examinable does not mean published.**

So this directory holds the synthetic runs in full and the real runs as
numbers. The real runs' own output sits beside the corpus it came from, which
is kept, so anybody can re-read or re-run it.


the two corpora
---------------

**synthetic — committed output lives here.**

    /Users/zebra/randomness/potsherd-T4.1-synthetic
      claude-home/    a copy of tests/fixtures/claude (committed, invented)
      models/         bge-small-en-v1.5, so the vector arm actually runs
      potsherd.db     4 claude sessions · 5 exchanges · 3 ghosts · 5 vectors

    Rebuild it with the recipe at the top of `run-synthetic.sh`. Two flags in
    that recipe are not optional: `--harness claude`, or `index` also reads the
    real ~/.codex, ~/.cursor and ~/.pi and the corpus stops being synthetic
    (117 exchanges instead of 5, most of them somebody's actual work); and
    `--no-settings`, because a fixture directory must never be handed to a verb
    that could write into it.

**reference — real, kept, cited, not published.**

    /Users/zebra/randomness/potsherd-T4.1-corpus
      potsherd.db     236 sessions · 1,406 exchanges · 299 ghosts ·
                      2,971 ghost prompts · 0 cards · schema v8 · 1,406 vectors
      models/         the same embedding model
      runs/           every real-corpus run's stdout, stderr and --json

    A byte copy of the phase-3 reference index (which lived in /tmp and would
    not have survived a reboot), plus the model directory.

    `0 cards` matters twice. The synthesizer's card-summaries input is empty on
    every run here, and T4.2's open-thread rule pass has nothing to compare —
    so `openThreads` is `[]` in every output. It would be anyway:
    `open-threads.ts` throws in this worktree and `ask` degrades silently by
    design (phase-4 ruling).


files
-----

  run-synthetic.sh          one `ask` against the synthetic corpus. Its output
                            is committable. Carries the build recipe.
  s1-pgbouncer.txt          a grounded answer, verbatim
  s2-decoy-strict.txt       a decoy under `--strict` — must print the refusal
                            and exit 2
  s3-adversarial.txt        a question the corpus cannot answer, without
                            `--strict`
  *.stderr.txt              the `--debug` filter audit, plus `exit=` and wall
                            time for each

  run.sh                    one `ask` against the reference corpus. Writes into
                            `$DIR/runs`, NOT into the repo.
  real-runs.txt             the reference-corpus runs as numbers only

  shortlist-probe.mjs       what the readers are handed, with no model in the
                            loop. The first question to ask of a run that came
                            back "0 answered".
  reader-probe.mjs          one reader, with the model's raw reply
  fanout-probe.mjs          six readers at concurrency, every raw reply
  topics-probe.mjs          where in a corpus an assistant-side answer exists
  patch-tests.py            the byte-exact-quote block added to tests/ask.test.ts
  patch-tests2.py           the refusal-reason block added to tests/ask.test.ts

The four probes print transcript content when run. Run them against the
synthetic corpus (`POTSHERD_ASK_DIR=…-synthetic`) if you intend to keep the
output.


four real bugs these runs found
-------------------------------

**1. The CLI silently overrode the library's shortlist.** `find` registers
`--vectors` with `.default('auto')`. Copying that onto `ask` meant commander
handed `'auto'` to `runAsk` on every invocation, overriding `ask.ts`'s own
default of vectors-ON — so **every real run shortlisted on bm25 alone**. On the
reference corpus that is not a small difference: for one question the bm25-only
top six were six sessions tied at 0.0098 (the AND pass had relaxed to OR and
everything scored the same) and the session that discussed the question was not
among them. Four consecutive runs came back `0 answered` and the readers looked
like the problem. Fixed by giving the flag no default and letting unset mean
"the library decides" — `vectorMode()` in `packages/cli/src/commands/ask.ts`.

**2. One long exchange ate the whole excerpt.** The first `excerptUnits` walked
`hit, its neighbours, next hit, its neighbours`, so a session whose hits were
seqs 2, 13 and 20 sent seq 2 alone: an 8,012-character opening prompt filled
the budget and the two matching exchanges never reached the reader. Hits are
now admitted before any neighbour and each unit takes a fair share of what is
left. Same session, same budget, after: seqs 1,2,3,10,11,12,18,19.

**3. A refusal printed the wrong reason.** A run that stopped at `--max-usd`
and a run whose citations did not survive leave `AskResult` in the same state —
a strict refusal blanks `sentences` and `evidence`, which is what a cost abort
leaves behind too. The renderer guessed, and told a user whose run had aborted
at ten cents that "fewer than 2 quotes survived the citation check": a false
statement about their archive, printed by the verb whose entire purpose is not
making those. `AskResult.refusal` now carries the reason instead of it being
inferred, and four tests hold each path.

**4. `searched` could exceed `matching`.** A recall block is a *conversation* —
`recall` clusters a parent with its subagents into one — and the shortlist reads
*sessions*, so counting blocks against sessions printed **"6 of 5 sessions
read"** on the synthetic corpus. Both numbers now come out of one expansion.

None of 1, 2 or 4 was visible from the rendered output. All three were found by
`shortlist-probe.mjs` and by reading the counts, which is why the probes are
kept rather than deleted.


the thing that is NOT a bug
---------------------------

A reader given a **ghost** answers `found: false` about anything that needed the
assistant's reply, and that is the honesty contract working. 299 of the 535
conversations in the reference corpus are ghosts — prompts only, the assistant
side deleted by Claude Code's sweep and not recoverable — and
`READER_GHOST_NOTE` tells the reader it may say what was asked and may not say
what was answered. `runs/fanout-probe.txt` is six such refusals over a question
whose answer only ever existed in deleted replies. A question that a surviving
session can answer (`runs/fanout-probe-ratelimit.txt`) gets `found: true` from
the session that holds it and `found: false` from the five ghosts around it.

Readers are, separately, **not deterministic**: one session answered
`found: false` on one run and `found: true` on the next from an identical
prompt. `READER_SYSTEM` was recalibrated because of it — the comment above the
constant records what was measured — but no prompt makes this go away, and none
of it is load-bearing. Every quote a reader produces is re-checked by
`filterAnswer` before anyone sees it.

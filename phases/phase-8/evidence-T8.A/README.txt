T8.A — the privacy guard: 8.1's probe and 8.3's fourteen pins.
Worker W1, branch p8/w1-guard, 22 aug 2026.

Everything here was produced by `python3 scripts/check-privacy.py` and by
`node packages/cli/bin/potsherd.js` (v1.0.0, built in this worktree) against the
synthetic demo corpus. Nothing is hand-written.


THE KEPT EVIDENCE DIRECTORY (re-examinable)
==============================================================================

  /tmp/w1-guard-evidence.yduKmU

  built with:
    node scripts/make-demo-corpus.mjs /tmp/w1-guard-evidence.yduKmU/.claude
    node packages/cli/bin/potsherd.js index --no-embed \
      --claude-dir   /tmp/w1-guard-evidence.yduKmU/.claude \
      --potsherd-dir /tmp/w1-guard-evidence.yduKmU/.potsherd

  contents: 237 transcripts parsed, 551 exchanges, 1,217 tool calls, 6 secrets
  masked, no vectors (--no-embed). Every raw capture is beside it as
  `*.raw.txt`, and `graft-cwd/.potsherd/` holds the briefs graft wrote.

  The demo corpus is DETERMINISTIC — a seeded mulberry32, no Math.random, no
  Date.now() in any content — so if that directory is gone, re-running the two
  commands above reproduces it byte for byte, which is a stronger guarantee
  than keeping a directory in /tmp.


PART A — 8.1's PROBE
==============================================================================

A new rule, `transcript-record`, in scripts/check-privacy.py.

WHAT IT MATCHES.  A line in `docs/**` that carries a transcript-record marker
(`"thinking":"`, `"role":"assistant"`, `"parentId":`, `<user_query>`) and whose
longest prose payload — the value of a `text`, `thinking`, `content`, `summary`
or `title` field, or the body of a `<user_query>` — runs past 100 characters,
UNLESS some line within 60 lines of it says the word "synthetic" or "invented"
alongside the word "record", "example" or "sample".

WHAT IT ACTUALLY ENFORCES.  Not "is this prose real?", which nothing here can
decide. It enforces a policy: **a transcript record sample must be declared
synthetic near where it appears.** The declaration is an assertion by whoever
committed the file, so it can be walked around by typing the word. That is a
real limit and it is written into the rule's comment. It is still worth having:
the six-phase leak in docs/upstream/PHASE-1-SCOUT.md was not somebody defeating
a check, it was nobody being asked the question. This asks it, in CI, every
time.

THE THRESHOLD, 100 CHARACTERS, AND WHY.  The `thinking` block that leaked ran to
**128 characters**. That is not an estimate: PHASE-1-SCOUT.md's own
"original `thinking` 128 chars" annotation records the length of what was
elided, and the annotation survived the purge that removed the text. So the
threshold has to sit under 128. 100 is about a sentence and a half of English —
long enough that the match is somebody's words rather than a field name, a
`<redacted>` marker or a two-word test prompt — with 28 characters of headroom
under the one real measurement available.

THE WINDOW, 60 LINES, AND WHY.  Measured, not chosen. In PHASE-1-SCOUT.md the
declaration leads its block and the block runs 45 lines past it. In
docs/formats/cursor.md the declaration is a TRAILING note after six samples, 39
lines below the first of them. 60 is the widest real gap plus half again. A
wider window is a WEAKER rule, so the number should shrink if it ever can.

WHY THE DECLARATION NEEDS TWO WORDS, NOT ONE.  Measured while writing the rule.
With the word alone, PHASE-1-SCOUT.md line 1492 — "injects a synthetic summary",
about a harness's own behaviour and about nothing in this repository — exempted
a record 50 lines below it. Requiring "record" / "example" / "sample" on the
same line kills that, and all three real declarations in docs/ keep passing.

PROVING IT WOULD HAVE CAUGHT THE REAL THING.  The pre-purge blob is gone —
`git log --all --oneline -- docs/upstream/PHASE-1-SCOUT.md` is one commit and
`git log --all -S "the user is asking about the project" --oneline` finds only
the sentence in docs/08-STATE-OF-PLAY.md that tells you to run that search. So
the leak was reconstructed two ways:

  1. AS A SELFTEST FIXTURE. Probe 12 is a pi `message` record — `type`, `id`,
     `parentId`, `timestamp`, `message.role:"assistant"`, a `content[]` with a
     `thinking` block — whose `thinking` string is **exactly 128 characters**,
     the recorded length of the real one. Only the length is real; the words are
     invented. The rule fires on it. Probe 13 is the cursor `<user_query>` half.

  2. AGAINST THE REAL FILE. Temporarily deleting the three synthetic
     declarations from docs/upstream/PHASE-1-SCOUT.md and docs/formats/cursor.md
     and re-running the sweep produced:

       docs/formats/cursor.md  [transcript-record]
           line 73:   payload 148 characters
           line 79:   payload 302 characters
           line 85:   payload 405 characters
       docs/upstream/PHASE-1-SCOUT.md  [transcript-record]
           line 1240: payload 263 characters
           line 1245: payload 302 characters
           line 1250: payload 341 characters
           line 1255: payload 128 characters
           line 1260: payload 243 characters
           line 1542: payload 173 characters

     Nine records, in the two files that held the leak, at the lines the leak
     was at — including one at exactly 128 characters. The files were restored
     immediately (`git status --short docs/` empty) and this demonstration is
     NOT committed.

FOUR CONTROLS, because a demonstration without a control proves nothing
(`plans/08` rule 10):

  probe 14  the same 128-character record with a declaration one line above it
            -> silent. This is the shape every sample in docs/ carries today.
  probe 15  the same record shape with a payload under the threshold
            -> silent.
  probe 16  the same undeclared record at a path outside docs/
            -> silent.
  and the demonstration above is its own control in reverse: the sweep is clean
  WITH the declarations and red WITHOUT them, so it is the declaration doing the
  work and not an accident of the file.

WHAT IT DOES NOT CATCH, written into the header as a STILL OPEN note:
  - a payload under 100 characters. The synthetic pi `thinking` in the file
    today is 99 characters and this rule cannot see it. Neither could it see a
    real one that short.
  - a record split across several lines by a formatter.
  - a declaration typed by somebody who did not mean it.


PART B — 8.3's FOURTEEN PINS
==============================================================================

Fourteen DEBT entries across nine files. Every one was confirmed by the guard
itself as "pinned at N, now clean" BEFORE its line was deleted; the intermediate
sweep that said so is what makes this a ratchet rather than a wish
(`plans/09 §13.5`). DEBT is now EMPTY.

RE-RUN AGAINST THE DEMO CORPUS — five files, five commands:

  phases/phase-3/evidence-T3.2-T3.3/help.txt
      node packages/cli/bin/potsherd.js find --help
      The two example lines that named a real project and a real corpus topic
      were removed from packages/cli/src/index.ts itself in phase 7, so the
      current help text is simply clean. The paste is longer than the one it
      replaces because the flag list has grown since phase 3.

  phases/phase-4/evidence-T4.3/doctor-privacy.txt
      node packages/cli/bin/potsherd.js doctor --privacy
      The original listed four real ~/.claude/projects/<slug> directories. The
      reproduction lists the demo corpus's four. Longer than the original
      because the bridges, setup's eight consent files, the .potsherd-bak
      copies and `ask` all landed in phases 4-6 and each added a path this
      screen has to name.

  phases/phase-4/evidence-T4.3/run1-by-id.txt
      graft 9c4d2f18 --budget 1200
      REAL MODEL CALL: agent-sdk (subscription), 27.2 s, 1 call, $0.019 est.
      383 of 1,200 tokens (est., chars/3.6), citations 8/8.
      The original's numbers, preserved in the file's header: 262 of 1,200,
      3/3, 1m 14s, $0.045.

  phases/phase-4/evidence-T4.3/run2-by-query.txt
      graft "the pooler decision" --budget 800
      REAL MODEL CALL: 18.6 s, 1 call, $0.016 est. 243 of 800, citations 5/5.
      The query resolves to a DIFFERENT session than run1's id does — b2181bfe,
      the demo corpus's open-thread session — which is the honest result of
      asking by words instead of by id and is left as it fell.
      The original's numbers: 244 of 800, 3/3, 1m 58s, $0.044.

  phases/phase-4/evidence-T4.3/run6-clip-no-tool.txt
      env PATH=<node's dir only> ... graft 9c4d2f18 --clip --no-model
      No model then, no model now: this one reproduces mechanism for mechanism.
      PATH is stripped to node's own directory so the clipboard probe finds
      nothing, because on this machine pbcopy exists and the branch under test
      is the one where it does not. 559 of 1,200, citations 8/8.
      The original's numbers: 368 of 1,200, 3/3, no call, <1s.

  All three graft runs print their FULL BRIEF, which the originals could not —
  the originals' bodies were a named third party's business plans. Being able
  to show the whole artefact is the point of having a demo corpus.

SUBSTITUTED, identity replaced and structure and finding kept — six files:

  phases/phase-0/HANDOFF.md          two project names on the `projects wiped`
                                     line of a pasted `audit` block. Every
                                     number on the block is untouched.
  phases/phase-1/WAVE.md             finding F15's worked example. The finding
                                     is that cursor's cwd is recoverable from
                                     tool inputs, and the example that carries
                                     it is the underscore-vs-hyphen slug case;
                                     both survive with synthetic names.
  phases/phase-2/VERIFICATION.md     the asked-vs-decided pair of prompt
                                     quotes. BOTH were substituted, not only
                                     the flagged one: the guard flagged the
                                     second because of a project name, but a
                                     prompt is family (1) prose either way.
                                     The shapes that decided the case — an
                                     imperative with a number in it, against a
                                     question ending "or something?" — are kept.
  phases/phase-4/HANDOFF.md          the row that RECORDED this debt. The names
                                     are withheld rather than restated; the
                                     finding and its phase number are kept.
  phases/phase-4/evidence-T4.1/patch-tests.py
                                     two `project:` fields in the test block
                                     this script inserts. They now read
                                     `Ledger`, which is what phase 7 actually
                                     substituted into tests/ask.test.ts, so the
                                     script's replace-and-insert still matches
                                     the file it patches.
  phases/phase-4/registration-T4.1.txt
                                     one `// input.project ... e.g. "<name>"`
                                     comment. It is an example of a shape — one
                                     path segment — and the demo corpus's own
                                     project name shows it just as well.

  Every one of the six carries a visible note saying it is a substitution.


PART C — THE ARGUMENT-PARSING FIX
==============================================================================

`main()` was `files = argv[1:] or tracked_files()`. An argument that was not
`--selftest` became a file list, dash or no dash. So:

  python3 scripts/check-privacy.py --list-pins

swept one nonexistent path, found nothing in it, concluded that all fourteen
pinned violations were "now clean -- delete the DEBT line", and exited 1. The
advice it gave with confidence was to break the ratchet.

Now: `parse_args()` rejects any unrecognised `-`-leading argument and any
argument beside `--selftest`, prints the usage block and exits 2. See
unknown-flag.txt beside this file.

THE SAME FAILURE ONE LAYER DOWN, found while writing the control for the above.
Given an explicit path list — `check-privacy.py somefile` — every DEBT entry for
a path NOT in that list is trivially "not found", so the run advised deleting
all of them. That is the identical wrong advice, reachable without any flag at
all. A partial sweep now judges only the paths it was given. Verified by adding
a temporary DEBT entry on `NOTICE` and running both ways:

    check-privacy.py LICENSE   -> "1 pinned known violations all at their
                                   expected counts", exit 0   (does not judge it)
    check-privacy.py NOTICE    -> "NOTICE [project-name] pinned at 1, now clean
                                   -- delete the DEBT line", exit 1  (does)

Four probes cover Part C: two positive (an unknown flag first, an unknown flag
after a real path), one control that an explicit path list is still accepted,
and one for the partial sweep. The last is worth keeping while DEBT is empty
because it is what catches the regression on the day somebody adds a pin back.


THE FILES IN THIS DIRECTORY
==============================================================================

  selftest.txt       python3 scripts/check-privacy.py --selftest
  sweep.txt          python3 scripts/check-privacy.py
  unknown-flag.txt   python3 scripts/check-privacy.py --list-pins   (exit 2)

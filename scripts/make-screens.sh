#!/usr/bin/env bash
#
# Regenerates every file in docs/screens/. Each one is verbatim stdout from the
# real binary — nothing here edits, aligns or prettifies a single character.
#
#   bash scripts/make-screens.sh
#
# What it runs against is the demo corpus (scripts/make-demo-corpus.mjs): a
# synthetic ~/.claude whose audit reproduces the reference machine's measured
# numbers with none of its project names, prompts or paths. HOME is pointed at
# a throwaway directory for the thirteen offline screens, so every path renders
# as `~/.claude` and `~/.potsherd` and potsherd never sees, reads or writes the
# real ones. The two model screens are the exception and say why at the point
# they make it ("the two model screens", below).
#
# The file numbers are the order the readme reads them in. The capture order is
# different, because every screen reports on the state the one before it left:
#
#   01, 06  audit, audit --sweep     before anything has been written
#   02      rescue                   the archive and the ghosts now exist
#   03      audit again              the sweep is off
#   07      index                    parses, redacts and indexes what rescue saved
#   08..12  ls, find, stats, show    all read the index, so all come after 07
#   04, 05  doctor                   captured after those, so that it reports a
#                                    populated index rather than "nothing
#                                    indexed yet — run potsherd index"
#   14, 15  ask, graft               last: both need cards, and a card would put
#                                    a model-written title on `ls` and `find`
#
# `audit` therefore has to be captured before `rescue` has run and again after,
# nothing that reads the index can be captured before `index` has built it, and
# nothing that reads a *card* may be captured before the screens that show what
# the archive looks like without one.
#
# Four things in the output are not fixed by the corpus and cannot be:
#   - the date in every heading is today's date, from the system clock;
#   - `doctor`'s heading carries this machine's node version;
#   - `index`, `find` and `stats` print how long they took, which is a
#     measurement of this machine and moves by a few milliseconds a run;
#   - the two model screens carry model-written text. 14-ask.txt's ANSWER, its
#     open-thread notes and how many threads survive differ every capture;
#     15-graft.txt is `--no-model` but prints the stored *card* verbatim, and a
#     model wrote that, so re-carding rewords it too. What must not change
#     about either is asserted at the bottom of this file rather than diffed.
# Everything else is byte-identical between runs. Regenerating on a different
# day therefore produces a one-character-per-heading diff, and that is correct:
# the date is real output, not a caption.
#
# Two of the fifteen need a model backend. Without one the script keeps their
# committed copies, says so, and still asserts them; POTSHERD_SCREENS_NO_MODEL=1
# forces that path. With one, the run cards 31 transcripts first and takes
# about seven minutes rather than one.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

screens="$repo/docs/screens"
demo="$repo/.tmp/demo-home"
bin="$repo/packages/cli/bin/potsherd.js"

if [ ! -f "$repo/packages/cli/dist/potsherd.js" ]; then
  echo "potsherd is not built. run:  pnpm build" >&2
  exit 1
fi

rm -rf "$demo"
node "$repo/scripts/make-demo-corpus.mjs" "$demo/.claude"

# Kept before HOME is moved, for the two screens that make a model call. See
# `shot_model` below: a harness's login lives under the *developer's* HOME, and
# the demo HOME has none, so `claude -p` there answers "Not logged in".
real_home="$HOME"

# The demo HOME is the whole point: `tildify` turns it into `~`, so the screens
# name no real directory. CLAUDE_CONFIG_DIR / POTSHERD_DIR would both override
# it, and either one set in the developer's shell would silently point this
# capture at their real corpus.
export HOME="$demo"
unset CLAUDE_CONFIG_DIR POTSHERD_DIR NO_COLOR FORCE_COLOR

# A stub `claude` inside the demo HOME, on the demo PATH.
#
# `doctor --privacy` now reports *which binary* would receive a model call
# (T2.7 D2), resolved from PATH. Without this the capture would print whatever
# absolute path this developer's `claude` happens to live at — a homebrew
# prefix, a version-manager shim, a temp directory — which is a fact about the
# machine that ran the script and not about potsherd. The stub makes that line
# what every other path in these screens already is: the synthetic corpus's
# own, rendered as `~/.claude/local/claude`. It is never executed: `--privacy`
# resolves the binary and makes no call.
mkdir -p "$demo/.claude/local"
printf '#!/bin/sh\nexit 0\n' > "$demo/.claude/local/claude"
chmod +x "$demo/.claude/local/claude"
export PATH="$demo/.claude/local:$PATH"

mkdir -p "$screens"

# NOTHING IS WRITTEN INTO docs/screens/ UNTIL THE WHOLE RUN HAS PASSED.
#
# This script used to `rm -f` every screen it was about to capture and then
# redirect the binary's stdout straight onto the committed path. Both halves
# were destructive: an interrupted run (^C, a dead backend six minutes into
# `card --all`, a laptop asleep) left the repository with committed artefacts
# deleted or half-written, recoverable only from git — and the readme links
# every one of them. That is open item 30.
#
# So every capture lands in a staging directory, the assertions run over
# *that*, and only a run that captured everything and passed every assertion
# moves the files into place. An interrupted run now leaves `docs/screens/`
# exactly as it found it.
#
# The two properties the old `rm -f` was there for are kept:
#   - a screen this run captures can never be yesterday's output, because
#     staging is emptied first and the move is per-file;
#   - a screen this run *skips* (the two model ones, on a machine with no
#     backend) is left exactly as committed — it is copied into staging so the
#     assertions still hold it, and copied back unchanged.
staging="$repo/.tmp/screens-new"
rm -rf "$staging"
mkdir -p "$staging"

offline_screens=(
  01-audit.txt 02-rescue.txt 03-audit-after.txt 04-doctor.txt
  05-doctor-privacy.txt 06-audit-sweep.txt 07-index.txt 08-ls.txt
  09-find.txt 10-stats.txt 11-show.txt 12-ls-ghosts.txt 13-find-redacted.txt
  16-before-after.txt
)
model_screens=(14-ask.txt 15-graft.txt 17-ls-cards.txt)

# --width 80 --no-color on every capture: the screens are a fixed 80-column
# artefact, not whatever terminal happened to run this.
shot() {
  local out="$1"; shift
  echo "  $out  <-  potsherd $*"
  node "$bin" "$@" --width 80 --no-color >"$staging/$out" 2>/dev/null
}

# `doctor --privacy` is the one screen whose output depends on the *working
# directory* and not only on HOME: `graft` writes its brief into the project
# you run it in, so the receipt lists `<cwd>/.potsherd/graft-<id8>.md`. Captured
# from the repo, that line renders this developer's checkout path — which is
# how the receipt below came to say `/Users/…/potsher…8dcc386/` the first time
# it was regenerated, and is the same class of fact about the capturing machine
# that the stub `claude` above exists to keep off these screens.
#
# So the doctor screens are captured from a project directory inside the demo
# HOME, where `tildify` renders it as `~/work/demo-project` like every other
# path here. `graft` is never run; only the path is printed.
project="$demo/work/demo-project"
mkdir -p "$project"

shot_in_project() {
  local out="$1"; shift
  echo "  $out  <-  potsherd $*  (from ~/work/demo-project)"
  ( cd "$project" && node "$bin" "$@" --width 80 --no-color ) \
    >"$staging/$out" 2>/dev/null
}

echo "capturing screens against $HOME/.claude"
shot 01-audit.txt        audit
shot 06-audit-sweep.txt  audit --sweep
shot 02-rescue.txt       rescue --yes
shot 03-audit-after.txt  audit

# --no-embed on the index screen is deliberate and is what the readme claims:
# it is the offline, no-model, seconds-not-minutes path, and it is the one a
# reproducible capture can use — the embedding model is a download, and a
# vectorised run would put a several-minute wall time on a committed screen.
shot 07-index.txt        index --full --no-embed

# Everything below reads the index 07 just built.
shot 08-ls.txt           ls

# `05` moment 3, and the one screen that is not a single command: the
# before/after people actually post. On the left is what Claude Code leaves you
# — a directory of uuids, one per session, with the deleted ones simply absent.
# On the right is the same archive after `rescue` and `index`. Both halves are
# real output; the left half is `ls`, the shell one.
#
# Written by a here-doc rather than by `shot` because it is two commands, and
# the frame around them is what makes the comparison legible. Everything inside
# the frame is verbatim.
echo "  16-before-after.txt  <-  ls ~/.claude/projects  vs  potsherd ls"
# Two things went wrong here the first two times, and both are worth the
# comment.
#
#   `ls -1 */*.jsonl` -- Claude Code's project directories start with a HYPHEN
#   (`-home-dev-auth-gateway`), so the expanded glob is parsed by `ls` as an
#   option and the whole thing fails with `unrecognized option`. The left half
#   of this screen read "0 files" while 228 sat on disk. `printf` with the
#   glob, and no `ls` at all.
#
#   `| head -6` -- under `set -o pipefail` a `head` that closes the pipe makes
#   the producer exit 141 and takes the script down. Sliced with `sed` over a
#   captured variable instead.
raw_ls=$( cd "$HOME/.claude/projects" && printf '%s\n' */*.jsonl 2>/dev/null )
raw_n=$( printf '%s\n' "$raw_ls" | grep -c . || true )
{
  printf '%s\n\n' 'what Claude Code leaves you  —  ls ~/.claude/projects/*'
  printf '%s\n' "$raw_ls" | sed -n '1,5p' | sed 's/^/  /'
  printf '  %s\n' "... $raw_n files, named by uuid, in $(cd "$HOME/.claude/projects" && printf '%s\n' */ | grep -c .) directories."
  printf '  %s\n' "the 299 sessions the sweep already took are not here at all."
  printf '\n%s\n\n' 'what potsherd leaves you  —  potsherd ls'
  node "$bin" ls --limit 5 --width 76 --no-color | sed 's/^/  /'
} > "$staging/16-before-after.txt"

shot 12-ls-ghosts.txt    ls --ghosts only
# "pgbouncer" is the thread scripts/make-demo-corpus.mjs plants through the
# corpus: one live session, three sessions the sweep deleted, and one subagent.
# It is the one query that shows the whole claim in a single screen — deleted
# prompts are searchable, subagents are searchable, and the tool says out loud
# which half of a deleted session it cannot give back.
shot 09-find.txt         find pgbouncer
shot 10-stats.txt        stats
# 9c4d2f18 is HERO.id in scripts/make-demo-corpus.mjs, which fixes it rather
# than drawing it from the PRNG precisely so that this line and the readme can
# name it. If this capture ever fails, that constant moved.
shot 11-show.txt         show 9c4d2f18

# The redaction screen, and it doubles as a demonstration of the mask format.
# A mask indexes as three fts5 tokens — `redacted`, the type, and the sha8 —
# so `find "redacted aws"` finds every exchange that leaked an aws key without
# anybody having to know what the key was. The demo corpus plants five
# credentials (scripts/make-demo-corpus.mjs); this is what the index kept of
# them. The assertions below fail the build if a raw one ever reaches a screen.
shot 13-find-redacted.txt find "redacted aws"

# Last of the offline screens, so that both doctor screens report on an index
# that exists.
shot_in_project 04-doctor.txt       doctor
shot_in_project 05-doctor-privacy.txt doctor --privacy

# ------------------------------------------------------- the two model screens
#
# `05`'s moments 4 and 5 — `ask` and `graft` — and the only two screens here
# that cannot be captured offline. Both need a **card**, and a card is a model
# call; `ask` additionally makes its reader and synthesizer calls at capture
# time.
#
# ## why these two run with the developer's own HOME
#
# Everything above runs with `HOME="$demo"` so that `tildify` renders every
# path as `~`. A model call cannot: on every subscription path the harness's
# login lives under the *developer's* HOME, and inside the demo one `claude -p`
# answers `Not logged in · Please run /login`. Setting CLAUDE_CONFIG_DIR at it
# does not help — the harness then wants its own `.claude.json` inside that
# directory, and `~/.claude` is a read-only input to this project.
#
# So `shot_model` puts HOME back and points potsherd at the demo corpus with
# `--potsherd-dir` / `--claude-dir` instead. potsherd still reads and writes
# nothing but the synthetic tree; only the harness sees the real home. That is
# safe for `ask` and for `card` because neither prints a path belonging to the
# machine it ran on: `card` prints its own `--potsherd-dir` and nothing else,
# and the only paths on an `ask` screen are the corpus's own `/home/dev/<name>`
# project directories, which is what `open-threads.ts` names a project by. The
# forbidden-string assertion below fails the build if a `/Users/` path ever
# reaches one anyway.
#
# It is *not* safe for `graft`, whose receipt names the file it wrote in the
# directory you ran it in. So graft stays under the demo HOME, from
# `~/work/demo-project` like the doctor screens, and takes `--no-model`: the
# stored card verbatim, labelled unsummarised, which is the path `graft --help`
# documents for a machine with no backend. A model-path brief would be the
# better screen and it cannot be had at the same time as a `~` in that line.
shot_model() {
  local out="$1"; shift
  echo "  $out  <-  potsherd $*  (model call, developer's HOME)"
  env HOME="$real_home" node "$bin" "$@" \
    --potsherd-dir "$demo/.potsherd" --claude-dir "$demo/.claude" \
    --width 80 --no-color >"$staging/$out" 2>/dev/null
}

# Is there a backend at all? `card --probe` makes one tiny call and stops, which
# is the cheapest honest answer — cheaper than discovering it inside a 6-minute
# card run. A machine with no backend keeps its committed copies of the two
# screens and is told so; it is not failed.
have_model=0
if [ "${POTSHERD_SCREENS_NO_MODEL:-}" = "1" ]; then
  echo "  POTSHERD_SCREENS_NO_MODEL=1 — keeping the committed ask and graft screens"
elif env HOME="$real_home" node "$bin" card --probe \
     --potsherd-dir "$demo/.potsherd" --claude-dir "$demo/.claude" >/dev/null 2>&1; then
  have_model=1
else
  echo "  no model backend — keeping the committed ask and graft screens." >&2
  echo "  set one up (claude, codex or ANTHROPIC_API_KEY) to regenerate them." >&2
fi

if [ "$have_model" = "1" ]; then
  # Every surviving session gets a card. The ghosts and the 197 subagents do
  # not: `--all` over the whole corpus is 217 calls and ~35 minutes, which is
  # not a thing a screenshot script may cost, while the 31 transcripts are 39
  # calls and about six and a half minutes.
  #
  # It is deliberately *not* narrowed to the projects the open thread turns out
  # to run between. Two reasons, and the second is the one that matters:
  #
  #   1. `open-threads.ts` strikes a token that appears in more than 30% of the
  #      cards as carrying no project-distinguishing information, and switches
  #      that filter off below twenty cards. A four-card index therefore does
  #      not behave like an archive; it behaves like a fixture.
  #   2. Choosing which projects may be project B, *after* seeing which one the
  #      catch came out of, would make the screen a picture of the script's
  #      choices rather than of the corpus. Everything carded, and whatever the
  #      rule pass and the model then agree on is what the screen shows —
  #      including nothing, which is what the assertions below are for.
  echo "  cards  <-  potsherd card --all  (31 transcripts, ~6m, ~39 calls)"
  env HOME="$real_home" node "$bin" card --all \
    --sidechains exclude --ghosts exclude --yes \
    --potsherd-dir "$demo/.potsherd" --claude-dir "$demo/.claude" \
    --width 80 --no-color >/dev/null 2>&1 || {
      echo "  card --all failed" >&2; exit 1; }

  # `05` moment 4 — ANSWER / EVIDENCE / OPEN THREADS. The question is the one
  # the corpus's whole planted thread is about, and the answer comes back
  # entirely out of `data-pipeline`; the open threads come from somewhere else
  # again. That is the shape `05` §4 describes and it is the reason this screen
  # is worth a capture: the connection is made from the cards, not from
  # anything the query matched.
  shot_model 14-ask.txt ask "what did we decide about prepared statements behind the pooler?" --no-vec

  # `05` moment 5, and it is captured like the doctor screens rather than like
  # the other model screen, because the receipt names the file graft wrote in
  # the directory it was run in.
  shot_in_project 15-graft.txt graft 9c4d2f18 --about pgbouncer --no-model

  # `ls` again, now that every surviving session has a card. It is the same
  # verb as 08 and a different screen: 08 shows what a harness gave you, and
  # this shows what a card gave you — the sessions Claude Code never titled are
  # no longer `potsherd-eval-data-47d9e281`. That difference is the whole point
  # of `card`, and until phase 7 it had no screenshot (open item 10).
  shot 17-ls-cards.txt     ls --limit 12
else
  # Not regenerated, so they are carried into staging exactly as committed —
  # asserted with the rest, and moved back byte-identical.
  for f in "${model_screens[@]}"; do
    [ -f "$screens/$f" ] && cp "$screens/$f" "$staging/$f"
  done
fi

# ---------------------------------------------------------------- assertions
#
# Characters, not bytes: the output carries `·`, `→`, `…` and `≤`, so `wc -c`
# would fail a line that is comfortably inside 80 columns. python3 counts code
# points, which is what a terminal draws.
#
# The readme is checked here too, and not only the screens. It is the same
# promise — no real project, no real client, no real path — and the readme is
# the file most likely to acquire one by hand.
#
# `doctor`'s heading and its `database` line are the two published *numbers*
# that describe the build rather than the corpus, and both had gone stale: the
# committed screen said `potsherd 0.1.0` and `schema v4 of v4` for the whole of
# phases 2, 3 and 4, against a shipped 0.4.0 and eight migrations. They are
# passed in here from the binary and the built store so the assertion below can
# say so out loud rather than leaving it to whoever next reads the screen.
version="$(node "$bin" --version)"
schema="$(node -e 'import(process.argv[1]).then((m) => console.log(m.latestSchemaVersion()))' \
  "$repo/packages/core/dist/db.js")"

python3 - "$staging" "$repo/README.md" "$version" "$schema" <<'PY'
import re, sys, pathlib

screens = pathlib.Path(sys.argv[1])
readme = pathlib.Path(sys.argv[2])
version = sys.argv[3].strip()
schema = sys.argv[4].strip()
expected = [
    '01-audit.txt', '02-rescue.txt', '03-audit-after.txt',
    '04-doctor.txt', '05-doctor-privacy.txt', '06-audit-sweep.txt',
    '07-index.txt', '08-ls.txt', '09-find.txt', '10-stats.txt',
    '11-show.txt', '12-ls-ghosts.txt', '13-find-redacted.txt',
    '14-ask.txt', '15-graft.txt', '16-before-after.txt', '17-ls-cards.txt',
]
# Names, paths and client work from the machine the numbers were measured on.
# None of them may ever reach a published screen or the readme.
forbidden = ['zebra', 'Meghavi', 'lexaiLMS', 'Veyu', 'Crimes', 'anilearn', '/Users/']

# The demo corpus plants five generated credentials so that `index` and `stats`
# can show the redactor working (scripts/make-demo-corpus.mjs, "planted
# secrets"). They are not real keys, but a screen that printed one would mean
# redaction had stopped running before the index — which is the one bug this
# repository must never ship a screenshot of. Shapes, not values, so this test
# keeps working when the PRNG draws different ones.
leaked = {
    'aws access key id': re.compile(r'\bAKIA[A-Z0-9]{16}\b'),
    'github token': re.compile(r'\bghp_[A-Za-z0-9]{36}\b'),
    'stripe key': re.compile(r'\bsk_live_[A-Za-z0-9]{24}\b'),
    'gcp api key': re.compile(r'\bAIza[0-9A-Za-z_-]{35}\b'),
    'password in a url': re.compile(r'://[^\s:@/]*:[^\s:@/‹]{8,}@'),
}

def columned(name, text):
    """
    The lines of a screen that are held to 80 columns.

    Every line of every screen, with one exception. `15-graft.txt` is the only
    screen with a body that is deliberately *not* an 80-column artefact:
    `render/graft.ts` prints the brief byte for byte as it wrote it to
    `./.potsherd/graft-<id8>.md`, because the thing you read and the thing you
    paste into an agent cannot be two different strings. The brief is markdown
    for a model to read, not a table for a terminal to draw, and its lines run
    long. So the rule applies to graft's *receipt* — everything above the `─`,
    rendered by the same `Card` as every other screen here — and stops there.
    """
    lines = text.splitlines()
    if name != '15-graft.txt':
        return lines
    end = next((i for i, l in enumerate(lines) if l.startswith('─')), len(lines))
    return lines[:end]


bad = []
targets = [(name, screens / name) for name in expected] + [('README.md', readme)]
for name, p in targets:
    if not p.exists():
        bad.append(f'{name}: missing')
        continue
    text = p.read_text(encoding='utf-8')
    if not text.strip():
        bad.append(f'{name}: empty')
    # The readme is markdown and wraps at 88; only the screens are an 80-column
    # artefact, and only their lines are counted. See `columned` for the one
    # screen whose body is exempt, and why.
    if p != readme:
        for i, line in enumerate(columned(name, text), 1):
            if len(line) > 80:
                bad.append(f'{name}:{i}: {len(line)} characters (max 80)\n    {line}')
    for word in forbidden:
        if word in text:
            bad.append(f'{name}: contains forbidden string {word!r}')
    for what, rx in leaked.items():
        m = rx.search(text)
        if m:
            bad.append(f'{name}: an unredacted {what} reached the page: {m.group(0)[:12]}…')

# `screens` here is the *staging* directory, so this asks whether the run
# captured exactly the set it meant to — not whether docs/screens/ has stale
# files in it. The shell removes those by name, out loud, after this passes.
stray = sorted(p.name for p in screens.glob('*.txt') if p.name not in expected)
if stray:
    bad.append('captured something not in the expected set: ' + ', '.join(stray))

# The find screen is the one that carries the whole claim. If it ever stops
# returning both halves, the readme is quoting a screenshot that no longer
# proves anything, and that must break the build rather than pass quietly.
#
# `· sidechain` used to be one of the four strings required here, and it had
# stopped appearing — not because the search screen lost its point, but
# because T3.6 gave it a better one. A subagent hit no longer gets a block of
# its own headed `claude · sidechain`; it is clustered under the session that
# spawned it and labelled `↳ subagent <id8>` on its own snippet line, so the
# reader sees the conversation rather than two disconnected rows. The screen
# still proves what it is here to prove — the assertion was pinned to the old
# rendering of the fact rather than to the fact — so it now asks for the
# marker T3.6 prints and for the footer's own count of them.
find = screens / '09-find.txt'
if find.exists():
    text = find.read_text(encoding='utf-8')
    for needed in [
        '· live',
        '· ghost',
        'assistant side not recoverable',
        '↳ subagent',
        'from subagents',
    ]:
        if needed not in text:
            bad.append(f'09-find.txt: no {needed!r} row — the search screen has lost its point')

# Same for the redaction screen: a mask has to be visible on it. If none is,
# either the corpus stopped planting credentials or — the case that matters —
# redaction stopped running before the index.
red = screens / '13-find-redacted.txt'
if red.exists() and '‹redacted:' not in red.read_text(encoding='utf-8'):
    bad.append('13-find-redacted.txt: no mask on it — nothing was redacted')

# A mask is one atom. Half of one on a published screen says potsherd cut a
# credential's own marker in two, which reads as corrupt output and invites the
# reader to think half of something leaked. `render/find.ts` and
# `search/snippet.ts` both hold the cut back to the mask's edge; this is the
# assertion that says so on the artefact rather than only in a unit test.
# `‹` and `›` are reserved for the two markers and cannot occur in base64, in a
# shell token or in a json key (redact.ts, redact-elide.ts), so an unbalanced
# one on a line is a cut mask and nothing else. Balance rather than a regex,
# because the cut can land on either side: `‹redacted…` from the tail and
# `…auth:201b2d22›` from the head are the same defect.
for name in expected + ['README.md']:
    p = readme if name == 'README.md' else screens / name
    if not p.exists():
        continue
    for i, line in enumerate(p.read_text(encoding='utf-8').splitlines(), 1):
        depth = 0
        for ch in line:
            if ch == '‹':
                depth += 1
            elif ch == '›':
                depth -= 1
                if depth < 0:
                    break
        if depth != 0:
            bad.append(f'{name}:{i}: a mask was cut in half\n    {line.strip()}')
            break

# The two numbers on `doctor` that describe the *build* and not the corpus.
# Both had gone stale — a published `potsherd 0.1.0 · schema v4 of v4` against
# a shipped 0.4.0 and eight migrations — and nothing said so, because every
# other number on that screen is fixed by the demo corpus and kept being right.
doctor = screens / '04-doctor.txt'
if doctor.exists():
    text = doctor.read_text(encoding='utf-8')
    head = text.splitlines()[0] if text.splitlines() else ''
    if f'potsherd {version}' not in head:
        bad.append(
            f'04-doctor.txt: heading says {head!r}, but the binary is {version}'
        )
    want_schema = f'schema v{schema} of v{schema}'
    if want_schema not in text:
        bad.append(
            f'04-doctor.txt: no {want_schema!r} line — '
            'the published schema version is not the one the store migrates to'
        )

# `05` moment 4, and the phase-4 definition of done: *the screenshot: one `ask`
# with an open-thread catch*. The open-thread line is the one people quote and
# it is also the one potsherd can most easily get wrong, so what is asserted
# here is not "there is a section" but the three things that make the section
# honest: the advisory label, the projects named in both directions, and a
# citation on the half of the claim that *can* be cited. A run where the model
# confirms nothing produces a screen with no OPEN THREADS block at all, and
# that must fail here rather than be committed as a screenshot of the feature.
ask = screens / '14-ask.txt'
if ask.exists():
    text = ask.read_text(encoding='utf-8')
    for needed in ['ANSWER', 'EVIDENCE', 'OPEN THREADS', 'possible open thread', 'not seen in']:
        if needed not in text:
            bad.append(f'14-ask.txt: no {needed!r} — this is not an ask screen with a catch')
    # `<project>/<id8>@<seq>` under the thread: the positive half of an open
    # thread is cited even though the negative half cannot be, and a reader who
    # cannot check the positive half is being asked to take it on faith.
    if not re.search(r'/[0-9a-f]{8}@\d', text):
        bad.append('14-ask.txt: the open thread cites no exchange a reader can open')

# `05` moment 5. The brief's last line is the contract — it is what tells the
# agent, and the person pasting it, where the thing came from.
graft = screens / '15-graft.txt'
if graft.exists():
    text = graft.read_text(encoding='utf-8')
    if 'source: claude ' not in text:
        bad.append("15-graft.txt: no `source:` line — a brief with no provenance")
    if 'graft-' not in text:
        bad.append('15-graft.txt: does not say where the brief was written')

if bad:
    print('\n'.join('  FAIL  ' + b for b in bad))
    sys.exit(1)

# The same measure the column rule uses, so the number printed on success is
# the number that would have failed: graft's brief is below the rule and is not
# an 80-column artefact.
widest = max(
    max((len(l) for l in columned(n, (screens / n).read_text(encoding='utf-8'))), default=0)
    for n in expected
)
print(f'  ok    {len(expected)} screens, widest line {widest} characters, '
      'no forbidden strings, no unredacted credentials, no cut masks')
PY

# Everything captured, everything asserted. Only now does docs/screens/ change.
for f in "${offline_screens[@]}" "${model_screens[@]}"; do
  [ -f "$staging/$f" ] && mv "$staging/$f" "$screens/$f"
done
# Names earlier drafts used, and anything else left behind: removed only now,
# and named out loud rather than swept.
for p in "$screens"/*.txt; do
  f="$(basename "$p")"
  case " ${offline_screens[*]} ${model_screens[*]} " in
    *" $f "*) ;;
    *) echo "  removing stale screen $f"; rm -f "$p" ;;
  esac
done
rm -rf "$staging"

echo "done. screens in docs/screens/"

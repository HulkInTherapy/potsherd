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
# a throwaway directory for the whole run, so every path renders as `~/.claude`
# and `~/.potsherd` and potsherd never sees, reads or writes the real ones.
#
# The file numbers are the order the readme reads them in. The capture order is
# different, because every screen reports on the state the one before it left:
#
#   01, 06  audit, audit --sweep     before anything has been written
#   02      rescue                   the archive and the ghosts now exist
#   03      audit again              the sweep is off
#   07      index                    parses, redacts and indexes what rescue saved
#   08..12  ls, find, stats, show    all read the index, so all come after 07
#   04, 05  doctor                   captured last on purpose, so that it reports
#                                    a populated index rather than "nothing
#                                    indexed yet — run potsherd index"
#
# `audit` therefore has to be captured before `rescue` has run and again after,
# and nothing that reads the index can be captured before `index` has built it.
#
# Three things in the output are not fixed by the corpus and cannot be:
#   - the date in every heading is today's date, from the system clock;
#   - `doctor`'s heading carries this machine's node version;
#   - `index`, `find` and `stats` print how long they took, which is a
#     measurement of this machine and moves by a few milliseconds a run.
# Everything else is byte-identical between runs. Regenerating on a different
# day therefore produces a one-character-per-heading diff, and that is correct:
# the date is real output, not a caption.
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
# Every screen this run is about to write, plus the names earlier drafts used.
# Removed up front so a stale screen can never survive a rename and go on being
# linked from the readme, and so a capture that fails leaves a missing file
# rather than yesterday's output.
rm -f "$screens"/*.txt \
      "$screens/00-audit-before-rescue.txt"

# --width 80 --no-color on every capture: the screens are a fixed 80-column
# artefact, not whatever terminal happened to run this.
shot() {
  local out="$1"; shift
  echo "  $out  <-  potsherd $*"
  node "$bin" "$@" --width 80 --no-color >"$screens/$out" 2>/dev/null
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

# Last, so that both doctor screens report on an index that exists.
shot 04-doctor.txt       doctor
shot 05-doctor-privacy.txt doctor --privacy

# ---------------------------------------------------------------- assertions
#
# Characters, not bytes: the output carries `·`, `→`, `…` and `≤`, so `wc -c`
# would fail a line that is comfortably inside 80 columns. python3 counts code
# points, which is what a terminal draws.
#
# The readme is checked here too, and not only the screens. It is the same
# promise — no real project, no real client, no real path — and the readme is
# the file most likely to acquire one by hand.
python3 - "$screens" "$repo/README.md" <<'PY'
import re, sys, pathlib

screens = pathlib.Path(sys.argv[1])
readme = pathlib.Path(sys.argv[2])
expected = [
    '01-audit.txt', '02-rescue.txt', '03-audit-after.txt',
    '04-doctor.txt', '05-doctor-privacy.txt', '06-audit-sweep.txt',
    '07-index.txt', '08-ls.txt', '09-find.txt', '10-stats.txt',
    '11-show.txt', '12-ls-ghosts.txt', '13-find-redacted.txt',
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
    # artefact, and only their lines are counted.
    if p != readme:
        for i, line in enumerate(text.splitlines(), 1):
            if len(line) > 80:
                bad.append(f'{name}:{i}: {len(line)} characters (max 80)\n    {line}')
    for word in forbidden:
        if word in text:
            bad.append(f'{name}: contains forbidden string {word!r}')
    for what, rx in leaked.items():
        m = rx.search(text)
        if m:
            bad.append(f'{name}: an unredacted {what} reached the page: {m.group(0)[:12]}…')

stray = sorted(p.name for p in screens.glob('*.txt') if p.name not in expected)
if stray:
    bad.append('unexpected screens left behind: ' + ', '.join(stray))

# The find screen is the one that carries the whole claim. If it ever stops
# returning both halves, the readme is quoting a screenshot that no longer
# proves anything, and that must break the build rather than pass quietly.
find = screens / '09-find.txt'
if find.exists():
    text = find.read_text(encoding='utf-8')
    for needed in ['· live', '· ghost', '· sidechain', 'assistant side not recoverable']:
        if needed not in text:
            bad.append(f'09-find.txt: no {needed!r} row — the search screen has lost its point')

# Same for the redaction screen: a mask has to be visible on it. If none is,
# either the corpus stopped planting credentials or — the case that matters —
# redaction stopped running before the index.
red = screens / '13-find-redacted.txt'
if red.exists() and '‹redacted:' not in red.read_text(encoding='utf-8'):
    bad.append('13-find-redacted.txt: no mask on it — nothing was redacted')

if bad:
    print('\n'.join('  FAIL  ' + b for b in bad))
    sys.exit(1)

widest = max(
    max((len(l) for l in (screens / n).read_text(encoding='utf-8').splitlines()), default=0)
    for n in expected
)
print(f'  ok    {len(expected)} screens, widest line {widest} characters, '
      'no forbidden strings, no unredacted credentials')
PY

echo "done. screens in docs/screens/"

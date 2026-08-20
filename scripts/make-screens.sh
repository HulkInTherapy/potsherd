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
# Order matters. The first three screens are the story in the order a new user
# meets it — the shock, the relief, and the same command again once the sweep
# is off — so `audit` has to be captured before `rescue` has run and again
# after. `doctor` comes last because it reports on a database that only exists
# once `rescue` has made one.
#
# Two things in the output are not fixed by the corpus and cannot be:
#   - the date in every heading is today's date, from the system clock;
#   - `doctor`'s heading carries this machine's node version.
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

mkdir -p "$screens"
# The files these six replace. Removed by name so a stale screen can never
# survive a rename and go on being linked from the readme.
rm -f "$screens/00-audit-before-rescue.txt" \
      "$screens/01-audit.txt" \
      "$screens/02-rescue.txt" \
      "$screens/03-doctor.txt" \
      "$screens/04-doctor-privacy.txt"

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
shot 04-doctor.txt       doctor
shot 05-doctor-privacy.txt doctor --privacy

# ---------------------------------------------------------------- assertions
#
# Characters, not bytes: the output carries `·`, `→`, `…` and `≤`, so `wc -c`
# would fail a line that is comfortably inside 80 columns. python3 counts code
# points, which is what a terminal draws.
python3 - "$screens" <<'PY'
import sys, pathlib

screens = pathlib.Path(sys.argv[1])
expected = [
    '01-audit.txt', '02-rescue.txt', '03-audit-after.txt',
    '04-doctor.txt', '05-doctor-privacy.txt', '06-audit-sweep.txt',
]
# Names, paths and client work from the machine the numbers were measured on.
# None of them may ever reach a published screen.
forbidden = ['zebra', 'Meghavi', 'lexaiLMS', 'Veyu', 'Crimes', 'anilearn', '/Users/']

bad = []
for name in expected:
    p = screens / name
    if not p.exists():
        bad.append(f'{name}: missing')
        continue
    text = p.read_text(encoding='utf-8')
    if not text.strip():
        bad.append(f'{name}: empty')
    for i, line in enumerate(text.splitlines(), 1):
        if len(line) > 80:
            bad.append(f'{name}:{i}: {len(line)} characters (max 80)\n    {line}')
    for word in forbidden:
        if word in text:
            bad.append(f'{name}: contains forbidden string {word!r}')

stray = sorted(p.name for p in screens.glob('*.txt') if p.name not in expected)
if stray:
    bad.append('unexpected screens left behind: ' + ', '.join(stray))

if bad:
    print('\n'.join('  FAIL  ' + b for b in bad))
    sys.exit(1)

widest = max(
    max((len(l) for l in (screens / n).read_text(encoding='utf-8').splitlines()), default=0)
    for n in expected
)
print(f'  ok    {len(expected)} screens, widest line {widest} characters, no forbidden strings')
PY

echo "done. screens in docs/screens/"

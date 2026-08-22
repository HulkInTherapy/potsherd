#!/usr/bin/env bash
#
# Records docs/demo.cast — `05`'s demo, and `plans/phases/phase-7`'s deliverable
# 3: audit → rescue → find → ask, at 80×24, under 60 seconds.
#
#   bash scripts/make-cast.sh          # record and render
#   POTSHERD_CAST_NO_MODEL=1 …         # skip the `ask` step (it needs a backend)
#
# ## why this is a script and not a person typing
#
# A cast is a published artefact, so the same rules apply to it as to
# docs/screens/: it runs against the **synthetic demo corpus** with `HOME`
# pointed at a throwaway directory, so every path renders as `~` and no real
# transcript, project name or home path can reach it. `scripts/make-screens.sh`
# has the long version of that reasoning; this is the same reasoning with a
# clock attached.
#
# It also means the recording is reproducible. A cast recorded by hand is a
# performance; this one is `audit`, `rescue`, `index`, `find` and `ask` with
# their real timings, and the only thing invented is the typing speed.
#
# ## the one thing that is faked, and why it is disclosed
#
# The keystrokes. `asciinema` records a terminal, so something has to type into
# it; `type()` below writes each character with a small delay so the cast reads
# like somebody at a keyboard rather than like six commands appearing at once.
# **The command output is not touched** — every millisecond of it is the real
# command running on this machine.
#
# `ask` is 30-40 s of model calls, which is most of a 60 s budget and most of
# what the cast has to show, so the wait is real too. There is nothing else in
# the cast to fill it with, and speeding it up would misrepresent the one number
# `ask`'s own screen prints.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

command -v asciinema >/dev/null || { echo "asciinema is not installed. brew install asciinema" >&2; exit 1; }

out="$repo/docs/demo.cast"
demo="$repo/.tmp/cast-home"
bin="$repo/packages/cli/bin/potsherd.js"

[ -f "$repo/packages/cli/dist/potsherd.js" ] || { echo "not built. run:  pnpm build" >&2; exit 1; }

rm -rf "$demo"
node "$repo/scripts/make-demo-corpus.mjs" "$demo/.claude" >/dev/null

# The inner script, run inside the recorded terminal. It is written to a file
# rather than passed as a string so that `asciinema rec -c` has one thing to
# run and the quoting stays legible.
cat > "$demo/session.sh" <<'INNER'
#!/usr/bin/env bash
set -u
P="node $BIN"
type() {
  printf '$ '
  local s="$1"
  for (( i=0; i<${#s}; i++ )); do printf '%s' "${s:i:1}"; sleep 0.035; done
  printf '\n'
  sleep 0.35
}
run() { type "$1"; eval "${1/#potsherd/$P}"; sleep 1.2; }

# `ask` is the one step that cannot run under the demo HOME.
#
# On every subscription path the harness's login lives under the DEVELOPER's
# home, and inside a throwaway one `claude -p` answers "Not logged in" — so the
# six readers all fail in three seconds and the screen says the archive had
# nothing in it. (The first recording of this cast did exactly that, and it is
# also what found the renderer bug where a dead backend and an empty archive
# printed the same sentence.)
#
# So this one line puts HOME back and points potsherd at the demo corpus with
# `--potsherd-dir` / `--claude-dir` instead — `scripts/make-screens.sh`'s
# `shot_model`, for the same reason and with the same guarantee: potsherd still
# reads and writes nothing but the synthetic tree, only the harness sees the
# real home, and the assertions at the end of this script fail the build if a
# `/Users/` path reaches the recording anyway.
askrun() {
  type "$1"
  env HOME="$REAL_HOME" node "$BIN" ask \
    "what did we decide about prepared statements behind the pooler?" --no-vec \
    --potsherd-dir "$DEMO/.potsherd" --claude-dir "$DEMO/.claude"
  sleep 1.2
}

sleep 0.8
run "potsherd audit"
run "potsherd rescue --yes"
run "potsherd index --full --no-embed"
run "potsherd find pgbouncer --limit 2"
if [ "${POTSHERD_CAST_NO_MODEL:-}" != "1" ]; then
  askrun "potsherd ask \"what did we decide about prepared statements behind the pooler?\""
fi
sleep 1.5
INNER
chmod +x "$demo/session.sh"

# `ask`'s open threads come out of the CARDS, so the corpus has to be carded
# before the recording starts — 31 transcripts, about six minutes, ~39 calls.
# Done outside the recording because six minutes of a progress bar is not the
# demo, and because a cast must be under 60 seconds.
if [ "${POTSHERD_CAST_NO_MODEL:-}" != "1" ]; then
  echo "  preparing: rescue, index and card --all (~6 min)"
  env HOME="$HOME" node "$bin" rescue --yes --quiet \
    --potsherd-dir "$demo/.potsherd" --claude-dir "$demo/.claude" >/dev/null
  env HOME="$HOME" node "$bin" index --full --no-embed \
    --potsherd-dir "$demo/.potsherd" --claude-dir "$demo/.claude" >/dev/null
  env HOME="$HOME" node "$bin" card --all --sidechains exclude --ghosts exclude --yes \
    --potsherd-dir "$demo/.potsherd" --claude-dir "$demo/.claude" >/dev/null 2>&1 \
    || { echo "  card --all failed — recording without a model" >&2; export POTSHERD_CAST_NO_MODEL=1; }
fi

echo "recording $out"
rm -f "$out"
env -u CLAUDE_CONFIG_DIR -u POTSHERD_DIR -u XDG_CONFIG_HOME -u NO_COLOR -u FORCE_COLOR \
  HOME="$demo" REAL_HOME="$HOME" DEMO="$demo" BIN="$bin" \
  COLUMNS=80 LINES=24 TERM=xterm-256color \
  POTSHERD_CAST_NO_MODEL="${POTSHERD_CAST_NO_MODEL:-}" \
  asciinema rec --overwrite --cols 80 --rows 24 \
    --command "bash $demo/session.sh" "$out"

# ---------------------------------------------------------------- assertions
python3 - "$out" <<'PY'
import json, pathlib, sys, re
cast = pathlib.Path(sys.argv[1])
lines = cast.read_text(encoding='utf-8').rstrip('\n').split('\n')
header = json.loads(lines[0])
events = [json.loads(l) for l in lines[1:]]
bad = []

# asciinema v2 and v3 disagree about both of these, and the script must not
# quietly assert nothing on the version it does not know. v2 puts `width` and
# `height` at the top level and absolute timestamps on every event; v3 nests the
# size under `term` and makes each timestamp a **delta**. Reading a v3 cast with
# the v2 rules gave `not 80x24: NonexNone` and a duration of 2.7 s — a guard
# that had stopped guarding while still printing a verdict.
term = header.get('term') or {}
cols = header.get('width', term.get('cols'))
rows = header.get('height', term.get('rows'))
if cols != 80 or rows != 24:
    bad.append(f'not 80x24: {cols}x{rows}')

version = header.get('version')
if version not in (2, 3):
    bad.append(f'unknown asciinema format version {version!r} — the checks below assume 2 or 3')
duration = (
    sum(e[0] for e in events) if version == 3 else (events[-1][0] if events else 0)
)
if duration > 60:
    bad.append(f'{duration:.1f}s — over the 60 s budget in plans/phases/phase-7')

text = ''.join(e[2] for e in events if e[1] == 'o')
# The same forbidden list docs/screens/ is held to. A cast is a published
# artefact and the machine that records it is the one with the real corpus on it.
for word in ['zebra', 'Meghavi', 'lexaiLMS', 'Veyu', 'Crimes', 'anilearn', '/Users/']:
    if word in text:
        bad.append(f'contains forbidden string {word!r}')
for what, rx in {
    'aws access key id': r'\bAKIA[A-Z0-9]{16}\b',
    'github token': r'\bghp_[A-Za-z0-9]{36}\b',
    'stripe key': r'\bsk_live_[A-Za-z0-9]{24}\b',
    'gcp api key': r'\bAIza[0-9A-Za-z_-]{35}\b',
}.items():
    if re.search(rx, text):
        bad.append(f'an unredacted {what} reached the cast')
# And that it shows what it is for.
for needed in ['sessions ever started', 'ghosts rebuilt', 'pgbouncer']:
    if needed not in text:
        bad.append(f'no {needed!r} — this is not the demo')

if bad:
    print('\n'.join('  FAIL  ' + b for b in bad))
    sys.exit(1)
print(f'  ok    {duration:.1f}s, 80x24, {len(events)} events, '
      f'{cast.stat().st_size // 1024} KB, no forbidden strings, no credentials')
PY

# ------------------------------------------------------------------- render
if command -v agg >/dev/null; then
  echo "rendering docs/demo.gif"
  agg --cols 80 --rows 24 --font-size 16 --speed 1 --theme monokai "$out" "$repo/docs/demo.gif"
  echo "  $(du -h "$repo/docs/demo.gif" | cut -f1)"
else
  echo "agg not installed — skipping the gif. brew install agg" >&2
fi

echo "done. cast in docs/demo.cast"

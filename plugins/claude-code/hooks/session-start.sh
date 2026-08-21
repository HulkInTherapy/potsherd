#!/bin/sh
# SessionStart: take a copy, and say out loud anything that stops one.
#
# WHY THIS IS A FILE AND NOT A LINE OF JSON. Until T5.9 this logic lived
# inline in `hooks.json` as a JSON-escaped one-liner, and it re-implemented
# `bin/potsherd`'s resolution -- in the opposite order, PATH first. On the
# reference machine PATH held the stale 0.1.0 phase-0 build while the 0.4.0
# checkout sat beside it, so every hook ran 0.1.0, `index` did not exist,
# stderr went to /dev/null and the hook exited 0. Nothing was ever indexed and
# nothing ever said so. The shim's own header had argued for the other order
# and given that exact reason; the hooks simply never called it.
#
# So: this file calls `bin/potsherd` and resolves nothing itself.
#
# THE SECOND HALF OF PHASE 0'S RULING -- "a hook that looks installed and
# silently does nothing is worse than no hook" -- needs more than the right
# order, because the right order can still land on a potsherd too old for the
# verb. Two things close that:
#
#   1. A CAPABILITY PROBE, here, before anything is promised. `index --help`
#      is the exact question ("does the potsherd this plugin resolves have the
#      verb SessionEnd is going to run?"), which a version-number comparison
#      only approximates -- and it keeps working across whatever the version
#      scheme does next. It costs one process -- a measured 128-146 ms on a
#      SessionStart with nothing else to do, against 28 ms before it existed,
#      almost all of it Node starting the bundle. If it fails, this hook says
#      so and does NOT go on to promise a copy it cannot take.
#   2. A FAILURE LOG. SessionEnd has no channel to the user at all, so it
#      writes what went wrong to `$POTSHERD_DIR/hook-failures.log` and this
#      hook reads it back at the start of the next session and clears it.
#
# Between them there is no path where a hook fails and no one is told.
set -u

ROOT="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"
SHIM="$ROOT/bin/potsherd"
PD="${POTSHERD_DIR:-$HOME/.potsherd}"
LOG="$PD/hook-failures.log"

MSG=''
say() { MSG="${MSG}${MSG:+  }$1"; }

# A hook may emit exactly one JSON object, so there is exactly one
# systemMessage and everything to be said is accumulated into it first.
emit() {
  [ -n "$MSG" ] || return 0
  ESC=$(printf '%s' "$MSG" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart"},"systemMessage":"%s"}\n' "$ESC"
}

# 1. Whatever the last SessionEnd could not do.
if [ -s "$LOG" ]; then
  say "potsherd: the last SessionEnd hook did not finish. $(tr '\n' ' ' < "$LOG" | cut -c1-500)"
  : > "$LOG" 2>/dev/null || true
fi

# 2. Is there a potsherd to run at all, and does it have the verbs?
if [ ! -f "$SHIM" ]; then
  say "potsherd: this plugin has no bin/potsherd, so NO copy was taken and no session will be indexed. The plugin is installed incomplete — reinstall it."
  emit
  exit 0
fi

PROBE=$(sh "$SHIM" index --help 2>&1); RC=$?
if [ "$RC" -eq 127 ]; then
  # The shim searched all three places and found none. Its own message names
  # them, so pass it through rather than writing a second, vaguer one.
  say "potsherd: no runnable potsherd, so NO copy was taken and no session will be indexed. $(printf '%s' "$PROBE" | tr '\n' ' ' | cut -c1-600)"
  emit
  exit 0
elif [ "$RC" -ne 0 ]; then
  VER=$(sh "$SHIM" --version 2>/dev/null | head -1)
  say "potsherd: the potsherd this plugin resolves (version ${VER:-unknown}) has no 'index' verb, so NO copy was taken and no session will be indexed — it is older than the plugin that is calling it. Point the plugin at a current build: pnpm install && pnpm build in the checkout, or remove the older potsherd from PATH."
  emit
  exit 0
fi

# 3. The one-off model download, announced before it happens rather than
#    after a silent stall. 32.4 MB is fmt.bytes(MODEL_DOWNLOAD_BYTES) — the
#    same string `potsherd index` prints. tests/hooks.test.ts pins them equal.
MD="$PD/models"
if [ -z "$(find "$MD/Xenova/bge-small-en-v1.5/onnx" -name '*.onnx' -size +1000k 2>/dev/null | head -1)" ]; then
  say "potsherd: no embedding model on this machine yet. When this session ends, the SessionEnd hook runs index --quiet, which downloads one: 32.4 MB, Xenova/bge-small-en-v1.5, into $MD. Once, detached, in the background. index --quiet prints nothing on its own, which is why you are told now instead. To skip it: disable the SessionEnd hook (see the plugin README) and index by hand with --no-embed."
fi

emit

# 4. The copy itself, detached. A failure here is logged, not swallowed: the
#    next SessionStart reads step 1 above.
(
  trap '' HUP
  ERR=$(sh "$SHIM" rescue --yes --quiet --no-settings 2>&1); RC=$?
  if [ "$RC" -ne 0 ]; then
    mkdir -p "$PD" 2>/dev/null
    printf '%s  rescue exited %s and no copy was taken: %s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RC" \
      "$(printf '%s' "$ERR" | tr '\n' ' ' | tr -d '\000-\037' | cut -c1-400)" >> "$LOG" 2>/dev/null || true
  fi
) </dev/null >/dev/null 2>&1 &

exit 0

#!/bin/sh
# SessionStart: say up front anything that will stop this thread being indexed.
#
# Codex's SessionStart takes no copy — Codex has no 30-day sweep to outrun —
# so this hook's whole job is to talk, and it is the only potsherd hook Codex
# runs that can. See `plugins/claude-code/hooks/session-start.sh` for the full
# account of why the resolution lives in `bin/potsherd` and not here; the short
# version is that until T5.9 this logic was a JSON one-liner in `hooks.json`
# that reached for PATH first, found the stale 0.1.0 phase-0 build, and let
# every SessionEnd fail into /dev/null and exit 0.
#
# Two things keep phase 0's ruling ("a hook that looks installed and silently
# does nothing is worse than no hook"):
#
#   1. A CAPABILITY PROBE — `index --help`, the exact verb SessionEnd will
#      run, asked of the exact potsherd `bin/potsherd` resolves. A version
#      comparison only approximates that question.
#   2. A FAILURE LOG — SessionEnd can show the user nothing at all, so it
#      writes to `$POTSHERD_DIR/hook-failures.log` and this hook reads it back
#      at the start of the next thread and clears it.
set -u

ROOT="${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"
SHIM="$ROOT/bin/potsherd"
PD="${POTSHERD_DIR:-$HOME/.potsherd}"
LOG="$PD/hook-failures.log"

MSG=''
say() { MSG="${MSG}${MSG:+  }$1"; }

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
  say "potsherd: this plugin has no bin/potsherd, so the SessionEnd hook will NOT index this thread. The plugin is installed incomplete — reinstall it."
  emit
  exit 0
fi

PROBE=$(sh "$SHIM" index --help 2>&1); RC=$?
if [ "$RC" -eq 127 ]; then
  say "potsherd: no runnable potsherd, so the SessionEnd hook will NOT index this thread. $(printf '%s' "$PROBE" | tr '\n' ' ' | cut -c1-600)"
  emit
  exit 0
elif [ "$RC" -ne 0 ]; then
  VER=$(sh "$SHIM" --version 2>/dev/null | head -1)
  say "potsherd: the potsherd this plugin resolves (version ${VER:-unknown}) has no 'index' verb, so the SessionEnd hook will NOT index this thread — it is older than the plugin that is calling it. Point the plugin at a current build: pnpm install && pnpm build in the checkout, or remove the older potsherd from PATH."
  emit
  exit 0
fi

# 3. There is no model download to announce, and there has not been since 8.6.
#    This block used to warn that SessionEnd would fetch 32.4 MB, and offered
#    "disable the SessionEnd hook" as the way out. Both halves were false the
#    moment `index` stopped embedding by default: session-end.sh runs
#    `index --session <id> --quiet` with no `--embed`, which downloads nothing,
#    so the warning described a non-event and its remedy was to switch off the
#    only thing the plugin does. Verified rather than reasoned about: running
#    that command against an empty ~/.potsherd creates no models directory.
#
#    Nothing replaces it. A hook that announces "we are not downloading
#    anything" every session is noise, and the place a reader actually needs
#    the upgrade is where it becomes relevant -- `potsherd index` ends with
#    `run potsherd index --embed for semantic search`, and `find`'s footer
#    says the same on a text-only index. The plugin README carries it too.

emit
exit 0

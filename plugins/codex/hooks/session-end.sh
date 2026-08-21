#!/bin/sh
# SessionEnd: index the session that just ended.
#
# Called as:  sh session-end.sh <session-id>
#
# SessionEnd has NO channel to the user — whatever it prints is discarded by
# the harness — so every failure here is appended to
# `$POTSHERD_DIR/hook-failures.log`, and `session-start.sh` reads that log out
# at the start of the next session and clears it. That is what keeps this hook
# inside phase 0's ruling: it can fail, but it cannot fail *silently*.
#
# It resolves nothing itself. `bin/potsherd` is the one place that decides
# which potsherd runs; see its header for the order and why it is that way.
set -u

ID="${1:-}"
[ -n "$ID" ] || exit 0

ROOT="${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"
SHIM="$ROOT/bin/potsherd"
PD="${POTSHERD_DIR:-$HOME/.potsherd}"
LOG="$PD/hook-failures.log"

note() {
  mkdir -p "$PD" 2>/dev/null
  printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$LOG" 2>/dev/null || true
}

flatten() { printf '%s' "$1" | tr '\n' ' ' | tr -d '\000-\037' | cut -c1-400; }

if [ ! -f "$SHIM" ]; then
  note "session $ID was NOT indexed: this plugin has no bin/potsherd to run."
  exit 0
fi

CFG="$PD/config.json"
if grep -q '"cardOnEnd"[[:space:]]*:[[:space:]]*true' "$CFG" 2>/dev/null; then CARD=1; else CARD=; fi

(
  trap '' HUP
  ERR=$(sh "$SHIM" index --session "$ID" --quiet 2>&1); RC=$?
  if [ "$RC" -ne 0 ]; then
    note "session $ID was NOT indexed — index exited $RC: $(flatten "$ERR")"
    exit 0
  fi
  [ -n "$CARD" ] || exit 0
  ERR=$(sh "$SHIM" card "$ID" --quiet --yes 2>&1); RC=$?
  [ "$RC" -eq 0 ] || note "session $ID was indexed but cardOnEnd made no card — card exited $RC: $(flatten "$ERR")"
) </dev/null >/dev/null 2>&1 &

exit 0

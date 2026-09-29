#!/bin/sh
# SessionStart, second entry: the opt-in "you have not been here in a while"
# brief. Gated on `"briefOnStart": true` in the potsherd config, so most
# sessions leave after the first line.
#
# Like the other two hooks this resolves nothing itself — `bin/potsherd` is
# the single place that decides which potsherd runs.
#
# This hook is allowed to be silent, and is the only one that is: it has
# nothing to report unless the project is stale, and `session-start.sh` has
# already said everything there is to say about a potsherd that will not run.
set -u

PD="${POTSHERD_DIR:-$HOME/.potsherd}"
grep -q '"briefOnStart"[[:space:]]*:[[:space:]]*true' "$PD/config.json" 2>/dev/null || exit 0

ROOT="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"
SHIM="$ROOT/bin/potsherd"
[ -f "$SHIM" ] || exit 0

PROJ=$(basename "${CLAUDE_PROJECT_DIR:-$PWD}")

# Nothing in the last 7 days? Then there is nothing stale to brief about.
sh "$SHIM" ls --project "$PROJ" --since 7d --limit 1 --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.exit(JSON.parse(s).total===0?0:1)}catch(e){process.exit(1)}})' \
  || exit 0

sh "$SHIM" ls --project "$PROJ" --limit 5 --no-color 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{s=s.trim().slice(0,4800);if(!s)process.exit(0);process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:"potsherd: this project has been untouched for 7+ days. Its most recent sessions:\n"+s+"\nUse the potsherd MCP tools to read any of them before assuming context is lost."}}))})'

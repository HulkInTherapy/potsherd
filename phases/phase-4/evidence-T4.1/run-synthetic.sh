#!/bin/sh
# One real `ask` against the SYNTHETIC corpus — the one whose output may be
# committed (`plans/00` ground rules: committed artefacts use the synthetic
# corpus, never the live one).
#
#   sh phases/phase-4/evidence-T4.1/run-synthetic.sh <name> "<question>" [flags...]
#
# The corpus is built once from the committed fixture, claude only:
#
#   rm -rf   /Users/zebra/randomness/potsherd-T4.1-synthetic
#   mkdir -p /Users/zebra/randomness/potsherd-T4.1-synthetic
#   cp -R tests/fixtures/claude /Users/zebra/randomness/potsherd-T4.1-synthetic/claude-home
#   cp -R <a potsherd models dir> /Users/zebra/randomness/potsherd-T4.1-synthetic/models
#   potsherd rescue --claude-dir …/claude-home --potsherd-dir …  --no-settings --quiet
#   potsherd index --harness claude --claude-dir …/claude-home --potsherd-dir …
#
# `--harness claude` is not optional. Without it `index` also reads the real
# ~/.codex, ~/.cursor and ~/.pi on this machine and the corpus stops being
# synthetic — 117 exchanges instead of 5, most of them somebody's actual work.
# `--no-settings` is likewise not optional: a fixture directory must never be
# handed to a verb that could write into it.
set -u
DIR=/Users/zebra/randomness/potsherd-T4.1-synthetic
OUT=phases/phase-4/evidence-T4.1
name=$1
shift
q=$1
shift
start=$(date +%s)
node packages/cli/bin/potsherd.js ask "$q" \
  --potsherd-dir "$DIR" --width 80 --debug "$@" \
  >"$OUT/$name.txt" 2>"$OUT/$name.stderr.txt"
code=$?
end=$(date +%s)
echo "--- exit=$code wall=$((end - start))s   cmd: potsherd ask \"$q\" $*" \
  >>"$OUT/$name.stderr.txt"
echo "exit=$code wall=$((end - start))s"

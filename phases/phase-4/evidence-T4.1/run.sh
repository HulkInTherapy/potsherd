#!/bin/sh
# One real `ask` against the KEPT reference corpus. Every number in the T4.1
# report came from a run of this script and the outputs are the .txt files
# beside it, so any of them can be re-examined or re-run.
#
#   sh phases/phase-4/evidence-T4.1/run.sh <name> "<question>" [extra flags...]
#
# stdout is the artifact — exactly what a user sees. stderr carries the
# `--debug` audit of what the citation filter dropped, which is deliberately
# NOT on stdout so that `--json` stays parseable.
#
# The corpus is kept, not temporary: /Users/zebra/randomness/potsherd-T4.1-corpus
# is a byte copy of the phase-3 reference index (236 sessions, 1,406 exchanges,
# 299 ghosts, 2,971 ghost prompts, 0 cards).
#
# **The outputs land beside the corpus, NOT in the repo.** `plans/00` ground
# rules: committed artefacts use the synthetic corpus, never the live one — a
# real-corpus run is cited by its kept --potsherd-dir and its numbers, and its
# transcript-derived prose stays out of a public repo. Re-examinable does not
# mean published. For the committed run, see `run-synthetic.sh`.
set -u
DIR=${POTSHERD_ASK_DIR:-/Users/zebra/randomness/potsherd-T4.1-corpus}
OUT=$DIR/runs
mkdir -p "$OUT"
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

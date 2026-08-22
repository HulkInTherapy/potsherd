T8.C / 8.4 — evidence
=====================

Every command below ran with the two reserved barrels patched by
`wire-up.py` (see `phases/phase-8/registration-W3.txt`), and both were
restored before the commit.

The evidence directories are kept and are NOT in the repo:

  /tmp/w3-frozen-SEEpoO   the frozen archive ~/.potsherd/archive-manual-2026-08-21
                          rescued + indexed into a mktemp -d, then
                          ls / find / ignore / stats / doctor
  /tmp/w3-live-JRyBWz     the same walk against the live ~/.claude (read-only),
                          which is the corpus the phase file's "9 of the top 15"
                          was measured on

Neither directory's contents are committed: they hold real project slugs,
session ids and titles.

Commands, in order, in each directory (FROZEN = the --claude-dir used):

  node packages/cli/bin/potsherd.js rescue --claude-dir FROZEN \
      --potsherd-dir $EV --no-settings --yes --width 80 --no-color
  node packages/cli/bin/potsherd.js index  --claude-dir FROZEN \
      --potsherd-dir $EV --no-embed --width 80 --no-color
  node packages/cli/bin/potsherd.js ls     --claude-dir FROZEN \
      --potsherd-dir $EV --limit 15 --width 80 --no-color     > ls-before.txt
  node packages/cli/bin/potsherd.js find pgbouncer --claude-dir FROZEN \
      --potsherd-dir $EV --limit 3 --width 80 --no-color      > find-before.txt
  node packages/cli/bin/potsherd.js ignore potsherd   --potsherd-dir $EV
  node packages/cli/bin/potsherd.js ignore randomness --potsherd-dir $EV
  ... ls / find again                                        > ls-after.txt, find-after.txt

`subagent-probe.txt` in the live directory is the discovery evidence for the
`agent-a3e88991…` row: the same transcript parsed with and without the fix.

  wall time: rescue 9.1 s, index 19.3 s on the frozen archive (327 MB, 236
  transcripts). Nothing here needed a subset.

`~/.claude`, `~/.codex`, `~/.cursor`, `~/.pi` and the frozen archive were read
and never written. `--potsherd-dir` was a fresh mktemp -d for every run; the
live `~/.potsherd/config.json` was never touched.

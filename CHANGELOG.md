# changelog

Every entry is a tag. Numbers in this file were produced by a command whose
output is in the matching `phases/phase-N/HANDOFF.md`.

## v1.0.0 — 22 August 2026 · polish and release

**A marketplace install now produces a working plugin.** It did not, for three
phases, and this was the largest single item outstanding. A Claude Code plugin
install is a git clone: nothing runs `pnpm install`, nothing runs a build, and
`better-sqlite3` is a native addon — so the CLI would not start, the MCP server
died before it spoke a word, and `session-archaeologist` was left holding
`Read`. Three changes close it:

- `plugins/claude-code/dist/{potsherd,mcp}.js` are **vendored** — built by
  `pnpm build`, copied by `pnpm vendor`, and rebuilt and byte-compared by CI on
  every push.
- `commander`, the MCP SDK and `zod` are **bundled** rather than external, and
  `better-sqlite3` is loaded on first `open()` rather than at import, so the
  bundles start beside an empty `node_modules`.
- **Node's own SQLite is the fallback.** FTS5, WAL, named parameters, `iterate`,
  and `sqlite-vec` all work under it. The whole suite runs green on it in CI,
  on the same matrix as the addon.

Measured on a fresh Debian container with nothing installed: clone, then `audit`
in **117 ms**, `rescue`, `index` over 228 transcripts in **333 ms**, `find`,
`show --html`, `audit --verify`, and an MCP server answering `tools/list` with
all six tools. Same on a clean `$HOME` on macOS, `audit` in **183 ms**.

**`npx potsherd audit` installed 764 MB. It installs 17 MB, in 1.6 s.** The two
model SDKs and the embedding runtime are optional peers now — npm installs
`optionalDependencies` regardless, which is what nobody had checked.

### new

- `potsherd show --html` — one self-contained page, no script, no network.
- `potsherd setup --status` answers for all seven clients without being told one.
- `potsherd` with no arguments is a six-verb tour, not a second `--help`.
- `docs/demo.cast` and `docs/demo.gif` — audit → rescue → index → find → ask.
- `docs/screens/16-before-after.txt` and `17-ls-cards.txt`.
- `docs/release/` — the checklists for the four things a person, not an agent,
  has to do.
- `FINAL-REPORT.md`.

### fixed

- **`ask` ran 25–33 rows against an 80×24 screen.** Held to a row budget now,
  with a stated order of what gives way, and evidence is never cut to save rows.
- **`ask` said "the readers found nothing" when no reader had run at all** — a
  claim about the user's archive from a verb that never read it.
- **`detectBackend` chose a backend from a signal, not from the module.** A
  `claude` binary on PATH with no agent SDK installed silently produced the
  above.
- **`potsherd ls | head -5` ended in a Node stack trace** (EPIPE).
- **The version was three releases stale**, and the test written to prevent that
  checked four surfaces that were all wrong together.
- `scripts/make-screens.sh` deleted committed screens before regenerating them.
- `find` was the only verb that stopped teaching the next one.
- `doctor --privacy` overflowed 60 columns on fourteen lines; `setup --status`
  on one; `guard --status` on one.
- `artifact-comment-monitor` had been reported as an undocumented format change
  on every `index` run since phase 1.
- `index`'s record-type table lost its columns on names over 30 characters.
- The MCP server decided it was the entry point by filename, then by a path
  comparison that was wrong through a symlink on macOS.

### removed

- The repository owner's own two project names, which had been the worked
  example in `find --help`, in two MCP tool descriptions, in four core
  docstrings and in two fixtures since phase 4.
  **34 pinned privacy violations → 14.**

### still open

Listed with reasons in `FINAL-REPORT.md`. The two that matter: the fusion gate
fails honestly (hybrid ties vector-only at 22/25 rather than beating it), and
the gemini, opencode and copilot adapters have never met real data and keep
their `unverified — documentation only` label.

## v0.7.0 — ecosystem
gemini/opencode/copilot adapters, claude-mem/agentmemory/notes bridges,
`export`, `stack`, `link --suggest`. 14 defects at verification.

## v0.6.0 — surfaces
The MCP server (six tools), the Claude Code plugin, the Codex plugin, `setup`,
`ask --readers-out/--readers-in`, `scripts/check-privacy.py`. 15 defects.

## v0.5.0 — ask and graft
`ask` with a code-level citation filter, `graft`, open threads, the ask evals.
18 defects.

## v0.4.0 — recall
Six-list hybrid fusion, 25-query evals, `find --explain`, composable filters.
7 defects.

## v0.3.0 — cards
`llm.ts`, verified per-session cards, ghost cards, `tag` `pin` `link`,
`ls --resume-menu`. 9 defects.

## v0.2.0 — foundation
The fork, four adapters, redaction, `index` `find` `ls` `show` `stats`.
8 defects.

## v0.1.0 — rescue
`audit` `rescue` `guard` `doctor`. 12 defects.

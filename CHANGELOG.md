# changelog

Every entry is a tag. Numbers in this file were produced by a command whose
output is in the matching `phases/phase-N/HANDOFF.md`.

## v1.1.0 — 22 August 2026 · hardening before the public moment

**Nothing on the first screen reads as broken any more, and the guard that
checks this repository stopped being a list of leaks it had already seen.**

### the archive looks like your work again

- **8.2 ghost titles.** 165 of 299 recovered sessions displayed as `/resume`,
  `/model`, `/mcp` or `clear` — the first line of `history.jsonl`, whatever it
  was. They take the first **substantive** prompt now, preferring the harness's
  own summary where one exists, and falling back to `<project>-<id8>` rather
  than to a slash command ever. **165 → 0.** Live sessions with no harness
  title get the same treatment: **204 gained a name**, and `ls --untitled`
  keeps meaning *"nothing a card would not improve"* because a new
  `title_source` column says who did the naming.
- A title is the **words**, not the furniture around them. A pasted screenshot
  arrives as `[Image: source: …/clipboard-….png]` on the line above what the
  person typed, and cutting a title from the raw string produced 60 characters
  of placeholder — and half a home directory — with the real words pushed off
  the end. **Derived titles carrying a home path: 19 → 0.**
- **8.4 `potsherd ignore <project>` / `unignore`.** On a machine that builds
  agents, 14 of the top 15 `ls` rows were potsherd's own worker sessions.
  Honoured by `ls`, `find`, `ask` and `stats`; `--all` overrides; **nothing is
  ignored by default and nothing is ever hidden silently** — each surface says
  how many rows the list cost it, and `doctor` prints the list. A subagent
  worktree rendered as a project slug was a discovery bug and is fixed there.

### the first run is offline again

- **8.6 `index` is text-only by default.** It used to fetch a 32 MB model and
  take **6m 44s**; the same index without embeddings is **9.6 s**. Semantic
  search is an explicit `potsherd index --embed`, offered in one line at the
  end of every run. A fresh-`$HOME` walk of `audit → rescue → index → ls →
  find`, with the network denied by sandbox and proven denied, completes in
  **14.5 s** on an idle machine against a 30 s target. Under load the same walk
  has measured 24.6–65.0 s; the target is met, and that is the honest range.
- `card --limit N` errored without `--all`. It is a scope now: `--limit` implies
  `--all`, newest first, and the dry-run's quote and the run agree.

### you can watch `ask` work, and it says what it costs

- **8.7** prints one line per reader as it returns —
  `reader 3/6 · 9c4d2f18 · found · 12.1s · $0.031 est.` — on **stderr**, so
  `--json` stays parseable.
- **`ask --cheap`**: k 3, a haiku-class synthesizer, and a session's card in
  place of a long slice. It was called `--fast` until it was measured against a
  control over ten runs each of five questions: **p50 50.5 s against the
  default's 45.0 s**, **$0.065 a run against $0.139**, answered 7/10 against
  10/10, citations 100% on both. About half the cost, and **not faster** — the
  unit of latency is a model call rather than a token. It ships under the name
  that is true, and its own screen says so on every run.

### the honesty surfaces

- **8.5 the fusion gate is closed.** `pnpm evals` had exited 1 since phase 3.
  Amended by the author of the original: hybrid must be **≥** both singles at
  recall@5 **and strictly above both** at recall@1. Weights untouched at the
  phase-3 stopping rule of 1.5. Measured: recall@5 12/22/22, recall@1 10/6/11 —
  **exit 0**, and `pnpm evals -- --vector-weight 0` still exits 1 on two
  independent clauses. The margin at recall@1 is **one**.
- **`audit` discloses what the deleted sessions contained.** No count changed:
  330 ever, 299 deleted, 2,971 prompts lost are all still exactly what they
  were. But `history.jsonl` records no field distinguishing a session from a
  resume-picker invocation, and **140 of the 299 recorded nothing but a slash
  command or a stub** — so a conditional row says so, and **the standalone
  python that `audit --verify` prints recomputes that number too**.
- **8.8** `stack` states its claim asymmetry in a legend above the table rather
  than only per row; the README's synthetic-corpus caption sits above the block
  it qualifies, where a screenshot crop cannot lose it.

### the privacy guard

- **14 pinned violations → 0.** The phase-0..4 evidence pastes were re-run
  against the synthetic demo corpus and replaced; the phase prose had its
  identity substituted and its findings kept, each with a visible note.
- **A new `transcript-record` rule** flags a JSON transcript sample in `docs/**`
  whose prose payload runs past 100 characters unless something nearby declares
  the samples synthetic — the shape of the leak that survived six phases while
  every automated check passed it.
- **The id rule is an inventory, not a blocklist.** It used to hold hashes of
  ids somebody had happened to notice, so an id nobody had noticed was
  invisible — and `phases/phase-2/VERIFICATION.md` had published ten real
  session ids since phase 2. Every id-shaped token in tracked text and tracked
  file names is now accounted for against a source this repository can
  **derive**, and the residue is pinned twice over: per file, and as a
  repository-wide ceiling that a substitution cannot walk around. **Real ids in
  the tree: 25 → 11**, and the remaining 29 unaccounted tokens are an open item
  in `phases/phase-8/HANDOFF.md`, not a clean bill.
- **25 probes** in `--selftest`, each with a control. An unknown flag is a usage
  error: `check-privacy.py --list-pins` used to be read as a file name and
  reported every pin as *"now clean — delete the DEBT line"*, exiting non-zero
  with confident, wrong advice.

### fixed after the verifier said so

Its verdict was *not releasable as described*, and the worst of its fifteen
findings was this: **`audit` printed 143 where its own standalone receipt
printed 140** on a real archive, on the row this release added. The whole point
of that receipt is that nobody has to trust potsherd to check potsherd. All
three implementations of the rule agree now, and a test builds the case the demo
corpus cannot produce — a deleted session whose only prompt is a pasted
screenshot — and requires the card, the snippet **run as printed**, and the
standalone script to return the same number.

Also from that report: both plugin `SessionStart` hooks announced a model
download that this release made impossible, and the test suite was **pinning the
false sentence**; `docs/demo.gif` was a recording of the previous release; the
documented verb count was `20` against a build of 21 with a list of 19; and the
published test count was wrong in five places. All fixed, and the counts are now
checked against commander's own registry rather than against prose.

**1,532 tests, 38 files**, green on macOS and Ubuntu × Node 22 and 24, and green
again under `POTSHERD_SQLITE=node`.

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

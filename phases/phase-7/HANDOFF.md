# phase 7 — polish and release · HANDOFF

**date:** 22 aug 2026 · **tests:** 1,434 green, 35 files · tag `v1.0.0`
**baseline at start:** `d54a703`, 1,354 tests, `VERSION` = `0.4.0` at tag `v0.7.0`.

The last phase. Run **solo by the orchestrator** rather than as a worker wave — the reason is in
`WAVE.md`, and what was kept from `07`/`09` is everything that finds defects: run the verb after
wiring it, run the guard after every change, read one real output by eye, and measure anything a
user will read.

---

## the three big items, all closed

### A — a marketplace install now produces a working plugin

Open since phase 5 and called "the install story for every user who is not us" in three handoffs.
A Claude Code plugin install is a **git clone**: nothing runs `pnpm install`, nothing runs a build,
there is no install hook, and `dist/` was gitignored. All six MCP tools vanished from the client and
`session-archaeologist` was left holding `Read`.

Three changes, none of which publishes anything:

1. **The bundles are vendored.** `plugins/claude-code/dist/{potsherd,mcp}.js`, 2.4 MB, built by
   `pnpm build` and copied by `pnpm vendor`. CI rebuilds them on every push and fails on a byte of
   drift. Only the Claude Code plugin carries them; `plugins/codex` looks next door, because 2.4 MB
   of identical bytes is not worth doubling for a plugin that has never been loaded by codex.
2. **The bundles need nothing beside them.** `commander`, the MCP SDK and `zod` were external for
   no reason but being dependencies, so the bundle could not *start* without a `node_modules`. The
   rule is now "external only if it cannot be bundled". `better-sqlite3` was a hoisted static
   import, so every verb died on a machine without the addon — including the four that never open a
   database. It is loaded on first `open()`.
3. **Node's own SQLite is the fallback.** Verified: FTS5 compiles, WAL works, named parameters
   bind, `iterate` exists, integers come back as numbers, and with `allowExtension` at construction
   **`sqlite-vec` loads into it too**. It has no `transaction()`, so the shim builds one from
   `SAVEPOINT`, nested the way better-sqlite3 nests because `ingest.ts` relies on it.

**The evidence that matters is not the eleven tests in `tests/sqlite-driver.test.ts`. It is that
all 1,434 tests pass under `POTSHERD_SQLITE=node`,** and CI runs the whole suite that way as a
second job. A fallback nobody exercises is the phantom-flag failure this project has recorded six
times.

**Measured end to end, fresh Debian container, nothing installed but git and node:** clone, then
`audit` in **117 ms**, `rescue`, `index` over 228 transcripts in **333 ms**, `ls`, `find`, `doctor`,
`show --html`, `audit --verify` recomputing its own numbers through the standalone python, and the
MCP server answering `tools/list` with all six tools. Clean `$HOME` on macOS: the same, `audit` in
**183 ms**.

Two real bugs surfaced by moving the bundle, both invisible until it moved:

- **`packages/mcp` decided it was the entry point by filename.** Vendored as `dist/mcp.js` it
  matched none of `/index.js`, `/potsherd-mcp.js`, `/index.ts` — so `main()` never ran and the
  process started, did nothing, and exited **0**. An MCP server that fails to start is invisible by
  design; this one had found a way to do it while looking like a clean exit.
- **The path comparison that replaced it was wrong on macOS only.** `import.meta.url` is resolved
  through symlinks by the ESM loader and `process.argv[1]` is not, so `/var/folders/…` compared
  unequal to `/private/var/folders/…` — which is every temp directory on that platform, and
  therefore every test of a marketplace install.

### B — the README

Stale by three phases: no cards, no `ask`, no `graft`, no plugin, no MCP server, no `setup`, no
`export`, and "phase 4 in progress" at the top. Seven new sections, every number in them traced to a
`HANDOFF.md`, plus two new screens (`16-before-after.txt`, `17-ls-cards.txt`) closing open item 10.

### C — `03 §9` and `03 §11`

Corrected against the shipped product and logged in `04-DECISIONS.md`. `§9` listed `mcp` as a CLI
verb and omitted four that exist; `§11` claimed potsherd writes *"only `~/.potsherd` and one key in
`~/.claude/settings.json`"* and *"no network"*, against eight consented config files with a
timestamped backup beside each, four flag-gated write paths, and three things that open a socket.
The **product** was correct throughout and CI guards the receipt; the **plan** was three phases
behind.

---

## measured this phase

| | measured | note |
|---|---|---|
| tarball install | **764 MB → 17 MB**, ~1.6 s | `optionalDependencies` are still installed by npm; they are optional peers now |
| fresh Ubuntu, clone only | audit **117 ms**, index 333 ms | node 22.23.2 and 24.19.0, no `node_modules` |
| fresh macOS `$HOME` | audit **183 ms** | every override cleared; `doctor --privacy` grepped, not trusted |
| `ask` block height | 25–33 rows → **24**, worst case over a 144-shape matrix | evidence is never cut to save rows |
| privacy pins | **34 → 14** | the guard confirmed each as "pinned at N, now clean" before its line was deleted |
| recall@5, 25 queries | bm25 11 · vectors 22 · hybrid 22 | the gate **fails**; see below |
| recall@1, same 25 | bm25 9 · vectors 6 · **hybrid 11** | fusion nearly doubles vectors-only |
| demo cast | 80×24, under the 60 s budget | `docs/demo.cast` + `docs/demo.gif` |

## the fusion gate, and why it is still red

`pnpm evals` exits 1. Hybrid ties vectors-only at 22/25 on recall@5 and the gate requires it to beat
both. **But at recall@1 — whether the answer is the first row, which is what a user experiences —
vectors-only is 6/25 and hybrid is 11/25.** The gate measures the metric that saturates and ignores
the one that does not.

Two ways to close it and neither is honest. Raising the vector weight to 2.0 reaches 23/25, which
the phase-3 sweep measured — and which is tuning a constant against the 25 queries that score it,
the overfitting phase 3 deliberately refused. Adding recall@1 to the gate is rewriting the gate
around the result. **So it stays red**, with the numbers written down.

## what phase 7 did not do, and why

- **Nothing was published, posted or submitted.** `npm publish`, the marketplace listing, the
  upstream PR and the registry checklists are all prepared in `docs/release/` with the exact
  commands, for a person. `obra/episodic-memory#128` is already open and overlaps our prepared PR;
  `docs/release/upstream.md` says to read it first.
- **The three documentation-only adapters keep their label.** No gemini, opencode or copilot
  transcripts exist on this machine. Running them against invented data would make the label false
  rather than true.
- **The codex plugin stays inferred.** `codex` is not installed here.

## for whoever picks this up

Everything open, with a reason for each, is in **`FINAL-REPORT.md` §6**. The four that are not
merely administrative: the fusion gate above, `ask`'s ~100 s p50 (structural — six readers plus a
synthesizer, at 60–160 s a call), the card estimator's one-directional ~2× optimism, and the three
adapters that have never met real data.

Three things this phase learned that are worth the next person's time:

1. **Do not edit a shell script while it is running.** Bash reads a script incrementally by byte
   offset, so an edit mid-run shifts the parser. A seven-minute screen capture ran `card --all
   failed` *after* it had already recorded the screens.
2. **`|` and `set -o pipefail` will kill a script that pipes into `head`.** SIGPIPE makes the
   producer exit 141 and the whole run stops. Twice, in two different scripts.
3. **Run the suite and commit in the same `&&` chain, not the same `;` chain.** A red suite did not
   stop a push, once, and CI caught it instead of me.

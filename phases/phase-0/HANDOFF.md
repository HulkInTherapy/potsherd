# phase 0 — rescue · HANDOFF

**tag:** `v0.1.0`  ·  **date:** 21 aug 2026  ·  **repo:** https://github.com/HulkInTherapy/potsherd

Ship `npx potsherd audit` and `potsherd rescue`. Zero model calls, zero keys, zero config.
Stop the bleeding and produce the first shareable number.

---

## what shipped

| deliverable | state | where |
|---|---|---|
| repo per `00-README.md` layout, MIT, `NOTICE`, CI (macos+ubuntu, node 22+24) | done | repo root, `.github/workflows/ci.yml` |
| `potsherd audit [--json] [--sweep] [--verify] [--claude-dir]` | done | `packages/cli/src/commands/audit.ts` |
| `potsherd rescue [--yes] [--dry-run] [--dest] [--no-settings] [--ghosts-only] [--quiet] [--json]` | done | `packages/cli/src/commands/rescue.ts` |
| `potsherd guard [--remove] [--status] [--yes] [--json]` | done | `packages/cli/src/commands/guard.ts` |
| `potsherd doctor [--privacy] [--json]` | done (added; `06` requires it) | `packages/cli/src/commands/doctor.ts` |
| readme incl. "what audit measures and how to verify it by hand" | done | `README.md` |
| `scripts/verify-audit.py` | done | stdlib only, no deps |
| screens | done | `docs/screens/*.txt` |

### the numbers, measured on the reference machine 21 aug 2026

`potsherd audit` and `scripts/verify-audit.py` agree exactly. Every figure below
is what `potsherd audit --json` prints (`bytes` formatted by `core/src/format.ts`
`bytes()`, wall time the median `timings.totalMs` over five runs) — nothing here
is typed in by hand:

```
sessions ever started   330      nov 2025 → aug 2026
still on disk            31
deleted                 299      91%
prompts lost          2,971
projects wiped           33      payments-api · crm-ingest · …
audit wall time        0.23 s    on 329 MB
```

**substitution, 2026-08-22:** the two project names on the `projects wiped` line are
**not** the ones this run printed — the real ones name a paying client's work and a
directory name is the private fact (`scripts/check-privacy.py`, family 3). Two names
off the synthetic demo corpus stand in their place. Every number on the block is the
measured one, unchanged; only the two words are substituted.

`potsherd rescue` on the frozen safety copy: **277 files, 327 MB archived, 299 ghosts rebuilt,
2,971 prompts recovered, 19 ghosts with recovered titles.** On the live corpus: 278 files
(one more: this session's own transcript), 329 MB.

---

## decisions taken in this phase (all logged in `plans/04-DECISIONS.md`)

1. **"sessions ever" is a union, not a history count.** History-only silently omits SDK sessions
   (`entrypoint: sdk-ts`), which never write to `history.jsonl`. The union of history +
   transcripts on disk + `sessions-index.json` gives 330 rather than 322. Deleted (299) and
   prompts lost (2,971) are unchanged; only the denominator grew, so the headline percentage
   moved 93% → 91%. `plans/01 §3` corrected.
2. **"projects wiped entirely" is 33, not 7.** The plan's list was its head. A directory counts
   as wiped only when every session in it is gone; a wiped subdirectory rolls up into its wiped
   parent; a subdirectory of a *surviving* project is not counted. Without the roll-up rules
   `$HOME` (itself a session cwd) swallowed every project on the machine.
3. **`rescue` also archives `history.jsonl`** — not in the phase file's task list. It is the only
   surviving record of the 299 already-deleted sessions; a rotation would make ghosts
   unrebuildable forever.
4. **Colour is hand-rolled ANSI** in `core/src/theme.ts`, not `chalk` (`03 §0`). One place
   resolves `NO_COLOR` / `--no-color` / `--ascii` / `--width`, and the design-system rules are
   unit-testable. Zero runtime dependencies added.
5. **One published npm package.** `potsherd` is an esbuild bundle of cli+core so `npx potsherd
   audit` resolves one thing; `@potsherd/core` stays private. Tarball 76 KB / 5 files.
6. **`better-sqlite3` ^12.11.1, not ^11.** v11 has no prebuild for Node 24 (`NODE_MODULE_VERSION
   137`), so it tried to compile from source — fatal for the `npx` promise. v12 ships Node 24
   prebuilds. FTS5 confirmed present (SQLite 3.53.2).
7. **`guard` pins an absolute path when potsherd is not on `PATH`**, and `guard --status` reports
   whether the installed command is actually runnable. A hook that looks installed and silently
   protects nothing is worse than no hook.

---

## corrections made to the plan folder

- `plans/01-PROBLEM-AND-EVIDENCE.md §3` — re-measured headline block; wiped-projects row.
- `plans/research/formats.md` §claude — **five record types were missing**:
  `permission-mode`, `file-history-snapshot`, `file-history-delta`, `system`, `frame-link`.
  **Phase 1 must know:** `file-history-snapshot` and `permission-mode` carry **no `timestamp`**,
  so a parser that assumes every record is timestamped will mis-order a session. Full counts are
  in that file.
- `plans/04-DECISIONS.md` decision log — seven entries.

---

## what the next phase must know

1. **The schema is already the whole of `03 §3`.** `packages/core/src/db.ts` creates `sessions`,
   `exchanges`, `tool_calls`, `ghosts`, `ghost_prompts`, `cards`, `tags`, `pins`, `links`,
   `rescue_log`, `archive_files`, `sync_state`, and all four FTS5 tables, in **three** versioned
   migrations. Phase 1 adds rows, not tables. `vec_exchanges` / `vec_cards` are the only things
   left (they need the `sqlite-vec` extension) — add them as **migration 4**.
2. **`archive_files` is the incremental-sync ledger.** `(source_path → sha256, bytes,
   source_mtime)`. The fast path is a stat comparison; only a size/mtime change triggers a hash.
   Phase 1's `index` should use `sessions.source_mtime` / `source_offset` the same way.
   **`sync_state` is the same idea one level up:** one row per pass, holding a fingerprint of
   everything that pass reads. `claude:ghosts` covers history.jsonl's size and mtime, the set of
   session ids on disk, and every sessions-index.json's size and mtime; when it matches, the ghost
   rebuild is skipped and its totals are read back out of `ghosts` / `ghost_prompts` so the receipt
   is unchanged. Phase 1's `index` should add its own key rather than re-parsing every transcript
   at every startup. Also note `scanClaudeDisk(dir, { content: false })`: rescue needs session ids,
   which are filenames, so it opens no transcripts at all. Those two changes took the guard hook
   from a 0.33 s median to 0.11 s on the 345 MB reference corpus.
3. **The archive is the fallback source.** When `~/.claude` loses a file, `~/.potsherd/archive/
   claude/<slug>/…` still has it, byte-exact. Phase 1's adapters should read the archive when the
   source path is gone and mark those sessions `status: archived`.
4. **Redaction has NOT been written.** `exchanges.redacted` and `ghost_prompts.redacted` columns
   exist and are always 0 today. T1.4 fills them. The archive copy must stay unredacted.
5. **The terminal design system is code, not a convention.** Build every new verb's output with
   `Card` / `table` from `core/src/render.ts` and `Theme` from `core/src/theme.ts`. `Card.row()`
   already enforces the grid, the widths and the colour budget; `format.ts` has `num` / `date` /
   `bytes` / `money` / `duration` / `elide` / `elideMiddle` / `clip` / `joinFit`. Use `clip` for
   text potsherd wrote (it preserves the deliberate double spaces) and `elide` for text that came
   out of a transcript.
6. **Every verb's last line is the next verb, and it must adapt.** `audit` reads
   `~/.potsherd/potsherd.db` read-only (via `readArchiveState`) purely so it never tells you to
   run something you have already run. Keep that property.
7. **Tests are sandboxed by `tests/setup.ts`**, which points `POTSHERD_DIR` and
   `CLAUDE_CONFIG_DIR` at a throwaway directory. No test can reach the developer's real state.
   Keep using `tests/helpers.ts` (`copyFixtureClaude`, `tempDir`, `FIXTURE_CLAUDE`, `IDS`).
8. **The fixture is generated, not pasted.** `node tests/fixtures/make-fixtures.mjs` regenerates
   `tests/fixtures/claude/`; CI fails if the output differs from what is committed. Extend the
   generator, not the fixture. It already covers a titled session with 5 title rewrites, an SDK
   session with no title, **two** sidechains (one under `<session>/subagents/`, one under
   `<project>/subagents/` — both layouts exist and neither may ever be counted as a session), a
   `sessions-index.json`, a memory note, three ghosts, a malformed history line and a sessionless
   history line.
9. **`potsherd` is installed globally on this machine** from the tarball, and the SessionStart
   guard hook is live in `~/.claude/settings.json`. Re-run
   `cd packages/cli && npm pack && npm install -g ./potsherd-0.1.0.tgz` after changing the CLI, or
   the hook will keep running the old build.

---

## how to verify this phase

```bash
cd /Users/zebra/randomness/potsherd
pnpm install && pnpm build && pnpm test && pnpm typecheck

potsherd audit
potsherd audit --json | python3 -c "import json,sys;d=json.load(sys.stdin);print({k:d[k] for k in ('sessionsEver','onDisk','deleted','promptsLost')})"
python3 scripts/verify-audit.py                 # must print the same four numbers

# safe against a frozen copy, never the live dirs
TMP=$(mktemp -d)
potsherd rescue --yes --no-settings --claude-dir ~/.potsherd/archive-manual-2026-08-21 --potsherd-dir $TMP --json | python3 -c "import json,sys;d=json.load(sys.stdin);print('copied',d['filesCopied'])"
potsherd rescue --yes --no-settings --claude-dir ~/.potsherd/archive-manual-2026-08-21 --potsherd-dir $TMP --json | python3 -c "import json,sys;d=json.load(sys.stdin);print('copied',d['filesCopied'])"   # must be 0
rm -rf $TMP

sqlite3 ~/.potsherd/potsherd.db 'select count(*) from ghosts; select count(*) from ghost_prompts;'
time potsherd audit > /dev/null
potsherd doctor && potsherd doctor --privacy
```

**Verifier's report:** see `phases/phase-0/VERIFICATION.md` (written by a worker that did not
author this phase, per `06`'s review rule).

---

## open items carried into later phases

| item | why it is open | picked up by |
|---|---|---|
| literal `npx potsherd audit` from the npm registry | the package is not published, so the registry path cannot be exercised. Verified instead by `npm pack` + `npm i -g` inside `node:22-bookworm-slim`: audit / rescue ×2 / doctor all exit 0 and the native `better-sqlite3` prebuild loads | phase 7 (release) |
| fresh macOS user account | not created; a clean `$HOME` was simulated instead | phase 7 |
| `vec_exchanges` / `vec_cards` tables | need the `sqlite-vec` extension, which phase 0 does not depend on | phase 1 (migration 3) |
| redaction | out of scope for phase 0 by the phase file | phase 1 T1.4 |
| codex / cursor / pi / gemini / opencode / copilot | `doctor` lists them as "phase 1" / "phase 6" with the path it would look in | phases 1 and 6 |
| `ls` | `rescue`'s next-verb line points at `guard`, not `ls`, because `ls` does not exist yet | phase 2 |
| real PNG screenshots | `docs/screens/` holds exact terminal text captures at 80 cols; PNGs and the asciinema cast are phase 7's deliverable | phase 7 |

## the screens, and why they are not from the live machine

`docs/screens/*.txt` and every code block in the README are **real, verbatim output** of the real
binary — but run against a **synthetic demo corpus**, not the developer's `~/.claude`. The corpus
is built by `scripts/make-demo-corpus.mjs` to reproduce the reference machine's measured counts
exactly (330 / 31 / 299 / 2,971 / 33 wiped / 197 sidechains / 21 titled / 3 sdk / 10 doomed, 3
within a day) with neutral project names and `/home/dev` paths.

The reason is in the ground rules: the real corpus is client work, and the repository is public.
The numbers are the product; the client names are not ours to publish. `scripts/make-screens.sh`
regenerates all six screens and **fails the build** if any of them contains a real project name,
a `/Users/` path, or a line over 80 characters. Three consecutive runs are byte-identical.

Byte totals are the one figure the demo corpus cannot reproduce — it holds about a megabyte, not
329 MB — so the README attributes every size and timing to the reference machine explicitly and
cites this file for them.

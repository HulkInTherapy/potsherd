# potsherd

Claude Code deletes your session transcripts after 30 days. It does not tell you.

```
npx potsherd audit
```

```
potsherd audit · ~/.claude · 21 aug 2026

  sessions ever started        330   nov 2025 → aug 2026
  still on disk                 31
  deleted by 30-day sweep      299   91%
  prompts lost               2,971
  projects wiped entirely       33   payments-api · crm-ingest · agent-runner

  next sweep will delete        10   sessions in ≤ 7 days   (3 within one day)
  cleanupPeriodDays          unset   → 30 (default)

  the prompts from all 299 are recoverable from history.jsonl.
  run  potsherd rescue  to archive what is left and rebuild the ghosts.
```

Real output from `potsherd audit`, run against a
[demo corpus](scripts/make-demo-corpus.mjs) that reproduces, number for number,
what was measured on one real machine on 21 August 2026.

Those measurements are that machine's; the project names, prompts and paths
behind them are its owner's client work and are not this repository's to
publish, so every code block below and every file in [`docs/screens/`](docs/screens)
is generated from a synthetic corpus built to the same counts. Yours will be
different from both.

`audit` reads; it writes nothing, needs no key, makes no network request, and
took **0.23 s** on the reference machine's **329 MB** of transcripts — it reads
the first and last 64 KB of each file and nothing in between. Both figures came
straight out of `potsherd audit --json` on that machine (`.bytes`, formatted the
way the card formats bytes, and the median `.timings.totalMs` over five runs) and
are recorded in [phases/phase-0/HANDOFF.md](phases/phase-0/HANDOFF.md); no number
in this readme is typed in by hand. The demo corpus reproduces the counts, not
the size — it holds about a megabyte — so wherever a block below prints bytes,
the bytes are the demo corpus's own and not the reference machine's.

> **Status: v0.1.0, phase 0 of 8.** Today potsherd rescues. Search, cards, `ask`
> and `graft` land in the phases that follow — see [the roadmap](#roadmap).

---

## The problem

`~/.claude/settings.json` has a key called `cleanupPeriodDays`. It defaults to
30. At every startup Claude Code deletes transcripts whose **mtime** is older
than that. No warning, no recycle bin, not surfaced in `/config`.

The transcripts are gone. But one file survives everything:
`~/.claude/history.jsonl` holds every prompt you have ever typed, with its
timestamp, project and session id — including the prompts from every deleted
session. potsherd calls those reconstructed sessions **ghosts**.

## The two commands

### `potsherd audit`

Counts what you have, what you have lost, and what goes next.

```bash
npx potsherd audit
npx potsherd audit --sweep          # name the sessions the next sweep takes
npx potsherd audit --json | jq .deleted
npx potsherd audit --verify         # the python that checks these numbers
```

### `potsherd rescue`

Copies everything that survives into `~/.potsherd/archive`, rebuilds the ghosts,
and then — only then — asks whether to turn the sweep off.

```bash
potsherd rescue
```

```
potsherd rescue · ~/.potsherd/archive/claude · 21 aug 2026

  files copied                 278   1.1 MB
  already archived               0   1.1 MB total on disk
  sessions archived             31   31 in the archive · 197 sidechains · 45 me…
  ghosts rebuilt               299
  prompts recovered          2,971   from 299 ghosts · 19 with titles

  the sweep                    off   cleanupPeriodDays unset → 3650

  archive: ~/.potsherd/archive/claude
  run  potsherd guard  to take a copy at every startup, automatically.
```

The counts are the reference machine's; the two byte figures are the demo
corpus's. The same run there copied **277 files and 327 MB**
([phases/phase-0/HANDOFF.md](phases/phase-0/HANDOFF.md)).

It is idempotent: run it twice and the second run copies nothing. It never
changes `~/.claude` unless you answer `y` to a prompt that shows you the diff
first, and it backs the file up before writing.

```bash
potsherd rescue --dry-run                        # report; write nothing anywhere
potsherd rescue --yes                            # accept the settings change
potsherd rescue --no-settings                    # never touch settings.json
potsherd rescue --yes --quiet --no-settings      # what the guard hook runs
```

### `potsherd guard`

Installs one `SessionStart` hook so a copy is taken at every Claude Code
startup, before any future sweep can run. It is appended beside your existing
hooks, never in place of them.

```bash
potsherd guard            # shows the diff, asks, backs up
potsherd guard --status
potsherd guard --remove
```

## What audit measures, and how to check it by hand

Four numbers, four definitions:

| number | definition |
|---|---|
| **sessions ever started** | distinct session ids seen in **any** of `history.jsonl`, the transcripts on disk, or a `sessions-index.json` |
| **still on disk** | of those, the ones with a transcript file today |
| **deleted** | ever − on disk |
| **prompts lost** | lines in `history.jsonl` whose `sessionId` is deleted |

The union matters: SDK-driven sessions (`entrypoint: sdk-ts`) never write to
`history.jsonl`, so counting history alone quietly omits them.

You do not have to trust potsherd to check potsherd.

```bash
potsherd audit --verify
```

prints a self-contained Python snippet — standard library only, no checkout, no
potsherd — that recomputes all four numbers from your own files, plus the four
definitions it implements. Paste it into a shell, or pipe it into one:

```bash
potsherd audit --verify --json | jq -r .snippet | sh
```

With a checkout of this repository,
[`scripts/verify-audit.py`](scripts/verify-audit.py) is the same computation
with `--json` and `--claude-dir`:

```bash
python3 scripts/verify-audit.py
python3 scripts/verify-audit.py --json --claude-dir ~/backup/.claude
```

Both exclude subagent transcripts (the `.jsonl` files under a `subagents/`
directory): a subagent transcript belongs to the session that spawned it, so
counting one as a session would inflate "still on disk".

If the two ever disagree, the Python is right and potsherd has a bug.

## What is not recoverable

Being clear about this before you find out yourself:

- **The assistant's side of a deleted session is gone.** `history.jsonl` records
  what you typed, not what Claude answered. A ghost is the prompt side only.
- **Tool calls, file edits and diffs from deleted sessions are gone.**
- `~/.claude/file-history/` only exists for live sessions.
- A ghost gets a title only where a `sessions-index.json` happened to survive in
  that project directory — on the reference machine, 4 of 16 project dirs.
- potsherd cannot recover anything the sweep took **before** you install it. It
  can stop the next one. That is the whole point of running `audit` today.

## Privacy

Generated by `potsherd doctor --privacy` against the demo corpus, not written
by hand:

```
potsherd doctor --privacy · 21 aug 2026

  reads (never modified):
    ~/.claude/projects
    ~/.claude/history.jsonl
    ~/.claude/projects/-home-dev-agent-runner/sessions-index.json
    ~/.claude/projects/-home-dev-crm-ingest/sessions-index.json
    ~/.claude/projects/-home-dev-notes-api/sessions-index.json
    ~/.claude/projects/-home-dev-payments-api/sessions-index.json
    ~/.claude/settings.json
    ~/.claude/settings.local.json  (absent)
    /Library/Application Support/ClaudeCode/managed-settings.json  (absent)

  writes:
    ~/.potsherd
    ~/.potsherd/archive
    ~/.potsherd/potsherd.db

  writes only after an explicit y at a diff:
    ~/.claude/settings.json
      cleanupPeriodDays, and one SessionStart hook entry

  no network. no telemetry. no account.
```

`~/.claude`, `~/.codex`, `~/.cursor`, `~/.pi` and `~/.gemini` are read-only
inputs. Archived copies are written 0600 and keep their original mtime. The
archive is byte-exact and unredacted, because it is your own file on your own
disk.

Run `potsherd doctor --privacy` on your machine to see the real list.

## Install

Nothing is required for `audit`:

```bash
npx potsherd audit
```

For the verbs that write, install it:

```bash
npm install -g potsherd
potsherd rescue
```

Requires Node 22 or newer. `CLAUDE_CONFIG_DIR` is honoured; `--claude-dir`
overrides it.

## Roadmap

potsherd is built in eight phases. Each ships on its own and is verified against
a real corpus before the next begins.

| phase | what it adds | status |
|---|---|---|
| 0 | `audit`, `rescue`, `guard`, `doctor` | **shipped — v0.1.0** |
| 1 | full parser, codex/cursor/pi adapters, redaction, `index`, `find`, `ls`, `show` | next |
| 2 | verified per-session cards, tags, pins, links | |
| 3 | hybrid recall across exchanges, cards and ghosts | |
| 4 | `ask` (cited answers, open threads) and `graft` (re-entry briefs) | |
| 5 | Claude Code plugin, Codex plugin, MCP server, hooks | |
| 6 | gemini/opencode/copilot, bridges to claude-mem and agentmemory | |
| 7 | polish, docs, release — v1.0.0 | |

## Credit

potsherd's engine is a fork of
[episodic-memory](https://github.com/obra/episodic-memory) by Jesse Vincent
(MIT). See [NOTICE](NOTICE). Generic fixes are prepared as upstream pull
requests under `docs/upstream/`.

## Licence

MIT. See [LICENSE](LICENSE).

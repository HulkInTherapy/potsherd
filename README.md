# potsherd

Claude Code deletes your session transcripts after 30 days. It does not tell you.

```
npx potsherd audit          # at release. today: see Install — the package is not published yet
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

Real output from `potsherd audit`
([`docs/screens/01-audit.txt`](docs/screens/01-audit.txt)), run against a
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
the size — it holds about half a megabyte — so wherever a block below prints
bytes, the bytes are the demo corpus's own and not the reference machine's.

> **Status: v0.4.0, phases 0 to 3 shipped of 8; phase 4 in progress.** Today
> potsherd rescues, indexes, searches, writes cards and recalls across them.
> `ask` and `graft` are landing in phase 4 — see [the roadmap](#roadmap).

---

## The problem

`~/.claude/settings.json` has a key called `cleanupPeriodDays`. It defaults to
30. At every startup Claude Code deletes transcripts whose **mtime** is older
than that. No warning, no recycle bin, not surfaced in `/config`.

The transcripts are gone. But one file survives everything:
`~/.claude/history.jsonl` holds every prompt you have ever typed, with its
timestamp, project and session id — including the prompts from every deleted
session. potsherd calls those reconstructed sessions **ghosts**.

## Rescue first

### `potsherd audit`

Counts what you have, what you have lost, and what goes next.

```bash
npx potsherd audit
npx potsherd audit --sweep          # name the sessions the next sweep takes
npx potsherd audit --json | jq .deleted
npx potsherd audit --verify         # the python that checks these numbers
```

`--sweep` ([`06-audit-sweep.txt`](docs/screens/06-audit-sweep.txt)) prints the
next thirty-one by name and by how many days they have left.

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

[`docs/screens/02-rescue.txt`](docs/screens/02-rescue.txt). The counts are the
reference machine's; the two byte figures are the demo corpus's. The same run
there copied **277 files and 327 MB**
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

---

## Then search it

Everything below reads an index that `potsherd index` builds from your
transcripts and from the ghosts `rescue` rebuilt. Two things are in it that are
usually left out:

- **subagent transcripts.** Claude Code writes every sidechain to its own file
  under `<session-id>/subagents/`. The reference machine had **197** of them
  against 31 live sessions — six files of delegated work for every one of the
  sessions you remember having. The search engine potsherd forked hard-codes
  `AND e.is_sidechain = 0` into both of its queries (`src/search.ts:165` and
  `:188`); removing it is the change prepared as an upstream pull request in
  [`docs/upstream/PR-sidechain-flag.md`](docs/upstream/PR-sidechain-flag.md). In
  potsherd a sidechain is a session in its own right, with its own id, parent
  and agent name, and it is included by default.
- **ghosts.** Sessions whose transcript the sweep already took, rebuilt from
  `history.jsonl`. Nothing can index those files any more, because they are not
  there; potsherd indexes the prompts that outlived them and says on every row
  that the other half is not coming back.

Both are `include` by default; `--sidechains only|exclude` and
`--ghosts only|exclude` narrow it.

### `potsherd find`

```bash
potsherd find pgbouncer
```

```
potsherd find "pgbouncer" · 5 sessions · bm25 · 5ms

  Pool the ingest workers through pgbouncer                        claude · live
  data-pipeline · 21 aug · 8 exchanges · main                             0.0369
    put pgbouncer in front of it in transaction pooling mode
    what happens to an in-flight batch when pgbouncer restarts?
    run  claude --resume 9c4d2f18-7a3b-4e05-b6d1-0f2a58e17c43

  Move payments-api onto pgbouncer                                claude · ghost
  payments-api · 13 nov 2025 · 241 prompts recovered · main               0.0246
    postgres is refusing connections under load. is a pooler the answer or do w…
    …e prepared statements are failing behind pgbouncer — what are the options?
    assistant side not recoverable · potsherd show 77c6a3a4

  Put the importer behind the pooler                              claude · ghost
  crm-ingest · 22 nov 2025 · 6 prompts recovered · feat/retry-budget      0.0241
    copy the pgbouncer setup from payments-api onto the importer
    what is a sane pgbouncer pool_size for twelve importer workers?
    assistant side not recoverable · potsherd show 840f40a5

  Keep LISTEN/NOTIFY off the pooler                               claude · ghost
  agent-runner · 3 dec 2025 · 3 prompts recovered · chore/deps            0.0164
    pgbouncer transaction pooling broke LISTEN/NOTIFY in the runner
    assistant side not recoverable · potsherd show 9f9d323a

  ↳ data-pipeline-01                                          claude · sidechain
  data-pipeline · 21 aug · 1 exchange · main · schema-checker             0.0161
    …y driver in the repo still prepares statements server-side under pgbouncer
    run  claude --resume 9c4d2f18-7a3b-4e05-b6d1-0f2a58e17c43

  3 ghost hits · 1 from subagents · …
```

[`docs/screens/09-find.txt`](docs/screens/09-find.txt). One live session, three
that Claude Code deleted months ago, and one subagent — from one query, with no
flags. The three middle results are the whole point: the decision was taken in a
project that no longer has a single transcript on disk, and the prompts that
took it are still here, marked for what they are.

`assistant side not recoverable` is printed on every ghost, every time. It is
not a footnote.

```bash
potsherd find "connection pool" --project data-pipeline --since 30d
potsherd find pgbouncer --ghosts only        # only what the sweep took
potsherd find pgbouncer --sidechains only    # only what the subagents did
potsherd find pgbouncer --harness codex      # claude, codex, cursor or pi
potsherd find pgbouncer --file db/pool.ts    # sessions that touched a path
potsherd find "the pooler decision" --vectors on
potsherd find pgbouncer --json | jq -r '.sessions[0].resume'
```

Retrieval is bm25 over an fts5 index, plus cosine over `sqlite-vec`, fused with
reciprocal rank. `--vectors auto` (the default) skips the vector half when the
words already matched, which is why the screen above says `bm25`. There is no
model call and no network in any of it.

`find` prints its own wall time on every run, so the number in your terminal is
yours. Ten queries against the reference machine's index — 1,441 exchanges from
all four harnesses — printed between **15 ms and 58 ms**, median 32; the demo
corpus screens here print single digits.

### `potsherd ls` — the archive, by title

```bash
potsherd ls
```

```
potsherd ls · 15 of 330

    when  harness  project          title                                 status
  21 aug  claude   data-pipeline    Pool the ingest workers through pgb…  live
  19 aug  claude   auth-gateway     Rewrite rss parser to stream  ↳6      live
  17 aug  claude   auth-gateway     Untangle token refresh error handli…  live
  16 aug  claude   report-builder   Add a timeout to mock server          live
  15 aug  claude   report-builder   report-builder-6fe53b91  ↳9           live
  14 aug  claude   docs-site        Pin seed script behind a feature fl…  live
  13 aug  claude   docs-site        Fix checkout flow timeout handling…   live
  12 aug  claude   event-bus        Add a dry-run mode to audit log  ↳3   live
  11 aug  claude   event-bus        Pin audio transcoder behind a featu…  live
  10 aug  claude   event-bus        Investigate rss parser regression ↳5  live
   9 aug  claude   infra-terraform  Refactor csv importer into two pass…  live
   8 aug  claude   infra-terraform  infra-terraform-08327c8b              live
   7 aug  claude   infra-terraform  Document dead-letter queue  ↳4        live
   6 aug  claude   mobile-shell     mobile-shell-532a725c  ↳8             live
   5 aug  claude   mobile-shell     mobile-shell-b969824b  ↳2             live

  31 sessions · 197 subagents inside them · 299 ghosts, prompts only
  run  potsherd show <id8>  to read one, or  potsherd find <words>
```

[`docs/screens/08-ls.txt`](docs/screens/08-ls.txt). This is
`ls ~/.claude/projects` after potsherd has read it. `↳n` is how many subagent
transcripts hang off that session. The four rows that still read
`project-<id8>` are honest ones: those sessions have no `ai-title`, and two of
them were driven by the SDK, which never writes one. potsherd does not invent a
title to fill a column.

Deleted sessions are in the same list, and the same flags reach them:

```bash
potsherd ls --ghosts only
```

```
potsherd ls · 15 of 299

    when  harness  project         title                                  status
  21 jul  claude   asset-cdn       refactor the docker entrypoint so th…  ghost
  20 jul  claude   payments-api    explain what the invoice renderer is…  ghost
  19 jul  claude   payments-api    add a feature flag around the cache…   ghost
  18 jul  claude   crm-ingest      turn the rss parser into a backgroun…  ghost
  17 jul  claude   agent-runner    the migration runner regressed after…  ghost
  17 jul  claude   portfolio-site  add metrics to the event replayer so…  ghost
  16 jul  claude   infant-vision   review the dead-letter queue for rac…  ghost
  15 jul  claude   hive-scheduler  the rss parser leaks a file handle s…  ghost
  14 jul  claude   webhook-relay   port the event replayer to the new c…  ghost
  13 jul  claude   plugin-host     port the auth middleware to the new…   ghost
  12 jul  claude   mesh-router     show me the diff before you write an…  ghost
  11 jul  claude   form-builder    the health check is failing in CI bu…  ghost
  11 jul  claude   chat-widget     commit this with a message that expl…  ghost
  10 jul  claude   payments-api    show me the diff before you write an…  ghost
   9 jul  claude   payments-api    add input validation to the mock ser…  ghost

  299 ghosts, prompts only
  run  potsherd show <id8>  to read one, or  potsherd find <words>
```

[`docs/screens/12-ls-ghosts.txt`](docs/screens/12-ls-ghosts.txt). A ghost's
title is the first thing you typed, unless a `sessions-index.json` happened to
survive in that project directory and remembered a real one — 19 of the 299 did.

### `potsherd show`

Reads one session end to end, by id or by any unambiguous prefix.

```bash
potsherd show 9c4d2f18
```

```
potsherd show · Pool the ingest workers through pgbouncer

  claude · live · data-pipeline · 21 aug 09:14 · main
  9c4d2f18-7a3b-4e05-b6d1-0f2a58e17c43
  8 exchanges
  run  claude --resume 9c4d2f18-7a3b-4e05-b6d1-0f2a58e17c43

    1  21 aug 09:14  you
    the ingest workers open one postgres connection per task and we are hitting
    max_connections again
    claude
    Confirmed from the pool metrics: 412 slots requested against a 400 limit at
    peak, so the workers queue and then time out.
    tools  Bash
    files  ingest.ts

    2  21 aug 09:23  you
    put pgbouncer in front of it in transaction pooling mode
    claude
    That will hold, but transaction pooling drops session state: SET,
    LISTEN/NOTIFY and server-side prepared statements stop surviving a
    transaction boundary.
    tools  Read
    files  pool.ts
```

The first two of eight exchanges;
[`docs/screens/11-show.txt`](docs/screens/11-show.txt) is the whole session,
including the line at the end that names its nine subagent transcripts.

```bash
potsherd show 9c4d2f18 --from 12 --to 18
potsherd show 9c4d2f18 --md > session.md
potsherd show 9c4d2f18 --json | jq -r '.exchanges[].userText'
```

### `potsherd index`

```bash
potsherd index --full --no-embed
```

```
potsherd index · ~/.potsherd · 21 aug 2026

  claude                       228   31 sessions · 197 sidechains · 439 exchang…
  codex                          0   not installed — ~/.codex/sessions
  cursor                         0   not installed — ~/.cursor/projects
  pi                             0   not installed — ~/.pi/agent/sessions

  exchanges indexed            439   242 tool calls · 2 redacted
  ghosts indexed               299   2,971 prompts, searchable
  secrets masked                 5   aws 1 · gcp 1 · github 1 · stripe 1 · …
  vectors                        —   skipped (--no-embed) · text search only

  full index                 251ms   228 parsed · 0 unchanged · 545 KB

  run  potsherd doctor  for parse coverage and every path read.
```

[`docs/screens/07-index.txt`](docs/screens/07-index.txt). Four harnesses are
parsed — Claude Code including its sidechains, Codex, Cursor and pi — and each
line names the directory it looked in, present or not.

```bash
potsherd index                       # incremental; only what changed
potsherd index --harness claude --no-embed
potsherd index --session 9c4d2f18
potsherd index --json | jq .totals
```

**How long it takes, honestly.** Two different operations get called "index",
and one is thirty times the other.

| | reference machine, 328 MB, 1,406 exchanges | demo corpus, 545 KB, 439 exchanges |
|---|---|---|
| `index --full --no-embed` | **8.8 s** | under a second — see the screen above |
| `index --full` (with vectors) | **4 m 42 s**, of which 4 m 32 s is embedding | 3.3 s |
| `index` (incremental, nothing changed) | **67 ms** | — |

The reference-machine figures were measured by phase 1 and are recorded with
their method in [phases/phase-1/WAVE.md](phases/phase-1/WAVE.md) (F20). The
demo-corpus column is the corpus `bash scripts/make-screens.sh` builds; its
`--no-embed` row is the screen above, and its vector row is what
`potsherd index --full` printed against that corpus with the model already
cached — 439 one-line exchanges embed a great deal faster than 1,406 real ones,
which is exactly why the two columns are shown side by side.

The 8.8 s covers parsing, redacting, storing, building fts5 and rebuilding all
299 ghosts. The 4 m 42 s is the same work plus 1,406 embeddings, and 96% of it
is the embeddings. Neither is a benchmark: re-running
`potsherd index --full --no-embed` on that machine while this readme was being
written — 346 MB, 256 transcripts, all four harnesses, load average 16.7 —
printed **24.2 s**. "Seconds" is the claim.

So **`--no-embed` is a first-class path, not a degraded one.** It needs no
model, no download and no network, and `find` works on day one without it —
every search screen in this readme was taken against a `--no-embed` index.

Vectors are what let `find "the pooler decision"` match a session that never
used those words. They cost a one-off model download (`bge-small`, 32.4 MB on
disk once cached) that `index` announces before it starts, and minutes on the
first run. You can add them later: `potsherd index` again without `--no-embed`
fills in what is pending.

### `potsherd stats`

```bash
potsherd stats
```

```
potsherd stats · ~/.potsherd · 21 aug 2026

  harness  sessions  subagents  ghosts  exchanges   bytes  span
  claude         31        197     299        439  545 KB  nov 2025 → aug 2026

  sessions                      31   197 subagents · 21 titled · 0 archived
  exchanges                    439   242 tool calls · 2 redacted
  ghosts                       299   2,971 prompts recovered · no assistant side
  secrets masked                 5   aws 1 · gcp 1 · github 1 · stripe 1 · …

  indexed                   21 aug   228 transcripts · up to date
  vectors                        0   bge-small · 439 pending · hybrid search on
  database                  1.9 MB   ~/.potsherd/potsherd.db

  run  potsherd ls  to read the archive by title, newest first.
```

[`docs/screens/10-stats.txt`](docs/screens/10-stats.txt). `439 pending` is
`--no-embed`'s honest bookkeeping: the vectors were skipped, and stats says so
rather than reporting an index that is complete.

`potsherd doctor` ([`04-doctor.txt`](docs/screens/04-doctor.txt)) goes further:
every record type the parsers did not consume, per harness and per version, and
a line for each adapter saying what it can and cannot recover.

## Redaction, and what it does not touch

Secrets are masked **before anything is written to the index**, and there is no
way to turn that off — no `--no-redact` flag, and adding one is not a feature
request ([`packages/core/src/redact.ts`](packages/core/src/redact.ts)). The
rules run at ingest, between the parser and the database, so a secret never
reaches fts5, never reaches a vector, and never reaches a model in any later
phase.

A mask replaces the value with its type and the first eight hex characters of
its sha256:

```
potsherd find "redacted aws" · 2 sessions · bm25 · 6ms

  Add a timeout to mock server                                     claude · live
  report-builder · 16 aug · 3 exchanges · feat/retry-budget               0.0098
    the nightly deploy job is 403ing against the bucket. what does it actually…
    run  claude --resume d3e6b7a1-5c04-4f92-9a83-27b6e0d418ca

  Put the importer behind the pooler                              claude · ghost
  crm-ingest · 22 nov 2025 · 6 prompts recovered · feat/retry-budget      0.0098
    … the pooler — postgres://ingest:‹redacted:basic-auth:201b2d22›@db.internal…
    assistant side not recoverable · potsherd show 840f40a5

  1 ghost hit · …
```

[`docs/screens/13-find-redacted.txt`](docs/screens/13-find-redacted.txt). The
demo corpus deliberately leaks five generated credentials — a `cat .env`, a CI
log and a connection string pasted into a prompt — so that these screens show
the redactor working rather than an empty count. The mask keeps the row
searchable and readable: you can still see it was a postgres url, which user and
which host, and `find "redacted aws"` finds every exchange that leaked an AWS
key without anyone having to know what the key was.

**The archive is not redacted.** `~/.potsherd/archive` is a byte-exact copy of
your own transcripts, with their original mtimes, mode 0600. Redaction protects
the derived index — the thing that gets queried, embedded and, in later phases,
put in front of a model. It does not get to alter your evidence.

The rule pack is ported from [gitleaks](https://github.com/gitleaks/gitleaks)
(MIT, © 2019 Zachary Rice) and
[secretlint](https://github.com/secretlint/secretlint) (MIT, © 2020 Secretlint);
neither is a runtime dependency, and each rule records the upstream rule id it
came from. See [NOTICE](NOTICE) for the exact attributions.

## Privacy

Generated by `potsherd doctor --privacy` against the demo corpus, not written
by hand ([`docs/screens/05-doctor-privacy.txt`](docs/screens/05-doctor-privacy.txt)):

```
potsherd doctor --privacy · 22 aug 2026

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
    ~/.codex/sessions  (absent)
    ~/.cursor/projects  (absent)
    ~/.pi/agent/sessions  (absent)
    ~/.gemini/tmp  (absent)
    ~/.local/share/opencode  (absent)
    ~/.copilot/session-state  (absent)

  writes:
    ~/.potsherd
    ~/.potsherd/archive
    ~/.potsherd/potsherd.db
    ~/.potsherd/models
    ~/work/demo-project/.potsherd/graft-<id8>.md
      only when you run graft, in the directory you run it in
    <the path you give to  ask --readers-out>
      only when you pass the flag. it holds the same redacted excerpts a
      model would have been sent, and no model was called to write it

  writes only after an explicit y at a diff:
    ~/.claude/settings.json
      cleanupPeriodDays, and one SessionStart hook entry
    ~/.claude.json
    ~/.codex/config.toml
    ~/.cursor/mcp.json
    ~/.gemini/settings.json
    ~/.config/opencode/opencode.json
    ~/.copilot/mcp-config.json
    ~/.pi/agent/settings.json
      one "potsherd" MCP server entry each, from potsherd setup.
      every other server in those files is preserved.

  leaves this machine:
    redacted slices of your transcripts, sent to a model as the
    text of one prompt. redaction runs first, in one place, on
    every outgoing string — there is no --no-redact flag.
    nothing else is ever sent: no file is uploaded, no path, no
    index, no counts, no identifiers.

  only these verbs call a model:
    potsherd card      writes the cards; one call per slice
    potsherd ask       one call, over the shortlist it retrieved
    potsherd graft     one call, to compress one session into a brief

  these never do, and open no socket at all:
    audit, rescue, guard, index, ls, find, show, stats, tag, pin,
    unpin, link, setup, doctor

  who receives them:
    your own Claude subscription, via ~/.claude/local/claude
    the same binary and the same account you already use by hand.
    potsherd holds no key, no token and no account of its own.
    the call runs with no tools, in an empty scratch directory, and
    its session is never written to ~/.claude/projects.

  no other network, except the one-off embedding-model download.
  `potsherd index` names it before it starts, but `--quiet` and
  `--json` suppress that line, and `--quiet` is how the plugin's
  SessionEnd hook runs it — so its SessionStart hook warns you first.
  `--no-embed` skips the download entirely.
  no telemetry. no account. potsherd stores no credential of its own.
```

`~/.claude`, `~/.codex`, `~/.cursor`, `~/.pi` and `~/.gemini` are read-only
inputs. Archived copies are written 0600 and keep their original mtime.

The one thing that leaves your machine is the text `potsherd card`, `potsherd
ask` and `potsherd graft` send to a model: redacted slices of the transcripts
being carded, answered over, or compressed into a brief, and nothing else. It
goes to the `claude` binary you already have, on your own subscription — or, if
you have no `claude` and you set `ANTHROPIC_API_KEY`, to the API on your key.
Redaction happens first, in one place, on every outgoing string, and there is
no `--no-redact`. Every other verb — `audit`, `rescue`, `guard`, `index`, `ls`,
`find`, `show`, `stats`, `tag`, `pin`, `unpin`, `link`, `doctor` — never calls a
model and opens no socket at all.

`graft` is also the one verb that writes outside `~/.potsherd`: its brief lands
in `./.potsherd/graft-<id8>.md`, in the project directory you run it in, which
is the point of the verb. The receipt above lists that path for the same reason
it lists everything else.

Run `potsherd doctor --privacy` on your machine to see the real list.

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
counting one as a session would inflate "still on disk". `index` and `find` do
the opposite and treat each one as a session of its own, because a subagent
transcript is a thing you want to search.

If the two ever disagree, the Python is right and potsherd has a bug.

## What is not recoverable

Being clear about this before you find out yourself:

- **The assistant's side of a deleted session is gone.** `history.jsonl` records
  what you typed, not what Claude answered. A ghost is the prompt side only, and
  every `find` result says so on its own row.
- **Tool calls, file edits and diffs from deleted sessions are gone.**
- `~/.claude/file-history/` only exists for live sessions.
- A ghost gets a title only where a `sessions-index.json` happened to survive in
  that project directory — on the reference machine, 4 of 16 project dirs, which
  gave 19 of the 299 ghosts a name back.
- **Cursor gives up less than the others.** Its transcripts carry no record
  type, no ids and no tool results, and no version marker exists anywhere under
  `~/.cursor`. Title, model, git branch and tool results are not recoverable
  from `~/.cursor` alone; potsherd leaves them undefined rather than inventing
  them, and `potsherd doctor` says which ones on the adapter's own line.
- potsherd cannot recover anything the sweep took **before** you install it. It
  can stop the next one. That is the whole point of running `audit` today.

## Install

> **potsherd is not on npm yet.** `npx potsherd` and `npm i -g potsherd` are
> both 404 today — publishing is phase 7's job. The `npx` line at the top of
> this readme is what `audit` will be at release; the commands below are what
> works now. Nothing else in this readme depends on the registry: every screen
> in it was captured from a checkout.

```bash
git clone https://github.com/HulkInTherapy/potsherd
cd potsherd
pnpm install && pnpm build

node packages/cli/bin/potsherd.js audit
node packages/cli/bin/potsherd.js rescue
node packages/cli/bin/potsherd.js index --no-embed
node packages/cli/bin/potsherd.js find "something you argued about in june"
```

`potsherd setup --claude` (and the plugin) write the absolute path to that
`bin/potsherd.js` into their config, so nothing depends on a global install.

Requires Node 22 or newer. `CLAUDE_CONFIG_DIR` is honoured; `--claude-dir`
overrides it. Every verb takes `--json`, `--no-color`, `--ascii` and `--width`.

## Roadmap

potsherd is built in eight phases. Each ships on its own and is verified against
a real corpus before the next begins.

| phase | what it adds | status |
|---|---|---|
| 0 | `audit`, `rescue`, `guard`, `doctor` | **shipped — v0.1.0** |
| 1 | full parser, sidechains, codex/cursor/pi adapters, redaction, `index`, `find`, `ls`, `show`, `stats` | **shipped — v0.2.0** |
| 2 | verified per-session cards, tags, pins, links | **shipped — v0.3.0** |
| 3 | hybrid recall across exchanges, cards and ghosts | **shipped — v0.4.0** |
| 4 | `ask` (cited answers, open threads) and `graft` (re-entry briefs) | in progress |
| 5 | Claude Code plugin, Codex plugin, MCP server, hooks | |
| 6 | gemini/opencode/copilot, bridges to claude-mem and agentmemory | |
| 7 | polish, docs, release — v1.0.0 | |

## Credit

potsherd's engine is a fork of
[episodic-memory](https://github.com/obra/episodic-memory) by Jesse Vincent
(MIT). See [NOTICE](NOTICE) for the exact upstream revision. Generic fixes are
prepared as upstream pull requests under
[`docs/upstream/`](docs/upstream) — none of them is submitted by an agent.

The secret-detection rules it redacts with are ported from
[gitleaks](https://github.com/gitleaks/gitleaks) (MIT, © 2019 Zachary Rice) and
[secretlint](https://github.com/secretlint/secretlint) (MIT, © 2020 Secretlint)
— see [Redaction](#redaction-and-what-it-does-not-touch) above and
[NOTICE](NOTICE).

## Licence

MIT. See [LICENSE](LICENSE).

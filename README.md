# potsherd

Claude Code deletes your session transcripts after 30 days. It does not tell you.

```
npx potsherd audit          # once published — see Install; today it is a git clone
```

**These numbers are a synthetic reproduction, not one person's archive.** The
block below is `potsherd audit` run against a
[demo corpus](scripts/make-demo-corpus.mjs) that reproduces, number for number,
what was measured on one real machine on 21 August 2026 — 330 sessions ever, 31
still on disk, 91% deleted. The transcripts behind those counts are their
owner's client work and are not this repository's to publish, so every code
block in this readme and every file in [`docs/screens/`](docs/screens) is
generated from the synthetic corpus instead.

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

![potsherd: audit, rescue, index, find](docs/demo.gif)

Fourteen seconds, unedited, recorded by
[`scripts/make-cast.sh`](scripts/make-cast.sh) against the demo corpus
([`docs/demo.cast`](docs/demo.cast)). `ask` has
[its own recording](docs/demo-ask.gif) because it is fifty seconds of real model
calls and would not fit inside a minute beside the rest.

The audit block above is real output, captured to
[`docs/screens/01-audit.txt`](docs/screens/01-audit.txt) by
[`scripts/make-screens.sh`](scripts/make-screens.sh); no number in this readme
is typed in by hand.

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

> **Status: v1.0.0. All eight phases shipped.** 21 verbs, a Claude Code plugin,
> an MCP server with six tools, adapters for seven coding agents, and bridges
> into three other memory tools. 1,532 tests, green on macOS and Ubuntu across
> Node 22 and 24 — and green again on Node's own SQLite, which is what makes a
> plugin install work with nothing else on the machine.

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

### What that leaves you with

```
what Claude Code leaves you  —  ls ~/.claude/projects/*

  -home-dev-auth-gateway/0e3ad88f-24f6-4cca-a6da-b0de6660898d.jsonl
  -home-dev-auth-gateway/81163900-c7dd-449a-b86d-f60fed82857c.jsonl
  -home-dev-billing-web/1045b6e3-c486-4d7e-b7bb-659c74bdb205.jsonl
  -home-dev-billing-web/aa9690f6-a5c2-4fad-bdb5-f8c9fb809865.jsonl
  -home-dev-billing-web/aafd81ae-8f2f-48de-8695-b5814d5ce5a9.jsonl
  ... 31 files, named by uuid, in 16 directories.
  the 299 sessions the sweep already took are not here at all.

what potsherd leaves you  —  potsherd ls

  potsherd ls · 5 of 330
  
      when  harness  project         title                              status
    21 aug  claude   data-pipeline   Pool the ingest workers through…   live
    19 aug  claude   auth-gateway    Rewrite rss parser to stream  ↳6   live
    17 aug  claude   auth-gateway    Untangle token refresh error han…  live
    16 aug  claude   report-builder  Add a timeout to mock server       live
    15 aug  claude   report-builder  report-builder-6fe53b91  ↳9        live
  
    31 sessions · 197 subagents inside them · 299 ghosts, prompts only
    run  potsherd show <id8>  to read one, or  potsherd find <words>
```

[`docs/screens/16-before-after.txt`](docs/screens/16-before-after.txt). Left is
what the harness leaves: one file per session, named by uuid, in a directory
named after a mangled path — and the sessions the sweep took are simply not
there. Right is the same machine after `rescue`. The 299 are back as ghosts,
the subagent transcripts are counted, and everything has a name.

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
potsherd index --embed                       # once; --vectors needs vectors
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
  11 aug  claude   event-bus        Move the event-bus consumers behind…  live
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
potsherd index --full
```

```
potsherd index · ~/.potsherd · 22 aug 2026

  claude                       228   31 sessions · 197 sidechains · 439 exchang…
  codex                          0   not installed — ~/.codex/sessions
  cursor                         0   not installed — ~/.cursor/projects
  pi                             0   not installed — ~/.pi/agent/sessions
  gemini                         0   not installed — ~/.gemini/tmp
  opencode                       0   not installed — ~/.local/share/opencode
  copilot                        0   not installed — ~/.copilot/session-state

  exchanges indexed            439   242 tool calls · 2 redacted
  ghosts indexed               299   2,971 prompts, searchable
  masked this run                5   aws 1 · gcp 1 · github 1 · stripe 1 · …
  vectors                        —   text search only · no model, no network

  full index                 300ms   228 parsed · 0 unchanged · 546 KB

  run  potsherd doctor  for parse coverage and every path read.
  run  potsherd index --embed  for semantic search (32 MB model, ~6 min, once)
```

[`docs/screens/07-index.txt`](docs/screens/07-index.txt), captured with no
flags, which since v1.1.0 means text only: no model, no download, no socket.
**Seven** harnesses are read — Claude Code including its sidechains, Codex,
Cursor, pi, Gemini, opencode and Copilot — and each line names the directory it
looked in, present or not. The last line is the whole of the semantic-search
upgrade; `potsherd index --embed` is the only thing that fetches a model.

```bash
potsherd index                       # incremental; only what changed
potsherd index --embed                # + semantic search, 32 MB model, once
potsherd index --session 9c4d2f18
potsherd index --json | jq .totals
```

**How long it takes, honestly.** Two different operations get called "index",
and one is thirty times the other.

| | reference machine, 328 MB, 1,406 exchanges | demo corpus, 545 KB, 439 exchanges |
|---|---|---|
| `index --full` (the default, text only) | **8.8 s** | under a second — see the screen above |
| `index --full --embed` (with vectors) | **4 m 42 s**, of which 4 m 32 s is embedding | 3.3 s |
| `index` (incremental, nothing changed) | **67 ms** | — |

The reference-machine figures were measured by phase 1 and are recorded with
their method in [phases/phase-1/WAVE.md](phases/phase-1/WAVE.md) (F20). The
demo-corpus column is the corpus `bash scripts/make-screens.sh` builds; its
text-only row is the screen above, and its vector row is what
`potsherd index --full --embed` printed against that corpus with the model already
cached — 439 one-line exchanges embed a great deal faster than 1,406 real ones,
which is exactly why the two columns are shown side by side.

The 8.8 s covers parsing, redacting, storing, building fts5 and rebuilding all
299 ghosts. The 4 m 42 s is the same work plus 1,406 embeddings, and 96% of it
is the embeddings. Neither is a benchmark: re-running
`potsherd index --full` on that machine while this readme was being
written — 346 MB, 256 transcripts, all four harnesses, load average 16.7 —
printed **24.2 s**. "Seconds" is the claim.

So **text only is the default path, not a degraded one.** It needs no model,
no download and no network, and `find` works on day one without them — every
search screen in this readme was taken against a text-only index.

Vectors are what let `find "the pooler decision"` match a session that never
used those words. They cost a one-off model download (`bge-small`, 32.4 MB on
disk once cached) that `index` announces before it starts, and minutes on the
first run, and you ask for them explicitly: `potsherd index --embed` fills in
what is pending, and prints nothing until you do.

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
text-only indexing's honest bookkeeping: no vectors were built, and stats says so
rather than reporting an index that is complete.

`potsherd doctor` ([`04-doctor.txt`](docs/screens/04-doctor.txt)) goes further:
every record type the parsers did not consume, per harness and per version, and
a line for each adapter saying what it can and cannot recover.

## Give the sessions names — `potsherd card`

`ls` above is the archive as the harness left it. **21 of the reference
machine's 31 live sessions had a title Claude Code wrote**, and the other ten
are the rows that read `report-builder-6fe53b91` and `mobile-shell-532a725c` —
a project name and eight characters of a uuid, because there was nothing else
to call them. A ghost has no title at all: the sweep took the file the title
was in.

`potsherd card` writes one card per session: a title, three sentences of
summary, the decisions, the open threads, the files, the topics. Each card is
one model call over the session's own text, and **every claim on it is checked
against the transcript before it is stored.** A decision whose `evidence_seq`
does not resolve to a real exchange is dropped, not printed — the same rule
`ask` runs, in the same code.

```bash
potsherd card --dry-run --all     # what it would cost, before it costs it
potsherd card --all --yes         # every session
potsherd card 9c4d2f18            # one
```

The dry run is not decoration. Cards are the one part of potsherd that spends
anything, so the estimate comes first and the receipt at the end says what it
actually cost beside what it quoted. On the reference machine, carding **35
sessions took 225 calls, 55m 25s and $12.93 of api-equivalent spend — $0
charged**, because the calls go out through the `claude` binary and your own
subscription. potsherd holds no key, no token and no account of its own. Of the claims those cards proposed, **261 were kept
and 5 dropped**, and **374 of 374 `evidence_seq` references resolve**
([phases/phase-2/HANDOFF.md](phases/phase-2/HANDOFF.md)).

The estimator is **about twice optimistic** even after being re-fitted against
twelve real calls, and it is one-directional: it quoted 2m 52s / $0.473 for a
ten-ghost run that took 5m 5s / $0.957. `card` does not hide that — the receipt
prints the quote beside the outcome, every finished run is recorded, and the
next estimate on that machine is scaled by the last one.

The same `ls`, once every session has one:

```
potsherd ls · 12 of 330

    when  harness  project          title                                 status
  21 aug  claude   data-pipeline    Pool ingest workers through pgbounc…  live
  19 aug  claude   auth-gateway     Rapid debugging and refactoring acr…  live
  17 aug  claude   auth-gateway     Backend component refactoring and d…  live
  16 aug  claude   report-builder   Fixed nightly deploy bucket auth mi…  live
  15 aug  claude   report-builder   Nine technical questions with misma…  live
  14 aug  claude   docs-site        Code changes and fixture loader bug…  live
  13 aug  claude   docs-site        Refactor core services with build f…  live
  12 aug  claude   event-bus        Multiple technical issues during de…  live
  11 aug  claude   event-bus        Connection pooling for delivery con…  live
  10 aug  claude   event-bus        Multiple requests for code and work…  live
   9 aug  claude   infra-terraform  Code review and refactoring across…   live
   8 aug  claude   infra-terraform  Development session with PR and rev…  live

  31 sessions · 197 subagents inside them · 299 ghosts, prompts only
  run  potsherd show <id8>  to read one, or  potsherd find <words>
```

[`docs/screens/17-ls-cards.txt`](docs/screens/17-ls-cards.txt). Same verb, same
archive, six minutes of model calls apart. The sessions the harness never named
now say what they were.

### Ghost cards

A ghost has prompts and no answers. Carding one is a different job, and it is
done by a different prompt that is told so: **the assistant side is gone, so
nothing may be written as decided.** 90 ghosts were carded on the reference
machine in 96 calls and about 33 minutes, and all 90 came back
`outcome: unknown`, `source: prompts-only`. The summaries say what was *asked*,
not what was concluded — one of the ten the verifier read by hand still
overstepped, and that is recorded rather than smoothed over.

### Your own marks — `tag`, `pin`, `link`

```bash
potsherd tag 9c4d2f18 +pgbouncer +infra -draft   # add two, remove one
potsherd pin 9c4d2f18                            # ★ in ls, --pinned in find
potsherd link 9c4d2f18 b2181bfe --note "same migration, two weeks apart"
potsherd link --suggest                          # candidates, never written
```

`link --suggest` proposes and never writes. It also prints its own precision,
in warning colour, because the honest number is not flattering: over 45 cards it
raised **5 candidates from 20, of which 2 are worth accepting**. One of the
three rejects is two unrelated projects joined by a `HANDOFF.md` — a filename
half the archive has. The terminal says that on the screen rather than implying
all five are good.

## Ask it a question — `potsherd ask`

`find` gives you places the answer might be. `ask` gives you the answer, and it
gives you the exchanges it came out of.

```bash
potsherd ask "what did we decide about prepared statements behind the pooler?"
```

```
potsherd ask "what did we decide about prepared statements behind the pooler?"

ANSWER
  The decision was to disable client-side prepared statement caching by setting
  statement_cache_size=0. [1] This was because transaction pooling (via
  pgbouncer) drops session state, so server-side prepared statements don't
  survive across transaction boundaries. [2] A test confirmed the fix: it failed
  with a "prepared statement already exists" error under the old config and
  passed once caching was disabled. [3]

EVIDENCE
  [1] data-pipeline/9c4d2f18  21 aug 09:31  "The change here is one line eithe…"
  [2] data-pipeline/9c4d2f18  21 aug 09:23  "That will hold, but transaction p…"
  [3] data-pipeline/9c4d2f18  21 aug 09:42  "Done. The test fails against the…"

OPEN THREADS
  possible open thread · decided in event-bus, not seen in data-pipeline
      Route delivery consumers to connection pooler on 6432 instead of direct
      postgres on 5432
      event-bus/b2181bfe@1,2  11 aug 11:38

  6 of 61 sessions read · 1 answered · 35.7s · $0.124 est.
  55 matching sessions not read · raise --k to widen
  run  potsherd graft 9c4d2f18  to carry it into the agent you are in
```

[`docs/screens/14-ask.txt`](docs/screens/14-ask.txt), a real run against the
demo corpus — and [`docs/demo-ask.gif`](docs/demo-ask.gif) is the same thing
recorded, all fifty-two seconds of it, including the wait.

Read the last block first. **`ask` reads a shortlist and says how big the
shortlist was** — six of sixty-one here — because an answer drawn from six
sessions is not an answer about your whole archive, and a tool that hid that
would be inviting you to over-trust it. `--k` widens it, at a model call each.

**`--cheap` narrows it**: `k` 3, a haiku-class synthesizer, and a session's card
in place of a long slice wherever a card exists. Measured over ten runs each of
five questions on a real archive, against the default as a control:

| | p50 | cost/run | answered | citations |
|---|---|---|---|---|
| default | 45.0 s | $0.139 | 10/10 | 45/45, 0 faults |
| `--cheap` | 50.5 s | $0.065 | 7/10 | 19/19, 0 faults |

So it is about **half the cost, and it is not faster** — it was called `--fast`
until it was measured. The unit of latency here is a model call rather than a
token: every reader is a separate process, so three readers finish in the wall
time six do, and shrinking what each one reads moves nothing. It reads less, so
it misses more, and the screen says so on every run that uses it.

What happens between the question and the screen:

1. `recall` shortlists `k` sessions — the same fusion `find` uses.
2. one **reader** per session, in parallel, is given that session's excerpts and
   asked for quotes and a fragment. Six calls.
3. one **synthesizer** writes the answer over what the readers returned.
4. **the citation filter runs in code.** Every sentence the synthesizer wrote
   must carry a `[n]`, every `[n]` must point at a quote, and every quote must
   occur in the live transcript bytes at the sequence number it claims. A
   sentence that fails is **dropped, not flagged**, and the footer counts what
   it dropped.

Step 4 is the product. It is not a prompt asking the model to be careful, it is
[`filterAnswer`](packages/core/src/ask.ts) — no model, no database, no clock —
and it is driven in the test suite by a synthesizer written to behave as badly
as one can: quoting sequence numbers that do not exist, quoting text nobody
wrote, paraphrasing what was written, citing a session nobody read, and writing
confident prose with no citations at all.

`--strict` refuses instead of answering when fewer than two quotes survive.
A refusal is not a shorter answer: it prints one line saying there is no
grounded answer, and one line saying **why** — the shortlist, the budget, or
the filter — and no prose at all.

### What it costs, and how long it takes

**`ask` at `k=6` measured 40–183 s over fifteen runs, p50 about 100 s**, and
$0.037–$0.194 of api-equivalent spend. That is five times the 20 s the
architecture originally asked for, and it is structural rather than a missed
optimisation: one haiku-class call through the agent SDK is 60–160 s, and this
is six of them plus a synthesizer. `k` was **not** quietly narrowed to make the
number look better; the target was corrected instead
([phases/phase-4/HANDOFF.md](phases/phase-4/HANDOFF.md)).

Inside Claude Code it is much faster, and free — see
[Inside Claude Code](#inside-claude-code) below.

### The evals

`ask` has its own eval set of ten gold questions and three decoys — questions
whose answer is **not** in the corpus, which must be refused. Three gates, and
the first is the one that fails the build:

```
(a) citations    18 lines · 0 faults        100% required
(b) coverage     8/10                       >= 7/10
(c) refusals     3/3                        refused, exit 2
```

`pnpm evals:ask` runs it. `evals/ask-selftest.ts` proves the scorer behind it:
sixteen hand-built results, no model and no index, each required to fail the one
gate it is named for — because a benchmark that cannot fail measures nothing.

## Carry a session into the one you are in — `potsherd graft`

The last verb, and the one the whole archive is for. `graft` compresses one past
session into a brief small enough to paste into an agent's context.

```bash
potsherd graft 9c4d2f18 --about pgbouncer          # to stdout, and to a file
potsherd graft "the pooler decision" --clip        # by query, to the clipboard
potsherd graft 9c4d2f18 --budget 600               # a harder ceiling
```

```
potsherd graft · claude 9c4d2f18 · 2026-08-21

  Pool ingest workers through pgbouncer
  about  pgbouncer

  tokens                       520   of 1200 budget  ·  est. (chars/3.6)
  citations                    8/8   distinct, and all resolve
  exchanges                      8   data-pipeline
  wrote, unsummarised                ~/work/demo-project/.potsherd/graft-9c4d2f…
  no model call — no model was used

────────────────────────────────────────────────────────────────────────

# Pool ingest workers through pgbouncer

Brief from a past session, about **pgbouncer**. Written by potsherd; every claim carries `[9c4d2f18@seq]`, the exchange it came from.

> **unsummarised.** No model call was made — no model was used. What follows is the stored card and transcript verbatim, not a summary.

**decided**
- Deploy pgbouncer in transaction pooling mode with pool_size=24 — Resolve max_connections exhaustion (412 slots requested vs 400 limit) in ingest workers [9c4d2f18@1] [9c4d2f18@2] [9c4d2f18@7]
- Disable statement caching (statement_cache_size=0) — Transaction pooling mode doesn't preserve server-side prepared statements; disabling cache prevents 'prepared statement already exists' errors [9c4d2f18@3] [9c4d2f18@4]
- Make batch writer idempotent, keyed on source file sha256 plus row offset — pgbouncer restart closes connections without rollback, causing retries to replay partially applied batches; idempotency prevents double-inserts [9c4d2f18@6]
- Document connection pooling configuration in readme — Similar prepared statement issue encountered before in payments-api; documentation prevents relearning the same lesson [9c4d2f18@7]

**from the transcript**
- you: put pgbouncer in front of it in transaction pooling mode agent: That will hold, but transaction pooling drops session state: SET, LISTEN/NOTIFY and server-side prepared statements stop surviving a transaction [9c4d2f18@2]
- you: what happens to an in-flight batch when pgbouncer restarts? agent: The client sees a closed connection rather than a rollback, so a retry replays a partially applied batch unless the writer is idempotent. [9c4d2f18@5]
- you: run the suite and commit agent: All green: 214 passed. Committed as "ingest: pool through pgbouncer in transaction mode". [9c4d2f18@8]

---

source: claude 9c4d2f18-7a3b-4e05-b6d1-0f2a58e17c43 · 8 exchanges · 2026-08-21

  run  potsherd show 9c4d2f18  read the session this came from, end to end
```

[`docs/screens/15-graft.txt`](docs/screens/15-graft.txt). This one is
`--no-model`: the stored card verbatim, labelled unsummarised, which is the path
`graft --help` documents for a machine with no backend.

Three things are load-bearing.

**The budget is a hard ceiling, not a hint.** Measured across real runs:
137/150, 222/1200, 397/1200, 487/1200 tokens. It has never been exceeded.

**Every claim carries `[id8@seq]`**, and the citations resolve: 3/3, 5/5, 7/7,
10/10, 13/13 across five runs. The same filter `ask` uses.

**The last line is the contract.** `source: <harness> <id> · <n> exchanges ·
<date>` tells the agent, and the person pasting it, exactly where the brief came
from — and `graft` writes the same bytes to `./.potsherd/graft-<id8>.md` in the
directory you ran it in, so what you read and what you paste can never be two
different strings.

`--no-model` prints the stored card verbatim, labelled unsummarised, for a
machine with no backend.

## Inside Claude Code

potsherd ships as a Claude Code plugin. Three surfaces, and the last one is the
reason the other two exist.

```
/plugin marketplace add HulkInTherapy/potsherd
/plugin install potsherd@potsherd
```

That is a git clone. It brings the CLI and the MCP server with it — both are
committed as single bundled files under
[`plugins/claude-code/dist/`](plugins/claude-code/dist) — and neither needs
`npm install`, a build step, or a native module. See
[Install](#install) for why that is worth a sentence.

**1. `/potsherd <verb>` — every verb, from the chat box.** `/potsherd audit`,
`/potsherd find pgbouncer`, `/potsherd graft 9c4d2f18 --about pooler`. The skill
runs the plugin's own bundled binary by absolute path, never a bare `potsherd`
that might be a different version, and it is told to print what the binary
printed rather than reformat it.

`/potsherd ask` takes a different route, and it is faster and free: the binary
records what the six readers would be given (`ask --readers-out`, **zero model
calls — the recorder is passed in as the reader function, so no reader backend
is constructed at all**), Claude dispatches the six readers with its own Agent
tool in parallel, and the binary makes the **one** synthesizer call and runs the
same code-level citation filter over the reply. Measured on a one-session
fixture: 21.8 s / 2 calls → 8.2 s / 1 call, and that 2.6× is a floor — the real
shape is six readers at once.

**2. `remembering-sessions` — the skill that fires without being asked.** It is
model-invocable and not a slash command. Its whole job is one `description`
field, because that field is the only thing that decides whether the model
reaches for your archive instead of saying it was not there. It dispatches
`session-archaeologist`, a haiku-class agent whose tools are five potsherd MCP
tools and `Read`.

Tested in print mode, with a control:

```
"what did we decide about pgbouncer … last month?"  → Skill → Agent
                                                      → 5× potsherd_find, 1× potsherd_ls
"what does a connection pooler do, in general?"     → NO TOOLS. answered directly.
```

**3. Two hooks.** `SessionStart` takes a copy before the sweep can run — a
detached `rescue`, measured at **6.5–10.5 ms** of hook time on the no-change
path (the work itself runs after the hook returns: with the archive wiped so
the rescue had real work, the hook came back at 7.0 ms while the archive filled
0 → 36 → 180 → 283 files over the next 1.75 s). `SessionEnd` indexes the session
that just finished. Total added to a session start, including the capability
probe below: **128–146 ms** over three runs of ten.

Neither hook can fail quietly. `SessionEnd` has no channel to the user at all —
Claude Code discards its `systemMessage` by design — so a failure is written to
`hook-failures.log`, and the **next** `SessionStart` reads it out and clears it.
That exists because of a real bug: the hooks used to resolve `potsherd` from
`PATH` first, and on the machine this was built on `PATH` held a stale 0.1.0
with no `index` verb, so `SessionEnd` exited 0 having indexed nothing, forever,
with the error going to `/dev/null`.

### The strongest single result in the build

The same question, twice, in the same repository:

```
grafted session, resumed     1 turn  ·  5.9 s ·  0 tool calls
                             correct, and it carried its source line
the same question, no brief  16 turns · 88 s  · 15 tool calls
                             confidently WRONG, about a different event,
                             citing a real commit hash
```

**The failure this addresses is not silence. It is a plausible answer assembled
from whatever is nearest to hand.**

## Other agents — `potsherd setup`

The same six tools, over MCP, in whatever you use.

```bash
potsherd setup --status        # the seven clients, and how far each was checked
potsherd setup --claude        # writes one "potsherd" entry, after a diff and a y
potsherd setup --cursor --dry-run
```

`setup` never clobbers. It reads the config, adds one `"potsherd"` server entry,
shows you the unified diff, waits for a `y`, and writes a timestamped backup
beside the file first. Every other server in that file is preserved.

Seven clients are supported and **three of them were verified against a real
tool or a real config file on this machine; four are from documentation only.**
That distinction is not a footnote — it is a field on each client, printed as
`unverified` on the consent screen, written into
[`docs/mcp-clients.md`](docs/mcp-clients.md), and asserted by a test. The
weakest is pi: the real `~/.pi/agent/settings.json` has no MCP key at all.

The server is six tools and stays six: `potsherd_find`, `potsherd_read`,
`potsherd_ask`, `potsherd_graft`, `potsherd_ls`, `potsherd_tag`. One competitor
in this space ships 54, which is the anti-pattern.

## Take it somewhere else — `potsherd export`

```bash
potsherd export --to markdown ./vault                # one file per card
potsherd export --to markdown ./vault --transcripts  # and the conversations
potsherd export --to agentmemory                     # dry run: what it would push
potsherd export --to agentmemory --yes               # actually write
```

Your archive is a sqlite file and a directory of your own transcripts. `export`
is there so it is never a lock-in: markdown out, or rows into another memory
tool's store — and writing into somebody else's store needs `--yes` every time.

`potsherd find --with claude-mem` reads three other tools' stores read-only and
federates them into one result list, concurrently. `hindsight` is a target
`export` **refuses**, and says why, rather than pretending.

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
the derived index — the thing that gets queried, embedded and, in `card`, `ask`
and `graft`, put in front of a model. It does not get to alter your evidence.

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
    …and these, only when you name them with  --with / --to:
    ~/.claude-mem/claude-mem.db
      claude-mem, or wherever CLAUDE_MEM_DATA_DIR points. read-only.
    <agentmemory's app-data dir>
      ~/Library/Application Support/agentmemory on macOS, $XDG_DATA_HOME
    <cwd>/CLAUDE.md, and .claude/CLAUDE.md above it
      the notes bridge, walking up from the directory you run in.
    ~/.claude/projects/<slug>/memory
      Claude Code's own auto-memory for this project. read-only.

  writes:
    ~/.potsherd
    ~/.potsherd/archive
    ~/.potsherd/potsherd.db
    ~/.potsherd/models
    ~/.potsherd/config.json
      your settings: the ignore list, written by potsherd ignore / unignore
    ~/work/demo-project/.potsherd/graft-<id8>.md
      only when you run graft, in the directory you run it in
    <the path you give to  ask --readers-out>
      only when you pass the flag. it holds the same redacted excerpts a model
      would have been sent, and no model was called to write it
    <the dir you give to  export --to markdown>
      one markdown file per card, only when you run export
    <your agentmemory store>  — export --to agentmemory --yes
      rows into another tool's store. never without --yes, and never at all
      unless you asked for that target

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
      one "potsherd" MCP server entry each, from potsherd setup. every other
      server in those files is preserved.
    …and beside each of those 8:  <that file>.potsherd-bak-<UTC>
      a copy of the file as it was, taken before potsherd changes it. one per
      write. potsherd never reads them back and never removes them; delete them
      yourself once you are happy with the change.

  leaves this machine:
    redacted slices of your transcripts, sent to a model as the text of one
    prompt. redaction runs first, in one place, on every outgoing string —
    there is no --no-redact flag. nothing else is ever sent: no file is
    uploaded, no path, no index, no counts, no identifiers.

  only these verbs call a model:
    potsherd card      writes the cards; one call per slice
    potsherd ask       one call, over the shortlist it retrieved
    potsherd graft     one call, to compress one session into a brief

  these never do, and open no socket at all:
    audit, rescue, guard, index, ls, show, stats, tag, pin, unpin,
    link, setup, stack, ignore, unignore, doctor

  these call no model either, but do open a socket on
  this machine — and only when you ask them to:
    potsherd find      --with <tool>, to read another tool's store
    potsherd export    --to <tool>, to write rows into one
      claude-mem is read over http://127.0.0.1; agentmemory by launching its
      mcp server, itself a shim over an http backend on localhost. nothing
      leaves this machine, and without the flag neither opens anything at all.

  who receives them:
    your own Claude subscription, via ~/.claude/local/claude
    the same binary and the same account you already use by hand.
    potsherd holds no key, no token and no account of its own.
    the call runs with no tools, in an empty scratch directory, and
    its session is never written to ~/.claude/projects.

  no other network, except the one-off embedding-model download,
  and only when you ask for it.
  A plain `potsherd index` fetches nothing: text search is the default, it
  needs no model, and it opens no socket at all. `potsherd index --embed` is
  what asks for the model, and it names the download before it starts — but
  `--quiet` and `--json` suppress that line, and `--quiet` is how the plugin's
  SessionEnd hook runs it, so its SessionStart hook warns you first.
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

## Where potsherd sits in the memory stack

potsherd is not the only tool reading your transcripts, and it is not trying to
be all of them. There are four distinct failures in agent memory — the context
window degrading inside a session, context not carrying between sessions, the
transcript itself being deleted, and getting the thing you found back into a
live agent. **potsherd is scoped to the last two.** The first belongs to your
harness and the second to claude-mem and Claude Code's own auto memory.

[`docs/memory-stack.md`](docs/memory-stack.md) is the long version: the four
failures, which of eight tools covers which of them, every claim with the URL
it was read from, and every licence. `potsherd stack` prints the same table
against what you actually have installed:

```bash
potsherd stack                    # the table, against what you have installed
potsherd stack --sources          # every claim, with the url it was read from
potsherd stack --paths            # why a tool you have installed reads as absent
potsherd stack --json | jq '.tools[] | select(.present)'
```

If that table ever shows potsherd winning all four rows, that is a bug in the
table.

## Install

There are three ways in, and **none of them needs a package registry**. potsherd
is not on npm yet — `npm view potsherd` is a 404 today — and publishing is a
thing a person does, not an agent
([`docs/release/npm.md`](docs/release/npm.md)).

### As a Claude Code plugin — one clone, nothing to build

```
/plugin marketplace add HulkInTherapy/potsherd
/plugin install potsherd@potsherd
/potsherd audit
```

That is a `git clone` and nothing else. It works because the plugin carries its
own bundled CLI and MCP server —
[`plugins/claude-code/dist/`](plugins/claude-code/dist), two committed files —
and because neither of them needs a `node_modules` to start.

**That includes the database.** `better-sqlite3` is a native addon and cannot be
vendored into one file, so potsherd falls back to `node:sqlite`, which Node
ships itself. The whole 1,532-test suite runs green under it in CI, on the same
matrix as the addon, because a fallback nobody exercises is not a fallback.
`potsherd doctor` prints which one you are on.

Measured on a fresh Debian container with no `node_modules` anywhere, on **Node
22.23.2 and 24.19.0**: clone, then `audit` — **117 ms** — then `rescue`,
`index` (228 transcripts, 333 ms), `ls`, `find`, `show --html`, `audit
--verify`, and an MCP server answering `tools/list` with all six tools.

That was not true until v1.0.0. Before it, a marketplace install produced a
plugin with no CLI and no MCP server: all six tools vanished from the client and
the `session-archaeologist` agent was left holding `Read`.

### From a checkout

```bash
git clone https://github.com/HulkInTherapy/potsherd
cd potsherd
pnpm install && pnpm build

node packages/cli/bin/potsherd.js audit
node packages/cli/bin/potsherd.js rescue
node packages/cli/bin/potsherd.js index
node packages/cli/bin/potsherd.js find "something you argued about in june"
```

`potsherd setup --claude` (and the plugin) write the absolute path to that
`bin/potsherd.js` into their config, so nothing depends on a global install.

### From a tarball

```bash
cd packages/cli && npm pack
npm install -g ./potsherd-1.0.0.tgz
potsherd audit
```

**17 MB, and about 1.6 s.** Everything heavy is an optional peer dependency and
none of it is installed unless you ask: the two model SDKs and the embedding
runtime are 677 MB of what used to be a 764 MB install, for features most people
will never turn on. Without them, everything that reads your own files works and
the three verbs that call a model refuse with one sentence naming the one
command that fixes it.

```bash
npm install -g @anthropic-ai/claude-agent-sdk   # card, ask, graft
npm install -g @huggingface/transformers         # vector search
npm install -g sqlite-vec                        # ...and its sqlite half
```

### What it needs

Node **22 or newer**, and nothing else. If your Node has `node:sqlite`
unflagged — 22.23.2 and 24.19.0 both do — everything works with no install at
all. If it does not, and `better-sqlite3` is not there either, then `audit`,
`rescue`, `guard` and `doctor` work and nothing that reads the index does;
`potsherd doctor` says which situation you are in rather than leaving you to
find out one verb at a time.

`CLAUDE_CONFIG_DIR` is honoured; `--claude-dir` overrides it. Every verb takes
`--json`, `--no-color`, `--ascii` and `--width`.

## What shipped, and when

Eight phases, each verified against a real corpus before the next began. Every
one has a `HANDOFF.md` and a `VERIFICATION.md` under
[`phases/`](phases) recording what it measured, what it missed, and what it left
open — including the numbers that did not meet their targets.

| phase | what it added | tag |
|---|---|---|
| 0 | `audit`, `rescue`, `guard`, `doctor` | `v0.1.0` |
| 1 | the parser, sidechains, codex/cursor/pi adapters, redaction, `index` `ls` `find` `show` `stats` | `v0.2.0` |
| 2 | `llm.ts`, verified cards, ghost cards, `tag` `pin` `link` | `v0.3.0` |
| 3 | six-list hybrid recall, 25-query evals, `find --explain` | `v0.4.0` |
| 4 | `ask` with a code-level citation filter, `graft`, open threads | `v0.5.0` |
| 5 | the MCP server, the Claude Code plugin, `setup`, the privacy guard | `v0.6.0` |
| 6 | gemini/opencode/copilot adapters, three bridges, `export`, `stack` | `v0.7.0` |
| 7 | the install story, the readme, the screens, `show --html`, the cast | **`v1.0.0`** |

The verifier that read each phase's work was never its author, and it has found
something every single time: **12 · 8 · 9 · 7 · 13 · 15 · 14**. That run has
never fallen, and the largest single defect in it was the orchestrator's own, at
integration, and it shipped green.

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

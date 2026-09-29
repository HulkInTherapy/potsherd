# the memory stack, explained

There are a lot of memory tools for coding agents, and most of them are good at
something different. This page says which does what, and — the part that
matters — **which two things potsherd deliberately does not do**.

```
potsherd stack
```

runs the same table against your machine and tells you what you have installed.

---

## the four failures people call "losing context"

They are not one problem. They are four, they bite at different moments, and
two of them are already solved by other people.

| # | failure | when it bites | state of the art |
|---|---|---|---|
| 1 | **context rot** — the model degrades inside one long session | during a session | solved: compaction, subagents, handoff docs, long windows |
| 2 | **cold start** — the next session in the *same* repo knows nothing | next day, same repo | solved: CLAUDE.md, auto memory, claude-mem, agentmemory |
| 3 | **archive amnesia** — you know you solved it, not when, not which project, not which session | weeks later, any project | **unsolved** |
| 4 | **re-entry** — you found the session, now get its context into the live agent | after you found it | **unsolved** — the tools that search are read-only |

**potsherd is scoped to 3 and 4.** That is the whole product, and everything
below follows from it.

## what potsherd does not do

- **Failure 1 is not in its reach.** potsherd is not in your session. Whatever
  your harness does about a degrading context window — compaction, subagents,
  a bigger window — it does without potsherd.
- **Failure 2 it refuses on purpose.** There is no injection at SessionStart.
  That lane belongs to claude-mem, and Claude Code's own auto memory is free,
  on by default, and documented to survive the retention sweep. Pull, not push:
  the way context gets into a live agent is `potsherd graft <session>`, which
  you run, and which writes a brief you paste.
- **No knowledge graph.** hindsight and greplica build graphs. potsherd does
  sessions, cards, tags and links. `potsherd export --to markdown <dir>` writes
  every card as a file, which is what a graph tool can be pointed at; a direct
  `--to hindsight` is **not built** and exits 1 saying so.
- **No server, no account, no telemetry.** SQLite in `~/.potsherd`, and a
  `--json` flag on every verb as the API.

If the table in `potsherd stack` ever shows potsherd winning all four rows,
that is a bug in the table.

---

## the tools

> **How each row was checked — read this before the table.**
> **potsherd's row was measured by running potsherd on the machine this page
> was written on. Every other row was read from that project's own
> documentation on [22 aug 2026](#sources-and-what-was-fetched) and was never
> run here.** That is not an even comparison and it runs in potsherd's favour,
> so it is said here, above the table, rather than only in the `claim checked`
> column beside each row. potsherd does not have these tools installed and does
> not claim to have exercised them. `potsherd stack` prints the same sentence
> above the same table in your terminal.
>
> The honest repair is not to grade potsherd by its docs too — it is the one
> tool here that was actually run — it is to say so where nobody can miss it.
> If the table ever shows potsherd winning all four rows, that is a bug in the
> table.

Coverage: **✓** covers it · **~** partly, with a caveat · **·** does not.

| tool | licence | 1 | 2 | 3 | 4 | claim checked |
|---|---|:--:|:--:|:--:|:--:|---|
| potsherd | MIT | · | · | ✓ | ✓ | this program |
| claude-mem | Apache-2.0 | · | ✓ | · | · | docs only |
| agentmemory | Apache-2.0 | · | ✓ | ~ | ~ | docs only |
| hindsight | MIT | · | ✓ | · | ~ | docs only |
| episodic-memory | MIT | · | ~ | ~ | · | read off this machine |
| greplica | MIT | · | ~ | · | ~ | docs only |
| superbrain | MIT | · | ✓ | · | · | docs only |
| CLAUDE.md / auto memory | built into Claude Code | · | ✓ | · | · | files read here, behaviour from the docs |

**"docs only" means exactly that** — see the note above the table. Every url
and every fetch date is in [sources](#sources-and-what-was-fetched).

### claude-mem — `thedotmack/claude-mem`

Five lifecycle hooks (SessionStart, UserPromptSubmit, PostToolUse, Stop,
SessionEnd) writing to SQLite under `~/.claude-mem/`, and its README says
*"Context from previous sessions will automatically appear in new sessions."*
That is failure 2, done well, for a very large number of people.

Where it stops for failures 3 and 4: its README documents no way to import
sessions from **before** you installed it. Everything older than your install
date is outside it, and how much that is depends entirely on when you
installed — it is not a measured quantity and this page will not invent one.
What *was* measured on the reference machine is a different number about a
different thing: **93% of sessions ever started (299 of 321) had already been
deleted by the 30-day sweep** (`plans/01` §3). Those 299 are outside claude-mem
too, because their transcripts no longer exist for any tool to import. Detected
at `~/.claude-mem`.

**Licence: Apache-2.0.** This project's own research notes had guessed
"AGPL-ish? check before linking". The GitHub licence API says Apache-2.0, so
reuse with attribution is allowed after all.

### agentmemory — `rohitg00/agentmemory`

The only tool on this list that backfills. `npx @agentmemory/agentmemory
import-jsonl` reads existing Claude Code transcripts out of `~/.claude/projects`.
That is a real partial answer to failure 3, and its 54 MCP tools give a live
agent on-demand search, which is a partial answer to failure 4.

The caveat is one its own README states: *"Claude Code's cleanupPeriodDays (in
`~/.claude/settings.json`, default 30) auto-deletes JSONL transcripts older than
that window from `~/.claude/projects/`."* `import-jsonl` can only import what
the sweep has not already taken. `potsherd audit` tells you how much that is.

Detection note: agentmemory does **not** use `~/.agentmemory`. Its README puts
state in the platform app-data directory — `~/Library/Application
Support/agentmemory` on macOS, `$XDG_DATA_HOME/agentmemory` or
`~/.local/share/agentmemory` on Linux. `potsherd stack` checks both.

**Licence: Apache-2.0.**

### hindsight — `vectorize-io/hindsight`

`retain` / `recall` against isolated memory banks — *"A bank is an isolated
memory store — one 'brain' for one user, agent, or project."* Installed for
coding agents with `npx @vectorize-io/hindsight-coding-agents install all`.
Needs PostgreSQL, or its embedded `pg0`.

Where it stops: banks are per-project, and the documentation does not describe
importing existing Claude Code transcripts. It is a natural **export target**
rather than a competitor — but the direct route is not built: `potsherd export
--to hindsight` exits 1 with *"it needs @vectorize-io/hindsight-client, and
potsherd adds no dependency for it (04: postgres and a python runtime are too
heavy to embed)"*. `export --to markdown <dir>` is the route that exists.

**Licence: MIT.**

### episodic-memory — `obra/episodic-memory`

**potsherd is forked from it**, and it is credited in `NOTICE` and the README.
It indexes `~/.claude/projects` and `~/.codex/sessions` into SQLite with
`sqlite-vec` embeddings and searches across every project — the closest thing
on this list to failure 3.

Two caveats keep it at `~` rather than `✓`. Its search hard-codes
`AND e.is_sidechain = 0`, which excludes subagent transcripts — 197 of the 227
transcript files on the reference machine, 87% of them. And it is read-only:
there is no way to put what it found back into a live agent, which is failure 4.

Detected at `~/.config/superpowers/conversation-index/db.sqlite` — it ships
inside the superpowers marketplace, so it is not under a directory named after
itself. On the reference machine that index exists and holds **zero exchanges**:
installed, never synced.

**Licence: MIT.**

### greplica — `Autoloops/greplica`

A per-repo knowledge graph of components, flows and claims, seeded from
transcripts: `greplica transcript bundle` converts *"Codex, Claude Code, GitHub
Copilot CLI, or OpenCode transcripts into a sanitized Markdown bundle"*.

Where it stops: the scope is one repository. Its own install flow starts with
`cd /path/to/your/repository-or-fork`. It cannot answer *"which project was that
in"*, which is the question failure 3 is made of.

**Licence: MIT.**

### superbrain — `m3talux/superbrain`

Session memory for Claude Code into a plain Obsidian markdown vault at a fixed
path: *"SuperBrain writes to its own vault at `~/.superbrain/vault` — a fixed,
predictable location with no environment variables to set."* Hooks on
PostToolUse / UserPromptSubmit / PreCompact / SessionEnd, with *"a user-visible
hybrid brief on session start"*.

Where it stops: capture-only from the moment you install it. Nothing before that
exists to it.

**Licence: MIT.**

### CLAUDE.md and auto memory — built into Claude Code

The one on this list you already have. From the Claude Code docs: CLAUDE.md and
auto memory are *"Both loaded at the start of every conversation"*, with auto
memory in `~/.claude/projects/<project>/memory/` and its `MEMORY.md` index
loaded up to *"the first 200 lines of MEMORY.md, or the first 25KB"*.

The fact worth knowing: **the memory directory survives the retention sweep.**
*"Claude Code deletes old session transcripts after the `cleanupPeriodDays`
retention period, but excludes the files in the memory directory from that
retention sweep."* Along with `~/.claude/history.jsonl`, it is one of the few
things that outlives a deleted session — which is why potsherd bridges to it
rather than replacing it.

Where it stops: scope is *"per repository, shared across worktrees"* and
*"machine-local"*. There is no cross-project view and no search of past
sessions.

---

## overlaps: what to turn off

`potsherd stack` flags two kinds of collision between the tools you actually
have installed.

**double-capture** — two or more tools with hooks writing a record of the same
session into two stores. It costs disk and it costs hook latency on every tool
call, and afterwards neither store is authoritative. Keep one.

**double-inject** — two or more tools pushing text into the context window at
session start. This is the expensive one: it is spent from the same budget as
your actual work, every session, whether or not it gets used. claude-mem's own
power user on the result: *"never saw them surface unless i asked."* Keep one
injector; the others can stay as on-demand search.

## the recommended stack

One owner per failure.

| # | failure | run |
|---|---|---|
| 1 | context rot | your harness. compaction and subagents. nothing to install. |
| 2 | cold start | whichever of claude-mem / agentmemory / superbrain you already have — or CLAUDE.md and auto memory, which are free and already on. |
| 3 | archive amnesia | potsherd |
| 4 | re-entry | potsherd — `graft` |

`potsherd stack` prints this filled in with what is actually on your machine.

---

## sources, and what was fetched

Every claim above was read on **22 August 2026** from the source named. Licences
and star counts came from `https://api.github.com/repos/<owner>/<repo>` the
same day; the rest came from each project's own README or documentation site.

| tool | fetched | licence reported |
|---|---|---|
| claude-mem | `https://raw.githubusercontent.com/thedotmack/claude-mem/main/README.md` + `https://api.github.com/repos/thedotmack/claude-mem` | Apache-2.0 |
| agentmemory | `https://raw.githubusercontent.com/rohitg00/agentmemory/main/README.md` + `https://api.github.com/repos/rohitg00/agentmemory` | Apache-2.0 |
| hindsight | `https://raw.githubusercontent.com/vectorize-io/hindsight/main/README.md` + `https://api.github.com/repos/vectorize-io/hindsight` | MIT |
| episodic-memory | `https://api.github.com/repos/obra/episodic-memory`, plus the local index at `~/.config/superpowers/conversation-index/db.sqlite` | MIT |
| greplica | `https://raw.githubusercontent.com/Autoloops/greplica/main/README.md` + `https://api.github.com/repos/Autoloops/greplica` | MIT |
| superbrain | `https://raw.githubusercontent.com/m3talux/superbrain/main/README.md` + `https://api.github.com/repos/m3talux/superbrain` | MIT |
| CLAUDE.md / auto memory | `https://code.claude.com/docs/en/memory` | n/a, part of Claude Code |

A claim about someone else's tool is perishable. `potsherd stack` prints the
fetch date on every run, so a table that has gone stale says so.

Detection is `existsSync` on the paths above and nothing else — no spawn, no
probe, no HTTP, and no read of another tool's database. `potsherd stack
--paths` prints every path it looked at, which is how you diagnose a tool that
is installed somewhere non-default and reads as absent.

---

## `potsherd link --suggest`

A second, smaller thing in the same honest spirit.

```
potsherd link --suggest
```

proposes cross-project links from card topic and file overlap, using the same
rule pass that powers `potsherd ask`'s open threads. **It never writes a link.**
Each row ends with the command that would create it, and you type it.

The number it prints, and the reason it prints it: on the reference corpus that
rule raised 8 candidates. **8 of 8 were genuinely absent from the other
project, but only 1–2 of the 8 were worth raising.** The absence half of the
rule is reliable; the usefulness half is mostly noise. Two failure modes
account for the rest — unrelated projects joined by a generic filename like
`HANDOFF.md`, and decisions that were only ever local to one project.

So `--suggest` shows five by default, tells you the measured rate in the
output, and says plainly: expect most of these to be wrong. Read one with
`potsherd show <id8>` before you accept it.

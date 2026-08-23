# potsherd — Claude Code plugin

Claude Code deletes transcripts older than 30 days. On the machine this plugin
was built against, that had already taken **299 of 334 sessions and 2,971
prompts**. This plugin exists so that number stops growing without you having
to remember anything.

Verified against **Claude Code 2.1.239**. Every hook field, environment
variable and manifest key below was checked against the live docs and against a
real install, not from memory — see [What was verified](#what-was-verified).

---

## What it installs

| Component | What it does |
|---|---|
| `SessionStart` hook | Runs `rescue` detached, so a copy of every transcript exists before the next sweep. **Measured 6.5–10.5 ms** of hook time on the no-change path. |
| `SessionStart` hook (brief) | Off by default. When enabled, injects a short list of recent sessions if this project has been untouched for 7+ days. |
| `SessionEnd` hook | Indexes the session that just ended, detached, so `potsherd ls --since 1h` finds it. Cards it too, but only if you opt in. |
| MCP server `potsherd` | Three tools with disjoint jobs: `potsherd_recall`, `potsherd_read`, `potsherd_graft`. |
| Skills and agent | `/potsherd <verb>`, plus a `remembering-sessions` skill the model reaches for on "last time…" questions. |
| `bin/potsherd` | The shim every skill routes through. See [Which potsherd runs](#which-potsherd-runs). |

Component cost, from `claude plugin details potsherd@potsherd`:

```
  Hooks (2)  SessionStart, SessionEnd  (harness-only — no model context cost)
  MCP servers (1)  potsherd  (tool schemas resolved at runtime; not counted)
  Projected token cost
  Always-on:   ~0 tok   added to every session
```

---

## Install

### 1. You need a `potsherd` binary — build it from a checkout

**Do this first.** The plugin ships configuration, not a program. A marketplace
install is a git clone, and this repository gitignores `dist/`, so a clone
contains no built binary and no `node_modules`.

> **`potsherd` is not published to npm.** `npm i -g potsherd` is a 404 today,
> and every earlier version of this file, of the shim's error message and of
> the `SessionStart` hook printed it anyway. Publishing is phase 7's. Until
> then the only instruction that works is the one below.

```sh
git clone https://github.com/HulkInTherapy/potsherd
cd potsherd
pnpm install && pnpm build
```

Then install the plugin **from that checkout** (`/plugin marketplace add
<the path you just cloned into>`), so that `bin/potsherd` finds the bundle two
directories up from itself. Installing from `HulkInTherapy/potsherd` on GitHub
clones a *second* copy with no `dist/` in it, and that copy is what the plugin
will look beside.

Without a built potsherd the hooks take no copy, `/potsherd` runs nothing, and
**all three MCP tools are absent** — which also leaves `session-archaeologist`
holding nothing but `Read`, so it answers "not found" to everything. None of
that is silent: the hook prints a `systemMessage` naming the problem, the shim
exits `127` listing the three places it looked, and `bin/potsherd-mcp` writes
the same list to the MCP server log.

### 2. Add the marketplace and install the plugin

```sh
/plugin marketplace add HulkInTherapy/potsherd
/plugin install potsherd@potsherd
```

Then restart Claude Code. Confirm it loaded:

```sh
claude plugin list          # Status: ✔ enabled
claude plugin details potsherd@potsherd
```

`Status: ✘ failed to load` means the hooks are not running. Do not assume a
listed plugin is a working one.

### Developing against a checkout

```sh
claude --plugin-dir plugins/claude-code
```

The hooks and the shim both prefer a built checkout over anything global, so
this runs the code you just changed rather than your installed copy.

---

## Which potsherd runs

`bin/potsherd` decides, and it is the **only** thing that decides. The three
hooks call it and resolve nothing themselves. Until T5.9 they each carried
their own copy of the logic below, inline in `hooks.json`, with steps 1–3
reversed — so on a machine with `0.1.0` on `PATH` and `0.4.0` in the checkout,
every hook ran `0.1.0`, `index` did not exist, and the error went to
`/dev/null`. Nothing was indexed and nothing said so.

The order:

1. `${CLAUDE_PLUGIN_ROOT}/dist/potsherd.js` — vendored in the plugin
2. `${CLAUDE_PLUGIN_ROOT}/../../packages/cli/…` — the surrounding checkout, if built
3. `potsherd` on `PATH` — a global install
4. nothing — say so loudly, exit non-zero

The plugin's own copy wins over `PATH` on purpose. The plugin carries a version
and speaks a pinned archive format; a stale global answering for a newer plugin
is a confusing failure. During development this machine had `0.1.0` on `PATH`
and `0.4.0` in the checkout, and the shim correctly chose `0.4.0`.

Today a **marketplace install always lands on step 3**, because steps 1 and 2
need `dist/` plus a `node_modules` with `better-sqlite3` and `sqlite-vec` built
for your platform. The esbuild bundle is a single file but still resolves those
two through `createRequire`, so it is not self-contained. That is why step 1 of
the install is not optional.

### …and what happens when it is too old

Landing on step 3 can find a `potsherd` that runs but predates the verb the
hook needs. `SessionStart` therefore asks it directly — `index --help`, the
exact verb `SessionEnd` will run — and if that fails it says so in a
`systemMessage` naming the version it found, instead of promising a copy it
cannot take. A capability probe rather than a version comparison, because the
question is "can it do this?", not "what number does it call itself?".

It costs a **measured 128–146 ms** on `SessionStart` with nothing else to do,
over three runs of ten (28 ms before it existed; almost all of the difference
is Node starting the bundle, which nothing can make cheaper). It runs once per
session, before the detached `rescue`.

`SessionEnd` cannot talk at all — Claude Code discards its `systemMessage` by
design — so when it fails it appends a line to
`~/.potsherd/hook-failures.log`, and the next `SessionStart` reads that line
out and clears the file. Between the probe and the log there is no path where a
hook fails and nobody is told.

---

## Do not rename the plugin or the MCP server

Both are literally `potsherd` — `name` in `.claude-plugin/plugin.json`, and the
server key in `.mcp.json`. Claude Code derives MCP tool names from both:

```
mcp__plugin_<plugin-name>_<server-name>__<tool-name>
  →  mcp__plugin_potsherd_potsherd__potsherd_recall
```

`agents/session-archaeologist.md` names its tools in that full form. **Rename
either one and the agent does not fail to load — it loads with no tools at
all**, and the only symptom is an archaeologist that always answers "not
found". If you must rename either, change the agent's `tools:` line in the same
commit.

---

## Configuration

Both switches live in `~/.potsherd/config.json` and are **off** unless the file
contains a literal `true`:

```json
{
  "cardOnEnd": false,
  "briefOnStart": false
}
```

**`cardOnEnd`** — card each session as it ends. Off by default because a card
is a model call: `card --all` measured 55m 25s for 35 sessions. Indexing on
`SessionEnd` happens either way; only the card is gated.

**`briefOnStart`** — inject recent-session titles when a project has been
untouched for 7+ days. Off by default because it puts text into your context
that you did not ask for. Costs about 25 ms to decline; about 725 ms when it
runs. Capped at 4,800 characters (~1,200 tokens).

### Turning off a single hook

There is no per-hook switch. Delete the entry you do not want from
`hooks/hooks.json` in your installed copy and restart Claude Code —
`claude plugin details potsherd@potsherd` will then show one fewer hook. A
plugin update overwrites that edit, so prefer disabling the whole plugin if you
want it to stick.

---

## What it does to your machine

potsherd's ground rule is that other tools' directories are read-only inputs.
This plugin holds to it: **it never writes to `~/.claude`.** That is the
difference between it and `potsherd guard`, which asks permission to add a hook
to your `settings.json`. If you are using this plugin you do not need `guard`.

| Path | Access |
|---|---|
| `~/.claude/**` | read only |
| `~/.potsherd/**` | read and write — the archive, index and config |
| `~/.potsherd/models/` | written once, on first index: a 32.4 MB local embedding model |
| `~/.potsherd/hook-failures.log` | appended by `SessionEnd` when it could not index; read out and cleared by the next `SessionStart` |
| `./.potsherd/graft-<id>.md` | written by `graft` only, in the cwd, when you ask for it |
| `/tmp/potsherd-readers-*.json` | written by `/potsherd ask`, which routes through `ask --readers-out` / `--readers-in`. Holds the shortlisted excerpts, redacted exactly as they would be sent to a model. |

Run `potsherd doctor --privacy` for the authoritative list; it is checked in CI.

Two things worth knowing before you enable anything:

- The **first** `SessionEnd` after install downloads the 32.4 MB embedding model
  (`Xenova/bge-small-en-v1.5`). It is detached, so it never delays a session.
  You are told before it happens: the `SessionStart` hook checks whether the
  model is on disk and warns you if it is not, because `SessionEnd` itself
  cannot — Claude Code discards a `SessionEnd` hook's `systemMessage` by
  design. The pure-shell model check costs about 4 ms and prints nothing once
  the model is cached; the capability probe beside it costs 128–146 ms (above). If you would rather it never happened, disable the `SessionEnd` hook
  (see below) and index by hand; `index` no longer fetches a model unless you
  pass `--embed`, and the cost is vector search on new sessions.
- Model calls happen only for `card`, `ask` and `graft`. The hooks call a model
  only if you set `cardOnEnd`.

---

## Uninstall

### Remove the plugin

```sh
/plugin uninstall potsherd@potsherd
/plugin marketplace remove potsherd
```

or, outside a session:

```sh
claude plugin uninstall potsherd@potsherd
claude plugin marketplace remove potsherd
```

Restart Claude Code. The hooks stop immediately; nothing is left in
`~/.claude` because nothing was put there.

### Remove the binary

```sh
npm uninstall -g potsherd
```

### Remove the archive — only if you mean it

Your rescued transcripts live in `~/.potsherd/archive`, and for most of them it
is the **only** remaining copy: Claude Code already deleted the originals.
Deleting this directory is not undoable.

```sh
potsherd ls --ghosts only        # what only exists here
rm -rf ~/.potsherd               # after you have read the line above
```

### If you also ran `potsherd guard`

`guard` is the pre-plugin path and edits `~/.claude/settings.json` directly.
The plugin does not remove it — potsherd does not touch that file without
being asked:

```sh
potsherd guard --status          # is it installed, and does its command still run?
potsherd guard --remove          # shows the diff, asks, then removes the hook
```

`guard` may also have set `cleanupPeriodDays` in `~/.claude/settings.json`.
That key is what stops the 30-day sweep. **Removing it resumes deletion**, so
it is left alone; edit it by hand if you want it gone.

---

## What was verified

Against Claude Code **2.1.239** and the live docs at
`code.claude.com/docs/en/{hooks,plugins-reference,plugin-marketplaces}.md`:

| Thing | Result |
|---|---|
| `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PROJECT_DIR` | exist in hook commands |
| `CLAUDE_SESSION_ID` | **does not exist.** The session id is read from the hook's stdin JSON (`session_id`) |
| `hooks.json` top level | `{"hooks": {"SessionStart": [...]}}` — the outer `hooks` key is required |
| `SessionStart` matchers | `startup`, `resume`, `clear`, `compact`, `fork`; `"startup\|resume"` is a list of exact strings, not a regex |
| `SessionEnd` | exists, cannot block, cannot add context, shares a 1.5 s budget |
| `additionalContext` | valid under `hookSpecificOutput` for `SessionStart` |
| `${CLAUDE_PLUGIN_ROOT}` in `.mcp.json` | interpolates |
| marketplace path | `.claude-plugin/marketplace.json` **at the repository root**; sources resolve relative to it |
| `claude plugin validate` | passes on both the plugin and the marketplace |

A caveat that cost a debugging cycle and is worth repeating: **`claude plugin
validate` passed on a manifest that failed to load.** Declaring
`"hooks": "./hooks/hooks.json"` duplicates the file Claude Code already loads
by convention, and the whole plugin is dropped. Only a real install caught it.
Verify with `claude plugin list`, not with the validator alone.

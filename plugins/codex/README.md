# potsherd — Codex plugin

Indexes each Codex thread as it ends, and exposes your whole session archive to
Codex over MCP.

> ### Read this before you trust anything below
>
> **`codex` was not installed on the machine this plugin was written on.** It
> has never been loaded by Codex, and no command in the *Install* section below
> has been run. What was available instead was Codex's own source, its live
> docs, and a real `~/.codex` on disk with real threads in it — so a lot here is
> checked, just not the last mile.
>
> Every claim in this file carries one of three labels, and
> [What was verified](#what-was-verified) does it key by key:
>
> | | meaning |
> |---|---|
> | **[docs]** | read out of Codex's live documentation or its Rust source, with the file named |
> | **[disk]** | checked against a real file in `~/.codex`, or executed against real Codex data |
> | **[inferred]** | **not verified anywhere.** Carried over from the Claude Code plugin's shape because it was the best guess available |
>
> An unverified manifest that says which parts are unverified is useful. One
> that pretends is not. Treat every **[inferred]** row as a thing to check the
> first time you install this.

---

## What it installs

| Component | What it does |
|---|---|
| `SessionEnd` hook | Indexes the thread that just ended, detached, so `potsherd ls --since 1h` finds it. Cards it too, but only if you opt in. |
| `SessionStart` hook | Does no indexing. It exists to say the two things `SessionEnd` structurally cannot — see [Why SessionStart only talks](#why-sessionstart-only-talks). |
| MCP server `potsherd` | The same six read-mostly tools the Claude Code plugin exposes: `potsherd_find`, `potsherd_read`, `potsherd_ask`, `potsherd_graft`, `potsherd_ls`, `potsherd_tag`. |

There are **no skills and no agent** here. The Claude Code plugin ships both;
Codex has its own skills format and this plugin does not attempt it. Nothing is
declared for them and no `skills/` directory exists, so Codex's skill discovery
finds nothing. **[docs]**

---

## Install

### 1. You need a `potsherd` binary — build it from a checkout

The plugin ships configuration, not a program.

> **`potsherd` is not published to npm.** `npm i -g potsherd` is a 404 today,
> and this file used to print it as the install command. Publishing is
> phase 7's. Until then the only instruction that works is the one below.

```sh
git clone https://github.com/HulkInTherapy/potsherd
cd potsherd
pnpm install && pnpm build
```

Then add the plugin **from that checkout**, so that `bin/potsherd` finds the
bundle two directories up from itself. Adding it from GitHub clones a *second*
copy with no `dist/` in it, and that copy is the one the plugin looks beside.

Without a built potsherd the `SessionEnd` hook indexes nothing and the MCP
server exposes no tools. It does not fail quietly: the `SessionStart` hook
prints a `systemMessage` naming the problem. **[disk]** — that message was
produced by running the real hook command with no `potsherd` reachable.

### 2. Add the plugin

`codex plugin` has exactly four subcommands — `add`, `list`, `marketplace`,
`remove`. **There is no `codex plugin install`.** **[docs]**
(`codex-rs/cli/src/plugin_cmd.rs`)

`codex plugin marketplace add` accepts a local path, `owner/repo[@ref]`, an
HTTPS Git URL or an SSH Git URL. **[docs]** So the documented development loop is
add-a-marketplace, then add the plugin from it:

```sh
codex plugin marketplace add /path/to/potsherd     # or HulkInTherapy/potsherd
codex plugin add potsherd@potsherd
codex plugin list
```

**[inferred]** — the marketplace *name* (`potsherd`) and the `PLUGIN@MARKETPLACE`
selector resolving to this directory both depend on Codex reading this
repository's root `.claude-plugin/marketplace.json`, or on a `marketplace.json`
this plugin does not ship. **Codex's marketplace manifest format was not
verified.** If `codex plugin marketplace add` rejects this repository, that is
the reason, and the fix is a Codex-shaped marketplace manifest at the repo root
— which is out of this task's scope.

**Do not run `codex features enable plugin_hooks`.** See
[The flag that does nothing](#the-flag-that-does-nothing).

---

## What was verified

### The manifest — `.codex-plugin/plugin.json`

`.codex-plugin/plugin.json` is a real, first-class manifest path. Codex's
discovery list is, in order: **[docs]**
(`codex-rs/exec-server-protocol/src/protocol.rs`)

```rust
pub const DISCOVERABLE_PLUGIN_MANIFEST_PATHS: &[&str] = &[
    ".codex-plugin/plugin.json",
    ".claude-plugin/plugin.json",
    ".cursor-plugin/plugin.json",
];
```

Note the second entry: Codex reads Claude Code plugin manifests too.

| Key | Status |
|---|---|
| keys are **camelCase** (`mcpServers`, not `mcp_servers`) | **[docs]** — `#[serde(rename_all = "camelCase")]` on `RawPluginManifest` |
| `name`, `version`, `description`, `keywords`, `author`, `homepage`, `repository`, `license` | **[docs]** + **[disk]** — all present in the OpenAI-shipped manifests under `~/.codex/plugins/cache/` |
| `interface` and its sub-keys | **[disk]** — copied key-for-key from the shipped `visualize` and `browser` manifests |
| `interface.defaultPrompt` capped at **3** entries of **128** chars | **[docs]** — `MAX_DEFAULT_PROMPT_COUNT`, `MAX_DEFAULT_PROMPT_LEN`. This manifest ships exactly 3, all under the cap |
| every path value must begin with `./` | **[docs]** — `resolve_manifest_path` drops the field with only a `tracing::warn!` otherwise. **This manifest declares no paths at all**, so the rule cannot bite it |

### Why this manifest declares almost nothing

The Claude Code plugin carries a scar worth repeating: `claude plugin validate`
**passed a manifest that Claude Code then refused to load**, because declaring
`"hooks": "./hooks/hooks.json"` duplicated a file Claude Code already discovers
by convention, and the whole plugin was dropped.

Codex has the same three conventional paths — and, checked in source, **not the
same trap**: **[docs]** (`codex-rs/core-plugins/src/loader.rs`)

```rust
const DEFAULT_HOOKS_CONFIG_FILE: &str = "hooks/hooks.json";
const DEFAULT_MCP_CONFIG_FILE: &str = ".mcp.json";
const DEFAULT_SKILLS_DIR_NAME: &str = "skills";
```

The manifest key and the conventional probe are **mutually exclusive `match`
arms** — declare the key and the default branch never runs; omit it and the
default path is probed. So declaring it is survivable here in a way it was not
in Claude Code.

This plugin still omits all three, because "prefer declaring less" costs nothing
when both routes work and removes a whole class of failure. The files sit at
`hooks/hooks.json` and `.mcp.json`, exactly where Codex looks for them.

### The MCP server — `.mcp.json`

| Thing | Status |
|---|---|
| a bundled MCP file may be `{"mcpServers": {…}}` **or** a bare server map | **[docs]** — `PluginMcpFile` is an untagged enum over both. This file uses the wrapper |
| `"type": "stdio"` is accepted | **[docs]** — `plugin_config.rs` explicitly matches `"http" \| "streamable_http" \| "streamable-http" \| "stdio"` |
| **`${PLUGIN_ROOT}` is NOT interpolated into `command`/`args`** | **[docs]** — no placeholder substitution exists in `plugin_config.rs`. This is a real difference from Claude Code, whose `.mcp.json` *does* interpolate `${CLAUDE_PLUGIN_ROOT}` |
| a **relative `cwd` is joined with the plugin root**, and `command`/`args` pass through untouched | **[docs]** — `root.join(cwd)`, with no rewriting of `command` or `args` |

That last pair is why this file reads the way it does. With no interpolation
available, the only way to point at a file near the plugin is to pin `cwd` to
the plugin root and let the child process resolve a relative argument against
it:

```json
{ "type": "stdio", "command": "sh",
  "args": ["bin/potsherd-mcp"], "cwd": "." }
```

`bin/potsherd-mcp` is the same three-place resolution `bin/potsherd` does, and
it exists for the same reason. Naming
`../../packages/mcp/dist/index.js` here directly — which this file used to —
means that in a marketplace install, where `dist/` is gitignored and absent,
`node` dies with a module-not-found stack trace before the server speaks MCP
and all six tools are simply missing from the client with no explanation. The
shim writes the three paths it tried, and the build command, to the server log
instead.

**Two warnings about this file, both honest:**

1. **[inferred]** — `packages/mcp` **does not exist in this commit.** It is
   T5.1's deliverable, landing in parallel. The path above mirrors the Claude
   Code plugin's `.mcp.json` exactly, but nothing has ever been launched from
   it, in Codex or anywhere else.
2. Setting `cwd` means the MCP server does **not** inherit your project
   directory. Anything potsherd writes relative to the working directory — the
   `graft` brief is the one that matters — would land beside the plugin instead
   of beside your code. If `codex plugin add` turns out to interpolate
   `${PLUGIN_ROOT}` after all, replacing the `args`/`cwd` pair with an
   interpolated absolute path is strictly better. **[inferred]**

A marketplace install has the same gap the Claude Code plugin documents: a git
clone carries no `dist/` and no `node_modules`, so `../../packages/mcp` resolves
to nothing. And unlike the hooks, the MCP server has **no `PATH` fallback to
lean on**, because **`potsherd mcp` is not a verb** — the CLI's verbs are
`audit rescue guard index find ask ls tag pin unpin link show graft stats card
doctor`, and `potsherd mcp` exits with `unknown command 'mcp'`. **[disk]**
So on a marketplace install the MCP half of this plugin will not start until
that is addressed. The hooks are unaffected.

### The hooks — `hooks/hooks.json`

| Thing | Status |
|---|---|
| the file needs a top-level `{"hooks": {…}}` wrapper, and takes an optional `description` | **[docs]** |
| `SessionStart` and `SessionEnd` both exist; 11 events in total | **[docs]** — `HookEventsToml` in `codex-rs/config/src/hook_config.rs` |
| `SessionStart`'s matcher filters `source`, values `startup \| resume \| clear \| compact` | **[docs]** — this plugin matches `startup\|resume` |
| `SessionStart` delivers `systemMessage` and `additionalContext` | **[docs]** |
| `SessionEnd`'s stdin carries `session_id`, and its `reason` has exactly one value today (`other`), so it takes no matcher | **[docs]** — generated JSON Schema, `session-end.command.input.schema.json` |
| hook handler keys `type`, `command`, `timeout` | **[docs]** |
| hook commands receive `PLUGIN_ROOT`, `PLUGIN_DATA`, and the compat aliases `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` | **[docs]** — injected verbatim in `codex-rs/hooks/src/engine/discovery.rs`, with the source comment *"For OOTB compat with existing plugins that use this env var."* |
| **there is no `CODEX_PROJECT_DIR`** and no `CODEX_PLUGIN_ROOT` | **[docs]** — the project directory arrives as `cwd` in the hook's stdin JSON |
| hooks are **on by default** — no flag, no opt-in | **[docs]** — `Feature::CodexHooks`, key `hooks`, `Stage::Stable`, `default_enabled: true` |
| the shell logic in both commands, in every branch | **[disk]** — both commands were extracted from this `hooks.json` and executed against a throwaway `HOME`. Since T5.9 each `command` is one line that `exec sh`s the matching `hooks/*.sh`; `tests/hooks.test.ts` extracts and runs them the same way, on a machine built with a stale `0.1.0` first on `PATH` |
| `index --session <codex-thread-id>` resolves a real Codex thread | **[disk]** — run against the real rollout file in `~/.codex/sessions/2026/07/21/`; the thread landed in the index as harness `codex` |

The one thing **[inferred]**: that Codex actually fires these two events for a
plugin-bundled `hooks.json` and injects `PLUGIN_ROOT` when it does. The
documentation says both. Nothing here has watched it happen.

### The flag that does nothing

The plan for this task said to document `codex features enable plugin_hooks`.
**Do not run it, and do not put it in any install instructions.** **[docs]**
(`codex-rs/features/src/lib.rs`)

```rust
FeatureSpec {
    id: Feature::PluginHooks,
    key: "plugin_hooks",
    stage: Stage::Removed,
    default_enabled: false,
},
```

with, in the config loader:

```rust
"plugin_hooks" => {
    continue;
}
```

`plugin_hooks` is a **removed** compatibility flag. It is still a *registered*
key, so `codex features enable plugin_hooks` passes validation, writes
`features.plugin_hooks = true` into your `config.toml`, and prints that it
enabled the feature — and then the loader reaches that `continue` and discards
it. The command appears to succeed and does nothing.

Plugin-bundled hooks need no flag at all: `Feature::CodexHooks` is `Stable` and
`default_enabled: true`. To turn hooks *off* you would set `hooks = false` under
`[features]`.

---

## Why SessionStart only talks

`SessionEnd` does the work; `SessionStart` does none of it. Two reasons, and
both are constraints rather than choices.

**`rescue` has nothing to do here.** `rescue` exists because Claude Code deletes
transcripts after 30 days. It is hard-coded to one harness —
`const HARNESS = 'claude'` in `packages/core/src/rescue.ts` — and reads only
`~/.claude`. Running it from a Codex plugin would archive nothing of Codex's, so
this plugin does not run it. **[disk]** That is a deliberate difference from the
Claude Code plugin, whose `SessionStart` hook is exactly a `rescue`.

**`SessionEnd` cannot say anything to you.** Codex's docs are explicit that
`SessionEnd` hooks are advisory: *"their output won't steer Codex or keep the
thread open"*, and they do not display user-facing messages. There is a
generated output schema for `session-start` and **none** for `session-end`.
**[docs]** Claude Code's `SessionEnd` has the identical limitation, stated more
bluntly: *"Exit codes and `systemMessage` are ignored."*

So anything the user must be told about work `SessionEnd` is going to do has to
be said at `SessionStart`, before the fact — and anything `SessionEnd` finds
out too late has to be written down for the *next* `SessionStart` to read. That
is what `~/.potsherd/hook-failures.log` is: `SessionEnd` appends a line to it
when it could not index, `SessionStart` reads it out and clears it. Three
things get said:

1. **No runnable `potsherd`** — then `SessionEnd` will index nothing, and you
   should know before you rely on it.
2. **A `potsherd` too old for the verb.** Resolution can land on a global
   install that predates `index` — on the machine this was written on, `PATH`
   held `0.1.0` while the checkout beside it was `0.4.0`. So `SessionStart`
   asks the resolved binary directly, `index --help`, and reports the version
   it found if that fails. A capability probe, not a version comparison: the
   question is "can it do this?". Costs a **measured 128 ms**, once per thread
   (17 ms before it existed; the difference is Node starting the bundle).

   Both hooks reach that binary through `bin/potsherd` and resolve nothing
   themselves. Before T5.9 each re-implemented the resolution inline in
   `hooks.json` with the order reversed, which is how `0.1.0` came to answer
   for `0.4.0` with the error going to `/dev/null` and the hook exiting `0`.
3. **The embedding model is not on disk yet** — then the first `SessionEnd`
   after install downloads **32.4 MB** of `Xenova/bge-small-en-v1.5`, detached, in
   the background. `index --quiet` is what the hook runs and `--quiet` prints
   nothing, so without this warning the download is completely silent. The hook
   probes for a cached model in pure shell — the same directory and the same
   ">1 MB `.onnx`" test as `isModelCached()`, with no Node startup — which costs
   a **measured ~4 ms** and fires only while the model is absent, so in practice
   once. **[disk]**

`potsherd doctor --privacy` states the same thing, and is checked in CI.

---

## Configuration

Shared with the Claude Code plugin — one `~/.potsherd/config.json`, and the
switch is **off** unless the file holds a literal `true`:

```json
{ "cardOnEnd": false }
```

**`cardOnEnd`** — card each thread as it ends. Off by default because a card is
a model call. Indexing on `SessionEnd` happens either way; only the card is
gated.

`briefOnStart` is a Claude Code-only switch. This plugin's `SessionStart` hook
injects no context and ignores it.

### Turning off a single hook

There is no per-hook switch. Delete the entry you do not want from
`hooks/hooks.json` in your installed copy and restart Codex. A plugin update
overwrites that edit, so prefer removing the whole plugin if you want it to
stick.

---

## What it does to your machine

potsherd's ground rule is that other tools' directories are read-only inputs.
This plugin holds to it: **it never writes to `~/.codex`.**

| Path | Access |
|---|---|
| `~/.codex/sessions/**` | read only |
| `~/.potsherd/**` | read and write — the archive, index and config |
| `~/.potsherd/models/` | written once, on first index: a 32.4 MB local embedding model |
| `~/.potsherd/hook-failures.log` | appended by `SessionEnd` when it could not index; read out and cleared by the next `SessionStart` |

Codex's transcripts live at
`~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-id>.jsonl`. **[disk]** —
matched against the real file on this machine. Codex does **not** appear to
sweep old threads the way Claude Code does, which is the other reason there is
no `rescue` hook here.

Run `potsherd doctor --privacy` for the authoritative list of every path read
and written; it is checked in CI.

---

## Uninstall

```sh
codex plugin remove potsherd@potsherd
codex plugin marketplace remove potsherd
```

**[inferred]** — the subcommands `remove` are **[docs]**; the exact selector
depends on the marketplace question above.

Restart Codex. Nothing is left in `~/.codex`, because nothing was put there.

### Remove the binary

```sh
npm uninstall -g potsherd
```

### Remove the archive — only if you mean it

Your indexed threads live in `~/.potsherd`, and for rescued Claude Code sessions
it is often the **only** remaining copy. Deleting it is not undoable.

```sh
potsherd ls --ghosts only        # what only exists here
rm -rf ~/.potsherd               # after you have read the line above
```

---

## Do not rename the plugin or the MCP server

Both are literally `potsherd` — `name` in `.codex-plugin/plugin.json`, and the
server key in `.mcp.json`. In Claude Code, renaming either silently strips the
bundled agent of all its tools, because tool names are derived from both.

**[inferred]** — Codex's MCP tool-naming scheme was not verified, and this plugin
ships no agent that hard-codes tool names, so the specific Claude Code failure
cannot occur here. Keeping the two names identical and equal to `potsherd` is
still the safer default until someone checks.

# potsherd as an MCP server — contract 2

The local 2.0.0-rc.1 candidate exposes four stdio tools:

| Tool | Purpose |
|---|---|
| `potsherd_recall` | Scoped lexical/semantic candidates and sourced evidence with explicit coverage |
| `potsherd_read` | Exact immutable spans, historical refs, authored notes and bounded pagination |
| `potsherd_graft` | Deterministic bounded context; no default model call or file write |
| `potsherd_write` | Explicit durable sourced author assertions with idempotent request keys |

Only `potsherd_write` is a write tool. Source roles, unknown times, branch scope, note authority and explicit supersession travel with the result. Similarity and link existence do not certify claim support. Missing semantic assets leave labelled lexical access; unavailable or incomplete capture never becomes global absence.

Budget counts the complete controlled payload using bundled cl100k-base transport accounting, not the host model's exact tokenizer. See [the versioned agent contract](AGENT-CONTRACT.md) for full inputs, currentness, privacy and migration limits.

Both plugins carry their own ESM CLI/MCP bundles and transport assets. A copied plugin directory can launch independently; native marketplace registration and actual host journeys are separate checks. Semantic model assets are acquired only with explicit `maintain --acquire-assets`; reads do not download them.

## the one command

```
potsherd setup --cursor          # or --claude --codex --gemini --opencode --copilot --pi --all
```

`setup` finds the client's config file, shows you the diff, and writes nothing
until you type `y`. It **merges**: if you already have three MCP servers, you
still have three, plus potsherd. It backs the file up first. `--dry-run` prints
the diff and writes nothing at all; `--status` says what is registered where;
`--remove` takes potsherd back out and leaves everything else alone.

```
potsherd setup --cursor --dry-run
potsherd setup --all --status
potsherd setup --claude --remove
```

If potsherd refuses — a config with comments in it, a config that is not valid
JSON, a codex config that declares `mcp_servers` inline — it prints the snippet
and lets you paste it yourself. It would rather do nothing than reformat a file
it did not write.

## how well each snippet is verified

Every table below carries this, because a snippet that has not been checked
should not look like one that has.

| client | config file | format | verified against |
|---|---|---|---|
| Claude Code | `~/.claude.json` | JSON | **the installed tool** — `claude mcp add -s user` writes this file, and real entries in it were read for the key and the entry shape |
| Codex CLI | `~/.codex/config.toml` | TOML | **a real config file** carrying two `[mcp_servers.*]` tables |
| Cursor | `~/.cursor/mcp.json` | JSON | **a real config file** |
| Gemini CLI | `~/.gemini/settings.json` | JSON | *documentation only — unverified* |
| opencode | `~/.config/opencode/opencode.json` | JSON | *documentation only — unverified* |
| GitHub Copilot CLI | `~/.copilot/mcp-config.json` | JSON | *documentation only — unverified* |
| pi | `~/.pi/agent/extensions/potsherd.ts` | Native extension | installed pi 0.74.0 API; model journey pending |

"Unverified" means exactly what it says: the client was not installed on the
machine these snippets were written on, and no config file it had written was
available to read. The snippet is what the documentation describes and what the
rest of the ecosystem uses; it may still be wrong. If one of them is, the fix is
a two-line change to `CLIENTS` in `packages/core/src/setup.ts` — please open an
issue with what your client actually wants.

## which command to register

Two forms work, and `setup` picks between them the way `guard` does:

| form | when | why |
|---|---|---|
| `potsherd-mcp` | it is on your `PATH` | survives an upgrade, reads best in a diff |
| `/abs/path/to/node /abs/path/to/packages/mcp/dist/index.js` | it is not | pinned to this install |

(Inside the two plugins the same server is launched through `bin/potsherd-mcp`, which resolves the bundle and, when there is none, writes the three paths it tried to the server log rather than dying with a module-not-found trace and taking all four tools with it silently.)

The absolute `node` in the second form is deliberate. Several of these clients
are GUI applications launched from Finder or a desktop entry, and those inherit
no shell `PATH` at all — a version-managed `node` would simply not be found.

`setup` will **not** write a stanza pointing at a server that is not there. A
config entry that looks installed and silently fails to spawn is worse than no
entry: the client starts, the tools never appear, and nothing tells you why.

The snippets below use the `potsherd-mcp` form. Substitute the absolute form if
you have not installed potsherd globally.

---

## Claude Code

The plugin is the better route — it installs the same server without touching
any of your files:

```
/plugin marketplace add HulkInTherapy/potsherd
/plugin install potsherd
```

If you are not using the plugin, user scope lives in `~/.claude.json`:

```json
{
  "mcpServers": {
    "potsherd": {
      "type": "stdio",
      "command": "potsherd-mcp",
      "args": []
    }
  }
}
```

`potsherd setup --claude` writes exactly that. Or, equivalently:

```
claude mcp add -s user potsherd -- potsherd-mcp
```

Project scope instead: the same `mcpServers` block in `./.mcp.json`.

## Codex CLI

`~/.codex/config.toml`, which is TOML and not JSON:

```toml
[mcp_servers.potsherd]
command = "potsherd-mcp"
args = []
```

`potsherd setup --codex` appends exactly that table and changes nothing else in
the file — it does not reparse your config, so your comments and ordering
survive. If your config declares `mcp_servers` as an inline table
(`mcp_servers = { … }`), potsherd refuses and prints the snippet instead, because
an appended table would redefine it.

## Cursor

Globally, in `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "potsherd": {
      "command": "potsherd-mcp",
      "args": []
    }
  }
}
```

Per project instead: the same block in `./.cursor/mcp.json`. `potsherd setup
--cursor` writes the global one.

## Gemini CLI

> Unverified: written from the Gemini CLI documentation, not tested against an
> installed `gemini`.

`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "potsherd": {
      "command": "potsherd-mcp",
      "args": []
    }
  }
}
```

Per project instead: `./.gemini/settings.json`.

## opencode

> Unverified: written from the opencode documentation, not tested against an
> installed `opencode`.

`~/.config/opencode/opencode.json` — note that opencode's key is `mcp`, not
`mcpServers`, and that argv is one array rather than a command plus args:

```json
{
  "mcp": {
    "potsherd": {
      "type": "local",
      "command": [
        "potsherd-mcp"
      ],
      "enabled": true
    }
  }
}
```

`potsherd setup --opencode` adds `"$schema": "https://opencode.ai/config.json"`
when it has to create the file, and leaves it alone when it does not.
`XDG_CONFIG_HOME` is honoured.

## GitHub Copilot CLI

> Unverified: written from the Copilot CLI documentation, not tested against an
> installed `copilot`.

`~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "potsherd": {
      "type": "local",
      "command": "potsherd-mcp",
      "args": [],
      "tools": ["*"]
    }
  }
}
```

`"tools": ["*"]` enables all three. Name them individually to enable fewer.

## pi

`potsherd setup --pi` installs a native pi extension at
`~/.pi/agent/extensions/potsherd.ts`. It uses the installed pi 0.74.0
`registerTool`, `session_start`, and `session_shutdown` APIs to bridge the four
MCP tools. The former `mcpServers` settings stanza was unverified and is no
longer generated. Existing user settings are not rewritten.

Setup enrolls selected capture hosts. `index --enroll pi,opencode` adds durable
capture authority; `index --unenroll pi` removes it. `--harness` alone is a
one-shot scan filter. Explicit `--pi-dir`/`--opencode-dir` roots are preserved
with existing enrolled roots. The MCP worker polls enrolled sources while the
host is alive and catches up when restarted. This is eventual capture, not an
acknowledgment that every final shutdown turn has already been indexed.

Native pi and OpenCode content currently has exchange-level evidence fidelity;
native IDs are retained in OpenCode snapshot artifacts, but public evidence
handles are projected exchanges. Native model-backed write/restart/resume
qualification remains separate from parser and extension tests.

---

## what this lets potsherd write

`setup` is the only part of potsherd that writes into another tool's directory,
and `potsherd doctor --privacy` lists all seven paths it can touch. Nothing is
written without an explicit `y` at a diff, every write is backed up beside the
original, and `--dry-run` writes nothing at all.

Everything else potsherd does stays inside `~/.potsherd`. See `doctor --privacy`
for the whole receipt.

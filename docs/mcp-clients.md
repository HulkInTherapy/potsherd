# potsherd as an MCP server

potsherd ships a stdio MCP server with six tools, so any MCP client can search,
read, interrogate and re-enter your coding-agent sessions without leaving the
agent you are already in.

```
potsherd_find    search every prompt, every subagent, every deleted session
potsherd_read    read one session, paginated by line
potsherd_ask     one cited answer over the shortlist it retrieved
potsherd_graft   a token-budgeted brief that re-enters an old session
potsherd_ls      sessions by title, newest first
potsherd_tag     your own tags on a session
```

Six, not fifty-four. Everything except `potsherd_tag` is read-only, and nothing
writes outside `~/.potsherd` except `potsherd_graft`'s brief, which lands in the
directory you ran the client from.

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
| pi | `~/.pi/agent/settings.json` | JSON | *documentation only — unverified, and the weakest of the seven* |

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

`"tools": ["*"]` enables all six. Name them individually to enable fewer.

## pi

> Unverified, and the least certain of the seven: written from documentation
> only, with no `pi` installed and no MCP key in the real
> `~/.pi/agent/settings.json` on the machine this was written on. Check it
> against your own before trusting it.

`~/.pi/agent/settings.json`:

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

---

## what this lets potsherd write

`setup` is the only part of potsherd that writes into another tool's directory,
and `potsherd doctor --privacy` lists all seven paths it can touch. Nothing is
written without an explicit `y` at a diff, every write is backed up beside the
original, and `--dry-run` writes nothing at all.

Everything else potsherd does stays inside `~/.potsherd`. See `doctor --privacy`
for the whole receipt.

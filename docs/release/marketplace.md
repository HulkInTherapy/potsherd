# the Claude Code plugin listing

**Not submitted, and not for an agent to submit.**

## what is ready

`.claude-plugin/marketplace.json` at the repository root describes one plugin,
`potsherd`, sourced from `./plugins/claude-code`. Its `version` is pinned to the
same string as every other manifest in the repository by
`tests/terminal.test.ts` — seven surfaces, one number, checked against the
newest git tag.

The plugin passes `claude plugin validate`. It carries:

- `skills/potsherd/SKILL.md` — `/potsherd <verb>`, user-invocable
- `skills/remembering-sessions/SKILL.md` — model-invocable, dispatches the agent
- `agents/session-archaeologist.md` — haiku-class, five MCP tools and `Read`
- `hooks/hooks.json` — `SessionStart` rescue, `SessionEnd` index
- `.mcp.json` — the stdio server, six tools
- **`dist/potsherd.js` and `dist/mcp.js`, committed** — this is what makes an
  install work at all, and it is why `pnpm vendor` is step 2 of the release.

## install it locally first, from a clone that is not this checkout

The point is to test what a stranger gets, so do it somewhere with no
`node_modules` and no build:

```bash
git clone https://github.com/HulkInTherapy/potsherd /tmp/market-test
cd /tmp/market-test
# no pnpm install. no build. nothing.
sh plugins/claude-code/bin/potsherd --version
sh plugins/claude-code/bin/potsherd audit
```

Then in Claude Code:

```
/plugin marketplace add /tmp/market-test
/plugin install potsherd@potsherd
/potsherd audit
```

and check that the six MCP tools are present — `session-archaeologist` having
only `Read` is exactly the failure this release exists to fix.

## submission

Whatever the current registry process is at the time. **Verify it before
following it**: six claims this project inherited about other people's software
proved false, and the worst of them was a command that succeeded and did
nothing.

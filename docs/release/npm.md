# publishing to npm

**Not done, and not for an agent to do.** `npm publish` is irreversible within
72 hours and permanent after that, and it publishes under an account that
belongs to a person.

## what is ready

`packages/cli` is the published package. It is called `potsherd`, its `bin` is
`potsherd`, and `npm pack` has been run and installed from the tarball on a
clean directory — that path is a CI step (`npx from the packed tarball`) and
runs on macOS and Ubuntu, Node 22 and Node 24, on every push.

```bash
cd packages/cli
npm pack
# potsherd-1.0.0.tgz
```

What is in it: `bin/`, `dist/`, `README.md`, `LICENSE`, `NOTICE`. `dist/` is one
esbuild bundle with `@potsherd/core` and `@potsherd/bridges` compiled in, so the
package has no workspace dependencies to resolve.

Runtime dependencies, and why each is where it is:

| package | why |
|---|---|
| `better-sqlite3` | the native addon. **Loaded on first `open()`, not at import** — without it, `audit`, `rescue`, `guard` and `doctor` still work, and everything else says so in one sentence. |
| `commander` | bundled in, not a dependency. |
| `sqlite-vec` *(optional)* | vector search. Absent → text search, and `doctor` says which. |
| `@huggingface/transformers` *(optional)* | the embedding model. Absent → `--no-embed` behaviour. |
| `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk` *(optional)* | the two model paths. Absent → `card`, `ask` and `graft` refuse with a sentence; nothing else notices. |

## the check that matters before publishing

```bash
npm view potsherd
```

Today: **404**. If that ever returns somebody else's package, stop — the name is
taken and this readme's `npx potsherd audit` line is a claim about their code.

## the command

```bash
cd packages/cli
npm publish --access public
```

Then, and only then, the `npx potsherd audit` line at the top of the README
stops needing its qualifier. Change it in the same commit.

## what publishing does NOT fix

Nothing about the plugin. A Claude Code plugin install is a git clone, it does
not resolve npm packages, and it is already self-contained — see
`scripts/vendor-plugin.mjs`.

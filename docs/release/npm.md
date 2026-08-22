# publishing to npm

**Rule 7 was re-scoped by meghavi on 22 August 2026: the orchestrator publishes.**
The paragraph below is kept because its reasoning is still why every step here
is a command with an expected output rather than a judgement call.

`npm publish` is irreversible within
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

## the command, decided

```bash
cd packages/cli
npm publish --access public
```

**`--access public` and nothing else.** Two things were considered and refused:

- **`--provenance`** attaches a signed attestation linking the tarball to the CI
  run that built it. It requires publishing *from* a trusted CI runner with an
  OIDC token; run from a laptop it either errors or produces nothing worth
  having. Not tonight. It is the right thing for a later release that publishes
  from a workflow, and it is written down here so the next person does not have
  to rediscover why it was skipped.
- **`--tag next`** would publish without moving `latest`. Refused because it
  makes `npx potsherd audit` — the first line of the README — resolve to nothing,
  which is the one command this release exists to make work.

Measured before publishing, on 22 August 2026:

```
npm view potsherd                     -> E404, the name is free
npm publish --dry-run                 -> potsherd@1.1.0, 8 files, 957.3 kB
                                         (unpacked 3.5 MB), no warnings
npm pack + install into an empty project
                                      -> 17 MB in node_modules, `audit` runs
```

The dry run warned once, about `bin[potsherd]` being `./bin/potsherd.js`; the
leading `./` is now gone and the warning with it. A warning on a publish is
noise that trains people to ignore publishes.

Then, and only then, the `npx potsherd audit` line at the top of the README
stops needing its qualifier. Change it in the same commit.

## what publishing does NOT fix

Nothing about the plugin. A Claude Code plugin install is a git clone, it does
not resolve npm packages, and it is already self-contained — see
`scripts/vendor-plugin.mjs`.

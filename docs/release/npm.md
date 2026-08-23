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

Before the first publish this was a **404**. Since 22 August 2026 it returns
**1.1.0**. The check still matters on any future rename: if it ever returns
somebody else's package, stop, because the readme's `npx potsherd audit` line
would then be a claim about their code.

## the command, decided — and superseded for the next release

**1.1.0 was published by hand:**

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

  **That later release is now set up.** `.github/workflows/publish.yml` fires on
  a `v*` tag with `id-token: write` and publishes with `--provenance`. See
  "the next release" below. `1.1.0` keeps no attestation — it cannot be added
  retroactively — and
  `npm view potsherd@1.1.0 --json | jq .dist.attestations` returns `null`,
  which is the honest state and should be said out loud rather than left to be
  discovered.
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


---

## the next release: publishing is the tag

`.github/workflows/publish.yml`. A human does step 1 once; everything after it
is a tag.

```bash
# 1. ONCE, and only a human can: an npm automation token with read+write on
#    this package, stored as the repository secret NPM_TOKEN.
#      npmjs.com/settings/~/tokens  ->  Generate New Token  ->  Granular Access
#      scope it to the `potsherd` package, give it Read and write, then:
gh secret set NPM_TOKEN --repo HulkInTherapy/potsherd

# 2. EVERY RELEASE
$EDITOR packages/core/src/version.ts     # and the six manifests pinned to it
pnpm build && pnpm vendor
git commit -am "release vX.Y.Z" && git push origin main
gh run watch                              # CI green on the PUSHED COMMIT first
git tag -a vX.Y.Z -m "potsherd vX.Y.Z" && git push origin vX.Y.Z
gh run watch                              # then the publish workflow
```

### what the workflow refuses to publish

Every one of these is a reason **not** to publish, and they run before the
publish step. A release pipeline whose only job is to publish will publish
anything.

- the tag and `packages/cli/package.json` disagree
- that version is already on the registry
- `check-privacy.py --selftest` or the full sweep is red
- `pnpm typecheck` or `pnpm test` is red
- the suite is red under `POTSHERD_SQLITE=node`
- `plugins/*/dist` is not what this source builds
- the packed tarball will not install and run in a clean directory

### and it checks that provenance actually landed

`npm publish --provenance` **succeeds silently** when the job is missing
`id-token: write`. A flag that is documented and does nothing is the failure
mode this project has recorded seven times, so the workflow polls
`npm view potsherd@<version> --json` afterwards and fails if
`dist.attestations` is still `null`.

### what provenance buys, and why it is on-brand

npm shows a verified **Provenance** panel on the package page, linking the
tarball to this repository, the exact commit and the workflow run that built it.

It is also the GitHub↔npm link people look for and do not find. **The "Packages"
box in the GitHub sidebar is GitHub's own registry** (`npm.pkg.github.com`), not
npmjs.com, and it will read "No packages published" forever no matter how many
times this package is published to npm. Publishing there instead would force a
scoped name (`@hulkintherapy/potsherd`) and require consumers to authenticate
with a GitHub token even for a public package — which would break
`npx potsherd audit`, the first command in the README.

And it is the same rule as everything else here. `audit --verify` prints
standalone python so nobody has to trust potsherd to check potsherd. An artefact
that says "trust me, this is the code" was the last place that rule was not
being applied.

### dry run

`workflow_dispatch` runs everything except the publish, so the whole pipeline
can be exercised without spending a version number:

```bash
gh workflow run publish.yml -f dry_run=true && gh run watch
```

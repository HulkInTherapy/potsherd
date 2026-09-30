# potsherd

Local memory for coding-agent sessions. Capture supported history, find exact source evidence, and save scoped handoffs with provenance.

**2.0.0-rc.2 is a release candidate.** Requires Node.js 22 or newer.

## Install and use

Build the candidate checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm vendor
node packages/cli/bin/potsherd.js --help
```

Use an owned test store and explicit source roots to try capture and search:

```sh
node packages/cli/bin/potsherd.js maintain --migrate --potsherd-dir /path/to/test-store
node packages/cli/bin/potsherd.js index --enroll codex,claude --codex-dir /path/to/codex --claude-dir /path/to/claude --potsherd-dir /path/to/test-store
node packages/cli/bin/potsherd.js find "latest project decisions" --project /example/project --potsherd-dir /path/to/test-store --json
```

`--enroll` enables automatic capture for those source roots. Semantic model assets require explicit `maintain --acquire-assets --rebuild`; missing assets produce labelled degraded coverage.

## Integrations and support

The [Codex plugin](plugins/codex/README.md), [Claude Code plugin](plugins/claude-code/README.md), native pi extension, and OpenCode MCP configuration expose recall, exact read, deterministic graft, and explicit write. See [installation and MCP configuration](docs/mcp-clients.md), the [agent contract](docs/AGENT-CONTRACT.md), and the [reader contract](docs/reader-contract.md).

Host verification differs by integration. [Candidate notes](docs/release-candidate.md) describe measured results and remaining limits; [release history](CHANGELOG.md) tracks product versions. This candidate is not certified as unattended primary memory.

## Evidence and upgrades

Only explicit write creates authored memory. Relevance scores and source links do not prove a claim; verify exact evidence and distinguish human decisions from assistant recaps, tool observations, and historical instructions. Reader validation checks structure and citation membership, not semantic entailment. Partial capture cannot establish global absence.

Before upgrading, back up the store and retain the previous package. `maintain --migrate` creates a pre-upgrade backup. To roll back, stop owned host/MCP processes, preserve the upgraded store, restore a copy of the backup, and run the previous package against that copy.

MIT licensed. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

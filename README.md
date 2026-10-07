# potsherd

Local memory for coding-agent sessions. Capture supported history, find exact source evidence, and save scoped handoffs with provenance.

**This checkout is the 1.6.0 release candidate.** Requires Node.js 22 or newer. Published `latest` remains 1.5.0 until the launch gates pass.

## Audit your recorded history

```sh
npx potsherd audit
```

The default interactive audit sends selected redacted conversation text to OpenCode Zen and TypeSafe/Jev after its opening recipient notice, with no extra Enter step. It presents recorded API-equivalent value at a dated current price catalog, favourite model, real projects, recent Jev work stories, memorable source lines and direct-user language. Arrow keys or Tab switch sections; Enter opens details and evidence, Esc returns, S freezes the current view and q exits. `--tone elegant|witty|chaotic|roast` overrides the inferred voice. `--plain`, `--ascii`, `--no-color` and `--no-motion` support simpler terminals.

Jev analyzes the largest complete recent scope that fits the free token and estimated time allowance: All, 45, 30, 7 or 3 days. When none fits, an explicitly labelled selection of the newest coherent episodes keeps the scope bounded and the calendar coverage partial. Its opening notice names OpenCode Zen and TypeSafe/Jev as recipients. Retained archives remain read-only; redacted conversation text is sent only through the qualified free route, with no paid fallback. The official anonymous OpenCode free-model route was verified with a zero-cost synthetic request; installed and representative semantic qualification remain release gates. Results and date inventories use a separate body-free local cache. Prices revalue recorded tokens at current catalog rates; they are not historical invoices. Missing usage, endpoints, rates or provenance stay visible.

Use `potsherd audit --legacy` for the local retention audit, or set `POTSHERD_OFFLINE=1` to keep the new retrospective local. Window estimates describe remaining analysis after inventory, not the entire cold command; large cold archives can take longer. `--sweep` and `--verify` keep their prior behavior. See [terminal audit coverage and privacy](docs/audit-terminal.md).

## Install and use

Install or upgrade the published release with `npm install -g potsherd@latest`. Build this checkout from source:

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

The v2 agent contract exposes four tools: `potsherd_recall` for scoped recall, `potsherd_read` for exact source evidence, `potsherd_graft` for deterministic handoffs, and `potsherd_write` for explicit authored memory. The [Codex plugin](plugins/codex/README.md), [Claude Code plugin](plugins/claude-code/README.md), native pi extension, and OpenCode MCP configuration use this contract. See [installation and MCP configuration](docs/mcp-clients.md), the [agent contract](docs/AGENT-CONTRACT.md), and the [reader contract](docs/reader-contract.md).

Host verification differs by integration. [Release notes](docs/release-candidate.md) describe measured results and remaining limits; [release history](CHANGELOG.md) tracks product versions. This release is not certified as unattended primary memory.

## Evidence and upgrades

Only explicit write creates authored memory. Relevance scores and source links do not prove a claim; verify exact evidence and distinguish human decisions from assistant recaps, tool observations, and historical instructions. Reader validation checks structure and citation membership, not semantic entailment. Partial capture cannot establish global absence.

Before upgrading, back up the store and retain the previous package. `maintain --migrate` creates a pre-upgrade backup. To roll back, stop owned host/MCP processes, preserve the upgraded store, restore a copy of the backup, and run the previous package against that copy.

MIT licensed. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

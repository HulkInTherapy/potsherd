# Slopie

[Slopie](https://github.com/HulkInTherapy/slopie), formerly Potsherd, is local memory for coding-agent sessions. Capture supported history, find exact source evidence, and save scoped handoffs with provenance.

**This checkout is the Slopie 1.6.1 candidate; npm publication is pending.** Requires Node.js 22 or newer. The earlier Potsherd 1.6.0 upload is a separate release and does not establish availability of this new package.

## Audit your recorded history

```sh
npx slopie audit
```

The default interactive audit sends selected redacted conversation text to OpenCode Zen and TypeSafe/Jev after its opening recipient notice, with no extra Enter step. It presents recorded API-equivalent value at a dated current price catalog, favourite model, real projects, recent Jev work stories, memorable source lines and direct-user language. Arrow keys or Tab switch sections; Enter opens details and evidence, Esc returns, S freezes the current view and q exits. `--tone elegant|witty|chaotic|roast` overrides the inferred voice. `--plain`, `--ascii`, `--no-color` and `--no-motion` support simpler terminals.

Jev analyzes the largest complete recent scope that fits the free token and estimated time allowance: All, 45, 30, 7 or 3 days. When none fits, an explicitly labelled selection of the newest coherent episodes keeps the scope bounded and the calendar coverage partial. Its opening notice names OpenCode Zen and TypeSafe/Jev as recipients. Retained archives remain read-only; redacted conversation text is sent only through the qualified free route, with no paid fallback. The anonymous free-model route previously returned zero-cost answers for an authored synthetic sample. Current free capacity is limited: four authorized private requests received quota errors and no accepted answers, so private semantic accuracy is unavailable. No private accuracy pass or guaranteed capacity is claimed. Results and date inventories use a separate body-free local cache. Prices revalue recorded tokens at current catalog rates; they are not historical invoices. Missing usage, endpoints, rates or provenance stay visible.

The audit remains experimental. The unchanged large synthetic fixture took about 33 seconds cold and 22 seconds warm. Independent, untuned scores were usefulness 7/10, ease 8/10 and appearance 8/10 at 80 columns (7/10 at 40); these do not establish broader semantic accuracy.

Use `slopie audit --legacy` for the local retention audit, or set `POTSHERD_OFFLINE=1` to keep the new retrospective local. Window estimates describe remaining analysis after inventory, not the entire cold command; large cold archives can take longer. `--sweep` and `--verify` keep their prior behavior. See [terminal audit coverage and privacy](docs/audit-terminal.md).

## Install and use

After publication, install with `npm install -g slopie@1.6.1` and run `slopie audit`. The `potsherd` executable remains a compatibility alias. Until then, build this candidate from source:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm vendor
node packages/cli/bin/slopie.js --help
```

Use an owned test store and explicit source roots to try capture and search:

```sh
node packages/cli/bin/slopie.js maintain --migrate --potsherd-dir /path/to/test-store
node packages/cli/bin/slopie.js index --enroll codex,claude --codex-dir /path/to/codex --claude-dir /path/to/claude --potsherd-dir /path/to/test-store
node packages/cli/bin/slopie.js find "latest project decisions" --project /example/project --potsherd-dir /path/to/test-store --json
```

`--enroll` enables automatic capture for those source roots. Semantic model assets require explicit `maintain --acquire-assets --rebuild`; missing assets produce labelled degraded coverage.

## Integrations and support

The v2 agent contract exposes four tools: `potsherd_recall` for scoped recall, `potsherd_read` for exact source evidence, `potsherd_graft` for deterministic handoffs, and `potsherd_write` for explicit authored memory. The [Codex plugin](plugins/codex/README.md), [Claude Code plugin](plugins/claude-code/README.md), native pi extension, and OpenCode MCP configuration use this contract. See [installation and MCP configuration](docs/mcp-clients.md), the [agent contract](docs/AGENT-CONTRACT.md), and the [reader contract](docs/reader-contract.md).

Existing `POTSHERD_*` settings, `--potsherd-dir`, local data/cache paths, plugin identities and tool IDs retain their compatibility names.

Host verification differs by integration. [Historical memory release notes](docs/release-candidate.md) describe measured results and remaining limits; [release history](CHANGELOG.md) tracks product versions. This release is not certified as unattended primary memory.

## Evidence and upgrades

Only explicit write creates authored memory. Relevance scores and source links do not prove a claim; verify exact evidence and distinguish human decisions from assistant recaps, tool observations, and historical instructions. Reader validation checks structure and citation membership, not semantic entailment. Partial capture cannot establish global absence.

Before upgrading, back up the store and retain the previous package. `maintain --migrate` creates a pre-upgrade backup. To roll back, stop owned host/MCP processes, preserve the upgraded store, restore a copy of the backup, and run the previous package against that copy.

MIT licensed. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

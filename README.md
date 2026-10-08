# Slopie

[Slopie](https://github.com/HulkInTherapy/slopie), formerly Potsherd, is local memory for coding-agent sessions. Capture supported history, find exact source evidence, and save scoped handoffs with provenance.

Requires Node.js 22 or newer.

## Audit your recorded history

```sh
npx slopie audit
```

The interactive audit opens one responsive wallboard with recorded API-equivalent value, known tokens, favourite models and prices, your top projects, requested work focus and source-backed repeated lines. Small terminals use left/right pages; `?` opens help, `s` freezes the displayed results, `d` opens a captured source and `q` exits. There are no section tabs or scrolling controls. `--plain` prints the full report; `--json` uses the safe aggregate representation. `--ascii`, `--no-color` and `--no-motion` support simpler terminals.

Native Claude Code, Codex, OpenCode and pi usage is read before retained-history fallback. Message/request identities, cumulative usage, cache inclusion and recorded per-response models determine the totals. Known machine/test inputs and copied history are separated from personal language. Reaction counts describe recorded feedback associated with a known assistant model; they are not model-quality benchmarks or universal human-authorship claims.

Prices revalue recorded usage at a dated current catalog. Exact known Claude models can use an explicitly named Anthropic first-party reference when the serving provider is unrecorded. Native recorded API-cost fields remain a separate basis. None is an invoice or subscription bill. Missing models, usage, rates and contradictory cache-duration fields stay unavailable.

Selected redacted conversations may be sent to OpenCode Zen and TypeSafe/Jev for free semantic analysis. A recipient notice is physically displayed immediately before each actual request, with no extra Enter or consumer key required. Offline and cache-only work makes no transfer claim. Set `POTSHERD_OFFLINE=1` to keep the retrospective local. Free capacity is limited; quota errors leave local facts usable and do not produce invented stories or quotes. Private semantic accuracy remains unqualified.

Jev selects the largest complete recent scope fitting the free allowance, or a visibly smaller selection of newest whole episodes. Recorded requests, assistant-reported outcomes and supported success remain distinct. `--tone elegant|witty|chaotic|roast` overrides the inferred voice. The audit remains experimental; large inventories can take longer, and source-format or pricing gaps are disclosed. See [coverage and privacy](docs/audit-terminal.md).

Use `slopie audit --legacy` for the local retention audit. `--sweep` and `--verify` keep their prior behavior.

## Install and use

Install with `npm install -g slopie` and run `slopie audit`. The `potsherd` executable remains a compatibility alias. To build this checkout from source:

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

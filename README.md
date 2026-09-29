# potsherd

Local memory for coding-agent sessions: capture supported history, retrieve exact source evidence, and write scoped handoffs with explicit provenance.

**2.0.0-rc.2 is a release candidate.** The four host integrations have separate evidence levels; full native model qualification is limited to available subscriptions. It is not certified as unattended primary memory. The current public npm release is 1.2.1.

Requires Node.js 22 or newer. The CLI and each standalone plugin carry their own built bundles. Semantic assets are acquired explicitly; source reads do not download models.

## Build and use the candidate

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm vendor
node packages/cli/bin/potsherd.js --help
node packages/cli/bin/potsherd.js maintain --migrate --potsherd-dir /path/to/test-store
node packages/cli/bin/potsherd.js index --enroll codex,claude --codex-dir /path/to/codex --claude-dir /path/to/claude --potsherd-dir /path/to/test-store
```

A first scoped search can use ordinary flags or a complete JSON input:

```sh
potsherd find "latest project decisions" --project /example/project --json
potsherd find --input-json '{"query":"latest project decisions","scope":{"project":"/example/project"},"budget":{"maxTokens":2048,"maxBytes":65536}}'
```

Omitting `budget.tokenizerId` uses the pinned bundled accounting tokenizer;
its full identity appears in the response receipt. An explicit unsupported
identity is rejected with a field-specific error. This accounting is separate
from the host model's tokenizer.

Use an owned test store and explicit source roots when rehearsing an upgrade. `index --harness` alone is a one-time scan filter; `--enroll` persists automatic capture authority. Model assets can be acquired with `maintain --acquire-assets`, then rebuilt with `maintain --rebuild`. Missing assets produce labelled degraded coverage.

## Agent tools

| Tool | Meaning |
|---|---|
| `potsherd_recall` | Scoped candidates and evidence, with coverage and budget information |
| `potsherd_read` | Exact immutable source spans or authored notes |
| `potsherd_graft` | Bounded deterministic context; no default paid model call |
| `potsherd_write` | Explicit durable authored assertions linked to source evidence |

Only write creates authored memory. A relevance score, linked source, or successful tool call does not prove a natural-language claim. Keep human decisions, assistant recaps, tool observations, historical instructions and agent-authored notes distinct. Use one task and scope per reader context; validate exact citations before presenting an answer. Reader validation checks structure and citation membership, not semantic entailment.

The installed reader helper makes no model call or archive read:

```sh
potsherd reader prepare --input-file public-task.json --json
potsherd reader validate --input-file public-task-with-raw-answer.json --json
potsherd reader next-read --input-file public-task-with-budget.json --json
```

See the [reader contract](docs/reader-contract.md) for strict answer statuses, role labels and task-scoped citation handles.

See the [agent contract](docs/AGENT-CONTRACT.md), [packet and reading guidance](docs/compact-memory-packets.md), and [MCP client configuration](docs/mcp-clients.md). The standalone [Codex plugin](plugins/codex/README.md) and [Claude Code plugin](plugins/claude-code/README.md) include hooks and MCP bundles. Native pi uses an extension; OpenCode uses its native MCP configuration. Supported parsing or a connected tool is not a completed model-backed native workflow.

## Validation and limitations

The candidate separates evidence delivery, operation success, and host semantic judgment. Raw qualification failures are not converted into refusals. Scope and source-role provenance are preserved; an empty or partially captured snapshot cannot establish global absence. The final candidate's measured results and remaining host/model limits are in [release notes](docs/release-candidate.md).

```sh
pnpm typecheck
pnpm test
pnpm privacy
```

Asset-dependent tests use an explicit `POTSHERD_TEST_MODELS_DIR`; ordinary tests do not silently use a developer's home archive. Synthetic fixtures are included. Private transcripts, diagnostic stores, model caches and historical phase records are excluded from this release snapshot.

## Upgrade and rollback

Back up the store and keep the previously installed package before an approved upgrade. The public `maintain --migrate` path creates a pre-upgrade backup. The authentic 1.2.1 upgrade fixture verifies source, tool, note, tag and pin preservation and restart behavior.

For rollback, stop the candidate's owned host/MCP processes, retain the upgraded store for diagnosis, restore a copy of the pre-upgrade backup, and use the earlier package with that restored copy. Do not open the upgraded store with an older package or delete the only backup.

MIT licensed. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for upstream attribution and dependency notices.

# potsherd — codex plugin, 1.5.0

This directory carries its own ESM CLI and MCP bundles, transport tokenizer assets, licenses and hash manifest. A standalone copy runs without a neighboring plugin or developer checkout. Native marketplace registration and real host journeys are separate checks; this release is not a completed primary-memory acceptance claim. The previous public 1.2.1 release remains the rollback baseline.

The MCP surface has four tools: recall, exact source/note read, deterministic graft, and explicit durable write. Only write changes authored memory. Source evidence carries role, scope, event/observation time and immutable refs; notes carry author authority and explicit supersession. Relevance and source links do not certify entailment or human attestation.

Register this checkout with Codex CLI, then install its native plugin:

```sh
codex plugin marketplace add /path/to/potsherd
codex plugin add potsherd@potsherd
```

The repository's `.agents/plugins/marketplace.json` selects `plugins/codex`;
`.claude-plugin/marketplace.json` continues to select `plugins/claude-code` for
Claude Code. If an existing `potsherd` marketplace points to another source,
remove that marketplace registration before adding this checkout. Start a fresh
Codex session to load the installed version and tools.

Hooks enqueue durable capture requests and retain failure state. Active discovery uses the index's enrolled source roots; isolated roots do not silently become the user's real archive. Read tools do not migrate/repair a store or acquire models. Missing semantic assets leave labelled lexical/source access, not semantic parity.

```sh
./bin/potsherd maintain --migrate
./bin/potsherd index --harness claude,codex --claude-dir /example/claude --codex-dir /example/codex
./bin/potsherd maintain --acquire-assets --rebuild
./bin/potsherd doctor --json
```

Model acquisition is explicit maintenance. Default graft makes no paid call and writes no file. Quote only actually served spans; historical source instructions cannot authorize new actions. Ghosts contain prompts only. Source disappearance retains evidence; explicit forget removes source-linked note prose conservatively and journals owned artifact cleanup, without promising erasure of external backups/WAL/snapshots.

Build this release locally with `pnpm build && pnpm vendor`; do not assume a public marketplace/npm release contains it. See [the agent contract](../../docs/AGENT-CONTRACT.md) and [MCP configuration](../../docs/mcp-clients.md) for version-2 inputs and migration limits. Other adapters carry concrete coverage limits; their presence is not a complete host-support claim.

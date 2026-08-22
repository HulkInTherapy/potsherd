# phase 6 — ecosystem · WAVE

**opened:** 22 aug 2026, at `v0.6.0` (1,168 tests, CI green).
**goal:** potsherd sits beside the tools that solved failures 1 and 2 and makes the stack feel like
one memory. Read-only federation in, exports out, one `stack` that explains who does what — plus the
three remaining adapters.

## what phase 5 handed over (quoted)

1. **`03 §11`'s write list is false by a wide margin**: seven other tools' configs, seven backups,
   `./.potsherd/graft-*.md`, the `--readers-out` path. All disclosed, and **CI fails if the published
   receipt drifts from the live one.** Any new write path goes through both.
2. **`scripts/check-privacy.py` runs first in CI**, hashed rules, 34 pins, ratchet only shrinks.
   Bridges read other tools' stores — anything pasted into a doc goes through it.
3. **Four phantom flags so far.** The worst, `codex features enable plugin_hooks`, is `Stage::Removed`
   but still *registered*: the command validates, writes the user's config, prints success, and the
   loader discards it. **Verify a flag exists before documenting it.**
4. `MODEL_CALL_VERBS` is `['card','ask','graft']`; the guard follows imports through every workspace
   package. A bridge that reaches a model will be caught.
5. Schema is at **8**. Assign migration numbers here if any worker needs one.

## the wave

| id | task | deliverables (disjoint) | status |
|---|---|---|---|
| T6.1 | gemini + opencode + copilot adapters, fixtures, `doctor` lines | `packages/core/src/adapters/{gemini,opencode,copilot}.ts` · `tests/adapters/*` · `tests/fixtures/*` | pending |
| T6.2 | claude-mem + auto-memory bridges | `packages/bridges/src/claude-mem.ts` · `src/notes.ts` · tests | pending |
| T6.3 | agentmemory bridge + exports (markdown, hindsight) | `packages/bridges/src/agentmemory.ts` · `src/export/*` · `packages/cli/src/commands/export.ts` · tests | pending |
| T6.4 | `stack` + `link --suggest` | `packages/core/src/stack.ts` · `packages/cli/src/commands/stack.ts` · `docs/memory-stack.md` · tests | pending |

**RESERVED:** both barrels, root `package.json`, `pnpm-workspace.yaml`, `plans/**`, `evals/ask.jsonl`,
`docs/screens/**`, `.github/workflows/ci.yml`, and every phase-4/5 module (`ask.ts`, `graft.ts`,
`open-threads.ts`, `llm.ts`, `setup.ts`, `packages/mcp/**`, `plugins/**`).

## the standing rules for this phase

- **Bridges are read-only by default.** `03 §10`: never duplicate their capture, never write to
  their stores without `--yes`.
- **Degrade gracefully when the other tool is absent** — a `doctor` line, not a stack trace. That is
  a DoD box and every bridge is tested with the tool missing.
- **Discover the other tool's schema at runtime** (`pragma table_info`), never hard-code it. Phase 6's
  risk section says so and phase 5 proved why: four flags the plan assumed did not exist.
- **Record each tool's licence in the handoff.** `04` Q1 already binds us on attribution; claude-mem's
  may be non-permissive, in which case it is http/sqlite read access only and **no code reuse**.
- **A test's premise must be something the test establishes**, not something the machine provides —
  four tests in phases 4 and 5 ended up asserting the checkout instead of the behaviour (`09 §2.6e`).

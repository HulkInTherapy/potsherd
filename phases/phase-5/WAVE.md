# phase 5 — surfaces · WAVE

**opened:** 22 aug 2026, at `v0.5.0` (1,041 tests green).
**goal:** everything phases 0–4 built, reachable without leaving the agent — MCP server, Claude
Code plugin (skill + agent + hooks), codex plugin, `setup`.

## what phase 4 handed over (quoted, not paraphrased)

1. **`ask` is already a library.** `ask(db, question, opts)` returns `AskResult`, and
   `AskOptions.readerFn` lets a surface run the reader fan-out with **Claude Code's native Agent
   tool** instead of the SDK. Interface in `phases/phase-4/registration-T4.1.txt`.
2. **`ask` at k=6 takes ~100 s** (measured 40–183 s; one real haiku call through the SDK is
   60–160 s). Any surface calling it needs progress output, not a spinner. **Inside Claude Code,
   `readerFn` is the way around this** — native Agent calls are not SDK calls.
3. `graft` writes `./.potsherd/graft-<id8>.md` in the **cwd** — the one place potsherd writes
   outside `~/.potsherd`. **CI now fails if the published privacy receipt drifts from the live
   one.** Any new write path must go through both.
4. `MODEL_CALL_VERBS` is `['card','ask','graft']` and the guard follows a command's core imports
   through the barrel, so a verb reaching a model *indirectly* is caught.
5. Schema is at **8**. No migration in phase 4.
6. **Model-path screenshots are not capturable on this machine** — `claude -p` says `Not logged in`
   under a relocated `HOME`. A `POTSHERD_HARNESS_HOME` escape hatch in `llm.ts` would fix it and is
   proposed here as **T5.7**.

## the wave

`07`'s map makes T5.1 a serial prerequisite. It does not have to be: **the MCP tool contract is
pinned below by the orchestrator before the wave**, exactly as the phase-4 open-threads types were,
so the skill and agent can be written against it while the server is being built. Five workers.

| id | task | branch | deliverables (disjoint) | status |
|---|---|---|---|---|
| T5.1 | MCP stdio server, 6 tools, `--selftest` | `task/T5.1-mcp` | `packages/mcp/**` | pending |
| T5.2 | skills + agent | `worktree-agent-a6a0b98…` | `plugins/claude-code/skills/**` · `plugins/claude-code/agents/**` | **merged** |
| T5.3 | hooks + plugin manifest + marketplace | `task/T5.3-plugin` | `plugins/claude-code/.claude-plugin/**` · `hooks/**` · `.mcp.json` · `marketplace.json` | pending |
| T5.4 | codex plugin | `task/T5.4-codex` | `plugins/codex/**` | **held** until T5.3's manifest exists, so two workers do not guess independently at the same structure |
| T5.6 | `ask --readers-out` / `--readers-in` | `task/T5.6-readers-io` | `packages/cli/src/commands/ask.ts` · `tests/ask.test.ts` | pending — added mid-wave from T5.2's finding |
| T5.5 | `potsherd setup` | `task/T5.5-setup` | `packages/cli/src/commands/setup.ts` · `packages/core/src/setup.ts` · `tests/setup.test.ts` | pending |

**RESERVED — no worker edits these.** `packages/core/src/index.ts`, `packages/cli/src/index.ts`,
`package.json`, `pnpm-workspace.yaml`, `README.md`, `plans/**`, `evals/**`, `docs/screens/**`,
`.github/workflows/ci.yml`, and every phase-4 module (`ask.ts`, `graft.ts`, `open-threads.ts`,
`llm.ts`). Workers report the exact line; the orchestrator adds them in one commit.

## the pinned MCP contract (fixed before the wave, from `03 §9`)

Six tools, no more — agentmemory's 54 is the named anti-pattern.

```
potsherd_find   { query, project?, harness?, since?, until?, tag?, sidechains?, ghosts?,
                  pinned?, limit? }        -> { sessions[], hits[], k, weights, relaxedLists }
potsherd_read   { session, start_line?, end_line? }   -> paginated exchanges + seq numbers
potsherd_ask    { question, k?, strict?, filters? }   -> AskResult (see phase-4 registration)
potsherd_graft  { session, about?, budget? }          -> GraftResult
potsherd_ls     { project?, tag?, pinned?, ghosts?, since?, limit? }  -> session rows
potsherd_tag    { session, add?[], remove?[] }        -> the session's tags after the write
```

Rules binding on every worker: **errors are returned as tool errors, never a crash**; every tool is
read-only except `potsherd_tag`; nothing writes outside `~/.potsherd` except `potsherd_graft`'s
brief, which lands in the cwd and is already disclosed by `doctor --privacy`.

## the orchestrator's own job this phase

`07` is explicit: **the in-Claude-Code manual tests are the orchestrator's**, because they need an
interactive session. Four of the DoD boxes can only be closed that way:

- `/potsherd find`, `/potsherd ask`, `/potsherd graft` invoked for real
- a natural "what did we decide about X last month?" prompt firing `remembering-sessions`
  **unprompted**
- `/potsherd graft <x>` visibly changing the next answer in the same session
- the hook's no-change path measured under 1 s

Transcripts get pasted into `HANDOFF.md`. A box I cannot demonstrate is recorded OPEN, not passed —
`plans/08` already carries one such box from phase 3 for exactly this reason.

## worker log

### T5.2 — merged

Answered the question its brief put to it directly, and the answer was no.
**A SKILL.md cannot supply `readerFn`** — it is a TypeScript closure handed to `ask()` by a
TypeScript caller, and a skill's only executable surfaces are Bash and Claude Code's tools. So the
plugin's `ask` reproduces the fan-out's *shape* (binary shortlist → six native Agent readers →
synthesis, with `READER_SYSTEM` quoted verbatim from `ask.ts`) but **loses `filterAnswer`**, the
code-enforced citation filter that is this product's central claim. It says so on its own last line
and routes to `potsherd ask` for the code-checked answer. **It does not claim the guarantee.**

Then it specified the fix rather than leaving the hole: `--readers-out` / `--readers-in`, buildable
**entirely through the existing public `AskOptions`** with zero edits to `ask.ts`. Added as **T5.6**.

Two things it caught that would have failed silently:
- **plugin name and `.mcp.json` server key must both be `potsherd`** — tools resolve as
  `mcp__plugin_<plugin>_<server>__<tool>`, so renaming either leaves the agent **with no tools**
  rather than failing to load. Relayed to T5.3 mid-flight.
- **`plugins/claude-code/bin/potsherd` was in nobody's DELIVER list** and `/potsherd` is inert
  without it. My omission in this table; assigned to T5.3.

It also **verified two plan facts instead of "correcting" them**: `arguments: verb rest` is a real
skill field, and the space in `Bash(${CLAUDE_PLUGIN_ROOT}/bin/potsherd *)` is correct for a skill
where the `Bash(git:*)` colon form is settings syntax. Everything checked twice, against live docs
**and** real installed plugins, pinned to Claude Code **2.1.239**.

Three candidate descriptions for `remembering-sessions` sit commented in its frontmatter; it ships
the imperative-first one. **The orchestrator tests all three** — see the 11-step script in
`phases/phase-5/registration-T5.2.txt` §3.

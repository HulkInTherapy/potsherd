# phase 5 — surfaces · HANDOFF

**date:** 22 aug 2026 · **tests:** 1,168 green, 28 files · **`--version`:** 0.4.0 → tag `v0.6.0`

Everything phases 0–4 built, reachable without leaving the agent. **16 verbs, an MCP server, two
plugins, and a privacy guard over the whole repo.** Three definition-of-done boxes are recorded as
failed or open rather than smoothed over; one of them — a working marketplace install — is the
install story for every user who is not us.

**16 verbs:** `audit rescue guard index ls find show card tag pin unpin link stats ask graft setup doctor`.

---

## what shipped

| deliverable | state |
|---|---|
| `packages/mcp` — stdio server, **exactly 6 tools**, `--selftest` (20 checks) | done |
| `plugins/claude-code` — 2 skills, 1 agent, 3 hooks, a bin shim, marketplace manifest | done |
| `plugins/codex` — manifest, MCP config, hooks, shim | done, **largely unverified** (codex is not installed here) |
| `potsherd setup` — 7 MCP clients, merge-not-clobber, consent + diff | done |
| `ask --readers-out` / `--readers-in` — the plugin's `ask` now runs `filterAnswer` | done |
| `scripts/check-privacy.py` — repo-wide, hashed rules, pin ratchet, first CI step | done |

### the two that mattered most

**`--readers-out` / `--readers-in`.** T5.2 established that a SKILL.md **cannot** supply
`readerFn` — it is a TypeScript closure and a skill is markdown — so the plugin's `ask` reproduced
the fan-out's shape while losing `filterAnswer`, this product's central claim. It said so on its own
last line rather than claiming the guarantee. Then it specified the fix; T5.6 built it with
**zero edits to `packages/core/src/ask.ts`** (`git diff` on that file: 0 lines). `--readers-out`
makes zero model calls *by construction* — no reader reports `found`, so `ask()` takes its own early
return above the only line that opens a backend. The plugin now routes through it, and the citation
filter runs on the fast path.

**The hooks.** They resolved `command -v potsherd` first, and PATH here holds the stale phase-0
`0.1.0`, which has no `index` verb — so `SessionEnd` exited 0 having indexed nothing, forever, with
the error going to `/dev/null`. Phase 0's own ruling, violated by the phase that inherited it. They
now call the plugin's shim, **probe the capability** (`index --help`, the exact verb `SessionEnd`
runs) rather than comparing version strings, and — because `SessionEnd` **cannot speak at all**, its
`systemMessage` being discarded by design — write failures to `hook-failures.log`, which the next
`SessionStart` reads out and clears. **No path now exists where a hook fails silently.**

---

## measured, on this machine

| | measured | target | verdict |
|---|---|---|---|
| `SessionStart`, nothing to do | **128–146 ms** | < 1 s | **met** (was 28 ms before the capability probe) |
| `SessionEnd` | 16.7–20.5 ms | — | recorded |
| brief injection, disabled (default) | 23–60 ms | — | recorded |
| MCP `--selftest` | 20 checks, 312 ms | — | met |
| `potsherd_ask` with no backend | **0–1 ms** to a tool error | not ~100 s | met |
| `--readers-in` replay vs a normal `ask` | 8.2 s / 1 call vs 21.8 s / 2 calls | — | a **floor**: the fixture has one reader, the real shape is six |

Detachment was **proved, not asserted**: with the archive wiped so the rescue had real work, the
hook returned at **7.0 ms** while the archive filled 0 → 36 → 180 → 283 over the next 1.75 s.

---

## the definition of done, rated honestly

| box | verdict |
|---|---|
| `06` standard met | **PASS** — the two sub-boxes that failed at verification are fixed |
| all four surfaces demonstrated with pasted transcripts | **PASS for three** (CLI, MCP, claude-code plugin — evidence below). **codex: OPEN**, not installed on this machine |
| `/potsherd graft <x>` visibly changes the next answer | **PASS**, with a control — `evidence-orchestrator/graft-changes-the-answer.md` |
| model-invoked recall fires on a natural "last time…" prompt | **PASS**, with a negative control — `evidence-orchestrator/model-invoked-recall.md` |
| hooks never block: < 1 s no-change path | **PASS** — 128–146 ms, and detachment proved separately |
| plugin passes the validator **and a local marketplace install** | **FAIL on the second half.** The validator passes clean. A marketplace install does **not** work: `dist/` is gitignored, so a clone has neither the CLI bundle nor the MCP server — all six tools vanish and `session-archaeologist` is left with `Read`. `npm view potsherd version` → **404** |
| `/potsherd graft` recorded as a screen capture for `docs/screens/` | **OPEN** — `15-graft.txt` exists from phase 4; no phase-5 capture of the in-Claude-Code moment |

### the interactive boxes, and why they are checkable

`plans/07` assigns these to the orchestrator because they need an interactive session. They do not:
`claude -p --plugin-dir … --output-format stream-json --verbose` exercises the same path and, unlike
an interactive session, **leaves a machine-readable record of every tool the model chose.** Both
positive cases were run with a control, because a demonstration without one proves nothing.

```
"what did we decide about pgbouncer … last month?"     → Skill(remembering-sessions) → Agent
                                                         → 5× potsherd_find, 1× potsherd_ls
"what does a connection pooler do, in general?"        → NO TOOLS. answered directly.
```

```
/potsherd graft <id> …          → Bash(bin/potsherd graft) then Bash(cat the brief)   ← 03 §9's
                                                                    "reads it straight into context"
same session, resumed           → 1 turn · 5.9 s · zero tools · correct · carried its source line
same question, no brief         → 16 turns · 88 s · 15 Bash calls · confidently WRONG, about a
                                  different event, citing a real commit hash
```

That last line is the sharpest result in the phase. **The failure mode without potsherd is not
silence — it is a plausible answer assembled from whatever is nearest to hand**, which is `01`'s
archive amnesia, reproduced by accident.

---

## verification: 15 defects, the run is 12 · 8 · 9 · 7 · 13 · **15**

Full detail in `VERIFICATION.md`. The two critical ones:

1. **`--readers-out` made real model calls under a flag documented as making none** — and
   `doctor --privacy` said of that path *"no model was called to write it"*. **This was the
   orchestrator's**: the two forwarding lines went into `find.action` instead of `ask.action` during
   integration. It shipped green because **every T5.6 test calls the helpers directly and nothing in
   1,137 tests went through commander.**
2. **A SKILL.md's frontmatter was truncated by its own comment block.** A `# ------` line reads as
   the closing `---` fence, so Claude Code saw `name:` and stopped — losing the `description` (the
   only thing that decides whether a model-invocable skill fires) *and* `user-invocable: false`.

---

## what phase 6 must know

1. **`03 §11`'s "writes only `~/.potsherd` and one key in `~/.claude/settings.json`" is now false by
   a wide margin**: seven other tools' configs, seven backups beside them, `./.potsherd/graft-*.md`
   in the cwd, and the `--readers-out` path. All disclosed; **CI fails if the published receipt
   drifts from the live one.** Any new write path must go through both.
2. **`scripts/check-privacy.py` runs first in CI, before `pnpm install`.** New rules are **hashed**,
   so it bans a real session id without publishing one. 34 pins, and the ratchet only lets that
   shrink. Bridges read other tools' stores — anything you paste into a doc goes through this guard.
3. **Four phantom flags so far** (`rescue --background`, `index --card`, a `brief` verb, and
   `codex features enable plugin_hooks`). The last is the worst shape: it is `Stage::Removed` but
   still *registered*, so the command validates, writes to the user's config, prints success, and
   the loader discards it. **Verify a flag exists before documenting it.**
4. `MODEL_CALL_VERBS` is `['card','ask','graft']` and the guard now follows a command's imports
   **through every workspace package**, so a verb reaching a model two hops away is caught.
5. Schema is still at **8**. No migration in phase 5.

## open items carried forward

| item | picked up by |
|---|---|
| **a marketplace install does not work** — `dist/` gitignored, npm package unpublished. Repair proposed (vendored `dist` + a first-run, announced `npm install` of the two native deps; or prebuilt binaries), **not implemented** | 7 |
| the codex plugin is **inferred from documentation**, never loaded by codex | 6 or 7 |
| no phase-5 screen capture of the `/potsherd graft` moment | 7 |
| `skills/potsherd/SKILL.md`'s `allowed-tools` under-declares: it instructs the model to dispatch `Agent` and does not list it. T5.9 declined to guess the identifier — the same class as D3, a declaration that looks complete and is not | 7 |
| `03 §9` still lists `mcp` and `export` as CLI verbs; neither exists | 7 |
| `recall.ts` carries 4 comments citing a real session title as measurement evidence; re-deriving them against the demo corpus is a measurement, not an edit | 7 |
| `README.md` is stale by two phases — no plugin install, no `setup`, no MCP server | 7 |
| inherited: `ask` p50 ~100 s vs 20 s; `ask` output 25–33 rows vs 24; the fusion gate | 7 |

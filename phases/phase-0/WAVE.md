# phase 0 — wave tracker

Phase 0 predates `plans/07-ORCHESTRATION.md`, which was added to the plan folder while this phase
was in flight and applies from the phase-1 boundary. Phase 0 was therefore executed directly by
the main session rather than by a worker wave. The one part of `07` that applies retroactively —
**the verifier must not be the author** — was honoured: verification ran in a fresh worker.

| task | executed by | branch | status | note |
|---|---|---|---|---|
| scaffold: repo, workspaces, MIT, NOTICE, CI | main session | `main` | done | `6697ca9`, `95b0249` |
| T0.1 scan (no parse) | main session | `main` | done | `claude/scan.ts`, head/tail 64 KB windows |
| T0.2 audit card | main session | `main` | done | `render/audit-card.ts` + `render.ts` grid |
| T0.3 rescue: archive copy + ghosts | main session | `main` | done | `rescue.ts`, `consent.ts` |
| T0.4 guard | main session | `main` | done | `guard.ts`, `resolve-bin.ts` |
| T0.5 verify script | main session | `main` | done | `scripts/verify-audit.py` |
| doctor (added; `06` requires it) | main session | `main` | done | `doctor.ts` |
| **verification** | **worker (fresh context, not the author)** | — | see `VERIFICATION.md` | ran every command in the phase file on the real corpus |

## from phase 1 onward

`07-ORCHESTRATION.md` is binding: the main session is an orchestrator that writes no product
code. Each phase runs as serial prerequisite → parallel wave in git worktrees → integration
worker → fresh verifier worker. Each phase gets its own `WAVE.md` in this format.

## defects found after the phase-0 commits

| # | defect | found by | status |
|---|---|---|---|
| D1 | `tests/audit.test.ts` "computes days left from mtime" depends on the fixture's mtime, which git does not preserve. Passes locally (the generator sets mtimes), fails on a fresh clone: `expected 30 to be 10`. The test must set the mtime itself on a temp copy. | GitHub Actions, all 4 matrix legs | open — fix pass |

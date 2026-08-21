# phase 2 — cards · wave tracker

Goal: every session (live, archived, or ghost) gets a verified structured card; `ls` becomes
something you can scan; tags, pins and links exist. **The first phase that calls a model.**

Run per `plans/07-ORCHESTRATION.md`: serial prerequisite → parallel wave in git worktrees →
integration → a fresh verifier that is not the author.

## the wave

| stage | task | branch | status | notes |
|---|---|---|---|---|
| serial | T2.1 `core/src/llm.ts` — the single entry for every model call | merged | **done** | 3 backends, estimator, caps, redaction enforced inside the module. One real agent-sdk call: 5.4s warm, haiku-class |
| parallel | T2.4 tags / pins / links / `ls` filters | merged | **done** | `--linked-to` works from both sides; filters compose |
| parallel | T2.2 ProMem-lite card pipeline | `task/T2.2-cards` | running | needs T2.1. Runs for real on the frozen corpus |
| parallel | T2.3 ghost cards (prompts only) | `task/T2.3-ghost-cards` | pending | needs T2.1 |
| parallel | T2.5 `ls --resume-menu` | merged | **done** | every line is a command or a `#` comment; `sh -n` accepts it |
| integration | card → `cards_fts` + `vec_cards`, markdown mirror, `find` fusion | — | pending | turns on the two lists phase 1 left switched off |
| verify | fresh verifier vs the definition of done | — | pending | never the author |

## what phase 1 handed over

- `cards_fts` and `vec_cards` are **wired but switched off, not faked** — `recall.ts`'s `LISTS`
  already names them; turning them on is two entries in the same loop once `card` writes rows.
- `--tag` and `--pinned` already parse and filter correctly; nothing writes the tables yet.
- schema is at **migration 5**; migration 5 is the model to copy (additive, versioned,
  `ON DELETE CASCADE`).
- **redaction must run before anything reaches a model**, not just before the index.
  `redactExchange()` and `redact-elide.ts` are the entry points.
- embedding is ~190 ms per exchange and **batching does not help**. Cards are far fewer than
  exchanges, so `vec_cards` is affordable.
- `format.ts`'s `elide`/`clip`/`joinFit`/`elideMiddle` take the `Theme` now — pass it, or ASCII
  width arithmetic is wrong.

## the cost rule for this phase

`03 §12`: cards for all sessions under **15 minutes and under $2** on haiku-class. `04` Q4: the
Agent SDK on the user's own subscription, so the marginal cost is effectively zero — but the
estimator and the cap are mandatory and on by default regardless. **No model call happens before
a dry-run estimate has been shown.**


## defects to fix before the phase-2 tag

| # | defect | found by | status |
|---|---|---|---|
| V1 | **`potsherd --version` reports 0.1.0 at tag v0.2.0.** The version is hard-coded in four places (`packages/cli/src/index.ts:19`, `packages/core/src/index.ts:282`, `packages/cli/src/commands/doctor.ts:440`, `packages/cli/package.json:3`) and nothing bumped them. Fix with one source of truth rather than four, and add a test that the binary's version matches `packages/cli/package.json` | orchestrator | open — after T2.2 merges, to avoid a conflict |

## the cost reality, measured

`03 §12`'s "30 sessions, < 15 min, < $2" was written before sidechains and ghosts were
first-class. The real scope of `card --all` is **126 targets** (36 sessions + 90 ghosts; 429 more
fall below the ≥3-exchange / ≥5-prompt floor) = 324 calls, 2.5M in / 126k out, **$3.16 equivalent,
64 min serial or 9.9 min at concurrency 6**. Time is met with concurrency; cost is over on the api
path only, which `04` Q4 already made the fallback. `03 §12` has been restated with the measurement
and `04` carries the decision.

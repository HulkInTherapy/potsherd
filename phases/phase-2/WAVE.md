# phase 2 — cards · wave tracker

Goal: every session (live, archived, or ghost) gets a verified structured card; `ls` becomes
something you can scan; tags, pins and links exist. **The first phase that calls a model.**

Run per `plans/07-ORCHESTRATION.md`: serial prerequisite → parallel wave in git worktrees →
integration → a fresh verifier that is not the author.

## the wave

| stage | task | branch | status | notes |
|---|---|---|---|---|
| serial | T2.1 `core/src/llm.ts` — the single entry for every model call | `task/T2.1-llm` | pending | gates T2.2 and T2.3 |
| parallel | T2.4 tags / pins / links / `ls` filters | `task/T2.4-tags` | pending | **no llm dependency — starts at phase start** |
| parallel | T2.2 ProMem-lite card pipeline | `task/T2.2-cards` | pending | needs T2.1 |
| parallel | T2.3 ghost cards (prompts only) | `task/T2.3-ghost-cards` | pending | needs T2.1 |
| parallel | T2.5 `ls --resume-menu` | `task/T2.5-resume` | pending | tiny; no llm |
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

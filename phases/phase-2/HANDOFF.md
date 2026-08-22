# phase 2 — cards · HANDOFF

**tag:** `v0.3.0` · **date:** 21 aug 2026 · **tests:** 792 green

Every session — live, archived, or ghost — gets a verified structured card. `ls` became something
you can scan. Tags, pins and links exist. **The first phase that calls a model**, on the user's own
subscription, behind a mandatory estimate and a hard cap.

---

## what shipped

| deliverable | state | where |
|---|---|---|
| `core/src/llm.ts` — one entry for every model call; agent-sdk / `codex exec` / api-key backends; dry-run estimator; `--max-usd`; **redaction enforced inside the module** | done | a caller cannot reach a model with raw text |
| `potsherd card [session\|--all\|--ghosts-only] [--dry-run] [--max-usd] [--force] [--export]` | done | ProMem-lite, five steps, `03 §6` |
| ghost cards from the prompt side alone | done | `outcome: unknown`, `source: prompts-only`, 90/90 |
| `tag` / `pin` / `link`, and `ls --tag --pinned --linked-to --untitled --ghosts …` | done | filters compose; `--linked-to` works from both ends |
| markdown mirror + `card --export <dir>` | done | `~/.potsherd/cards/<harness>/<slug>/<id>.md` |
| `ls --resume-menu` | done | every line a command or a `#` comment; `sh -n` accepts it |

### the real runs, on this machine

```
35 sessions   225 calls   55m 25s   $12.93 equivalent · $0 charged
90 ghosts      96 calls   ~33m      ~$9  equivalent · $0 charged
claims 261 (sessions) + 430 (ghosts) kept · 5 + 54 dropped
evidence_seq  374/374 resolve on sessions · 287/287 on the verifier's independent run
outcome unknown  90/90 ghosts       source prompts-only  90/90 ghosts
```

Evidence directories were **kept**, not discarded: `potsherd-t27-evidence`,
`potsherd-t27-repro-120s`, `potsherd-t27-verifier-ten` beside the repo.

---

## decisions taken in this phase

1. **The evidence bar is 0.6, not `03 §6`'s original 0.5** — measured, not chosen. Over 261 real
   claims: true claims median **0.70** against their own cited exchanges; the same claims
   deliberately re-pointed at another session's exchanges median **0.50**, and **38 of 74 controls
   still cleared 0.5**. At 0.6 controls fall to ~10% and true claims lose ~10%.
2. **The estimator is fitted to twelve real calls and self-corrects.** `ms ≈ 46,200 + 915/1k chars`,
   `$0.016 + $1.057/1M chars`, effective concurrency `1 + (n−1)×0.8`. Every finished run is
   recorded in `card_runs` (migration 6) and scales the next estimate on that machine.
3. **The LLM timeout is 360 s**, derived from the call profile: the largest prompt the slicer
   builds is 60k chars → 101 s serial → ×2.43 measured concurrency-6 stretch → ×1.15 worst
   residual = 282 s worst credible, rounded up with headroom. A deadline is retried once; a
   refusal is not.
4. **A ghost summary describes what the user asked for, never what was built.** Enforced in the
   prompts-only system prompt, because the summary is the one field `verify` does not gate and the
   one `ls` and `show` put in front of the reader.

---

## what phase 3 must know

1. **The fusion still loses, and that is now measured three ways.** bm25 8/10, vectors 6/10,
   hybrid 6/10 — unchanged by cards joining the lists, and at recall@1 cards make it slightly
   worse. `pnpm evals` prints the verdict against itself. **Phase 3's gate is exactly this**, and
   the diagnosis from phase 1 still stands: vectors genuinely help where bm25 fails (they find one
   concept query at rank 3 that bm25 misses entirely), but **ghosts carry no embeddings and get
   drowned whenever the vec list is on**. Embedding ghost prompts, or scoring absence from a list
   rather than letting absence read as a low rank, are the two obvious moves.
2. **`cards_fts` and `vec_cards` are live now** and joined for ghosts as well as sessions — that
   needed a second `ghosts`-joined query, not a `LEFT JOIN`, which would defeat the bound-parameter
   filter builder.
3. **Caveat on the eval corpus**: only 4 of 24 fixture sessions clear the ≥3-exchange floor, so the
   card list competes at ~17% completeness. Phase 3 grows the set to 25 queries; grow the carded
   fixture corpus with it or the card lists stay under-powered.
4. **Migrations are at 6.** `card_runs` is the newest and is the model for anything that needs to
   learn from a previous run.
5. **A constant encoding a measured trade-off needs a test that fails when it moves.**
   `EVIDENCE_COSINE` sat at 0.5 for a day while the spec said 0.6 and all 81 card tests passed at
   either value.

---

## how to verify this phase

```bash
cd /Users/zebra/randomness/potsherd
pnpm install && pnpm build && pnpm test && pnpm typecheck    # 792 tests

TMP=$(mktemp -d)
node packages/cli/bin/potsherd.js index --full --no-embed \
  --claude-dir ~/.potsherd/archive-manual-2026-08-21 --potsherd-dir $TMP
node packages/cli/bin/potsherd.js rescue --yes --no-settings \
  --claude-dir ~/.potsherd/archive-manual-2026-08-21 --potsherd-dir $TMP
node packages/cli/bin/potsherd.js card --dry-run --all --potsherd-dir $TMP   # calls nothing
node packages/cli/bin/potsherd.js card --ghosts-only --limit 5 --potsherd-dir $TMP
node packages/cli/bin/potsherd.js ls --potsherd-dir $TMP
node packages/cli/bin/potsherd.js show <id8> --potsherd-dir $TMP             # the card, then the transcript
node packages/cli/bin/potsherd.js doctor --privacy --potsherd-dir $TMP       # names what leaves the machine
```

**Verifier's report:** `phases/phase-2/VERIFICATION.md`. It found nine defects; seven code defects
were fixed in T2.7, one was fixed by the verifier itself, and one is a plan correction (below).

---

## open items carried forward

| item | state | picked up by |
|---|---|---|
| **the recall fusion loses to bm25 alone** — measured three times now | open, well-diagnosed | phase 3, whose gate is exactly this |
| **the estimator is still ~2× optimistic** even after the re-fit: it quoted 2m 52s / $0.473 for a 10-ghost run that took 5m 5s / $0.957. Inside the 2× acceptance bar, but the bias is one-directional | open | the self-correction should close it as runs accumulate; re-check in phase 7 |
| **`scripts/make-screens.sh` fails its own assertion** — `13-find-redacted.txt` comes back with no mask because the `find` snippet now elides mid-mask; `09-find.txt` also reshuffles where bm25 scores tie | open | phase 7 owns the screens; fix the elision so a mask is never cut |
| **one ghost summary still oversteps** (id withheld — T8.H, 22 aug 2026: a session id is family (2) corpus identity and this repo is public; the ghost is the one `phases/phase-2/VERIFICATION.md` reports as the worst of its ten. It is a personal-journal session whose prompts narrate the person's own life, and the summary repeats them as completed facts). 9 of 10 are clean | open, small | phase 7 polish |
| `03 §12`'s numbers were estimator output, not measurement | **corrected in the plan** | — |
| `docs/screens/` has no `ls`-with-cards or before/after shot | open | phase 7 |
| `card --all` at full scale is ~1h 25m and ~$22 equivalent ($0 charged) | recorded miss vs the 15 min / $2 target | phase 7 records it in the README |

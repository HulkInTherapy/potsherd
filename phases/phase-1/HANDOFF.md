# phase 1 — foundation · HANDOFF

**tag:** `v0.2.0` · **date:** 21 aug 2026 · **tests:** 518 green on macos + ubuntu, node 22 + 24

A sidechain-aware, multi-harness, redacted, offline index with a `find` that answers in under
150 ms. Still zero model calls: everything in this phase runs with no key, no account and no
network.

---

## what shipped

| deliverable | state | where |
|---|---|---|
| `packages/core` = hand-ported `obra/episodic-memory` v1.4.2, `NOTICE` + credit, upstream sha recorded | done | `docs/upstream/PORT-LOG.md` lists every upstream file: ported, adapted or refused |
| adapters: claude (top-level + sidechains + sdk + titles), codex, cursor, pi | done | `packages/core/src/adapters/` |
| gemini / opencode / copilot stubs `doctor` reports as "phase 6" with the path | done | `doctor` |
| store per `03 §3` + fts5 + `vec_exchanges` | done | `db.ts`, migrations 1–5 |
| redaction per `03 §5` with ported rule packs + entropy | done | `redact.ts`, `redact-rules.ts`, `redact-elide.ts` |
| `index`, `find`, `show`, `ls`, `stats`, `doctor [--privacy]` | done | each with `--json` and a `--help` example |
| `evals/queries.jsonl` + `evals/run.ts` printing recall@5 | done | `pnpm evals` |

### the numbers, measured on the frozen corpus

`~/.potsherd/archive-manual-2026-08-21`, which is the reference machine's corpus as it stood when
phase 0 archived it. The live `~/.claude` grows while agents run, so it supports floors only.

```
index --full --no-embed        8.7s     236 transcripts · 328 MB
index --full (with vectors)    4m 11s   96% of it embedding 1,406 exchanges
index (incremental, no change) 67 ms

sessions   37 + 199 subagents        claude 30+197 · codex 1 · cursor 2+2 · pi 4
exchanges  1,406                     10,218 tool calls · 176 redacted
ghosts     299                       2,971 prompts (built by `rescue`, not `index`)
secrets    2,446 masked              entropy 2,290 · generic 147 · stripe 6 · aws 3
find       p50 114.7 ms              20 warm runs, process wall clock
recall@5   bm25 8/10                 the phase-1 gate is >= 8/10 — met
```

---

## decisions taken in this phase (all logged in `plans/04-DECISIONS.md`)

1. **The fork is a hand-port, not a subtree.** `git subtree add --prefix packages/core` is
   impossible — the prefix already held phase-0 code and git refuses. Upstream is a fetch-only
   remote (`upstream-episodic`), so `git log`/`git diff` against any upstream sha still work, and
   every ported file carries a provenance header. `NOTICE` names sha `10757690…`.
2. **Upstream gave less than the plan assumed.** It has **no fts5 and no bm25 at all** — its text
   search is `LIKE '%q%'` — and its store is exchange-only with no `sessions` table. Hybrid
   retrieval and the whole schema are potsherd's own. `research/competitors.md` corrected.
3. **The port improved on upstream in three places** rather than copying it: the exchange boundary
   uses the full human-prompt rule; tool results are paired by `tool_use_id` (upstream has a
   `TODO` and drops every result); sidechains are parsed as sessions in their own right.
4. **The cursor adapter reads `~/.cursor` only.** Title, model and git branch live in VS Code's
   `workspaceStorage` sqlite, which is not among the five read-only inputs `00-README.md` names.
   Reading it would widen potsherd's footprint into an editor's private state. The adapter
   recovers the cwd from inside `~/.cursor` anyway, and `doctor` states what is unknowable.
5. **Binary payloads are elided at ingest, before redaction.** Not doing so is what produced
   165,085 masks; 98.6% were base64 images in tool results. Now 2,444.

---

## corrections made to the plan folder

- `plans/research/formats.md` — **rewritten from 122 to 509 lines** against the real files. Every
  harness section was wrong somewhere. A "how these were measured" header and a per-harness
  "traps" subsection now exist; gemini/opencode/copilot are explicitly marked **unmeasured**.
- `plans/research/competitors.md` — upstream has 207 tests, not 38, and no fts5.
- `plans/04-DECISIONS.md` — twelve entries.
- **`plans/phases/phase-1-foundation.md` needs one correction the orchestrator should make:** it
  documents `find "…" --json | jq '.[0].session'`. The shipped shape is an object with `.sessions`
  (it also carries `vectors` and `ms`), so the incantation is `jq '.sessions[0].id'`.

---

## what phase 2 must know

1. **`cards_fts` and `vec_cards` are wired but switched off, not faked.** `recall.ts`'s `LISTS`
   already names them; turning them on is two entries in the same loop once `card` writes rows.
2. **`--tag` and `--pinned` parse and filter correctly** — nothing writes `tags`/`pins` yet.
3. **The schema is at migration 5.** Migration 5 added `session_record_types` and is the model to
   copy: additive, versioned, and it retires its rows with `ON DELETE CASCADE`.
4. **Redaction runs before anything reaches the index, and must run before anything reaches a
   model.** `redactExchange()` and `redact-elide.ts` are the entry points. The archive stays
   byte-exact and unredacted — that is verified, not assumed: two real API keys exist in the
   archive in plaintext and appear **zero** times in `potsherd.db`.
5. **Embedding costs ~190 ms per exchange and batching does not help.** Measured: batches of 1–16
   all cost ~215 ms and 32 costs 416 ms, while q8's per-pass activation scales put a batched
   vector ~3e-3 of cosine from a single-call one. `intraOpNumThreads: 4` is worth 24%. Cards will
   be far fewer than exchanges, so this is affordable for `vec_cards`.
6. **`ls` is a shareable moment and now looks like one.** Build every new verb's output with
   `Card`/`table` and `Theme`. Since T1.7a, `format.ts`'s `elide`/`clip`/`joinFit`/`elideMiddle`
   take the `Theme` so ASCII width arithmetic is correct — pass it.
7. **`recall.ts`'s title list is weight-scaled by query coverage.** The honest query set exposed a
   real ranking defect: `titleMatches` keeps whichever titles matched *best*, and when nothing
   matches well "best" is one common word out of six — a query for "stop counting the same event
   twice in the rollup" filled the page with sessions titled "…twice…" and pushed the real answer
   to rank 6. The list's weight is now scaled by the fraction of the query the best title covered.
   That one change is what took bm25 from 7/10 to 8/10; no query was touched to get there.
8. **A run reports what the run did; the index reports what the index holds.** Never label one as
   the other. This was a real defect (`index` printed "index holds no secrets" while the index
   held masks) and the rule now has tests behind it.

---

## how to verify this phase

```bash
cd /Users/zebra/randomness/potsherd
pnpm install && pnpm build && pnpm test && pnpm typecheck   # 518 tests

TMP=$(mktemp -d)
node packages/cli/bin/potsherd.js index --full --no-embed \
  --claude-dir ~/.potsherd/archive-manual-2026-08-21 --potsherd-dir $TMP
node packages/cli/bin/potsherd.js stats  --potsherd-dir $TMP
node packages/cli/bin/potsherd.js doctor --potsherd-dir $TMP
node packages/cli/bin/potsherd.js ls     --potsherd-dir $TMP
node packages/cli/bin/potsherd.js find "instagram client" --potsherd-dir $TMP
node packages/cli/bin/potsherd.js find "instagram" --sidechains only --potsherd-dir $TMP
pnpm evals
rm -rf $TMP
```

**Verifier's report:** `phases/phase-1/VERIFICATION.md`, written by a worker that authored none of
this phase. It found 8 defects; 7 were fixed and re-verified, 1 is carried below.

---

## open items carried into later phases

| item | state | picked up by |
|---|---|---|
| **hybrid recall scores *below* bm25 alone: 8/10 bm25, 6/10 vectors, 6/10 hybrid** on the honest query set. `pnpm evals` prints "plans/06 phase 3 would not merge this fusion" itself. The phase-1 gate (bm25 ≥ 8/10) is met; the fusion is not good enough. **Diagnosis for phase 3, already measured:** vectors genuinely help where bm25 fails — vectors-only finds one of the two concept queries at rank 3 and lifts the other to 6 — but **ghosts carry no embeddings and get drowned whenever the vec list is on**. Fixing the fusion probably means embedding ghost prompts, or scoring lists a session is absent from rather than letting absence read as a low rank | **open, measured** | phase 3, whose gate is exactly this |
| full index 4m 11s against `03 §12`'s 3 minutes | open, recorded | phase 3 or 7; `--no-embed` at 8.7s is the shippable path |
| the eval set is 10 queries over a small fixture corpus | by design | phase 3 grows it to 25 with 5 sidechain-only and 5 ghost-only |
| `show --html` | unimplemented (`--md` works) | phase 7 |
| upstream PR — **obra/episodic-memory#128 is already open** and overlaps `docs/upstream/PR-sidechain-flag.md` | prepared, **not submitted** | read #128 first; ours may be redundant |
| `artifact-comment-monitor` reports as a novel record type forever | open | phase 2, once we know if it carries anything |
| ghosts require `rescue`; `index` alone yields none | by design, now stated in the output | — |

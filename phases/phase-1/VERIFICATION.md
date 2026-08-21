# phase 1 — independent verification

Run by a worker with a fresh context that wrote none of this phase's code, per the review rule in
`plans/06-QUALITY-AND-EVALS.md` and the verifier rule in `plans/07-ORCHESTRATION.md`. It was asked
to be adversarial. It was right on every count.

Build: `pnpm install && pnpm build`, then `node packages/cli/bin/potsherd.js` (the `potsherd` on
PATH is the phase-0 build and was never invoked). Frozen corpus
`~/.potsherd/archive-manual-2026-08-21`; every write into a temp directory.

## definition of done

| box | verdict | evidence |
|---|---|---|
| `06` standard met; inherited + new tests green | **FAIL at verification** | 473/473 and typecheck green locally, but CI on `940a151` was red (an `onnxruntime-node` postinstall `ETIMEDOUT` — infra, since re-run), and `phases/phase-1/HANDOFF.md` did not yet exist |
| 30 + 197 claude (frozen), 1 codex, 4 cursor, 4 pi | **PASS** | sqlite: claude 30 top-level + 197 sidechains, codex 1, cursor 4, pi 4 = **236** sessions |
| sidechains searchable; ghosts searchable; sdk listed | **PASS**, with a caveat | all three verified. Caveat: `index` alone yields 0 ghosts — `rescue` must run first, so the plan's own command sequence returns nothing on a fresh directory |
| redaction fixture 6/6; `doctor` shows counts | **PASS** | the fixture is now **11/11** planted (a superset of the required 6); `doctor --json` → `{total: 2446, aws: 3, stripe: 6, generic: 147, entropy: 2290}` |
| `find` p50 < 150 ms; recall@5 ≥ 8/10 | **PASS**, with a caveat | 20 warm runs of `pgbouncer`: **p50 114.7 ms** process-wall (min 112.0, max 120.7), internal 7 ms. evals 10/10. Caveat: a query bm25 misses costs **471.9 ms**, because that is when the model is woken |
| `NOTICE` + readme credit; upstream sha recorded | **PASS** | sha verified live against `git ls-remote upstream-episodic` |
| draft PR prepared, not submitted | **PASS** | `docs/upstream/PR-sidechain-flag.md`, marked PREPARED/NOT SUBMITTED. `gh` search for `author:HulkInTherapy` on obra/episodic-memory → `total_count: 0` |

## the numbers, independently reproduced

```
index --full --claude-dir <frozen>
  claude 227 · 30 sessions · 197 sidechains   codex 1   cursor 4   pi 4
  exchanges indexed 1,406 · 10,218 tool calls · 176 redacted
  secrets masked 2,446 · vectors 1,406
  full index 4m 11s · 236 parsed · 328 MB        (03 §12 target 3 min — MISS, recorded)

sidechain ids matching '%:%' = 197
duplicate source_path rows = 0 · primary-key collisions = 0
frozen corpus sha256 before/after a full index: no change
~/.codex ~/.cursor ~/.pi sha256 before/after: no change
```

**Redaction, proved on real data rather than on the fixture.** Two distinct real `tvly-dev-…` API
keys exist in the frozen archive. **Zero** appear verbatim anywhere in `potsherd.db`; the mask for
the first appears 341 times. The archive itself is unredacted (119 archive files contain the
plaintext key) and byte-exact — the only two files that differ from their sources are exact
prefixes of them, because those sources are still being written. That is exactly the contract in
`03 §5`: the index is redacted, the archive is the user's own file.

## defects found

| # | severity | defect | outcome |
|---|---|---|---|
| D2 | **high (honesty)** | `doctor` reports per-run counters as index totals: after an incremental pass, `queue-operation` vanished from the record-type list entirely and `last-prompt` fell from 50 to 22. The same run printed **`secrets masked 0 · nothing matched — index holds no secrets`** while the index actually held 3 masks in 2 exchanges. Breaks `06`'s "unknown record types listed with counts, not hidden" | fix worker T1.7a |
| D3 | high | **`--ascii` does not produce ASCII.** `ls --ascii` emits 11× U+2026, `stats --ascii` 7× U+2014, `doctor --ascii` U+2026/U+00B7/U+2014, while `theme.ts` documents "replaces every non-ASCII glyph". Root cause: `format.ts`'s `elide`/`clip`/`joinFit` hard-default `ellip = '…'` and know nothing about the theme | fix worker T1.7a |
| D4 | high | **the eval's vector mode is a no-op** — `evals/run.ts:157` indexes with `embed: false`, so the run labelled `bm25 + vectors` ran with zero vectors. "hybrid ≥ bm25" was satisfied trivially | fix worker T1.7b |
| D5 | high | **the eval queries are tuned to pass.** Every query is a bag of words lifted near-verbatim from its target — `"webhook rate limited by the gateway"` against a prompt reading "the outbound webhook is getting rate limited by their gateway". With 11 candidates and recall@5, bm25 cannot lose. It proves plumbing, not ranking | fix worker T1.7b |
| D6 | medium | **`find` fails the screenshot test.** Snippets start mid-word; one top-3 result's only snippet was `[Image: source: /var/folders/…/clipboard-…`, showing nothing about why it matched; second snippet lines are often boilerplate lacking the query term. `doctor` truncates the record-type *name* (`cursor user:injected-continua…`), the one thing a reader needs. `ls` passes | T1.7a + T1.7b |
| D1 | low | `doctor` overflowed `--width 60` by exactly one character on every `known` record-type row | fixed by the verifier (1 line) |
| — | low | two raw NUL bytes in `packages/core/src/ingest.ts` make git and grep treat it as binary | T1.7a |
| — | low | the plan documents `find --json \| jq '.[0].session'`; the shipped shape is an object with `.sessions` | T1.7a to reconcile |

## could not verify

- **Ubuntu green** — macOS only; the ubuntu/node22 leg failed on a network flake and has been re-run.
- **the 3-minute full-index target** — measured 4m 11s with embeddings. Recorded as a miss.
- **that the prepared upstream PR applies cleanly** — the diff was never applied to an upstream
  checkout. **Note: upstream PR #128 ("make subagent and workflow (sidechain) conversations
  searchable") is already open and overlaps ours.**
- **`doctor --privacy` completeness** — the paths it claims were verified; syscalls were not traced,
  though before/after hashes of all four read-only corpora were identical.

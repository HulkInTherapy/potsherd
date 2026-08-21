# phase 4 — ask & graft · WAVE

**opened:** 21 aug 2026, at `v0.4.0` (844 tests green, CI green).
**goal:** the two verbs nobody else has — `ask` (interrogation with citations) and `graft`
(token-budgeted re-entry brief). Plus open-thread detection and the ask eval harness.

## what phase 3 handed over (quoted, not paraphrased)

1. `recall(db, query, filters, {k, lists})` returns `k`, effective `weights`, `relaxedLists` and
   `from[].contribution` — `ask` shortlists through it and can explain its own shortlist.
2. `find --json` carries `sessionId` and `isSidechain` per hit, so a consumer can tell which
   session actually matched inside a clustered block. **The reader fan-out needs exactly this.**
3. Schema is at **8**. Ghost prompts have vectors; ghosts are first-class in every list.
4. `evals/run.ts` computes a gate verdict and **exits non-zero on failure**. The ask evals do the
   same or they are a score nobody checks.
5. Open, inherited: the fusion gate FAILS honestly (hybrid 22/25 ties vec-only). Phase 7 re-checks.
   **Phase 4 does not touch the ranker and does not touch `evals/run.ts` or `evals/queries.jsonl`.**

## the wave

Built the measuring instrument first, with a worker that has no stake in the score — the single
best decision of phase 3 (`09 §6.7`). T4.0 writes the questions; T4.1 writes the thing they judge;
neither sees the other's work until integration.

| id | task | branch | worktree | deliverables (disjoint) | status |
|---|---|---|---|---|---|
| T4.0 | ask eval set + scoring harness (10 gold + 3 decoys) | `task/T4.0-ask-evals` | yes | `evals/ask.jsonl` · `evals/ask-run.ts` · `evals/ask-selftest.ts` · `evals/ASK-EVALS.md` | **merged** |
| T4.1 | `ask` pipeline: shortlist → readers → synthesizer → **code-level citation filter** | `task/T4.1-ask` | yes | `packages/core/src/ask.ts` · `packages/core/src/render/ask.ts` · `packages/cli/src/commands/ask.ts` · `tests/ask.test.ts` · `phases/phase-4/registration-T4.1.txt` | pending |
| T4.2 | open threads: rule pass + model confirm | `task/T4.2-open-threads` | yes | `packages/core/src/open-threads.ts` · `tests/open-threads.test.ts` | pending |
| T4.3 | `graft`: token-budgeted brief + `--clip` | `task/T4.3-graft` | yes | `packages/core/src/graft.ts` · `packages/core/src/render/graft.ts` · `packages/cli/src/commands/graft.ts` · `tests/graft.test.ts` · `phases/phase-4/registration-T4.3.txt` | pending |

**RESERVED — no worker edits these.** `packages/core/src/index.ts`, `packages/cli/src/index.ts`,
`package.json`, `evals/run.ts`, `evals/queries.jsonl`, `README.md`, `plans/**`. Workers report the
exact line(s) and the orchestrator adds them in one integration commit.

## the pinned interfaces (fixed by the orchestrator before the wave, so four workers compile against one contract)

```ts
// packages/core/src/ask.ts — T4.1 owns
export interface AskEvidence {
  index: number;            // 1-based; what an ANSWER sentence cites
  sessionId: string; id8: string; project: string; harness: Harness;
  seq: number; ts: string; quote: string;   // quote is <= 90 chars in the rendered view, full here
  isSidechain: boolean; isGhost: boolean;
}
export interface AskSentence { text: string; cites: number[] }   // cites index into evidence
export interface AskResult {
  question: string;
  answer: string;                 // the kept sentences, joined
  sentences: AskSentence[];       // kept only
  dropped: string[];              // sentences the code dropped for want of a citation
  evidence: AskEvidence[];
  openThreads: OpenThread[];
  searched: number;               // sessions actually read
  matching: number;               // sessions that matched before the k cap
  readers: { sessionId: string; id8: string; found: boolean; quotes: number; ms: number }[];
  refused: boolean;               // --strict and fewer than 2 evidence lines survived
  strict: boolean;
  spend: Spend;                   // from llm.ts
  estimated: boolean;             // true if any figure in spend is est. (05 honesty contract)
  ms: number;
}
export async function ask(db: Db, question: string, o?: AskOptions): Promise<AskResult>;

// packages/core/src/open-threads.ts — T4.2 owns
export interface OpenThreadCandidate {
  decision: string; what: string;
  sessionId: string; id8: string; project: string; ts: string;
  otherProject: string; otherSessionIds: string[];
  overlap: { files: string[]; topics: string[] };
  score: number;
}
export interface OpenThread extends OpenThreadCandidate { confirmed: boolean; note: string }
export const OPEN_THREAD_LABEL = 'possible open thread';
export function openThreadCandidates(db: Db, sessionIds: readonly string[], o?: { limit?: number }): OpenThreadCandidate[];
export async function confirmOpenThreads(cands: readonly OpenThreadCandidate[], o: { llm?: Llm; model?: string; budget?: Budget }): Promise<OpenThread[]>;

// packages/core/src/graft.ts — T4.3 owns
export interface GraftResult {
  sessionId: string; id8: string; project: string; harness: Harness;
  about: string | null; exchanges: number; date: string;
  budget: number; tokens: number; estimated: boolean;   // tokens est. unless the api path counted them
  brief: string; path: string; clipped: boolean;
  citations: { id8: string; seq: number; resolves: boolean }[];
  spend: Spend; ms: number;
}
export async function graft(db: Db, target: string, o?: GraftOptions): Promise<GraftResult>;
```

`ask --json` prints `AskResult` verbatim. `graft --json` prints `GraftResult` verbatim minus
`brief` duplication rules — `brief` stays. **T4.0 scores against `AskResult` and nothing else.**

## integration + verification

- T4.4 (orchestrator, at integration): the library interface documented in
  `packages/core/README.md` so the phase-5 plugin skill can run the readers with the native Agent
  tool instead of the SDK.
- one real `ask` run on the reference corpus, `--potsherd-dir` **kept**, path recorded here.
- the orchestrator reads one real `ask` output by eye (`09 §5`).
- a **fresh verifier** that authored none of it, does not sub-delegate, and pastes command output
  for every finding.

## worker log

### T4.0 — merged
10 gold + 3 decoys. Every gold answer was located by grep **before** its question was written;
every decoy proven absent. The scorer proves itself on **12 hand-built `AskResult` objects, 11 of
which must fail**, and each must fail *the gate it is named for* — the worker isolated two cases
that originally tripped two gates at once, on the grounds that a case failing two gates proves
neither. Two of the twelve check that **the set cannot lie about itself** (an overlap it does not
have; a decoy the corpus can now answer).

Independently re-confirmed by the orchestrator rather than taken on the report's word:

```
$ npx tsx evals/ask-selftest.ts
  PASS — the scorer said the right thing about all 12 cases and about the set itself   (exit 0)
$ grep -ricE 'france|paris|capital' evals/fixture/claude --include='*.jsonl' | awk -F: '$2>0'
(0 hits)
$ python3 -c "…"    gold 10 · decoys 3 · max overlap 0.50   (flag bar is 0.60)
```

Overlap min 0.00 / median 0.325 / **max 0.50** — nothing flagged, where phase 3's set had three
queries at 0.67 that each had to defend themselves. Shapes: sidechain-only 3, ghost-only 2,
multi-session 2, card 2, ordinary exchange 1. Every minimum in the brief met.

Carried to integration:
- `"evals:ask": "tsx evals/ask-run.ts"` added to `package.json` by the orchestrator. **done**
- `AskOptions` was named in the pinned interface but never defined, so the harness calls
  `ask(db, q, { k, root, strict } as unknown as AskOptions)`. **T4.1's real `AskOptions` must be
  reconciled with that one line at integration.**
- The harness's set-integrity half runs *before* it imports `ask`, so `pnpm evals:ask` produces the
  real overlap table today and exits 1 naming T4.1 — a deliberate honest failure, not a stub.

### orchestrator, unprompted
`tests/redact.test.ts` asserted 10 MB of redaction in under 10 s against a **3.5 s idle run** —
2.9x of headroom — and failed under the load of four concurrent workers. A wall-clock bar on a
shared machine measures the machine. Recalibrated against a linear pass over the same bytes
(`09 §5`: a flaky timing assertion is the orchestrator's own fix, not a worker's).

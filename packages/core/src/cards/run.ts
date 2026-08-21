import fs from 'node:fs';
import path from 'node:path';

import type { Db } from '../db.js';
import type { EmbeddingsOptions } from '../embeddings.js';
import { BudgetError, type Llm } from '../llm.js';
import { modelsDir } from '../paths.js';
import { makeGate } from './gate.js';
import { cardTranscript, type CardResult } from './pipeline.js';
import type { CardKind, CardTarget } from './plan.js';
import { formatErrorSentinel } from './sentinel.js';
import { loadSessionTranscript, type Transcript } from './transcript.js';
import type { DropReason } from './verify.js';
import { cachedEmbedder } from './vectors.js';
import {
  cardEmbeddingText,
  cardPath,
  readPriorCard,
  writeCard,
  type CardRecord,
} from './write.js';

/**
 * `potsherd card --all`: the pipeline, over a plan, at concurrency.
 *
 * `03` §12, restated after measurement: the reference corpus is 126 targets
 * and 324 calls, which is **64 minutes serial and 9.9 at concurrency 6**. Wall
 * time is the budget that binds on the subscription path, and the only lever
 * on it is running several sessions at once — a card call is ~5.4 s of
 * spawning a harness and waiting, which is almost entirely idle.
 *
 * Three things this module is responsible for and the pipeline is not:
 *
 *   1. **The cap is a ceiling, not a post-mortem.** `budget.progress(done,
 *      total)` is set before every target so a {@link BudgetError} can say how
 *      far the run got, and the abort stops the other workers rather than
 *      letting six in-flight sessions spend past the line.
 *   2. **One bad session does not lose the run.** A target that throws is
 *      counted, given an error sentinel (upstream's fix: without one it
 *      re-queues forever and pins the head of the queue) and stepped over.
 *   3. **Ghosts are not carded here.** They are in the plan — `planCards`
 *      selects them and prices them — and T2.3 owns writing them. The seam is
 *      {@link CardRunOptions.kinds}: T2.3 adds a `loadGhostTranscript`, passes
 *      `kinds: ['session', 'ghost']`, and changes nothing else.
 */

export interface CardRunOptions {
  /** potsherd's own directory: where the mirror and the model cache live. */
  root: string;
  targets: readonly CardTarget[];
  /** `03` §12: 6 is the default from phase 2 on. */
  concurrency?: number;
  /** Which kinds this build knows how to card. Default `['session']` (T2.2). */
  kinds?: readonly CardKind[];
  /** Re-card even when a fresh card exists; also passes the old card as prior. */
  force?: boolean;
  embeddings?: EmbeddingsOptions;
  signal?: AbortSignal;
  onProgress?: (event: CardProgress) => void;
  /** Test seam: deterministic vectors with no model on disk. */
  embed?: (text: string) => Promise<number[]>;
}

export interface CardProgress {
  phase: 'start' | 'done' | 'failed' | 'skipped';
  target: CardTarget;
  done: number;
  total: number;
  /** On `done`: the finished card's title. On `failed`: the message. */
  detail?: string;
  usd?: number;
}

export interface CardSummary {
  id: string;
  kind: CardKind;
  title: string;
  outcome: string;
  decisions: number;
  openThreads: number;
  kept: number;
  dropped: number;
  coverage: number | null;
  supplemented: boolean;
  degraded: boolean;
  calls: number;
  usd: number;
  ms: number;
  path: string;
}

export interface CardRunReport {
  written: number;
  failed: number;
  /** Kinds this build does not card yet — ghosts, until T2.3. */
  deferred: number;
  verified: { kept: number; dropped: number };
  /** Why claims were dropped, so a zero is diagnosable and so is a hundred. */
  dropsByReason: Record<DropReason, number>;
  calls: number;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  /** Sessions whose finished card still cited an exchange that does not exist. */
  unresolved: number;
  supplemented: number;
  degraded: number;
  ms: number;
  cards: CardSummary[];
  errors: { id: string; message: string }[];
  /** Set when a `--max-usd` / `--max-tokens` ceiling stopped the run. */
  aborted?: { message: string; fix: string; done: number; total: number };
}

export async function runCards(
  db: Db,
  llm: Llm,
  options: CardRunOptions,
): Promise<CardRunReport> {
  const started = Date.now();
  const kinds = new Set<CardKind>(options.kinds ?? ['session']);
  const queue = options.targets.filter((t) => kinds.has(t.kind));
  const deferred = options.targets.length - queue.length;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 6));

  const report: CardRunReport = {
    written: 0,
    failed: 0,
    deferred,
    verified: { kept: 0, dropped: 0 },
    dropsByReason: { 'no-citation': 0, 'unresolved-seq': 0, 'no-match': 0 },
    calls: 0,
    usd: 0,
    inputTokens: 0,
    outputTokens: 0,
    unresolved: 0,
    supplemented: 0,
    degraded: 0,
    ms: 0,
    cards: [],
    errors: [],
  };

  // One embedding cache for the whole run. Claims repeat across a project's
  // sessions far more than they repeat inside one, and the model is the cost.
  const embedOptions: EmbeddingsOptions = options.embeddings ?? { cacheDir: modelsDir(options.root) };
  const embedder = cachedEmbedder({
    ...(options.embed ? { embed: options.embed } : {}),
    embeddings: embedOptions,
  });

  // `--concurrency n` means n model calls, not n sessions. See `cards/gate.ts`
  // for why the difference is the whole of the wall-time budget.
  const gate = makeGate(concurrency);
  const abort = new AbortController();
  const onOuter = (): void => abort.abort();
  options.signal?.addEventListener('abort', onOuter, { once: true });

  let next = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (abort.signal.aborted) return;
      const index = next++;
      if (index >= queue.length) return;
      const target = queue[index]!;

      // Before the call, not after: the abort message is only useful if it can
      // say "27 of 236 done".
      llm.budget.progress(done, queue.length);
      options.onProgress?.({ phase: 'start', target, done, total: queue.length });

      try {
        const transcript = loadTranscript(db, target);
        if (!transcript || transcript.units.length === 0) {
          report.failed += 1;
          report.errors.push({ id: target.id, message: 'no transcript rows for this session' });
          options.onProgress?.({
            phase: 'failed',
            target,
            done,
            total: queue.length,
            detail: 'no transcript rows',
          });
          done += 1;
          continue;
        }

        const prior = target.carded ? readPriorCard(db, target.id) : null;
        const result = await cardTranscript(llm, transcript, {
          ...(prior ? { prior } : {}),
          embedder,
          ...(options.embed ? { embed: options.embed } : {}),
          embeddings: embedOptions,
          signal: abort.signal,
          gate,
        });

        const file = await persist(db, options, transcript, result, embedder.embed, llm.model);
        absorb(report, result, target, file);
        done += 1;
        options.onProgress?.({
          phase: 'done',
          target,
          done,
          total: queue.length,
          detail: result.card.title,
          usd: result.spend.usd,
        });
      } catch (err) {
        if (err instanceof BudgetError) {
          report.aborted = {
            message: err.message,
            fix: err.fix,
            done: err.detail.done,
            total: err.detail.total,
          };
          abort.abort();
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        report.failed += 1;
        report.errors.push({ id: target.id, message });
        writeSentinel(options.root, target, err);
        done += 1;
        options.onProgress?.({ phase: 'failed', target, done, total: queue.length, detail: message });
      }
    }
  };

  try {
    // More workers than permits, deliberately. A worker spends much of a
    // session's life *not* calling a model — loading the transcript, embedding
    // for coverage, verifying, writing — and a pool the size of the gate would
    // leave permits idle during all of it. The gate, not the pool, is what
    // bounds spend and spawned harnesses.
    const workers = Math.min(concurrency * 2, queue.length);
    await Promise.all(Array.from({ length: workers }, worker));
  } finally {
    options.signal?.removeEventListener('abort', onOuter);
  }

  const spend = llm.spend;
  report.calls = spend.calls;
  report.usd = spend.usd;
  report.inputTokens = spend.inputTokens;
  report.outputTokens = spend.outputTokens;
  report.ms = Date.now() - started;
  report.cards.sort((a, b) => b.dropped - a.dropped || a.id.localeCompare(b.id));
  return report;
}

function loadTranscript(db: Db, target: CardTarget): Transcript | null {
  // T2.3: `if (target.kind === 'ghost') return loadGhostTranscript(db, target.id);`
  return loadSessionTranscript(db, target.id);
}

async function persist(
  db: Db,
  options: CardRunOptions,
  transcript: Transcript,
  result: CardResult,
  embed: (text: string) => Promise<number[]>,
  model: string,
): Promise<string> {
  const text = cardEmbeddingText(result.card);
  let embedding: number[] | undefined;
  try {
    // `vec_cards` is the one vector the *card* owns, and `find` degrades to
    // fts5 without it rather than failing (`recall.ts`'s first property).
    embedding = text.trim() ? await embed(text) : undefined;
  } catch {
    embedding = undefined;
  }

  const record: CardRecord = {
    sessionId: transcript.id,
    harness: transcript.harness,
    projectSlug: transcript.projectSlug,
    project: transcript.project,
    card: result.card,
    verified: result.verified,
    model: result.model || model,
    costUsd: result.spend.usd,
    createdAt: new Date().toISOString(),
    source: transcript.kind === 'ghost' ? 'prompts-only' : 'transcript',
    ...(result.degraded ? { degraded: true } : {}),
    ...(result.coverage ? { coverage: 1 - result.coverage.fraction } : {}),
  };
  return writeCard(db, options.root, record, embedding);
}

function absorb(report: CardRunReport, result: CardResult, target: CardTarget, file: string): void {
  report.written += 1;
  report.verified.kept += result.verified.kept;
  report.verified.dropped += result.verified.dropped;
  for (const d of result.drops) report.dropsByReason[d.reason] += 1;
  report.unresolved += result.unresolved.length;
  if (result.supplemented) report.supplemented += 1;
  if (result.degraded) report.degraded += 1;
  report.cards.push({
    id: target.id,
    kind: target.kind,
    title: result.card.title,
    outcome: result.card.outcome,
    decisions: result.card.decisions.length,
    openThreads: result.card.open_threads.length,
    kept: result.verified.kept,
    dropped: result.verified.dropped,
    coverage: result.coverage ? 1 - result.coverage.fraction : null,
    supplemented: result.supplemented,
    degraded: result.degraded,
    calls: result.spend.calls,
    usd: result.spend.usd,
    ms: result.ms,
    path: file,
  });
}

/**
 * Upstream's error sentinel (obra/episodic-memory #91, #96), which `cards/
 * sentinel.ts` ported and nothing used until now.
 *
 * Without it a failed session leaves no trace on disk, and the *user* has
 * nothing to look at: the run says "3 failed" and the mirror directory is
 * silent about which three or why. Never fatal — a card run must not die
 * because the mirror directory is read-only.
 */
function writeSentinel(root: string, target: CardTarget, error: unknown): void {
  try {
    const file = cardPath(root, target.harness, projectSlugOf(target), target.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, formatErrorSentinel(error), { mode: 0o600 });
  } catch {
    /* a sentinel that cannot be written is not worth failing a run over */
  }
}

function projectSlugOf(target: CardTarget): string | null {
  return target.projectSlug;
}

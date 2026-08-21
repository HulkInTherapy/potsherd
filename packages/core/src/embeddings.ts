import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { modelsDir } from './paths.js';

/**
 * Local embedding model.
 *
 * Ported from obra/episodic-memory@1075769 `src/embeddings.ts`
 * (MIT, (c) 2025 Jesse Vincent). The model choice, the dtype, the 2000-char
 * truncation, the mean/normalize pooling and — most importantly — the
 * asymmetric BGE query prefix are all upstream's, and upstream measured them
 * (+6.34 R@1 on a 17K-corpus retrieval test against real production data).
 * None of that is second-guessed here.
 *
 * Four changes, all of them about where the bytes live and who is allowed to
 * print:
 *
 *   1. **Cache directory.** Upstream sets no `env.cacheDir`, so
 *      transformers.js caches the 34 MB ONNX file inside
 *      `node_modules/@huggingface/transformers/.cache/`. For a published CLI
 *      that is wrong twice over: a global npm prefix is often not writable,
 *      and `npm update` deletes the cache. potsherd points it at
 *      `~/.potsherd/models` (`paths.modelsDir()`), which is potsherd's own
 *      directory and survives reinstalls.
 *   2. **Serialised first run.** The scout found two orphaned
 *      `model_quantized.onnx.tmp.<pid>` files (17.8 MB + 29.5 MB) left by
 *      concurrent test workers racing to download the same model. `pipeline()`
 *      is now behind a single module-level promise, so one process downloads
 *      once; `ensureModel()` lets a caller do the download deliberately,
 *      before a progress bar starts.
 *   3. **Nothing writes to stdout or stderr.** Upstream logs "Loading
 *      embedding model…" with `console.error`. potsherd's CLI owns every byte
 *      of its output (`03` §9), so progress arrives through a callback.
 *   4. **Lazy import.** `@huggingface/transformers` pulls in onnxruntime-node,
 *      which costs ~200 ms to load. `potsherd audit` must never pay for it, so
 *      the import happens inside `initEmbeddings()`.
 *
 * Offline: after the first download the model is read from `modelsDir()` and
 * no network call is made. `HF_HUB_OFFLINE=1` / `TRANSFORMERS_OFFLINE=1` are
 * honoured by the library, and {@link isModelCached} answers before you try.
 */

/** Bumped when anything in the pipeline changes — model, dtype, or prefix. */
export const EMBEDDING_VERSION = 1;

export const MODEL_ID = 'Xenova/bge-small-en-v1.5';
export const MODEL_DTYPE = 'q8';
/** 384, matching `vec_exchanges(embedding FLOAT[384])` in `03` §3. */
export const EMBEDDING_DIMENSIONS = 384;
/** Roughly what the first run downloads, for the message the CLI prints. */
export const MODEL_DOWNLOAD_BYTES = 34_014_426;

export const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

/** Longer inputs degrade mean-pooled embeddings; upstream measured this too. */
const MAX_INPUT_CHARS = 2000;

/**
 * How many threads onnxruntime may use for one forward pass.
 *
 * Measured on the reference machine (Apple M-series, 4 performance + 4
 * efficiency cores), embedding a 2,000-character exchange with the q8 model:
 *
 *     onnxruntime default (all logical cores)   161 ms
 *     intraOpNumThreads = 4                      94 ms
 *     intraOpNumThreads = 8                     251 ms
 *
 * The default is not a good default here: spilling a 33M-parameter model onto
 * the efficiency cores costs more in synchronisation than the extra cores
 * return, and on this corpus that difference is the whole of `index`'s time
 * budget (`03` §12). Half the logical cores, capped at four, is the shape of
 * that curve. `POTSHERD_EMBED_THREADS` overrides it for a machine where it is
 * wrong. Thread count changes no vector — it is the same arithmetic in a
 * different order — so {@link EMBEDDING_VERSION} does not move with it.
 */
export function embedThreads(): number {
  const override = Number(process.env['POTSHERD_EMBED_THREADS']);
  if (Number.isFinite(override) && override >= 1) return Math.floor(override);
  const logical = os.availableParallelism?.() ?? os.cpus().length ?? 2;
  return Math.max(1, Math.min(4, Math.floor(logical / 2)));
}

export interface EmbeddingsOptions {
  /** Where the ONNX weights live. Defaults to `~/.potsherd/models`. */
  cacheDir?: string;
  /** Called with 0..1 during the first-run download. Never prints anything. */
  onProgress?: (fraction: number, file: string) => void;
}

type Pipeline = (
  input: string | string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array | number[]; dims?: number[] }>;

let pipelinePromise: Promise<Pipeline> | null = null;

/** True when the model is already on disk, so `index` can run with no network. */
export function isModelCached(cacheDir = modelsDir()): boolean {
  const dir = path.join(cacheDir, ...MODEL_ID.split('/'), 'onnx');
  try {
    return fs
      .readdirSync(dir)
      .some((f) => f.endsWith('.onnx') && fs.statSync(path.join(dir, f)).size > 1_000_000);
  } catch {
    return false;
  }
}

/**
 * Load the model, downloading it on first use. Idempotent and safe to call
 * concurrently: every caller awaits the same promise.
 */
export async function initEmbeddings(options: EmbeddingsOptions = {}): Promise<void> {
  await getPipeline(options);
}

/** Alias that reads better at a call site that only wants the download done. */
export const ensureModel = initEmbeddings;

async function getPipeline(options: EmbeddingsOptions = {}): Promise<Pipeline> {
  if (pipelinePromise) return pipelinePromise;
  pipelinePromise = (async () => {
    const cacheDir = options.cacheDir ?? modelsDir();
    fs.mkdirSync(cacheDir, { recursive: true });

    const transformers = await import('@huggingface/transformers');
    const env = transformers.env as unknown as Record<string, unknown>;
    env.allowLocalModels = true;
    env.useBrowserCache = false;
    env.cacheDir = cacheDir;

    const onProgress = options.onProgress;
    const built = await transformers.pipeline('feature-extraction', MODEL_ID, {
      dtype: MODEL_DTYPE,
      session_options: { intraOpNumThreads: embedThreads(), interOpNumThreads: 1 },
      progress_callback: onProgress
        ? (p: unknown) => {
            if (typeof p !== 'object' || p === null) return;
            const rec = p as { progress?: number; file?: string };
            if (typeof rec.progress === 'number') {
              onProgress(Math.max(0, Math.min(1, rec.progress / 100)), rec.file ?? '');
            }
          }
        : () => {},
    });
    return built as unknown as Pipeline;
  })();

  try {
    return await pipelinePromise;
  } catch (error) {
    pipelinePromise = null; // a failed download must not poison the process
    throw error;
  }
}

/** Drop the loaded model. Tests use it; nothing in the CLI does. */
export function resetEmbeddings(): void {
  pipelinePromise = null;
}

export async function generateEmbedding(
  text: string,
  options: EmbeddingsOptions = {},
): Promise<number[]> {
  const pipe = await getPipeline(options);
  const output = await pipe(text.substring(0, MAX_INPUT_CHARS), {
    pooling: 'mean',
    normalize: true,
  });
  return Array.from(output.data as Float32Array);
}

/**
 * Prepend the BGE retrieval prefix to a query string. Idempotent: returns the
 * input unchanged if the prefix is already present.
 */
export function withQueryPrefix(query: string): string {
  if (query.startsWith(BGE_QUERY_PREFIX)) return query;
  return BGE_QUERY_PREFIX + query;
}

/**
 * Embed a search QUERY. BGE models are trained asymmetrically: the prefix goes
 * on queries only, documents go through unmodified.
 */
export async function generateQueryEmbedding(
  query: string,
  options: EmbeddingsOptions = {},
): Promise<number[]> {
  return generateEmbedding(withQueryPrefix(query), options);
}

/**
 * The exact string an exchange is embedded as. Upstream's concatenation
 * format, and the stored vectors depend on it — change it and
 * {@link EMBEDDING_VERSION} must move too.
 */
export function exchangeText(
  userText: string,
  assistantText: string,
  toolNames?: readonly string[],
): string {
  let combined = `User: ${userText}\n\nAssistant: ${assistantText}`;
  if (toolNames && toolNames.length > 0) {
    combined += `\n\nTools: ${toolNames.join(', ')}`;
  }
  return combined;
}

/** Embed one exchange. */
export async function generateExchangeEmbedding(
  userText: string,
  assistantText: string,
  toolNames?: readonly string[],
  options: EmbeddingsOptions = {},
): Promise<number[]> {
  return generateEmbedding(exchangeText(userText, assistantText, toolNames), options);
}

export interface ExchangeInput {
  userText: string;
  assistantText: string;
  toolNames?: readonly string[];
}

/**
 * Embed several inputs in one forward pass.
 *
 * Measured on the reference machine before `index` was allowed to use this:
 * batch sizes 1, 2, 4, 8 and 16 are within noise of each other (~215 ms per
 * 2,000-character exchange) and 32 is nearly twice as slow. There is no
 * throughput to win here — the model, not the per-call overhead, is the cost.
 *
 * And a batch is not bit-identical to single calls. `pooling: 'mean'` does
 * average under the attention mask, so padding does not leak, but q8 dynamic
 * quantisation picks activation scales per forward pass and a ragged batch
 * therefore lands about 3e-3 of cosine away from the same input embedded alone
 * (`tests/embeddings.test.ts` measures it). Both vectors are equally valid and
 * either would retrieve the same neighbours — but given no speed to gain,
 * `ingest.ts` embeds one exchange per call and keeps the exactly-reproducible
 * vector. This function stays because it is the right shape for a caller that
 * does have a throughput problem, on a machine where batching pays.
 *
 * Falls back to one call per input if the runtime ever returns a shape other
 * than `[n, 384]`; a slower index is always better than a wrong vector.
 */
export async function generateExchangeEmbeddings(
  items: readonly ExchangeInput[],
  options: EmbeddingsOptions = {},
): Promise<number[][]> {
  if (items.length === 0) return [];
  const texts = items.map((i) =>
    exchangeText(i.userText, i.assistantText, i.toolNames).substring(0, MAX_INPUT_CHARS),
  );
  const pipe = await getPipeline(options);
  const output = await pipe(texts, { pooling: 'mean', normalize: true });
  const data = output.data as Float32Array;
  if (data.length !== texts.length * EMBEDDING_DIMENSIONS) {
    const out: number[][] = [];
    for (const text of texts) out.push(await generateEmbedding(text, options));
    return out;
  }
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 1) {
    out.push(Array.from(data.slice(i * EMBEDDING_DIMENSIONS, (i + 1) * EMBEDDING_DIMENSIONS)));
  }
  return out;
}

/** `Float32Array` blob in the layout `vec0` expects, for `vec_exchanges`. */
export function embeddingToBlob(embedding: readonly number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

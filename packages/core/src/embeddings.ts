import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { modelsDir } from './paths.js';

/**
 * Local embedding model, and the runtime that runs it.
 *
 * Ported from obra/episodic-memory@1075769 `src/embeddings.ts`
 * (MIT, (c) 2025 Jesse Vincent). The model choice, the dtype, the 2000-char
 * truncation, the mean/normalize pooling and — most importantly — the
 * asymmetric BGE query prefix are all upstream's, and upstream measured them
 * (+6.34 R@1 on a 17K-corpus retrieval test against real production data).
 * None of that is second-guessed here, and none of it changed when the runtime
 * underneath it did.
 *
 * ## what changed, and why
 *
 * Until now this file reached the model through `@huggingface/transformers`,
 * whose node build statically imports `onnxruntime-node` and `sharp`. Those
 * two are **native addons**, they weigh 677 MB installed, and they are the
 * reason semantic search was an optional peer dependency that nobody had — so
 * on a clean `npm i -g potsherd` the entire semantic half of `find` did not
 * run. A capability the user has to install is not a capability.
 *
 * So the runtime is now **WebAssembly**, and it is **acquired, not installed**:
 *
 *   - `onnxruntime-web`'s wasm build runs the same ONNX graph with no native
 *     compile, on any platform node runs on. Three files, 13.0 MB.
 *   - `@huggingface/tokenizers` is a pure-JS implementation of the same
 *     WordPiece tokenizer transformers.js uses. One file, 82 KB, no
 *     dependencies.
 *   - the quantized bge-small weights and their tokenizer come from the same
 *     Hugging Face repo transformers.js was fetching anyway, 34.7 MB.
 *
 * 48.4 MB in total, fetched **once**, in the background, into
 * `~/.potsherd/models`. Nothing is installed into `node_modules`, nothing is
 * compiled, and the published tarball stays at 17 MB.
 *
 * ## measured, on the reference machine (M-series, 8 logical cores)
 *
 * Same 60-exchange corpus, same weights, same pooling, one exchange per
 * forward pass:
 *
 *     onnxruntime-node  (native, 4 threads)     35.8 ms / exchange
 *     onnxruntime-web   (wasm,   4 threads)    233.9 ms / exchange
 *
 * **6.5× slower**, which is the price of never asking anyone to install
 * anything. It is paid in the background, and it is why {@link embedPending}
 * (in `vec.ts`) embeds newest sessions first: the sessions a user is about to
 * search for are the ones they were just in.
 *
 * The two runtimes do not produce bit-identical vectors — q8 dynamic
 * quantisation picks activation scales per forward pass and the two builds
 * pick them slightly differently. Measured over the same 60 exchanges the
 * cosine between the native vector and the wasm vector is **0.9983 mean,
 * 0.9950 worst**, which is the same order as the batch-vs-single difference
 * upstream already tolerates (3e-3) and retrieves the same neighbours. So
 * {@link EMBEDDING_VERSION} does **not** move: forcing every existing user to
 * re-embed their whole archive to gain 5e-3 of cosine would be a worse trade
 * than the mixed index. `tests/embeddings.test.ts` pins the agreement.
 *
 * ## the four decisions that were already here, unchanged
 *
 *   1. **Cache directory.** `~/.potsherd/models` (`paths.modelsDir()`), never
 *      `node_modules`, because a global npm prefix is often not writable and
 *      `npm update` deletes it. It is now also where the runtime lands, and
 *      **nothing here ever writes outside it**.
 *   2. **Serialised first run.** One module-level promise, so concurrent
 *      callers download once. {@link ensureModel} lets a caller do the
 *      acquisition deliberately, before a progress bar starts.
 *   3. **Nothing writes to stdout or stderr.** The CLI owns every byte of its
 *      output (`03` §9); progress arrives through a callback.
 *   4. **Lazy import.** Nothing heavy is imported until {@link initEmbeddings}
 *      is called, so `potsherd audit` never pays for it.
 *
 * Offline: after the first acquisition everything is read from
 * {@link modelsDir} and no network call is made. {@link acquisitionPlan}
 * answers what is missing before anything is attempted, and a machine that is
 * offline forever gets a fully working text-search potsherd and an honest
 * status line — never a hang and never a crash.
 */

/** Bumped when anything in the pipeline changes — model, dtype, or prefix. */
export const EMBEDDING_VERSION = 1;

export const MODEL_ID = 'Xenova/bge-small-en-v1.5';
export const MODEL_DTYPE = 'q8';
/** 384, matching the `embedding FLOAT[384]` vectors in `03` §3. */
export const EMBEDDING_DIMENSIONS = 384;

export const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

/** Longer inputs degrade mean-pooled embeddings; upstream measured this too. */
const MAX_INPUT_CHARS = 2000;

// --------------------------------------------------------------- acquisition

/**
 * One file potsherd fetches on first use.
 *
 * `sha256` and `bytes` are not decoration. They are the whole of the
 * supply-chain story for a binary that arrives over the network and is then
 * executed: every file is written to `<name>.part`, hashed, and only renamed
 * into place when it matches. A truncated download, a captive-portal HTML
 * page, or a substituted binary all fail the same way — the part file is
 * deleted and the capability stays absent. Both sets of digests were verified
 * against a fresh fetch from the upstream host on 2026-08-23.
 */
export interface RuntimeFile {
  /** Path under {@link modelsDir}, always relative and always forward-slashed. */
  readonly name: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** onnxruntime-web, pinned. The wasm build: no native addon, any platform. */
export const RUNTIME_VERSION = '1.27.0';
/** @huggingface/tokenizers, pinned. Pure JS/TS, zero dependencies, 82 KB. */
export const TOKENIZERS_VERSION = '0.1.3';

/**
 * Where the runtime files come from.
 *
 * jsDelivr serves individual files out of an npm package; the npm registry
 * only serves whole tarballs, and `onnxruntime-web`'s tarball unpacks to
 * 137 MB to yield the 13 MB actually needed. Fetching four files is honest
 * about what it takes and 10× lighter. `POTSHERD_RUNTIME_BASE` redirects it —
 * at a mirror, or, in the tests, at a `file://` directory.
 */
export function runtimeBase(): string {
  const override = process.env['POTSHERD_RUNTIME_BASE'];
  return override && override.trim() ? stripSlash(override.trim()) : 'https://cdn.jsdelivr.net/npm';
}

/** Where the weights come from. `POTSHERD_MODEL_BASE` redirects it the same way. */
export function modelBase(): string {
  const override = process.env['POTSHERD_MODEL_BASE'];
  return override && override.trim() ? stripSlash(override.trim()) : 'https://huggingface.co';
}

/** The subdirectory of {@link modelsDir} the wasm runtime lives in. */
export const RUNTIME_SUBDIR = `runtime/onnxruntime-web-${RUNTIME_VERSION}`;

function runtimeFiles(): RuntimeFile[] {
  const ort = `${runtimeBase()}/onnxruntime-web@${RUNTIME_VERSION}/dist`;
  const tok = `${runtimeBase()}/@huggingface/tokenizers@${TOKENIZERS_VERSION}/dist`;
  return [
    {
      name: `${RUNTIME_SUBDIR}/ort.wasm.bundle.min.mjs`,
      url: `${ort}/ort.wasm.bundle.min.mjs`,
      bytes: 72_799,
      sha256: '1db5e1c5cd2b860eed85e6eeff23e2aaa7cffcc407f67093bcc888f631b94ba9',
    },
    {
      name: `${RUNTIME_SUBDIR}/ort-wasm-simd-threaded.mjs`,
      url: `${ort}/ort-wasm-simd-threaded.mjs`,
      bytes: 24_180,
      sha256: '0a1e718d99c41b22c21f2520ff4f9e883a6b5533856e398d21816ee8eb8185d3',
    },
    {
      name: `${RUNTIME_SUBDIR}/ort-wasm-simd-threaded.wasm`,
      url: `${ort}/ort-wasm-simd-threaded.wasm`,
      bytes: 13_479_978,
      sha256: 'd1ab1b94b16a65b29d710d0b587b29e7bed336827577623913479b8afe8113e6',
    },
    {
      name: `${RUNTIME_SUBDIR}/tokenizers.mjs`,
      url: `${tok}/tokenizers.mjs`,
      bytes: 81_970,
      sha256: '6d92e25f9576e67124b3a3f910f5cc1df95a42bde4df4f5387f62dee4554f301',
    },
  ];
}

function modelFiles(): RuntimeFile[] {
  const base = `${modelBase()}/${MODEL_ID}/resolve/main`;
  const at = (name: string, bytes: number, sha256: string): RuntimeFile => ({
    name: `${MODEL_ID}/${name}`,
    url: `${base}/${name}`,
    bytes,
    sha256,
  });
  return [
    at('config.json', 683, 'fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350'),
    at(
      'tokenizer_config.json',
      366,
      '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
    ),
    at(
      'tokenizer.json',
      711_396,
      'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
    ),
    at(
      'onnx/model_quantized.onnx',
      34_014_426,
      '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4',
    ),
  ];
}

/** Every file first use needs, runtime and weights together. */
export function requiredFiles(): RuntimeFile[] {
  return [...runtimeFiles(), ...modelFiles()];
}

/**
 * The hosts acquisition actually contacts, for `doctor --privacy` to name.
 *
 * Derived from the same two bases the downloader uses rather than written out
 * a second time, so a receipt cannot describe a host potsherd does not use, or
 * miss one it does. This project has shipped a false "no network" line once
 * (`08` rule 1) and it is not doing it again.
 */
export function runtimeHosts(): string {
  const hosts = [...new Set([runtimeBase(), modelBase()].map(hostOf))].filter(Boolean);
  if (hosts.length === 0) return 'nowhere — every source is a local path';
  if (hosts.length === 1) return hosts[0] as string;
  return `${hosts.slice(0, -1).join(', ')} and ${hosts[hosts.length - 1] as string}`;
}

function hostOf(base: string): string {
  try {
    const u = new URL(base);
    return u.protocol === 'file:' ? '' : u.host;
  } catch {
    return '';
  }
}

/** What the whole first run downloads: 48.4 MB. For the line `index` prints. */
export const ACQUIRE_BYTES = requiredFiles().reduce((n, f) => n + f.bytes, 0);
/** The weights alone, kept for callers that only name the model. */
export const MODEL_DOWNLOAD_BYTES = 34_014_426;

/** True when a file is present at exactly its pinned size. */
function haveFile(cacheDir: string, f: RuntimeFile): boolean {
  try {
    return fs.statSync(path.join(cacheDir, ...f.name.split('/'))).size === f.bytes;
  } catch {
    return false;
  }
}

/** What is still missing, and how many bytes that is. Never touches the network. */
export function acquisitionPlan(cacheDir = modelsDir()): {
  missing: RuntimeFile[];
  bytes: number;
  complete: boolean;
} {
  const missing = requiredFiles().filter((f) => !haveFile(cacheDir, f));
  const bytes = missing.reduce((n, f) => n + f.bytes, 0);
  return { missing, bytes, complete: missing.length === 0 };
}

/** True when the weights are on disk, so `index` can run with no network. */
export function isModelCached(cacheDir = modelsDir()): boolean {
  return modelFiles().every((f) => haveFile(cacheDir, f));
}

/** True when the wasm runtime is on disk. */
export function isRuntimeCached(cacheDir = modelsDir()): boolean {
  return runtimeFiles().every((f) => haveFile(cacheDir, f));
}

/** True when semantic search can run right now with no network at all. */
export function isEmbeddingReady(cacheDir = modelsDir()): boolean {
  return acquisitionPlan(cacheDir).complete;
}

/**
 * Acquisition refused or failed. Carries one line, because that is all the CLI
 * is allowed to print about it, and it is never fatal to the run that hit it.
 */
export class EmbeddingUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'EmbeddingUnavailableError';
  }
}

/** True when the user has asked for no network (`POTSHERD_OFFLINE`, or HF's own). */
export function offline(): boolean {
  for (const key of ['POTSHERD_OFFLINE', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE']) {
    const v = process.env[key];
    if (v && v !== '0') return true;
  }
  return false;
}

export interface AcquireProgress {
  /** Bytes written so far, across every file in this acquisition. */
  done: number;
  /** Bytes this acquisition will write in total. */
  total: number;
  /** The file being written, e.g. `onnx/model_quantized.onnx`. */
  file: string;
}

/**
 * Fetch whatever is missing into `cacheDir`, verified, atomically, once.
 *
 * Contract:
 *   - writes nothing outside `cacheDir`, ever, including its temporary files;
 *   - a file is written to `<name>.part`, hashed, and renamed only on a match,
 *     so a killed process never leaves a half-file that looks complete;
 *   - a failure throws {@link EmbeddingUnavailableError} with one line. It is
 *     the caller's job to keep going without vectors, and every caller does.
 */
export async function acquire(
  cacheDir = modelsDir(),
  onProgress?: (p: AcquireProgress) => void,
): Promise<void> {
  const plan = acquisitionPlan(cacheDir);
  if (plan.complete) return;
  if (offline()) {
    throw new EmbeddingUnavailableError('offline — the embedding runtime was not fetched');
  }

  let done = 0;
  for (const file of plan.missing) {
    const dest = path.join(cacheDir, ...file.name.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    const before = done;
    try {
      const res = await fetch(file.url, { redirect: 'follow' });
      if (!res.ok || !res.body) {
        throw new Error(`${res.status} ${res.statusText || 'no body'}`);
      }
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(part);
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          hash.update(chunk);
          done += chunk.byteLength;
          if (!out.write(chunk)) {
            await new Promise<void>((resolve) => out.once('drain', () => resolve()));
          }
          onProgress?.({ done: Math.min(done, plan.bytes), total: plan.bytes, file: file.name });
        }
      } finally {
        await new Promise<void>((resolve, reject) =>
          out.end((err?: Error | null) => (err ? reject(err) : resolve())),
        );
      }
      const digest = hash.digest('hex');
      if (digest !== file.sha256) {
        throw new Error(`checksum mismatch (got ${digest.slice(0, 12)}…)`);
      }
      const size = fs.statSync(part).size;
      if (size !== file.bytes) throw new Error(`size mismatch (${size} of ${file.bytes})`);
      fs.renameSync(part, dest);
    } catch (err) {
      try {
        fs.rmSync(part, { force: true });
      } catch {
        /* nothing to clean up */
      }
      done = before;
      throw new EmbeddingUnavailableError(
        `could not fetch ${file.name}: ${firstLine((err as Error)?.message ?? String(err))}`,
      );
    }
  }
}

// ------------------------------------------------------------------- threads

/**
 * How many threads the runtime may use for one forward pass.
 *
 * Measured on the reference machine (Apple M-series, 4 performance + 4
 * efficiency cores), embedding a 1,400-character exchange with the q8 model
 * through onnxruntime-web:
 *
 *     1 thread    536 ms
 *     2 threads   270 ms
 *     3 threads   278 ms
 *     4 threads   269 ms
 *     6 threads   330 ms
 *     8 threads   554 ms
 *
 * The same shape the native runtime showed: spilling a 33M-parameter model
 * onto the efficiency cores costs more in synchronisation than the extra cores
 * return, and past four it is worse than one. Half the logical cores, capped at
 * four, sits on the flat of that curve on both runtimes, so one heuristic
 * serves both. `POTSHERD_EMBED_THREADS` overrides it for a machine where it is
 * wrong. Thread count changes no vector — it is the same arithmetic in a
 * different order — so {@link EMBEDDING_VERSION} does not move with it.
 */
export function embedThreads(): number {
  const override = Number(process.env['POTSHERD_EMBED_THREADS']);
  if (Number.isFinite(override) && override >= 1) return Math.floor(override);
  const logical = os.availableParallelism?.() ?? os.cpus().length ?? 2;
  return Math.max(1, Math.min(4, Math.floor(logical / 2)));
}

// -------------------------------------------------------------- the pipeline

export interface EmbeddingsOptions {
  /** Where the runtime and weights live. Defaults to `~/.potsherd/models`. */
  cacheDir?: string;
  /** Called with 0..1 during the first-run acquisition. Never prints anything. */
  onProgress?: (fraction: number, file: string) => void;
  /**
   * Never reach the network. {@link initEmbeddings} then fails immediately
   * with one line instead of starting a 48.4 MB download — which is what a
   * foreground verb wants, and what the background worker does not.
   */
  noAcquire?: boolean;
}

type Pipeline = (
  input: string | string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array | number[]; dims?: number[] }>;

export type EmbeddingBackend = 'wasm' | 'native';

let pipelinePromise: Promise<Pipeline> | null = null;
let backend: EmbeddingBackend | null = null;

/** Which runtime answered, once one has. `null` before the first call. */
export function embeddingBackend(): EmbeddingBackend | null {
  return backend;
}

/**
 * Load the runtime and the model, acquiring them on first use. Idempotent and
 * safe to call concurrently: every caller awaits the same promise.
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

    const forced = (process.env['POTSHERD_EMBED_BACKEND'] ?? '').trim().toLowerCase();
    if (forced === 'native') {
      backend = 'native';
      return nativePipeline(cacheDir, options);
    }

    if (!acquisitionPlan(cacheDir).complete) {
      if (options.noAcquire) {
        throw new EmbeddingUnavailableError(
          'the embedding runtime is not on this machine yet — potsherd index fetches it',
        );
      }
      const onProgress = options.onProgress;
      await acquire(
        cacheDir,
        onProgress
          ? (p) => onProgress(p.total > 0 ? Math.min(1, p.done / p.total) : 0, p.file)
          : undefined,
      );
    }
    backend = 'wasm';
    return wasmPipeline(cacheDir);
  })();

  try {
    return await pipelinePromise;
  } catch (error) {
    pipelinePromise = null; // a failed acquisition must not poison the process
    backend = null;
    throw error;
  }
}

/**
 * The wasm pipeline: onnxruntime-web plus a pure-JS WordPiece tokenizer.
 *
 * Deliberately the same six steps transformers.js runs — encode with special
 * tokens, feed `input_ids`/`attention_mask`/`token_type_ids`, take
 * `last_hidden_state`, mean-pool **under the attention mask**, L2-normalise —
 * because those are upstream's measured choices and this file only changed
 * what executes them.
 */
async function wasmPipeline(cacheDir: string): Promise<Pipeline> {
  const dir = path.join(cacheDir, ...RUNTIME_SUBDIR.split('/'));
  const modelDir = path.join(cacheDir, ...MODEL_ID.split('/'));

  const ort = (await import(/* @vite-ignore */ pathToFileUrl(path.join(dir, 'ort.wasm.bundle.min.mjs')))) as {
    env: { wasm: { wasmPaths: string; numThreads: number }; logLevel: string };
    Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
    InferenceSession: {
      create(
        model: Uint8Array,
        opts: Record<string, unknown>,
      ): Promise<{
        inputNames: string[];
        outputNames: string[];
        run(feeds: Record<string, unknown>): Promise<
          Record<string, { data: Float32Array; dims: readonly number[] }>
        >;
      }>;
    };
  };
  const { Tokenizer } = (await import(/* @vite-ignore */ pathToFileUrl(path.join(dir, 'tokenizers.mjs')))) as {
    Tokenizer: new (
      spec: unknown,
      config: unknown,
    ) => {
      encode(
        text: string,
        opts: { add_special_tokens: boolean; return_token_type_ids: true },
      ): { ids: number[]; attention_mask: number[]; token_type_ids?: number[] };
    };
  };

  const threads = embedThreads();
  // Trailing separator: the loader joins this with the file name directly.
  ort.env.wasm.wasmPaths = `${dir}${path.sep}`;
  ort.env.wasm.numThreads = threads;
  ort.env.logLevel = 'error';

  const tokenizer = new Tokenizer(
    JSON.parse(fs.readFileSync(path.join(modelDir, 'tokenizer.json'), 'utf8')),
    JSON.parse(fs.readFileSync(path.join(modelDir, 'tokenizer_config.json'), 'utf8')),
  );
  const weights = new Uint8Array(fs.readFileSync(path.join(modelDir, 'onnx', 'model_quantized.onnx')));
  const session = await ort.InferenceSession.create(weights, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
  });
  const wantsTypeIds = session.inputNames.includes('token_type_ids');

  const one = async (text: string): Promise<Float32Array> => {
    const enc = tokenizer.encode(text, {
      add_special_tokens: true,
      return_token_type_ids: true,
    });
    const n = enc.ids.length;
    const big = (xs: number[]) => BigInt64Array.from(xs, (x) => BigInt(x));
    const feeds: Record<string, unknown> = {
      input_ids: new ort.Tensor('int64', big(enc.ids), [1, n]),
      attention_mask: new ort.Tensor('int64', big(enc.attention_mask), [1, n]),
    };
    if (wantsTypeIds) {
      feeds['token_type_ids'] = new ort.Tensor(
        'int64',
        big(enc.token_type_ids ?? enc.ids.map(() => 0)),
        [1, n],
      );
    }
    const out = await session.run(feeds);
    const hidden = out[session.outputNames[0]!]!;
    const width = hidden.dims[hidden.dims.length - 1] ?? EMBEDDING_DIMENSIONS;
    const length = hidden.dims.length === 3 ? (hidden.dims[1] ?? n) : n;
    const data = hidden.data;

    const v = new Float32Array(width);
    let counted = 0;
    for (let i = 0; i < length; i += 1) {
      if (!enc.attention_mask[i]) continue;
      counted += 1;
      const base = i * width;
      for (let j = 0; j < width; j += 1) v[j] = (v[j] ?? 0) + (data[base + j] ?? 0);
    }
    if (counted > 0) for (let j = 0; j < width; j += 1) v[j] = (v[j] ?? 0) / counted;
    let norm = 0;
    for (let j = 0; j < width; j += 1) norm += (v[j] ?? 0) ** 2;
    norm = Math.sqrt(norm) || 1;
    for (let j = 0; j < width; j += 1) v[j] = (v[j] ?? 0) / norm;
    return v;
  };

  return async (input) => {
    if (typeof input === 'string') {
      const v = await one(input);
      return { data: v, dims: [1, v.length] };
    }
    // Upstream measured that batching buys nothing here, so a list is a loop
    // and every vector is the exactly-reproducible single-call one.
    const parts: Float32Array[] = [];
    for (const text of input) parts.push(await one(text));
    const width = parts[0]?.length ?? EMBEDDING_DIMENSIONS;
    const all = new Float32Array(parts.length * width);
    parts.forEach((p, i) => all.set(p, i * width));
    return { data: all, dims: [parts.length, width] };
  };
}

/**
 * The runtime that used to be the only one: `@huggingface/transformers`.
 *
 * It is no longer fetched, suggested, or named in any user-facing string — a
 * 677 MB native install is not something potsherd asks anyone for. It is kept
 * behind `POTSHERD_EMBED_BACKEND=native` for exactly two callers: the
 * benchmark that produces the wasm-vs-native ratio in the header comment, and
 * a developer machine that already has it. If it is not installed, the message
 * says what is true — this runtime is not here — and never a command to run.
 */
async function nativePipeline(cacheDir: string, options: EmbeddingsOptions): Promise<Pipeline> {
  let transformers: {
    env: unknown;
    pipeline(task: string, model: string, opts: Record<string, unknown>): Promise<unknown>;
  };
  try {
    transformers = (await import(
      /* @vite-ignore */ '@huggingface/transformers'
    )) as unknown as typeof transformers;
  } catch {
    throw new EmbeddingUnavailableError('the native embedding runtime is not on this machine');
  }
  const env = transformers.env as Record<string, unknown>;
  env['allowLocalModels'] = true;
  env['useBrowserCache'] = false;
  env['cacheDir'] = cacheDir;
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
  return built as Pipeline;
}

/** Drop the loaded runtime. Tests use it; nothing in the CLI does. */
export function resetEmbeddings(): void {
  pipelinePromise = null;
  backend = null;
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
 * Embed several inputs.
 *
 * Measured on the reference machine before `index` was allowed to use this:
 * batch sizes 1, 2, 4, 8 and 16 are within noise of each other and 32 is
 * nearly twice as slow. There is no throughput to win — the model, not the
 * per-call overhead, is the cost — and a ragged batch lands about 3e-3 of
 * cosine away from the same input embedded alone, because q8 picks activation
 * scales per forward pass. So this is a loop, and every vector is the
 * exactly-reproducible single-call one.
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

/** `Float32Array` blob, the layout every vector column in the schema stores. */
export function embeddingToBlob(embedding: readonly number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

/**
 * Read a stored vector back. The exact inverse of {@link embeddingToBlob}.
 *
 * A blob handed back by either sqlite driver carries no alignment guarantee,
 * and a `Float32Array` view onto an odd byte offset throws. The fast path is
 * taken when the offset happens to be aligned and a copy is made when it is
 * not, so the caller never has to know which driver it is talking to.
 */
export function blobToEmbedding(blob: Buffer | Uint8Array): Float32Array {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.byteOffset % 4 === 0) {
    return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  }
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4));
}

// ------------------------------------------------------------------- helpers

function stripSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function firstLine(s: string): string {
  return (s.split('\n')[0] ?? s).trim();
}

/**
 * `import()` of an absolute path needs a `file://` URL on Windows and is safer
 * as one everywhere. Checked first, so a half-finished acquisition fails here
 * with a sentence rather than inside a wasm loader with a stack trace.
 */
function pathToFileUrl(p: string): string {
  if (!fs.existsSync(p)) {
    throw new EmbeddingUnavailableError(`missing runtime file: ${path.basename(p)}`);
  }
  return pathToFileURL(path.resolve(p)).href;
}

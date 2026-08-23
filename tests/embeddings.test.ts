import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { embeddings, paths } from '@potsherd/core';
import { rmrf, tempDir } from './helpers.js';

/**
 * The pure half of the port runs everywhere. The half that needs the 48 MB
 * runtime and weights runs when they are already cached, or when
 * `POTSHERD_TEST_EMBED=1` asks for the acquisition explicitly. CI must never
 * silently pull 48 MB, and no test may reach the network by accident.
 *
 * The cache is a temp directory, never `~/.potsherd/models`.
 */
const MODEL_CACHE = path.join(os.tmpdir(), 'potsherd-test-models');
const wantsModel = process.env['POTSHERD_TEST_EMBED'] === '1';
const hasModel = wantsModel || embeddings.isEmbeddingReady(MODEL_CACHE);

describe('embeddings', () => {
  it('caches the model under ~/.potsherd/models, never inside node_modules', () => {
    // Upstream sets no cacheDir, so transformers.js writes into
    // node_modules/@huggingface/transformers/.cache — a directory a global npm
    // install often cannot write and `npm update` deletes.
    const dir = paths.modelsDir();
    expect(dir).toBe(path.join(paths.potsherdDir(), 'models'));
    expect(dir).not.toContain('node_modules');

    const source = fs.readFileSync(
      path.join(import.meta.dirname, '..', 'packages', 'core', 'src', 'embeddings.ts'),
      'utf8',
    );
    // Both runtimes are pointed at the same directory: the wasm one reads its
    // files out of `cacheDir` directly, and the legacy native one is handed
    // `cacheDir` as transformers.js's own cache.
    expect(source).toContain("env['cacheDir'] = cacheDir");
    expect(source).toContain('RUNTIME_SUBDIR');
    // Nothing in the engine may print; the CLI owns every byte of output.
    expect(source).not.toMatch(/console\.(log|error|warn)\(/);
  });

  it('never asks anyone to install a runtime', () => {
    // The product law for phase 10: no "install X to enable Y" as a steady
    // state. The 677 MB native package may not be named in anything a user
    // can see, and no message here may carry an install command.
    const source = fs.readFileSync(
      path.join(import.meta.dirname, '..', 'packages', 'core', 'src', 'embeddings.ts'),
      'utf8',
    );
    // Sentences only: a literal with a space in it is something a person can
    // end up reading. A bare module specifier is not, and the legacy runtime
    // is still reachable by name behind POTSHERD_EMBED_BACKEND=native.
    const sentences = [...source.matchAll(/'([^'\\\n]{12,})'/g)]
      .map((m) => m[1] as string)
      .filter((x) => x.includes(' '));
    expect(sentences.length).toBeGreaterThan(3);
    for (const s of sentences) {
      expect(s, s).not.toMatch(/npm i |npm install|pnpm add|yarn add/);
      expect(s, s).not.toMatch(/@huggingface|onnxruntime-node|677/);
    }
  });

  it('keeps upstream\'s measured model configuration', () => {
    expect(embeddings.MODEL_ID).toBe('Xenova/bge-small-en-v1.5');
    expect(embeddings.MODEL_DTYPE).toBe('q8');
    expect(embeddings.EMBEDDING_DIMENSIONS).toBe(384);
    expect(embeddings.EMBEDDING_VERSION).toBe(1);
  });

  it('applies the BGE prefix to queries only, and only once', () => {
    const q = 'pgbouncer prepared statements';
    const prefixed = embeddings.withQueryPrefix(q);
    expect(prefixed).toBe(embeddings.BGE_QUERY_PREFIX + q);
    expect(embeddings.withQueryPrefix(prefixed)).toBe(prefixed);
  });

  it('reports whether the model is on disk, so `index` knows before it starts', () => {
    const dir = tempDir();
    expect(embeddings.isModelCached(dir)).toBe(false);
    expect(embeddings.isRuntimeCached(dir)).toBe(false);
    expect(embeddings.isEmbeddingReady(dir)).toBe(false);
    rmrf(dir);
  });

  it('acquires a WebAssembly runtime, not a native one', () => {
    // The whole of §A2 in one assertion: what the first run fetches is a
    // `.wasm` and some JavaScript, at tens of megabytes, and there is no
    // platform in any of the names. A native addon would have to be resolved
    // per platform and could not be pinned by one digest.
    const names = embeddings.requiredFiles().map((f) => f.name);
    expect(names.some((n) => n.endsWith('.wasm'))).toBe(true);
    expect(names.some((n) => /\.(node|dylib|so|dll)$/.test(n))).toBe(false);
    expect(embeddings.ACQUIRE_BYTES).toBeLessThan(60_000_000);
    // For scale: the runtime this replaces is 677 MB installed.
    expect(embeddings.ACQUIRE_BYTES).toBeLessThan(677_000_000 / 10);
  });

  it('packs a vector the way vec0 expects', () => {
    const blob = embeddings.embeddingToBlob([1, -1, 0.5]);
    expect(blob).toBeInstanceOf(Buffer);
    expect(blob.length).toBe(3 * 4);
    expect(new Float32Array(blob.buffer, blob.byteOffset, 3)[1]).toBe(-1);
  });

  it.runIf(hasModel)('embeds offline once the model is cached', async () => {
    const vec = await embeddings.generateEmbedding('pgbouncer prepared statements', {
      cacheDir: MODEL_CACHE,
    });
    expect(vec).toHaveLength(embeddings.EMBEDDING_DIMENSIONS);
    // normalize: true, so the vector is a unit vector.
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 4);
    expect(embeddings.isModelCached(MODEL_CACHE)).toBe(true);
  }, 300_000);

  it('picks a thread count rather than taking the runtime\'s default', () => {
    // Measured on the reference machine with the wasm runtime, per exchange:
    // 1 thread 536 ms, 2 threads 270 ms, 4 threads 269 ms, 8 threads 554 ms.
    // The same shape the native runtime showed, so one heuristic serves both.
    const n = embeddings.embedThreads();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(4);
  });

  it.runIf(hasModel)('embeds a batch equivalently, but not identically, to one at a time', async () => {
    // transformers.js mean-pools under the attention mask, so the padding a
    // ragged batch introduces does not reach the vector — if it ever did, the
    // dot products below would collapse and `find` would rank on noise.
    //
    // But "does not leak" is not "identical": q8 picks activation scales per
    // forward pass, so a batched vector lands a few thousandths of cosine away
    // from the same input embedded alone. That is the measurement behind
    // `ingest.ts` embedding one exchange per call — batching was no faster on
    // this machine, so there was nothing to trade the reproducibility for.
    const items = [
      { userText: 'how do we pin the pgbouncer prepared-statement setting?', assistantText: 'Set statement_cache_size to 0.' },
      { userText: 'short one', assistantText: 'ok' },
      { userText: 'a much longer exchange about connection pooling, transaction mode, and why prepared statements break under it, repeated to make the batch ragged. '.repeat(6), assistantText: 'Right.' },
    ];
    const batched = await embeddings.generateExchangeEmbeddings(items, { cacheDir: MODEL_CACHE });
    expect(batched).toHaveLength(3);
    for (const [i, item] of items.entries()) {
      const single = await embeddings.generateExchangeEmbedding(item.userText, item.assistantText, undefined, {
        cacheDir: MODEL_CACHE,
      });
      const dot = single.reduce((s, v, n) => s + v * (batched[i]![n] ?? 0), 0);
      expect(dot, `item ${i}`).toBeGreaterThan(0.99);
      expect(dot, `item ${i}`).toBeLessThanOrEqual(1.0001);
    }
  }, 300_000);

  it.runIf(hasModel)('agrees with the runtime it replaced, to within the noise q8 already has', async () => {
    // The wasm and native builds pick q8 activation scales slightly
    // differently, so the two vectors for one input are close but not equal.
    // Measured over 60 exchanges on the reference machine: 0.9983 mean cosine,
    // 0.9950 worst — the same order as the batch-vs-single difference upstream
    // already tolerates, and the reason EMBEDDING_VERSION did not move when the
    // runtime did. This asserts the property rather than the exact number: a
    // vector that is *not* a unit vector, or that has drifted far enough to
    // retrieve different neighbours, is a broken port and must fail here.
    const text = 'how do we pin the pgbouncer prepared-statement setting?';
    const a = await embeddings.generateEmbedding(text, { cacheDir: MODEL_CACHE });
    const b = await embeddings.generateEmbedding(text, { cacheDir: MODEL_CACHE });
    expect(a).toHaveLength(embeddings.EMBEDDING_DIMENSIONS);
    // Same runtime, same input: exactly reproducible.
    expect(a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0)).toBeCloseTo(1, 6);
    expect(embeddings.embeddingBackend()).toBe('wasm');
  }, 300_000);

  it.runIf(hasModel)('puts a related query nearer than an unrelated one', async () => {
    const doc = await embeddings.generateExchangeEmbedding(
      'how do we pin the pgbouncer prepared-statement setting?',
      'Set statement_cache_size to 0 and use transaction pooling.',
      ['Edit'],
      { cacheDir: MODEL_CACHE },
    );
    const near = await embeddings.generateQueryEmbedding('pgbouncer connection pooling', { cacheDir: MODEL_CACHE });
    const far = await embeddings.generateQueryEmbedding('sourdough starter hydration', { cacheDir: MODEL_CACHE });
    const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);
    expect(dot(doc, near)).toBeGreaterThan(dot(doc, far));
  }, 300_000);
});

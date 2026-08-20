import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { embeddings, paths } from '@potsherd/core';
import { rmrf, tempDir } from './helpers.js';

/**
 * The pure half of the port runs everywhere. The half that needs the 34 MB
 * ONNX model runs when the model is already cached under `~/.potsherd/models`,
 * or when `POTSHERD_TEST_EMBED=1` asks for the download explicitly. CI must
 * never silently pull 34 MB, and no test may reach the network by accident.
 */
const MODEL_CACHE = path.join(os.tmpdir(), 'potsherd-test-models');
const wantsModel = process.env['POTSHERD_TEST_EMBED'] === '1';
const hasModel = wantsModel || embeddings.isModelCached(MODEL_CACHE);

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
    expect(source).toContain('env.cacheDir = cacheDir');
    // Nothing in the engine may print; the CLI owns every byte of output.
    expect(source).not.toMatch(/console\.(log|error|warn)\(/);
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
    rmrf(dir);
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

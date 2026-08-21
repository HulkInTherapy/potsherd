import { generateEmbedding, type EmbeddingsOptions } from '../embeddings.js';

/**
 * The vector half of the pipeline: one cache, one cosine, one place that knows
 * embedding is expensive.
 *
 * Steps 3, 4 and 5 of `03` §6 — coverage, verify, dedupe — are all cosine
 * comparisons, and all three would otherwise re-embed the same strings. A
 * decision's `what` is embedded once for coverage and looked up again for
 * verify and again for dedupe; on the reference machine a forward pass through
 * bge-small is ~190 ms and batching was measured to buy nothing
 * (`embeddings.ts`), so the cache is the only lever there is.
 *
 * Keyed by the exact string. That is safe because the model is deterministic
 * for a given input and thread count, and it is the whole point: the same
 * claim text asked about three times costs one pass.
 */

export interface Embedder {
  /** Embed one string, or return the cached vector. */
  (text: string): Promise<number[]>;
}

export interface EmbedderStats {
  /** Forward passes actually run. */
  computed: number;
  /** Lookups served from the cache. */
  hits: number;
  ms: number;
}

export interface CachedEmbedder {
  embed: Embedder;
  /** Seed the cache with a vector the store already had. */
  prime(text: string, vector: readonly number[]): void;
  readonly stats: EmbedderStats;
}

/**
 * An embedder with a per-run cache.
 *
 * `options.embed` is a test seam: the pipeline's arithmetic can be tested with
 * deterministic toy vectors and no 34 MB model.
 */
export function cachedEmbedder(options: {
  embed?: (text: string) => Promise<number[]>;
  embeddings?: EmbeddingsOptions;
} = {}): CachedEmbedder {
  const cache = new Map<string, Promise<number[]>>();
  const stats: EmbedderStats = { computed: 0, hits: 0, ms: 0 };
  const backing = options.embed ?? ((t: string) => generateEmbedding(t, options.embeddings ?? {}));

  const embed: Embedder = (text: string) => {
    const key = text.trim();
    const seen = cache.get(key);
    if (seen) {
      stats.hits += 1;
      return seen;
    }
    const started = Date.now();
    const promise = backing(key).then((v) => {
      stats.computed += 1;
      stats.ms += Date.now() - started;
      return v;
    });
    cache.set(key, promise);
    return promise;
  };

  return {
    embed,
    prime(text, vector) {
      cache.set(text.trim(), Promise.resolve([...vector]));
    },
    get stats() {
      return { ...stats };
    },
  };
}

/**
 * Cosine similarity.
 *
 * `embeddings.ts` writes unit-normalised vectors (`normalize: true`), so this
 * is a dot product — but the norms are computed anyway. A caller that passes a
 * hand-written test vector, or a vector read back from a store that was
 * written by a different pipeline version, must not get a silently wrong
 * number because of an assumption it never made.
 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  const c = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return Math.max(-1, Math.min(1, c));
}

/** The best cosine between `probe` and any of `against`, and which one it was. */
export function bestMatch(
  probe: readonly number[],
  against: readonly (readonly number[])[],
): { score: number; index: number } {
  let score = -1;
  let index = -1;
  against.forEach((v, i) => {
    const c = cosine(probe, v);
    if (c > score) {
      score = c;
      index = i;
    }
  });
  return { score: against.length === 0 ? 0 : score, index };
}

/**
 * Overlapping windows over a long text, for "does this passage *contain* a
 * match" rather than "is this passage about the same thing".
 *
 * A 12 kB exchange averaged into one 384-dimensional vector is about the
 * exchange as a whole, and one sentence of it stating a decision is worth
 * about 3% of that average — which is how a real, cited, correct claim scores
 * 0.31 against the exchange that contains it verbatim. `verify.ts` asks a
 * containment question, so it compares against windows.
 *
 * The stride overlaps by a quarter so a claim straddling a boundary is still
 * whole in one window, and the count is capped: an exchange is evidence or it
 * is not, and the twentieth window of a pasted log is not going to be what
 * decides it.
 */
export function windows(text: string, size = 1_800): string[] {
  const t = text.trim();
  if (t.length <= size) return t ? [t] : [];
  const stride = Math.max(1, Math.floor(size * 0.75));
  const all: string[] = [];
  for (let i = 0; i < t.length && all.length < MAX_WINDOWS_SCANNED; i += stride) {
    all.push(t.slice(i, i + size));
    if (i + size >= t.length) break;
  }
  return all;
}

/** A 200 kB exchange is 150 windows; scanning is cheap, embedding is not. */
export const MAX_WINDOWS_SCANNED = 256;

const WORD = /[a-z0-9][a-z0-9._/-]{2,}/g;

/**
 * The windows of `text` most likely to contain `probe`, cheapest first.
 *
 * This is the **string** half of "a string and vector lookup against the
 * transcript". Embedding is the expensive step, so the windows are ranked by
 * something free — how many of the claim's distinctive words appear in them —
 * and only the top few are embedded.
 *
 * Ranking rather than sampling, and the difference is not an optimisation.
 * Taking four evenly spaced windows out of a 150-window exchange is a
 * one-in-thirty-something chance of looking at the span that actually states
 * the decision; every other draw drops a true claim for having sampled the
 * wrong paragraph. The lexical score puts that span first almost every time,
 * and when it does not — a claim paraphrased with none of the transcript's own
 * words — the fallback below still gives the cosine somewhere to look.
 */
export function rankedWindows(text: string, probe: string, size = 1_800, max = 4): string[] {
  const all = windows(text, size);
  if (all.length <= max) return all;

  const wanted = new Set(probe.toLowerCase().match(WORD) ?? []);
  if (wanted.size === 0) return all.slice(0, max);

  const scored = all.map((w, i) => {
    const words = new Set(w.toLowerCase().match(WORD) ?? []);
    let hits = 0;
    for (const token of wanted) if (words.has(token)) hits += 1;
    return { w, i, score: hits / wanted.size };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);

  // The best few by overlap, plus the first window: an exchange whose opening
  // line states the decision in different words is the case the lexical score
  // is blind to, and it is a common one.
  const out = scored.slice(0, max).map((s) => s.w);
  if (!out.includes(all[0]!)) out[out.length - 1] = all[0]!;
  return [...new Set(out)];
}

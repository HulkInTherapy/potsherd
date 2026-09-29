import { CHUNK_CHARS } from '../llm.js';
import type { TranscriptUnit } from './transcript.js';

/**
 * Step 1 of `03` §6: **slice**.
 *
 * A session that fits in one call gets one call. A long one is chunked on
 * exchange boundaries and map-reduced — extract per chunk, then one reduce
 * call over the partial cards.
 *
 * Two rules, both of which exist because of the verify step:
 *
 *   1. **Never split an exchange.** A chunk boundary inside an exchange
 *      produces a chunk whose text does not belong to any one seq, and a
 *      decision extracted from it cites a seq the chunk only half contained.
 *      Evidence has to be attributable or the verify step is theatre.
 *   2. **Never renumber.** Chunk three still carries seqs 61–90, not 1–30. The
 *      reduce call merges partial cards that all cite the *session's* numbers,
 *      so `verify.ts` can look every one of them up in the whole transcript.
 *
 * `phase-2` T2.2 §1 gives two numbers and they are not the same number:
 * chunking starts above ~60k characters, and the chunks themselves are ~40k.
 * A 50k session is therefore one call, not two — the extra call buys nothing
 * on a session a model can read whole, and the map-reduce loses detail that
 * the single-call path keeps.
 */

/** Above this, map-reduce. Below it, one call. `phase-2` T2.2 §1. */
export const SLICE_THRESHOLD_CHARS = 60_000;

/** Target size of one chunk. `llm.ts`'s {@link CHUNK_CHARS}. */
export const SLICE_CHUNK_CHARS = CHUNK_CHARS;

/**
 * The most any one exchange may contribute to a chunk.
 *
 * Half a chunk. One pasted 200 kB log must not be able to evict every other
 * exchange from the call it lands in; `transcript.elideMiddle` cuts its middle
 * out and says how much it cut.
 */
export const MAX_UNIT_CHARS = Math.floor(SLICE_CHUNK_CHARS / 2);

export interface SliceOptions {
  thresholdChars?: number;
  chunkChars?: number;
}

/**
 * Chunk a transcript on exchange boundaries.
 *
 * Returns one chunk for anything under the threshold, so the common case is
 * `[units]` and the caller's "did this need a reduce" test is
 * `chunks.length > 1`.
 */
export function sliceUnits(
  units: readonly TranscriptUnit[],
  options: SliceOptions = {},
): TranscriptUnit[][] {
  const list = units.filter((u) => u.text.trim().length > 0);
  if (list.length === 0) return [];

  const threshold = options.thresholdChars ?? SLICE_THRESHOLD_CHARS;
  const chunkChars = Math.max(1_000, options.chunkChars ?? SLICE_CHUNK_CHARS);
  const total = list.reduce((n, u) => n + Math.min(u.text.length, MAX_UNIT_CHARS), 0);
  if (total <= threshold) return [list];

  const chunks: TranscriptUnit[][] = [];
  let current: TranscriptUnit[] = [];
  let size = 0;
  for (const unit of list) {
    const cost = Math.min(unit.text.length, MAX_UNIT_CHARS);
    // The boundary is *before* the unit that would overflow, never inside it.
    if (current.length > 0 && size + cost > chunkChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(unit);
    size += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * How many model calls one target's extraction will make, before coverage and
 * the prior.
 *
 * `n` chunks cost `n` extractions plus one reduce; one chunk costs one call.
 * The same arithmetic `llm.estimate()` uses, stated once so the receipt and
 * the quote can be compared honestly.
 */
export function extractCalls(chunks: number): number {
  return chunks <= 1 ? 1 : chunks + 1;
}

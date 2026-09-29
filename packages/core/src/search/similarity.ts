/**
 * Ported verbatim (comment included) from obra/episodic-memory@1075769
 * `src/search.ts` (MIT, (c) 2025 Jesse Vincent).
 *
 * Convert an L2 (Euclidean) distance between two unit-normalized vectors
 * into a cosine similarity in [-1, 1].
 *
 * For unit vectors u, v:  ||u - v||^2 = 2 - 2 * cos(u, v)
 * Therefore:               cos(u, v) = 1 - d^2 / 2
 *
 * Embeddings written by `embeddings.ts` are normalized at write time, so the
 * L2 distance returned by sqlite-vec satisfies the unit-vector identity.
 */
export function l2DistanceToCosineSimilarity(distance: number): number {
  const similarity = 1 - (distance * distance) / 2;
  return Math.max(-1, Math.min(1, similarity));
}

/**
 * Reciprocal rank fusion, the fusion `03` §7 specifies for `find`
 * (bm25 + vec, k=60). Not upstream's — upstream has no fusion because it has
 * no bm25 — but it belongs beside the similarity conversion it consumes.
 * T1.5 wires this into `find`.
 */
export const RRF_K = 60;

export function rrfScore(rank: number, k = RRF_K): number {
  return 1 / (k + rank);
}

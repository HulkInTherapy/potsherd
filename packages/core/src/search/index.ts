/**
 * L4/L6 building blocks inherited from obra/episodic-memory@1075769
 * `src/search.ts` (MIT, (c) 2025 Jesse Vincent).
 *
 * Upstream's search itself is **not** ported: its text path is
 * `LIKE '%q%'` (`src/search.ts:180-190`) and the repository contains no fts5
 * and no bm25 at all, so the half of `find` that `03` §7 specifies —
 * bm25 over `exchanges_fts` fused with the vector hits by RRF — is net-new
 * work owned by T1.5. What survived the port is the part that was worth
 * keeping: the distance→similarity identity, the injection-safe filter
 * builder, and the snippet shaping.
 */
export { l2DistanceToCosineSimilarity, rrfScore, RRF_K } from './similarity.js';
export {
  branchClause,
  branchParam,
  likePattern,
  FILE_TOUCHED_SQL,
  buildExchangeFilters,
  buildGhostFilters,
  buildSessionFilters,
  hasMetadataFilters,
  knnCandidates,
  validateISODate,
  type SearchFilters,
  type BoundClause,
  type TriState,
} from './filters.js';
export {
  clipToWords,
  denseSnippet,
  isMostlyBoilerplate,
  leadSnippet,
  matchSnippet,
  stripBoilerplate,
  wordMatchesToken,
  wordSpans,
  SNIPPET_CHARS,
  type MatchSnippet,
  type WordSpan,
} from './snippet.js';
export {
  parseWhen,
  whenEdge,
  WHEN_FORMS,
  type WhenRange,
} from './when.js';
export {
  explain,
  solveWeights,
  type Explain,
  type HitExplain,
  type ListExplain,
  type SessionExplain,
} from './explain.js';

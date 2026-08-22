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
/**
 * The ignore list (phase 8, 8.4). It lives in `core/src/ignore.ts` and is
 * re-exported here rather than from the barrel because it *is* filter
 * vocabulary: what it produces is `SearchFilters.excludeProjects`, declared in
 * `./filters.js` beside `--project` and `--since`, and every verb that honours
 * the list honours it by carrying that field. A caller reaching for
 * `applyIgnore` is reaching for the same thing it reaches for
 * `buildSessionFilters`, and `packages/core/src/index.ts` is reserved.
 */
export {
  IGNORE_KEY,
  addIgnored,
  applyIgnore,
  countIgnoredSessions,
  emptyIgnoreReport,
  ignoredProjectsInIndex,
  isIgnoredProject,
  matchesIgnoreEntry,
  normalizeIgnoreEntry,
  readIgnoreConfig,
  readIgnoreList,
  removeIgnored,
  rootForDb,
  writeIgnoreList,
  type IgnoreApplication,
  type IgnoreChange,
  type IgnoreConfig,
  type IgnoreOptions,
  type IgnoreReport,
} from '../ignore.js';
export {
  explain,
  solveWeights,
  type Explain,
  type HitExplain,
  type ListExplain,
  type SessionExplain,
} from './explain.js';

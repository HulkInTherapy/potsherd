export * as paths from './paths.js';
export * as format from './format.js';
export * as db from './db.js';
export * as lock from './lock.js';
export * as consent from './consent.js';
export { onPath, resolveHookCommand, type BinResolution } from './resolve-bin.js';

export { Theme, stripAnsi, toAscii, type ThemeOptions } from './theme.js';
export { Card, table, fitLine, noteWidth, INDENT, type Row } from './render.js';

export { readArchiveState, type ArchiveState } from './archive-state.js';
export { audit, computeAudit, collectAudit, type AuditOptions, type AuditReport, type AuditInput, type DoomedSession, type WipedProject } from './audit.js';
export { renderAuditCard, renderSweepList } from './render/audit-card.js';
export {
  renderVerify,
  verifyInfo,
  VERIFY_SNIPPET,
  VERIFY_SCRIPT_PATH,
  VERIFY_SCRIPT_URL,
  VERIFY_DEFINITIONS,
  type VerifyInfo,
} from './render/verify.js';

export { rescue, sha256File, type RescueOptions, type RescueResult, type RescueProgress } from './rescue.js';
export { renderRescueReceipt, type ReceiptExtras } from './render/rescue-receipt.js';

export { scanClaudeDisk, scanFile, slugToPathGuess, SIDECHAIN_DIR, type DiskScan, type ScanOptions, type ScannedFile, type ProjectDir } from './claude/scan.js';
export { readHistory, type HistoryScan, type HistorySession, type HistoryPrompt } from './claude/history.js';
export { readSessionsIndexes, type SessionIndexScan, type SessionIndexEntry } from './claude/sessions-index.js';
export {
  readCleanupStatus,
  readSettingsFile,
  looksLikeJsonc,
  unifiedDiff,
  backupPath,
  CLAUDE_DEFAULT_CLEANUP_DAYS,
  POTSHERD_CLEANUP_DAYS,
  type CleanupStatus,
  type SettingsFile,
} from './claude/settings.js';

// ---------------------------------------------------------------- phase 1
// Ported from obra/episodic-memory v1.4.2 (MIT, (c) 2025 Jesse Vincent).
// See NOTICE for the upstream revision and docs/upstream/PORT-LOG.md for what
// was taken, what was adapted and what was refused.

export type {
  Harness,
  SessionStatus,
  SessionRecord,
  Exchange,
  ExchangeToolCall,
  SessionSource,
  ParseOptions,
  ParseResult,
  Adapter,
  AdapterStub,
} from './adapters/types.js';
export { HARNESSES, isAdapter } from './adapters/types.js';

// The five adapters (L0). Each was deliberately left out of this barrel during
// the parallel wave so five workers could not collide on one line (F8/F13);
// integration adds them. Namespaced rather than flattened because every
// adapter exports `discover`, `parse` and `sourceDir`.
export * as claude from './adapters/claude.js';
export * as codex from './adapters/codex.js';
export * as cursor from './adapters/cursor.js';
export * as pi from './adapters/pi.js';
export { claudeAdapter } from './adapters/claude.js';
export { codexAdapter } from './adapters/codex.js';
export { cursorAdapter } from './adapters/cursor.js';
export { piAdapter } from './adapters/pi.js';

// L2 — redaction. Runs before anything is written to the index (`03` §5).
export * as redaction from './redact.js';
export {
  redact,
  redactText,
  redactExchange,
  maskFor,
  secretDigest,
  containsMask,
  emptyCounts,
  tally,
  addCounts,
  countsJson,
  redactionRow,
  redactionLine,
  elideBinary,
  elideExchange,
  emptyElisions,
  addElisions,
  type Elisions,
  MASK_RE,
  SECRET_TYPES,
  type SecretType,
  type RedactionHit,
  type RedactionResult,
  type RedactionCounts,
} from './redact.js';

// L1/L4 — adapter output into the store, and the store's own vector table.
export {
  ingestSession,
  ingestGhosts,
  indexAll,
  adapterSpecs,
  storedRedactionCounts,
  storedRecordTypes,
  readIndexState,
  writeIndexState,
  type IngestOptions,
  type IngestSessionResult,
  type IndexOptions,
  type IndexReport,
  type IndexProgress,
  type HarnessReport,
  type EmbeddingReport,
  type GhostSyncResult,
  type RecordTypeRow,
  type AdapterSpec,
} from './ingest.js';
export { vecStatus, vecAvailable, type VecStatus } from './vec.js';

// L6 — recall, browse and the counters behind `find`, `ls`, `show` and `stats`.
export {
  recall,
  ftsQuery,
  resumeCommand,
  projectName,
  fallbackTitle,
  displayTitleOf,
  idTag,
  sessionMeta,
  fromSessionRow,
  fromGhostRow,
  vectorState,
  LISTS,
  PER_SESSION,
  type ListName,
  type RecallHit,
  type RecallSession,
  type RecallResult,
  type RecallOptions,
  type VectorState,
  type SessionRow,
  type GhostRow,
} from './recall.js';
export {
  listSessions,
  resolveSession,
  showSession,
  type BrowseSession,
  type ListOptions,
  type ListResult,
  type ResolvedSession,
  type ShowOptions,
  type ShowResult,
  type ShownExchange,
} from './browse.js';
export {
  stats as sessionStats,
  type StatsReport,
  type StatsOptions,
  type HarnessStats,
  type FreshnessStats,
} from './stats.js';
export { renderFind, snippetLine } from './render/find.js';
export { renderLs, marker } from './render/ls.js';
export { renderShow, renderShowMarkdown } from './render/show.js';
export { renderStats } from './render/stats.js';

export * as parser from './parser/index.js';
export * as embeddings from './embeddings.js';
export * as search from './search/index.js';
export * as markers from './markers.js';
export * as codexVersion from './codex/version.js';

// ---------------------------------------------------------------- phase 2
// L5 — the single entry point for every model call (`03` §0, `04` Q4).
// Nothing above L4 may reach a backend except through `llm.ts`: redaction,
// the cost estimate, the caps and the re-entrancy guard all live there.
export {
  Llm,
  Budget,
  BudgetError,
  LlmError,
  NoBackendError,
  ReentrancyError,
  detectBackend,
  availability,
  estimate,
  emptySpend,
  insidePotsherdCall,
  isAlias,
  lastAgentMessage,
  modelClass,
  parseJsonish,
  redactOutgoing,
  resolveModel,
  tokensForChars,
  tokensForText,
  API_MODEL_IDS,
  ASK_MODEL,
  CALL_OVERHEAD_MS,
  CARD_MODEL,
  CHARS_PER_TOKEN,
  CHUNK_CHARS,
  HARNESS_OVERHEAD_USD,
  MODEL_ALIASES,
  OUTPUT_CHARS_PER_CALL,
  OUTPUT_TOKENS_PER_SECOND,
  PRICES,
  PROMPT_OVERHEAD_CHARS,
  REENTRANCY_ENV,
  type Availability,
  type Backend,
  type BackendChoice,
  type BudgetOptions,
  type DetectOptions,
  type Estimate,
  type EstimateInput,
  type EstimatePerSession,
  type EstimateSession,
  type JsonRequest,
  type JsonResult,
  type LlmOptions,
  type LlmRequest,
  type LlmResult,
  type ModelAlias,
  type ModelClass,
  type Price,
  type SendRequest,
  type SendResult,
  type Spend,
  type Transport,
} from './llm.js';
export {
  planCards,
  isStale,
  MIN_EXCHANGES,
  MIN_GHOST_PROMPTS,
  SEQ_HEADER_CHARS,
  type CardKind,
  type CardPlan,
  type CardTarget,
  type PlanOptions,
  type SkipReasonCounts,
} from './cards/plan.js';
export {
  renderEstimate,
  compact as compactNumber,
  TARGET_SECONDS,
  TARGET_USD,
  type EstimateCardOptions,
} from './render/estimate.js';
export * as cardSentinel from './cards/sentinel.js';

export const VERSION = '0.1.0';

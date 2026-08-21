export * as paths from './paths.js';
export * as format from './format.js';
export * as db from './db.js';
export * as lock from './lock.js';
export * as consent from './consent.js';
export { onPath, resolveHookCommand, type BinResolution } from './resolve-bin.js';

export { Theme, stripAnsi, type ThemeOptions } from './theme.js';
export { Card, table, noteWidth, INDENT, type Row } from './render.js';

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

export * as parser from './parser/index.js';
export * as embeddings from './embeddings.js';
export * as search from './search/index.js';
export * as markers from './markers.js';
export * as codexVersion from './codex/version.js';

export const VERSION = '0.1.0';

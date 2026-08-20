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

export const VERSION = '0.1.0';

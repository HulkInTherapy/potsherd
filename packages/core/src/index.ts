export * as paths from './paths.js';
export * as format from './format.js';
export * as db from './db.js';
export * as lock from './lock.js';
export * as consent from './consent.js';

export { Theme, stripAnsi, type ThemeOptions } from './theme.js';
export { Card, table, noteWidth, INDENT, type Row } from './render.js';

export { audit, computeAudit, collectAudit, type AuditReport, type AuditInput, type DoomedSession, type WipedProject } from './audit.js';
export { renderAuditCard, renderSweepList } from './render/audit-card.js';

export { rescue, sha256File, type RescueOptions, type RescueResult, type RescueProgress } from './rescue.js';
export { renderRescueReceipt, type ReceiptExtras } from './render/rescue-receipt.js';

export { scanClaudeDisk, scanFile, slugToPathGuess, type DiskScan, type ScannedFile, type ProjectDir } from './claude/scan.js';
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

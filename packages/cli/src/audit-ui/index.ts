/**
 * `slopie audit` terminal UI.
 *
 *   view-model.ts     snapshot → display facts (pure, memoised)
 *   layout.ts         display facts → fixed-size pages of styled lines (pure)
 *   renderer.ts       styled lines → ANSI, diffed against the previous frame
 *   terminal.ts       interactive runtime: input, resize, transfers, restore
 *   plain.ts          --plain text and --export SVG
 *   fixture-session.ts  dev hooks: SLOPIE_AUDIT_FIXTURE / SLOPIE_AUDIT_RECORD
 */
import type { AuditSession, AuditSnapshot, AuditScope } from '../../../core/src/analytics/contracts.js';
import { renderPlain, renderShareSvg } from './plain.js';
import { runWallboard, type TerminalResult } from './terminal.js';

export interface AuditTerminalOptions {
  color?: boolean;
  ascii?: boolean;
  width?: number;
  motion?: boolean;
  private?: boolean;
  /** Kept for CLI compatibility; the wallboard has no scope editor. */
  onScopeRequest?: (scope: AuditScope) => void;
}

export type AuditTerminalResult = TerminalResult;

export function runLaunchTerminal(session: AuditSession, options: AuditTerminalOptions = {}): Promise<AuditTerminalResult> {
  return runWallboard(session, options);
}

export function renderLaunchPlain(snapshot: AuditSnapshot, options: AuditTerminalOptions = {}): string {
  return renderPlain(snapshot, { width: options.width, ascii: options.ascii });
}

export function renderAuditShareSvg(snapshot: AuditSnapshot, options: { width?: number; ascii?: boolean } = {}): string {
  return renderShareSvg(snapshot, options);
}

export { applyAuditEvent, applyPrivacyEvent, applyPreviewInvalidation } from './session-state.js';
export { boardData, detailLines, isLoading } from './view-model.js';
export type { BoardData } from './view-model.js';
export { buildBoard, buildDetails, pageText } from './layout.js';
export { cellWidth, clip, sanitize } from './text.js';
export { modelName } from './format.js';
export { decodeKey } from './terminal.js';

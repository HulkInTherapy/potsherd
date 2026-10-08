/**
 * `slopie audit` terminal UI.
 *
 *   story/deck.ts     snapshot → the ordered story deck (pure, memoised; reads only story/source.ts)
 *   cards/*.ts        one renderer per card kind (chrome + its own visual), pure functions of time
 *   loading.ts        the loading story (agents light up, messages flow into Slopie)
 *   mascot.ts         Slopie as pixel data
 *   gfx/*.ts          cell canvas, palette, easing, block font, cell-diff renderer
 *   terminal.ts       interactive runtime: input, resize, transfers, restore
 *   share.ts          share card → SVG
 *   view-model.ts     1.7.x board facts (fallback deck, details)
 *   layout.ts         1.7.x board layout (plain output)
 *   plain.ts          --plain text and --export SVG
 *   fixture-session.ts  dev hooks: SLOPIE_AUDIT_FIXTURE / SLOPIE_AUDIT_RECORD
 */
import type { AuditSession, AuditSnapshot, AuditScope } from '../../../core/src/analytics/contracts.js';
import { renderPlain, renderShareSvg } from './plain.js';
import { runWallboard, type TerminalResult } from './terminal.js';
import { storyShareSvg } from './share.js';
import { storyOf } from './story/source.js';

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
  return (storyOf(snapshot) ? storyShareSvg(snapshot) : null) ?? renderShareSvg(snapshot, options);
}

export { applyAuditEvent, applyPrivacyEvent, applyPreviewInvalidation } from './session-state.js';
export { boardData, detailLines, isLoading } from './view-model.js';
export type { BoardData } from './view-model.js';
export { buildBoard, buildDetails, pageText } from './layout.js';
export { cellWidth, clip, sanitize } from './text.js';
export { modelName } from './format.js';
export { decodeKey } from './terminal.js';
export { buildDeck } from './story/deck.js';
export type { DeckCard } from './story/deck.js';

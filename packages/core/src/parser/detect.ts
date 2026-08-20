import type { Harness } from '../adapters/types.js';
import { readJsonlLines, parseJsonLine } from './jsonl.js';
import { isRecord } from './content.js';

/**
 * Sniff which harness wrote a `.jsonl`.
 *
 * Ported from obra/episodic-memory@1075769 `src/parser.ts`
 * (MIT, (c) 2025 Jesse Vincent) — `detectConversationHarness`. One deviation:
 * upstream returns `'claude'` for anything it cannot identify, which silently
 * feeds a cursor or pi transcript to the claude parser. potsherd returns
 * `null` instead and lets `doctor` report the file as unrecognised.
 *
 * Adapters normally know their own harness from the directory they walked;
 * this is for loose files (an archive copy, a `--file` argument).
 */
export async function detectHarness(filePath: string): Promise<Harness | null> {
  for await (const line of readJsonlLines(filePath)) {
    const parsed = parseJsonLine(line.text);
    if (!isRecord(parsed)) continue;

    if (
      isRecord(parsed.payload) &&
      (parsed.type === 'session_meta' ||
        parsed.type === 'turn_context' ||
        parsed.type === 'response_item' ||
        parsed.type === 'event_msg' ||
        parsed.type === 'compacted')
    ) {
      return 'codex';
    }

    // Claude Code records always carry a `type`; the message-bearing ones also
    // carry `sessionId` and `uuid`.
    if (typeof parsed.type === 'string') {
      if (parsed.type === 'session' && typeof parsed.cwd === 'string' && typeof parsed.id === 'string') {
        return 'pi'; // header record; the pi adapter (T1.3) parses the rest
      }
      if (typeof parsed.sessionId === 'string' || typeof parsed.uuid === 'string') return 'claude';
      return 'claude';
    }

    // Cursor records have no `type` at all — `role` is the discriminator.
    if (typeof parsed.role === 'string') return 'cursor';

    return null;
  }
  return null;
}

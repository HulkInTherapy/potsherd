/**
 * L0 parsers — transcript file in, `Exchange[]` out.
 *
 * Ported from obra/episodic-memory@1075769 `src/parser.ts`
 * (MIT, (c) 2025 Jesse Vincent) and restructured onto potsherd's layer layout.
 * Upstream had one 554-line file dispatching on a sniffed harness; here the
 * sniff (`detect.ts`), the byte-exact line reader (`jsonl.ts`), the
 * content-block helpers (`content.ts`) and the two harness parsers are
 * separate, because T1.2/T1.3 add four more harnesses on top of the same
 * helpers.
 *
 * Parsers know nothing about sqlite, paths or the CLI. They never redact —
 * L2 does that between here and the index — so every `Exchange` leaves here
 * with `redacted: false`.
 */
export { readJsonlLines, parseJsonLine, type JsonlLine, type ReadJsonlOptions } from './jsonl.js';
export {
  extractTextFromContent,
  extractTypedText,
  safeParseJson,
  stringifyToolInput,
  stringifyToolOutput,
  filesFromToolInput,
  isRecord,
  uniq,
} from './content.js';
export { parseClaudeTranscript, exchangeId, type ClaudeParseOptions } from './claude.js';
export { parseCodexTranscript, sessionIdFromPath, type CodexParseOptions } from './codex.js';
export { detectHarness } from './detect.js';

import type { ParseResult } from '../adapters/types.js';
import { detectHarness } from './detect.js';
import { parseClaudeTranscript, type ClaudeParseOptions } from './claude.js';
import { parseCodexTranscript, type CodexParseOptions } from './codex.js';

/**
 * Parse a transcript whose harness is not known in advance. Adapters call the
 * harness-specific parser directly; this is for loose files.
 */
export async function parseTranscript(
  filePath: string,
  options: ClaudeParseOptions & CodexParseOptions = {},
): Promise<ParseResult | null> {
  const harness = await detectHarness(filePath);
  if (harness === 'codex') return parseCodexTranscript(filePath, options);
  if (harness === 'claude') return parseClaudeTranscript(filePath, options);
  return null;
}

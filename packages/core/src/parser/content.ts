/**
 * Content-block helpers.
 *
 * Ported from obra/episodic-memory@1075769 `src/parser.ts`
 * (MIT, (c) 2025 Jesse Vincent) — `extractTextFromContent`, `safeParseJson`
 * and `stringifyToolOutput` are upstream's, near-verbatim; the strict-mode
 * guards and `filesTouched` are potsherd's.
 *
 * Every harness writes an assistant turn as either a plain string or an array
 * of typed blocks. This module is the only place that knows the block shapes.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Join every `text` field in a content array. Upstream filters on the presence
 * of a string `text`, which is deliberately loose: it picks up `text`,
 * `input_text` and `output_text` blocks alike, and that is what codex needs.
 */
export function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is Record<string, unknown> => isRecord(block) && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
}

/** Text blocks only — used for the claude path, where `type` is reliable. */
export function extractTypedText(content: unknown, blockType = 'text'): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is Record<string, unknown> => isRecord(b) && b.type === blockType && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

export function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function stringifyToolOutput(output: unknown): string | undefined {
  if (output === undefined || output === null) return undefined;
  if (typeof output === 'string') return output;
  const text = extractTextFromContent(output);
  if (text.trim()) return text;
  try {
    return JSON.stringify(output);
  } catch {
    return undefined;
  }
}

/**
 * `Exchange.toolCalls[].input` is a string in `03` §2 (it goes straight into a
 * TEXT column and through the redactor), so structured inputs are stringified
 * here once rather than at every call site.
 */
export function stringifyToolInput(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

/**
 * The tool-input keys that name a file. `03` §2 asks for `filesTouched`
 * "parsed from Edit/Write/Read tool inputs"; matching on the key rather than
 * the tool name survives new tools and harness-specific tool naming.
 */
const FILE_KEYS = ['file_path', 'filePath', 'notebook_path', 'notebookPath', 'path'] as const;

/** Absolute-ish paths named by a tool input, in first-seen order. */
export function filesFromToolInput(input: unknown): string[] {
  if (!isRecord(input)) return [];
  const out: string[] = [];
  for (const key of FILE_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) out.push(value);
  }
  // MultiEdit and friends nest one level: { edits: [{ file_path }] }.
  for (const value of Object.values(input)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      for (const f of filesFromToolInput(item)) out.push(f);
    }
  }
  return out;
}

/** Dedup preserving order — `filesTouched` is a set, but a stable one. */
export function uniq(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

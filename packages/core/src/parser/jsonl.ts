import fs from 'node:fs';

/**
 * Byte-exact JSONL line reader.
 *
 * Ported in spirit from obra/episodic-memory@1075769 `src/parser.ts`
 * (MIT, (c) 2025 Jesse Vincent), which streams transcripts through
 * `readline`. potsherd cannot use `readline`: `03` §3 indexes incrementally by
 * `(source_mtime, source_offset)`, and readline hands back decoded strings
 * with no byte position, so resuming a growing transcript is impossible.
 *
 * This reader splits on `\n` over raw buffers, so every line carries the exact
 * byte range it occupied. A transcript that is being appended to right now
 * ends in a half-written line; that line is yielded with `terminated: false`
 * and callers must not consume it — the next run will see it whole.
 */

export interface JsonlLine {
  /** Decoded text, with a trailing `\r` stripped. */
  text: string;
  /** 1-based, counting from the start of the file when `start` is 0. */
  lineNumber: number;
  /** Byte offset of the first byte of the line. */
  start: number;
  /** Byte offset just past the line's terminating newline. */
  end: number;
  /** False for a final line with no newline: the file is still being written. */
  terminated: boolean;
}

const LF = 0x0a;

export interface ReadJsonlOptions {
  /** Byte offset to resume from. Must sit on a line boundary. */
  start?: number;
  /** Line number of the line before `start`, so numbering stays continuous. */
  startLine?: number;
}

export async function* readJsonlLines(
  filePath: string,
  options: ReadJsonlOptions = {},
): AsyncGenerator<JsonlLine> {
  const start = options.start ?? 0;
  let offset = start;
  let lineNumber = options.startLine ?? 0;
  let held: Buffer = Buffer.alloc(0);

  const stream = fs.createReadStream(filePath, { start });
  for await (const chunk of stream) {
    held = held.length === 0 ? (chunk as Buffer) : Buffer.concat([held, chunk as Buffer]);
    let idx = held.indexOf(LF);
    while (idx !== -1) {
      const raw = held.subarray(0, idx);
      const end = offset + idx + 1;
      lineNumber += 1;
      yield { text: decode(raw), lineNumber, start: offset, end, terminated: true };
      offset = end;
      held = held.subarray(idx + 1);
      idx = held.indexOf(LF);
    }
  }

  if (held.length > 0) {
    lineNumber += 1;
    yield {
      text: decode(held),
      lineNumber,
      start: offset,
      end: offset + held.length,
      terminated: false,
    };
  }
}

function decode(raw: Buffer): string {
  const text = raw.toString('utf8');
  return text.endsWith('\r') ? text.slice(0, -1) : text;
}

/** `JSON.parse` that returns `undefined` instead of throwing. */
export function parseJsonLine(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

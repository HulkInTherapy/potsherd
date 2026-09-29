import fs from 'node:fs';
import readline from 'node:readline';
import { claudePaths } from '../paths.js';

/**
 * `~/.claude/history.jsonl` is the only artefact that survives the 30-day
 * sweep for every session ever run. One line per prompt:
 *
 *   {"display":"<prompt text>","pastedContents":{},"timestamp":<ms>,
 *    "project":"/abs/cwd","sessionId":"<uuid>"}
 *
 * It is the ghost source. It is read as a stream and never JSON.parsed whole:
 * a heavy user's file runs to tens of megabytes, and `audit` has a two-second
 * budget it must not spend here.
 */

export interface HistoryPrompt {
  ts: number;
  text: string;
}

export interface HistorySession {
  sessionId: string;
  project: string;
  firstTs: number;
  lastTs: number;
  promptCount: number;
  firstPrompt: string;
  /** Populated only when `withPrompts` is set (rescue needs it, audit does not). */
  prompts: HistoryPrompt[];
}

export interface HistoryScan {
  path: string;
  exists: boolean;
  /**
   * Whether this scan was asked for `prompts`, and so whether a caller may
   * draw a conclusion from them.
   *
   * It exists because the alternative is a silent zero. `audit` counts the
   * deleted sessions whose prompts never named them; a scan taken without
   * `withPrompts` has an empty `prompts` array on every session, and that
   * count would come out `0` — a number, on the product's first screen,
   * meaning "nobody asked". Reported as `null` instead. See
   * `computeAudit`'s `deletedWithoutSubstantivePrompt`.
   */
  withPrompts: boolean;
  lines: number;
  malformed: number;
  /** Lines with no `sessionId` — older Claude Code versions wrote these. */
  orphanPrompts: number;
  sessions: Map<string, HistorySession>;
  firstTs: number | null;
  lastTs: number | null;
  bytes: number;
  scanMs: number;
}

export async function readHistory(
  dir?: string,
  opts: { withPrompts?: boolean; maxPromptChars?: number } = {},
): Promise<HistoryScan> {
  const started = Date.now();
  const p = claudePaths(dir).history;
  const scan: HistoryScan = {
    path: p,
    exists: fs.existsSync(p),
    withPrompts: Boolean(opts.withPrompts),
    lines: 0,
    malformed: 0,
    orphanPrompts: 0,
    sessions: new Map(),
    firstTs: null,
    lastTs: null,
    bytes: 0,
    scanMs: 0,
  };
  if (!scan.exists) {
    scan.scanMs = Date.now() - started;
    return scan;
  }
  scan.bytes = fs.statSync(p).size;
  const maxChars = opts.maxPromptChars ?? 8000;

  const rl = readline.createInterface({
    input: fs.createReadStream(p, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    scan.lines++;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(s) as Record<string, unknown>;
    } catch {
      scan.malformed++;
      continue;
    }
    const sessionId = typeof r['sessionId'] === 'string' ? (r['sessionId'] as string) : '';
    const ts = typeof r['timestamp'] === 'number' ? (r['timestamp'] as number) : 0;
    const text = typeof r['display'] === 'string' ? (r['display'] as string) : '';
    const project = typeof r['project'] === 'string' ? (r['project'] as string) : '';

    if (ts) {
      if (scan.firstTs === null || ts < scan.firstTs) scan.firstTs = ts;
      if (scan.lastTs === null || ts > scan.lastTs) scan.lastTs = ts;
    }
    if (!sessionId) {
      scan.orphanPrompts++;
      continue;
    }

    let sess = scan.sessions.get(sessionId);
    if (!sess) {
      sess = {
        sessionId,
        project,
        firstTs: ts || Number.MAX_SAFE_INTEGER,
        lastTs: ts,
        promptCount: 0,
        firstPrompt: '',
        prompts: [],
      };
      scan.sessions.set(sessionId, sess);
    }
    sess.promptCount++;
    if (project && !sess.project) sess.project = project;
    if (ts) {
      if (ts < sess.firstTs) sess.firstTs = ts;
      if (ts > sess.lastTs) sess.lastTs = ts;
    }
    if (!sess.firstPrompt && text) sess.firstPrompt = text.slice(0, maxChars);
    if (opts.withPrompts && text) {
      sess.prompts.push({ ts, text: text.length > maxChars ? text.slice(0, maxChars) : text });
    }
  }

  for (const sess of scan.sessions.values()) {
    if (sess.firstTs === Number.MAX_SAFE_INTEGER) sess.firstTs = sess.lastTs;
    if (opts.withPrompts) sess.prompts.sort((a, b) => a.ts - b.ts);
  }

  scan.scanMs = Date.now() - started;
  return scan;
}

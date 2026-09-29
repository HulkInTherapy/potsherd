import fs from 'node:fs';

/**
 * UNUSED UNTIL PHASE 2. Nothing imports this yet; it is here because the port
 * was cheap and the retry semantics are hard-won upstream bug fixes (#91, #96)
 * that phase 2's card writer would otherwise rediscover.
 *
 * Ported near-verbatim from obra/episodic-memory@1075769
 * `src/summary-sentinel.ts` (MIT, (c) 2025 Jesse Vincent). The only changes
 * are the environment variable name (`POTSHERD_*`) and the doc comment naming
 * potsherd's card path instead of upstream's summary path.
 *
 * Sentinel file format for `~/.potsherd/cards/<harness>/<session>.md`:
 *
 * - File missing → the session has no card; queue it.
 * - File empty → permanent skip (a zero-exchange / metadata-only transcript).
 * - File starts with `__ERRORED__\n` → the last attempt failed. Skip-then-
 *   retry: re-queue once the file's mtime is older than the retry threshold,
 *   otherwise leave it alone.
 * - Anything else → a real card.
 *
 * The error marker is the fix that matters: without it a failed run writes no
 * sentinel at all, so the session re-queues on every pass forever and can pin
 * the head of the queue.
 */

export const ERROR_MARKER = '__ERRORED__';
const ERROR_MARKER_PREFIX = `${ERROR_MARKER}\n`;
const DEFAULT_RETRY_MS = 3_600_000; // 1 hour

export function formatErrorSentinel(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${ERROR_MARKER}\n${new Date().toISOString()}\n${message}\n`;
}

export function isErroredSentinel(content: string): boolean {
  return content.startsWith(ERROR_MARKER_PREFIX);
}

function getErrorRetryMs(): number {
  const raw = process.env.POTSHERD_CARD_ERROR_RETRY_HOURS;
  if (!raw) return DEFAULT_RETRY_MS;
  const hours = Number.parseFloat(raw);
  return Number.isFinite(hours) && hours > 0 ? hours * 3_600_000 : DEFAULT_RETRY_MS;
}

/**
 * True when the sentinel at `cardPath` is a real card — non-empty and not an
 * error marker. Empty and errored sentinels both return false.
 */
export function hasRealCard(cardPath: string): boolean {
  let content: string;
  try {
    content = fs.readFileSync(cardPath, 'utf-8');
  } catch {
    return false;
  }
  if (content.length === 0) return false;
  return !isErroredSentinel(content);
}

/** True when the session should be (re-)carded: no sentinel, or a stale error. */
export function shouldQueueForCard(cardPath: string): boolean {
  let content: string;
  try {
    content = fs.readFileSync(cardPath, 'utf-8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
  if (!isErroredSentinel(content)) return false;
  try {
    return Date.now() - fs.statSync(cardPath).mtimeMs >= getErrorRetryMs();
  } catch {
    return false;
  }
}

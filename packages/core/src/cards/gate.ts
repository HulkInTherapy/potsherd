/**
 * One global limit on how many model calls are in flight at once.
 *
 * `03` §12's arithmetic is `wall = calls × per-call ÷ concurrency`, and that
 * only holds if *calls* are what run in parallel. Limiting **sessions** to six
 * is not the same thing and on the reference corpus it is much worse: the
 * largest session there is 1.2M characters, which is 30 chunks and 31 calls,
 * and those calls are strictly serial inside one session. That one session
 * then sets the floor for the whole run no matter how many workers are idle
 * beside it.
 *
 * The map calls of a map-reduce are independent by construction — each reads
 * one chunk and writes one partial card — so they can run together. What must
 * not happen is thirty of them plus five other sessions all spawning a harness
 * at once. Hence a semaphore rather than a per-session limit: the session pool
 * and the chunk fan-out both draw from the same pool of `n` permits, so
 * `--concurrency 6` means "six model calls", which is the number the estimate
 * was divided by and the number the machine actually has to survive.
 */

export interface Gate {
  /** Run `fn` once a permit is free, and release it however `fn` ends. */
  <T>(fn: () => Promise<T>): Promise<T>;
}

export function makeGate(limit: number): Gate {
  const n = Math.max(1, Math.floor(limit));
  let inFlight = 0;
  const waiting: (() => void)[] = [];

  const release = (): void => {
    inFlight -= 1;
    const next = waiting.shift();
    if (next) next();
  };

  return async function gate<T>(fn: () => Promise<T>): Promise<T> {
    if (inFlight >= n) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    inFlight += 1;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

/** A gate that limits nothing, for a caller that runs one thing at a time. */
export const openGate: Gate = <T>(fn: () => Promise<T>): Promise<T> => fn();

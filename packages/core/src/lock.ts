import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { potsherdDir } from './paths.js';

/**
 * A single-writer lock over `~/.potsherd`. The SessionStart hook and a hand-run
 * `potsherd rescue` can fire at the same moment; without this they would both
 * copy the same files and both write a rescue_log row.
 *
 * Directory-create is the primitive because it is atomic on every filesystem we
 * care about. A lock whose owning pid is gone is stale and gets taken over.
 */

const STALE_MS = 5 * 60_000;

export interface LockHandle {
  path: string;
  release(): void;
}

export class LockBusyError extends Error {
  constructor(public readonly holder: LockInfo | null, lockPath: string) {
    super(
      holder
        ? `another potsherd is running (pid ${holder.pid}, ${holder.op}, since ${holder.at}). ` +
          `if that is wrong, remove ${lockPath}`
        : `another potsherd is running. if that is wrong, remove ${lockPath}`,
    );
    this.name = 'LockBusyError';
  }
}

interface LockInfo {
  pid: number;
  op: string;
  at: string;
  host: string;
}

export function acquire(op: string, opts: { root?: string; wait?: number } = {}): LockHandle {
  const root = opts.root ?? potsherdDir();
  const lockPath = path.join(root, '.lock');
  const deadline = Date.now() + (opts.wait ?? 0);

  fs.mkdirSync(root, { recursive: true, mode: 0o700 });

  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      const info: LockInfo = {
        pid: process.pid,
        op,
        at: new Date().toISOString(),
        host: process.env.HOSTNAME ?? '',
      };
      fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify(info), { mode: 0o600 });
      let released = false;
      return {
        path: lockPath,
        release() {
          if (released) return;
          released = true;
          try {
            fs.rmSync(lockPath, { recursive: true, force: true });
          } catch { /* the process is exiting anyway */ }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = readOwner(lockPath);
      if (isStale(lockPath, holder)) {
        try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* raced */ }
        continue;
      }
      if (Date.now() >= deadline) throw new LockBusyError(holder, lockPath);
      sleepSync(100);
    }
  }
}

/** Run `fn` under the lock, always releasing it. */
export function withLock<T>(op: string, fn: () => T, opts: { root?: string; wait?: number } = {}): T {
  const lock = acquire(op, opts);
  try {
    return fn();
  } finally {
    lock.release();
  }
}

export async function withLockAsync<T>(
  op: string,
  fn: () => Promise<T>,
  opts: { root?: string; wait?: number } = {},
): Promise<T> {
  const lock = acquire(op, opts);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

function readOwner(lockPath: string): LockInfo | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')) as LockInfo;
  } catch {
    return null;
  }
}

function isStale(lockPath: string, holder: LockInfo | null): boolean {
  if (holder && holder.pid && (!holder.host || holder.host === (process.env.HOSTNAME ?? ''))) {
    if (!pidAlive(holder.pid)) return true;
  }
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs > STALE_MS;
  } catch {
    return true;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

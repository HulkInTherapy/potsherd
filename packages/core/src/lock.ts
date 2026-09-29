import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { potsherdDir } from './paths.js';

/**
 * A single-writer lock over `~/.potsherd`. The SessionStart hook and a hand-run
 * `potsherd rescue` can fire at the same moment; without this they would both
 * copy the same files and both write a rescue_log row.
 *
 * Directory-create is the primitive because it is atomic on every filesystem we
 * care about. A lock whose owning pid is gone is stale and gets taken over.
 */

/**
 * How long a lock whose owner cannot be identified is honoured.
 *
 * It is a **last resort**, not the rule. A lock with a readable owner is
 * decided by whether that owner is still running (see {@link isStale}); this
 * number only decides the case where owner metadata is unreadable. A named
 * foreign host cannot be probed locally and is conservatively protected.
 *
 * It used to decide every case, and that is FIX-B D3: a full embedding pass
 * runs for hours, so from minute five onward every `potsherd index` removed the
 * running embedder's lock and started another one beside it. The lock was a
 * suggestion with a five-minute expiry, while the code's comment called it a
 * guarantee.
 */
const STALE_MS = 5 * 60_000;

/**
 * How often a holder stamps its own lock.
 *
 * On a timer that is `unref`'d, so it can never keep a process alive one tick
 * longer than its work — the background embedder is detached and unwatched, and
 * a lock that outlived its owner would be the bug this is fixing.
 */
const HEARTBEAT_MS = 20_000;

/**
 * Lanes: one lock file per kind of work, rather than one file for the process.
 *
 * `index`, `rescue` and everything else share `.lock`, because they are the
 * single-writer set the lock was written for — two of them copying the same
 * files is the race it exists to stop. The embedding pass is not in that set.
 * It runs for hours, it touches no source file, and it writes one small row at
 * a time under WAL with `busy_timeout = 5000`; putting it in the same lane as
 * `index` meant either blocking `index` for the whole warming window or
 * expiring the lock, and the code chose to expire it.
 *
 * So the embedder has its own file. Two embedders still exclude each other —
 * which is the guarantee that was claimed and is now kept — and no foreground
 * verb ever waits on one.
 */
export type Lane = 'default' | 'embed';

function lockPathFor(root: string, lane: Lane | undefined): string {
  return path.join(root, lane === 'embed' ? '.lock.embed' : '.lock');
}

export interface LockHandle {
  path: string;
  release(): void;
  /**
   * Say that this holder is still working.
   *
   * Called on a timer for the whole life of the lock, and exposed so a caller
   * in a long **synchronous** stretch — where no timer can fire — can say so
   * itself. A missed heartbeat never expires an identified live process.
   */
  touch(): void;
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

export interface LockInfo {
  pid: number;
  op: string;
  at: string;
  host: string;
  /** Local process birth identity, when the OS exposes one. */
  processStart?: string;
  /** Unique lease identity. Legacy owner.json records have neither field. */
  token?: string;
}

export function acquire(
  op: string,
  opts: { root?: string; wait?: number; lane?: Lane } = {},
): LockHandle {
  const root = opts.root ?? potsherdDir();
  const lockPath = lockPathFor(root, opts.lane);
  const deadline = Date.now() + (opts.wait ?? 0);

  fs.mkdirSync(root, { recursive: true, mode: 0o700 });

  // Publish metadata with the directory, avoiding a mkdir/owner-write gap.
  // Every owner record has a unique filename. No operation recursively deletes
  // the shared path: unlinking A's record cannot affect B, and rmdir cannot
  // remove B's already-populated directory even if publication interleaves.
  const token = randomUUID();
  const ownerFile = `owner.${token}.json`;
  const claim = `${lockPath}.claim-${token}`;
  const start = processStart(process.pid);
  const info: LockInfo = {
    pid: process.pid,
    op,
    at: new Date().toISOString(),
    host: os.hostname(),
    token,
    ...(start ? { processStart: start } : {}),
  };
  fs.mkdirSync(claim, { mode: 0o700 });
  try {
    fs.writeFileSync(path.join(claim, ownerFile), JSON.stringify(info), { mode: 0o600 });
    for (;;) {
      let observed = fs.existsSync(lockPath) ? readOwner(lockPath) : null;
      if (fs.existsSync(lockPath)) {
        if (isStale(lockPath, observed?.info ?? null)) {
          retire(lockPath, observed?.file);
          // Unknown extra files cannot be safely removed; fail closed.
          if (!fs.existsSync(lockPath)) continue;
          observed = readOwner(lockPath);
        }
        if (Date.now() >= deadline) throw new LockBusyError(observed?.info ?? null, lockPath);
        sleepSync(100);
        continue;
      }
      try {
        fs.renameSync(claim, lockPath);
        break;
      } catch (err) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
        // A concurrent fully-published owner won; inspect it on the next pass.
      }
    }
  } finally {
    // This private staging path is never the published lease.
    fs.rmSync(claim, { recursive: true, force: true });
  }

  let directory: number;
  try {
    directory = fs.openSync(lockPath, 'r');
  } catch (err) {
    retire(lockPath, ownerFile);
    throw err;
  }
  let released = false;
  const touch = () => {
    if (released) return;
    try {
      const now = new Date();
      // The descriptor names this owner's inode, even after path replacement.
      fs.futimesSync(directory, now, now);
    } catch { /* no authority over a replacement path */ }
  };
  const beat = setInterval(touch, HEARTBEAT_MS);
  beat.unref?.();
  return {
    path: lockPath,
    touch,
    release() {
      if (released) return;
      released = true;
      clearInterval(beat);
      try { fs.closeSync(directory); } catch { /* already closed */ }
      retire(lockPath, ownerFile);
    },
  };
}

/** Run `fn` under the lock, always releasing it. */
export function withLock<T>(
  op: string,
  fn: () => T,
  opts: { root?: string; wait?: number; lane?: Lane } = {},
): T {
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
  opts: { root?: string; wait?: number; lane?: Lane } = {},
): Promise<T> {
  const lock = acquire(op, opts);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

/** Read only immutable owner records; never infer an owner from a pid alone. */
function readOwner(lockPath: string): { info: LockInfo | null; file: string } | null {
  try {
    const files = fs.readdirSync(lockPath);
    const file = files.find((name) => /^owner\.[0-9a-f-]+\.json$/.test(name))
      ?? (files.includes('owner.json') ? 'owner.json' : undefined);
    if (!file) return null;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(lockPath, file), 'utf8')) as LockInfo;
      if (!Number.isInteger(info.pid) || info.pid <= 0 || typeof info.host !== 'string') return { info: null, file };
      return { info, file };
    } catch {
      return { info: null, file };
    }
  } catch {
    return null;
  }
}

/** Remove only the observed record, then only an empty directory. */
function retire(lockPath: string, file?: string): void {
  try {
    if (file) fs.unlinkSync(path.join(lockPath, file));
    fs.rmdirSync(lockPath);
  } catch { /* replaced, already retired, or unknown nonempty metadata */ }
}

/**
 * Dead local processes and proven PID reuse can be recovered immediately.
 * Without process birth evidence a live local pid is conservatively honoured,
 * including legacy leases. Heartbeat age cannot distinguish a paused/busy
 * event loop from a recycled pid. Foreign owners cannot be checked locally
 * and are protected until explicitly removed. Unidentified leases retain the
 * historical grace period; unknown extra files fail closed.
 */
function isStale(lockPath: string, holder: LockInfo | null): boolean {
  if (holder && (!holder.host || holder.host === os.hostname() || holder.host === (process.env.HOSTNAME ?? ''))) {
    if (!pidAlive(holder.pid)) return true;
    const currentStart = holder.processStart ? processStart(holder.pid) : null;
    return Boolean(currentStart && currentStart !== holder.processStart);
  }
  return !holder && ageMs(lockPath) > STALE_MS;
}

/** Linux exposes kernel start ticks; macOS/BSD expose a process birth date. */
function processStart(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return fields[19] ? `linux:${fields[19]}` : null;
    }
    if (process.platform === 'darwin' || process.platform === 'freebsd') {
      const start = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000,
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      }).trim();
      return start ? `${process.platform}:${start}` : null;
    }
  } catch { /* birth identity unavailable: keep a live owner, never guess */ }
  return null;
}

/** How long since this lock was last stamped. `Infinity` when it is not there. */
function ageMs(lockPath: string): number {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Who holds this lane right now, or `null` when nobody does.
 *
 * The question `index` has to be able to ask before it spawns an embedder, and
 * could not: `startBackgroundEmbedding` spawned unconditionally, so N runs of
 * `potsherd index` during one warming window left N detached embedders. It is
 * deliberately a *read* — it never creates, removes or waits on anything — so
 * asking it can neither block a verb nor become a way to lose a lock.
 *
 * A stale lock answers `null`, by the same rule {@link acquire} takes over on.
 */
export function holder(opts: { root?: string; lane?: Lane } = {}): LockInfo | null {
  const lockPath = lockPathFor(opts.root ?? potsherdDir(), opts.lane);
  try {
    if (!fs.existsSync(lockPath)) return null;
  } catch {
    return null;
  }
  const info = readOwner(lockPath)?.info ?? null;
  return isStale(lockPath, info) ? null : info;
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

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

/**
 * How long a lock whose owner cannot be identified is honoured.
 *
 * It is a **last resort**, not the rule. A lock with a readable owner is
 * decided by whether that owner is still running (see {@link isStale}); this
 * number only decides the case where `owner.json` is unreadable or was written
 * on another host, where there is nothing else to go on.
 *
 * It used to decide every case, and that is FIX-B D3: a full embedding pass
 * runs for hours, so from minute five onward every `potsherd index` removed the
 * running embedder's lock and started another one beside it. The lock was a
 * suggestion with a five-minute expiry, while the code's comment called it a
 * guarantee.
 */
const STALE_MS = 5 * 60_000;

/**
 * How long a lock whose owner **is alive** is honoured without a heartbeat.
 *
 * VERIFICATION-5 C-4. `isStale` used to answer `!pidAlive(holder.pid)` and stop
 * there — *"a live owner is never stale"* — which made a live pid not merely
 * necessary but sufficient. Two things follow, and both were measured:
 *
 *   1. `kill -9` leaves `.lock.embed` behind and nothing in the product removes
 *      it. There is no `unlock` verb; all 22 were checked.
 *   2. **A recycled pid poisons the lane for ever.** Once the operating system
 *      hands that pid number to any unrelated process, `pidAlive` is true,
 *      `isStale` is false, `index` refuses to spawn a replacement, and every
 *      surface says *warming* with nothing embedding — which is FIX-F's C2 lie
 *      coming back in through a door C2 did not close.
 *
 * So a live pid is necessary and not sufficient: an owner that is alive **and**
 * has not touched its lock inside this window is stale. That is what the mtime
 * test was always for, and the reason it could not be used before is that
 * nothing refreshed the lock — a five-minute expiry on a pass that runs for
 * hours is FIX-B's D3, where every `index` past minute five removed a working
 * embedder's lock and started another beside it.
 *
 * The half that makes the timeout safe is therefore {@link HEARTBEAT_MS}: the
 * holder stamps its own lock while it works, so a *working* owner is never more
 * than one beat old and thirty consecutive misses is the threshold here. A
 * timeout on a lock nobody refreshes would only move the failure.
 */
const LIVE_STALE_MS = 10 * 60_000;

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
   * itself. See {@link LIVE_STALE_MS} for why anybody has to.
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
}

export function acquire(
  op: string,
  opts: { root?: string; wait?: number; lane?: Lane } = {},
): LockHandle {
  const root = opts.root ?? potsherdDir();
  const lockPath = lockPathFor(root, opts.lane);
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
      const touch = () => {
        if (released) return;
        try {
          const now = new Date();
          fs.utimesSync(lockPath, now, now);
        } catch {
          /* the lock was removed under us; `release` is about to find that out */
        }
      };
      const beat = setInterval(touch, HEARTBEAT_MS);
      // Never hold the event loop open for a heartbeat. The embedding worker is
      // detached and nothing waits on it, so a timer that kept it alive would
      // outlive the pass and hold the lane it is meant to be reporting on.
      beat.unref?.();
      return {
        path: lockPath,
        touch,
        release() {
          if (released) return;
          released = true;
          clearInterval(beat);
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

function readOwner(lockPath: string): LockInfo | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')) as LockInfo;
  } catch {
    return null;
  }
}

/**
 * Whether this lock may be taken over.
 *
 * **A live owner is never stale.** That is the whole of the change, and the
 * reason is arithmetic: the embedding pass measured on the reference archive
 * takes hours, {@link STALE_MS} is five minutes, and the old body fell through
 * to the mtime test even after confirming the owner was alive. So every run
 * past minute five removed a working process's lock and started another one
 * beside it — the pile-up D3 measured, with the previous embedders still
 * running and still burning CPU.
 *
 * **And a live owner is not thereby a working one** (VERIFICATION-5 C-4). A pid
 * the operating system has since handed to something else is alive and is not
 * this lock's owner, and `kill -9` leaves a lock behind that nothing in the
 * product removes — so the answer used to be *warming, for ever*. A live owner
 * is honoured for {@link LIVE_STALE_MS} **since it last stamped its lock**,
 * which is thirty heartbeats, and a holder that is working stamps it every
 * {@link HEARTBEAT_MS}. D3's guarantee is untouched by that: a pass that runs
 * for hours is refreshing the whole time, so its lock never ages at all.
 *
 * The plain mtime test survives for the one case it is the only answer to: a
 * lock whose `owner.json` is unreadable, or which was written on another host
 * and whose pid means nothing here.
 */
function isStale(lockPath: string, holder: LockInfo | null): boolean {
  if (holder && holder.pid && (!holder.host || holder.host === (process.env.HOSTNAME ?? ''))) {
    if (!pidAlive(holder.pid)) return true;
    return ageMs(lockPath) > LIVE_STALE_MS;
  }
  return ageMs(lockPath) > STALE_MS;
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
  const info = readOwner(lockPath);
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

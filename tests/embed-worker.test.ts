import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lock } from '@potsherd/core';
import { rmrf, tempDir } from './helpers.js';

/**
 * One background embedder, ever — phase-10 FIX-B D3.
 *
 * The verifier watched `potsherd index` go from two live detached embedders to
 * three, each accumulating CPU (33:28, 24:46 and 1:01 over a 25-second window,
 * ~315% between them), while this file's own comment claimed the worker "holds
 * the lock so two of them never race". Two things made that comment false and
 * both are pinned here:
 *
 *   1. **A live owner was declared stale after five minutes.** `isStale` fell
 *      through to the lock directory's mtime even when the owning pid was
 *      alive on this host, so the newest process simply removed the running
 *      one's lock and took over. A full embedding pass is hours; five minutes
 *      is not a timeout, it is a guarantee that every pass past minute five is
 *      unprotected.
 *   2. **The embed pass held the one `.lock` for its whole run.** Which is why
 *      the mtime escape hatch could not simply be deleted: with it gone, an
 *      honest lock would have blocked `potsherd index` for the entire warming
 *      window. So the embed pass has its own lane, and `index` is never behind
 *      it.
 *
 * With those two, `index` can ask whether an embedder is already running
 * before it spawns one — which is the third test here, and the one the defect
 * is actually about.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmrf(r);
});

function root(): string {
  const r = tempDir('potsherd-lock-');
  roots.push(r);
  return r;
}

/** Backdate a lock directory past `STALE_MS`, the way an hours-long pass does. */
function age(dir: string, minutes: number): void {
  const when = new Date(Date.now() - minutes * 60_000);
  fs.utimesSync(dir, when, when);
}

describe('the embed lock is a guarantee, not a five-minute suggestion', () => {
  it('never takes over from an owner whose pid is alive, however old the lock', () => {
    const r = root();
    const held = lock.acquire('embed', { root: r, lane: 'embed' });
    try {
      // This process is the owner and this process is alive. Six minutes is
      // past `STALE_MS`; an hours-long embedding pass is far past it.
      age(held.path, 6);
      expect(() => lock.acquire('embed', { root: r, lane: 'embed' })).toThrow(/another potsherd/);
      expect(lock.holder({ root: r, lane: 'embed' })?.pid).toBe(process.pid);
    } finally {
      held.release();
    }
  });

  it('still takes over from an owner that is gone', () => {
    const r = root();
    const lockPath = path.join(r, '.lock.embed');
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(
      path.join(lockPath, 'owner.json'),
      JSON.stringify({ pid: 0x7ffffffe, op: 'embed', at: new Date().toISOString(), host: process.env.HOSTNAME ?? '' }),
    );
    age(lockPath, 6);
    // A dead pid is a dead lock, and the next run is entitled to it.
    const taken = lock.acquire('embed', { root: r, lane: 'embed' });
    taken.release();
    expect(lock.holder({ root: r, lane: 'embed' })).toBeNull();
  });

  it('does not put the embedder in front of index, rescue or anything else', () => {
    const r = root();
    const embedding = lock.acquire('embed', { root: r, lane: 'embed' });
    try {
      age(embedding.path, 90);
      // The whole reason the mtime escape hatch existed. `index` must not wait
      // on a pass that runs for hours, and now it does not have to: different
      // lane, different file.
      const indexing = lock.acquire('index', { root: r });
      expect(indexing.path).not.toBe(embedding.path);
      indexing.release();
    } finally {
      embedding.release();
    }
  });
});

describe('index does not spawn an embedder on top of a running one', () => {
  it('reports the live embedder so the spawn is skipped', () => {
    const r = root();
    expect(lock.holder({ root: r, lane: 'embed' })).toBeNull();
    const held = lock.acquire('embed', { root: r, lane: 'embed' });
    try {
      age(held.path, 45);
      const who = lock.holder({ root: r, lane: 'embed' });
      expect(who).not.toBeNull();
      expect(who?.op).toBe('embed');
      expect(who?.pid).toBe(process.pid);
    } finally {
      held.release();
    }
    // Released is released: the next `index` is the one that starts the work.
    expect(lock.holder({ root: r, lane: 'embed' })).toBeNull();
  });
});

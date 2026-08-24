import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lock } from '@potsherd/core';
import { vectorNote, vectorReport } from '../packages/core/src/doctor-line.js';
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
 *
 * ## and then the guarantee went too far — VERIFICATION-5 C-4
 *
 * `isStale` answered `!pidAlive(holder.pid)` and stopped: *"a live owner is
 * never stale."* A live pid became sufficient rather than merely necessary, and
 * two states follow from that which nothing in the product could leave:
 * `kill -9` leaves the lock behind (there is no verb that clears it), and the
 * moment the operating system recycles that pid number to any unrelated
 * process, `index` refuses to spawn a replacement and every surface says
 * *warming* with nothing embedding — **for ever**. That is FIX-F's C2 lie
 * coming back through a door C2 did not close.
 *
 * The answer is not to delete the mtime test again; it is to give it something
 * true to read. A holder now stamps its own lock while it works, so the tests
 * below say `touch()` where a real pass has a heartbeat, and D3's guarantee is
 * restated exactly as it was: **a pass that is still working is never taken
 * over, however long it runs.** What is no longer true, and must not be, is
 * that a lock nobody has touched for ten minutes is honoured because some
 * process somewhere happens to hold its number.
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
  it('never takes over from an owner that is alive and still working, however long the pass runs', () => {
    const r = root();
    const held = lock.acquire('embed', { root: r, lane: 'embed' });
    try {
      // Ninety minutes into a pass — far past `STALE_MS`, and the shape D3
      // measured. The holder is alive and has just said so, which is what the
      // heartbeat does every twenty seconds for the whole run.
      age(held.path, 90);
      held.touch();
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
      embedding.touch();
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
      held.touch();
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

describe('a lock nobody is refreshing does not outlive its owner — C-4', () => {
  it('a live pid is necessary and not sufficient: an unstamped lock ages out', () => {
    const r = root();
    const held = lock.acquire('embed', { root: r, lane: 'embed' });
    try {
      // The poisoned lock, exactly: `owner.json` names a pid that is alive —
      // this process's own, the strongest possible version of the case — and
      // nothing has stamped the lock for eleven minutes. Before C-4 this was
      // honoured for the life of the machine.
      age(held.path, 11);
      expect(lock.holder({ root: r, lane: 'embed' })).toBeNull();
      const taken = lock.acquire('embed', { root: r, lane: 'embed' });
      expect(taken.path).toBe(held.path);
      taken.release();
    } finally {
      held.release();
    }
  });

  it('a recycled pid is a stale lock, not a working embedder', () => {
    const r = root();
    const lockPath = path.join(r, '.lock.embed');
    fs.mkdirSync(lockPath, { recursive: true });
    // The verifier's measurement, without needing the operating system to
    // actually recycle a number: a lock whose recorded pid is alive and is not
    // the process that wrote it. `nohup sleep 400 &` in their run; this process
    // here, which is alive by construction and has never held this lane.
    fs.writeFileSync(
      path.join(lockPath, 'owner.json'),
      JSON.stringify({ pid: process.pid, op: 'embed', at: '2026-08-24T18:41:23.642Z', host: process.env.HOSTNAME ?? '' }),
    );
    age(lockPath, 30);
    expect(lock.holder({ root: r, lane: 'embed' })).toBeNull();
    const taken = lock.acquire('embed', { root: r, lane: 'embed' });
    taken.release();
  });

  it('the heartbeat is the holder\'s own, and stops when it releases', () => {
    const r = root();
    const held = lock.acquire('embed', { root: r, lane: 'embed' });
    const before = fs.statSync(held.path).mtimeMs;
    age(held.path, 3);
    expect(fs.statSync(held.path).mtimeMs).toBeLessThan(before);
    held.touch();
    expect(fs.statSync(held.path).mtimeMs).toBeGreaterThanOrEqual(before - 1000);
    held.release();
    // A touch after release must not re-create the directory the release just
    // removed — that would be a lock with no owner at all, which is the state
    // this whole file exists to make impossible.
    held.touch();
    expect(fs.existsSync(held.path)).toBe(false);
  });
});

/**
 * `doctor` could not tell "nobody is embedding" from "a fetch is in flight" —
 * VERIFICATION-5 C-6.
 *
 * Both printed `0 of N · 46.1 MB runtime not fetched yet`, because the
 * `pending` branch read `working` only when the runtime was already on disk —
 * so on the first run of a fresh install, which is the exact moment a user runs
 * `doctor` to ask *is anything happening*, it never read it at all. `find` and
 * `potsherd_recall` already separated the two states; FIX-F C2's claim that one
 * flag drives all four surfaces was true of three.
 */
describe('the vectors row separates a fetch in flight from a stopped one — C-6', () => {
  const counts = { embedded: 0, pending: 1_800, cacheDir: path.join(tempDir('potsherd-nocache-'), 'absent') };

  it('says so while the runtime is being fetched', () => {
    const r = vectorReport({ ...counts, working: true });
    expect(r.runtimeReady).toBe(false);
    expect(r.phase).toBe('pending');
    const note = vectorNote(r).parts.join(' · ');
    expect(note).toMatch(/fetching the/);
    expect(note).not.toMatch(/not fetched/);
  });

  it('says the other thing when nothing is', () => {
    const note = vectorNote(vectorReport({ ...counts, working: false })).parts.join(' · ');
    expect(note).toMatch(/not running/);
    expect(note).toMatch(/not fetched/);
    expect(note).not.toMatch(/fetching the/);
  });

  it('claims neither when the caller could not ask', () => {
    // `undefined` is a caller with no root, and an absent measurement must not
    // become a claim in either direction. The old wording, unchanged.
    const note = vectorNote(vectorReport({ ...counts })).parts.join(' · ');
    expect(note).toMatch(/runtime not fetched yet/);
    expect(note).not.toMatch(/not running/);
    expect(note).not.toMatch(/fetching the/);
  });

  it('and the two states no longer render the same sentence', () => {
    const fetching = vectorNote(vectorReport({ ...counts, working: true })).parts.join(' · ');
    const stopped = vectorNote(vectorReport({ ...counts, working: false })).parts.join(' · ');
    expect(fetching).not.toBe(stopped);
  });
});

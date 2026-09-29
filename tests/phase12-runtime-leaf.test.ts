import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db as store, lock } from '@potsherd/core';
import { runRescue } from '../packages/cli/src/commands/rescue.js';
import { copyFixtureClaude, IDS, rmrf, tempDir } from './helpers.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

const roots: string[] = [];
const handles: ReturnType<typeof lock.acquire>[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const handle of handles.splice(0)) handle.release();
  for (const root of roots.splice(0)) rmrf(root);
});
function root(): string {
  const dir = tempDir('potsherd-phase12-leaf-');
  roots.push(dir);
  return dir;
}
function acquire(dir: string, op: string) {
  const handle = lock.acquire(op, { root: dir });
  handles.push(handle);
  return handle;
}
function age(dir: string, minutes = 30): number {
  const when = new Date(Date.now() - minutes * 60_000);
  fs.utimesSync(dir, when, when);
  return fs.statSync(dir).mtimeMs;
}
function ownerFile(dir: string): string {
  return path.join(dir, fs.readdirSync(dir).find(name => /^owner(?:\.[0-9a-f-]+)?\.json$/.test(name))!);
}
function markDead(dir: string): void {
  const file = ownerFile(dir);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), pid: 0x7ffffffe }));
}

describe('phase 12 ownership-safe leases', () => {
  it('keeps a live owner excluded even when synchronous work misses every heartbeat', () => {
    const dir = root();
    const old = acquire(dir, 'long-synchronous-work');
    age(old.path, 90);
    expect(lock.holder({ root: dir })?.op).toBe('long-synchronous-work');
    expect(() => acquire(dir, 'contender')).toThrow(lock.LockBusyError);
  });

  it('excludes contenders during a real process pause and recovers after its death', async () => {
    const dir = root();
    const module = new URL('../packages/core/src/lock.ts', import.meta.url).href;
    const script = `
      import { acquire } from ${JSON.stringify(module)};
      const held = acquire('child-owner', { root: ${JSON.stringify(dir)} });
      process.send({ path: held.path });
      process.on('message', () => { held.release(); process.exit(0); });
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    children.push(child);
    const ready = await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(([code]) => { throw new Error(`child exited before publishing (${code})`); }),
    ]);
    const lockPath = (ready[0] as { path: string }).path;
    child.kill('SIGSTOP');
    age(lockPath, 90);
    expect(() => acquire(dir, 'contender')).toThrow(lock.LockBusyError);
    const stopped = once(child, 'exit');
    child.kill('SIGKILL');
    await stopped;
    expect(acquire(dir, 'after-crash')).toBeDefined();
    expect(() => acquire(dir, 'third')).toThrow(lock.LockBusyError);
  }, 10_000);

  it('fences a superseded handle from replacement heartbeat and release', () => {
    vi.useFakeTimers();
    const dir = root();
    const old = acquire(dir, 'old');
    // A dead process/recycled PID has lost authority. Keep its handle to model
    // the delayed callback that caused L5, without expiring real live work.
    markDead(old.path);
    const next = acquire(dir, 'replacement');
    const replacementMtime = age(next.path, 2);
    old.touch();
    expect(fs.statSync(next.path).mtimeMs).toBe(replacementMtime);
    old.release();
    vi.advanceTimersByTime(20_000);
    expect(lock.holder({ root: dir })?.op).toBe('replacement');
    expect(() => acquire(dir, 'third')).toThrow(lock.LockBusyError);
    next.release();
    expect(acquire(dir, 'successor')).toBeDefined();
  });

  it('cannot erase a replacement when its delayed release resumes', () => {
    const dir = root();
    const old = acquire(dir, 'old');
    markDead(old.path);
    acquire(dir, 'replacement');
    old.release();
    expect(lock.holder({ root: dir })?.op).toBe('replacement');
    expect(() => acquire(dir, 'third')).toThrow(lock.LockBusyError);
  });

  it('cannot remove a successor published after its stale-owner observation', () => {
    const dir = root();
    const old = acquire(dir, 'dead');
    markDead(old.path);
    const kill = process.kill.bind(process);
    let interleaved = false;
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal: number | string) => {
      if (pid === 0x7ffffffe && !interleaved) {
        interleaved = true;
        // Deterministic barrier: stale metadata was read, then another process
        // retires it and publishes a lease before the first contender resumes.
        fs.rmSync(old.path, { recursive: true });
        acquire(dir, 'winner');
        throw Object.assign(new Error('dead owner'), { code: 'ESRCH' });
      }
      return kill(pid, signal as NodeJS.Signals);
    }) as typeof process.kill);
    expect(() => acquire(dir, 'late-contender')).toThrow(lock.LockBusyError);
    expect(interleaved).toBe(true);
    expect(lock.holder({ root: dir })?.op).toBe('winner');
  });

  it('detects a recycled local pid by birth identity without waiting for heartbeat expiry', () => {
    const dir = root();
    // Inject the OS birth lookup deterministically; sandboxed macOS denies ps.
    const lookup = vi.mocked(execFileSync);
    const original = lookup.getMockImplementation()!;
    lookup.mockImplementation((() => 'Mon Sep 28 12:00:00 2026\n') as typeof execFileSync);
    const old = acquire(dir, 'recycled');
    const file = ownerFile(old.path);
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(info.processStart).toBeTruthy();
    fs.writeFileSync(file, JSON.stringify({ ...info, processStart: 'different-process-birth' }));
    expect(lock.holder({ root: dir })).toBeNull();
    acquire(dir, 'actual-owner');
    old.release();
    expect(lock.holder({ root: dir })?.op).toBe('actual-owner');
    lookup.mockImplementation(original);
  });

  it('fails closed for a foreign host whose process cannot be verified locally', () => {
    const dir = root();
    const lockPath = path.join(dir, '.lock');
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
      pid: process.pid, op: 'foreign', at: new Date().toISOString(), host: `${os.hostname()}-other`,
    }));
    age(lockPath);
    expect(lock.holder({ root: dir })?.op).toBe('foreign');
    expect(() => acquire(dir, 'contender')).toThrow(lock.LockBusyError);
  });

  it('recovers expired unknown metadata but honors its publication grace period', () => {
    const dir = root();
    const lockPath = path.join(dir, '.lock');
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), '{truncated');
    expect(() => acquire(dir, 'early')).toThrow(lock.LockBusyError);
    age(lockPath);
    expect(acquire(dir, 'recovered')).toBeDefined();
  });

  it('honors an empty unpublished legacy directory until its grace period expires', () => {
    const dir = root();
    const lockPath = path.join(dir, '.lock');
    fs.mkdirSync(lockPath);
    expect(() => acquire(dir, 'early')).toThrow(lock.LockBusyError);
    age(lockPath);
    expect(acquire(dir, 'after-crash')).toBeDefined();
  });

  it('does not publish an incomplete owner after metadata-write failure', () => {
    const dir = root();
    const write = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]).includes('.lock')) throw Object.assign(new Error('metadata EIO'), { code: 'EIO' });
      return write(...args);
    });
    expect(() => acquire(dir, 'failed')).toThrow('metadata EIO');
    expect(fs.existsSync(path.join(dir, '.lock'))).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
    vi.restoreAllMocks();
    expect(acquire(dir, 'retry')).toBeDefined();
  });
});

describe('phase 12 rescue failure status', () => {
  it.each([{ quiet: true }, { json: true }, {}])('returns non-success for partial copy failure in %j mode, then retries only the failed file', async mode => {
    const dir = root();
    const claude = copyFixtureClaude();
    roots.push(path.dirname(claude));
    const src = path.join(claude, 'projects', '-tmp-potsherd-alpha', `${IDS.alive}.jsonl`);
    const dst = path.join(dir, 'archive', 'claude', '-tmp-potsherd-alpha', `${IDS.alive}.jsonl`);
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const copy = fs.copyFileSync;
    vi.spyOn(fs, 'copyFileSync').mockImplementation((...args: Parameters<typeof fs.copyFileSync>) => {
      if (args[0] === src) throw Object.assign(new Error('synthetic copy EIO'), { code: 'EIO' });
      return copy(...args);
    });
    const options = { potsherdDir: dir, claudeDir: claude, settings: false, ...mode };
    expect(await runRescue(options)).toBe(1);
    expect(fs.existsSync(dst)).toBe(false);
    const first = store.open({ root: dir, readonly: true });
    expect(store.count(first, 'archive_files')).toBe(6);
    first.close();
    if ('json' in mode) {
      const receipt = JSON.parse(output.mock.calls.map(call => String(call[0])).join(''));
      expect(receipt.filesFailed).toHaveLength(1);
      expect(receipt.filesCopied).toBe(6);
    }
    vi.mocked(fs.copyFileSync).mockRestore();
    expect(await runRescue(options)).toBe(0);
    expect(fs.readFileSync(dst)).toEqual(fs.readFileSync(src));
    const db = store.open({ root: dir, readonly: true });
    expect(store.count(db, 'archive_files')).toBe(7);
    expect(db.prepare('SELECT files_copied FROM rescue_log ORDER BY id').all()).toEqual([
      { files_copied: 6 }, { files_copied: 1 },
    ]);
    db.close();
  });

  it('returns non-success on replacement rename failure, preserves the archive, and repairs it on retry', async () => {
    const dir = root();
    const claude = copyFixtureClaude();
    roots.push(path.dirname(claude));
    const options = { potsherdDir: dir, claudeDir: claude, settings: false, quiet: true };
    expect(await runRescue(options)).toBe(0);
    const src = path.join(claude, 'projects', '-tmp-potsherd-alpha', `${IDS.alive}.jsonl`);
    const dst = path.join(dir, 'archive', 'claude', '-tmp-potsherd-alpha', `${IDS.alive}.jsonl`);
    const before = fs.readFileSync(dst);
    fs.appendFileSync(src, JSON.stringify({ type: 'progress', value: 'later' }) + '\n');
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === dst) throw Object.assign(new Error('synthetic rename EIO'), { code: 'EIO' });
      return rename(from, to);
    });
    expect(await runRescue(options)).toBe(1);
    expect(fs.readFileSync(dst)).toEqual(before);
    // The existing atomic-copy path may retain its scratch file after EIO;
    // it never replaces the last valid archive and retry overwrites it.
    vi.mocked(fs.renameSync).mockRestore();
    expect(await runRescue(options)).toBe(0);
    expect(fs.readFileSync(dst)).toEqual(fs.readFileSync(src));
  });
});

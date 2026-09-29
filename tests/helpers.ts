import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURE_CLAUDE = path.join(here, 'fixtures', 'claude');

export const IDS = {
  alive: '11111111-1111-4111-8111-111111111111',
  sdk: '22222222-2222-4222-8222-222222222222',
  ghostA: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  ghostB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ghostC: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
} as const;

export const PROJECTS = {
  alpha: '/tmp/potsherd-alpha',
  beta: '/tmp/potsherd-beta',
  gamma: '/tmp/potsherd-gamma',
} as const;

/** A writable throwaway directory, removed by `cleanup()`. */
export function tempDir(prefix = 'potsherd-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * The transcript mtimes the sweep tests reason about, relative to the fixture
 * root. They live here and not in the fixture because **git does not preserve
 * mtimes**: on a fresh clone every fixture file is stamped with the checkout
 * time, so a test that reads a date off the working tree passes on the machine
 * that generated the fixture and fails in CI. Any test whose result depends on
 * a file's age must set that age itself.
 */
export const FIXTURE_MTIMES: Record<string, string> = {
  [`projects/-tmp-potsherd-alpha/${IDS.alive}.jsonl`]: '2026-08-01T09:05:20.000Z',
  [`projects/-tmp-potsherd-beta/${IDS.sdk}.jsonl`]: '2026-08-02T11:00:09.000Z',
};

/** Stamp one file with a known mtime (and atime), for sweep arithmetic. */
export function setMtime(file: string, when: string): void {
  const d = new Date(when);
  fs.utimesSync(file, d, d);
}

/**
 * A writable copy of the committed fixture. Tests that exercise rescue or the
 * settings consent flow must never mutate the fixture in the repo.
 *
 * The copy is stamped with `FIXTURE_MTIMES`, so every test that copies the
 * fixture gets the same session ages whatever the checkout did.
 */
export function copyFixtureClaude(): string {
  const dir = path.join(tempDir(), 'claude');
  fs.cpSync(FIXTURE_CLAUDE, dir, { recursive: true });
  for (const [rel, when] of Object.entries(FIXTURE_MTIMES)) {
    setMtime(path.join(dir, rel), when);
  }
  return dir;
}

export function rmrf(p: string): void {
  // `maxRetries`, because phase 5's hook tests are the first in this suite to
  // exercise something that is *designed* to outlive the process that started
  // it: both plugins' hooks detach their real work so a session start is never
  // blocked. A detached `rescue` still writing into the sandbox while the
  // recursive remove walks it is `ENOTEMPTY` on Linux — seen on CI, not on
  // macOS. The answer is a more patient cleanup, not a less detached hook;
  // making the hook synchronous to suit the test would delete the property
  // the test exists to check.
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

export function readJson<T = unknown>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}

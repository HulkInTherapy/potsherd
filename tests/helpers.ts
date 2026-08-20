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
 * A writable copy of the committed fixture. Tests that exercise rescue or the
 * settings consent flow must never mutate the fixture in the repo.
 */
export function copyFixtureClaude(): string {
  const dir = path.join(tempDir(), 'claude');
  fs.cpSync(FIXTURE_CLAUDE, dir, { recursive: true });
  return dir;
}

export function rmrf(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

export function readJson<T = unknown>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}

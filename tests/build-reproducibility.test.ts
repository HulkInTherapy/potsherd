import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
describe('canonical bundle working directory', () => {
  for (const [pkg, output] of [['cli', 'potsherd.js'], ['mcp', 'index.js']]) {
    it(`${pkg} emits identical bytes from repository and package directories`, () => {
      const directory = path.join(root, 'packages', pkg!);
      const build = (cwd: string) => {
        const result = spawnSync(process.execPath, [path.join(directory, 'build.mjs')], {cwd, encoding: 'utf8', timeout: 30_000});
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        return [output!, `${output}.map`].map(file => readFileSync(path.join(directory, 'dist', file)));
      };
      const repository = build(root), local = build(directory);
      for (let i = 0; i < repository.length; i++) expect(repository[i]!.equals(local[i]!)).toBe(true);
    }, 65_000);
  }
});

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmrf, tempDir } from './helpers.js';

/**
 * The two SQLite drivers (open item A).
 *
 * A Claude Code plugin install is a git clone: nothing runs `pnpm install`,
 * nothing runs a build, and `better-sqlite3` is a native addon that cannot be
 * vendored into one file. For seven phases that meant a marketplace install
 * produced a plugin whose CLI would not start and whose MCP server died before
 * it spoke a word.
 *
 * Node has shipped its own SQLite since 22.5, so potsherd falls back to it.
 * The thing that makes that claim worth anything is not this file — it is that
 * **the whole suite runs green under `POTSHERD_SQLITE=node`**, which CI does as
 * a separate job. A driver nobody exercises is the phantom-flag failure this
 * project has recorded six times: a path that looks supported, succeeds, and
 * does nothing.
 *
 * What this file adds is the part the rest of the suite cannot see, because
 * the rest of the suite runs inside a checkout with a full `node_modules`:
 * that the shipped bundle **starts and works with no `node_modules` at all**.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(repo, 'packages', 'cli', 'dist', 'potsherd.js');
const FIXTURE = path.join(repo, 'tests', 'fixtures', 'claude');

let sandbox = '';
let lone = '';
const dirs: string[] = [];

/**
 * Run the bundle from a directory that has no `node_modules` above it.
 *
 * **`NODE_PATH` has to go, and finding that out is the point of this comment.**
 * Vitest sets it to three directories inside the repository's own
 * `node_modules/.pnpm`, and a child process inherits it — so the first version
 * of these tests copied the bundle into `os.tmpdir()`, ran it, and watched it
 * resolve `better-sqlite3` anyway. The test would have reported "the fallback
 * works" while never once loading the fallback.
 *
 * That is `09 §7.2` exactly: a test's premise must be something the test
 * establishes, not something the machine happens to provide. The premise here
 * is "no `better-sqlite3` is reachable", so the test has to make that true.
 */
function run(args: string[], env: Record<string, string> = {}): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const childEnv: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1', ...env };
  delete childEnv['NODE_PATH'];
  delete childEnv['POTSHERD_SQLITE'];
  // `spawnSync`, not `execFileSync`: the pattern the rest of the suite uses
  // discards stderr on success (it only reads it out of the thrown error), and
  // two of the things checked here — that nothing is written to stderr, and
  // that the escape hatch puts it back — are assertions *about* stderr on a
  // successful run.
  const r = spawnSync(process.execPath, [lone, ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    env: childEnv as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Does `better-sqlite3` resolve from `dir`, in a child with a clean env? */
function addonReachable(dir: string): boolean {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env['NODE_PATH'];
  const r = spawnSync(
    process.execPath,
    ['-e', "require('node:module').createRequire(process.argv[1]).resolve('better-sqlite3')", path.join(dir, 'potsherd.js')],
    { encoding: 'utf8', env: env as NodeJS.ProcessEnv },
  );
  return r.status === 0;
}

beforeAll(() => {
  execFileSync('node', ['build.mjs'], { cwd: path.join(repo, 'packages', 'cli'), stdio: 'pipe' });
  // `/tmp`, not a temp dir inside the repo: a directory under the checkout has
  // the repo's own `node_modules` on its resolution path, and the whole point
  // here is a machine that has none. `os.tmpdir()` is outside it.
  sandbox = tempDir('potsherd-lonely-');
  dirs.push(sandbox);
  lone = path.join(sandbox, 'potsherd.js');
  fs.copyFileSync(bundle, lone);
}, 180_000);

afterAll(() => {
  while (dirs.length) rmrf(dirs.pop()!);
});

describe('the shipped bundle, with no node_modules anywhere', () => {
  it('is one file — nothing beside it, and nothing reachable from it', () => {
    expect(fs.readdirSync(sandbox)).toEqual(['potsherd.js']);
    // The premise, established rather than assumed: from where this bundle
    // sits, and in the environment these tests give a child, `better-sqlite3`
    // does not resolve.
    expect(addonReachable(sandbox), 'better-sqlite3 is reachable from the sandbox').toBe(false);
  });

  it('starts, and knows its own version', () => {
    const r = run(['--version']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('audits — the first command anyone runs, and it needs no database', () => {
    const r = run(['audit', '--claude-dir', FIXTURE, '--json']);
    expect(r.code, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout) as Record<string, number>;
    expect(j['deleted']).toBe(3);
    expect(j['promptsLost']).toBe(6);
  });

  it('rescues — archives and rebuilds ghosts, on Node’s own sqlite', () => {
    const root = path.join(sandbox, 'pd-rescue');
    const r = run(['rescue', '--yes', '--no-settings', '--json', '--claude-dir', FIXTURE, '--potsherd-dir', root]);
    expect(r.code, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout) as Record<string, number>;
    expect(j['ghostsBuilt']).toBeGreaterThan(0);
    expect(j['promptsRecovered']).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(root, 'potsherd.db'))).toBe(true);
  });

  it('indexes and searches, and finds a prompt from a deleted session', () => {
    const root = path.join(sandbox, 'pd-find');
    expect(run(['rescue', '--yes', '--no-settings', '--quiet', '--claude-dir', FIXTURE, '--potsherd-dir', root]).code).toBe(0);
    expect(
      run(['index', '--full', '--no-embed', '--harness', 'claude', '--claude-dir', FIXTURE, '--potsherd-dir', root]).code,
    ).toBe(0);
    const r = run(['find', 'pgbouncer', '--json', '--potsherd-dir', root]);
    expect(r.code, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout) as { sessions: unknown[] };
    expect(j.sessions.length).toBeGreaterThan(0);
  });

  it('reports which sqlite it used, in the human view and in --json', () => {
    const root = path.join(sandbox, 'pd-find');
    const human = run(['doctor', '--claude-dir', FIXTURE, '--potsherd-dir', root, '--width', '80']);
    expect(human.stdout).toContain('node:sqlite');
    const j = JSON.parse(
      run(['doctor', '--json', '--claude-dir', FIXTURE, '--potsherd-dir', root]).stdout,
    ) as { db: { driver: string } };
    expect(j.db.driver).toBe('node:sqlite');
  });

  it('prints no experimental warning on the way past', () => {
    // Node warns the first time `node:sqlite` loads. It would land on top of
    // every screen and in front of every `--json` consumer's stderr, for a
    // decision the user did not make and cannot act on.
    const root = path.join(sandbox, 'pd-find');
    const r = run(['ls', '--potsherd-dir', root]);
    expect(r.stderr).toBe('');
  });

  it('puts the warning back when asked — if this Node emits one at all', (ctx) => {
    // The escape hatch must not be a flag that does nothing (`10.1`: six plan
    // claims about other software proved false, and the worst *succeeds* and
    // does nothing). But whether there is a warning to put back is a fact
    // about the Node running this, not about potsherd: it was experimental in
    // 22.5 and unflagged later, and the runner's Node had already stopped
    // printing it when this test first went to CI — four red legs asserting
    // that somebody else's warning still existed.
    //
    // So the premise is established rather than assumed (`09 §7.2`): ask this
    // Node directly, and skip loudly if the answer is no.
    //
    // **FIX-J §4.3.** It said `skip` and it printed its reason, and then it
    // `return`ed — which vitest reports as a **pass**. That is C-10's defect,
    // found here by sweeping the suite for the pattern rather than by anything
    // going wrong: on a Node that has stopped warning about `node:sqlite`, this
    // test went green having asserted nothing about the flag it exists to
    // prove is not a no-op. The reason it printed was already right; only the
    // verdict was wrong. `ctx.skip()` is the verdict.
    const probe = spawnSync(process.execPath, ['-e', "require('node:sqlite')"], {
      encoding: 'utf8',
    });
    if (!probe.stderr.includes('ExperimentalWarning')) {
      console.log(
        `  SKIPPED: ${process.version} does not warn about node:sqlite, so there is ` +
          'nothing for POTSHERD_SQLITE_WARN to put back',
      );
      ctx.skip();
      return;
    }
    const root = path.join(sandbox, 'pd-find');
    const loud = run(['ls', '--potsherd-dir', root], { POTSHERD_SQLITE_WARN: '1' });
    expect(loud.stderr).toContain('ExperimentalWarning');
  });
});

describe('POTSHERD_SQLITE selects a driver, and is not a flag that does nothing', () => {
  it('forces the addon when asked, inside the checkout', () => {
    const root = tempDir('potsherd-drv-');
    dirs.push(root);
    const out = execFileSync(
      process.execPath,
      [bundle, 'doctor', '--json', '--claude-dir', FIXTURE, '--potsherd-dir', root],
      { encoding: 'utf8', env: { ...process.env, POTSHERD_SQLITE: 'better-sqlite3' } },
    );
    expect((JSON.parse(out) as { db: { driver: string } }).db.driver).toBe('better-sqlite3');
  });

  it('forces the built-in when asked, inside the same checkout', () => {
    const root = tempDir('potsherd-drv-');
    dirs.push(root);
    const out = execFileSync(
      process.execPath,
      [bundle, 'doctor', '--json', '--claude-dir', FIXTURE, '--potsherd-dir', root],
      { encoding: 'utf8', env: { ...process.env, POTSHERD_SQLITE: 'node' } },
    );
    expect((JSON.parse(out) as { db: { driver: string } }).db.driver).toBe('node:sqlite');
  });

  it('prefers the addon when nothing is forced', () => {
    const root = tempDir('potsherd-drv-');
    dirs.push(root);
    const env = { ...process.env };
    delete env['POTSHERD_SQLITE'];
    const out = execFileSync(
      process.execPath,
      [bundle, 'doctor', '--json', '--claude-dir', FIXTURE, '--potsherd-dir', root],
      { encoding: 'utf8', env },
    );
    expect((JSON.parse(out) as { db: { driver: string } }).db.driver).toBe('better-sqlite3');
  });
});

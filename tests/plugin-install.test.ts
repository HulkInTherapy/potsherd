// The plugin directory is installed ON ITS OWN. A marketplace install copies
// `plugins/claude-code/` to `~/.claude/plugins/cache/...` and nothing else, so
// the repository's root `package.json` ("type": "module") is not there. Node
// then walks UP to the nearest package.json — and on a real machine that is
// `~/.claude/package.json`, which Claude Code writes as {"type":"commonjs"} —
// so the ESM bundle in `dist/` failed to load and both the binary and the MCP
// server crashed on startup (found by the user on 23 aug 2026, after v1.1.0).
//
// Phase 9's fresh-copy test did not catch it because it copied the plugin to
// /tmp, where no package.json exists above it and Node auto-detects ESM. This
// test copies it under a parent that says "commonjs" on purpose: the one
// environment that reproduces the install, not the one that hides it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { TOOLS } from '../packages/mcp/src/server.js';

const REPO = resolve(__dirname, '..');
const PLUGIN_SRC = join(REPO, 'plugins', 'claude-code');

let root: string;
let plugin: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'potsherd-plugin-install-'));
  // the trap: a parent package.json that forces CommonJS on anything below it
  writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}\n');
  plugin = join(root, 'potsherd');
  cpSync(PLUGIN_SRC, plugin, { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the plugin directory, installed on its own under a commonjs parent', () => {
  it('ships its own package.json that marks dist/ as ES modules', () => {
    const p = join(PLUGIN_SRC, 'package.json');
    expect(existsSync(p)).toBe(true);
    const pkg = JSON.parse(readFileSync(p, 'utf8'));
    expect(pkg.type).toBe('module');
    expect(pkg.private).toBe(true);
    const manifest = JSON.parse(readFileSync(join(PLUGIN_SRC, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(pkg.version).toBe(manifest.version);
  });

  it('the bundled binary starts and prints its version, with no ESM warning', () => {
    const r = spawnSync('sh', [join(plugin, 'bin', 'potsherd'), '--version'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: '' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(r.stderr).not.toMatch(/Failed to load the ES module|Cannot use import statement/);
  });

  /**
   * `plugins/<harness>/dist` is BUILD OUTPUT, so every assertion here is about
   * whatever was last vendored rather than about the current source. A comment
   * used to say so and nothing enforced it, which makes the test's premise
   * something a person had to remember instead of something the test
   * establishes (`09 §7.2`, the recurring one). If the bundles are stale this
   * fails HERE, naming the command, rather than passing on last release's
   * behaviour under this release's name.
   *
   * ## it used to compare mtimes, and that made its premise the filesystem
   *
   * This test took the newest mtime under `packages/**​/*.ts` and required the
   * bundle to be at least that new. The third verifier restored one source file
   * **byte for byte** with `cp` — content identical, mtime bumped — and the
   * test went red while `pnpm vendor` reported no diff at all. A `git checkout`
   * away and back, a `touch`, a rebase, a fresh clone (git stamps every file
   * with the checkout time) flips it the same way. That is rule 7 exactly: *a
   * test's premise must be something the test establishes, not something the
   * machine provides.* It was noise in one direction and, worse, an alarm
   * nobody could trust in the other.
   *
   * ## what it compares now
   *
   * Content, and specifically **the content `pnpm vendor` itself computes**.
   * `scripts/vendor-plugin.mjs` is a `copyFileSync` per entry of one `ARTIFACTS`
   * list; "the bundle this build produces" is its left-hand column, and the
   * committed bundle is its right-hand one. So the assertion is that the two are
   * byte-identical — the same property CI states as *"the vendored plugin
   * bundles are the ones this build produces"* by running the vendor script and
   * diffing `plugins/`, reproduced here without writing into the working tree.
   *
   * The pair list is restated rather than imported, because that script is a
   * top-level program that copies files and calls `process.exit` on import. So
   * the list is **pinned to the script's own text** first: a third artefact, a
   * renamed bundle or a moved output path fails on the pin, loudly, instead of
   * leaving this test quietly checking a pair that no longer exists.
   *
   * ## the one hop this does not cover, said out loud
   *
   * source -> `packages/*​/dist` is the build; `packages/*​/dist` -> `plugins/`
   * is the vendor. This pins the second. The first is pinned by `pnpm build`
   * running before `pnpm test` in CI, and by `tests/plugin-bundle.test.ts`
   * requiring the vendored bundle's own `VERSION` string to equal the one in
   * `packages/cli/package.json` and in each plugin manifest. A source change
   * that has been built and not vendored is red here; one that has not been
   * built either is red at the CI step above, which builds first.
   */
  it('the vendored bundles are byte-for-byte the bundles this build produces', () => {
    /** `ARTIFACTS` from `scripts/vendor-plugin.mjs`: [built, where the plugin wants it]. */
    const ARTIFACTS: readonly (readonly [string, string])[] = [
      ['packages/cli/dist/potsherd.js', 'dist/potsherd.js'],
      ['packages/mcp/dist/index.js', 'dist/mcp.js'],
    ];
    const vendorScript = join(REPO, 'scripts', 'vendor-plugin.mjs');
    const script = readFileSync(vendorScript, 'utf8');
    // The pin. If the vendor script's list moves, this list is wrong and says
    // so here rather than checking two paths nothing copies any more.
    for (const [from, to] of ARTIFACTS) {
      expect(script, `scripts/vendor-plugin.mjs no longer copies ${from}`).toContain(`'${from}'`);
      expect(script, `scripts/vendor-plugin.mjs no longer writes ${to}`).toContain(`'${to}'`);
    }
    const pairs = script.match(/^ {2}\['[^']+', *'[^']+'\],$/gm) ?? [];
    expect(
      pairs,
      'scripts/vendor-plugin.mjs vendors a different number of files than this test checks',
    ).toHaveLength(ARTIFACTS.length);

    for (const [from, to] of ARTIFACTS) {
      const built = join(REPO, from);
      const vendored = join(PLUGIN_SRC, to);
      expect(existsSync(built), `${from} is missing — run: pnpm build && pnpm vendor`).toBe(true);
      expect(existsSync(vendored), `${vendored} is missing — run: pnpm build && pnpm vendor`).toBe(
        true,
      );
      const fresh = readFileSync(built);
      const committed = readFileSync(vendored);
      // A 1.6 MB buffer diff is unreadable, so the message carries the two
      // sizes and the first byte that differs — enough to tell "a stale bundle"
      // from "the wrong file" without printing either of them.
      let at = -1;
      const n = Math.min(fresh.length, committed.length);
      for (let i = 0; i < n; i++) {
        if (fresh[i] !== committed[i]) {
          at = i;
          break;
        }
      }
      if (at === -1 && fresh.length !== committed.length) at = n;
      expect(
        at,
        `plugins/claude-code/${to} is not what ${from} builds ` +
          `(${String(committed.length)} bytes committed, ${String(fresh.length)} built, ` +
          `first difference at byte ${String(at)}) — run: pnpm build && pnpm vendor`,
      ).toBe(-1);
    }
  });

  it('the bundled MCP server answers tools/list with all three tools', () => {
    const frames = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ].map((f) => JSON.stringify(f)).join('\n') + '\n';
    const r = spawnSync('sh', [join(plugin, 'bin', 'potsherd-mcp')], {
      input: frames,
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: '' },
      timeout: 30_000,
    });
    expect(r.stderr).not.toMatch(/Failed to load the ES module|Cannot use import statement/);
    const reply = r.stdout
      .split('\n')
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((d) => d && d.id === 2);
    expect(reply, 'no tools/list reply').toBeTruthy();
    const names = reply.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['potsherd_graft', 'potsherd_read', 'potsherd_recall']);
  });

  it('and the same copy WITHOUT its package.json fails the way the install did', () => {
    rmSync(join(plugin, 'package.json'));
    const r = spawnSync('sh', [join(plugin, 'bin', 'potsherd'), '--version'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: '' },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Failed to load the ES module|Cannot use import statement/);
    // put it back so the other tests in this file do not depend on order
    cpSync(join(PLUGIN_SRC, 'package.json'), join(plugin, 'package.json'));
  });
});

// ---------------------------------------------------------------------------
// THE CODEX PLUGIN, UNDER ITS OWN TRAP (T10.12)
//
// `plugins/codex/` had never been loaded by a codex, and this file contained
// zero occurrences of the word `codex`. It has now been loaded by a real
// `@openai/codex@0.149.0`, installed through codex's own marketplace, and the
// trap turns out NOT to be the one above. Measured, not assumed:
//
//   1. WHERE IT RUNS. `codex plugin add` copies the plugin alone to
//      `$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>/` — the
//      same shape as `~/.claude/plugins/cache/`, one level deeper for the
//      version. {@link CODEX_CACHE_DEPTH} reproduces it.
//
//   2. THE COMMONJS TRAP DOES NOT EXIST HERE. Walking up from that installed
//      root on the reference machine finds NO `package.json` at all: codex
//      writes none into `$CODEX_HOME`, unlike Claude Code, which writes
//      `~/.claude/package.json` = {"type":"commonjs"}. And `plugins/codex/`
//      ships no `dist/` to be mis-typed in the first place. So this is not the
//      trap to test, and testing it would be theatre.
//
//   3. THE TRAP CODEX ACTUALLY HAS IS THE MISSING BUNDLE. `plugins/codex/bin/
//      potsherd` resolves through four places, and a marketplace install
//      satisfies NONE of the first three: no `$ROOT/dist/`, no sibling
//      `../claude-code/dist/` (the marketplace copies one directory), no
//      `../../packages/cli/dist/` (there is no checkout above the cache). The
//      only thing that can save it is `potsherd` on PATH — which is exactly
//      what the author's machine has and a user's does not. That is the same
//      class as v1.1.0: the environment that hides the fault is the author's.
//      So the test asserts the honest failure (`exit 127`, all three places
//      named, phase 0's "never silently do nothing") and the working case.
//
//   4. AND THE ESM TRAP IS REAL ONE HOP OVER. Step 1b runs the CLAUDE plugin's
//      bundle from next door. That bundle is ESM and is only ESM because
//      `plugins/claude-code/package.json` says so — so the commonjs parent
//      DOES bite the codex plugin, through its neighbour. Both directions are
//      asserted below.
//
// Verified against the real binary on 2026-08-24 (`T10.12-REPORT.md` §2):
// codex sets **both** `PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` for hooks, and
// discovers hooks at `<plugin>/hooks/hooks.json`.
const CODEX_PLUGIN_SRC = join(REPO, 'plugins', 'codex');
/** `$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>/`, measured. */
const CODEX_CACHE_DEPTH = ['plugins', 'cache', 'potsherd-local', 'potsherd', '1.1.0'];

describe('the codex plugin, installed the way codex installs it', () => {
  let codexRoot: string;
  let codexPlugin: string;

  beforeAll(() => {
    codexRoot = mkdtempSync(join(tmpdir(), 'potsherd-codex-install-'));
    // Same commonjs parent as above. It cannot bite `plugins/codex` directly
    // (no dist/), and it is here so that the step-1b assertion below is made
    // in the environment that DID break the real install, not in a clean room.
    writeFileSync(join(codexRoot, 'package.json'), '{"type":"commonjs"}\n');
    codexPlugin = join(codexRoot, '.codex', ...CODEX_CACHE_DEPTH);
    cpSync(CODEX_PLUGIN_SRC, codexPlugin, { recursive: true });
  });

  afterAll(() => {
    rmSync(codexRoot, { recursive: true, force: true });
  });

  it('carries a codex manifest, versioned with the claude plugin', () => {
    const manifest = JSON.parse(
      readFileSync(join(CODEX_PLUGIN_SRC, '.codex-plugin', 'plugin.json'), 'utf8'),
    );
    expect(manifest.name).toBe('potsherd');
    const twin = JSON.parse(readFileSync(join(PLUGIN_SRC, 'package.json'), 'utf8'));
    expect(
      manifest.version,
      'plugins/codex/.codex-plugin/plugin.json and plugins/claude-code/package.json must agree',
    ).toBe(twin.version);
    // codex 0.149.0 clamps a SessionEnd hook to 3s and says so on every run.
    // The declared 10 is not honoured; the file is kept as-is deliberately
    // (T10.12-LABELS.md), and this records that the number is not the one that
    // takes effect, so nobody re-derives it from the file.
    const hooks = JSON.parse(readFileSync(join(CODEX_PLUGIN_SRC, 'hooks', 'hooks.json'), 'utf8'));
    expect(Object.keys(hooks.hooks).sort()).toEqual(['SessionEnd', 'SessionStart']);
  });

  it('ships NO dist/ — so a marketplace install has no bundle of its own', () => {
    expect(
      existsSync(join(CODEX_PLUGIN_SRC, 'dist')),
      'plugins/codex/dist appeared: it must now carry its own package.json ({"type":"module"}) ' +
        'or the commonjs parent above the codex cache will break it exactly as v1.1.0 broke',
    ).toBe(false);
  });

  it('installed alone, with nothing on PATH, it fails LOUDLY and names all three places', () => {
    const r = spawnSync('sh', [join(codexPlugin, 'bin', 'potsherd'), '--version'], {
      encoding: 'utf8',
      // The one thing the author's machine has that a fresh install does not.
      env: { PATH: '/usr/bin:/bin', HOME: codexRoot, NODE_PATH: '' },
    });
    expect(r.status, 'a shim that exits 0 having run nothing is the failure wearing the fix').toBe(
      127,
    );
    expect(r.stderr).toMatch(/vendored in the plugin/);
    expect(r.stderr).toMatch(/the surrounding checkout/);
    expect(r.stderr).toMatch(/potsherd on PATH/);
    expect(r.stdout).toBe('');
  });

  it('with the claude plugin next door it runs — and that bundle is ESM only because of its package.json', () => {
    // Step 1b: `$ROOT/../claude-code/dist/potsherd.js`. Reproduce the layout
    // the resolution expects, INSIDE the commonjs parent.
    const sibling = join(codexPlugin, '..', 'claude-code');
    cpSync(PLUGIN_SRC, sibling, { recursive: true });
    const run = () =>
      spawnSync('sh', [join(codexPlugin, 'bin', 'potsherd'), '--version'], {
        encoding: 'utf8',
        env: { PATH: process.env['PATH'] ?? '', HOME: codexRoot, NODE_PATH: '' },
      });

    const ok = run();
    expect(ok.status).toBe(0);
    expect(ok.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(ok.stderr).not.toMatch(/Failed to load the ES module|Cannot use import statement/);

    // and the trap, one hop over: take the neighbour's package.json away and
    // the codex plugin inherits {"type":"commonjs"} from the parent.
    rmSync(join(sibling, 'package.json'));
    const broken = run();
    expect(broken.status).not.toBe(0);
    expect(broken.stderr).toMatch(/Failed to load the ES module|Cannot use import statement/);

    rmSync(sibling, { recursive: true, force: true });
  });

  it('the MCP shim resolves the same way and answers tools/list when it can', () => {
    const sibling = join(codexPlugin, '..', 'claude-code');
    cpSync(PLUGIN_SRC, sibling, { recursive: true });
    const frames =
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      ]
        .map((f) => JSON.stringify(f))
        .join('\n') + '\n';
    const r = spawnSync('sh', [join(codexPlugin, 'bin', 'potsherd-mcp')], {
      input: frames,
      encoding: 'utf8',
      env: { ...process.env, HOME: codexRoot, NODE_PATH: '' },
      timeout: 30_000,
    });
    expect(r.stderr).not.toMatch(/Failed to load the ES module|Cannot use import statement/);
    const reply = r.stdout
      .split('\n')
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((d) => d && d.id === 2);
    expect(reply, 'no tools/list reply from the codex plugin shim').toBeTruthy();
    const names = reply.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['potsherd_graft', 'potsherd_read', 'potsherd_recall']);
    rmSync(sibling, { recursive: true, force: true });
  });

  it("the .mcp.json codex reads declares the shim by a path relative to the plugin", () => {
    const mcp = JSON.parse(readFileSync(join(CODEX_PLUGIN_SRC, '.mcp.json'), 'utf8'));
    const server = mcp.mcpServers.potsherd;
    expect(server.command).toBe('sh');
    expect(server.args).toEqual(['bin/potsherd-mcp']);
    expect(existsSync(join(codexPlugin, ...server.args))).toBe(true);
  });
});

/**
 * D9 — the shim that tells a user what a failed start costs them.
 *
 * `bin/potsherd-mcp` is the last thing a user sees when the server does not
 * come up, and it is the only place that says which tools they have lost. It
 * described the v1.1.0 surface: "six tools", and a `session-archaeologist`
 * "left with no tools but `Read`". There are three tools, and that agent has
 * had no `Read` since T10.6 — so the one message written to be actionable was
 * describing a product that no longer exists.
 *
 * Both counts are derived here rather than typed, so a fourth tool or a
 * renamed one fails this test instead of quietly ageing the shim.
 */
describe('the shim shims describe the server that exists', () => {
  const NUMBER = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];
  const shims = ['claude-code', 'codex'].map((h) => {
    const text = readFileSync(join(REPO, 'plugins', h, 'bin', 'potsherd-mcp'), 'utf8');
    // A shell comment wraps mid-sentence, so "six\n# tools" is one phrase and a
    // line-blind reader is the only one that sees it. Unwrap before matching.
    return { harness: h, text, flat: text.replace(/\n#\s?/g, ' ') };
  });

  it('counts the tools the server actually registers', () => {
    for (const { harness, flat } of shims) {
      const counts = [...flat.matchAll(/\b(zero|one|two|three|four|five|six|seven)\s+tools?\b/gi)].map(
        (m) => m[1]!.toLowerCase(),
      );
      expect(counts.length, `${harness}: the shim says nothing about how many tools`).toBeGreaterThan(0);
      for (const c of counts) {
        expect(c, `${harness}: shim claims "${c} tools"`).toBe(NUMBER[TOOLS.length]);
      }
    }
  });

  it('names every tool it says is absent, and no tool that does not exist', () => {
    for (const { harness, text } of shims) {
      const named = new Set([...text.matchAll(/\bpotsherd_[a-z]+\b/g)].map((m) => m[0]));
      expect([...named].sort(), `${harness}`).toEqual([...TOOLS].sort());
    }
  });

  it('does not promise the archaeologist a Read it no longer has', () => {
    // The point of removing `Read` (audit F3) was that the agent could not
    // fall back to the repository. A shim telling a user the agent still has
    // it describes the fabrication path as a consolation.
    const agent = readFileSync(
      join(REPO, 'plugins', 'claude-code', 'agents', 'session-archaeologist.md'),
      'utf8',
    );
    expect(agent).not.toMatch(/^tools:.*\bRead\b/m);
    for (const { harness, text } of shims) {
      expect(text, `${harness}`).not.toMatch(/no tools but `?Read`?/);
      expect(text, `${harness}`).not.toMatch(/left holding `?Read`?/);
    }
  });
});

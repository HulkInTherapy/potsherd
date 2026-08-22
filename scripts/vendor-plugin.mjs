/**
 * Copy the built bundles into the plugin directories, so that a plugin
 * installed from the marketplace has something to run.
 *
 *   node scripts/vendor-plugin.mjs        # after pnpm build
 *
 * ## why a generated file is committed
 *
 * A Claude Code (or Codex) plugin install is a **git clone**. Nothing runs
 * `pnpm install`, nothing runs a build, and `dist/` is gitignored — so until
 * now a marketplace install produced a plugin with no CLI and no MCP server.
 * All six MCP tools vanished and `session-archaeologist` was left holding
 * `Read`; `bin/potsherd` fell through to whatever `potsherd` happened to be on
 * PATH, which on the machine this was written on was a stale 0.1.0. That is
 * open item A, and it has been the install story for every user who is not us
 * since phase 5.
 *
 * There are three ways out and this is the one that does not require anybody
 * to trust a registry we have not published to:
 *
 *   1. publish to npm — an outward-facing act; `docs/release/` prepares it and
 *      a human does it.
 *   2. build on install — a plugin cannot; there is no install hook.
 *   3. **vendor the bundle.** One file per plugin, committed.
 *
 * ## what makes this safe rather than a stale artefact waiting to happen
 *
 * The vendored bundle prints its own `VERSION`, and `tests/plugin-bundle.
 * test.ts` requires that string to equal the one in `packages/cli/package.json`
 * and in each plugin manifest. `VERSION` must be bumped for every release and
 * the suite already enforces that four ways, so **a release that forgets to
 * re-vendor fails the suite**. Between releases the vendored bundle is the last
 * released one, which is what a marketplace user should get anyway.
 *
 * ## what is deliberately NOT vendored
 *
 * `node_modules`. The bundles need no dependency to start — `commander`, the
 * MCP SDK and `zod` are bundled in, and `better-sqlite3`, `sqlite-vec`, the
 * embedding runtime and the agent SDK are all loaded lazily and degrade to a
 * sentence. So a vendored plugin with an empty `node_modules` runs `audit`,
 * `rescue`, `guard` and `doctor` — the whole rescue path — and tells the user
 * one command for the rest. Vendoring a native addon would mean vendoring it
 * per platform and per Node ABI, and getting that wrong is a
 * `NODE_MODULE_VERSION` crash for somebody who did nothing wrong.
 */
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** [built bundle, where each plugin wants it] */
const ARTIFACTS = [
  ['packages/cli/dist/potsherd.js', 'dist/potsherd.js'],
  ['packages/mcp/dist/index.js', 'dist/mcp.js'],
];
/**
 * Only the Claude Code plugin carries the bundles.
 *
 * The codex plugin is 2.4 MB of the same two files, for a plugin that
 * `phases/phase-5` labels **inferred from documentation and never loaded by
 * codex** (codex is not installed on the reference machine). Doubling what a
 * clone downloads for a surface nobody has confirmed works is not a trade
 * worth making, so `plugins/codex/bin/*` look next door — the two plugins ship
 * in the same repository and land in the same clone.
 */
const PLUGINS = ['plugins/claude-code'];

const missing = ARTIFACTS.map(([from]) => from).filter((f) => !existsSync(path.join(repo, f)));
if (missing.length > 0) {
  console.error(`not built: ${missing.join(', ')}\nrun:  pnpm build`);
  process.exit(1);
}

let bytes = 0;
for (const plugin of PLUGINS) {
  mkdirSync(path.join(repo, plugin, 'dist'), { recursive: true });
  for (const [from, to] of ARTIFACTS) {
    const src = path.join(repo, from);
    const dst = path.join(repo, plugin, to);
    copyFileSync(src, dst);
    bytes += statSync(dst).size;
    console.log(`  ${plugin}/${to}  <-  ${from}  (${(statSync(dst).size / 1024).toFixed(0)} KB)`);
  }
  // Source maps are NOT vendored: they are larger than the bundles and exist
  // for people debugging a checkout, who have the checkout.
  writeFileSync(
    path.join(repo, plugin, 'dist', 'README.md'),
    [
      '# generated — do not edit',
      '',
      'These are built by `pnpm build` and copied here by',
      '`scripts/vendor-plugin.mjs`. They are committed because a plugin install',
      'is a git clone: nothing installs dependencies and nothing runs a build,',
      'so without them the plugin has no CLI and no MCP server.',
      '',
      'They need no `node_modules` to start. `better-sqlite3` and `sqlite-vec`',
      'are loaded lazily; without them `audit`, `rescue`, `guard` and `doctor`',
      'work and everything that reads the index says so in one sentence.',
      '',
      'Regenerate with:  pnpm build && node scripts/vendor-plugin.mjs',
      '',
    ].join('\n'),
  );
}
console.log(`vendored ${ARTIFACTS.length * PLUGINS.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB total`);

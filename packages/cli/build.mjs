import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
mkdirSync(path.join(here, 'dist'), { recursive: true });

// @potsherd/core is bundled in rather than published separately: one npm
// package means `npx potsherd audit` resolves one thing.
//
// What stays external, and why it is a shorter list than it was.
//
// The rule is now **"external only if it cannot be bundled"**, not "external if
// it is a dependency". `commander` is pure JavaScript and is needed by every
// single invocation, so leaving it out bought nothing and cost the one thing
// that mattered: a bundle that cannot run beside an empty `node_modules`. A
// marketplace install of the plugin is exactly that situation — `dist/` is
// gitignored and nothing installs dependencies for a git clone — and the whole
// of open item A comes from it.
//
// What remains is genuinely unbundlable:
//   better-sqlite3, sqlite-vec        native addons
//   @huggingface/transformers         native (onnxruntime), and 300 MB of it
//   @anthropic-ai/claude-agent-sdk    resolves its own vendored cli.js by path
//   @anthropic-ai/sdk                 optional; only the API-key path uses it
//   @modelcontextprotocol/sdk, zod    not reachable from the CLI at all
//
// Every one of the first four is loaded lazily and degrades to a sentence, so a
// bundle with none of them present still runs `audit`, `rescue`, `guard` and
// `doctor` — the rescue path, which is what the product is named for.
const external = [
  'better-sqlite3',
  'sqlite-vec',
  '@huggingface/transformers',
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/sdk',
  '@modelcontextprotocol/sdk',
  'zod',
];

const targets = [
  { in: 'src/index.ts', out: 'dist/potsherd.js' },
];

for (const t of targets) {
  await build({
    entryPoints: [path.join(here, t.in)],
    outfile: path.join(here, t.out),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: true,
    external,
    logLevel: 'info',
    banner: {
      js: "import { createRequire as __potsherdCreateRequire } from 'node:module';\nconst require = __potsherdCreateRequire(import.meta.url);",
    },
  });
}

writeFileSync(path.join(here, 'dist', '.gitkeep'), '');

// The published package carries its own licence and credit. The originals live
// at the repo root; npm only packs files inside the package directory.
const repo = path.resolve(here, '..', '..');
for (const file of ['LICENSE', 'NOTICE', 'README.md']) {
  const from = path.join(repo, file);
  if (existsSync(from)) copyFileSync(from, path.join(here, file));
}

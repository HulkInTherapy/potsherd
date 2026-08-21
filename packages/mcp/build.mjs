import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
mkdirSync(path.join(here, 'dist'), { recursive: true });

// Same shape as `packages/cli/build.mjs`, and for the same reason: `@potsherd/
// core` is bundled in so that the plugin ships one file it can point a client
// at, and the native and heavy dependencies stay external because they cannot
// be bundled and are declared in package.json.
const external = [
  'better-sqlite3',
  'sqlite-vec',
  '@huggingface/transformers',
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/sdk',
  '@modelcontextprotocol/sdk',
  'zod',
  // `commander` is reached only through `packages/cli/src/output.js`'s module
  // graph; nothing in this server parses argv with it.
  'commander',
];

await build({
  entryPoints: [path.join(here, 'src/index.ts')],
  outfile: path.join(here, 'dist/index.js'),
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

writeFileSync(path.join(here, 'dist', '.gitkeep'), '');

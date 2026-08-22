import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
mkdirSync(path.join(here, 'dist'), { recursive: true });

// `@potsherd/core` is bundled in so that the plugin ships one file it can
// point a client at.
//
// Same rule as `packages/cli/build.mjs`: external only if it cannot be
// bundled. `@modelcontextprotocol/sdk`, `zod` and `commander` are all pure
// JavaScript and all needed by every start of this server, and leaving them
// out is what made a marketplace install produce a server that died with a
// module-not-found before it ever spoke MCP — taking all six tools with it,
// silently, because a server that fails to start is invisible by design.
const external = [
  'better-sqlite3',
  'sqlite-vec',
  '@huggingface/transformers',
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/sdk',
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

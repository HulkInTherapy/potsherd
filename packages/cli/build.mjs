import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
mkdirSync(path.join(here, 'dist'), { recursive: true });

// @potsherd/core is bundled in rather than published separately: one npm
// package means `npx potsherd audit` resolves one thing. Native and heavy
// optional dependencies stay external and are declared in package.json.
const external = [
  'better-sqlite3',
  'commander',
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

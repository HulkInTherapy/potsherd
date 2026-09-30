/** Build-local distribution packaging. Each host installs one plugin directory. */
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync,readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** [built bundle, where each plugin wants it] */
const ARTIFACTS = [
  ['packages/cli/dist/potsherd.js', 'dist/potsherd.js'],
  ['packages/mcp/dist/index.js', 'dist/mcp.js'],
];
const PLUGINS = ['plugins/claude-code','plugins/codex'];

// Generated artifacts and docs do not change build provenance. Freeze bundles
// after committing these inputs so a later artifact commit reproduces the manifest.
const BUILD_INPUTS = [
  ':(glob)packages/*/src/**',
  ':(glob)packages/*/bin/**',
  ':(glob)packages/*/package.json',
  ':(glob)packages/*/build.mjs',
  ':(glob)packages/*/tsconfig*.json',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  ':(glob)tsconfig*.json', 'scripts/vendor-plugin.mjs',
  ':(glob)plugins/*/package.json',
  ':(glob)plugins/*/.*-plugin/*.json',
  '.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json',
  'LICENSE', 'NOTICE', 'licenses/js-tiktoken-MIT.txt',
];
const sourceRevision = execFileSync('git', ['log', '-1', '--format=%H', '--', ...BUILD_INPUTS], {
  cwd: repo, encoding: 'utf8',
}).trim();
if (!sourceRevision) throw new Error('No committed build inputs found');

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
  for(const license of ['LICENSE','NOTICE'])copyFileSync(path.join(repo,license),path.join(repo,plugin,license));
  mkdirSync(path.join(repo,plugin,'licenses'),{recursive:true});
  copyFileSync(path.join(repo,'licenses','js-tiktoken-MIT.txt'),path.join(repo,plugin,'licenses','js-tiktoken-MIT.txt'));
  const files=Object.fromEntries(ARTIFACTS.map(([,name])=>{const body=readFileSync(path.join(repo,plugin,name));return [name,{bytes:body.length,sha256:createHash('sha256').update(body).digest('hex')}];}));
  const version=JSON.parse(readFileSync(path.join(repo,'packages','cli','package.json'),'utf8')).version;
  writeFileSync(path.join(repo,plugin,'dist','artifact-manifest.json'),JSON.stringify({contractVersion:2,version,sourceRevision,files,budgetTokenizer:'cl100k-base/js-tiktoken@1.0.21',semanticAssets:'explicit maintain acquisition; not bundled or downloaded on read'},null,2)+'\n');
  writeFileSync(path.join(repo,plugin,'dist','README.md'),`# Generated local candidate artifacts

Both this plugin's CLI and MCP bundles run independently of a sibling plugin or repository checkout. Bundled transport tokenizer assets require no download. Semantic model assets are acquired only by explicit maintain policy; missing assets leave labelled lexical/source access.

SQLite uses a locally available better-sqlite3 driver or Node's built-in node:sqlite when available. No native addon is vendored. This package includes its ESM marker, licenses and a hash manifest. Source maps are omitted.

Regenerate: pnpm build && pnpm vendor. Candidate version is not a publication or acceptance claim.
`);

}
console.log(`vendored ${ARTIFACTS.length * PLUGINS.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB total`);

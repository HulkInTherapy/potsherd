import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Runtime-required packages externalized from the MCP server bundle (see the
 * `bundle` script in package.json). The bundle inline-imports these at runtime
 * via Node's resolver, so a partial node_modules extraction — directory exists
 * but the package is missing its package.json and lib/ — surfaces as a
 * confusing `ERR_MODULE_NOT_FOUND` *after* the wrapper has already declared
 * dependencies healthy and launched the server (#95 Bug 1).
 *
 * Excludes optional / OS-specific externals (sharp, fsevents) — missing those
 * is not necessarily fatal.
 */
export const REQUIRED_PACKAGES = [
  '@anthropic-ai/claude-agent-sdk',
  '@huggingface/transformers',
  'better-sqlite3',
  'onnxruntime-node',
  'proper-lockfile',
  'sqlite-vec',
];

/**
 * Return the list of required packages whose package.json is missing under
 * `<pluginRoot>/node_modules`. An empty array means the install looks complete;
 * a non-empty array is the diagnostic to print before re-running `npm install`.
 *
 * Probing each package's package.json — not just the directory — catches
 * partial extractions where the folder exists but the manifest hasn't been
 * written yet (the failure mode reported for episodic-memory@1.4.1 on Windows
 * 11 in #95).
 */
export function findMissingDeps(pluginRoot) {
  const nodeModules = join(pluginRoot, 'node_modules');
  if (!existsSync(nodeModules)) {
    return REQUIRED_PACKAGES.slice();
  }
  return REQUIRED_PACKAGES.filter(pkg => !existsSync(join(nodeModules, pkg, 'package.json')));
}

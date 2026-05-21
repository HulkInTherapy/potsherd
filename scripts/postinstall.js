#!/usr/bin/env node
/**
 * Cross-platform postinstall: rebuild better-sqlite3's native binding against
 * the local Node version.
 *
 * Replaces the unix-only shell idiom that lived in package.json:
 *
 *   "postinstall": "npm rebuild better-sqlite3 2>/dev/null || true"
 *
 * On Windows cmd.exe that line fails — `2>/dev/null` isn't valid redirection
 * and `|| true` doesn't behave the same — which makes `npm install` exit
 * non-zero even when every dependency installed correctly. Reporter on
 * Windows 11 (#95) saw exactly this and spent time chasing a phantom failure.
 *
 * This script exits 0 on success or failure. Failure output is preserved on
 * stderr so a user (or the wrapper) can still see what went wrong, but it
 * doesn't propagate to the parent `npm install` as a fatal error.
 */
import { spawnSync } from 'child_process';

const isWindows = process.platform === 'win32';
const npmBin = isWindows ? 'npm.cmd' : 'npm';

const result = spawnSync(npmBin, ['rebuild', 'better-sqlite3'], {
  stdio: ['ignore', 'inherit', 'inherit'],
  shell: isWindows,
});

if (result.status !== 0) {
  console.error(
    'episodic-memory: postinstall rebuild of better-sqlite3 failed ' +
    `(status=${result.status}). The package files are still installed, but ` +
    'the native binding for this Node version may be missing. The MCP server ' +
    'will surface the underlying error on first launch (see ~/.config/' +
    'superpowers/logs/episodic-memory.log). Recover with: ' +
    'cd <plugin-dir> && npm rebuild better-sqlite3'
  );
}

process.exit(0);

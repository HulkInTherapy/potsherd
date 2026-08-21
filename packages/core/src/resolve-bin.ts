import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/**
 * The command string a hook should run to reach *this* potsherd.
 *
 * A `SessionStart` hook that says `potsherd rescue` and then fails because
 * potsherd is not on PATH is worse than no hook at all: it looks installed and
 * silently protects nothing. So the resolution order is
 *
 *   1. `potsherd` on PATH        — survives upgrades, reads best in a diff
 *   2. `node "<absolute path>"`  — always works, pinned to this install
 *
 * `guard --status` re-checks this, so a global install later can be noticed.
 */

export interface BinResolution {
  /** The command to put in the hook. */
  command: string;
  /** How it was found, for the message shown next to the diff. */
  via: 'path' | 'absolute';
  /** The resolved file, when we found one. */
  file?: string;
}

export function onPath(name = 'potsherd', env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env['PATH'];
  if (!raw) return null;
  const exts = process.platform === 'win32'
    ? (env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        const st = fs.statSync(candidate);
        if (st.isFile()) {
          if (process.platform === 'win32') return candidate;
          fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        }
      } catch { /* next candidate */ }
    }
  }
  return null;
}

/** `entry` is normally `process.argv[1]`, the bin script node was handed. */
export function resolveHookCommand(args: string, entry?: string): BinResolution {
  const found = onPath('potsherd');
  if (found) return { command: `potsherd ${args}`, via: 'path', file: found };

  const self = entry && fs.existsSync(entry) ? path.resolve(entry) : null;
  if (self) {
    // Quoted because a path can contain spaces, and a hook command is a shell
    // string, not an argv array.
    return { command: `node "${self}" ${args}`, via: 'absolute', file: self };
  }
  return { command: `potsherd ${args}`, via: 'path' };
}

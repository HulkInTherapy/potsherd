import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/**
 * Every path potsherd reads or writes is resolved here, so `doctor --privacy`
 * can enumerate them and so tests can redirect everything with two env vars.
 *
 * READ-ONLY inputs:  ~/.claude, ~/.codex, ~/.cursor, ~/.pi, ~/.gemini
 * WRITABLE:          ~/.potsherd  (and, with explicit consent, exactly one key
 *                    plus one hook entry in ~/.claude/settings.json)
 */

export function home(): string {
  return os.homedir();
}

/** `~/.claude`, honouring CLAUDE_CONFIG_DIR and an explicit --claude-dir. */
export function claudeDir(override?: string): string {
  if (override) return path.resolve(expandTilde(override));
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env && env.trim()) return path.resolve(expandTilde(env.trim()));
  return path.join(home(), '.claude');
}

/** potsherd's own state. The only directory potsherd creates or writes. */
export function potsherdDir(override?: string): string {
  if (override) return path.resolve(expandTilde(override));
  const env = process.env.POTSHERD_DIR;
  if (env && env.trim()) return path.resolve(expandTilde(env.trim()));
  return path.join(home(), '.potsherd');
}

export function dbPath(root = potsherdDir()): string {
  return path.join(root, 'potsherd.db');
}

export function archiveDir(root = potsherdDir()): string {
  return path.join(root, 'archive');
}

export function cardsDir(root = potsherdDir()): string {
  return path.join(root, 'cards');
}

export function modelsDir(root = potsherdDir()): string {
  return path.join(root, 'models');
}

export function configPath(root = potsherdDir()): string {
  return path.join(root, 'config.json');
}

/** Claude Code's own files, all read-only to us. */
export function claudePaths(dir = claudeDir()) {
  return {
    root: dir,
    projects: path.join(dir, 'projects'),
    history: path.join(dir, 'history.jsonl'),
    settings: path.join(dir, 'settings.json'),
    localSettings: path.join(dir, 'settings.local.json'),
    sessions: path.join(dir, 'sessions'),
  };
}

/** Enterprise-managed settings, which override the user's own. */
export function managedSettingsPath(): string {
  if (process.platform === 'darwin') {
    return '/Library/Application Support/ClaudeCode/managed-settings.json';
  }
  if (process.platform === 'win32') {
    return 'C:\\ProgramData\\ClaudeCode\\managed-settings.json';
  }
  return '/etc/claude-code/managed-settings.json';
}

export function expandTilde(p: string): string {
  if (p === '~') return home();
  if (p.startsWith('~/')) return path.join(home(), p.slice(2));
  return p;
}

/** `/Users/zebra/Fulcrum` -> `-Users-zebra-Fulcrum` (Claude Code's project slug). */
export function slugify(cwd: string): string {
  return cwd.replace(/[/\\]/g, '-');
}

/**
 * Best-effort inverse of {@link slugify}. Ambiguous because a real directory
 * name may contain `-`; callers prefer the `cwd` recorded inside the transcript
 * and fall back to this only when no record carries one.
 */
export function unslugify(slug: string): string {
  return slug.replace(/^-/, '/').replace(/-/g, '/');
}

/** `~/x/y` for display; the audit card never prints a full home path. */
export function tildify(p: string): string {
  const h = home();
  return p === h ? '~' : p.startsWith(h + path.sep) ? '~' + p.slice(h.length) : p;
}

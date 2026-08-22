import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import type { Harness } from './adapters/types.js';

/**
 * Every path potsherd reads or writes is resolved here, so `doctor --privacy`
 * can enumerate them and so tests can redirect everything with two env vars.
 *
 * READ-ONLY inputs:  ~/.claude, ~/.codex, ~/.cursor, ~/.pi, ~/.gemini
 * WRITABLE:          ~/.potsherd  (and, with explicit consent, exactly one key
 *                    plus one hook entry in ~/.claude/settings.json)
 *
 * Each harness's root also honours that harness's own environment variable
 * (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) or, where the harness has none,
 * potsherd's test override (`POTSHERD_CURSOR_DIR`, `POTSHERD_PI_DIR`). The
 * four adapters landed in parallel with these resolvers inside them (finding
 * F9); they live here now and the adapters re-export them, so `doctor
 * --privacy` can enumerate every path potsherd can read from one module.
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

// ------------------------------------------------- the other harnesses (F9)

/** `~/.codex`, honouring `CODEX_HOME` and an explicit override. */
export function codexDir(override?: string): string {
  if (override) return path.resolve(expandTilde(override));
  const env = process.env['CODEX_HOME'];
  if (env && env.trim()) return path.resolve(expandTilde(env.trim()));
  return path.join(home(), '.codex');
}

/** Codex's own files, all read-only to us (`00-README.md`, ground rules). */
export function codexPaths(dir = codexDir()) {
  return {
    root: dir,
    sessions: path.join(dir, 'sessions'),
    /** Upstream feature; absent on many machines. Discovered when present. */
    archived: path.join(dir, 'archived_sessions'),
    sessionIndex: path.join(dir, 'session_index.jsonl'),
  };
}

/**
 * `~/.cursor`. Cursor defines no environment variable of its own, so
 * `POTSHERD_CURSOR_DIR` exists purely so `doctor` and the tests can point at a
 * fixture tree instead of the developer's real one.
 */
export function cursorDir(override?: string): string {
  if (override) return path.resolve(expandTilde(override));
  const env = process.env['POTSHERD_CURSOR_DIR'];
  if (env && env.trim()) return path.resolve(expandTilde(env.trim()));
  return path.join(home(), '.cursor');
}

export function cursorPaths(dir = cursorDir()) {
  return { root: dir, projects: path.join(dir, 'projects') };
}

export function cursorProjectsDir(override?: string): string {
  return cursorPaths(cursorDir(override)).projects;
}

/** `~/.pi`, overridable by `POTSHERD_PI_DIR` for the same reason as cursor. */
export function piDir(override?: string): string {
  if (override) return path.resolve(expandTilde(override));
  const env = process.env['POTSHERD_PI_DIR'];
  if (env && env.trim()) return path.resolve(expandTilde(env.trim()));
  return path.join(home(), '.pi');
}

export function piPaths(dir = piDir()) {
  return { root: dir, sessions: path.join(dir, 'agent', 'sessions') };
}

export function piSessionsDir(override?: string): string {
  return piPaths(piDir(override)).sessions;
}

/**
 * The phase-6 harnesses (`03 §2`: gemini, opencode, copilot). Each takes an
 * override for the same reason cursor and pi do — tests must never read the
 * developer's real directory — and each is a **read-only input**
 * (`00-README.md` ground rules): potsherd never writes a byte under them.
 */

/** `~/.gemini`, overridable by `POTSHERD_GEMINI_DIR`. */
export function geminiDir(override?: string): string {
  if (override) return path.resolve(expandTilde(override));
  const env = process.env['POTSHERD_GEMINI_DIR'];
  if (env && env.trim()) return path.resolve(expandTilde(env.trim()));
  return path.join(home(), '.gemini');
}

export function geminiPaths(dir = geminiDir()) {
  return { root: dir, tmp: path.join(dir, 'tmp') };
}

/** Where gemini cli keeps its per-project checkpoint directories. */
export function geminiTmpDir(override?: string): string {
  return geminiPaths(geminiDir(override)).tmp;
}

/** `~/.local/share/opencode`, overridable by `POTSHERD_OPENCODE_DIR`. */
export function opencodeDir(override?: string): string {
  if (override) return path.resolve(expandTilde(override));
  const env = process.env['POTSHERD_OPENCODE_DIR'];
  if (env && env.trim()) return path.resolve(expandTilde(env.trim()));
  return path.join(home(), '.local', 'share', 'opencode');
}

/** `~/.copilot`, overridable by `POTSHERD_COPILOT_DIR`. */
export function copilotDir(override?: string): string {
  if (override) return path.resolve(expandTilde(override));
  const env = process.env['POTSHERD_COPILOT_DIR'];
  if (env && env.trim()) return path.resolve(expandTilde(env.trim()));
  return path.join(home(), '.copilot');
}

export function copilotPaths(dir = copilotDir()) {
  return { root: dir, sessionState: path.join(dir, 'session-state') };
}

/** Where copilot cli keeps its session state directories. */
export function copilotSessionStateDir(override?: string): string {
  return copilotPaths(copilotDir(override)).sessionState;
}

export interface HarnessSourceDir {
  harness: Harness;
  /** The directory the adapter walks. */
  dir: string;
  /** The environment variable that moves it, if the harness has one. */
  env?: string;
}

/**
 * Every directory potsherd can read a transcript from, in `doctor`'s order.
 * One list, so `doctor --privacy` can never drift from what the adapters
 * actually open.
 */
export function harnessSourceDirs(overrides: { claudeDir?: string } = {}): HarnessSourceDir[] {
  return [
    { harness: 'claude', dir: claudePaths(claudeDir(overrides.claudeDir)).projects, env: 'CLAUDE_CONFIG_DIR' },
    { harness: 'codex', dir: codexPaths().sessions, env: 'CODEX_HOME' },
    { harness: 'cursor', dir: cursorProjectsDir(), env: 'POTSHERD_CURSOR_DIR' },
    { harness: 'pi', dir: piSessionsDir(), env: 'POTSHERD_PI_DIR' },
    { harness: 'gemini', dir: geminiTmpDir(), env: 'POTSHERD_GEMINI_DIR' },
    { harness: 'opencode', dir: opencodeDir(), env: 'POTSHERD_OPENCODE_DIR' },
    { harness: 'copilot', dir: copilotSessionStateDir(), env: 'POTSHERD_COPILOT_DIR' },
  ];
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

/** `/Users/dev/event-bus` -> `-Users-dev-event-bus` (Claude Code's project slug). */
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

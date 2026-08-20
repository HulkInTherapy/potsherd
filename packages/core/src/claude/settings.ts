import fs from 'node:fs';
import path from 'node:path';
import { claudePaths, managedSettingsPath } from '../paths.js';

/**
 * Reads Claude Code's settings only to answer two questions:
 *
 *   1. what is the effective `cleanupPeriodDays` (unset means 30, the default
 *      that has already deleted 93% of the reference machine's sessions)?
 *   2. is this file safe for potsherd to edit at all?
 *
 * Question 2 is the important one. If the file has comments (JSONC), trailing
 * commas, or an enterprise-managed override, potsherd refuses to write and
 * prints manual instructions instead of corrupting a file it did not create.
 */

export const CLAUDE_DEFAULT_CLEANUP_DAYS = 30;
/** 10 years. The value the consent prompt offers. */
export const POTSHERD_CLEANUP_DAYS = 3650;

export type SettingsSource = 'managed' | 'local' | 'user' | 'default';

export interface SettingsFile {
  path: string;
  exists: boolean;
  /** Raw text, kept so an edit can be a minimal, formatting-preserving patch. */
  text?: string;
  json?: Record<string, unknown>;
  /** Set when the file exists but cannot be parsed as strict JSON. */
  parseError?: string;
  /** True when the text contains `//` or block comments outside strings. */
  jsonc?: boolean;
}

export interface CleanupStatus {
  /** The value that actually applies, after precedence. */
  effective: number;
  /** What the user's own settings.json says, or null when unset. */
  declared: number | null;
  source: SettingsSource;
  files: { managed: SettingsFile; local: SettingsFile; user: SettingsFile };
  /** True when potsherd may safely write `cleanupPeriodDays` to the user file. */
  editable: boolean;
  /** Present when `editable` is false: why, in one sentence. */
  reason?: string;
}

export function readSettingsFile(p: string): SettingsFile {
  if (!fs.existsSync(p)) return { path: p, exists: false };
  let text: string;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (err) {
    return { path: p, exists: true, parseError: `unreadable: ${(err as Error).message}` };
  }
  const file: SettingsFile = { path: p, exists: true, text, jsonc: looksLikeJsonc(text) };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      file.json = parsed as Record<string, unknown>;
    } else {
      file.parseError = 'top level is not an object';
    }
  } catch (err) {
    file.parseError = (err as Error).message;
  }
  return file;
}

export function readCleanupStatus(dir?: string): CleanupStatus {
  const cp = claudePaths(dir);
  const managed = readSettingsFile(managedSettingsPath());
  const local = readSettingsFile(cp.localSettings);
  const user = readSettingsFile(cp.settings);

  let effective = CLAUDE_DEFAULT_CLEANUP_DAYS;
  let source: SettingsSource = 'default';
  let declared: number | null = null;

  // Lowest precedence first, so the highest wins by overwriting.
  for (const [src, f] of [['user', user], ['local', local], ['managed', managed]] as const) {
    const v = f.json?.['cleanupPeriodDays'];
    if (typeof v === 'number' && Number.isFinite(v)) {
      effective = v;
      source = src;
      if (src === 'user') declared = v;
    }
  }
  if (typeof user.json?.['cleanupPeriodDays'] === 'number') {
    declared = user.json['cleanupPeriodDays'] as number;
  }

  let editable = true;
  let reason: string | undefined;
  if (managed.exists && typeof managed.json?.['cleanupPeriodDays'] === 'number') {
    editable = false;
    reason = `an enterprise-managed policy at ${managed.path} sets cleanupPeriodDays; a user setting cannot override it`;
  } else if (user.exists && user.jsonc) {
    // Checked before the parse error, because a JSONC file also fails to parse
    // and "contains comments" is the message that tells the user what to do.
    editable = false;
    reason = `${user.path} contains comments, so rewriting it as JSON would drop them`;
  } else if (user.exists && user.parseError) {
    editable = false;
    reason = `${user.path} is not valid JSON (${user.parseError})`;
  }

  return { effective, declared, source, files: { managed, local, user }, editable, reason };
}

/**
 * Strict-JSON check for comment markers outside string literals. Cheap and
 * deliberately conservative: a false positive costs a refusal to edit, a false
 * negative costs a user their comments.
 */
export function looksLikeJsonc(text: string): boolean {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) return true;
  }
  return false;
}

/** The two-space-indented JSON potsherd writes, matching Claude Code's own style. */
export function stringifySettings(json: Record<string, unknown>): string {
  return JSON.stringify(json, null, 2) + '\n';
}

/** `settings.json.potsherd-bak-2026-08-21T09-14-03Z` next to the original. */
export function backupPath(p: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
  return `${p}.potsherd-bak-${stamp}`;
}

export function writeSettingsWithBackup(
  p: string,
  json: Record<string, unknown>,
  now = new Date(),
): { backup: string | null } {
  let backup: string | null = null;
  if (fs.existsSync(p)) {
    backup = backupPath(p, now);
    fs.copyFileSync(p, backup);
  } else {
    fs.mkdirSync(path.dirname(p), { recursive: true });
  }
  fs.writeFileSync(p, stringifySettings(json), { mode: 0o600 });
  return { backup };
}

/** A minimal unified diff, so consent is informed rather than assumed. */
export function unifiedDiff(before: string, after: string, label: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const out: string[] = [`--- ${label}`, `+++ ${label}`];
  // Longest common prefix / suffix is enough: our edits are a single key.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  const ctx = 3;
  const from = Math.max(0, start - ctx);
  const toA = Math.min(a.length - 1, endA + ctx);
  const toB = Math.min(b.length - 1, endB + ctx);
  out.push(`@@ -${from + 1},${toA - from + 1} +${from + 1},${toB - from + 1} @@`);
  for (let i = from; i < start; i++) out.push(' ' + a[i]);
  for (let i = start; i <= endA; i++) out.push('-' + a[i]);
  for (let i = start; i <= endB; i++) out.push('+' + b[i]);
  for (let i = endA + 1; i <= toA; i++) out.push(' ' + a[i]);
  return out.join('\n');
}

import fs from 'node:fs';
import { claudePaths } from './paths.js';
import {
  POTSHERD_CLEANUP_DAYS,
  readCleanupStatus,
  stringifySettings,
  unifiedDiff,
  writeSettingsWithBackup,
  type CleanupStatus,
} from './claude/settings.js';

/**
 * The one place in potsherd that can write outside ~/.potsherd, and the only
 * two things it can write: `cleanupPeriodDays`, and one SessionStart hook entry
 * whose command is a `potsherd rescue`.
 *
 * Every function here returns a *proposal* — the before text, the after text,
 * and a diff. Applying it is a separate call that the CLI makes only after a
 * `y`. Nothing in this module reads stdin; consent is the caller's business, so
 * a library user can never be tricked into a silent write.
 */

export interface SettingsProposal {
  path: string;
  before: string;
  after: string;
  diff: string;
  /** False when the file is JSONC, unparseable, or overridden by policy. */
  safe: boolean;
  reason?: string;
  /** True when the change is already in place. */
  noop: boolean;
}

export const GUARD_COMMAND = 'potsherd rescue --yes --quiet --no-settings';
const GUARD_MATCHER = 'startup|resume';
const GUARD_MARKER = 'potsherd rescue';

export function proposeCleanupPeriod(
  dir?: string,
  days = POTSHERD_CLEANUP_DAYS,
  status?: CleanupStatus,
): SettingsProposal {
  const st = status ?? readCleanupStatus(dir);
  const p = claudePaths(dir).settings;
  const before = st.files.user.text ?? '{}\n';

  if (!st.editable) {
    return {
      path: p,
      before,
      after: before,
      diff: '',
      safe: false,
      reason: st.reason ?? 'settings.json cannot be edited safely',
      noop: false,
    };
  }
  const json: Record<string, unknown> = st.files.user.json
    ? structuredClone(st.files.user.json)
    : {};
  if (json['cleanupPeriodDays'] === days) {
    return { path: p, before, after: before, diff: '', safe: true, noop: true };
  }
  json['cleanupPeriodDays'] = days;
  const after = stringifySettings(json);
  return {
    path: p,
    before,
    after,
    diff: unifiedDiff(before, after, shortPath(p)),
    safe: true,
    noop: false,
  };
}

export interface HookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string; timeout?: number }[];
}

export function proposeGuardHook(
  dir?: string,
  opts: { remove?: boolean; command?: string } = {},
): SettingsProposal {
  const st = readCleanupStatus(dir);
  const p = claudePaths(dir).settings;
  const before = st.files.user.text ?? '{}\n';

  if (st.files.user.exists && (st.files.user.parseError || st.files.user.jsonc)) {
    return {
      path: p,
      before,
      after: before,
      diff: '',
      safe: false,
      reason: st.files.user.jsonc
        ? `${p} contains comments, so rewriting it as JSON would drop them`
        : `${p} is not valid JSON (${st.files.user.parseError})`,
      noop: false,
    };
  }

  const json: Record<string, unknown> = st.files.user.json
    ? structuredClone(st.files.user.json)
    : {};
  const hooks = (json['hooks'] ??= {}) as Record<string, unknown>;
  const list = Array.isArray(hooks['SessionStart']) ? [...(hooks['SessionStart'] as HookEntry[])] : [];

  const isOurs = (e: HookEntry) =>
    (e.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes(GUARD_MARKER));
  const already = list.some(isOurs);

  if (opts.remove) {
    if (!already) return { path: p, before, after: before, diff: '', safe: true, noop: true };
    const kept = list.filter((e) => !isOurs(e));
    if (kept.length) hooks['SessionStart'] = kept;
    else delete hooks['SessionStart'];
    if (Object.keys(hooks).length === 0) delete json['hooks'];
  } else {
    if (already) return { path: p, before, after: before, diff: '', safe: true, noop: true };
    // Append, never replace: users have their own SessionStart hooks and this
    // must sit beside them.
    list.push({
      matcher: GUARD_MATCHER,
      hooks: [{ type: 'command', command: opts.command ?? GUARD_COMMAND, timeout: 10 }],
    });
    hooks['SessionStart'] = list;
  }

  const after = stringifySettings(json);
  return {
    path: p,
    before,
    after,
    diff: unifiedDiff(before, after, shortPath(p)),
    safe: true,
    noop: false,
  };
}

export function guardInstalled(dir?: string): boolean {
  const st = readCleanupStatus(dir);
  const hooks = st.files.user.json?.['hooks'] as Record<string, unknown> | undefined;
  const list = hooks?.['SessionStart'];
  if (!Array.isArray(list)) return false;
  return (list as HookEntry[]).some((e) =>
    (e.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes(GUARD_MARKER)),
  );
}

export function applyProposal(
  proposal: SettingsProposal,
  now = new Date(),
): { written: boolean; backup: string | null } {
  if (!proposal.safe) throw new Error(proposal.reason ?? 'refusing to write settings');
  if (proposal.noop) return { written: false, backup: null };
  const parsed: unknown = JSON.parse(proposal.after);
  if (!parsed || typeof parsed !== 'object') throw new Error('refusing to write non-object settings');
  const { backup } = writeSettingsWithBackup(proposal.path, parsed as Record<string, unknown>, now);
  return { written: true, backup };
}

/** Manual instructions, printed whenever potsherd refuses to edit the file. */
export function manualInstructions(
  proposal: SettingsProposal,
  what: 'cleanup' | 'guard',
  days = POTSHERD_CLEANUP_DAYS,
): string[] {
  const lines = [`potsherd did not edit ${shortPath(proposal.path)}: ${proposal.reason}`, ''];
  if (what === 'cleanup') {
    lines.push('to keep your sessions, add this key by hand:', '', `  "cleanupPeriodDays": ${days}`);
  } else {
    lines.push('to install the guard by hand, add to "hooks":', '');
    lines.push(
      ...JSON.stringify(
        { SessionStart: [{ matcher: GUARD_MATCHER, hooks: [{ type: 'command', command: GUARD_COMMAND, timeout: 10 }] }] },
        null,
        2,
      )
        .split('\n')
        .map((l) => '  ' + l),
    );
  }
  return lines;
}

function shortPath(p: string): string {
  const h = process.env.HOME ?? '';
  return h && p.startsWith(h) ? '~' + p.slice(h.length) : p;
}

export function settingsExists(dir?: string): boolean {
  return fs.existsSync(claudePaths(dir).settings);
}

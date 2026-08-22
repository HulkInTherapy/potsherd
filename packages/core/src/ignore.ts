import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db.js';
import { configPath, expandTilde, potsherdDir } from './paths.js';
import type { SearchFilters } from './search/filters.js';

/**
 * The ignore list: projects you do not want in `ls`, `find`, `ask` or `stats`.
 *
 * **Why it exists.** On the reference machine 9 of the top 15 `ls` rows are
 * potsherd's own worker and sdk sessions, and `find pgbouncer` returns
 * potsherd's own test sessions before the user's. Every user who builds
 * potsherd from a checkout hits a milder version of that, and every developer
 * running agents across many repos hits it whatever they build. The archive is
 * not wrong — it is complete, and completeness is what buries the answer.
 *
 * **Three rules this module is built to keep.**
 *
 *   1. **Nothing is ignored by default.** There is no shipped list, no
 *      "this looks like a build directory" heuristic, and no auto-detection.
 *      The user names what they ignore, with `potsherd ignore <project>`, and
 *      `potsherd unignore <project>` takes it back. A tool that decided on its
 *      own which of your work did not count would be making a claim about your
 *      history it has no standing to make.
 *
 *   2. **An ignore list is never silent.** Every surface that drops rows says
 *      so and says how many — `ls`, `find` and `stats` each print one line
 *      naming the count and the flag that undoes it. A filter the user cannot
 *      see is a claim about their archive the product cannot support: "you
 *      have 12 sessions about pgbouncer" is a different sentence from "you
 *      have 12 sessions about pgbouncer, outside the projects you told me to
 *      skip". `doctor` prints the whole list, always.
 *
 *   3. **Ignoring is a view, not a deletion.** `index` keeps indexing
 *      everything, `rescue` keeps rescuing everything, `show <id>` still shows
 *      an ignored session, and `--all` brings every row back on the surfaces
 *      that hide them. Nothing here ever deletes a row or skips a file.
 *
 * **Storage** is `~/.potsherd/config.json`, whose path `paths.configPath()`
 * has always resolved. The file is potsherd's own — the first thing potsherd
 * writes there that a user is expected to edit — so the writer preserves every
 * key it does not own and the reader survives a file that has been hand-edited
 * into nonsense.
 */

/** The key this module owns inside `config.json`. Everything else is left alone. */
export const IGNORE_KEY = 'ignore';

export interface IgnoreConfig {
  /** The list as stored, in the order it was written. */
  list: string[];
  /** Every other key in the file, preserved across writes. */
  rest: Record<string, unknown>;
  /**
   * Set when the file exists and could not be understood. The list is then
   * empty — but `doctor` says the file is unreadable rather than reporting an
   * empty list, because "you ignore nothing" and "I could not read your
   * settings" are different facts and only one of them is actionable.
   */
  error?: string;
  /** The file this came from, whether or not it exists. */
  file: string;
}

/**
 * Read `<root>/config.json`.
 *
 * A missing file is not an error: it is the normal state of a fresh install
 * and means an empty list. A malformed one is reported rather than repaired —
 * this file belongs to the user once they have opened it.
 */
export function readIgnoreConfig(root: string = potsherdDir()): IgnoreConfig {
  const file = configPath(root);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { list: [], rest: {}, file };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { list: [], rest: {}, file, error: 'config.json is not valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { list: [], rest: {}, file, error: 'config.json is not a JSON object' };
  }
  const record = parsed as Record<string, unknown>;
  const { [IGNORE_KEY]: raw, ...rest } = record;
  if (raw === undefined) return { list: [], rest, file };
  if (!Array.isArray(raw)) {
    return { list: [], rest, file, error: `config.json "${IGNORE_KEY}" is not an array` };
  }
  const list: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const entry = normalizeIgnoreEntry(value);
    if (entry && !list.some((e) => sameEntry(e, entry))) list.push(entry);
  }
  return { list, rest, file };
}

/** Just the list. The shape every caller inside the engine wants. */
export function readIgnoreList(root: string = potsherdDir()): string[] {
  return readIgnoreConfig(root).list;
}

/**
 * Write the list back, preserving every other key.
 *
 * Written to a sibling temp file and renamed, so a crash mid-write leaves the
 * old config rather than half of a new one, and created 0600 because
 * `~/.potsherd` holds copies of transcripts and this file sits beside them.
 */
export function writeIgnoreList(root: string, list: readonly string[]): string[] {
  const current = readIgnoreConfig(root);
  const clean: string[] = [];
  for (const value of list) {
    const entry = normalizeIgnoreEntry(value);
    if (entry && !clean.some((e) => sameEntry(e, entry))) clean.push(entry);
  }
  const next = { ...current.rest, [IGNORE_KEY]: clean };
  const file = current.file;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${String(process.pid)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return clean;
}

export interface IgnoreChange {
  /** The list after the change. */
  list: string[];
  /** The entry as it was stored or removed, normalised. */
  entry: string;
  /** False when the entry was already there (`ignore`) or absent (`unignore`). */
  changed: boolean;
}

/** `potsherd ignore <project>`. Idempotent, and says so rather than pretending. */
export function addIgnored(root: string, project: string): IgnoreChange {
  const entry = normalizeIgnoreEntry(project);
  if (!entry) throw new Error('an ignore entry needs at least one character that is not a slash');
  const before = readIgnoreList(root);
  if (before.some((e) => sameEntry(e, entry))) return { list: before, entry, changed: false };
  const list = writeIgnoreList(root, [...before, entry]);
  return { list, entry, changed: true };
}

/** `potsherd unignore <project>`. */
export function removeIgnored(root: string, project: string): IgnoreChange {
  const entry = normalizeIgnoreEntry(project);
  if (!entry) throw new Error('an ignore entry needs at least one character that is not a slash');
  const before = readIgnoreList(root);
  if (!before.some((e) => sameEntry(e, entry))) return { list: before, entry, changed: false };
  const list = writeIgnoreList(
    root,
    before.filter((e) => !sameEntry(e, entry)),
  );
  return { list, entry, changed: true };
}

/**
 * What the user typed, as it will be stored.
 *
 * `~` is expanded because a stored `~/code/potsherd` would never match a
 * project recorded as `/Users/me/code/potsherd`, and a trailing slash is
 * dropped because `potsherd/` and `potsherd` are the same directory to
 * everyone except a string comparison.
 */
export function normalizeIgnoreEntry(value: string): string {
  const trimmed = expandTilde(value.trim());
  return trimmed.replace(/[\\/]+$/, '');
}

function fold(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function sameEntry(a: string, b: string): boolean {
  return fold(a) === fold(b);
}

/**
 * Does this entry name this project?
 *
 * Two forms, and the difference is whether the user typed a slash.
 *
 *   `potsherd`                a **path segment**. Matches
 *                             `/Users/me/randomness/potsherd` and everything
 *                             under it, including
 *                             `/Users/me/randomness/potsherd/wt/w3-ignore`.
 *                             It does **not** match `potsherd-notes`: the
 *                             segment must be the whole segment, or `ignore
 *                             core` would hide `core-app` and the user would
 *                             have no way to tell it had.
 *
 *   `~/randomness/potsherd`   a **path**. Matches that directory and its
 *                             descendants, and nothing else. This is the form
 *                             to reach for when the same directory name
 *                             appears in two places and only one of them is
 *                             noise.
 *
 * The segment form is the default because it is the one that works: potsherd's
 * own sessions on the reference machine are spread across the checkout, six
 * git worktrees and a `.claude/worktrees/agent-*` directory, and a rule that
 * matched only the exact path the user typed would hide one of eight.
 */
export function matchesIgnoreEntry(project: string | null | undefined, entry: string): boolean {
  if (!project) return false;
  const p = fold(project);
  const e = fold(entry);
  if (!p || !e) return false;
  if (p === e) return true;
  if (e.includes('/')) return p.startsWith(`${e}/`);
  return p.split('/').filter(Boolean).includes(e);
}

/** True when any entry in the list names this project. */
export function isIgnoredProject(
  project: string | null | undefined,
  entries: readonly string[],
): boolean {
  return entries.some((entry) => matchesIgnoreEntry(project, entry));
}

/**
 * `<root>` for an open database, so a core function that was handed only a
 * `Db` can still find the config beside it.
 *
 * This matters because `ask` reaches `recall` without passing a root through
 * every layer, and an ignore list `ls` honours but `ask` does not would be
 * worse than no ignore list at all. `PRAGMA database_list` names the file the
 * connection actually opened — not the file some caller believes it opened —
 * so a test pointing at a temp directory and a user pointing at `~/.potsherd`
 * are answered the same way. An in-memory database has no file and returns
 * null, which is the honest answer: it has no config.
 */
export function rootForDb(db: Db): string | null {
  try {
    const rows = db.prepare('PRAGMA database_list').all() as {
      name?: string;
      file?: string;
    }[];
    const main = rows.find((r) => r.name === 'main') ?? rows[0];
    const file = main?.file;
    if (!file) return null;
    return path.dirname(file);
  } catch {
    return null;
  }
}

/**
 * The project values **in this index** that the list names.
 *
 * The predicate is a rule about paths; SQL needs a set of literals. Resolving
 * the rule against the projects that actually exist gives both — a bound
 * `NOT IN (?, ?)` that any of the three filter builders can carry, and the
 * exact list of what is being hidden, which is what the surfaces print.
 */
export function ignoredProjectsInIndex(db: Db, entries: readonly string[]): string[] {
  if (entries.length === 0) return [];
  let rows: { project: string | null }[] = [];
  try {
    rows = db
      .prepare(
        `SELECT DISTINCT project FROM (
            SELECT project FROM sessions WHERE project IS NOT NULL
            UNION
            SELECT project FROM ghosts   WHERE project IS NOT NULL
         )`,
      )
      .all() as { project: string | null }[];
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const r of rows) {
    if (r.project && isIgnoredProject(r.project, entries)) out.push(r.project);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export interface IgnoreOptions {
  /** `--all`: show everything. The list is read but not applied. */
  all?: boolean;
  /** potsherd root. Falls back to the database's own directory. */
  root?: string;
  /** Entries to use instead of reading the config. Tests, and `--json` echo. */
  entries?: readonly string[];
}

export interface IgnoreApplication {
  /** The filters to run, with `excludeProjects` set when the list applies. */
  filters: SearchFilters;
  /** What the config holds, whether or not it was applied. */
  entries: string[];
  /** The project values excluded from this query. Empty when nothing applied. */
  projects: string[];
  /** True when rows were actually excluded. */
  applied: boolean;
  /** Why not, when `applied` is false and `entries` is not empty. */
  reason?: 'all' | 'named-project' | 'no-match';
}

/**
 * Fold the ignore list into a set of filters, once, at the top of a verb.
 *
 * Two things deliberately switch it off:
 *
 *   **`--all`.** The escape hatch every surface names on screen.
 *
 *   **`--project X`.** Naming a project *is* asking for it. Hiding the rows
 *     someone has just asked for by name, and printing "12 hidden" under an
 *     empty table, is the ignore list arguing with its user.
 */
export function applyIgnore(
  db: Db,
  filters: SearchFilters = {},
  options: IgnoreOptions = {},
): IgnoreApplication {
  const root = options.root ?? rootForDb(db) ?? undefined;
  const entries = [...(options.entries ?? readIgnoreList(root ?? potsherdDir()))];
  if (entries.length === 0) return { filters, entries, projects: [], applied: false };
  if (options.all) return { filters, entries, projects: [], applied: false, reason: 'all' };
  if (filters.project) {
    return { filters, entries, projects: [], applied: false, reason: 'named-project' };
  }
  const projects = ignoredProjectsInIndex(db, entries);
  if (projects.length === 0) {
    return { filters, entries, projects: [], applied: false, reason: 'no-match' };
  }
  return { filters: { ...filters, excludeProjects: projects }, entries, projects, applied: true };
}

/**
 * What a surface reports about the rows it dropped.
 *
 * Carried on `ListResult`, `RecallResult` and `StatsReport` so the renderers
 * and `--json` read one shape, and so a `--json` consumer can tell "no
 * results" apart from "no results outside your ignore list".
 */
export interface IgnoreReport {
  /** The list as configured. */
  entries: string[];
  /** The project values actually excluded. */
  projects: string[];
  /**
   * How much the list cost, **in the units the surface reporting it uses**,
   * and 0 whenever the list did not apply.
   *
   *   `ls`     rows dropped from *this* listing — the ones that matched every
   *            other filter and lost only on their project.
   *   `find`   sessions in the ignored projects that were not searched.
   *   `stats`  sessions and ghosts left out of the counts.
   *
   * Each surface names its unit on screen; they are not interchangeable and
   * nothing should add them together.
   */
  hidden: number;
}

/**
 * Sessions and ghosts belonging to the ignored projects, for the surfaces that
 * report what they did not look at rather than what they dropped.
 *
 * Top-level sessions only: a subagent transcript is not a row anybody counts,
 * and `197 sessions not searched` on a machine with 30 conversations would be
 * a true number that misinforms every reader of it.
 */
export function countIgnoredSessions(db: Db, projects: readonly string[]): number {
  if (projects.length === 0) return 0;
  const marks = projects.map(() => '?').join(', ');
  try {
    const row = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM sessions
                   WHERE is_sidechain = 0 AND project IN (${marks}))
              + (SELECT COUNT(*) FROM ghosts WHERE project IN (${marks})) AS n`,
      )
      .get(...projects, ...projects) as { n: number };
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

export function emptyIgnoreReport(entries: readonly string[] = []): IgnoreReport {
  return { entries: [...entries], projects: [], hidden: 0 };
}

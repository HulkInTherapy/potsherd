import { db as store, fitLine, format as fmt, paths, search as searchNs } from '@potsherd/core';

// Same reasoning as `doctor.ts`: the ignore list is filter vocabulary, and the
// core barrel is reserved. See `packages/core/src/search/index.ts`.
const { addIgnored, countIgnoredSessions, ignoredProjectsInIndex, readIgnoreConfig, removeIgnored } =
  searchNs;
import fs from 'node:fs';
import { print, printJson, themeFrom, UserError, type GlobalOptions } from '../output.js';

export interface IgnoreCommandOptions extends GlobalOptions {
  /** The project the user named. Omitted for the bare `potsherd ignore`. */
  project?: string;
  /** `unignore` is the same verb with this set. */
  remove?: boolean;
}

/**
 * `potsherd ignore <project>` / `potsherd unignore <project>` — and, with no
 * argument, the list itself.
 *
 * **The problem it exists for.** On the reference machine 9 of the top 15 `ls`
 * rows are potsherd's own worker and sdk sessions and `find pgbouncer` returns
 * potsherd's own test sessions first. Nothing is broken: the archive is
 * complete, and completeness is what buries the user's own work under the
 * work of whatever they last built. Every user who builds potsherd from a
 * checkout hits a milder version of it, and every developer running agents
 * across several repos hits it whatever they build.
 *
 * **Three rules the verb keeps** (`packages/core/src/ignore.ts` has them at
 * length, and the code that enforces them):
 *
 *   - *nothing is ignored by default.* No shipped list and no "this looks like
 *     a build directory" guess. You name it or it is not ignored.
 *   - *ignoring is never silent.* `ls`, `find` and `stats` each print how many
 *     rows the list cost them, and `doctor` prints the whole list.
 *   - *ignoring is a view, not a deletion.* `index` still indexes it, `rescue`
 *     still rescues it, `show <id>` still shows it, and `--all` brings it back.
 *
 * It is modelled on `pin`: one small verb, a stored side effect, and a receipt
 * that says what changed and what to run next. Like `pin` it is idempotent and
 * says so rather than pretending it did something.
 */
export async function runIgnore(o: IgnoreCommandOptions): Promise<number> {
  const verb = o.remove ? 'unignore' : 'ignore';
  const root = paths.potsherdDir(o.potsherdDir);
  const before = readIgnoreConfig(root);
  if (before.error) {
    throw new UserError(
      `${paths.tildify(before.file)}: ${before.error}`,
      `open it and fix it, or delete it — potsherd will write a new one`,
    );
  }

  const named = o.project?.trim();
  if (!named) {
    return show(o, root, before.list, verb);
  }

  const change = o.remove ? removeIgnored(root, named) : addIgnored(root, named);
  const matched = projectsFor(root, change.list);

  if (o.json) {
    printJson({
      verb,
      entry: change.entry,
      changed: change.changed,
      ignore: change.list,
      projects: matched.projects,
      sessions: matched.sessions,
      config: before.file,
    });
    return 0;
  }

  const t = themeFrom(o);
  const lines = [
    t.dim(fmt.clip(`potsherd ${verb} ${t.sep} ${change.entry}`, t.width, t)),
    '',
  ];

  if (o.remove) {
    lines.push(`  ${change.changed ? 'no longer ignored' : t.dim('was not ignored')}`);
  } else {
    lines.push(`  ${change.changed ? 'ignored' : t.dim('already ignored')}`);
  }

  // What it costs, in the same breath as the change: a list that took 41 rows
  // off `ls` and said nothing would be exactly the silent filter this verb is
  // written not to be.
  if (matched.projects.length > 0) {
    const n = matched.sessions;
    lines.push(
      `  ${t.dim(
        `${fmt.num(matched.projects.length)} ${fmt.plural(matched.projects.length, 'project')} in the index ${t.sep} ${fmt.num(n)} ${fmt.plural(n, 'session')} hidden from ls, find, ask and stats`,
      )}`,
    );
  } else if (!o.remove) {
    // Naming something the index has never seen is nearly always a typo, and
    // an ignore list that quietly accepts one is a list the user believes is
    // working when it is not.
    lines.push(`  ${t.dim('nothing in the index matches it yet')}`);
  }

  lines.push('');
  lines.push(
    fitLine(
      t,
      `${t.dim('run')}  potsherd ls --all  ${t.dim('to see everything again, or  potsherd doctor  for the list')}`,
      `${t.dim('run')}  potsherd ls --all  ${t.dim('to see everything again')}`,
      `${t.dim('run')}  potsherd ls --all`,
    ),
  );
  print(lines.join('\n'));
  return 0;
}

/** `potsherd ignore` with no argument: the list, and what it hides. */
function show(o: IgnoreCommandOptions, root: string, list: string[], verb: string): number {
  const matched = projectsFor(root, list);
  if (o.json) {
    printJson({
      verb,
      ignore: list,
      projects: matched.projects,
      sessions: matched.sessions,
      config: paths.configPath(root),
    });
    return 0;
  }

  const t = themeFrom(o);
  const lines = [t.dim(fmt.clip(`potsherd ignore ${t.sep} ${paths.tildify(paths.configPath(root))}`, t.width, t)), ''];
  if (list.length === 0) {
    lines.push('  nothing is ignored');
    lines.push('');
    lines.push(
      fitLine(
        t,
        `${t.dim('run')}  potsherd ignore <project>  ${t.dim('to keep a project out of ls, find, ask and stats')}`,
        `${t.dim('run')}  potsherd ignore <project>  ${t.dim('to keep it out of ls and find')}`,
        `${t.dim('run')}  potsherd ignore <project>`,
      ),
    );
    print(lines.join('\n'));
    return 0;
  }

  for (const entry of list) lines.push(`  ${fmt.clip(entry, t.width - 2, t)}`);
  lines.push('');
  const n = matched.sessions;
  lines.push(
    `  ${t.dim(
      `${fmt.num(matched.projects.length)} ${fmt.plural(matched.projects.length, 'project')} in the index ${t.sep} ${fmt.num(n)} ${fmt.plural(n, 'session')} hidden`,
    )}`,
  );
  lines.push('');
  lines.push(
    fitLine(
      t,
      `${t.dim('run')}  potsherd unignore <project>  ${t.dim('to take one back, or  potsherd ls --all')}`,
      `${t.dim('run')}  potsherd unignore <project>  ${t.dim('to take one back')}`,
      `${t.dim('run')}  potsherd unignore <project>`,
    ),
  );
  print(lines.join('\n'));
  return 0;
}

/**
 * Which projects in the index the list actually names, and how many sessions
 * that is.
 *
 * The index is opened read-only and its absence is not an error: `ignore` is a
 * config verb and must work before anything has ever been indexed — that is
 * precisely when a user is setting the tool up. Without a database the receipt
 * says what it stored and nothing about what it hides, which is all it knows.
 */
function projectsFor(root: string, list: readonly string[]): { projects: string[]; sessions: number } {
  const file = paths.dbPath(root);
  if (list.length === 0 || !fs.existsSync(file)) return { projects: [], sessions: 0 };
  let db;
  try {
    db = store.open({ root, readonly: true });
  } catch {
    return { projects: [], sessions: 0 };
  }
  try {
    const projects = ignoredProjectsInIndex(db, list);
    return { projects, sessions: countIgnoredSessions(db, projects) };
  } catch {
    return { projects: [], sessions: 0 };
  } finally {
    db.close();
  }
}

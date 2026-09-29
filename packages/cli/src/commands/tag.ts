import {
  allTags,
  applyTags,
  fitLine,
  format as fmt,
  parseTagArgs,
  sessionTags,
  Theme,
  type db as dbNs,
  idTag,
} from '@potsherd/core';
import { print, printJson, themeFrom, UserError, type GlobalOptions } from '../output.js';
import { openIndex } from '../filters.js';
import { mustResolve } from '../session-ref.js';

export interface TagCommandOptions extends GlobalOptions {
  session: string;
  /** `+postgres`, `-infra`, or a bare word (which means add). */
  ops: string[];
}

/**
 * `potsherd tag <session> +tag -tag …` — add and remove in one invocation.
 *
 * One invocation because that is how people think about it: "postgres, not
 * mysql" is a single correction, and making it two commands invites a machine
 * to be left tagged both ways. The two writes go into one transaction for the
 * same reason.
 *
 * With no `+`/`-` argument it lists what the session already carries, so
 * `potsherd tag 9c4d2f18` is a safe thing to type when you cannot remember.
 */
export async function runTag(o: TagCommandOptions): Promise<number> {
  const { db } = openIndex(o);
  try {
    const found = mustResolve(db, o.session, 'tag');
    const t = themeFrom(o);

    if (o.ops.length === 0) {
      const tags = sessionTags(db, found.id);
      if (o.json) {
        printJson({ session: summary(found), tags, added: [], removed: [], unchanged: [], rejected: [] });
        return 0;
      }
      print(listing(t, found, tags));
      return 0;
    }

    const { add, remove, rejected } = parseTagArgs(o.ops);
    if (rejected.length > 0 && add.length === 0 && remove.length === 0) {
      throw new UserError(
        `nothing usable in ${rejected.map((r) => `"${r}"`).join(', ')} — a tag is letters, digits, - . _ or /`,
        `potsherd tag ${idTag(found.id)} +postgres -mysql`,
      );
    }

    const result = applyTags(db, found.id, { add, remove });

    if (o.json) {
      printJson({
        session: summary(found),
        tags: result.tags,
        added: result.added,
        removed: result.removed,
        unchanged: result.unchanged,
        rejected,
      });
      return 0;
    }

    print(receipt(t, found, result, rejected, db));
    return 0;
  } finally {
    db.close();
  }
}

function summary(found: { id: string; kind: string; title: string }): {
  id: string;
  kind: string;
  title: string;
} {
  return { id: found.id, kind: found.kind, title: found.title };
}

function heading(t: Theme, verb: string, found: { id: string; title: string }): string {
  return t.dim(
    fmt.clip(`potsherd ${verb} ${t.sep} ${idTag(found.id)} ${t.sep} ${found.title}`, t.width, t),
  );
}

function tagList(tags: readonly string[]): string {
  return tags.map((tag) => `#${tag}`).join(' ');
}

function listing(t: Theme, found: { id: string; title: string }, tags: string[]): string {
  const lines = [heading(t, 'tag', found), ''];
  if (tags.length === 0) {
    lines.push(`  ${t.dim('no tags yet.')}`);
    lines.push('');
    lines.push(
      fitLine(
        t,
        `${t.dim('run')}  potsherd tag ${idTag(found.id)} +postgres  ${t.dim('to add one')}`,
        `${t.dim('run')}  potsherd tag ${idTag(found.id)} +postgres`,
      ),
    );
    return lines.join('\n');
  }
  lines.push(`  ${fmt.clip(tagList(tags), t.width - 2, t)}`);
  lines.push('');
  lines.push(
    fitLine(
      t,
      `${t.dim('run')}  potsherd ls --tag ${tags[0]}  ${t.dim('to list everything carrying it')}`,
      `${t.dim('run')}  potsherd ls --tag ${tags[0]}`,
    ),
  );
  return lines.join('\n');
}

function receipt(
  t: Theme,
  found: { id: string; title: string },
  result: { tags: string[]; added: string[]; removed: string[]; unchanged: string[] },
  rejected: string[],
  db: dbNs.Db,
): string {
  const lines = [heading(t, 'tag', found), ''];

  // What changed, in the syntax that changed it — so the line can be re-read
  // as the command that produced it.
  const changes: string[] = [
    ...result.added.map((tag) => t.ok(`+${tag}`)),
    ...result.removed.map((tag) => t.warn(`-${tag}`)),
  ];
  if (changes.length > 0) lines.push('  ' + changes.join(' '));
  else lines.push(`  ${t.dim('nothing changed — it was already like that.')}`);

  if (rejected.length > 0) {
    lines.push(
      `  ${t.dim(fmt.clip(`ignored ${rejected.map((r) => `"${r}"`).join(', ')}: not a tag`, t.width - 2, t))}`,
    );
  }

  lines.push('');
  lines.push(
    '  ' +
      t.dim('tags  ') +
      fmt.clip(result.tags.length ? tagList(result.tags) : t.dash, t.width - 8, t),
  );

  // How many other sessions share the tag just added: the number that tells
  // you whether the tag is doing any work.
  const pivot = result.added[0] ?? result.tags[0];
  lines.push('');
  if (pivot) {
    const n = allTags(db).find((row) => row.tag === pivot)?.sessions ?? 1;
    lines.push(
      fitLine(
        t,
        `${t.dim('run')}  potsherd ls --tag ${pivot}  ${t.dim(`to list all ${fmt.num(n)} ${fmt.plural(n, 'session')} carrying it`)}`,
        `${t.dim('run')}  potsherd ls --tag ${pivot}  ${t.dim(`${fmt.num(n)} ${fmt.plural(n, 'session')}`)}`,
        `${t.dim('run')}  potsherd ls --tag ${pivot}`,
      ),
    );
  } else {
    lines.push(
      fitLine(
        t,
        `${t.dim('run')}  potsherd ls  ${t.dim('to see the archive')}`,
        `${t.dim('run')}  potsherd ls`,
      ),
    );
  }
  return lines.join('\n');
}

/**
 * Pull `+postgres` / `-infra` out of argv before commander ever sees them.
 *
 * `-infra` is, to any getopt-shaped parser, the short flags `-i -n -f -r -a`;
 * `-v2` is `--version`, and `potsherd tag <id> -v2` would have printed the
 * version number and exited zero. Commander's `allowUnknownOption` fixes the
 * first case and not the second, because the program's own short flags are
 * matched before the subcommand's arguments are.
 *
 * So the tag operands are removed from argv here, by a rule small enough to
 * state in full: **after the session id, every token that does not begin with
 * `--`, and is not the value of a global flag, is a tag operand.** Long flags
 * stay in argv, which means an unknown one is still reported as an unknown
 * option rather than silently becoming a tag.
 */
const GLOBAL_WITH_VALUE = new Set(['--width', '--claude-dir', '--potsherd-dir', '--note']);

export function splitTagOperands(argv: readonly string[]): { argv: string[]; ops: string[] } {
  const head = argv.slice(0, 2);
  const rest = argv.slice(2);
  const kept: string[] = [];
  const ops: string[] = [];

  let seenVerb = false;
  let seenSession = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '-h' || arg === '--help') {
      kept.push(arg);
      continue;
    }
    if (arg.startsWith('--')) {
      kept.push(arg);
      // `--width 60`: the 60 belongs to the flag, not to the tag list.
      if (GLOBAL_WITH_VALUE.has(arg) && i + 1 < rest.length) kept.push(rest[++i]!);
      continue;
    }
    if (!seenVerb) {
      if (arg.startsWith('-')) {
        kept.push(arg);
        continue;
      }
      // The first bare word is the verb. Anything but `tag` and this whole
      // rewrite is off — no other verb takes a `-word` argument.
      if (arg !== 'tag') return { argv: [...argv], ops: [] };
      seenVerb = true;
      kept.push(arg);
      continue;
    }
    if (!seenSession) {
      if (arg.startsWith('-')) {
        kept.push(arg);
        continue;
      }
      seenSession = true;
      kept.push(arg);
      continue;
    }
    ops.push(arg);
  }

  return { argv: [...head, ...kept], ops };
}

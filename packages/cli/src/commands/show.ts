import {
  displayTitleOf,
  format as fmt,
  renderShow,
  renderShowMarkdown,
  resolveSession,
  showSession,
  table,
} from '@potsherd/core';
import { print, printJson, themeFrom, UserError, type GlobalOptions } from '../output.js';
import { openIndex } from '../filters.js';

export interface ShowCommandOptions extends GlobalOptions {
  session: string;
  from?: unknown;
  to?: unknown;
  md?: boolean;
}

/**
 * `potsherd show` — one session, read end to end.
 *
 * Takes a full session id or any unambiguous prefix, because nobody retypes a
 * uuid; `find` and `ls` both print the first eight characters for exactly this.
 * An **ambiguous** prefix lists the candidates rather than picking the newest.
 * Showing someone the wrong conversation, confidently, is the one failure a
 * memory tool cannot recover from — so this is a hard rule, not a nicety.
 */
export async function runShow(o: ShowCommandOptions): Promise<number> {
  const ref = o.session?.trim();
  if (!ref) throw new UserError('show needs a session id', 'potsherd show 85ef9531');

  const { db } = openIndex(o);
  try {
    const found = resolveSession(db, ref);
    if (!found) {
      throw new UserError(
        `no session id starts with "${ref}"`,
        'potsherd ls    # the ids are the first column of  potsherd ls --json',
      );
    }
    if (found.ambiguous) {
      if (o.json) {
        printJson({ ambiguous: found.ambiguous });
        return 1;
      }
      const t = themeFrom(o);
      // The whole id, not a prefix: the reason these are ambiguous is that
      // their prefixes collide, so printing prefixes back would be useless.
      const rows = found.ambiguous.map((c) => [
        c.id,
        c.when ? fmt.shortDate(c.when) : '—',
        c.kind === 'ghost' ? 'ghost' : c.isSidechain ? 'subagent' : '',
        displayTitleOf(c.title, c.project, c.id),
      ]);
      const lines = [
        `"${ref}" matches ${found.ambiguous.length} sessions:`,
        '',
        ...table(t, rows, { gap: 2, grow: 3 }),
        '',
        `  ${t.dim('run')}  potsherd show ${found.ambiguous[0]!.id}`,
      ];
      print(lines.join('\n'));
      return 1;
    }

    const result = showSession(db, found.id, {
      ...(o.from !== undefined ? { from: Number(o.from) } : {}),
      ...(o.to !== undefined ? { to: Number(o.to) } : {}),
    });
    if (!result) {
      throw new UserError(`session ${found.id} is in the index but has no body`, 'potsherd index --full');
    }

    if (o.json) {
      printJson({
        session: result.session,
        from: result.from,
        to: result.to,
        total: result.total,
        exchanges: result.exchanges,
        ghostPrompts: result.ghostPrompts ?? null,
        children: result.children,
      });
      return 0;
    }
    if (o.md) {
      print(renderShowMarkdown(result));
      return 0;
    }
    print(renderShow(result, themeFrom(o)));
    return 0;
  } finally {
    db.close();
  }
}

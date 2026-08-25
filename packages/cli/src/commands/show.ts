import {
  displayTitleOf,
  format as fmt,
  renderShow,
  renderShowHtml,
  renderShowMarkdown,
  resolveSession,
  showSession,
  table,
  VERSION,
  idTag,
} from '@potsherd/core';
import { print, printJson, themeFrom, UserError, type GlobalOptions } from '../output.js';
import { openIndex } from '../filters.js';

export interface ShowCommandOptions extends GlobalOptions {
  session: string;
  from?: unknown;
  to?: unknown;
  md?: boolean;
  html?: boolean;
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
  if (!ref) throw new UserError('show needs a session id', 'potsherd show 9c4d2f18');

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
        // The fork/resume chain this transcript is a link in (`threads.ts`).
        //
        // `show` deliberately still renders **one transcript**: asked for a
        // session id it prints that session's exchanges and no others. What it
        // could not do before was say where the rest of the work went — an
        // agent reading four exchanges had no way to learn that 119 more sit
        // one hop away under a different id. `session.thread` is that pointer,
        // and it names every link so the next call can be made without a
        // search.
        thread: result.session.thread,
        // The whole card, not `cardTitle` and `cardSource`. A machine reader
        // asking `show --json` for a carded session was getting the two
        // fields the *title* needed and none of the card (T2.7 D3).
        card: result.card,
      });
      return 0;
    }
    if (o.md && o.html) {
      throw new UserError(
        'show takes --md or --html, not both',
        'potsherd show ' + idTag(found.id) + ' --html > session.html',
      );
    }
    if (o.md) {
      print(renderShowMarkdown(result));
      return 0;
    }
    if (o.html) {
      print(renderShowHtml(result, VERSION));
      return 0;
    }
    print(renderShow(result, themeFrom(o)));
    // VERIFICATION-8 C8-1 asked for a disclosure here — `show <parent-prefix>`
    // taking the parent "in silence, despite documenting any unambiguous
    // prefix". `renderShow` was already making it, in better words than a
    // second block would: the subagent block above this line names every
    // transcript the session spawned, by an `idTag` that resolves to it. On
    // the reference archive that block reads `40 subagent transcripts:  agent
    // <id8> · agent <id8> · …`. What the parent prefix opened has been on this
    // screen all along; what was wrong was the id in the citation, and that is
    // fixed where it is minted. The model door had no such block and now
    // carries the same fact in `potsherd_read`'s `note` (`tools/thread.ts`).
    return 0;
  } finally {
    db.close();
  }
}

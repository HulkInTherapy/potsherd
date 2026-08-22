import {
  fitLine,
  format as fmt,
  linkSessions,
  sessionLinks,
  Theme,
  unlinkSessions,
  renderSuggestions,
  suggestLinks,
} from '@potsherd/core';
import { print, printJson, themeFrom, UserError, type GlobalOptions } from '../output.js';
import { openIndex } from '../filters.js';
import { mustResolve, type ResolvedRef } from '../session-ref.js';

export interface LinkCommandOptions extends GlobalOptions {
  /** `--suggest` — propose cross-project links; writes nothing. */
  suggest?: boolean;
  a?: string;
  b?: string;
  note?: string;
  remove?: boolean;
}

/**
 * `potsherd link <a> <b> [--note "…"]` — "these two are the same thread".
 *
 * The link a memory tool cannot derive: two sessions in different projects, a
 * month apart, that were the same piece of thinking. Search will not connect
 * them (different words, different files) and neither will a card. Only the
 * person who lived through both knows, and this is where they say so.
 *
 * **Undirected in meaning, directed in storage.** The row records the pair as
 * the user typed it, because "I linked this to that" is a fact about what they
 * did — but every read looks at both columns, so `ls --linked-to <b>` finds
 * `a`. Linking a pair that is already linked the other way round updates that
 * row instead of writing a mirror; `(A,B)` and `(B,A)` both satisfy the
 * primary key, and two rows saying one thing is how this table always breaks.
 */
export async function runLink(o: LinkCommandOptions): Promise<number> {
  const verb = o.remove ? 'unlink' : 'link';
  const { db } = openIndex(o);
  try {
    // `--suggest` resolves no session reference, so it runs before the two
    // mustResolve calls. It proposes and never writes: phase 4 measured this
    // rule pass at 1-2 of 8 candidates worth raising, and renderSuggestions
    // prints that number rather than implying the list is all good.
    if (o.suggest) {
      const result = suggestLinks(db, {});
      if (o.json) {
        printJson(result);
        return 0;
      }
      for (const line of renderSuggestions(result, themeFrom(o), fmt.wrap)) print(line);
      return 0;
    }

    // `a` and `b` became optional so `--suggest` could take neither. A bare
    // `potsherd link` is now reachable and must say so rather than throw.
    if (!o.a || !o.b) {
      throw new UserError(
        'link needs two sessions',
        'potsherd link 4c9339e0 f1665f76   (or: potsherd link --suggest)',
      );
    }
    const a = mustResolve(db, o.a, verb);
    const b = mustResolve(db, o.b, verb);

    if (a.id === b.id) {
      throw new UserError(
        'a session cannot be linked to itself',
        `potsherd link ${a.id.slice(0, 8)} <other-id8>`,
      );
    }

    if (o.remove) {
      const removed = unlinkSessions(db, a.id, b.id);
      if (o.json) {
        printJson({ a: ref(a), b: ref(b), removed, links: sessionLinks(db, a.id) });
        return 0;
      }
      print(receipt(themeFrom(o), verb, a, b, removed ? 'unlinked' : 'they were not linked', null));
      return 0;
    }

    const note = o.note?.trim() ? o.note.trim() : null;
    const result = linkSessions(db, a.id, b.id, note);

    if (o.json) {
      printJson({
        a: ref(a),
        b: ref(b),
        note: result.note,
        createdAt: result.createdAt,
        created: result.created,
        // True when the pair was already recorded the other way round. The
        // link is one link either way; this says which row holds it.
        reversed: result.reversed,
        links: sessionLinks(db, a.id),
      });
      return 0;
    }

    const what = result.created
      ? 'linked'
      : result.reversed
        ? 'already linked (the other way round)'
        : 'already linked';
    print(receipt(themeFrom(o), verb, a, b, what, result.note));
    return 0;
  } finally {
    db.close();
  }
}

function ref(r: ResolvedRef): { id: string; kind: string; title: string } {
  return { id: r.id, kind: r.kind, title: r.title };
}

function receipt(
  t: Theme,
  verb: string,
  a: ResolvedRef,
  b: ResolvedRef,
  what: string,
  note: string | null,
): string {
  const lines = [t.dim(fmt.clip(`potsherd ${verb} ${t.sep} ${what}`, t.width, t)), ''];
  // Both titles, one per line: the whole value of a link is that you can read
  // what got joined without looking either id up.
  for (const side of [a, b]) {
    lines.push(
      '  ' +
        t.dim(side.id.slice(0, 8)) +
        '  ' +
        fmt.elide(side.title, Math.max(12, t.width - 12), t),
    );
  }
  if (note) {
    lines.push('');
    lines.push('  ' + t.dim(fmt.elide(`“${note}”`, t.width - 2, t)));
  }
  lines.push('');
  lines.push(
    fitLine(
      t,
      `${t.dim('run')}  potsherd ls --linked-to ${a.id.slice(0, 8)}  ${t.dim('to list both ends')}`,
      `${t.dim('run')}  potsherd ls --linked-to ${a.id.slice(0, 8)}`,
    ),
  );
  return lines.join('\n');
}

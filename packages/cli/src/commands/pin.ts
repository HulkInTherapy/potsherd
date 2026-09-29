import { fitLine, format as fmt, idTag, pinSession, sessionTags, Theme, unpinSession } from '@potsherd/core';
import { print, printJson, themeFrom, type GlobalOptions } from '../output.js';
import { openIndex } from '../filters.js';
import { mustResolve } from '../session-ref.js';

export interface PinCommandOptions extends GlobalOptions {
  session: string;
  /** `unpin` is the same verb with this set. */
  remove?: boolean;
}

/**
 * `potsherd pin <session>` / `potsherd unpin <session>`.
 *
 * A pin is the cheapest thing a user can say about a session and the most
 * durable: it survives re-indexing, re-carding and the harness deleting the
 * transcript, because `pins` keys on the session id and holds no foreign key
 * to a table a sweep can empty. **Pinning a ghost is allowed and deliberate** —
 * a session Claude Code already deleted is exactly the one worth marking.
 *
 * Pinning is idempotent and says so rather than pretending it did something:
 * the receipt gives the original `pinned_at`, so a second `pin` cannot quietly
 * rewrite when you first cared about a session.
 */
export async function runPin(o: PinCommandOptions): Promise<number> {
  const verb = o.remove ? 'unpin' : 'pin';
  const { db } = openIndex(o);
  try {
    const found = mustResolve(db, o.session, verb);
    const result = o.remove ? unpinSession(db, found.id) : pinSession(db, found.id);
    const tags = sessionTags(db, found.id);

    if (o.json) {
      printJson({
        session: { id: found.id, kind: found.kind, title: found.title },
        pinned: result.pinned,
        pinnedAt: result.pinnedAt,
        changed: result.changed,
        tags,
      });
      return 0;
    }

    const t = themeFrom(o);
    const lines = [
      t.dim(
        fmt.clip(
          `potsherd ${verb} ${t.sep} ${idTag(found.id)} ${t.sep} ${found.title}`,
          t.width,
          t,
        ),
      ),
      '',
    ];

    if (result.pinned) {
      const since = result.pinnedAt ? fmt.shortDateTime(result.pinnedAt) : '';
      lines.push(
        `  ${t.ok(t.star)} ${result.changed ? 'pinned' : t.dim('already pinned')}${since ? '  ' + t.dim(since) : ''}`,
      );
    } else {
      lines.push(`  ${result.changed ? 'unpinned' : t.dim('was not pinned')}`);
    }

    lines.push('');
    lines.push(
      fitLine(
        t,
        `${t.dim('run')}  potsherd ls --pinned  ${t.dim('to list everything you have kept')}`,
        `${t.dim('run')}  potsherd ls --pinned`,
      ),
    );
    print(lines.join('\n'));
    return 0;
  } finally {
    db.close();
  }
}

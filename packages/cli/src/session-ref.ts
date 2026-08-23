import { displayTitleOf, resolveSession, type db as dbNs } from '@potsherd/core';
import { UserError } from './output.js';

type Db = dbNs.Db;

export interface ResolvedRef {
  id: string;
  kind: 'session' | 'ghost';
  /** What `ls` would call it — for the receipt the writing verbs print. */
  title: string;
}

/**
 * The one resolver `tag`, `pin`, `unpin` and `link` share with `show`.
 *
 * Every verb that names a session takes the same eight characters `ls` and
 * `find` print, because nobody retypes a uuid. There is exactly one
 * implementation of what those eight characters mean
 * (`browse.ts`'s `resolveSession`), so `potsherd show 9c4d2f18` and
 * `potsherd tag 9c4d2f18` can never disagree about which session that is —
 * which they would within a week if this were written twice.
 *
 * What this adds is the failure side. A reference that resolves to nothing is
 * the commonest mistake at this surface, and it must say so and name the one
 * command that fixes it — never a stack trace, and never a silent write to a
 * session id that does not exist. `tags`, `pins` and `links` carry no foreign
 * key (a pin on a *deleted* session is the pin most worth having, and a ghost
 * has no row in `sessions`), so this check is the only thing standing between
 * a typo and a row nothing will ever read.
 */
export function mustResolve(db: Db, ref: string, verb: string): ResolvedRef {
  const needle = ref?.trim() ?? '';
  if (!needle) {
    throw new UserError(`${verb} needs a session id`, `potsherd ${verb} 9c4d2f18`);
  }

  const found = resolveSession(db, needle);
  if (!found) {
    throw new UserError(
      `no session in the index starts with "${needle}"`,
      'potsherd ls    # the ids are the first eight characters of  potsherd ls --json',
    );
  }
  if (found.ambiguous) {
    // The whole id, not a prefix: the reason these are ambiguous is that their
    // prefixes collide, so printing prefixes back would be useless.
    const shown = found.ambiguous
      .slice(0, 5)
      .map((c) => `${c.id}  ${displayTitleOf(c.title, c.project, c.id)}`)
      .join('\n        ');
    throw new UserError(
      `"${needle}" matches ${found.ambiguous.length} sessions:\n        ${shown}`,
      `potsherd ${verb} ${found.ambiguous[0]!.id}`,
    );
  }

  return { id: found.id, kind: found.kind, title: titleOf(db, found.id, found.kind) };
}

function titleOf(db: Db, id: string, kind: 'session' | 'ghost'): string {
  if (kind === 'ghost') {
    const row = db
      .prepare(
        `SELECT g.title AS title, g.project AS project,
                (SELECT p.text FROM ghost_prompts p WHERE p.session_id = g.session_id
                   AND p.text NOT LIKE '/%' AND length(trim(p.text)) > 3
                 ORDER BY p.seq LIMIT 1) AS best_prompt
           FROM ghosts g WHERE g.session_id = ?`,
      )
      .get(id) as { title: string | null; project: string | null; best_prompt: string | null } | undefined;
    const text = row?.title ?? row?.best_prompt ?? null;
    return displayTitleOf(text ? text.replace(/\s+/g, ' ').slice(0, 120) : null, row?.project ?? null, id);
  }
  // A card title beats the harness's, the same way it does in `ls`. `cards` is
  // empty until T2.2, so today this always falls through to `s.title`.
  const row = db
    .prepare(
      `SELECT COALESCE((SELECT c.title FROM cards c WHERE c.session_id = s.id), s.title) AS title,
              s.project AS project, s.harness AS harness
         FROM sessions s WHERE s.id = ?`,
    )
    .get(id) as { title: string | null; project: string | null; harness: string } | undefined;
  return displayTitleOf(row?.title ?? null, row?.project ?? null, id);
}

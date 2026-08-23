import { resolveSession, showSession, type db as dbNs } from '@potsherd/core';

type Db = dbNs.Db;

/**
 * T10.6 · F3 — the citation check, in code.
 *
 * The audit is the specification for this file, so it is quoted rather than
 * summarised:
 *
 * > Both of my runs cited repo markdown in the `SOURCES` block, in the correct
 * > format, with the session-id and exchange-count fields left as `—`. The
 * > format made the fabrication look like evidence. […] **A citation format
 * > that accepts unverified rows is worse than no format**, because it converts
 * > a guess into something that reads like a receipt.
 *
 * `filterAnswer` (`core/ask.ts`) already runs exactly this discipline one level
 * down: a `[id8@seq]` whose seq does not resolve against the transcript is
 * removed, and a line left holding no surviving citation goes with it. This is
 * the same rule at the level of the `SOURCES` block itself — an `id8` that does
 * not resolve against the index is not a citation, whatever it is wearing.
 *
 * Two halves, and both of them matter:
 *
 *   **mint** — {@link mintCitation} builds the source line from index rows.
 *   Every `potsherd_recall` row and every `potsherd_read` window carries one.
 *   A model that copies a minted line cannot invent a session, because it never
 *   composed the line in the first place.
 *
 *   **refuse** — {@link verifySources} takes prose that claims to carry source
 *   lines and drops every one whose first field is not an id8 that resolves.
 *   It runs on `potsherd_graft`'s reply on every call, and it is exported so
 *   that any surface which comes to hold a model's `SOURCES` block can run it
 *   without writing a second implementation of what a citation is.
 *
 * What this file deliberately does **not** claim: it cannot see text that never
 * enters this process. A subagent's report goes from the subagent to the main
 * loop without passing through potsherd, so the enforcement there is the
 * subagent's *tool list* — `Read` removed, so the repository is unreachable and
 * the audit's actual fabrication (`HANDOFF.md §3`) has no source to come from —
 * plus minted citations it can only copy. `T10.6-REPORT.md` says which of those
 * is code and which is prompt, in those words, because F3 is the proof that
 * prompts do not hold.
 */

/** The separator `05` uses between fields on every potsherd source line. */
export const SEP = ' · ';

/**
 * The syntactic gate: does this field even open with an id?
 *
 * Eight hex characters, which is what `ls` and `recall` print and what every
 * potsherd surface takes as a reference. It is a **prefix** test rather than a
 * whole-string one because a session id is not always eight characters and not
 * always only hex: a full uuid carries hyphens, and a subagent transcript is
 * addressed as `<parent-uuid>:agent-<hash>`. Requiring hex to the end refused
 * `graft`'s own `source: claude <full-uuid> · …` footer, which is a true line.
 *
 * Anything that clears this gate still has to resolve against the index; the
 * gate only decides whether the refusal reads `not-an-id` or `unresolved`.
 */
const ID8 = /^[0-9a-f]{8}/i;

export interface CitationFacts {
  sessionId: string;
  kind: 'session' | 'ghost';
  harness: string;
  project: string | null;
  exchanges: number;
  prompts: number;
  /** Content-true, per audit F4: the last thing said, never the fork point. */
  date: string | null;
}

/**
 * The canonical source line, built from index rows and nothing else.
 *
 * `<id8> · <project> · <harness> · <n> exchanges · <date>`, and for a ghost
 * `<id8> · <project> · <harness> · ghost, prompts only · <date>` — the two
 * shapes `agents/session-archaeologist.md` documents, produced here so that the
 * agent copies them instead of composing them.
 */
export function mintCitation(f: CitationFacts): string {
  const id8 = f.sessionId.slice(0, 8);
  const project = f.project?.split('/').filter(Boolean).pop() || '(no project)';
  const count =
    f.kind === 'ghost'
      ? 'ghost, prompts only'
      : `${String(f.exchanges)} exchange${f.exchanges === 1 ? '' : 's'}`;
  return [id8, project, f.harness, count, f.date ?? 'undated'].join(SEP);
}

/** The facts for one session, read out of the index. `null` when it is not there. */
export function citationFacts(db: Db, sessionId: string): CitationFacts | null {
  const shown = showSession(db, sessionId, { from: 1, to: 1 });
  if (!shown) return null;
  const s = shown.session;
  return {
    sessionId: s.id,
    kind: s.kind,
    harness: s.harness,
    project: s.project,
    exchanges: s.exchanges,
    prompts: s.prompts,
    // `endedAt` is the content-true end; `startedAt` is what F4 caught being
    // inherited from a fork point. Prefer the former and fall back only when
    // there is nothing else.
    date: day(s.endedAt ?? s.startedAt),
  };
}

function day(ts: string | null): string | null {
  if (!ts) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(ts.trim());
  return m ? m[1]! : ts.trim().slice(0, 10) || null;
}

// --------------------------------------------------------------- the refusal

export type RefusalReason =
  /** The line's id field is `—`, blank, or a dash of some kind. */
  | 'no-id'
  /** There is something in the field, and it is not an id — `HANDOFF.md §3`. */
  | 'not-an-id'
  /** It is shaped like an id and no session in the index starts with it. */
  | 'unresolved'
  /** It is a prefix of more than one session, so it names none of them. */
  | 'ambiguous';

export interface SourceRow {
  /** The line as written. */
  line: string;
  /** 0-based line number in the text it came from. */
  at: number;
  /** The first field, trimmed. */
  field: string;
  /** The resolved session id, when it resolved. */
  sessionId: string | null;
  resolves: boolean;
  reason: RefusalReason | null;
  /** Indented lines that hang off this one — the quote it was carrying. */
  carried: number;
}

export interface SourcesVerdict {
  /** True when the text held anything shaped like a source line at all. */
  found: boolean;
  rows: SourceRow[];
  kept: SourceRow[];
  refused: SourceRow[];
  /** The text with every refused line, and the quotes under it, removed. */
  text: string;
  /** One line naming what was dropped, or null when nothing was. */
  note: string | null;
}

/**
 * The count field — `12 exchanges`, `— exchanges`, `ghost, prompts only`.
 *
 * This is what makes a line a **citation** rather than a sentence that happens
 * to contain a middle dot. It is matched loosely on purpose: the audit's rows
 * had the count left as a dash, and a check that required a number there would
 * have waved through exactly the lines it exists to catch.
 */
const COUNT_FIELD = /(^|\s)(exchanges?|prompts? only)\s*$/i;

/** `source:` / `SOURCE:` — the label graft's own provenance line carries. */
const SOURCE_LABEL = /^\s*sources?\s*:\s*/i;

/**
 * Is this line wearing the citation format, and what is it claiming to cite?
 *
 * Two failures to avoid, and they pull in opposite directions.
 *
 * Too loose and it eats prose. The first version of this function took any
 * line with three `·`-separated fields, and the very first thing it refused
 * was `graft`'s own `source: <harness> <id> · <n> exchanges · <date>` footer —
 * a true line, deleted, which is a worse outcome than the fabrication it was
 * written to stop.
 *
 * Too tight and it waves the fabrication through. The audit's rows were *repo
 * files dressed in the citation format*, with the id and count fields left as
 * a dash; a check that required a resolvable-looking id before it would agree
 * a line was a citation could never refuse one.
 *
 * So the grammar is: `·`-separated, at least three fields, and one of them is
 * a count of exchanges or the ghost marker. That is what a citation is and
 * what a sentence is not. The **id** is then the first field, minus any
 * `source:` label and any words before the last token — which is how both the
 * archaeologist's `<id8> · …` and graft's `source: claude <id> · …` are read
 * by one rule.
 */
export function sourceFieldOf(line: string): string | null {
  if (/^\s/.test(line)) return null;
  const fields = line.split(SEP);
  if (fields.length < 3) return null;
  if (!fields.some((f) => COUNT_FIELD.test(f.trim()))) return null;
  const head = fields[0]!.replace(SOURCE_LABEL, '').trim();
  if (!head) return null;
  const last = head.split(/\s+/).pop() ?? '';
  return last.trim() || null;
}

const DASHES = /^[-–—_.\s?]*$/u;

export function verifySources(db: Db, text: string): SourcesVerdict {
  const lines = text.split('\n');
  const rows: SourceRow[] = [];
  const drop = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const field = sourceFieldOf(line);
    if (field === null) continue;

    let sessionId: string | null = null;
    let reason: RefusalReason | null = null;

    if (DASHES.test(field)) {
      reason = 'no-id';
    } else if (!ID8.test(field)) {
      // `HANDOFF.md §3`. This is the audit's own case, and the one the format
      // made look like evidence.
      reason = 'not-an-id';
    } else {
      const found = resolveSession(db, field.toLowerCase());
      if (!found) reason = 'unresolved';
      else if (found.ambiguous) reason = 'ambiguous';
      else sessionId = found.id;
    }

    // Everything indented under it is the quote it was carrying, and a quote
    // whose citation was refused is an uncited claim about the user's history.
    // Cited or dropped: it goes with the line.
    let carried = 0;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trim() === '' || !/^\s/.test(lines[j]!)) break;
      carried++;
    }

    const row: SourceRow = {
      line,
      at: i,
      field,
      sessionId,
      resolves: reason === null,
      reason,
      carried,
    };
    rows.push(row);
    if (reason !== null) {
      drop.add(i);
      for (let j = 1; j <= carried; j++) drop.add(i + j);
    }
  }

  const refused = rows.filter((r) => !r.resolves);
  const kept = rows.filter((r) => r.resolves);
  return {
    found: rows.length > 0,
    rows,
    kept,
    refused,
    text: lines.filter((_, i) => !drop.has(i)).join('\n'),
    note: refused.length === 0 ? null : refusalNote(refused),
  };
}

/**
 * The one line a refusal prints.
 *
 * `05`: the tool says when it is guessing, and every message names its fix.
 * The fix for a refused citation is not a flag — it is the sentence that says
 * where a real one comes from.
 */
export function refusalNote(refused: readonly SourceRow[]): string {
  const n = refused.length;
  const what = refused
    .slice(0, 3)
    .map((r) => `"${r.field}" (${r.reason ?? 'refused'})`)
    .join(', ');
  return (
    `${String(n)} source line${n === 1 ? '' : 's'} refused: ${what}` +
    (n > 3 ? `, and ${String(n - 3)} more` : '') +
    '. A source line is a session id that resolves against the index, not a file path ' +
    'and not a dash. Copy the citation potsherd_recall or potsherd_read gave you.'
  );
}

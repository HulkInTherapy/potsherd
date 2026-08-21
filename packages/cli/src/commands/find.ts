import { recall, renderFind } from '@potsherd/core';
import { print, printJson, themeFrom, UserError, type GlobalOptions } from '../output.js';
import { openIndex, parseFilters, parseLimit, type FilterFlags } from '../filters.js';

export interface FindCommandOptions extends GlobalOptions, FilterFlags {
  query: string;
  limit?: unknown;
  /** `--no-vec`. */
  vec?: boolean;
  /** `--vectors auto|on|off`. */
  vectors?: string;
}

/**
 * `potsherd find` — the verb the index exists for.
 *
 * Sidechains and ghosts are both in by default (`03` §7). That is one line of
 * configuration and the whole differentiator: on the reference machine it is
 * the difference between searching 30 sessions and searching 30 sessions, 197
 * subagent transcripts and 299 conversations Claude Code already deleted.
 *
 * Vectors are used when they exist and skipped, with a printed reason, when
 * they do not — `--no-embed`, no sqlite-vec, no model. A `find` that errored
 * because a native extension was missing would be a `find` that does not work
 * on an aeroplane, and text search alone is genuinely good.
 */
export async function runFind(o: FindCommandOptions): Promise<number> {
  const query = o.query?.trim();
  if (!query) {
    throw new UserError('find needs something to look for', 'potsherd find "pgbouncer"');
  }

  const { db, root } = openIndex(o);
  try {
    const filters = parseFilters(db, o);
    const limit = parseLimit(o.limit, 10);
    const result = await recall(db, query, filters, {
      limit,
      root,
      vectors: vectorMode(o),
    });

    if (o.json) {
      printJson({
        query: result.query,
        filters,
        vectors: result.vectors,
        lists: result.lists,
        relaxed: result.relaxed,
        ms: result.ms,
        sessions: result.sessions.map((s) => ({
          id: s.id,
          kind: s.kind,
          harness: s.harness,
          title: s.title,
          displayTitle: s.displayTitle,
          project: s.project,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          status: s.status,
          isSidechain: s.isSidechain,
          parentSessionId: s.parentSessionId,
          agentName: s.agentName,
          gitBranch: s.gitBranch,
          pinned: s.pinned,
          prompts: s.prompts,
          exchanges: s.exchanges,
          resume: s.resume,
          score: s.score,
          hits: s.hits.map((h) => ({
            kind: h.kind,
            id: h.id ?? null,
            seq: h.seq ?? null,
            ts: h.ts ?? null,
            score: h.score,
            from: h.from,
            snippet: h.snippet.text,
            match: h.snippet.match ?? null,
          })),
        })),
      });
      return result.sessions.length ? 0 : 1;
    }

    print(renderFind(result, themeFrom(o)));
    // Exit 1 on no match, so `potsherd find x || echo none` works in a script.
    return result.sessions.length ? 0 : 1;
  } finally {
    db.close();
  }
}

/**
 * `auto` by default: bm25 answers, and the embedding model is only woken when
 * the words did not match. See `RecallOptions.vectors` for why — it is the
 * difference between a 130 ms verb and a 490 ms one, and `03` §12 asks for 150.
 */
function vectorMode(o: FindCommandOptions): boolean | 'auto' {
  if (o.vec === false) return false;
  switch (o.vectors) {
    case 'on':
      return true;
    case 'off':
      return false;
    default:
      return 'auto';
  }
}

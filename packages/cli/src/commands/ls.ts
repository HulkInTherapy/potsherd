import { listSessions, renderLs } from '@potsherd/core';
import { print, printJson, themeFrom, type GlobalOptions } from '../output.js';
import { openIndex, parseFilters, parseLimit, type FilterFlags } from '../filters.js';

export interface LsCommandOptions extends GlobalOptions, FilterFlags {
  limit?: unknown;
}

/**
 * `potsherd ls` — the archive, finally legible (plans/05, moment 3).
 *
 * The screenshot test: `ls ~/.claude/projects` prints three hundred uuids in
 * seven directories; this prints the same conversations by name, newest first,
 * with the deleted ones still in the list. It has to be understandable at
 * 80×24 with no caption, which is why the renderer is stricter about width
 * than anything except the audit card.
 */
export async function runLs(o: LsCommandOptions): Promise<number> {
  const { db } = openIndex(o);
  try {
    const filters = parseFilters(db, o);
    // 15 rows plus the heading, the column header, the summary and the next verb
    // is 21 lines: the whole of `ls` fits one 80x24 screenshot, which is the
    // acceptance test for this verb (plans/05, moment 3).
    const limit = parseLimit(o.limit, 15);
    const result = listSessions(db, filters, { limit });

    if (o.json) {
      printJson({
        total: result.total,
        shown: result.sessions.length,
        ghosts: result.ghosts,
        sidechains: result.sidechains,
        rolledUp: result.rolledUp,
        filters,
        sessions: result.sessions.map((s) => ({
          id: s.id,
          kind: s.kind,
          harness: s.harness,
          title: s.title,
          displayTitle: s.displayTitle,
          project: s.project,
          projectName: s.projectName,
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
          bytes: s.bytes,
          resume: s.resume,
        })),
      });
      return 0;
    }

    print(renderLs(result, themeFrom(o)));
    return 0;
  } finally {
    db.close();
  }
}

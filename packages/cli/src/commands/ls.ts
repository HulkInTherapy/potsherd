import { listSessions, renderLs, renderResumeMenu } from '@potsherd/core';
import { print, printJson, themeFrom, type GlobalOptions } from '../output.js';
import { openIndex, parseFilters, parseLimit, type FilterFlags } from '../filters.js';

export interface LsCommandOptions extends GlobalOptions, FilterFlags {
  limit?: unknown;
  resumeMenu?: boolean;
}

/**
 * `potsherd ls` — the archive, finally legible (plans/05, moment 3).
 *
 * The screenshot test: `ls ~/.claude/projects` prints three hundred uuids in
 * seven directories; this prints the same conversations by name, newest first,
 * with the deleted ones still in the list. It has to be understandable at
 * 80×24 with no caption, which is why the renderer is stricter about width
 * than anything except the audit card.
 *
 * Every filter composes with every other: `--tag`, `--pinned`, `--linked-to`,
 * `--untitled`, `--ghosts`, `--since`, `--until`, `--project`, `--harness`,
 * `--branch` and `--status` are all AND-ed into one clause
 * (`search/filters.ts`), so three at once means all three, never the last one
 * typed.
 */
export async function runLs(o: LsCommandOptions): Promise<number> {
  const { db } = openIndex(o);
  try {
    const filters = parseFilters(db, o);
    // 15 rows plus the heading, the column header, the summary and the next verb
    // is 21 lines: the whole of `ls` fits one 80x24 screenshot, which is the
    // acceptance test for this verb (plans/05, moment 3).
    //
    // The resume menu is not a screenshot — it is pasted into a shell and
    // scrolled — so it gets a longer default.
    const limit = parseLimit(o.limit, o.resumeMenu ? 25 : 15);
    const result = listSessions(db, filters, { limit });

    if (o.json) {
      printJson({
        total: result.total,
        shown: result.sessions.length,
        ghosts: result.ghosts,
        sidechains: result.sidechains,
        rolledUp: result.rolledUp,
        filters,
        // The same lines the human view prints, so a script never has to
        // rebuild `claude --resume <id>  # <title>` for itself.
        ...(o.resumeMenu
          ? {
              resumeMenu: result.sessions
                .filter((s) => s.resume)
                .map((s) => ({
                  id: s.id,
                  title: s.displayTitle,
                  command: s.resume,
                  line: `${s.resume}  # ${s.displayTitle.replace(/\s+/g, ' ')}`,
                })),
            }
          : {}),
        sessions: result.sessions.map((s) => ({
          id: s.id,
          kind: s.kind,
          harness: s.harness,
          title: s.title,
          displayTitle: s.displayTitle,
          cardTitle: s.cardTitle,
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
          tags: s.tags,
          prompts: s.prompts,
          exchanges: s.exchanges,
          bytes: s.bytes,
          resume: s.resume,
        })),
      });
      return 0;
    }

    const t = themeFrom(o);
    print(o.resumeMenu ? renderResumeMenu(result, t) : renderLs(result, t));
    return 0;
  } finally {
    db.close();
  }
}

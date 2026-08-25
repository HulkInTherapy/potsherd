import { listSessions, renderLs, renderResumeMenu } from '@potsherd/core';
import { print, printJson, themeFrom, type GlobalOptions } from '../output.js';
import { openIndex, parseFilters, parseLimit, type FilterFlags } from '../filters.js';

export interface LsCommandOptions extends GlobalOptions, FilterFlags {
  limit?: unknown;
  resumeMenu?: boolean;
  /**
   * `--all`: show the projects the ignore list hides.
   *
   * Deliberately **not** part of the shared `addFilters` registration, though
   * every other flag on this verb is. `potsherd card --all` already exists and
   * means "every session in the index"; a single `--all` registered across the
   * shared block would have put two meanings on one word. So `ls`, `find` and
   * `stats` each declare it, with the same description and the same effect,
   * and nothing else does.
   *
   * It overrides the ignore list and only the ignore list: every other filter
   * still applies.
   */
  all?: boolean;
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
  const { db, root } = openIndex(o);
  try {
    const filters = parseFilters(db, o);
    // 15 rows plus the heading, the column header, the summary and the next verb
    // is 21 lines: the whole of `ls` fits one 80x24 screenshot, which is the
    // acceptance test for this verb (plans/05, moment 3).
    //
    // The resume menu is not a screenshot — it is pasted into a shell and
    // scrolled — so it gets a longer default.
    const limit = parseLimit(o.limit, o.resumeMenu ? 25 : 15);
    // `--all` overrides the ignore list — and only the ignore list. Every
    // other filter still applies, so `ls --all --ghosts only` is what the
    // sweep took across every project including the ignored ones.
    const result = listSessions(db, filters, { limit, root, all: Boolean(o.all) });

    if (o.json) {
      printJson({
        total: result.total,
        shown: result.sessions.length,
        ghosts: result.ghosts,
        sidechains: result.sidechains,
        rolledUp: result.rolledUp,
        // Earlier links of a fork/resume chain, folded into the row of the
        // link that carries the work (`threads.ts`, audit F4). Reported for
        // the same reason `rolledUp` is: a listing that quietly drops rows is
        // lying about the archive, and a script needs to know the count is a
        // thread's rather than a file's.
        threaded: result.threaded,
        // The names of the ignored projects live here and not on the screen:
        // a script needs them, a screenshot must not carry them.
        ignored: result.ignored,
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
          cardSource: s.cardSource,
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
          // The chain, with every member's id, so a script can still address
          // the transcripts the human view folded. Null is the ordinary case.
          thread: s.thread,
        })),
      });
      return 0;
    }

    const t = themeFrom(o);
    print(
      o.resumeMenu
        ? renderResumeMenu(result, t)
        : // The words the reader typed, handed to the heading so it can quote
          // them rather than re-derive them from the instants `parseFilters`
          // turned them into. VERIFICATION-6 C-2: the receipt of an input is
          // the one thing that must never be a second computation.
          renderLs(result, t, new Date(), { since: o.since, until: o.until }),
    );
    return 0;
  } finally {
    db.close();
  }
}

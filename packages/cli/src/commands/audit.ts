import { audit, paths, renderAuditCard, renderSweepList, renderVerify, verifyInfo } from '@potsherd/core';
import { print, printJson, themeFrom, type GlobalOptions } from '../output.js';

export interface AuditOptions extends GlobalOptions {
  sweep?: boolean;
  verify?: boolean;
}

/**
 * `potsherd audit` — read-only. It opens no database, creates no directory and
 * writes nothing anywhere, which is what makes it safe to be the first thing
 * `npx` runs on a stranger's machine.
 */
export async function runAudit(o: AuditOptions): Promise<number> {
  // `--verify` reads nothing at all: it hands over the python that recomputes
  // the four numbers from the user's own files, and gets out of the way. It is
  // the honesty contract in plans/05 §honesty, and it must keep working on a
  // machine that reached potsherd through npx and has no checkout.
  if (o.verify) {
    const dir = paths.claudeDir(o.claudeDir);
    if (o.json) {
      printJson(verifyInfo(dir));
      return 0;
    }
    print(renderVerify(paths.tildify(dir), themeFrom(o)));
    return 0;
  }

  const report = await audit(o.claudeDir, new Date(), o.potsherdDir ? { potsherdDir: o.potsherdDir } : {});

  if (o.json) {
    printJson({
      sessionsEver: report.sessionsEver,
      onDisk: report.onDisk,
      deleted: report.deleted,
      promptsLost: report.promptsLost,
      promptsSurviving: report.promptsSurviving,
      projectsWiped: report.projectsWiped.map((p) => ({
        project: p.project,
        name: p.name,
        sessions: p.sessions,
        prompts: p.prompts,
      })),
      nextSweep: report.nextSweep.map((s) => ({
        id: s.id,
        title: s.title,
        project: s.project,
        daysLeft: s.daysLeft,
        bytes: s.bytes,
        mtime: s.mtime,
      })),
      nextSweepWithin7Days: report.nextSweepWithin7Days,
      nextSweepWithinOneDay: report.nextSweepWithinOneDay,
      cleanupPeriodDays: report.cleanupPeriodDays,
      cleanupPeriodEffective: report.cleanupPeriodEffective,
      cleanupPeriodSource: report.cleanupPeriodSource,
      cleanupEditable: report.cleanupEditable,
      measuredAt: report.measuredAt,
      claudeDir: report.claudeDir,
      onDiskFiles: report.onDiskFiles,
      sidechainFiles: report.sidechainFiles,
      sdkSessions: report.sdkSessions,
      titledSessions: report.titledSessions,
      memoryFiles: report.memoryFiles,
      sessionsIndexFiles: report.sessionsIndexFiles,
      bytes: report.bytes,
      history: {
        sessions: report.historySessions,
        onDisk: report.historyOnDisk,
        prompts: report.historyPrompts,
        firstTs: report.historyFirstTs,
        lastTs: report.historyLastTs,
      },
      projectDirs: report.projectDirs,
      projectsWithSessions: report.projectsWithSessions,
      timings: report.timings,
      archive: report.archive,
      warnings: report.warnings,
    });
    return 0;
  }

  const t = themeFrom(o);
  print(renderAuditCard(report, t));
  if (o.sweep) {
    const list = renderSweepList(report, t, 20);
    if (list) print(list);
  }
  return 0;
}

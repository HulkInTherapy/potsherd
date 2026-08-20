import { audit, renderAuditCard, renderSweepList } from '@potsherd/core';
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
  const report = await audit(o.claudeDir);

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

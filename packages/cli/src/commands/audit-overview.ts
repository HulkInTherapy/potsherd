import fs from 'node:fs';
import path from 'node:path';
import { createAuditSession, publicAuditSnapshot, type AuditHarness, type AuditOverviewOptions, type AuditScope } from '@potsherd/core';
import { print, printJson, themeFrom, UserError } from '../output.js';
import type { AuditOptions } from './audit.js';

/** New route only. Legacy branches never import or initialize the terminal UI. */
export async function runAuditOverview(o: AuditOptions): Promise<number> {
  const harnesses = o.harness ? [...new Set(o.harness.split(',').map(h => h.trim()))] : undefined;
  if (harnesses?.some(h => !['claude','codex','pi','opencode'].includes(h))) {
    throw new UserError('Choose overview sources from claude,codex,pi,opencode.');
  }
  if (o.export && path.extname(o.export).toLowerCase() !== '.svg') {
    throw new UserError('Use a .svg path for the safe share preview.');
  }
  let options: AuditOverviewOptions = {
    claudeDir:o.claudeDir,codexDir:o.codexDir,piDir:o.piDir,opencodeDir:o.opencodeDir,potsherdDir:o.potsherdDir,
    harnesses:harnesses as AuditHarness[]|undefined,project:o.project,since:o.since,until:o.until,timezone:o.timezone,
  };
  const ui = await import('../audit-ui/index.js');
  const width = o.width ?? process.stdout.columns ?? 80;
  const interactive = !o.json && !o.plain && !o.export && Boolean(process.stdin.isTTY && process.stdout.isTTY) && width >= 38 && (process.stdout.rows ?? 24) >= 18;
  themeFrom(o);
  for (;;) {
    const session = createAuditSession(options);
    try {
      if (!interactive) {
        const snapshot = await session.run();
        if (o.json) printJson(publicAuditSnapshot(snapshot));
        else print(ui.renderAuditPlain(snapshot,{ascii:o.ascii,width}));
        if (o.export) {
          const file=path.resolve(o.export);
          fs.writeFileSync(file,ui.renderAuditShareSvg(snapshot,{width}),{flag:'wx'});
          if (!o.json) print(`Saved safe share preview: ${file}`);
        }
        return snapshot.status === 'error' ? 1 : 0;
      }
      let requestedScope: AuditScope|null = null;
      const result = await ui.runAuditTerminal(session,{
        color:o.color,ascii:o.ascii,width:o.width,motion:o.motion,private:o.private,
        onScopeRequest:scope => { requestedScope=scope; },
      });
      if (requestedScope) {
        const scope = requestedScope as AuditScope;
        options={...options,harnesses:scope.harnesses,project:scope.project ?? undefined,since:scope.eventFrom ?? undefined,until:scope.asOf ?? undefined,timezone:scope.timezone};
        continue;
      }
      print(ui.renderAuditPlain(result.snapshot,{ascii:o.ascii,width}));
      return result.reason === 'cancelled' ? 130 : result.snapshot.status === 'error' ? 1 : 0;
    } finally { session.dispose(); }
  }
}

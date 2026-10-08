import fs from 'node:fs';
import path from 'node:path';
import { publicAuditSnapshot, type AuditHarness, type AuditOverviewOptions, type AuditScope, type AuditTone } from '@potsherd/core';
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
  if(o.tone&&!['elegant','witty','chaotic','roast'].includes(o.tone))throw new UserError('Choose a tone: elegant, witty, chaotic, roast.');
  let options: AuditOverviewOptions = {launch:true,tone:o.tone as AuditTone|undefined,
    claudeDir:o.claudeDir,codexDir:o.codexDir,piDir:o.piDir,opencodeDir:o.opencodeDir,potsherdDir:o.potsherdDir,
    harnesses:harnesses as AuditHarness[]|undefined,project:o.project,since:o.since,until:o.until,timezone:o.timezone,
  };
  const ui = await import('../audit-ui/index.js');
  const width = o.width ?? process.stdout.columns ?? 80;
  const interactive = !o.json && !o.plain && !o.export && Boolean(process.stdin.isTTY && process.stdout.isTTY) && width >= 38 && (process.stdout.rows ?? 24) >= 18;
  themeFrom(o);
  for (;;) {
    const {createBackgroundAuditSession}=await import('../audit-background.js');
    const session = createBackgroundAuditSession(options);
    try {
      if (!interactive) {
        const stop=()=>session.cancel();process.once('SIGTERM',stop);process.once('SIGHUP',stop);
        let snapshot;try{snapshot = await session.run(event=>{if(event.type==='transfer'){process.stderr.write(event.notice+'\n',()=>{if(event.ackId)session.acknowledgeTransfer?.(event.ackId);});}});}finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGHUP',stop);}
        if (o.json) printJson(publicAuditSnapshot(snapshot));
        else print(ui.renderLaunchPlain(snapshot,{ascii:o.ascii,width}));
        if (o.export) {
          const file=path.resolve(o.export);
          fs.writeFileSync(file,ui.renderAuditShareSvg(snapshot,{width}),{flag:'wx'});
          if (!o.json) print(`Saved safe share preview: ${file}`);
        }
        return snapshot.status === 'cancelled' ? 130 : snapshot.status === 'error' ? 1 : 0;
      }
      let requestedScope: AuditScope|null = null;
      const result = await ui.runLaunchTerminal(session,{
        color:o.color,ascii:o.ascii,width:o.width,motion:o.motion,private:o.private,
        onScopeRequest:scope => { requestedScope=scope; },
      });
      if (requestedScope) {
        const scope = requestedScope as AuditScope;
        options={...options,harnesses:scope.harnesses,project:scope.project ?? undefined,since:scope.eventFrom ?? undefined,until:scope.asOf ?? undefined,timezone:scope.timezone};
        continue;
      }
      return result.reason === 'cancelled' ? 130 : result.snapshot.status === 'error' ? 1 : 0;
    } finally { session.dispose(); }
  }
}

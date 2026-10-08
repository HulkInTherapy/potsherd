import fs from 'node:fs';
import path from 'node:path';
import {createAuditSession, publicAuditSnapshot, type AuditHarness, type AuditOverviewOptions, type AuditScope, type AuditSession, type AuditTone} from '@potsherd/core';
import {print, printJson, themeFrom, UserError} from '../output.js';
import type {AuditOptions} from './audit.js';

/** New route only. Legacy branches never import or initialize the terminal UI. */
export async function runAuditOverview(o: AuditOptions): Promise<number> {
  const harnesses = o.harness ? [...new Set(o.harness.split(',').map(h => h.trim()))] : undefined;
  if (harnesses?.some(h => !['claude', 'codex', 'pi', 'opencode'].includes(h))) throw new UserError('Choose overview sources from claude,codex,pi,opencode.');
  if (o.export && path.extname(o.export).toLowerCase() !== '.svg') throw new UserError('Use a .svg path for the safe share preview.');
  if (o.tone && !['elegant', 'witty', 'chaotic', 'roast'].includes(o.tone)) throw new UserError('Choose a tone: elegant, witty, chaotic, roast.');
  let options: AuditOverviewOptions = {
    launch: true, tone: o.tone as AuditTone | undefined,
    claudeDir: o.claudeDir, codexDir: o.codexDir, piDir: o.piDir, opencodeDir: o.opencodeDir, potsherdDir: o.potsherdDir,
    harnesses: harnesses as AuditHarness[] | undefined, project: o.project, since: o.since, until: o.until, timezone: o.timezone,
    // Developer/benchmark seam: point the derived cache somewhere else (e.g. a fresh dir for a cold run).
    ...(process.env['SLOPIE_AUDIT_CACHE_DIR'] ? {derivedCacheDir: process.env['SLOPIE_AUDIT_CACHE_DIR']} : {}),
  };
  const width = o.width ?? process.stdout.columns ?? 80;
  const interactive = !o.json && !o.plain && !o.export && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  themeFrom(o);

  if (!interactive) {
    // No renderer to keep responsive: run in this process on the worker-thread pool.
    const {localScanPool} = await import('../audit-background.js');
    const session = createAuditSession({...options, nativeScanExecutor: localScanPool(),
      onTransfer: async event => { await new Promise<void>(resolve => process.stderr.write(event.notice + '\n', () => resolve())); }});
    const stop = () => session.cancel();
    process.once('SIGTERM', stop);
    process.once('SIGHUP', stop);
    try {
      const snapshot = await session.run();
      if (o.json) printJson(o.private ? snapshot : publicAuditSnapshot(snapshot));
      else {
        const ui = await import('../audit-ui/index.js');
        print(ui.renderLaunchPlain(snapshot, {ascii: o.ascii, width}));
        if (o.export) {
          const file = path.resolve(o.export);
          fs.writeFileSync(file, ui.renderAuditShareSvg(snapshot, {width}), {flag: 'wx'});
          print(`Saved safe share preview: ${file}`);
        }
      }
      if (o.json && o.export) {
        const ui = await import('../audit-ui/index.js');
        fs.writeFileSync(path.resolve(o.export), ui.renderAuditShareSvg(snapshot, {width}), {flag: 'wx'});
      }
      return snapshot.status === 'cancelled' ? 130 : snapshot.status === 'error' ? 1 : 0;
    } finally {
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGHUP', stop);
      session.dispose();
    }
  }

  const ui = await import('../audit-ui/index.js');
  for (;;) {
    const session: AuditSession = await createSession(options);
    try {
      let requestedScope: AuditScope | null = null;
      const result = await ui.runLaunchTerminal(session, {
        color: o.color, ascii: o.ascii, width: o.width, motion: o.motion, private: o.private,
        onScopeRequest: scope => { requestedScope = scope; },
      });
      if (requestedScope) {
        const scope = requestedScope as AuditScope;
        options = {...options, harnesses: scope.harnesses, project: scope.project ?? undefined, since: scope.eventFrom ?? undefined, until: scope.asOf ?? undefined, timezone: scope.timezone};
        continue;
      }
      return result.reason === 'cancelled' ? 130 : result.snapshot.status === 'error' ? 1 : 0;
    } finally {
      session.dispose();
    }
  }
}

/** Dev hooks (see audit-ui/fixture-session.ts): replay a saved run or record a real one. */
async function createSession(options: AuditOverviewOptions): Promise<AuditSession> {
  const fixture = process.env['SLOPIE_AUDIT_FIXTURE'];
  const record = process.env['SLOPIE_AUDIT_RECORD'];
  const {createBackgroundAuditSession} = await import('../audit-background.js');
  if (fixture || record) {
    const dev = await import('../audit-ui/fixture-session.js');
    if (fixture) return dev.createFixtureSession(path.resolve(fixture));
    return dev.recordAuditSession(createBackgroundAuditSession(options), path.resolve(record!));
  }
  return createBackgroundAuditSession(options);
}

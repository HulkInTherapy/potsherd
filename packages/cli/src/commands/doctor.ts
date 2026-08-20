import fs from 'node:fs';
import process from 'node:process';
import {
  audit,
  db as store,
  paths,
  format as fmt,
  Card,
  consent,
  type AuditReport,
} from '@potsherd/core';
import { print, printJson, themeFrom, type GlobalOptions } from '../output.js';

export interface DoctorOptions extends GlobalOptions {
  privacy?: boolean;
}

/**
 * `potsherd doctor` — what potsherd can see, what it has stored, and what it
 * could not parse. Unknown record types are counted and listed, never hidden:
 * a parser that silently drops a record type is how an archive tool quietly
 * loses the thing you were looking for.
 *
 * `--privacy` prints every path read and every path written. It is the section
 * of the readme that lets someone decide to trust this, and it is generated
 * rather than written by hand so it can never drift from the code.
 */
export async function runDoctor(o: DoctorOptions): Promise<number> {
  const report = await audit(o.claudeDir, new Date(), o.potsherdDir ? { potsherdDir: o.potsherdDir } : {});
  const root = paths.potsherdDir(o.potsherdDir);
  const dbFile = paths.dbPath(root);
  const dbExists = fs.existsSync(dbFile);

  const counts: Record<string, number> = {};
  let schema = 0;
  if (dbExists) {
    const db = store.open({ root, readonly: true });
    try {
      schema = store.schemaVersion(db);
      for (const table of ['sessions', 'exchanges', 'ghosts', 'ghost_prompts', 'cards', 'tags', 'pins', 'links', 'archive_files', 'rescue_log']) {
        counts[table] = store.count(db, table);
      }
    } finally {
      db.close();
    }
  }

  const unknownTypes = collectRecordTypes(report);
  const written = [root, paths.archiveDir(root), dbFile];
  const consented = [paths.claudePaths(report.claudeDir).settings];

  if (o.privacy) {
    if (o.json) {
      printJson({ reads: report.pathsRead, writes: written, writesWithConsent: consented });
      return 0;
    }
    const t = themeFrom(o);
    const card = new Card(t);
    card.heading('doctor --privacy', fmt.date(new Date())).blank();
    // Paths are the one thing here that can outrun any terminal, so they elide
    // in the middle: the last segment is what identifies a file.
    const pathW = Math.max(24, t.width - 16);
    const show = (p: string) => fmt.elideMiddle(paths.tildify(p), pathW, t.ellip);

    card.text('reads (never modified):');
    for (const p of dedupe(report.pathsRead)) {
      card.raw(`    ${show(p)}${fs.existsSync(p) ? '' : t.dim('  (absent)')}`);
    }
    card.blank().text('writes:');
    for (const p of written) card.raw(`    ${show(p)}`);
    card.blank().text('writes only after an explicit y at a diff:');
    for (const p of consented) card.raw(`    ${show(p)}`);
    card.raw(`      ${t.dim('cleanupPeriodDays, and one SessionStart hook entry')}`);
    card.blank().text('no network. no telemetry. no account.');
    print(card.toString());
    return 0;
  }

  if (o.json) {
    printJson({
      version: VERSION_STRING,
      node: process.version,
      platform: process.platform,
      claudeDir: report.claudeDir,
      claudeDirExists: report.claudeDirExists,
      potsherdDir: root,
      db: { path: dbFile, exists: dbExists, schemaVersion: schema, latest: store.latestSchemaVersion(), counts },
      corpus: {
        sessions: report.onDiskFiles,
        sidechains: report.sidechainFiles,
        ghosts: counts['ghosts'] ?? 0,
        bytes: report.bytes,
        titled: report.titledSessions,
        sdkSessions: report.sdkSessions,
        sessionsIndexFiles: report.sessionsIndexFiles,
        memoryFiles: report.memoryFiles,
      },
      recordTypes: unknownTypes,
      adapters: adapterStatus(),
      guard: { installed: consent.guardInstalled(o.claudeDir) },
      cleanupPeriodDays: report.cleanupPeriodEffective,
      fatalErrors: report.warnings.filter((w) => w.startsWith('unreadable transcript')).length,
      warnings: report.warnings,
    });
    return 0;
  }

  const t = themeFrom(o);
  const card = new Card(t);
  card.heading('doctor', `potsherd ${VERSION_STRING}`, `node ${process.version}`).blank();
  card.rows([
    { label: 'claude dir', value: '', note: paths.tildify(report.claudeDir) + (report.claudeDirExists ? '' : '  (not found)') },
    { label: 'potsherd dir', value: '', note: paths.tildify(root) },
    { label: 'database', value: '', note: dbExists ? `schema v${schema} of v${store.latestSchemaVersion()}` : 'not created yet — run potsherd rescue' },
  ]);
  card.blank();
  card.rows([
    {
      label: 'sessions on disk',
      value: fmt.num(report.onDiskFiles),
      // The live corpus's size belongs to this row, not to `files archived`.
      note: `${fmt.num(report.titledSessions)} titled · ${fmt.num(report.sdkSessions)} sdk · ${fmt.bytes(report.bytes)}`,
    },
    { label: 'sidechains on disk', value: fmt.num(report.sidechainFiles), note: 'subagent transcripts' },
    {
      label: 'ghosts stored',
      value: fmt.num(counts['ghosts'] ?? 0),
      note: `${fmt.num(counts['ghost_prompts'] ?? 0)} ${fmt.plural(counts['ghost_prompts'] ?? 0, 'prompt')}`,
    },
    {
      // The count is of archived files, so the size beside it must be the
      // archive's, not the live corpus's — printing report.bytes here made the
      // row contradict the rescue receipt that had just run.
      label: 'files archived',
      value: fmt.num(counts['archive_files'] ?? 0),
      note: report.archive && report.archive.archivedFiles > 0
        ? fmt.bytes(report.archive.archivedBytes) + ' of source, byte-exact'
        : 'nothing archived yet — run potsherd rescue',
    },
    { label: 'rescue runs', value: fmt.num(counts['rescue_log'] ?? 0) },
  ]);

  // Every record type, always. A parser that silently drops a type is how an
  // archive tool loses the thing you were looking for, so nothing is hidden
  // behind a "N more" here.
  card.blank().text('record types seen (head/tail scan):');
  for (const [type, n] of Object.entries(unknownTypes).sort((a, b) => b[1] - a[1])) {
    card.raw(`    ${type.padEnd(24)}${fmt.num(n).padStart(7)}`);
  }

  card.blank().text('adapters:');
  for (const [name, status] of Object.entries(adapterStatus())) {
    // Pad the plain text and colour afterwards: padEnd counts escape bytes.
    const label = status.supported ? 'ready' : `phase ${status.phase}`;
    const mark = status.supported ? t.ok(label.padEnd(10)) : t.dim(label.padEnd(10));
    card.raw(`    ${name.padEnd(12)}${mark}${t.dim(paths.tildify(status.path))}`);
  }

  const fatal = report.warnings.filter((w) => w.startsWith('unreadable transcript'));
  card.blank();
  card.rows([{
    label: 'fatal parse errors',
    value: fmt.num(fatal.length),
    note: fatal.length ? 'see --json' : 'none',
    tone: fatal.length ? 'warn' : 'ok',
  }]);
  for (const w of report.warnings.slice(0, 4)) card.text(t.dim(`note: ${w}`));

  card.blank().fix(
    'potsherd doctor --privacy',
    'to see every path potsherd reads and writes.',
    'for every path it touches.',
  );
  print(card.toString());
  return fatal.length ? 1 : 0;
}

function collectRecordTypes(report: AuditReport): Record<string, number> {
  // The audit scan counted every `type` it saw in the head/tail windows. Phase
  // 1's full parser replaces this with exact per-file, per-version counts.
  return report.recordTypes;
}

interface AdapterStatus { supported: boolean; phase: number; path: string }

function adapterStatus(): Record<string, AdapterStatus> {
  const h = paths.home();
  return {
    claude: { supported: true, phase: 0, path: `${h}/.claude/projects` },
    codex: { supported: false, phase: 1, path: `${h}/.codex/sessions` },
    cursor: { supported: false, phase: 1, path: `${h}/.cursor/projects` },
    pi: { supported: false, phase: 1, path: `${h}/.pi/agent/sessions` },
    gemini: { supported: false, phase: 6, path: `${h}/.gemini/tmp` },
    opencode: { supported: false, phase: 6, path: `${h}/.local/share/opencode` },
    copilot: { supported: false, phase: 6, path: `${h}/.copilot/session-state` },
  };
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

export const VERSION_STRING = '0.1.0';

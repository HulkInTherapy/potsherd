import fs from 'node:fs';
import process from 'node:process';
import {
  audit,
  claude as claudeAdapter,
  codex as codexAdapter,
  countsJson,
  cursor as cursorAdapter,
  db as store,
  paths,
  pi as piAdapter,
  format as fmt,
  Card,
  consent,
  redactionRow,
  storedRecordTypes,
  storedRedactionCounts,
  vecStatus,
  emptyCounts,
  type AuditReport,
  type RecordTypeRow,
  type RedactionCounts,
  type VecStatus,
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
  let redaction: RedactionCounts = emptyCounts();
  let indexedTypes: RecordTypeRow[] = [];
  let vec: VecStatus = { available: false, reason: 'no database yet — run potsherd index' };
  let indexedAt: string | null = null;
  if (dbExists) {
    // Read-only: `doctor` never migrates, never writes, and never takes the
    // lock, so it is safe to run while an index is in flight.
    const db = store.open({ root, readonly: true });
    try {
      schema = store.schemaVersion(db);
      for (const table of ['sessions', 'exchanges', 'tool_calls', 'ghosts', 'ghost_prompts', 'cards', 'tags', 'pins', 'links', 'archive_files', 'rescue_log', 'vec_exchanges']) {
        counts[table] = store.count(db, table);
      }
      redaction = storedRedactionCounts(db);
      indexedTypes = storedRecordTypes(db);
      vec = vecStatus(db);
      const row = db.prepare('SELECT MAX(indexed_at) AS at FROM sessions').get() as { at: string | null };
      indexedAt = row?.at ?? null;
    } catch {
      // A database written by a newer potsherd, or one being migrated right
      // now. Say what is readable rather than failing the whole verb.
    } finally {
      db.close();
    }
  }

  const unknownTypes = collectRecordTypes(report);
  const adapters = await adapterStatus(o);
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
      index: {
        indexedAt,
        sessions: counts['sessions'] ?? 0,
        exchanges: counts['exchanges'] ?? 0,
        toolCalls: counts['tool_calls'] ?? 0,
        vectors: counts['vec_exchanges'] ?? 0,
        vec,
      },
      redaction: countsJson(redaction),
      recordTypes: unknownTypes,
      // Exact per-(harness, version, type) counts, from the last `index` run.
      // `recordTypes` above is the audit's head/tail estimate and stays for
      // machines that have never indexed.
      indexedRecordTypes: indexedTypes,
      adapters,
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

  card.blank();
  card.rows([
    {
      label: 'sessions indexed',
      value: fmt.num(counts['sessions'] ?? 0),
      note: indexedAt
        ? `${fmt.num(counts['exchanges'] ?? 0)} ${fmt.plural(counts['exchanges'] ?? 0, 'exchange')} · ` +
          `${fmt.num(counts['tool_calls'] ?? 0)} tool ${fmt.plural(counts['tool_calls'] ?? 0, 'call')}`
        : 'nothing indexed yet — run potsherd index',
      tone: indexedAt ? 'none' : 'dim',
    },
    {
      label: 'ghost prompts indexed',
      value: fmt.num(counts['ghost_prompts'] ?? 0),
      note: 'searchable in ghost_prompts_fts',
    },
    // `03` §5: doctor reports redaction counts by type. The numbers are read
    // back out of the index rather than remembered, so they cannot drift.
    redactionRow(redaction, t, card.noteWidth()),
    {
      label: 'vectors',
      value: vec.available ? fmt.num(counts['vec_exchanges'] ?? 0) : '—',
      note: vec.available
        ? `sqlite-vec ${vec.version ?? 'loaded'} · bge-small, 384-d`
        : `no vector index: ${vec.reason ?? 'sqlite-vec unavailable'} — text search still works`,
      tone: vec.available ? 'ok' : 'dim',
    },
  ]);

  // Every record type, always. A parser that silently drops a type is how an
  // archive tool loses the thing you were looking for, so nothing is hidden
  // behind a "N more" here. Once `index` has run these are exact counts per
  // (harness, version, type); before that they are the audit's head/tail
  // estimate over claude alone.
  if (indexedTypes.length > 0) {
    card.blank().text('record types not consumed, per harness and version:');
    for (const row of indexedTypes) {
      const left = `${row.harness} ${row.type}`;
      const mark = row.novel ? t.warn('new') : t.dim('known');
      card.raw(
        `    ${fmt.elide(left, 28).padEnd(28)}${fmt.num(row.count).padStart(7)}   ` +
          `${t.dim(fmt.elide(row.version, 10).padEnd(10))} ${mark}`,
      );
    }
    card.text(t.dim('"new" means no note in research/formats.md describes it yet.'));
  } else {
    card.blank().text('record types seen (head/tail scan — run potsherd index for exact counts):');
    for (const [type, n] of Object.entries(unknownTypes).sort((a, b) => b[1] - a[1])) {
      card.raw(`    ${type.padEnd(24)}${fmt.num(n).padStart(7)}`);
    }
  }

  card.blank().text('adapters:');
  for (const a of adapters) {
    // Clipped, never wrapped: `render.ts`'s one rule.
    const line = fmt.clip(a.line, Math.max(20, t.width - 4));
    card.raw(`    ${a.supported ? line : t.dim(line)}`);
  }
  card.text(t.dim(fmt.clip(cursorAdapter.CURSOR_DOCTOR_NOTE, Math.max(20, t.width - 4))));

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

interface AdapterStatus {
  harness: string;
  supported: boolean;
  /** The phase that will support it. 1 for the four that now do. */
  phase: number;
  path: string;
  /** The adapter's own one-liner — every adapter owns the words about itself. */
  line: string;
}

/**
 * The adapter block.
 *
 * Each supported adapter exports its own `doctorLine()`, because the facts
 * worth printing differ per harness — codex has a cli version, cursor has
 * fields it can never recover, claude has sidechains — and the adapter is the
 * only place that knows them. `doctor` supplies the block, not the sentences.
 */
async function adapterStatus(o: DoctorOptions): Promise<AdapterStatus[]> {
  const out: AdapterStatus[] = [];
  const claudeOptions = {
    ...(o.claudeDir ? { claudeDir: o.claudeDir } : {}),
    ...(o.potsherdDir ? { potsherdDir: o.potsherdDir } : {}),
  };
  out.push({
    harness: 'claude',
    supported: true,
    phase: 1,
    path: claudeAdapter.sourceDir(o.claudeDir),
    line: claudeAdapter.doctorLine(claudeOptions),
  });

  const codexReport = await codexAdapter.codexDoctor();
  out.push({
    harness: 'codex',
    supported: true,
    phase: 1,
    path: codexReport.sourceDir,
    line: codexAdapter.doctorLine(codexReport),
  });

  out.push({
    harness: 'cursor',
    supported: true,
    phase: 1,
    path: cursorAdapter.cursorProjectsDir(),
    line: cursorAdapter.doctorLine(),
  });

  out.push({
    harness: 'pi',
    supported: true,
    phase: 1,
    path: piAdapter.sourceDir(),
    line: piAdapter.doctorLine(),
  });

  // Not yet written. `doctor` still names the directory it would read, so a
  // user of one of these knows potsherd has not silently ignored them.
  for (const [harness, dir] of [
    ['gemini', paths.harnessSourceDirs().find((h) => h.harness === 'gemini')?.dir ?? ''],
    ['opencode', paths.opencodeDir()],
    ['copilot', paths.harnessSourceDirs().find((h) => h.harness === 'copilot')?.dir ?? ''],
  ] as const) {
    out.push({
      harness,
      supported: false,
      phase: 6,
      path: dir,
      line: `${harness.padEnd(12)}${'phase 6'.padEnd(10)}${paths.tildify(dir).padEnd(28)}  not yet parsed`,
    });
  }
  return out;
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

export const VERSION_STRING = '0.1.0';

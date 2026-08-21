import fs from 'node:fs';
import nodePath from 'node:path';
import process from 'node:process';
import {
  VERSION,
  audit,
  claude as claudeAdapter,
  codex as codexAdapter,
  countsJson,
  cursor as cursorAdapter,
  detectBackend,
  MODEL_CALL_VERBS,
  NoBackendError,
  OFFLINE_VERBS,
  db as store,
  paths,
  pi as piAdapter,
  format as fmt,
  Card,
  consent,
  redactionRow,
  storedRecordTypes,
  storedRedactionCounts,
  Theme,
  vecStatus,
  emptyCounts,
  setup,
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
      // Before the counts: `vec_exchanges` is a virtual table and does not
      // exist for a connection that has not loaded the extension, so counting
      // it first would silently report zero vectors on a fully vectorised
      // index. A read-only connection can still load an extension.
      vec = vecStatus(db);
      for (const table of ['sessions', 'exchanges', 'tool_calls', 'ghosts', 'ghost_prompts', 'cards', 'tags', 'pins', 'links', 'archive_files', 'rescue_log', 'vec_exchanges']) {
        counts[table] = store.count(db, table);
      }
      redaction = storedRedactionCounts(db);
      indexedTypes = storedRecordTypes(db);
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
  // `audit` only ever reads claude's tree. `index` reads all seven harnesses,
  // so `--privacy` must list all seven — from `paths.harnessSourceDirs()`, the
  // one module every adapter now resolves its directory through (finding F9),
  // so this list cannot drift from what the code actually opens.
  const harnessReads = paths
    .harnessSourceDirs(o.claudeDir ? { claudeDir: o.claudeDir } : {})
    .map((h) => h.dir);
  const reads = dedupe([...report.pathsRead, ...harnessReads]);
  const written = [
    root,
    paths.archiveDir(root),
    dbFile,
    paths.modelsDir(root),
    // `graft` is the one verb that writes outside ~/.potsherd: the brief lands
    // in the project you run it in, which is the entire point of the verb.
    // `03` §11 says this receipt lists *every* path written — and it has
    // under-reported once already, when it still said "no network" after the
    // product had started calling a model. So it lists this one.
    nodePath.join(process.cwd(), '.potsherd', 'graft-<id8>.md'),
    // And `ask --readers-out` is the second, at a path the user names. It
    // holds the same redacted excerpts a model would have been sent, and no
    // model was called to write it.
    '<the path you give to  ask --readers-out>',
  ];
  const settingsFile = paths.claudePaths(report.claudeDir).settings;
  // `setup` writes one MCP stanza into each agent's own config file. That is
  // the only place potsherd writes into another tool's directory, it is gated
  // on an explicit y at a diff, and every other server in those files is
  // preserved — but it is a write, so it is listed.
  const mcpConfigs = setup.setupWritePaths();
  const consented = [settingsFile, ...mcpConfigs];
  // AND, BESIDE EACH OF THEM, A BACKUP. Every consented write copies the file
  // it is about to change to `<file>.potsherd-bak-<UTC>` first. That is a file
  // potsherd creates in somebody else's directory, and until T5.9 this receipt
  // named the eight configs and said nothing about the eight copies — while
  // claiming, two lines below, that "every other server in those files is
  // preserved", which reads as an exhaustive account of what setup does to
  // them. `03` §11 says this receipt lists every path written; these are paths
  // written.
  const backups = consented.map((p) => `${p}.potsherd-bak-<UTC>`);

  if (o.privacy) {
    const network = networkDisclosure();
    if (o.json) {
      printJson({
        reads,
        writes: written,
        writesWithConsent: [...consented, ...backups],
        network,
      });
      return 0;
    }
    const t = themeFrom(o);
    const card = new Card(t);
    card.heading('doctor --privacy', fmt.date(new Date())).blank();
    // Paths are the one thing here that can outrun any terminal, so they elide
    // in the middle: the last segment is what identifies a file.
    const pathW = Math.max(24, t.width - 16);
    const show = (p: string) => fmt.elideMiddle(paths.tildify(p), pathW, t);

    card.text('reads (never modified):');
    for (const p of reads) {
      card.raw(`    ${show(p)}${fs.existsSync(p) ? '' : t.dim('  (absent)')}`);
    }
    card.blank().text('writes:');
    for (const p of written) {
      card.raw(`    ${show(p)}`);
      // A note per path, not one line after the loop: two of these are
      // conditional now, and a single trailing sentence could only describe one
      // of them truthfully.
      if (p.endsWith('graft-<id8>.md')) {
        card.raw(`      ${t.dim('only when you run graft, in the directory you run it in')}`);
      } else if (p.startsWith('<the path you give')) {
        card.raw(`      ${t.dim('only when you pass the flag. it holds the same redacted excerpts a')}`);
        card.raw(`      ${t.dim('model would have been sent, and no model was called to write it')}`);
      }
    }
    card.blank().text('writes only after an explicit y at a diff:');
    card.raw(`    ${show(settingsFile)}`);
    card.raw(`      ${t.dim('cleanupPeriodDays, and one SessionStart hook entry')}`);
    for (const p of mcpConfigs) card.raw(`    ${show(p)}`);
    card.raw(`      ${t.dim('one "potsherd" MCP server entry each, from potsherd setup.')}`);
    card.raw(`      ${t.dim('every other server in those files is preserved.')}`);
    card.raw(`    ${t.dim('…and beside each of those')} ${String(consented.length)}${t.dim(':')}  <that file>.potsherd-bak-<UTC>`);
    card.raw(`      ${t.dim('a copy of the file as it was, taken before potsherd changes it.')}`);
    card.raw(`      ${t.dim('one per write. potsherd never reads them back and never removes')}`);
    card.raw(`      ${t.dim('them; delete them yourself once you are happy with the change.')}`);
    // The largest privacy-relevant thing potsherd does is no longer "reads
    // your files": from phase 2 on it *sends* some of them. A receipt that
    // still said "no network" would be the worst class of bug this project
    // has, so what leaves the machine is stated before what does not.
    card.blank().text('leaves this machine:');
    card.raw(`    ${t.accent('redacted slices of your transcripts')}, sent to a model as the`);
    card.raw('    text of one prompt. redaction runs first, in one place, on');
    card.raw('    every outgoing string — there is no --no-redact flag.');
    card.raw('    nothing else is ever sent: no file is uploaded, no path, no');
    card.raw('    index, no counts, no identifiers.');

    card.blank().text('only these verbs call a model:');
    const verbNote: Record<string, string> = {
      card: 'writes the cards; one call per slice',
      ask: 'one call, over the shortlist it retrieved',
      graft: 'one call, to compress one session into a brief',
    };
    for (const verb of MODEL_CALL_VERBS) {
      const note = verbNote[verb];
      card.raw(`    potsherd ${verb.padEnd(8)}${note ? `  ${note}` : ''}`.trimEnd());
    }
    card.blank().text('these never do, and open no socket at all:');
    // Wrapped, not elided: the whole value of this line is that a reader can
    // find their verb in it, and `ls…w, stats` is a list with the answer cut
    // out of the middle.
    for (const line of fmt.wrap(OFFLINE_VERBS.join(', '), pathW)) card.raw(`    ${line}`);

    card.blank().text('who receives them:');
    for (const line of fmt.wrap(network.to, pathW)) card.raw(`    ${line}`);
    for (const line of network.detail) card.raw(`    ${t.dim(line)}`);

    card
      .blank()
      // This paragraph asserted, until 2026-08-22, that `index` "announces
      // before it starts" — full stop. Phase 5 built a path where it does
      // not: the plugin's SessionEnd hook runs `index --quiet`, and `--quiet`
      // returns from `onModelDownload` before printing. One SessionEnd firing
      // fetched 33 MB with nothing shown. A receipt that describes an
      // announcement it does not always make is the same failure as the
      // "no network" line this project shipped once already (`08` rule 1), so
      // the suppressing flags are named and the hook's own warning is stated.
      .text('no other network, except the one-off embedding-model download.')
      .text('`potsherd index` names it before it starts, but `--quiet` and')
      .text('`--json` suppress that line, and `--quiet` is how the plugin\'s')
      .text('SessionEnd hook runs it — so its SessionStart hook warns you first.')
      .text('`--no-embed` skips the download entirely.')
      .text('no telemetry. no account. potsherd stores no credential of its own.');
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
      // Exact per-(harness, version, type) counts over every session in the
      // index, summed from `session_record_types`. `recordTypes` above is the
      // audit's head/tail estimate and stays for machines that never indexed.
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
      note:
        `${fmt.num(report.titledSessions)} titled ${t.mid} ${fmt.num(report.sdkSessions)} sdk ` +
        `${t.mid} ${fmt.bytes(report.bytes)}`,
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
        ? `${fmt.num(counts['exchanges'] ?? 0)} ${fmt.plural(counts['exchanges'] ?? 0, 'exchange')} ${t.mid} ` +
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
      value: vec.available ? fmt.num(counts['vec_exchanges'] ?? 0) : t.dash,
      note: vec.available
        ? `sqlite-vec ${vec.version ?? 'loaded'} ${t.mid} bge-small, 384-d`
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
    // Summed across harness versions — the full (harness, version, type) table
    // is in `--json`, and on this corpus it is a hundred rows. What a person
    // needs on screen is which types exist, how many, in how many builds, and
    // whether any of them is one no format note has described yet.
    //
    // These are the counts over everything the index currently holds, not over
    // whatever the last `index` pass happened to open: they are stored per
    // session (`session_record_types`, migration 5) and summed here.
    card.blank().text('record types the parsers did not consume, over the whole index:');
    for (const line of recordTypeLines(foldRecordTypes(indexedTypes), t)) card.raw(line);
    card.text(t.dim('"new" means no note in research/formats.md describes it yet.'));
  } else {
    card.blank().text('record types seen (head/tail scan — run potsherd index for exact counts):');
    for (const [type, n] of Object.entries(unknownTypes).sort((a, b) => b[1] - a[1])) {
      card.raw(`    ${fmt.elide(type, Math.max(12, t.width - 13), t).padEnd(24)}${fmt.num(n).padStart(7)}`);
    }
  }

  card.blank().text('adapters:');
  for (const a of adapters) {
    // Clipped, never wrapped: `render.ts`'s one rule.
    const line = fmt.clip(a.line, Math.max(20, t.width - 4), t);
    card.raw(`    ${a.supported ? line : t.dim(line)}`);
  }
  card.text(t.dim(fmt.clip(cursorAdapter.CURSOR_DOCTOR_NOTE, Math.max(20, t.width - 4), t)));

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

/**
 * One line per record type, laid out so that **the name is never the thing
 * that gets elided**.
 *
 * The name is the only part a reader can act on — `queue-operation` sends you
 * to a format note, `user:injected-continua…` sends you nowhere — so it takes
 * every column the fixed fields do not need, and when even that is not enough
 * the row wraps onto a second line rather than losing its identity. The
 * version column is what gives ground at 60 columns (`2 versions` → `2v`), and
 * the whole line is exactly `t.width` at 80 and at 60: the two-space gap after
 * the count is deliberate, and a third space is what pushed every `known` row
 * one character past `--width 60`.
 */
function recordTypeLines(rows: readonly FoldedRecordType[], t: Theme): string[] {
  const wide = t.width >= 74;
  const countW = 7;
  const versionW = wide ? 11 : 3;
  const markW = 5;
  const nameW = Math.max(12, t.width - 4 - countW - 2 - versionW - 1 - markW);
  const out: string[] = [];
  for (const row of rows) {
    const name = `${row.harness} ${row.type}`;
    const mark = row.novel ? t.warn('new') : t.dim('known');
    const versions = wide
      ? row.versions === 1 ? '1 version' : `${row.versions} versions`
      : `${row.versions}v`;
    const tail = `${fmt.num(row.count).padStart(countW)}  ${t.dim(versions.padEnd(versionW))} ${mark}`;
    if (name.length <= nameW) {
      out.push(`    ${name.padEnd(nameW)}${tail}`);
    } else {
      // Wrapped, not truncated. A name too long for any terminal still elides
      // in the middle, where the least identifying characters are.
      out.push(`    ${fmt.elideMiddle(name, Math.max(12, t.width - 4), t)}`);
      out.push(`    ${' '.repeat(nameW)}${tail}`);
    }
  }
  return out;
}

interface FoldedRecordType {
  harness: string;
  type: string;
  count: number;
  versions: number;
  novel: boolean;
}

/** `(harness, version, type)` rows summed to `(harness, type)`, novel first. */
function foldRecordTypes(rows: readonly RecordTypeRow[]): FoldedRecordType[] {
  const out = new Map<string, FoldedRecordType>();
  for (const row of rows) {
    const key = `${row.harness} ${row.type}`;
    const at = out.get(key);
    if (at) {
      at.count += row.count;
      at.versions += 1;
      at.novel = at.novel || row.novel;
    } else {
      out.set(key, {
        harness: row.harness,
        type: row.type,
        count: row.count,
        versions: 1,
        novel: row.novel,
      });
    }
  }
  return [...out.values()].sort(
    (a, b) => Number(b.novel) - Number(a.novel) || b.count - a.count || (a.type < b.type ? -1 : 1),
  );
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** Re-exported under the old name so existing callers keep working. */
export const VERSION_STRING = VERSION;

/**
 * Where this machine's model calls would actually go, detected rather than
 * assumed.
 *
 * `04` Q4's backend choice *is* the answer to "who receives my transcripts",
 * so the receipt runs the same detection `card` runs. It reads a binary's
 * presence and one environment variable; it makes no call and needs no
 * credential to answer, which is what lets `--privacy` stay the one section
 * that is safe to run before you trust anything.
 */
export function networkDisclosure(): { backend: string | null; to: string; detail: string[] } {
  try {
    const choice = detectBackend();
    if (choice.backend === 'api') {
      return {
        backend: 'api',
        to: 'api.anthropic.com, on your own ANTHROPIC_API_KEY.',
        detail: [
          'metered against that key. potsherd never stores or logs it.',
          'this is the fallback path: install Claude Code and it is not used.',
        ],
      };
    }
    // The path, shortened the way every other path in this receipt is: what
    // identifies a binary is its last segment, and a shim path can be 100
    // characters of temp directory.
    const bin = choice.bin
      ? fmt.elideMiddle(paths.tildify(choice.bin), 46, '...')
      : choice.backend;
    return {
      backend: choice.backend,
      to: `your own ${choice.backend === 'codex' ? 'codex' : 'Claude'} subscription, via ${bin}`,
      detail: [
        'the same binary and the same account you already use by hand.',
        'potsherd holds no key, no token and no account of its own.',
        'the call runs with no tools, in an empty scratch directory, and',
        'its session is never written to ~/.claude/projects.',
      ],
    };
  } catch (err) {
    if (!(err instanceof NoBackendError)) throw err;
    return {
      backend: null,
      to: 'nobody — there is no model backend on this machine.',
      detail: [
        'no `claude` binary and no ANTHROPIC_API_KEY, so `potsherd card`',
        'refuses rather than calling anything. every other verb still works.',
      ],
    };
  }
}

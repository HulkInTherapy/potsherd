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
  LOCAL_SOCKET_VERBS,
  OFFLINE_VERBS,
  db as store,
  paths,
  pi as piAdapter,
  gemini as geminiAdapter,
  opencode as opencodeAdapter,
  copilot as copilotAdapter,
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
import { BRIDGE_READ_PATHS, EXPORT_WRITE_PATHS } from '../privacy-paths.js';
import { search as searchNs } from '@potsherd/core';

// The ignore list. It reaches `doctor` through the `search` namespace because
// that is where the filter vocabulary lives (`SearchFilters.excludeProjects`),
// and because `packages/core/src/index.ts` is reserved on the branch this
// landed on.
const { readIgnoreConfig, ignoredProjectsInIndex, countIgnoredSessions } = searchNs;

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

  // The ignore list, read whether or not it is empty. `doctor` is the one
  // screen that prints it in full and by name: `ls`, `find` and `stats` print
  // only a count, because they are screenshot surfaces and these are
  // directories off the user's own machine.
  const ignoreConfig = readIgnoreConfig(root);
  const ignoreProjects = ignoreList(root, dbExists, ignoreConfig.list);

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
    // `03` §11 promises "~/.potsherd and the four things inside it" and then
    // lists three. This is the fourth, and until `potsherd ignore` there was
    // nothing that wrote it — the path had been resolvable since phase 0 and
    // unused. It is an unprompted write inside potsherd's own directory, so it
    // is named here rather than left to the reader to infer from the directory
    // above it.
    paths.configPath(root),
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
    // T6.6 D13 — and `export` is the third. `EXPORT_WRITE_PATHS` was declared
    // in `commands/export.ts` labelled "Exported for the registration file's
    // `doctor --privacy` line" and had zero consumers, so the one verb that
    // writes a directory of files wherever you point it appeared nowhere in
    // the list of what potsherd writes.
    ...EXPORT_WRITE_PATHS,
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
        // The same list the human view prints, so a script and a person are
        // reading one receipt.
        bridgeReads: BRIDGE_READ_PATHS.map((b) => b.path),
        writes: written,
        writesWithConsent: [...consented, ...backups],
        network,
        ignore: ignoreConfig.list,
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

    /**
     * A note under a path, wrapped to whatever width this terminal is.
     *
     * These used to be hand-split string literals, broken at roughly 72
     * characters — which is a screen designed for exactly one width. `05` asks
     * for 80 degrading to 60, and at 60 this receipt overflowed on **fourteen
     * lines**, found by widening the width check from the two verbs that had
     * once been caught to all twenty-three.
     *
     * Written as whole sentences and wrapped here, so the receipt is right at
     * any width and there is no second copy of the prose to keep in step.
     */
    const note = (text: string, indent = 6): void => {
      const pad = ' '.repeat(indent);
      // Verbatim when it fits. `fmt.wrap` collapses runs of spaces, and the
      // double space in `with  --with / --to` is the design system's, not an
      // accident — so a line that never needed wrapping does not get it.
      if (Theme.len(pad + text) <= t.width) {
        card.raw(`${pad}${t.dim(text)}`);
        return;
      }
      for (const line of fmt.wrap(text, Math.max(20, t.width - indent - 1))) {
        card.raw(`${pad}${t.dim(line)}`);
      }
    };

    card.text('reads (never modified):');
    for (const p of reads) {
      card.raw(`    ${show(p)}${fs.existsSync(p) ? '' : t.dim('  (absent)')}`);
    }
    // T6.6 D13 — the other tools' stores. `03` §11 says this receipt lists
    // every path read, and until now it listed none of these: `find --with`
    // and `export --to` read a claude-mem database, an agentmemory store and
    // the CLAUDE.md files the notes bridge walks up from the working
    // directory. Written out rather than computed, because resolving them
    // would put `@potsherd/bridges` — and its localhost socket — into an
    // offline verb's import graph; `tests/bridges.test.ts` asserts each one
    // against the bridge's own path helper so they cannot drift.
    note('…and these, only when you name them with  --with / --to:', 4);
    for (const b of BRIDGE_READ_PATHS) {
      card.raw(`    ${show(b.path)}`);
      note(b.note);
    }
    card.blank().text('writes:');
    for (const p of written) {
      card.raw(`    ${show(p)}`);
      // A note per path, not one line after the loop: two of these are
      // conditional now, and a single trailing sentence could only describe one
      // of them truthfully.
      if (p.endsWith('config.json')) {
        note('your settings: the ignore list, written by potsherd ignore / unignore');
      } else if (p.endsWith('graft-<id8>.md')) {
        note('only when you run graft, in the directory you run it in');
      } else if (p.startsWith('<the path you give')) {
        note(
          'only when you pass the flag. it holds the same redacted excerpts a model ' +
            'would have been sent, and no model was called to write it',
        );
      } else if (p.startsWith('<the dir you give')) {
        note('one markdown file per card, only when you run export');
      } else if (p.startsWith('<your agentmemory')) {
        note(
          "rows into another tool's store. never without --yes, and never at all " +
            'unless you asked for that target',
        );
      }
    }
    card.blank().text('writes only after an explicit y at a diff:');
    card.raw(`    ${show(settingsFile)}`);
    note('cleanupPeriodDays, and one SessionStart hook entry');
    for (const p of mcpConfigs) card.raw(`    ${show(p)}`);
    note(
      'one "potsherd" MCP server entry each, from potsherd setup. every other ' +
        'server in those files is preserved.',
    );
    note(
      `…and beside each of those ${String(consented.length)}:  <that file>.potsherd-bak-<UTC>`,
      4,
    );
    note(
      'a copy of the file as it was, taken before potsherd changes it. one per ' +
        'write. potsherd never reads them back and never removes them; delete them ' +
        'yourself once you are happy with the change.',
    );
    // The largest privacy-relevant thing potsherd does is no longer "reads
    // your files": from phase 2 on it *sends* some of them. A receipt that
    // still said "no network" would be the worst class of bug this project
    // has, so what leaves the machine is stated before what does not.
    card.blank().text('leaves this machine:');
    {
      // The accent belongs on the first phrase, so the wrap is computed over
      // the plain sentence and the phrase is coloured back in afterwards. It
      // is the one accent on this screen (`05`: one per card).
      const lead = 'redacted slices of your transcripts';
      const body =
        `${lead}, sent to a model as the text of one prompt. redaction runs ` +
        'first, in one place, on every outgoing string — there is no --no-redact ' +
        'flag. nothing else is ever sent: no file is uploaded, no path, no index, ' +
        'no counts, no identifiers.';
      const lines = fmt.wrap(body, Math.max(20, t.width - 5));
      lines.forEach((line, i) => {
        card.raw(`    ${i === 0 && line.startsWith(lead) ? t.accent(lead) + line.slice(lead.length) : line}`);
      });
    }

    card.blank().text('only these verbs call a model:');
    const verbNote: Record<string, string> = {
      card: 'writes the cards; one call per slice',
      ask: 'one call, over the shortlist it retrieved',
      graft: 'one call, to compress one session into a brief',
    };
    const socketNote: Record<string, string> = {
      find: '--with <tool>, to read another tool\'s store',
      export: '--to <tool>, to write rows into one',
    };
    const verbRow = (verb: string, gloss?: string): void => {
      const head = `    potsherd ${verb.padEnd(8)}`;
      // The verb is the thing a reader is looking for, so the gloss elides.
      const room = t.width - head.length - 2;
      card.raw(
        (gloss && room >= 12 ? `${head}  ${fmt.elide(gloss, room, t)}` : head).trimEnd(),
      );
    };
    for (const verb of MODEL_CALL_VERBS) verbRow(verb, verbNote[verb]);
    card.blank().text('these never do, and open no socket at all:');
    // Wrapped, not elided: the whole value of this line is that a reader can
    // find their verb in it, and `ls…w, stats` is a list with the answer cut
    // out of the middle.
    for (const line of fmt.wrap(OFFLINE_VERBS.join(', '), pathW)) card.raw(`    ${line}`);

    // T6.6 D2/D12. `find` and `export` were in the list above, under the words
    // "open no socket at all", while both were probing 127.0.0.1 and spawning
    // another program to talk to. The fix was not to move the word `export`
    // into a screenshot — it was to stop the receipt saying something false,
    // and only then regenerate the screen. `LOCAL_SOCKET_VERBS` carries the
    // whole reasoning.
    card.blank().text('these call no model either, but do open a socket on');
    note('this machine — and only when you ask them to:', 2);
    for (const verb of LOCAL_SOCKET_VERBS) verbRow(verb, socketNote[verb]);
    note(
      'claude-mem is read over http://127.0.0.1; agentmemory by launching its mcp ' +
        'server, itself a shim over an http backend on localhost. nothing leaves ' +
        'this machine, and without the flag neither opens anything at all.',
    );

    card.blank().text('who receives them:');
    for (const line of fmt.wrap(network.to, pathW)) card.raw(`    ${line}`);
    for (const line of network.detail) note(line, 4);

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
      // 8.6 flipped the default, so the sentence that used to end '`--no-embed`
      // skips the download entirely' now describes an escape hatch from a thing
      // that no longer happens by default. It says what does happen instead.
      .text('no other network, except the one-off embedding-model download,')
      .text('and only when you ask for it.');
    for (const line of fmt.wrap(
      'A plain `potsherd index` fetches nothing: text search is the ' +
        'default, it needs no model, and it opens no socket at all. `potsherd index ' +
        '--embed` is what asks for the model, and it names the download before it ' +
        "starts — but `--quiet` and `--json` suppress that line, and `--quiet` is " +
        "how the plugin's SessionEnd hook runs it, so its SessionStart hook warns " +
        'you first.',
      Math.max(20, t.width - 3),
    )) {
      card.raw(`  ${line}`);
    }
    for (const line of fmt.wrap(
      'no telemetry. no account. potsherd stores no credential of its own.',
      Math.max(20, t.width - 3),
    )) {
      card.raw(`  ${line}`);
    }
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
      db: {
        path: dbFile,
        exists: dbExists,
        schemaVersion: schema,
        latest: store.latestSchemaVersion(),
        // Which SQLite is answering. Two can, and which one changes what the
        // product can do — a machine-readable consumer needs it as much as the
        // human view does.
        driver: store.sqliteDriverName(),
        counts,
      },
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
      ignore: {
        config: ignoreConfig.file,
        entries: ignoreConfig.list,
        ...(ignoreConfig.error ? { error: ignoreConfig.error } : {}),
        projects: ignoreProjects.projects,
        sessions: ignoreProjects.sessions,
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
    {
      label: 'database',
      value: '',
      note: dbExists
        ? `schema v${schema} of v${store.latestSchemaVersion()}${schemaNote(schema, vec)}`
        : 'not created yet — run potsherd rescue',
    },
    { label: 'sqlite', value: '', note: sqliteNote() },
  ]);
  card.blank();
  card.rows([
    {
      label: 'sessions on disk',
      value: fmt.num(report.onDiskFiles),
      // The live corpus's size belongs to this row, not to `files archived`.
      note:
        // `harness-titled`, not `titled`. `stats` prints `31 titled` for this
        // same corpus and means something else by it — every session that has
        // a NAME, including the 8.2 titles potsherd derives from the first
        // substantive prompt. This line counts only the ones the harness
        // itself named, which is what `doctor` is for: what is on disk and
        // what came with it. Two screens, one word, two numbers, and neither
        // said which question it answered — `09 §13.12`.
        `${fmt.num(report.titledSessions)} harness-titled ${t.mid} ${fmt.num(report.sdkSessions)} sdk ` +
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
  card.text(t.dim(fmt.clip(geminiAdapter.GEMINI_DOCTOR_NOTE, Math.max(20, t.width - 4), t)));
  card.text(t.dim(fmt.clip(opencodeAdapter.OPENCODE_DOCTOR_NOTE, Math.max(20, t.width - 4), t)));
  card.text(t.dim(fmt.clip(copilotAdapter.COPILOT_DOCTOR_NOTE, Math.max(20, t.width - 4), t)));

  // `03` §8.4: "doctor prints the ignore list". Printed only when there is one
  // — a fresh install ignores nothing, and a line saying so on every doctor run
  // would be a permanent answer to a question nobody asked. A *broken*
  // config.json is always printed, because an unreadable settings file and an
  // empty list look identical from the outside and only one of them is a
  // problem the user can fix.
  if (ignoreConfig.error) {
    card.blank().text(t.warn(`ignore list: ${ignoreConfig.error}`));
    card.text(t.dim(fmt.elideMiddle(paths.tildify(ignoreConfig.file), Math.max(20, t.width - 4), t)));
  } else if (ignoreConfig.list.length > 0) {
    card.blank().text('ignored — hidden from ls, find, ask and stats (--all shows them):');
    for (const entry of ignoreConfig.list) {
      card.raw(`    ${fmt.elideMiddle(paths.tildify(entry), Math.max(20, t.width - 4), t)}`);
    }
    const p = ignoreProjects.projects.length;
    const n = ignoreProjects.sessions;
    card.text(
      t.dim(
        `${fmt.num(p)} ${fmt.plural(p, 'project')} in the index ${t.mid} ${fmt.num(n)} ${fmt.plural(n, 'session')} hidden ${t.mid} potsherd unignore <project>`,
      ),
    );
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

/**
 * The projects an ignore list actually names in this index, and their session
 * count. Zero of both when there is no database yet — `doctor` runs before
 * `index` does, and an ignore list is legal before anything is indexed.
 */
function ignoreList(
  root: string,
  dbExists: boolean,
  entries: readonly string[],
): { projects: string[]; sessions: number } {
  if (!dbExists || entries.length === 0) return { projects: [], sessions: 0 };
  const db = store.open({ root, readonly: true });
  try {
    const projects = ignoredProjectsInIndex(db, entries);
    return { projects, sessions: countIgnoredSessions(db, projects) };
  } catch {
    return { projects: [], sessions: 0 };
  } finally {
    db.close();
  }
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
  /**
   * T6.6 D6 — was this parser ever run against a real store?
   *
   * `false` for the four adapters written against real transcripts; `true` for
   * the three written from documentation alone (`<NAME>_FORMAT_UNVERIFIED`).
   *
   * It is a field and not a word inside {@link line} because `line` is clipped
   * to the terminal width and, when the tool is **absent**, does not carry the
   * word at all — and absent is the state on every machine that does not have
   * the tool. `doctor --json` is documented as the API, and the API said
   * `supported: true` with nothing to distinguish a parser that has read a
   * thousand real sessions from one that has read none.
   */
  unverified: boolean;
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
    unverified: false,
    path: claudeAdapter.sourceDir(o.claudeDir),
    line: claudeAdapter.doctorLine(claudeOptions),
  });

  const codexReport = await codexAdapter.codexDoctor();
  out.push({
    harness: 'codex',
    supported: true,
    phase: 1,
    unverified: false,
    path: codexReport.sourceDir,
    line: codexAdapter.doctorLine(codexReport),
  });

  out.push({
    harness: 'cursor',
    supported: true,
    phase: 1,
    unverified: false,
    path: cursorAdapter.cursorProjectsDir(),
    line: cursorAdapter.doctorLine(),
  });

  out.push({
    harness: 'pi',
    supported: true,
    phase: 1,
    unverified: false,
    path: piAdapter.sourceDir(),
    line: piAdapter.doctorLine(),
  });

  // Phase 6, T6.1. All three are `unverified — documentation only`: none was
  // present with sessions on the machine they were written on, so each was
  // built against `plans/research/formats.md` (which marks all three sections
  // **unmeasured**) and synthetic fixtures. Each adapter's own `doctorLine()`
  // says so, and distinguishes **not installed** from **installed with no
  // sessions** from **parsed** — "0 sessions" alone cannot tell those apart.
  out.push({
    harness: 'gemini',
    supported: true,
    phase: 6,
    unverified: geminiAdapter.GEMINI_FORMAT_UNVERIFIED,
    path: geminiAdapter.sourceDir(),
    line: geminiAdapter.doctorLine(),
  });

  out.push({
    harness: 'opencode',
    supported: true,
    phase: 6,
    unverified: opencodeAdapter.OPENCODE_FORMAT_UNVERIFIED,
    path: opencodeAdapter.sourceDir(),
    line: opencodeAdapter.doctorLine(),
  });

  out.push({
    harness: 'copilot',
    supported: true,
    phase: 6,
    unverified: copilotAdapter.COPILOT_FORMAT_UNVERIFIED,
    path: copilotAdapter.sourceDir(),
    line: copilotAdapter.doctorLine(),
  });

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


/**
 * Which SQLite is answering.
 *
 * Two can, and which one is running changes what the product can do, so it is
 * on the screen rather than inferable. `better-sqlite3` is the native addon and
 * the only one that has ever had vector search; `node:sqlite` is Node's own,
 * needs no install at all, and is what a plugin installed from the marketplace
 * runs on — the whole reason a marketplace install works now.
 */
function sqliteNote(): string {
  const kind = store.sqliteDriverName();
  if (kind === 'better-sqlite3') return 'better-sqlite3 (native addon)';
  if (kind === 'node:sqlite') return "node:sqlite — Node's own, no install needed";
  return 'none — nothing that reads the index can run';
}

/**
 * Why the schema number can legitimately be lower than the latest.
 *
 * `schemaVersion()` reports the highest *contiguous* migration, and migrations
 * 4 and 8 are the `sqlite-vec` ones, which are allowed to decline on a machine
 * without the extension. So `schema v3 of v8` on a working install is not a
 * failed migration; it is vector search being absent, and saying which is the
 * difference between a number that alarms and a number that informs.
 */
function schemaNote(schema: number, vec: VecStatus): string {
  if (schema >= store.latestSchemaVersion()) return '';
  // Migrations 4 and 8 create the `vec0` tables and are allowed to decline on a
  // machine without `sqlite-vec` — `schemaVersion()` reports the highest
  // *contiguous* version, so one declining migration holds the number down
  // even though everything after it applied. `schema v3 of v8` on a perfectly
  // working install therefore alarms for no reason unless the line says which
  // it is. A declining migration is not recorded, so the next writable open
  // retries it, and `index` is the verb that does one.
  return vec.available ? '  · run potsherd index' : '  · the rest needs sqlite-vec';
}

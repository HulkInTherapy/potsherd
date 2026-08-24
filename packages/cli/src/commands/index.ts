import { spawn } from 'node:child_process';
import process from 'node:process';
import {
  Card,
  countsJson,
  db as store,
  embeddings,
  format as fmt,
  indexAll,
  lock,
  paths,
  vecStatus,
  type Harness,
  type HarnessReport,
  type IndexReport,
  type RedactionCounts,
  type Row,
  type VecStatus,
} from '@potsherd/core';
import type { Database as Db } from 'better-sqlite3';
import { print, printJson, Progress, themeFrom, UserError, type GlobalOptions } from '../output.js';

/**
 * The environment variable that turns this verb into the background embedder.
 *
 * A variable rather than a flag because the flag list is the product's public
 * surface and this is not a thing anyone should ever type. `index` sets it on
 * the child it spawns; nothing else sets it, and if a user sets it by hand all
 * they get is the same work done in the foreground with no output.
 */
const WORKER_ENV = 'POTSHERD_EMBED_WORKER';

export interface IndexCommandOptions extends GlobalOptions {
  full?: boolean;
  incremental?: boolean;
  harness?: string;
  /**
   * Tri-state, and the middle state is the one that changed (phase 10 §A2).
   *
   *   `undefined` — no flag, and **the default**. Text search is live when the
   *                 verb returns; the embedding runtime is fetched and the
   *                 vectors are built in a detached background process. The
   *                 user is told, in one line, and is never asked.
   *   `true`      — `--embed`. Do the same work in the **foreground**, with a
   *                 progress bar, and do not return until it is finished. For
   *                 anyone who wants to watch it, or to script "index, then
   *                 search" without a wait loop.
   *   `false`     — `--no-embed`. Text only, and nothing is spawned. The
   *                 offline/CI/metered-connection switch. It turns a capability
   *                 **off**; nothing has to be turned on.
   *
   * `--no-embed` used to be the default in all but name — no flag meant no
   * vectors — which made semantic search an opt-in tier and half of `find`
   * dead on arrival for everyone who never read the receipt's last line. That
   * default is what this removes.
   */
  embed?: boolean;
  session?: string;
}

/** The harnesses an adapter exists for. `03` §2 names three more; phase 6. */
const INDEXABLE: readonly string[] = ['claude', 'codex', 'cursor', 'pi'];
const NOT_YET: readonly string[] = ['gemini', 'opencode', 'copilot'];

/**
 * `potsherd index` — every transcript on this machine, parsed, redacted,
 * searchable, and on its way to being semantically searchable.
 *
 * Four promises this verb makes, in the order a user meets them:
 *
 *   1. **It is incremental by default.** A second run that finds nothing
 *      changed does no work and says so in well under a second. `--full`
 *      re-reads everything.
 *   2. **It returns as soon as text search is live.** Measured on the
 *      reference archive on 2026-08-23: 15.4 s for 332 transcripts, 1,678
 *      exchanges, 433 MB. Nothing about vectors is allowed to move that
 *      number, which is why the embedding pass is a detached child and not a
 *      phase of this one.
 *   3. **Semantic search arrives on its own.** The 48 MB wasm runtime and the
 *      quantized model are fetched once, in the background, into
 *      `~/.potsherd/models`; the vectors are built newest-first so the
 *      sessions you were just in are searchable within the first minute. One
 *      line says it is happening. Nothing asks, nothing blocks, and a machine
 *      that is offline forever gets a working text index and an honest line.
 *   4. **It never leaves a secret in the index.** Redaction runs before the
 *      first row is written (`03` §5), and the receipt prints what was masked.
 */
export async function runIndex(o: IndexCommandOptions): Promise<number> {
  if (process.env[WORKER_ENV] === '1') return runEmbedWorker(o);

  const t = themeFrom(o);
  const root = paths.potsherdDir(o.potsherdDir);
  const showProgress = !o.json && !o.quiet && Boolean(process.stderr.isTTY);

  if (o.full && o.incremental) {
    throw new UserError(
      '--full and --incremental ask for opposite things',
      'potsherd index --full     (or just: potsherd index)',
    );
  }
  const harnesses = parseHarnesses(o.harness);

  const bar = new Progress('indexing', showProgress);

  const report = await lock.withLockAsync(
    'index',
    () =>
      indexAll({
        root,
        potsherdDir: root,
        ...(o.claudeDir ? { claudeDir: o.claudeDir } : {}),
        ...(harnesses ? { harnesses } : {}),
        ...(o.session ? { sessionId: o.session } : {}),
        full: Boolean(o.full),
        // The parse pass never embeds. Whether it happens here, in a child, or
        // not at all is decided below, once text search is already live.
        embed: false,
        onProgress: (p) => {
          if (p.phase === 'parse') bar.update(p.done, p.total, `${p.harness}  ${p.note}`);
        },
      }),
    { root, wait: 2000 },
  );
  bar.done();

  // The vectors half of the receipt, and the only place it is computed.
  let vec = readVectors(root);
  let spawned = false;

  if (o.embed === true) {
    // The foreground path: the same work, watched.
    vec = await embedInForeground(root, showProgress);
  } else if (o.embed !== false && (vec.report?.pending ?? 0) > 0) {
    spawned = startBackgroundEmbedding(root, o);
  }

  if (o.json) {
    printJson({
      ...report,
      redaction: countsJson(report.redaction),
      redactionScope: 'run',
      // `embeddings` is what the *parse* pass did, and it never embeds now, so
      // reporting its `enabled: false` on a run that has just started the
      // background pass would be the same kind of lie audit F2 caught. The
      // three fields a consumer reads are corrected from the state of the
      // index; the rest of the shape is untouched so nothing downstream
      // breaks.
      embeddings: {
        ...report.embeddings,
        enabled: o.embed !== false,
        available: vec.available && (vec.report?.phase ?? 'unavailable') !== 'unavailable',
        upToDate: vec.report?.embedded ?? report.embeddings.upToDate,
      },
      // `--json` parity with the human view (audit F9): the same numbers, from
      // the same call, named the same way.
      vectors: vec.report ?? null,
      vectorBackend: vec.backend ?? null,
      embeddingInBackground: spawned,
      db: paths.dbPath(root),
    });
    return report.totals.failed ? 1 : 0;
  }
  if (o.quiet) return report.totals.failed ? 1 : 0;

  print(renderIndexReceipt(report, t, root, { embed: o.embed, vec, spawned }));
  return report.totals.failed ? 1 : 0;
}

// ------------------------------------------------------------ the embed pass

/** The one read of the vector state, used by the receipt, `--json`, and both paths. */
function readVectors(root: string): VecStatus {
  let db: Db | null = null;
  try {
    db = store.open({ root });
    return vecStatus(db, root);
  } catch (err) {
    return { available: false, reason: firstLine((err as Error)?.message ?? String(err)) };
  } finally {
    try {
      db?.close();
    } catch {
      /* already gone */
    }
  }
}

/**
 * `--embed`: acquire and embed here, with a progress bar, and do not return
 * until it is done.
 *
 * Two bars rather than one, because they are two different waits and a user
 * staring at a stalled percentage deserves to know which. The download is
 * announced before it starts — never discovered afterwards — and it names the
 * directory it lands in.
 */
async function embedInForeground(root: string, showProgress: boolean): Promise<VecStatus> {
  const fetchBar = new Progress('fetching', showProgress);
  const embedBar = new Progress('embedding', showProgress);
  let db: Db | null = null;
  try {
    db = store.open({ root });
    const before = vecStatus(db, root);
    await lock.withLockAsync(
      'embed',
      async () => {
        await before.embed?.({
          onProgress: (p) => {
            if (p.phase === 'acquire') fetchBar.update(p.done, p.total, p.file);
            else embedBar.update(p.done, p.total);
          },
        });
      },
      { root, wait: 5000, lane: 'embed' },
    );
    return vecStatus(db, root);
  } catch (err) {
    return { available: false, reason: firstLine((err as Error)?.message ?? String(err)) };
  } finally {
    fetchBar.done();
    embedBar.done();
    try {
      db?.close();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Start the detached child that does the embedding, and return whether it
 * started.
 *
 * The contract this has to keep is that a foreground verb is **never** slowed
 * or blocked by it: the child gets its own process group, its stdio goes
 * nowhere, and the parent unrefs it and exits. If spawning fails — a locked-down
 * environment, no executable path — that is not an error anybody needs to see:
 * the next `index`, or `--embed`, does the same work, and until then `find`
 * says `semantic search: warming` with a count that is not moving. Reporting a
 * failure the user cannot act on would be noise, and the state is visible in
 * `doctor`.
 */
function startBackgroundEmbedding(root: string, o: IndexCommandOptions): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  // FIX-B D3, and the whole of it. This used to spawn unconditionally, so a
  // user who ran `index` three times during one warming window ended up with
  // three detached embedders, all alive and all burning CPU — the verifier
  // measured 33:28, 24:46 and 1:01 of accumulated time over a 25-second
  // window. The lock could not stop them because it expired after five minutes
  // and a pass runs for hours (see `lock.isStale`); it can now, and this is
  // the cheaper half of the same answer: do not start a second one at all.
  //
  // A read, not an acquire: the child needs the lock, and a parent that took
  // it first would hand the child a lock it must then wait for.
  if (lock.holder({ root, lane: 'embed' })) return false;
  try {
    const child = spawn(
      process.execPath,
      [entry, 'index', '--quiet', '--potsherd-dir', root, ...(o.color === false ? ['--no-color'] : [])],
      {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, [WORKER_ENV]: '1' },
      },
    );
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * The background child. Parses nothing, prints nothing, and holds the embed
 * lane for the whole pass, so two of them never race.
 *
 * That sentence used to be here and used to be false, which is the worst kind
 * of comment because it stops the next reader checking. Two things make it
 * true now, and both are in `lock.ts`: a lock whose owner is alive is never
 * taken over, however long the pass runs; and the pass has a lane of its own,
 * so keeping the lock for hours costs no foreground verb anything.
 * `tests/embed-worker.test.ts` fails if either is undone.
 *
 * It exits 0 whatever happens, including when it cannot get the lock or cannot
 * reach the network, because nothing is watching it and a non-zero exit from an
 * unwatched process is a lie waiting to be found in a log.
 */
async function runEmbedWorker(o: IndexCommandOptions): Promise<number> {
  const root = paths.potsherdDir(o.potsherdDir);
  const cacheDir = paths.modelsDir(root);
  let db: Db | null = null;
  try {
    db = store.open({ root });
    const status = vecStatus(db, root);
    await lock.withLockAsync('embed', async () => void (await status.embed?.({ cacheDir })), {
      root,
      wait: 0,
      lane: 'embed',
    });
  } catch {
    // Locked by another worker, offline, or a database that moved. All three
    // are answered the same way: leave it for the next run.
  } finally {
    try {
      db?.close();
    } catch {
      /* already gone */
    }
  }
  return 0;
}

function parseHarnesses(raw?: string): Harness[] | undefined {
  if (!raw) return undefined;
  const wanted = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  // A harness potsherd cannot parse yet is named as such rather than accepted
  // and silently ignored — `--harness gemini` returning "0 sessions" would read
  // as "you have no gemini sessions", which is a different and wrong claim.
  const pending = wanted.filter((h) => NOT_YET.includes(h));
  if (pending.length) {
    throw new UserError(
      `${pending.join(', ')} ${pending.length === 1 ? 'is' : 'are'} not parsed yet — phase 6. doctor names the directory potsherd would read`,
      'potsherd doctor',
    );
  }
  const bad = wanted.filter((h) => !INDEXABLE.includes(h));
  if (bad.length) {
    throw new UserError(
      `unknown harness: ${bad.join(', ')}`,
      `potsherd index --harness ${INDEXABLE.join('|')}`,
    );
  }
  return wanted as Harness[];
}

/**
 * The receipt. Every row is a number the user can check by hand, and the last
 * line is the next verb (`05`, and phase-0 HANDOFF item 6).
 */
export function renderIndexReceipt(
  report: IndexReport,
  t: ReturnType<typeof themeFrom>,
  root: string,
  o: { embed?: boolean; vec?: VecStatus; spawned?: boolean } = {},
): string {
  const card = new Card(t);
  card.heading('index', paths.tildify(root), fmt.date(new Date(report.ranAt))).blank();

  for (const h of report.harnesses) {
    card.row({
      label: h.harness,
      value: fmt.num(h.sessions),
      note: harnessNote(h, ` ${t.mid} `),
      tone: h.failed > 0 ? 'warn' : h.sessions > 0 ? 'none' : 'dim',
    });
  }

  card.blank();
  const totals = report.totals;
  card.rows([
    {
      label: 'exchanges indexed',
      value: fmt.num(totals.exchanges),
      note:
        `${fmt.num(totals.toolCalls)} tool ${fmt.plural(totals.toolCalls, 'call')} ` +
        `${t.mid} ${fmt.num(totals.redactedExchanges)} redacted`,
    },
    ghostRow(report, t),
    // What *this pass* masked, and labelled as such. `index` cannot see the
    // index-wide total — it only knows what it re-read — and the old row said
    // "nothing matched — index holds no secrets" after an incremental run that
    // opened one file, on an index holding three masks. A run reports the run.
    maskedThisRunRow(report, t, card.noteWidth()),
    vectorsRow(o.vec, t, card.noteWidth(), o.embed === false),
  ]);

  card.blank();
  card.rows([
    {
      label: report.full ? 'full index' : 'incremental index',
      value: fmt.duration(report.ms),
      note:
        `${fmt.num(totals.parsed)} parsed ${t.mid} ${fmt.num(totals.skipped)} unchanged ` +
        `${t.mid} ${fmt.bytes(totals.bytes)}`,
      tone: 'accent',
    },
  ]);

  if (totals.failed > 0) {
    card.blank().text(`${fmt.num(totals.failed)} ${fmt.plural(totals.failed, 'transcript')} could not be parsed:`, 'warn');
    for (const h of report.harnesses) {
      for (const err of h.errors.slice(0, 3)) card.text(t.dim(`  ${fmt.elideMiddle(err, t.width - 6, t.ellip)}`));
    }
  }

  const novel = report.recordTypes.filter((r) => r.novel);
  if (novel.length > 0) {
    card.blank().text('record types no format note describes yet, in what this run read:');
    for (const row of novel.slice(0, 5)) {
      // The name is what the reader needs, so it gets the width and the
      // version gives ground — the same rule `doctor` follows.
      //
      // Elide and pad to the SAME width. They used to disagree: elided to
      // `nameW` (58 at an 80-column terminal) and padded to
      // `Math.min(nameW, 30)`, so every name between 31 and 58 characters
      // pushed the count and version columns right by however long it was, and
      // the table stopped being a table on exactly the rows a reader is
      // squinting at — the long, unfamiliar record-type names are the whole
      // reason this block prints at all. 4 + nameW + 7 + 3 + 8 is the terminal
      // width, so one number governs both.
      const nameW = Math.max(20, t.width - 4 - 7 - 3 - 8);
      const name = `${row.harness} ${row.type}`;
      card.raw(
        `    ${fmt.elide(name, nameW, t).padEnd(nameW)}` +
          `${fmt.num(row.count).padStart(7)}   ${t.dim(fmt.elide(row.version, 8, t))}`,
      );
    }
  }

  // The status line. A status, not an apology and not an offer: there is no
  // command in it, because there is nothing for the reader to do. §A2 item 2.
  // Given longest-first so a narrow terminal loses the elaboration and keeps
  // the count, and never gets a sentence cut in half.
  const warming =
    o.embed === false ? [] : warmingSentences(o.vec, o.spawned === true);
  if (warming.length > 0) card.blank().fit(...warming);

  card.blank().fix(
    'potsherd doctor',
    'to see parse coverage, redaction counts and every path read.',
    'for parse coverage and every path read.',
  );
  return card.toString();
}

/**
 * The one line `index` prints about semantic search.
 *
 * It says what is happening, once, and never sells anything. The three cases
 * are: it is running and here is how far it has got; it cannot run and here is
 * the one clause that says why; or there is nothing to say, and then nothing is
 * printed. `find` prints the same sentence from the same report while it waits.
 */
function warmingSentences(vec: VecStatus | undefined, spawned: boolean): string[] {
  const r = vec?.report;
  if (!r) return [];
  if (r.phase === 'unavailable') {
    const why = r.reason ?? 'not running on this machine';
    return [`semantic search: ${why} — text search is live`, `semantic search: ${why}`];
  }
  if (r.phase === 'ready' || r.phase === 'empty') return [];
  // `vec.line` is the sentence `find` prints while it waits, from the same
  // report. `index` prints it with one extra clause saying who is doing the
  // work, and falls back to the bare sentence at 60 columns.
  const head = vec?.line ?? `semantic search: warming (${fmt.num(r.embedded)} of ${fmt.num(r.total)})`;
  if (!spawned) return [head];
  if (!r.runtimeReady && embeddings.offline()) {
    // The one case where nothing is happening and saying "in the background"
    // would be a lie: this machine has been told not to use the network.
    return [
      `${head} — offline, so the runtime was not fetched`,
      `${head} — offline`,
      head,
    ];
  }
  const long = r.runtimeReady
    ? 'in the background, newest sessions first'
    : `fetching the ${fmt.bytes(r.acquireBytes)} runtime in the background, once`;
  const short = r.runtimeReady ? 'in the background' : `fetching ${fmt.bytes(r.acquireBytes)}, once`;
  return [`${head} — ${long}`, `${head} — ${short}`, head];
}

function harnessNote(h: HarnessReport, sep = ' · '): string {
  if (!h.present && h.discovered === 0) return `not installed — ${paths.tildify(h.sourceDir)}`;
  if (h.discovered === 0) return `no transcripts in ${paths.tildify(h.sourceDir)}`;
  const parts: string[] = [];
  const top = h.sessions - h.sidechains;
  parts.push(`${fmt.num(top)} ${fmt.plural(top, 'session')}`);
  if (h.sidechains > 0) parts.push(`${fmt.num(h.sidechains)} sidechains`);
  parts.push(`${fmt.num(h.exchanges)} ${fmt.plural(h.exchanges, 'exchange')}`);
  if (h.unchanged) parts.push('unchanged');
  else if (h.parsed > 0) parts.push(`${fmt.num(h.parsed)} re-read`);
  if (h.failed > 0) parts.push(`${fmt.num(h.failed)} failed`);
  return parts.join(sep);
}

/**
 * The `vectors` row — from `vecStatus(db, root)`, the same call `doctor` and
 * `find` make.
 *
 * It used to be rendered from the {@link IndexReport}, which knew only what
 * *this pass* had embedded, while `doctor` rendered a `COUNT(*)` guarded by a
 * native extension. The two printed different things about the same index in
 * the same session, which is the disagreement audit F2 caught. There is now one
 * function that answers and one that renders; `tests/vectors-lazy.test.ts` pins
 * that they agree.
 */
function vectorsRow(
  vec: VecStatus | undefined,
  t: ReturnType<typeof themeFrom>,
  noteWidth: number,
  explicitlyOff: boolean,
): Row {
  if (!vec?.report) {
    return { label: 'vectors', value: t.dash, note: 'no index yet', tone: 'dim' };
  }
  if (explicitlyOff && vec.report.pending > 0) {
    return {
      label: 'vectors',
      value: vec.report.embedded > 0 ? fmt.num(vec.report.embedded) : t.dash,
      note: 'not this run (--no-embed)',
      tone: 'dim',
    };
  }
  const row = vec.row;
  if (!row) return { label: 'vectors', value: t.dash, note: 'no index yet', tone: 'dim' };
  return {
    label: 'vectors',
    value: row.value === '—' ? t.dash : row.value,
    note: row.note(noteWidth, ` ${t.mid} `),
    tone: row.tone,
  };
}

/**
 * `ghosts indexed`.
 *
 * Zero is a fact worth explaining rather than a blank: ghosts are recovered
 * from `history.jsonl` by `potsherd rescue`, so a fresh `index` alone finds
 * none — and `potsherd find --ghosts only` would then answer "no match", which
 * reads as "you have no deleted sessions" when the truth is "nobody has looked
 * for them yet".
 */
function ghostRow(report: IndexReport, t: ReturnType<typeof themeFrom>): Row {
  const g = report.ghosts;
  if (g.ghosts === 0) {
    return {
      label: 'ghosts indexed',
      value: '0',
      note: 'none recovered yet — run potsherd rescue',
      tone: 'dim',
    };
  }
  return {
    label: 'ghosts indexed',
    value: fmt.num(g.ghosts),
    note: g.unchanged
      ? `${fmt.num(g.prompts)} prompts ${t.mid} unchanged`
      : `${fmt.num(g.prompts)} ${fmt.plural(g.prompts, 'prompt')}, searchable`,
  };
}

/**
 * `masked this run`.
 *
 * Every word of this row is scoped to the pass that just ran, because that is
 * all a run can honestly know. `potsherd doctor` counts the masks that are
 * actually in the stored text and is the only place that speaks for the index.
 */
function maskedThisRunRow(
  report: IndexReport,
  t: ReturnType<typeof themeFrom>,
  noteWidth: number,
): Row {
  const c: RedactionCounts = report.redaction;
  if (report.totals.parsed === 0) {
    return {
      label: 'masked this run',
      value: t.dash,
      note: 'nothing re-read — see potsherd doctor',
      tone: 'dim',
    };
  }
  const parts = Object.entries(c.byType)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${fmt.num(n)}`);
  if (parts.length === 0) {
    return {
      label: 'masked this run',
      value: '0',
      note: 'nothing matched in what was re-read',
      tone: 'dim',
    };
  }
  return {
    label: 'masked this run',
    value: fmt.num(c.total),
    note: fmt.joinFit(parts, noteWidth, ` ${t.mid} `, t),
    tone: 'ok',
  };
}

function firstLine(s: string): string {
  return (s.split('\n')[0] ?? s).trim();
}

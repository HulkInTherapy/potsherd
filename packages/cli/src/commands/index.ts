import process from 'node:process';
import {
  Card,
  countsJson,
  format as fmt,
  indexAll,
  lock,
  paths,
  type Harness,
  type HarnessReport,
  type IndexReport,
  type RedactionCounts,
  type Row,
} from '@potsherd/core';
import { print, printJson, Progress, themeFrom, UserError, type GlobalOptions } from '../output.js';

export interface IndexCommandOptions extends GlobalOptions {
  full?: boolean;
  incremental?: boolean;
  harness?: string;
  embed?: boolean;
  session?: string;
}

/** The harnesses an adapter exists for. `03` §2 names three more; phase 6. */
const INDEXABLE: readonly string[] = ['claude', 'codex', 'cursor', 'pi'];
const NOT_YET: readonly string[] = ['gemini', 'opencode', 'copilot'];

/**
 * `potsherd index` — every transcript on this machine, parsed, redacted and
 * searchable.
 *
 * Three promises this verb makes, in the order a user meets them:
 *
 *   1. **It is incremental by default.** A second run that finds nothing
 *      changed does no work and says so in well under a second. `--full`
 *      re-reads everything.
 *   2. **It never stalls silently.** The one-line progress bar names the file
 *      being read, and the ~34 MB first-run model download is announced *before*
 *      it starts, not discovered afterwards.
 *   3. **It never leaves a secret in the index.** Redaction runs before the
 *      first row is written (`03` §5), and the receipt prints what was masked.
 *      `--no-embed` skips the model entirely so this works offline on day one.
 */
export async function runIndex(o: IndexCommandOptions): Promise<number> {
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
  const embedBar = new Progress('embedding', showProgress);
  let announced = false;

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
        embed: o.embed !== false,
        onModelDownload: (bytes) => {
          announced = true;
          bar.done();
          if (o.json || o.quiet) return;
          // Said before the download starts, never after a silent stall. This
          // is the only time potsherd touches the network without being asked
          // to run a model, and the user is told which directory it lands in.
          print(
            `  first run: fetching the ${fmt.bytes(bytes)} embedding model into ` +
              `${paths.tildify(paths.modelsDir(root))}  ${t.dim('(once; --no-embed skips it)')}`,
          );
        },
        onProgress: (p) => {
          if (p.phase === 'parse') bar.update(p.done, p.total, `${p.harness}  ${p.note}`);
          else if (p.phase === 'embed') embedBar.update(p.done, p.total);
          else if (p.phase === 'model-download' && announced) {
            embedBar.update(Math.round(p.fraction * 100), 100, 'downloading');
          }
        },
      }),
    { root, wait: 2000 },
  );
  bar.done();
  embedBar.done();

  if (o.json) {
    printJson({
      ...report,
      // Named for what it is: what *this pass* masked. The index-wide totals
      // are `potsherd doctor --json`'s `redaction`, counted back out of the
      // stored text rather than remembered from a run.
      redaction: countsJson(report.redaction),
      redactionScope: 'run',
      db: paths.dbPath(root),
    });
    return report.totals.failed ? 1 : 0;
  }
  if (o.quiet) return report.totals.failed ? 1 : 0;

  print(renderIndexReceipt(report, t, root));
  return report.totals.failed ? 1 : 0;
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
    embeddingRow(report, t),
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
      const nameW = Math.max(20, t.width - 4 - 7 - 3 - 8);
      const name = `${row.harness} ${row.type}`;
      card.raw(
        `    ${fmt.elide(name, nameW, t).padEnd(Math.min(nameW, 30))}` +
          `${fmt.num(row.count).padStart(7)}   ${t.dim(fmt.elide(row.version, 8, t))}`,
      );
    }
  }

  card.blank().fix(
    'potsherd doctor',
    'to see parse coverage, redaction counts and every path read.',
    'for parse coverage and every path read.',
  );
  return card.toString();
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

function embeddingRow(report: IndexReport, t: ReturnType<typeof themeFrom>) {
  const e = report.embeddings;
  const total = e.embedded + e.upToDate;
  if (!e.enabled) {
    return {
      label: 'vectors',
      value: t.dash,
      note: `skipped (--no-embed) ${t.mid} text search only`,
      tone: 'dim' as const,
    };
  }
  if (!e.available) {
    return {
      label: 'vectors',
      value: t.dash,
      note: fmt.clip(`no vector index: ${e.reason ?? 'unavailable'}`, Math.max(20, t.width - 40), t),
      tone: 'dim' as const,
    };
  }
  return {
    label: 'vectors',
    value: fmt.num(total),
    note:
      `${fmt.num(e.embedded)} new ${t.mid} bge-small` +
      `${report.vec.version ? ` ${t.mid} sqlite-vec ${report.vec.version}` : ''}`,
    tone: 'ok' as const,
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

import process from 'node:process';
import {
  Card,
  countsJson,
  format as fmt,
  indexAll,
  lock,
  paths,
  redactionRow,
  type Harness,
  type HarnessReport,
  type IndexReport,
} from '@potsherd/core';
import { print, printJson, Progress, themeFrom, UserError, type GlobalOptions } from '../output.js';

export interface IndexCommandOptions extends GlobalOptions {
  full?: boolean;
  incremental?: boolean;
  harness?: string;
  embed?: boolean;
  session?: string;
}

const HARNESS_NAMES: readonly string[] = ['claude', 'codex', 'cursor', 'pi', 'gemini', 'opencode', 'copilot'];

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
      redaction: countsJson(report.redaction),
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
  const bad = wanted.filter((h) => !HARNESS_NAMES.includes(h));
  if (bad.length) {
    throw new UserError(
      `unknown harness: ${bad.join(', ')}`,
      `potsherd index --harness ${HARNESS_NAMES.slice(0, 4).join('|')}`,
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
      note: harnessNote(h),
      tone: h.failed > 0 ? 'warn' : h.sessions > 0 ? 'none' : 'dim',
    });
  }

  card.blank();
  const totals = report.totals;
  card.rows([
    {
      label: 'exchanges indexed',
      value: fmt.num(totals.exchanges),
      note: `${fmt.num(totals.toolCalls)} tool ${fmt.plural(totals.toolCalls, 'call')} · ${fmt.num(totals.redactedExchanges)} redacted`,
    },
    {
      label: 'ghosts indexed',
      value: fmt.num(report.ghosts.ghosts),
      note: report.ghosts.unchanged
        ? `${fmt.num(report.ghosts.prompts)} prompts · unchanged`
        : `${fmt.num(report.ghosts.prompts)} ${fmt.plural(report.ghosts.prompts, 'prompt')}, searchable`,
    },
    redactionRow(report.redaction, t, card.noteWidth()),
    embeddingRow(report, t),
  ]);

  card.blank();
  card.rows([
    {
      label: report.full ? 'full index' : 'incremental index',
      value: fmt.duration(report.ms),
      note: `${fmt.num(totals.parsed)} parsed · ${fmt.num(totals.skipped)} unchanged · ${fmt.bytes(totals.bytes)}`,
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
    card.blank().text('record types no format note describes yet:');
    for (const row of novel.slice(0, 5)) {
      card.raw(`    ${(`${row.harness} ${row.type}`).padEnd(30)}${fmt.num(row.count).padStart(7)}   ${t.dim(row.version)}`);
    }
  }

  card.blank().fix(
    'potsherd doctor',
    'to see parse coverage, redaction counts and every path read.',
    'for parse coverage and every path read.',
  );
  return card.toString();
}

function harnessNote(h: HarnessReport): string {
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
  return parts.join(' · ');
}

function embeddingRow(report: IndexReport, t: ReturnType<typeof themeFrom>) {
  const e = report.embeddings;
  const total = e.embedded + e.upToDate;
  if (!e.enabled) {
    return { label: 'vectors', value: '—', note: 'skipped (--no-embed) · text search only', tone: 'dim' as const };
  }
  if (!e.available) {
    return {
      label: 'vectors',
      value: '—',
      note: fmt.clip(`no vector index: ${e.reason ?? 'unavailable'}`, Math.max(20, t.width - 40)),
      tone: 'dim' as const,
    };
  }
  return {
    label: 'vectors',
    value: fmt.num(total),
    note: `${fmt.num(e.embedded)} new · bge-small${report.vec.version ? ` · sqlite-vec ${report.vec.version}` : ''}`,
    tone: 'ok' as const,
  };
}

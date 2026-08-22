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
  /**
   * Tri-state, and every state is a different sentence (T8.E):
   *
   *   `undefined` — no flag. **Text only.** No model, no download, no network.
   *                 The receipt ends with one line offering the upgrade.
   *   `true`      — `--embed`. Fetch the model if it is not here yet and
   *                 embed. The opt-in, and the only path that touches the
   *                 network.
   *   `false`     — `--no-embed`. Text only *and stop offering*: the upgrade
   *                 line is not printed. Someone who has said no once — in a
   *                 hook, in CI, on a metered connection — should not be sold
   *                 to on every run, and that is the whole of what the flag
   *                 still does now that it names the default. It is kept
   *                 rather than removed because it is the documented spelling
   *                 of "offline, and I mean it", and because `08` rule 8 asks
   *                 a flag to either do something or go — this one does
   *                 something you can see by diffing two receipts.
   */
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
 *   2. **It is offline by default** (T8.E, `08` §8.6). `potsherd index` with
 *      no flags parses, redacts and indexes — and stops. No model, no 32 MB
 *      download, no network at all. Measured on the frozen reference archive
 *      on 2026-08-22: 10.7 s text-only against 343 s (5m 43s) with
 *      embeddings, of which the download is a few seconds and the rest is
 *      1,294 exchanges through bge-small. `05` promises a stranger a walk
 *      that finishes while they are still watching; four hundred times the
 *      budget is not a default, it is an opt-in, and it is now spelled
 *      `--embed`. The receipt's last line offers it.
 *   3. **It never stalls silently.** The one-line progress bar names the file
 *      being read, and the first-run model download `--embed` triggers is
 *      announced *before* it starts, not discovered afterwards.
 *   4. **It never leaves a secret in the index.** Redaction runs before the
 *      first row is written (`03` §5), and the receipt prints what was masked.
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
        // The flip. `undefined` and `false` both mean text-only; only an
        // explicit `--embed` reaches for the model.
        embed: o.embed === true,
        onModelDownload: (bytes) => {
          announced = true;
          bar.done();
          if (o.json || o.quiet) return;
          // Said before the download starts, never after a silent stall. It
          // only happens on the `--embed` path now — nothing potsherd does by
          // default reaches the network — and the user is told which
          // directory it lands in.
          print(
            `  first run: fetching the ${fmt.bytes(bytes)} embedding model into ` +
              `${paths.tildify(paths.modelsDir(root))}  ${t.dim('(once)')}`,
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

  print(renderIndexReceipt(report, t, root, { embed: o.embed }));
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
  o: { embed?: boolean } = {},
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
    embeddingRow(report, t, o.embed === false),
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

  card.blank().fix(
    'potsherd doctor',
    'to see parse coverage, redaction counts and every path read.',
    'for parse coverage and every path read.',
  );

  // The one line that offers the upgrade (`08` §8.6). Printed only when this
  // run did not embed *and* the user has not already said no with
  // `--no-embed`, and only when there is something to search — offering
  // semantic search over an empty index is noise, not help.
  //
  // The two numbers are measured, not guessed: `fmt.bytes` renders
  // `MODEL_DOWNLOAD_BYTES` (34,014,426) as 32 MB, and 5m 43s is
  // `index --embed` on the frozen reference archive (1,294 exchanges) on
  // 2026-08-22, rounded up. `~` is the estimate marker `05` asks for; a
  // smaller archive is faster and a larger one is slower, roughly linearly.
  if (o.embed === undefined && !report.embeddings.enabled && report.totals.exchanges > 0) {
    card.fix(
      'potsherd index --embed',
      'for semantic search (32 MB model, ~6 min, once)',
      'for semantic search (32 MB, ~6 min)',
      'for semantic search',
    );
  }
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

/**
 * The `vectors` row.
 *
 * Three different facts, and the row says which one it is (T8.E). The one
 * that did not exist before the default flipped is the third: a user who ran
 * `index --embed` last week and plain `index` today still has their vectors,
 * and this run did not refresh them. Printing `—  skipped` over an index
 * holding 1,294 vectors would be false, and printing the count with no
 * qualifier would be worse — it would claim the vectors cover what was just
 * parsed. So the count is shown *and* labelled stale.
 */
function embeddingRow(
  report: IndexReport,
  t: ReturnType<typeof themeFrom>,
  explicitlyOff: boolean,
) {
  const e = report.embeddings;
  const total = e.embedded + e.upToDate;
  if (!e.enabled) {
    if (e.upToDate > 0) {
      return {
        label: 'vectors',
        value: fmt.num(e.upToDate),
        note: `not refreshed this run ${t.mid} potsherd index --embed`,
        tone: 'dim' as const,
      };
    }
    return {
      label: 'vectors',
      value: t.dash,
      note: explicitlyOff
        ? `skipped (--no-embed) ${t.mid} text search only`
        : `text search only ${t.mid} no model, no network`,
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

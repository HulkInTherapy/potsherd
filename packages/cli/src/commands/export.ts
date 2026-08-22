import {
  collectCards,
  exportMarkdown,
  pushToAgentMemory,
  TRANSCRIPT_LIMIT,
  type MarkdownExport,
  type PushResult,
} from '@potsherd/bridges';
import { fitLine, format as fmt, paths, Theme } from '@potsherd/core';
import { openIndex } from '../filters.js';
import { print, printJson, themeFrom, UserError, type GlobalOptions } from '../output.js';

/**
 * `potsherd export --to <target>` — the archive, out.
 *
 * ## three targets, and only one of them is a promise
 *
 * `markdown` is the export that matters and the only one that works with no
 * other software installed. It is what turns a `~/.potsherd` nobody can read
 * without potsherd into an Obsidian vault, a git repo, or a folder of files
 * that will still open in 2036.
 *
 * `agentmemory` is a write into somebody else's store, so it is gated on
 * `--yes` (`03` §10) and, without it, prints what it *would* do and exits 0
 * having written nothing.
 *
 * `hindsight` is **not built**, deliberately, and says so rather than failing
 * obscurely. `04` recorded it as too heavy to embed — postgres and a python
 * runtime — and the ruling for this task was to skip it if it could not be
 * done without a new dependency. It cannot: `@vectorize-io/hindsight-client`
 * would have to be resolvable for a `retain()` call to mean anything, and no
 * dependency was added. The target is still *named* here, because a user who
 * types it deserves the reason and not `unknown target`.
 *
 * ## it does not need an index
 *
 * A cards-only export reads the mirror under `~/.potsherd/cards/`, which is
 * files. `--transcripts` opens the database because it has to; the plain form
 * does not, so an export still works on a machine whose index is mid-rebuild.
 */

/** Everything `--to` accepts. Ordered as the help prints them. */
export const EXPORT_TARGETS = ['markdown', 'agentmemory', 'hindsight'] as const;
export type ExportTarget = (typeof EXPORT_TARGETS)[number];

export interface ExportCommandOptions extends GlobalOptions {
  to: string;
  /** The destination directory. Required for `markdown`. */
  dir?: string;
  transcripts?: boolean;
  limit?: number;
}

export async function runExport(o: ExportCommandOptions): Promise<number> {
  const target = parseTarget(o.to);

  if (target === 'hindsight') {
    // A refusal with a reason, and the command that does work. Not an error
    // the user caused, so it is not a UserError — but it is not a success
    // either, and a script that pipes `export --to hindsight` into something
    // must not think it got an export.
    throw new UserError(
      'export --to hindsight is not built: it needs @vectorize-io/hindsight-client, and potsherd adds no dependency for it (04: postgres and a python runtime are too heavy to embed)',
      'potsherd export --to markdown ./vault',
    );
  }

  const root = paths.potsherdDir(o.potsherdDir);
  return target === 'markdown' ? runMarkdown(o, root) : runAgentMemory(o, root);
}

function parseTarget(raw: string): ExportTarget {
  const value = (raw ?? '').trim().toLowerCase();
  if ((EXPORT_TARGETS as readonly string[]).includes(value)) return value as ExportTarget;
  throw new UserError(
    `--to takes one of ${EXPORT_TARGETS.join(', ')} — not "${raw}"`,
    'potsherd export --to markdown ./vault',
  );
}

// ---------------------------------------------------------------- markdown

function runMarkdown(o: ExportCommandOptions, root: string): number {
  const dir = o.dir?.trim();
  if (!dir) {
    throw new UserError(
      'export --to markdown needs a directory to write into',
      'potsherd export --to markdown ./vault',
    );
  }

  // Refusing to write into potsherd's own root is not paranoia: `exportCards`
  // copies `<root>/cards` into `<dest>`, and a dest of `<root>` would walk a
  // tree it is writing into.
  if (paths.potsherdDir(dir) === root || dir === root) {
    throw new UserError(
      'export --to markdown cannot write into potsherd’s own directory',
      'potsherd export --to markdown ./vault',
    );
  }

  // `--transcripts` is the only half that needs the database. Opening it
  // unconditionally would make a cards-only export fail on a machine that has
  // cards and no index, which is a real state after a `--potsherd-dir` copy.
  const opened = o.transcripts ? openIndex(o) : null;
  try {
    let result: MarkdownExport;
    try {
      result = exportMarkdown({
        root,
        dest: dir,
        ...(o.transcripts ? { transcripts: true } : {}),
        ...(opened ? { db: opened.db } : {}),
        limit: o.limit ?? TRANSCRIPT_LIMIT,
      });
    } catch (err) {
      throw new UserError(
        `could not write into ${dir}: ${(err as Error)?.message ?? String(err)}`,
        'potsherd export --to markdown ./vault',
      );
    }

    if (o.json) {
      printJson({
        target: 'markdown',
        dest: result.dest,
        cards: result.cards,
        transcripts: result.transcripts,
        ms: result.ms,
      });
      return 0;
    }
    print(markdownReceipt(themeFrom(o), result, dir));
    return 0;
  } finally {
    opened?.db.close();
  }
}

/**
 * `typed` is the directory as the user wrote it, not the resolved path.
 *
 * The next-verb line has to be pasteable, and an absolute path under a temp
 * directory is 70 characters that get elided into `/private/tmp/claude-…` —
 * a suggestion nobody can run. What they typed is short, correct from the
 * same shell, and already on their screen.
 */
function markdownReceipt(t: Theme, r: MarkdownExport, typed: string): string {
  const lines = [
    t.dim(fmt.clip(`potsherd export ${t.sep} markdown`, t.width, t)),
    '',
    `  ${t.accent(String(r.cards.files))} card${r.cards.files === 1 ? '' : 's'}  ${t.dim(`${kb(r.cards.bytes)} into`)} ${fmt.elideMiddle(paths.tildify(r.dest), Math.max(24, t.width - 24), t)}`,
  ];
  if (r.cards.skipped) {
    lines.push(`  ${t.dim(`${r.cards.skipped} skipped — error markers and sessions that could not be carded`)}`);
  }
  if (r.transcripts) {
    lines.push(
      `  ${t.accent(String(r.transcripts.files))} transcript${r.transcripts.files === 1 ? '' : 's'}  ${t.dim(`${kb(r.transcripts.bytes)} into`)} transcripts/`,
    );
    if (r.transcripts.skipped) {
      lines.push(`  ${t.dim(`${r.transcripts.skipped} sessions had no body to render`)}`);
    }
    for (const reason of r.transcripts.reasons) lines.push(`  ${t.dim(reason)}`);
  }
  // The honest empty case. "0 cards" with no explanation reads as a broken
  // export; it almost always means `potsherd card` has never been run.
  if (r.cards.files === 0) {
    lines.push('', `  ${t.dim('no cards in the mirror yet')}`);
    lines.push(fitLine(t, `  ${t.dim('run')}  potsherd card --all  ${t.dim('to write some, then export again')}`));
    return lines.join('\n');
  }
  lines.push('');
  // T6.6 D9 — this line is a **command**, and `fitLine` clips its last variant.
  // With a long directory the thing that got clipped was the path: the
  // suggestion turned into `potsherd export --to markdown /private/tmp/cla…`,
  // which is exactly the failure the comment on `typed` above says this line
  // exists to avoid. A command that cannot be pasted is worse than a command
  // that wraps, so the explanation moves to its own line and the command is
  // never cut.
  const command = `potsherd export --to markdown ${shellish(typed)} --transcripts`;
  const hint = 'to add the full conversations';
  const oneLine = `  ${t.dim('run')}  ${command}  ${t.dim(hint)}`;
  if (Theme.len(oneLine) <= t.width) {
    lines.push(t.asciiLine(oneLine));
  } else {
    lines.push(t.asciiLine(`  ${t.dim('run')}  ${command}`));
    lines.push(t.asciiLine(`       ${t.dim(hint)}`));
  }
  return lines.join('\n');
}

// ------------------------------------------------------------- agentmemory

async function runAgentMemory(o: ExportCommandOptions, root: string): Promise<number> {
  const cards = collectCards(root, o.limit ?? 1000);
  const result = await pushToAgentMemory(cards, { ...(o.yes ? { yes: true } : {}) });

  if (o.json) {
    printJson({
      target: 'agentmemory',
      // The four-valued presence reaches `--json`, not only the human view.
      // Phase 5's verifier found `setup`'s equivalent label on three surfaces
      // and missing from the fourth; this is the fourth.
      presence: result.status.presence,
      store: result.status.path,
      consent: o.yes === true,
      wrote: result.wrote,
      planned: result.planned,
      pushed: result.pushed,
      failed: result.failed,
      tool: result.tool,
      detail: result.detail,
    });
    return exitCode(result, o);
  }

  print(pushReceipt(themeFrom(o), result, Boolean(o.yes)));
  return exitCode(result, o);
}

/**
 * Non-zero only when the user asked for a write and did not get one.
 *
 * A dry run that correctly reports "would push 12" has done its job and exits
 * 0. A `--yes` run against a store that is not there has not, and a script
 * that pipes this must be able to tell.
 */
function exitCode(result: PushResult, o: ExportCommandOptions): number {
  if (!o.yes) return 0;
  return result.wrote ? 0 : 1;
}

function pushReceipt(t: Theme, r: PushResult, yes: boolean): string {
  const lines = [
    t.dim(fmt.clip(`potsherd export ${t.sep} agentmemory`, t.width, t)),
    '',
    `  ${t.dim('store')}  ${fmt.elideMiddle(paths.tildify(r.status.path), Math.max(24, t.width - 12), t)}`,
    `  ${t.dim(presenceWord(r.status.presence))}`,
    '',
  ];
  if (r.wrote) {
    lines.push(`  ${t.accent(String(r.pushed))} card${r.pushed === 1 ? '' : 's'} pushed${r.failed ? t.dim(`, ${r.failed} failed`) : ''}`);
  } else {
    lines.push(`  ${fmt.elide(r.detail, Math.max(24, t.width - 4), t)}`);
  }
  lines.push('');
  if (!yes && r.status.presence === 'store') {
    lines.push(
      fitLine(t, `  ${t.dim('run')}  potsherd export --to agentmemory --yes  ${t.dim('to actually write')}`),
    );
  } else {
    lines.push(fitLine(t, `  ${t.dim('run')}  potsherd export --to markdown ./vault  ${t.dim('for the export that needs nothing installed')}`));
  }
  return lines.join('\n');
}

/** The four presences, as a sentence a reader can act on. */
function presenceWord(presence: PushResult['status']['presence']): string {
  switch (presence) {
    case 'store':
      return 'found: a real store';
    case 'empty':
      return 'found: installed, and empty';
    case 'unrecognised':
      return 'found: installed, and potsherd cannot talk to it';
    default:
      return 'not present on this machine';
  }
}

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KiB`;
}

/** Quote a path only when it needs it, so the suggested command is pasteable. */
function shellish(p: string): string {
  return /[\s'"$`\\]/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p;
}

// T6.6 D13 — `EXPORT_WRITE_PATHS` lived here, claimed to exist "for the
// registration file's `doctor --privacy` line", and had zero consumers. It is
// now in `../privacy-paths.ts`, which `doctor` can import without pulling
// `@potsherd/bridges` — and its socket — into an offline verb's import graph,
// and it is printed. Re-exported so the name still resolves from here.
export { EXPORT_WRITE_PATHS } from '../privacy-paths.js';

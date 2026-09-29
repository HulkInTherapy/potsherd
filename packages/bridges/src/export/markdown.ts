/**
 * `potsherd export --to markdown <dir>` — the archive as a second brain.
 *
 * ## it renders nothing
 *
 * That is the design, not an omission. potsherd already has exactly one card
 * renderer (`cards/write.ts`'s `cardMarkdown`, which writes the mirror under
 * `~/.potsherd/cards/`) and exactly one transcript renderer
 * (`render/show.ts`'s `renderShowMarkdown`, which is what `potsherd show --md`
 * prints). A second renderer here would drift from both within a release, and
 * the first thing a user would notice is that the card in their vault says
 * something slightly different from the card `potsherd show` prints — which
 * makes the export untrustworthy in the exact way an archive must not be.
 *
 * So this module is a *walker and a namer*: `exportCards()` copies the mirror
 * that is already on disk, `renderShowMarkdown()` produces each transcript,
 * and everything here decides where files go and what they are called.
 *
 * ## the tree
 *
 *     <dest>/
 *       <harness>/<slug>/<id>.md          cards, exactly as the mirror holds
 *       transcripts/<harness>/<slug>/<id>.md   with --transcripts
 *
 * The card half of that shape comes from `exportCards()` and is deliberately
 * unchanged: a re-export updates in place instead of duplicating, which is
 * what makes this safe to point at a git repo or an Obsidian vault and run
 * again next month.
 *
 * ## nothing here needs `--yes`
 *
 * The governing rule for this package is that potsherd never writes to another
 * tool's store without `--yes`. A directory the user named on the command line
 * is not another tool's store — it is the argument. This is the export that
 * needs no consent gate, and it is the one the phase file says matters most.
 */

import {
  exportCards,
  listSessions,
  renderShowMarkdown,
  showSession,
  type ExportResult,
} from '@potsherd/core';
import fs from 'node:fs';
import path from 'node:path';
import { firstLine } from '../types.js';

/**
 * The index handle, taken from the function that consumes it.
 *
 * `Db` lives behind core's `db` namespace and is not on the barrel. Deriving
 * it here rather than adding a barrel line keeps this package from needing a
 * change to `packages/core/src/index.ts`, which other workers are editing —
 * and it cannot drift, because it *is* whatever `listSessions` accepts.
 */
type Db = Parameters<typeof listSessions>[0];

export interface MarkdownExportOptions {
  /** The potsherd root whose cards mirror is copied. */
  root: string;
  /** Where to write. Created if absent. */
  dest: string;
  /**
   * Also write one file per session with the full conversation.
   *
   * Off by default, and the default is the safe one: a transcript is the raw
   * text of everything that was said, the cards are the redacted, verified
   * summaries, and a user pointing this at a shared vault should have to ask
   * for the raw half.
   */
  transcripts?: boolean;
  /** Needed only for `transcripts`. */
  db?: Db;
  /** Cap on transcripts written. Default 500. */
  limit?: number;
}

export interface TranscriptExport {
  files: number;
  bytes: number;
  /** Sessions considered that produced no file, with one reason each. */
  skipped: number;
  reasons: string[];
}

export interface MarkdownExport {
  dest: string;
  /** Straight from core's `exportCards`. Not recomputed here. */
  cards: ExportResult;
  transcripts: TranscriptExport | null;
  ms: number;
}

/** Default ceiling on transcripts, so a 4,000-session archive is not a surprise. */
export const TRANSCRIPT_LIMIT = 500;

/**
 * Copy the cards out, and optionally the transcripts beside them.
 *
 * Throws only if `dest` cannot be created — a failure the user has to know
 * about, because every count below it would be zero and look like an empty
 * archive. Everything after that degrades per-file and is counted.
 */
export function exportMarkdown(options: MarkdownExportOptions): MarkdownExport {
  const started = Date.now();
  const dest = path.resolve(options.dest);
  fs.mkdirSync(dest, { recursive: true });

  const cards = exportCards(options.root, dest);
  const transcripts = options.transcripts ? writeTranscripts(dest, options) : null;

  return { dest, cards, transcripts, ms: Date.now() - started };
}

function writeTranscripts(dest: string, options: MarkdownExportOptions): TranscriptExport {
  const out: TranscriptExport = { files: 0, bytes: 0, skipped: 0, reasons: [] };
  const db = options.db;
  if (!db) {
    out.reasons.push('no index open: --transcripts needs the database');
    return out;
  }

  const limit = Math.max(1, options.limit ?? TRANSCRIPT_LIMIT);
  const root = path.join(dest, 'transcripts');

  let listed;
  try {
    listed = listSessions(db, {}, { limit });
  } catch (err) {
    out.reasons.push(firstLine(err));
    return out;
  }

  for (const session of listed.sessions) {
    let markdown: string;
    try {
      const shown = showSession(db, session.id);
      if (!shown) {
        // A session in the index with no body: a ghost with no recovered
        // prompts, or one indexed with `--no-full`. Counted, not fatal.
        out.skipped += 1;
        continue;
      }
      markdown = renderShowMarkdown(shown);
    } catch (err) {
      out.skipped += 1;
      pushReason(out, firstLine(err));
      continue;
    }

    // Same tree shape as the cards half, under `transcripts/`, so a vault can
    // hold both without one shadowing the other and a reader can find the
    // transcript for a card by prefixing the path.
    const file = path.join(root, session.harness, safeSegment(session.projectName), `${session.id}.md`);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // 0600, like every other file potsherd writes (`03` §11): a transcript
      // is the least redacted thing in the archive and the export is the one
      // place it leaves `~/.potsherd`.
      fs.writeFileSync(file, markdown, { mode: 0o600 });
    } catch (err) {
      out.skipped += 1;
      pushReason(out, firstLine(err));
      continue;
    }
    out.files += 1;
    out.bytes += Buffer.byteLength(markdown);
  }

  return out;
}

/** At most three distinct reasons: a receipt is not a log. */
function pushReason(out: TranscriptExport, reason: string): void {
  if (out.reasons.length < 3 && !out.reasons.includes(reason)) out.reasons.push(reason);
}

/**
 * A path segment that cannot escape `dest`.
 *
 * The project name comes out of a transcript, which is untrusted input to this
 * process however trusted its author: a session whose recorded project was
 * `../../.ssh` must not put a file there. Kept deliberately simple — anything
 * that is not a word character, a dash or a dot becomes a dash.
 */
export function safeSegment(name: string | null | undefined): string {
  const cleaned = (name ?? '').replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80);
  return cleaned || 'unknown';
}

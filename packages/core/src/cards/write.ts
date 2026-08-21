import fs from 'node:fs';
import path from 'node:path';

import type { Db } from '../db.js';
import type { Harness } from '../adapters/types.js';
import { EMBEDDING_DIMENSIONS, embeddingToBlob } from '../embeddings.js';
import { cardsDir } from '../paths.js';
import { vecAvailable } from '../vec.js';
import type { CardClaim, ExtractedCard } from './schema.js';
import type { VerifyTotals } from './verify.js';

/**
 * Step 5 of `03` §6: **write** — `cards`, `cards_fts`, `vec_cards`, and the
 * markdown mirror.
 *
 * Four representations of one card, and the fourth is the one that matters
 * most. `research/memory-research.md` §1 on TRUSTMEM: *the pipeline is where
 * trust is lost*, and our mitigation is the verify step, the `verified` flag,
 * **and cards as markdown the user can read and edit**. A card the user cannot
 * open in an editor is a claim they have to take on faith.
 *
 * ## The fts5 delete protocol
 *
 * `cards_fts` is `content='cards'`: sqlite stores no copy of the text, so a
 * plain overwrite leaves the index pointing at values that are no longer
 * there and later queries return the wrong rows — or
 * `database disk image is malformed`. Re-carding must therefore feed the *old*
 * column values back with the `'delete'` command before writing the new ones.
 * `ingest.clearExchanges` learned this the same way.
 *
 * The columns are indexed exactly as `cards` stores them, JSON and all. That
 * is not laziness: an external-content table whose index disagrees with its
 * content table gives one answer to a query and a different one after
 * `'rebuild'`. The unicode61 tokenizer drops the punctuation anyway, and the
 * structural words it does keep (`what`, `why`, `evidence_seq`) appear in
 * every card, so bm25's IDF prices them at nothing.
 */

export interface CardRecord {
  sessionId: string;
  harness: Harness;
  projectSlug: string | null;
  project: string | null;
  card: ExtractedCard;
  verified: VerifyTotals;
  model: string;
  costUsd: number;
  createdAt: string;
  /** `transcript` for a session; T2.3 writes `prompts-only` for a ghost. */
  source: string;
  /** Both JSON attempts failed and the card is title + summary only. */
  degraded?: boolean;
  /** Coverage after the supplement, 0–1. Recorded for the mirror. */
  coverage?: number;
}

/** The string `vec_cards` embeds: `title + summary + topics` (`phase-2` T2.2 §6). */
export function cardEmbeddingText(card: ExtractedCard): string {
  return [card.title, card.summary, card.topics.join(', ')].filter((s) => s.trim()).join('\n');
}

/** `~/.potsherd/cards/<harness>/<slug>/<id>.md`. */
export function cardPath(root: string, harness: string, slug: string | null, id: string): string {
  return path.join(cardsDir(root), harness, safeSlug(slug), `${id}.md`);
}

/**
 * A project slug as a single safe path segment.
 *
 * Claude Code's own slugs are already flat (`-Users-zebra-Fulcrum`), but codex
 * and cursor projects are not guaranteed to be, and a slug containing `..` or
 * a separator would put a card outside `~/.potsherd`. `03` §11 says potsherd
 * writes only under its own directory, so the guard is here rather than in a
 * comment.
 */
export function safeSlug(slug: string | null | undefined): string {
  const segments = (slug ?? '')
    .split(/[/\\]+/)
    .map((part) => part.trim())
    // `.` and `..` are the only two segments that can move the write out of
    // the directory it was aimed at. Dropping them is safe for a real slug,
    // which never contains either, and total for one that does.
    .filter((part) => part.length > 0 && part !== '.' && part !== '..');
  const s = segments.join('-');
  return s.length > 0 ? s.slice(0, 120) : 'unknown';
}

// ------------------------------------------------------------------ markdown

function yamlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
}

function yamlList(items: readonly string[], indent = '  '): string {
  if (items.length === 0) return ' []';
  return `\n${items.map((i) => `${indent}- ${yamlString(i)}`).join('\n')}`;
}

function yamlClaims(claims: readonly CardClaim[], indent = '  '): string {
  if (claims.length === 0) return ' []';
  return `\n${claims
    .map((c) => {
      const lines = [`${indent}- what: ${yamlString(c.what)}`];
      if (c.why?.trim()) lines.push(`${indent}  why: ${yamlString(c.why.trim())}`);
      lines.push(`${indent}  evidence_seq: [${c.evidence_seq.join(', ')}]`);
      return lines.join('\n');
    })
    .join('\n')}`;
}

/**
 * The mirror: YAML frontmatter over a human-readable body.
 *
 * `phase-2` deliverable 5 fixes the frontmatter keys — title, tags, decisions,
 * open_threads, files, verified, model, cost — so a second-brain vault can
 * treat the directory as a note collection. `verified` is in the frontmatter
 * and not just the body because it is the field that tells a reader how much
 * of what follows survived being checked.
 */
export function cardMarkdown(record: CardRecord): string {
  const c = record.card;
  const front = [
    '---',
    `id: ${yamlString(record.sessionId)}`,
    `title: ${yamlString(c.title)}`,
    `harness: ${yamlString(record.harness)}`,
    `project: ${yamlString(record.project ?? '')}`,
    `outcome: ${yamlString(c.outcome)}`,
    `source: ${yamlString(record.source)}`,
    `tags:${yamlList(c.tags)}`,
    `topics:${yamlList(c.topics)}`,
    `files:${yamlList(c.files)}`,
    `decisions:${yamlClaims(c.decisions)}`,
    `open_threads:${yamlClaims(c.open_threads)}`,
    `verified:`,
    `  kept: ${record.verified.kept}`,
    `  dropped: ${record.verified.dropped}`,
    ...(record.coverage !== undefined ? [`coverage: ${record.coverage.toFixed(2)}`] : []),
    ...(record.degraded ? ['degraded: true'] : []),
    `model: ${yamlString(record.model)}`,
    `cost: ${record.costUsd.toFixed(4)}`,
    `created_at: ${yamlString(record.createdAt)}`,
    '---',
  ].join('\n');

  const body: string[] = ['', `# ${c.title || record.sessionId.slice(0, 8)}`, ''];
  if (c.summary) body.push(c.summary, '');
  if (c.decisions.length > 0) {
    body.push('## decisions', '');
    for (const d of c.decisions) {
      body.push(`- **${d.what}**${d.why ? ` — ${d.why}` : ''}  \`seq ${d.evidence_seq.join(', ')}\``);
    }
    body.push('');
  }
  if (c.open_threads.length > 0) {
    body.push('## open threads', '');
    for (const o of c.open_threads) {
      body.push(`- ${o.what}  \`seq ${o.evidence_seq.join(', ')}\``);
    }
    body.push('');
  }
  if (c.files.length > 0) {
    body.push('## files', '', ...c.files.map((f) => `- \`${f}\``), '');
  }
  body.push(
    '---',
    '',
    `${record.verified.kept} claim${record.verified.kept === 1 ? '' : 's'} kept, ` +
      `${record.verified.dropped} dropped for want of evidence in the transcript.` +
      (record.degraded ? '  The model never returned valid JSON; this card is title and summary only.' : ''),
    '',
    `\`potsherd show ${record.sessionId.slice(0, 8)}\``,
    '',
  );

  return `${front}\n${body.join('\n')}`;
}

// ------------------------------------------------------------------- sqlite

interface ExistingRow {
  rowid: number;
  title: string | null;
  summary: string | null;
  topics: string;
  decisions: string;
  open_threads: string;
}

/**
 * Write one card everywhere it belongs, atomically in sqlite and then on disk.
 *
 * Returns the mirror path. The database write is one transaction: a card that
 * exists in `cards` but not in `cards_fts` is invisible to `find`, which is a
 * worse failure than not having carded the session at all.
 */
export function writeCard(db: Db, root: string, record: CardRecord, embedding?: readonly number[]): string {
  const c = record.card;
  const topics = JSON.stringify(c.topics);
  const decisions = JSON.stringify(c.decisions);
  const openThreads = JSON.stringify(c.open_threads);
  const tags = JSON.stringify(c.tags);
  const files = JSON.stringify(c.files);
  const md = cardMarkdown(record);
  const verified = JSON.stringify({
    kept: record.verified.kept,
    dropped: record.verified.dropped,
    ...(record.coverage !== undefined ? { coverage: Number(record.coverage.toFixed(3)) } : {}),
    ...(record.degraded ? { degraded: true } : {}),
  });

  const write = db.transaction(() => {
    const old = db
      .prepare(
        `SELECT rowid, title, summary, topics, decisions, open_threads
           FROM cards WHERE session_id = ?`,
      )
      .get(record.sessionId) as ExistingRow | undefined;

    if (old) {
      db.prepare(
        `INSERT INTO cards_fts (cards_fts, rowid, title, summary, topics, decisions, open_threads)
         VALUES ('delete', ?, ?, ?, ?, ?, ?)`,
      ).run(old.rowid, old.title, old.summary, old.topics, old.decisions, old.open_threads);
    }

    db.prepare(
      `INSERT INTO cards (session_id, title, summary, topics, decisions, files, outcome,
                          open_threads, suggested_tags, model, verified, cost_usd, created_at,
                          card_md, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         title = excluded.title, summary = excluded.summary, topics = excluded.topics,
         decisions = excluded.decisions, files = excluded.files, outcome = excluded.outcome,
         open_threads = excluded.open_threads, suggested_tags = excluded.suggested_tags,
         model = excluded.model, verified = excluded.verified, cost_usd = excluded.cost_usd,
         created_at = excluded.created_at, card_md = excluded.card_md, source = excluded.source`,
    ).run(
      record.sessionId,
      c.title,
      c.summary,
      topics,
      decisions,
      files,
      c.outcome,
      openThreads,
      tags,
      record.model,
      verified,
      record.costUsd,
      record.createdAt,
      md,
      record.source,
    );

    const row = db
      .prepare('SELECT rowid FROM cards WHERE session_id = ?')
      .get(record.sessionId) as { rowid: number };
    db.prepare(
      `INSERT INTO cards_fts (rowid, title, summary, topics, decisions, open_threads)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(row.rowid, c.title, c.summary, topics, decisions, openThreads);

    // vec0 implements neither UPSERT nor INSERT OR REPLACE; delete then insert
    // is the documented replacement (`ingest.ts` says the same).
    //
    // The vector is the *optional* half, here as it is in `recall.ts`: a card
    // with no row in `vec_cards` is still found by `cards_fts`, but a card
    // that was never written because the vector insert raised is found by
    // nothing. So the length is checked (vec0 rejects a mismatch loudly) and
    // anything else it objects to is swallowed rather than rolling back the
    // card, the fts row and the mirror with it.
    if (
      embedding &&
      embedding.length === EMBEDDING_DIMENSIONS &&
      vecAvailable(db) &&
      vecCardsExist(db)
    ) {
      try {
        db.prepare('DELETE FROM vec_cards WHERE session_id = ?').run(record.sessionId);
        db.prepare('INSERT INTO vec_cards (session_id, embedding) VALUES (?, ?)').run(
          record.sessionId,
          embeddingToBlob(embedding),
        );
      } catch {
        /* fts5 still has the card; `find` degrades to bm25 for this one row */
      }
    }
  });
  write();

  const file = cardPath(root, record.harness, record.projectSlug, record.sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 0600: a card quotes the transcript, and the transcript is the user's.
  fs.writeFileSync(file, md, { mode: 0o600 });
  return file;
}

function vecCardsExist(db: Db): boolean {
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'vec_cards'`)
      .get() as { n: number };
    return row.n > 0;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------- export

export interface ExportResult {
  files: number;
  bytes: number;
  dest: string;
}

/**
 * `potsherd card --export <dir>` — copy the mirror out.
 *
 * A copy, not a move and not a symlink: the destination is usually a git repo
 * or an Obsidian vault, and the user is expected to edit what lands there. The
 * tree shape (`<harness>/<slug>/<id>.md`) is preserved so a re-export updates
 * in place instead of duplicating.
 */
export function exportCards(root: string, dest: string): ExportResult {
  const from = cardsDir(root);
  const result: ExportResult = { files: 0, bytes: 0, dest };
  if (!fs.existsSync(from)) return result;

  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const source = path.join(dir, entry.name);
      const relative = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        walk(source, relative);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const target = path.join(dest, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      result.files += 1;
      result.bytes += fs.statSync(source).size;
    }
  };
  walk(from, '');
  return result;
}

/** The card already written for a session, as the prior for a re-card. */
export function readPriorCard(db: Db, sessionId: string): ExtractedCard | null {
  const row = db
    .prepare(
      `SELECT title, summary, topics, decisions, files, outcome, open_threads, suggested_tags
         FROM cards WHERE session_id = ?`,
    )
    .get(sessionId) as
    | {
        title: string | null;
        summary: string | null;
        topics: string;
        decisions: string;
        files: string;
        outcome: string | null;
        open_threads: string;
        suggested_tags: string;
      }
    | undefined;
  if (!row) return null;
  const parse = <T>(json: string, fallback: T): T => {
    try {
      return JSON.parse(json) as T;
    } catch {
      return fallback;
    }
  };
  return {
    title: row.title ?? '',
    summary: row.summary ?? '',
    topics: parse<string[]>(row.topics, []),
    decisions: parse<CardClaim[]>(row.decisions, []),
    files: parse<string[]>(row.files, []),
    outcome: (row.outcome as ExtractedCard['outcome']) ?? 'unknown',
    open_threads: parse<CardClaim[]>(row.open_threads, []),
    tags: parse<string[]>(row.suggested_tags, []),
  };
}

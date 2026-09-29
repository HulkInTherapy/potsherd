import type { Db } from '../db.js';
import type { Harness } from '../adapters/types.js';
import { vecAvailable } from '../vec.js';
import type { CardKind } from './plan.js';

/**
 * What the pipeline reads: a session as a numbered list of units.
 *
 * Everything above this module — slice, extract, coverage, verify, dedupe —
 * works on {@link Transcript} and knows nothing about sessions, exchanges,
 * ghosts or sqlite. That is deliberate and it is the seam T2.3 needs: a ghost
 * card is the same five steps over units built from `ghost_prompts` instead of
 * `exchanges`, with `outcome` forced to `unknown` and `source: 'prompts-only'`.
 * T2.3 writes one loader; it does not touch the pipeline.
 *
 * **`seq` is the contract.** It is the number the model cites in
 * `evidence_seq` and the number `verify.ts` looks up, so it must be the same
 * number in the prompt, in the card and in `exchanges.seq`. It is never
 * renumbered, never made contiguous and never reused across chunks — a
 * map-reduce over four chunks still cites the session's own seq numbers.
 */

export interface TranscriptUnit {
  /** `exchanges.seq` — the identity the model cites. Never renumbered. */
  seq: number;
  /** `exchanges.id`, when the unit came from a row that has one. */
  id?: string;
  ts: string | null;
  /** Redacted at rest (`03` §5); this is the text a model may see. */
  text: string;
  /**
   * The stored vector for this unit, when the index has one. Reused rather
   * than recomputed: coverage embeds every unit, and at ~190 ms per forward
   * pass on the reference machine a 60-exchange session would otherwise pay
   * 11 s before the first model call.
   */
  embedding?: number[];
  /** Paths the exchange touched, as a hint for `files[]`. */
  files?: string[];
}

export interface Transcript {
  id: string;
  kind: CardKind;
  harness: Harness;
  /** The harness's own title, if it wrote one. Used as a fallback card title. */
  title: string | null;
  project: string | null;
  projectSlug: string | null;
  units: TranscriptUnit[];
  /** Sum of unit text lengths. What the estimate was quoted against. */
  chars: number;
  isSidechain: boolean;
}

interface SessionRow {
  id: string;
  harness: Harness;
  title: string | null;
  project: string | null;
  project_slug: string | null;
  is_sidechain: number;
}

interface ExchangeRow {
  id: string;
  seq: number;
  ts: string | null;
  user_text: string;
  assistant_text: string;
  files_touched: string;
}

/**
 * One session, as units.
 *
 * The vectors come along in the same pass when `vec_exchanges` has them, which
 * is the only reason coverage is affordable. When the index was built with
 * `--no-embed` the field is simply absent and `coverage.ts` embeds on demand.
 */
export function loadSessionTranscript(db: Db, sessionId: string): Transcript | null {
  const s = db
    .prepare(
      `SELECT id, harness, title, project, project_slug, is_sidechain
         FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as SessionRow | undefined;
  if (!s) return null;

  const rows = db
    .prepare(
      `SELECT id, seq, ts, user_text, assistant_text, files_touched
         FROM exchanges WHERE session_id = ? ORDER BY seq`,
    )
    .all(sessionId) as ExchangeRow[];

  const vectors = loadVectors(
    db,
    rows.map((r) => r.id),
  );

  let chars = 0;
  const units: TranscriptUnit[] = rows.map((r) => {
    const text = unitText(r.user_text, r.assistant_text);
    chars += text.length;
    const embedding = vectors.get(r.id);
    return {
      seq: r.seq,
      id: r.id,
      ts: r.ts,
      text,
      ...(embedding ? { embedding } : {}),
      files: parseFiles(r.files_touched),
    };
  });

  return {
    id: s.id,
    kind: 'session',
    harness: s.harness,
    title: s.title,
    project: s.project,
    projectSlug: s.project_slug,
    units,
    chars,
    isSidechain: s.is_sidechain === 1,
  };
}

/**
 * The two sides of an exchange, in the shape both the prompt and the evidence
 * lookup see.
 *
 * Not `embeddings.exchangeText()`: that string is the one the *stored* vector
 * was computed from and it must not move (`EMBEDDING_VERSION` would have to
 * move with it). This one is for reading — by a model, and by a person opening
 * the markdown mirror.
 */
export function unitText(userText: string, assistantText: string): string {
  const user = userText.trim();
  const assistant = assistantText.trim();
  if (user && assistant) return `user: ${user}\n\nassistant: ${assistant}`;
  if (user) return `user: ${user}`;
  return assistant ? `assistant: ${assistant}` : '';
}

/** `[seq 12 · 2026-08-21]` — the header `plan.ts` budgets 24 characters for. */
export function unitHeader(unit: TranscriptUnit): string {
  const day = unit.ts ? unit.ts.slice(0, 10) : '';
  return day ? `[seq ${unit.seq} · ${day}]` : `[seq ${unit.seq}]`;
}

/** One unit as it appears in a prompt. */
export function renderUnit(unit: TranscriptUnit, maxChars?: number): string {
  const body = maxChars !== undefined ? elideMiddle(unit.text, maxChars) : unit.text;
  return `${unitHeader(unit)}\n${body}`;
}

/**
 * Cut the middle out of a very long unit, and say so.
 *
 * A single exchange can be 200 kB — a pasted log, a `cat` of a lockfile — and
 * one of them would fill a chunk on its own and push the rest of the session
 * out of the call. The head and the tail are where a decision is stated; the
 * middle of a 200 kB tool result is not. The marker is left in the text so the
 * model can see that it is reading a cut, and so a person reading the mirror
 * can too.
 */
export function elideMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const keep = Math.max(200, Math.floor((maxChars - 40) / 2));
  const cut = text.length - keep * 2;
  return `${text.slice(0, keep)}\n… [${cut.toLocaleString('en-US')} characters elided] …\n${text.slice(-keep)}`;
}

function parseFiles(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Stored exchange vectors, by exchange id.
 *
 * Total: an index built with `--no-embed`, a machine with no `sqlite-vec`, or
 * a table that is simply empty all return an empty map and the caller embeds
 * what it needs. A card run must never fail because the vector half is absent.
 */
export function loadVectors(db: Db, ids: readonly string[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (ids.length === 0) return out;
  if (!vecAvailable(db)) return out;
  const CHUNK = 400;
  try {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const rows = db
        .prepare(
          `SELECT id, embedding FROM vec_exchanges WHERE id IN (${slice.map(() => '?').join(',')})`,
        )
        .all(...slice) as { id: string; embedding: Buffer | Uint8Array }[];
      for (const r of rows) {
        const buf = Buffer.isBuffer(r.embedding) ? r.embedding : Buffer.from(r.embedding);
        out.set(
          r.id,
          Array.from(
            new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
          ),
        );
      }
    }
  } catch {
    return new Map();
  }
  return out;
}

// -------------------------------------------------------------------- ghosts

interface GhostRow {
  session_id: string;
  harness: Harness;
  title: string | null;
  project: string | null;
  first_prompt: string | null;
}

interface GhostPromptRow {
  id: string;
  seq: number;
  ts: string | null;
  text: string;
}

/**
 * One ghost, as units — T2.3's half of the seam described at the top of this
 * file.
 *
 * A ghost is a session Claude Code's 30-day sweep deleted, rebuilt from
 * `~/.claude/history.jsonl`. On the reference machine there are 30 surviving
 * sessions and 299 ghosts, so this loader — not {@link loadSessionTranscript}
 * — is what most of a real archive goes through. The ghost card is, for most
 * of the archive, the only card there will ever be.
 *
 * What survives is the prompt side: `ghost_prompts.text` in `seq` order, plus
 * `ghosts.title` (from a `sessions-index.json` that outlived the transcript)
 * and `ghosts.first_prompt`. The assistant's side is gone and cannot be
 * inferred, which is why the units say `user:` and nothing else, why the
 * pipeline forces `outcome: unknown` on anything that comes out of here, and
 * why the card is written `source: prompts-only`.
 *
 * `seq` is `ghost_prompts.seq` — the prompt's position in the session, counted
 * from 0 — and it is the number the model cites and `verify.ts` looks up, the
 * same contract an exchange's seq has.
 */
export function loadGhostTranscript(db: Db, sessionId: string): Transcript | null {
  const g = db
    .prepare(
      `SELECT session_id, harness, title, project, first_prompt
         FROM ghosts WHERE session_id = ?`,
    )
    .get(sessionId) as GhostRow | undefined;
  if (!g) return null;

  const rows = db
    .prepare(`SELECT id, seq, ts, text FROM ghost_prompts WHERE session_id = ? ORDER BY seq`)
    .all(sessionId) as GhostPromptRow[];

  let chars = 0;
  const units: TranscriptUnit[] = rows.map((r) => {
    // `unitText` with an empty assistant side, deliberately: the prompt is
    // labelled `user:` exactly as it would be in a session, so the model reads
    // one shape and a person opening the mirror reads one shape.
    const text = unitText(r.text, '');
    chars += text.length;
    return { seq: r.seq, id: r.id, ts: r.ts, text };
  });

  // The harness's own title when a `sessions-index.json` survived the sweep;
  // otherwise the opening prompt, which is what `ls` already falls back to.
  const title = g.title?.trim() || g.first_prompt?.trim() || null;

  return {
    id: g.session_id,
    kind: 'ghost',
    harness: g.harness,
    title,
    project: g.project,
    projectSlug: ghostProjectSlug(g.project),
    units,
    chars,
    isSidechain: false,
  };
}

/**
 * `/Users/dev/Downloads/data_pipeline` -> `-Users-dev-Downloads-data-pipeline`.
 *
 * `ghosts` has no `project_slug` column — the transcript that would have
 * carried one is what the sweep deleted — so the slug is re-derived here with
 * Claude Code's own encoding: every character that is not a letter or a digit
 * becomes `-`. Deriving it rather than handing the raw path to `safeSlug` is
 * what puts a ghost's card in the *same* mirror directory as the surviving
 * sessions of the same project instead of one directory beside it.
 */
export function ghostProjectSlug(project: string | null | undefined): string | null {
  const p = project?.trim();
  if (!p) return null;
  return p.replace(/[^A-Za-z0-9]/g, '-');
}

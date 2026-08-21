import type { Db } from './db.js';
import type { Harness, SessionStatus } from './adapters/types.js';
import {
  buildExchangeFilters,
  buildGhostFilters,
  buildSessionFilters,
  knnCandidates,
  validateISODate,
  type SearchFilters,
} from './search/filters.js';
import { RRF_K, rrfScore, l2DistanceToCosineSimilarity } from './search/similarity.js';
import {
  denseSnippet,
  isMostlyBoilerplate,
  matchSnippet,
  wordMatchesToken,
  wordSpans,
  type MatchSnippet,
} from './search/snippet.js';
import { vecStatus, vecTablesExist } from './vec.js';
import {
  EMBEDDING_VERSION,
  embeddingToBlob,
  generateQueryEmbedding,
  isModelCached,
} from './embeddings.js';
import { modelsDir, potsherdDir } from './paths.js';

/**
 * L6 — recall.
 *
 * `03` §7: `find(query, filters)` = rrf( bm25(exchanges_fts), bm25(cards_fts),
 * bm25(ghosts_fts), vec(exchanges), vec(cards) ), k=60, with session
 * diversification (max 3 exchanges per session in the top list).
 *
 * Four of those lists exist today and are fused here. The two `cards` lists are
 * phase 2's — `cards_fts` and `vec_cards` are created by migration 2/4 and are
 * empty until a card writer fills them, so they are named in {@link LISTS} and
 * left switched off rather than faked. Turning them on is adding two entries to
 * the same fusion loop.
 *
 * **Nothing here is upstream's.** obra/episodic-memory has no fts5 and no bm25
 * — its text search is `LIKE '%q%'` (`src/search.ts:180-190`) — so there was no
 * hybrid to port. What is inherited is the arithmetic underneath: the
 * distance→similarity identity, the injection-safe filter builder and the
 * snippet shaping, all in `search/`.
 *
 * ## Three properties this module is built around
 *
 * 1. **Vectors are optional.** With `--no-embed`, with sqlite-vec unavailable,
 *    or on a machine where the 34 MB model was never fetched, recall degrades
 *    to bm25 alone and *says so* in {@link RecallResult.vectors}. It never
 *    throws, and it never silently returns a worse answer without a reason the
 *    caller can print.
 * 2. **Sidechains and ghosts are in by default.** They are the reason potsherd
 *    exists: 197 subagent transcripts and 299 deleted sessions on the reference
 *    machine that every other tool hides. `filters.sidechains` and
 *    `filters.ghosts` both default to `include`.
 * 3. **The fusion is rank-based, so the lists never need a common scale.** bm25
 *    returns a negative log-odds-ish number, cosine returns [-1, 1]; RRF only
 *    reads their *order*, which is the entire reason it is the right fusion for
 *    a hybrid with no training data to calibrate on.
 */

// ------------------------------------------------------------------- shapes

export type ListName =
  | 'titles'
  | 'exchanges_fts'
  | 'ghosts_fts'
  | 'ghost_prompts_fts'
  | 'vec_exchanges'
  /** phase 2 */
  | 'cards_fts'
  /** phase 2 */
  | 'vec_cards';

/** The lists `recall` runs today. `cards_fts`/`vec_cards` join in phase 2. */
export const LISTS: readonly ListName[] = [
  'titles',
  'exchanges_fts',
  'ghosts_fts',
  'ghost_prompts_fts',
  'vec_exchanges',
];

export interface RecallHit {
  /**
   * `exchange` has both sides; `ghost` has the prompt side only; `title` is the
   * session's own name matching, which has no body text behind it.
   */
  kind: 'exchange' | 'ghost' | 'title';
  sessionId: string;
  /** `exchanges.id`, or `ghost_prompts.id`. Absent for a `ghosts_fts` hit. */
  id?: string;
  seq?: number;
  ts?: string | null;
  /** The text the snippet was cut from. */
  userText: string;
  assistantText?: string;
  snippet: MatchSnippet;
  isSidechain: boolean;
  /** Fused score. Bigger is better; RRF scores are small (~0.016 at rank 1). */
  score: number;
  /** Which lists put this row where, for `--json` and for debugging recall. */
  from: { list: ListName; rank: number; raw: number }[];
}

export interface RecallSession {
  id: string;
  kind: 'session' | 'ghost';
  harness: Harness;
  title: string | null;
  /** `title`, or `<slug>-<id8>` when the harness never wrote one. */
  displayTitle: string;
  project: string | null;
  /** Last path segment of `project` — what a table column can hold. */
  projectName: string;
  startedAt: string | null;
  endedAt: string | null;
  status: SessionStatus;
  isSidechain: boolean;
  parentSessionId: string | null;
  agentName: string | null;
  gitBranch: string | null;
  pinned: boolean;
  /** User prompts (a session) or recovered prompts (a ghost). */
  prompts: number;
  exchanges: number;
  /** Subagent transcripts that name this session as their parent. */
  subagents: number;
  bytes: number;
  /** `claude --resume <id>` / `codex resume <id>`, or null when not resumable. */
  resume: string | null;
  score: number;
  hits: RecallHit[];
}

export interface VectorState {
  /** True when the vec list actually contributed to this result. */
  used: boolean;
  available: boolean;
  /** One line, printable, when `used` is false. */
  reason?: string;
  vectors?: number;
}

export interface RecallResult {
  query: string;
  sessions: RecallSession[];
  /** Every hit that survived diversification, best first. */
  hits: RecallHit[];
  vectors: VectorState;
  lists: { list: ListName; candidates: number; ms: number }[];
  /** True when the exact-AND pass found too little and the OR pass was run. */
  relaxed: boolean;
  ms: number;
}

export interface RecallOptions {
  /** Sessions to return. Default 10. */
  limit?: number;
  /** RRF's k. `03` §7 fixes it at 60; the knob exists for the evals. */
  k?: number;
  /** Which lists to fuse. Default {@link LISTS}, minus whatever is unavailable. */
  lists?: readonly ListName[];
  /** Session diversification: exchange hits kept per session. Default 3. */
  perSession?: number;
  /** Candidate depth per list. Default `max(limit * 10, 60)`. */
  candidates?: number;
  /**
   * The vector half of the hybrid.
   *
   *   `true`   — always run it.
   *   `false`  — never (`--no-vec`, and what `--no-embed` leaves you with).
   *   `'auto'` — the default: run it only when the words did not already
   *              settle the question.
   *
   * `'auto'` exists because the two halves have costs three orders of
   * magnitude apart. bm25 over `exchanges_fts` is a single index seek —
   * sub-millisecond, and the reason `03` §12 can ask for a p50 under 150 ms
   * end to end. The vector half needs a forward pass through bge-small to
   * embed the query, which is ~350 ms on the reference machine and dominates
   * everything else the verb does.
   *
   * And it buys nothing when the text index already returned a full page of
   * exact matches: RRF would reorder results the user is about to be happy
   * with. Where it earns its cost is exactly where bm25 struggles — a query
   * whose words are not the words in the transcript, which is precisely the
   * case `recall` detects when the AND pass comes back thin and has to relax.
   * So: run the cheap list first, and pay for the expensive one only when the
   * cheap one asked for help.
   */
  vectors?: boolean | 'auto';
  /** potsherd root, so the embedding model is found under `--potsherd-dir`. */
  root?: string;
}

/** Max exchange hits from one session in the top list (`03` §7). */
export const PER_SESSION = 3;

/**
 * Per-list weight in the fusion. RRF's own formula has none — every list is
 * `1/(k+rank)` — and for lists of comparable trustworthiness that is right.
 *
 * The vector list is not comparable. A bm25 hit at rank 1 means *this
 * conversation contains the words you typed*; a cosine hit at rank 1 means
 * *this is the nearest of 1,406 points in a 384-dimensional space*, and on a
 * corpus this size the nearest point to almost any query is something. Equal
 * weights let one semantic near-miss outrank an exact quotation, which is what
 * it did on the reference corpus before this line existed.
 *
 * At 0.5 a top vector hit scores below a third-place bm25 hit: vectors add
 * sessions the words missed and break ties among the ones they found, and they
 * do not overturn a literal match. That is the job.
 */
/**
 * What a list's hits are worth once that list had to loosen the query.
 *
 * A hit found by the words as typed is stronger evidence than one found only
 * after falling back to any-word matching, and because the lists relax
 * independently the two kinds routinely appear side by side. On the reference
 * corpus, "canon printer driver" appears verbatim in a deleted session's
 * prompts and nowhere in any surviving transcript — so `ghost_prompts_fts`
 * answers exactly while `exchanges_fts` relaxes, and without this the relaxed
 * list's top three still outrank the exact one.
 */
const RELAXED_PENALTY = 0.6;

/**
 * What {@link titleMatches} returns: the ranked titles, and *how much of the
 * query* the best of them actually covered.
 *
 * The coverage is the correction T1.7b's eval set forced. `titles` is weighted
 * at 1.5 because a session named after what you asked is stronger evidence
 * than a paragraph mentioning it — but only when the title is named after what
 * you asked. `titleMatches` keeps whichever titles matched *best*, and when
 * nothing matches well "best" can be one common word out of six: on the new
 * eval set, `find "stop counting the same event twice in the rollup"` filled
 * the whole first page with sessions whose titles contain `twice`, and pushed
 * the untitled session containing `event`, `twice` **and** `rollup` to sixth.
 *
 * Multiplying the list's weight by the fraction of the query the best title
 * covered says the thing rank alone cannot: one word out of six is a hint
 * (0.25), five out of six is an answer (1.25). It costs nothing when the title
 * really is the answer, which is the case the weight was added for.
 */
interface TitleList {
  hits: RawHit[];
  /** Query words the best title matched, over query words asked for. */
  coverage: number;
}

const WEIGHTS: Record<string, number> = {
  // A title is a statement about the *whole* session — Claude Code's own
  // `ai-title`, or codex's thread name. One paragraph out of four hundred
  // mentioning "instagram" and a session called "Build Instagram chat-only
  // client" are not the same evidence, and rank alone cannot say so. Scaled
  // by coverage at fusion time; see {@link TitleList}.
  titles: 1.5,
  exchanges_fts: 1,
  ghosts_fts: 1,
  ghost_prompts_fts: 1,
  vec_exchanges: 0.5,
};

// -------------------------------------------------------------- fts5 syntax

export interface FtsQuery {
  tokens: string[];
  /** All tokens required. Precise, and the pass that runs first. */
  and: string;
  /** Any token, prefix-matched. The relaxation when AND found too little. */
  or: string;
}

/**
 * Turn a user's words into an fts5 MATCH expression.
 *
 * Every token is wrapped in double quotes, which in fts5 means "a literal
 * string, not syntax" — so `AND`, `NEAR/3`, `*`, `^`, `-` and an unbalanced
 * quote are all just words. That is the whole injection surface of MATCH, and
 * closing it here means no caller has to think about it. (The `"` inside a
 * token is doubled, fts5's own escape.)
 */
export function ftsQuery(query: string): FtsQuery {
  const tokens = (query.match(/[\p{L}\p{N}_]+/gu) ?? []).map((t) => t.toLowerCase()).slice(0, 24);
  const quote = (t: string): string => `"${t.replace(/"/g, '""')}"`;
  // Stopwords are dropped from the OR pass only. In the AND pass "the" costs
  // nothing — every document that has the other four words probably has it
  // too. In the OR pass it is actively harmful: `"the"* OR "pod"` ranks a
  // ghost prompt that merely contains "there" alongside the one exchange that
  // is about the pod, and RRF cannot tell them apart because both are rank 1
  // in their own list. Measured on the eval set: this alone is the difference
  // between the kubernetes query landing at #7 and at #1.
  const meaningful = tokens.filter((t) => !STOPWORDS.has(t));
  const orTokens = meaningful.length > 0 ? meaningful : tokens;
  return {
    tokens,
    and: tokens.map(quote).join(' AND '),
    // Prefix matching, but only on tokens long enough for the extension to be
    // an inflection rather than a different word. `"driver"*` reaching
    // "drivers" is what a user means; `"canon"*` reaching `canonicalJson` is
    // not, and on the reference corpus that one match put a session about an
    // unrelated build system above the ghost that was actually about a Canon
    // printer. Six characters is where the extensions stop being surprising.
    or: orTokens.map((t) => (t.length >= PREFIX_MIN ? `${quote(t)}*` : quote(t))).join(' OR '),
  };
}

/**
 * The smallest closed-class list that does the job. Deliberately not a full
 * English stopword list: fts5's own tokenizer keeps everything, potsherd
 * searches technical prose where "not", "no" and "off" carry meaning, and a
 * long list would start eating words people search for on purpose.
 */
/** Shortest token the OR pass will prefix-match. See {@link ftsQuery}. */
const PREFIX_MIN = 6;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with',
  'is', 'it', 'this', 'that', 'be', 'was', 'are', 'as', 'by', 'we', 'i',
]);

// ------------------------------------------------------------------ helpers

/** The command that puts the user back inside that session, when there is one. */
export function resumeCommand(
  harness: Harness,
  id: string,
  status: SessionStatus = 'live',
  parentSessionId?: string | null,
): string | null {
  // An archived or ghost session has no transcript where the harness looks for
  // one, so its own resume command would fail. Printing it anyway would be the
  // worst kind of wrong: a command that looks like the fix and is not.
  if (status !== 'live') return null;
  // A subagent transcript is not resumable — `4c9339e0-…:agent-a02db260…` is
  // potsherd's id for a file, not a session claude will reopen. What the user
  // actually wants is the conversation that spawned it, so that is what is
  // offered. This is the difference between a command that works and a
  // command that looks like it should.
  const target = parentSessionId || id;
  if (target.includes(':')) return null;
  switch (harness) {
    case 'claude':
      return `claude --resume ${target}`;
    case 'codex':
      return `codex resume ${target}`;
    default:
      // cursor and pi resume from their own UI, not from an id on a command
      // line. `potsherd show` is the honest next step there.
      return null;
  }
}

/** `/Users/x/Meghavi-Second-Brain` -> `Meghavi-Second-Brain`. */
export function projectName(project: string | null | undefined): string {
  if (!project) return '—';
  const parts = project.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? project;
}

/**
 * The eight characters of a session id that identify *this* session.
 *
 * Normally the first eight, which is what `--resume` and `potsherd show` take.
 * A claude subagent transcript is different: its id is
 * `<parent-uuid>:agent-<hash>`, so the first eight characters are the
 * *parent's* and every one of the 197 subagents on the reference machine would
 * be labelled identically. The distinguishing half is on the right, so that is
 * the half taken.
 */
export function idTag(id: string): string {
  const colon = id.lastIndexOf(':');
  if (colon === -1) return id.slice(0, 8);
  return id.slice(colon + 1).replace(/^agent-/, '').slice(0, 8);
}

/**
 * What `ls` shows for a session the harness never titled — sdk sessions, and
 * every codex thread before it is named. `03` §7 calls it `<slug>-<id8>`; the
 * slug used is the project's last segment rather than claude's own
 * `-Users-zebra-Fulcrum` form, because the point is a name that fits a column.
 */
export function fallbackTitle(
  project: string | null | undefined,
  id: string,
  harness: Harness = 'claude',
): string {
  const slug = project ? projectName(project) : harness;
  return `${slug}-${idTag(id)}`;
}

export function displayTitleOf(
  title: string | null | undefined,
  project: string | null | undefined,
  id: string,
  harness: Harness = 'claude',
): string {
  const clean = title?.replace(/\s+/g, ' ').trim();
  return clean ? clean : fallbackTitle(project, id, harness);
}

/**
 * The snippet, and which half of the exchange to cut it from.
 *
 * An exchange is a prompt *and* an answer, and the words the user is now
 * searching for are as often in one as in the other. The first version always
 * cut from `user_text` and only looked at `assistant_text` when the prompt was
 * empty — which is how the T1.7 review got a top-three result whose entire
 * snippet was `[Image: source: /var/folders/…/clipboard-…]`: that *was* the
 * prompt. Someone pasted a screenshot, and the answer underneath — the part
 * that actually matched — was never considered.
 *
 * So both sides are scored, by how many distinct query words each contains
 * after machine boilerplate is discounted, and the winner is quoted. Ties go
 * to the prompt, because a person recognises their own question faster than
 * they recognise an answer they have forgotten.
 */
export function bestSnippet(
  userText: string,
  assistantText: string | undefined,
  query: string,
  tokens: readonly string[],
): MatchSnippet {
  const sides = [userText ?? '', assistantText ?? ''].filter((s) => s.trim().length > 0);
  if (sides.length === 0) return { text: '' };

  const exact = query.trim().toLowerCase();
  const scored = sides.map((text) => {
    const lower = text.toLowerCase();
    const distinct = new Set(
      wordSpans(text)
        .map((s) => tokens.find((t) => wordMatchesToken(s.word, t)))
        .filter((t): t is string => Boolean(t)),
    ).size;
    return {
      text,
      // The whole phrase, verbatim, beats any count of scattered words.
      phrase: exact.length > 0 && lower.includes(exact) ? 1 : 0,
      distinct,
      boilerplate: isMostlyBoilerplate(text) ? 1 : 0,
    };
  });
  scored.sort(
    (a, b) =>
      b.phrase - a.phrase ||
      b.distinct - a.distinct ||
      a.boilerplate - b.boilerplate ||
      sides.indexOf(a.text) - sides.indexOf(b.text),
  );
  const chosen = scored[0]!;
  if (chosen.phrase === 1 && chosen.distinct <= 1) return matchSnippet(chosen.text, query);
  return denseSnippet(chosen.text, tokens);
}

// -------------------------------------------------------------------- lists

interface RawHit {
  key: string;
  kind: 'exchange' | 'ghost' | 'title';
  sessionId: string;
  id?: string;
  seq?: number;
  ts?: string | null;
  userText: string;
  assistantText?: string;
  isSidechain: boolean;
  raw: number;
}

function tableExists(db: Db, name: string): boolean {
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?`)
      .get(name) as { n: number };
    return row.n > 0;
  } catch {
    return false;
  }
}

/**
 * The session's own title, matched by hand rather than by fts5.
 *
 * `03` §3 puts titles in `cards_fts`, which phase 2 fills. Until then
 * `sessions.title` — the string `ls` prints, the string the user just read and
 * is now typing back — is in **no** search index at all. On the reference
 * corpus that is worth three of ten queries: "session context search and
 * memory tool" is the exact title of the most recent session and bm25 over the
 * bodies did not return it in the top ten, because the body of a session about
 * search says "search" four hundred times and so does everything else.
 *
 * There are only a few hundred titles, so this needs no index: one `LIKE` per
 * token (bound, never concatenated), then ranked in JS by how many of the
 * query's words the title actually contains and how little else it says. It
 * joins the fusion as one more ranked list, which is exactly what RRF is for —
 * and when `cards_fts` arrives it becomes one more list beside this one rather
 * than a replacement for it.
 */
function titleMatches(
  db: Db,
  allTokens: string[],
  filters: SearchFilters,
  depth: number,
): TitleList {
  // Stopwords out: a title is a handful of words, so "the" matching is not
  // evidence of anything, and with the weight this list carries it would be
  // actively misleading.
  const meaningful = allTokens.filter((t) => !STOPWORDS.has(t));
  const tokens = meaningful.length > 0 ? meaningful : allTokens;
  if (tokens.length === 0) return { hits: [], coverage: 0 };
  const likes = tokens.map(() => 'LOWER(s.title) LIKE ?').join(' OR ');
  const params = tokens.map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const f = buildSessionFilters(filters);
  const rows = db
    .prepare(
      `SELECT s.id AS id, s.title AS title, s.started_at AS ts, s.is_sidechain AS is_sidechain
         FROM sessions s
        WHERE s.title IS NOT NULL AND (${likes}) ${f.sql}
        LIMIT ?`,
    )
    .all(...params, ...f.params, depth * 2) as {
    id: string;
    title: string;
    ts: string | null;
    is_sidechain: number;
  }[];

  if (rows.length === 0) return { hits: [], coverage: 0 };
  const scored = rows.map((r) => {
    const lower = r.title.toLowerCase();
    const matched = tokens.filter((t) => lower.includes(t)).length;
    return { r, matched, len: r.title.length };
  });
  // Only the titles that match the query *best* stay. A list that also carried
  // every title sharing one word with the query would be mostly noise, and
  // noise weighted at 1.5 is worse than no list at all — the question this
  // list answers is "is a session named after what you asked", and a title
  // matching one word out of four is not an answer to it.
  const bestMatched = Math.max(...scored.map((x) => x.matched));
  const strongest = scored.filter((x) => x.matched === bestMatched);
  // Among equals, the title that says least else: "Build Instagram chat-only
  // client" over a sentence that mentions Instagram in passing.
  strongest.sort((a, b) => a.len - b.len);
  return {
    coverage: bestMatched / tokens.length,
    hits: strongest.slice(0, depth).map(({ r }) => ({
      key: `t:${r.id}`,
      kind: 'title' as const,
      sessionId: r.id,
      ts: r.ts,
      userText: r.title,
      isSidechain: r.is_sidechain === 1,
      raw: 0,
    })),
  };
}

function bm25Exchanges(db: Db, match: string, filters: SearchFilters, depth: number): RawHit[] {
  const f = buildExchangeFilters(filters);
  const rows = db
    .prepare(
      `SELECT e.id AS id, e.session_id AS session_id, e.seq AS seq, e.ts AS ts,
              e.user_text AS user_text, e.assistant_text AS assistant_text,
              e.is_sidechain AS is_sidechain,
              bm25(exchanges_fts, 2.0, 1.0) AS rank
         FROM exchanges_fts
         JOIN exchanges e ON e.rowid = exchanges_fts.rowid
         JOIN sessions  s ON s.id = e.session_id
        WHERE exchanges_fts MATCH ?
          ${f.sql}
        ORDER BY rank
        LIMIT ?`,
    )
    .all(match, ...f.params, depth) as {
    id: string;
    session_id: string;
    seq: number;
    ts: string | null;
    user_text: string;
    assistant_text: string;
    is_sidechain: number;
    rank: number;
  }[];
  return rows.map((r) => ({
    key: `e:${r.id}`,
    kind: 'exchange' as const,
    sessionId: r.session_id,
    id: r.id,
    seq: r.seq,
    ts: r.ts,
    userText: r.user_text,
    assistantText: r.assistant_text,
    isSidechain: r.is_sidechain === 1,
    raw: r.rank,
  }));
}

function bm25Ghosts(db: Db, match: string, filters: SearchFilters, depth: number): RawHit[] {
  const f = buildGhostFilters(filters);
  const rows = db
    .prepare(
      `SELECT g.session_id AS session_id, g.first_prompt AS first_prompt, g.title AS title,
              g.first_ts AS ts, bm25(ghosts_fts, 1.0, 2.0) AS rank
         FROM ghosts_fts
         JOIN ghosts g ON g.rowid = ghosts_fts.rowid
        WHERE ghosts_fts MATCH ?
          ${f.sql}
        ORDER BY rank
        LIMIT ?`,
    )
    .all(match, ...f.params, depth) as {
    session_id: string;
    first_prompt: string | null;
    title: string | null;
    ts: string | null;
    rank: number;
  }[];
  return rows.map((r) => ({
    key: `g:${r.session_id}`,
    kind: 'ghost' as const,
    sessionId: r.session_id,
    seq: 0,
    ts: r.ts,
    userText: r.first_prompt ?? r.title ?? '',
    isSidechain: false,
    raw: r.rank,
  }));
}

function bm25GhostPrompts(db: Db, match: string, filters: SearchFilters, depth: number): RawHit[] {
  const f = buildGhostFilters(filters);
  const rows = db
    .prepare(
      `SELECT p.id AS id, p.session_id AS session_id, p.seq AS seq, p.ts AS ts, p.text AS text,
              bm25(ghost_prompts_fts) AS rank
         FROM ghost_prompts_fts
         JOIN ghost_prompts p ON p.rowid = ghost_prompts_fts.rowid
         JOIN ghosts g ON g.session_id = p.session_id
        WHERE ghost_prompts_fts MATCH ?
          ${f.sql}
        ORDER BY rank
        LIMIT ?`,
    )
    .all(match, ...f.params, depth) as {
    id: string;
    session_id: string;
    seq: number;
    ts: string | null;
    text: string;
    rank: number;
  }[];
  return rows.map((r) => ({
    key: `gp:${r.id}`,
    kind: 'ghost' as const,
    sessionId: r.session_id,
    id: r.id,
    seq: r.seq,
    ts: r.ts,
    userText: r.text,
    isSidechain: false,
    raw: r.rank,
  }));
}

function vecExchanges(
  db: Db,
  embedding: number[],
  filters: SearchFilters,
  depth: number,
): RawHit[] {
  // vec0 applies its KNN cut *before* WHERE, so a filtered search has to ask
  // for more neighbours than it wants and trim afterwards (`knnCandidates`).
  const wanted = knnCandidates(depth, filters);
  const near = db
    .prepare(
      `SELECT id, distance FROM vec_exchanges
        WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
    )
    .all(embeddingToBlob(embedding), wanted) as { id: string; distance: number }[];
  if (near.length === 0) return [];

  const order = new Map(near.map((n, i) => [n.id, i]));
  const similarity = new Map(near.map((n) => [n.id, l2DistanceToCosineSimilarity(n.distance)]));
  const f = buildExchangeFilters(filters);
  const placeholders = near.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT e.id AS id, e.session_id AS session_id, e.seq AS seq, e.ts AS ts,
              e.user_text AS user_text, e.assistant_text AS assistant_text,
              e.is_sidechain AS is_sidechain
         FROM exchanges e
         JOIN sessions s ON s.id = e.session_id
        WHERE e.id IN (${placeholders})
          ${f.sql}`,
    )
    .all(...near.map((n) => n.id), ...f.params) as {
    id: string;
    session_id: string;
    seq: number;
    ts: string | null;
    user_text: string;
    assistant_text: string;
    is_sidechain: number;
  }[];

  return rows
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .slice(0, depth)
    .map((r) => ({
      key: `e:${r.id}`,
      kind: 'exchange' as const,
      sessionId: r.session_id,
      id: r.id,
      seq: r.seq,
      ts: r.ts,
      userText: r.user_text,
      assistantText: r.assistant_text,
      isSidechain: r.is_sidechain === 1,
      raw: similarity.get(r.id) ?? 0,
    }));
}

// ------------------------------------------------------------------ vectors

/** Can this database answer a vector query at all, and if not, why not. */
export function vectorState(db: Db, root?: string): VectorState {
  // `vecStatus` is what actually loads vec0 into this connection; without it
  // `vec_exchanges` is a row in sqlite_master that no query can read.
  const ext = vecStatus(db);
  if (!ext.available) {
    return {
      used: false,
      available: false,
      reason: `no vector index — ${ext.reason ?? 'sqlite-vec did not load'}`,
    };
  }
  if (!vecTablesExist(db)) {
    return { used: false, available: false, reason: 'no vector index — never built' };
  }
  let vectors = 0;
  try {
    vectors = (db.prepare('SELECT COUNT(*) AS n FROM vec_exchanges').get() as { n: number }).n;
  } catch {
    return { used: false, available: false, reason: 'no vector index — vec_exchanges unreadable' };
  }
  if (vectors === 0) {
    return {
      used: false,
      available: false,
      vectors: 0,
      reason: 'no embeddings in the index — run  potsherd index  without --no-embed',
    };
  }
  const cache = modelsDir(potsherdDir(root));
  if (!isModelCached(cache)) {
    return {
      used: false,
      available: false,
      vectors,
      reason: 'embedding model not downloaded — run  potsherd index  once online',
    };
  }
  return { used: false, available: true, vectors };
}

// -------------------------------------------------------------------- fusion

/**
 * The whole of `find`'s ranking. Runs each list, fuses by RRF, diversifies by
 * session, and groups into the blocks the renderer prints.
 */
export async function recall(
  db: Db,
  query: string,
  filters: SearchFilters = {},
  options: RecallOptions = {},
): Promise<RecallResult> {
  const started = Date.now();
  const limit = Math.max(1, options.limit ?? 10);
  const k = options.k ?? RRF_K;
  const perSession = Math.max(1, options.perSession ?? PER_SESSION);
  const depth = Math.max(options.candidates ?? Math.max(limit * 10, 60), limit);
  // `--status ghost` is `--ghosts only` said the other way round; a ghost has
  // no row in `sessions`, so there is nothing else it could mean.
  const ghosts = filters.status === 'ghost' ? 'only' : (filters.ghosts ?? 'include');
  const sidechains = filters.sidechains ?? 'include';

  // Validated once, here, rather than inside each list. Every list wraps its
  // own query in a try/catch so a corrupt fts index cannot take the whole
  // search down — which would also swallow a bad `--since` and answer "no
  // results" to a question the user never actually asked.
  if (filters.since) validateISODate(filters.since, '--since');
  if (filters.until) validateISODate(filters.until, '--until');

  const fts = ftsQuery(query);
  const listReports: RecallResult['lists'] = [];
  const empty = (vectors: VectorState): RecallResult => ({
    query,
    sessions: [],
    hits: [],
    vectors,
    lists: listReports,
    relaxed: false,
    ms: Date.now() - started,
  });

  const vecMode: boolean | 'auto' = options.vectors ?? 'auto';
  const vectors: VectorState =
    vecMode === false
      ? { used: false, available: false, reason: 'vectors off (--no-vec)' }
      : vectorState(db, options.root);

  if (fts.tokens.length === 0) return empty(vectors);

  // Which lists are in play. A tri-state filter switches whole lists off:
  // `--ghosts only` is not "search everything then drop the non-ghosts", it is
  // "do not run the exchange lists at all", which is also why it is fast.
  const wanted = new Set<ListName>(options.lists ?? LISTS);
  if (ghosts === 'only') {
    wanted.delete('titles');
    wanted.delete('exchanges_fts');
    wanted.delete('vec_exchanges');
    wanted.delete('cards_fts');
    wanted.delete('vec_cards');
  }
  // A ghost is a row from history.jsonl: prompts only, never a subagent. So
  // `--ghosts exclude` and `--sidechains only` both mean the same thing here.
  if (
    ghosts === 'exclude' ||
    sidechains === 'only' ||
    (filters.status && filters.status !== 'ghost') ||
    filters.file
  ) {
    wanted.delete('ghosts_fts');
    wanted.delete('ghost_prompts_fts');
  }
  if (!vectors.available) wanted.delete('vec_exchanges');
  // Phase 2 owns these two; they are empty until a card writer runs.
  if (!tableExists(db, 'cards_fts')) wanted.delete('cards_fts');
  wanted.delete('vec_cards');
  wanted.delete('cards_fts');

  let relaxed = false;
  const relaxedLists = new Set<ListName>();

  /**
   * Exact first, then relaxed — **per list**, not globally.
   *
   * `AND` is what someone typing five words means, and where it works it
   * should not be second-guessed. But the lists have very different shapes: an
   * `exchanges` row is a prompt plus a whole assistant turn and easily holds
   * five words, while a `ghost_prompts` row is one sentence out of
   * `history.jsonl` and almost never does. Relaxing globally therefore either
   * starves the ghosts (never relax) or floods the exchanges with any-word
   * noise (always relax).
   *
   * Relaxing each list only when *that list* found nothing gives both: the
   * precise answer keeps its rank, and the deleted session still surfaces.
   */
  const textList = (list: ListName, fn: (match: string) => RawHit[]): RawHit[] => {
    if (!wanted.has(list)) return [];
    const t0 = Date.now();
    let hits: RawHit[] = [];
    let usedOr = false;
    try {
      hits = fn(fts.and);
      if (hits.length === 0 && fts.or && fts.or !== fts.and) {
        usedOr = true;
        hits = fn(fts.or);
      }
    } catch {
      // A malformed external-content index or a missing table must not take
      // the whole query down; the other lists still have an answer.
      hits = [];
    }
    if (usedOr) {
      relaxedLists.add(list);
      if (hits.length > 0) relaxed = true;
    }
    listReports.push({ list, candidates: hits.length, ms: Date.now() - t0 });
    return hits;
  };

  const titles = wanted.has('titles')
    ? titled(db, fts.tokens, filters, depth, listReports)
    : { hits: [], coverage: 0 };
  const lists: Record<string, RawHit[]> = {
    titles: titles.hits,
    exchanges_fts: textList('exchanges_fts', (m) => bm25Exchanges(db, m, filters, depth)),
    ghosts_fts: textList('ghosts_fts', (m) => bm25Ghosts(db, m, filters, depth)),
    ghost_prompts_fts: textList('ghost_prompts_fts', (m) =>
      bm25GhostPrompts(db, m, filters, depth),
    ),
  };

  // The question `auto` asks is not "did we fill the page" but "did the words
  // work". If the user's exact words appear together in some conversation, the
  // text index has already answered and a 350 ms forward pass through
  // bge-small can only reorder an answer they are about to be happy with.
  // Semantic search earns its cost in the other case: when the words appear
  // nowhere and `exchanges_fts` had to fall back to any-word matching.
  const settled = !relaxedLists.has('exchanges_fts') && (lists['exchanges_fts']?.length ?? 0) > 0;
  if (vecMode === 'auto' && settled) {
    wanted.delete('vec_exchanges');
    vectors.reason = 'the words matched; --vectors on adds semantic search';
  }

  if (wanted.has('vec_exchanges')) {
    const t0 = Date.now();
    try {
      const embedding = await generateQueryEmbedding(query, {
        cacheDir: modelsDir(potsherdDir(options.root)),
      });
      const hits = vecExchanges(db, embedding, filters, depth);
      listReports.push({ list: 'vec_exchanges', candidates: hits.length, ms: Date.now() - t0 });
      lists['vec_exchanges'] = hits;
      vectors.used = hits.length > 0;
    } catch (err) {
      vectors.used = false;
      vectors.reason = `vectors unavailable: ${firstLine((err as Error)?.message ?? String(err))}`;
    }
  }

  // Stopwords do not make a snippet. `find "key on a replayed request"` that
  // highlights `on` has pointed at the one word in the query that explains
  // nothing, and the density search would happily centre a window on the
  // three places a document says "a". The full token list still drives the
  // *ranking*; only the quoting uses the meaningful half.
  const meaningfulTokens = fts.tokens.filter((t) => !STOPWORDS.has(t));
  const quotableTokens = meaningfulTokens.length > 0 ? meaningfulTokens : fts.tokens;

  // ---- reciprocal rank fusion
  const fused = new Map<string, RawHit & { score: number; from: RecallHit['from'] }>();
  for (const [name, hits] of Object.entries(lists)) {
    const weight =
      (WEIGHTS[name] ?? 1) *
      (name === 'titles' ? titles.coverage : 1) *
      (relaxedLists.has(name as ListName) ? RELAXED_PENALTY : 1);
    hits.forEach((hit, i) => {
      const rank = i + 1;
      const contribution = weight * rrfScore(rank, k);
      const seen = fused.get(hit.key);
      if (seen) {
        seen.score += contribution;
        seen.from.push({ list: name as ListName, rank, raw: hit.raw });
        // A vec hit carries no better text than an fts hit of the same row, but
        // it may be the only one that has it.
        if (!seen.assistantText && hit.assistantText) seen.assistantText = hit.assistantText;
      } else {
        fused.set(hit.key, {
          ...hit,
          score: contribution,
          from: [{ list: name as ListName, rank, raw: hit.raw }],
        });
      }
    });
  }

  const ranked = [...fused.values()].sort(
    (a, b) => b.score - a.score || (a.seq ?? 0) - (b.seq ?? 0),
  );

  // ---- session diversification (`03` §7: at most 3 from one session)
  const perSessionCount = new Map<string, number>();
  const kept: RecallHit[] = [];
  for (const hit of ranked) {
    const n = perSessionCount.get(hit.sessionId) ?? 0;
    if (n >= perSession) continue;
    perSessionCount.set(hit.sessionId, n + 1);
    kept.push({
      kind: hit.kind,
      sessionId: hit.sessionId,
      ...(hit.id ? { id: hit.id } : {}),
      ...(hit.seq !== undefined ? { seq: hit.seq } : {}),
      ts: hit.ts ?? null,
      userText: hit.userText,
      ...(hit.assistantText !== undefined ? { assistantText: hit.assistantText } : {}),
      snippet: bestSnippet(hit.userText, hit.assistantText, query, quotableTokens),
      isSidechain: hit.isSidechain,
      score: hit.score,
      from: hit.from,
    });
  }

  // ---- group into session blocks
  const order: string[] = [];
  const grouped = new Map<string, RecallHit[]>();
  for (const hit of kept) {
    if (!grouped.has(hit.sessionId)) {
      grouped.set(hit.sessionId, []);
      order.push(hit.sessionId);
    }
    grouped.get(hit.sessionId)!.push(hit);
  }

  const meta = sessionMeta(db, order);
  const sessions: RecallSession[] = [];
  for (const id of order) {
    const m = meta.get(id);
    if (!m) continue;
    // A session can hold the same text twice — a re-sent prompt, a `/model`
    // typed at both ends of a session — and two identical snippet lines under
    // one heading read as a rendering bug rather than as data.
    const seenText = new Set<string>();
    const hits = grouped.get(id)!.filter((h) => {
      const key = h.snippet.text.trim();
      if (!key) return true;
      if (seenText.has(key)) return false;
      seenText.add(key);
      return true;
    });
    sessions.push({ ...m, score: sessionScore(hits), hits });
    // Three times the page, then sort by the *session's* total and cut. A
    // session whose best single hit ranks eleventh but which matched five
    // times is a better answer than one that matched once at rank ten, and
    // cutting at `limit` before the aggregation would never let it say so.
    if (sessions.length >= limit * 3) break;
  }
  sessions.sort((a, b) => b.score - a.score);
  sessions.length = Math.min(sessions.length, limit);

  const shown = new Set(sessions.map((s) => s.id));
  return {
    query,
    sessions,
    hits: kept.filter((h) => shown.has(h.sessionId)),
    vectors,
    lists: listReports,
    relaxed,
    ms: Date.now() - started,
  };
}

// -------------------------------------------------------------- session meta

type SessionMeta = Omit<RecallSession, 'score' | 'hits'>;

/**
 * Metadata for a mixed set of ids, some of which are sessions and some ghosts.
 * One query per table rather than one per id, because a `find` for a common
 * word touches thirty of them.
 */
export function sessionMeta(db: Db, ids: readonly string[]): Map<string, SessionMeta> {
  const out = new Map<string, SessionMeta>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');

  const sessions = db
    .prepare(
      `SELECT s.id, s.harness, s.title, s.project, s.started_at, s.ended_at, s.status,
              s.is_sidechain, s.parent_session_id, s.agent_name, s.git_branch,
              s.user_prompts, s.assistant_turns, s.bytes,
              (SELECT COUNT(*) FROM exchanges e WHERE e.session_id = s.id) AS exchanges,
              (SELECT COUNT(*) FROM sessions c WHERE c.parent_session_id = s.id) AS subagents,
              (SELECT COUNT(*) FROM pins p WHERE p.session_id = s.id) AS pinned
         FROM sessions s WHERE s.id IN (${placeholders})`,
    )
    .all(...ids) as SessionRow[];
  for (const r of sessions) out.set(r.id, fromSessionRow(r));

  const missing = ids.filter((id) => !out.has(id));
  if (missing.length > 0) {
    const ghostRows = db
      .prepare(
        `SELECT g.session_id, g.harness, g.title, g.first_prompt, g.project,
                g.first_ts, g.last_ts, g.prompt_count, g.git_branch,
                (SELECT p.text FROM ghost_prompts p WHERE p.session_id = g.session_id
                   AND p.text NOT LIKE '/%' AND length(trim(p.text)) > 3
                 ORDER BY p.seq LIMIT 1) AS best_prompt,
                (SELECT COUNT(*) FROM pins p WHERE p.session_id = g.session_id) AS pinned
           FROM ghosts g WHERE g.session_id IN (${missing.map(() => '?').join(',')})`,
      )
      .all(...missing) as GhostRow[];
    for (const r of ghostRows) out.set(r.session_id, fromGhostRow(r));
  }
  return out;
}

export interface SessionRow {
  id: string;
  harness: Harness;
  title: string | null;
  project: string | null;
  started_at: string | null;
  ended_at: string | null;
  status: SessionStatus;
  is_sidechain: number;
  parent_session_id: string | null;
  agent_name: string | null;
  git_branch: string | null;
  user_prompts: number;
  assistant_turns: number;
  bytes: number;
  exchanges: number;
  subagents: number;
  pinned: number;
}

export interface GhostRow {
  session_id: string;
  harness: Harness;
  title: string | null;
  first_prompt?: string | null;
  /** The first prompt that is not a slash command — see `fromGhostRow`. */
  best_prompt?: string | null;
  project: string | null;
  first_ts: string | null;
  last_ts: string | null;
  prompt_count: number;
  git_branch: string | null;
  pinned: number;
}

export function fromSessionRow(r: SessionRow): SessionMeta {
  return {
    id: r.id,
    kind: 'session',
    harness: r.harness,
    title: r.title,
    displayTitle: displayTitleOf(r.title, r.project, r.id, r.harness),
    project: r.project,
    projectName: projectName(r.project),
    startedAt: r.started_at,
    endedAt: r.ended_at,
    status: r.status,
    isSidechain: r.is_sidechain === 1,
    parentSessionId: r.parent_session_id,
    agentName: r.agent_name,
    gitBranch: r.git_branch,
    pinned: r.pinned > 0,
    prompts: r.user_prompts,
    exchanges: r.exchanges,
    subagents: r.subagents ?? 0,
    bytes: r.bytes,
    resume: resumeCommand(r.harness, r.id, r.status, r.parent_session_id),
  };
}

export function fromGhostRow(r: GhostRow): SessionMeta {
  return {
    id: r.session_id,
    kind: 'ghost',
    harness: r.harness,
    title: r.title,
    // Only 19 of the 299 ghosts on the reference machine ever got a title —
    // `sessions-index.json` is swept along with the transcript. What survives
    // in `history.jsonl` is the prompt the user typed, and "fix the canon
    // printer driver on macos" identifies a deleted session far better than
    // `macos_canon_driver-f7ac67c0` does. Untitled *sessions* keep the
    // `<slug>-<id8>` form (`03` T1.2) because they have an assistant side that
    // phase 2's card writer will name properly; a ghost never will.
    //
    // `best_prompt` skips the opening `/model`, `/login` and `/resume` — a
    // slash command is what the user typed *at* Claude Code, not *to* it, and
    // twelve ghosts all called `/model` is no better than twelve uuids.
    displayTitle: displayTitleOf(
      r.title ?? firstPromptTitle(r.best_prompt) ?? firstPromptTitle(r.first_prompt),
      r.project,
      r.session_id,
      r.harness,
    ),
    project: r.project,
    projectName: projectName(r.project),
    startedAt: r.first_ts,
    endedAt: r.last_ts,
    status: 'ghost',
    isSidechain: false,
    parentSessionId: null,
    agentName: null,
    gitBranch: r.git_branch,
    pinned: r.pinned > 0,
    prompts: r.prompt_count,
    exchanges: 0,
    subagents: 0,
    bytes: 0,
    resume: null,
  };
}

/** A ghost's opening prompt, cut to something a table column can hold. */
function firstPromptTitle(text: string | null | undefined): string | null {
  if (!text) return null;
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean || clean.length < 3) return null;
  return clean.length > 120 ? clean.slice(0, 120) : clean;
}

/**
 * A session's score from its hits: the best one, plus half of what the others
 * add.
 *
 * Neither extreme survives contact with a real corpus. Taking the **max**
 * ignores corroboration — a session that answers the question in five places
 * ranks level with one that mentions it once. Taking the **sum** rewards
 * volume — on the reference corpus a 155-exchange session that says
 * "instagram" three times outranks the session actually titled "Build
 * Instagram chat-only client", which is the wrong answer by any human reading.
 *
 * Halving the tail, and capping it at half the best hit, is the smallest thing
 * that says both: the strongest single piece of evidence decides, and
 * repetition breaks ties within that. A session can never score more than 1.5x
 * its own best hit.
 */
function sessionScore(hits: RecallHit[]): number {
  if (hits.length === 0) return 0;
  const sorted = [...hits].sort((a, b) => b.score - a.score);
  const best = sorted[0]!.score;
  const rest = sorted.slice(1).reduce((n, h) => n + h.score, 0);
  // Corroboration is capped at half the best hit, so no amount of repetition
  // can beat strictly better evidence. Uncapped, three mid-ranked mentions
  // inside one long session outscore any single top hit, and the long session
  // wins every query — which is how the reference corpus ranked the session
  // literally titled "Build Instagram chat-only client" eighth for
  // "instagram chat only client".
  return best + Math.min(rest / 2, best / 2);
}

function titled(
  db: Db,
  tokens: string[],
  filters: SearchFilters,
  depth: number,
  reports: RecallResult['lists'],
): TitleList {
  const t0 = Date.now();
  let list: TitleList = { hits: [], coverage: 0 };
  try {
    list = titleMatches(db, tokens, filters, depth);
  } catch {
    list = { hits: [], coverage: 0 };
  }
  reports.push({ list: 'titles', candidates: list.hits.length, ms: Date.now() - t0 });
  return list;
}

function firstLine(s: string): string {
  return (s.split('\n')[0] ?? s).trim();
}

/** Kept honest against `embeddings.EMBEDDING_VERSION` by the index. */
export const RECALL_EMBEDDING_VERSION = EMBEDDING_VERSION;

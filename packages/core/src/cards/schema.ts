/**
 * The card, as a shape — and everything needed to get that shape back out of a
 * chat model that has no obligation to produce it.
 *
 * `03` §6 and `phase-2` T2.2 §2 specify the JSON a card extraction returns.
 * This module owns three separate jobs that are easy to confuse:
 *
 *   1. **{@link CARD_SCHEMA}** — the shape in words, appended to the prompt by
 *      `Llm.json`. It is repeated verbatim on the retry, so it is written to
 *      be short and unambiguous rather than complete.
 *   2. **{@link validateCard}** — the gate that decides whether a reply was a
 *      card at all. It is deliberately *permissive*: it rejects only replies
 *      that carry neither a title nor a summary, because a retry costs a whole
 *      model call and "the model returned six topics instead of eight" is not
 *      worth one.
 *   3. **{@link normaliseCard}** — the clamp. Word and item ceilings, type
 *      coercion, whitespace, de-duplication of the plain string lists. It runs
 *      *after* validation for exactly the reason above: limits are enforced in
 *      code, not by asking the model again.
 *
 * The split matters because `Llm.json` retries when `validate` returns null.
 * A strict validator turns every small drift into a second call, and on a
 * 126-target run that is the difference between the `03` §12 budget and twice
 * it. The pipeline's honesty comes from `verify.ts`, which drops claims the
 * transcript does not support; it does not come from being fussy here.
 */

/** `03` §6: the five outcomes a session can have had. */
export type CardOutcome = 'shipped' | 'partial' | 'abandoned' | 'exploration' | 'unknown';

export const CARD_OUTCOMES: readonly CardOutcome[] = [
  'shipped',
  'partial',
  'abandoned',
  'exploration',
  'unknown',
];

/**
 * A decision or an open thread: something the card *asserts*, with the seq
 * numbers of the exchanges that are supposed to back it up.
 *
 * `evidence_seq` is the whole reason the pipeline can claim to be checkable.
 * `verify.ts` resolves every number in it against the transcript and drops the
 * claim when they do not resolve or do not match.
 */
export interface CardClaim {
  what: string;
  /** Decisions carry a reason; open threads usually do not. */
  why?: string | null;
  evidence_seq: number[];
}

export interface ExtractedCard {
  title: string;
  summary: string;
  topics: string[];
  decisions: CardClaim[];
  files: string[];
  outcome: CardOutcome;
  open_threads: CardClaim[];
  tags: string[];
}

// `phase-2` T2.2 §2's ceilings, enforced in code.
export const MAX_TITLE_WORDS = 8;
export const MAX_SUMMARY_WORDS = 60;
export const MAX_TOPICS = 8;
export const MAX_TAGS = 5;
/** Not in the spec; a card is a card, not a file listing. */
export const MAX_FILES = 20;
export const MAX_CLAIMS = 8;
/** A `what` longer than this is a paragraph pretending to be a claim. */
export const MAX_CLAIM_CHARS = 240;

/**
 * The shape, in words. Appended to every extraction prompt by `Llm.json` and
 * repeated on the retry.
 */
export const CARD_SCHEMA = `{
  "title": "string, at most ${MAX_TITLE_WORDS} words, no trailing punctuation",
  "summary": "string, at most ${MAX_SUMMARY_WORDS} words, past tense, what happened",
  "topics": ["string", "at most ${MAX_TOPICS}"],
  "decisions": [{"what": "string", "why": "string", "evidence_seq": [12, 14]}],
  "files": ["repo-relative path", "at most ${MAX_FILES}"],
  "outcome": "one of: ${CARD_OUTCOMES.join(' | ')}",
  "open_threads": [{"what": "string", "evidence_seq": [31]}],
  "tags": ["lowercase-hyphenated", "at most ${MAX_TAGS}"]
}`;

// --------------------------------------------------------------- coercion

function asString(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function asStringList(v: unknown, max: number): string[] {
  const raw = Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    // A model that was asked for `["a", "b"]` sometimes answers
    // `[{"name": "a"}]`. Take the obvious string out of it rather than
    // spending a retry on the difference.
    const s = asString(
      typeof item === 'object' && item !== null
        ? ((item as Record<string, unknown>)['name'] ??
            (item as Record<string, unknown>)['path'] ??
            (item as Record<string, unknown>)['topic'] ??
            (item as Record<string, unknown>)['what'])
        : item,
    );
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Sequence numbers, as integers.
 *
 * `"12"`, `12.0`, `"seq 12"` and `[12]` all mean 12 and all appear in real
 * replies. Anything that is not a non-negative integer after that is dropped
 * here rather than surviving to `verify.ts` as an unresolvable citation —
 * which is one of the two ways the "100% of evidence_seq resolve" invariant is
 * kept (the other is `verify.ts` pruning seqs the transcript does not have).
 */
export function asSeqList(v: unknown): number[] {
  const raw = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    let n: number;
    if (typeof item === 'number') n = item;
    else if (typeof item === 'string') {
      const m = /-?\d+/.exec(item);
      n = m ? Number(m[0]) : Number.NaN;
    } else continue;
    if (!Number.isFinite(n)) continue;
    n = Math.trunc(n);
    if (n < 0) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function asClaimList(v: unknown, max: number): CardClaim[] {
  const raw = Array.isArray(v) ? v : [];
  const out: CardClaim[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const what = clampChars(item.trim());
      if (what) out.push({ what, evidence_seq: [] });
    } else if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      const what = clampChars(asString(rec['what'] ?? rec['decision'] ?? rec['thread'] ?? rec['text']));
      if (!what) continue;
      const why = asString(rec['why'] ?? rec['reason'] ?? '');
      out.push({
        what,
        ...(why ? { why: clampChars(why) } : {}),
        evidence_seq: asSeqList(rec['evidence_seq'] ?? rec['evidence'] ?? rec['seq']),
      });
    }
    if (out.length >= max) break;
  }
  return out;
}

function clampChars(s: string): string {
  return s.length <= MAX_CLAIM_CHARS ? s : `${s.slice(0, MAX_CLAIM_CHARS - 1).trimEnd()}…`;
}

export function clampWords(s: string, max: number): string {
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length <= max) return words.join(' ');
  return `${words.slice(0, max).join(' ')}…`;
}

function asOutcome(v: unknown): CardOutcome {
  const s = asString(v).toLowerCase();
  for (const o of CARD_OUTCOMES) if (s === o) return o;
  // A model asked for one of five words answers with a sentence containing
  // one of them often enough to be worth reading rather than defaulting.
  for (const o of CARD_OUTCOMES) if (o !== 'unknown' && s.includes(o)) return o;
  return 'unknown';
}

// ---------------------------------------------------------------- the gate

/**
 * Is this reply a card?
 *
 * Yes if it is an object with a non-empty `title` or `summary`. Everything
 * else is coerced. Returning null here costs a whole model call, so it is
 * reserved for a reply that carried no card at all — which is exactly the case
 * `Llm.json`'s retry was built for.
 */
export function validateCard(value: unknown): ExtractedCard | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  // Some replies wrap the card: `{"card": {...}}`, `{"result": {...}}`.
  for (const key of ['card', 'result', 'output', 'data']) {
    const inner = rec[key];
    if (inner && typeof inner === 'object' && !Array.isArray(inner) && !rec['title'] && !rec['summary']) {
      return validateCard(inner);
    }
  }
  const title = asString(rec['title']);
  const summary = asString(rec['summary'] ?? rec['description']);
  if (!title && !summary) return null;
  return normaliseCard({
    title,
    summary,
    topics: asStringList(rec['topics'], MAX_TOPICS),
    decisions: asClaimList(rec['decisions'], MAX_CLAIMS),
    files: asStringList(rec['files'] ?? rec['files_touched'], MAX_FILES),
    outcome: asOutcome(rec['outcome']),
    open_threads: asClaimList(rec['open_threads'] ?? rec['openThreads'], MAX_CLAIMS),
    tags: asStringList(rec['tags'] ?? rec['suggested_tags'], MAX_TAGS),
  });
}

/** Clamp an already-typed card to the spec's ceilings. Idempotent. */
export function normaliseCard(card: ExtractedCard): ExtractedCard {
  return {
    title: clampWords(card.title.replace(/[.\s]+$/, ''), MAX_TITLE_WORDS),
    summary: clampWords(card.summary, MAX_SUMMARY_WORDS),
    topics: card.topics.slice(0, MAX_TOPICS),
    decisions: card.decisions.slice(0, MAX_CLAIMS),
    files: card.files.slice(0, MAX_FILES),
    outcome: card.outcome,
    open_threads: card.open_threads.slice(0, MAX_CLAIMS),
    tags: card.tags.map(tagify).filter(Boolean).slice(0, MAX_TAGS),
  };
}

/** `Postgres Pooling` -> `postgres-pooling`, so `ls --tag` has one spelling. */
export function tagify(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

/**
 * What a card is when both attempts failed to parse.
 *
 * `phase-2`'s risk list: *"json drift from the model → schema check + one retry
 * + fall back to a minimal card (title + summary) rather than failing the
 * run"*. A minimal card still makes the session findable by name, which is
 * most of what a card is for, and it asserts nothing — no decisions, no open
 * threads, outcome `unknown` — so a degraded card can never be a wrong one.
 */
export function minimalCard(title: string, summary: string): ExtractedCard {
  return normaliseCard({
    title,
    summary,
    topics: [],
    decisions: [],
    files: [],
    outcome: 'unknown',
    open_threads: [],
    tags: [],
  });
}

export function emptyCard(): ExtractedCard {
  return minimalCard('', '');
}

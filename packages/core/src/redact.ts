import { createHash } from 'node:crypto';
import type { Exchange, ExchangeToolCall } from './adapters/types.js';
import { Theme } from './theme.js';
import type { Row } from './render.js';
import * as fmt from './format.js';
import {
  ALLOW_SPANS,
  RULES,
  SECRET_TYPES,
  type Rule,
  type SecretType,
} from './redact-rules.js';

export type { SecretType } from './redact-rules.js';
// The pre-redaction pass. Not redaction — it removes binary bulk that carries
// no meaning for retrieval — but it runs immediately before this module on the
// same strings, so it is re-exported here and the two are read together.
export {
  elideBinary,
  elideExchange,
  emptyElisions,
  addElisions,
  MIN_PAYLOAD,
  ELISION_RE,
  type Elisions,
} from './redact-elide.js';
export {
  RULES,
  SECRET_TYPES,
  shannonEntropy,
  ENTROPY_MIN_LENGTH,
  ENTROPY_THRESHOLD,
  nameLooksLikeSecret,
  valueLooksLikeSecret,
  type Rule,
} from './redact-rules.js';

/**
 * L2 — redaction. `plans/03-ARCHITECTURE.md` §5 and §11.
 *
 * This module decides whether a user's secrets can ever leave their machine.
 * Nothing downstream of it — the index, cards, ask, graft — is allowed to see
 * an unredacted string, and every string that reaches a model passes through
 * here first. A false negative is a leaked credential; a false positive is one
 * unreadable token in a search result. The rules are tuned accordingly.
 *
 * Pure and synchronous by contract: no I/O, no network, no module state that
 * survives a call. It runs over the whole corpus at index time, so it also has
 * to be fast — see `tests/redact.test.ts` for the measured 10 MB throughput.
 *
 * ## The mask
 *
 *     ‹redacted:<type>:<sha8>›        e.g. ‹redacted:aws:9f2b1c04›
 *
 * `sha8` is the first 8 hex characters of sha256(secret), so the *same* secret
 * always produces the *same* mask: the index stays searchable by shape ("that
 * session where the same aws key appeared") and never by value. Two different
 * secrets colliding needs a 32-bit sha256 prefix collision.
 *
 * The guillemets are deliberate: `‹` U+2039 and `›` U+203A cannot appear in a
 * shell token, a json key or a base64 blob, so the mask can never be confused
 * for content and can never be pasted back into a command by accident.
 *
 * fts5 tokenisation, measured against the bundled sqlite (default `unicode61`
 * tokenizer): `‹redacted:aws:9f2b1c04›` indexes as the three tokens
 * `redacted`, `aws`, `9f2b1c04` — both guillemets and both colons are
 * separators. So `find "9f2b1c04"` locates every exchange that leaked that one
 * secret, `find "redacted AND aws"` locates every exchange that leaked an aws
 * key, and the phrase query `"redacted:aws:9f2b1c04"` also works. The mask
 * costs three tokens per hit in the index and nothing else.
 *
 * ## What redaction does NOT touch
 *
 * The archive copy (L3) is byte-exact and unredacted: it is the user's own file
 * on the user's own disk. Only the *index* is redacted. There is no
 * `--no-redact` flag (`03` §11) and adding one is not a feature request.
 */

/** A masked secret. `sha8` identifies it without revealing it. */
export interface RedactionHit {
  type: SecretType;
  /** Rule id that claimed it — `doctor` and false-positive triage. */
  rule: string;
  /** First 8 hex chars of sha256(secret). */
  sha8: string;
  /** Offset of the secret in the *input* text. */
  start: number;
  /** Length of the secret in the input text. */
  length: number;
}

export interface RedactionResult {
  text: string;
  hits: RedactionHit[];
}

/** Counts by type, for `doctor`. */
export interface RedactionCounts {
  total: number;
  byType: Record<SecretType, number>;
}

const OPEN = '‹';
const CLOSE = '›';

/** Matches potsherd's own mask, so a second pass recognises its output. */
export const MASK_RE = new RegExp(`${OPEN}redacted:[a-z-]+:[0-9a-f]{8}${CLOSE}`, 'g');

/** The first 8 hex characters of sha256(secret). */
export function secretDigest(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 8);
}

/** `‹redacted:aws:9f2b1c04›` */
export function maskFor(type: SecretType, secret: string): string {
  return `${OPEN}redacted:${type}:${secretDigest(secret)}${CLOSE}`;
}

/** Does this text already contain a potsherd mask? */
export function containsMask(text: string): boolean {
  return new RegExp(MASK_RE.source).test(text);
}

interface Span {
  start: number;
  end: number;
}

/**
 * Mask every secret in `text`.
 *
 * Rules are applied in `RULES` order and the first rule to claim a span keeps
 * it, which is why the table is ordered specific → generic → entropy: a jwt is
 * reported as a jwt and not as three high-entropy tokens, and the base64 body
 * of a private key is reported as one private key and not as forty.
 *
 * Idempotent: existing masks are protected spans, so `redact(redact(x).text)`
 * returns the same text with no further hits.
 */
export function redact(text: string): RedactionResult {
  if (typeof text !== 'string' || text.length === 0) return { text: text ?? '', hits: [] };

  // Claimed characters. One byte per input character: an O(1) overlap test that
  // stays honest when 40 rules each propose overlapping spans.
  const claimed = new Uint8Array(text.length);
  const spans: Array<Span & { rule: Rule; value: string }> = [];

  // Allowlisted regions (data URIs, SRI hashes) and this module's own masks are
  // claimed before any rule runs, so nothing can match inside them.
  for (const span of protectedSpans(text)) claim(claimed, span);

  for (const rule of RULES) {
    for (const m of rule.scan(text)) {
      if (m.start < 0 || m.end > text.length || m.end <= m.start) continue;
      if (isClaimed(claimed, m)) continue;
      claim(claimed, m);
      spans.push({ start: m.start, end: m.end, rule, value: m.value });
    }
  }

  if (spans.length === 0) return { text, hits: [] };
  spans.sort((a, b) => a.start - b.start);

  const out: string[] = [];
  const hits: RedactionHit[] = [];
  let cursor = 0;
  for (const s of spans) {
    out.push(text.slice(cursor, s.start));
    const sha8 = secretDigest(s.value);
    out.push(`${OPEN}redacted:${s.rule.type}:${sha8}${CLOSE}`);
    hits.push({ type: s.rule.type, rule: s.rule.id, sha8, start: s.start, length: s.end - s.start });
    cursor = s.end;
  }
  out.push(text.slice(cursor));
  return { text: out.join(''), hits };
}

/** Just the text, for the many callers that do not care what was masked. */
export function redactText(text: string): string {
  return redact(text).text;
}

/**
 * Redact one exchange in place of its unredacted self: `user_text`,
 * `assistant_text` and every `tool_calls.input` / `.result` (`03` §5). Returns
 * a new object; the input is never mutated, because the caller may still be
 * writing the byte-exact archive copy from it.
 */
export function redactExchange(ex: Exchange): { exchange: Exchange; hits: RedactionHit[] } {
  const hits: RedactionHit[] = [];
  const one = (s: string): string => {
    const r = redact(s);
    if (r.hits.length) hits.push(...r.hits);
    return r.text;
  };

  const userText = one(ex.userText);
  const assistantText = one(ex.assistantText);
  const toolCalls: ExchangeToolCall[] = ex.toolCalls.map((tc) => {
    const next: ExchangeToolCall = { ...tc, input: one(tc.input) };
    if (tc.result !== undefined) next.result = one(tc.result);
    return next;
  });

  return {
    exchange: { ...ex, userText, assistantText, toolCalls, redacted: ex.redacted || hits.length > 0 },
    hits,
  };
}

// ---------------------------------------------------------------- counting

export function emptyCounts(): RedactionCounts {
  const byType = {} as Record<SecretType, number>;
  for (const t of SECRET_TYPES) byType[t] = 0;
  return { total: 0, byType };
}

/** Tally hits by type. `doctor` sums these across the whole index. */
export function tally(hits: Iterable<RedactionHit>, into: RedactionCounts = emptyCounts()): RedactionCounts {
  for (const h of hits) {
    into.byType[h.type] = (into.byType[h.type] ?? 0) + 1;
    into.total++;
  }
  return into;
}

export function addCounts(a: RedactionCounts, b: RedactionCounts): RedactionCounts {
  const out = emptyCounts();
  out.total = a.total + b.total;
  for (const t of SECRET_TYPES) out.byType[t] = (a.byType[t] ?? 0) + (b.byType[t] ?? 0);
  return out;
}

/** `{ total, aws: 3, jwt: 12 }` — the `--json` shape for `doctor`. */
export function countsJson(c: RedactionCounts): Record<string, number> {
  const out: Record<string, number> = { total: c.total };
  for (const t of SECRET_TYPES) if ((c.byType[t] ?? 0) > 0) out[t] = c.byType[t] ?? 0;
  return out;
}

/**
 * The `doctor` line (`03` §5: "`potsherd doctor` reports redaction counts by
 * type"), in the house style of `render.ts`:
 *
 *     secrets masked            1,284   jwt 512 · entropy 402 · aws 12
 *
 * The note lists types by count, biggest first, and elides rather than wraps —
 * `render.ts` never wraps a row. Wired into the doctor card by T1.5; kept here
 * so the counts and the way they are said stay in one file.
 */
export function redactionRow(
  c: RedactionCounts,
  t: Theme = new Theme(),
  noteWidth = 43,
): Row {
  const parts = SECRET_TYPES.filter((k) => (c.byType[k] ?? 0) > 0)
    .sort((a, b) => (c.byType[b] ?? 0) - (c.byType[a] ?? 0))
    .map((k) => `${k} ${fmt.num(c.byType[k] ?? 0)}`);
  const note = parts.length === 0
    ? 'nothing matched — index holds no secrets'
    : fmt.joinFit(parts, noteWidth, ` ${t.mid} `, t.ellip);
  return {
    label: 'secrets masked',
    value: fmt.num(c.total),
    note,
    tone: c.total > 0 ? 'ok' : 'dim',
  };
}

/** One plain line, for logs and for `doctor` in a non-card context. */
export function redactionLine(c: RedactionCounts, t: Theme = new Theme()): string {
  const row = redactionRow(c, t, Math.max(20, t.width - 30));
  return `${row.label.padEnd(22)}${(row.value ?? '').padStart(7)}   ${t.dim(row.note ?? '')}`;
}

// ---------------------------------------------------------------- internals

function protectedSpans(text: string): Span[] {
  const spans: Span[] = [];
  const patterns = [MASK_RE, ...ALLOW_SPANS];
  for (const p of patterns) {
    const rx = new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text)) !== null) {
      if (m[0].length === 0) { rx.lastIndex++; continue; }
      spans.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  return spans;
}

function isClaimed(claimed: Uint8Array, s: Span): boolean {
  for (let i = s.start; i < s.end; i++) if (claimed[i]) return true;
  return false;
}

function claim(claimed: Uint8Array, s: Span): void {
  const end = Math.min(s.end, claimed.length);
  for (let i = Math.max(0, s.start); i < end; i++) claimed[i] = 1;
}

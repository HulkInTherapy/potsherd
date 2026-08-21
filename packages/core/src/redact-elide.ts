/**
 * Binary elision — the pass that runs **before** the redactor.
 *
 * ## Why this exists
 *
 * T1.4 landed the redactor and `potsherd index --full` promptly reported
 * *165,088 secrets masked* over 1,406 exchanges. Measuring where they were
 * (`scripts/redaction-benchmark.mjs`) settled it: 98.6% were in `tool_calls`,
 * and the single worst tool call was a **589 KB base64 JPEG** pasted into a
 * `Read` result, which alone produced 5,660 entropy hits.
 *
 * That is not a miscalibrated entropy rule. It is a picture. No secret scanner
 * ever written can look at 589 KB of base64 and tell you which 40 characters
 * of it are a credential, because none of them are — it is a JPEG. The fix is
 * not to make the detector blinder; it is to stop feeding it images.
 *
 * The codex adapter already established the convention for exactly this
 * problem (`adapters/codex.ts`, "Trap 3"): a binary payload becomes a short
 * marker, `‹elided:image/png:109362 bytes›`. Its regex only recognises
 * `data:…;base64,…` URIs, which is the shape codex writes. Claude Code writes
 * the Anthropic content-block shape instead —
 *
 *     [{"type":"image","source":{"type":"base64","data":"/9j/4AAQ…","media_type":"image/jpeg"}}]
 *
 * — which that regex never sees. This module generalises the convention to
 * both shapes, plus to a bare base64 run that announces itself with a file
 * magic, and is called from `ingest.ts` on the way into the store, before
 * `redactExchange`.
 *
 * ## Why it is safe to run before redaction
 *
 * Every shape elided here is identified by something a *credential never has*:
 * a `data:` URI scheme, an image content-block wrapper, or the base64 of a
 * file-format magic number. A 40-character AWS secret is not a JPEG header,
 * and the {@link MIN_PAYLOAD} floor of 512 base64 characters is far above any
 * credential that has ever been issued. PEM private-key bodies are longer than
 * that but begin `MII…` / `b3Blb…` and carry a `-----BEGIN` header, so they
 * match no magic here and reach the redactor intact — `tests/redact.test.ts`
 * holds that case.
 *
 * The marker uses the same guillemets as the mask (`‹` U+2039, `›` U+203A) and
 * for the same reason: those characters cannot occur in base64, in a shell
 * token or in a json key, so an elision can never be confused for content and
 * a second pass recognises its own output.
 *
 * Elision is **not** redaction and does not pretend to be. It removes bulk
 * that carries no meaning for retrieval; the redactor still runs afterwards
 * over everything that survives, and there is still no `--no-redact` flag.
 */

import type { Exchange, ExchangeToolCall } from './adapters/types.js';

/** What one pass threw away, so a caller can say it out loud. */
export interface Elisions {
  /** Binary payloads replaced by a marker. */
  binaryParts: number;
  /** Characters dropped. */
  charsElided: number;
}

export function emptyElisions(): Elisions {
  return { binaryParts: 0, charsElided: 0 };
}

export function addElisions(a: Elisions, b: Elisions): Elisions {
  return {
    binaryParts: a.binaryParts + b.binaryParts,
    charsElided: a.charsElided + b.charsElided,
  };
}

/**
 * The shortest base64 run this module will elide, in characters. 512 base64
 * characters is 384 bytes.
 *
 * Chosen to sit far above every credential shape in `redact-rules.ts` — the
 * longest is an anthropic key at ~120 characters — so raising this floor can
 * never be the reason a secret is missed. A "binary payload" smaller than this
 * is not worth a marker anyway.
 */
export const MIN_PAYLOAD = 512;

/** Matches this module's own marker, so a second pass is a no-op. */
export const ELISION_RE = /‹elided:[^›]{1,120}›/g;

/**
 * base64 of the first bytes of a file format, longest prefix first.
 *
 * A base64 payload that starts with one of these *is* that file: base64 is a
 * fixed 3-bytes-to-4-characters encoding with no header of its own, so the
 * leading characters are a faithful transcription of the leading bytes, which
 * for every format below is a magic number the format spec mandates.
 *
 * Only formats that actually turn up pasted into an agent transcript are here.
 * Adding one is cheap; guessing one is not, so each names the bytes it encodes.
 */
const BASE64_MAGIC: Array<[prefix: string, mime: string, bytes: string]> = [
  ['iVBORw0KGgo', 'image/png', '89 50 4E 47 0D 0A 1A 0A'],
  ['/9j/', 'image/jpeg', 'FF D8 FF (JFIF/Exif SOI)'],
  ['R0lGODdh', 'image/gif', 'GIF87a'],
  ['R0lGODlh', 'image/gif', 'GIF89a'],
  ['Qk0', 'image/bmp', '42 4D ("BM")'],
  ['SUkqAA', 'image/tiff', '49 49 2A 00 (little-endian TIFF)'],
  ['TU0AK', 'image/tiff', '4D 4D 00 2A (big-endian TIFF)'],
  ['AAABAA', 'image/x-icon', '00 00 01 00 (ICO)'],
  ['UklGR', 'application/octet-stream', '52 49 46 46 ("RIFF" — webp/wav/avi)'],
  ['JVBERi0', 'application/pdf', '25 50 44 46 2D ("%PDF-")'],
  ['UEsDB', 'application/zip', '50 4B 03 04 ("PK\\x03\\x04" — zip/docx/xlsx)'],
  ['H4sI', 'application/gzip', '1F 8B 08'],
  ['SUQz', 'audio/mpeg', '49 44 33 ("ID3")'],
  ['T2dnU', 'application/ogg', '4F 67 67 53 ("OggS")'],
  ['d09GRg', 'font/woff', '77 4F 46 46 ("wOFF")'],
  ['d09GMg', 'font/woff2', '77 4F 46 32 ("wOF2")'],
  ['AAEAAA', 'font/ttf', '00 01 00 00 (TrueType)'],
  ['T1RUTw', 'font/otf', '4F 54 54 4F ("OTTO")'],
];

/** A payload character: base64, plus the `\/` a json encoder writes for `/`. */
const B64_RUN = `(?:[A-Za-z0-9+/=]|\\\\/)`;

/**
 * A payload, possibly hard-wrapped.
 *
 * Whitespace is tolerated *only between two long chunks*. Allowing it as a
 * plain payload character is the obvious way to write this and it is wrong:
 * `<900 characters of png>\ndone` is then a single run, and the elision eats
 * the word after the payload. Requiring a continuation to be ≥ 40 characters
 * means prose on the next line ends the run instead of joining it.
 */
const B64_BODY = `${B64_RUN}{40,}(?:[\\r\\n \\t]+${B64_RUN}{40,})*`;

/**
 * `data:image/png;base64,…` — the shape the codex adapter already elides,
 * kept identical here so the two passes agree and the second is a no-op.
 */
const DATA_URI = new RegExp(
  `data:([a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+)?(?:;[a-zA-Z0-9.+=-]+)*;base64,${B64_BODY}`,
  'g',
);

/**
 * The Anthropic / OpenAI image **content block**, as the parser stringifies it
 * into `tool_calls.result`:
 *
 *     {"type":"image","source":{"type":"base64","data":"/9j/4AAQ…","media_type":"image/jpeg"}}
 *
 * `media_type` may sit either side of `data` (both orders occur in the real
 * corpus), so the mime is recovered by a second look rather than by trying to
 * write one regex that matches both. The payload key is the union of the keys
 * the shapes in the wild use: `data` (anthropic), `image_data`, `b64_json`
 * (openai images), `base64`.
 *
 * The `"base64"` / `media_type` context is *required*: without it this would
 * be "elide any long string called data", which would swallow a base64
 * credential posted in a json body. That case is a planted fixture.
 */
const CONTENT_BLOCK = new RegExp(
  `"(?:data|image_data|b64_json|base64)"\\s*:\\s*"(${B64_BODY})"`,
  'g',
);

/** `"media_type":"image/jpeg"`, `"mimeType": "image/png"`, `"type":"base64"`. */
const MEDIA_HINT = /"(?:media_?type|mime_?type|mimeType)"\s*:\s*"([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+)"|"type"\s*:\s*"base64"/gi;

/** How far either side of a payload a media hint still counts as its own. */
const HINT_WINDOW = 200;

/**
 * A bare base64 run that announces itself with a file magic — a payload pasted
 * without any wrapper at all, which is what `cat image.png | base64` in a Bash
 * tool result looks like.
 *
 * Anchored on the magic prefixes rather than on "any base64 character", which
 * is not a nicety: a `{512,}` quantifier over an unanchored character class
 * is retried at every letter of the corpus, and the corpus is 78 MB. With the
 * literal prefixes up front the engine skips to the next possible start.
 */
const MAGIC_PREFIXES = BASE64_MAGIC.map(([p]) => p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|');
const BARE_RUN = new RegExp(
  `(?<![A-Za-z0-9+/=])(?:${MAGIC_PREFIXES})${B64_BODY}`,
  'g',
);

interface Span {
  start: number;
  end: number;
  mime: string;
}

/** Strip json escapes and whitespace to get at the payload's real leading bytes. */
function magicOf(payload: string): string | undefined {
  const head = payload.slice(0, 32).replace(/\\\//g, '/').replace(/\s+/g, '');
  for (const [prefix, mime] of BASE64_MAGIC) if (head.startsWith(prefix)) return mime;
  return undefined;
}

/** The mime named nearest to `[start,end)`, if the window holds a hint. */
function mimeNear(text: string, start: number, end: number): string | undefined {
  const from = Math.max(0, start - HINT_WINDOW);
  const window = text.slice(from, start) + text.slice(end, Math.min(text.length, end + HINT_WINDOW));
  const rx = new RegExp(MEDIA_HINT.source, MEDIA_HINT.flags);
  let m: RegExpExecArray | null;
  let sawBase64 = false;
  while ((m = rx.exec(window)) !== null) {
    if (m[1]) return m[1];
    sawBase64 = true;
  }
  return sawBase64 ? 'application/octet-stream' : undefined;
}

function collect(re: RegExp, text: string, group: number, decide: (payload: string, start: number, end: number) => string | undefined, out: Span[]): void {
  const rx = new RegExp(re.source, re.flags);
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text)) !== null) {
    const payload = group === 0 ? m[0] : m[group];
    if (payload === undefined || payload.length === 0) { rx.lastIndex += 1; continue; }
    const start = m.index + (group === 0 ? 0 : m[0].indexOf(payload));
    const end = start + payload.length;
    const mime = decide(payload, start, end);
    if (mime === undefined) continue;
    out.push({ start, end, mime });
  }
}

/**
 * Replace every binary payload in `text` with `‹elided:<mime>:<n> bytes›`.
 *
 * Idempotent: the marker contains no base64 run of its own, so a second call
 * finds nothing and returns the same string.
 */
export function elideBinary(text: string, tally: Elisions = emptyElisions()): string {
  if (typeof text !== 'string' || text.length < MIN_PAYLOAD) return text ?? '';
  // Cheap reject. Every shape below needs a long unbroken base64 run, and
  // that needs at least this much alphabet. Skipping here is what keeps the
  // pass off the 99% of transcript text that is prose and code.
  if (!/[A-Za-z0-9+/]{64}/.test(text)) return text;

  const spans: Span[] = [];
  // The regexes only require 40 payload characters so that a hard-wrapped
  // payload still matches as one run; the MIN_PAYLOAD floor is applied here,
  // to the whole run.
  const big = (payload: string) => payload.length >= MIN_PAYLOAD;
  // 1. data: URIs — mime is in the URI itself.
  collect(DATA_URI, text, 0, (payload) => {
    if (!big(payload)) return undefined;
    const m = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+)?/.exec(payload);
    return m?.[1] ?? 'application/octet-stream';
  }, spans);
  // 2. image content blocks — the wrapper must say `base64` or name a mime,
  //    otherwise a long value that merely happens to be called `data` is left
  //    for the redactor to judge.
  collect(CONTENT_BLOCK, text, 1, (payload, start, end) => {
    if (!big(payload)) return undefined;
    const hint = mimeNear(text, start, end);
    if (hint === undefined) return undefined;
    return magicOf(payload) ?? hint;
  }, spans);
  // 3. bare runs that carry a file magic.
  collect(BARE_RUN, text, 0, (payload) => (big(payload) ? magicOf(payload) : undefined), spans);

  if (spans.length === 0) return text;

  // First span wins on overlap: a data: URI inside a content block is elided
  // once, as the URI, not twice.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: string[] = [];
  let cursor = 0;
  for (const s of spans) {
    if (s.start < cursor) continue;
    out.push(text.slice(cursor, s.start));
    const n = s.end - s.start;
    out.push(`‹elided:${s.mime}:${n} bytes›`);
    tally.binaryParts += 1;
    tally.charsElided += n;
    cursor = s.end;
  }
  out.push(text.slice(cursor));
  return out.join('');
}

/**
 * {@link elideBinary} over every field of an exchange that `03` §5 redacts.
 * Returns a new object; the input is never mutated, because the caller may
 * still be writing the byte-exact archive copy from it.
 */
export function elideExchange(ex: Exchange): { exchange: Exchange; elisions: Elisions } {
  const elisions = emptyElisions();
  const one = (s: string): string => elideBinary(s, elisions);

  const userText = one(ex.userText);
  const assistantText = one(ex.assistantText);
  const toolCalls: ExchangeToolCall[] = ex.toolCalls.map((tc) => {
    const next: ExchangeToolCall = { ...tc, input: one(tc.input) };
    if (tc.result !== undefined) next.result = one(tc.result);
    return next;
  });

  if (elisions.binaryParts === 0) return { exchange: ex, elisions };
  return { exchange: { ...ex, userText, assistantText, toolCalls }, elisions };
}

/**
 * Per-prompt derived features for the 1.8 story (port of the insight
 * prototype's features.py). Deterministic, lexicon based, O(len(text)).
 *
 * Runs in the scan workers while the text is in memory; only the derived
 * numbers, sparse phrase indices and bounded, filtered short strings are
 * kept. Full prompt text is never cached.
 */

export const STORY_FEATURES_VERSION = 1;

/** Compact per-prompt feature row. Short keys: thousands of these live in the derived cache. */
export interface PromptFeatures {
  /** Typed characters, words, lines. */
  ch: number; w: number; ln: number;
  /** Bit flags, see FLAG. */
  fl: number;
  /** Swear / insult counts measured on the tone window (paste guard applied). */
  sw: number; ins: number;
  /** First ≤6 swear words (lowercase, unmasked; masked on display). */
  sws?: string[];
  fr: number; cw: number; cr: number; ex: number;
  we: number; i: number; fi: number; pf: number; hi: number;
  /** First word of the prompt (lowercase, ≤24 chars). */
  fw: string;
  /** Normalized line (lowercase, placeholders removed, ≤60 chars) when the prompt is ≤80 chars. */
  sl?: string;
  /** Indices into TICS that occur in this prompt. */
  tc?: number[];
  /** Indices into ADDRESS used vocatively in this prompt. */
  ad?: number[];
}

export const FLAG = {
  paste: 1, image: 2, code: 4, url: 8, pasteSuspect: 16, slur: 32, polite: 64, thanks: 128, sorry: 256,
  multiPunct: 512, question: 1024, delegate: 2048, lets: 4096, please: 8192, history: 16384,
} as const;
export const has = (f: PromptFeatures, flag: number) => (f.fl & flag) !== 0;

export const PLACEHOLDER = /\[(?:Pasted text|Image) #\d+[^\]]*\]/gi;
const URL_RX = /https?:\/\/\S+/g;
const CODEISH = /```[\s\S]*?```/g;
export const WORD = /[a-z][a-z']*/g;

const SWEAR_STEMS = ['fuck', 'shit', 'bullshit', 'wtf', 'damn', 'goddamn', 'crap', 'bitch', 'asshole', 'dumbass',
  'stfu', 'ffs', 'piss', 'bastard', 'motherf', 'bloody',
  'bsdk', 'chutiya', 'chutiye', 'madarchod', 'bhenchod', 'behenchod', 'gandu'];
const SWEAR_EXACT = new Set(['ffs', 'wtf', 'stfu']);
const SWEAR_PREFIX = SWEAR_STEMS.filter(s => !SWEAR_EXACT.has(s));
const INSULT = ['stupid', 'idiot', 'dumb', 'moron', 'useless', 'pathetic', 'lazy', 'incompetent', 'garbage', 'trash', 'retard'];
const SLUR_STEMS = ['retard'];
const POLITE = /\b(please|pls|plz|thanks|thank you|thank u|thx|ty|appreciate|great job|good job|well done|awesome|amazing|love it|love this|nice work|brilliant|you're the best|perfect)\b/;
const THANKS = /\b(thanks|thank you|thank u|thx|ty|appreciate it|great job|good job|well done|nice work)\b/;
const SORRY = /\b(sorry|my bad|apologi[sz]e)\b/;
const FRUSTRATION = /\b(again|still not|still doesn't|still isn't|i told you|i said|i already|not working|doesn't work|didn't work|isn't working|why (?:the|did|are|is|would) |what the|seriously|come on|for the last time|how many times|are you (?:kidding|serious|dumb|stupid))\b/g;
const DELEGATE = /\b(sub-?agents?|agents? in parallel|parallel agents?|spawn|launch (?:\w+ )?agents?|team of agents|multiple agents|\d+ agents)\b/;
const FILLER = /\b(basically|kind of|sort of|i guess|i mean|you know|like,|um+|uh+|okay so|so yeah|whatever)\b/g;
const PERFECTION = /\b(best possible|perfect(?:ly)?|exactly|properly|every single|completely|100%|flawless|world[- ]class|insanely|extremely)\b/g;
const QWORDS = new Set(['what', 'why', 'how', 'is', 'are', 'can', 'could', 'should', 'does', 'do', 'did', 'where', 'when', 'which', 'who', 'will', 'would']);
const WE = /\b(we|we're|we've|let's|us|our)\b/g;
const I_ = /\b(i|i'm|i've|me|my)\b/g;
const HINGLISH = /\b(bhai|yaar|kya|hai|nahi|kar|karo|acha|accha|theek|matlab|abhi|bas|chal|haan)\b/g;
const CAPS = /\b[A-Z][A-Z']{2,}\b/g;
const CAPS_OK = new Set(['API', 'URL', 'HTML', 'CSS', 'JSON', 'CLI', 'PR', 'UI', 'UX', 'MCP', 'LLM', 'SDK', 'README', 'TODO', 'IST', 'PDF', 'NPM', 'AWS', 'GPT', 'MD', 'SEO', 'JS', 'TS', 'ID', 'OK', 'AI', 'CEO', 'USA', 'SQL', 'DB', 'SSH', 'HTTP', 'HTTPS', 'PNG', 'SVG', 'CTA', 'FAQ']);

export function isSwearWord(w: string): boolean {
  if (SWEAR_EXACT.has(w)) return true;
  for (const s of SWEAR_PREFIX) if (w.startsWith(s)) return true;
  return false;
}
const isInsult = (w: string) => INSULT.some(s => w.startsWith(s));
export const isSlur = (w: string) => SLUR_STEMS.some(s => w.startsWith(s));
export const isFWord = (w: string) => w.startsWith('fuck') || w.startsWith('motherf');

/** f*****g style masking for display. */
export function mask(w: string): string {
  return w.length <= 2 ? w : w[0] + '*'.repeat(w.length - 2) + w[w.length - 1];
}

/** Placeholders, fenced code and URLs removed; curly apostrophes straightened. */
export function cleanForTone(text: string): string {
  return text.replace(PLACEHOLDER, ' ').replace(/[‘’]/g, "'").replace(CODEISH, ' ').replace(URL_RX, ' ');
}

const count = (rx: RegExp, s: string) => { rx.lastIndex = 0; let n = 0; while (rx.exec(s)) n++; rx.lastIndex = 0; return n; };
const words = (s: string): string[] => s.match(WORD) ?? [];

/* ------------------------------------------------------------ catalogs --- */

export const TICS = ['one more thing', 'each and every', 'do one thing', 'every single thing', 'kind of a thing', 'and all', 'and stuff', 'or something',
  'at the end of the day', 'to be honest', 'basically', 'you know what', 'let me know', 'best possible', 'world class', 'insanely',
  'make it pop', 'help me out', 'what do you think', "i don't know", 'just do it', 'ship it', 'go ahead', 'lfg', "let's go", 'no worries',
  'makes sense', 'figure it out', 'deep research', 'ultra think', 'ultrathink', 'step by step', 'one shot', 'whatever it takes',
  'end to end', 'from scratch', 'like a pro', 'production ready', 'properly', 'exactly', 'and everything', 'all of that', 'the whole thing',
  'you know', 'i mean', 'sort of', 'kind of', 'so yeah', 'okay so'] as const;
const CLAUSE_FINAL = new Set(['and all', 'and stuff', 'or something', 'and everything', 'all of that', 'and all that']);
/** Expected rate per 100 prompts for a typical heavy user (initial priors). */
export const TIC_PRIOR: Readonly<Record<string, number>> = {
  'kind of': 8, basically: 5, exactly: 6, properly: 3, 'you know': 3, 'i mean': 2, 'what do you think': 2, "i don't know": 3, 'go ahead': 3,
  'let me know': 3, 'the whole thing': 2, 'sort of': 2, 'and all': 2, 'or something': 2, 'from scratch': 1, 'step by step': 1, 'makes sense': 1.5,
  'deep research': 0.5,
};
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Phrases by first word: one walk over the words of a prompt finds every catchphrase. */
const TIC_BY_FIRST = new Map<string, {phrase: string; index: number; final: boolean}[]>();
TICS.forEach((phrase, index) => {
  const first = phrase.split(' ')[0]!;
  const list = TIC_BY_FIRST.get(first) ?? [];
  list.push({phrase, index, final: CLAUSE_FINAL.has(phrase)});
  TIC_BY_FIRST.set(first, list);
});
const CLAUSE_END = /^\s*(?:[.,!?;:)\n]|$|and\b|so\b|but\b)/;
const isWordChar = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c);
/** Indices of TICS present in the (lowercase) text; clause-final hedges only before punctuation, the end, or and/so/but. */
export function ticsIn(low: string): number[] {
  const found = new Set<number>();
  const rx = /[a-z']+/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(low)) !== null) {
    const list = TIC_BY_FIRST.get(m[0]);
    if (!list || isWordChar(low[m.index - 1])) continue;
    for (const t of list) {
      if (found.has(t.index) || !low.startsWith(t.phrase, m.index)) continue;
      const end = m.index + t.phrase.length;
      if (t.final ? CLAUSE_END.test(low.slice(end, end + 12)) : !isWordChar(low[end]) || !isWordChar(low[end - 1])) found.add(t.index);
    }
  }
  return [...found].sort((a, b) => a - b);
}

export const ADDRESS = ['dude', 'bro', 'buddy', 'babe', 'baby', 'my friend', 'man', 'mate', 'boss', 'sir', 'brother', 'bhai', 'yaar', 'chief', 'champ', 'my guy', 'darling', 'love'] as const;
const ADDRESS_GATE = new RegExp('\\b(' + ADDRESS.map(esc).join('|') + ')\\b', 'g');
const ADDRESS_INDEX = new Map<string, number>(ADDRESS.map((a, i) => [a, i]));
const VOCATIVE_BEFORE = /(?:^|[,.!?]\s*|\b(?:hey|yo|ok|okay|thanks|no|come on)\s+)$/;
/** Indices of ADDRESS terms used vocatively: at a clause start or end, after hey/yo/ok/thanks, or before punctuation. */
export function addressIn(low: string): number[] {
  const found = new Set<number>();
  ADDRESS_GATE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ADDRESS_GATE.exec(low)) !== null) {
    const i = ADDRESS_INDEX.get(m[1]!)!;
    if (found.has(i)) continue;
    const end = m.index + m[0].length;
    if (VOCATIVE_BEFORE.test(low.slice(Math.max(0, m.index - 12), m.index)) || /^\s*[,.!?]/.test(low.slice(end, end + 8)) || end === low.length) found.add(i);
  }
  return [...found].sort((a, b) => a - b);
}

/* ----------------------------------------------------------- featurize --- */

export interface FeaturizeInput {
  /** Typed text (Claude history display) or transcript text. */
  text: string;
  /** True when the text is what the user typed (history.jsonl), false for transcript text that may expand pastes. */
  typed: boolean;
  hasPaste?: boolean;
  hasImage?: boolean;
}

export function featurize(input: FeaturizeInput): PromptFeatures {
  const raw = input.text;
  let t = cleanForTone(raw);
  const all = words(t.toLowerCase());
  // Paste guard: transcripts expand pastes inline, so a giant prompt is mostly pasted material.
  // Tone then only looks at the head and tail, where the typed framing lives.
  const pasteSuspect = all.length > 1500 || (all.length > 600 && !input.typed);
  if (pasteSuspect) {
    const toks = t.split(/\s+/).filter(Boolean);
    t = toks.slice(0, 150).concat('…', toks.slice(-150)).join(' ');
  }
  const low = t.toLowerCase();
  const tone = pasteSuspect ? words(low) : all;
  let letters = 0, upper = 0;
  for (let k = 0; k < t.length; k++) {
    const c = t.charCodeAt(k);
    if (c >= 65 && c <= 90) { letters++; upper++; } else if (c >= 97 && c <= 122) letters++;
    else if (c > 127 && /\p{L}/u.test(t[k]!)) { letters++; if (t[k] !== t[k]!.toLowerCase()) upper++; }
  }
  let caps = 0;
  for (const m of t.match(CAPS) ?? []) if (!CAPS_OK.has(m)) caps++;
  const swears: string[] = [];
  let insults = 0, slur = false;
  for (const w of tone) {
    if (isSwearWord(w)) swears.push(w);
    if (isInsult(w)) insults++;
    if (!slur && isSlur(w)) slur = true;
  }
  const first = all[0] ?? '';
  const rawLow = raw.toLowerCase();
  const trimmed = raw.trim();
  let fl = 0;
  if (/\[Pasted text #/.test(raw) || input.hasPaste) fl |= FLAG.paste;
  if (input.hasImage || raw.includes('[Image #')) fl |= FLAG.image;
  if (raw.includes('```')) fl |= FLAG.code;
  URL_RX.lastIndex = 0;
  if (URL_RX.test(raw)) fl |= FLAG.url;
  URL_RX.lastIndex = 0;
  if (pasteSuspect) fl |= FLAG.pasteSuspect;
  if (slur) fl |= FLAG.slur;
  if (POLITE.test(low)) fl |= FLAG.polite;
  if (THANKS.test(low)) fl |= FLAG.thanks;
  if (SORRY.test(low)) fl |= FLAG.sorry;
  if (/[!?]{3,}/.test(raw)) fl |= FLAG.multiPunct;
  if (trimmed.endsWith('?') || (QWORDS.has(first) && all.length < 40)) fl |= FLAG.question;
  if (DELEGATE.test(low)) fl |= FLAG.delegate;
  if (/\blet'?s\b/.test(rawLow)) fl |= FLAG.lets;
  if (/\b(please|pls|plz)\b/.test(rawLow)) fl |= FLAG.please;
  if (input.typed) fl |= FLAG.history;
  let excl = 0;
  for (let k = raw.indexOf('!'); k >= 0; k = raw.indexOf('!', k + 1)) excl++;
  let lines = 1;
  for (let k = raw.indexOf('\n'); k >= 0; k = raw.indexOf('\n', k + 1)) lines++;
  const f: PromptFeatures = {
    ch: raw.length, w: all.length, ln: lines, fl,
    sw: swears.length, ins: insults,
    fr: count(FRUSTRATION, low), cw: caps, cr: letters >= 12 ? Math.round((upper / letters) * 1000) / 1000 : 0, ex: excl,
    we: count(WE, low), i: count(I_, low), fi: count(FILLER, low), pf: count(PERFECTION, low), hi: count(HINGLISH, low),
    fw: first.slice(0, 24),
  };
  if (swears.length) f.sws = swears.slice(0, 6);
  if (raw.length <= 80) {
    const sl = raw.replace(PLACEHOLDER, '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);
    if (sl) f.sl = sl;
  }
  const tc = ticsIn(rawLow);
  if (tc.length) f.tc = tc;
  const ad = addressIn(rawLow);
  if (ad.length) f.ad = ad;
  return f;
}

/* -------------------------------------------------------------- quotes --- */

/** Topics a quote must never touch (health, relationships, money stress, secrets, ...). */
export const SENSITIVE = /\b(die|dying|suicid\w*|kill (?:my|me)\w*|depress\w*|demons?|deserve|anxiety|therap\w*|panic|lonely|worthless|hate myself|cry(?:ing)?|breakup|girlfriend|boyfriend|wife|husband|sex\w*|porn|nude|drunk|password|token|secret|api[_ -]?key|ssn|salary|loan|debt|visa|lawyer|doctor|hospital|meds?)\b/i;
export const SECRETISH = /(sk-[A-Za-z0-9]|tvly-|AKIA|ghp_|xox[bp]-|@[\w.-]+\.\w{2,}|[A-Za-z0-9_-]{32,}|\/Users\/|\/home\/|~\/|https?:\/\/|\[REDACTED|<redacted)/;

/**
 * An on-screen quote: one line, short, no secrets/paths/emails/keys, no
 * sensitive topics, swears masked. Null when the text must not be quoted.
 */
export function safeQuote(text: string, maxLength = 90): string | null {
  let t = text.replace(PLACEHOLDER, '').replace(/\s+/g, ' ').trim();
  if (!t || SENSITIVE.test(t) || SECRETISH.test(t)) return null;
  // Masking keeps length, so only the part that can be shown needs it.
  t = t.slice(0, maxLength + 40).replace(/[A-Za-z']+/g, w => { const l = w.toLowerCase(); return isSwearWord(l) || isSlur(l) ? mask(w) : w; }) + t.slice(maxLength + 40);
  if (t.length <= maxLength) return t;
  const cut = t.slice(0, maxLength - 1);
  const space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : cut) + '…';
}

/** Masks swears in a short typed line for display (no other filtering). */
export function maskLine(text: string): string {
  return text.replace(/[A-Za-z']+/g, w => { const l = w.toLowerCase(); return isSwearWord(l) || isSlur(l) ? mask(w) : w; });
}

/* ------------------------------------------------------- side tables --- */

export const TOPIC_STOP = new Set(("the a an and or of to in on for is it that this i you we be are was with as at by from so if but not do can me my your our just what how all also now like then there they them these those one some any more much very really thing things something everything get got make made want need see know think going go let lets let's okay ok yes no up out into about will would should could have has had been being he she his her him its it's i'm don't can't isn't doesn't which who when where why here same other only even still well right good way time new use using done try give take put come look").split(' '));

/** Words of a prompt for the vocabulary counter (typo fingerprint): ≥3 letters. */
export function vocabularyWords(text: string): string[] {
  return words(cleanForTone(text).toLowerCase()).filter(w => w.length >= 3 && w.length <= 24);
}

/** Distinct topic words of a prompt (day vs night topics). */
export function topicWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of words(cleanForTone(text).toLowerCase())) if (w.length >= 3 && w.length <= 24 && !TOPIC_STOP.has(w) && !isSwearWord(w)) out.add(w);
  return out;
}

/**
 * Typo fingerprint: words the user types rarely (≤12 times) that are not in
 * the dictionary and sit one edit away from a word they type far more often
 * (≥ max(10, 8×)). Uses deletion indexes instead of generating every edit,
 * so it stays in the low milliseconds on a 20k-word vocabulary.
 */
import {isSwearWord} from './story-lexicon.js';

const SLANG_OK = new Set(('intro sorta kinda gonna wanna gotta lemme dunno okay repo repos config configs env async auth admin todo todos dev devs '
  + 'infra prod app apps ui ux url urls api apis json yaml npm pnpm cli gui ide sdk llm llms gpt mcp oauth uuid dms dm vibe vibes '
  + 'tldr btw imo tbh lol lmao nah yeah yep yup hmm ohh ok pls plz thx ya yo').split(' '));
/** Irregular forms that word lists often miss (and that look one edit away from a common word). */
const IRREGULAR = new Set(('became began begun bent bound bred broke broken brought built burnt caught chose chosen clung dealt drew drawn drove driven '
  + 'ate eaten fed felt fled flung forbade forgot forgotten forgave froze frozen gave given went gone grew grown hung heard hid hidden held hurt '
  + 'kept knelt knew known laid led leapt left lent lay lain lit lost made meant met paid ran rang rung rode ridden rose risen sang sung sank sunk '
  + 'sat said saw seen sought sold sent set shook shaken shone shot shown shrank shut slept slid slung spoke spoken spent spun split spread sprang '
  + 'stood stole stolen stuck stung struck strove swore sworn swept swam swum swung taught tore torn told thought threw thrown took taken understood '
  + 'woke woken wore worn wove won wound wrote written children men women mice feet teeth geese data indices matrices analyses').split(' '));
const SUFFIXES: [string, string[]][] = [['s', ['']], ['es', ['']], ['ed', ['', 'e']], ['d', ['']], ['ing', ['', 'e']], ['ly', ['']], ['er', ['', 'e']], ['ers', ['', 'e']], ['ies', ['y']], ['ied', ['y']]];

export interface WordSet {has(word: string): boolean}

function known(w: string, dict: WordSet): boolean {
  w = w.replace(/'/g, '');
  if (IRREGULAR.has(w) || dict.has(w)) return true;
  for (const [suf, adds] of SUFFIXES) {
    if (!w.endsWith(suf)) continue;
    const stem = w.slice(0, -suf.length);
    for (const a of adds) {
      if (dict.has(stem + a)) return true;
      // doubled consonant: "stopped" -> "stop"
      if (w.length > suf.length + 2 && stem[stem.length - 1] === stem[stem.length - 2] && dict.has(stem.slice(0, -1))) return true;
    }
  }
  return false;
}

export interface TypoResult {
  pairs: number;
  total: number;
  top: {typo: string; word: string; count: number}[];
  kind: {name: string; count: number} | null;
}

export function typoPairs(vocab: ReadonlyMap<string, number>, dict: WordSet): TypoResult | null {
  // Frequent dictionary words are the only possible corrections.
  const frequent = new Map<string, number>();
  for (const [w, n] of vocab) if (n >= 10 && dict.has(w)) frequent.set(w, n);
  const deletes = new Map<string, string[]>(); // deletion of one char -> words
  const posDeletes = new Map<string, string[]>(); // `${i}|${deletion}` -> words (substitutions)
  const push = (m: Map<string, string[]>, k: string, v: string) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };
  for (const v of frequent.keys()) for (let i = 0; i < v.length; i++) { const d = v.slice(0, i) + v.slice(i + 1); push(deletes, d, v); push(posDeletes, `${i}|${d}`, v); }

  const pairs: {count: number; typo: string; word: string}[] = [];
  for (const [w, c] of vocab) {
    if (w.length < 4 || c > 12 || SLANG_OK.has(w) || known(w, dict)) continue;
    const need = Math.max(10, 8 * c);
    const cands = new Set<string>();
    for (let i = 0; i < w.length; i++) {
      const d = w.slice(0, i) + w.slice(i + 1);
      if (frequent.has(d)) cands.add(d); // w has an extra letter
      for (const v of posDeletes.get(`${i}|${d}`) ?? []) if (v !== w) cands.add(v); // one substituted letter
      if (i + 1 < w.length) { const t = w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2); if (t !== w && frequent.has(t)) cands.add(t); }
    }
    for (const v of deletes.get(w) ?? []) cands.add(v); // w dropped a letter
    let best: string | null = null, bestN = -1;
    for (const v of cands) { const n = frequent.get(v)!; if (n >= need && (n > bestN || (n === bestN && v > best!))) { best = v; bestN = n; } }
    if (best) pairs.push({count: c, typo: w, word: best});
  }
  pairs.sort((a, b) => b.count - a.count || (a.typo < b.typo ? -1 : 1));
  if (pairs.length < 10) return null;
  const total = pairs.reduce((n, p) => n + p.count, 0);
  const kinds = new Map<string, number>();
  for (const p of pairs) {
    if (p.typo.length < 5 || p.typo[0] !== p.word[0]) continue;
    const k = p.typo.length < p.word.length ? 'dropped a letter' : p.typo.length > p.word.length ? 'doubled/extra letter'
      : [...p.typo].sort().join('') === [...p.word].sort().join('') ? 'swapped two letters' : 'hit the wrong key';
    kinds.set(k, (kinds.get(k) ?? 0) + p.count);
  }
  const clean = pairs.filter(p => !isSwearWord(p.typo));
  const sorted = (s: string) => [...s].sort().join('');
  const sig = clean.filter(p => p.typo.length >= 6 && (sorted(p.typo) === sorted(p.word) || p.typo.length < p.word.length));
  const sig5 = clean.filter(p => p.typo.length >= 5 && p.word.length >= 5 && p.typo[0] === p.word[0]);
  const top = [...sig.slice(0, 1), ...sig5.filter(p => p !== sig[0])].slice(0, 4);
  if (top.length < 4) return null;
  let kind: TypoResult['kind'] = null;
  for (const [name, count] of kinds) if (!kind || count > kind.count) kind = {name, count};
  return {pairs: pairs.length, total, top, kind};
}

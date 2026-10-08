/**
 * English dictionary for the typo fingerprint: the bundled list (see
 * scripts/make-wordlist.mjs) plus the system word list when one exists.
 * Loading the system list costs ~40 ms, so lookups are memoized and the memo
 * is kept in the derived cache: a warm run only loads the list when the
 * vocabulary has a word it has never looked up.
 */
import fs from 'node:fs';
import {STORY_WORDLIST} from './story-wordlist.js';

const SYSTEM_LISTS = ['/usr/share/dict/words', '/usr/share/dict/web2', '/usr/share/dict/american-english', '/usr/share/dict/british-english'];

export class DictionaryLookup {
  private words: Set<string> | null = null;
  loaded = false;
  constructor(readonly memo: Map<string, boolean> = new Map()) {}

  has(word: string): boolean {
    const hit = this.memo.get(word);
    if (hit !== undefined) return hit;
    const value = this.load().has(word);
    this.memo.set(word, value);
    return value;
  }

  /** Loads the word lists now (e.g. while worker threads are still reading). */
  preload(): void { this.load(); }

  private load(): Set<string> {
    if (this.words) return this.words;
    this.loaded = true;
    const words = new Set(STORY_WORDLIST.split(' '));
    for (const file of SYSTEM_LISTS) {
      try {
        for (const w of fs.readFileSync(file, 'utf8').toLowerCase().split('\n')) if (w) words.add(w);
        break;
      } catch { /* not on this machine */ }
    }
    this.words = words;
    return words;
  }
}

/**
 * Per-file cache of extracted facts, keyed by (path, size, mtime). A warm run
 * only re-reads files that changed. The cache lives in the audit derived-cache
 * directory (mode 0700/0600) and never holds sources the user has forgotten or
 * ignored: they are dropped every time it is written.
 */
import fs from 'node:fs';
import path from 'node:path';
import {serialize, deserialize} from 'node:v8';
import {FACTS_VERSION, type HistoryData, type HistoryEntry, type SourceFacts} from './extract.js';

const FILE = `facts-v${FACTS_VERSION}.bin`;

export class FactsCache {
  private entries = new Map<string, SourceFacts>();
  private historyEntry: {file: string; size: number; mtimeMs: number; tz: string; data: HistoryData} | null = null;
  /** Dictionary lookups of the typo fingerprint (word -> in dictionary). */
  dictionary = new Map<string, boolean>();
  private dirty = false;

  constructor(private readonly dir: string | null) {}

  load(): void {
    if (!this.dir) return;
    try {
      const value = deserialize(fs.readFileSync(path.join(this.dir, FILE))) as {version: number; entries: SourceFacts[]; history?: FactsCache['historyEntry']; dictionary?: Map<string, boolean>};
      if (value?.version !== FACTS_VERSION || !Array.isArray(value.entries)) return;
      for (const facts of value.entries) this.entries.set(facts.file, facts);
      this.historyEntry = value.history ?? null;
      if (value.dictionary instanceof Map) this.dictionary = value.dictionary;
      this.dictionarySize = this.dictionary.size;
    } catch {
      // Missing or unreadable cache: everything is simply read again.
    }
  }

  private dictionarySize = 0;

  /** Cached facts when the file still has the same size and mtime (and story time zone). */
  get(file: string, size: number, mtimeMs: number, tz?: string): SourceFacts | null {
    const facts = this.entries.get(file);
    return facts && facts.size === size && facts.mtimeMs === mtimeMs && (!tz || !facts.tz || facts.tz === tz) ? facts : null;
  }

  /** Previous facts of a file regardless of freshness (for append-only resume). */
  previous(file: string): SourceFacts | null {
    return this.entries.get(file) ?? null;
  }

  set(facts: SourceFacts): void {
    this.entries.set(facts.file, facts);
    this.dirty = true;
  }

  /**
   * Parsed ~/.claude/history.jsonl (text stripped), re-read only when it
   * changes. `read` gets the previous data and its byte length so an
   * append-only log can be extended instead of re-read.
   */
  history(file: string, tz: string, read: (file: string, previous: {data: HistoryData; size: number} | null) => HistoryData): HistoryData {
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { return {entries: [], counters: new Map()}; }
    const h = this.historyEntry;
    if (h && h.file === file && h.tz === tz && h.size === stat.size && h.mtimeMs === stat.mtimeMs) return h.data;
    const data = read(file, h && h.file === file && h.tz === tz && h.size > 0 && h.size < stat.size ? {data: h.data, size: h.data.bytes ?? h.size} : null);
    for (const e of data.entries) e.text = '';
    this.historyEntry = {file, size: stat.size, mtimeMs: stat.mtimeMs, tz, data};
    this.dirty = true;
    return data;
  }

  /** Writes the cache, keeping only files that still exist and are allowed. */
  save(keep: (facts: SourceFacts) => boolean, keepHistory: (entry: HistoryEntry) => boolean = () => true): void {
    if (!this.dir) return;
    let removed = false;
    for (const [file, facts] of this.entries) if (!keep(facts)) { this.entries.delete(file); removed = true; }
    if (this.historyEntry) {
      const {data} = this.historyEntry;
      const kept = data.entries.filter(keepHistory);
      if (kept.length !== data.entries.length) {
        const counters = new Map([...data.counters].filter(([session, c]) => keepHistory({sessionId: session || null, at: null, project: c.project, kind: 'human', text: ''})));
        this.historyEntry = {...this.historyEntry, size: -1, data: {entries: kept, counters}};
        removed = true;
      }
    }
    if (!this.dirty && !removed && this.dictionary.size === this.dictionarySize) return;
    try {
      fs.mkdirSync(this.dir, {recursive: true, mode: 0o700});
      const target = path.join(this.dir, FILE), temp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(temp, serialize({version: FACTS_VERSION, entries: [...this.entries.values()], history: this.historyEntry, dictionary: this.dictionary}), {mode: 0o600});
      fs.renameSync(temp, target);
      for (const old of fs.readdirSync(this.dir)) if (/^facts-v\d+\.bin$/.test(old) && old !== FILE) fs.rmSync(path.join(this.dir, old), {force: true});
      this.dirty = false;
      this.dictionarySize = this.dictionary.size;
    } catch {
      // The cache is an optimisation; failing to write it never fails a report.
    }
  }
}

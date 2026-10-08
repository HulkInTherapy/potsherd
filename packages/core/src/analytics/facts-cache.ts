/**
 * Per-file cache of extracted facts, keyed by (path, size, mtime). A warm run
 * only re-reads files that changed. The cache lives in the audit derived-cache
 * directory (mode 0700/0600) and never holds sources the user has forgotten or
 * ignored: they are dropped every time it is written.
 */
import fs from 'node:fs';
import path from 'node:path';
import {serialize, deserialize} from 'node:v8';
import {FACTS_VERSION, type HistoryEntry, type SourceFacts} from './extract.js';

const FILE = `facts-v${FACTS_VERSION}.bin`;

export class FactsCache {
  private entries = new Map<string, SourceFacts>();
  private historyEntry: {file: string; size: number; mtimeMs: number; entries: HistoryEntry[]} | null = null;
  private dirty = false;

  constructor(private readonly dir: string | null) {}

  load(): void {
    if (!this.dir) return;
    try {
      const value = deserialize(fs.readFileSync(path.join(this.dir, FILE))) as {version: number; entries: SourceFacts[]; history?: FactsCache['historyEntry']};
      if (value?.version !== FACTS_VERSION || !Array.isArray(value.entries)) return;
      for (const facts of value.entries) this.entries.set(facts.file, facts);
      this.historyEntry = value.history ?? null;
    } catch {
      // Missing or unreadable cache: everything is simply read again.
    }
  }

  /** Cached facts when the file still has the same size and mtime. */
  get(file: string, size: number, mtimeMs: number): SourceFacts | null {
    const facts = this.entries.get(file);
    return facts && facts.size === size && facts.mtimeMs === mtimeMs ? facts : null;
  }

  set(facts: SourceFacts): void {
    this.entries.set(facts.file, facts);
    this.dirty = true;
  }

  /** Parsed ~/.claude/history.jsonl, re-read only when it changes. */
  history(file: string, read: (file: string) => HistoryEntry[]): HistoryEntry[] {
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { return []; }
    const h = this.historyEntry;
    if (h && h.file === file && h.size === stat.size && h.mtimeMs === stat.mtimeMs) return h.entries;
    const entries = read(file);
    this.historyEntry = {file, size: stat.size, mtimeMs: stat.mtimeMs, entries};
    this.dirty = true;
    return entries;
  }

  /** Writes the cache, keeping only files that still exist and are allowed. */
  save(keep: (facts: SourceFacts) => boolean, keepHistory: (entry: HistoryEntry) => boolean = () => true): void {
    if (!this.dir) return;
    let removed = false;
    for (const [file, facts] of this.entries) if (!keep(facts)) { this.entries.delete(file); removed = true; }
    if (this.historyEntry) {
      const kept = this.historyEntry.entries.filter(keepHistory);
      if (kept.length !== this.historyEntry.entries.length) { this.historyEntry = {...this.historyEntry, size: -1, entries: kept}; removed = true; }
    }
    if (!this.dirty && !removed) return;
    try {
      fs.mkdirSync(this.dir, {recursive: true, mode: 0o700});
      const target = path.join(this.dir, FILE), temp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(temp, serialize({version: FACTS_VERSION, entries: [...this.entries.values()], history: this.historyEntry}), {mode: 0o600});
      fs.renameSync(temp, target);
      for (const old of fs.readdirSync(this.dir)) if (/^facts-v\d+\.bin$/.test(old) && old !== FILE) fs.rmSync(path.join(this.dir, old), {force: true});
      this.dirty = false;
    } catch {
      // The cache is an optimisation; failing to write it never fails a report.
    }
  }
}

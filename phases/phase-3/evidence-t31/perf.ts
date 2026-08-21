/**
 * T3.5 — p50/p95 warm, per retrieval mode. `03 §12`: p50 < 150 ms warm.
 *
 * Warm means the process has already loaded sqlite, the vec extension and the
 * embedding model: the number `03 §12` asks for is the one a second `find` in
 * the same session costs, not the one that includes a 34 MB cold model load.
 * Twenty runs per mode over the full 25-query set, so each reported percentile
 * is over 500 searches and not over one lucky query.
 */
import fs from 'node:fs';
import path from 'node:path';
import { LISTS, db as store, recall, type ListName } from '../../../packages/core/src/index.js';

const root = process.env['R']!;
const queries = process.env['QFILE']
  ? fs
      .readFileSync(process.env['QFILE'], 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  : fs
      .readFileSync(path.join(process.cwd(), 'evals', 'queries.jsonl'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('//'))
      .map((l) => (JSON.parse(l) as { query: string }).query);

const MODES: [string, { lists: readonly ListName[]; vectors: boolean | 'auto' }][] = [
  ['bm25 only', { lists: LISTS, vectors: false }],
  ['vectors only', { lists: ['vec_exchanges', 'vec_cards'], vectors: true }],
  ['hybrid (auto)', { lists: LISTS, vectors: 'auto' }],
  ['hybrid (always)', { lists: LISTS, vectors: true }],
];

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

const db = store.open({ root });
const RUNS = 20;
console.log(`${RUNS} warm runs x ${queries.length} queries per mode\n`);
console.log('  mode              p50      p95      max      n');
for (const [label, mode] of MODES) {
  // Warm-up pass, not measured: it pays for the model load and the page cache.
  for (const q of queries) {
    await recall(db, q, {}, { limit: 10, root, lists: mode.lists, vectors: mode.vectors });
  }
  const ms: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    for (const q of queries) {
      const t0 = performance.now();
      await recall(db, q, {}, { limit: 10, root, lists: mode.lists, vectors: mode.vectors });
      ms.push(performance.now() - t0);
    }
  }
  console.log(
    `  ${label.padEnd(16)}  ${pct(ms, 50).toFixed(1).padStart(6)}ms ${pct(ms, 95).toFixed(1).padStart(6)}ms ${Math.max(...ms).toFixed(1).padStart(6)}ms  ${ms.length}`,
  );
}
db.close();

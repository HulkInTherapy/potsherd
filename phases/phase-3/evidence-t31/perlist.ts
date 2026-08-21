import fs from 'node:fs';
import { LISTS, db as store, recall } from '../../../packages/core/src/index.js';

const root = process.env['R']!;
const queries = fs
  .readFileSync(process.env['QFILE']!, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean);
const db = store.open({ root });
const total = new Map<string, number[]>();
for (const q of queries) {
  await recall(db, q, {}, { limit: 10, root, lists: LISTS, vectors: true });
}
for (let i = 0; i < 5; i++) {
  for (const q of queries) {
    const r = await recall(db, q, {}, { limit: 10, root, lists: LISTS, vectors: true });
    for (const l of r.lists) {
      const arr = total.get(l.list) ?? [];
      arr.push(l.ms);
      total.set(l.list, arr);
    }
  }
}
const med = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
for (const [list, xs] of [...total].sort((a, b) => med(b[1]) - med(a[1]))) {
  console.log(`  ${list.padEnd(20)} median ${med(xs).toFixed(1).padStart(6)}ms  max ${Math.max(...xs).toFixed(1).padStart(6)}ms`);
}
db.close();

import { db as store, recall } from '../../../packages/core/src/index.js';
const root = process.env.R!;
const db = store.open({ root });
const qs: [string, string][] = [
  ['which import made the icon set so big', '4ae3102b'],
  ['the thing quietly eating most of the cloud bill', 'd4b1f0a7'],
  ['where the pennies went when we changed the file format', '2f7c8b31'],
  ['the thing on the new page a screen reader could not escape', '9c1e5d80'],
  ['how many a second before the latency went off a cliff', '6b3a9e24'],
];
for (const [q, prefix] of qs) {
  const r = await recall(db, q, {}, { limit: 60, root, lists: ['vec_exchanges', 'vec_cards'], vectors: true });
  const idx = r.sessions.findIndex((s) => s.id.startsWith(prefix));
  const scIdx = r.sessions.findIndex((s) => s.id.startsWith(prefix) && (s.isSidechain || s.hits.some((h) => h.isSidechain)));
  console.log(`\nQ: ${q}`);
  console.log(`  any block for ${prefix}: #${idx + 1}  sidechain-satisfying: #${scIdx + 1}  of ${r.sessions.length} blocks`);
  for (const s of r.sessions.filter((s) => s.id.startsWith(prefix))) {
    console.log(`    ${s.id}  sc=${s.isSidechain} score=${s.score.toFixed(5)} hits=${s.hits.map((h) => `${h.kind}/sc=${h.isSidechain}/${h.from.map((f) => f.list + '#' + f.rank).join(',')}`).join(' | ')}`);
  }
  console.log(`  total sidechain-flagged hits anywhere: ${r.hits.filter((h) => h.isSidechain).length}`);
}
db.close();

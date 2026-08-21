import { db as store, recall } from '../../../packages/core/src/index.js';
const root = process.env.R!;
const db = store.open({ root });
const qs = [
  'which import made the icon set so big',
  'the thing quietly eating most of the cloud bill',
  'where the pennies went when we changed the finance report',
  'the thing on the new page a screen reader could not read',
  'how many a second before the latency went off',
];
for (const q of qs) {
  const r = await recall(db, q, {}, { limit: 20, root, lists: ['vec_exchanges', 'vec_cards'], vectors: true });
  console.log('\nQ:', q, '| vectors used:', r.vectors.used, r.vectors.reason ?? '');
  console.log('  lists:', r.lists.map((l) => `${l.list}:${l.candidates}`).join(' '));
  console.log('  sidechain hits total:', r.hits.filter((h) => h.isSidechain).length, '/', r.hits.length);
  r.sessions
    .slice(0, 5)
    .forEach((s, i) =>
      console.log(
        `   #${i + 1} ${s.id.slice(0, 44)} sc=${s.isSidechain} hits=${s.hits.length} scHits=${s.hits.filter((h) => h.isSidechain).length}`,
      ),
    );
}
db.close();

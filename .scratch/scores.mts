import { db as store, loadSessionTranscript, readPriorCard, verifyCard, cachedEmbedder, paths } from '../packages/core/src/index.js';

const root = process.argv[2]!;
const dbh = store.open({ root });
const ids = (dbh.prepare('SELECT session_id FROM cards').all() as { session_id: string }[]).map((r) => r.session_id);

const all: number[] = [];
const control: number[] = [];
for (const id of ids) {
  const t = loadSessionTranscript(dbh, id);
  const card = readPriorCard(dbh, id);
  if (!t || !card) continue;
  const e = cachedEmbedder({ embeddings: { cacheDir: paths.modelsDir(root) } });
  for (const u of t.units) if (u.embedding) e.prime(u.text, u.embedding);
  const r = await verifyCard(card, t.units, e.embed);
  all.push(...r.scores);

  // Control: the same claims, cited against a DIFFERENT session's exchanges.
  const other = ids.find((x) => x !== id);
  if (other) {
    const ot = loadSessionTranscript(dbh, other);
    if (ot && ot.units.length) {
      const shuffled = {
        ...card,
        decisions: card.decisions.slice(0, 3).map((d) => ({ ...d, evidence_seq: [ot.units[0]!.seq] })),
        open_threads: [],
      };
      const e2 = cachedEmbedder({ embeddings: { cacheDir: paths.modelsDir(root) } });
      const cr = await verifyCard(shuffled, ot.units, e2.embed);
      control.push(...cr.scores);
    }
  }
}
const pct = (xs: number[], p: number) => { const s=[...xs].sort((a,b)=>a-b); return s[Math.min(s.length-1, Math.floor(p*s.length))] ?? 0; };
const fmt = (xs: number[]) => xs.length ? `n=${xs.length} min ${pct(xs,0).toFixed(2)} p10 ${pct(xs,0.1).toFixed(2)} median ${pct(xs,0.5).toFixed(2)} max ${pct(xs,0.999).toFixed(2)}` : 'none';
console.log('claims cited correctly     ', fmt(all));
console.log('same claims, wrong exchange', fmt(control));
console.log('kept under 0.5 threshold   ', all.filter((s)=>s>=0.5).length, '/', all.length);
console.log('control that would be kept ', control.filter((s)=>s>=0.5).length, '/', control.length);
dbh.close();

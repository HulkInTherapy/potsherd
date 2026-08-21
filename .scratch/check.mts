import { db as store, loadSessionTranscript, unresolvedEvidence } from '../packages/core/src/index.js';

const root = process.argv[2]!;
const dbh = store.open({ root });
const rows = dbh
  .prepare('SELECT session_id, title, decisions, open_threads, verified, cost_usd, source FROM cards')
  .all() as { session_id: string; title: string; decisions: string; open_threads: string; verified: string; cost_usd: number; source: string }[];

let claims = 0, seqs = 0, bad = 0, kept = 0, dropped = 0, usd = 0;
const badRows: string[] = [];
const dropped0: string[] = [];
for (const r of rows) {
  const t = loadSessionTranscript(dbh, r.session_id);
  if (!t) { console.log('NO TRANSCRIPT', r.session_id); continue; }
  const card = { decisions: JSON.parse(r.decisions), open_threads: JSON.parse(r.open_threads) };
  claims += card.decisions.length + card.open_threads.length;
  for (const c of [...card.decisions, ...card.open_threads]) seqs += c.evidence_seq.length;
  const u = unresolvedEvidence(card, t.units);
  if (u.length) { bad += u.length; badRows.push(`${r.session_id.slice(0,8)} ${JSON.stringify(u)}`); }
  const v = JSON.parse(r.verified);
  kept += v.kept; dropped += v.dropped; usd += r.cost_usd;
  if (v.dropped === 0) dropped0.push(r.session_id.slice(0,8));
}
console.log(JSON.stringify({
  cards: rows.length, claims, evidenceSeqs: seqs, unresolved: bad,
  verifiedKept: kept, verifiedDropped: dropped,
  cardsWithZeroDropped: dropped0.length,
  usd: Number(usd.toFixed(3)),
}, null, 1));
if (badRows.length) console.log('BAD:', badRows.join('\n'));
dbh.close();

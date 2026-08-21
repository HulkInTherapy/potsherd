// What the readers are actually handed, with no model in the loop.
//
// `ask` is only as good as its shortlist (`05` honesty contract says so out
// loud), so when a run comes back "0 answered" the first question is whether
// the readers were given the right text — not whether they read it badly.
// This prints the excerpt every reader would receive.
//
//   node phases/phase-4/evidence-T4.1/shortlist-probe.mjs "<question>" [k]
import { db as store, recall } from '../../../packages/core/dist/index.js';
import { excerptUnits, excerptText } from '../../../packages/core/dist/ask.js';
import {
  loadGhostTranscript,
  loadSessionTranscript,
} from '../../../packages/core/dist/cards/transcript.js';
import { idTag, projectName } from '../../../packages/core/dist/recall.js';

const root = process.env.POTSHERD_ASK_DIR ?? '/Users/zebra/randomness/potsherd-T4.1-corpus';
const question = process.argv[2];
const k = Number(process.argv[3] ?? 6);
const db = store.open({ root });

const found = await recall(db, question, {}, { limit: 50, candidates: Math.max(k * 10, 60), root, vectors: true });
console.log(`recall: ${found.sessions.length} blocks, ${found.hits.length} hits, ${found.ms}ms, vectors=${found.vectors.used}`);

// The same walk `shortlist()` in ask.ts does: recall's block order kept, each
// block expanded into the distinct sessions its hits came from.
const order = [];
const seqs = new Map();
const scores = new Map();
for (const s of found.sessions) {
  const inBlock = [];
  for (const h of s.hits) {
    if (!seqs.has(h.sessionId)) { seqs.set(h.sessionId, []); inBlock.push(h.sessionId); }
    const list = seqs.get(h.sessionId);
    if (h.seq !== undefined && h.seq !== null && !list.includes(h.seq)) list.push(h.seq);
    scores.set(h.sessionId, Math.max(scores.get(h.sessionId) ?? 0, h.score));
  }
  if (!seqs.has(s.id)) { seqs.set(s.id, []); scores.set(s.id, s.score); inBlock.push(s.id); }
  inBlock.sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));
  order.push(...inBlock);
}
const ranked = order.slice(0, k).map((id) => [id, { seqs: seqs.get(id), score: scores.get(id) }]);
for (const [sessionId, e] of ranked) {
  const t = loadSessionTranscript(db, sessionId) ?? loadGhostTranscript(db, sessionId);
  if (!t) { console.log(`\n### ${sessionId}  NOT LOADABLE`); continue; }
  const units = excerptUnits(t, e.seqs);
  const text = excerptText(units);
  console.log(`\n${'='.repeat(78)}`);
  console.log(`### ${projectName(t.project)}/${idTag(sessionId)}  ${t.kind}  score=${e.score.toFixed(4)}`);
  console.log(`    hit seqs: ${e.seqs.join(', ') || '(none — title/card match)'}`);
  console.log(`    excerpt seqs: ${units.map((u) => u.seq).join(', ')}   ${text.length} chars`);
  console.log(text.slice(0, 1800));
}
db.close();

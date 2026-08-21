// One reader, one session, with the model's RAW reply printed.
//
// `ask` deliberately swallows a reader that answers badly — `found: false` and
// the run continues — which is right for a user and useless for debugging. This
// prints what the backend actually said, so "0 answered" can be diagnosed as
// "read it and found nothing" or as "did not produce the shape".
//
//   node phases/phase-4/evidence-T4.1/reader-probe.mjs "<question>" [rank]
import { db as store, recall, Llm } from '../../../packages/core/dist/index.js';
import { excerptUnits, excerptText, READER_SYSTEM } from '../../../packages/core/dist/ask.js';
import {
  loadGhostTranscript,
  loadSessionTranscript,
} from '../../../packages/core/dist/cards/transcript.js';
import { idTag, projectName } from '../../../packages/core/dist/recall.js';

const root = process.env.POTSHERD_ASK_DIR ?? '/Users/zebra/randomness/potsherd-T4.1-corpus';
const question = process.argv[2];
const rank = Number(process.argv[3] ?? 0);
const db = store.open({ root });

const found = await recall(db, question, {}, { limit: 50, candidates: 60, root, vectors: true });
const order = [];
const seqs = new Map();
for (const s of found.sessions) {
  for (const h of s.hits) {
    if (!seqs.has(h.sessionId)) { seqs.set(h.sessionId, []); order.push(h.sessionId); }
    const l = seqs.get(h.sessionId);
    if (h.seq !== undefined && h.seq !== null && !l.includes(h.seq)) l.push(h.seq);
  }
  if (!seqs.has(s.id)) { seqs.set(s.id, []); order.push(s.id); }
}
const sessionId = order[rank];
const t = loadSessionTranscript(db, sessionId) ?? loadGhostTranscript(db, sessionId);
const units = excerptUnits(t, seqs.get(sessionId) ?? []);
const excerpts = excerptText(units);
const isGhost = t.kind === 'ghost';

const prompt =
  `Question: ${question}\n\n` +
  `Session ${idTag(sessionId)} (${projectName(t.project)}, ${t.harness}` +
  `${isGhost ? ', GHOST — prompts only' : ''}).\n` +
  `Citable seq numbers: ${units.map((u) => u.seq).join(', ')}\n\n` +
  `Excerpts:\n${excerpts}`;

console.log(`### ${projectName(t.project)}/${idTag(sessionId)}  ${t.kind}  ${excerpts.length} chars`);
console.log(`--- PROMPT (first 1200) ---\n${prompt.slice(0, 1200)}\n...`);

const llm = Llm.open({ model: 'haiku' });
const at = Date.now();
// Exactly the call `sdkReader()` makes, including llm.json's appended JSON_RULE
// and Shape block — the difference between this and a bare `llm.text` is the
// only place a working reader can turn into a silent `found: false`.
const READER_SCHEMA =
  '{"found":true|false,"quotes":[{"seq":<number>,"ts":"<the ts given>","text":"<verbatim>"}],' +
  '"answer_fragment":"<one or two sentences, or empty when found is false>"}';
const r = await llm.json({
  prompt,
  system: READER_SYSTEM,
  schema: READER_SCHEMA,
  fallback: { found: false, quotes: [], answer_fragment: 'FALLBACK-USED' },
});
console.log(`--- json() (${Date.now() - at}ms, ${r.model}, ${r.backend}, attempts=${r.attempts}, parsed=${r.parsed}) ---`);
console.log('RAW TEXT:', JSON.stringify(r.text).slice(0, 2000));
console.log('VALUE   :', JSON.stringify(r.value, null, 2).slice(0, 2000));
await llm.close();
db.close();

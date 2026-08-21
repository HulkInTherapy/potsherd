// The reader fan-out, at concurrency, with every RAW reply printed.
//
// Why this exists: on the reference corpus a session that answers `found: true`
// when it is the only reader answers `found: false` when it is one of six. That
// is either a real property of the backend under concurrency or a bug in
// `sdkReader`, and the difference is only visible in the text the model sent.
//
//   node phases/phase-4/evidence-T4.1/fanout-probe.mjs "<question>" [k] [concurrency]
import { db as store, recall, Llm } from '../../../packages/core/dist/index.js';
import { excerptUnits, excerptText, READER_SYSTEM } from '../../../packages/core/dist/ask.js';
import { makeGate } from '../../../packages/core/dist/cards/gate.js';
import {
  loadGhostTranscript,
  loadSessionTranscript,
} from '../../../packages/core/dist/cards/transcript.js';
import { idTag, projectName } from '../../../packages/core/dist/recall.js';

const root = process.env.POTSHERD_ASK_DIR ?? '/Users/zebra/randomness/potsherd-T4.1-corpus';
const question = process.argv[2];
const k = Number(process.argv[3] ?? 6);
const conc = Number(process.argv[4] ?? 6);
const db = store.open({ root });

const found = await recall(db, question, {}, { limit: 50, candidates: Math.max(k * 10, 60), root, vectors: true });
const order = [];
const seqs = new Map();
const scores = new Map();
for (const s of found.sessions) {
  const inBlock = [];
  for (const h of s.hits) {
    if (!seqs.has(h.sessionId)) { seqs.set(h.sessionId, []); inBlock.push(h.sessionId); }
    const l = seqs.get(h.sessionId);
    if (h.seq !== undefined && h.seq !== null && !l.includes(h.seq)) l.push(h.seq);
    scores.set(h.sessionId, Math.max(scores.get(h.sessionId) ?? 0, h.score));
  }
  if (!seqs.has(s.id)) { seqs.set(s.id, []); scores.set(s.id, s.score); inBlock.push(s.id); }
  inBlock.sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));
  order.push(...inBlock);
}

const targets = order.slice(0, k).map((sessionId) => {
  const t = loadSessionTranscript(db, sessionId) ?? loadGhostTranscript(db, sessionId);
  const units = excerptUnits(t, seqs.get(sessionId) ?? []);
  return { sessionId, id8: idTag(sessionId), project: projectName(t.project), harness: t.harness, isGhost: t.kind === 'ghost', units };
});

const READER_SCHEMA =
  '{"found":true|false,"quotes":[{"seq":<number>,"ts":"<the ts given>","text":"<verbatim>"}],' +
  '"answer_fragment":"<one or two sentences, or empty when found is false>"}';

const llm = Llm.open({ model: 'haiku' });
const gate = makeGate(conc);
console.log(`k=${k} concurrency=${conc}`);
const results = await Promise.all(
  targets.map((t) =>
    gate(async () => {
      const excerpts = excerptText(t.units);
      const prompt =
        `Question: ${question}\n\nSession ${t.id8} (${t.project}, ${t.harness}` +
        `${t.isGhost ? ', GHOST — prompts only' : ''}).\n` +
        `Citable seq numbers: ${t.units.map((u) => u.seq).join(', ')}\n\nExcerpts:\n${excerpts}`;
      const at = Date.now();
      const r = await llm.json({
        prompt,
        system: t.isGhost ? READER_SYSTEM + '\n\n(prompts only)' : READER_SYSTEM,
        schema: READER_SCHEMA,
        fallback: { found: false, quotes: [], answer_fragment: 'FALLBACK-USED' },
      });
      return { t, r, ms: Date.now() - at, chars: excerpts.length };
    }),
  ),
);
for (const { t, r, ms, chars } of results) {
  console.log(`\n=== ${t.project}/${t.id8} ${t.isGhost ? 'ghost' : 'session'} ${chars}ch ${ms}ms attempts=${r.attempts} parsed=${r.parsed} out=${r.outputTokens}tok`);
  console.log(JSON.stringify(r.text).slice(0, 1500));
}
await llm.close();
db.close();

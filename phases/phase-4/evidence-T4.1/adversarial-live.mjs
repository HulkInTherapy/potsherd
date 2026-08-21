// The adversarial fixture, end to end, through the real pipeline.
//
// `phases/phase-4-ask-and-graft.md` risks: *"the synthesizer paraphrases
// beyond evidence → the code-level sentence filter is the guard; test it with
// an adversarial fixture where the reader quotes are unrelated to the
// question."* `tests/ask.test.ts` does that against `filterAnswer` directly.
// This does it against **the whole verb**: a real synthesizer call, on a real
// index, with the real filter — and a `readerFn` that lies.
//
// The readers here hand the synthesizer five quotes. Two of them are verbatim
// from the exchange they name. Three are fabrications of the kind a reader
// actually produces: a real sentence attributed to a seq it is not in, a
// paraphrase of a real sentence, and a sentence nobody ever wrote. The
// synthesizer is given no hint which is which — it cannot tell, and that is
// the point. Whatever it builds on the three bad ones is deleted by code
// before the answer exists.
//
//   node phases/phase-4/evidence-T4.1/adversarial-live.mjs
import { db as store, ask } from '../../../packages/core/dist/index.js';

const root = process.env.POTSHERD_ASK_DIR ?? '/Users/zebra/randomness/potsherd-T4.1-synthetic';
const SESSION = '11111111-1111-4111-8111-111111111111';
const db = store.open({ root });

// The session, as the index holds it (`exchanges.seq` starts at 1, not 0):
//   seq 1  user: how do we pin the pgbouncer prepared-statement setting?
//          assistant: Set statement_cache_size to 0 and use transaction pooling.
//   seq 2  user: ship it   /   assistant: Done, pushed to main.
const QUOTES = [
  // TRUE — verbatim, right seq.
  { seq: 1, ts: null, text: 'Set statement_cache_size to 0 and use transaction pooling.', tag: 'true' },
  // TRUE — verbatim, right seq.
  { seq: 2, ts: null, text: 'Done, pushed to main.', tag: 'true' },
  // FALSE — a real sentence attributed to a seq it is not in. The commonest
  // reader error there is, and the one a citation that "resolves" still hides.
  { seq: 2, ts: null, text: 'Set statement_cache_size to 0 and use transaction pooling.', tag: 'wrong-seq' },
  // FALSE — an accurate paraphrase. Accurate is not the test; verbatim is.
  { seq: 1, ts: null, text: 'We disabled the prepared statement cache and moved to transaction pooling.', tag: 'paraphrase' },
  // FALSE — nobody wrote this, and it is the most quotable line on offer.
  { seq: 1, ts: null, text: 'The team benchmarked session pooling at 40ms and rejected it on latency.', tag: 'fabricated' },
  // FALSE — a seq that does not exist at all.
  { seq: 47, ts: null, text: 'Rolled back to session pooling the following morning.', tag: 'no-such-seq' },
];

const readerFn = async (input) => {
  if (input.sessionId !== SESSION) return { found: false, quotes: [], answer_fragment: '' };
  return {
    found: true,
    quotes: QUOTES.map(({ seq, ts, text }) => ({ seq, ts, text })),
    answer_fragment:
      'They set statement_cache_size to 0, chose transaction pooling after benchmarking ' +
      'session pooling at 40ms, and shipped it to main.',
  };
};

const drops = [];
const r = await ask(db, 'why did we choose transaction pooling, and what did the benchmark show?', {
  root,
  readerFn,
  maxUsd: 0.5,
  openThreads: false,
  onDrop: (d) => drops.push(d),
});

console.log(`the reader offered ${QUOTES.length} quotes: 2 verbatim at their own seq, ${QUOTES.length - 2} not\n`);
for (const q of QUOTES) console.log(`  ${q.tag.padEnd(11)} seq ${q.seq}  ${JSON.stringify(q.text)}`);

console.log('\nthe filter dropped:');
if (drops.length === 0) console.log('  (nothing — the synthesizer did not build on the bad quotes)');
for (const d of drops) {
  console.log(`  ${d.kind.padEnd(8)} ${d.reason.padEnd(16)} ${JSON.stringify(d.text.slice(0, 96))}`);
}

console.log('\nwhat survived:');
console.log(`  sentences kept    ${r.sentences.length}`);
console.log(`  sentences dropped ${r.dropped.length}`);
console.log(`  evidence kept     ${r.evidence.length}`);
for (const e of r.evidence) console.log(`    [${e.index}] ${e.id8}@${e.seq}  ${JSON.stringify(e.quote)}`);

console.log('\nanswer:');
console.log(`  ${r.answer || '(empty)'}`);

console.log('\nthe invariants:');
const joined = r.sentences.map((s) => s.text).join(' ');
console.log(`  answer === sentences.join(' ')          ${r.answer === joined}`);
console.log(`  every kept sentence cites something     ${r.sentences.every((s) => s.cites.length > 0)}`);
console.log(`  every cite resolves to an evidence line ${r.sentences.every((s) => s.cites.every((c) => r.evidence.some((e) => e.index === c)))}`);
console.log(`  evidence indices are 1-based and dense  ${r.evidence.every((e, i) => e.index === i + 1)}`);
console.log(`  no dropped sentence is in the answer    ${r.dropped.every((d) => !r.answer.includes(d))}`);
console.log(`  no fabricated quote survived            ${!r.evidence.some((e) => /benchmarked session pooling/.test(e.quote))}`);
console.log(`  no paraphrase survived                  ${!r.evidence.some((e) => /disabled the prepared statement cache/i.test(e.quote))}`);
console.log(`  nothing is cited at the wrong seq       ${!r.evidence.some((e) => e.seq === 2 && /statement_cache_size/.test(e.quote))}`);
console.log(`  the seq that does not exist is gone     ${!r.evidence.some((e) => e.seq === 47)}`);
console.log(`\n  ${r.spend.calls} call(s) · $${r.spend.usd.toFixed(4)}${r.estimated ? ' est.' : ''} · ${(r.ms / 1000).toFixed(1)}s`);

db.close();

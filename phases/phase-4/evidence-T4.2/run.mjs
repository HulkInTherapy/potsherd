/**
 * T4.2 real run, over the reference corpus.
 *
 * `ask` (T4.1) is being written in another worktree, so this is the driver that
 * exercises the two exported functions exactly as `ask` will: the rule pass over
 * every carded session, then **one** model call confirming the whole batch.
 *
 *   node run.mjs <potsherd-dir> [--limit 8] [--no-model]
 *
 * Prints JSON: the candidates, the confirmations, and the wall time and token
 * figures for the model call. Token counts inherit `llm.ts`'s honesty rule — the
 * agent SDK reports a constant `input_tokens: 10`, which is discarded and
 * labelled `est.`
 */
import Database from '../../../packages/core/node_modules/better-sqlite3/lib/index.js';
import {
  openThreadCandidates,
  confirmOpenThreads,
  OPEN_THREAD_LABEL,
  MENTION_COSINE,
  CONFIRM_BATCH,
} from '../../../packages/core/dist/open-threads.js';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
if (!dir) {
  console.error('usage: node run.mjs <potsherd-dir> [--limit N] [--no-model]');
  process.exit(2);
}
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : 8;
const noModel = args.includes('--no-model');

const db = new Database(`${dir}/potsherd.db`, { readonly: true });

// What `ask` passes: the shortlist. Here, every carded real session, so the
// number reported is the whole corpus's and not one query's.
const sessionIds = db
  .prepare(`SELECT session_id FROM cards WHERE source = 'transcript'`)
  .all()
  .map((r) => r.session_id);

const t0 = Date.now();
const candidates = openThreadCandidates(db, sessionIds, { limit });
const ruleMs = Date.now() - t0;

let confirmed = [];
let modelMs = 0;
if (!noModel && candidates.length) {
  const t1 = Date.now();
  const mi = args.indexOf("--model");
  confirmed = await confirmOpenThreads(candidates, mi >= 0 ? { model: args[mi + 1] } : {});
  modelMs = Date.now() - t1;
}

console.log(
  JSON.stringify(
    {
      potsherdDir: dir,
      label: OPEN_THREAD_LABEL,
      mentionCosine: MENTION_COSINE,
      confirmBatch: CONFIRM_BATCH,
      sessionsConsidered: sessionIds.length,
      cardsInIndex: db.prepare('SELECT count(*) n FROM cards').get().n,
      ruleMs,
      modelMs,
      candidates,
      confirmed,
      confirmedCount: confirmed.filter((c) => c.confirmed).length,
    },
    null,
    2,
  ),
);

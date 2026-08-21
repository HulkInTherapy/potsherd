// Where in this corpus is there an actual, quotable, assistant-side answer?
//
// A `ask` demo is only as honest as the corpus behind it. 299 of the 535
// conversations here are ghosts — prompts only — and a reader given a ghost is
// told, correctly, that it may not say what the assistant answered. So a
// question whose answer lives in a ghost gets `found: false` from every reader
// and that is the honesty contract working, not a bug. This lists the
// exchanges that *do* have a substantial assistant side saying a decision, so a
// real run can be pointed at one.
import { db as store } from '../../../packages/core/dist/index.js';

const root = process.env.POTSHERD_ASK_DIR ?? '/Users/zebra/randomness/potsherd-T4.1-corpus';
const db = store.open({ root });

const rows = db
  .prepare(
    `SELECT e.session_id, e.seq, s.project, s.title, s.is_sidechain,
            length(e.assistant_text) AS alen,
            substr(e.user_text, 1, 110)      AS u,
            substr(e.assistant_text, 1, 300) AS a
       FROM exchanges e JOIN sessions s ON s.id = e.session_id
      WHERE length(e.assistant_text) BETWEEN 600 AND 6000
        AND (e.assistant_text LIKE '%we decided%'
          OR e.assistant_text LIKE '%the decision%'
          OR e.assistant_text LIKE '%I chose%'
          OR e.assistant_text LIKE '%chose to%'
          OR e.assistant_text LIKE '%instead of%'
          OR e.assistant_text LIKE '%rather than%')
      ORDER BY alen DESC
      LIMIT 40`,
  )
  .all();

for (const r of rows) {
  console.log(`\n--- ${r.project?.split('/').pop()}  ${r.session_id.slice(0, 8)}@${r.seq}  ${r.alen}ch${r.is_sidechain ? '  sidechain' : ''}`);
  console.log(`  U: ${r.u.replace(/\s+/g, ' ')}`);
  console.log(`  A: ${r.a.replace(/\s+/g, ' ')}`);
}
console.log(`\n${rows.length} rows`);
db.close();

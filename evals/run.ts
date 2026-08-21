#!/usr/bin/env tsx
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  Theme,
  db as store,
  format as fmt,
  indexAll,
  recall,
  rescue,
  table,
  type RecallResult,
} from '../packages/core/src/index.js';

/**
 * T1.6 — the recall eval. `pnpm evals`.
 *
 * Ten known-answer queries against a corpus whose answers are known because
 * the corpus was written to have them. It prints recall@5: the fraction of
 * queries whose expected session comes back in the top five.
 *
 * ## Why the committed set is a fixture
 *
 * The real reference set lives in `~/.potsherd/evals/queries.jsonl` and is
 * never committed. A query written against a real corpus *is* the corpus: to
 * be a good query it has to quote the distinctive words of a real
 * conversation, which means a committed reference set would publish client
 * names, project names and prompt text. `plans/phases/phase-1-foundation.md`
 * T1.6 says so outright, and this file is built around it:
 *
 *   pnpm evals                              the fixture set, offline, no real data
 *   pnpm evals -- --set ~/.potsherd/evals/queries.jsonl --potsherd-dir ~/.potsherd
 *                                           the private set, against the real index
 *
 * The fixture corpus in `evals/fixture/` is invented — eight sessions, two
 * subagent transcripts and three ghosts across four made-up projects — but it
 * is shaped like a real one: the ghost answers exist only in `history.jsonl`,
 * the sidechain answer exists only in a subagent's transcript, and one session
 * has no title at all. A `find` that quietly stopped returning any of those
 * three would drop this score, which is the whole point of having it.
 *
 * ## What it measures, and what it does not
 *
 * recall@5 over *sessions*, not exchanges: the question is "did potsherd put
 * the right conversation on the first screen", which is the thing a user
 * actually experiences. It says nothing about ordering within the five, and
 * nothing about precision — with ten queries neither would mean much.
 */

// The core is imported from source, not from `@potsherd/core`: `tsx` reads TS
// directly, so `pnpm evals` works in a fresh clone with nothing built, and it
// always measures the checkout rather than whatever is in `dist/`.
const here = path.dirname(fileURLToPath(import.meta.url));

interface EvalQuery {
  query: string;
  expected_session_prefix: string;
  expected_harness?: string;
  note?: string;
}

interface Outcome {
  query: EvalQuery;
  hit: boolean;
  /** 1-based position of the expected session, or 0 when it never appeared. */
  rank: number;
  harness: string | null;
  ms: number;
  result: RecallResult;
}

interface Options {
  set: string;
  potsherdDir: string | null;
  k: number;
  vectors: 'auto' | 'on' | 'off';
  json: boolean;
  keep: boolean;
}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    set: path.join(here, 'queries.jsonl'),
    potsherdDir: null,
    k: 5,
    vectors: 'off',
    json: false,
    keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--set') o.set = String(argv[++i]);
    else if (a === '--potsherd-dir') o.potsherdDir = String(argv[++i]);
    else if (a === '--k') o.k = Number(argv[++i]);
    else if (a === '--vectors') o.vectors = argv[++i] as Options['vectors'];
    else if (a === '--json') o.json = true;
    else if (a === '--keep') o.keep = true;
    else if (a === '-h' || a === '--help') {
      process.stdout.write(HELP);
      process.exit(0);
    }
  }
  return o;
}

const HELP = `
potsherd evals — recall@5 over a known-answer query set

  pnpm evals
  pnpm evals -- --vectors on                       # hybrid instead of bm25 alone
  pnpm evals -- --k 1                              # recall@1
  pnpm evals -- --set ~/.potsherd/evals/queries.jsonl --potsherd-dir ~/.potsherd
  pnpm evals -- --json

  --set <file>          queries.jsonl (default: the committed fixture set)
  --potsherd-dir <dir>  search this index instead of building one from the fixture
  --k <n>               recall@k (default 5)
  --vectors auto|on|off the vector half of the hybrid (default off — bm25 alone)
  --keep                do not delete the temporary fixture index
  --json                machine-readable
`;

function readQueries(file: string): EvalQuery[] {
  if (!fs.existsSync(file)) {
    throw new Error(
      `no query set at ${file}\n` +
        `  the committed fixture set is evals/queries.jsonl; the private one lives in ~/.potsherd/evals/`,
    );
  }
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .map((l) => JSON.parse(l) as EvalQuery);
}

/**
 * Build the fixture index from scratch, every run.
 *
 * `--no-embed`, so it needs no model and no network and finishes in about a
 * second; `rescue --ghosts-only` first, because ghosts come from
 * `history.jsonl` and `index` only redacts and indexes ghosts that already
 * exist. Building it fresh rather than committing a `.db` means the eval
 * measures *today's* indexer, which is the only version worth measuring.
 */
async function buildFixtureIndex(keep: boolean): Promise<{ root: string; cleanup: () => void }> {
  const claudeDir = path.join(here, 'fixture', 'claude');
  if (!fs.existsSync(claudeDir)) {
    throw new Error(`no fixture corpus at ${claudeDir}`);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'potsherd-evals-'));
  await rescue({ claudeDir, root, ghostsOnly: true, quiet: true });
  await indexAll({ root, claudeDir, harnesses: ['claude'], embed: false, full: true });
  return {
    root,
    cleanup: () => {
      if (!keep) fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  const queries = readQueries(o.set);

  const built = o.potsherdDir ? null : await buildFixtureIndex(o.keep);
  const root = o.potsherdDir ?? built!.root;
  const db = store.open({ root });

  const outcomes: Outcome[] = [];
  try {
    for (const q of queries) {
      const t0 = Date.now();
      const result = await recall(
        db,
        q.query,
        {},
        {
          limit: Math.max(o.k, 10),
          root,
          vectors: o.vectors === 'on' ? true : o.vectors === 'off' ? false : 'auto',
        },
      );
      const ms = Date.now() - t0;
      const at = result.sessions.findIndex((s) => s.id.startsWith(q.expected_session_prefix));
      outcomes.push({
        query: q,
        hit: at >= 0 && at < o.k,
        rank: at + 1,
        harness: at >= 0 ? result.sessions[at]!.harness : null,
        ms,
        result,
      });
    }
  } finally {
    db.close();
    built?.cleanup();
  }

  const hits = outcomes.filter((r) => r.hit).length;
  const times = outcomes.map((r) => r.ms).sort((a, b) => a - b);

  if (o.json) {
    process.stdout.write(
      JSON.stringify(
        {
          set: o.set,
          root,
          k: o.k,
          vectors: o.vectors,
          queries: queries.length,
          hits,
          recall: queries.length ? hits / queries.length : 0,
          p50: percentile(times, 50),
          p95: percentile(times, 95),
          results: outcomes.map((r) => ({
            query: r.query.query,
            expected: r.query.expected_session_prefix,
            note: r.query.note ?? null,
            hit: r.hit,
            rank: r.rank,
            harness: r.harness,
            ms: r.ms,
            sessions: r.result.sessions.slice(0, o.k).map((s) => ({
              id: s.id,
              status: s.status,
              isSidechain: s.isSidechain,
              title: s.displayTitle,
            })),
          })),
        },
        null,
        2,
      ) + '\n',
    );
    process.exitCode = hits === queries.length ? 0 : 1;
    return;
  }

  const t = new Theme({ width: 80 });
  const rows = outcomes.map((r) => [
    r.hit ? 'ok' : t.warn('MISS'),
    r.rank > 0 ? `#${r.rank}` : '—',
    `${r.ms}ms`,
    fmt.elide(r.query.query, 34),
    t.dim(r.query.note ?? ''),
  ]);

  const out: string[] = [];
  out.push(
    t.dim(
      `potsherd evals ${t.sep} ${path.basename(o.set)} ${t.sep} ${queries.length} queries ${t.sep} ` +
        (o.vectors === 'off' ? 'bm25' : `bm25 + vectors (${o.vectors})`),
    ),
  );
  out.push('');
  out.push(...table(t, rows, { gap: 2, grow: 4, align: ['left', 'right', 'right'] }));
  out.push('');
  const pct = queries.length ? Math.round((hits / queries.length) * 100) : 0;
  out.push(
    `  recall@${o.k}${' '.repeat(6)}${String(hits).padStart(3)}/${queries.length}   ` +
      (hits >= Math.ceil(queries.length * 0.8) ? t.ok(`${pct}%`) : t.warn(`${pct}%`)),
  );
  out.push(
    t.dim(
      `  recall p50    ${String(percentile(times, 50)).padStart(3)}ms   p95 ${percentile(times, 95)}ms` +
        `   (in-process; the CLI adds ~90ms of node startup)`,
    ),
  );
  process.stdout.write(out.join('\n') + '\n');
  process.exitCode = hits === queries.length ? 0 : 1;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i]!;
}

main().catch((err) => {
  process.stderr.write(`evals: ${(err as Error).message}\n`);
  process.exit(1);
});

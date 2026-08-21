#!/usr/bin/env tsx
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  LISTS,
  Theme,
  db as store,
  embeddings,
  format as fmt,
  indexAll,
  paths,
  recall,
  rescue,
  table,
  vectorState,
  type ListName,
  type RecallResult,
} from '../packages/core/src/index.js';

/**
 * T1.6 / T1.7b — the recall eval. `pnpm evals`.
 *
 * Known-answer queries against a corpus whose answers are known because the
 * corpus was written to have them. It prints recall@5 — the fraction of
 * queries whose expected session comes back in the top five — for each of the
 * three retrieval modes separately, because the interesting number is not any
 * one of them but the gap between them.
 *
 * ## Two things T1.7b had to fix here
 *
 * **The vector runs had no vectors.** This file built its fixture index with
 * `embed: false` and then offered `--vectors on`, so the run labelled
 * `bm25 + vectors` was bm25 compared against bm25 and could not lose. The
 * index is now built *with* embeddings whenever the model is on disk, the
 * three modes are run separately, and when the model is missing the vector
 * modes are **skipped and said to be skipped** rather than quietly faked.
 *
 * **The queries were tuned to pass.** The first set scored 10/10 with every
 * answer at rank 1, because each query was a near-substring of its answer:
 * `"webhook rate limited by the gateway"` against a prompt reading *"the
 * outbound webhook is getting rate limited by their gateway"*. That measures
 * string overlap. The set is rewritten around how somebody remembers a
 * conversation weeks later, with distractor sessions on adjacent topics that
 * must rank below the answer; see the header of `queries.jsonl`.
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
 * The fixture corpus in `evals/fixture/` is invented — 24 sessions, two
 * subagent transcripts and five ghosts across six made-up projects — but it is
 * shaped like a real one: two ghost answers exist only in `history.jsonl`, one
 * answer exists only in a subagent's transcript, two answerable sessions have
 * no title at all, and one session's prompts are pasted-screenshot
 * placeholders with the real content in the reply. A `find` that quietly
 * stopped returning any of those would drop this score, which is the whole
 * point of having it.
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

/** `plans/06`: phase 1's gate is ≥ 8/10 on bm25 alone. */
export const PHASE_1_GATE = 0.8;

interface EvalQuery {
  query: string;
  expected_session_prefix: string;
  expected_harness?: string;
  /** Require the answer to come back as the subagent transcript, not the parent. */
  expected_sidechain?: boolean;
  /** `concept` | `ranking` | `recall`; see the header of queries.jsonl. */
  class?: string;
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

type ModeKey = 'bm25' | 'vectors' | 'hybrid' | 'always';

interface Mode {
  key: ModeKey;
  label: string;
  lists: readonly ListName[];
  vectors: boolean | 'auto';
  /** True when this mode needs the index to hold vectors. */
  needsVectors: boolean;
}

/**
 * Four modes, not two, because "hybrid" is ambiguous and the ambiguity is
 * exactly where the interesting number lives.
 *
 * `hybrid` is what `potsherd find` actually runs: `vectors: 'auto'`, which
 * pays for the 350 ms forward pass only when the text index had to relax. It
 * is the number a user experiences. `always` forces the vector list on every
 * query, which is the form `plans/06`'s phase-3 gate — *hybrid must beat
 * bm25-only and vec-only on the same set* — is really about. Reporting both
 * makes it visible when `auto` is carrying the score and the fusion is not.
 */
const MODES: Record<ModeKey, Mode> = {
  bm25: { key: 'bm25', label: 'bm25 only', lists: LISTS, vectors: false, needsVectors: false },
  vectors: {
    key: 'vectors',
    label: 'vectors only',
    lists: ['vec_exchanges'],
    vectors: true,
    needsVectors: true,
  },
  hybrid: { key: 'hybrid', label: 'hybrid (auto)', lists: LISTS, vectors: 'auto', needsVectors: true },
  always: {
    key: 'always',
    label: 'hybrid (always)',
    lists: LISTS,
    vectors: true,
    needsVectors: true,
  },
};

interface Options {
  set: string;
  potsherdDir: string | null;
  k: number;
  /**
   * Drop `cards_fts` and `vec_cards` from every mode.
   *
   * The honest A/B for "did cards help the fusion" is the *same index* and the
   * *same queries* with the card lists on and off — not a carded index against
   * an uncarded one, which also differs in when it was built and what else had
   * changed. T2.2 reports both halves of exactly this switch.
   */
  noCards: boolean;
  modes: ModeKey[] | null;
  /** Back-compatible single-mode switch. */
  vectors: 'auto' | 'on' | 'off' | null;
  json: boolean;
  keep: boolean;
}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    set: path.join(here, 'queries.jsonl'),
    potsherdDir: null,
    k: 5,
    noCards: false,
    modes: null,
    vectors: null,
    json: false,
    keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--set') o.set = String(argv[++i]);
    else if (a === '--potsherd-dir') o.potsherdDir = String(argv[++i]);
    else if (a === '--k') o.k = Number(argv[++i]);
    else if (a === '--no-cards') o.noCards = true;
    else if (a === '--modes') {
      o.modes = String(argv[++i])
        .split(',')
        .map((m) => m.trim() as ModeKey)
        .filter((m) => m in MODES);
    } else if (a === '--vectors') o.vectors = argv[++i] as Options['vectors'];
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

  pnpm evals                                       all four retrieval modes
  pnpm evals -- --modes bm25                       one mode only
  pnpm evals -- --k 1                              recall@1
  pnpm evals -- --set ~/.potsherd/evals/queries.jsonl --potsherd-dir ~/.potsherd
  pnpm evals -- --json

  --set <file>          queries.jsonl (default: the committed fixture set)
  --potsherd-dir <dir>  search this index instead of building one from the fixture
  --k <n>               recall@k (default 5)
  --no-cards            drop cards_fts and vec_cards from every mode, for the
                        same-index A/B on whether cards help the fusion
  --modes a,b,c         any of bm25, vectors, hybrid, always (default: all four)
  --vectors auto|on|off legacy single-mode switch
  --keep                do not delete the temporary fixture index
  --json                machine-readable

The vector modes need the 34 MB bge-small model on disk. It is looked for in
POTSHERD_MODELS_DIR, then ~/.potsherd/models, then the directory the test
suite uses; if none of them has it the vector modes are skipped and the run
says so. POTSHERD_EVALS_EMBED=1 permits the download into ~/.potsherd/models.
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
 * Where the embedding model already is, if it is anywhere.
 *
 * `indexAll` and `recall` both read the model from `<root>/models`, and the
 * fixture root is a fresh temporary directory every run — so without this the
 * honest vector mode would download 34 MB per run. The cache is located once
 * and symlinked into the run's root, which keeps `--potsherd-dir` genuinely
 * self-contained (nothing is written outside the temp root) while costing the
 * download exactly once per machine.
 */
function findModelCache(): { dir: string; found: boolean } {
  // `POTSHERD_MODELS_DIR`, when set, is the answer — not the first guess. A
  // machine pointing the eval at a specific model wants that model or nothing,
  // and it is also the only way to make this function say "no" on a machine
  // that happens to have one lying around.
  const override = process.env['POTSHERD_MODELS_DIR'];
  const candidates = override
    ? [override]
    : [paths.modelsDir(), path.join(os.tmpdir(), 'potsherd-test-models')];
  for (const dir of candidates) {
    if (embeddings.isModelCached(dir)) return { dir, found: true };
  }
  return { dir: override ?? paths.modelsDir(), found: false };
}

interface Built {
  root: string;
  /** Vectors actually in `vec_exchanges` after the build. */
  vectors: number;
  /** Milliseconds the embedding pass cost, and how many exchanges it embedded. */
  embedMs: number;
  embedded: number;
  /** Why there are no vectors, when there are none. */
  reason?: string;
  cleanup: () => void;
}

/**
 * Build the fixture index from scratch, every run.
 *
 * `rescue --ghosts-only` first, because ghosts come from `history.jsonl` and
 * `index` only redacts and indexes ghosts that already exist. Building it
 * fresh rather than committing a `.db` means the eval measures *today's*
 * indexer, which is the only version worth measuring.
 */
async function buildFixtureIndex(keep: boolean, embed: boolean): Promise<Built> {
  const claudeDir = path.join(here, 'fixture', 'claude');
  if (!fs.existsSync(claudeDir)) {
    throw new Error(`no fixture corpus at ${claudeDir}`);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'potsherd-evals-'));
  const cleanup = (): void => {
    if (!keep) fs.rmSync(root, { recursive: true, force: true });
  };

  let reason: string | undefined;
  if (embed) {
    const cache = findModelCache();
    if (cache.found) {
      // A symlink, not a copy: 34 MB per run of io for nothing otherwise.
      fs.symlinkSync(cache.dir, path.join(root, 'models'));
    } else if (process.env['POTSHERD_EVALS_EMBED'] === '1') {
      fs.mkdirSync(paths.modelsDir(), { recursive: true });
      fs.symlinkSync(paths.modelsDir(), path.join(root, 'models'));
    } else {
      embed = false;
      reason =
        'no embedding model on disk — set POTSHERD_EVALS_EMBED=1 to fetch 34 MB, or POTSHERD_MODELS_DIR to point at one';
    }
  }

  await rescue({ claudeDir, root, ghostsOnly: true, quiet: true });
  const report = await indexAll({
    root,
    claudeDir,
    harnesses: ['claude'],
    embed,
    full: true,
  });

  // `vectorState` is what loads vec0 into the connection; counting the table
  // directly on a fresh handle throws, which is how the first draft of this
  // function decided a perfectly good index had no vectors in it.
  const db = store.open({ root });
  const state = vectorState(db, root);
  const vectors = state.vectors ?? 0;
  db.close();

  if (embed && vectors === 0 && !reason) {
    reason = report.embeddings.reason ?? state.reason ?? 'the index came back with no vectors';
  }
  return {
    root,
    vectors,
    embedMs: report.embeddings.ms,
    embedded: report.embeddings.embedded,
    ...(reason ? { reason } : {}),
    cleanup,
  };
}

async function runMode(
  root: string,
  queries: EvalQuery[],
  mode: Mode,
  k: number,
): Promise<Outcome[]> {
  const db = store.open({ root });
  const outcomes: Outcome[] = [];
  try {
    for (const q of queries) {
      const t0 = Date.now();
      const result = await recall(
        db,
        q.query,
        {},
        { limit: Math.max(k, 10), root, lists: mode.lists, vectors: mode.vectors },
      );
      const ms = Date.now() - t0;
      const at = result.sessions.findIndex(
        (s) =>
          s.id.startsWith(q.expected_session_prefix) &&
          (q.expected_sidechain ? s.isSidechain : true),
      );
      outcomes.push({
        query: q,
        hit: at >= 0 && at < k,
        rank: at + 1,
        harness: at >= 0 ? result.sessions[at]!.harness : null,
        ms,
        result,
      });
    }
  } finally {
    db.close();
  }
  return outcomes;
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  const queries = readQueries(o.set);

  // `--vectors` is the old single-mode switch; honour it, but the default is
  // now all three modes, because "hybrid ≥ bm25" is only a claim when the two
  // numbers were produced by the same command on the same corpus.
  let wanted: ModeKey[] =
    o.modes ??
    (o.vectors === 'off'
      ? ['bm25']
      : o.vectors === 'on'
        ? ['always']
        : o.vectors === 'auto'
          ? ['hybrid']
          : ['bm25', 'vectors', 'hybrid', 'always']);

  const needVectors = wanted.some((m) => MODES[m].needsVectors);
  const built = o.potsherdDir ? null : await buildFixtureIndex(o.keep, needVectors);
  const root = o.potsherdDir ?? built!.root;

  let skipped: string | null = null;
  if (needVectors && built && built.vectors === 0) {
    skipped = built.reason ?? 'no vectors in the index';
    wanted = wanted.filter((m) => !MODES[m].needsVectors);
    if (wanted.length === 0) wanted = ['bm25'];
  }

  const runs: { mode: Mode; outcomes: Outcome[] }[] = [];
  try {
    for (const key of wanted) {
      const mode = o.noCards
        ? {
            ...MODES[key],
            lists: MODES[key].lists.filter((l) => l !== 'cards_fts' && l !== 'vec_cards'),
          }
        : MODES[key];
      runs.push({ mode, outcomes: await runMode(root, queries, mode, o.k) });
    }
  } finally {
    built?.cleanup();
  }

  const primary = runs.find((r) => r.mode.key === 'bm25') ?? runs[0]!;
  const score = (outcomes: Outcome[]): number => outcomes.filter((r) => r.hit).length;
  const gateMet = score(primary.outcomes) / queries.length >= PHASE_1_GATE;

  if (o.json) {
    process.stdout.write(
      JSON.stringify(
        {
          set: o.set,
          root,
          k: o.k,
          queries: queries.length,
          gate: PHASE_1_GATE,
          gateMet,
          index: built
            ? {
                vectors: built.vectors,
                embedded: built.embedded,
                embedMs: built.embedMs,
                skipped,
              }
            : null,
          modes: runs.map(({ mode, outcomes }) => ({
            mode: mode.key,
            hits: score(outcomes),
            recall: queries.length ? score(outcomes) / queries.length : 0,
            p50: percentile(sorted(outcomes), 50),
            p95: percentile(sorted(outcomes), 95),
            results: outcomes.map((r) => ({
              query: r.query.query,
              expected: r.query.expected_session_prefix,
              class: r.query.class ?? null,
              note: r.query.note ?? null,
              hit: r.hit,
              rank: r.rank,
              harness: r.harness,
              ms: r.ms,
              vectorsUsed: r.result.vectors.used,
              sessions: r.result.sessions.slice(0, o.k).map((s) => ({
                id: s.id,
                status: s.status,
                isSidechain: s.isSidechain,
                title: s.displayTitle,
              })),
            })),
          })),
        },
        null,
        2,
      ) + '\n',
    );
    process.exitCode = gateMet ? 0 : 1;
    return;
  }

  const t = new Theme({ width: 80 });
  const out: string[] = [];
  out.push(
    t.dim(
      `potsherd evals ${t.sep} ${path.basename(o.set)} ${t.sep} ${queries.length} queries ` +
        `${t.sep} recall@${o.k} ${t.sep} ${built ? `${fmt.num(built.vectors)} vectors` : 'existing index'}`,
    ),
  );
  out.push('');

  // The per-query table is the primary mode's; the other modes are a summary,
  // because three tables of ten rows is not a screenshot.
  const rows = primary.outcomes.map((r) => [
    r.hit ? 'ok' : t.warn('MISS'),
    r.rank > 0 ? `#${r.rank}` : '—',
    r.query.class ?? '',
    fmt.elide(r.query.query, 52),
  ]);
  out.push(...table(t, rows, { gap: 2, grow: 3, align: ['left', 'right', 'left'] }));
  out.push('');

  for (const { mode, outcomes } of runs) {
    const hits = score(outcomes);
    const pct = queries.length ? Math.round((hits / queries.length) * 100) : 0;
    const ok = hits / queries.length >= PHASE_1_GATE;
    out.push(
      `  ${mode.label.padEnd(16)}${String(hits).padStart(3)}/${queries.length}   ` +
        (ok ? t.ok(`${pct}%`.padEnd(5)) : t.warn(`${pct}%`.padEnd(5))) +
        t.dim(`  p50 ${percentile(sorted(outcomes), 50)}ms   p95 ${percentile(sorted(outcomes), 95)}ms`),
    );
  }
  out.push('');
  // The comparison `plans/06` phase 3 turns into a gate. Said here, in the run
  // that produced the numbers, so nobody has to hold two screenshots side by
  // side to notice that the fusion is currently costing recall rather than
  // buying it.
  const bm25Score = runs.find((r) => r.mode.key === 'bm25');
  const hybridScore = runs.find((r) => r.mode.key === 'hybrid' || r.mode.key === 'always');
  if (bm25Score && hybridScore) {
    const gap = score(hybridScore.outcomes) - score(bm25Score.outcomes);
    out.push(
      INDENT +
        (gap >= 0
          ? t.dim(`hybrid ${gap === 0 ? 'ties' : `beats`} bm25 by ${Math.abs(gap)}`)
          : t.warn(`hybrid is ${-gap} below bm25`) +
            t.dim(` ${t.sep} plans/06 phase 3 would not merge this fusion`)),
    );
  }
  if (skipped) {
    out.push(INDENT + t.warn('vector modes skipped') + t.dim(` ${t.sep} ${fmt.clip(skipped, 55)}`));
  } else if (built && built.embedded > 0) {
    out.push(
      INDENT +
        t.dim(
          `${fmt.num(built.embedded)} exchanges embedded in ${fmt.duration(built.embedMs)}` +
            ` ${t.sep} ${Math.round(built.embedMs / built.embedded)}ms each`,
        ),
    );
  }
  out.push(
    INDENT +
      t.dim(`phase-1 gate ${t.sep} bm25 alone ≥ ${Math.round(PHASE_1_GATE * queries.length)}/${queries.length} ${t.sep} `) +
      (gateMet ? t.ok('met') : t.warn('not met')),
  );
  process.stdout.write(out.join('\n') + '\n');
  process.exitCode = gateMet ? 0 : 1;
}

const INDENT = '  ';

function sorted(outcomes: Outcome[]): number[] {
  return outcomes.map((r) => r.ms).sort((a, b) => a - b);
}

function percentile(s: number[], p: number): number {
  if (s.length === 0) return 0;
  const i = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[i]!;
}

main().catch((err) => {
  process.stderr.write(`evals: ${(err as Error).message}\n`);
  process.exit(1);
});

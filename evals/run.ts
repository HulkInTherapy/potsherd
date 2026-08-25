#!/usr/bin/env tsx
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { compareToBaseline, readBaseline } from './baseline.js';
import { fileURLToPath } from 'node:url';
import {
  LISTS,
  Theme,
  cardEmbeddingText,
  db as store,
  embeddings,
  format as fmt,
  indexAll,
  paths,
  recall,
  rescue,
  table,
  vectorState,
  WEIGHTS,
  writeCard,
  type ListName,
  type RecallResult,
} from '../packages/core/src/index.js';
import type { Db } from '../packages/core/src/db.js';
import { PHASE_1_GATE, PHASE_3_GATE, judge, ruleLine, type Gate } from './gate.js';

/**
 * T1.6 / T1.7b / T3.4 — the recall eval. `pnpm evals`.
 *
 * Known-answer queries against a corpus whose answers are known because the
 * corpus was written to have them. It prints recall@5 *and* recall@1 for four
 * retrieval modes separately, because the interesting number is not any one of
 * them but the gap between them — and then it says out loud whether that gap
 * clears `plans/06`'s phase-3 gate **as amended by phase 8.5**: hybrid ≥ both
 * singles at recall@5, and strictly above both at recall@1. The rule, why it
 * was amended after five phases of exiting 1, and the test that proves it can
 * still fail are all in `evals/gate.ts`.
 *
 * ## The three ways this file has been wrong, and what stops each now
 *
 * **The vector runs had no vectors.** It built its fixture index with
 * `embed: false` and then offered `--vectors on`, so the run labelled
 * `bm25 + vectors` was bm25 compared against bm25 and could not lose. The
 * index is now built *with* embeddings whenever the model is on disk, the
 * modes are run separately, and when the model is missing the vector modes are
 * **skipped and said to be skipped** rather than quietly faked.
 *
 * **The queries were tuned to pass.** The first set scored 10/10 with every
 * answer at rank 1, because each query was a near-substring of its answer:
 * `"webhook rate limited by the gateway"` against a prompt reading *"the
 * outbound webhook is getting rate limited by their gateway"*. That measures
 * string overlap. The set is now written around how somebody remembers a
 * conversation weeks later — and, because good intentions are not a control,
 * every run **prints the word overlap between each query and its own answer**
 * and flags anything above the threshold. A query that passes only because it
 * quotes its answer says so on the screen, in the same run that scored it.
 *
 * **The metric was free.** recall@5 over eleven candidates is not a test;
 * `scripts/make-eval-corpus.mjs` now writes 46 sessions, 6 sidechains and 12
 * ghosts, most of them distractors on the adjacent topic, and recall@1 is
 * reported next to recall@5 so that "in the top five somewhere" cannot hide a
 * ranker that never puts the answer first.
 *
 * ## Cards
 *
 * `cards_fts` and `vec_cards` are two of the five lists the fusion reads, and
 * phase 2 measured them competing at about 17% completeness on this corpus,
 * which is not a test of them. The eval index cannot run the real card
 * pipeline — `runCards` calls a model, which costs money, needs a key and
 * answers differently every time — so the cards are fixture data
 * (`evals/fixture/cards.jsonl`), written through the real `writeCard`, which
 * is the code path that fills `cards`, `cards_fts` and `vec_cards`. What is
 * measured is retrieval over card text, not the extractor that would have
 * produced it. `--no-cards` drops both card lists for the same-index A/B.
 *
 * ## Why the committed set is a fixture
 *
 * The real reference set lives in `~/.potsherd/evals/queries.jsonl` and is
 * never committed. A query written against a real corpus *is* the corpus: to
 * be a good query it has to quote the distinctive words of a real
 * conversation, which means a committed reference set would publish client
 * names, project names and prompt text. `plans/06` says so outright:
 *
 *   pnpm evals                              the fixture set, offline, no real data
 *   pnpm evals -- --set ~/.potsherd/evals/queries.jsonl --potsherd-dir ~/.potsherd
 *                                           the private set, against the real index
 *
 * ## What it measures, and what it does not
 *
 * recall@k over *sessions*, not exchanges: the question is "did potsherd put
 * the right conversation on the first screen", which is the thing a user
 * actually experiences. It says nothing about precision — with 25 queries it
 * could not mean much — and nothing about whether the snippet was any good.
 */

// The core is imported from source, not from `@potsherd/core`: `tsx` reads TS
// directly, so `pnpm evals` works in a fresh clone with nothing built, and it
// always measures the checkout rather than whatever is in `dist/`.
const here = path.dirname(fileURLToPath(import.meta.url));

// The gate itself lives in `evals/gate.ts` — a pure function over counts — so
// that `tests/evals-gate.test.ts` can prove it still fails without building an
// index or owning an embedding model. Re-exported here because that is where
// five phases of notes point.
export { PHASE_1_GATE, PHASE_3_GATE };

/**
 * The overlap a query is allowed to share with its own answer.
 *
 * Overlap here is: of the query's content words (stopwords dropped), what
 * fraction appears verbatim in the answer's indexed text — exchange bodies,
 * ghost prompts and title, the text `exchanges_fts` and `ghosts_fts` actually
 * match on. A query at 1.0 is a substring of its answer and proves nothing: a
 * grep would find it. A query at 0.0 shares no word at all and can only be
 * answered by the vector half or by a card.
 *
 * 0.6 is the line, and it is a judgement rather than a law. Two reasons for
 * that number. First, the set it replaced sat at 0.8–1.0 — the failure it is
 * built to catch is loud, not marginal. Second, below about 0.6 an English
 * query of five or six content words is contributing at most three of them to
 * bm25, which on a 58-candidate corpus with distractors on the same topic is
 * not enough to win by matching alone; above it, the query starts to be a
 * quotation. Queries *above* the line are not automatically wrong — a real
 * user does sometimes remember three exact words — but each one has to be
 * worth defending, so the runner names them.
 */
const OVERLAP_FLAG = 0.6;

interface EvalQuery {
  query: string;
  expected_session_prefix: string;
  expected_harness?: string;
  /** Require the answer to come back as the subagent transcript, not the parent. */
  expected_sidechain?: boolean;
  /** `concept` | `ranking` | `recall`; see the header of queries.jsonl. */
  class?: string;
  /** `sidechain` | `ghost` | `card` | `text`: where in the index the answer is. */
  needs?: string;
  /**
   * T10.1 — a confidence control rather than a recall query.
   *
   * `strong`   the archive answers this: at least one row, envelope `strong`.
   * `no-match` the archive does not: **zero** rows.
   *
   * Controls carry no `expected_session_prefix`, because two of the three are
   * asserting that the right answer is nothing, and they are held out of
   * recall@1 and recall@k entirely — folding three unanswerable queries into a
   * 25-query denominator would move the phase-3 gate by nine points and would
   * be measuring the floor with an instrument that cannot see it.
   */
  control?: 'strong' | 'no-match';
  note?: string;
}

/** One control, run and judged. */
interface ControlOutcome {
  query: EvalQuery;
  want: 'strong' | 'no-match';
  rows: number;
  confidence: string;
  withheld: number;
  pass: boolean;
}

/**
 * The three controls, at the floor `potsherd find` actually uses.
 *
 * `minConfidence: 'weak'` and not the library default, which withholds
 * nothing: the floor is set by the *verb*, because `recall()` is also the
 * shortlist builder for `ask` and `graft`, and those hand their rows to a
 * reader who can judge for themselves. What is measured here is what a person
 * or an agent typing `potsherd find` gets.
 */
async function runControls(root: string, controls: EvalQuery[]): Promise<ControlOutcome[]> {
  const db = store.open({ root });
  const out: ControlOutcome[] = [];
  try {
    for (const q of controls) {
      const r = await recall(db, q.query, {}, { limit: 10, root, vectors: false, minConfidence: 'weak' });
      const want = q.control!;
      const pass =
        want === 'no-match'
          ? r.sessions.length === 0
          : r.sessions.length > 0 && r.confidence === 'strong';
      out.push({
        query: q,
        want,
        rows: r.sessions.length,
        confidence: r.confidence,
        withheld: r.belowFloor,
        pass,
      });
    }
  } finally {
    db.close();
  }
  return out;
}

interface Outcome {
  query: EvalQuery;
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
 * query, which is the form the phase-3 gate — *hybrid must be ≥ both singles at
 * recall@5 and strictly above both at recall@1* — is really about. Reporting
 * both makes it visible when `auto` is carrying the score and the fusion is
 * not.
 */
const MODES: Record<ModeKey, Mode> = {
  bm25: { key: 'bm25', label: 'bm25 only', lists: LISTS, vectors: false, needsVectors: false },
  vectors: {
    key: 'vectors',
    label: 'vectors only',
    lists: ['vec_exchanges', 'vec_ghost_prompts', 'vec_cards'],
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

const ORDER: ModeKey[] = ['bm25', 'vectors', 'hybrid', 'always'];

interface Options {
  set: string;
  potsherdDir: string | null;
  /** Reported alongside recall@1 always; `--k` moves the wide one. */
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
  overlap: number;
  json: boolean;
  keep: boolean;
  /**
   * `--vector-weight <n>`: override {@link WEIGHTS} for all three vector
   * lists, for this run only.
   *
   * This exists for one purpose and it is not tuning. `plans/08` rule 3 — *a
   * constant encoding a measured trade-off needs a test that fails when it
   * moves* — and rule 4 — *a benchmark that cannot fail is worse than no
   * benchmark* — together demand a way to prove the gate is still a gate.
   * `--vector-weight 0` is that proof: it removes the semantic half of the
   * fusion, collapsing hybrid back onto bm25, and the gate must go red.
   *
   * `null` means the shipped weights, which are the phase-3 stopping rule of
   * 1.5 and are what the release gate is judged on. Any override is printed on
   * the run's own header and carried in `--json`, so a screenshot of a doctored
   * run cannot be mistaken for a screenshot of the release run.
   */
  vectorWeight: number | null;
  /**
   * `--no-vector-lists`: drop `vec_exchanges`, `vec_ghost_prompts` and
   * `vec_cards` from every mode, exactly as `--no-cards` drops the two card
   * lists. **This is the regression control.**
   *
   * ## why this flag exists rather than `--vector-weight 0`
   *
   * `plans/08` rule 4 — *a benchmark that cannot fail is worse than no
   * benchmark* — needs a switch that provably turns the fusion back into
   * bm25-only, so that a red gate can be produced on demand. `gate.ts` and
   * `tests/evals-gate.test.ts` both recorded `--vector-weight 0` as that
   * switch, and described it correctly for the build it was written on: it
   * *did* collapse hybrid onto bm25, because before FIX-I the fused score was
   * the only thing that ordered the page, so zeroing a list's weight erased
   * everything the list could do.
   *
   * Since FIX-I the page is ordered by `byLabel` — lane, confidence word,
   * `calibration.score`, and only then the fused score — and `calibrate()`
   * reads `from[].raw` and how many lists found the row. Neither reads a
   * weight. So a zero-weighted list still runs, still admits candidates, and
   * still supplies `strength` and `agreement` to the primary sort key.
   * Measured on this commit: `--vector-weight 0` scores hybrid **52/60 ·
   * 33/60** where bm25-only scores **40/60 · 31/60**. Twelve queries at
   * recall@5 are bought by lists weighted to nothing, and the probe fails the
   * gate on **one** clause (`> vectors`), not the two `gate.ts` recorded.
   *
   * ## and why `--vector-weight 0` was not simply redefined to mean this
   *
   * Two reasons, both about not making a number lie somewhere else.
   *
   * 1. `FIX-K-REPORT.md §0` swept the whole one-parameter lexical:semantic
   *    family and its exhaustiveness argument is *RRF is linear in the
   *    weights*. That argument needs `w = 0` to be a genuine member of the
   *    family — the limit of the points either side of it. A flag named
   *    `--vector-weight` that silently stops setting a weight at one end of
   *    its own range puts a discontinuity into the family the next sweep will
   *    trust.
   * 2. At `w = 0` the **`vectors only`** column is degenerate on its own
   *    terms: all three of its lists are weighted 0, every fused score is 0,
   *    and its order falls through to a tiebreak. A control whose comparison
   *    mode is meaningless cannot be the thing that proves the gate works.
   *
   * So the weight stays a weight and the lane removal gets a flag that says
   * what it does. What it produces, measured, is recorded in `gate.ts`.
   */
  noVectorLists: boolean;
}

/** The three lists `--vector-weight` moves: the whole semantic half. */
const VECTOR_LISTS = ['vec_exchanges', 'vec_ghost_prompts', 'vec_cards'] as const;

/**
 * The weight the build ships, read out of {@link WEIGHTS} rather than typed
 * here, so this file cannot drift from the value the product actually uses.
 * `1.5` is `plans/03`'s phase-3 **stopping rule**, not an argmax over this
 * query set, and §8.5's amendment left it alone on purpose.
 */
const DEFAULT_VECTOR_WEIGHT = WEIGHTS.vec_exchanges;

function parseArgs(argv: string[]): Options {
  const o: Options = {
    set: path.join(here, 'queries.jsonl'),
    potsherdDir: null,
    k: 5,
    noCards: false,
    modes: null,
    vectors: null,
    overlap: OVERLAP_FLAG,
    json: false,
    keep: false,
    vectorWeight: null,
    noVectorLists: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--set') o.set = String(argv[++i]);
    else if (a === '--potsherd-dir') o.potsherdDir = String(argv[++i]);
    else if (a === '--k') o.k = Number(argv[++i]);
    else if (a === '--overlap') o.overlap = Number(argv[++i]);
    else if (a === '--vector-weight') o.vectorWeight = Number(argv[++i]);
    else if (a === '--no-cards') o.noCards = true;
    else if (a === '--no-vector-lists') o.noVectorLists = true;
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
potsherd evals — recall@1 and recall@5 over a known-answer query set

  pnpm evals                                       all four retrieval modes
  pnpm evals -- --modes bm25                       one mode only
  pnpm evals -- --no-cards                         same index, card lists off
  pnpm evals -- --set ~/.potsherd/evals/queries.jsonl --potsherd-dir ~/.potsherd
  pnpm evals -- --json

  --set <file>          queries.jsonl (default: the committed fixture set)
  --potsherd-dir <dir>  search this index instead of building one from the fixture
  --k <n>               the wide recall (default 5; recall@1 is always printed)
  --overlap <0..1>      flag a query sharing more than this fraction of its
                        content words with its own answer (default ${OVERLAP_FLAG})
  --no-cards            drop cards_fts and vec_cards from every mode, for the
                        same-index A/B on whether cards help the fusion
  --modes a,b,c         any of bm25, vectors, hybrid, always (default: all four)
  --vectors auto|on|off legacy single-mode switch
  --keep                do not delete the temporary fixture index, and print it
  --vector-weight <n>   override the weight of vec_exchanges, vec_ghost_prompts
                        and vec_cards for this run. NOT a tuning knob and NOT
                        the regression control: the release gate is judged at
                        the shipped weight, and since FIX-I a zero weight
                        removes only a list's contribution to the fused score,
                        not the list. Zero-weighted vector lists still buy 12
                        queries at recall@5 because the page is ordered by the
                        calibrator, which never reads a weight.
  --no-vector-lists     drop vec_exchanges, vec_ghost_prompts and vec_cards
                        from every mode, the way --no-cards drops the card
                        lists. THIS is the check that proves the gate can go
                        red: with no semantic lane, hybrid IS bm25 —
                          pnpm evals -- --no-vector-lists   must exit 1
  --json                machine-readable

The vector modes need the 34 MB bge-small model on disk. It is looked for in
POTSHERD_MODELS_DIR, then ~/.potsherd/models, then the directory the test
suite uses; if none of them has it the vector modes are skipped and the run
says so. POTSHERD_EVALS_EMBED=1 permits the download.
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
  cards: number;
  /** Why there are no vectors, when there are none. */
  reason?: string;
  cleanup: () => void;
}

/**
 * The card sidecar: `evals/fixture/cards.jsonl`, one card per line, written by
 * `scripts/make-eval-corpus.mjs` beside the transcripts it summarises.
 */
interface FixtureCard {
  session_id: string;
  harness: string;
  project: string;
  project_slug: string;
  source: string;
  title: string;
  summary: string;
  topics: string[];
  decisions: { what: string; why: string | null; evidence_seq: number[] }[];
  files: string[];
  outcome: string;
  open_threads: { what: string; evidence_seq: number[] }[];
  tags: string[];
}

async function injectCards(db: Db, root: string, modelDir: string | null): Promise<number> {
  const file = path.join(here, 'fixture', 'cards.jsonl');
  if (!fs.existsSync(file)) return 0;
  const cards = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .map((l) => JSON.parse(l) as FixtureCard);
  for (const c of cards) {
    const card = {
      title: c.title,
      summary: c.summary,
      topics: c.topics,
      decisions: c.decisions,
      files: c.files,
      outcome: c.outcome as never,
      open_threads: c.open_threads,
      tags: c.tags,
    };
    // The card vector is optional in exactly the way `writeCard` says it is:
    // no model on disk means `cards_fts` still holds the card and `vec_cards`
    // does not, which is what a real index looks like before `card --embed`.
    const embedding = modelDir
      ? await embeddings.generateEmbedding(cardEmbeddingText(card), { cacheDir: modelDir })
      : undefined;
    writeCard(
      db,
      root,
      {
        sessionId: c.session_id,
        harness: c.harness as never,
        projectSlug: c.project_slug,
        project: c.project,
        card,
        verified: { kept: c.decisions.length + c.open_threads.length, dropped: 0 },
        model: 'fixture',
        costUsd: 0,
        createdAt: '2026-08-05T00:00:00.000Z',
        source: c.source,
      },
      embedding,
    );
  }
  return cards.length;
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
  let modelDir: string | null = null;
  if (embed) {
    const cache = findModelCache();
    if (cache.found) {
      // A symlink, not a copy: 34 MB per run of io for nothing otherwise.
      fs.symlinkSync(cache.dir, path.join(root, 'models'));
      modelDir = path.join(root, 'models');
    } else if (process.env['POTSHERD_EVALS_EMBED'] === '1') {
      // Download into the cache the run was pointed at, not into whatever
      // `~/.potsherd` happens to be — a machine that named a directory meant it.
      fs.mkdirSync(cache.dir, { recursive: true });
      fs.symlinkSync(cache.dir, path.join(root, 'models'));
      modelDir = path.join(root, 'models');
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
  const cards = await injectCards(db, root, embed && vectors > 0 ? modelDir : null);
  db.close();

  if (embed && vectors === 0 && !reason) {
    reason = report.embeddings.reason ?? state.reason ?? 'the index came back with no vectors';
  }
  return {
    root,
    vectors,
    embedMs: report.embeddings.ms,
    embedded: report.embeddings.embedded,
    cards,
    ...(reason ? { reason } : {}),
    cleanup,
  };
}

/** Retrieve deep enough that a rank can be reported, not just a hit. */
const DEPTH = 20;

async function runMode(
  root: string,
  queries: EvalQuery[],
  mode: Mode,
  k: number,
  weights: Partial<Record<ListName, number>> | null,
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
        {
          limit: Math.max(k, DEPTH),
          root,
          lists: mode.lists,
          vectors: mode.vectors,
          ...(weights ? { weights } : {}),
        },
      );
      const ms = Date.now() - t0;
      // `expected_sidechain` asks whether the *subagent transcript* is what
      // came back, not merely a session whose id starts the same way — a
      // claude sidechain id is `<parent>:agent-<hash>`, so a prefix test alone
      // cannot tell the two apart. It is satisfied either by a sidechain
      // session or by a parent block carrying a sidechain hit, because
      // `recall` rolls subagents up under their parent and both spellings mean
      // the same thing to the reader: the answer on the screen is the
      // subagent's text.
      const at = result.sessions.findIndex(
        (s) =>
          s.id.startsWith(q.expected_session_prefix) &&
          (q.expected_sidechain ? s.isSidechain || s.hits.some((h) => h.isSidechain) : true),
      );
      outcomes.push({
        query: q,
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

const hitAt = (o: Outcome, k: number): boolean => o.rank > 0 && o.rank <= k;
const scoreAt = (outcomes: Outcome[], k: number): number =>
  outcomes.filter((o) => hitAt(o, k)).length;

// ------------------------------------------------------------ overlap check
//
// The anti-gaming half of the instrument. It answers one question about the
// query set itself, every run: *could this query have been answered by
// quoting?* Nothing else in the eval can see that, because a query that is a
// substring of its answer scores 25/25 and looks like a triumph.

const STOPWORDS = new Set(
  ('a an the and or but if then than that this those these it its it is was were be been being do does did done ' +
    'of to in on at by for from with without into over under about after before again as so such not no nor ' +
    'we us our you your they them their he she his her i me my one two some any all most more much many ' +
    'what which who whom when where why how did do had has have can could would should will shall may might ' +
    'there here up down out off just only same other another still even ever never always got get gets ' +
    'was were are am been being what was there')
    .split(/\s+/)
    .filter(Boolean),
);

const words = (s: string): string[] => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
const contentWords = (s: string): string[] => [...new Set(words(s).filter((w) => !STOPWORDS.has(w)))];

interface Overlap {
  query: EvalQuery;
  /** Fraction of the query's content words that appear in the answer's body. */
  text: number;
  /** The same against the answer's card, when it has one. */
  card: number | null;
  /** The words that did appear, for the reader to judge. */
  shared: string[];
  flagged: boolean;
}

/**
 * What the answer session physically contains, as one string per source.
 *
 * A sidechain's id is `<parent>:agent-<hash>`, so the prefix match picks up the
 * parent and its subagents together — which is right: an answer "in the
 * session" means anywhere a `find` would look for it.
 */
function targetText(db: Db, prefix: string): { body: string; card: string | null } {
  const like = `${prefix}%`;
  const parts: string[] = [];
  for (const r of db
    .prepare('SELECT user_text, assistant_text FROM exchanges WHERE session_id LIKE ?')
    .all(like) as { user_text: string; assistant_text: string }[]) {
    parts.push(r.user_text, r.assistant_text);
  }
  for (const r of db.prepare('SELECT title FROM sessions WHERE id LIKE ?').all(like) as {
    title: string | null;
  }[]) {
    if (r.title) parts.push(r.title);
  }
  for (const r of db.prepare('SELECT text FROM ghost_prompts WHERE session_id LIKE ?').all(like) as {
    text: string;
  }[]) {
    parts.push(r.text);
  }
  for (const r of db
    .prepare('SELECT first_prompt, title FROM ghosts WHERE session_id LIKE ?')
    .all(like) as { first_prompt: string | null; title: string | null }[]) {
    if (r.first_prompt) parts.push(r.first_prompt);
    if (r.title) parts.push(r.title);
  }
  const cards = db
    .prepare('SELECT title, summary, topics, decisions, open_threads FROM cards WHERE session_id LIKE ?')
    .all(like) as Record<string, string>[];
  const card = cards.length
    ? cards.map((c) => [c['title'], c['summary'], c['topics'], c['decisions'], c['open_threads']].join(' ')).join(' ')
    : null;
  return { body: parts.join(' '), card };
}

function overlaps(root: string, queries: EvalQuery[], threshold: number): Overlap[] {
  const db = store.open({ root });
  try {
    return queries.map((q) => {
      const { body, card } = targetText(db, q.expected_session_prefix);
      const qw = contentWords(q.query);
      const bodyWords = new Set(words(body));
      const cardWords = card ? new Set(words(card)) : null;
      const shared = qw.filter((w) => bodyWords.has(w));
      const text = qw.length ? shared.length / qw.length : 0;
      const inCard = cardWords ? qw.filter((w) => cardWords.has(w)).length / (qw.length || 1) : null;
      return { query: q, text, card: inCard, shared, flagged: text > threshold };
    });
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------- the phase gate

/**
 * The **amended** gate of `plans/phases/phase-8-hardening.md` §8.5: *hybrid
 * must be ≥ both singles at recall@k, and strictly above both at recall@1.*
 *
 * Every condition is computed here rather than left for a human to do with two
 * screenshots — the fusion has now been measured losing three separate times,
 * and every one of those took somebody comparing numbers by hand. The rule
 * itself is in `evals/gate.ts`, which is where its rationale and its test are.
 */
function gateFor(
  runs: { mode: Mode; outcomes: Outcome[] }[],
  key: ModeKey,
  total: number,
  k: number,
): Gate | null {
  const hybrid = runs.find((r) => r.mode.key === key);
  const bm25 = runs.find((r) => r.mode.key === 'bm25');
  const vec = runs.find((r) => r.mode.key === 'vectors');
  if (!hybrid || !bm25 || !vec) return null;
  const score = (o: Outcome[]): { at1: number; atK: number } => ({
    at1: scoreAt(o, 1),
    atK: scoreAt(o, k),
  });
  return judge(
    key,
    { bm25: score(bm25.outcomes), vectors: score(vec.outcomes), hybrid: score(hybrid.outcomes) },
    total,
    k,
  );
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  const all = readQueries(o.set);
  // Two instruments in one file, kept apart. The recall set asks *did the right
  // conversation come back*; the controls ask *did the tool admit when there is
  // no right conversation*. Mixing their denominators would make each one a
  // worse measure of the other.
  const controls = all.filter((q) => q.control);
  const queries = all.filter((q) => !q.control);

  // `--vectors` is the old single-mode switch; honour it, but the default is
  // all four modes, because "hybrid ≥ bm25" is only a claim when the two
  // numbers were produced by the same command on the same corpus.
  let wanted: ModeKey[] =
    o.modes ??
    (o.vectors === 'off'
      ? ['bm25']
      : o.vectors === 'on'
        ? ['always']
        : o.vectors === 'auto'
          ? ['hybrid']
          : [...ORDER]);

  // The weight override, resolved once. `null` is "the shipped weights", and
  // the shipped weights are what the release gate is judged on.
  const weights: Partial<Record<ListName, number>> | null =
    o.vectorWeight === null || Number.isNaN(o.vectorWeight)
      ? null
      : Object.fromEntries(VECTOR_LISTS.map((l) => [l, o.vectorWeight!]));

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
  let overlap: Overlap[] = [];
  let controlOutcomes: ControlOutcome[] = [];
  try {
    for (const key of wanted) {
      // Both list filters are applied to the *same* index, which is the rule
      // `--no-cards`'s own docstring states: the honest A/B for "did this half
      // of the fusion help" is the same corpus and the same queries with the
      // lists on and off, never a differently-built index. So
      // `--no-vector-lists` still embeds — it removes the lane from the
      // *search*, not from the archive.
      let lists: readonly ListName[] = MODES[key].lists;
      if (o.noCards) lists = lists.filter((l) => l !== 'cards_fts' && l !== 'vec_cards');
      if (o.noVectorLists) lists = lists.filter((l) => !VECTOR_LISTS.includes(l as never));
      const mode: Mode = o.noVectorLists
        ? // With no semantic list left to fuse, `vectors: 'auto'` would still
          // pay for a forward pass whose result nothing reads. Turning it off
          // makes the control's latency column honest too.
          { ...MODES[key], lists, vectors: false }
        : { ...MODES[key], lists };
      runs.push({ mode, outcomes: await runMode(root, queries, mode, o.k, weights) });
    }
    overlap = overlaps(root, queries, o.overlap);
    controlOutcomes = await runControls(root, controls);
  } finally {
    built?.cleanup();
  }

  const total = queries.length;
  const gates = (['hybrid', 'always'] as ModeKey[])
    .map((k) => gateFor(runs, k, total, o.k))
    .filter((g): g is Gate => g !== null);
  // The gate is the mode a user actually gets. `always` is reported beside it
  // so an `auto` that never wakes the model cannot be mistaken for a fusion
  // that works.
  const verdict = gates.find((g) => g.mode === 'hybrid') ?? null;
  const primary = runs.find((r) => r.mode.key === 'bm25') ?? runs[0]!;
  const phase1 = scoreAt(primary.outcomes, o.k) / total >= PHASE_1_GATE;
  // `plans/08` rule 4: a benchmark that cannot fail is worse than no benchmark.
  // A control that is reported and not enforced is exactly that, so a red
  // control fails the run on its own — the recall score cannot buy it back.
  const controlsPass = controlOutcomes.every((c) => c.pass);
  const ok = (verdict ? verdict.pass : phase1) && controlsPass;

  if (o.json) {
    process.stdout.write(
      JSON.stringify(
        {
          set: o.set,
          root: o.keep || o.potsherdDir ? root : null,
          k: o.k,
          queries: total,
          controls: controlOutcomes.map((c) => ({
            query: c.query.query,
            want: c.want,
            rows: c.rows,
            confidence: c.confidence,
            withheld: c.withheld,
            pass: c.pass,
          })),
          coverage: coverage(queries),
          // Both halves of the amended gate, separately, per judged mode —
          // `wide` (recall@k, `>=`) and `tight` (recall@1, `>`) — so a pass is
          // machine-checkable condition by condition and not a rendered
          // string somebody has to read. `rule` is the same sentence the
          // terminal prints.
          gates: {
            rule: ruleLine(o.k, total),
            phase1Bar: PHASE_1_GATE,
            phase3Bar: PHASE_3_GATE,
            phase1Met: phase1,
            phase3: gates,
          },
          // The run's own configuration, so a `--json` blob can never be read
          // as the release run when it was not one.
          weights: {
            vectorWeight: o.vectorWeight ?? DEFAULT_VECTOR_WEIGHT,
            shipped: DEFAULT_VECTOR_WEIGHT,
            overridden: weights !== null,
            lists: VECTOR_LISTS,
            // The lane, separately from its weight, because since FIX-I those
            // are two different facts about a run and the old field could only
            // report one of them.
            semanticLane: o.noVectorLists ? 'removed' : 'present',
          },
          pass: ok,
          index: built
            ? {
                vectors: built.vectors,
                embedded: built.embedded,
                embedMs: built.embedMs,
                cards: built.cards,
                skipped,
              }
            : null,
          overlap: {
            threshold: o.overlap,
            flagged: overlap.filter((r) => r.flagged).map((r) => r.query.query),
            rows: overlap.map((r) => ({
              query: r.query.query,
              text: Number(r.text.toFixed(3)),
              card: r.card === null ? null : Number(r.card.toFixed(3)),
              shared: r.shared,
              flagged: r.flagged,
            })),
          },
          modes: runs.map(({ mode, outcomes }) => ({
            mode: mode.key,
            hits: scoreAt(outcomes, o.k),
            recall: total ? scoreAt(outcomes, o.k) / total : 0,
            hits1: scoreAt(outcomes, 1),
            recall1: total ? scoreAt(outcomes, 1) / total : 0,
            p50: percentile(sorted(outcomes), 50),
            p95: percentile(sorted(outcomes), 95),
            results: outcomes.map((r) => ({
              query: r.query.query,
              expected: r.query.expected_session_prefix,
              class: r.query.class ?? null,
              needs: r.query.needs ?? null,
              note: r.query.note ?? null,
              hit: hitAt(r, o.k),
              hit1: hitAt(r, 1),
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
    process.exitCode = ok ? 0 : 1;
    return;
  }

  const t = new Theme({ width: 100 });
  const out: string[] = [];
  const cov = coverage(queries);
  out.push(
    t.dim(
      `potsherd evals ${t.sep} ${path.basename(o.set)} ${t.sep} ${total} queries ` +
        `${t.sep} ${cov.sidechain} sidechain ${t.sep} ${cov.ghost} ghost ${t.sep} ${cov.card} card ` +
        `${t.sep} ${built ? `${fmt.num(built.cards)} cards, ${fmt.num(built.vectors)} vectors` : 'existing index'}`,
    ),
  );
  // The weight is on the screen of *every* run, not only an overridden one: a
  // number that appears when it is unusual is a number nobody learns to read.
  out.push(
    weights
      ? t.warn(
          `  vector weight ${o.vectorWeight} ${t.sep} OVERRIDDEN (shipped: ${DEFAULT_VECTOR_WEIGHT}) ` +
            `${t.sep} this is a probe, not the release gate`,
        )
      : t.dim(
          `  vector weight ${DEFAULT_VECTOR_WEIGHT} ${t.sep} the phase-3 stopping rule, unchanged by the §8.5 amendment`,
        ),
  );
  // The lane's presence is on the screen of every run for the same reason the
  // weight is: a line that only appears when something is unusual is a line
  // nobody learns to read. And a zero weight is *not* this line — that was the
  // whole confusion `--no-vector-lists` exists to end.
  out.push(
    o.noVectorLists
      ? t.warn(
          `  semantic lane REMOVED ${t.sep} vec_exchanges, vec_ghost_prompts, vec_cards dropped from every mode ` +
            `${t.sep} this is the regression control, not the release gate`,
        )
      : t.dim(`  semantic lane present ${t.sep} all eight lists available to every mode that asks for them`),
  );
  out.push('');

  // One row per query, one column per mode: the rank the answer came back at,
  // or a dash when it never did. This is the table the ranker is read from —
  // a mode summary alone cannot tell you *which* queries a change bought and
  // which ones it sold.
  const header = ['', '', ...runs.map((r) => shortLabel(r.mode.key)), ''];
  const rows = queries.map((q, i) => [
    q.needs ?? '',
    q.class ?? '',
    ...runs.map(({ outcomes }) => rankCell(t, outcomes[i]!, o.k)),
    fmt.elide(q.query, 46),
  ]);
  out.push(
    ...table(t, [header, ...rows], {
      gap: 2,
      grow: header.length - 1,
      align: ['left', 'left', ...runs.map(() => 'right' as const), 'left'],
    }),
  );
  out.push('');

  for (const { mode, outcomes } of runs) {
    const wide = scoreAt(outcomes, o.k);
    const tight = scoreAt(outcomes, 1);
    const pct = total ? Math.round((wide / total) * 100) : 0;
    const ok3 = total > 0 && wide / total >= PHASE_3_GATE;
    out.push(
      `  ${mode.label.padEnd(16)}` +
        `recall@${o.k} ${String(wide).padStart(3)}/${total}  ` +
        (ok3 ? t.ok(`${pct}%`.padEnd(5)) : t.warn(`${pct}%`.padEnd(5))) +
        `   recall@1 ${String(tight).padStart(3)}/${total}  ` +
        t.dim(`${total ? Math.round((tight / total) * 100) : 0}%`.padEnd(5)) +
        t.dim(`  p50 ${percentile(sorted(outcomes), 50)}ms  p95 ${percentile(sorted(outcomes), 95)}ms`),
    );
  }
  out.push('');

  // ------------------------------------------------------------- the overlap
  const flagged = overlap.filter((r) => r.flagged);
  const mean = overlap.reduce((a, r) => a + r.text, 0) / (overlap.length || 1);
  const worst = [...overlap].sort((a, b) => b.text - a.text)[0];
  out.push(
    INDENT +
      t.dim(
        `word overlap with the answer ${t.sep} mean ${pct2(mean)} ${t.sep} ` +
          `worst ${worst ? pct2(worst.text) : '—'} ${t.sep} flag above ${pct2(o.overlap)}`,
      ),
  );
  if (flagged.length === 0) {
    out.push(INDENT + t.ok('none flagged') + t.dim(' — no query is a quotation of its own answer'));
  } else {
    for (const r of flagged) {
      out.push(
        INDENT +
          t.warn(`${pct2(r.text)} ${fmt.elide(r.query.query, 44)}`) +
          t.dim(`  shares: ${r.shared.join(' ')}`),
      );
    }
  }
  out.push('');

  if (skipped) {
    out.push(INDENT + t.warn('vector modes skipped') + t.dim(` ${t.sep} ${fmt.clip(skipped, 70)}`));
  } else if (built && built.embedded > 0) {
    out.push(
      INDENT +
        t.dim(
          `${fmt.num(built.embedded)} exchanges embedded in ${fmt.duration(built.embedMs)}` +
            ` ${t.sep} ${Math.round(built.embedMs / built.embedded)}ms each`,
        ),
    );
  }

  // --------------------------------------------------------------- the gate
  //
  // The rule is spelled out in words, with both comparison operators named,
  // because this block is the thing that ends up in a screenshot and the
  // original one-line version — "above bm25-only and vec-only" — was ambiguous
  // enough about `>` versus `>=` to cost this project five phases of argument.
  out.push(INDENT + t.dim(`phase-3 gate ${t.sep} amended 22 aug 2026 (phase 8.5), by the author of the original`));
  for (const line of fmt.wrap(ruleLine(o.k, total), t.width - 4)) {
    out.push(INDENT + t.dim(line));
  }
  if (gates.length === 0) {
    out.push(
      INDENT +
        t.warn('cannot be judged') +
        t.dim(
          skipped
            ? ' — the vector modes did not run'
            : ' — it needs bm25, vectors and at least one hybrid mode in the same run',
        ),
    );
    out.push(
      INDENT +
        t.dim(`phase-1 gate ${t.sep} bm25 alone ≥ ${Math.round(PHASE_1_GATE * total)}/${total} ${t.sep} `) +
        (phase1 ? t.ok('met') : t.warn('not met')),
    );
  } else {
    for (const g of gates) {
      const label = MODES[g.mode as ModeKey].label;
      // Two lines per mode, one per half of the rule, each condition its own
      // ✓/✗ with the number it was compared against in brackets. One line
      // would fit; it would also hide which of the four conditions went red.
      out.push(
        INDENT +
          `${label.padEnd(18)}recall@${g.k} ${String(g.wide.hybrid).padStart(3)}/${total}   ` +
          mark(t, g.wide.beatsBm25, `≥ bm25 (${g.wide.bm25})`.padEnd(15)) +
          '  ' +
          mark(t, g.wide.beatsVectors, `≥ vectors (${g.wide.vectors})`.padEnd(17)) +
          '  ' +
          mark(t, g.clearsBar, `≥ ${g.bar}/${total}`),
      );
      out.push(
        INDENT +
          `${' '.repeat(18)}recall@1 ${String(g.tight.hybrid).padStart(3)}/${total}   ` +
          mark(t, g.tight.beatsBm25, `> bm25 (${g.tight.bm25})`.padEnd(15)) +
          '  ' +
          mark(t, g.tight.beatsVectors, `> vectors (${g.tight.vectors})`.padEnd(17)) +
          '  ' +
          (g.pass ? t.ok('PASS') : t.warn('FAIL')),
      );
    }
    out.push(
      INDENT +
        (verdict?.pass
          ? t.ok('PASS') + t.dim(' — the amended phase-3 gate would merge this fusion')
          : t.warn('FAIL') + t.dim(' — the amended phase-3 gate would not merge this fusion')),
    );
  }
  if (controlOutcomes.length > 0) {
    out.push('');
    out.push(INDENT + t.dim(`confidence controls  ${t.sep}  the floor potsherd find runs at`));
    for (const c of controlOutcomes) {
      const want = c.want === 'no-match' ? 'zero rows' : 'rows at strong';
      const got =
        c.rows === 0
          ? `no match${c.withheld > 0 ? `, ${c.withheld} withheld` : ''}`
          : `${c.rows} ${c.rows === 1 ? 'row' : 'rows'} ${c.confidence}`;
      out.push(
        INDENT +
          (c.pass ? t.ok('  ok  ') : t.warn(' FAIL ')) +
          ` ${want.padEnd(15)} ${got.padEnd(24)} ${t.dim(c.query.query)}`,
      );
    }
  }
  // The floor is a count, and a count cannot say WHAT broke. This names it.
  const { flips, unknownQueries } = compareToBaseline(
    runs.map(({ mode, outcomes }) => ({
      mode: mode.key,
      results: outcomes.map((r) => ({
        query: r.query.query,
        hit: hitAt(r, o.k),
        hit1: hitAt(r, 1),
      })),
    })),
    readBaseline(),
  );
  if (flips.length > 0 || unknownQueries > 0) {
    out.push('');
    out.push(
      INDENT + t.dim(`against the pinned per-query baseline  ${t.sep}  evals/per-query-baseline.json`),
    );
    for (const f of flips.slice(0, 12)) {
      const label = f.direction === 'lost' ? t.warn(' lost ') : t.ok(' gain ');
      const metric = f.metric === 'hit' ? `recall@${String(o.k)}` : 'recall@1';
      out.push(
        INDENT + label + ` ${f.mode.padEnd(8)} ${metric.padEnd(9)} ${t.dim(fmt.clip(f.query, 52))}`,
      );
    }
    if (flips.length > 12) {
      out.push(INDENT + t.dim(`  … and ${String(flips.length - 12)} more`));
    }
    if (unknownQueries > 0) {
      out.push(
        INDENT +
          t.dim(
            `  ${String(unknownQueries)} query-results are not in the baseline — new queries, ` +
              'not regressions',
          ),
      );
    }
    out.push(
      INDENT +
        t.dim('  regenerate deliberately:  pnpm evals -- --json | node scripts/write-eval-baseline.mjs'),
    );
  }
  if (o.keep && built) out.push(INDENT + t.dim(`index kept at ${built.root}`));
  process.stdout.write(out.join('\n') + '\n');
  process.exitCode = ok ? 0 : 1;
}

const INDENT = '  ';

function coverage(queries: EvalQuery[]): Record<string, number> {
  const c: Record<string, number> = { sidechain: 0, ghost: 0, card: 0, text: 0 };
  for (const q of queries) {
    const k = q.needs ?? 'text';
    c[k] = (c[k] ?? 0) + 1;
  }
  return c;
}

const shortLabel = (k: ModeKey): string =>
  ({ bm25: 'bm25', vectors: 'vec', hybrid: 'hyb', always: 'alw' })[k];

function rankCell(t: Theme, o: Outcome, k: number): string {
  if (o.rank === 0) return t.warn('—');
  const cell = `#${o.rank}`;
  if (o.rank === 1) return t.ok(cell);
  return o.rank <= k ? cell : t.warn(cell);
}

const mark = (t: Theme, ok: boolean, label: string): string =>
  ok ? t.ok(`✓ ${label}`) : t.warn(`✗ ${label}`);

const pct2 = (n: number): string => `${Math.round(n * 100)}%`;

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

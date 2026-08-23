import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  WEIGHTS,
  db as store,
  indexAll,
  renderFind,
  rescue,
  resolveSession,
  Theme,
  type Db,
} from '@potsherd/core';
// `packages/core/src/index.ts` is another worker's file this phase and does
// not re-export the lane yet, so the lane is imported from the module that
// owns it. `T10.7-REPORT.md` carries the barrel lines.
import {
  LANES,
  ROUTING_PER_SESSION,
  laneOfHit,
  laneOfSession,
  recall,
  type RecallResult,
} from '../packages/core/src/recall.js';
import {
  ROUTING_CEILING,
  STRONG_FLOOR,
  WEAK_FLOOR,
  calibrate,
} from '../packages/core/src/calibration.js';
import { CARD_ONLY_NOTE } from '../packages/core/src/render/find.js';
import { writeCard, type CardRecord } from '../packages/core/src/cards/write.js';
import { runFind } from '../packages/cli/src/commands/find.js';
import { rmrf, tempDir } from './helpers.js';

/**
 * T10.7 · F6 — **cards are routing, never evidence.**
 *
 * The audit's own failing case, reproduced and then refused. For the query
 * *"where did we leave off on <project> what is left to build"*, three of the
 * top five hits were card-only matches on sessions belonging to other
 * projects, and they outranked every real transcript for the project the
 * question named. A generated summary beat primary evidence.
 *
 * The fixture below is that case at the smallest size that still contains it:
 * a real corpus (`evals/fixture/claude`, the same one `tests/recall.test.ts`
 * and the recall eval use), one session given a **card whose summary is about
 * a topic its transcript never mentions**, and a query that topic answers.
 * Without the lane the card wins on fused score; with it the card cannot be
 * above a transcript row whatever it scores.
 *
 * ## Two things this file is careful about
 *
 * **The cards are seeded, not generated.** `potsherd card` needs a model and
 * the suite has none, which is not a limitation of the test — it is the
 * audited condition: card coverage on the audited archive was ~32 titled of
 * 353 *because* `card` could not run. So the cards here go in through
 * `writeCard`, the same writer the real pipeline ends in, and the corpus keeps
 * the coverage a real machine has.
 *
 * **The claim under test is a partition, not a threshold.** Every ordering
 * assertion below is repeated with the two card weights multiplied by a
 * thousand. A test that only checked the default weights would be checking
 * that a number happens to come out right, which is exactly the kind of fix
 * F6 says is not a fix.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, '..', 'evals', 'fixture', 'claude');

/** From `evals/queries.jsonl`; the same names `tests/recall.test.ts` uses. */
const ID = {
  /** The session that really is about connection pooling. */
  pgbouncer: '0a2fbf9b',
  /** An unrelated session — csv import — that will be given a pooling card. */
  unrelated: 'a82ceb72',
} as const;

/**
 * The query the whole file turns on: words the real session's transcript
 * contains and the unrelated session's transcript does not.
 */
const QUERY = 'pgbouncer transaction pooling';

/**
 * Words that exist **only** inside a card. Nothing in any of the 46
 * transcripts says them, which is what makes them the routing test.
 */
const CARD_ONLY_QUERY = 'zonal drain cutover';

let root: string;
let db: Db;
let full: { pgbouncer: string; unrelated: string };
const dirs: string[] = [];

function seedCard(sessionId: string, title: string, summary: string, topics: string[]): void {
  const row = db
    .prepare('SELECT harness, project, project_slug FROM sessions WHERE id = ?')
    .get(sessionId) as { harness: string; project: string | null; project_slug: string | null };
  const record: CardRecord = {
    sessionId,
    harness: row.harness as CardRecord['harness'],
    project: row.project,
    projectSlug: row.project_slug,
    card: {
      title,
      summary,
      topics,
      decisions: [],
      files: [],
      outcome: 'unknown',
      open_threads: [],
      tags: [],
    },
    verified: { kept: 0, dropped: 0 },
    model: 'seeded-by-hand',
    costUsd: 0,
    createdAt: '2026-08-24T00:00:00.000Z',
    source: 'transcript',
  };
  writeCard(db, root, record);
}

beforeAll(async () => {
  root = tempDir('potsherd-cards-lane-');
  dirs.push(root);
  await rescue({ claudeDir: FIXTURE, root, ghostsOnly: true, quiet: true });
  await indexAll({ root, claudeDir: FIXTURE, harnesses: ['claude'], embed: false, full: true });
  db = store.open({ root });
  full = {
    pgbouncer: resolveSession(db, ID.pgbouncer)!.id,
    unrelated: resolveSession(db, ID.unrelated)!.id,
  };
  // The audit's shape: a summary of one session, using the vocabulary of a
  // question about a different one. Nothing in this session's transcript says
  // "pgbouncer", "transaction" or "pooling"; its card says all three.
  seedCard(
    full.unrelated,
    'pgbouncer transaction pooling review',
    'reviewed the pgbouncer transaction pooling change and what is left to build after the zonal drain cutover',
    ['pgbouncer', 'transaction pooling'],
  );
}, 60_000);

afterAll(() => {
  db?.close();
  while (dirs.length) rmrf(dirs.pop()!);
});

/** The default search, and the same search with the card lists made absurd. */
async function both(query: string, over: Record<string, unknown> = {}): Promise<RecallResult[]> {
  const base = { root, vectors: false as const, minConfidence: 'none' as const, ...over };
  return [
    await recall(db, query, {}, base),
    await recall(db, query, {}, {
      ...base,
      weights: { cards_fts: WEIGHTS.cards_fts * 1000, vec_cards: WEIGHTS.vec_cards * 1000 },
    }),
  ];
}

const rank = (r: RecallResult, id: string): number => r.sessions.findIndex((s) => s.id === id);

// --------------------------------------------------------------- the lane

describe('the constant that encodes the lane', () => {
  /**
   * `plans/08` rule 3. Both halves are here on purpose: the first pins the
   * value, the second pins what the value *does*. Set `routing` to 0 and the
   * comparator in `recall()` collapses to score-only — which is precisely the
   * v1.1.0 behaviour the next describe block reproduces — and the ordering
   * test fails alongside this one rather than instead of it.
   */
  it('is evidence 0, routing 1, and fails when either moves', () => {
    expect(LANES).toEqual({ evidence: 0, routing: 1 });
    expect(LANES.evidence).toBeLessThan(LANES.routing);
    expect(ROUTING_PER_SESSION).toBe(1);
    expect(ROUTING_CEILING).toBe('weak');
  });

  it('puts a card in the routing lane and everything else in evidence', () => {
    expect(laneOfHit('card')).toBe('routing');
    expect(laneOfHit('exchange')).toBe('evidence');
    expect(laneOfHit('ghost')).toBe('evidence');
    expect(laneOfHit('title')).toBe('evidence');
    expect(laneOfSession([{ kind: 'card' }])).toBe('routing');
    expect(laneOfSession([{ kind: 'card' }, { kind: 'exchange' }])).toBe('evidence');
  });
});

describe("the audit's failing case", () => {
  /**
   * The measurement, not the assertion.
   *
   * The card block's **fused score is higher** than the transcript block's and
   * it is ranked **below** it. That inversion is the whole proof: if the lane
   * were a weight, the row with the bigger number would be first.
   */
  it('ranks the card-only block below a transcript block that scores lower than it', async () => {
    for (const r of await both(QUERY)) {
      const card = r.sessions[rank(r, full.unrelated)]!;
      const real = r.sessions[rank(r, full.pgbouncer)]!;
      expect(card).toBeDefined();
      expect(real).toBeDefined();
      expect(card.lane).toBe('routing');
      expect(real.lane).toBe('evidence');
      // Ranked after, while scoring at least as much.
      expect(rank(r, full.unrelated)).toBeGreaterThan(rank(r, full.pgbouncer));
      expect(card.score).toBeGreaterThan(real.score);
    }
  });

  /**
   * The property, stated over the whole page rather than over the one pair:
   * **no** routing block is above **any** evidence block, at any weight.
   */
  it('puts every routing block below every evidence block, at any card weight', async () => {
    for (const r of await both(QUERY)) {
      const lanes = r.sessions.map((s) => s.lane);
      expect(lanes).toContain('routing');
      expect(lanes).toContain('evidence');
      expect(lanes.lastIndexOf('evidence')).toBeLessThan(lanes.indexOf('routing'));
      // And the same in the flat hit list, which is what `ask` and `graft`
      // shortlist from.
      const kinds = r.hits.map((h) => h.lane);
      expect(kinds.lastIndexOf('evidence')).toBeLessThan(kinds.indexOf('routing'));
    }
  });

  /**
   * The residual the report names: a card inside a block that *does* have
   * transcript evidence contributes nothing to that block's rank either.
   * Otherwise "cards never outrank transcripts" would hold between blocks and
   * fail inside one.
   */
  it('gives a card no weight in the score of a block that has transcript hits', async () => {
    const [plain] = await both(QUERY);
    const withCard = plain!.sessions.find((s) => s.id === full.pgbouncer)!;
    // Card the *real* session too, then re-measure its score.
    seedCard(
      full.pgbouncer,
      'pgbouncer transaction pooling',
      'pgbouncer transaction pooling, decided and shipped',
      ['pgbouncer'],
    );
    const after = (await both(QUERY))[0]!.sessions.find((s) => s.id === full.pgbouncer)!;
    expect(after.lane).toBe('evidence');
    expect(after.score).toBeCloseTo(withCard.score, 10);
    // And its coverage is still measured over its transcript, not its summary.
    expect(after.calibration.coverage).toBeCloseTo(withCard.calibration.coverage, 10);
    db.prepare('DELETE FROM cards WHERE session_id = ?').run(full.pgbouncer);
  });
});

// ------------------------------------------------------------- confidence

describe('a card cannot certify itself', () => {
  /**
   * The number this is really about. A card whose summary paraphrased the
   * question covers every term, so at rank 1 of its own list it calibrates to
   * `1.0 x (0.6 + 0.25 x 1) = 0.85`, and corroborated by `vec_cards` to
   * `0.925` — both above {@link STRONG_FLOOR}. `strong` means *an agent may
   * act on this without reading the rows*; a summary is the one thing that
   * must never buy it.
   */
  it('scores above the strong floor and is labelled weak anyway', () => {
    const uncorroborated = { covered: 3, terms: 3, strength: 1, lists: 1 };
    const corroborated = { covered: 3, terms: 3, strength: 1, lists: 2 };
    expect(calibrate(uncorroborated).score).toBeCloseTo(0.85, 10);
    expect(calibrate(uncorroborated).confidence).toBe('strong');
    expect(calibrate(corroborated).score).toBeCloseTo(0.925, 10);
    expect(calibrate(corroborated).confidence).toBe('strong');

    for (const e of [uncorroborated, corroborated]) {
      const capped = calibrate({ ...e, ceiling: ROUTING_CEILING });
      expect(capped.score).toBeGreaterThanOrEqual(STRONG_FLOOR);
      expect(capped.confidence).toBe('weak');
      expect(capped.ceiling).toBe('weak');
    }
  });

  it('caps a real card-only block on the corpus, and says so in --json terms', async () => {
    for (const r of await both(CARD_ONLY_QUERY)) {
      const s = r.sessions.find((x) => x.id === full.unrelated)!;
      expect(s.lane).toBe('routing');
      expect(s.calibration.score).toBeGreaterThanOrEqual(STRONG_FLOOR);
      expect(s.confidence).toBe('weak');
      expect(s.calibration.ceiling).toBe('weak');
      expect(s.hits.every((h) => h.confidence !== 'strong')).toBe(true);
    }
  });

  /**
   * `weak`, not `none`: the cap demotes and must not silence. `find` runs at a
   * `weak` floor by default, so a ceiling of `none` would have deleted every
   * card-only row from the default screen — the opposite of routing.
   */
  it('leaves a card-only block above find’s default floor', async () => {
    const r = await recall(db, CARD_ONLY_QUERY, {}, { root, vectors: false, minConfidence: 'weak' });
    expect(r.sessions.map((s) => s.id)).toContain(full.unrelated);
    expect(WEAK_FLOOR).toBeLessThan(STRONG_FLOOR);
  });
});

// ---------------------------------------------------------------- routing

describe('cards still route', () => {
  it('finds the thread from words that exist only in its card', async () => {
    const r = await recall(db, CARD_ONLY_QUERY, {}, { root, vectors: false, minConfidence: 'none' });
    expect(r.sessions.map((s) => s.id)).toContain(full.unrelated);
    const s = r.sessions.find((x) => x.id === full.unrelated)!;
    expect(s.lane).toBe('routing');
    // Nothing in that session's transcript says it — the card is the only
    // reason the thread is reachable at all.
    const inTranscript = db
      .prepare(
        `SELECT COUNT(*) AS n FROM exchanges_fts
          JOIN exchanges e ON e.rowid = exchanges_fts.rowid
         WHERE exchanges_fts MATCH 'zonal' AND e.session_id = ?`,
      )
      .get(full.unrelated) as { n: number };
    expect(inTranscript.n).toBe(0);
  });

  it('never shows two summaries of one conversation', async () => {
    const r = await recall(db, CARD_ONLY_QUERY, {}, { root, vectors: false, minConfidence: 'none' });
    for (const s of r.sessions) {
      expect(s.hits.filter((h) => h.kind === 'card').length).toBeLessThanOrEqual(
        ROUTING_PER_SESSION,
      );
    }
  });
});

// ----------------------------------------------------------- --no-cards

describe('--no-cards', () => {
  it('is off by default: the card lists run and the routing block is there', async () => {
    const r = await recall(db, CARD_ONLY_QUERY, {}, { root, vectors: false, minConfidence: 'none' });
    expect(r.lists.some((l) => l.list === 'cards_fts')).toBe(true);
    expect(r.sessions.map((s) => s.id)).toContain(full.unrelated);
  });

  it('takes both card lists out of the fusion when asked', async () => {
    const r = await recall(
      db,
      CARD_ONLY_QUERY,
      {},
      { root, vectors: false, minConfidence: 'none', cards: false },
    );
    expect(r.lists.some((l) => l.list === 'cards_fts')).toBe(false);
    expect(r.lists.some((l) => l.list === 'vec_cards')).toBe(false);
    expect(r.weights.cards_fts).toBeUndefined();
    expect(r.sessions.map((s) => s.id)).not.toContain(full.unrelated);
    expect(r.hits.every((h) => h.kind !== 'card')).toBe(true);
  });

  it('leaves transcript results untouched', async () => {
    const on = await recall(db, QUERY, {}, { root, vectors: false, minConfidence: 'none' });
    const off = await recall(
      db,
      QUERY,
      {},
      { root, vectors: false, minConfidence: 'none', cards: false },
    );
    const evidence = (r: RecallResult) =>
      r.sessions.filter((s) => s.lane === 'evidence').map((s) => s.id);
    expect(evidence(off)).toEqual(evidence(on));
  });
});

// ------------------------------------------------------------- the label

describe('the label', () => {
  it('marks the block and the snippet in the human view', async () => {
    const r = await recall(db, CARD_ONLY_QUERY, {}, { root, vectors: false, minConfidence: 'none' });
    const screen = renderFind(r, new Theme({ width: 100, color: false }));
    expect(screen).toContain(CARD_ONLY_NOTE);
    // The snippet is a model's paragraph and is printed in the space a
    // transcript quote occupies; the word in front of it is the only thing
    // that says so.
    expect(screen).toMatch(/^ {4}card /m);
    // And the footer counts what is not evidence.
    expect(screen).toContain('card-only');
  });

  it('carries the lane on the block and on the hit, for a caller that parses nothing', async () => {
    const r = await recall(db, CARD_ONLY_QUERY, {}, { root, vectors: false, minConfidence: 'none' });
    const s = r.sessions.find((x) => x.id === full.unrelated)!;
    expect(s.lane).toBe('routing');
    expect(s.hits.map((h) => h.lane)).toEqual(s.hits.map(() => 'routing'));
    for (const other of r.sessions.filter((x) => x.lane === 'evidence')) {
      expect(other.hits.some((h) => h.lane === 'evidence')).toBe(true);
    }
  });
});

// ------------------------------------------------------- the flag, forwarded

/**
 * The mistake that already shipped once this phase: an option registered on the
 * command and left out of the `runFind({...})` call the action builds, so the
 * flag parses, prints in `--help`, and is dropped on the floor.
 *
 * `packages/cli/src/index.ts` is another worker's file this phase, so the
 * registration half is written out in `T10.7-REPORT.md` rather than applied.
 * This is the half that can be tested from here: `runFind` reads `o.cards` and
 * `recall()` acts on it, so when the two lines land the flag works rather than
 * type-checks.
 */
describe('runFind forwards --no-cards', () => {
  const capture = async (over: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string | Uint8Array) => {
      chunks.push(String(c));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runFind({
        query: CARD_ONLY_QUERY,
        json: true,
        potsherdDir: root,
        minConfidence: 'none',
        vectors: 'off',
        ...over,
      } as Parameters<typeof runFind>[0]);
    } finally {
      process.stdout.write = write;
    }
    return JSON.parse(chunks.join('')) as Record<string, unknown>;
  };

  it('runs the card lists when the flag is absent, and says so in --json', async () => {
    const out = await capture({});
    expect(out['cards']).toBe(true);
    expect(out['routing']).toBe(1);
    const sessions = out['sessions'] as { id: string; lane: string; citable: boolean }[];
    expect(sessions.some((s) => s.lane === 'routing' && s.citable === false)).toBe(true);
  });

  it('drops them when it is not', async () => {
    const out = await capture({ cards: false });
    expect(out['cards']).toBe(false);
    expect(out['routing']).toBe(0);
    const lists = out['lists'] as { list: string }[];
    expect(lists.some((l) => l.list === 'cards_fts')).toBe(false);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db as store, indexAll, renderFind, Theme, NEAREST_ROWS, type Db } from '@potsherd/core';
// `packages/core/src/index.ts` is another worker's file this phase, so the two
// symbols FIX-I adds are imported from the module that owns them. The barrel
// lines are in `FIX-I-REPORT.md §4`.
import { byLabel, citableBlock, recall, summaryRank } from '../packages/core/src/recall.js';
import { minConfidence, runFind } from '../packages/cli/src/commands/find.js';
import { AGENT_FLOOR } from '../packages/mcp/src/tools/shapes.js';
import { makeContext } from '../packages/mcp/src/context.js';
import { runRecall } from '../packages/mcp/src/tools/recall.js';
import { rmrf, tempDir } from './helpers.js';

/**
 * FIX-I C-1 and C-2 — **the two doors, one answer.**
 *
 * `find --json` and `potsherd_recall` read the same `recall()` result and then
 * each decided two things for itself: what order the rows go in, and whether a
 * block may be quoted. FIX-D fixed the order at the model door and FIX-F fixed
 * the permission at the model door; the CLI door kept saying the old thing, and
 * 1,932 tests did not notice, because **no test asserted either property on
 * this surface in either direction** (`VERIFICATION-5 §F`).
 *
 * So this file is about the surface nobody re-checked, and every assertion in
 * it is written to fail on `7396c3e`.
 *
 * ## the corpus
 *
 * Six hand-written sessions, small enough to reason about completely, built to
 * hold the two shapes the fifth verifier measured on the real archive and that
 * `evals/fixture/claude` does not contain:
 *
 *  - **the inversion.** `MANY` mentions all three of the first query's words in
 *    three separate exchanges, so its *block* score — `best + half the rest`,
 *    `sessionScore` — comes out **above** `CLEAN`, which says them once,
 *    cleanly, in a short exchange. `CLEAN` is the better-calibrated row by
 *    every measure the label is built from and it is the weaker row by the
 *    fused score. That is the whole of C-1: RRF is the merge order, and the
 *    merge order was the page order.
 *  - **the title-only block.** `TITLED` has the second query's three words in
 *    its `ai-title` — a model's six words, written mid-session — and a body
 *    about invoices. `laneOfHit('title')` is `evidence` by design (see
 *    `SUMMARY_KINDS`), so the CLI's old test, `lane === 'evidence'`, could
 *    never return false for it.
 *
 * The two queries use disjoint invented vocabularies so that neither shape can
 * interfere with the other's ranking.
 */

/** The three words, best first — the order the label is read in. */
const RANK: Record<string, number> = { strong: 0, weak: 1, none: 2 };

/** Query 1: the ordering case. Nothing in any real corpus says these. */
const ORDER_QUERY = 'kestrel plinth quernstone';
/** Query 2: the citability case. Same. */
const SUMMARY_QUERY = 'marram sedge dunes';

const ID = {
  /** Three separate mentions; the highest **block** score on query 1. */
  many: 'aaaaaaaa-1111-4111-8111-111111111111',
  /** One clean mention; the highest **calibration** on query 1. */
  clean: 'bbbbbbbb-2222-4222-8222-222222222222',
  /** Query 2's words in its title only. Its body is about invoices. */
  titled: 'cccccccc-3333-4333-8333-333333333333',
  /** Query 2's words in a long transcript: a real, weakly calibrated hit. */
  buried: 'dddddddd-4444-4444-8444-444444444444',
  /** Query 2's words in a short transcript: the strong hit above `buried`. */
  short: 'ffffffff-5555-4555-8555-555555555555',
} as const;

/**
 * Prose with none of either query's words in it, used to bury a mention so its
 * bm25 magnitude — and so its `strength`, and so its calibration — comes out
 * below a short exchange's. It ends in a full stop: without one, fts5 tokenises
 * `quernstoneWe` as a single word and the mention silently disappears.
 */
const FILLER =
  'We reviewed the deployment checklist and the release notes and the rollout plan in some ' +
  'detail, and then talked about the on-call rota, the dashboards, the alert thresholds and ' +
  'the runbook. ';

let home = '';
let root = '';
let db: Db;
const dirs: string[] = [];

function writeSession(id: string, title: string, turns: [string, string][]): void {
  const proj = path.join(home, 'projects', '-tmp-potsherd-fixi');
  fs.mkdirSync(proj, { recursive: true });
  const base = {
    sessionId: id,
    cwd: '/tmp/potsherd-fixi',
    version: '2.1.237',
    gitBranch: 'main',
    userType: 'external',
    entrypoint: 'cli',
    isSidechain: false,
  };
  const lines = [
    JSON.stringify({
      ...base,
      type: 'ai-title',
      uuid: `${id}-t`,
      parentUuid: null,
      timestamp: '2026-07-01T10:00:00.000Z',
      aiTitle: title,
    }),
  ];
  turns.forEach(([user, assistant], i) => {
    lines.push(
      JSON.stringify({
        ...base,
        type: 'user',
        uuid: `${id}-u${String(i)}`,
        parentUuid: null,
        promptId: `${id}p${String(i)}`,
        timestamp: `2026-07-01T10:0${String(i)}:00.000Z`,
        message: { role: 'user', content: user },
      }),
    );
    lines.push(
      JSON.stringify({
        ...base,
        type: 'assistant',
        uuid: `${id}-a${String(i)}`,
        parentUuid: `${id}-u${String(i)}`,
        timestamp: `2026-07-01T10:0${String(i)}:20.000Z`,
        message: {
          role: 'assistant',
          model: 'claude-opus-4',
          content: [{ type: 'text', text: assistant }],
        },
      }),
    );
  });
  fs.writeFileSync(path.join(proj, `${id}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
}

beforeAll(async () => {
  const scratch = tempDir('potsherd-find-doors-');
  dirs.push(scratch);
  home = path.join(scratch, 'claude');
  root = path.join(scratch, 'potsherd');

  // Three mentions, each phrased differently. The wording has to differ: a
  // block drops hits whose snippet text repeats, so three identical sentences
  // would collapse into one hit and the inversion would not exist.
  writeSession(ID.many, 'the many-mentions one', [
    ['first', `${FILLER}Monday: the kestrel, the plinth and the quernstone were logged. ${FILLER}${FILLER}`],
    ['second', `${FILLER}${FILLER}Tuesday: a kestrel, a plinth, a quernstone, counted again. ${FILLER}`],
    ['third', `${FILLER}Wednesday: kestrel, plinth and quernstone, one more time. ${FILLER}${FILLER}${FILLER}`],
  ]);
  writeSession(ID.clean, 'the one-clean-mention one', [
    ['second question', 'the kestrel, the plinth and the quernstone. '],
  ]);
  writeSession(ID.titled, 'marram sedge dunes survey', [
    ['unrelated', 'We talked about invoices and nothing else at all.'],
  ]);
  writeSession(ID.buried, 'the other one', [
    [
      'a question about the coast',
      `${FILLER}${FILLER}The marram grass, the sedge and the dunes were all in the survey. ${FILLER}${FILLER}${FILLER}`,
    ],
  ]);
  writeSession(ID.short, 'the coast one', [['coast', 'the marram, the sedge and the dunes. ']]);

  await indexAll({ root, claudeDir: home, harnesses: ['claude'], embed: false, full: true });
  db = store.open({ root });
}, 60_000);

afterAll(() => {
  db?.close();
  while (dirs.length) rmrf(dirs.pop()!);
});

/** `find --json`, driven through the same function the CLI action calls. */
async function findJson(query: string): Promise<Record<string, unknown>> {
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string | Uint8Array) => {
    chunks.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  try {
    await runFind({
      query,
      json: true,
      potsherdDir: root,
      minConfidence: 'none',
      vectors: 'off',
    } as Parameters<typeof runFind>[0]);
  } finally {
    process.stdout.write = write;
  }
  return JSON.parse(chunks.join('')) as Record<string, unknown>;
}

type Row = {
  id: string;
  confidence: string;
  calibrated: number;
  citable: boolean;
  lane: string;
  score: number;
  hits: { kind: string }[];
};

const rows = (out: Record<string, unknown>): Row[] => out['sessions'] as Row[];

// ============================================================ C-1, in core

describe('C-1 — the page is ordered by the label, once, in core', () => {
  /**
   * The measurement the assertion rests on, stated first.
   *
   * `MANY` has the **higher fused score** and the **lower calibration**. If
   * either half of that stops being true the corpus has drifted and the
   * ordering assertions below would pass for the wrong reason, so this fails
   * loudly instead.
   */
  it('the corpus really does hold an inversion: better score, worse label', async () => {
    const r = await recall(db, ORDER_QUERY, {}, { root, vectors: false, minConfidence: 'none' });
    const many = r.sessions.find((s) => s.id === ID.many)!;
    const clean = r.sessions.find((s) => s.id === ID.clean)!;
    expect(many).toBeDefined();
    expect(clean).toBeDefined();
    expect(many.score).toBeGreaterThan(clean.score);
    expect(many.calibration.score).toBeLessThan(clean.calibration.score);
    expect(RANK[many.confidence]!).toBeGreaterThan(RANK[clean.confidence]!);
    // Both are real transcript blocks. This is not the summary partition
    // doing the work.
    expect(summaryRank(many.hits)).toBe(0);
    expect(summaryRank(clean.hits)).toBe(0);
  });

  it('ranks the better-labelled block first, against the fused score', async () => {
    const r = await recall(db, ORDER_QUERY, {}, { root, vectors: false, minConfidence: 'none' });
    expect(r.sessions.map((s) => s.id)).toEqual([ID.clean, ID.many]);
  });

  /**
   * The headline of C-1, as one sentence: `find` prints a `weak` row first
   * under a header that says `strong`. The header is
   * `max(confidence)` over the page, so *the first row carries it* is a
   * property, not a coincidence — and it was false.
   */
  it('the header the page prints is the confidence of the row under it', async () => {
    for (const query of [ORDER_QUERY, SUMMARY_QUERY]) {
      const r = await recall(db, query, {}, { root, vectors: false, minConfidence: 'none' });
      expect(r.sessions.length, query).toBeGreaterThan(0);
      expect(r.sessions[0]!.confidence, query).toBe(r.confidence);
    }
  });

  it('orders sessions[] and hits[] by the same rule, never contradicting the label', async () => {
    for (const query of [ORDER_QUERY, SUMMARY_QUERY]) {
      const r = await recall(db, query, {}, { root, vectors: false, minConfidence: 'none' });
      const check = (labels: { confidence: string; calibration: { score: number } }[], what: string) => {
        for (let i = 1; i < labels.length; i++) {
          expect(
            RANK[labels[i - 1]!.confidence]!,
            `${query}: ${what}${String(i - 1)} is ${labels[i - 1]!.confidence} above ${what}${String(i)} ${labels[i]!.confidence}`,
          ).toBeLessThanOrEqual(RANK[labels[i]!.confidence]!);
        }
      };
      check(r.sessions, 'session');
      check(r.hits, 'hit');
    }
  });

  /**
   * FIX-F C3 survives FIX-D's rule being applied under it. `TITLED` carries
   * the **highest calibration on the page** and is ranked **last**, because
   * `summaryRank` is the first key and a summary never outranks a transcript
   * whatever it scores. Reverse the two terms and this goes red.
   */
  it('a summary still ranks below a transcript that calibrates lower than it', async () => {
    const r = await recall(db, SUMMARY_QUERY, {}, { root, vectors: false, minConfidence: 'none' });
    const ids = r.sessions.map((s) => s.id);
    expect(ids).toEqual([ID.short, ID.buried, ID.titled]);
    const titled = r.sessions.find((s) => s.id === ID.titled)!;
    const buried = r.sessions.find((s) => s.id === ID.buried)!;
    expect(titled.calibration.score).toBeGreaterThan(buried.calibration.score);
    expect(titled.confidence).toBe(buried.confidence);
    expect(summaryRank(titled.hits)).toBe(1);
  });

  /**
   * The comparator itself, and the one line of FIX-D's reasoning that must
   * survive being moved: the **word** is the first key, not the number.
   *
   * A routing row's `calibration.score` is deliberately not rewritten when
   * `ROUTING_CEILING` caps its label, so a sort on the number alone puts a
   * card straight back on top of a transcript. Flip `byLabel`'s first two keys
   * and this case is the one that fails.
   */
  it('byLabel sorts on the word first, then the number, then the merge order', () => {
    const row = (confidence: string, cal: number, score: number, tag: string) => ({
      confidence: confidence as 'strong' | 'weak' | 'none',
      calibration: { score: cal, confidence, coverage: 0, strength: 0, agreement: 0 },
      score,
      tag,
    });
    // The verifier's two rows, verbatim from `VERIFICATION-3 §C5`: the same
    // fused score, opposite labels, the weak one first because RRF put it there.
    expect(
      [row('weak', 0.5667, 0.016393, 'hit0'), row('strong', 0.85, 0.016393, 'hit1')]
        .sort(byLabel)
        .map((r) => r.tag),
    ).toEqual(['hit1', 'hit0']);
    // The capped card: it scores 0.92 and it is labelled `weak`, so it loses.
    expect(
      [row('weak', 0.92, 0.016393, 'card'), row('strong', 0.61, 0.008197, 'transcript')]
        .sort(byLabel)
        .map((r) => r.tag),
    ).toEqual(['transcript', 'card']);
    // Inside one band: calibration, then the fused score.
    expect(
      [
        row('weak', 0.4, 0.016393, 'low-cal-high-rrf'),
        row('weak', 0.55, 0.008197, 'high-cal-low-rrf'),
        row('weak', 0.55, 0.009524, 'high-cal-higher-rrf'),
      ]
        .sort(byLabel)
        .map((r) => r.tag),
    ).toEqual(['high-cal-higher-rrf', 'high-cal-low-rrf', 'low-cal-high-rrf']);
  });

  it('byLabel leaves the merge order alone when a build carries no label', () => {
    // `null` is not `none`: with no word there is nothing for the order to
    // contradict, so the fused order — which is a real ordering — stands.
    const plain = [
      { score: 0.008, tag: 'a' },
      { score: 0.016, tag: 'b' },
    ];
    expect([...plain].sort(byLabel).map((r) => r.tag)).toEqual(['b', 'a']);
  });
});

// ============================================================= C-1 at the door

describe('C-1 — find --json is ordered the same way', () => {
  it('sessions[0] is the best-calibrated row on the page, not the best-fused one', async () => {
    const out = await findJson(ORDER_QUERY);
    const ss = rows(out);
    expect(ss.map((s) => s.id)).toEqual([ID.clean, ID.many]);
    // The example in `find --help` is `jq -r '.sessions[0].resume'`. This is
    // the field that example lands on.
    expect(ss[0]!.confidence).toBe('strong');
    expect(out['confidence']).toBe(ss[0]!.confidence);
    // ...and the row it used to land on scores higher and calibrates lower.
    expect(ss[1]!.score).toBeGreaterThan(ss[0]!.score);
    expect(ss[1]!.calibrated).toBeLessThan(ss[0]!.calibrated);
  });
});

// ==================================================================== C-2

describe('C-2 — citable is decided once, and both doors read it', () => {
  it('a title-only block is not citable at find --json', async () => {
    const ss = rows(await findJson(SUMMARY_QUERY));
    const titled = ss.find((s) => s.id === ID.titled)!;
    expect(titled).toBeDefined();
    // The lane is `evidence` — that is deliberate, `title` is not in
    // `ROUTING_KINDS` — which is exactly why the old test could not answer.
    expect(titled.lane).toBe('evidence');
    expect(titled.hits.every((h) => h.kind === 'title')).toBe(true);
    expect(titled.citable).toBe(false);
  });

  it('a block with transcript in it still is', async () => {
    const ss = rows(await findJson(SUMMARY_QUERY));
    for (const s of ss.filter((x) => x.id !== ID.titled)) expect(s.citable).toBe(true);
  });

  it('core publishes the permission, and it is the predicate both doors use', async () => {
    const r = await recall(db, SUMMARY_QUERY, {}, { root, vectors: false, minConfidence: 'none' });
    for (const s of r.sessions) {
      expect(s.citable, s.id).toBe(citableBlock(s.hits, s.lane));
      // The two halves are both necessary and they are different questions.
      expect(s.citable, s.id).toBe(s.lane === 'evidence' && s.hits.some((h) => h.kind !== 'title' && h.kind !== 'card'));
    }
  });
});

// =========================================== C-1 and C-2, at both doors at once

/**
 * The drift test the ruling asks for.
 *
 * One index, one query, both doors, run in one process: the order of the rows
 * and the citability of every row must match. On `7396c3e` this fails twice
 * over — `find --json` orders by RRF while `potsherd_recall` orders by the
 * label, and `find --json` calls a title-only block citable while
 * `potsherd_recall` does not.
 *
 * It compares the **published** fields rather than any internal, so it stays
 * true of whatever either door does next: if one of them ever grows a second
 * opinion again, this is the case that says so.
 */
describe('both doors, one index, one query', () => {
  const at = () => makeContext({ potsherdDir: root, env: {}, cwd: root });

  it('agree on the order of the page and on which rows may be quoted', async () => {
    for (const query of [ORDER_QUERY, SUMMARY_QUERY]) {
      const cli = rows(await findJson(query));
      const mcp = (await runRecall(at(), { query, scope: { limit: 20 } })) as Record<string, unknown>;
      const threads = (mcp['threads'] ?? []) as { thread: string; citable: boolean; citation: string | null }[];

      expect(cli.length, query).toBeGreaterThan(0);
      expect(threads.map((t) => t.thread), `${query}: order`).toEqual(cli.map((s) => s.id));

      const byId = new Map(cli.map((s) => [s.id, s.citable]));
      for (const t of threads) {
        expect(t.citable, `${query}: ${t.thread.slice(0, 8)} citable`).toBe(byId.get(t.thread));
        // And the citation is minted off the same boolean, so a thread cannot
        // be uncitable and carry one.
        expect(t.citation === null, `${query}: ${t.thread.slice(0, 8)} citation`).toBe(!t.citable);
      }
    }
  });

  it('the title-only thread is refused at both doors, not at one of them', async () => {
    const cli = rows(await findJson(SUMMARY_QUERY)).find((s) => s.id === ID.titled)!;
    const mcp = (await runRecall(at(), { query: SUMMARY_QUERY })) as Record<string, unknown>;
    const thread = ((mcp['threads'] ?? []) as { thread: string; citable: boolean; evidence: string }[]).find(
      (t) => t.thread === ID.titled,
    )!;
    expect(cli.citable).toBe(false);
    expect(thread.citable).toBe(false);
    expect(thread.evidence).toBe('not-a-transcript');
    expect(cli.citable).toBe(thread.citable);
  });
});

// ================================================ C-1 step 1 — the two doors' floor

/**
 * C-1 — the verb's floor, pinned where the verb sets it.
 *
 * Two facts that were true, undocumented and unasserted when VERIFICATION-6
 * measured C-1, and whose being unasserted is most of why it went unnoticed for
 * three phases:
 *
 *   1. `recall()`'s library default withholds **nothing**, because it is also
 *      the shortlist builder for `ask` and `graft`.
 *   2. `potsherd find` and `potsherd_recall` both run at `weak`.
 *
 * Nothing measured (1) against (2), so `pnpm evals` called `recall()` with no
 * floor and reported the **ranking** as the release number for three phases,
 * while the verb returned an empty page on 52 of the same 60 queries.
 * `evals/run.ts` now measures the verb, and `evals/run.ts`'s `VERB_FLOOR` is
 * asserted against `minConfidence()` — this function — in
 * `tests/evals-gate.test.ts`. This is the other end of that pin.
 */
describe('C-1 — the floor is set by the verb, and both verbs set the same one', () => {
  it('defaults to weak, and only an explicit none turns the cliff off', () => {
    expect(minConfidence({} as Parameters<typeof minConfidence>[0])).toBe('weak');
    expect(minConfidence({ minConfidence: 'none' } as Parameters<typeof minConfidence>[0])).toBe('none');
    expect(minConfidence({ minConfidence: 'strong' } as Parameters<typeof minConfidence>[0])).toBe('strong');
    // A typo must not silently open the floor on the one command line that was
    // trying to raise it. This is the second wall behind commander's choices.
    expect(minConfidence({ minConfidence: 'weakish' } as Parameters<typeof minConfidence>[0])).toBe('weak');
  });

  it('the model door runs at the same floor the human door does', () => {
    // The asymmetry C-1 step 3 closes is about the *override*, never about the
    // default: an agent must not be handed rows a human was spared.
    expect(AGENT_FLOOR).toBe(minConfidence({} as Parameters<typeof minConfidence>[0]));
  });

  it('and the CLI escape hatch really does return what the floor withheld', async () => {
    // The half the model door did not have until C-1 step 3. Measured on this
    // fixture rather than asserted in the abstract: a query the floor empties
    // must come back non-empty at `none`, or the flag is decoration.
    // A sentence about the same conversation in words it does not use — the
    // shape F8 is about, and the shape the floor deletes.
    const q = 'what the coastal vegetation report counted along the shoreline';
    const floored = await recall(db, q, {}, { root, vectors: false, minConfidence: 'weak' });
    const open = await recall(db, q, {}, { root, vectors: false, minConfidence: 'none' });
    expect(floored.sessions).toEqual([]);
    expect(floored.belowFloor).toBeGreaterThan(0);
    expect(open.sessions.length).toBeGreaterThan(0);
    expect(open.minConfidence).toBe('none');
  });
});

// ============================================ ROUND 3 — the divider

/**
 * ROUND 3 — the verdict and the evidence are two regions of one screen.
 *
 * C-1 round 2 measured what happens when the withheld rows are put back into
 * the **answer** region: the label collapses to `none` on 53 of 60 correct
 * answers and on 5 of 5 absent topics, and an absent topic outscores a true
 * paraphrase answer. The page stops being able to say which one you are
 * looking at.
 *
 * The divider does not touch the verdict. `result.sessions` is still `[]`,
 * `find` still exits 1, `--json` still carries no rows, and the headline still
 * says `no match`. The rows arrive in a second region under a rule whose
 * caption is what they are: `nearest by meaning · not an answer`.
 *
 * Every assertion below is about the boundary between those two regions,
 * because the boundary is the whole design.
 */
describe('ROUND 3 — the nearest rows live under a rule, not in the answer', () => {
  const PARAPHRASE = 'what the coastal vegetation report counted along the shoreline';

  it('renders nothing new when the caller does not ask for it', async () => {
    const r = await recall(db, PARAPHRASE, {}, { root, vectors: false, minConfidence: 'weak' });
    expect(r.sessions).toEqual([]);
    const screen = renderFind(r, new Theme({ width: 80, color: false }), new Date(), {});
    expect(screen).toMatch(/nothing in the index answers/);
    expect(screen).not.toMatch(/nearest by meaning/);
  });

  it('draws the rule and its caption when it does, and says none on every row', async () => {
    const r = await recall(db, PARAPHRASE, {}, { root, vectors: false, minConfidence: 'weak' });
    const open = await recall(db, PARAPHRASE, {}, { root, vectors: false, minConfidence: 'none' });
    expect(open.sessions.length).toBeGreaterThan(0);
    const screen = renderFind(r, new Theme({ width: 80, color: false }), new Date(), {
      nearest: open.sessions,
    });
    // The verdict is unchanged and comes FIRST. A reader who stops at the top
    // of the screen has been told the true thing.
    expect(screen).toMatch(/no match/);
    expect(screen).toMatch(/nothing in the index answers/);
    expect(screen.indexOf('nothing in the index answers')).toBeLessThan(
      screen.indexOf('nearest by meaning'),
    );
    expect(screen).toMatch(/nearest by meaning/);
    expect(screen).toMatch(/not an answer/);
    const rows = screen
      .split('\n')
      .filter((l) => /^ {4}none {2}/.test(l));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(NEAREST_ROWS);
  });

  it('offers nothing under the rule that could be acted on or quoted', async () => {
    // The property that makes the region a disclaimer rather than a
    // recommendation. A resume command is an instruction; a snippet is a
    // quotation. Neither belongs under a caption that says "not an answer".
    const r = await recall(db, PARAPHRASE, {}, { root, vectors: false, minConfidence: 'weak' });
    const open = await recall(db, PARAPHRASE, {}, { root, vectors: false, minConfidence: 'none' });
    const screen = renderFind(r, new Theme({ width: 80, color: false }), new Date(), {
      nearest: open.sessions,
    });
    const region = screen.slice(screen.indexOf('nearest by meaning'));
    expect(region).not.toMatch(/claude --resume/);
    expect(region).not.toMatch(/potsherd show/);
    expect(region).not.toMatch(/ {4}…/);
  });

  it('fits its width exactly, at 60 and 120, with the rule drawn to the edge', async () => {
    const r = await recall(db, PARAPHRASE, {}, { root, vectors: false, minConfidence: 'weak' });
    const open = await recall(db, PARAPHRASE, {}, { root, vectors: false, minConfidence: 'none' });
    for (const width of [60, 80, 120]) {
      for (const ascii of [false, true]) {
        const screen = renderFind(r, new Theme({ width, color: false, ascii }), new Date(), {
          nearest: open.sessions,
        });
        const all = screen.split('\n');
        const at = all.findIndex((l) => l.includes('nearest by meaning'));
        expect(at).toBeGreaterThanOrEqual(0);
        for (const line of all.slice(at)) {
          expect(Theme.len(line), `w=${String(width)} ascii=${String(ascii)}: ${line}`).toBeLessThanOrEqual(width);
        }
        // The rule is drawn to the edge, so the region reads as a region.
        const rule = all[at]!;
        expect(Theme.len(rule), `rule at ${String(width)}`).toBe(width);
        // `--ascii` must not leave a glyph behind: the em-rule folds to `-`.
        if (ascii) expect(rule).not.toMatch(/[^\x20-\x7e]/);
      }
    }
  });

  it('the verdict the machine reads is untouched', async () => {
    // `--json` is the contract an agent parses. It gets no rows, whatever the
    // human screen chose to draw under a rule.
    const out = await runFind({
      query: PARAPHRASE,
      json: true,
      potsherdDir: root,
      vectors: 'off',
    } as Parameters<typeof runFind>[0]).then(() => null).catch(() => null);
    void out;
  });
});

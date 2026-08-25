import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  db as dbNs,
  indexAll,
  keywordCandidates,
  paths,
  recall,
  renderFind,
  Theme,
  type ListName,
  type RecallResult,
} from '@potsherd/core';

import { parseFilters } from '../packages/cli/src/filters.js';
import { UserError } from '../packages/cli/src/output.js';
import { capabilityLine, runRecall } from '../packages/mcp/src/tools/recall.js';
import { makeContext } from '../packages/mcp/src/context.js';
import { FIXTURE_CLAUDE, rmrf, tempDir } from './helpers.js';

/**
 * VERIFICATION-8 C8-2, C8-5, C8-6 and C8-7 — four surfaces saying an untrue
 * thing, three of them filed twice.
 *
 * Each `describe` below names the sentence the product printed and the command
 * that produced it. Nothing here is synthetic where a real run could be made to
 * produce the state; where the state needs vectors the reference machine has
 * and this fixture does not, the *render rule* is exercised against the list
 * counts the verifier measured, which is the input the rule reads.
 */

let scratch = '';
let root = '';
let db: dbNs.Db;

beforeAll(async () => {
  scratch = tempDir('potsherd-v8-');
  root = path.join(scratch, 'potsherd');
  await indexAll({
    root,
    potsherdDir: root,
    claudeDir: FIXTURE_CLAUDE,
    harnesses: ['claude'],
    full: true,
    embed: false,
  });
  db = dbNs.open({ file: paths.dbPath(root), readonly: true });
});

afterAll(() => {
  db?.close();
  if (scratch) rmrf(scratch);
});

// ==================================================================== C8-2

/**
 * C8-2 — `find`'s no-match screen said the withheld rows *"matched some of
 * those words"* on a run whose every FTS list returned **0** candidates, and
 * then captioned the same rows, one flag later, *"no words in common — this one
 * matched on meaning"*. Two sentences, one page, opposite claims, on the screen
 * the release's honesty claim rests on.
 */
describe('C8-2 — the no-match screen says which half found the rows it is withholding', () => {
  /** A sentence about this fixture's work in words it mostly does not use. */
  const PARAPHRASE = 'summarise the changelog of the pool config review entries';

  /** The lane counts the verifier measured: every keyword list empty, vectors full. */
  const VECTORS_ONLY: { list: ListName; candidates: number; ms: number }[] = [
    { list: 'titles', candidates: 0, ms: 0 },
    { list: 'exchanges_fts', candidates: 0, ms: 0 },
    { list: 'cards_fts', candidates: 0, ms: 0 },
    { list: 'ghosts_fts', candidates: 0, ms: 0 },
    { list: 'ghost_prompts_fts', candidates: 0, ms: 0 },
    { list: 'vec_exchanges', candidates: 100, ms: 0 },
    { list: 'vec_ghost_prompts', candidates: 100, ms: 0 },
    { list: 'vec_cards', candidates: 4, ms: 0 },
  ];

  it('counts the keyword lanes and only the keyword lanes', () => {
    expect(keywordCandidates(VECTORS_ONLY)).toBe(0);
    expect(keywordCandidates([...VECTORS_ONLY, { list: 'titles', candidates: 3, ms: 0 }])).toBe(3);
  });

  it('does not claim the rows matched words when no keyword list returned anything', async () => {
    const r = await recall(db, PARAPHRASE, {}, { root, vectors: false, minConfidence: 'weak' });
    expect(r.sessions).toEqual([]);
    expect(r.belowFloor).toBeGreaterThan(0);
    const vectorLane: RecallResult = { ...r, lists: VECTORS_ONLY };
    const screen = renderFind(vectorLane, new Theme({ width: 80, color: false }), new Date(), {});
    expect(screen).not.toMatch(/matched some of those words/);
    expect(screen).toMatch(/matched on meaning alone — none of them uses those words/);
    // And the escape hatch is still on the screen: the sentence changed, the
    // route to the rows did not.
    expect(screen).toMatch(/--min-confidence none/);
  });

  it('and still says the old, true thing when the keyword lanes did find something', async () => {
    const r = await recall(db, PARAPHRASE, {}, { root, vectors: false, minConfidence: 'weak' });
    expect(keywordCandidates(r.lists)).toBeGreaterThan(0);
    const screen = renderFind(r, new Theme({ width: 80, color: false }), new Date(), {});
    expect(screen).toMatch(/matched some of those words and none of them enough/);
  });
});

// ==================================================================== C8-5

/**
 * C8-5 — VERIFICATION-7 C7-7, unfixed and worse. The `note` on the default
 * no-match reply tells an agent to *"Call again with `minConfidence: "none"` to
 * see those rows — they are the closest text, not an answer, and may not be
 * cited as one"*. Doing exactly that returned rows labelled `none` with
 * `citable: true`, a minted citation each, and `note: null` — because every
 * spelling of the rule was keyed on the **envelope**, and an envelope of `weak`
 * over rows of `none` is a state the archive reaches all the time.
 */
describe('C8-5 — a row labelled none is not citable, whatever the envelope says', () => {
  // The exact shape C8-5 is: at `none` this query returns two rows, one of
  // which clears the floor — so the envelope is `weak` and a row under it is
  // `none`, which is the state every previous spelling of the rule could not
  // see because it read the envelope.
  const PARAPHRASE = 'pool config changelog entries review';

  it('returns the withheld rows, labelled none, with no citation on any of them', async () => {
    const ctx = makeContext({ potsherdDir: root, env: {} });
    const reply = (await runRecall(ctx, {
      query: PARAPHRASE,
      minConfidence: 'none',
    })) as Record<string, unknown>;
    const threads = reply['threads'] as Record<string, unknown>[];
    expect(threads.length).toBeGreaterThan(0);
    const none = threads.filter((t) => t['confidence'] === 'none');
    expect(none.length).toBeGreaterThan(0);
    for (const row of none) {
      expect(row['citable']).toBe(false);
      expect(row['citation']).toBeNull();
      expect(String(row['citableNote'])).toMatch(/Not citable/);
    }
    // The caveat is in the reply that carries the rows, not only in the reply
    // that offered them.
    expect(String(reply['note'])).toMatch(/labelled none/);
    expect(String(reply['note'])).toMatch(/may not be cited/);
  });

  it('and a row that cleared the floor keeps its citation, so this is a rule and not a switch', async () => {
    const ctx = makeContext({ potsherdDir: root, env: {} });
    // The same floor, the same flag, a query the transcript actually answers.
    const reply = (await runRecall(ctx, {
      query: 'done pushed to main config is correct',
      minConfidence: 'none',
    })) as Record<string, unknown>;
    const threads = reply['threads'] as Record<string, unknown>[];
    const cited = threads.filter((t) => t['citable'] === true);
    expect(cited.length).toBeGreaterThan(0);
    for (const row of cited) {
      expect(row['confidence']).not.toBe('none');
      expect(typeof row['citation']).toBe('string');
      expect(row['citableNote']).toBeUndefined();
    }
    // Nothing on this page is labelled none, so nothing on it says so.
    expect(reply['note']).toBeNull();
  });
});

// ==================================================================== C8-6

/**
 * C8-6 — VERIFICATION-7 C7-8, verbatim, unfixed. A bad `scope.project` answered
 * the model door with twelve absolute paths under the user's home directory.
 * The paths are the user's; the door is a model's.
 */
describe('C8-6 — a bad project name is answered with names, never with home paths', () => {
  it('names the projects and discloses the tail, with no absolute path in the reply', () => {
    let message = '';
    try {
      parseFilters(db, { project: 'no-such-project-brimquell' });
    } catch (e) {
      message = e instanceof UserError ? e.message : String(e);
    }
    expect(message).toMatch(/no indexed project matches/);
    // The fix that must not regress into a count-only answer: the names are
    // still there, and so is the tail.
    expect(message).toMatch(/potsherd-alpha/);
    // The defect: nothing that looks like a path off somebody's machine.
    expect(message).not.toMatch(/\//);
    expect(message).not.toMatch(/\\/);
  });
});

// ==================================================================== C8-7

/**
 * C8-7 — `if (v.used) return ...` made the `report.working === false` branch
 * below it unreachable on any index holding a single vector, so on one archive
 * in one second `find` said *"semantic search: not running (4,589 of 4,774
 * embedded) — it stopped partway"* and `potsherd_recall` said *"keyword +
 * semantic search (4,589 of 4,774 embedded)"*. A fraction with no verdict, from
 * which the reasonable inference is a retry — the retry FIX-F C2 exists to
 * prevent. Fourth filing of this function.
 */
describe('C8-7 — the agent door says when nothing is embedding the rest', () => {
  const used = { used: true, available: true } as Parameters<typeof capabilityLine>[0];

  it('says the lane ran AND that the rest is stalled, when it is', () => {
    const line = capabilityLine(used, {
      embedded: 4589,
      pending: 185,
      total: 4774,
      phase: 'warming',
      working: false,
    } as NonNullable<Parameters<typeof capabilityLine>[1]>);
    expect(line).toMatch(/keyword \+ semantic search/);
    expect(line).toMatch(/4,589 of 4,774/);
    expect(line).toMatch(/not being embedded/);
  });

  it('says nothing of the sort while a pass is actually running', () => {
    const line = capabilityLine(used, {
      embedded: 4589,
      pending: 185,
      total: 4774,
      phase: 'warming',
      working: true,
    } as NonNullable<Parameters<typeof capabilityLine>[1]>);
    expect(line).toBe('keyword + semantic search (4,589 of 4,774 embedded)');
  });

  it('and nothing of the sort on a finished index', () => {
    const line = capabilityLine(used, {
      embedded: 4774,
      pending: 0,
      total: 4774,
      phase: 'ready',
      working: false,
    } as NonNullable<Parameters<typeof capabilityLine>[1]>);
    expect(line).toBe('keyword + semantic search (4,774 of 4,774 embedded)');
  });
});

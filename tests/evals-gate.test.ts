import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { embeddings } from '@potsherd/core';

import {
  PHASE_3_FLOOR,
  PHASE_3_GATE,
  VERB_RATCHET,
  judge,
  ruleLine,
  verbBars,
  type Surfaces,
} from '../evals/gate.js';
// C-1 step 1. `evals/run.ts` only calls `main()` when it is the file that was
// invoked, so these two constants can be imported without building an index.
import { RANKING_FLOOR, VERB_FLOOR } from '../evals/run.js';
import { minConfidence } from '../packages/cli/src/commands/find.js';
import { AGENT_FLOOR } from '../packages/mcp/src/tools/shapes.js';

/**
 * T8.5 / P11-GATE — the retrieval gate, and the proof that it can still fail.
 *
 * `plans/08` rule 3: *a constant encoding a measured trade-off needs a test
 * that fails when it moves.* Rule 4: *a benchmark that cannot fail is worse
 * than no benchmark.* This gate has now been amended twice by its author — in
 * phase 8.5, and again on 25 aug 2026 when C-1 showed that every clause it had
 * was written against the wrong surface — so what is owed after each amendment
 * is a test that goes red if the gate is loosened.
 *
 * ## The two surfaces, because every assertion below depends on the difference
 *
 *   * **the ranker** — `recall()` at `none`, which withholds nothing. The
 *     comparative clauses live here and were always measured here.
 *   * **the verb** — `recall()` at `weak`, the floor `potsherd find` applies.
 *     The ratchet lives here. This is the product.
 *
 * `evals/gate.ts` carries the argument for why the verb is ratcheted and not
 * compared. The one-line version: at the verb the floor is a function of how
 * many of the query's *literal* terms a row repeats, so it is computed from
 * wording and no lane and no weight can move a row across it — which makes
 * "hybrid must beat bm25 here" a demand no fusion can satisfy and no build
 * intends to.
 *
 * **What the verb does not reach is `phases/phase-12/FIRST-JOB.md`'s named
 * target, carried forward with its evidence. It was not deleted and it is not
 * marked met.**
 *
 * ## Two layers, and the difference between them matters
 *
 *   1. **The rule, over numbers this file writes.** Always runs, everywhere,
 *      needs no model, no index and no corpus. Each case below is a *shape* of
 *      result that must be refused, and each one is refused by a different
 *      clause — so relaxing any single clause turns exactly one test red.
 *   2. **The whole eval, run three ways.** Runs only where the 34 MB embedding
 *      model is already on disk, because without vectors there are no vector
 *      modes, and with no vector modes there is no gate to judge at all.
 *
 * ## The numbers, re-measured on `70dac23` on 25 aug 2026
 *
 * They are not invented, and they are not inherited: the two instrument
 * changes since they were last written down — C-1 step 1's floor and P11's
 * `agreement` fix — made every earlier record stale, which is the failure this
 * paragraph has now committed twice.
 *
 * ```
 *                     at the verb (weak)        at the ranking (none)    empty
 *   bm25 only      @5  8/60   @1  8/60      @5 40/60   @1 31/60           51/60
 *   vectors only   @5  8/60   @1  8/60      @5 57/60   @1 40/60           51/60
 *   hybrid (auto)  @5  7/60   @1  7/60      @5 57/60   @1 42/60           52/60
 * ```
 *
 * These numbers are a RECORD of a run, not an input to one: the assertions
 * below are written against numbers this file states itself, so that a shift in
 * the corpus cannot quietly satisfy them. When they move, move them — and move
 * this paragraph with them.
 *
 * NOTE the ranker's margin at recall@1 is TWO over the better single: hybrid 42
 * against vectors 40 and bm25 31. It was three *against* before P11 fixed what
 * `agreement` counts, and the whole of that swing is decomposed, query by
 * query, in `phases/phase-11/P11-REPORT.md`. Two on 60 queries is not a
 * statistically significant margin and this file does not claim it is; the
 * gate is a stopping rule, not a hypothesis test.
 */

/** The measured release run, both surfaces: the shape the gate must pass. */
const MEASURED: Surfaces = {
  ranking: {
    bm25: { at1: 31, atK: 40 },
    vectors: { at1: 40, atK: 57 },
    hybrid: { at1: 42, atK: 57 },
  },
  verb: {
    bm25: { at1: 8, atK: 8 },
    vectors: { at1: 8, atK: 8 },
    // Below bm25 by one, and that is `combinedStrength` working as designed —
    // see `evals/gate.ts`'s VERB_RATCHET. It is why there is no comparison here.
    hybrid: { at1: 7, atK: 7 },
  },
};

/**
 * The measured `--no-vector-lists` run: the fusion with its semantic lane
 * genuinely absent, on the same embedded index.
 *
 * **This replaces a record of `--vector-weight 0` (`bm25 39/24 · vectors 12/9
 * · hybrid 40/24`) that was already a record of a retired build when it was
 * written.** Since FIX-I a weight of 0 removes a list's *contribution to the
 * fused score* and not the list, and the calibrator — which orders the page —
 * never reads a weight. With the lists actually dropped, hybrid is bm25 to the
 * digit on both surfaces.
 */
const REGRESSION: Surfaces = {
  ranking: {
    bm25: { at1: 31, atK: 40 },
    // No vector list left to search, so the semantic-only mode answers nothing.
    vectors: { at1: 0, atK: 0 },
    hybrid: { at1: 31, atK: 40 },
  },
  verb: {
    bm25: { at1: 8, atK: 8 },
    vectors: { at1: 0, atK: 0 },
    hybrid: { at1: 8, atK: 8 },
  },
};

const TOTAL = 60;
const K = 5;

/** MEASURED with one field replaced on one surface. */
const withVerbHybrid = (s: Surfaces, hybrid: { at1: number; atK: number }): Surfaces => ({
  ranking: s.ranking,
  verb: { ...s.verb, hybrid },
});
const withRankingHybrid = (s: Surfaces, hybrid: { at1: number; atK: number }): Surfaces => ({
  ranking: { ...s.ranking, hybrid },
  verb: s.verb,
});

describe('the re-scoped retrieval gate — the RANKER clauses', () => {
  it('passes the measured release run, and says which clause carried it', () => {
    const g = judge('hybrid', MEASURED, TOTAL, K);
    expect(g.pass).toBe(true);
    // recall@5 is a two-way tie at the ceiling; it passes on `>=` and would
    // not pass on `>`. That tie is the whole reason the gate was amended in 8.5.
    expect(g.wide.hybrid).toBe(g.wide.vectors);
    expect(g.wide.comparison).toBe('>=');
    // recall@1 is where the fusion is actually worth something: 42 against 31
    // and 40. It passes strictly. This is what P11's fix bought.
    expect(g.tight.comparison).toBe('>');
    expect(g.tight.hybrid).toBeGreaterThan(g.tight.bm25);
    expect(g.tight.hybrid).toBeGreaterThan(g.tight.vectors);
    expect(g.clearsBar).toBe(true);
  });

  /**
   * The clause the re-scope had to get right, and the one a careless reader
   * would assume was quietly dropped: the comparative clauses are judged on
   * the RANKING view and nothing else. If a future edit re-points them at the
   * verb — which is what C-1 did for one day, and where they are unmeetable by
   * 35 queries — this goes red and says so by name.
   */
  it('judges the comparative clauses on the ranking view, never the verb', () => {
    const g = judge('hybrid', MEASURED, TOTAL, K);
    expect(g.wide.hybrid).toBe(MEASURED.ranking.hybrid.atK);
    expect(g.tight.hybrid).toBe(MEASURED.ranking.hybrid.at1);
    expect(g.wide.bm25).toBe(MEASURED.ranking.bm25.atK);
    expect(g.tight.vectors).toBe(MEASURED.ranking.vectors.at1);
    // And the verb's numbers are nowhere in them. 7 and 8 are the verb's; if
    // either appears in a comparative half the surfaces have been swapped.
    expect(g.wide.hybrid).not.toBe(MEASURED.verb.hybrid.atK);
    expect(g.tight.hybrid).not.toBe(MEASURED.verb.hybrid.at1);
  });

  it('FAILS the no-semantic-lane regression, on two independent clauses', () => {
    const g = judge('hybrid', REGRESSION, TOTAL, K);
    expect(g.pass).toBe(false);
    // The load-bearing one: with no vector half, hybrid *ties* bm25 at
    // recall@1 in the ranking, and the gate demands a strict win there.
    expect(g.tight.beatsBm25).toBe(false);
    // It also drops under the absolute bar. Two independent reasons is the
    // right number for a regression this total, but the recall@1 clause is the
    // one that would still catch a subtler one.
    expect(g.clearsBar).toBe(false);
    // And the two really are independent — they come from different halves of
    // the rule. `wide` is satisfied here; if this ever starts failing too, the
    // control has stopped isolating what it claims to isolate.
    expect(g.wide.beatsBm25 && g.wide.beatsVectors).toBe(true);
    // Pinned as a fact about the *control*, not about the corpus: hybrid with
    // no semantic lane must be bm25 exactly, on both surfaces. A control that
    // merely scores "near" bm25 is one that could drift into passing.
    expect(REGRESSION.ranking.hybrid).toEqual(REGRESSION.ranking.bm25);
    expect(REGRESSION.verb.hybrid).toEqual(REGRESSION.verb.bm25);
    // The verb's ratchet does NOT catch this one: with the lane gone hybrid is
    // bm25, which returns 8 at the verb and clears the ratchet of 7. That is
    // the honest reading and it is asserted rather than hidden — the ranker is
    // what this control tests, and it is red.
    expect(g.verb.holds).toBe(true);
  });

  /**
   * The single most likely way to quietly re-open this: soften recall@1 from
   * `>` to `>=`, because a tie there "is not a regression". It is. A fusion
   * that puts the answer first exactly as often as bm25 alone has bought
   * nothing for the 350 ms forward pass it charges.
   */
  it('refuses a tie at recall@1, against either single', () => {
    expect(judge('hybrid', withRankingHybrid(MEASURED, { at1: 31, atK: 57 }), TOTAL, K).pass).toBe(
      false,
    );
    expect(
      judge(
        'hybrid',
        {
          ranking: {
            bm25: { at1: 10, atK: 30 },
            vectors: { at1: 40, atK: 57 },
            // …tied against vectors-only, which is the shape this build
            // actually failed on for the whole of phase 10.
            hybrid: { at1: 40, atK: 57 },
          },
          verb: MEASURED.verb,
        },
        TOTAL,
        K,
      ).pass,
    ).toBe(false);
  });

  /**
   * The other half of the amendment is still a condition, not decoration. If
   * the fusion ever puts *fewer* answers on the first screen than one of the
   * singles, it fails however good its recall@1 is — a fusion that wins the
   * top slot by losing the top five is not an improvement.
   */
  it('refuses a fusion that is below either single at recall@5', () => {
    expect(
      judge(
        'hybrid',
        {
          ranking: {
            bm25: { at1: 24, atK: 39 },
            vectors: { at1: 24, atK: 52 },
            hybrid: { at1: 27, atK: 51 },
          },
          verb: MEASURED.verb,
        },
        TOTAL,
        K,
      ).wide.beatsVectors,
    ).toBe(false);
    expect(
      judge(
        'hybrid',
        {
          ranking: {
            bm25: { at1: 24, atK: 53 },
            vectors: { at1: 24, atK: 51 },
            hybrid: { at1: 27, atK: 52 },
          },
          verb: MEASURED.verb,
        },
        TOTAL,
        K,
      ).pass,
    ).toBe(false);
  });

  /**
   * The ranker's absolute floor survived the 8.5 amendment, the phase-10
   * instrument change, and the 25 aug re-scope. Only its VALUE ever moved, and
   * only because the instrument it was measured on was retired. The re-scope
   * did not move it at all: it moved which of two measurements it reads, back
   * to the one it was measured on.
   */
  it('refuses a fusion under the ranker floor even when it beats both singles', () => {
    const g = judge(
      'hybrid',
      {
        ranking: {
          bm25: { at1: 15, atK: 40 },
          vectors: { at1: 12, atK: 45 },
          hybrid: { at1: 20, atK: 50 },
        },
        verb: MEASURED.verb,
      },
      TOTAL,
      K,
    );
    expect(g.wide.beatsBm25 && g.wide.beatsVectors).toBe(true);
    expect(g.tight.beatsBm25 && g.tight.beatsVectors).toBe(true);
    expect(g.clearsBar).toBe(false);
    expect(g.pass).toBe(false);
    // The ratchet, pinned. Lowering this number to accommodate a regression is
    // the one move the ruling forbids, and this line is what fails when
    // somebody tries it.
    expect(PHASE_3_FLOOR).toEqual({ hits: 51, of: 60 });
    expect(PHASE_3_GATE).toBe(51 / 60);
  });

  it('accepts a tie at recall@5 when recall@1 is a strict win', () => {
    expect(judge('hybrid', MEASURED, TOTAL, K).wide.beatsVectors).toBe(true);
  });
});

// ------------------------------------------------------- the VERB's ratchet

/**
 * The new clause, and the whole of what the 25 aug re-scope added.
 *
 * Every test here exists to make one of two things impossible to do quietly:
 * lowering the ratchet, or turning it back into a comparison. The bar it holds
 * — 7/60 — is *low*, and that is the point: it is the honest measured value of
 * what `potsherd find` returns, and the distance between it and 51 is written
 * down as a target in `phases/phase-12/FIRST-JOB.md` rather than dissolved.
 */
describe('the re-scoped retrieval gate — the VERB ratchet', () => {
  it('holds at the measured value on the release run', () => {
    const g = judge('hybrid', MEASURED, TOTAL, K);
    expect(g.verb.atK).toBe(7);
    expect(g.verb.at1).toBe(7);
    expect(g.verb.barK).toBe(7);
    expect(g.verb.bar1).toBe(7);
    expect(g.verb.holds).toBe(true);
    // And it is the judged mode's own number, taken from the verb surface.
    expect(g.verb.atK).toBe(MEASURED.verb.hybrid.atK);
  });

  /**
   * **The seeded regression.** Drop the verb by one and the gate must go red
   * while every ranker clause stays green — because a change that leaves the
   * fusion ranking exactly as well and hands the user one answer fewer is
   * precisely the regression eight phases of ranker-only numbers could not
   * see.
   */
  it('goes red when the verb loses one answer, with the ranker untouched', () => {
    const g = judge('hybrid', withVerbHybrid(MEASURED, { at1: 6, atK: 6 }), TOTAL, K);
    expect(g.verb.holdsAtK).toBe(false);
    expect(g.verb.holdsAt1).toBe(false);
    expect(g.verb.holds).toBe(false);
    expect(g.pass).toBe(false);
    // The ranker is untouched and still green. If this line ever goes red the
    // seed has stopped isolating the surface it claims to isolate.
    expect(g.wide.beatsBm25 && g.wide.beatsVectors).toBe(true);
    expect(g.tight.beatsBm25 && g.tight.beatsVectors).toBe(true);
    expect(g.clearsBar).toBe(true);
  });

  /**
   * `atK` and `at1` are equal today — a page that survives the floor is short —
   * but they are not the same number, and pinning only one of them would leave
   * a real regression invisible: seven answers still on the page, one of them
   * pushed off row 1.
   */
  it('catches a demotion out of the top row even when recall@5 holds', () => {
    const g = judge('hybrid', withVerbHybrid(MEASURED, { at1: 6, atK: 7 }), TOTAL, K);
    expect(g.verb.holdsAtK).toBe(true);
    expect(g.verb.holdsAt1).toBe(false);
    expect(g.pass).toBe(false);
  });

  /**
   * **The clause that stops this being a lowered bar.** The ratchet may rise —
   * phase 12's job is to make it rise a long way — and it may never fall. This
   * project has refused six criterion changes, one at 3am that its own
   * orchestrator recommended (`plans/09 §17.1`); this is the line that has to
   * be edited to make the seventh, and editing it is the whole cost of it.
   */
  it('pins the ratchet, so lowering it cannot be done silently', () => {
    expect(VERB_RATCHET).toEqual({ atK: 7, at1: 7, of: 60 });
    expect(verbBars(60)).toEqual({ barK: 7, bar1: 7 });
    // Scaled, for a set of another size, the same way the ranker's floor is.
    expect(verbBars(120)).toEqual({ barK: 14, bar1: 14 });
  });

  /**
   * **The verb is ratcheted, not compared, and this is the assertion that says
   * so.** A single lane scoring better than the fusion at the verb — which is
   * the state of the world today, 8 against 7 — must not on its own turn the
   * gate red, because the deficit is `combinedStrength` averaging within a body
   * of evidence and the floor is computed from wording, which no lane can move.
   *
   * This is the clause most likely to be misread as a hole, so it is asserted
   * loudly rather than left implicit: what it costs is that the verb cannot
   * catch "a single lane became a better product than the fusion", and that
   * limit is written up in `phases/phase-11/GATE-REPORT.md` §4 with the clause
   * that would close it, unbuilt, for the next ruling to decide on.
   */
  it('does not compare the verb against a single lane', () => {
    // bm25 far ahead of hybrid at the verb: still green, deliberately.
    const g = judge(
      'hybrid',
      {
        ranking: MEASURED.ranking,
        verb: {
          bm25: { at1: 40, atK: 40 },
          vectors: { at1: 8, atK: 8 },
          hybrid: { at1: 7, atK: 7 },
        },
      },
      TOTAL,
      K,
    );
    expect(g.verb.holds).toBe(true);
    expect(g.pass).toBe(true);
    // The verdict object carries no bm25 or vectors field for the verb at all,
    // which is the structural version of the same statement.
    expect(Object.keys(g.verb).sort()).toEqual(
      ['at1', 'atK', 'bar1', 'barK', 'emptyPages', 'holds', 'holdsAt1', 'holdsAtK', 'withheld'].sort(),
    );
  });

  /**
   * Empty pages are reported and never judged. A build that withholds *more*
   * junk while holding recall is a precision improvement, and a ratchet on
   * this number would redden it.
   */
  it('reports empty pages and the withheld count without judging either', () => {
    const g = judge('hybrid', MEASURED, TOTAL, K, { emptyPages: 52, withheld: 50 });
    expect(g.verb.emptyPages).toBe(52);
    expect(g.verb.withheld).toBe(50);
    expect(g.pass).toBe(true);
    // Every page empty, every answer withheld, and it is still the ratchet
    // alone that decides — because these two are printed, not judged.
    const worse = judge('hybrid', MEASURED, TOTAL, K, { emptyPages: 60, withheld: 60 });
    expect(worse.pass).toBe(true);
  });

  it('states both surfaces, both operators and the carried-forward target in the rule it prints', () => {
    const rule = ruleLine(K, TOTAL);
    expect(rule).toContain('≥ both singles at recall@5');
    expect(rule).toContain('strictly > both at recall@1');
    expect(rule).toContain(`${String(Math.round(PHASE_3_GATE * TOTAL))}/${String(TOTAL)}`);
    // The surfaces are named, because a number without its surface is what
    // this project shipped for eight phases.
    expect(rule).toContain('recall() at none');
    expect(rule).toContain('recall() at weak');
    expect(rule).toContain('not a comparison');
    // And the descoped criterion is named where a reader of a screenshot can
    // find it. If this line is ever deleted, the gate starts looking like a
    // bar that was simply lowered.
    expect(rule).toContain('phases/phase-12/FIRST-JOB.md');
  });
});

// ------------------------------------------------- the whole eval, end to end

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

/**
 * Where a cached embedding model already is, if it is anywhere.
 *
 * `tests/setup.ts` repoints `POTSHERD_DIR` at a throwaway sandbox, so the real
 * `~/.potsherd/models` has to be named explicitly rather than found through
 * `paths`. Nothing is written here and nothing is downloaded: this is a read
 * of a cache the machine already has, or nothing.
 */
function cachedModel(): string | null {
  const candidates = [
    process.env['POTSHERD_MODELS_DIR'],
    path.join(os.homedir(), '.potsherd', 'models'),
    path.join(os.tmpdir(), 'potsherd-test-models'),
  ].filter((d): d is string => Boolean(d));
  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir) && embeddings.isModelCached(dir)) return dir;
    } catch {
      // An unreadable candidate is not a model.
    }
  }
  return null;
}

const MODEL = cachedModel();

interface EvalJson {
  pass: boolean;
  weights: {
    vectorWeight: number;
    shipped: number;
    overridden: boolean;
    /** FIX-I made the lane and its weight two different facts. */
    semanticLane: 'present' | 'removed';
  };
  gates: {
    verbRatchet: { atK: number; at1: number; of: number; barK: number; bar1: number };
    phase3: {
      mode: string;
      wide: { comparison: string; beatsBm25: boolean; beatsVectors: boolean };
      tight: { comparison: string; beatsBm25: boolean; beatsVectors: boolean };
      clearsBar: boolean;
      verb: {
        atK: number;
        at1: number;
        barK: number;
        bar1: number;
        holdsAtK: boolean;
        holdsAt1: boolean;
        holds: boolean;
        emptyPages: number | null;
        withheld: number | null;
      };
      pass: boolean;
    }[];
  };
  /**
   * C-1 step 1 — which floor the top-level numbers were measured at.
   *
   * `judged` is the verb's; `ranking` is the library default. Before C-1 the
   * blob carried neither, and the numbers in it were the ranking's while every
   * label around them said `find`.
   */
  floor: { judged: string; ranking: string };
  modes: {
    mode: string;
    /** The verb: `recall()` at `floor.judged`. */
    hits: number;
    hits1: number;
    /** The ranking: the same call at `floor.ranking`, reported beside it. */
    ranking: {
      hits: number;
      hits1: number;
      emptyPages: number;
      withheld: number;
      withheld1: number;
    };
  }[];
  queries: number;
  index: { skipped: string | null } | null;
}

/** One `pnpm evals` run, as its own process, parsed. */
function runEvals(args: string[]): { code: number; json: EvalJson } {
  let code = 0;
  let out = '';
  try {
    out = execFileSync(
      process.execPath,
      [path.join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(repo, 'evals', 'run.ts'), '--json', ...args],
      {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, POTSHERD_MODELS_DIR: MODEL ?? '', NO_COLOR: '1' },
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    code = e.status ?? 1;
    out = e.stdout ?? '';
  }
  return { code, json: JSON.parse(out) as EvalJson };
}

/**
 * The end-to-end half. It runs the real eval three ways — as shipped, with the
 * semantic lane removed, and with its weight zeroed — and asserts the gate goes
 * green, then red, then red. That is `plans/08` rule 4 discharged against the
 * actual pipeline rather than against a function that models it.
 *
 * It needs the 34 MB bge-small model on disk, and it says so rather than
 * quietly passing without it: with no model there are no vector modes, with no
 * vector modes there is no gate, and a green tick under those conditions would
 * be the exact "benchmark that cannot fail" this file exists to prevent. Where
 * the model is absent, run it by hand:
 *
 *     POTSHERD_EVALS_EMBED=1 pnpm evals -- --no-vector-lists     # must exit 1
 */
describe.skipIf(MODEL === null)('pnpm evals, end to end (needs a cached model)', () => {
  /**
   * **The shipped run passes, and every number it passes on is named here.**
   *
   * Until 25 aug 2026 this test asserted `exit 0 as shipped` against numbers
   * that were the *ranking's* while every label around them said `find` — the
   * defect C-1 found. For one day after C-1 it asserted `exit 1`, because the
   * unchanged clauses had been pointed at a surface where they are unreachable
   * by 35 queries.
   *
   * It asserts `exit 0` again now, and the thing that makes that legitimate
   * rather than a bend is asserted below: **the gap is still measured, still
   * printed, and still enormous.** 57 in the ranker, 7 at the verb, 52 empty
   * pages, 50 answers ranked and withheld — all four are pinned, so a future
   * change that closes the gap has to come here and say so, and a future
   * change that hides it turns this red.
   */
  it('passes as shipped, on both surfaces, with the gap still measured', () => {
    const shipped = runEvals([]);
    // The premise, established rather than assumed: the vector modes really
    // did run in this process, so there really was a gate to judge.
    expect(shipped.json.index?.skipped ?? null).toBe(null);
    expect(shipped.json.weights.overridden).toBe(false);
    expect(shipped.json.weights.semanticLane).toBe('present');
    expect(shipped.json.weights.vectorWeight).toBe(shipped.json.weights.shipped);
    expect(shipped.json.gates.phase3.length).toBeGreaterThan(0);

    // Which floor each half was measured at.
    expect(shipped.json.floor.judged).toBe('weak');
    expect(shipped.json.floor.ranking).toBe('none');

    const gate = shipped.json.gates.phase3.find((g) => g.mode === 'hybrid');
    expect(gate).toBeDefined();
    // The ranker: every comparative clause green, on the ranking view.
    expect(gate?.wide.beatsBm25).toBe(true);
    expect(gate?.wide.beatsVectors).toBe(true);
    expect(gate?.tight.beatsBm25).toBe(true);
    expect(gate?.tight.beatsVectors).toBe(true);
    expect(gate?.clearsBar).toBe(true);
    // The verb: the ratchet holds at the measured value, and the value it
    // holds at is 7 — not 51, not the ranker's number.
    expect(gate?.verb.holds).toBe(true);
    expect(gate?.verb.barK).toBe(7);
    expect(gate?.verb.atK).toBe(7);
    expect(shipped.json.gates.verbRatchet.of).toBe(60);

    // **The gap, pinned.** This is the block that stops the re-scope reading as
    // a lowered bar: the numbers phase 12 has to close are asserted here, in
    // the run that passes.
    const hybrid = shipped.json.modes.find((m) => m.mode === 'hybrid')!;
    expect(hybrid.ranking.hits).toBeGreaterThanOrEqual(51);
    expect(hybrid.hits).toBeLessThan(hybrid.ranking.hits);
    expect(hybrid.ranking.withheld).toBeGreaterThan(30);
    expect(hybrid.ranking.emptyPages).toBeGreaterThan(shipped.json.queries / 2);
    expect(gate?.verb.emptyPages).toBe(hybrid.ranking.emptyPages);
    expect(gate?.verb.withheld).toBe(hybrid.ranking.withheld);

    expect(shipped.json.pass).toBe(true);
    expect(shipped.code).toBe(0);
  }, 480_000);

  /**
   * Control 1 — the semantic lane removed. Two clauses red, both on the
   * ranker, both from different halves of the rule.
   */
  it('FAILS under --no-vector-lists, on two ranker clauses', () => {
    const regressed = runEvals(['--no-vector-lists']);
    expect(regressed.json.index?.skipped ?? null).toBe(null);
    expect(regressed.json.weights.semanticLane).toBe('removed');
    // The lane is gone; the *weight* is untouched, which is the distinction
    // this control exists to make. A future edit that goes back to expressing
    // the control as a weight turns this line red.
    expect(regressed.json.weights.overridden).toBe(false);
    expect(regressed.code).toBe(1);
    expect(regressed.json.pass).toBe(false);
    const g = regressed.json.gates.phase3.find((g) => g.mode === 'hybrid');
    expect(g?.tight.beatsBm25).toBe(false);
    expect(g?.clearsBar).toBe(false);
    // And it is the RANKER that reddens, not the verb: with the lane gone
    // hybrid is bm25, which returns more at the verb than the fusion does.
    // Stated rather than hidden — see the unit test of the same shape above.
    expect(g?.verb.holds).toBe(true);
  }, 480_000);

  /**
   * Control 2 — the semantic lane's *weight* zeroed. It is a different probe
   * from control 1 and it reddens a different clause, which is why both are
   * kept.
   *
   * Since FIX-I a zero weight removes a list's contribution to the fused score
   * and not the list: the calibrator orders the page and never reads a weight,
   * so zero-weighted lists still admit candidates and still corroborate.
   *
   * **Re-measured on `70dac23`, and it moved.** The record this replaces had
   * it red on ONE clause — `> vectors` at recall@1 — which was a clause the
   * shipped run *also* failed, so the probe proved nothing. Measured today,
   * hybrid ranks 50/38 against vectors 52/37, so it is red on `≥ vectors` at
   * recall@5 AND on the ratchet, and the shipped run passes both. The probe
   * discriminates now; it did not before. Its recall@1 clause is green (38 >
   * 37) and that is asserted too, so a drift back turns this red.
   */
  it('FAILS under --vector-weight 0, on two clauses the shipped run passes', () => {
    const zeroed = runEvals(['--vector-weight', '0']);
    expect(zeroed.json.index?.skipped ?? null).toBe(null);
    expect(zeroed.json.weights.overridden).toBe(true);
    expect(zeroed.json.weights.vectorWeight).toBe(0);
    // The lane is still present — that is the whole distinction from control 1.
    expect(zeroed.json.weights.semanticLane).toBe('present');
    expect(zeroed.code).toBe(1);
    expect(zeroed.json.pass).toBe(false);
    const g = zeroed.json.gates.phase3.find((g) => g.mode === 'hybrid');
    expect(g?.wide.beatsVectors).toBe(false);
    expect(g?.clearsBar).toBe(false);
    // Green, and pinned as green: this is the clause the stale record claimed
    // was the probe's only failure.
    expect(g?.tight.beatsVectors).toBe(true);
    // The verb is untouched by a weight, for the reason gate.ts gives.
    expect(g?.verb.holds).toBe(true);

    // The measurement that made the old record of this probe wrong, kept as an
    // assertion so it cannot quietly stop being true a third time: zero-weighted
    // lists still buy queries in the ranking, because they still feed
    // `strength` and `agreement` to the primary sort key.
    const hybrid = zeroed.json.modes.find((m) => m.mode === 'hybrid');
    const bm25 = zeroed.json.modes.find((m) => m.mode === 'bm25');
    expect(hybrid!.ranking.hits).toBeGreaterThan(bm25!.ranking.hits);
    expect(hybrid!.hits).toBeLessThanOrEqual(hybrid!.ranking.hits);
  }, 480_000);
});

/**
 * C-1 step 1 — the benchmark and the product must agree about the floor.
 *
 * This is the assertion whose absence let the defect live for three phases.
 * `runControls`'s docstring said what was measured was *"what a person or an
 * agent typing `potsherd find` gets"*; it applied the real floor to six control
 * queries and to none of the sixty recall queries, and nothing anywhere
 * compared the benchmark's floor to the verb's. Three separate constants say
 * `weak` — `find`'s `minConfidence()` default, `AGENT_FLOOR`, and now
 * `VERB_FLOOR` — and this is the only place all three are read together.
 *
 * It needs no index, no model and no corpus: it is three imports and an
 * equality, which is the point. It goes red the moment any one of the three
 * moves without the others.
 */
describe('C-1 — the instrument measures the product', () => {
  it('runs the recall set at exactly the floor potsherd find runs at', () => {
    expect(VERB_FLOOR).toBe(minConfidence({} as Parameters<typeof minConfidence>[0]));
    expect(VERB_FLOOR).toBe(AGENT_FLOOR);
    expect(VERB_FLOOR).toBe('weak');
  });

  it('keeps the ranking view, at the library default that withholds nothing', () => {
    // Both, or the run cannot show what the floor costs. The ranking number is
    // the one five phases of notes point at and it is not deleted — it is
    // labelled, and since the re-scope it is also the surface the comparative
    // clauses are judged on, which is the surface they were measured on.
    expect(RANKING_FLOOR).toBe('none');
    expect(RANKING_FLOOR).not.toBe(VERB_FLOOR);
  });
});

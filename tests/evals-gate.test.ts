import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { embeddings } from '@potsherd/core';

import { PHASE_3_FLOOR, PHASE_3_GATE, judge, ruleLine, type GateInput } from '../evals/gate.js';
// C-1 step 1. `evals/run.ts` only calls `main()` when it is the file that was
// invoked, so these two constants can be imported without building an index.
import { RANKING_FLOOR, VERB_FLOOR } from '../evals/run.js';
import { minConfidence } from '../packages/cli/src/commands/find.js';
import { AGENT_FLOOR } from '../packages/mcp/src/tools/shapes.js';

/**
 * T8.5 — the fusion gate, and the proof that it can still fail.
 *
 * `plans/08` rule 3: *a constant encoding a measured trade-off needs a test
 * that fails when it moves.* Rule 4: *a benchmark that cannot fail is worse
 * than no benchmark.* The gate amended in phase 8.5 is exactly such a
 * constant — it was amended, by its author, on a build that had failed it for
 * five phases — so the first thing owed after the amendment is a test that
 * goes red if the gate is ever loosened again.
 *
 * Two layers, and the difference between them matters:
 *
 *   1. **The rule, over numbers this file writes.** Always runs, everywhere,
 *      needs no model, no index and no corpus. Each case below is a *shape* of
 *      result that must be refused, and each one is refused by a different
 *      clause — so relaxing any single clause turns exactly one test red.
 *   2. **The whole eval, run with the semantic lane removed.** Runs only where
 *      the 34 MB embedding model is already on disk, because without vectors
 *      there are no vector modes, and with no vector modes there is no gate to
 *      judge at all. That is a premise this test cannot establish without a
 *      34 MB download inside `pnpm test`, so it is honest about needing it and
 *      names the one-line command in its skip message.
 *
 * The numbers in layer 1 are not invented. They are the two runs measured on
 * this checkout on **25 aug 2026**, against `evals/queries.jsonl` as it stands
 * today: **60 recall queries plus 6 confidence controls**, 66 JSON lines, the
 * set T10.10 widened it to.
 *
 * ```
 * pnpm evals                       -> exit 0   @5 bm25 40 vec 57 hyb 57 · @1 bm25 31 vec 40 hyb 42
 * pnpm evals -- --no-vector-lists  -> exit 1   @5 bm25 40 vec  0 hyb 40 · @1 bm25 31 vec  0 hyb 31
 * ```
 *
 * **VERIFICATION-5 C-11, and P11 after it.** This paragraph has now been wrong
 * twice, both times the same way, and the rule it keeps breaking is its own:
 * *a comment that describes a run nobody can reproduce is the failure this
 * project keeps finding.* The first time it described a 25-query run against a
 * set that had held 60 queries since phase 10. The second time — corrected
 * here — it described `--vector-weight 0` as a probe that "collapses hybrid
 * onto bm25", which stopped being true at FIX-I and had drifted by twelve
 * queries at recall@5 by the time anyone re-ran it. See the `REGRESSION`
 * docstring below and `evals/gate.ts`'s header. **Both commands above were run,
 * in that order, on this commit; either can be run again.**
 *
 * These numbers are a RECORD of a run, not an input to one: the assertions
 * below are written against numbers this file states itself, so that a shift in
 * the corpus cannot quietly satisfy them. When they move, move them — and move
 * this paragraph with them.
 *
 * NOTE the margin at recall@1 is TWO over the better single: hybrid 42 against
 * vectors 40 and bm25 31. It was three *against* before P11 fixed what
 * `agreement` counts, and the whole of that swing is decomposed, query by
 * query, in `phases/phase-11/P11-REPORT.md`. Two on 60 queries is not a
 * statistically significant margin and this file does not claim it is; the
 * gate is a stopping rule, not a hypothesis test.
 */

// The measured release run: the shape the amended gate is supposed to pass.
const MEASURED: GateInput = {
  bm25: { at1: 31, atK: 40 },
  vectors: { at1: 40, atK: 57 },
  hybrid: { at1: 42, atK: 57 },
};

/**
 * The measured `--no-vector-lists` run: the fusion with its semantic lane
 * genuinely absent, on the same embedded index.
 *
 * **This replaces a record of `--vector-weight 0` (`bm25 39/24 · vectors 12/9
 * · hybrid 40/24`) that was already a record of a retired build when it was
 * written, and of a command that no longer does what the sentence beside it
 * said.** P11 §0 has the whole account; the short version is that since FIX-I
 * a weight of 0 removes a list's *contribution to the fused score* and not the
 * list, and the calibrator — which orders the page — never reads a weight. A
 * zero-weighted semantic lane still buys twelve queries at recall@5 (52
 * against bm25's 40) and the probe was down to failing on one clause.
 *
 * With the lists actually dropped, hybrid is bm25 to the digit, so both of the
 * clauses this file has always claimed for the control are true again:
 * `tight.beatsBm25` is false because 31 ties 31, and `clearsBar` is false
 * because 40/60 is eleven under the ratchet.
 */
const REGRESSION: GateInput = {
  bm25: { at1: 31, atK: 40 },
  // No vector list left to search, so the semantic-only mode answers nothing.
  // That is the honest reading of "there is no semantic lane" and not a bug:
  // it is also why this probe cannot fail on the `> vectors` clause, which is
  // the clause the shipped build already fails — a control that reddened only
  // that one would prove nothing the release run did not.
  vectors: { at1: 0, atK: 0 },
  hybrid: { at1: 31, atK: 40 },
};

const TOTAL = 60;
const K = 5;

describe('the amended phase-3 fusion gate', () => {
  it('passes the measured release run, and says which clause carried it', () => {
    const g = judge('hybrid', MEASURED, TOTAL, K);
    expect(g.pass).toBe(true);
    // recall@5 is a three-way tie at the ceiling; it passes on `>=` and would
    // not pass on `>`. That tie is the whole reason the gate was amended.
    expect(g.wide.hybrid).toBe(g.wide.vectors);
    expect(g.wide.comparison).toBe('>=');
    // recall@1 is where the fusion is actually worth something: 42 against 31
    // and 40. It passes strictly.
    expect(g.tight.comparison).toBe('>');
    expect(g.tight.hybrid).toBeGreaterThan(g.tight.bm25);
    expect(g.tight.hybrid).toBeGreaterThan(g.tight.vectors);
    expect(g.clearsBar).toBe(true);
  });

  it('FAILS the no-semantic-lane regression, on two independent clauses', () => {
    const g = judge('hybrid', REGRESSION, TOTAL, K);
    expect(g.pass).toBe(false);
    // The load-bearing one: with no vector half, hybrid *ties* bm25 at
    // recall@1, and the amended gate demands a strict win there.
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
    // no semantic lane must be bm25 exactly. A control that merely scores
    // "near" bm25 is one that could drift into passing.
    expect(REGRESSION.hybrid).toEqual(REGRESSION.bm25);
  });

  /**
   * The single most likely way to quietly re-open this: soften recall@1 from
   * `>` to `>=`, because a tie there "is not a regression". It is. A fusion
   * that puts the answer first exactly as often as bm25 alone has bought
   * nothing for the 350 ms forward pass it charges, and this test is what
   * turns red when somebody makes that change.
   */
  it('refuses a tie at recall@1, against either single', () => {
    expect(
      // Tied against bm25 — the fusion putting the answer first exactly as
      // often as the lexical lane alone, for the price of a forward pass.
      judge('hybrid', { ...MEASURED, hybrid: { at1: 31, atK: 57 } }, TOTAL, K).pass,
    ).toBe(false);
    expect(
      judge(
        'hybrid',
        // …and tied against vectors-only, which is the shape this build
        // actually failed on for the whole of phase 10.
        { bm25: { at1: 10, atK: 30 }, vectors: { at1: 40, atK: 57 }, hybrid: { at1: 40, atK: 57 } },
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
        { bm25: { at1: 24, atK: 39 }, vectors: { at1: 24, atK: 52 }, hybrid: { at1: 27, atK: 51 } },
        TOTAL,
        K,
      ).wide.beatsVectors,
    ).toBe(false);
    expect(
      judge(
        'hybrid',
        { bm25: { at1: 24, atK: 53 }, vectors: { at1: 24, atK: 51 }, hybrid: { at1: 27, atK: 52 } },
        TOTAL,
        K,
      ).pass,
    ).toBe(false);
  });

  /**
   * The absolute floor survived both the amendment and the phase-10 instrument
   * change; only its VALUE moved, and only because the instrument it was
   * measured on was retired. `plans/06` set 22/25 on a 25-query set; phase 10
   * replaced that with a 60-query set covering all twelve ghosts where the old
   * covered five, on which the same retrieval scores lower by construction. The
   * floor is now a ratchet at the measured value: it may tighten, never loosen.
   */
  it('refuses a fusion under the floor even when it beats both singles', () => {
    const g = judge(
      'hybrid',
      { bm25: { at1: 15, atK: 40 }, vectors: { at1: 12, atK: 45 }, hybrid: { at1: 20, atK: 50 } },
      TOTAL,
      K,
    );
    expect(g.wide.beatsBm25 && g.wide.beatsVectors).toBe(true);
    expect(g.tight.beatsBm25 && g.tight.beatsVectors).toBe(true);
    expect(g.clearsBar).toBe(false);
    expect(g.pass).toBe(false);
    // The ratchet, pinned. Raising this number to accommodate a regression is
    // the one move the ruling forbids, and this line is what fails when
    // somebody tries it.
    expect(PHASE_3_FLOOR).toEqual({ hits: 51, of: 60 });
    expect(PHASE_3_GATE).toBe(51 / 60);
  });

  /**
   * And the amendment itself: a saturated recall@5 must no longer be fatal.
   * This is the case the pre-amendment gate failed, and it is here so that
   * anyone restoring the old strict `>` at recall@5 breaks a test that says in
   * its name what they broke.
   */
  it('accepts a three-way tie at recall@5 when recall@1 is a strict win', () => {
    expect(judge('hybrid', MEASURED, TOTAL, K).wide.beatsVectors).toBe(true);
  });

  it('states both comparison operators in the rule it prints', () => {
    const rule = ruleLine(K, TOTAL);
    expect(rule).toContain('≥ both singles at recall@5');
    expect(rule).toContain('strictly > both at recall@1');
    expect(rule).toContain(`${String(Math.round(PHASE_3_GATE * TOTAL))}/${String(TOTAL)}`);
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
    phase3: {
      mode: string;
      wide: { comparison: string; beatsBm25: boolean; beatsVectors: boolean };
      tight: { comparison: string; beatsBm25: boolean; beatsVectors: boolean };
      clearsBar: boolean;
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
 * The end-to-end half. It runs the real eval twice — once as shipped, once
 * with the semantic half of the fusion removed — and asserts the gate goes
 * green then red. That is `plans/08` rule 4 discharged against the actual
 * pipeline rather than against a function that models it.
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
   * C-1 step 1 — **the shipped run now fails, and that is the finding.**
   *
   * Until 25 aug 2026 this test asserted `exit 0 as shipped`, and it was
   * measuring `recall()` at the library default, which withholds nothing. The
   * verb runs at `weak`. So the number the phase-3 gate had been judging for
   * three phases was the **ranking** — 57/60 at recall@5, published in the
   * release notes as this build's verified retrieval quality — while
   * `potsherd find` returned an empty page for 52 of the same 60 queries.
   *
   * The instrument was corrected, no clause of `evals/gate.ts` was touched,
   * and the gate went red on all five clauses. Reported as a finding rather
   * than repaired, per the ruling on C-1: *if step 1 alone makes the gate
   * unmeetable, that is a finding, not a failure.* The floor cannot be lowered
   * to meet it without giving up F1 — C-1 §1 has the exhaustive search: over
   * every threshold on every scale-free quantity the index carries, the most
   * that can be returned while every no-match control still comes back empty
   * is 16 of 60.
   *
   * This test therefore pins **both** numbers and the gap between them. If a
   * later change closes the gap honestly, the `pass: false` line goes red and
   * whoever closed it has to come here and say how. If a later change quietly
   * re-points the gate at the ranking, `floor.judged` goes red first.
   */
  it('is judged on the verb, and the verb does not clear the gate', () => {
    const shipped = runEvals([]);
    // The premise, established rather than assumed: the vector modes really
    // did run in this process, so there really was a gate to judge.
    expect(shipped.json.index?.skipped ?? null).toBe(null);
    expect(shipped.json.weights.overridden).toBe(false);
    expect(shipped.json.weights.semanticLane).toBe('present');
    expect(shipped.json.weights.vectorWeight).toBe(shipped.json.weights.shipped);
    expect(shipped.json.gates.phase3.length).toBeGreaterThan(0);

    // What is being judged: the floor the verb runs at, not the library's.
    expect(shipped.json.floor.judged).toBe('weak');
    expect(shipped.json.floor.ranking).toBe('none');

    // And the two numbers, side by side. The ranking clears the 51/60 ratchet
    // comfortably; the verb is nowhere near it, and the difference is the rows
    // the floor withheld.
    const hybrid = shipped.json.modes.find((m) => m.mode === 'hybrid')!;
    expect(hybrid.ranking.hits).toBeGreaterThanOrEqual(51);
    expect(hybrid.hits).toBeLessThan(hybrid.ranking.hits);
    expect(hybrid.ranking.withheld).toBeGreaterThan(30);
    expect(hybrid.ranking.emptyPages).toBeGreaterThan(shipped.json.queries / 2);

    expect(shipped.code).toBe(1);
    expect(shipped.json.pass).toBe(false);
    const gate = shipped.json.gates.phase3.find((g) => g.mode === 'hybrid');
    expect(gate?.clearsBar).toBe(false);

    const regressed = runEvals(['--no-vector-lists']);
    expect(regressed.json.index?.skipped ?? null).toBe(null);
    expect(regressed.json.weights.semanticLane).toBe('removed');
    // The lane is gone; the *weight* is untouched, which is the distinction
    // this control exists to make. A future edit that goes back to expressing
    // the control as a weight turns this line red.
    expect(regressed.json.weights.overridden).toBe(false);
    expect(regressed.code).toBe(1);
    expect(regressed.json.pass).toBe(false);
    // And it fails for the reason the amendment cares about, not by accident —
    // on both of the clauses `gate.ts` records for it.
    const regressedGate = regressed.json.gates.phase3.find((g) => g.mode === 'hybrid');
    expect(regressedGate?.tight.beatsBm25).toBe(false);
    expect(regressedGate?.clearsBar).toBe(false);
  }, 480_000);

  /**
   * The finding that made this file wrong, kept as an assertion so that it
   * cannot quietly stop being true and leave the paragraph above stale a
   * second time.
   *
   * `--vector-weight 0` is a real weight probe and stays one. What it is NOT
   * is a proof that the gate can fail: it removes the semantic lane's
   * contribution to the fused score and nothing else, and the fused score is
   * `byLabel`'s fourth key. If a future change ever makes a zero weight
   * genuinely collapse hybrid onto bm25, this test goes red and whoever
   * changed it can decide which control the repository wants.
   */
  it('records that a zero vector WEIGHT is not the same thing as no lane', () => {
    const zeroed = runEvals(['--vector-weight', '0']);
    expect(zeroed.json.index?.skipped ?? null).toBe(null);
    expect(zeroed.json.weights.overridden).toBe(true);
    expect(zeroed.json.weights.vectorWeight).toBe(0);
    expect(zeroed.json.weights.semanticLane).toBe('present');
    const hybrid = zeroed.json.modes.find((m) => m.mode === 'hybrid');
    const bm25 = zeroed.json.modes.find((m) => m.mode === 'bm25');
    // The measurement: zero-weighted lists still buy queries, because they
    // still feed `strength` and `agreement` to the primary sort key.
    //
    // C-1 step 1 — read off the RANKING view, which is the half of the run
    // P11's claim was ever about. `hits` is now the verb's, and at the floor
    // the semantic lane does not buy queries at all: it is the fused ORDER
    // that a zero weight fails to erase, and the floor is computed from
    // wording, which no lane and no weight can change. That is not a
    // contradiction of P11, it is C-1, and it is asserted below so the two
    // findings stay legible next to each other.
    expect(hybrid!.ranking.hits).toBeGreaterThan(bm25!.ranking.hits);
    expect(hybrid!.ranking.hits1).toBeGreaterThan(bm25!.ranking.hits1);
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
    // labelled, which is the whole of step 1.
    expect(RANKING_FLOOR).toBe('none');
    expect(RANKING_FLOOR).not.toBe(VERB_FLOOR);
  });
});

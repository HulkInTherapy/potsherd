import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { embeddings } from '@potsherd/core';

import { PHASE_3_FLOOR, PHASE_3_GATE, judge, ruleLine, type GateInput } from '../evals/gate.js';

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
 *   2. **The whole eval, run with the vector weight forced to 0.** Runs only
 *      where the 34 MB embedding model is already on disk, because without
 *      vectors there are no vector modes, and with no vector modes there is no
 *      gate to judge at all. That is a premise this test cannot establish
 *      without a 34 MB download inside `pnpm test`, so it is honest about
 *      needing it and names the one-line command in its skip message.
 *
 * The numbers in layer 1 are not invented. They are the two runs measured on
 * this checkout on **25 aug 2026**, against `evals/queries.jsonl` as it stands
 * today: **60 recall queries plus 6 confidence controls**, 66 JSON lines, the
 * set T10.10 widened it to.
 *
 * ```
 * pnpm evals                        -> exit 0   @5 bm25 39 vec 51 hyb 51 · @1 bm25 24 vec 24 hyb 27
 * pnpm evals -- --vector-weight 0   -> exit 1   @5 bm25 39 vec 12 hyb 40 · @1 bm25 24 vec  9 hyb 24
 * ```
 *
 * **VERIFICATION-5 C-11.** What was written here before was a 25-query run
 * from 22 aug (`@5 bm25 12 vec 22 hyb 22 · @1 bm25 10 vec 6 hyb 11`) against a
 * set that has held 60 queries since phase 10 — and `PHASE_3_FLOOR` had already
 * been moved to `{ hits: 51, of: 60 }` for that set while this comment went on
 * describing the instrument it replaced. This paragraph's own rule, quoted
 * below and then broken by it: *a comment that describes a run nobody can
 * reproduce is the failure this project keeps finding.* Both commands above
 * were run, in that order, on this commit; either can be run again.
 *
 * These numbers are a RECORD of a run, not an input to one: the assertions
 * below are written against numbers this file states itself, so that a shift in
 * the corpus cannot quietly satisfy them. When they move, move them — and move
 * this paragraph with them.
 *
 * NOTE the margin at recall@1 is THREE on the wider set: hybrid 27 against
 * bm25 24 and vectors 24. On the old 25-query set it was one. The wider set
 * covers all twelve ghosts where the old covered five, so the gate is judged on
 * more of the corpus and by a margin that a single query flipping no longer
 * decides — which is the trade the widening bought, and the reason the floor
 * moved with it rather than staying at 22/25.
 *
 * `--vector-weight 0` does not collapse hybrid exactly onto bm25 (40 against
 * 39 at recall@5): with the semantic half weighted to nothing the fusion still
 * reorders on the RRF ranks. It ties bm25 at recall@1, which is the clause
 * that fails it, and it lands 11 under the floor, which is the second.
 */

// The measured release run: the shape the amended gate is supposed to pass.
const MEASURED: GateInput = {
  bm25: { at1: 24, atK: 39 },
  vectors: { at1: 24, atK: 51 },
  hybrid: { at1: 27, atK: 51 },
};

// The measured `--vector-weight 0` run: fusion with its semantic half removed.
// It does not collapse *exactly* onto bm25 — 40 against 39 at recall@5, because
// the fusion still reorders on the RRF ranks — but it ties it where the gate
// looks hardest, at recall@1, and lands 11 under the floor.
const REGRESSION: GateInput = {
  bm25: { at1: 24, atK: 39 },
  vectors: { at1: 9, atK: 12 },
  hybrid: { at1: 24, atK: 40 },
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
    // recall@1 is where the fusion is actually worth something: 27 against 24
    // and 24. It passes strictly.
    expect(g.tight.comparison).toBe('>');
    expect(g.tight.hybrid).toBeGreaterThan(g.tight.bm25);
    expect(g.tight.hybrid).toBeGreaterThan(g.tight.vectors);
    expect(g.clearsBar).toBe(true);
  });

  it('FAILS the vector-weight-0 regression, and fails it on recall@1', () => {
    const g = judge('hybrid', REGRESSION, TOTAL, K);
    expect(g.pass).toBe(false);
    // The load-bearing one: with no vector half, hybrid *ties* bm25 at
    // recall@1, and the amended gate demands a strict win there.
    expect(g.tight.beatsBm25).toBe(false);
    // It also drops under the absolute bar. Two independent reasons is the
    // right number for a regression this total, but the recall@1 clause is the
    // one that would still catch a subtler one.
    expect(g.clearsBar).toBe(false);
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
      judge('hybrid', { ...MEASURED, hybrid: { at1: 24, atK: 51 } }, TOTAL, K).pass,
    ).toBe(false);
    expect(
      judge(
        'hybrid',
        { bm25: { at1: 10, atK: 30 }, vectors: { at1: 27, atK: 51 }, hybrid: { at1: 27, atK: 51 } },
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
  weights: { vectorWeight: number; shipped: number; overridden: boolean };
  gates: {
    phase3: {
      mode: string;
      wide: { comparison: string; beatsBm25: boolean; beatsVectors: boolean };
      tight: { comparison: string; beatsBm25: boolean; beatsVectors: boolean };
      clearsBar: boolean;
      pass: boolean;
    }[];
  };
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
 *     POTSHERD_EVALS_EMBED=1 pnpm evals -- --vector-weight 0     # must exit 1
 */
describe.skipIf(MODEL === null)('pnpm evals, end to end (needs a cached model)', () => {
  it('exits 0 as shipped and 1 with the vector weight forced to 0', () => {
    const shipped = runEvals([]);
    // The premise, established rather than assumed: the vector modes really
    // did run in this process, so there really was a gate to judge.
    expect(shipped.json.index?.skipped ?? null).toBe(null);
    expect(shipped.json.weights.overridden).toBe(false);
    expect(shipped.json.weights.vectorWeight).toBe(shipped.json.weights.shipped);
    expect(shipped.json.gates.phase3.length).toBeGreaterThan(0);
    expect(shipped.code).toBe(0);
    expect(shipped.json.pass).toBe(true);

    const regressed = runEvals(['--vector-weight', '0']);
    expect(regressed.json.index?.skipped ?? null).toBe(null);
    expect(regressed.json.weights.overridden).toBe(true);
    expect(regressed.json.weights.vectorWeight).toBe(0);
    expect(regressed.code).toBe(1);
    expect(regressed.json.pass).toBe(false);
    // And it fails for the reason the amendment cares about, not by accident.
    const hybrid = regressed.json.gates.phase3.find((g) => g.mode === 'hybrid');
    expect(hybrid?.tight.beatsBm25).toBe(false);
  }, 240_000);
});

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { db as store, Theme, markers } from '@potsherd/core';
import {
  API_MODEL_IDS,
  Budget,
  BudgetError,
  CALL_PROFILES,
  DEFAULT_TIMEOUT_MS,
  TIMEOUT_RETRIES,
  MODEL_CALL_VERBS,
  OFFLINE_VERBS,
  CARD_MODEL,
  CHARS_PER_TOKEN,
  Llm,
  LlmError,
  IMPLAUSIBLE_TOKEN_FACTOR,
  NoBackendError,
  PRICES,
  REENTRANCY_ENV,
  ReentrancyError,
  availability,
  detectBackend,
  effectiveConcurrency,
  estimate,
  lastAgentMessage,
  modelClass,
  parseJsonish,
  redactOutgoing,
  resolveModel,
  tokensForChars,
  type Backend,
  type SendRequest,
  type SendResult,
  type Transport,
} from '../packages/core/src/llm.js';
import {
  MIN_EXCHANGES,
  MIN_GHOST_PROMPTS,
  isStale,
  planCards,
} from '../packages/core/src/cards/plan.js';
import { renderEstimate } from '../packages/core/src/render/estimate.js';
import {
  accuracyNote,
  cardRuns,
  readCalibration,
  recordCardRun,
  MIN_CALLS as MIN_CALIBRATION_CALLS,
} from '../packages/core/src/calibration.js';
import { rmrf, tempDir } from './helpers.js';

/**
 * `llm.ts` is the only place in potsherd that can leak a credential to a third
 * party, and the only place that can spend money. Both of those are tested
 * here against a transport that records exactly what a real backend would have
 * been handed — the seam is deliberately below redaction and below the budget,
 * so a test cannot be fooled by a caller that happens to redact first.
 */

const created: string[] = [];
afterEach(() => {
  while (created.length) rmrf(created.pop()!);
});

function scratch(prefix = 'potsherd-llm-test-'): string {
  const dir = tempDir(prefix);
  created.push(dir);
  return dir;
}

/** Records every request, answers with whatever the test queued. */
class RecordingTransport implements Transport {
  readonly sent: SendRequest[] = [];
  closed = 0;
  constructor(
    readonly backend: Backend = 'agent-sdk',
    private readonly replies: (string | Error)[] = ['ok'],
  ) {}
  async send(req: SendRequest): Promise<SendResult> {
    this.sent.push(req);
    const reply = this.replies[Math.min(this.sent.length - 1, this.replies.length - 1)] ?? 'ok';
    if (reply instanceof Error) throw reply;
    return { text: reply, inputTokens: 100, outputTokens: 20, usd: 0.001 };
  }
  async close(): Promise<void> {
    this.closed++;
  }
}

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const GH_TOKEN = 'ghp_' + 'a'.repeat(36);

// -------------------------------------------------------------- redaction

describe('llm redaction gate', () => {
  it('masks a planted credential before the backend ever sees it', async () => {
    const t = new RecordingTransport();
    const llm = Llm.open({ transport: t });
    await llm.text({
      prompt: `here is the failing deploy:\n  AWS_ACCESS_KEY_ID=${AWS_KEY}\n  it 403s`,
    });

    const seen = t.sent[0]!.prompt;
    expect(seen).not.toContain(AWS_KEY);
    expect(seen).toMatch(/‹redacted:aws:[0-9a-f]{8}›/);
    // The surrounding text survives: redaction removes the secret, not the
    // meaning, or the card would be about nothing.
    expect(seen).toContain('here is the failing deploy');
    expect(seen).toContain('it 403s');
  });

  it('masks the system prompt too', async () => {
    const t = new RecordingTransport();
    const llm = Llm.open({ transport: t });
    await llm.text({ prompt: 'summarise', system: `token ${GH_TOKEN} is the one to use` });
    expect(t.sent[0]!.system).toBeDefined();
    expect(t.sent[0]!.system).not.toContain(GH_TOKEN);
    expect(t.sent[0]!.system).toMatch(/‹redacted:github:[0-9a-f]{8}›/);
  });

  it('counts what it masked, so a caller can report it', async () => {
    const llm = Llm.open({ transport: new RecordingTransport() });
    const r = await llm.text({ prompt: `${AWS_KEY} and ${GH_TOKEN}` });
    expect(r.redactions).toBe(2);
  });

  it('redacts through the json path as well', async () => {
    const t = new RecordingTransport('agent-sdk', ['{"title":"x"}']);
    const llm = Llm.open({ transport: t });
    await llm.json({
      prompt: `the key was ${AWS_KEY}`,
      schema: '{"title": string}',
      fallback: { title: '' },
    });
    expect(t.sent[0]!.prompt).not.toContain(AWS_KEY);
  });

  it('the same secret always produces the same mask', () => {
    const a = redactOutgoing(`x ${AWS_KEY} y`);
    const b = redactOutgoing(`totally different ${AWS_KEY}`);
    const maskA = /‹redacted:aws:[0-9a-f]{8}›/.exec(a.text)![0];
    const maskB = /‹redacted:aws:[0-9a-f]{8}›/.exec(b.text)![0];
    expect(maskA).toBe(maskB);
  });
});

// ------------------------------------------------------------ re-entrancy

describe('re-entrancy', () => {
  it('every outgoing prompt carries the marker that keeps it out of the index', async () => {
    const t = new RecordingTransport();
    const llm = Llm.open({ transport: t });
    await llm.text({ prompt: 'hello' });
    expect(markers.hasExclusionMarker(t.sent[0]!.prompt)).toBe(true);
  });

  it('refuses to call a model from inside a potsherd-spawned process', () => {
    expect(() => Llm.open({ env: { ...process.env, [REENTRANCY_ENV]: '1' } })).toThrow(
      ReentrancyError,
    );
  });
});

// -------------------------------------------------------------- detection

const NOTHING = { claude: null, codex: null };
const which = (found: Record<string, string | null>) => (n: string) => found[n] ?? null;

describe('backend detection', () => {
  it('picks agent-sdk when a claude binary exists', () => {
    const c = detectBackend({ env: {}, which: which({ claude: '/usr/local/bin/claude' }) });
    expect(c.backend).toBe('agent-sdk');
    expect(c.chargeable).toBe(false);
    expect(c.why).toContain('claude');
  });

  it('prefers the subscription even when an api key is also set', () => {
    const c = detectBackend({
      env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
      which: which({ claude: '/usr/local/bin/claude' }),
    });
    // `04` Q4: the key is a fallback, not a preference. A Claude Code user must
    // never be billed for what their subscription already covers.
    expect(c.backend).toBe('agent-sdk');
  });

  it('falls back to the api key when there is no claude binary', () => {
    const c = detectBackend({ env: { ANTHROPIC_API_KEY: 'sk-ant-test' }, which: which(NOTHING) });
    expect(c.backend).toBe('api');
    expect(c.chargeable).toBe(true);
  });

  it('uses codex when codex is the harness and there is no claude', () => {
    const c = detectBackend({
      env: { CODEX_HOME: '/home/x/.codex', ANTHROPIC_API_KEY: 'sk-ant-test' },
      which: which({ codex: '/usr/local/bin/codex' }),
    });
    expect(c.backend).toBe('codex');
  });

  it('names both ways out when there is neither', () => {
    let err: unknown;
    try {
      detectBackend({ env: {}, which: which(NOTHING) });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NoBackendError);
    const e = err as NoBackendError;
    expect(e.message).toContain('claude');
    expect(e.message).toContain('ANTHROPIC_API_KEY');
    expect(e.fix).toContain('ANTHROPIC_API_KEY');
  });

  it('an empty ANTHROPIC_API_KEY is not a credential', () => {
    expect(availability({ env: { ANTHROPIC_API_KEY: '   ' }, which: which(NOTHING) }).apiKey).toBe(
      false,
    );
    expect(() => detectBackend({ env: { ANTHROPIC_API_KEY: '' }, which: which(NOTHING) })).toThrow(
      NoBackendError,
    );
  });

  it('POTSHERD_LLM_BACKEND forces a backend', () => {
    const c = detectBackend({
      env: { POTSHERD_LLM_BACKEND: 'api' },
      which: which({ claude: '/usr/local/bin/claude' }),
    });
    expect(c.backend).toBe('api');
  });
});

describe('model resolution', () => {
  it('passes aliases through untouched on the subscription paths', () => {
    expect(resolveModel('haiku', 'agent-sdk')).toBe('haiku');
    expect(resolveModel('sonnet', 'codex')).toBe('sonnet');
  });

  it('resolves aliases only for the api path, which has no aliasing', () => {
    expect(resolveModel('haiku', 'api')).toBe(API_MODEL_IDS.haiku);
    expect(API_MODEL_IDS.haiku).toContain('haiku');
  });

  it('passes an explicit model id through on every path', () => {
    for (const b of ['agent-sdk', 'codex', 'api'] as Backend[]) {
      expect(resolveModel('claude-haiku-4-5', b)).toBe('claude-haiku-4-5');
    }
  });

  it('prices an unrecognised model as the most expensive class it knows', () => {
    expect(modelClass('some-future-model')).toBe('opus');
    expect(modelClass('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(modelClass('sonnet')).toBe('sonnet');
  });

  it('the default card model is haiku-class, per 04 Q4', () => {
    expect(modelClass(CARD_MODEL)).toBe('haiku');
  });
});

// -------------------------------------------------------------- estimator

describe('estimate', () => {
  it('is chars / 3.6 of the redacted text', () => {
    const e = estimate({ sessions: [{ id: 'a', chars: 3_600 }], promptOverheadChars: 0 });
    expect(tokensForChars(3_600)).toBe(1_000);
    expect(e.inputTokens).toBe(1_000);
    expect(CHARS_PER_TOKEN).toBe(3.6);
  });

  it('prices the api path at the model class list price', () => {
    // The api path is the one a user is really billed for, and there the
    // token arithmetic *is* the invoice.
    const e = estimate({
      sessions: [{ id: 'a', chars: 3_600_000 }],
      model: 'haiku',
      backend: 'api',
      promptOverheadChars: 0,
      outputCharsPerCall: 0,
      chunkChars: 3_600_000,
    });
    expect(e.inputTokens).toBe(1_000_000);
    expect(e.outputTokens).toBe(0);
    expect(e.usd).toBeCloseTo(PRICES.haiku.inputPerMTok, 6);
  });

  it('charges a long session for the map-reduce it will need', () => {
    const one = estimate({ sessions: [{ id: 'a', chars: 10_000 }], chunkChars: 40_000 });
    const many = estimate({ sessions: [{ id: 'a', chars: 130_000 }], chunkChars: 40_000 });
    expect(one.calls).toBe(1);
    // 4 chunks + 1 reduce.
    expect(many.calls).toBe(5);
  });

  it('reports zero for an empty run rather than throwing', () => {
    const e = estimate({ sessions: [] });
    expect(e).toMatchObject({ sessions: 0, calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 });
    expect(e.seconds).toBe(0);
  });

  it('time is a fixed cost per call plus a cost per character', () => {
    const p = CALL_PROFILES['agent-sdk'];
    const small = estimate({ sessions: [{ id: 'a', chars: 1_000 }], promptOverheadChars: 0 });
    const big = estimate({ sessions: [{ id: 'a', chars: 39_000 }], promptOverheadChars: 0 });
    expect(small.calls).toBe(1);
    expect(big.calls).toBe(1);
    expect(small.seconds).toBeCloseTo((p.baseMs + p.msPerKChar * 1) / 1_000, 5);
    // The bug this replaced: one flat constant per call, so a 40k chunk was
    // quoted at the same 5.4 s as a ten-token probe. It is not.
    expect(big.seconds).toBeGreaterThan(small.seconds * 1.5);
  });

  it('does not pretend concurrency is free', () => {
    const p = CALL_PROFILES['agent-sdk'];
    const serial = estimate({
      sessions: Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, chars: 20_000 })),
    });
    const parallel = estimate({
      sessions: Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, chars: 20_000 })),
      concurrency: 6,
    });
    expect(effectiveConcurrency(6, p)).toBeCloseTo(5, 5);
    expect(parallel.seconds).toBeCloseTo(serial.seconds / 5, 5);
    // Never the naive divide-by-six that produced "7m 26s" for a 55-minute run.
    expect(parallel.seconds).toBeGreaterThan(serial.seconds / 6);
    expect(parallel.effectiveConcurrency).toBeCloseTo(5, 5);
  });

  it('gives a range, because a point estimate was 7x wrong once', () => {
    const e = estimate({ sessions: [{ id: 'a', chars: 40_000 }], concurrency: 6 });
    expect(e.secondsLow).toBeLessThan(e.seconds);
    expect(e.secondsHigh).toBeGreaterThan(e.seconds);
    expect(e.usdLow).toBeLessThan(e.usd);
    expect(e.usdHigh).toBeGreaterThan(e.usd);
    expect(e.basis).toMatch(/real calls/);
    expect(e.measured).toBe(true);
    expect(estimate({ sessions: [{ id: 'a', chars: 1 }], backend: 'api' }).measured).toBe(false);
  });

  it('reproduces the one real run it is fitted to, within 2x', () => {
    // 21 aug 2026: 33 eligible sessions of the frozen corpus, 209 calls,
    // 55m 25s at concurrency 6, $12.93 api-equivalent. The old estimator said
    // 7m 26s and $2.66. Sizes below are the real per-session character counts
    // reduced to their mean; what is asserted is the order of magnitude.
    const perCall = 35_454;
    const e = estimate({
      sessions: Array.from({ length: 209 }, (_, i) => ({
        id: `s${i}`,
        chars: perCall,
        calls: 1,
      })),
      promptOverheadChars: 0,
      concurrency: 6,
    });
    expect(e.calls).toBe(209);
    for (const [actual, got] of [
      [3_325, e.seconds],
      [12.93, e.usd],
    ] as const) {
      expect(got).toBeGreaterThan(actual / 2);
      expect(got).toBeLessThan(actual * 2);
    }
  });

  it('knows the subscription path spends no money', () => {
    const sub = estimate({ sessions: [{ id: 'a', chars: 1_000 }], backend: 'agent-sdk' });
    const api = estimate({ sessions: [{ id: 'a', chars: 1_000 }], backend: 'api' });
    expect(sub.chargeable).toBe(false);
    expect(api.chargeable).toBe(true);
    // The equivalent is still computed on both: 03 §12's $2 target is real for
    // anyone on a key, and it is the number that lets someone choose.
    expect(sub.usd).toBeGreaterThan(0);
    expect(api.usd).toBeGreaterThan(0);
    // They are no longer the same number, and that is the point: the agent
    // sdk's own `total_cost_usd` includes its system prompt, its cache writes
    // and its reasoning output. Pricing that path from tokens alone quoted the
    // one recorded run at $4.25 against a real $12.93.
    expect(sub.usd).toBeGreaterThan(api.usd);
  });

  it('scales linearly in sessions', () => {
    const s = (n: number) =>
      estimate({ sessions: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, chars: 5_000 })) });
    expect(s(10).usd).toBeCloseTo(s(1).usd * 10, 8);
  });
});

// ------------------------------------------------------- token accounting

/**
 * The agent SDK counts only the uncached tokens of its final turn, so it
 * reported **10** for every one of the twelve real calls measured for T2.6 —
 * and **1,980 in total** for a 198-call run over two million characters. A
 * column headed "input tokens" that prints that number is not slightly wrong;
 * it is measuring something else.
 */
describe('token accounting on the agent-sdk path', () => {
  class Reporting implements Transport {
    readonly backend = 'agent-sdk' as const;
    constructor(private readonly usage: Partial<SendResult>) {}
    async send(): Promise<SendResult> {
      return { text: 'ok', ...this.usage };
    }
    async close(): Promise<void> {}
  }

  const bigPrompt = 'x'.repeat(40_000);

  it('prefers its own estimate when the backend under-reports by an order of magnitude', async () => {
    const llm = Llm.open({ transport: new Reporting({ inputTokens: 10, outputTokens: 900 }) });
    const r = await llm.text({ prompt: bigPrompt });
    expect(r.inputTokensEstimated).toBe(true);
    // chars / 3.6, not 10.
    expect(r.inputTokens).toBeGreaterThan(10_000);
    expect(r.outputTokensEstimated).toBe(false);
    expect(r.outputTokens).toBe(900);
  });

  it('believes a backend that counts honestly, and says it was measured', async () => {
    const honest = Math.round(40_000 / CHARS_PER_TOKEN);
    const llm = Llm.open({ transport: new Reporting({ inputTokens: honest, outputTokens: 40 }) });
    const r = await llm.text({ prompt: bigPrompt });
    expect(r.inputTokensEstimated).toBe(false);
    expect(r.inputTokens).toBe(honest);
  });

  it('draws the line at one order of magnitude, not at taste', async () => {
    const estimated = Math.ceil(40_000 / CHARS_PER_TOKEN);
    // Just inside: a real tokenizer differs from chars / 3.6 by tens of
    // percent, never by 1,000x, so anything this close is believed.
    const near = Math.ceil(estimated / (IMPLAUSIBLE_TOKEN_FACTOR - 1));
    const llmNear = Llm.open({ transport: new Reporting({ inputTokens: near }) });
    expect((await llmNear.text({ prompt: bigPrompt })).inputTokensEstimated).toBe(false);

    const far = Math.floor(estimated / (IMPLAUSIBLE_TOKEN_FACTOR + 1));
    const llmFar = Llm.open({ transport: new Reporting({ inputTokens: far }) });
    expect((await llmFar.text({ prompt: bigPrompt })).inputTokensEstimated).toBe(true);
  });

  it('counts how many calls of a run had to be estimated', async () => {
    const llm = Llm.open({ transport: new Reporting({ inputTokens: 10 }) });
    await llm.text({ prompt: bigPrompt });
    await llm.text({ prompt: bigPrompt });
    expect(llm.spend.calls).toBe(2);
    expect(llm.spend.estimatedInputCalls).toBe(2);
    expect(llm.spend.inputTokens).toBeGreaterThan(20_000);
  });
});

// ------------------------------------------------------------ calibration

/**
 * The estimator's self-check. Constants fitted on one machine are still a
 * guess about every other one; the only measurement that settles it is the
 * user's own finished run.
 */
describe('calibration from the machine own runs', () => {
  const finished = {
    backend: 'agent-sdk' as const,
    model: 'haiku',
    concurrency: 6,
    targets: 33,
    predictedCalls: 209,
    predictedSeconds: 3_287,
    predictedUsd: 11.18,
    actualCalls: 209,
    actualSeconds: 3_325,
    actualUsd: 12.93,
    complete: true,
  };

  it('has a card_runs table from migration 6', () => {
    const db = store.open({ file: ':memory:' });
    expect(store.schemaVersion(db)).toBeGreaterThanOrEqual(6);
    expect(cardRuns(db)).toEqual([]);
    db.close();
  });

  it('records what a run was quoted and what it did', () => {
    const db = store.open({ file: ':memory:' });
    const row = recordCardRun(db, finished);
    expect(row.timeRatio).toBeCloseTo(3_325 / 3_287, 4);
    expect(row.usdRatio).toBeCloseTo(12.93 / 11.18, 4);
    expect(cardRuns(db)).toHaveLength(1);
    db.close();
  });

  it('corrects the next estimate by what the last run did', () => {
    const db = store.open({ file: ':memory:' });
    expect(readCalibration(db)).toBeNull();
    // A run that came in 3x over.
    recordCardRun(db, { ...finished, actualSeconds: 9_861, actualUsd: 33.54 });
    const cal = readCalibration(db, { backend: 'agent-sdk' })!;
    expect(cal.samples).toBe(1);
    expect(cal.timeRatio).toBeCloseTo(3, 2);
    expect(cal.usdRatio).toBeCloseTo(3, 2);

    const plain = estimate({ sessions: [{ id: 'a', chars: 40_000 }] });
    const corrected = estimate({ sessions: [{ id: 'a', chars: 40_000 }], calibration: cal });
    expect(corrected.seconds / plain.seconds).toBeCloseTo(3, 1);
    expect(corrected.usd / plain.usd).toBeCloseTo(3, 1);
    expect(corrected.calibration?.samples).toBe(1);
    db.close();
  });

  it('ignores a run that a ceiling stopped, and one too small to mean anything', () => {
    const db = store.open({ file: ':memory:' });
    recordCardRun(db, { ...finished, actualSeconds: 9_861, complete: false });
    expect(readCalibration(db)).toBeNull();
    recordCardRun(db, {
      ...finished,
      actualCalls: MIN_CALIBRATION_CALLS - 1,
      actualSeconds: 9_861,
    });
    expect(readCalibration(db)).toBeNull();
    db.close();
  });

  it('clamps a wild ratio rather than quoting nonsense forever', () => {
    const db = store.open({ file: ':memory:' });
    recordCardRun(db, { ...finished, actualSeconds: 3_287_000, actualUsd: 11_180 });
    expect(readCalibration(db)!.timeRatio).toBe(5);
    expect(readCalibration(db)!.usdRatio).toBe(5);
    db.close();
  });

  it('the plan reads the correction from the store without being asked', () => {
    const { db, addSession } = seededDb(scratch());
    addSession('s', 5, 20_000);
    const before = planCards(db, { backend: 'agent-sdk' });
    expect(before.estimate.calibration).toBeUndefined();

    recordCardRun(db, { ...finished, actualSeconds: 6_574, actualUsd: 22.36 });
    const after = planCards(db, { backend: 'agent-sdk' });
    expect(after.estimate.calibration?.samples).toBe(1);
    expect(after.estimate.seconds).toBeGreaterThan(before.estimate.seconds * 1.8);

    // A caller that wants the fitted constants alone can still have them.
    const pinned = planCards(db, { backend: 'agent-sdk', calibration: null });
    expect(pinned.estimate.seconds).toBeCloseTo(before.estimate.seconds, 5);

    // The correction is on the screen, not only in the arithmetic.
    const out = renderEstimate(after, new Theme({ color: false, width: 80 }));
    expect(out).toContain('corrected');
    expect(out).toContain('1 finished run here');
    db.close();
  });

  it('says how wrong the estimate was, in words a user can read', () => {
    expect(
      accuracyNote({
        predictedSeconds: 446,
        actualSeconds: 3_325,
        predictedUsd: 2.66,
        actualUsd: 12.93,
      }),
    ).toBe('the estimate was 7.5x under on time and 4.9x under on cost');
    expect(
      accuracyNote({
        predictedSeconds: 3_287,
        actualSeconds: 3_325,
        predictedUsd: 11.18,
        actualUsd: 12.93,
      }),
    ).toContain('right on time');
  });
});

// ----------------------------------------------------------------- budget

describe('budget caps', () => {
  it('--max-usd stops the run before the ceiling, not after it', async () => {
    const t = new RecordingTransport();
    // One call is ~100 in / 20 out, ~$0.001 of recorded spend, but the gate
    // uses the *projection*, which reserves the full output allowance.
    const llm = Llm.open({ transport: t, maxUsd: 0.0001 });
    await expect(llm.text({ prompt: 'hello' })).rejects.toBeInstanceOf(BudgetError);
    expect(t.sent).toHaveLength(0);
  });

  it('says how far it got', () => {
    const b = new Budget({ maxUsd: 1 });
    b.record({ inputTokens: 100, outputTokens: 10, usd: 0.9, ms: 10 });
    b.progress(27, 236);
    let err: unknown;
    try {
      b.admit({ usd: 0.5 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BudgetError);
    const e = err as BudgetError;
    expect(e.message).toContain('27 of 236');
    expect(e.detail.done).toBe(27);
    expect(e.detail.total).toBe(236);
    expect(e.detail.kind).toBe('usd');
    expect(e.fix).toContain('--max-usd');
  });

  // --- D1 (T4.5): the cap has to hold *within* a batch, not only between them.
  //
  // Before the reservation, `admit` ran before a call and `record` after it, so
  // at concurrency 6 all six workers cleared `admit` against a spend of $0 and
  // the run overshot `--max-usd` by a whole batch. `card --all` shipped with
  // this from v0.3.0. The numbers below are chosen to be exact in binary
  // floating point (0.125 * 4 === 0.5) so the assertion is about the gate and
  // not about rounding.
  it('holds --max-usd within one concurrent batch, not just between batches', async () => {
    const CONCURRENCY = 6;
    const MAX_USD = 0.5;
    const PER_CALL_USD = 0.125; // 4 fit exactly; the 5th and 6th must be refused
    const b = new Budget({ maxUsd: MAX_USD });
    b.progress(0, CONCURRENCY);

    let admitted = 0;
    let refused = 0;

    // Every task runs synchronously up to its first `await`, so all six
    // `admit`s happen before any `record` — which is exactly the in-flight
    // window the old code could not see.
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        let reservation;
        try {
          reservation = b.admit({ usd: PER_CALL_USD });
          admitted += 1;
        } catch (err) {
          expect(err).toBeInstanceOf(BudgetError);
          refused += 1;
          return;
        }
        await Promise.resolve(); // the model call
        b.record(
          { inputTokens: 0, outputTokens: 0, usd: PER_CALL_USD, ms: 0 },
          reservation,
        );
      }),
    );

    expect(admitted).toBe(4);
    expect(refused).toBe(CONCURRENCY - 4);
    expect(b.spend.usd).toBeLessThanOrEqual(MAX_USD);
    expect(b.spend.usd).toBeCloseTo(0.5, 6);
  });

  // The same defect one layer up: `Llm.text` is what `card --all` and `ask`
  // actually call, so the reservation has to be threaded through it and not
  // only exist on `Budget`. Six calls are launched at once against a cap that
  // affords four; the transport parks every call until all six have been
  // admitted or refused, which is the in-flight window the old code was blind
  // to. `--max-usd 0.02` is chosen against this transport's $0.001 recorded
  // spend and its ~$0.005 projection, so the arithmetic is the gate's.
  it('Llm.text holds --max-usd across six calls in flight at once', async () => {
    let release = (): void => {};
    const parked = new Promise<void>((r) => {
      release = r;
    });
    let inFlight = 0;
    const t: Transport = {
      backend: 'agent-sdk',
      async send() {
        inFlight += 1;
        await parked;
        return { text: 'ok', inputTokens: 100, outputTokens: 20, usd: 0.001 };
      },
      async close() {},
    };
    const llm = Llm.open({ transport: t, maxUsd: 0.02, maxOutputTokens: 1_000 });

    const settled = Promise.allSettled(
      Array.from({ length: 6 }, () => llm.text({ prompt: 'hello' })),
    );
    // Everything that is going to be admitted has been by now; nothing has
    // returned, so no `record` has run.
    await Promise.resolve();
    await Promise.resolve();
    release();
    const results = await settled;
    await llm.close();

    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const refused = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof BudgetError,
    ).length;
    expect(ok + refused).toBe(6);
    // Refusals happened, and they happened *before* the backend was reached —
    // which is the whole promise of a pre-call cap.
    expect(refused).toBeGreaterThan(0);
    expect(inFlight).toBe(ok);
    expect(llm.spend.calls).toBe(ok);
    expect(llm.spend.usd).toBeLessThanOrEqual(0.02);
  });

  it('gives a reservation back when the call throws, so one failure does not poison the cap', async () => {
    const b = new Budget({ maxUsd: 0.5 });
    const r = b.admit({ usd: 0.4 });
    r.release();
    // Without the release, 0.4 would still be held and this would throw.
    expect(() => b.admit({ usd: 0.4 })).not.toThrow();
  });

  it('replaces the reservation with the actual, so a high estimate does not stick', async () => {
    const b = new Budget({ maxUsd: 1 });
    const r = b.admit({ usd: 0.9 }); // pessimistic: full output allowance
    b.record({ inputTokens: 10, outputTokens: 10, usd: 0.01, ms: 1 }, r);
    expect(b.spend.usd).toBeCloseTo(0.01, 6);
    // The $0.89 the estimate over-reserved is available again.
    expect(() => b.admit({ usd: 0.9 })).not.toThrow();
  });

  // A single estimate larger than the whole cap must refuse *that* call and
  // leave the budget usable, rather than reserving itself into a state where
  // nothing can ever be admitted again.
  it('a huge estimate refuses itself and reserves nothing', () => {
    const b = new Budget({ maxUsd: 0.5 });
    expect(() => b.admit({ usd: 100 })).toThrow(BudgetError);
    expect(() => b.admit({ usd: 0.4 })).not.toThrow();
  });

  it('has a per-run token cap too', () => {
    const b = new Budget({ maxTokens: 1_000 });
    b.record({ inputTokens: 900, outputTokens: 50, usd: 0, ms: 0 });
    expect(() => b.admit({ tokens: 100 })).toThrow(BudgetError);
    expect(() => b.admit({ tokens: 10 })).not.toThrow();
  });

  it('tracks the equivalent spend even where nothing is charged', async () => {
    const t = new RecordingTransport('agent-sdk');
    const llm = Llm.open({ transport: t });
    await llm.text({ prompt: 'one' });
    await llm.text({ prompt: 'two' });
    expect(llm.spend.calls).toBe(2);
    expect(llm.spend.inputTokens).toBe(200);
    expect(llm.spend.usd).toBeCloseTo(0.002, 6);
  });

  it('a run with no cap never refuses a call', async () => {
    const t = new RecordingTransport();
    const llm = Llm.open({ transport: t });
    await llm.text({ prompt: 'x'.repeat(200_000) });
    expect(t.sent).toHaveLength(1);
  });
});

// -------------------------------------------------------------- json path

describe('json enforcement', () => {
  it('parses a clean object', async () => {
    const llm = Llm.open({ transport: new RecordingTransport('api', ['{"title":"a card"}']) });
    const r = await llm.json({ prompt: 'p', schema: '{title}', fallback: { title: '' } });
    expect(r.value).toEqual({ title: 'a card' });
    expect(r.attempts).toBe(1);
    expect(r.parsed).toBe(true);
  });

  it('unwraps a markdown fence', async () => {
    const llm = Llm.open({
      transport: new RecordingTransport('api', ['```json\n{"title":"fenced"}\n```']),
    });
    const r = await llm.json({ prompt: 'p', schema: '{title}', fallback: { title: '' } });
    expect(r.value).toEqual({ title: 'fenced' });
    expect(r.attempts).toBe(1);
  });

  it('retries exactly once on a parse failure, then succeeds', async () => {
    const t = new RecordingTransport('api', ['sorry, I cannot', '{"title":"second try"}']);
    const llm = Llm.open({ transport: t });
    const r = await llm.json({ prompt: 'p', schema: '{title}', fallback: { title: '' } });
    expect(r.value).toEqual({ title: 'second try' });
    expect(r.attempts).toBe(2);
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]!.prompt).toContain('could not be parsed');
  });

  it('falls back to a minimal result rather than throwing away the run', async () => {
    const t = new RecordingTransport('api', ['nope', 'still nope']);
    const llm = Llm.open({ transport: t });
    const r = await llm.json({
      prompt: 'p',
      schema: '{title}',
      fallback: { title: 'untitled' },
    });
    expect(r.value).toEqual({ title: 'untitled' });
    expect(r.parsed).toBe(false);
    // Two attempts and no more: a third would be an unbounded spend.
    expect(t.sent).toHaveLength(2);
  });

  it('a validator that rejects triggers the same one retry', async () => {
    const t = new RecordingTransport('api', ['{"wrong":1}', '{"title":"right"}']);
    const llm = Llm.open({ transport: t });
    const r = await llm.json<{ title: string }>({
      prompt: 'p',
      schema: '{title}',
      fallback: { title: '' },
      validate: (v) => {
        const o = v as { title?: unknown };
        return typeof o.title === 'string' ? { title: o.title } : null;
      },
    });
    expect(r.value).toEqual({ title: 'right' });
    expect(r.attempts).toBe(2);
  });

  it('tells the model the rule, every time', async () => {
    const t = new RecordingTransport('api', ['{}']);
    const llm = Llm.open({ transport: t });
    await llm.json({ prompt: 'p', schema: '{title}', fallback: {} });
    expect(t.sent[0]!.prompt).toContain('one JSON object and nothing else');
    expect(t.sent[0]!.prompt).toContain('{title}');
  });
});

describe('parseJsonish', () => {
  it('finds the object inside prose', () => {
    expect(parseJsonish('Here you go: {"a":1} — hope that helps')).toEqual({
      ok: true,
      value: { a: 1 },
    });
  });
  it('rejects an empty reply with a reason', () => {
    const r = parseJsonish('   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('empty reply');
  });
  it('rejects a reply with no json in it', () => {
    expect(parseJsonish('absolutely not').ok).toBe(false);
  });
});

// ------------------------------------------------------- spawned backends

/** A fake harness on PATH, so the spawn plumbing is real without a real CLI. */
function fakeBin(name: string, body: string): string {
  const dir = scratch('potsherd-bin-');
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  // The fake dir goes *in front of* the real PATH rather than replacing it:
  // the stub is a shell script and still needs `cat` and `sleep` to exist.
  return `${dir}${path.delimiter}${process.env['PATH'] ?? ''}`;
}

describe('codex backend plumbing', () => {
  it('feeds the prompt on stdin and reads the answer from stdout', async () => {
    const dir = fakeBin('codex', 'cat > /dev/null; echo "the answer"');
    const llm = Llm.open({
      backend: 'codex',
      env: { ...process.env, PATH: dir },
      tmpRoot: scratch(),
    });
    try {
      const r = await llm.text({ prompt: 'question' });
      expect(r.text).toBe('the answer');
      expect(r.backend).toBe('codex');
    } finally {
      await llm.close();
    }
  });

  it('reports a non-zero exit as something the user can act on', async () => {
    const dir = fakeBin('codex', 'echo "not logged in" >&2; exit 3');
    const llm = Llm.open({
      backend: 'codex',
      env: { ...process.env, PATH: dir },
      tmpRoot: scratch(),
    });
    try {
      await expect(llm.text({ prompt: 'q' })).rejects.toThrow(/exited 3/);
    } finally {
      await llm.close();
    }
  });

  it('never hangs: a silent backend hits the timeout', async () => {
    const dir = fakeBin('codex', 'sleep 30');
    const llm = Llm.open({
      backend: 'codex',
      env: { ...process.env, PATH: dir },
      tmpRoot: scratch(),
      timeoutMs: 300,
    });
    try {
      await expect(llm.text({ prompt: 'q' })).rejects.toThrow(/did not answer within/);
    } finally {
      await llm.close();
    }
  }, 10_000);

  it('sets the re-entrancy guard in the spawned environment', async () => {
    const dir = fakeBin('codex', `cat > /dev/null; echo "guard=\${${REENTRANCY_ENV}:-unset}"`);
    const llm = Llm.open({
      backend: 'codex',
      env: { ...process.env, PATH: dir },
      tmpRoot: scratch(),
    });
    try {
      const r = await llm.text({ prompt: 'q' });
      expect(r.text).toBe('guard=1');
    } finally {
      await llm.close();
    }
  });

  it('runs in a scratch cwd, so no CLAUDE.md is ever loaded', async () => {
    const dir = fakeBin('codex', 'cat > /dev/null; echo "$4"');
    const tmpRoot = scratch();
    const llm = Llm.open({
      backend: 'codex',
      env: { ...process.env, PATH: dir },
      tmpRoot,
    });
    try {
      // argv is: exec --skip-git-repo-check --cd <scratch> …
      const r = await llm.text({ prompt: 'q' });
      expect(r.text.startsWith(tmpRoot)).toBe(true);
      expect(fs.readdirSync(r.text.trim())).toEqual([]);
    } finally {
      await llm.close();
    }
  });

  it('removes the scratch directory on close', async () => {
    const dir = fakeBin('codex', 'cat > /dev/null; echo "$4"');
    const tmpRoot = scratch();
    const llm = Llm.open({ backend: 'codex', env: { ...process.env, PATH: dir }, tmpRoot });
    const r = await llm.text({ prompt: 'q' });
    const cwd = r.text.trim();
    expect(fs.existsSync(cwd)).toBe(true);
    await llm.close();
    expect(fs.existsSync(cwd)).toBe(false);
  });

  it('says which binary it could not run', async () => {
    const llm = Llm.open({
      backend: 'codex',
      // An empty PATH: nothing named codex anywhere.
      env: { ...process.env, PATH: scratch() },
      tmpRoot: scratch(),
    });
    try {
      await expect(llm.text({ prompt: 'q' })).rejects.toBeInstanceOf(LlmError);
    } finally {
      await llm.close();
    }
  });
});

describe('lastAgentMessage', () => {
  it('takes the last agent message out of jsonl', () => {
    const out = ['{"msg":{"text":"first"}}', '{"msg":{"text":"last"}}'].join('\n');
    expect(lastAgentMessage(out)).toBe('last');
  });
  it('passes plain output straight through', () => {
    expect(lastAgentMessage('  just text  ')).toBe('just text');
  });
  it('does not mistake prose that starts with a brace for jsonl', () => {
    expect(lastAgentMessage('{not json at all')).toBe('{not json at all');
  });
});

// ------------------------------------------------------------ card plan

function seededDb(root: string) {
  const db = store.open({ root });
  const now = Date.now();
  const addSession = (id: string, exchanges: number, chars: number) => {
    db.prepare(
      `INSERT INTO sessions (id, harness, project, started_at, ended_at, status, source_mtime)
       VALUES (?, 'claude', '/tmp/p', '2026-08-01T00:00:00.000Z', '2026-08-01T01:00:00.000Z', 'live', ?)`,
    ).run(id, now);
    for (let i = 0; i < exchanges; i++) {
      db.prepare(
        `INSERT INTO exchanges (id, session_id, seq, ts, user_text, assistant_text)
         VALUES (?, ?, ?, '2026-08-01T00:00:00.000Z', ?, ?)`,
      ).run(`${id}-${i}`, id, i, 'q'.repeat(chars), 'a'.repeat(chars));
    }
  };
  const addGhost = (id: string, prompts: number) => {
    db.prepare(
      `INSERT INTO ghosts (session_id, harness, project, first_ts, last_ts, prompt_count)
       VALUES (?, 'claude', '/tmp/p', '2026-08-01T00:00:00.000Z', '2026-08-01T01:00:00.000Z', ?)`,
    ).run(id, prompts);
    for (let i = 0; i < prompts; i++) {
      db.prepare(
        `INSERT INTO ghost_prompts (id, session_id, seq, ts, text)
         VALUES (?, ?, ?, '2026-08-01T00:00:00.000Z', ?)`,
      ).run(`${id}-${i}`, id, i, 'p'.repeat(100));
    }
  };
  return { db, addSession, addGhost };
}

describe('planCards', () => {
  it('skips sessions under the exchange floor and ghosts under the prompt floor', () => {
    const { db, addSession, addGhost } = seededDb(scratch());
    addSession('long', MIN_EXCHANGES, 500);
    addSession('short', MIN_EXCHANGES - 1, 500);
    addGhost('ghost-long', MIN_GHOST_PROMPTS);
    addGhost('ghost-short', MIN_GHOST_PROMPTS - 1);
    const plan = planCards(db);
    db.close();
    expect(plan.targets.map((t) => t.id).sort()).toEqual(['ghost-long', 'long']);
    expect(plan.skipped.tooShort).toBe(2);
    expect(plan.sessions).toBe(1);
    expect(plan.ghosts).toBe(1);
  });

  it('measures characters off the store, which is redacted at rest', () => {
    const { db, addSession } = seededDb(scratch());
    addSession('s', 3, 1_000);
    const plan = planCards(db);
    db.close();
    // 3 exchanges x (1,000 user + 1,000 assistant), plus the seq header.
    expect(plan.targets[0]!.chars).toBe(6_000 + 3 * 24);
    expect(plan.estimate.inputTokens).toBeGreaterThan(0);
  });

  it('leaves a fresh card alone unless --force', () => {
    const { db, addSession } = seededDb(scratch());
    addSession('s', 5, 100);
    db.prepare(
      `INSERT INTO cards (session_id, title, created_at) VALUES ('s', 't', ?)`,
    ).run(new Date(Date.now() + 60_000).toISOString());

    expect(planCards(db).targets).toHaveLength(0);
    expect(planCards(db).skipped.alreadyCarded).toBe(1);
    expect(planCards(db, { force: true }).targets).toHaveLength(1);
    db.close();
  });

  it('re-cards when the transcript moved after the card was written', () => {
    expect(isStale('2026-08-01T00:00:00.000Z', Date.parse('2026-08-02T00:00:00.000Z'))).toBe(true);
    expect(isStale('2026-08-03T00:00:00.000Z', Date.parse('2026-08-02T00:00:00.000Z'))).toBe(false);
    expect(isStale(null, 1)).toBe(true);
  });

  it('honours --ghosts exclude and --ghosts only', () => {
    const { db, addSession, addGhost } = seededDb(scratch());
    addSession('s', 5, 100);
    addGhost('g', 9);
    expect(planCards(db, { filters: { ghosts: 'exclude' } }).ghosts).toBe(0);
    expect(planCards(db, { filters: { ghosts: 'only' } }).sessions).toBe(0);
    expect(planCards(db, { filters: { ghosts: 'only' } }).ghosts).toBe(1);
    db.close();
  });

  it('prices the plan without touching a backend', () => {
    const { db, addSession } = seededDb(scratch());
    addSession('s', 4, 2_000);
    const plan = planCards(db, { model: 'haiku', backend: 'agent-sdk', chargeable: false });
    db.close();
    expect(plan.estimate.model).toBe('haiku');
    expect(plan.estimate.chargeable).toBe(false);
    expect(plan.estimate.usd).toBeGreaterThan(0);
    expect(plan.estimate.seconds).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------- the card

describe('renderEstimate', () => {
  function planFor(chargeable: boolean) {
    const { db, addSession, addGhost } = seededDb(scratch());
    addSession('s', 5, 4_000);
    addGhost('g', 8);
    const plan = planCards(db, {
      backend: chargeable ? 'api' : 'agent-sdk',
      chargeable,
    });
    db.close();
    return plan;
  }

  it('prints sessions, tokens, cost and time', () => {
    const out = renderEstimate(planFor(false), new Theme({ color: false, width: 80 }));
    expect(out).toContain('sessions to card');
    expect(out).toContain('ghosts to card');
    expect(out).toContain('input tokens');
    expect(out).toContain('estimated time');
    expect(out).toMatch(/\$\d/);
  });

  it('says nothing was called', () => {
    const out = renderEstimate(planFor(false), new Theme({ color: false, width: 80 }));
    expect(out).toContain('nothing was called');
  });

  it('calls the money an equivalent on the subscription path', () => {
    const sub = renderEstimate(planFor(false), new Theme({ color: false, width: 80 }));
    const api = renderEstimate(planFor(true), new Theme({ color: false, width: 80 }));
    expect(sub).toContain('equivalent cost');
    expect(sub).toContain('$0 charged');
    expect(api).toContain('estimated cost');
    expect(api).not.toContain('$0 charged');
  });

  it('fits 80 and 60 columns without wrapping', () => {
    for (const width of [60, 80]) {
      const out = renderEstimate(planFor(true), new Theme({ color: false, width }));
      for (const line of out.split('\n')) {
        expect(line.length, `"${line}" at ${width}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it('is pure ascii under --ascii', () => {
    const out = renderEstimate(planFor(false), new Theme({ color: false, ascii: true, width: 80 }));
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7F]/.test(out)).toBe(false);
  });

  it('has something to say when there is nothing to card', () => {
    const { db } = seededDb(scratch());
    const plan = planCards(db);
    db.close();
    const out = renderEstimate(plan, new Theme({ color: false, width: 80 }));
    expect(out).toContain('nothing');
    expect(out).toContain('potsherd index');
  });
});

// ------------------------------------------------------- T2.7 D1: the clock

/**
 * The verification's largest finding: `POTSHERD_LLM_TIMEOUT_MS` defaulted to
 * 120 s, a default-settings run lost **28 of 90 ghosts and 1 of 1 session** to
 * it, and no test said the number had to be related to anything.
 *
 * These three do. The first pins the deadline to the same measurements the
 * estimator is fitted to, so moving `CALL_PROFILES` without moving the
 * deadline fails here rather than in somebody's run. The second and third pin
 * the cheap half of the fix: a deadline is a retry, and only a deadline is.
 */
describe('the per-call deadline (T2.7 D1)', () => {
  it('covers the largest call potsherd can make, at the default concurrency', () => {
    const p = CALL_PROFILES['agent-sdk'];
    // `slice.ts` chunks above 60k characters, so 60k is the biggest single
    // prompt this pipeline ever builds.
    const worstSerialMs = p.baseMs + p.msPerKChar * 60;
    // Measured: six 40k calls at once took 191-204 s each where one alone
    // takes ~84 s. 2.43 is the worst of that, and +15% is the fit's own worst
    // residual over the six serial calls.
    const worstCredibleMs = worstSerialMs * 2.43 * 1.15;
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(worstCredibleMs);
    // And not absurdly more than it: past this a call is wedged, not slow.
    expect(DEFAULT_TIMEOUT_MS).toBeLessThan(worstCredibleMs * 2);
    // The value that failed. 120 s does not even cover the *mean* call once
    // six are in flight — which is why a third of a default run was lost.
    expect(120_000).toBeLessThan(worstCredibleMs);
    expect(120_000).toBeLessThan(worstSerialMs * 2.43);
  });

  it('retries a call that ran out of clock, rather than losing the card', async () => {
    let attempts = 0;
    const transport: Transport = {
      backend: 'agent-sdk',
      async send(): Promise<SendResult> {
        attempts += 1;
        if (attempts === 1) {
          throw new LlmError('the model call did not answer within 120s', 'fix', undefined, {
            timedOut: true,
          });
        }
        return { text: 'second time lucky', inputTokens: 10, outputTokens: 5, usd: 0.001 };
      },
      async close(): Promise<void> {},
    };
    const llm = Llm.open({ transport, env: {} });
    try {
      const r = await llm.text({ prompt: 'q' });
      expect(r.text).toBe('second time lucky');
      expect(attempts).toBe(1 + TIMEOUT_RETRIES);
    } finally {
      await llm.close();
    }
  });

  it('does not retry a failure that is not a deadline', async () => {
    let attempts = 0;
    const transport: Transport = {
      backend: 'agent-sdk',
      async send(): Promise<SendResult> {
        attempts += 1;
        throw new LlmError('the model call ended as error_max_turns');
      },
      async close(): Promise<void> {},
    };
    const llm = Llm.open({ transport, env: {} });
    try {
      await expect(llm.text({ prompt: 'q' })).rejects.toThrow(/error_max_turns/);
      expect(attempts).toBe(1);
    } finally {
      await llm.close();
    }
  });

  it('gives up after the retry rather than trying for ever', async () => {
    let attempts = 0;
    const transport: Transport = {
      backend: 'agent-sdk',
      async send(): Promise<SendResult> {
        attempts += 1;
        throw new LlmError('the model call did not answer within 360s', 'fix', undefined, {
          timedOut: true,
        });
      },
      async close(): Promise<void> {},
    };
    const llm = Llm.open({ transport, env: {} });
    try {
      await expect(llm.text({ prompt: 'q' })).rejects.toThrow(/did not answer within/);
      expect(attempts).toBe(1 + TIMEOUT_RETRIES);
    } finally {
      await llm.close();
    }
  });
});

/**
 * T2.7 D2's other half: the privacy receipt names the verbs that call a model,
 * and that list is only true while nothing else reaches `Llm.open`.
 *
 * Asserted against the source of the CLI's command files rather than against a
 * second hand-written list, because a hand-written list is exactly what drifted
 * into claiming "no network" for a whole phase.
 */
describe('which verbs may call a model (T2.7 D2)', () => {
  /**
   * Phase 4 proved this scan was too shallow. `ask` genuinely calls a model,
   * and grepping `packages/cli/src/commands/ask.ts` finds nothing: it opens the
   * backend inside `packages/core/src/ask.ts`, one import away. So the guard
   * said `ask` was offline while it was reading transcripts to a model —
   * *precisely* the drift this test exists to prevent, in the one shape it
   * could not see.
   *
   * The scan now follows the command's workspace imports through the barrel
   * into the module that actually implements them. That is a strengthening:
   * nothing that used to be caught stops being caught.
   *
   * Phase 5 then found the *next* hole, and found it by reasoning rather than
   * by being bitten: T5.1 declined to add a `potsherd mcp` verb partly because
   * this guard would not have caught it. The scan followed `@potsherd/core`
   * only, and a `commands/mcp.ts` imports `@potsherd/mcp` — whose tools call
   * `ask()`, which opens a backend two hops away. So the guard is now over
   * *every* workspace package, and it walks the module's own relative imports
   * as well, because reaching a model through one more file is not a different
   * thing from reaching it directly.
   */
  const WORKSPACE: Record<string, string> = {
    '@potsherd/core': 'packages/core/src',
    '@potsherd/mcp': 'packages/mcp/src',
    // Phase 6 found the same hole one package over: `commands/export.ts`
    // imports `@potsherd/bridges`, and until this line existed the guard walked
    // straight past that import and `export` was unchecked. The lesson is that
    // this map is a denylist of packages we remembered — so it is now derived
    // from the workspace, not hand-written.
    '@potsherd/bridges': 'packages/bridges/src',
  };

  const barrelExports = (): Map<string, string> => {
    const map = new Map<string, string>();
    for (const dir of Object.values(WORKSPACE)) {
      const index = path.resolve(process.cwd(), dir, 'index.ts');
      if (!fs.existsSync(index)) continue;
      const barrel = fs.readFileSync(index, 'utf-8');
      // A barrel can also *declare* what it exports rather than re-export it —
      // `packages/mcp/src/index.ts` exports `main` directly. Those names map to
      // the barrel itself, and `opensBackend` walks on from there.
      for (const m of barrel.matchAll(
        /export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/g,
      )) {
        if (!map.has(m[1]!)) map.set(m[1]!, index);
      }
      for (const m of barrel.matchAll(/export\s*\{([^}]*)\}\s*from\s*'\.\/([^']+)\.js'/g)) {
        const mod = path.resolve(process.cwd(), dir, `${m[2]}.ts`);
        for (const raw of m[1].split(',')) {
          const name = raw.replace(/\btype\b/, '').split(/\s+as\s+/)[0]?.trim();
          if (name && !map.has(name)) map.set(name, mod);
        }
      }
    }
    return map;
  };

  /** Does this module, or anything it imports relatively, open a backend? */
  const opensBackend = (file: string, seen = new Set<string>()): boolean => {
    if (seen.has(file) || !fs.existsSync(file)) return false;
    seen.add(file);
    // `llm.ts` *defines* `Llm`; importing a constant or a type from it is not
    // reaching a model. `doctor` imports MODEL_CALL_VERBS to say who does.
    if (file.endsWith(`${path.sep}llm.ts`)) return false;
    const src = fs.readFileSync(file, 'utf-8');
    if (/\bLlm\.open\(/.test(src)) return true;
    for (const m of src.matchAll(/from\s*'(\.[^']+)\.js'/g)) {
      if (opensBackend(path.resolve(path.dirname(file), `${m[1]}.ts`), seen)) return true;
    }
    return false;
  };

  it('no command outside MODEL_CALL_VERBS reaches Llm.open, directly or through core', () => {
    const exportsMap = barrelExports();
    const dir = path.resolve(process.cwd(), 'packages/cli/src/commands');
    const found: string[] = [];
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.ts')) continue;
      const src = fs.readFileSync(path.join(dir, file), 'utf-8');
      let reaches = /\bLlm\.open\(/.test(src);
      if (!reaches) {
        const pkgs = Object.keys(WORKSPACE).map((p) => p.replace('/', '\\/')).join('|');
        for (const imp of src.matchAll(
          new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*'(?:${pkgs})'`, 'g'),
        )) {
          for (const raw of imp[1]!.split(',')) {
            const name = raw.replace(/\btype\b/, '').split(/\s+as\s+/)[0]?.trim();
            const mod = name ? exportsMap.get(name) : undefined;
            if (!mod) continue;
            // An import only counts if the command actually calls it.
            if (!name || !new RegExp(`\\b${name}\\s*\\(`).test(src)) continue;
            if (opensBackend(mod)) reaches = true;
          }
        }
      }
      if (reaches) found.push(file.replace(/\.ts$/, ''));
    }
    expect(found.sort()).toEqual([...MODEL_CALL_VERBS].sort());
  });

  /**
   * The other direction, which nothing checked.
   *
   * The test above asks "does any verb outside the list call a model?" — the
   * false-negative direction. It cannot see a verb that is in *neither* list,
   * and `unpin` was exactly that for two phases: registered at
   * `packages/cli/src/index.ts` and named in neither `MODEL_CALL_VERBS` nor
   * `OFFLINE_VERBS`, so `doctor --privacy` answered "is unpin safe to run on a
   * client's laptop?" by saying nothing at all.
   *
   * `OFFLINE_VERBS`'s own doc comment says the list is written out rather than
   * left as "everything else" because "an answer by omission is not one". A
   * list with a hole in it is an answer by omission. So the union of the two
   * has to cover every command the CLI registers, and a new verb now fails
   * here — at the moment it is registered — rather than shipping into a
   * receipt that quietly skips it.
   */
  it('every registered command is in one of the two privacy lists', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'packages/cli/src/index.ts'),
      'utf-8',
    );
    const registered = [...src.matchAll(/\.command\('([a-z-]+)'\)/g)].map((m) => m[1]);

    // Non-vacuous: if the scrape ever stops matching, this fails rather than
    // passing over an empty set.
    expect(registered.length).toBeGreaterThanOrEqual(16);
    expect(registered).toContain('unpin');
    expect(registered).toContain('doctor');

    const disclosed = new Set([...MODEL_CALL_VERBS, ...OFFLINE_VERBS]);
    const undisclosed = registered.filter((v) => !disclosed.has(v));
    expect(undisclosed).toEqual([]);

    // And no list may name a verb that does not exist, which is the same drift
    // running the other way.
    const known = new Set(registered);
    expect([...disclosed].filter((v) => !known.has(v))).toEqual([]);

    // The two lists are disjoint: a verb cannot both call a model and be
    // guaranteed to open no socket.
    const both = MODEL_CALL_VERBS.filter((v) => OFFLINE_VERBS.includes(v));
    expect(both).toEqual([]);
  });
});

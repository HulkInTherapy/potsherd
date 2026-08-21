import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { db as store, Theme, markers } from '@potsherd/core';
import {
  API_MODEL_IDS,
  Budget,
  BudgetError,
  CALL_OVERHEAD_MS,
  CARD_MODEL,
  CHARS_PER_TOKEN,
  Llm,
  LlmError,
  NoBackendError,
  OUTPUT_TOKENS_PER_SECOND,
  PRICES,
  REENTRANCY_ENV,
  ReentrancyError,
  availability,
  detectBackend,
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

  it('prices at the model class list price', () => {
    const e = estimate({
      sessions: [{ id: 'a', chars: 3_600_000 }],
      model: 'haiku',
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

  it('time is call overhead plus output throughput, divided by concurrency', () => {
    const serial = estimate({ sessions: [{ id: 'a', chars: 1_000 }] });
    expect(serial.calls).toBe(1);
    expect(serial.seconds).toBeCloseTo(
      CALL_OVERHEAD_MS / 1000 + serial.outputTokens / OUTPUT_TOKENS_PER_SECOND,
      5,
    );
    const parallel = estimate({ sessions: [{ id: 'a', chars: 1_000 }], concurrency: 4 });
    expect(parallel.seconds).toBeCloseTo(serial.seconds / 4, 5);
  });

  it('knows the subscription path spends no money', () => {
    const sub = estimate({ sessions: [{ id: 'a', chars: 1_000 }], backend: 'agent-sdk' });
    const api = estimate({ sessions: [{ id: 'a', chars: 1_000 }], backend: 'api' });
    expect(sub.chargeable).toBe(false);
    expect(api.chargeable).toBe(true);
    // The equivalent is still computed on both: 03 §12's $2 target is real for
    // anyone on a key, and it is the number that lets someone choose.
    expect(sub.usd).toBeCloseTo(api.usd, 10);
    expect(sub.usd).toBeGreaterThan(0);
  });

  it('scales linearly in sessions', () => {
    const s = (n: number) =>
      estimate({ sessions: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, chars: 5_000 })) });
    expect(s(10).usd).toBeCloseTo(s(1).usd * 10, 8);
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

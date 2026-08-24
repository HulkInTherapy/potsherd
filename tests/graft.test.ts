import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db as store, indexAll, rescue, Theme, type Db } from '@potsherd/core';
import {
  Llm,
  tokensForText,
  type Backend,
  type SendRequest,
  type SendResult,
  type Transport,
} from '../packages/core/src/llm.js';
import { writeCard } from '../packages/core/src/cards/write.js';
import { emptyCard } from '../packages/core/src/cards/schema.js';
import { PROMPTS_ONLY } from '../packages/core/src/cards/ghost.js';
import {
  DEFAULT_BUDGET,
  MIN_BUDGET,
  buildPrompt,
  cardOnlyBody,
  clipSafe,
  collectSource,
  counterFor,
  enforceBudget,
  ensureGraftDir,
  graft,
  graftDir,
  graftPath,
  hasMaterial,
  resolveCitations,
  resolveTarget,
  safeCut,
  sourceLine,
  stripHarnessBoilerplate,
  type ClipOutcome,
  type Counter,
} from '../packages/core/src/graft.js';
import { graftJson, renderGraft } from '../packages/core/src/render/graft.js';
import { maskFor } from '../packages/core/src/redact.js';
import { rmrf, tempDir } from './helpers.js';

/**
 * `graft` makes three promises, and each one is a promise a model cannot be
 * asked to keep:
 *
 *   1. the brief is **under `--budget`**, always;
 *   2. every `[id8@seq]` in it **resolves** to a real exchange;
 *   3. a brief built from a **ghost** says the assistant side is gone.
 *
 * All three are therefore enforced in code after the model has spoken, and all
 * three are tested here against a transport that returns exactly the reply the
 * failure needs — 3× the budget, a fabricated seq, a fabricated session id.
 * A test that only ever sees a well-behaved model tests nothing about this
 * verb, because a well-behaved model is not what this verb is for.
 *
 * The corpus is `evals/fixture/claude`, the same one `recall.test.ts` and the
 * recall evals use, so "seq 4 of `0a2fbf9b` exists" is a fact two other files
 * already depend on.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, '..', 'evals', 'fixture', 'claude');

/** Known ids from `evals/fixture` — see `evals/queries.jsonl`. */
const ID = {
  pgbouncer: '0a2fbf9b',
  ghostPrinter: 'e6aa5ba7',
  /**
   * A real session with **no card** — nothing in `beforeAll` writes one for
   * it. `graft <id>` with no `--about` on this session is the headline use
   * case of the verb and the path T4.7a G1 found broken.
   */
  cardless: '0c68f4a1',
} as const;

let root: string;
let db: Db;
let pgbouncerId: string;
let ghostId: string;
let cardlessId: string;
const dirs: string[] = [];

/** A cwd for the `./.potsherd/` writes, so no test touches the repo. */
function workdir(): string {
  const d = tempDir('potsherd-graft-cwd-');
  dirs.push(d);
  return d;
}

class StubTransport implements Transport {
  readonly sent: SendRequest[] = [];
  closed = 0;
  constructor(
    private readonly reply: string | Error,
    readonly backend: Backend = 'agent-sdk',
  ) {}
  async send(req: SendRequest): Promise<SendResult> {
    this.sent.push(req);
    if (this.reply instanceof Error) throw this.reply;
    return { text: this.reply, inputTokens: 400, outputTokens: 200, usd: 0.002 };
  }
  async close(): Promise<void> {
    this.closed++;
  }
}

function stub(reply: string | Error, backend: Backend = 'agent-sdk'): Llm {
  return Llm.open({ transport: new StubTransport(reply, backend) });
}

beforeAll(async () => {
  root = tempDir('potsherd-graft-');
  dirs.push(root);
  await rescue({ claudeDir: FIXTURE, root, ghostsOnly: true, quiet: true });
  await indexAll({ root, claudeDir: FIXTURE, harnesses: ['claude'], embed: false, full: true });
  db = store.open({ root });

  pgbouncerId = (
    db.prepare('SELECT id FROM sessions WHERE id LIKE ?').get(`${ID.pgbouncer}%`) as { id: string }
  ).id;
  ghostId = (
    db.prepare('SELECT session_id AS id FROM ghosts WHERE session_id LIKE ?').get(
      `${ID.ghostPrinter}%`,
    ) as { id: string }
  ).id;
  cardlessId = (
    db.prepare('SELECT id FROM sessions WHERE id LIKE ?').get(`${ID.cardless}%`) as { id: string }
  ).id;

  // One real card, so the card-only path and the prompt builder have the shape
  // they were designed around. The seqs are checked against the transcript
  // below, so this fixture cannot quietly go stale.
  const seqs = (
    db.prepare('SELECT seq FROM exchanges WHERE session_id = ? ORDER BY seq LIMIT 3').all(
      pgbouncerId,
    ) as { seq: number }[]
  ).map((r) => r.seq);
  expect(seqs.length).toBeGreaterThanOrEqual(2);
  writeCard(db, root, {
    sessionId: pgbouncerId,
    harness: 'claude',
    projectSlug: 'tmp-potsherd-eval-api',
    project: '/tmp/potsherd-eval-api',
    card: {
      ...emptyCard(),
      title: 'pgbouncer and prepared statements',
      summary: 'Chased a prepared-statement error under the pooler and settled on a pool mode.',
      topics: ['pgbouncer', 'postgres'],
      decisions: [
        { what: 'use transaction pooling', why: 'session pooling wasted connections', evidence_seq: [seqs[0]!] },
        { what: 'disable prepared statements in the driver', why: null, evidence_seq: [seqs[1]!] },
      ],
      open_threads: [{ what: 'nobody re-ran the load test after the switch', evidence_seq: [seqs[0]!] }],
      files: ['db/pool.ts'],
      outcome: 'shipped',
      tags: ['postgres'],
    },
    verified: { kept: 3, dropped: 0 },
    model: 'test',
    costUsd: 0,
    createdAt: new Date().toISOString(),
    source: 'transcript',
  });
}, 120_000);

afterAll(() => {
  db?.close();
  while (dirs.length) rmrf(dirs.pop()!);
});

const seqOf = (id: string, n = 0): number =>
  (db.prepare('SELECT seq FROM exchanges WHERE session_id = ? ORDER BY seq').all(id) as {
    seq: number;
  }[])[n]!.seq;

// --------------------------------------------------- G1: never an empty prompt

/**
 * A transport that behaves the way a real model behaves, which a fixed-reply
 * stub cannot: it **reads the prompt**, and if the prompt carries no session
 * material it says so rather than inventing a brief.
 *
 * This is the whole of T4.7a G1 in one class. `graft <session>` with no
 * `--about` on a session with no card built a prompt out of a header, a title
 * and a list of rules — no transcript, no card, nothing — and the only reply
 * available to a model given that is a refusal, which `via === 'model'` then
 * wrote to `./.potsherd/graft-<id8>.md` and `--clip` copied to the clipboard.
 * A stub with a canned reply cannot catch that, because a canned reply is not
 * a function of the prompt. This one is.
 */
class PickyTransport implements Transport {
  readonly sent: SendRequest[] = [];
  closed = 0;
  readonly backend: Backend = 'agent-sdk';

  async send(req: SendRequest): Promise<SendResult> {
    this.sent.push(req);
    const prompt = req.prompt;
    const beforeTask = prompt.split('## your task')[0] ?? '';
    // `## card` or `## the last N exchanges …`: any section that is material.
    if (!/^## /m.test(beforeTask)) {
      return {
        text:
          `I don't have access to the session material. You've provided the session header ` +
          'but not the transcript, logs, or notes from that session.\n' +
          'Please provide the session material, and I will write the re-entry brief.',
        inputTokens: 300,
        outputTokens: 90,
        usd: 0.002,
      };
    }
    const legal = /The ONLY legal seq numbers are: ([\d, ]+)/.exec(prompt);
    const seqs = (legal?.[1] ?? '')
      .split(',')
      .map((n) => Number(n.trim()))
      .filter((n) => Number.isFinite(n));
    const id8 = /^Session ([0-9a-f]{8})/m.exec(prompt)?.[1] ?? '';
    return {
      text: seqs
        .slice(0, 3)
        .map((s, i) => `- fact ${i + 1}, drawn from the material above [${id8}@${s}]`)
        .join('\n'),
      inputTokens: 900,
      outputTokens: 120,
      usd: 0.004,
    };
  }

  async close(): Promise<void> {
    this.closed++;
  }
}

describe('a prompt never goes out with no session content in it', () => {
  it('puts the tail of the transcript in the prompt when there is no --about and no card', async () => {
    // The broken shape: `collectSource` populated `slice` only under
    // `if (about)`, and `buildPrompt` included transcript text only under
    // `if (src.slice.length)`. Card material only under `if (src.card)`. So a
    // cardless session with no topic produced a prompt with neither.
    const src = await collectSource(db, cardlessId, {});
    expect(src.card).toBeNull();
    expect(src.slice.length).toBeGreaterThan(0);
    expect(src.sliceVia).toBe('recent');

    const prompt = buildPrompt(src, { budget: DEFAULT_BUDGET });
    const beforeTask = prompt.split('## your task')[0]!;
    expect(beforeTask).toMatch(/^## the last \d+ exchanges? of the session$/m);
    // Real transcript text, not just a heading — the first prompt of this
    // fixture session, verbatim.
    expect(prompt).toContain('the customer is charged twice');
    // And never `## exchanges about "undefined"`, which is what the topic
    // heading interpolated once this branch became reachable without a topic.
    expect(prompt).not.toContain('undefined');
  });

  it('refuses to build a prompt at all when there is genuinely nothing to compress', async () => {
    const src = await collectSource(db, cardlessId, {});
    const empty = { ...src, card: null, slice: [], sliceVia: null } as typeof src;
    expect(hasMaterial(empty)).toBe(false);
    // A backstop in the function itself, not only in its one caller: a prompt
    // with no material can only produce a refusal.
    expect(() => buildPrompt(empty, { budget: DEFAULT_BUDGET })).toThrow(/no indexed material/);
  });

  it('writes a real brief, not the model saying it has nothing, on a cardless session', async () => {
    const transport = new PickyTransport();
    const llm = Llm.open({ transport });
    const r = await graft(db, cardlessId, { budget: DEFAULT_BUDGET, llm, cwd: workdir() });
    await llm.close();

    // The exact failure, asserted against: the refusal must not be the brief.
    expect(r.brief).not.toMatch(/I don't have access to the session material/);
    expect(r.brief).not.toMatch(/Please provide the session material/);

    expect(r.via).toBe('model');
    expect(r.citations.length).toBeGreaterThan(0);
    expect(r.citations.every((c) => c.resolves)).toBe(true);
    expect(r.brief).toMatch(/^- fact 1, drawn from the material above \[/m);
    // What went to disk is what was on screen, and it is attributable.
    expect(fs.readFileSync(r.path, 'utf8')).toBe(r.brief);
    expect(r.brief.trim().split('\n').pop()).toMatch(/^source: claude /);
  });

  it('never sends a prompt whose only sections are potsherd’s own rules', async () => {
    const transport = new PickyTransport();
    const llm = Llm.open({ transport });
    await graft(db, cardlessId, { budget: DEFAULT_BUDGET, llm, cwd: workdir() });
    await llm.close();
    expect(transport.sent).toHaveLength(1);
    const beforeTask = transport.sent[0]!.prompt.split('## your task')[0]!;
    expect(beforeTask).toMatch(/^## /m);
  });

  it('still narrows to the topic when --about is given — the default is only a default', async () => {
    const src = await collectSource(db, cardlessId, { about: 'double charge', root });
    // `--about` still owns the slice; the recency default fires only when
    // there is neither a topic nor a card.
    expect(src.sliceVia === 'about' || src.slice.length === 0).toBe(true);
  });

  it('leaves a carded session alone — its prompt already had material', async () => {
    const src = await collectSource(db, pgbouncerId, {});
    expect(src.card).not.toBeNull();
    expect(src.sliceVia).toBeNull();
    expect(src.slice).toHaveLength(0);
    expect(buildPrompt(src, { budget: DEFAULT_BUDGET })).toContain('## card');
  });
});

// ----------------------------------------------------------------- budget

describe('the budget is a ceiling, not a hope', () => {
  it('trims a model reply of 3x the budget down under it', async () => {
    // The failure this verb exists to prevent: a brief that reads well, cites
    // properly, and is three times the size the user asked to paste.
    const budget = 300;
    const seq = seqOf(pgbouncerId);
    const oneLine = `- the pooler was the problem and the fix was transaction mode [${ID.pgbouncer}@${seq}]`;
    // ~3x: 300 tokens is ~1,080 chars, so aim at ~3,300.
    const bloated: string[] = [];
    while (tokensForText(bloated.join('\n')) < budget * 3) bloated.push(oneLine);
    expect(tokensForText(bloated.join('\n'))).toBeGreaterThan(budget * 3 - 1);

    const llm = stub(bloated.join('\n'));
    const cwd = workdir();
    const r = await graft(db, pgbouncerId, { budget, llm, cwd });
    await llm.close();

    expect(r.via).toBe('model');
    expect(r.tokens).toBeLessThanOrEqual(budget);
    expect(r.trimmed).toBeGreaterThan(0);
    // Not just the returned number: the bytes on disk are what gets pasted.
    const onDisk = fs.readFileSync(r.path, 'utf8');
    expect(onDisk).toBe(r.brief);
    expect(tokensForText(onDisk)).toBeLessThanOrEqual(budget);
    // Trimming never takes the trailer. A brief with no `source:` line is not
    // attributable, which is worse than a brief that is short.
    expect(onDisk.trim().split('\n').pop()).toMatch(/^source: claude /);
  });

  it('says it trimmed, rather than trimming quietly', async () => {
    const seq = seqOf(pgbouncerId);
    const many = Array.from(
      { length: 60 },
      (_, i) => `- fact number ${i} about the pooler [${ID.pgbouncer}@${seq}]`,
    ).join('\n');
    const llm = stub(many);
    const r = await graft(db, pgbouncerId, { budget: 200, llm, cwd: workdir() });
    await llm.close();
    expect(r.brief).toMatch(/trimmed \d+ lines? to fit --budget 200/);
  });

  it('still comes in under a budget too small to hold the header', async () => {
    const seq = seqOf(pgbouncerId);
    const llm = stub(`- one fact [${ID.pgbouncer}@${seq}]`);
    const r = await graft(db, pgbouncerId, { budget: MIN_BUDGET, llm, cwd: workdir() });
    await llm.close();
    expect(r.tokens).toBeLessThanOrEqual(MIN_BUDGET);
  });

  it('leaves a brief that already fits completely alone', async () => {
    const seq = seqOf(pgbouncerId);
    const llm = stub(`- transaction pooling, not session pooling [${ID.pgbouncer}@${seq}]`);
    const r = await graft(db, pgbouncerId, { budget: DEFAULT_BUDGET, llm, cwd: workdir() });
    await llm.close();
    expect(r.trimmed).toBe(0);
    expect(r.brief).not.toMatch(/trimmed/);
    expect(r.tokens).toBeLessThan(DEFAULT_BUDGET);
  });

  it('measures with the counter a handful of times, not once per dropped line', async () => {
    // On the api path `count` is a network round trip. Trimming a reply that
    // came back 3x too long, one line and one call at a time, would be forty
    // of them. The estimator picks the cut; the counter only has to agree.
    let calls = 0;
    const counted: Counter = async (text) => {
      calls++;
      // A counter that disagrees with the estimator, so the drift correction
      // is exercised rather than trivially 1.
      return { tokens: Math.round(text.length / 3.2), estimated: false };
    };
    const r = await enforceBudget({
      head: ['# head'],
      body: Array.from({ length: 120 }, (_, i) => `- line ${i} of a body that is far too long to fit`),
      tail: ['---', '', 'source: claude x · 1 exchange · 2026-08-21'],
      budget: 200,
      count: counted,
    });
    expect(r.tokens).toBeLessThanOrEqual(200);
    expect(r.estimated).toBe(false);
    expect(r.trimmed).toBeGreaterThan(50);
    expect(calls).toBeLessThanOrEqual(5);
  });

  it('enforceBudget never removes the tail', async () => {
    const count = counterFor(null);
    const r = await enforceBudget({
      head: ['# head'],
      body: Array.from({ length: 40 }, (_, i) => `- line ${i} of a body that is far too long`),
      tail: ['---', '', 'source: claude x · 1 exchange · 2026-08-21'],
      budget: 80,
      count,
    });
    expect(r.tokens).toBeLessThanOrEqual(80);
    expect(r.brief).toContain('source: claude x');
  });
});

// -------------------------------------------------------------- citations

describe('every citation resolves, or it is not printed', () => {
  it('drops a fabricated seq and a fabricated id8, and says so in citations[]', async () => {
    const realSeq = seqOf(pgbouncerId);
    const madeUpSeq = 999_999;
    const madeUpId = 'deadbeef';
    const reply = [
      `- transaction pooling was chosen [${ID.pgbouncer}@${realSeq}]`,
      `- the load test was re-run and passed [${ID.pgbouncer}@${madeUpSeq}]`,
      `- the same decision was taken in the other repo [${madeUpId}@${realSeq}]`,
    ].join('\n');

    const llm = stub(reply);
    const r = await graft(db, pgbouncerId, { budget: DEFAULT_BUDGET, llm, cwd: workdir() });
    await llm.close();

    // The truthful record: three citations were emitted, one resolves.
    expect(r.citations).toHaveLength(3);
    const byKey = new Map(r.citations.map((c) => [`${c.id8}@${c.seq}`, c.resolves]));
    expect(byKey.get(`${ID.pgbouncer}@${realSeq}`)).toBe(true);
    expect(byKey.get(`${ID.pgbouncer}@${madeUpSeq}`)).toBe(false);
    expect(byKey.get(`${madeUpId}@${realSeq}`)).toBe(false);

    // And the brief: the invented ones are gone, and so are the claims that
    // rested on them. `00-README.md`: cited or dropped.
    expect(r.brief).toContain(`[${ID.pgbouncer}@${realSeq}]`);
    expect(r.brief).not.toContain(String(madeUpSeq));
    expect(r.brief).not.toContain(madeUpId);
    expect(r.brief).not.toContain('load test was re-run');
    expect(r.brief).not.toContain('other repo');
    expect(r.droppedLines).toHaveLength(2);
    // And the reader is told, on the face of the brief, that it happened.
    expect(r.brief).toMatch(/2 citations named an exchange this index does not have/);
  });

  it('checks a comma group, which a bracket-anchored pattern would have missed', () => {
    // The bug this catches, found on a real run: a model with two sources for
    // one bullet writes `[id8@24, id8@158]`. A pattern anchored to `[…]`
    // matches neither, so the line reads as uncited and sails past the check
    // *unchecked* — which is worse than a dropped citation, because it is a
    // fabricated one that got printed.
    const real = seqOf(pgbouncerId);
    const pass = resolveCitations(
      db,
      `- two sources for one fact [${ID.pgbouncer}@${real}, ${ID.pgbouncer}@777777]`,
      { sessionId: pgbouncerId },
    );
    expect(pass.citations).toHaveLength(2);
    expect(pass.citations.find((c) => c.seq === 777777)!.resolves).toBe(false);
    expect(pass.text).not.toContain('777777');
    // And what is left is a clean bracket, not `[0a2fbf9b@4, ]`.
    expect(pass.text).toContain(`[${ID.pgbouncer}@${real}]`);
    expect(pass.text).not.toMatch(/,\s*\]/);
  });

  it('checks the shorthand second seq in [id8@24, 158], which was displayed and never checked', () => {
    // **T4.7a G6.** T4.3 taught the pattern to see `[id8@24, id8@158]`, and it
    // does. But a model that has written the id once shortens the second
    // reference at least as often as it repeats it, and neither `158` nor
    // `@158` is an `id8@seq` token — so `158` sat *inside the citation group*,
    // was shown to the reader, was never resolved against the index, and never
    // appeared in `GraftResult.citations`. That is the precise failure T4.3
    // itself named as worse than a dropped citation: an unchecked one.
    const real = seqOf(pgbouncerId);
    const pass = resolveCitations(db, `- two exchanges [${ID.pgbouncer}@${real}, 999123]`, {
      sessionId: pgbouncerId,
    });
    expect(pass.citations).toHaveLength(2);
    expect(pass.citations.find((c) => c.seq === 999123)!.resolves).toBe(false);
    expect(pass.text).not.toContain('999123');
    expect(pass.text).toContain(`[${ID.pgbouncer}@${real}]`);
  });

  it('checks the [id8@24, @158] shorthand too', () => {
    const real = seqOf(pgbouncerId);
    const pass = resolveCitations(db, `- two exchanges [${ID.pgbouncer}@${real}, @999124]`, {
      sessionId: pgbouncerId,
    });
    expect(pass.citations).toHaveLength(2);
    expect(pass.citations.find((c) => c.seq === 999124)!.resolves).toBe(false);
    expect(pass.text).not.toContain('999124');
  });

  it('resolves a shorthand seq that is real, and shows it expanded', () => {
    const a = seqOf(pgbouncerId, 0);
    const b = seqOf(pgbouncerId, 1);
    const pass = resolveCitations(db, `- two exchanges [${ID.pgbouncer}@${a}, ${b}]`, {
      sessionId: pgbouncerId,
    });
    expect(pass.citations.map((c) => c.seq).sort((x, y) => x - y)).toEqual([a, b].sort((x, y) => x - y));
    expect(pass.citations.every((c) => c.resolves)).toBe(true);
    // The reader is shown the canonical form, which is what they should have
    // been shown in the first place.
    expect(pass.text).toContain(`[${ID.pgbouncer}@${a}, ${ID.pgbouncer}@${b}]`);
    expect(pass.droppedLines).toHaveLength(0);
  });

  it('leaves a bracket that is not a citation group completely alone', () => {
    const real = seqOf(pgbouncerId);
    const pass = resolveCitations(db, `- a list [a, 1, b] and a note [see 4] [${ID.pgbouncer}@${real}]`, {
      sessionId: pgbouncerId,
    });
    expect(pass.text).toContain('[a, 1, b]');
    expect(pass.text).toContain('[see 4]');
    expect(pass.citations).toHaveLength(1);
  });

  it('does not truncate an eight-digit seq into a seq that was never written', () => {
    // **T4.7a G7.** `CITATION_RE` bounded the seq at `\d{1,7}`, which did not
    // *refuse* `[id8@12345678]` — it matched the first seven digits, and
    // `--json` then reported `{"seq":1234567,"resolves":false}`: a number that
    // appears nowhere in the brief and nowhere in the transcript. A citation
    // checker that fabricates a citation of its own is worse than the
    // fabrication it was checking.
    const pass = resolveCitations(db, `- a fabricated source [${ID.pgbouncer}@12345678]`, {
      sessionId: pgbouncerId,
    });
    expect(pass.citations).toHaveLength(1);
    expect(pass.citations[0]!.seq).toBe(12345678);
    expect(pass.citations[0]!.resolves).toBe(false);
    expect(pass.droppedLines).toHaveLength(1);
    expect(pass.text.trim()).toBe('');
  });

  it('reports an absurdly long seq as itself, unresolved, rather than as Infinity', () => {
    const pass = resolveCitations(db, `- nonsense [${ID.pgbouncer}@${'9'.repeat(40)}]`, {
      sessionId: pgbouncerId,
    });
    expect(pass.citations).toHaveLength(1);
    expect(pass.citations[0]!.resolves).toBe(false);
    expect(Number.isFinite(pass.citations[0]!.seq)).toBe(true);
  });

  it('leaves no empty bracket behind when every citation in a group is invented', () => {
    const pass = resolveCitations(db, `- nothing real here [${ID.pgbouncer}@111111, ${ID.pgbouncer}@222222] tail`, {
      sessionId: pgbouncerId,
    });
    expect(pass.citations.every((c) => !c.resolves)).toBe(true);
    expect(pass.text).toBe('');
    expect(pass.droppedLines).toHaveLength(1);
  });

  it('drops a bullet that carries the unfilled template instead of a seq', () => {
    // Found on a real ghost run: the model copied `[<a real ghost, id withheld>@<seq>]` verbatim
    // out of the instruction. `<seq>` is not a number, so a citation pattern
    // never sees it, and the bullet reads as *uncited* rather than as
    // miscited — kept, unchecked, and visibly carrying a citation that is not
    // one. Cited or dropped means dropped.
    const pass = resolveCitations(db, `- a claim with no real source [${ID.pgbouncer}@<seq>]`, {
      sessionId: pgbouncerId,
    });
    expect(pass.text.trim()).toBe('');
    expect(pass.droppedLines).toHaveLength(1);
  });

  it('drops an uncited bullet AND uncited prose, and keeps only structure', () => {
    // **CHANGED BY T4.7a G3, and the assertion on the prose line is flipped on
    // purpose.** This test used to assert that
    // `'The session settled a pooling question.'` *survived*, on the reasoning
    // that prose is potsherd's own text rather than an assertion about the
    // transcript. That reasoning was wrong for the model path, which is where
    // nearly all prose in a brief comes from: `isClaim` was a bullet-only
    // rule, so a model's uncited paragraph sailed through, and a model's
    // paragraph carrying a *fabricated* citation was kept while the fabricated
    // citation was silently deleted — the product's answer to a fake source
    // being to erase the evidence that it was fake. Every brief is headed
    // "every claim carries `[id8@seq]`", and the reader of that header is the
    // agent the brief gets pasted into, so the filter now covers what the
    // header claims. Structure — headings, bold labels, rules, fences, blanks
    // — asserts nothing and still stays.
    const real = seqOf(pgbouncerId);
    const pass = resolveCitations(
      db,
      [
        'The session settled a pooling question.',
        '**decided**',
        `- transaction pooling [${ID.pgbouncer}@${real}]`,
        '- and also we definitely fixed the load test',
      ].join('\n'),
      { sessionId: pgbouncerId },
    );
    expect(pass.text).not.toContain('The session settled a pooling question.');
    expect(pass.text).toContain('**decided**');
    expect(pass.text).toContain(`[${ID.pgbouncer}@${real}]`);
    expect(pass.text).not.toContain('definitely fixed the load test');
    expect(pass.droppedLines).toEqual([
      'The session settled a pooling question.',
      '- and also we definitely fixed the load test',
    ]);
  });

  it('takes out a prose claim whose only citation was fabricated, evidence and all', () => {
    // The shape G3 called worse than a bare uncited claim: the claim was kept,
    // the false citation deleted, and a dangling " ." left where it had been.
    const pass = resolveCitations(
      db,
      'We migrated the whole fleet to Aurora Serverless v2 [9c4d2f18aaaa@999].',
      { sessionId: pgbouncerId },
    );
    expect(pass.text.trim()).toBe('');
    expect(pass.droppedLines).toHaveLength(1);
    expect(pass.citations).toEqual([{ id8: '9c4d2f18aaaa', seq: 999, resolves: false }]);
  });

  it('keeps a prose claim that cites — the rule is cited-or-dropped, not bulleted', () => {
    const real = seqOf(pgbouncerId);
    const pass = resolveCitations(
      db,
      `The pooler question was settled in this session [${ID.pgbouncer}@${real}].`,
      { sessionId: pgbouncerId },
    );
    expect(pass.text).toContain('The pooler question was settled in this session');
    expect(pass.droppedLines).toHaveLength(0);
  });

  it('the card-only body no longer emits the summary it could not cite', async () => {
    // **CHANGED BY T4.7a G3.** This test used to assert the card's summary
    // *survived* the citation pass. Under the widened filter it is what it
    // always was — an assertion about the session with no seq behind it, the
    // card schema giving `evidence_seq` to `decisions` and `open_threads` and
    // to nothing else — so the header's promise and the brief's contents now
    // agree. `cardOnlyBody` drops it at the source rather than emit it to be
    // deleted, because potsherd's own line appearing in `droppedLines` would
    // report a fabrication that never happened.
    const r = await graft(db, pgbouncerId, { llm: null, cwd: workdir() });
    expect(r.brief).not.toContain('Chased a prepared-statement error under the pooler');
    expect(r.droppedLines).toHaveLength(0);
    // What a returning reader came for is still all there, and still cited.
    expect(r.brief).toContain('use transaction pooling');
    expect(r.brief).toContain('nobody re-ran the load test after the switch');
    expect(r.citations.length).toBeGreaterThan(0);
    expect(r.citations.every((c) => c.resolves)).toBe(true);
    // The header's promise, asserted rather than trusted: every line of the
    // brief either carries a citation or is structure/potsherd's own frame.
    const body = r.brief
      .split('\n')
      .filter((l) => l.trim())
      .filter((l) => !/^(#|>|---|source: |Brief from a past session)/.test(l))
      .filter((l) => !/^\s*\*\*[^*]+\*\*:?\s*$/.test(l));
    expect(body.length).toBeGreaterThan(0);
    for (const line of body) expect(line).toMatch(/\[[0-9a-f]{6,40}@\d+\]/);
  });

  it('checks a bare id8@seq with no brackets at all', () => {
    const pass = resolveCitations(db, `- see ${ID.pgbouncer}@999998 for the detail`, {
      sessionId: pgbouncerId,
    });
    expect(pass.citations).toHaveLength(1);
    expect(pass.citations[0]!.resolves).toBe(false);
    expect(pass.droppedLines).toHaveLength(1);
  });

  it('keeps a line that has one good citation beside one bad one', () => {
    const realSeq = seqOf(pgbouncerId);
    const pass = resolveCitations(
      db,
      `- pooling was settled [${ID.pgbouncer}@${realSeq}] [${ID.pgbouncer}@424242]`,
      { sessionId: pgbouncerId },
    );
    expect(pass.text).toContain(`[${ID.pgbouncer}@${realSeq}]`);
    expect(pass.text).not.toContain('424242');
    expect(pass.droppedLines).toHaveLength(0);
    expect(pass.citations.filter((c) => c.resolves)).toHaveLength(1);
  });

  it('resolves a citation to a ghost prompt, which has a seq and no assistant side', () => {
    const seq = (
      db.prepare('SELECT seq FROM ghost_prompts WHERE session_id = ? ORDER BY seq LIMIT 1').get(
        ghostId,
      ) as { seq: number }
    ).seq;
    const pass = resolveCitations(db, `- the printer would not bind [${ID.ghostPrinter}@${seq}]`, {
      sessionId: ghostId,
    });
    expect(pass.citations[0]!.resolves).toBe(true);
    expect(pass.droppedLines).toHaveLength(0);
  });

  it('a brief whose every citation is invented comes back with no claims at all', async () => {
    const llm = stub(`- something that never happened [${ID.pgbouncer}@808080]`);
    const r = await graft(db, pgbouncerId, { budget: DEFAULT_BUDGET, llm, cwd: workdir() });
    await llm.close();
    expect(r.citations.every((c) => !c.resolves)).toBe(true);
    expect(r.brief).not.toContain('never happened');
    // What is left is still a valid, attributable document — just an empty one.
    expect(r.brief.trim().split('\n').pop()).toMatch(/^source: claude /);
  });
});

// ------------------------------------------------------------------ ghost

describe('a ghost brief says the assistant side is gone', () => {
  it('prints the prompts-only banner and tells the model not to invent replies', async () => {
    const seq = (
      db.prepare('SELECT seq FROM ghost_prompts WHERE session_id = ? ORDER BY seq LIMIT 1').get(
        ghostId,
      ) as { seq: number }
    ).seq;
    const llm = stub(`- the user was chasing a bind failure [${ID.ghostPrinter}@${seq}]`);
    const r = await graft(db, ghostId, { budget: DEFAULT_BUDGET, llm, cwd: workdir() });
    await llm.close();

    expect(r.isGhost).toBe(true);
    expect(r.brief).toMatch(/prompts only/i);
    expect(r.brief).toMatch(/not recoverable/i);
    // The banner is written in code, above the body, so no reply from the
    // model can be missing it — which is the point. A brief that implies the
    // assistant's answer is known when it is not is the worst thing this verb
    // could produce.
    const bannerAt = r.brief.indexOf('prompts only');
    expect(bannerAt).toBeGreaterThan(-1);
    expect(bannerAt).toBeLessThan(r.brief.indexOf('bind failure'));
  });

  it('warns the model in the prompt as well as the reader in the brief', async () => {
    const src = await collectSource(db, ghostId, {});
    const prompt = buildPrompt(src, { about: null, budget: 400 });
    expect(prompt).toContain('THIS SESSION IS A GHOST');
    expect(prompt).toMatch(/not recoverable/);
  });

  it('the card-only path banners it too, with no model in the room', async () => {
    const r = await graft(db, ghostId, { budget: DEFAULT_BUDGET, llm: null, cwd: workdir() });
    expect(r.via).toBe('card-only');
    expect(r.brief).toMatch(/prompts only/i);
    expect(r.brief).toMatch(/not recoverable/i);
  });
});

// ------------------------------------------------------- the offline path

describe('it works on a plane', () => {
  it('writes a brief with no model at all, labelled unsummarised', async () => {
    const r = await graft(db, pgbouncerId, { budget: DEFAULT_BUDGET, llm: null, cwd: workdir() });
    expect(r.via).toBe('card-only');
    expect(r.spend.calls).toBe(0);
    expect(r.brief).toMatch(/\*\*unsummarised\.\*\*/);
    expect(r.brief).toContain('transaction pooling');
    expect(r.citations.length).toBeGreaterThan(0);
    expect(r.citations.every((c) => c.resolves)).toBe(true);
    expect(fs.existsSync(r.path)).toBe(true);
  });

  it('falls back to the card when the model call throws, and says why', async () => {
    const llm = stub(new Error('backend went away'));
    const r = await graft(db, pgbouncerId, { budget: DEFAULT_BUDGET, llm, cwd: workdir() });
    await llm.close();
    expect(r.via).toBe('card-only');
    expect(r.reason).toMatch(/backend went away/);
    expect(r.brief).toMatch(/unsummarised/);
  });

  /**
   * **VERIFICATION-5 C-9, pinned.** The brief's own header said
   *
   *   > **unsummarised.** No model call was made — the model call failed
   *   > (claude --print could not answer: Not logged in · Please run /login).
   *
   * A call that failed was made. Both halves of one question, asserted in one
   * sentence, on the receipt an agent reads first — and the test above it
   * (`falls back to the card when the model call throws`) passed throughout,
   * because it asserted `/unsummarised/` and the reason, and never the claim
   * about the call. This asserts the claim, in both directions, so that neither
   * sentence can be given to the other run.
   *
   * `called` is the fact that separates them, and it is neither
   * `via === 'model'` (did a call *succeed*) nor `spend.calls > 0` (was one
   * *billed*): a backend that refuses a login bills nothing and still costs a
   * round trip, which is exactly the run below.
   */
  it('does not say no call was made about a call that failed', async () => {
    const llm = stub(new Error('claude --print could not answer: Not logged in'));
    const tried = await graft(db, pgbouncerId, { budget: DEFAULT_BUDGET, llm, cwd: workdir() });
    await llm.close();
    expect(tried.via).toBe('card-only');
    expect(tried.called).toBe(true);
    // Billed nothing, and still made the call. That is the pair the old
    // sentence could not tell apart.
    expect(tried.spend.calls).toBe(0);
    expect(tried.brief).toContain('**unsummarised.** The model call did not produce one');
    expect(tried.brief).not.toContain('No model call was made');

    const off = await graft(db, pgbouncerId, { budget: DEFAULT_BUDGET, llm: null, cwd: workdir() });
    expect(off.called).toBe(false);
    expect(off.brief).toContain('**unsummarised.** No model call was made');
    expect(off.brief).not.toContain('The model call did not produce one');
  });

  it('the card-only body is the card verbatim — nothing is paraphrased', async () => {
    const src = await collectSource(db, pgbouncerId, {});
    const body = cardOnlyBody(src).join('\n');
    expect(body).toContain('use transaction pooling');
    expect(body).toContain('session pooling wasted connections');
    expect(body).toContain('nobody re-ran the load test after the switch');
  });
});

// ----------------------------------------------------------- the last line

describe('the last line is always the source line', () => {
  it('names the harness, the full id, the exchange count and the date', async () => {
    const llm = stub(`- a fact [${ID.pgbouncer}@${seqOf(pgbouncerId)}]`);
    const r = await graft(db, pgbouncerId, { budget: DEFAULT_BUDGET, llm, cwd: workdir() });
    await llm.close();
    const last = r.brief.trim().split('\n').pop()!;
    expect(last).toBe(
      sourceLine({
        harness: 'claude',
        sessionId: pgbouncerId,
        exchanges: r.exchanges,
        date: r.date,
      }),
    );
    // The full id, not the id8: a brief pasted into a third tool has to stay
    // resumable, and `claude --resume 0a2fbf9b` is not a command.
    expect(last).toContain(pgbouncerId);
    expect(last).toMatch(/ · \d+ exchanges? · \d{4}-\d{2}-\d{2}$/);
  });

  it('says "1 exchange", not "1 exchanges"', () => {
    expect(sourceLine({ harness: 'claude', sessionId: 'x', exchanges: 1, date: 'd' })).toContain(
      '· 1 exchange ·',
    );
  });

  // --- F4 (T10.3). A brief drawn from a fork/resume chain counts the chain,
  // and the line has to say so: `241 exchanges` beside an id whose transcript
  // holds four is the unattributable citation this line exists to prevent.
  it('says how many transcripts the count spans, and only when it is more than one', () => {
    expect(
      sourceLine({ harness: 'claude', sessionId: 'x', exchanges: 123, date: 'd', sessions: 2 }),
    ).toContain('· 123 exchanges across 2 sessions ·');
    // One is the whole history of this line, so every brief ever written keeps
    // the wording it had.
    expect(
      sourceLine({ harness: 'claude', sessionId: 'x', exchanges: 4, date: 'd', sessions: 1 }),
    ).toBe(sourceLine({ harness: 'claude', sessionId: 'x', exchanges: 4, date: 'd' }));
  });

  it('a session nothing was forked from grafts as a thread of one', async () => {
    const src = await collectSource(db, pgbouncerId, {});
    expect(src.thread.sessions).toEqual([pgbouncerId]);
    const llm = stub(`- a fact [${ID.pgbouncer}@${seqOf(pgbouncerId)}]`);
    const r = await graft(db, pgbouncerId, { budget: DEFAULT_BUDGET, llm, cwd: workdir() });
    await llm.close();
    expect(r.sessions).toBe(1);
    expect(r.threadId).toBe(pgbouncerId);
    expect(r.brief).not.toContain('across');
    // The prompt keeps the sentence it has always carried; the chain wording
    // is a new case, not a rewrite of every brief.
    expect(buildPrompt(src, { budget: DEFAULT_BUDGET })).toContain(
      'The ONLY legal seq numbers are:',
    );
  });

  // --- D2 (T4.5). `03` §8 specifies this line as `· <n> exchanges ·`
  // unconditionally, and on a ghost that made the brief contradict itself three
  // lines apart: a prominent blockquote saying the assistant side was never
  // kept, then a last line claiming 241 *exchanges* of a session that has none.
  // An exchange is a prompt and a reply; a ghost kept only the prompt. The spec
  // is wrong here and is logged as such; the receipt in `render/graft.ts`
  // already annotates its row with "prompts only", so this matches it.
  it('says "prompts", not "exchanges", on a ghost', () => {
    expect(
      sourceLine({ harness: 'claude', sessionId: 'x', exchanges: 241, date: 'd', isGhost: true }),
    ).toContain('· 241 prompts ·');
    expect(
      sourceLine({ harness: 'claude', sessionId: 'x', exchanges: 1, date: 'd', isGhost: true }),
    ).toContain('· 1 prompt ·');
  });

  it('keeps "exchanges" on a session that has both sides', () => {
    const line = sourceLine({ harness: 'claude', sessionId: 'x', exchanges: 241, date: 'd' });
    expect(line).toContain('· 241 exchanges ·');
    expect(line).not.toContain('prompt');
    // Explicit `false` reads the same as omitted.
    expect(
      sourceLine({ harness: 'claude', sessionId: 'x', exchanges: 241, date: 'd', isGhost: false }),
    ).toBe(line);
  });

  it("a real ghost brief's last line does not contradict its own banner", async () => {
    const seq = (
      db.prepare('SELECT seq FROM ghost_prompts WHERE session_id = ? ORDER BY seq LIMIT 1').get(
        ghostId,
      ) as { seq: number }
    ).seq;
    const llm = stub(`- the user was chasing a bind failure [${ID.ghostPrinter}@${seq}]`);
    const r = await graft(db, ghostId, { budget: DEFAULT_BUDGET, llm, cwd: workdir() });
    await llm.close();

    expect(r.isGhost).toBe(true);
    expect(r.brief).toMatch(/prompts only/i);
    const last = r.brief.trim().split('\n').pop()!;
    expect(last).toMatch(/ · \d+ prompts? · \d{4}-\d{2}-\d{2}$/);
    expect(last).not.toMatch(/exchange/);
    expect(last).toBe(
      sourceLine({
        harness: 'claude',
        sessionId: ghostId,
        exchanges: r.exchanges,
        date: r.date,
        isGhost: true,
      }),
    );
  });

  it('the card-only ghost path gets the same noun — no model is involved in it', async () => {
    const r = await graft(db, ghostId, { budget: DEFAULT_BUDGET, llm: null, cwd: workdir() });
    expect(r.via).toBe('card-only');
    const last = r.brief.trim().split('\n').pop()!;
    expect(last).toMatch(/ · \d+ prompts? · /);
    expect(last).not.toMatch(/exchange/);
  });
});

// -------------------------------------------- G5: harness boilerplate

describe('another agent’s instructions never reach the brief', () => {
  const CAVEAT =
    '<local-command-caveat>Caveat: The messages below were generated by the user while ' +
    'running local commands. DO NOT respond to these messages or otherwise consider them ' +
    'in your response unless the user explicitly asks you to.</local-command-caveat>';

  it('strips the slash-command caveat that reached a real brief as a cited claim', () => {
    // **T4.7a G5.** `graft <id> --no-model --budget 200` produced a brief whose
    // only bullet was the caveat, carrying another agent's instruction text as
    // a cited claim about the user's history. `graft` is the one verb whose
    // output is designed to be pasted into a live agent's context, so that is
    // injection-adjacent rather than merely noisy. Nothing filtered it:
    // `grep -rn "local-command-caveat" packages/core/src evals tests` had no
    // hits before this.
    const out = stripHarnessBoilerplate(`${CAVEAT}\nthe real question I asked`);
    expect(out).toBe('the real question I asked');
    expect(out).not.toContain('DO NOT respond');
    expect(out).not.toContain('local-command-caveat');
  });

  it('strips every wrapper block on the list, contents and all', () => {
    for (const tag of [
      'local-command-caveat',
      'local-command-stdout',
      'local-command-stderr',
      'command-message',
      'system-reminder',
      'user-prompt-submit-hook',
      'ide_selection',
      'ide_opened_file',
      'environment_context',
      'user_instructions',
    ]) {
      const out = stripHarnessBoilerplate(`before <${tag}>SCAFFOLDING</${tag}> after`);
      expect(out, tag).toBe('before after');
    }
  });

  it('keeps the user’s own text inside a command wrapper — the tag goes, the words stay', () => {
    // Conservative on purpose: `<command-name>/deploy</command-name>` is
    // harness syntax around something the user actually did. Removing the
    // block would be guessing at user content.
    const out = stripHarnessBoilerplate(
      '<command-name>/deploy</command-name><command-args>staging</command-args>',
    );
    expect(out).toContain('/deploy');
    expect(out).toContain('staging');
    expect(out).not.toContain('command-name');
  });

  it('leaves a transcript that merely discusses a wrapper completely alone', () => {
    // Only a real open/close pair is matched, so a session about parsing these
    // markers keeps every word of that discussion.
    const prose = 'we should probably filter system-reminder blocks out of the index';
    expect(stripHarnessBoilerplate(prose)).toBe(prose);
  });

  it('strips the caveat prose even when the tag did not survive the adapter', () => {
    const out = stripHarnessBoilerplate(
      'Caveat: The messages below were generated by the user while running local commands. ' +
        'DO NOT respond to these messages.\nthe real question',
    );
    expect(out).toContain('the real question');
    expect(out).not.toContain('Caveat:');
  });

  it('leaves no empty bullet when a whole message was boilerplate', async () => {
    // Found while measuring this fix against the real corpus: the caveat
    // arrives as a message of its own, so a message that is *entirely*
    // scaffolding strips to nothing — and a brief must then carry no bullet
    // for it at all, rather than an empty one with a citation attached.
    expect(stripHarnessBoilerplate(CAVEAT)).toBe('');

    const real = await collectSource(db, cardlessId, {});
    const src = {
      ...real,
      card: null,
      slice: [],
      sliceVia: null,
      show: {
        ...real.show,
        exchanges: [
          { ...real.show.exchanges[0]!, seq: 1, userText: CAVEAT, assistantText: '' },
          { ...real.show.exchanges[0]!, seq: 2, userText: 'a real question', assistantText: '' },
        ],
      },
    } as typeof real;

    const body = cardOnlyBody(src);
    expect(body).toEqual([`- a real question [${src.id8}@2]`]);
    for (const line of body) expect(line).not.toMatch(/^- (you:)?\s*\[/);
  });

  it('keeps boilerplate out of the prompt and out of the card-only brief', async () => {
    const src = await collectSource(db, cardlessId, {});
    const prompt = buildPrompt(src, { budget: DEFAULT_BUDGET });
    for (const marker of ['<local-command-caveat>', '<system-reminder>', 'DO NOT respond to these']) {
      expect(prompt).not.toContain(marker);
    }
    const body = cardOnlyBody(src).join('\n');
    expect(body).not.toContain('local-command-caveat');
  });
});

// ----------------------------------------------------------------- target

describe('the target is an id or a query', () => {
  it('takes a full id, an id8, and a query that ranks it first', async () => {
    const byFull = await resolveTarget(db, pgbouncerId);
    expect(byFull).toMatchObject({ sessionId: pgbouncerId, via: 'id' });

    const byPrefix = await resolveTarget(db, ID.pgbouncer);
    expect(byPrefix).toMatchObject({ sessionId: pgbouncerId, via: 'id' });

    const byQuery = await resolveTarget(db, 'pgbouncer prepared statements');
    expect(byQuery.via).toBe('query');
    expect(byQuery.sessionId).toBe(pgbouncerId);
  });

  it('refuses a target nothing matches, with the command that widens it', async () => {
    // `!!!` has no word characters, so `ftsQuery` tokenises to nothing and
    // `recall` returns an empty result rather than relaxing into one. A query
    // of real words always finds *something* — that is what the OR pass is
    // for — so this is the only shape that reaches the empty branch.
    await expect(resolveTarget(db, '!!! ...')).rejects.toMatchObject({
      name: 'GraftError',
      fix: expect.stringContaining('potsherd find'),
    });
    await expect(resolveTarget(db, '   ')).rejects.toMatchObject({ name: 'GraftError' });
  });

  it('--about narrows the material to the exchanges about the topic', async () => {
    const wide = await collectSource(db, pgbouncerId, {});
    const narrow = await collectSource(db, pgbouncerId, { about: 'prepared statements', k: 2 });
    expect(wide.slice).toHaveLength(0);
    expect(narrow.slice.length).toBeGreaterThan(0);
    expect(narrow.slice.length).toBeLessThanOrEqual(2);
    for (const ex of narrow.slice) {
      expect(seqExistsFor(pgbouncerId, ex.seq)).toBe(true);
    }
    const prompt = buildPrompt(narrow, { about: 'prepared statements', budget: 800 });
    expect(prompt).toContain('exchanges about "prepared statements"');
    // The model is told which seqs it may cite. A model not given the list
    // invents plausible ones and the citation pass then deletes its work.
    expect(prompt).toMatch(/The ONLY legal seq numbers are: [\d, ]+/);
  });
});

function seqExistsFor(id: string, seq: number): boolean {
  return Boolean(
    db.prepare('SELECT 1 AS ok FROM exchanges WHERE session_id = ? AND seq = ?').get(id, seq),
  );
}

// ------------------------------------------------------------- ./.potsherd

describe('./.potsherd — the one write outside ~/.potsherd', () => {
  it('writes the brief and a .gitignore beside it', async () => {
    const cwd = workdir();
    const r = await graft(db, pgbouncerId, { llm: null, cwd });
    expect(r.path).toBe(graftPath(r.id8, cwd));
    expect(fs.existsSync(path.join(graftDir(cwd), '.gitignore'))).toBe(true);
    expect(r.wroteGitignore).toBe(true);
    expect(fs.readFileSync(path.join(graftDir(cwd), '.gitignore'), 'utf8')).toContain('*');
  });

  it('never clobbers a .gitignore the user already wrote', () => {
    const cwd = workdir();
    fs.mkdirSync(graftDir(cwd), { recursive: true });
    const mine = '# mine, thank you\n!keep-this.md\n';
    fs.writeFileSync(path.join(graftDir(cwd), '.gitignore'), mine);

    const first = ensureGraftDir(cwd);
    expect(first.wroteGitignore).toBe(false);
    expect(fs.readFileSync(path.join(graftDir(cwd), '.gitignore'), 'utf8')).toBe(mine);
  });

  it('writes nowhere at all when asked not to', async () => {
    const cwd = workdir();
    const r = await graft(db, pgbouncerId, { llm: null, cwd, write: false });
    expect(r.path).toBe('');
    expect(fs.existsSync(graftDir(cwd))).toBe(false);
    expect(r.brief.length).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------- clipboard

describe('--clip fails softly', () => {
  it('a machine with no clipboard tool is a note, not an error', async () => {
    const none: ClipOutcome = { ok: false, tool: null, note: 'no clipboard tool found' };
    const r = await graft(db, pgbouncerId, {
      llm: null,
      cwd: workdir(),
      clip: true,
      clipboard: () => none,
    });
    expect(r.clipped).toBe(false);
    expect(r.clip).toEqual(none);
    // The brief is still on disk, and the render still says what happened.
    expect(fs.existsSync(r.path)).toBe(true);
    expect(renderGraft(r, new Theme({ color: false }))).toContain('no clipboard tool found');
  });

  it('records the tool that took it when one is there', async () => {
    let got = '';
    const r = await graft(db, pgbouncerId, {
      llm: null,
      cwd: workdir(),
      clip: true,
      clipboard: (text) => {
        got = text;
        return { ok: true, tool: 'pbcopy' };
      },
    });
    expect(r.clipped).toBe(true);
    // What went to the clipboard is byte-for-byte what went to disk.
    expect(got).toBe(r.brief);
    expect(got).toBe(fs.readFileSync(r.path, 'utf8'));
  });

  it('does not touch the clipboard unless asked', async () => {
    let called = 0;
    const r = await graft(db, pgbouncerId, {
      llm: null,
      cwd: workdir(),
      clipboard: () => {
        called++;
        return { ok: true, tool: 'pbcopy' };
      },
    });
    expect(called).toBe(0);
    expect(r.clipped).toBe(false);
    expect(r.clip).toBeNull();
  });
});

// ------------------------------------------------------------ mask safety

describe('a cut never falls inside a redaction mask', () => {
  const mask = maskFor('aws', 'AKIAIOSFODNN7EXAMPLE');

  it('pushes a cut back to the start of the mask it would have split', () => {
    const text = `the key is ${mask} and that is that`;
    const inside = text.indexOf(mask) + 8;
    expect(safeCut(text, inside)).toBe(text.indexOf(mask));
    // A cut outside any mask is left exactly where it was.
    expect(safeCut(text, 4)).toBe(4);
  });

  it('clipSafe never emits half a mask', () => {
    const text = `prefix ${mask} suffix`;
    for (let n = 1; n <= text.length; n++) {
      const cut = clipSafe(text, n);
      // Either the whole mask is there or none of it is. A leading fragment
      // reads as a leaked prefix of a real key, which is the failure phase 2's
      // screenshot script hit for exactly this reason.
      const opens = (cut.match(/‹/g) ?? []).length;
      const closes = (cut.match(/›/g) ?? []).length;
      expect(opens).toBe(closes);
      expect(cut).not.toMatch(/‹redacted:[a-z-]*$/);
    }
  });

  it('an elision marker survives a cut in one piece too', () => {
    const marker = '‹elided:image/png:109362 bytes›';
    const text = `before ${marker} after`;
    const inside = text.indexOf(marker) + 10;
    expect(safeCut(text, inside)).toBe(text.indexOf(marker));
  });
});

// --------------------------------------------------------------- contract

describe('the pinned GraftResult', () => {
  it('--json carries exactly the fields WAVE.md pinned, and no more', async () => {
    const llm = stub(`- a fact [${ID.pgbouncer}@${seqOf(pgbouncerId)}]`);
    const r = await graft(db, pgbouncerId, { about: 'pgbouncer', llm, cwd: workdir() });
    await llm.close();
    const json = graftJson(r);
    expect(Object.keys(json).sort()).toEqual(
      [
        'about',
        'brief',
        'budget',
        'citations',
        'clipped',
        'date',
        'estimated',
        'exchanges',
        'harness',
        'id8',
        'ms',
        'path',
        'project',
        'sessionId',
        'spend',
        'tokens',
      ].sort(),
    );
    expect(json['about']).toBe('pgbouncer');
    expect(json['id8']).toBe(pgbouncerId.slice(0, 8));
    expect(json['sessionId']).toBe(pgbouncerId);
    expect(json['brief']).toBe(r.brief);
    // The `--json` view and the human view carry the same brief (`05`).
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it('says the token count is an estimate on every path but the api one', async () => {
    const llm = stub(`- a fact [${ID.pgbouncer}@${seqOf(pgbouncerId)}]`, 'agent-sdk');
    const r = await graft(db, pgbouncerId, { llm, cwd: workdir() });
    await llm.close();
    // `05`'s honesty contract: an estimate that looks like a measurement is
    // the bug this project has already shipped once.
    expect(r.estimated).toBe(true);
    expect(r.tokens).toBe(tokensForText(r.brief));
    expect(renderGraft(r, new Theme({ color: false }))).toContain('est. (chars/3.6)');
  });

  it('labels the dollar figure est. too, not just the token count', async () => {
    // **T4.7a G2.** `render/ask.ts:109`, `render/ask.ts:212` and
    // `cli/commands/ask.ts:101` all guard money with `r.estimated`;
    // `render/graft.ts:80` was the one site in the product that did not, and
    // the unlabelled figure sat two rows under a `tokens` row that labels
    // *itself* `est. (chars/3.6)`. On the subscription path it is an
    // api-equivalent estimate, not money anyone was charged. Seen unlabelled
    // on three real runs; `05`'s honesty contract is explicit.
    const llm = stub(`- a fact [${ID.pgbouncer}@${seqOf(pgbouncerId)}]`, 'agent-sdk');
    const r = await graft(db, pgbouncerId, { llm, cwd: workdir() });
    await llm.close();
    expect(r.estimated).toBe(true);
    expect(r.spend.usd).toBeGreaterThan(0);
    const out = renderGraft(r, new Theme({ color: false }));
    const money = out.split('\n').find((l) => l.includes('$'))!;
    expect(money).toBeDefined();
    expect(money).toMatch(/\$[\d.]+ est\./);
  });

  it('a zero-citation brief never reads as clean', async () => {
    // **T4.7a G4.** `citations 0/0 · "distinct, and all resolve"` read green
    // on a brief with no citations at all — the receipt's most reassuring line
    // above a brief with no evidence in it. "All of them resolve" is vacuously
    // true of an empty set; the row exists to answer *is this backed by
    // anything*, and on zero the answer is no.
    const llm = stub('This session was about a thing.');
    const r = await graft(db, pgbouncerId, { llm, cwd: workdir() });
    await llm.close();
    expect(r.citations).toHaveLength(0);
    const out = renderGraft(r, new Theme({ color: false }));
    const row = out.split('\n').find((l) => l.includes('citations'))!;
    expect(row).toContain('0/0');
    expect(row).not.toContain('distinct, and all resolve');
    expect(row).toContain('nothing in this brief is cited');
  });

  it('still says all resolve when some actually did', async () => {
    const llm = stub(`- a fact [${ID.pgbouncer}@${seqOf(pgbouncerId)}]`);
    const r = await graft(db, pgbouncerId, { llm, cwd: workdir() });
    await llm.close();
    const row = renderGraft(r, new Theme({ color: false }))
      .split('\n')
      .find((l) => l.includes('citations'))!;
    expect(row).toContain('distinct, and all resolve');
  });

  it('degrades to 60 columns without losing the next verb', async () => {
    // `plans/05`: designed for 80, degrades to 60, and the last line of every
    // verb is the next verb — printed whole, because half a command cannot be
    // typed.
    const llm = stub(`- transaction pooling [${ID.pgbouncer}@${seqOf(pgbouncerId)}]`);
    const r = await graft(db, pgbouncerId, { llm, cwd: workdir() });
    await llm.close();
    const out = renderGraft(r, new Theme({ color: false, width: 60 }));
    const receipt = out.split('────')[0]!;
    for (const line of receipt.split('\n')) expect(line.length).toBeLessThanOrEqual(60);
    expect(out).toContain(`potsherd show ${r.id8}`);
  });

  it('renders whole, inside 80 columns, with no line wrapping', async () => {
    const llm = stub(`- transaction pooling [${ID.pgbouncer}@${seqOf(pgbouncerId)}]`);
    const r = await graft(db, pgbouncerId, { llm, cwd: workdir() });
    await llm.close();
    const out = renderGraft(r, new Theme({ color: false, width: 80 }));
    // The receipt is potsherd's own text and must fit. The brief below it is
    // the model's markdown and is printed verbatim — deliberately, because
    // what is on screen and what is pasted have to be one string.
    const receipt = out.split('────')[0]!;
    for (const line of receipt.split('\n')) expect(line.length).toBeLessThanOrEqual(80);
    expect(out).toContain('run  potsherd show');
  });
});

// ---------------------------------------------------------------- prompts

describe('the prompt', () => {
  it('carries the card and the topic slice, and never the whole transcript', async () => {
    const src = await collectSource(db, pgbouncerId, { about: 'prepared statements', k: 2 });
    const prompt = buildPrompt(src, { about: 'prepared statements', budget: 800 });
    expect(prompt).toContain('## card');
    expect(prompt).toContain('use transaction pooling');
    // `03` §11: ask/graft never include full transcripts in a prompt, only the
    // shortlisted slices.
    const wholeSession = (
      db.prepare('SELECT user_text FROM exchanges WHERE session_id = ?').all(pgbouncerId) as {
        user_text: string;
      }[]
    ).length;
    expect(src.slice.length).toBeLessThan(wholeSession);
  });

  it('goes through the redactor on the way out — there is no way round it', async () => {
    const transport = new StubTransport('- nothing [x@1]');
    const llm = Llm.open({ transport });
    await graft(db, pgbouncerId, { llm, cwd: workdir(), about: 'pgbouncer' });
    await llm.close();
    // llm.ts redacts every outgoing string itself; this asserts graft has not
    // found some other way to a backend.
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.prompt).not.toMatch(/AKIA[0-9A-Z]{16}/);
  });
});

// ------------------------------------------------------------------ cards

describe('a ghost card is not mistaken for a transcript card', () => {
  it('marks a prompts-only card as such in the prompt', async () => {
    const seq = (
      db.prepare('SELECT seq FROM ghost_prompts WHERE session_id = ? ORDER BY seq LIMIT 1').get(
        ghostId,
      ) as { seq: number }
    ).seq;
    writeCard(db, root, {
      sessionId: ghostId,
      harness: 'claude',
      projectSlug: 'ghosts',
      project: '/tmp/potsherd-eval-ghost',
      card: {
        ...emptyCard(),
        title: 'printer driver hunt',
        summary: 'The user was chasing a laser printer driver.',
        open_threads: [{ what: 'no driver was ever confirmed working', evidence_seq: [seq] }],
        outcome: 'unknown',
      },
      verified: { kept: 1, dropped: 0 },
      model: 'test',
      costUsd: 0,
      createdAt: new Date().toISOString(),
      source: PROMPTS_ONLY,
    });
    const src = await collectSource(db, ghostId, {});
    const prompt = buildPrompt(src, { about: null, budget: 400 });
    expect(prompt).toContain('(prompts only)');
  });
});

describe('the header never asserts a topic the body does not cover', () => {
  // Found by T4.7a and reported rather than fixed, which was the right call.
  // `--about <topic>` that selected no exchanges still wrote
  // "about **<topic>**" into the header while the body was the session's
  // opening exchanges — a claim about the brief that the brief itself
  // contradicts, in the one line the receiving agent reads first.
  it('says the topic did not match rather than claiming the brief is about it', async () => {
    const transport = new PickyTransport();
    const llm = Llm.open({ transport });
    const r = await graft(db, cardlessId, {
      budget: DEFAULT_BUDGET,
      about: 'zzzz-no-such-topic-anywhere-qqqq',
      llm,
      cwd: workdir(),
    });
    await llm.close();

    expect(r.about).toBe('zzzz-no-such-topic-anywhere-qqqq');
    expect(r.brief).not.toMatch(/about \*\*zzzz-no-such-topic-anywhere-qqqq\*\*\./);
    expect(r.brief).toMatch(/Nothing in it matched \*\*zzzz-no-such-topic-anywhere-qqqq\*\*/);
  });

  it('still claims the topic when the topic is what chose the material', async () => {
    const transport = new PickyTransport();
    const llm = Llm.open({ transport });
    const r = await graft(db, pgbouncerId, {
      budget: DEFAULT_BUDGET,
      about: 'pgbouncer',
      llm,
      cwd: workdir(),
    });
    await llm.close();
    expect(r.brief).toMatch(/about \*\*pgbouncer\*\*\./);
  });
});


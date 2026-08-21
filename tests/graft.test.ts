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
  resolveCitations,
  resolveTarget,
  safeCut,
  sourceLine,
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
} as const;

let root: string;
let db: Db;
let pgbouncerId: string;
let ghostId: string;
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

  it('leaves no empty bracket behind when every citation in a group is invented', () => {
    const pass = resolveCitations(db, `- nothing real here [${ID.pgbouncer}@111111, ${ID.pgbouncer}@222222] tail`, {
      sessionId: pgbouncerId,
    });
    expect(pass.citations.every((c) => !c.resolves)).toBe(true);
    expect(pass.text).toBe('');
    expect(pass.droppedLines).toHaveLength(1);
  });

  it('drops a bullet that carries the unfilled template instead of a seq', () => {
    // Found on a real ghost run: the model copied `[f7ac67c0@<seq>]` verbatim
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

  it('drops any bullet with no citation at all, and keeps prose that is not a claim', () => {
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
    // Potsherd's own prose and its own headings are not assertions about the
    // transcript, so they stay. The uncited bullet is an assertion, so it goes.
    expect(pass.text).toContain('The session settled a pooling question.');
    expect(pass.text).toContain('**decided**');
    expect(pass.text).toContain(`[${ID.pgbouncer}@${real}]`);
    expect(pass.text).not.toContain('definitely fixed the load test');
    expect(pass.droppedLines).toEqual(['- and also we definitely fixed the load test']);
  });

  it('the card-only summary survives the rule that drops uncited bullets', async () => {
    const r = await graft(db, pgbouncerId, { llm: null, cwd: workdir() });
    // The summary has no seq of its own and must not be mistaken for a claim
    // the citation pass should delete.
    expect(r.brief).toContain('Chased a prepared-statement error under the pooler');
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

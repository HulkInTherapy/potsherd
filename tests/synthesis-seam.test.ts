import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { db as store } from '@potsherd/core';
import {
  ask,
  type AskReaderOutput,
  type AskResult,
  type ProposedSentence,
} from '../packages/core/src/ask.js';
import {
  Llm,
  type Backend,
  type SendRequest,
  type SendResult,
  type Transport,
} from '../packages/core/src/llm.js';
import {
  REPLY_INSTRUCTION,
  SYNTHESIS_FILE_KIND,
  SYNTHESIS_FILE_VERSION,
  READERS_FILE_KIND,
  filterHostAnswer,
  writeReadersFile,
  writeSynthesisFile,
} from '../packages/cli/src/commands/ask.js';
import { rmrf, tempDir } from './helpers.js';

/**
 * `--synthesis-out` / `--filter-in` — the seam that removes the last model
 * call from `ask`, and the proof that removing it removes none of the
 * guarantee.
 *
 * `tests/ask.test.ts` already proves the *reader* half: `--readers-out` makes
 * no call, `--readers-in` produces byte-identical output to a normal run. What
 * it could not prove is the part the audit called the wall — that the run then
 * needed a backend anyway, for one synthesis call, and so the free path was
 * free for six sevenths of its work and then stopped.
 *
 * Three claims are tested here and they are not the same claim:
 *
 *   1. **zero calls.** Not "the flags skip the call" but "there is no
 *      expression on this path that can construct a backend". Every test that
 *      asserts it does so against a transport that throws if it is ever sent
 *      anything, so a regression fails loudly rather than quietly costing
 *      money.
 *   2. **the citation guarantee survives the hand-over.** A host agent is an
 *      arbitrary model with an arbitrary amount of good faith. The seam is
 *      only sound if a fabricated quote from the host dies exactly where a
 *      fabricated quote from a backend dies — in `filterAnswer`, in code. The
 *      central test plants the *same* fabrication on both paths and compares
 *      the two results field for field.
 *   3. **a stale file is refused.** The answer and the evidence it is checked
 *      against must come from one recording of one shortlist, or the printed
 *      counts describe a sweep that did not happen.
 */

const created: string[] = [];
afterEach(() => {
  while (created.length) rmrf(created.pop()!);
});

function scratch(prefix = 'potsherd-synth-'): string {
  const dir = tempDir(prefix);
  created.push(dir);
  return dir;
}

// --------------------------------------------------------------- fixtures

const POOLER = 'sess-pooler-0001';
const REAL_QUOTE = 'we set statement_cache_size=0 on the client';
const QUESTION = 'how did we handle pgbouncer with prepared statements?';

/** An index holding one quotable session, so `ask()` runs for real. */
function seedDb(): { root: string; db: ReturnType<typeof store.open> } {
  const root = scratch();
  const db = store.open({ root });
  db.prepare(
    `INSERT INTO sessions (id, harness, title, project, project_slug, source_path, status,
        is_sidechain, started_at, ended_at, user_prompts, assistant_turns, bytes, indexed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(POOLER, 'claude', 'the pooler', '/tmp/Ledger', '-tmp-Ledger', '/tmp/x.jsonl', 'live', 0,
    '2026-08-04T09:00:00.000Z', '2026-08-04T10:00:00.000Z', 2, 2, 100, '2026-08-05T00:00:00.000Z');
  const ins = db.prepare(
    `INSERT INTO exchanges (id, session_id, seq, ts, user_text, assistant_text, files_touched)
     VALUES (?,?,?,?,?,?,?)`,
  );
  ins.run('u11', POOLER, 11, '2026-08-04T09:00:00.000Z', 'earlier context about deploys', '', '[]');
  ins.run('u12', POOLER, 12, '2026-08-04T09:05:00.000Z',
    'the pooler is 500ing on deploy',
    'pgbouncer in transaction mode cannot carry prepared statements, so we set ' +
      'statement_cache_size=0 on the client rather than moving the pooler to session mode.',
    '[]');
  // `exchanges_fts` is external-content: without the rebuild `recall`
  // shortlists nothing and every assertion below is vacuous.
  db.exec("INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild')");
  return { root, db };
}

/** What a reader returns for that session. */
const READER_OUT: AskReaderOutput = {
  found: true,
  quotes: [{ seq: 12, ts: '2026-08-04T09:05:00.000Z', text: REAL_QUOTE }],
  answer_fragment: 'they set the client cache to zero.',
};
const RECORDED = { sessionId: POOLER, ...READER_OUT };

function synthReply(
  sentences: ProposedSentence[],
  evidence: { n: number; session_id: string; seq: number; quote: string }[],
): unknown {
  return { evidence, answer: sentences.map((s) => ({ text: s.text, cites: s.cites })) };
}

/** An honest answer: one sentence, one quote that is really in the transcript. */
const HONEST = synthReply(
  [{ text: 'The client cache was set to zero rather than changing the pooler mode.', cites: [1] }],
  [{ n: 1, session_id: POOLER, seq: 12, quote: REAL_QUOTE }],
);

/**
 * The adversarial answer, and the shape of it matters.
 *
 * Sentence 1 is supported by a real quote. Sentence 2 is supported *only* by a
 * quote nobody ever said — plausible, in the right register, naming a real
 * session and a real seq. That is the failure this whole seam has to survive:
 * not a model that returns nonsense, but a model that returns something that
 * reads like a receipt. The filter must keep the first sentence and delete the
 * second, and it must do so without being told which is which.
 */
const FABRICATED_QUOTE = 'we moved the pooler to session mode and the errors stopped';
const FABRICATING = synthReply(
  [
    { text: 'The client cache was set to zero rather than changing the pooler mode.', cites: [1] },
    { text: 'Session mode was adopted and resolved the errors.', cites: [2] },
  ],
  [
    { n: 1, session_id: POOLER, seq: 12, quote: REAL_QUOTE },
    { n: 2, session_id: POOLER, seq: 12, quote: FABRICATED_QUOTE },
  ],
);

/** A transport that fails the test if anything is ever sent to it. */
class Throwing implements Transport {
  readonly backend: Backend = 'agent-sdk';
  readonly sent: SendRequest[] = [];
  closed = 0;
  async send(req: SendRequest): Promise<SendResult> {
    this.sent.push(req);
    throw new Error('a model was called on a path that must not call one');
  }
  async close(): Promise<void> {
    this.closed++;
  }
}

/** A transport that replies with a script, so the binary path can be compared. */
class Scripted implements Transport {
  readonly sent: SendRequest[] = [];
  constructor(
    readonly backend: Backend,
    private readonly replies: string[],
  ) {}
  async send(req: SendRequest): Promise<SendResult> {
    this.sent.push(req);
    const reply = this.replies[Math.min(this.sent.length - 1, this.replies.length - 1)] ?? '{}';
    return { text: reply, inputTokens: 10, outputTokens: 120 };
  }
  async close(): Promise<void> {}
}

function outFile(name: string): string {
  return path.join(scratch(), name);
}

/** Record the readers, then write the outputs back in, as a host agent would. */
async function readersWithOutputs(
  db: ReturnType<typeof store.open>,
  root: string,
  outputs: unknown[] = [RECORDED],
  k?: number,
): Promise<string> {
  const target = outFile('readers.json');
  await writeReadersFile(db, QUESTION, { root, ...(k ? { k } : {}) }, target);
  const file = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(target, JSON.stringify({ ...file, outputs }, null, 2), 'utf8');
  return target;
}

/** The full seam up to the point the host has to answer the synthesis prompt. */
async function stagedSynthesis(
  db: ReturnType<typeof store.open>,
  root: string,
  k?: number,
): Promise<{ synth: string; probe: AskResult }> {
  // `k` travels through both halves or neither. The reader file and the
  // synthesis file each pin the shortlist they were recorded against, so a
  // chain recorded at two different `k`s is refused at the first join — which
  // is the behaviour, and it is why this helper takes one number rather than
  // letting the two calls drift apart.
  const readers = await readersWithOutputs(db, root, [RECORDED], k);
  const synth = outFile('synthesis.json');
  const { probe } = await writeSynthesisFile(
    db,
    QUESTION,
    { root, ...(k ? { k } : {}) },
    synth,
    readers,
  );
  return { synth, probe };
}

/** Write the host's reply into the synthesis file, as a host agent would. */
function answerWith(target: string, reply: unknown): void {
  const file = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(target, JSON.stringify({ ...file, reply }, null, 2), 'utf8');
}

// ================================================== 1. the zero-call claim

describe('--synthesis-out makes no model call', () => {
  it('constructs no backend at all, against a transport that throws if it is sent anything', async () => {
    const { root, db } = seedDb();
    const transport = new Throwing();
    // Both handles. Neither a reader backend nor a synthesizer backend can be
    // reached without this test noticing.
    const llm = Llm.open({ transport, model: 'sonnet' });
    const readerLlm = Llm.open({ transport, model: 'haiku' });
    const readers = await readersWithOutputs(db, root);

    const { file, probe, abs } = await writeSynthesisFile(
      db,
      QUESTION,
      { root, llm, readerLlm },
      outFile('synthesis.json'),
      readers,
    );

    expect(transport.sent).toHaveLength(0);
    expect(probe.spend.calls).toBe(0);
    expect(probe.spend.usd).toBe(0);
    // and it did the expensive-to-reproduce half: the shortlist, the readers'
    // recorded verdicts, and the prompt built from them.
    expect(file).not.toBeNull();
    expect(file!.prompt).toContain(REAL_QUOTE);
    expect(file!.sessionIds).toEqual([POOLER]);
    expect(fs.existsSync(abs)).toBe(true);
    db.close();
    await llm.close();
    await readerLlm.close();
  });

  it('writes a versioned envelope carrying the prompt, the schema and the citable seqs', async () => {
    const { root, db } = seedDb();
    const readers = await readersWithOutputs(db, root, [RECORDED], 4);
    const target = outFile('synthesis.json');
    await writeSynthesisFile(db, QUESTION, { root, k: 4 }, target, readers);

    const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>;
    expect(parsed['kind']).toBe(SYNTHESIS_FILE_KIND);
    expect(parsed['version']).toBe(SYNTHESIS_FILE_VERSION);
    expect(parsed['question']).toBe(QUESTION);
    expect(parsed['k']).toBe(4);
    expect(parsed['sessionIds']).toEqual([POOLER]);
    // The three things a host agent cannot answer without.
    expect(String(parsed['system'])).toMatch(/EVIDENCE/);
    expect(String(parsed['schema'])).toContain('session_id');
    expect(String(parsed['prompt'])).toContain(QUESTION);
    // The citable set, so the host can see which seqs it may name.
    const sessions = parsed['sessions'] as { sessionId: string; seqs: number[] }[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sessionId).toBe(POOLER);
    expect(sessions[0]!.seqs).toContain(12);
    // And the readers travel with it, so `--filter-in` needs one file.
    expect(parsed['readers']).toHaveLength(1);
    expect(parsed['reply']).toBeUndefined();
    db.close();
  });

  it('writes nothing when no reader found anything — an empty prompt invites an invented answer', async () => {
    const { root, db } = seedDb();
    const readers = await readersWithOutputs(db, root, [
      { sessionId: POOLER, found: false, quotes: [], answer_fragment: '' },
    ]);
    const target = outFile('synthesis.json');
    const { file, probe } = await writeSynthesisFile(db, QUESTION, { root }, target, readers);

    expect(file).toBeNull();
    expect(fs.existsSync(target)).toBe(false);
    expect(probe.spend.calls).toBe(0);
    db.close();
  });
});

describe('--filter-in makes no model call', () => {
  it('answers from the file with a transport that throws if it is sent anything', async () => {
    const { root, db } = seedDb();
    const { synth } = await stagedSynthesis(db, root);
    answerWith(synth, HONEST);

    const transport = new Throwing();
    const llm = Llm.open({ transport, model: 'sonnet' });
    const readerLlm = Llm.open({ transport, model: 'haiku' });
    const r = await filterHostAnswer(db, QUESTION, { root, llm, readerLlm }, synth);

    expect(transport.sent).toHaveLength(0);
    expect(r.spend.calls).toBe(0);
    expect(r.spend.usd).toBe(0);
    // A real, cited answer out of a run that spent nothing.
    expect(r.answer).toContain('client cache was set to zero');
    expect(r.evidence).toHaveLength(1);
    expect(r.evidence[0]!.quote).toContain('statement_cache_size=0');
    expect(r.evidence[0]!.sessionId).toBe(POOLER);
    expect(r.evidence[0]!.seq).toBe(12);
    db.close();
    await llm.close();
    await readerLlm.close();
  });
});

// ============================== 2. the guarantee survives the hand-over

describe('the citation filter runs over the host answer, in code', () => {
  it('strips a fabricated quote from the host exactly as it strips one from the binary path', async () => {
    // --- the binary path: a scripted backend returns the fabrication.
    const a = seedDb();
    const readerLlm = Llm.open({ transport: new Scripted('agent-sdk', [JSON.stringify(READER_OUT)]), model: 'haiku' });
    const binaryLlm = Llm.open({
      transport: new Scripted('agent-sdk', [JSON.stringify(FABRICATING)]),
      model: 'sonnet',
    });
    const viaBinary = await ask(a.db, QUESTION, {
      root: a.root,
      llm: binaryLlm,
      readerLlm,
      openThreads: false,
    });

    // --- the seam: the *same* fabrication, handed back through the file.
    const b = seedDb();
    const { synth } = await stagedSynthesis(b.db, b.root);
    answerWith(synth, FABRICATING);
    const viaSeam = await filterHostAnswer(b.db, QUESTION, { root: b.root }, synth);

    // The fabricated sentence is gone on both, and gone for the same reason.
    expect(viaSeam.answer).not.toContain('Session mode');
    expect(viaBinary.answer).not.toContain('Session mode');
    expect(viaSeam.answer).toBe(viaBinary.answer);
    expect(viaSeam.evidence).toEqual(viaBinary.evidence);
    expect(viaSeam.dropped).toEqual(viaBinary.dropped);
    // The surviving sentence is the one whose quote is really in the transcript.
    expect(viaSeam.sentences).toHaveLength(1);
    expect(viaSeam.evidence).toHaveLength(1);
    expect(viaSeam.evidence[0]!.quote).toContain('statement_cache_size=0');
    // And the fabricated text is nowhere in what would be printed.
    expect(JSON.stringify(viaSeam.evidence)).not.toContain('session mode and the errors');

    a.db.close();
    b.db.close();
    await readerLlm.close();
    await binaryLlm.close();
  });

  it('reports the drop, so --debug can show what the host tried to say', async () => {
    const { root, db } = seedDb();
    const { synth } = await stagedSynthesis(db, root);
    answerWith(synth, FABRICATING);

    const drops: { kind: string; reason: string }[] = [];
    const r = await filterHostAnswer(
      db,
      QUESTION,
      { root, onDrop: (d) => drops.push({ kind: d.kind, reason: d.reason }) },
      synth,
    );

    expect(r.dropped.length).toBeGreaterThan(0);
    expect(drops.length).toBeGreaterThan(0);
    db.close();
  });

  it('a host answer with nothing checkable in it produces no answer, not a plausible one', async () => {
    const { root, db } = seedDb();
    const { synth } = await stagedSynthesis(db, root);
    answerWith(
      synth,
      synthReply(
        [{ text: 'The team moved to session mode in July.', cites: [1] }],
        [{ n: 1, session_id: POOLER, seq: 12, quote: FABRICATED_QUOTE }],
      ),
    );
    const r = await filterHostAnswer(db, QUESTION, { root }, synth);

    expect(r.answer).toBe('');
    expect(r.sentences).toHaveLength(0);
    expect(r.evidence).toHaveLength(0);
    db.close();
  });

  it('a host answer citing a session that was never shortlisted is dropped', async () => {
    const { root, db } = seedDb();
    const { synth } = await stagedSynthesis(db, root);
    answerWith(
      synth,
      synthReply(
        [{ text: 'A different session settled it.', cites: [1] }],
        [{ n: 1, session_id: 'sess-invented-9999', seq: 12, quote: REAL_QUOTE }],
      ),
    );
    const r = await filterHostAnswer(db, QUESTION, { root }, synth);

    expect(r.answer).toBe('');
    expect(r.evidence).toHaveLength(0);
    db.close();
  });

  // The test that stood here — *"a reply that is not the right shape at all is
  // the empty answer, not a crash"* — asserted VERIFICATION-4's C4 as if it
  // were the specification. It is inverted in §7 below: a refusal is not a
  // crash, and an object with neither an "evidence" nor an "answer" array is
  // not a fact about the user's archive. The two halves it was really pinning
  // — no exception escapes, and nothing unchecked reaches the answer — are
  // both still pinned there.

  it('--strict refuses a host answer the filter emptied, with ask’s own exit-2 refusal', async () => {
    const { root, db } = seedDb();
    const { synth } = await stagedSynthesis(db, root);
    answerWith(
      synth,
      synthReply(
        [{ text: 'The team moved to session mode in July.', cites: [1] }],
        [{ n: 1, session_id: POOLER, seq: 12, quote: FABRICATED_QUOTE }],
      ),
    );
    const r = await filterHostAnswer(db, QUESTION, { root, strict: true }, synth);

    expect(r.refused).toBe(true);
    expect(r.answer).toBe('');
    db.close();
  });
});

// ============================== 3. one recording, one shortlist

describe('the synthesis file is checked before it is believed', () => {
  it('refuses a file recorded against a different question', async () => {
    const { root, db } = seedDb();
    const { synth } = await stagedSynthesis(db, root);
    answerWith(synth, HONEST);

    await expect(
      filterHostAnswer(db, 'what did we decide about the queue?', { root }, synth),
    ).rejects.toThrow(/recorded against a different question/);
    db.close();
  });

  it('refuses a file recorded with a different k, which is a different shortlist', async () => {
    const { root, db } = seedDb();
    const { synth } = await stagedSynthesis(db, root, 4);
    answerWith(synth, HONEST);

    await expect(filterHostAnswer(db, QUESTION, { root, k: 6 }, synth)).rejects.toThrow(
      /recorded with --k 4 and this run asked for --k 6/,
    );
    db.close();
  });

  it('refuses a recording nobody has answered yet, and says so in those words', async () => {
    const { root, db } = seedDb();
    const { synth } = await stagedSynthesis(db, root);

    await expect(filterHostAnswer(db, QUESTION, { root }, synth)).rejects.toThrow(
      /has no "reply"/,
    );
    db.close();
  });

  it('refuses a reader file handed to --filter-in, and names the flag that takes one', async () => {
    const { root, db } = seedDb();
    const readers = await readersWithOutputs(db, root);
    let err: unknown;
    try {
      await filterHostAnswer(db, QUESTION, { root }, readers);
    } catch (e) {
      err = e;
    }
    expect(String((err as Error).message)).toMatch(/is not a synthesis file/);
    expect(String((err as { fix?: string }).fix)).toMatch(/--readers-in/);
    // and the discriminators really are different, so the check can never be
    // a coincidence of two identical envelopes.
    expect(SYNTHESIS_FILE_KIND).not.toBe(READERS_FILE_KIND);
    db.close();
  });

  it('refuses a file from a future format rather than reading it as this one', async () => {
    const { root, db } = seedDb();
    const { synth } = await stagedSynthesis(db, root);
    const file = JSON.parse(fs.readFileSync(synth, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(synth, JSON.stringify({ ...file, version: 99, reply: HONEST }, null, 2));

    await expect(filterHostAnswer(db, QUESTION, { root }, synth)).rejects.toThrow(
      /v99 synthesis file/,
    );
    db.close();
  });

  it('refuses a file whose readers name a session this question no longer shortlists', async () => {
    const { root, db } = seedDb();
    const { synth } = await stagedSynthesis(db, root);
    const file = JSON.parse(fs.readFileSync(synth, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(
      synth,
      JSON.stringify(
        {
          ...file,
          readers: [...(file['readers'] as unknown[]), { ...RECORDED, sessionId: 'sess-gone-0002' }],
          reply: HONEST,
        },
        null,
        2,
      ),
    );

    await expect(filterHostAnswer(db, QUESTION, { root }, synth)).rejects.toThrow(
      /no longer shortlists/,
    );
    db.close();
  });

  it('refuses a file with no readers array — an answer filtered against nothing', async () => {
    const { root, db } = seedDb();
    const { synth } = await stagedSynthesis(db, root);
    const file = JSON.parse(fs.readFileSync(synth, 'utf8')) as Record<string, unknown>;
    delete file['readers'];
    fs.writeFileSync(synth, JSON.stringify({ ...file, reply: HONEST }, null, 2));

    await expect(filterHostAnswer(db, QUESTION, { root }, synth)).rejects.toThrow(
      /has no "readers" array/,
    );
    db.close();
  });
});

// ============================== 4. the seam and the binary agree

describe('the seam produces the answer the binary path would have produced', () => {
  it('is identical field for field, at two fewer model calls', async () => {
    // --- the normal run: a reader backend and a synthesizer backend.
    const a = seedDb();
    const readerLlm = Llm.open({ transport: new Scripted('agent-sdk', [JSON.stringify(READER_OUT)]), model: 'haiku' });
    const synthTransport = new Scripted('agent-sdk', [JSON.stringify(HONEST)]);
    const normalLlm = Llm.open({ transport: synthTransport, model: 'sonnet' });
    const normal = await ask(a.db, QUESTION, {
      root: a.root,
      llm: normalLlm,
      readerLlm,
      openThreads: false,
    });

    // --- the seam: both halves handed back through files.
    const b = seedDb();
    const { synth } = await stagedSynthesis(b.db, b.root);
    answerWith(synth, HONEST);
    const seam = await filterHostAnswer(b.db, QUESTION, { root: b.root }, synth);

    /** Everything an answer is made of. `ms` is a clock and `spend` is the point. */
    const shape = (r: AskResult): unknown => ({
      ...r,
      ms: 0,
      spend: null,
      estimated: false,
      readers: r.readers.map((x) => ({ ...x, ms: 0 })),
    });

    expect(JSON.stringify(shape(seam))).toBe(JSON.stringify(shape(normal)));
    expect(seam.answer).toBe(normal.answer);
    expect(seam.evidence).toEqual(normal.evidence);

    // The two fields that must differ, and the whole reason the flags exist.
    expect(normal.spend.calls).toBe(2);
    expect(seam.spend.calls).toBe(0);
    expect(synthTransport.sent).toHaveLength(1);

    a.db.close();
    b.db.close();
    await readerLlm.close();
    await normalLlm.close();
  });

  it('hands the host the same prompt the backend would have been sent', async () => {
    const a = seedDb();
    const readerLlm = Llm.open({ transport: new Scripted('agent-sdk', [JSON.stringify(READER_OUT)]), model: 'haiku' });
    const synthTransport = new Scripted('agent-sdk', [JSON.stringify(HONEST)]);
    const normalLlm = Llm.open({ transport: synthTransport, model: 'sonnet' });
    await ask(a.db, QUESTION, { root: a.root, llm: normalLlm, readerLlm, openThreads: false });

    const b = seedDb();
    const { synth } = await stagedSynthesis(b.db, b.root);
    const file = JSON.parse(fs.readFileSync(synth, 'utf8')) as { prompt: string; system: string };

    // What the backend was actually sent, minus the framing `llm.ts` adds
    // around every outgoing prompt (the re-entrancy marker and the JSON rule).
    const sentToBackend = synthTransport.sent[0]!.prompt;
    expect(sentToBackend).toContain(file.prompt);
    expect(synthTransport.sent[0]!.system).toBe(file.system);

    a.db.close();
    b.db.close();
    await readerLlm.close();
    await normalLlm.close();
  });
});

// ====================== 6. a reader that found nothing is an ordinary result

/**
 * The bug this section exists for, and why the rest of the file could not see it.
 *
 * `--synthesis-out` recorded its `sessionIds` from the synthesizer's *inputs* —
 * the sessions whose readers came back `found: true`. `--filter-in` re-derives
 * the live shortlist and refuses when the recorded list does not cover it,
 * because answering from a stale file would print a live run's counts over
 * recorded content. That check is right. The list it was given was not.
 *
 * So every round trip in which any reader reported `found: false` was refused —
 * and on a real archive that is almost all of them: the first end-to-end run
 * over the demo corpus shortlisted six sessions, four of which legitimately had
 * nothing to say, and the seam rejected its own output.
 *
 * `seedDb()` seeds ONE session. With one session the synthesizer's inputs and
 * the shortlist are the same list, so the two can never disagree and no
 * assertion in this file can fail. The premise was the fixture, not the code
 * (`09 §7.2`), which is why a green suite shipped a broken happy path.
 */
function seedTwo(): { root: string; db: ReturnType<typeof store.open> } {
  const { root, db } = seedDb();
  const QUIET = '22222222-0000-4000-8000-000000000002';
  db.prepare(
    `INSERT INTO sessions (id, harness, title, project, project_slug, source_path, status,
        is_sidechain, started_at, ended_at, user_prompts, assistant_turns, bytes, indexed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(QUIET, 'claude', 'the other pooler thread', '/tmp/Ledger', '-tmp-Ledger', '/tmp/y.jsonl',
    'live', 0, '2026-08-03T09:00:00.000Z', '2026-08-03T10:00:00.000Z', 1, 1, 100,
    '2026-08-05T00:00:00.000Z');
  db.prepare(
    `INSERT INTO exchanges (id, session_id, seq, ts, user_text, assistant_text, files_touched)
     VALUES (?,?,?,?,?,?,?)`,
  ).run('q01', QUIET, 1, '2026-08-03T09:00:00.000Z',
    // Shortlisted on the words and empty on the answer, which is the whole
    // point: a session that is genuinely about pgbouncer and prepared
    // statements, in which nothing was decided. `find` is right to surface it
    // and the reader is right to come back `found: false`.
    'someone raised pgbouncer and prepared statements in standup and nobody had context',
    'Noted, no decision here — the pgbouncer prepared statements question is still open.', '[]');
  db.exec("INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild')");
  return { root, db };
}

describe('a shortlisted session whose reader found nothing', () => {
  it('is recorded in the synthesis file, so --filter-in accepts its own output', async () => {
    const { root, db } = seedTwo();
    const QUIET = '22222222-0000-4000-8000-000000000002';

    // Both sessions are shortlisted; only one has an answer in it. That is the
    // ordinary case, not a degenerate one.
    const readers = await readersWithOutputs(db, root, [
      RECORDED,
      { sessionId: QUIET, found: false, quotes: [], answer_fragment: '' },
    ]);
    const synth = outFile('synthesis-two.json');
    const { file } = await writeSynthesisFile(db, QUESTION, { root }, synth, readers);

    // The synthesizer saw one session. The FILE must record both, because both
    // are what `--filter-in` will find when it recomputes the shortlist.
    expect(file).not.toBeNull();
    expect(file!.sessions).toHaveLength(1);
    expect(file!.sessionIds).toHaveLength(2);
    expect(file!.sessionIds).toContain(QUIET);

    // And the round trip completes rather than refusing. Before the fix this
    // threw: "recorded shortlist does not match the shortlist this question
    // produces now: 1 shortlisted session it does not cover".
    answerWith(synth, HONEST);
    const result = await filterHostAnswer(db, QUESTION, { root }, synth);
    expect(result.spend.calls).toBe(0);
    expect(result.answer).toContain('client cache was set to zero');

    db.close();
  });
});

// ============ 7. a reply potsherd cannot use is never an empty archive (C4)

/**
 * VERIFICATION-4 C4, and the shape of the hole it went through.
 *
 * `--synthesis-out`'s receipt said *"answer "prompt" in the shape of "schema",
 * add it to the file as "reply""*. A host agent captures its model's **text**
 * and stores it, so `"reply"` was a JSON *string* — and every layer below
 * `filterHostAnswer` is tolerant by design: `validateSynth` returns `null` for
 * a value it cannot read, `hostSynthesize` turns `null` into
 * `{evidence:[],answer:[]}`, `filterAnswer` keeps nothing out of nothing. The
 * run printed *"the readers found nothing that answers the question"* with
 * *"1 answered"* on the line below, and exited as if it had read the archive.
 *
 * Two claims are tested here and they are not the same claim:
 *
 *   1. **the string form works**, and works *identically* — same answer, same
 *      evidence, same drops, same zero calls. A fabrication planted inside the
 *      JSON string dies in the same line of code as one planted in the object,
 *      which is the ruling this was written under: if accepting the string let
 *      anything through that the object catches, reject it loudly instead.
 *   2. **nothing unusable is ever silent.** Every shape that cannot be filtered
 *      is refused by name, at an exit code no honest empty uses, and none of
 *      the refusals prints the reply back — it is a model's prose about the
 *      user's own transcripts.
 *
 * Every test below runs on {@link seedTwo}: two sessions shortlisted, one
 * reader answering and one not. The single-session fixture is what hid the
 * last defect in this file (§6), and a false honest-empty is exactly the class
 * of bug a one-session premise cannot see.
 */

const QUIET_ID = '22222222-0000-4000-8000-000000000002';

/** The seam, staged on two sessions, up to the point the host must answer. */
async function stagedTwo(): Promise<{
  root: string;
  db: ReturnType<typeof store.open>;
  synth: string;
}> {
  const { root, db } = seedTwo();
  const readers = await readersWithOutputs(db, root, [
    RECORDED,
    { sessionId: QUIET_ID, found: false, quotes: [], answer_fragment: '' },
  ]);
  const synth = outFile('synthesis-two.json');
  const { file } = await writeSynthesisFile(db, QUESTION, { root }, synth, readers);
  // The premise of every test below: two sessions shortlisted, one answering.
  expect(file!.sessionIds).toHaveLength(2);
  expect(file!.sessions).toHaveLength(1);
  return { root, db, synth };
}

/** Everything an answer is made of, minus the clock. */
function answerShape(r: AskResult): unknown {
  return { ...r, ms: 0, readers: r.readers.map((x) => ({ ...x, ms: 0 })) };
}

async function refusal(fn: () => Promise<unknown>): Promise<Error & { fix?: string; code?: number }> {
  try {
    await fn();
  } catch (e) {
    return e as Error & { fix?: string; code?: number };
  }
  throw new Error('expected a refusal and got none');
}

describe('a reply recorded as a JSON string', () => {
  it('answers exactly as the same reply recorded as an object does', async () => {
    const { root, db, synth } = await stagedTwo();

    answerWith(synth, HONEST);
    const viaObject = await filterHostAnswer(db, QUESTION, { root }, synth);
    answerWith(synth, JSON.stringify(HONEST));
    const notes: string[] = [];
    const viaString = await filterHostAnswer(db, QUESTION, { root }, synth, (l) => notes.push(l));

    // Not "it answers": it answers with the same bytes.
    expect(JSON.stringify(answerShape(viaString))).toBe(JSON.stringify(answerShape(viaObject)));
    expect(viaString.answer).toContain('client cache was set to zero');
    expect(viaString.evidence).toHaveLength(1);
    expect(viaString.spend.calls).toBe(0);
    // And the run says it had to parse, above the answer.
    expect(notes.join(' ')).toMatch(/was a JSON string; parsed it/);
    db.close();
  });

  it('drops a fabrication planted inside the string exactly as it drops one in the object', async () => {
    const { root, db, synth } = await stagedTwo();

    answerWith(synth, FABRICATING);
    const viaObject = await filterHostAnswer(db, QUESTION, { root }, synth);
    answerWith(synth, JSON.stringify(FABRICATING));
    const viaString = await filterHostAnswer(db, QUESTION, { root }, synth);

    expect(JSON.stringify(answerShape(viaString))).toBe(JSON.stringify(answerShape(viaObject)));
    expect(viaString.answer).not.toContain('Session mode');
    expect(viaString.sentences).toHaveLength(1);
    expect(viaString.dropped.length).toBeGreaterThan(0);
    expect(JSON.stringify(viaString.evidence)).not.toContain('session mode and the errors');
    db.close();
  });

  it('parses a fenced string, which is what a model returns when it is being helpful', async () => {
    const { root, db, synth } = await stagedTwo();
    answerWith(synth, '```json\n' + JSON.stringify(HONEST, null, 2) + '\n```');
    const r = await filterHostAnswer(db, QUESTION, { root }, synth);

    expect(r.answer).toContain('client cache was set to zero');
    expect(r.spend.calls).toBe(0);
    db.close();
  });

  it('refuses a fence with prose inside it rather than guessing at the prose', async () => {
    const { root, db, synth } = await stagedTwo();
    answerWith(synth, '```\nThe client cache was set to zero.\n```');
    const err = await refusal(() => filterHostAnswer(db, QUESTION, { root }, synth));

    expect(err.message).toMatch(/is a string and it is not JSON/);
    db.close();
  });
});

describe('a reply that cannot be filtered is refused, not reported as nothing found', () => {
  it('refuses prose, and says it is prose rather than answering nothing', async () => {
    const { root, db, synth } = await stagedTwo();
    answerWith(synth, 'The client cache was set to zero rather than changing the pooler mode.');
    const err = await refusal(() => filterHostAnswer(db, QUESTION, { root }, synth));

    expect(err.message).toMatch(/"reply" is a string and it is not JSON/);
    expect(err.message).toMatch(/prose carries no quote it can check/);
    // `JSON.parse`'s own message quotes back ten characters of what it was
    // given. Those ten characters are a model's prose about the user's
    // transcripts, so the parser's message is not printed at all.
    expect(err.message).not.toContain('The client cache');
    expect(err.fix).toMatch(/store that object as "reply"/);
    db.close();
  });

  it('refuses an empty string as an unanswered file, not an empty archive', async () => {
    const { root, db, synth } = await stagedTwo();
    answerWith(synth, '   ');
    const err = await refusal(() => filterHostAnswer(db, QUESTION, { root }, synth));

    expect(err.message).toMatch(/"reply" is an empty string/);
    expect(err.message).toMatch(/not an archive with nothing in it/);
    db.close();
  });

  it('refuses a JSON string that parses to something other than an object, and names what it found', async () => {
    const { root, db, synth } = await stagedTwo();
    answerWith(synth, JSON.stringify([HONEST]));
    const err = await refusal(() => filterHostAnswer(db, QUESTION, { root }, synth));

    expect(err.message).toMatch(/is a JSON string containing an array/);
    db.close();
  });

  it('refuses a reply that is not an object at all', async () => {
    const { root, db, synth } = await stagedTwo();
    answerWith(synth, 42);
    const err = await refusal(() => filterHostAnswer(db, QUESTION, { root }, synth));

    expect(err.message).toMatch(/"reply" is a number/);
    db.close();
  });

  it('refuses an object with neither an "evidence" nor an "answer" array', async () => {
    // This test used to assert the opposite — *"a reply that is not the right
    // shape at all is the empty answer, not a crash"* — and a refusal is not a
    // crash. An object with neither array is a host agent that answered the
    // wrong question or wrote the wrong field, and printing "the readers found
    // nothing" over it is a statement about the user's archive that this run
    // has no basis for. FIX-G C4(b).
    const { root, db, synth } = await stagedTwo();
    answerWith(synth, { some: 'other thing entirely' });
    const err = await refusal(() => filterHostAnswer(db, QUESTION, { root }, synth));

    expect(err.message).toMatch(/neither an "evidence" array nor an "answer" array/);
    expect(err.message).toMatch(/nothing in it for the citation filter to check/);
    db.close();
  });

  it('refuses arrays whose every entry is malformed, the case validateSynth nulls', async () => {
    const { root, db, synth } = await stagedTwo();
    // Both arrays are present and non-empty, so the shape check above passes.
    // Every entry is missing a field the schema requires, so `validateSynth`
    // would return null and the run would have printed an empty archive.
    answerWith(synth, { evidence: [{ quote: 'x' }, { session_id: POOLER }], answer: [{}, { cites: [1] }] });
    const err = await refusal(() => filterHostAnswer(db, QUESTION, { root }, synth));

    expect(err.message).toMatch(/holds 2 evidence entries and 2 sentences/);
    expect(err.message).toMatch(/not one of them is usable/);
    db.close();
  });

  it('allows an object with both arrays empty — the host’s own honest empty', async () => {
    // The one case where an empty result is the truth: a synthesizer that read
    // the evidence and concluded nothing is supportable is answering, not
    // failing. The refusal above must never swallow this.
    const { root, db, synth } = await stagedTwo();
    answerWith(synth, { evidence: [], answer: [] });
    const r = await filterHostAnswer(db, QUESTION, { root }, synth);

    expect(r.answer).toBe('');
    expect(r.sentences).toHaveLength(0);
    expect(r.spend.calls).toBe(0);
    db.close();
  });

  it('exits 2 on every reply refusal — the code no honest empty uses', async () => {
    // `ask`'s codes: 0 a grounded answer, 1 the archive was read and had
    // nothing, 2 potsherd declined to answer. C4 is that a broken input was
    // being reported in the vocabulary of the empty archive, so 1 is the one
    // code these must not carry.
    const { root, db, synth } = await stagedTwo();
    for (const bad of ['prose, not JSON', '', 42, { some: 'thing' }, JSON.stringify([1, 2])]) {
      answerWith(synth, bad);
      const err = await refusal(() => filterHostAnswer(db, QUESTION, { root }, synth));
      expect(err.code).toBe(2);
    }
    // and the unanswered recording, which is the same problem one stage earlier
    const file = JSON.parse(fs.readFileSync(synth, 'utf8')) as Record<string, unknown>;
    delete file['reply'];
    fs.writeFileSync(synth, JSON.stringify(file, null, 2), 'utf8');
    const err = await refusal(() => filterHostAnswer(db, QUESTION, { root }, synth));
    expect(err.message).toMatch(/has no "reply"/);
    expect(err.code).toBe(2);
    db.close();
  });

  it('never prints the reply back, because it is prose about the user’s transcripts', async () => {
    const { root, db, synth } = await stagedTwo();
    const secret = 'the migration ran against the production ledger at 03:40';
    for (const bad of [secret, JSON.stringify([secret]), { note: secret }]) {
      answerWith(synth, bad);
      const err = await refusal(() => filterHostAnswer(db, QUESTION, { root }, synth));
      // Not a word of it, and not the ten-character head `JSON.parse` quotes.
      expect(err.message).not.toContain(secret.slice(0, 10));
      expect(err.message).not.toContain('migration');
      expect(err.message).not.toContain('ledger');
      expect(String(err.fix ?? '')).not.toContain('migration');
    }
    db.close();
  });
});

describe('the instruction the host is given names the shape', () => {
  it('is written into the file, for the agent that only ever sees the file', async () => {
    const { db, synth } = await stagedTwo();
    const parsed = JSON.parse(fs.readFileSync(synth, 'utf8')) as Record<string, unknown>;

    const instruction = String(parsed['instruction'] ?? '');
    expect(instruction).toBe(REPLY_INSTRUCTION);
    // The three facts a competent reader needed and did not have: that it is
    // an object, that the JSON text of it is also accepted, and that anything
    // else is refused rather than read as an empty answer.
    expect(instruction).toMatch(/JSON object/);
    expect(instruction).toMatch(/JSON text/);
    expect(instruction).toMatch(/refused rather than read as an empty answer/);
    // The old sentence — "add it to the file as reply" — is what a reader
    // resolved to "add the model's text".
    expect(instruction).not.toMatch(/add it to the file/);
    db.close();
  });
});

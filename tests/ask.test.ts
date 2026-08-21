import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { db as store } from '@potsherd/core';
import {
  ANSWER_MAX_WORDS,
  ASK_K,
  ASK_MAX_USD,
  ASK_SESSION_CHARS,
  MIN_QUOTE_CHARS,
  STRICT_MIN_EVIDENCE,
  ask,
  excerptText,
  excerptUnits,
  filterAnswer,
  normaliseQuote,
  quoteOccursIn,
  type AskDrop,
  type AskReaderFn,
  type AskReaderOutput,
  type EvidenceSource,
  type ProposedEvidence,
  type ProposedSentence,
} from '../packages/core/src/ask.js';
import { matchSpan, quotableText } from '../packages/core/src/ask.js';
import { QUOTE_CHARS, clipQuote, maskSafeCut, renderAsk } from '../packages/core/src/render/ask.js';
import { Theme, stripAnsi } from '../packages/core/src/theme.js';
import { Llm, type Backend, type SendRequest, type SendResult, type Transport } from '../packages/core/src/llm.js';
import type { Transcript, TranscriptUnit } from '../packages/core/src/cards/transcript.js';
import { rmrf, tempDir } from './helpers.js';

/**
 * `ask` is the verb the whole project's claim rests on, and the claim is not
 * "the model is careful". It is:
 *
 *   **a sentence without a citation is dropped by code, not by prompt.**
 *
 * So the centre of this file is not the happy path. It is a synthesizer that
 * behaves as badly as a synthesizer can — quoting seqs that do not exist,
 * quoting text that was never written, paraphrasing what was, citing a session
 * nobody read, and writing confident prose with no citations at all — driven
 * through the real filter, with the real `AskResult` checked afterwards.
 *
 * `phases/phase-4-ask-and-graft.md` risks names the fixture: *"test it with an
 * adversarial fixture where the reader quotes are unrelated to the question"*.
 * That is `adversarialSources()` below.
 */

const created: string[] = [];
afterEach(() => {
  while (created.length) rmrf(created.pop()!);
});

function scratch(prefix = 'potsherd-ask-test-'): string {
  const dir = tempDir(prefix);
  created.push(dir);
  return dir;
}

// --------------------------------------------------------------- fixtures

function unit(seq: number, text: string, ts = `2026-08-0${(seq % 9) + 1}T09:00:00.000Z`): TranscriptUnit {
  return { seq, id: `u${seq}`, ts, text };
}

/** One session whose text says something specific and quotable. */
const POOLER = 'sess-pooler-0001';
const POOLER_TEXT =
  'user: the pooler is 500ing on deploy\n\n' +
  'assistant: pgbouncer in transaction mode cannot carry prepared statements, ' +
  'so we set statement_cache_size=0 on the client rather than moving the pooler to session mode.';

const NOTES = 'sess-notes-00002';
const NOTES_TEXT =
  'user: remind me what we said about the queue\n\n' +
  'assistant: we left the queue alone this week and revisited nothing.';

function sources(): EvidenceSource[] {
  return [
    {
      sessionId: POOLER,
      id8: 'sess-poo',
      project: 'Fulcrum',
      harness: 'claude',
      isSidechain: false,
      isGhost: false,
      units: [unit(11, 'user: earlier context about deploys'), unit(12, POOLER_TEXT)],
    },
    {
      sessionId: NOTES,
      id8: 'sess-not',
      project: 'meghbrain',
      harness: 'claude',
      isSidechain: false,
      isGhost: true,
      units: [unit(3, NOTES_TEXT)],
    },
  ];
}

const REAL_QUOTE = 'we set statement_cache_size=0 on the client';

// ============================================================ quote checks

describe('normaliseQuote', () => {
  it('folds whitespace, case and typographic glyphs and nothing else', () => {
    expect(normaliseQuote('  We   Set\nstatement_cache_size=0 ')).toBe(
      'we set statement_cache_size=0',
    );
    expect(normaliseQuote('don’t — “yes”…')).toBe(normaliseQuote("don't - \"yes\"..."));
  });

  it('does not fold a word away, so a paraphrase can never normalise into a quote', () => {
    expect(normaliseQuote('we disabled the statement cache')).not.toBe(
      normaliseQuote('we set statement_cache_size=0'),
    );
  });
});

describe('quoteOccursIn', () => {
  it('accepts a verbatim quote through a re-wrap', () => {
    expect(quoteOccursIn('we set\n  statement_cache_size=0 on the client', POOLER_TEXT)).toBe(true);
  });

  it('rejects a paraphrase of the same sentence', () => {
    expect(quoteOccursIn('we turned off the prepared statement cache', POOLER_TEXT)).toBe(false);
  });

  it('rejects a quote shorter than MIN_QUOTE_CHARS, so "the" cannot be evidence', () => {
    expect('the'.length).toBeLessThan(MIN_QUOTE_CHARS);
    expect(quoteOccursIn('the', POOLER_TEXT)).toBe(false);
    expect(quoteOccursIn('pgbouncer', POOLER_TEXT)).toBe(false);
  });
});

describe("the emitted quote is the transcript's bytes, not the model's", () => {
  // The ask evals check every evidence line against the index and count a
  // quote that matches "only after case folding" as a **fault**: a quote is a
  // quotation, and a tool that lowercases somebody's words has changed the
  // record even though it changed none of them. So the folding in
  // `normaliseQuote` is used to *find* the passage and never to render it.
  it('repairs a re-cased quote to the source casing', () => {
    const out = filterAnswer(
      [{ text: 'The cache was set to zero.', cites: [1] }],
      // The model shouted it. The transcript did not.
      [{ index: 1, sessionId: POOLER, seq: 12, quote: 'WE SET STATEMENT_CACHE_SIZE=0 ON THE CLIENT' }],
      sources(),
    );
    expect(out.evidence).toHaveLength(1);
    expect(out.evidence[0]!.quote).toBe('we set statement_cache_size=0 on the client');
  });

  it('repairs a curly apostrophe back to the straight one the transcript has', () => {
    const src: EvidenceSource[] = [
      {
        sessionId: POOLER,
        id8: 'sess-poo',
        project: 'Fulcrum',
        harness: 'claude',
        isSidechain: false,
        isGhost: false,
        units: [unit(12, "user: x\n\nassistant: we don't carry prepared statements at the pooler")],
      },
    ];
    const out = filterAnswer(
      [{ text: 'Not at the pooler.', cites: [1] }],
      [{ index: 1, sessionId: POOLER, seq: 12, quote: 'we don’t carry prepared statements' }],
      src,
    );
    expect(out.evidence[0]!.quote).toBe("we don't carry prepared statements");
  });

  it('the emitted quote is a literal substring of the exchange as the index stores it', () => {
    // The index holds `user_text` and `assistant_text` as two columns, and
    // anything checking a citation later reads them joined with a newline and
    // no labels. `unitText` adds `user:` / `assistant:` for the model's
    // benefit; those labels must never end up inside a quote.
    const stored =
      'the pooler is 500ing on deploy\npgbouncer in transaction mode cannot carry prepared ' +
      'statements, so we set statement_cache_size=0 on the client rather than moving the ' +
      'pooler to session mode.';
    expect(quotableText(POOLER_TEXT)).toBe(stored);
    const out = filterAnswer(
      [{ text: 'Set to zero.', cites: [1] }],
      [{ index: 1, sessionId: POOLER, seq: 12, quote: REAL_QUOTE }],
      sources(),
    );
    expect(stored.replace(/\s+/g, ' ')).toContain(out.evidence[0]!.quote);
  });

  it('refuses a quote that would span the user/assistant join', () => {
    const out = filterAnswer(
      [{ text: 'Both sides at once.', cites: [1] }],
      [{ index: 1, sessionId: POOLER, seq: 12, quote: 'on deploy assistant: pgbouncer in transaction mode' }],
      sources(),
    );
    expect(out.evidence).toHaveLength(0);
    expect(reasons(out.drops)).toContain('not-a-quote');
  });

  it('refuses a quote that swallowed an elided middle', () => {
    const long =
      'user: q\n\nassistant: ' +
      'head '.repeat(10) +
      '\n… [4,000 characters elided] …\n' +
      'tail '.repeat(10);
    const src: EvidenceSource[] = [
      {
        sessionId: POOLER,
        id8: 'sess-poo',
        project: 'Fulcrum',
        harness: 'claude',
        isSidechain: false,
        isGhost: false,
        units: [unit(12, long)],
      },
    ];
    const out = filterAnswer(
      [{ text: 'One continuous passage.', cites: [1] }],
      [
        {
          index: 1,
          sessionId: POOLER,
          seq: 12,
          quote: 'head head … [4,000 characters elided] … tail tail',
        },
      ],
      src,
    );
    expect(out.evidence).toHaveLength(0);
  });

  it('matchSpan reports source coordinates, not folded ones', () => {
    const text = 'AAA   We  Set   The  Cache   To  Zero.';
    // Long enough to clear MIN_QUOTE_CHARS — the floor applies here too, since
    // this is the function the floor is enforced in.
    const span = matchSpan('we set the cache to zero.', text);
    expect(span).not.toBeNull();
    expect(text.slice(span!.start, span!.end)).toBe('We  Set   The  Cache   To  Zero.');
  });
});

// ============================================================== the filter

describe('filterAnswer — the code-level citation filter', () => {
  it('keeps a sentence whose quote actually occurs at the seq it names', () => {
    const out = filterAnswer(
      [{ text: 'We disabled the statement cache at the client.', cites: [1] }],
      [{ index: 1, sessionId: POOLER, seq: 12, quote: REAL_QUOTE }],
      sources(),
    );
    expect(out.sentences).toHaveLength(1);
    expect(out.evidence).toHaveLength(1);
    expect(out.evidence[0]!.index).toBe(1);
    expect(out.evidence[0]!.seq).toBe(12);
    // The timestamp is the transcript's, not the model's.
    expect(out.evidence[0]!.ts).toBe('2026-08-04T09:00:00.000Z');
    expect(out.dropped).toHaveLength(0);
  });

  it('drops a fabricated seq — the quote is real, the location is not', () => {
    const out = filterAnswer(
      [{ text: 'We disabled the statement cache.', cites: [1] }],
      [{ index: 1, sessionId: POOLER, seq: 99, quote: REAL_QUOTE }],
      sources(),
    );
    expect(out.evidence).toHaveLength(0);
    expect(out.sentences).toHaveLength(0);
    expect(out.dropped).toEqual(['We disabled the statement cache.']);
    expect(reasons(out.drops)).toContain('unresolved-seq');
  });

  it('drops a quote attributed to the wrong seq in the right session', () => {
    const out = filterAnswer(
      [{ text: 'We disabled the statement cache.', cites: [1] }],
      // seq 11 exists and does not contain this sentence.
      [{ index: 1, sessionId: POOLER, seq: 11, quote: REAL_QUOTE }],
      sources(),
    );
    expect(out.evidence).toHaveLength(0);
    expect(reasons(out.drops)).toContain('not-a-quote');
  });

  it('drops a fabricated quote', () => {
    const out = filterAnswer(
      [{ text: 'We moved the pooler to session mode.', cites: [1] }],
      [
        {
          index: 1,
          sessionId: POOLER,
          seq: 12,
          quote: 'we moved the pooler to session mode and shipped it on friday',
        },
      ],
      sources(),
    );
    expect(out.evidence).toHaveLength(0);
    expect(out.sentences).toHaveLength(0);
    expect(reasons(out.drops)).toContain('not-a-quote');
  });

  it('drops a paraphrase-not-quote even when it is faithful to the meaning', () => {
    const out = filterAnswer(
      [{ text: 'Prepared statements were switched off client-side.', cites: [1] }],
      [
        {
          index: 1,
          sessionId: POOLER,
          seq: 12,
          // Accurate. Not what the transcript says.
          quote: 'prepared statements were disabled on the client side',
        },
      ],
      sources(),
    );
    expect(out.evidence).toHaveLength(0);
    expect(reasons(out.drops)).toEqual(['not-a-quote', 'no-citation']);
  });

  it('drops a citation to a session no reader was given', () => {
    const out = filterAnswer(
      [{ text: 'It was decided in another project.', cites: [1] }],
      [{ index: 1, sessionId: 'sess-never-read', seq: 12, quote: REAL_QUOTE }],
      sources(),
    );
    expect(reasons(out.drops)).toContain('unknown-session');
    expect(out.evidence).toHaveLength(0);
  });

  it('keeps the surviving half of a sentence with two citations', () => {
    const out = filterAnswer(
      [{ text: 'We disabled it at the client.', cites: [1, 2] }],
      [
        { index: 1, sessionId: POOLER, seq: 12, quote: REAL_QUOTE },
        { index: 2, sessionId: POOLER, seq: 12, quote: 'a quote that was never written down' },
      ],
      sources(),
    );
    expect(out.sentences).toHaveLength(1);
    expect(out.sentences[0]!.cites).toEqual([1]);
    expect(out.evidence).toHaveLength(1);
  });

  it('renumbers so cites stay 1-based and dense after the middle line is dropped', () => {
    const out = filterAnswer(
      [
        { text: 'First claim.', cites: [1] },
        { text: 'Second claim.', cites: [2] },
        { text: 'Third claim.', cites: [3] },
      ],
      [
        { index: 1, sessionId: POOLER, seq: 12, quote: REAL_QUOTE },
        { index: 2, sessionId: POOLER, seq: 12, quote: 'invented text that is not in there' },
        { index: 3, sessionId: NOTES, seq: 3, quote: 'we left the queue alone this week' },
      ],
      sources(),
    );
    expect(out.sentences.map((s) => s.text)).toEqual(['First claim.', 'Third claim.']);
    expect(out.evidence.map((e) => e.index)).toEqual([1, 2]);
    expect(out.sentences.map((s) => s.cites)).toEqual([[1], [2]]);
    expect(out.dropped).toEqual(['Second claim.']);
  });

  it('drops evidence nothing cites', () => {
    const out = filterAnswer(
      [{ text: 'Only the first matters.', cites: [1] }],
      [
        { index: 1, sessionId: POOLER, seq: 12, quote: REAL_QUOTE },
        { index: 2, sessionId: NOTES, seq: 3, quote: 'we left the queue alone this week' },
      ],
      sources(),
    );
    expect(out.evidence).toHaveLength(1);
    expect(reasons(out.drops)).toContain('uncited');
  });

  it('a synthesizer that cites nothing yields nothing at all', () => {
    const out = filterAnswer(
      [
        { text: 'You settled on pgbouncer in transaction mode.', cites: [] },
        { text: 'The decision was never revisited.', cites: [] },
      ],
      [],
      sources(),
    );
    expect(out.sentences).toHaveLength(0);
    expect(out.evidence).toHaveLength(0);
    expect(out.dropped).toHaveLength(2);
  });

  it('a one-word quote cannot buy a citation', () => {
    const out = filterAnswer(
      [{ text: 'Everything is fine.', cites: [1] }],
      [{ index: 1, sessionId: POOLER, seq: 12, quote: 'the' }],
      sources(),
    );
    expect(out.evidence).toHaveLength(0);
    expect(reasons(out.drops)).toContain('too-short');
  });
});

function reasons(drops: readonly AskDrop[]): string[] {
  return drops.map((d) => d.reason);
}

// ================================================== the adversarial fixture

/**
 * The fixture the phase plan asks for by name: readers that answer confidently
 * with quotes that have nothing to do with the question, and a synthesizer
 * that writes a fluent paragraph on top of them.
 *
 * The quotes here are *real* — they occur at the seqs they name — so nothing
 * in the filter's first step can save the user. What has to happen is that the
 * sentences citing invented evidence are dropped, and under `--strict` the
 * remainder is refused rather than shown.
 */
function adversarialSources(): EvidenceSource[] {
  return [
    {
      sessionId: 'sess-lunch-0001',
      id8: 'sess-lun',
      project: 'meghbrain',
      harness: 'claude',
      isSidechain: false,
      isGhost: false,
      units: [
        unit(4, 'user: what should I have for lunch\n\nassistant: the leftovers in the fridge are fine.'),
      ],
    },
  ];
}

describe('the adversarial fixture: reader quotes unrelated to the question', () => {
  const proposed: ProposedSentence[] = [
    { text: 'You decided to disable prepared statements at the pooler.', cites: [1] },
    { text: 'The change shipped in July and was never revisited.', cites: [2] },
    { text: 'The team was broadly happy with the outcome.', cites: [] },
  ];

  it('drops every sentence when the evidence is invented, and answers nothing', () => {
    const evidence: ProposedEvidence[] = [
      // Confident, plausible, and nowhere in the transcript.
      { index: 1, sessionId: 'sess-lunch-0001', seq: 4, quote: 'we disabled prepared statements at the pooler' },
      { index: 2, sessionId: 'sess-lunch-0001', seq: 4, quote: 'shipped in july, never revisited since' },
    ];
    const out = filterAnswer(proposed, evidence, adversarialSources());
    expect(out.sentences).toHaveLength(0);
    expect(out.evidence).toHaveLength(0);
    expect(out.dropped).toHaveLength(3);
  });

  it('does not accept a real but irrelevant quote as support for an invented claim', () => {
    // The quote is verbatim. It is about lunch. The filter cannot judge
    // relevance and does not pretend to — but the claim is only allowed to
    // stand with the quote *visible beside it*, which is the guarantee.
    const out = filterAnswer(
      [{ text: 'You decided to disable prepared statements at the pooler.', cites: [1] }],
      [{ index: 1, sessionId: 'sess-lunch-0001', seq: 4, quote: 'the leftovers in the fridge are fine' }],
      adversarialSources(),
    );
    expect(out.sentences).toHaveLength(1);
    expect(out.evidence[0]!.quote).toContain('leftovers');
    // And the rendered block puts them on the same screen, so the mismatch is
    // the reader's to see rather than the tool's to hide.
    const text = stripAnsi(
      renderAsk(
        resultFrom(out, { question: 'how did we handle pgbouncer?', searched: 1, matching: 1 }),
        new Theme({ color: false, width: 80 }),
        new Date('2026-08-21T00:00:00Z'),
      ),
    );
    expect(text).toContain('leftovers in the fridge');
  });
});

// ============================================== end-to-end, with fake models

/** A transport that answers each call with whatever the test queued, in order. */
class Scripted implements Transport {
  readonly sent: SendRequest[] = [];
  closed = 0;
  constructor(
    readonly backend: Backend = 'agent-sdk',
    private readonly replies: (string | Error)[] = [],
  ) {}
  async send(req: SendRequest): Promise<SendResult> {
    this.sent.push(req);
    const reply = this.replies[Math.min(this.sent.length - 1, this.replies.length - 1)] ?? '{}';
    if (reply instanceof Error) throw reply;
    // Reproduces the agent SDK's constant `input_tokens: 10` (`04`, 21 aug
    // 2026), so `estimated` is exercised on the path a real run takes.
    return { text: reply, inputTokens: 10, outputTokens: 120 };
  }
  async close(): Promise<void> {
    this.closed++;
  }
}

/** An index holding the two fixture sessions, so `ask()` can run for real. */
function seedDb(): { root: string; db: ReturnType<typeof store.open> } {
  const root = scratch();
  const db = store.open({ root });
  db.prepare(
    `INSERT INTO sessions (id, harness, title, project, project_slug, source_path, status,
        is_sidechain, started_at, ended_at, user_prompts, assistant_turns, bytes, indexed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(POOLER, 'claude', 'the pooler', '/tmp/Fulcrum', '-tmp-Fulcrum', '/tmp/x.jsonl', 'live', 0,
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
  // `exchanges_fts` is external-content, so the rows have to be published to
  // it or `recall` shortlists nothing and every test below is vacuous.
  db.exec("INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild')");
  return { root, db };
}

const READER_OK = JSON.stringify({
  found: true,
  quotes: [{ seq: 12, ts: '2026-08-04T09:05:00.000Z', text: REAL_QUOTE }],
  answer_fragment: 'they set the client cache to zero.',
});

function synthReply(sentences: ProposedSentence[], evidence: { n: number; session_id: string; seq: number; quote: string }[]): string {
  return JSON.stringify({ evidence, answer: sentences.map((s) => ({ text: s.text, cites: s.cites })) });
}

describe('ask() end to end', () => {
  it('answers, and answer is exactly the kept sentences joined', async () => {
    const { root, db } = seedDb();
    const readerLlm = Llm.open({ transport: new Scripted('agent-sdk', [READER_OK]), model: 'haiku' });
    const llm = Llm.open({
      transport: new Scripted('agent-sdk', [
        synthReply(
          [
            { text: 'The client cache was set to zero rather than changing the pooler mode.', cites: [1] },
            { text: 'This was reviewed again in September and reversed.', cites: [2] },
          ],
          [
            { n: 1, session_id: POOLER, seq: 12, quote: REAL_QUOTE },
            { n: 2, session_id: POOLER, seq: 12, quote: 'reviewed again in september and reversed' },
          ],
        ),
      ]),
      model: 'sonnet',
    });

    const r = await ask(db, 'how did we handle pgbouncer with prepared statements?', {
      root,
      llm,
      readerLlm,
      openThreads: false,
    });

    expect(r.sentences).toHaveLength(1);
    expect(r.answer).toBe(r.sentences.map((s) => s.text).join(' '));
    expect(r.answer).not.toContain('September');
    expect(r.dropped).toEqual(['This was reviewed again in September and reversed.']);
    expect(r.evidence).toHaveLength(1);
    expect(r.evidence[0]!.sessionId).toBe(POOLER);
    expect(r.evidence[0]!.project).toBe('Fulcrum');
    expect(r.refused).toBe(false);
    expect(r.searched).toBe(1);
    // The agent SDK's constant 10 is discarded by llm.ts, so the figure is est.
    expect(r.estimated).toBe(true);
    expect(r.spend.calls).toBe(2);
    db.close();
    await llm.close();
    await readerLlm.close();
  });

  it('refuses under --strict rather than printing a plausible paragraph', async () => {
    const { root, db } = seedDb();
    const readerLlm = Llm.open({ transport: new Scripted('agent-sdk', [READER_OK]), model: 'haiku' });
    const llm = Llm.open({
      transport: new Scripted('agent-sdk', [
        synthReply(
          [
            { text: 'You settled on transaction mode and moved on.', cites: [1] },
            { text: 'Nobody revisited it.', cites: [] },
          ],
          [{ n: 1, session_id: POOLER, seq: 12, quote: 'you settled on transaction mode and moved on' }],
        ),
      ]),
      model: 'sonnet',
    });

    const r = await ask(db, 'how did we handle pgbouncer with prepared statements?', {
      root,
      llm,
      readerLlm,
      strict: true,
      openThreads: false,
    });

    expect(r.refused).toBe(true);
    expect(r.answer).toBe('');
    expect(r.sentences).toHaveLength(0);
    expect(r.evidence).toHaveLength(0);
    const text = stripAnsi(renderAsk(r, new Theme({ color: false, width: 80 })));
    expect(text).toContain('no grounded answer in 1 session searched');
    expect(text).not.toContain('transaction mode and moved on');
    db.close();
    await llm.close();
    await readerLlm.close();
  });

  it('survives a reader that dies, and records that it did', async () => {
    const { root, db } = seedDb();
    const readerFn: AskReaderFn = async () => {
      throw new Error('did not answer within 360s');
    };
    const llm = Llm.open({ transport: new Scripted('agent-sdk', ['{}']), model: 'sonnet' });
    const r = await ask(db, 'pgbouncer prepared statements', {
      root,
      llm,
      readerFn,
      openThreads: false,
    });
    expect(r.readers).toHaveLength(1);
    expect(r.readers[0]!.found).toBe(false);
    expect(r.readers[0]!.error).toContain('did not answer');
    expect(r.answer).toBe('');
    // No reader answered, so the synthesizer was never called.
    expect(r.spend.calls).toBe(0);
    db.close();
    await llm.close();
  });

  it('T4.4: readerFn replaces the SDK entirely, and its quotes face the same filter', async () => {
    const { root, db } = seedDb();
    const seen: string[] = [];
    const readerFn: AskReaderFn = async (input): Promise<AskReaderOutput> => {
      seen.push(input.sessionId);
      expect(input.excerpts).toContain('[seq 12');
      expect(input.seqs).toContain(12);
      return {
        found: true,
        quotes: [{ seq: 12, ts: null, text: REAL_QUOTE }],
        answer_fragment: 'client cache set to zero',
      };
    };
    const llm = Llm.open({
      transport: new Scripted('agent-sdk', [
        synthReply(
          [{ text: 'The client cache was set to zero.', cites: [1] }],
          [{ n: 1, session_id: POOLER, seq: 12, quote: REAL_QUOTE }],
        ),
      ]),
      model: 'sonnet',
    });
    const r = await ask(db, 'pgbouncer prepared statements', { root, llm, readerFn, openThreads: false });
    expect(seen).toEqual([POOLER]);
    // One call: the synthesizer. The readers cost nothing on this path, which
    // is the whole point of the seam (`phase-4` T4.4).
    expect(r.spend.calls).toBe(1);
    expect(r.evidence).toHaveLength(1);
    db.close();
    await llm.close();
  });

  it('aborts before the synthesizer when the readers alone exceeded --max-usd', async () => {
    const { root, db } = seedDb();
    const { Budget } = await import('../packages/core/src/llm.js');
    // One ceiling across both models, which is what `--max-usd` has to mean.
    const budget = new Budget({ maxUsd: 0.15 });
    const synth = new Scripted('agent-sdk', ['{}']);
    const llm = Llm.open({ transport: synth, model: 'sonnet', budget });
    // A reader whose call is admitted (projected ~$0.02) and then costs $0.20.
    const readerTransport: Transport = {
      backend: 'agent-sdk',
      async send() {
        return { text: READER_OK, inputTokens: 10, outputTokens: 120, usd: 0.2 };
      },
      async close() {},
    };
    const readerLlm = Llm.open({ transport: readerTransport, model: 'haiku', budget });

    const r = await ask(db, 'pgbouncer prepared statements', {
      root,
      llm,
      readerLlm,
      budget,
      maxUsd: 0.15,
      openThreads: false,
    });

    // The reader ran and found something; the synthesizer was never called.
    expect(r.readers[0]!.found).toBe(true);
    expect(synth.sent).toHaveLength(0);
    expect(r.refused).toBe(true);
    expect(r.answer).toBe('');
    expect(r.evidence).toHaveLength(0);
    expect(r.spend.usd).toBeGreaterThan(0.15);
    db.close();
    await llm.close();
    await readerLlm.close();
  });

  it('degrades to no open threads when open-threads.ts is not implemented', async () => {
    const { root, db } = seedDb();
    const readerFn: AskReaderFn = async () => ({
      found: true,
      quotes: [{ seq: 12, ts: null, text: REAL_QUOTE }],
      answer_fragment: 'x',
    });
    const llm = Llm.open({
      transport: new Scripted('agent-sdk', [
        synthReply(
          [{ text: 'The client cache was set to zero.', cites: [1] }],
          [{ n: 1, session_id: POOLER, seq: 12, quote: REAL_QUOTE }],
        ),
      ]),
      model: 'sonnet',
    });
    // openThreads left ON: `openThreadCandidates` throws in this worktree and
    // the verb must not notice.
    const r = await ask(db, 'pgbouncer prepared statements', { root, llm, readerFn });
    expect(r.openThreads).toEqual([]);
    expect(r.sentences).toHaveLength(1);
    db.close();
    await llm.close();
  });

  it('never reports more sessions searched than matched', async () => {
    // A recall block is a *conversation* — parent plus its subagents — and the
    // shortlist reads sessions, so counting blocks against sessions printed
    // "6 of 5 sessions read" on the synthetic corpus. Both numbers come out of
    // one expansion now, and this is the invariant that says so.
    const { root, db } = seedDb();
    const readerFn: AskReaderFn = async () => ({ found: false, quotes: [], answer_fragment: '' });
    const r = await ask(db, 'pgbouncer prepared statements', { root, readerFn, openThreads: false });
    expect(r.searched).toBeLessThanOrEqual(r.matching);
    db.close();
  });

  it('nothing matched is an empty result, not a thrown error', async () => {
    const { root, db } = seedDb();
    const r = await ask(db, 'zzzzqqq nothing like this exists anywhere', { root, openThreads: false });
    expect(r.searched).toBe(0);
    expect(r.answer).toBe('');
    expect(r.spend.calls).toBe(0);
    db.close();
  });
});

// ================================================================ excerpts

describe('excerptUnits', () => {
  const transcript = (n: number): Transcript => ({
    id: 'x',
    kind: 'session',
    harness: 'claude',
    title: null,
    project: '/tmp/p',
    projectSlug: '-tmp-p',
    units: Array.from({ length: n }, (_, i) => unit(i, `body ${i} `.repeat(20))),
    chars: 0,
    isSidechain: false,
  });

  it('takes the hit and one neighbour on each side', () => {
    const got = excerptUnits(transcript(10), [5], { maxChars: 100_000 });
    expect(got.map((u) => u.seq)).toEqual([4, 5, 6]);
  });

  it('stays under the per-session cap', () => {
    const t = transcript(60);
    const got = excerptUnits(t, [10, 20, 30, 40]);
    const chars = got.reduce((n, u) => n + u.text.length, 0);
    expect(chars).toBeLessThanOrEqual(ASK_SESSION_CHARS);
    expect(got.length).toBeGreaterThan(0);
  });

  it('falls back to the opening when the session matched on its title alone', () => {
    const got = excerptUnits(transcript(10), []);
    expect(got.map((u) => u.seq)).toEqual([0, 1, 2]);
  });

  it('renders seq headers the reader can cite', () => {
    const text = excerptText(excerptUnits(transcript(4), [1], { maxChars: 100_000 }));
    expect(text).toContain('[seq 1');
    expect(text).toContain('[seq 2');
  });
});

// ================================================================ renderer

function resultFrom(
  out: ReturnType<typeof filterAnswer>,
  extra: { question: string; searched: number; matching: number },
) {
  return {
    question: extra.question,
    answer: out.sentences.map((s) => s.text).join(' '),
    sentences: out.sentences,
    dropped: out.dropped,
    evidence: out.evidence,
    openThreads: [],
    searched: extra.searched,
    matching: extra.matching,
    readers: [],
    refused: false,
    refusal: null,
    strict: false,
    spend: { calls: 2, inputTokens: 100, outputTokens: 40, usd: 0.021, ms: 900, estimatedInputCalls: 2 },
    estimated: true,
    ms: 12_400,
  };
}

describe('renderAsk', () => {
  const out = filterAnswer(
    [
      { text: 'The client cache was set to zero rather than changing the pooler mode.', cites: [1] },
      { text: 'The queue was left alone that week.', cites: [2] },
    ],
    [
      { index: 1, sessionId: POOLER, seq: 12, quote: REAL_QUOTE },
      { index: 2, sessionId: NOTES, seq: 3, quote: 'we left the queue alone this week' },
    ],
    sources(),
  );
  const r = resultFrom(out, { question: 'how did we handle pgbouncer?', searched: 6, matching: 41 });
  const text = (opts: { width?: number; ascii?: boolean } = {}) =>
    stripAnsi(
      renderAsk(
        r,
        new Theme({ color: false, width: opts.width ?? 80, ascii: opts.ascii ?? false }),
        new Date('2026-08-21T00:00:00Z'),
      ),
    );

  it('prints ANSWER, EVIDENCE and the next verb', () => {
    const t = text();
    expect(t).toContain('ANSWER');
    expect(t).toContain('EVIDENCE');
    expect(t).toMatch(/next\s+potsherd graft /);
  });

  it('carries a session id and a timestamp on every evidence line', () => {
    for (const line of text().split('\n').filter((l) => /^\s*\[\d+\]/.test(l))) {
      expect(line).toMatch(/\/[a-z0-9-]{3,}/);
      expect(line).toMatch(/\d{1,2} \w{3}/);
    }
  });

  it('prints the k-cap sentence the phase plan specifies', () => {
    expect(text()).toContain('searched 6 of 41 matching sessions; raise --k to widen');
  });

  it('fits 80x24 and never wraps past the width, at 80 and at 60', () => {
    for (const width of [80, 60]) {
      const lines = text({ width }).split('\n');
      expect(lines.length).toBeLessThanOrEqual(24);
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(width);
    }
  });

  it('has no emoji and no ascii art', () => {
    expect(text()).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('--ascii leaves nothing non-ascii behind', () => {
    // eslint-disable-next-line no-control-regex
    expect(new Theme({ ascii: true }).asciiLine(text({ ascii: true }))).not.toMatch(/[^\x00-\x7F]/);
  });

  it('never prints a dropped sentence, only its count', () => {
    const dropped = filterAnswer(
      [
        { text: 'Kept because it cites something real.', cites: [1] },
        { text: 'THE SECRET INVENTED CLAIM.', cites: [2] },
      ],
      [
        { index: 1, sessionId: POOLER, seq: 12, quote: REAL_QUOTE },
        { index: 2, sessionId: POOLER, seq: 12, quote: 'nothing like this was ever written' },
      ],
      sources(),
    );
    const view = stripAnsi(
      renderAsk(
        resultFrom(dropped, { question: 'q', searched: 1, matching: 1 }),
        new Theme({ color: false, width: 80 }),
      ),
    );
    expect(view).not.toContain('THE SECRET INVENTED CLAIM');
    expect(view).toContain('1 sentence dropped');
  });

  it('labels the cost est. when the spend was estimated', () => {
    expect(text()).toContain('est.');
  });
});

describe('a refusal says why', () => {
  const base = {
    question: 'q',
    answer: '',
    sentences: [],
    dropped: [],
    evidence: [],
    openThreads: [],
    searched: 6,
    matching: 41,
    readers: [
      { sessionId: POOLER, id8: 'sess-poo', found: true, quotes: 2, ms: 30_000 },
      { sessionId: NOTES, id8: 'sess-not', found: true, quotes: 1, ms: 28_000 },
    ],
    refused: true,
    strict: false,
    spend: { calls: 6, inputTokens: 900, outputTokens: 400, usd: 0.123, ms: 90_000, estimatedInputCalls: 6 },
    estimated: true,
    ms: 92_000,
  };
  const view = (refusal: string, strict = false) =>
    stripAnsi(
      renderAsk(
        { ...base, refusal, strict } as unknown as Parameters<typeof renderAsk>[0],
        new Theme({ color: false, width: 80 }),
      ),
    );

  it('a cost abort says it stopped on cost, and does not blame the citations', () => {
    const t = view('budget');
    expect(t).toContain('stopped at the cost ceiling');
    expect(t).toContain('$0.123 est.');
    expect(t).toContain('raise --max-usd');
    // The sentence the first version printed here, which was not true.
    expect(t).not.toContain('survived the citation check');
  });

  it('a strict refusal blames the citations, because that is what happened', () => {
    const t = view('strict', true);
    expect(t).toContain('fewer than 2 quotes survived the citation check');
    expect(t).not.toContain('cost ceiling');
  });

  it('a shortlist nothing answered says so', () => {
    expect(view('no-answer', true)).toContain('no session read addressed the question');
  });

  it("every refusal path still prints the plan's sentence", () => {
    for (const r of ['budget', 'strict', 'no-answer', 'no-match']) {
      expect(view(r)).toContain('no grounded answer in 6 sessions searched');
    }
  });
});

// ------------------------------------------------------- mask-safe clipping

describe('clipQuote', () => {
  const MASK = '‹redacted:aws:9f2b1c04›';

  it('truncates at ~90 characters with an ellipsis', () => {
    const long = 'x'.repeat(400);
    const got = clipQuote(long, QUOTE_CHARS, new Theme({ ascii: false }));
    expect(got.length).toBe(QUOTE_CHARS);
    expect(got.endsWith('…')).toBe(true);
  });

  it('never cuts a redaction mask in half', () => {
    // Place the mask so the naive cut lands inside it.
    const head = 'the deploy failed because the key ';
    const s = head + MASK + ' was rotated overnight and nobody told the pooler';
    const cut = head.length + 8;
    const got = clipQuote(s, cut, '…');
    expect(got).not.toContain('‹redacted:aws:9f2b');
    expect(got.includes('‹')).toBe(false);
  });

  it('keeps a mask whole when it fits', () => {
    const s = `key ${MASK} rotated`;
    expect(clipQuote(s, 200, '…')).toContain(MASK);
  });

  it('never cuts an elision marker in half either', () => {
    const marker = '‹elided:image/png:109362 bytes›';
    const s = `here is the screenshot ${marker} and then the error`;
    const got = clipQuote(s, 30, '…');
    expect(got).not.toContain('‹elided:image');
  });

  it('maskSafeCut pulls the boundary back to the start of the span', () => {
    const s = `abc${MASK}def`;
    expect(maskSafeCut(s, 3)).toBe(3);
    expect(maskSafeCut(s, 6)).toBe(3);
    expect(maskSafeCut(s, 3 + MASK.length)).toBe(3 + MASK.length);
    expect(maskSafeCut(s, 100)).toBe(100);
  });
});

// ------------------------------------------------------------------ knobs

describe('the numbers this verb is built to', () => {
  it('matches the plan', () => {
    expect(ASK_K).toBe(6);
    // Raised 0.10 -> 0.50 on measurement: five real k=6 runs cost $0.037-$0.123
    // api-equivalent, so 0.10 aborted correct runs before the synthesizer.
    // See 04-DECISIONS.md, 21 aug 2026.
    expect(ASK_MAX_USD).toBe(0.5);
    expect(ANSWER_MAX_WORDS).toBe(150);
    expect(STRICT_MIN_EVIDENCE).toBe(2);
    expect(QUOTE_CHARS).toBe(90);
  });

  it('the reader contract is the plan\'s, verbatim', async () => {
    const { READER_SYSTEM } = await import('../packages/core/src/ask.js');
    expect(READER_SYSTEM.toLowerCase()).toContain(
      "you are given one session's excerpts with seq numbers",
    );
    expect(READER_SYSTEM).toContain('{found: bool, quotes:[{seq, ts, text}], answer_fragment}');
    expect(READER_SYSTEM.toLowerCase()).toContain('found=false and nothing else');
  });

  it('a ghost reader is told the assistant side is gone', async () => {
    const { READER_GHOST_NOTE } = await import('../packages/core/src/ask.js');
    expect(READER_GHOST_NOTE).toMatch(/not recoverable/i);
    expect(READER_GHOST_NOTE).toMatch(/may not say, or imply, what was answered/i);
  });
});

// ------------------------------------------------------------ housekeeping

describe('the module writes nothing', () => {
  it('leaves no files behind a run', async () => {
    const { root, db } = seedDb();
    const before = fs.readdirSync(root).sort();
    await ask(db, 'zzzz nothing', { root, openThreads: false });
    expect(fs.readdirSync(root).sort()).toEqual(before);
    expect(fs.existsSync(path.join(root, 'ask'))).toBe(false);
    db.close();
  });
});

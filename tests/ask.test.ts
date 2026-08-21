import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { db as store } from '@potsherd/core';
import {
  ANSWER_MAX_WORDS,
  trimToWordBudget,
  wordCount,
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
import {
  NO_MODEL_NOTE,
  OPEN_THREAD_LABEL,
  openThreadCandidates,
} from '../packages/core/src/open-threads.js';
import { Theme, stripAnsi } from '../packages/core/src/theme.js';
import { Llm, redactOutgoing, type Backend, type SendRequest, type SendResult, type Transport } from '../packages/core/src/llm.js';
import {
  READERS_FILE_KIND,
  READERS_FILE_VERSION,
  replayReaders,
  writeReadersFile,
} from '../packages/cli/src/commands/ask.js';
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
      project: 'Ledger',
      harness: 'claude',
      isSidechain: false,
      isGhost: false,
      units: [unit(11, 'user: earlier context about deploys'), unit(12, POOLER_TEXT)],
    },
    {
      sessionId: NOTES,
      id8: 'sess-not',
      project: 'brainstore',
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
        project: 'Ledger',
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
        project: 'Ledger',
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
      project: 'brainstore',
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

/**
 * The open-thread fixture, laid on top of {@link seedDb}.
 *
 * `ask()`'s own end-to-end tests all pass `openThreads: false`, so the whole
 * open-thread path — the model pass and what the caller does with its verdicts
 * — was reachable from `ask()` in production and from nothing in this file.
 * That is how `tryOpenThreads` came to return `confirmed` unfiltered while
 * `open-threads.ts` documented the opposite ("confirmed:false candidates are
 * dropped by the caller"), and how a real run printed
 *
 *     possible open thread · decided in alpha, not seen in beta
 *         no model was available to confirm this, so it is unconfirmed and
 *         not shown.
 *
 * — a note saying "not shown" while being shown — next to a candidate whose
 * note was *the model rejected this*. With T4.2's measurement that only 1–2 of
 * 8 candidates are worth raising, the unconfirmed path was showing roughly six
 * false threads for every real one, and the model pass was decorative.
 *
 * The fixture is the same shape as `tests/open-threads.test.ts`'s: two
 * projects that share a vocabulary and a file, a decision recorded in one, and
 * no matching decision in the other. Its cards and its sibling session are
 * written *after* `seedDb` publishes `exchanges_fts`, so the sibling's filler
 * exchanges stay out of the shortlist and `ask` still retrieves exactly the
 * one session the other tests here retrieve.
 */
const SIBLING_TOPICS = ['pgbouncer', 'prepared statements', 'connection pooling', 'postgres'];
const SIBLING_FILES = ['db/pool.ts', 'db/migrate.ts'];
const DECIDED_WHAT =
  'disable prepared statements when pgbouncer runs in transaction pooling mode';
const DECIDED_WHY = 'pgbouncer cannot route a prepared statement to the same backend twice';
const SIBLING_SESSION = '5a5a5a5a-1111-4111-8111-111111111111';

function withOpenThreadMaterial(db: ReturnType<typeof store.open>): void {
  const card = db.prepare(
    `INSERT INTO cards (session_id, title, summary, topics, decisions, files, outcome,
        open_threads, source)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  // A: the session `ask` answers from. Its decision cites seq 12, which is a
  // real exchange in `seedDb`, so the positive half of the claim is checkable.
  card.run(
    POOLER, 'the pooler', 'what happened',
    JSON.stringify(SIBLING_TOPICS),
    JSON.stringify([{ what: DECIDED_WHAT, why: DECIDED_WHY, evidence_seq: [12] }]),
    JSON.stringify(SIBLING_FILES), 'shipped', '[]', 'transcript',
  );

  // B: a sibling project, same files and topics, a different decision. This is
  // the project the decision was "never seen in".
  db.prepare(
    'INSERT INTO sessions (id, harness, project, started_at, status) VALUES (?,?,?,?,?)',
  ).run(SIBLING_SESSION, 'claude', '/tmp/Meghbrain', '2026-07-01T10:00:00.000Z', 'archived');
  db.prepare(
    'INSERT INTO exchanges (id, session_id, seq, ts, user_text, assistant_text) VALUES (?,?,?,?,?,?)',
  ).run(`${SIBLING_SESSION}#2`, SIBLING_SESSION, 2, '2026-07-01T12:00:00.000Z', 'q', 'a');
  card.run(
    SIBLING_SESSION, 'the importer', 'what happened',
    JSON.stringify(SIBLING_TOPICS),
    JSON.stringify([
      { what: 'move the nightly ingest onto a cron schedule', why: '', evidence_seq: [2] },
    ]),
    JSON.stringify(SIBLING_FILES), 'shipped', '[]', 'transcript',
  );
}

/** The synthesizer reply every open-thread test below reuses. */
const SYNTH_OK = synthReply(
  [{ text: 'The client cache was set to zero rather than changing the pooler mode.', cites: [1] }],
  [{ n: 1, session_id: POOLER, seq: 12, quote: REAL_QUOTE }],
);

/**
 * The open-thread path through `ask()`, which nothing exercised.
 *
 * Every case here is non-vacuous by construction: each one asserts that
 * `openThreadCandidates` on the same database raises at least one candidate
 * *before* looking at what `ask` did with it, so a fixture that quietly stopped
 * generating candidates fails loudly instead of passing empty.
 */
/**
 * The word budget, enforced in code.
 *
 * `ANSWER_MAX_WORDS` was prompt-only: `grep` found it at one line of the
 * synthesizer prompt and in a `toBe(150)` test, and nothing anywhere compared
 * an answer against it. A real run came back at **163 words** — a 17-line
 * ANSWER block and 40 lines in total, against `05`'s "compact enough to
 * screenshot whole" and its 80x24 box.
 *
 * Asking the model nicely is not how the citation rule works and it is not how
 * this one works either. `filterAnswer` drops whole trailing sentences, which
 * is the enforcement that does not create a second dishonesty: a sentence cut
 * mid-thought would carry a citation while saying something the evidence does
 * not support, whereas a whole sentence was checked on its own and can be
 * removed on its own.
 */
describe('the answer holds ANSWER_MAX_WORDS, in code', () => {
  it('pins the constant, and now something actually reads it', () => {
    // The test that already existed. It is kept because `plans/08` rule 3 says
    // a constant encoding a measured trade-off needs a test that fails when it
    // moves — but on its own it constrained nothing about any answer.
    expect(ANSWER_MAX_WORDS).toBe(150);
  });

  const sentence = (words: number, tag: string): string =>
    `${tag} ` + Array.from({ length: words - 2 }, (_, i) => `w${i}`).join(' ') + ' end.';

  it('counts words the way a reader does', () => {
    expect(wordCount('')).toBe(0);
    expect(wordCount('   ')).toBe(0);
    expect(wordCount('one')).toBe(1);
    expect(wordCount('  two  words \n here ')).toBe(3);
    expect(wordCount(sentence(40, 'a'))).toBe(40);
  });

  it('drops whole trailing sentences rather than cutting one in half', () => {
    const input = [
      { text: sentence(80, 'first'), cites: [1] },
      { text: sentence(60, 'second'), cites: [2] },
      { text: sentence(50, 'third'), cites: [3] },
    ];
    const { kept, trimmed } = trimToWordBudget(input, ANSWER_MAX_WORDS);

    expect(kept).toHaveLength(2);
    expect(trimmed).toEqual([input[2]!.text]);
    // Every kept sentence is byte-identical to what went in. Nothing was cut,
    // shortened, re-wrapped or ellipsised — the whole point of the choice.
    expect(kept.map((k) => k.text)).toEqual([input[0]!.text, input[1]!.text]);
    expect(wordCount(kept.map((k) => k.text).join(' '))).toBeLessThanOrEqual(ANSWER_MAX_WORDS);
  });

  it('takes the whole tail once the budget is spent, not just the long bits', () => {
    const input = [
      { text: sentence(140, 'first'), cites: [1] },
      { text: sentence(40, 'second'), cites: [2] },
      { text: sentence(4, 'third'), cites: [3] }, // would have fitted
    ];
    const { kept, trimmed } = trimToWordBudget(input, ANSWER_MAX_WORDS);
    expect(kept).toHaveLength(1);
    // A four-word recap printed straight after the sentence that was supposed
    // to set it up is a non-sequitur, so it goes with the rest of the tail.
    expect(trimmed).toEqual([input[1]!.text, input[2]!.text]);
  });

  it('keeps a single over-long sentence rather than printing nothing', () => {
    const one = [{ text: sentence(400, 'only'), cites: [1] }];
    const { kept, trimmed } = trimToWordBudget(one, ANSWER_MAX_WORDS);
    // An empty ANSWER block is a silent refusal, and `05` has a loud one.
    expect(kept).toEqual(one);
    expect(trimmed).toEqual([]);
  });

  it('is a no-op on an answer that already fits', () => {
    const input = [
      { text: sentence(20, 'a'), cites: [1] },
      { text: sentence(20, 'b'), cites: [2] },
    ];
    const { kept, trimmed } = trimToWordBudget(input, ANSWER_MAX_WORDS);
    expect(kept).toEqual(input);
    expect(trimmed).toEqual([]);
  });

  it('enforces it inside filterAnswer, and takes the orphaned evidence with it', () => {
    // Three real, resolving citations. Nothing here fails the citation check;
    // the only thing that can remove a sentence is the budget.
    const long = (n: number, tag: string): string => sentence(n, tag);
    const out = filterAnswer(
      [
        { text: long(80, 'first'), cites: [1] },
        { text: long(60, 'second'), cites: [2] },
        { text: long(50, 'third'), cites: [3] },
      ],
      [
        { index: 1, sessionId: POOLER, seq: 12, quote: REAL_QUOTE },
        { index: 2, sessionId: NOTES, seq: 3, quote: 'we left the queue alone this week' },
        { index: 3, sessionId: POOLER, seq: 12, quote: REAL_QUOTE.slice(0, 40) },
      ],
      sources(),
    );

    // Nothing failed the citation check.
    expect(out.dropped).toEqual([]);
    expect(out.trimmed).toHaveLength(1);
    expect(out.sentences).toHaveLength(2);
    expect(wordCount(out.sentences.map((x) => x.text).join(' '))).toBeLessThanOrEqual(
      ANSWER_MAX_WORDS,
    );

    // The receipt shrinks with the answer. Evidence [3] was cited only by the
    // trimmed sentence, so it falls out through the `uncited` path — leaving
    // it in would print a quote for a claim that is no longer on the screen.
    expect(out.evidence).toHaveLength(2);
    expect(out.evidence.map((e) => e.index)).toEqual([1, 2]);
    expect(out.drops.filter((d) => d.reason === 'over-budget')).toHaveLength(1);
    expect(out.drops.some((d) => d.reason === 'uncited')).toBe(true);
  });

  it('holds the cap end to end, through ask()', async () => {
    const { root, db } = seedDb();
    const readerLlm = Llm.open({
      transport: new Scripted('agent-sdk', [READER_OK]),
      model: 'haiku',
    });
    // A synthesizer that ignores the prompt's word ceiling, which is the whole
    // reason the ceiling cannot live in the prompt.
    const llm = Llm.open({
      transport: new Scripted('agent-sdk', [
        synthReply(
          [
            { text: sentence(90, 'first'), cites: [1] },
            { text: sentence(90, 'second'), cites: [1] },
            { text: sentence(90, 'third'), cites: [1] },
          ],
          [{ n: 1, session_id: POOLER, seq: 12, quote: REAL_QUOTE }],
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

    // 270 words in; the cap holds.
    expect(wordCount(r.answer)).toBeLessThanOrEqual(ANSWER_MAX_WORDS);
    expect(r.sentences).toHaveLength(1);
    expect(r.trimmed).toHaveLength(2);
    // `answer` is still exactly the kept sentences joined — the invariant the
    // rest of this file rests on is not weakened by the cap.
    expect(r.answer).toBe(r.sentences.map((x) => x.text).join(' '));
    // And a trimmed sentence is not a dropped one: they are different events.
    expect(r.dropped).toEqual([]);

    // The screen says the answer was held, rather than stopping silently.
    const text = stripAnsi(renderAsk(r, new Theme({ color: false, width: 80 }), new Date()));
    expect(text).toContain('2 sentences trimmed');
    expect(text).toContain('answer held to 150 words');

    db.close();
    await llm.close();
    await readerLlm.close();
  });

  it('keeps the whole run inside 80x24, which is what the cap is for', async () => {
    const { root, db } = seedDb();
    const readerLlm = Llm.open({
      transport: new Scripted('agent-sdk', [READER_OK]),
      model: 'haiku',
    });
    const llm = Llm.open({
      transport: new Scripted('agent-sdk', [
        synthReply(
          [
            { text: sentence(90, 'first'), cites: [1] },
            { text: sentence(90, 'second'), cites: [1] },
            { text: sentence(90, 'third'), cites: [1] },
          ],
          [{ n: 1, session_id: POOLER, seq: 12, quote: REAL_QUOTE }],
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
    const lines = stripAnsi(
      renderAsk(r, new Theme({ color: false, width: 80 }), new Date()),
    ).split('\n');
    // `05` §4: "output is compact enough to screenshot whole". 24 is the box.
    expect(lines.length).toBeLessThanOrEqual(24);
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(80);

    db.close();
    await llm.close();
    await readerLlm.close();
  });
});

describe('ask() open threads', () => {
  const QUESTION = 'how did we handle pgbouncer with prepared statements?';

  /** `ask()` with the open-thread pass on, and `confirmReply` scripted for it. */
  async function askWithThreads(confirmReply: string | Error) {
    const { root, db } = seedDb();
    withOpenThreadMaterial(db);

    // The fixture has to be capable of producing a thread, or nothing below
    // means anything. This is the guard against a vacuous pass.
    const candidates = openThreadCandidates(db, [POOLER]);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.what).toBe(DECIDED_WHAT);

    const readerLlm = Llm.open({
      transport: new Scripted('agent-sdk', [READER_OK]),
      model: 'haiku',
    });
    // One transport, two calls: the synthesizer first, then the open-thread
    // confirmation — `ask` hands its own synth llm to `tryOpenThreads`.
    const llm = Llm.open({
      transport: new Scripted('agent-sdk', [SYNTH_OK, confirmReply]),
      model: 'sonnet',
    });
    const r = await ask(db, QUESTION, { root, llm, readerLlm, openThreads: true });
    // The sibling session is not in the shortlist, so the answer half of the
    // run is the same one the tests above make.
    expect(r.searched).toBe(1);
    expect(r.refused).toBe(false);
    db.close();
    await llm.close();
    await readerLlm.close();
    return { r, candidates };
  }

  const verdicts = (results: { i: number; confirmed: boolean; note: string }[]): string =>
    JSON.stringify({ results });

  it('shows nothing when the model returns no verdict for any candidate', async () => {
    const { r, candidates } = await askWithThreads(verdicts([]));

    // The bug: before the fix this was `candidates.length`, every one of them
    // carrying `confirmed: false`.
    expect(r.openThreads).toEqual([]);
    expect(candidates.length).toBeGreaterThan(0);

    // And nothing reaches the screen, which is where a reader would have met it.
    const text = stripAnsi(renderAsk(r, new Theme({ color: false, width: 80 }), new Date()));
    expect(text).not.toContain(OPEN_THREAD_LABEL);
    expect(text).not.toContain(DECIDED_WHAT);
  });

  it('shows nothing when the model rejects the candidate outright', async () => {
    const { r } = await askWithThreads(
      verdicts([
        { i: 0, confirmed: false, note: 'brainstore already handles the pooler in its own config.' },
      ]),
    );

    // A candidate the model *rejected*, printed anyway, is what made the whole
    // model pass decorative. The screen is asserted before the array because
    // the screen is where a reader met it: `render/ask.ts` prints every element
    // of `openThreads` and has never looked at `confirmed`, by design — the
    // drop is the caller's job and this is the test that says so.
    const text = stripAnsi(renderAsk(r, new Theme({ color: false, width: 80 }), new Date()));
    expect(text).not.toContain('already handles the pooler');
    expect(text).not.toContain(OPEN_THREAD_LABEL);
    expect(r.openThreads).toEqual([]);
  });

  it('never prints the note that says it is not being shown', async () => {
    // The line that gave the bug away: `NO_MODEL_NOTE` reads "…so it is
    // unconfirmed and not shown", and a build that renders that sentence is
    // contradicting itself in the user's own terminal.
    expect(NO_MODEL_NOTE).toContain('not shown');

    // The confirmation call fails outright, which is the reachable form of
    // "nothing could be confirmed" when a model *is* configured: every
    // candidate comes back unconfirmed, carrying a note that says so.
    const { r, candidates } = await askWithThreads(new Error('the backend went away'));
    expect(candidates.length).toBeGreaterThan(0);

    const text = stripAnsi(renderAsk(r, new Theme({ color: false, width: 80 }), new Date()));
    expect(text).not.toContain('not shown');
    expect(text).not.toContain('unconfirmed');
    expect(text).not.toContain(OPEN_THREAD_LABEL);
    expect(r.openThreads).toEqual([]);
  });

  it('shows the confirmed thread, and only it', async () => {
    const { r, candidates } = await askWithThreads(
      verdicts([{ i: 0, confirmed: true, note: 'brainstore still opens raw connections here.' }]),
    );

    expect(r.openThreads).toHaveLength(1);
    const t = r.openThreads[0]!;
    expect(t.confirmed).toBe(true);
    expect(t.what).toBe(DECIDED_WHAT);
    expect(t.project).toBe('/tmp/Ledger');
    expect(t.otherProject).toBe('/tmp/Meghbrain');
    // Cited or dropped applies here too: the positive half points at a real
    // exchange of the session `ask` answered from.
    expect(t.evidenceSeqs).toEqual([12]);
    expect(t.sessionId).toBe(POOLER);
    // Every field except `confirmed` and `note` is the rule pass's own.
    expect(t.what).toBe(candidates[0]!.what);
    expect(t.why).toBe(candidates[0]!.why);

    const text = stripAnsi(renderAsk(r, new Theme({ color: false, width: 80 }), new Date()));
    expect(text).toContain(OPEN_THREAD_LABEL);
    expect(text).toContain('brainstore still opens raw connections here.');
  });

  it('keeps the confirmed one and drops the rejected one from the same batch', async () => {
    // Two candidates in one confirmation call, one verdict each. This is the
    // case the filter has to get right per-item rather than all-or-nothing.
    const { root, db } = seedDb();
    withOpenThreadMaterial(db);
    // A second decision in A, same shape, so the batch carries two.
    const second = 'pin the pooler pool_size to twelve for the importer workers';
    db.prepare('UPDATE cards SET decisions = ? WHERE session_id = ?').run(
      JSON.stringify([
        { what: DECIDED_WHAT, why: DECIDED_WHY, evidence_seq: [12] },
        { what: second, why: 'twelve workers, one connection each', evidence_seq: [11] },
      ]),
      POOLER,
    );

    const candidates = openThreadCandidates(db, [POOLER]);
    expect(candidates).toHaveLength(2);
    const rejected = candidates.findIndex((c) => c.what === second);
    expect(rejected).toBeGreaterThanOrEqual(0);
    const kept = 1 - rejected;

    const readerLlm = Llm.open({
      transport: new Scripted('agent-sdk', [READER_OK]),
      model: 'haiku',
    });
    const llm = Llm.open({
      transport: new Scripted('agent-sdk', [
        SYNTH_OK,
        verdicts([
          { i: kept, confirmed: true, note: 'brainstore still opens raw connections here.' },
          { i: rejected, confirmed: false, note: 'brainstore sets pool_size in its own compose file.' },
        ]),
      ]),
      model: 'sonnet',
    });
    const r = await ask(db, QUESTION, { root, llm, readerLlm, openThreads: true });

    expect(r.openThreads).toHaveLength(1);
    expect(r.openThreads[0]!.what).toBe(candidates[kept]!.what);
    expect(r.openThreads.map((t) => t.what)).not.toContain(second);

    const text = stripAnsi(renderAsk(r, new Theme({ color: false, width: 80 }), new Date()));
    expect(text).not.toContain('own compose file');

    db.close();
    await llm.close();
    await readerLlm.close();
  });
});

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
    expect(r.evidence[0]!.project).toBe('Ledger');
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
    trimmed: out.trimmed,
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

describe('an open thread is checkable in the terminal, not only in --json', () => {
  // The rule pass drops any decision whose evidence_seq does not resolve, so
  // by construction every open thread that reaches the renderer has one. The
  // renderer used to print `<project>/<id8>  <date>` and no seq, which left
  // the one claim potsherd makes about an *absence* as the one claim a reader
  // could not go and check. This fails if the seq stops being printed.
  const thread = {
    what: 'transaction pooling was chosen over session pooling',
    why: 'prepared statements were breaking',
    sessionId: POOLER,
    id8: POOLER.slice(0, 8),
    project: '/Users/dev/api',
    ts: '2026-08-01T14:30:00Z',
    evidenceSeqs: [12, 19] as readonly number[],
    otherProject: '/Users/dev/web',
    otherSessionIds: [],
    overlap: { files: [] as readonly string[], topics: ['pooling'] as readonly string[] },
    score: 2.1,
    confirmed: true,
    note: 'the pooler decision never reached web',
  };

  it('prints the seq the claim rests on, and labels the claim advisory', () => {
    // renderAsk returns early when no sentence survived the filter, which is
    // right — open threads are context attached to an answer, not an answer.
    // So this needs a real grounded answer to reach the OPEN THREADS block.
    const base = filterAnswer(
      [{ text: 'The client cache was set to zero rather than changing the pooler mode.', cites: [1] }],
      [{ index: 1, sessionId: POOLER, seq: 12, quote: REAL_QUOTE }],
      sources(),
    );
    expect(base.sentences.length).toBe(1);
    const r = {
      ...resultFrom(base, { question: 'the pooler decision', searched: 2, matching: 2 }),
      openThreads: [thread],
    };
    const text = stripAnsi(
      renderAsk(r, new Theme({ color: false, width: 80 }), new Date('2026-08-21T00:00:00Z')),
    );
    expect(text).toContain('@12,19');
    // Both halves of "decided in A, not seen in B" must survive the width.
    // Rendering raw absolute project paths tail-truncated B off the end, which
    // deletes the half of the claim that carries the finding.
    expect(text).toContain('not seen in web');
    expect(text).not.toContain('/Users/');
    expect(text).toContain(OPEN_THREAD_LABEL);
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(80);
  });
});

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
    trimmed: [],
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

// ================================================== T5.6 — the reader file
//
// `--readers-out` and `--readers-in` are the file-shaped form of T4.4's
// `readerFn`: the seam a *program* uses, made usable by something that is not
// a program. The tests below are about the two claims that make them worth
// having — the recording costs nothing, and the replay is the same run.

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

/** `AKIA` + 16, which `redact-rules.ts` masks as the `aws` family. */
const FAKE_KEY = 'AKIAIOSFODNN7EXAMPLE';

describe('T5.6 --readers-out', () => {
  function outFile(): string {
    return path.join(scratch('potsherd-readers-'), 'nested', 'readers.json');
  }

  it('makes zero model calls, against a transport that throws if it is called', async () => {
    const { root, db } = seedDb();
    const transport = new Throwing();
    // Both handles, so neither a reader backend nor a synthesizer backend can
    // be reached without the test noticing.
    const llm = Llm.open({ transport, model: 'sonnet' });
    const readerLlm = Llm.open({ transport, model: 'haiku' });
    const target = outFile();

    const { file, probe, abs } = await writeReadersFile(
      db,
      'how did we handle pgbouncer with prepared statements?',
      { root, llm, readerLlm },
      target,
    );

    // Not "we skipped them" — there was no expression on this path that could
    // have constructed a backend. `ask.ts:1047` opens no reader when a
    // `readerFn` is supplied, and `ask.ts:1104` returns before `ask.ts:1116`,
    // the only line that opens the synthesizer's.
    expect(transport.sent).toHaveLength(0);
    expect(probe.spend.calls).toBe(0);
    expect(probe.spend.usd).toBe(0);
    expect(probe.answer).toBe('');
    // and it still did the expensive-to-reproduce half: the shortlist.
    expect(file.targets).toHaveLength(1);
    expect(file.sessionIds).toEqual([POOLER]);
    expect(fs.existsSync(abs)).toBe(true);
    db.close();
    await llm.close();
    await readerLlm.close();
  });

  it('writes a versioned envelope carrying the question, k and the session ids', async () => {
    const { root, db } = seedDb();
    const target = outFile();
    await writeReadersFile(db, 'pgbouncer prepared statements', { root, k: 4 }, target);

    const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>;
    expect(parsed['kind']).toBe(READERS_FILE_KIND);
    expect(parsed['version']).toBe(READERS_FILE_VERSION);
    expect(parsed['question']).toBe('pgbouncer prepared statements');
    expect(parsed['k']).toBe(4);
    expect(parsed['sessionIds']).toEqual([POOLER]);
    expect(typeof parsed['potsherd']).toBe('string');
    // The three mismatch detectors are the point of the envelope; a file
    // without them is replayable against anything.
    for (const field of ['question', 'k', 'sessionIds']) expect(parsed[field]).toBeDefined();
    db.close();
  });

  it('records AskReaderInput verbatim — the object T4.4 documents, not a summary of it', async () => {
    const { root, db } = seedDb();
    const target = outFile();
    const { file } = await writeReadersFile(db, 'pgbouncer prepared statements', { root }, target);

    const t0 = file.targets[0]!;
    expect(t0.sessionId).toBe(POOLER);
    expect(t0.id8).toBe(POOLER.slice(0, 8));
    expect(t0.project).toBe('Ledger');
    expect(t0.harness).toBe('claude');
    expect(t0.isGhost).toBe(false);
    expect(t0.isSidechain).toBe(false);
    expect(t0.seqs).toContain(12);
    expect(t0.excerpts).toContain('[seq 12');
    expect(t0.excerpts).toContain('statement_cache_size=0');
    // A reader given this file needs nothing else to do its job.
    expect(t0.question).toBe('pgbouncer prepared statements');
    db.close();
  });

  it('the excerpts it writes are already redacted — `redactOutgoing` finds nothing left to mask', async () => {
    const { root, db } = seedDb();
    const target = outFile();
    const { file } = await writeReadersFile(db, 'pgbouncer prepared statements', { root }, target);

    // This is the whole redaction question for these two flags, asserted
    // rather than asserted about. Redaction is L2: it runs at ingest, before
    // anything is written to the index, so what `readerFn` is handed is
    // already masked. `llm.ts`'s own outgoing pass is "identical to the ingest
    // path, deliberately", and this is that sentence as a test — the file
    // holds exactly the bytes a model would have been sent, no more.
    for (const t of file.targets) {
      const again = redactOutgoing(t.excerpts);
      expect(again.hits).toBe(0);
      expect(again.text).toBe(t.excerpts);
    }
    db.close();
  });

  it('a secret that reached the store anyway does not reach the file', async () => {
    // Seeded straight into the index, past ingest's redaction, which is the
    // only way this text can exist there. The flag writes to a path the user
    // names, so it re-runs the outgoing pass rather than trusting the store:
    // a file the user can `cat` must not be the one copy of a credential.
    const root = scratch();
    const db = store.open({ root });
    db.prepare(
      `INSERT INTO sessions (id, harness, title, project, project_slug, source_path, status,
          is_sidechain, started_at, ended_at, user_prompts, assistant_turns, bytes, indexed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(POOLER, 'claude', 'the pooler', '/tmp/Ledger', '-tmp-Ledger', '/tmp/x.jsonl', 'live', 0,
      '2026-08-04T09:00:00.000Z', '2026-08-04T10:00:00.000Z', 2, 2, 100, '2026-08-05T00:00:00.000Z');
    db.prepare(
      `INSERT INTO exchanges (id, session_id, seq, ts, user_text, assistant_text, files_touched)
       VALUES (?,?,?,?,?,?,?)`,
    ).run('u12', POOLER, 12, '2026-08-04T09:05:00.000Z', 'the pooler is 500ing on deploy',
      `deploy with AWS_ACCESS_KEY_ID=${FAKE_KEY} and pgbouncer prepared statements off`, '[]');
    db.exec("INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild')");

    const target = outFile();
    await writeReadersFile(db, 'pgbouncer prepared statements', { root }, target);
    const raw = fs.readFileSync(target, 'utf8');
    expect(raw).not.toContain(FAKE_KEY);
    expect(raw).toContain('redacted:aws:');
    db.close();
  });

  it('the same question over the same index writes the same bytes twice', async () => {
    const { root, db } = seedDb();
    const a = outFile();
    const b = outFile();
    await writeReadersFile(db, 'pgbouncer prepared statements', { root }, a);
    await writeReadersFile(db, 'pgbouncer prepared statements', { root }, b);
    // `concurrency: 1` on the recording pass buys this: the recording order is
    // the shortlist order, so a diff of two recordings is a diff of the index.
    expect(fs.readFileSync(a, 'utf8')).toBe(fs.readFileSync(b, 'utf8'));
    db.close();
  });

  it('creates the directory it was pointed at, and ends the file with a newline', async () => {
    const { root, db } = seedDb();
    const target = outFile();
    expect(fs.existsSync(path.dirname(target))).toBe(false);
    await writeReadersFile(db, 'pgbouncer prepared statements', { root }, target);
    expect(fs.readFileSync(target, 'utf8').endsWith('}\n')).toBe(true);
    db.close();
  });
});

describe('T5.6 --readers-in', () => {
  const QUESTION = 'how did we handle pgbouncer with prepared statements?';
  /** What the SDK reader returns for `seedDb`'s one session, as a recording. */
  const RECORDED = { sessionId: POOLER, ...(JSON.parse(READER_OK) as AskReaderOutput) };
  const SYNTH = synthReply(
    [{ text: 'The client cache was set to zero rather than changing the pooler mode.', cites: [1] }],
    [{ n: 1, session_id: POOLER, seq: 12, quote: REAL_QUOTE }],
  );

  function outFile(): string {
    return path.join(scratch('potsherd-readers-'), 'readers.json');
  }

  /** Record, then write `outputs` back into the same file, as a skill would. */
  async function recordWithOutputs(
    db: ReturnType<typeof store.open>,
    root: string,
    question: string,
    outputs: unknown[],
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const target = outFile();
    await writeReadersFile(db, question, { root }, target);
    const file = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(target, JSON.stringify({ ...file, outputs, ...extra }, null, 2), 'utf8');
    return target;
  }

  /** Everything an answer is made of. `ms` is a clock and `spend` is the point. */
  function answerShape(r: AskResult): unknown {
    return {
      ...r,
      ms: 0,
      spend: null,
      readers: r.readers.map((x) => ({ ...x, ms: 0 })),
    };
  }

  it('produces the same AskResult as a normal run, and one fewer model call', async () => {
    const { root, db } = seedDb();

    // --- the normal run: SDK readers, then the synthesizer.
    const readerLlm = Llm.open({ transport: new Scripted('agent-sdk', [READER_OK]), model: 'haiku' });
    const normalSynth = new Scripted('agent-sdk', [SYNTH]);
    const normalLlm = Llm.open({ transport: normalSynth, model: 'sonnet' });
    const normal = await ask(db, QUESTION, { root, llm: normalLlm, readerLlm, openThreads: false });

    // --- the replay: the same reader outputs, handed back through a file.
    const target = await recordWithOutputs(db, root, QUESTION, [RECORDED]);
    const replaySynth = new Scripted('agent-sdk', [SYNTH]);
    const replayLlm = Llm.open({ transport: replaySynth, model: 'sonnet' });
    const replayed = await replayReaders(db, QUESTION, { root, llm: replayLlm, openThreads: false }, target);

    // Identical, field for field, including the evidence, the numbering, the
    // dropped list, `searched`, `matching` and the reader reports. Nothing
    // downstream of the readers knows which path it was on.
    expect(JSON.stringify(answerShape(replayed))).toBe(JSON.stringify(answerShape(normal)));
    expect(replayed.answer).toBe(normal.answer);
    expect(replayed.evidence).toEqual(normal.evidence);

    // The two fields that must differ, and why the flag exists: the readers
    // are gone, so the run is one call instead of two.
    expect(normal.spend.calls).toBe(2);
    expect(replayed.spend.calls).toBe(1);
    expect(replaySynth.sent).toHaveLength(1);

    db.close();
    await readerLlm.close();
    await normalLlm.close();
    await replayLlm.close();
  });

  it('runs filterAnswer on the replayed quotes — a fabricated one is still dropped', async () => {
    const { root, db } = seedDb();
    // A recording whose reader "quoted" something nobody wrote. This is the
    // guarantee a SKILL.md cannot reproduce, running on the skill's own
    // reader output.
    const target = await recordWithOutputs(db, root, QUESTION, [
      {
        sessionId: POOLER,
        found: true,
        quotes: [{ seq: 12, ts: null, text: 'we moved the pooler to session mode' }],
        answer_fragment: 'session mode',
      },
    ]);
    const drops: AskDrop[] = [];
    const llm = Llm.open({
      transport: new Scripted('agent-sdk', [
        synthReply(
          [{ text: 'The pooler was moved to session mode.', cites: [1] }],
          [{ n: 1, session_id: POOLER, seq: 12, quote: 'we moved the pooler to session mode' }],
        ),
      ]),
      model: 'sonnet',
    });
    const r = await replayReaders(
      db,
      QUESTION,
      { root, llm, openThreads: false, onDrop: (d) => drops.push(d) },
      target,
    );
    expect(r.evidence).toHaveLength(0);
    expect(r.answer).toBe('');
    expect(r.dropped).toEqual(['The pooler was moved to session mode.']);
    expect(drops.map((d) => d.reason)).toContain('not-a-quote');
    db.close();
    await llm.close();
  });

  it('--strict still refuses on a replay', async () => {
    const { root, db } = seedDb();
    const target = await recordWithOutputs(db, root, QUESTION, [RECORDED]);
    const llm = Llm.open({ transport: new Scripted('agent-sdk', [SYNTH]), model: 'sonnet' });
    const r = await replayReaders(db, QUESTION, { root, llm, strict: true, openThreads: false }, target);
    // One surviving evidence line, and STRICT_MIN_EVIDENCE is two.
    expect(r.refused).toBe(true);
    expect(r.answer).toBe('');
    db.close();
    await llm.close();
  });

  it('refuses a file recorded against a different question', async () => {
    const { root, db } = seedDb();
    const target = await recordWithOutputs(db, root, QUESTION, [RECORDED]);
    const transport = new Throwing();
    const llm = Llm.open({ transport, model: 'sonnet' });
    await expect(
      replayReaders(db, 'what did we decide about the queue?', { root, llm, openThreads: false }, target),
    ).rejects.toThrow(/recorded against a different question/);
    // And it refused before it spent anything. A stale-file check that runs
    // after the synthesizer has already been paid for is not a check.
    expect(transport.sent).toHaveLength(0);
    db.close();
    await llm.close();
  });

  it('refuses a file recorded at a different --k', async () => {
    const { root, db } = seedDb();
    const target = await recordWithOutputs(db, root, QUESTION, [RECORDED], { k: 3 });
    await expect(
      replayReaders(db, QUESTION, { root, k: 6, openThreads: false }, target),
    ).rejects.toThrow(/--k 3 and this run asked for --k 6/);
    db.close();
  });

  it('refuses a recording nobody has read yet', async () => {
    const { root, db } = seedDb();
    const target = outFile();
    await writeReadersFile(db, QUESTION, { root }, target);
    await expect(replayReaders(db, QUESTION, { root, openThreads: false }, target)).rejects.toThrow(
      /no "outputs"/,
    );
    db.close();
  });

  it('refuses a shortlist the file does not cover — a partial match is a failure, not an answer', async () => {
    const { root, db } = seedDb();
    // The file knows about a session the index no longer shortlists, and does
    // not know about the one it does. Answering from the overlap would print
    // the live shortlist's "n of m sessions read" over a file that covers
    // less than it, and `filterAnswer` cannot see a quote nobody produced.
    const target = await recordWithOutputs(db, root, QUESTION, [{ ...RECORDED, sessionId: 'sess-gone-0001' }], {
      sessionIds: ['sess-gone-0001'],
    });
    const transport = new Throwing();
    const llm = Llm.open({ transport, model: 'sonnet' });
    await expect(replayReaders(db, QUESTION, { root, llm, openThreads: false }, target)).rejects.toThrow(
      /does not match the shortlist this question produces now/,
    );
    expect(transport.sent).toHaveLength(0);
    db.close();
    await llm.close();
  });

  it('refuses an "outputs" array that misses a shortlisted session', async () => {
    const { root, db } = seedDb();
    const target = await recordWithOutputs(db, root, QUESTION, []);
    await expect(replayReaders(db, QUESTION, { root, openThreads: false }, target)).rejects.toThrow(
      /"outputs" does not match the shortlist/,
    );
    db.close();
  });

  it('refuses a file that is not one of ours, or is a version it cannot read', async () => {
    const { root, db } = seedDb();
    const alien = outFile();
    fs.writeFileSync(alien, JSON.stringify({ kind: 'something.else', version: 1 }), 'utf8');
    await expect(replayReaders(db, QUESTION, { root }, alien)).rejects.toThrow(/is not a reader file/);

    const future = outFile();
    await writeReadersFile(db, QUESTION, { root }, future);
    const parsed = JSON.parse(fs.readFileSync(future, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(future, JSON.stringify({ ...parsed, version: 99 }), 'utf8');
    await expect(replayReaders(db, QUESTION, { root }, future)).rejects.toThrow(/v99 reader file/);

    const notJson = outFile();
    fs.writeFileSync(notJson, 'six agents said things', 'utf8');
    await expect(replayReaders(db, QUESTION, { root }, notJson)).rejects.toThrow(/is not JSON/);
    db.close();
  });

  it('refuses a malformed output rather than answering from a hole in it', async () => {
    const { root, db } = seedDb();
    // `found` omitted. `ask()` would read this as `found: false`, print "1
    // session searched, none answered", and be wrong about the archive.
    const noFound = await recordWithOutputs(db, root, QUESTION, [
      { sessionId: POOLER, quotes: [], answer_fragment: '' },
    ]);
    await expect(replayReaders(db, QUESTION, { root }, noFound)).rejects.toThrow(/no boolean "found"/);

    const noSeq = await recordWithOutputs(db, root, QUESTION, [
      { sessionId: POOLER, found: true, quotes: [{ text: REAL_QUOTE }], answer_fragment: '' },
    ]);
    await expect(replayReaders(db, QUESTION, { root }, noSeq)).rejects.toThrow(/no integer "seq"/);

    const noId = await recordWithOutputs(db, root, QUESTION, [{ found: false, quotes: [] }]);
    await expect(replayReaders(db, QUESTION, { root }, noId)).rejects.toThrow(/no "sessionId"/);
    db.close();
  });

  it('names a missing "version" as missing, not as "vundefined"', async () => {
    // D12. `String(undefined)` is `"undefined"`, and the message read
    //   potsherd: … is a vundefined reader file and this potsherd (0.4.0) reads v1
    // for the commonest case there is: a file with `kind` right and no
    // `version` at all, which is what a hand-edited recording looks like.
    const { root, db } = seedDb();
    const target = await recordWithOutputs(db, root, QUESTION, [RECORDED]);
    const file = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>;

    delete file['version'];
    fs.writeFileSync(target, JSON.stringify(file, null, 2));
    await expect(replayReaders(db, QUESTION, { root }, target)).rejects.toThrow(
      /has no "version"/,
    );
    await expect(replayReaders(db, QUESTION, { root }, target)).rejects.not.toThrow(
      /vundefined/,
    );

    // A version from the future still reads as a version, with a number.
    fs.writeFileSync(target, JSON.stringify({ ...file, version: 7 }, null, 2));
    await expect(replayReaders(db, QUESTION, { root }, target)).rejects.toThrow(
      /is a v7 reader file/,
    );

    // And a version that is not a number says what it found instead of
    // printing it after a `v`.
    fs.writeFileSync(target, JSON.stringify({ ...file, version: '1' }, null, 2));
    await expect(replayReaders(db, QUESTION, { root }, target)).rejects.toThrow(
      /"version" here is "1"/,
    );
    db.close();
  });

  it('a reader that found nothing replays as a reader that found nothing', async () => {
    const { root, db } = seedDb();
    const target = await recordWithOutputs(db, root, QUESTION, [
      { sessionId: POOLER, found: false, quotes: [], answer_fragment: '' },
    ]);
    const transport = new Throwing();
    const llm = Llm.open({ transport, model: 'sonnet' });
    const r = await replayReaders(db, QUESTION, { root, llm, openThreads: false }, target);
    // `ask()`'s own `answered.length === 0` early return, reached honestly.
    expect(r.searched).toBe(1);
    expect(r.readers[0]!.found).toBe(false);
    expect(r.answer).toBe('');
    expect(transport.sent).toHaveLength(0);
    db.close();
    await llm.close();
  });
});

/**
 * T5.9 / D15 — the plugin skill has to *use* the seam, not describe one.
 *
 * T5.6 shipped `--readers-out` / `--readers-in` and T5.2 §2 said that when
 * they landed, `skills/potsherd/SKILL.md` should replace its hand-rolled
 * fan-out with them and delete the "checked by reading" caveat. `plugins/**`
 * was reserved from both tasks, so nobody made that edit: `grep -rn
 * 'readers-out' plugins/` matched nothing, the skill still rebuilt the
 * shortlist out of `find --json` and `show --json`, and it still ended every
 * answer telling the user to re-run `potsherd ask` for a citation-checked one
 * — which the round trip now gives them.
 *
 * These assertions are about the skill file, because the skill file is the
 * product here. The last one is the load-bearing one: it reads the field names
 * the skill tells a model to use out of the prose and checks them against the
 * keys the recorder actually writes, so the instructions cannot drift away
 * from the format without failing.
 */
describe('the plugin skill routes ask through --readers-out / --readers-in', () => {
  const skillPath = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    '..',
    'plugins',
    'claude-code',
    'skills',
    'potsherd',
    'SKILL.md',
  );
  const skill = (): string => fs.readFileSync(skillPath, 'utf8');
  const QUESTION = 'how did we handle pgbouncer with prepared statements?';

  /** A recording and nothing else, exactly as step 1 of the skill produces. */
  async function recordOnly(
    db: ReturnType<typeof store.open>,
    root: string,
    question: string,
  ): Promise<string> {
    const target = path.join(scratch('potsherd-skill-'), 'readers.json');
    await writeReadersFile(db, question, { root }, target);
    return target;
  }

  it('names both halves of the round trip', () => {
    const text = skill();
    expect(text).toMatch(/--readers-out/);
    expect(text).toMatch(/--readers-in/);
  });

  it('no longer rebuilds the shortlist by hand', () => {
    const text = skill();
    const ask = text.slice(text.indexOf('## ask'), text.indexOf('## rescue and guard'));
    // The three commands the old route ran to reconstruct what --readers-out
    // records in one call. Rebuilding it by hand produces a different
    // shortlist, which --readers-in refuses.
    expect(ask).not.toMatch(/BIN find .*--limit 6/);
    expect(ask).not.toMatch(/BIN show <sessionId> --json/);
  });

  it('does not disclaim the citation filter it now runs', () => {
    const text = skill();
    const ask = text.slice(text.indexOf('## ask'), text.indexOf('## rescue and guard'));
    // The exact sentence T5.6 §6 said could go, and the weaker-guarantee
    // language around it. `--readers-in` runs `filterAnswer` in code.
    expect(ask).not.toMatch(/citation filter — for the code-checked answer/);
    expect(ask).not.toMatch(/it is a weaker guarantee/);
    expect(ask).not.toMatch(/quotes checked against the excerpts above/);
  });

  it('warns that the filters must match across the two calls', () => {
    const ask = skill();
    expect(ask).toMatch(/filters/i);
    expect(ask).toMatch(/same \$rest|identical across the two calls|paste the same string/i);
  });

  it('says --strict and --json need no special case any more', () => {
    const text = skill();
    const ask = text.slice(text.indexOf('## ask'), text.indexOf('## rescue and guard'));
    expect(ask).toMatch(/`--strict` and `--json` need no special case/);
  });

  it('describes the file with the field names the recorder actually writes', async () => {
    const { root, db } = seedDb();
    const target = await recordOnly(db, root, QUESTION);
    const file = JSON.parse(fs.readFileSync(target, 'utf8')) as {
      targets: Record<string, unknown>[];
    };
    db.close();

    const text = skill();
    const ask = text.slice(text.indexOf('## ask'), text.indexOf('## rescue and guard'));
    // Every per-target field the skill tells a model to hand its readers has
    // to be a field the recorder puts there.
    const real = new Set(Object.keys(file.targets[0]!));
    for (const named of ['sessionId', 'id8', 'project', 'harness', 'isSidechain', 'isGhost', 'excerpts', 'seqs']) {
      expect(ask, `skill names ${named}`).toContain(named);
      expect(real, `recorder writes ${named}`).toContain(named);
    }
    // And the shape it tells the model to write back is the shape the replay
    // reads: `sessionId` plus AskReaderOutput.
    for (const named of ['outputs', 'found', 'quotes', 'answer_fragment']) {
      expect(ask, `skill names ${named}`).toContain(named);
    }
  });
});

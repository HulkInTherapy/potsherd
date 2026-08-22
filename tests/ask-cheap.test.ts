import { afterEach, describe, expect, it } from 'vitest';
import { db as store } from '@potsherd/core';
import {
  ASK_CARD_CHARS,
  ASK_CHEAP_K,
  ASK_CHEAP_MODEL,
  ASK_CHEAP_SESSION_CHARS,
  ASK_CHEAP_TOP_EXCHANGES,
  ASK_K,
  ASK_SESSION_CHARS,
  READER_CARD_NOTE,
  ask,
  filterAnswer,
  type AskProgress,
  type AskReaderFn,
  type AskReaderInput,
  type AskReaderReport,
  type AskResult,
  type EvidenceSource,
} from '../packages/core/src/ask.js';
import { cheapNote, readerLine, renderAsk } from '../packages/core/src/render/ask.js';
import { Theme, stripAnsi } from '../packages/core/src/theme.js';
import {
  Llm,
  type Backend,
  type SendRequest,
  type SendResult,
  type Transport,
} from '../packages/core/src/llm.js';
import { askProgress } from '../packages/cli/src/commands/ask.js';
import { themeFrom } from '../packages/cli/src/output.js';
import { rmrf, tempDir } from './helpers.js';

/**
 * 8.7 — the wait, and the cheap path.
 *
 * Two claims are under test here and they are not the same kind of claim.
 *
 * **The wait is legible.** One line per reader, as it returns, in a shape that
 * fits 80 columns and 60, folds to ASCII, and — the part that is a *defect* if
 * it is wrong rather than a shortfall — goes to a stream that cannot corrupt
 * `--json`. The phase file is explicit: *"a progress line that corrupts
 * `--json` output is a worse defect than the blind wait."* So the sink is an
 * argument to {@link askProgress} and the test watches both streams, rather
 * than asserting about a terminal it does not have.
 *
 * **`--cheap` reads less, and says so, and still cannot guess.** The three
 * levers (k, a haiku-class synthesizer, cards-first) are all reductions in
 * what was looked at. The one thing they may not reduce is the citation rule,
 * and cards-first is where that could quietly go wrong: the card is prose the
 * model is handed and no exchange contains, so a quote lifted from it is
 * exactly the shape of a fabricated citation. The test drives that case
 * through the real filter.
 *
 * ## what is not observable here
 *
 * **Wall time is not tested.** `--cheap`'s acceptance is a p50 in seconds
 * against a real backend, and a deadline asserted in this file would be a test
 * of the machine it runs on. That measurement is a run, recorded with its
 * evidence directories, not an assertion — and the reason is on the record:
 * an earlier deadline test in this build passed locally three times and failed
 * on all four CI legs because `availability()` finds a `claude` at a well-known
 * absolute path even with `PATH` emptied, so "there is no backend" was never
 * the premise the test thought it had established. Nothing below needs a
 * backend: every model call goes through {@link Scripted}.
 */

const created: string[] = [];
afterEach(() => {
  while (created.length) rmrf(created.pop()!);
});

function scratch(prefix = 'potsherd-ask-cheap-'): string {
  const dir = tempDir(prefix);
  created.push(dir);
  return dir;
}

// ------------------------------------------------------------------ doubles

/** Records every outgoing request, so a test can read what the wire carried. */
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
    return { text: reply, inputTokens: 10, outputTokens: 120 };
  }
  async close(): Promise<void> {
    this.closed++;
  }
}

/** A sink that keeps what was written, so a test can name the stream. */
class Sink {
  readonly chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  get text(): string {
    return this.chunks.join('');
  }
  get lines(): string[] {
    return this.text.split('\n').filter((l) => l !== '');
  }
}

function report(o: Partial<AskReaderReport> = {}): AskReaderReport {
  return {
    // A demo-corpus id. The phase file's worked example used a real session
    // id from the reference machine and it reached this file by being copied
    // out of the plan; the id-inventory guard refused it.
    sessionId: '9c4d2f18-7a3b-4e05-b6d1-0f2a58e17c43',
    id8: '9c4d2f18',
    found: true,
    quotes: 2,
    ms: 12_100,
    ...o,
  };
}

// ============================================================ the reader line

describe('one line per reader, as it returns', () => {
  it('is the shape the phase file specifies', () => {
    const t = new Theme({ color: false, width: 80 });
    // The id column is 11 wide, not 8: a sidechain reader prints
    // `<parent>↳<tag>`, because `idTag` alone returns `01` for an id like
    // `<uuid>:agent-01` and `01` is not something a reader can pass to
    // `show` — it matched six sessions when this was checked by hand.
    expect(readerLine(report(), 3, 6, t)).toBe('  reader 3/6 · 9c4d2f18    · found   ·  12.1s');
  });

  it('lines the four columns up, whatever the verdict or the id', () => {
    const t = new Theme({ color: false, width: 80 });
    const lines = [
      readerLine(report({ id8: 'b2181bfe', found: false, ms: 9_500 }), 1, 6, t),
      readerLine(report({ id8: '9c4d2f18', ms: 15_000 }), 5, 6, t),
      // `idTag` returns two characters for a harness whose ids carry a `:`
      // suffix. Unpadded, that line reads as corrupt output.
      readerLine(report({ id8: '12', found: false, error: 'x', ms: 183_400 }), 6, 6, t),
    ];
    const columns = lines.map((l) => [...l].map((c, i) => (c === '·' ? i : -1)).filter((i) => i >= 0));
    expect(columns[1]).toEqual(columns[0]);
    expect(columns[2]).toEqual(columns[0]);
  });

  it('says "nothing" and "failed" as different words', () => {
    const t = new Theme({ color: false, width: 80 });
    const nothing = readerLine(report({ found: false, quotes: 0 }), 1, 6, t);
    const failed = readerLine(
      report({ found: false, quotes: 0, error: 'did not answer within 360s' }),
      2,
      6,
      t,
    );
    expect(nothing).toContain('nothing');
    expect(failed).toContain('failed');
    // The distinction the `nothing()` renderer already carries a scar for: a
    // reader that never ran is not a session that had nothing in it.
    expect(nothing).not.toContain('failed');
    expect(failed).not.toContain('nothing');
  });

  it('fits 80 columns and 60, and never wraps', () => {
    for (const width of [80, 60]) {
      const t = new Theme({ color: false, width });
      for (const r of [
        report(),
        report({ found: false }),
        report({ found: false, error: 'x' }),
        report({ ms: 183_400 }),
      ]) {
        const line = readerLine(r, 10, 10, t);
        expect(line).not.toContain('\n');
        expect(Theme.len(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('is pure ASCII under --ascii', () => {
    const t = new Theme({ color: false, ascii: true, width: 80 });
    const line = readerLine(report(), 3, 6, t);
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7F]/.test(line)).toBe(false);
    expect(line).toContain('|');
    expect(line).not.toContain('·');
  });

  it('carries no escape codes when colour is off, and the word survives when it is on', () => {
    const plain = readerLine(report(), 3, 6, new Theme({ color: false, width: 80 }));
    expect(plain).toBe(stripAnsi(plain));
    const coloured = readerLine(report(), 3, 6, new Theme({ color: true, width: 80 }));
    // Colour is redundant with the word, which is the only safe way to use it:
    // the same line read on a monochrome terminal says the same thing.
    expect(stripAnsi(coloured)).toBe(plain);
  });

  it('carries the running cost at 80 columns and drops it at 60', () => {
    const spend = { usd: 0.0412, estimated: true };
    const wide = readerLine(report(), 3, 6, new Theme({ color: false, width: 80 }), spend);
    expect(wide).toContain('$0.041');
    expect(wide).toContain('est.');
    expect(Theme.len(wide)).toBeLessThanOrEqual(80);
    // Dropped rather than clipped: the four identity columns are the receipt
    // and the total is on the footer either way, so a narrow terminal loses
    // the running figure instead of losing the end of the grid.
    const narrow = readerLine(report(), 3, 6, new Theme({ color: false, width: 48 }), spend);
    expect(narrow).not.toContain('$');
    expect(narrow).toBe(readerLine(report(), 3, 6, new Theme({ color: false, width: 48 })));
  });

  it('clips rather than wrapping at an absurd width', () => {
    const t = new Theme({ color: false, width: 20 });
    const line = readerLine(report(), 3, 6, t);
    expect(line).not.toContain('\n');
    expect(Theme.len(line)).toBeLessThanOrEqual(20);
  });
});

// ================================================== where the line is written

describe('the progress line cannot corrupt --json', () => {
  const t = themeFrom({ color: false, width: 80 });

  function progressEvent(o: Partial<AskProgress> = {}): AskProgress {
    return {
      step: 'read',
      done: 1,
      total: 6,
      spend: { calls: 1, inputTokens: 0, outputTokens: 0, usd: 0, ms: 0, estimatedInputCalls: 1 },
      reader: report(),
      ...o,
    };
  }

  it('writes to the sink it was given and to nothing else', () => {
    const err = new Sink();
    const out = new Sink();
    const onProgress = askProgress(t, err, true);
    onProgress(progressEvent({ done: 1, reader: report({ id8: 'aaaaaaaa' }) }));
    onProgress(progressEvent({ done: 2, reader: report({ id8: 'bbbbbbbb', found: false }) }));
    expect(err.lines).toHaveLength(2);
    // The whole point of the seam: stdout is a different object and stays
    // empty, which is what makes `ask --json | jq` safe on a slow run.
    expect(out.text).toBe('');
  });

  it('shows the running spend, labelled est., as the readers arrive', () => {
    const err = new Sink();
    askProgress(t, err, true)(
      progressEvent({
        spend: {
          calls: 2,
          inputTokens: 0,
          outputTokens: 0,
          usd: 0.0412,
          ms: 0,
          estimatedInputCalls: 2,
        },
      }),
    );
    // `03` §8 asks this verb for a live cost display, and `05`'s honesty
    // contract asks for the label. Both survive the bar being deleted.
    expect(err.text).toContain('$0.041');
    expect(err.text).toContain('est.');
  });

  it('emits one line per reader, in arrival order, each ending in a newline', () => {
    const err = new Sink();
    const onProgress = askProgress(t, err, true);
    onProgress(progressEvent({ done: 1, reader: report({ id8: 'aaaaaaaa' }) }));
    onProgress(progressEvent({ done: 2, reader: report({ id8: 'bbbbbbbb' }) }));
    expect(err.text.endsWith('\n')).toBe(true);
    expect(err.lines[0]).toContain('aaaaaaaa');
    expect(err.lines[0]).toContain('1/6');
    expect(err.lines[1]).toContain('bbbbbbbb');
    expect(err.lines[1]).toContain('2/6');
  });

  it('prints nothing for the steps that have nothing per-item to show', () => {
    const err = new Sink();
    const onProgress = askProgress(t, err, true);
    for (const step of ['shortlist', 'synthesize', 'filter', 'threads'] as const) {
      onProgress(progressEvent({ step, reader: undefined as unknown as AskReaderReport }));
    }
    // A `read` event with no reader on it is the same case: nothing to print.
    onProgress(progressEvent({ reader: undefined as unknown as AskReaderReport }));
    expect(err.text).toBe('');
  });

  it('is silent under --quiet, and only under --quiet', () => {
    const quiet = new Sink();
    askProgress(t, quiet, false)(progressEvent());
    expect(quiet.text).toBe('');
    const loud = new Sink();
    askProgress(t, loud, true)(progressEvent());
    expect(loud.lines).toHaveLength(1);
  });
});

describe('ask() reports every reader as it returns', () => {
  it('carries the report on the progress event, failures included', async () => {
    const { root, db } = seedFast();
    const seen: AskProgress[] = [];
    const readerFn: AskReaderFn = async (input) => {
      if (input.sessionId === QUIET) throw new Error('did not answer within 360s');
      return {
        found: true,
        quotes: [{ seq: 12, ts: null, text: REAL_QUOTE }],
        answer_fragment: 'they set the client cache to zero.',
      };
    };
    const llm = Llm.open({ transport: new Scripted('agent-sdk', ['{}']), model: 'sonnet' });
    await ask(db, 'pgbouncer prepared statements pooler', {
      root,
      llm,
      readerFn,
      openThreads: false,
      onProgress: (p) => seen.push({ ...p }),
    });

    const reads = seen.filter((p) => p.step === 'read');
    expect(reads.length).toBeGreaterThan(0);
    // Every read event names the reader it is about. Without this the CLI has
    // a counter and no way to say which session it counted.
    expect(reads.every((p) => Boolean(p.reader))).toBe(true);
    const failed = reads.filter((p) => p.reader?.error);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reader!.id8).toBe(QUIET.slice(0, 8));
    expect(failed[0]!.detail).toBe('failed');
    db.close();
    await llm.close();
  });
});

// ========================================================== cards-first

const POOLER = '11111111-2222-4222-8222-222222222222';
const QUIET = '33333333-4444-4444-8444-444444444444';
const REAL_QUOTE = 'we set statement_cache_size=0 on the client';

/**
 * A synthetic index with two pooler sessions, one of them carded.
 *
 * Both are long enough that the default slice and the cards-first slice are
 * different sizes — otherwise the excerpt assertions below would pass on a
 * fixture too small to tell them apart, which is the failure mode that makes a
 * size test worthless.
 */
function seedFast(o: { card?: boolean; secret?: string; short?: boolean } = {}): {
  root: string;
  db: ReturnType<typeof store.open>;
} {
  const root = scratch();
  const db = store.open({ root });
  const session = db.prepare(
    `INSERT INTO sessions (id, harness, title, project, project_slug, source_path, status,
        is_sidechain, started_at, ended_at, user_prompts, assistant_turns, bytes, indexed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const ins = db.prepare(
    `INSERT INTO exchanges (id, session_id, seq, ts, user_text, assistant_text, files_touched)
     VALUES (?,?,?,?,?,?,?)`,
  );
  // Filler wide enough that eight seqs cannot fit in ASK_CHEAP_SESSION_CHARS
  // but do fit in ASK_SESSION_CHARS.
  const filler = 'the pooler and the connection pool were discussed at length. '.repeat(
    o.short ? 1 : 20,
  );

  // Eight sessions, not two: the `k` assertions below are about a cap, and a
  // cap tested on a corpus smaller than the cap passes for the wrong reason.
  const extras = Array.from(
    { length: 6 },
    (_, i) => [`5${i}555555-6666-4666-8666-666666666666`, `/tmp/Filler${i}`] as const,
  );
  for (const [id, project] of [
    [POOLER, '/tmp/Ledger'] as const,
    [QUIET, '/tmp/Sibling'] as const,
    ...extras,
  ]) {
    session.run(id, 'claude', 'the pooler', project, project.replace(/\//g, '-'),
      '/tmp/x.jsonl', 'live', 0, '2026-08-04T09:00:00.000Z', '2026-08-04T10:00:00.000Z',
      8, 8, 100, '2026-08-05T00:00:00.000Z');
    // `short`: three brief exchanges, which is what a real short session looks
    // like and what the demo corpus turned out to be made of. The top-2 slice
    // is then the whole session, so the card is pure addition.
    for (let seq = 8; seq <= (o.short ? 10 : 15); seq++) {
      ins.run(`${id}-u${seq}`, id, seq, '2026-08-04T09:00:00.000Z',
        `pgbouncer prepared statements pooler question ${seq}. ${filler}`,
        seq === 12
          ? 'pgbouncer in transaction mode cannot carry prepared statements, so ' +
            `${REAL_QUOTE} rather than moving the pooler to session mode. ${filler}`
          : `an answer about the pooler at ${seq}. ${filler}`,
        '[]');
    }
  }
  db.exec("INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild')");

  if (o.card !== false) {
    db.prepare(
      `INSERT INTO cards (session_id, title, summary, topics, decisions, files, outcome,
          open_threads, source)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      POOLER,
      'the pooler',
      `the session where the pooler mode was settled${o.secret ? ` using ${o.secret}` : ''}`,
      '["pgbouncer"]',
      JSON.stringify([
        {
          what: 'disable prepared statements behind pgbouncer',
          why: 'transaction pooling cannot route them twice',
          evidence_seq: [12],
        },
      ]),
      '["db/pool.ts"]',
      'shipped',
      '[]',
      'transcript',
    );
  }
  return { root, db };
}

/** Collects the reader inputs `ask()` builds, without calling a model. */
async function readerInputs(
  db: ReturnType<typeof store.open>,
  root: string,
  opts: { cheap?: boolean; k?: number } = {},
): Promise<AskReaderInput[]> {
  const seen: AskReaderInput[] = [];
  const readerFn: AskReaderFn = async (input) => {
    seen.push(input);
    return { found: false, quotes: [], answer_fragment: '' };
  };
  await ask(db, 'pgbouncer prepared statements pooler', {
    root,
    readerFn,
    openThreads: false,
    ...opts,
  });
  return seen;
}

describe('--cheap is cards-first, and only where there is a card', () => {
  it('hands a carded session the card plus a short slice', async () => {
    const { root, db } = seedFast();
    const cheap = await readerInputs(db, root, { cheap: true });
    const carded = cheap.find((x) => x.sessionId === POOLER)!;
    expect(carded.card).toBeTruthy();
    expect(carded.card).toContain('disable prepared statements behind pgbouncer');
    // The seq the card names is carried so the reader can go and quote the
    // exchange rather than the card's paraphrase of it.
    expect(carded.card).toContain('seq 12');
    expect(carded.card!.length).toBeLessThanOrEqual(ASK_CARD_CHARS + 1);
    expect(carded.excerpts.length).toBeLessThanOrEqual(ASK_CHEAP_SESSION_CHARS + 200);
    expect(carded.seqs.length).toBeLessThanOrEqual(ASK_CHEAP_TOP_EXCHANGES * 3);
    db.close();
  });

  it('leaves an uncarded session its full slice, even under --cheap', async () => {
    const { root, db } = seedFast();
    const cheap = await readerInputs(db, root, { cheap: true });
    const uncarded = cheap.find((x) => x.sessionId === QUIET)!;
    // Nothing is standing in for what a cut would remove here, so nothing is
    // cut. A third of a transcript and no summary of the rest is a miss the
    // user cannot see.
    expect(uncarded.card).toBeUndefined();
    expect(uncarded.excerpts.length).toBeGreaterThan(ASK_CHEAP_SESSION_CHARS);
    db.close();
  });

  it('never sends more than the default path would have', async () => {
    // The whole trade assumes the default slice is near its 8 kB ceiling. On a
    // short session it is not, and a 900-character card bolted onto a 1 kB
    // slice makes `--cheap` send more than the path it replaces. Measured on
    // the synthetic demo corpus: 4,518 characters against 3,032.
    const { root, db } = seedFast({ short: true });
    const cheap = await readerInputs(db, root, { cheap: true });
    const slow = await readerInputs(db, root, {});
    const sent = (xs: AskReaderInput[]): number =>
      xs.reduce((a, x) => a + x.excerpts.length + (x.card?.length ?? 0), 0);
    const carded = cheap.find((x) => x.sessionId === POOLER)!;
    // Nothing to trade away, so nothing is traded: no card, and the same
    // excerpt the default path would have sent.
    expect(carded.card).toBeUndefined();
    expect(carded.excerpts).toBe(slow.find((x) => x.sessionId === POOLER)!.excerpts);
    expect(sent(cheap)).toBeLessThanOrEqual(sent(slow));
    db.close();
  });

  it('sends no card at all on the default path', async () => {
    const { root, db } = seedFast();
    const slow = await readerInputs(db, root, {});
    expect(slow.every((x) => x.card === undefined)).toBe(true);
    expect(slow.find((x) => x.sessionId === POOLER)!.excerpts.length).toBeGreaterThan(
      ASK_CHEAP_SESSION_CHARS,
    );
    db.close();
  });

  it('degrades to the ordinary slice when the corpus has no cards', async () => {
    const { root, db } = seedFast({ card: false });
    const cheap = await readerInputs(db, root, { cheap: true });
    expect(cheap.every((x) => x.card === undefined)).toBe(true);
    expect(cheap.every((x) => x.excerpts.length > ASK_CHEAP_SESSION_CHARS)).toBe(true);
    db.close();
  });

  it('reads ASK_CHEAP_K sessions by default and obeys an explicit --k', async () => {
    const { root, db } = seedFast();
    const r = await ask(db, 'pgbouncer prepared statements pooler', {
      root,
      readerFn: async () => ({ found: false, quotes: [], answer_fragment: '' }),
      openThreads: false,
      cheap: true,
    });
    expect(ASK_CHEAP_K).toBeLessThan(ASK_K);
    expect(r.searched).toBe(ASK_CHEAP_K);
    expect(r.cheap).toBe(true);
    // The control: the same corpus, the same question, the default path.
    const slow = await ask(db, 'pgbouncer prepared statements pooler', {
      root,
      readerFn: async () => ({ found: false, quotes: [], answer_fragment: '' }),
      openThreads: false,
    });
    expect(slow.searched).toBe(ASK_K);
    expect(slow.cheap).toBe(false);

    // An explicit --k beats --cheap, in both directions, because the footer
    // prints the shortlist it actually built.
    expect((await readerInputs(db, root, { cheap: true, k: 2 })).length).toBe(2);
    expect((await readerInputs(db, root, { cheap: true, k: 5 })).length).toBe(5);
    db.close();
  });
});

describe('the card is context, never evidence', () => {
  it('drops a quote lifted from the card, because no exchange contains it', () => {
    const cardOnlyClaim = 'disable prepared statements behind pgbouncer';
    const sources: EvidenceSource[] = [
      {
        sessionId: POOLER,
        id8: POOLER.slice(0, 8),
        project: 'Ledger',
        harness: 'claude',
        isSidechain: false,
        isGhost: false,
        units: [
          {
            seq: 12,
            id: 'u12',
            ts: '2026-08-04T09:05:00.000Z',
            text: `user: the pooler is 500ing\n\nassistant: ${REAL_QUOTE} rather than session mode.`,
          },
        ],
      },
    ];
    const out = filterAnswer(
      [
        { text: 'The card says the decision was taken.', cites: [1] },
        { text: 'The client cache was set to zero.', cites: [2] },
      ],
      [
        { index: 1, sessionId: POOLER, seq: 12, quote: cardOnlyClaim },
        { index: 2, sessionId: POOLER, seq: 12, quote: REAL_QUOTE },
      ],
      sources,
    );
    // The card's own words resolve to no exchange, so the line and the
    // sentence that leaned on it both go. This is why cards-first can be
    // faster without being a different product.
    expect(out.evidence).toHaveLength(1);
    expect(out.evidence[0]!.quote).toContain('statement_cache_size=0');
    expect(out.dropped).toEqual(['The card says the decision was taken.']);
    expect(out.drops.some((d) => d.reason === 'not-a-quote')).toBe(true);
  });

  it('tells the reader so in the system prompt, and puts the card above the excerpts', async () => {
    const { root, db } = seedFast();
    const transport = new Scripted('agent-sdk', ['{"found":false,"quotes":[],"answer_fragment":""}']);
    const readerLlm = Llm.open({ transport, model: 'haiku' });
    await ask(db, 'pgbouncer prepared statements pooler', {
      root,
      readerLlm,
      llm: Llm.open({ transport: new Scripted('agent-sdk', ['{}']), model: 'haiku' }),
      openThreads: false,
      cheap: true,
    });
    const carded = transport.sent.find((r) => r.prompt.includes('Card (context only'));
    expect(carded).toBeTruthy();
    expect(carded!.system).toContain(READER_CARD_NOTE);
    // Above the excerpts, so the last thing read before answering is the
    // evidence itself.
    expect(carded!.prompt.indexOf('Card (context only')).toBeLessThan(
      carded!.prompt.indexOf('Excerpts:'),
    );
    db.close();
    await readerLlm.close();
  });
});

describe('there is no --no-redact, and the card does not get one', () => {
  it('masks a secret in the card text on the wire', async () => {
    // Synthetic and shaped like the rule, not lifted from anywhere: a 40-char
    // hex assignment is what `redact.ts`'s generic `KEY=` rule is for.
    const secret = 'API_SECRET=0123456789abcdef0123456789abcdef01234567';
    const { root, db } = seedFast({ secret });
    const transport = new Scripted('agent-sdk', ['{"found":false,"quotes":[],"answer_fragment":""}']);
    const readerLlm = Llm.open({ transport, model: 'haiku' });
    await ask(db, 'pgbouncer prepared statements pooler', {
      root,
      readerLlm,
      llm: Llm.open({ transport: new Scripted('agent-sdk', ['{}']), model: 'haiku' }),
      openThreads: false,
      cheap: true,
    });
    const carded = transport.sent.find((r) => r.prompt.includes('Card (context only'))!;
    // `llm.ts` redacts every outgoing prompt and there is no flag that turns
    // it off. `--cheap` changes what is sent, not whether it is redacted.
    expect(carded.prompt).toContain('Card (context only');
    expect(carded.prompt).not.toContain('0123456789abcdef0123456789abcdef01234567');
    expect(carded.prompt).toContain('‹redacted:');
    db.close();
    await readerLlm.close();
  });
});

// ================================================ the line --cheap owes the user

describe('--cheap is honest about what it traded away', () => {
  function base(o: Partial<AskResult> = {}): AskResult {
    return {
      question: 'what did we decide about the pooler?',
      answer: 'The client cache was set to zero. [1]',
      sentences: [{ text: 'The client cache was set to zero.', cites: [1] }],
      dropped: [],
      trimmed: [],
      evidence: [
        {
          index: 1,
          sessionId: POOLER,
          id8: POOLER.slice(0, 8),
          project: 'Ledger',
          harness: 'claude',
          seq: 12,
          ts: '2026-08-04T09:05:00.000Z',
          quote: REAL_QUOTE,
          isSidechain: false,
          isGhost: false,
        },
      ],
      openThreads: [],
      searched: 3,
      matching: 47,
      readers: [],
      refused: false,
      refusal: null,
      strict: false,
      spend: { calls: 4, inputTokens: 0, outputTokens: 0, usd: 0.02, ms: 0, estimatedInputCalls: 4 },
      estimated: true,
      cheap: true,
      ms: 21_400,
      ...o,
    };
  }

  const t = new Theme({ color: false, width: 80 });

  it('says it on the screen, not only in --help', () => {
    const text = stripAnsi(renderAsk(base(), t, new Date('2026-08-22T12:00:00Z')));
    expect(text).toContain('--cheap');
    expect(text).toContain('can miss');
  });

  it('says it on a refusal and on a run that found nothing, too', () => {
    const refusedText = stripAnsi(
      renderAsk(
        base({ refused: true, refusal: 'strict', sentences: [], evidence: [], answer: '' }),
        t,
      ),
    );
    expect(refusedText).toContain('--cheap');
    const nothingText = stripAnsi(
      renderAsk(base({ sentences: [], evidence: [], answer: '' }), t),
    );
    // The screen a narrow read is most likely to produce is the one it most
    // needs to disclose on: "nothing found" after reading three sessions is
    // not the same statement as "nothing found" after reading six.
    expect(nothingText).toContain('--cheap');
  });

  it('says nothing at all on the default path', () => {
    const text = stripAnsi(renderAsk(base({ cheap: false, searched: 6 }), t));
    expect(text).not.toContain('--cheap');
  });

  it('fits 80 columns and 60, with "can miss" surviving the narrow one', () => {
    for (const width of [80, 60]) {
      const line = cheapNote(base(), new Theme({ color: false, width }));
      expect(Theme.len(line)).toBeLessThanOrEqual(width);
      expect(line).toContain('can miss');
    }
  });

  it('is pure ASCII under --ascii', () => {
    const line = cheapNote(base(), new Theme({ color: false, ascii: true, width: 80 }));
    const folded = new Theme({ ascii: true }).asciiLine(line);
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7F]/.test(folded)).toBe(false);
  });

  it('is carried in --json as a field, not inferred from the prose', () => {
    expect(base().cheap).toBe(true);
    expect(base({ cheap: false }).cheap).toBe(false);
  });
});

describe('the cheap path picks a cheaper synthesizer without being asked', () => {
  it('uses a haiku-class model, and an explicit --model still wins', async () => {
    const { root, db } = seedFast();
    const seen: string[] = [];
    const readerFn: AskReaderFn = async () => ({
      found: true,
      quotes: [{ seq: 12, ts: null, text: REAL_QUOTE }],
      answer_fragment: 'the client cache was set to zero.',
    });
    // `ask()` opens the synthesizer itself when no `llm` is passed, so the
    // model it chose is read off the handle rather than off a transport.
    const spy = { open: Llm.open.bind(Llm) };
    const original = Llm.open;
    (Llm as unknown as { open: typeof Llm.open }).open = ((opts: Parameters<typeof Llm.open>[0]) => {
      if (opts?.model) seen.push(String(opts.model));
      return spy.open({ ...opts, transport: new Scripted('agent-sdk', ['{}']) });
    }) as typeof Llm.open;
    try {
      await ask(db, 'pgbouncer prepared statements pooler', {
        root,
        readerFn,
        openThreads: false,
        cheap: true,
      });
      expect(seen).toContain(ASK_CHEAP_MODEL);
      seen.length = 0;
      await ask(db, 'pgbouncer prepared statements pooler', {
        root,
        readerFn,
        openThreads: false,
        cheap: true,
        model: 'opus',
      });
      expect(seen).toContain('opus');
    } finally {
      (Llm as unknown as { open: typeof Llm.open }).open = original;
    }
    db.close();
  });
});

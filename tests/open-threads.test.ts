import { afterEach, describe, expect, it } from 'vitest';
import { db as store, type Db } from '@potsherd/core';
import {
  Llm,
  type Backend,
  type SendRequest,
  type SendResult,
  type Transport,
} from '../packages/core/src/llm.js';
import {
  GENERIC_DF,
  MEASURED_NONMATCH_MAX,
  MENTION_COSINE,
  MIN_ANCHOR_TOKENS,
  MIN_PROJECT_OVERLAP,
  OPEN_THREAD_LABEL,
  contentTokens,
  openThreadCandidates,
  sameProject,
  tokenCosine,
  type OpenThreadCandidate,
} from '../packages/core/src/open-threads.js';
// T6.6 D0b — the model pass lives in its own module so that the rule pass is
// provably offline; the names are the same ones, one import line over.
import {
  CONFIRM_BATCH,
  NO_MODEL_NOTE,
  confirmOpenThreads,
} from '../packages/core/src/open-threads-confirm.js';

/**
 * T4.2 — "decided in A, never seen in B".
 *
 * The thing under test is a claim about an **absence**, which is the one kind
 * of claim potsherd cannot cite. `05` §4 calls the resulting line the moment
 * people quote; it is therefore also the easiest place in the product to print
 * something confidently wrong, and these tests are organised around the ways
 * it can be wrong rather than around the functions.
 *
 * The three false positives that matter, each with a case below:
 *
 *   - **B did do it.** Two projects that share files and topics, and B's card
 *     records the same decision in different words. Must produce nothing.
 *   - **The projects are unrelated.** They share one generic word — the
 *     brief's `auth` — and nothing else. Must produce nothing.
 *   - **The evidence is a ghost.** A ghost card is prompts only, with no
 *     assistant side, so a "decision" attributed to one is a decision the user
 *     *typed about*. Must never raise a candidate; must still be able to
 *     withdraw one.
 *
 * And the guard that is code rather than prompt: a model that confirms a
 * candidate the card cannot cite is overruled here.
 */

// ------------------------------------------------------------------ fixture

const OPEN: Db[] = [];
afterEach(() => {
  while (OPEN.length) OPEN.pop()!.close();
});

function memDb(): Db {
  const db = store.open({ file: ':memory:' });
  OPEN.push(db);
  return db;
}

let nextId = 0;
function uuid(tag: string): string {
  nextId += 1;
  return `${tag}${String(nextId).padStart(4, '0')}-0000-4000-8000-000000000000`.slice(0, 36);
}

interface CardSpec {
  id?: string;
  project: string;
  topics?: string[];
  files?: string[];
  decisions?: { what: string; why?: string; seq?: number[] }[];
  openThreads?: string[];
  /** prompts-only, i.e. a ghost card */
  ghost?: boolean;
  /** seqs that exist as exchanges. Defaults to every seq the decisions cite. */
  exchangeSeqs?: number[];
}

/**
 * One carded session (or ghost) in the index.
 *
 * Writes the same three rows `cards/write.ts` and `ingest.ts` write — the card,
 * the session or ghost it belongs to, and the exchanges its `evidence_seq`
 * points at — because the rule pass resolves citations against the transcript
 * and a fixture without exchanges would silently drop every decision.
 */
function addCard(db: Db, spec: CardSpec): string {
  const id = spec.id ?? uuid('c');
  const decisions = (spec.decisions ?? []).map((d) => ({
    what: d.what,
    why: d.why ?? '',
    evidence_seq: d.seq ?? [1],
  }));

  if (spec.ghost) {
    db.prepare(
      'INSERT INTO ghosts (session_id, harness, project, first_ts, prompt_count) VALUES (?,?,?,?,?)',
    ).run(id, 'claude', spec.project, '2026-07-01T10:00:00.000Z', 3);
  } else {
    db.prepare(
      'INSERT INTO sessions (id, harness, project, started_at, status) VALUES (?,?,?,?,?)',
    ).run(id, 'claude', spec.project, '2026-07-01T10:00:00.000Z', 'archived');
    const seqs =
      spec.exchangeSeqs ?? [...new Set(decisions.flatMap((d) => d.evidence_seq))].sort();
    for (const seq of seqs) {
      db.prepare(
        'INSERT INTO exchanges (id, session_id, seq, ts, user_text, assistant_text) VALUES (?,?,?,?,?,?)',
      ).run(`${id}#${seq}`, id, seq, `2026-07-01T1${seq % 10}:00:00.000Z`, 'q', 'a');
    }
  }

  db.prepare(
    `INSERT INTO cards (session_id, title, summary, topics, decisions, files, outcome, open_threads, source)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    'a card',
    'what happened',
    JSON.stringify(spec.topics ?? []),
    JSON.stringify(decisions),
    JSON.stringify(spec.files ?? []),
    'shipped',
    JSON.stringify((spec.openThreads ?? []).map((w) => ({ what: w, evidence_seq: [1] }))),
    spec.ghost ? 'prompts-only' : 'transcript',
  );
  return id;
}

const LEDGER = '/Users/example/Ledger';
const BRAINSTORE = '/Users/example/brainstore';

/** The shared vocabulary that makes two projects siblings rather than strangers. */
const SIBLING_TOPICS = ['pgbouncer', 'prepared statements', 'connection pooling', 'postgres'];
const SIBLING_FILES = ['db/pool.ts', 'db/migrate.ts'];

/** The decision under test, in A's words. */
const DECIDED = {
  what: 'disable prepared statements when pgbouncer runs in transaction pooling mode',
  why: 'pgbouncer cannot route a prepared statement to the same backend twice',
  seq: [7],
};

// ------------------------------------------------------------------ the rule

describe('T4.2 rule pass — "decided in A, never seen in B"', () => {
  it('produces one candidate when B genuinely never mentions the decision', () => {
    const db = memDb();
    const a = addCard(db, {
      project: LEDGER,
      topics: SIBLING_TOPICS,
      files: SIBLING_FILES,
      decisions: [DECIDED],
    });
    addCard(db, {
      project: BRAINSTORE,
      topics: SIBLING_TOPICS,
      files: SIBLING_FILES,
      decisions: [{ what: 'move the nightly ingest onto a cron schedule', seq: [2] }],
    });

    const found = openThreadCandidates(db, [a]);
    expect(found).toHaveLength(1);
    const c = found[0]!;
    expect(c.what).toBe(DECIDED.what);
    expect(c.why).toBe(DECIDED.why);
    expect(c.project).toBe(LEDGER);
    expect(c.otherProject).toBe(BRAINSTORE);
    // Cited or dropped: the positive half of the claim is checkable.
    // Was `expect(c.evidenceSeq).toBe(7)` — changed in T4.5 (D3) because the
    // field is now every resolving seq, not the lowest one. Same seq, new shape.
    expect(c.evidenceSeqs).toEqual([7]);
    expect(c.id8).toBe(a.slice(0, 8));
    expect(c.ts).toBe('2026-07-01T17:00:00.000Z'); // the cited exchange's ts, not the session's
    expect(c.otherSessionIds.length).toBe(1);
    expect(c.overlap.topics).toContain('pgbouncer');
    expect(c.overlap.files).toContain('db/pool.ts');
    expect(c.score).toBeGreaterThan(0);
  });

  // --- D3 (T4.5). `CardClaim.evidence_seq` is `number[]`; T4.2 pinned the
  // candidate to the lowest resolving seq alone, so a decision citing three
  // exchanges arrived carrying one and the other two were unreachable from the
  // thread. These two tests are what stops it narrowing again.
  it('carries every citation the decision made, not just the lowest', () => {
    const db = memDb();
    const a = addCard(db, {
      project: LEDGER,
      topics: SIBLING_TOPICS,
      files: SIBLING_FILES,
      decisions: [{ ...DECIDED, seq: [7, 12, 31] }],
    });
    addCard(db, {
      project: BRAINSTORE,
      topics: SIBLING_TOPICS,
      files: SIBLING_FILES,
      decisions: [{ what: 'move the nightly ingest onto a cron schedule', seq: [2] }],
    });

    const c = openThreadCandidates(db, [a])[0]!;
    expect(c.evidenceSeqs).toEqual([7, 12, 31]);
    // The timestamp is still the first resolving exchange's, unchanged by the
    // widening, so a reader lands where T4.2's candidate pointed them.
    expect(c.ts).toBe('2026-07-01T17:00:00.000Z');
  });

  it('keeps only the seqs that resolve, so every one of them can be read', () => {
    const db = memDb();
    const a = addCard(db, {
      project: LEDGER,
      topics: SIBLING_TOPICS,
      files: SIBLING_FILES,
      decisions: [{ ...DECIDED, seq: [7, 999] }],
      // 999 is cited by the card and is not an exchange of this session.
      exchangeSeqs: [7],
    });
    addCard(db, {
      project: BRAINSTORE,
      topics: SIBLING_TOPICS,
      files: SIBLING_FILES,
      decisions: [{ what: 'move the nightly ingest onto a cron schedule', seq: [2] }],
    });

    const c = openThreadCandidates(db, [a])[0]!;
    expect(c.evidenceSeqs).toEqual([7]);
    expect(c.evidenceSeqs).not.toContain(999);
  });

  it('produces nothing when B did contain the decision, in different words', () => {
    const db = memDb();
    const a = addCard(db, {
      project: LEDGER,
      topics: SIBLING_TOPICS,
      files: SIBLING_FILES,
      decisions: [DECIDED],
    });
    // Same projects, same files, same topics — and B decided it too. This is
    // the false positive that reads as insight, and it must not be raised.
    addCard(db, {
      project: BRAINSTORE,
      topics: SIBLING_TOPICS,
      files: SIBLING_FILES,
      decisions: [
        {
          what: 'turn off prepared statements for pgbouncer transaction pooling',
          seq: [4],
        },
      ],
    });

    expect(openThreadCandidates(db, [a])).toEqual([]);
  });

  it('counts an open thread in B as B having seen it', () => {
    const db = memDb();
    const a = addCard(db, {
      project: LEDGER,
      topics: SIBLING_TOPICS,
      files: SIBLING_FILES,
      decisions: [DECIDED],
    });
    addCard(db, {
      project: BRAINSTORE,
      topics: SIBLING_TOPICS,
      files: SIBLING_FILES,
      decisions: [{ what: 'move the nightly ingest onto a cron schedule', seq: [2] }],
      openThreads: ['prepared statements still on under pgbouncer transaction pooling'],
    });

    // "Never seen in B" is false when B has it written down as a question.
    expect(openThreadCandidates(db, [a])).toEqual([]);
  });

  it('does not fire when the only overlap is a single generic token', () => {
    const db = memDb();
    // The brief's case: two projects that happen to share the word "auth".
    const a = addCard(db, {
      project: LEDGER,
      topics: ['auth', 'pgbouncer', 'prepared statements'],
      files: ['db/pool.ts'],
      decisions: [{ what: 'rotate the auth signing key every ninety days', seq: [3] }],
    });
    addCard(db, {
      project: '/Users/example/field_notes',
      topics: ['auth', 'quadratics', 'worksheets'],
      files: ['sheets/algebra.md'],
      decisions: [{ what: 'generate one worksheet per topic', seq: [1] }],
    });

    expect(openThreadCandidates(db, [a])).toEqual([]);
  });

  it('does not fire across a project and its own subdirectory', () => {
    const db = memDb();
    const a = addCard(db, {
      project: BRAINSTORE,
      topics: SIBLING_TOPICS,
      files: SIBLING_FILES,
      decisions: [DECIDED],
    });
    addCard(db, {
      project: `${BRAINSTORE}/docs`,
      topics: SIBLING_TOPICS,
      files: SIBLING_FILES,
      decisions: [{ what: 'document the runbook', seq: [1] }],
    });

    expect(openThreadCandidates(db, [a])).toEqual([]);
    expect(sameProject(BRAINSTORE, `${BRAINSTORE}/docs`)).toBe(true);
    expect(sameProject(BRAINSTORE, LEDGER)).toBe(false);
    expect(sameProject(BRAINSTORE, '/Users/example/brainstore-old')).toBe(false);
  });

  it('drops a decision whose evidence_seq resolves to no exchange', () => {
    const db = memDb();
    const a = addCard(db, {
      project: LEDGER,
      topics: SIBLING_TOPICS,
      files: SIBLING_FILES,
      decisions: [{ ...DECIDED, seq: [99] }],
      exchangeSeqs: [1, 2, 3], // 99 is not among them
    });
    addCard(db, { project: BRAINSTORE, topics: SIBLING_TOPICS, files: SIBLING_FILES });

    expect(openThreadCandidates(db, [a])).toEqual([]);
  });

  it('drops a decision that cites nothing at all', () => {
    const db = memDb();
    const a = addCard(db, {
      project: LEDGER,
      topics: SIBLING_TOPICS,
      files: SIBLING_FILES,
      decisions: [{ ...DECIDED, seq: [] }],
      exchangeSeqs: [1, 2, 3],
    });
    addCard(db, { project: BRAINSTORE, topics: SIBLING_TOPICS, files: SIBLING_FILES });

    // "Cited or dropped": an uncited decision is dropped, not marked, because
    // the negative half of an open thread can never be cited either.
    expect(openThreadCandidates(db, [a])).toEqual([]);
  });

  it('honours the limit and orders by score', () => {
    const db = memDb();
    const a = addCard(db, {
      project: LEDGER,
      topics: SIBLING_TOPICS,
      files: SIBLING_FILES,
      decisions: [
        DECIDED,
        { what: 'pin the postgres connection pooling maximum to sixteen', seq: [8] },
        { what: 'run migrate against the pgbouncer postgres replica first', seq: [9] },
      ],
    });
    addCard(db, {
      project: BRAINSTORE,
      topics: SIBLING_TOPICS,
      files: SIBLING_FILES,
      decisions: [{ what: 'move the nightly ingest onto a cron schedule', seq: [2] }],
    });

    const all = openThreadCandidates(db, [a]);
    expect(all.length).toBeGreaterThan(1);
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1]!.score).toBeGreaterThanOrEqual(all[i]!.score);
    }
    expect(openThreadCandidates(db, [a], { limit: 1 })).toHaveLength(1);
    expect(openThreadCandidates(db, [a], { limit: 0 })).toEqual([]);
  });

  it('raises one line per decision, not one per sibling project', () => {
    const db = memDb();
    const a = addCard(db, {
      project: LEDGER,
      topics: SIBLING_TOPICS,
      files: SIBLING_FILES,
      decisions: [DECIDED],
    });
    // Two related projects, neither of which ever mentions it. That is still
    // one claim, and `OpenThreadCandidate` can name only one `otherProject`.
    for (const p of [BRAINSTORE, '/Users/example/orbiter']) {
      addCard(db, {
        project: p,
        topics: SIBLING_TOPICS,
        files: SIBLING_FILES,
        decisions: [{ what: 'move the nightly ingest onto a cron schedule', seq: [2] }],
      });
    }

    const found = openThreadCandidates(db, [a]);
    expect(found).toHaveLength(1);
    expect(found[0]!.what).toBe(DECIDED.what);
  });

  it('collapses the same decision reached from two sessions of A', () => {
    const db = memDb();
    const a1 = addCard(db, {
      project: LEDGER,
      topics: SIBLING_TOPICS,
      files: SIBLING_FILES,
      decisions: [DECIDED],
    });
    const a2 = addCard(db, {
      project: LEDGER,
      topics: SIBLING_TOPICS,
      files: SIBLING_FILES,
      decisions: [DECIDED],
    });
    addCard(db, {
      project: BRAINSTORE,
      topics: SIBLING_TOPICS,
      files: SIBLING_FILES,
      decisions: [{ what: 'move the nightly ingest onto a cron schedule', seq: [2] }],
    });

    expect(openThreadCandidates(db, [a1, a2])).toHaveLength(1);
  });

  it('returns nothing rather than throwing on an empty index', () => {
    const db = memDb();
    expect(openThreadCandidates(db, [])).toEqual([]);
    expect(openThreadCandidates(db, ['not-a-session'])).toEqual([]);
  });
});

// ------------------------------------------------------------------ ghosts

describe('T4.2 ghost cards — weak evidence may withdraw a candidate, never raise one', () => {
  it('never raises a candidate from a ghost card decision', () => {
    const db = memDb();
    // A ghost card is built from prompts only (`cards/ghost.ts`): there is no
    // assistant side, so a "decision" on one is a decision the user typed
    // about, not one the transcript shows being made.
    const ghost = addCard(db, {
      project: LEDGER,
      topics: SIBLING_TOPICS,
      files: SIBLING_FILES,
      decisions: [DECIDED],
      ghost: true,
    });
    addCard(db, {
      project: BRAINSTORE,
      topics: SIBLING_TOPICS,
      files: SIBLING_FILES,
      decisions: [{ what: 'move the nightly ingest onto a cron schedule', seq: [2] }],
    });

    expect(openThreadCandidates(db, [ghost])).toEqual([]);
  });

  it('lets a ghost card in B withdraw a candidate', () => {
    const db = memDb();
    const a = addCard(db, {
      project: LEDGER,
      topics: SIBLING_TOPICS,
      files: SIBLING_FILES,
      decisions: [DECIDED],
    });
    // B's only card is a ghost, and it mentions the decision. The prompts are
    // too weak to accuse anyone of anything, and quite strong enough to say
    // "this did come up over there" — which is all a withdrawal needs.
    addCard(db, {
      project: BRAINSTORE,
      topics: SIBLING_TOPICS,
      files: SIBLING_FILES,
      decisions: [
        { what: 'turn off prepared statements for pgbouncer transaction pooling', seq: [1] },
      ],
      ghost: true,
    });

    expect(openThreadCandidates(db, [a])).toEqual([]);
  });

  it('a ghost in B that says nothing relevant does not suppress the candidate', () => {
    const db = memDb();
    const a = addCard(db, {
      project: LEDGER,
      topics: SIBLING_TOPICS,
      files: SIBLING_FILES,
      decisions: [DECIDED],
    });
    addCard(db, {
      project: BRAINSTORE,
      topics: SIBLING_TOPICS,
      files: SIBLING_FILES,
      decisions: [{ what: 'move the nightly ingest onto a cron schedule', seq: [1] }],
      ghost: true,
    });

    expect(openThreadCandidates(db, [a])).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ constants

describe('T4.2 constants are measured, and this test fails when one moves', () => {
  /**
   * `docs/08-STATE-OF-PLAY.md`: a constant that sat at the wrong value for a
   * day while all 81 card tests passed at either value is a documented failure
   * of this project. So the value is asserted directly, and the labelled pairs
   * from the control run are replayed through the same arithmetic the rule pass
   * uses.
   *
   * The control is in `phases/phase-4/evidence-T4.2/mention-control.md`.
   */
  it('MENTION_COSINE is 0.35', () => {
    expect(MENTION_COSINE).toBe(0.35);
  });

  it('sits above the largest non-match the corpus produced', () => {
    // 194 (decision in A, project B) pairs were generated from the reference
    // corpus with the bar off and read by hand at the top of the distribution.
    // Every one was a non-match; the largest reached 0.3223. The bar is above
    // it by construction, and this asserts the relationship rather than the
    // bare number so that moving one without the other fails.
    expect(MEASURED_NONMATCH_MAX).toBe(0.3223);
    expect(MENTION_COSINE).toBeGreaterThan(MEASURED_NONMATCH_MAX);

    // The corpus's own maximum, replayed through the same arithmetic the rule
    // pass uses: two different decisions that share the word "audit".
    const worstCoincidence = tokenCosine(
      new Set(
        contentTokens(
          'Launch four-agent comprehensive wall audit (pentest, plan-vs-code, architecture, code-quality) ' +
            'Find missing loopholes and problems; verify phase plans implemented; ensure interconnection and testing coverage',
        ),
      ),
      new Set(
        contentTokens(
          'Design 8-phase implementation plan with rescue/audit as phase 0, launch as phase 7',
        ),
      ),
    );
    // It must not be withdrawn: it is not the same decision.
    expect(worstCoincidence).toBeLessThan(MENTION_COSINE);
  });

  it('is a weak guard, and the overlap that makes it weak is real', () => {
    // The honest limit of the measurement: the positive side is n = 0. The
    // corpus contains no case of B genuinely restating A's decision, so
    // nothing measured shows this bar catches one. These synthetic paraphrase
    // pairs are what a positive would look like, and they straddle the bar —
    // which is the point of this test. If this ever starts passing as a clean
    // separation, the statistic changed and the comment on MENTION_COSINE is
    // out of date.
    const paraphrases: [string, string][] = [
      [
        'disable prepared statements when pgbouncer runs in transaction pooling mode',
        'turn off prepared statements for pgbouncer transaction pooling',
      ],
      [
        'redact secrets at index time rather than at query time',
        'redaction runs during indexing, not when a query is served',
      ],
      [
        'use sqlite fts5 with an external content table for the card index',
        'card index is fts5 external content over the cards table',
      ],
      [
        'cap reader fan-out at six sessions for the ask verb',
        'ask fans out to at most six reader sessions',
      ],
    ];
    // Plainly unrelated pairs, for the floor of the distribution.
    const unrelated: [string, string][] = [
      [
        'disable prepared statements when pgbouncer runs in transaction pooling mode',
        'move the nightly ingest onto a cron schedule',
      ],
      [
        'redact secrets at index time rather than at query time',
        'rename the settings file to config.json',
      ],
      [
        'use sqlite fts5 with an external content table for the card index',
        'switch the worksheet generator to landscape layout',
      ],
      [
        'cap reader fan-out at six sessions for the ask verb',
        'add a dark theme to the dashboard',
      ],
    ];

    const score = ([x, y]: [string, string]) =>
      tokenCosine(new Set(contentTokens(x)), new Set(contentTokens(y)));

    const paraphraseScores = paraphrases.map(score);
    const lowestParaphrase = Math.min(...paraphraseScores);
    const highestParaphrase = Math.max(...paraphraseScores);

    // Unrelated text stays far below the bar. That much the statistic does do.
    expect(Math.max(...unrelated.map(score))).toBeLessThan(MENTION_COSINE);

    // But a real paraphrase can land on either side of it: some restatements
    // are withdrawn and some are not. This is the overlap with the measured
    // non-match distribution (max 0.3223) and it is why the module says the
    // mention check is not the guard.
    expect(lowestParaphrase).toBeLessThan(MENTION_COSINE);
    expect(highestParaphrase).toBeGreaterThan(MENTION_COSINE);
    expect(lowestParaphrase).toBeLessThan(MEASURED_NONMATCH_MAX);
  });

  it('pins the structural minimums and the label', () => {
    expect(MIN_ANCHOR_TOKENS).toBe(2);
    expect(MIN_PROJECT_OVERLAP).toBe(3);
    expect(GENERIC_DF).toBe(0.3);
    expect(CONFIRM_BATCH).toBe(12);
    // `05`: the renderer says "possible open thread", never "open thread".
    expect(OPEN_THREAD_LABEL).toBe('possible open thread');
  });

  it('tokenCosine is a cosine over token memberships', () => {
    expect(tokenCosine(new Set(['a']), new Set())).toBe(0);
    expect(tokenCosine(new Set(['pgbouncer']), new Set(['pgbouncer']))).toBe(1);
    expect(tokenCosine(new Set(['pgbouncer']), new Set(['cron']))).toBe(0);
  });
});

// ------------------------------------------------------------------ model pass

class Replying implements Transport {
  readonly sent: SendRequest[] = [];
  closed = 0;
  constructor(
    private readonly replies: string[],
    readonly backend: Backend = 'agent-sdk',
  ) {}
  async send(req: SendRequest): Promise<SendResult> {
    this.sent.push(req);
    const reply = this.replies[Math.min(this.sent.length - 1, this.replies.length - 1)] ?? '{}';
    return { text: reply, inputTokens: 10, outputTokens: 40, usd: 0 };
  }
  async close(): Promise<void> {
    this.closed += 1;
  }
}

class Failing implements Transport {
  readonly backend: Backend = 'agent-sdk';
  async send(): Promise<SendResult> {
    throw new Error('backend went away');
  }
  async close(): Promise<void> {}
}

function candidate(over: Partial<OpenThreadCandidate> = {}): OpenThreadCandidate {
  return {
    what: DECIDED.what,
    why: DECIDED.why,
    sessionId: '4c9339e0-0000-4000-8000-000000000000',
    id8: '4c9339e0',
    project: LEDGER,
    ts: '2026-07-01T17:00:00.000Z',
    evidenceSeqs: [7],
    otherProject: BRAINSTORE,
    otherSessionIds: ['9c4d2f18-0000-4000-8000-000000000000'],
    overlap: { files: ['db/pool.ts'], topics: ['pgbouncer'] },
    score: 4,
    ...over,
  };
}

describe('T4.2 model pass — advisory, batched, and overruled in code', () => {
  it('rejects a candidate, and the rejection carries the model sentence', async () => {
    const t = new Replying([
      JSON.stringify({
        results: [
          { i: 0, confirmed: true, note: 'brainstore uses the same pooler and never turned this off.' },
          { i: 1, confirmed: false, note: 'the two projects only share the word postgres.' },
        ],
      }),
    ]);
    const cands = [candidate(), candidate({ what: 'rename the config file', score: 1 })];
    const out = await confirmOpenThreads(cands, { llm: Llm.open({ transport: t }) });

    expect(out).toHaveLength(2);
    expect(out[0]!.confirmed).toBe(true);
    expect(out[1]!.confirmed).toBe(false);
    expect(out[1]!.note).toBe('the two projects only share the word postgres.');
    // The caller drops `confirmed:false`; the rejected candidate is not shown.
    expect(out.filter((o) => o.confirmed).map((o) => o.what)).toEqual([DECIDED.what]);
  });

  it('confirms N candidates in one call, not N calls', async () => {
    const results = Array.from({ length: CONFIRM_BATCH }, (_, i) => ({
      i,
      confirmed: true,
      note: `candidate ${i} looks real.`,
    }));
    const t = new Replying([JSON.stringify({ results })]);
    const cands = Array.from({ length: CONFIRM_BATCH }, (_, i) =>
      candidate({ what: `decision number ${i} about pgbouncer pooling`, score: i }),
    );

    const out = await confirmOpenThreads(cands, { llm: Llm.open({ transport: t }) });
    expect(out.filter((o) => o.confirmed)).toHaveLength(CONFIRM_BATCH);
    // The whole point of the batch: a real haiku-class call is 60–160 s.
    expect(t.sent).toHaveLength(1);
  });

  it('chunks past the batch size rather than truncating', async () => {
    const reply = (offset: number) =>
      JSON.stringify({
        results: Array.from({ length: CONFIRM_BATCH }, (_, i) => ({
          i,
          confirmed: true,
          note: `verdict ${offset + i}.`,
        })),
      });
    const t = new Replying([reply(0), reply(CONFIRM_BATCH)]);
    const cands = Array.from({ length: CONFIRM_BATCH + 3 }, (_, i) =>
      candidate({ what: `decision ${i}`, score: i }),
    );

    const out = await confirmOpenThreads(cands, { llm: Llm.open({ transport: t }) });
    expect(out).toHaveLength(CONFIRM_BATCH + 3);
    expect(t.sent).toHaveLength(2);
    expect(out.every((o) => o.confirmed)).toBe(true);
  });

  it('overrules a confirmation of a candidate the card cannot cite', async () => {
    const t = new Replying([
      JSON.stringify({
        results: [{ i: 0, confirmed: true, note: 'this is definitely an open thread.' }],
      }),
    ]);
    // The ruling: the prompt is not the guard, the code is.
    const out = await confirmOpenThreads([candidate({ evidenceSeqs: [] })], {
      llm: Llm.open({ transport: t }),
    });
    expect(out[0]!.confirmed).toBe(false);
    expect(out[0]!.note).toMatch(/evidence_seq/);
  });

  it('keeps its own fields when the model rewrites them', async () => {
    const t = new Replying([
      JSON.stringify({
        results: [
          {
            i: 0,
            confirmed: true,
            note: 'yes.',
            what: 'something the model made up',
            otherProject: '/Users/example/not-a-project',
            evidenceSeqs: [4242],
          },
        ],
      }),
    ]);
    const out = await confirmOpenThreads([candidate()], { llm: Llm.open({ transport: t }) });
    expect(out[0]!.what).toBe(DECIDED.what);
    expect(out[0]!.otherProject).toBe(BRAINSTORE);
    expect(out[0]!.evidenceSeqs).toEqual([7]);
  });

  it('discards a verdict for a candidate it never sent', async () => {
    const t = new Replying([
      JSON.stringify({
        results: [
          { i: 0, confirmed: true, note: 'real.' },
          { i: 9, confirmed: true, note: 'a verdict about nothing.' },
        ],
      }),
    ]);
    const out = await confirmOpenThreads([candidate()], { llm: Llm.open({ transport: t }) });
    expect(out).toHaveLength(1);
    expect(out[0]!.note).toBe('real.');
  });

  it('does not confirm without a reason', async () => {
    const t = new Replying([
      JSON.stringify({ results: [{ i: 0, confirmed: true, note: '' }] }),
    ]);
    const out = await confirmOpenThreads([candidate()], { llm: Llm.open({ transport: t }) });
    expect(out[0]!.confirmed).toBe(false);
  });

  it('clamps a paragraph to one sentence', async () => {
    const t = new Replying([
      JSON.stringify({
        results: [
          {
            i: 0,
            confirmed: true,
            note: 'brainstore shares the pooler. It also shares the migration script. And more.',
          },
        ],
      }),
    ]);
    const out = await confirmOpenThreads([candidate()], { llm: Llm.open({ transport: t }) });
    expect(out[0]!.note).toBe('brainstore shares the pooler.');
  });

  it('returns unconfirmed candidates when the backend fails mid-call', async () => {
    const out = await confirmOpenThreads([candidate()], {
      llm: Llm.open({ transport: new Failing() }),
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.confirmed).toBe(false);
    expect(out[0]!.note).toMatch(/did not run/);
  });

  it('returns unconfirmed candidates when both parse attempts fail', async () => {
    const t = new Replying(['not json at all', 'still not json']);
    const out = await confirmOpenThreads([candidate()], { llm: Llm.open({ transport: t }) });
    expect(out[0]!.confirmed).toBe(false);
    expect(out[0]!.note).toMatch(/no verdict/);
  });

  it('is a no-op on an empty candidate list and calls nothing', async () => {
    const t = new Replying(['{}']);
    expect(await confirmOpenThreads([], { llm: Llm.open({ transport: t }) })).toEqual([]);
    expect(t.sent).toHaveLength(0);
  });

  it('sends the decision, both projects and the overlap, and nothing else', async () => {
    const t = new Replying([JSON.stringify({ results: [{ i: 0, confirmed: false, note: 'no.' }] })]);
    await confirmOpenThreads([candidate()], { llm: Llm.open({ transport: t }) });
    const sent = t.sent[0]!;
    expect(sent.prompt).toContain(DECIDED.what);
    expect(sent.prompt).toContain(LEDGER);
    expect(sent.prompt).toContain(BRAINSTORE);
    expect(sent.prompt).toContain('db/pool.ts');
    // The absence is arithmetic and is not the model's to re-decide.
    expect(sent.system).toMatch(/not your job/);
  });
});

// ------------------------------------------------------------------ no model

/**
 * The ruling, in the brief's words: *`confirmOpenThreads` must work with no
 * LLM available: if `detectBackend` finds nothing, return every candidate with
 * `confirmed:false` and a note saying no model was available — the caller then
 * shows nothing. `ask` must never fail because open threads could not be
 * confirmed.*
 *
 * `ConfirmOptions` has no `env` seam, so the environment itself is what gets
 * stubbed: an empty `PATH` makes `onPath('claude')` and `onPath('codex')` both
 * fail, and with no `ANTHROPIC_API_KEY` `detectBackend` has nothing left to
 * choose and throws `NoBackendError`. That is exactly the machine this ruling
 * is about.
 */
describe('T4.2 no-LLM ruling', () => {
  const GUARDED = [
    'PATH',
    'ANTHROPIC_API_KEY',
    'POTSHERD_LLM_BACKEND',
    'POTSHERD_MODEL',
    'POTSHERD_LLM_GUARD',
    'POTSHERD_HARNESS',
    'CODEX_HOME',
    'CODEX_SANDBOX',
  ] as const;

  async function withNoBackend<T>(fn: () => Promise<T>): Promise<T> {
    const saved = new Map(GUARDED.map((k) => [k, process.env[k]]));
    for (const k of GUARDED) delete process.env[k];
    process.env['PATH'] = '';
    try {
      return await fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it('marks every candidate unconfirmed when detectBackend finds nothing', async () => {
    const out = await withNoBackend(() =>
      confirmOpenThreads([candidate(), candidate({ what: 'another decision' })]),
    );
    expect(out).toHaveLength(2);
    expect(out.every((o) => o.confirmed === false)).toBe(true);
    expect(out.every((o) => o.note === NO_MODEL_NOTE)).toBe(true);
    // The candidate's own fields survive intact, so a caller that wanted to
    // print them anyway still could.
    expect(out[0]!.what).toBe(DECIDED.what);
    expect(out[0]!.evidenceSeqs).toEqual([7]);
  });

  it('NO_MODEL_NOTE says plainly that nothing was confirmed', () => {
    expect(NO_MODEL_NOTE).toMatch(/no model was available/);
  });

  it('a failing backend is the same contract: unconfirmed, never thrown', async () => {
    const out = await confirmOpenThreads([candidate()], {
      llm: Llm.open({ transport: new Failing() }),
    });
    expect(out.every((o) => o.confirmed === false)).toBe(true);
  });
});

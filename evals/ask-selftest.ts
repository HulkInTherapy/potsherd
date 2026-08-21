#!/usr/bin/env tsx
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  GATE_COVERAGE,
  STRICT_EXIT,
  checkCitations,
  checkCoverage,
  checkDecoy,
  isDecoy,
  readSet,
  verdictFor,
  type AskDecoy,
  type AskGold,
  type Corpus,
  type DecoyLeak,
  type DecoyRow,
  type GoldRow,
  type OverlapRow,
} from './ask-run.js';
import type { AskResult } from '../packages/core/src/ask.js';

/**
 * T4.0 — the scorer's own test. `tsx evals/ask-selftest.ts`.
 *
 * `evals/ask-run.ts` cannot be run on this branch: `packages/core/src/ask.ts` is T4.1's file and
 * does not exist yet, by design — the questions were written by a worker who never saw the
 * implementation. So the harness is proved the only way it can be, which is also the better way:
 * `AskResult` objects are built by hand, each one broken in one specific place, and the scorer
 * has to say the right thing about each.
 *
 * Every case below asserts a **failing** verdict except the first. That is the whole point. An
 * eval harness that has never been observed failing is a harness nobody has tested; phase 1's
 * 10/10 and `run.ts`'s two rounds of measuring nothing are what this file exists to prevent
 * happening a third time. If any of these stops failing, the scorer is broken — fix the scorer,
 * not this test.
 *
 * The corpus is a stub map of `(sessionId, seq) -> text`, holding real lines from
 * `evals/fixture/claude`, so "the quote occurs in the cited exchange" is checked against text
 * that genuinely exists somewhere in the fixture. Nothing here touches an index, a model or a
 * network.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------ the stub corpus
//
// Four real units from evals/fixture/claude: two exchanges, one subagent exchange and one ghost
// prompt (ghost seq is 0-based, which is itself worth having in the fixture for this test).

const RAMP = '6b3a9e24-8f05-4c31-b7d2-1a94e6035cb7:agent-p4a';
const CRON = '4ddd4b1f-8f16-40c8-8970-658738871ba0';
const OOM = 'b52e8c07-6a31-4d94-8f26-c30719ad5e48';

const TEXTS = new Map<string, string>([
  [
    `${RAMP}@1`,
    'run the ramp to a thousand virtual users and report where it breaks\n' +
      'It holds to three hundred and eighty a second. Past that the ninety-ninth percentile goes ' +
      'from a hundred and twenty milliseconds to four seconds, because the connection wait queue never drains.',
  ],
  [`${CRON}@0`, 'the billing cron runs for forty minutes and blocks the nightly backup'],
  [`${CRON}@1`, 'move the billing cron onto a queue so it can run in parallel'],
  [
    `${OOM}@1`,
    'the pod is killed with exit code 137 a few times a day and comes straight back\n' +
      'OOMKilled. The limit is 512Mi and the heap alone reaches it under load; raise the limit and set the heap under it.',
  ],
  [
    `${OOM}@2`,
    'why only in the afternoon\n' +
      'That is when the report job runs on the same node and takes the headroom the kubelet was counting on.',
  ],
]);

const STUB: Corpus = { text: (id, seq) => TEXTS.get(`${id}@${seq}`) ?? null };

/** For the coverage cases: gate (a) must not be what fails, so every quote resolves. */
const PERMISSIVE: Corpus = { text: () => 'anything at all' };

// --------------------------------------------------------------------- builders

function result(over: Partial<AskResult>): AskResult {
  return {
    question: 'q',
    answer: '',
    sentences: [],
    dropped: [],
    evidence: [],
    openThreads: [],
    searched: 6,
    matching: 6,
    readers: [],
    refused: false,
    strict: false,
    spend: { usd: 0, inputTokens: 0, outputTokens: 0, calls: 0 },
    estimated: true,
    ms: 1,
    ...over,
  } as unknown as AskResult;
}

let nextIndex = 1;
function ev(sessionId: string, seq: number, quote: string, index?: number): AskResult['evidence'][number] {
  return {
    index: index ?? nextIndex++,
    sessionId,
    id8: sessionId.slice(0, 8),
    project: '/tmp/potsherd-eval-fixture',
    harness: 'claude',
    seq,
    ts: '2026-06-08T15:00:00.000Z',
    quote,
    isSidechain: sessionId.includes(':agent-'),
    isGhost: sessionId === CRON,
  } as unknown as AskResult['evidence'][number];
}

const honestOverlap = (g: AskGold): OverlapRow => ({
  id: g.id,
  question: g.question,
  text: g.overlap,
  card: 0,
  recorded: g.overlap,
  measured: g.overlap,
  shared: [],
  flagged: false,
  dishonest: false,
});

const soundDecoy = (d: AskDecoy): DecoyLeak => ({ id: d.id, best: 0.2, where: 'x', shared: [], leaked: false });

// ------------------------------------------------------------------- the fixtures
//
// The committed set is loaded rather than mocked, so the coverage cases exercise the real
// expectSessions and the real expectPhrases, and so this file also proves something about the
// set itself: every hand-written gold answer satisfies its own phrase gate and names its own
// sessions. A gold answer that could not pass its own question would be a set nothing can pass.

const cases = readSet(path.join(here, 'ask.jsonl'));
const GOLD = cases.filter((c): c is AskGold => !isDecoy(c));
const DECOYS = cases.filter(isDecoy);

/** A gold row whose result is the hand-written gold answer, cited to the first expected seq. */
function goldRow(g: AskGold, covered: boolean): GoldRow {
  const [sid, seq] = g.expectSeqs[0]!;
  const r = covered
    ? result({
        question: g.question,
        answer: g.gold,
        sentences: [{ text: g.gold, cites: [1] }],
        evidence: [ev(sid, seq, 'anything at all', 1)],
      })
    // An uncovered row is empty rather than wrong: no answer, no sentences, no evidence. That
    // keeps gate (a) clean so the coverage case fails (b) and only (b) — a case that trips two
    // gates at once proves neither of them.
    : result({ question: g.question, answer: '', sentences: [], evidence: [] });
  return { gold: g, result: r, faults: checkCitations(r, PERMISSIVE), coverage: checkCoverage(r, g), ms: 1 };
}

function decoyRow(d: AskDecoy, refused: boolean, cliExit: number): DecoyRow {
  const r = refused
    ? result({ question: d.question, refused: true, strict: true })
    : // The guess `--strict` exists to prevent: a real exchange cited for a claim it does not
      // make. The quote is `anything at all` only so that PERMISSIVE resolves it and gate (a)
      // stays clean — the failure under test is (c), not the citation.
      result({
        question: d.question,
        strict: true,
        answer: 'A token bucket at 20 requests per second with a jittered retry on 429.',
        sentences: [{ text: 'A token bucket at 20 requests per second with a jittered retry on 429.', cites: [1] }],
        evidence: [ev(RAMP, 1, 'anything at all', 1)],
      });
  return { decoy: d, result: r, faults: checkCitations(r, PERMISSIVE), outcome: checkDecoy(r, cliExit, 'stub'), ms: 1 };
}

// --------------------------------------------------------------------- the cases

interface Case {
  name: string;
  /** What the scorer must say. */
  want: 'pass' | 'fail-a' | 'fail-b' | 'fail-c' | 'fail-set';
  run: () => { pass: boolean; a: boolean; b: boolean; c: boolean; set: boolean; why: string };
}

/** Score one hand-built gold result against g01, with everything else in the set clean. */
function withGoldResult(r: AskResult, corpus: Corpus): Case['run'] {
  return () => {
    const g01 = GOLD[0]!;
    const broken: GoldRow = {
      gold: g01,
      result: r,
      faults: checkCitations(r, corpus),
      coverage: checkCoverage(r, g01),
      ms: 1,
    };
    const rows = [broken, ...GOLD.slice(1).map((g) => goldRow(g, true))];
    const decoys = DECOYS.map((d) => decoyRow(d, true, STRICT_EXIT));
    const v = verdictFor(rows, decoys, GOLD.map(honestOverlap), DECOYS.map(soundDecoy));
    return {
      pass: v.pass,
      a: v.citations.pass,
      b: v.coverage.pass,
      c: v.decoys.pass,
      set: v.set.pass,
      why: broken.faults.map((f) => f.kind).join(',') || 'no faults',
    };
  };
}

const CASES: Case[] = [
  {
    name: 'clean — 10/10 covered, every quote resolves, 3/3 refused',
    want: 'pass',
    run: () => {
      const rows = GOLD.map((g) => goldRow(g, true));
      const decoys = DECOYS.map((d) => decoyRow(d, true, STRICT_EXIT));
      const v = verdictFor(rows, decoys, GOLD.map(honestOverlap), DECOYS.map(soundDecoy));
      return {
        pass: v.pass,
        a: v.citations.pass,
        b: v.coverage.pass,
        c: v.decoys.pass,
        set: v.set.pass,
        why: `${v.coverage.covered}/${v.coverage.total} covered, ${v.decoys.refused}/${v.decoys.total} refused`,
      };
    },
  },
  {
    name: 'a citation whose seq does not exist',
    want: 'fail-a',
    run: withGoldResult(
      result({
        answer: 'It held to three hundred and eighty a second.',
        sentences: [{ text: 'It held to three hundred and eighty a second.', cites: [1] }],
        evidence: [ev(RAMP, 99, 'It holds to three hundred and eighty a second.', 1)],
      }),
      STUB,
    ),
  },
  {
    name: 'a quote that does not occur in the exchange it cites',
    want: 'fail-a',
    run: withGoldResult(
      result({
        answer: 'It held to three hundred and eighty a second.',
        sentences: [{ text: 'It held to three hundred and eighty a second.', cites: [1] }],
        // Real text, real session, wrong seq: the OOM line lifted onto the ramp subagent. This is
        // what a confident wrong answer looks like, and a resolver that only checked the seq
        // existed would wave it through.
        evidence: [ev(RAMP, 1, 'OOMKilled. The limit is 512Mi and the heap alone reaches it under load', 1)],
      }),
      STUB,
    ),
  },
  {
    name: 'answer holds a sentence that is not in sentences[]',
    want: 'fail-a',
    run: withGoldResult(
      result({
        answer:
          'It held to three hundred and eighty a second. The connection pool was resized to 400 the following week.',
        sentences: [{ text: 'It held to three hundred and eighty a second.', cites: [1] }],
        evidence: [ev(RAMP, 1, 'It holds to three hundred and eighty a second.', 1)],
      }),
      STUB,
    ),
  },
  {
    name: 'a dropped sentence is still in answer — the filter only pretended to drop',
    want: 'fail-a',
    run: withGoldResult(
      result({
        answer: 'It held to three hundred and eighty a second. That was good enough for the sale.',
        sentences: [
          { text: 'It held to three hundred and eighty a second.', cites: [1] },
          { text: 'That was good enough for the sale.', cites: [1] },
        ],
        dropped: ['That was good enough for the sale.'],
        evidence: [ev(RAMP, 1, 'It holds to three hundred and eighty a second.', 1)],
      }),
      STUB,
    ),
  },
  {
    name: 'a kept sentence with no citation at all',
    want: 'fail-a',
    run: withGoldResult(
      result({
        answer: 'It held to three hundred and eighty a second.',
        sentences: [{ text: 'It held to three hundred and eighty a second.', cites: [] }],
        evidence: [ev(RAMP, 1, 'It holds to three hundred and eighty a second.', 1)],
      }),
      STUB,
    ),
  },
  {
    name: 'a sentence citing an evidence index that does not exist',
    want: 'fail-a',
    run: withGoldResult(
      result({
        answer: 'It held to three hundred and eighty a second.',
        sentences: [{ text: 'It held to three hundred and eighty a second.', cites: [3] }],
        evidence: [ev(RAMP, 1, 'It holds to three hundred and eighty a second.', 1)],
      }),
      STUB,
    ),
  },
  {
    name: 'covering 6 of 10 gold',
    want: 'fail-b',
    run: () => {
      const rows = GOLD.map((g, i) => goldRow(g, i < 6));
      const decoys = DECOYS.map((d) => decoyRow(d, true, STRICT_EXIT));
      const v = verdictFor(rows, decoys, GOLD.map(honestOverlap), DECOYS.map(soundDecoy));
      return {
        pass: v.pass,
        a: v.citations.pass,
        b: v.coverage.pass,
        c: v.decoys.pass,
        set: v.set.pass,
        why: `${v.coverage.covered}/${v.coverage.total}, bar is ${Math.ceil(GATE_COVERAGE * v.coverage.total)}`,
      };
    },
  },
  {
    name: 'a decoy answered instead of refused',
    want: 'fail-c',
    run: () => {
      const rows = GOLD.map((g) => goldRow(g, true));
      const decoys = DECOYS.map((d, i) => decoyRow(d, i !== 2, i !== 2 ? STRICT_EXIT : 0));
      const v = verdictFor(rows, decoys, GOLD.map(honestOverlap), DECOYS.map(soundDecoy));
      return {
        pass: v.pass,
        a: v.citations.pass,
        b: v.coverage.pass,
        c: v.decoys.pass,
        set: v.set.pass,
        why: `${v.decoys.refused}/${v.decoys.total} refused`,
      };
    },
  },
  {
    name: 'a decoy refused by the library but the cli did not exit 2',
    want: 'fail-c',
    run: () => {
      const rows = GOLD.map((g) => goldRow(g, true));
      const decoys = DECOYS.map((d, i) => decoyRow(d, true, i === 0 ? 0 : STRICT_EXIT));
      const v = verdictFor(rows, decoys, GOLD.map(honestOverlap), DECOYS.map(soundDecoy));
      return {
        pass: v.pass,
        a: v.citations.pass,
        b: v.coverage.pass,
        c: v.decoys.pass,
        set: v.set.pass,
        why: `cli exit 0 on ${decoys[0]!.decoy.id}; the cli half is load-bearing`,
      };
    },
  },
  {
    name: 'ask.jsonl records an overlap it does not have',
    want: 'fail-set',
    run: () => {
      const rows = GOLD.map((g) => goldRow(g, true));
      const decoys = DECOYS.map((d) => decoyRow(d, true, STRICT_EXIT));
      const ov = GOLD.map(honestOverlap);
      ov[4] = { ...ov[4]!, measured: 0.81, dishonest: true, flagged: true };
      const v = verdictFor(rows, decoys, ov, DECOYS.map(soundDecoy));
      return {
        pass: v.pass,
        a: v.citations.pass,
        b: v.coverage.pass,
        c: v.decoys.pass,
        set: v.set.pass,
        why: `${ov[4]!.id} records ${ov[4]!.recorded} and measures 0.81`,
      };
    },
  },
  {
    name: 'a decoy the corpus can now answer',
    want: 'fail-set',
    run: () => {
      const rows = GOLD.map((g) => goldRow(g, true));
      const decoys = DECOYS.map((d) => decoyRow(d, true, STRICT_EXIT));
      const leaks = DECOYS.map(soundDecoy);
      leaks[1] = { ...leaks[1]!, best: 1.0, where: 'some-new-session', leaked: true };
      const v = verdictFor(rows, decoys, GOLD.map(honestOverlap), leaks);
      return {
        pass: v.pass,
        a: v.citations.pass,
        b: v.coverage.pass,
        c: v.decoys.pass,
        set: v.set.pass,
        why: `${leaks[1]!.id} is now covered 100% by one session`,
      };
    },
  },
];

// ------------------------------------------------------------------------ run it

function wanted(want: Case['want'], got: { pass: boolean; a: boolean; b: boolean; c: boolean; set: boolean }): boolean {
  switch (want) {
    case 'pass':
      return got.pass && got.a && got.b && got.c && got.set;
    // A broken result must fail the *named* gate, and the verdict overall. Asserting the gate by
    // name is what stops a scorer that fails everything for the wrong reason from looking right.
    case 'fail-a':
      return !got.pass && !got.a;
    case 'fail-b':
      return !got.pass && !got.b;
    case 'fail-c':
      return !got.pass && !got.c;
    case 'fail-set':
      return !got.pass && !got.set;
  }
}

const g = (b: boolean): string => (b ? 'ok  ' : 'FAIL');
const lines: string[] = [];
let bad = 0;

lines.push(`potsherd ask-evals selftest · ${CASES.length} cases · ${GOLD.length} gold, ${DECOYS.length} decoys`);
lines.push('');

// The set's own integrity, checked before anything else: a gold answer that cannot satisfy its
// own expectPhrases would make its question unpassable by construction.
for (const gold of GOLD) {
  const c = checkCoverage(
    result({ answer: gold.gold, evidence: gold.expectSessions.map((s, i) => ev(s, gold.expectSeqs[i]?.[1] ?? 1, 'x', i + 1)) }),
    gold,
  );
  if (!c.covered) {
    bad++;
    lines.push(`  FAIL  ${gold.id} — the hand-written gold answer does not satisfy its own expectPhrases/expectSessions`);
  }
}
if (bad === 0) lines.push(`  ok    every gold answer satisfies its own expectPhrases and names its own sessions`);
lines.push('');

lines.push('  want       (a)   (b)   (c)   set    case');
for (const c of CASES) {
  const got = c.run();
  const ok = wanted(c.want, got);
  if (!ok) bad++;
  lines.push(
    `  ${c.want.padEnd(10)} ${g(got.a)}  ${g(got.b)}  ${g(got.c)}  ${g(got.set)}   ` +
      `${ok ? '✓' : '✗ SCORER BROKEN'} ${c.name}`,
  );
  lines.push(`             ${' '.repeat(28)}  ${got.why}`);
}
lines.push('');
lines.push(
  bad === 0
    ? `  PASS — the scorer said the right thing about all ${CASES.length} cases and about the set itself`
    : `  FAIL — ${bad} expectation(s) unmet. Fix the scorer, not this test.`,
);

process.stdout.write(lines.join('\n') + '\n');
process.exitCode = bad === 0 ? 0 : 1;

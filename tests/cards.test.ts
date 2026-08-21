import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { db as store } from '@potsherd/core';
import {
  Llm,
  type Backend,
  type SendRequest,
  type SendResult,
  type Transport,
} from '../packages/core/src/llm.js';
import {
  CARD_SCHEMA,
  MAX_SUMMARY_WORDS,
  MAX_TITLE_WORDS,
  asSeqList,
  minimalCard,
  normaliseCard,
  tagify,
  validateCard,
  type ExtractedCard,
} from '../packages/core/src/cards/schema.js';
import {
  MAX_UNIT_CHARS,
  SLICE_THRESHOLD_CHARS,
  extractCalls,
  sliceUnits,
} from '../packages/core/src/cards/slice.js';
import {
  COVERAGE_COSINE,
  UNCOVERED_FRACTION,
  cardItems,
  measureCoverage,
  mergeSupplement,
} from '../packages/core/src/cards/coverage.js';
import {
  EVIDENCE_COSINE,
  unresolvedEvidence,
  verifyCard,
} from '../packages/core/src/cards/verify.js';
import { dedupeCard } from '../packages/core/src/cards/dedupe.js';
import { makeGate } from '../packages/core/src/cards/gate.js';
import { cachedEmbedder, cosine, rankedWindows, windows } from '../packages/core/src/cards/vectors.js';
import { cardTranscript } from '../packages/core/src/cards/pipeline.js';
import { runCards } from '../packages/core/src/cards/run.js';
import { planCards } from '../packages/core/src/cards/plan.js';
import {
  cardEmbeddingText,
  cardMarkdown,
  cardPath,
  exportCards,
  readPriorCard,
  safeSlug,
  writeCard,
  type CardRecord,
} from '../packages/core/src/cards/write.js';
import {
  elideMiddle,
  ghostProjectSlug,
  loadGhostTranscript,
  loadSessionTranscript,
  type Transcript,
  type TranscriptUnit,
} from '../packages/core/src/cards/transcript.js';
import { PROMPTS_ONLY, statesDecision } from '../packages/core/src/cards/ghost.js';
import { MIN_GHOST_PROMPTS } from '../packages/core/src/cards/plan.js';
import { listSessions, showSession } from '../packages/core/src/browse.js';
import { recall } from '../packages/core/src/recall.js';
import { renderCardRun } from '../packages/core/src/render/card-run.js';
import { renderLs } from '../packages/core/src/render/ls.js';
import { renderShow, renderShowMarkdown } from '../packages/core/src/render/show.js';
import { Theme } from '../packages/core/src/theme.js';
import { rmrf, tempDir } from './helpers.js';

/**
 * T2.2 — the ProMem-lite card pipeline (`plans/03-ARCHITECTURE.md` §6,
 * `plans/research/memory-research.md` §1).
 *
 * The pipeline's whole claim is that a card never asserts something the
 * transcript does not contain, so the tests that matter here are the ones
 * about **step 4**: a claim citing an exchange that does not exist is dropped,
 * a claim the cited exchange does not support is dropped, and what survives
 * cites only exchanges that resolve. That last one is the acceptance criterion
 * and it is asserted as an invariant of the finished card, not as a property
 * of a well-behaved model.
 *
 * Everything here runs with **no model and no embedding model**: `Llm.open`'s
 * transport seam supplies the replies and {@link toyEmbed} supplies the
 * vectors. A bag-of-words embedder is enough because every threshold in the
 * pipeline is a statement about *overlap*, and a deterministic embedder makes
 * "0.6 covered / 0.5 supported / 0.8 duplicate" testable without a 34 MB
 * download or a network.
 */

const created: string[] = [];
afterEach(() => {
  while (created.length) rmrf(created.pop()!);
});

function scratch(prefix = 'potsherd-cards-test-'): string {
  const dir = tempDir(prefix);
  created.push(dir);
  return dir;
}

// ------------------------------------------------------------- toy vectors

/**
 * A deterministic bag-of-words embedder: hashed unigrams, L2-normalised.
 *
 * Cosine is then the cosine of two word histograms — 1 for identical text, 0
 * for texts sharing no words — which is the property every threshold in the
 * pipeline is really about. It is not bge-small and it is not meant to be; it
 * makes the *arithmetic* testable offline.
 */
// 384, the same width as `embeddings.EMBEDDING_DIMENSIONS`, so the toy vectors
// go into `vec_cards` exactly as real ones do — and so hashed unigrams have
// enough buckets that two unrelated sentences do not collide into a false
// match, which at 96 buckets they did.
const DIMS = 384;
function toyVector(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261;
    for (let i = 0; i < token.length; i++) {
      h = Math.imul(h ^ token.charCodeAt(i), 16777619) >>> 0;
    }
    v[h % DIMS] = (v[h % DIMS] ?? 0) + 1;
  }
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / norm);
}
const toyEmbed = async (text: string): Promise<number[]> => toyVector(text);
const toyEmbedder = () => cachedEmbedder({ embed: toyEmbed });

function unit(seq: number, text: string): TranscriptUnit {
  return { seq, id: `e${seq}`, ts: '2026-08-01T00:00:00.000Z', text };
}

function transcriptOf(units: TranscriptUnit[], over: Partial<Transcript> = {}): Transcript {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'session',
    harness: 'claude',
    title: 'a session',
    project: '/tmp/p',
    projectSlug: '-tmp-p',
    units,
    chars: units.reduce((n, u) => n + u.text.length, 0),
    isSidechain: false,
    ...over,
  };
}

function claim(what: string, seqs: number[], why?: string) {
  return { what, ...(why ? { why } : {}), evidence_seq: seqs };
}

function cardOf(over: Partial<ExtractedCard> = {}): ExtractedCard {
  return {
    title: 'a card',
    summary: 'a summary',
    topics: [],
    decisions: [],
    files: [],
    outcome: 'unknown',
    open_threads: [],
    tags: [],
    ...over,
  };
}

/** Answers with whatever the test queued, in order. */
class ScriptedTransport implements Transport {
  readonly sent: SendRequest[] = [];
  closed = 0;
  constructor(
    private readonly replies: (string | Error)[],
    readonly backend: Backend = 'agent-sdk',
  ) {}
  async send(req: SendRequest): Promise<SendResult> {
    this.sent.push(req);
    const reply = this.replies[Math.min(this.sent.length - 1, this.replies.length - 1)] ?? '{}';
    if (reply instanceof Error) throw reply;
    return { text: reply, inputTokens: 1_000, outputTokens: 200, usd: 0.002 };
  }
  async close(): Promise<void> {
    this.closed++;
  }
}

function llmWith(replies: (string | Error)[], opts: Record<string, unknown> = {}): Llm {
  return Llm.open({ transport: new ScriptedTransport(replies), env: {}, ...opts });
}

// ------------------------------------------------------------------ schema

describe('the card schema', () => {
  it('accepts a well-formed card and clamps it to the spec ceilings', () => {
    const card = validateCard({
      title: 'one two three four five six seven eight nine ten',
      summary: Array.from({ length: 90 }, (_, i) => `w${i}`).join(' '),
      topics: Array.from({ length: 12 }, (_, i) => `t${i}`),
      decisions: [{ what: 'use pgbouncer', why: 'pooling', evidence_seq: [3, '4', 4] }],
      files: ['src/db.ts'],
      outcome: 'shipped',
      open_threads: [{ what: 'measure it', evidence_seq: [9] }],
      tags: ['Postgres Pooling', 'infra', 'a', 'b', 'c', 'd'],
    });
    expect(card).not.toBeNull();
    expect(card!.title.split(' ').length).toBeLessThanOrEqual(MAX_TITLE_WORDS + 1);
    expect(card!.summary.split(' ').length).toBeLessThanOrEqual(MAX_SUMMARY_WORDS + 1);
    expect(card!.topics).toHaveLength(8);
    expect(card!.tags).toHaveLength(5);
    expect(card!.tags[0]).toBe('postgres-pooling');
    expect(card!.decisions[0]!.evidence_seq).toEqual([3, 4]);
    expect(card!.outcome).toBe('shipped');
  });

  it('is permissive on purpose: a retry costs a whole call', () => {
    // Six topics instead of eight, a string where a list was asked for, a
    // decision as a bare string. None of these is worth a second model call.
    const card = validateCard({
      title: 'something happened',
      topics: 'pooling',
      decisions: ['we switched pooler'],
      outcome: 'we mostly shipped it',
    });
    expect(card).not.toBeNull();
    expect(card!.topics).toEqual(['pooling']);
    expect(card!.decisions[0]!.what).toBe('we switched pooler');
    expect(card!.decisions[0]!.evidence_seq).toEqual([]);
    expect(card!.outcome).toBe('shipped');
  });

  it('unwraps a card the model put inside an envelope', () => {
    const card = validateCard({ card: { title: 'inner', summary: 'yes' } });
    expect(card?.title).toBe('inner');
  });

  it('rejects a reply that is not a card at all, which is what triggers the retry', () => {
    expect(validateCard(null)).toBeNull();
    expect(validateCard('a sentence')).toBeNull();
    expect(validateCard([1, 2, 3])).toBeNull();
    expect(validateCard({ topics: ['a'] })).toBeNull();
  });

  it('reads seq numbers out of whatever shape they arrive in', () => {
    expect(asSeqList([1, '2', 3.9, 'seq 4', -1, 2])).toEqual([1, 2, 3, 4]);
    expect(asSeqList(undefined)).toEqual([]);
    expect(asSeqList('12')).toEqual([12]);
  });

  it('names every field the pipeline reads in the schema it sends', () => {
    for (const key of ['title', 'summary', 'topics', 'decisions', 'evidence_seq', 'files', 'outcome', 'open_threads', 'tags']) {
      expect(CARD_SCHEMA).toContain(key);
    }
  });

  it('tagifies to one spelling so `ls --tag` can match', () => {
    expect(tagify('Postgres  Pooling!')).toBe('postgres-pooling');
    expect(tagify('---')).toBe('');
  });

  it('has a minimal card that asserts nothing', () => {
    const m = minimalCard('t', 's');
    expect(m.decisions).toEqual([]);
    expect(m.open_threads).toEqual([]);
    expect(m.outcome).toBe('unknown');
  });

  it('normalise is idempotent', () => {
    const once = normaliseCard(cardOf({ title: 'a b c d e f g h i j k' }));
    expect(normaliseCard(once)).toEqual(once);
  });
});

// ------------------------------------------------------------------- slice

describe('slice', () => {
  it('sends a short session in one call', () => {
    const units = [unit(0, 'a'.repeat(1_000)), unit(1, 'b'.repeat(1_000))];
    expect(sliceUnits(units)).toHaveLength(1);
    expect(extractCalls(1)).toBe(1);
  });

  it('chunks only above the threshold, and never inside an exchange', () => {
    const units = Array.from({ length: 10 }, (_, i) => unit(i, 'x'.repeat(9_000)));
    const total = units.reduce((n, u) => n + u.text.length, 0);
    expect(total).toBeGreaterThan(SLICE_THRESHOLD_CHARS);
    const chunks = sliceUnits(units);
    expect(chunks.length).toBeGreaterThan(1);
    // Every unit appears exactly once, whole, in exactly one chunk.
    const seen = chunks.flat();
    expect(seen).toHaveLength(units.length);
    expect(seen.map((u) => u.seq)).toEqual(units.map((u) => u.seq));
    for (const u of seen) expect(u.text.length).toBe(9_000);
  });

  it('carries the session\'s own seq numbers into every chunk', () => {
    const units = Array.from({ length: 12 }, (_, i) => unit(i + 100, 'y'.repeat(9_000)));
    const chunks = sliceUnits(units);
    expect(chunks.length).toBeGreaterThan(1);
    // Not renumbered per chunk: the last chunk still starts high.
    expect(chunks[chunks.length - 1]![0]!.seq).toBeGreaterThan(100);
    expect(new Set(chunks.flat().map((u) => u.seq)).size).toBe(12);
  });

  it('caps one enormous exchange rather than letting it evict a whole chunk', () => {
    const long = 'z'.repeat(500_000);
    expect(elideMiddle(long, MAX_UNIT_CHARS).length).toBeLessThanOrEqual(MAX_UNIT_CHARS + 80);
    expect(elideMiddle(long, MAX_UNIT_CHARS)).toContain('characters elided');
    expect(elideMiddle('short', 100)).toBe('short');
  });

  it('drops empty units and survives an empty session', () => {
    expect(sliceUnits([])).toEqual([]);
    expect(sliceUnits([unit(0, '   ')])).toEqual([]);
  });

  it('prices a map-reduce as chunks plus one reduce', () => {
    expect(extractCalls(1)).toBe(1);
    expect(extractCalls(4)).toBe(5);
  });
});

// ---------------------------------------------------------------- coverage

describe('coverage', () => {
  it('marks an exchange no item speaks for as uncovered', async () => {
    const units = [
      unit(0, 'pgbouncer transaction pooling prepared statements'),
      unit(1, 'entirely unrelated conversation about bicycle maintenance'),
    ];
    const card = cardOf({ title: 'pgbouncer pooling', summary: 'pgbouncer transaction pooling prepared statements', topics: ['pgbouncer'] });
    const report = await measureCoverage(units, card, toyEmbedder().embed);
    expect(report.total).toBe(2);
    expect(report.uncovered).toEqual([1]);
    expect(report.best[0]!).toBeGreaterThanOrEqual(COVERAGE_COSINE);
    expect(report.best[1]!).toBeLessThan(COVERAGE_COSINE);
  });

  it('asks for a supplement only above the uncovered fraction', async () => {
    const covered = unit(0, 'alpha beta gamma');
    const card = cardOf({ title: 'alpha beta gamma', summary: 'alpha beta gamma' });
    const mostlyCovered = [covered, covered, covered, unit(3, 'zeta eta theta')];
    const mostlyNot = [covered, unit(1, 'zeta'), unit(2, 'eta'), unit(3, 'theta')];
    const a = await measureCoverage(mostlyCovered, card, toyEmbedder().embed);
    const b = await measureCoverage(mostlyNot, card, toyEmbedder().embed);
    expect(a.fraction).toBeLessThanOrEqual(UNCOVERED_FRACTION);
    expect(a.needsSupplement).toBe(false);
    expect(b.fraction).toBeGreaterThan(UNCOVERED_FRACTION);
    expect(b.needsSupplement).toBe(true);
  });

  it('does not embed file paths as items', () => {
    const items = cardItems(cardOf({ files: ['src/db.ts'], topics: ['pooling'] }));
    expect(items).toContain('pooling');
    expect(items).not.toContain('src/db.ts');
  });

  it('treats a card that says nothing as covering nothing', async () => {
    const report = await measureCoverage([unit(0, 'text')], minimalCard('', ''), toyEmbedder().embed);
    expect(report.needsSupplement).toBe(true);
    expect(report.uncovered).toEqual([0]);
  });

  it('merges a supplement without letting it rewrite the summary', () => {
    const base = cardOf({ title: 'base', summary: 'base summary', topics: ['a'], decisions: [claim('one', [1])], outcome: 'shipped' });
    const extra = cardOf({ title: '', summary: '', topics: ['a', 'b'], decisions: [claim('two', [9])], outcome: 'abandoned', tags: ['x'] });
    const merged = mergeSupplement(base, extra);
    expect(merged.title).toBe('base');
    expect(merged.summary).toBe('base summary');
    expect(merged.outcome).toBe('shipped');
    expect(merged.topics).toEqual(['a', 'b']);
    expect(merged.decisions.map((d) => d.what)).toEqual(['one', 'two']);
    expect(merged.tags).toEqual(['x']);
  });
});

// ------------------------------------------------------------------ verify

describe('verify — the hallucination filter', () => {
  const units = [
    unit(0, 'we switched the pooler to transaction mode because prepared statements were leaking'),
    unit(1, 'the deploy script now runs migrations before the rollout'),
  ];

  it('keeps a claim the cited exchange contains', async () => {
    const card = cardOf({ decisions: [claim('switched the pooler to transaction mode', [0])] });
    const r = await verifyCard(card, units, toyEmbedder().embed);
    expect(r.verified).toEqual({ kept: 1, dropped: 0 });
    expect(r.card.decisions[0]!.evidence_seq).toEqual([0]);
    expect(r.scores[0]!).toBeGreaterThanOrEqual(EVIDENCE_COSINE);
  });

  it('drops a claim the cited exchange does not contain', async () => {
    const card = cardOf({
      decisions: [claim('rewrote the billing engine in rust', [1])],
    });
    const r = await verifyCard(card, units, toyEmbedder().embed);
    expect(r.verified).toEqual({ kept: 0, dropped: 1 });
    expect(r.drops[0]!.reason).toBe('no-match');
    expect(r.drops[0]!.best).toBeLessThan(EVIDENCE_COSINE);
    expect(r.card.decisions).toEqual([]);
  });

  it('drops a claim citing a seq the transcript does not have', async () => {
    const card = cardOf({ decisions: [claim('switched the pooler to transaction mode', [47])] });
    const r = await verifyCard(card, units, toyEmbedder().embed);
    expect(r.verified.dropped).toBe(1);
    expect(r.drops[0]!.reason).toBe('unresolved-seq');
  });

  it('drops a claim that cites nothing at all', async () => {
    const card = cardOf({ decisions: [claim('switched the pooler to transaction mode', [])] });
    const r = await verifyCard(card, units, toyEmbedder().embed);
    expect(r.verified.dropped).toBe(1);
    expect(r.drops[0]!.reason).toBe('no-citation');
  });

  it('prunes the citations that did not stand up and keeps the ones that did', async () => {
    const card = cardOf({ decisions: [claim('switched the pooler to transaction mode', [0, 1, 99])] });
    const r = await verifyCard(card, units, toyEmbedder().embed);
    expect(r.verified.kept).toBe(1);
    expect(r.card.decisions[0]!.evidence_seq).toEqual([0]);
  });

  it('filters open threads on the same terms as decisions', async () => {
    const card = cardOf({
      open_threads: [
        claim('the deploy script runs migrations before the rollout', [1]),
        claim('nobody has audited the kubernetes ingress annotations', [1]),
      ],
    });
    const r = await verifyCard(card, units, toyEmbedder().embed);
    expect(r.verified).toEqual({ kept: 1, dropped: 1 });
    expect(r.card.open_threads).toHaveLength(1);
  });

  it('100% of the surviving evidence_seq resolve — the acceptance criterion', async () => {
    // Every shape of bad citation at once, plus two good ones.
    const card = cardOf({
      decisions: [
        claim('switched the pooler to transaction mode', [0, 12, 900]),
        claim('invented a thing that never happened here', [0]),
        claim('uncited assertion', []),
        claim('deploy script runs migrations before the rollout', [1, 44]),
      ],
      open_threads: [claim('another invention entirely', [0, 1])],
    });
    const r = await verifyCard(card, units, toyEmbedder().embed);
    expect(unresolvedEvidence(r.card, units)).toEqual([]);
    expect(r.verified.dropped).toBeGreaterThan(0);
    for (const c of [...r.card.decisions, ...r.card.open_threads]) {
      expect(c.evidence_seq.length).toBeGreaterThan(0);
      for (const seq of c.evidence_seq) {
        expect(units.some((u) => u.seq === seq)).toBe(true);
      }
    }
  });

  it('finds a claim buried in a long exchange, which whole-exchange cosine would miss', async () => {
    const noise = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod '.repeat(200);
    const buried = unit(0, `${noise}\nwe switched the pooler to transaction mode\n${noise}`);
    const text = 'switched the pooler to transaction mode';
    // Averaged over the whole exchange the claim is a rounding error…
    expect(cosine(toyVector(text), toyVector(buried.text))).toBeLessThan(EVIDENCE_COSINE);
    // …but it is whole inside one window, which is the question being asked.
    const best = Math.max(
      ...rankedWindows(buried.text, text).map((w) => cosine(toyVector(text), toyVector(w))),
    );
    expect(windows(buried.text).length).toBeGreaterThan(1);
    expect(best).toBeGreaterThan(cosine(toyVector(text), toyVector(buried.text)));
    // And the whole point: it is kept, where a sampled window would have lost it.
    // The span is *found*, which is the part sampling gets wrong.
    expect(rankedWindows(buried.text, text).some((w) => w.includes('transaction mode'))).toBe(true);

    // And it is then kept. The threshold is lowered for this one assertion
    // because the toy embedder is a raw word histogram: 6 claim words inside a
    // 1,800-character window of repeated lorem is 0.03 of cosine to it, where
    // bge-small scores the same pair around 0.7 — measured on the reference
    // corpus, where supported claims land at 0.65–0.78 against
    // EVIDENCE_COSINE's 0.5. What is under test here is the lookup, not the
    // encoder.
    const r = await verifyCard(
      cardOf({ decisions: [claim(text, [0])] }),
      [buried],
      toyEmbedder().embed,
      { cosine: 0.02, windowChars: 1_800 },
    );
    expect(r.verified.kept).toBe(1);
    const strict = await verifyCard(
      cardOf({ decisions: [claim(text, [0])] }),
      [buried],
      toyEmbedder().embed,
      { cosine: 0.9 },
    );
    expect(strict.verified.dropped).toBe(1);
  });
});

// ------------------------------------------------------------------ dedupe

describe('dedupe', () => {
  it('merges near-identical claims and keeps the better-evidenced one', async () => {
    const card = cardOf({
      decisions: [
        claim('switched the pooler to transaction mode', [1]),
        claim('switched the pooler to transaction mode', [2, 3], 'prepared statements leaked'),
      ],
    });
    const { card: out, report } = await dedupeCard(card, toyEmbedder().embed);
    expect(out.decisions).toHaveLength(1);
    expect(report.removed).toBe(1);
    // The union of citations, so no evidence is lost to a tie-break.
    expect(out.decisions[0]!.evidence_seq).toEqual([1, 2, 3]);
    expect(out.decisions[0]!.why).toBe('prepared statements leaked');
  });

  it('leaves genuinely different claims alone', async () => {
    const card = cardOf({
      decisions: [claim('switched the pooler', [1]), claim('rewrote the parser in rust', [2])],
    });
    const { card: out } = await dedupeCard(card, toyEmbedder().embed);
    expect(out.decisions).toHaveLength(2);
  });

  it('compares file paths as strings, never as vectors', async () => {
    const card = cardOf({ files: ['src/db.ts', 'src/api.ts', 'src/db.ts'] });
    const { card: out } = await dedupeCard(card, toyEmbedder().embed);
    expect(out.files).toEqual(['src/db.ts', 'src/api.ts']);
  });

  it('keeps the shorter of two equivalent topics', async () => {
    const card = cardOf({ topics: ['pgbouncer pooling', 'pooling pgbouncer'] });
    const { card: out } = await dedupeCard(card, toyEmbedder().embed);
    expect(out.topics).toEqual(['pgbouncer pooling']);
  });
});

// ----------------------------------------------------------------- vectors

describe('vectors', () => {
  it('caches, so the same string is embedded once', async () => {
    let calls = 0;
    const e = cachedEmbedder({
      embed: async (t) => {
        calls++;
        return toyVector(t);
      },
    });
    await e.embed('hello');
    await e.embed('hello');
    expect(calls).toBe(1);
    expect(e.stats.hits).toBe(1);
  });

  it('takes a primed vector from the store instead of recomputing it', async () => {
    let calls = 0;
    const e = cachedEmbedder({
      embed: async (t) => {
        calls++;
        return toyVector(t);
      },
    });
    e.prime('hello', toyVector('hello'));
    await e.embed('hello');
    expect(calls).toBe(0);
  });

  it('cosine is 1 for identical text and 0 for disjoint text', () => {
    expect(cosine(toyVector('a b c'), toyVector('a b c'))).toBeCloseTo(1, 6);
    expect(cosine(toyVector('alpha'), toyVector('omega'))).toBeCloseTo(0, 6);
    expect(cosine([], [1])).toBe(0);
    expect(cosine([0, 0], [0, 0])).toBe(0);
  });

  it('windows overlap, and ranked windows put the evidence first', () => {
    expect(windows('short')).toEqual(['short']);
    const long = Array.from({ length: 400 }, (_, i) => `sentence number ${i} here`).join(' ');
    expect(windows(long, 500).length).toBeGreaterThan(4);
    // Overlapping: consecutive windows share their edges.
    const w = windows(long, 500);
    expect(w[1]!.slice(0, 50)).not.toBe(w[0]!.slice(0, 50));
    expect(windows('')).toEqual([]);

    const buried = `${'noise words here '.repeat(300)}the pooler moved to transaction mode${' more noise '.repeat(300)}`;
    const ranked = rankedWindows(buried, 'pooler moved to transaction mode', 500, 4);
    expect(ranked.length).toBeLessThanOrEqual(4);
    expect(ranked.some((x) => x.includes('the pooler moved to transaction mode'))).toBe(true);
  });
});

// -------------------------------------------------------------------- gate

describe('the concurrency gate', () => {
  it('never lets more than n calls run at once', async () => {
    const gate = makeGate(2);
    let live = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 12 }, () =>
        gate(async () => {
          live++;
          peak = Math.max(peak, live);
          await new Promise((r) => setTimeout(r, 5));
          live--;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(live).toBe(0);
  });

  it('releases the permit when the call throws', async () => {
    const gate = makeGate(1);
    await expect(gate(async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    await expect(gate(async () => 'fine')).resolves.toBe('fine');
  });
});

// ---------------------------------------------------------------- pipeline

const GOOD_CARD = JSON.stringify({
  title: 'switched the pooler to transaction mode',
  summary: 'moved pgbouncer to transaction pooling and fixed the deploy order',
  topics: ['pgbouncer', 'deploys'],
  decisions: [
    { what: 'switched the pooler to transaction mode', why: 'prepared statements leaked', evidence_seq: [0] },
    { what: 'rewrote the billing engine in rust', why: 'invented', evidence_seq: [1] },
    { what: 'cites an exchange that does not exist', evidence_seq: [88] },
  ],
  files: ['deploy.sh'],
  outcome: 'shipped',
  open_threads: [{ what: 'the deploy script runs migrations before the rollout', evidence_seq: [1] }],
  tags: ['infra'],
});

function pgTranscript(): Transcript {
  return transcriptOf([
    unit(0, 'we switched the pooler to transaction mode because prepared statements were leaking'),
    unit(1, 'the deploy script now runs migrations before the rollout'),
  ]);
}

// ---------------------------------------------------------------- ghosts

/**
 * A deleted session, as `history.jsonl` remembers it: six prompts and no
 * assistant.
 *
 * Prompt 2 **states** a decision. Prompt 4 **asks** about one. They are about
 * comparable things, phrased comparably, and only one of them is a decision
 * this person made — which is the distinction T2.3 exists to hold, and the
 * thing a model asked to summarise the prompts gets wrong.
 */
const GHOST_PROMPTS = [
  'set up the events table for the analytics service',
  'the writes are slow when two workers insert at once',
  "let's go with postgres, not mysql, for the events table",
  'add an index on created_at and re-run the load test',
  'should we use redis or memcached for the session cache?',
  'the load test still fails at 400 rps',
];

/** The same six prompts as a {@link Transcript}, without touching sqlite. */
function ghostTranscript(prompts: readonly string[] = GHOST_PROMPTS): Transcript {
  return transcriptOf(
    prompts.map((p, i) => unit(i, `user: ${p}`)),
    { kind: 'ghost', id: 'g1', title: 'analytics events table', projectSlug: '-tmp-p' },
  );
}

/** A card claiming both the decision that was made and the one that was asked. */
const GHOST_CARD = JSON.stringify({
  title: 'analytics events table',
  summary: 'worked on the events table for the analytics service and load tested the writes',
  topics: ['postgres', 'load testing'],
  decisions: [
    { what: 'go with postgres, not mysql, for the events table', why: 'writes are slow', evidence_seq: [2] },
    { what: 'use redis or memcached for the session cache', evidence_seq: [4] },
  ],
  files: [],
  // A guess: there is no assistant side to have shipped anything.
  outcome: 'shipped',
  open_threads: [{ what: 'the load test still fails at 400 rps', evidence_seq: [5] }],
  tags: ['postgres'],
});

function seedGhost(db: ReturnType<typeof store.open>, id: string, prompts: readonly string[]): void {
  db.prepare(
    `INSERT INTO ghosts (session_id, harness, project, first_ts, last_ts, prompt_count, first_prompt, title)
     VALUES (?, 'claude', '/tmp/p', '2026-08-01T00:00:00.000Z', '2026-08-01T01:00:00.000Z', ?, ?, 'analytics events table')`,
  ).run(id, prompts.length, prompts[0] ?? null);
  prompts.forEach((text, i) => {
    db.prepare(
      `INSERT INTO ghost_prompts (id, session_id, seq, ts, text)
       VALUES (?, ?, ?, '2026-08-01T00:00:00.000Z', ?)`,
    ).run(`${id}-${i}`, id, i, text);
  });
}

describe('the pipeline, end to end', () => {
  it('runs all five steps and writes only what the transcript supports', async () => {
    const llm = llmWith([GOOD_CARD]);
    const steps: string[] = [];
    const r = await cardTranscript(llm, pgTranscript(), {
      embed: toyEmbed,
      onStep: (s) => steps.push(s),
    });
    await llm.close();

    expect(steps).toEqual(['extract', 'coverage', 'verify', 'dedupe']);
    expect(r.card.title).toContain('pooler');
    // One of the three decisions was invented and one cited seq 88.
    expect(r.card.decisions.map((d) => d.what)).toEqual(['switched the pooler to transaction mode']);
    expect(r.verified.kept).toBe(2);
    expect(r.verified.dropped).toBe(2);
    expect(r.drops.map((d) => d.reason).sort()).toEqual(['no-match', 'unresolved-seq']);
    expect(r.unresolved).toEqual([]);
    expect(r.degraded).toBe(false);
    expect(r.spend.calls).toBe(1);
  });

  it('survives json drift with a minimal card rather than failing the run', async () => {
    const llm = llmWith(['I am afraid I cannot do that.', 'Still prose, sorry.']);
    const r = await cardTranscript(llm, pgTranscript(), { embed: toyEmbed, coverage: false });
    await llm.close();
    expect(r.degraded).toBe(true);
    expect(r.card.title.length).toBeGreaterThan(0);
    expect(r.card.decisions).toEqual([]);
    expect(r.card.outcome).toBe('unknown');
    // Two attempts, and no third.
    expect(r.spend.calls).toBe(2);
  });

  it('map-reduces a long session and keeps the session\'s seq numbers', async () => {
    const big = Array.from({ length: 12 }, (_, i) =>
      unit(i, `exchange ${i} discussed routine scheduling work. `.repeat(160)),
    );
    big[7] = unit(7, 'we switched the pooler to transaction mode. '.repeat(160));
    const partial = JSON.stringify({
      title: 'part',
      summary: 'part summary',
      decisions: [{ what: 'switched the pooler to transaction mode', evidence_seq: [7] }],
    });
    const llm = llmWith([partial]);
    const r = await cardTranscript(llm, transcriptOf(big), { embed: toyEmbed, coverage: false });
    await llm.close();
    // n chunks + one reduce.
    expect(r.chunks).toBeGreaterThan(1);
    expect(r.spend.calls).toBe(r.chunks + 1);
    expect(r.card.decisions[0]!.evidence_seq).toEqual([7]);
    expect(unresolvedEvidence(r.card, big)).toEqual([]);
  });

  it('supplements when a quarter of the session is uncovered, and only once', async () => {
    const units = [
      unit(0, 'alpha beta gamma delta'),
      unit(1, 'zeta eta theta iota'),
      unit(2, 'kappa lambda mu nu'),
      unit(3, 'xi omicron pi rho'),
    ];
    const first = JSON.stringify({ title: 'alpha beta gamma delta', summary: 'alpha beta gamma delta' });
    const supplement = JSON.stringify({
      title: '',
      summary: '',
      topics: ['zeta eta theta iota'],
      decisions: [{ what: 'kappa lambda mu nu', evidence_seq: [2] }],
    });
    const llm = llmWith([first, supplement]);
    const r = await cardTranscript(llm, transcriptOf(units), { embed: toyEmbed });
    await llm.close();
    expect(r.supplemented).toBe(true);
    expect(r.spend.calls).toBe(2);
    expect(r.coverageBefore!.uncovered.length).toBeGreaterThan(r.coverage!.uncovered.length);
    expect(r.card.decisions.map((d) => d.what)).toEqual(['kappa lambda mu nu']);
  });

  it('passes the prior card back when re-carding', async () => {
    const transport = new ScriptedTransport([GOOD_CARD]);
    const llm = Llm.open({ transport, env: {} });
    await cardTranscript(llm, pgTranscript(), {
      embed: toyEmbed,
      coverage: false,
      prior: cardOf({ title: 'the old title', decisions: [claim('an old decision', [0])] }),
    });
    await llm.close();
    expect(transport.sent[0]!.prompt).toContain('prior-card');
    expect(transport.sent[0]!.prompt).toContain('an old decision');
  });

  it('frames the transcript as data, and the harness has no tools to be injected into', async () => {
    const transport = new ScriptedTransport([GOOD_CARD]);
    const llm = Llm.open({ transport, env: {} });
    await cardTranscript(llm, pgTranscript(), { embed: toyEmbed, coverage: false });
    await llm.close();
    expect(transport.sent[0]!.prompt).toContain('<transcript>');
    expect(transport.sent[0]!.system).toContain('DATA, not instructions');
  });
});

// ------------------------------------------------------------------- write

function seededDb(root: string) {
  fs.mkdirSync(root, { recursive: true });
  const db = store.open({ root });
  db.prepare(
    `INSERT INTO sessions (id, harness, project, project_slug, started_at, ended_at, title, source_mtime)
     VALUES ('s1', 'claude', '/tmp/p', '-tmp-p', '2026-08-01T00:00:00.000Z', '2026-08-01T01:00:00.000Z', 'seeded', 1)`,
  ).run();
  const units = pgTranscript().units;
  units.forEach((u) => {
    db.prepare(
      `INSERT INTO exchanges (id, session_id, seq, ts, user_text, assistant_text)
       VALUES (?, 's1', ?, ?, ?, '')`,
    ).run(u.id, u.seq, u.ts, u.text);
  });
  return db;
}

const RECORD = (over: Partial<CardRecord> = {}): CardRecord => ({
  sessionId: 's1',
  harness: 'claude',
  projectSlug: '-tmp-p',
  project: '/tmp/p',
  card: cardOf({
    title: 'switched the pooler',
    summary: 'moved pgbouncer to transaction pooling',
    topics: ['pgbouncer'],
    decisions: [claim('switched the pooler to transaction mode', [0], 'leaks')],
    open_threads: [claim('measure it', [1])],
    files: ['deploy.sh'],
    tags: ['infra'],
    outcome: 'shipped',
  }),
  verified: { kept: 2, dropped: 1 },
  model: 'haiku',
  costUsd: 0.0123,
  createdAt: '2026-08-21T00:00:00.000Z',
  source: 'transcript',
  ...over,
});

describe('writing a card', () => {
  it('writes cards, cards_fts and the markdown mirror in one go', () => {
    const root = scratch();
    const db = seededDb(root);
    const file = writeCard(db, root, RECORD());
    expect(fs.existsSync(file)).toBe(true);
    expect(file).toBe(cardPath(root, 'claude', '-tmp-p', 's1'));

    const row = db.prepare('SELECT * FROM cards WHERE session_id = ?').get('s1') as Record<string, unknown>;
    expect(row['title']).toBe('switched the pooler');
    expect(JSON.parse(String(row['verified']))).toMatchObject({ kept: 2, dropped: 1 });
    const hit = db
      .prepare(`SELECT session_id FROM cards_fts JOIN cards ON cards.rowid = cards_fts.rowid WHERE cards_fts MATCH 'pgbouncer'`)
      .all() as { session_id: string }[];
    expect(hit.map((h) => h.session_id)).toEqual(['s1']);
    db.close();
  });

  it('re-carding does not corrupt the external-content fts index', () => {
    const root = scratch();
    const db = seededDb(root);
    writeCard(db, root, RECORD());
    writeCard(db, root, RECORD({ card: cardOf({ title: 'rewrote the parser', summary: 'moved to a hand-written parser', topics: ['parsing'] }) }));

    const stale = db
      .prepare(`SELECT COUNT(*) AS n FROM cards_fts WHERE cards_fts MATCH 'pgbouncer'`)
      .get() as { n: number };
    expect(stale.n).toBe(0);
    const fresh = db
      .prepare(`SELECT COUNT(*) AS n FROM cards_fts WHERE cards_fts MATCH 'parser'`)
      .get() as { n: number };
    expect(fresh.n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM cards').get()).toEqual({ n: 1 });
    db.close();
  });

  it('puts every field phase-2 names in the frontmatter', () => {
    const md = cardMarkdown(RECORD());
    for (const key of ['title:', 'tags:', 'decisions:', 'open_threads:', 'files:', 'verified:', 'model:', 'cost:']) {
      expect(md).toContain(key);
    }
    expect(md).toContain('evidence_seq: [0]');
    expect(md).toContain('kept: 2');
    expect(md).toContain('dropped: 1');
    expect(md.startsWith('---\n')).toBe(true);
  });

  it('says so in the mirror when the card is a degraded one', () => {
    const md = cardMarkdown(RECORD({ degraded: true }));
    expect(md).toContain('degraded: true');
    expect(md).toContain('never returned valid JSON');
  });

  it('embeds title, summary and topics — and nothing else', () => {
    const text = cardEmbeddingText(RECORD().card);
    expect(text).toContain('switched the pooler');
    expect(text).toContain('pgbouncer');
    expect(text).not.toContain('deploy.sh');
  });

  it('keeps a project slug inside potsherd\'s own directory', () => {
    expect(safeSlug('../../etc')).toBe('etc');
    expect(safeSlug('a/b')).toBe('a-b');
    // A real Claude Code slug is one segment and survives untouched.
    expect(safeSlug('-Users-zebra-Fulcrum')).toBe('-Users-zebra-Fulcrum');
    expect(safeSlug(null)).toBe('unknown');
    expect(safeSlug('')).toBe('unknown');
  });

  it('reads a written card back as a prior', () => {
    const root = scratch();
    const db = seededDb(root);
    writeCard(db, root, RECORD());
    const prior = readPriorCard(db, 's1');
    expect(prior?.decisions[0]!.evidence_seq).toEqual([0]);
    expect(prior?.outcome).toBe('shipped');
    expect(readPriorCard(db, 'nope')).toBeNull();
    db.close();
  });

  it('exports the mirror tree into a directory', () => {
    const root = scratch();
    const dest = scratch();
    const db = seededDb(root);
    writeCard(db, root, RECORD());
    db.close();
    const out = exportCards(root, dest);
    expect(out.files).toBe(1);
    expect(out.bytes).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dest, 'claude', '-tmp-p', 's1.md'))).toBe(true);
    expect(exportCards(scratch(), dest).files).toBe(0);
  });
});

// --------------------------------------------------------------------- run

describe('the run', () => {
  function runnableDb(root: string) {
    const db = seededDb(root);
    db.prepare(
      `INSERT INTO exchanges (id, session_id, seq, ts, user_text, assistant_text)
       VALUES ('e2', 's1', 2, '2026-08-01T00:00:00.000Z', 'a third exchange about pgbouncer', '')`,
    ).run();
    return db;
  }

  it('writes a card per target and reports what the filter dropped', async () => {
    const root = scratch();
    const db = runnableDb(root);
    const llm = llmWith([GOOD_CARD]);
    const plan = planCards(db, {});
    const report = await runCards(db, llm, {
      root,
      targets: plan.targets,
      concurrency: 2,
      embed: toyEmbed,
    });
    await llm.close();
    expect(report.written).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.verified.dropped).toBeGreaterThan(0);
    expect(report.unresolved).toBe(0);
    // The scripted reply is re-offered to the supplement call, so the invented
    // seq is seen more than once. The property under test is that it never
    // survives, not how many times it was tried.
    expect(report.dropsByReason['unresolved-seq']).toBeGreaterThanOrEqual(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM cards').get()).toEqual({ n: 1 });
    db.close();
  });

  it('gives a ghost the same mirror directory as the sessions from its project', () => {
    const db = seededDb(scratch());
    db.prepare(
      `INSERT INTO ghosts (session_id, harness, project, first_ts, last_ts, prompt_count)
       VALUES ('g1', 'claude', '/Users/zebra/Fulcrum', '2026-08-01T00:00:00.000Z', '2026-08-01T01:00:00.000Z', 9)`,
    ).run();
    for (let i = 0; i < 9; i++) {
      db.prepare(
        `INSERT INTO ghost_prompts (id, session_id, seq, ts, text) VALUES (?, 'g1', ?, '2026-08-01T00:00:00.000Z', 'a prompt')`,
      ).run(`g1-${i}`, i);
    }
    const ghost = planCards(db, {}).targets.find((t) => t.kind === 'ghost')!;
    db.close();
    // `rescue` recovers a cwd, not a slug; the target carries Claude Code's own
    // spelling of it so T2.3's cards land beside this project's sessions.
    expect(ghost.projectSlug).toBe('-Users-zebra-Fulcrum');
    expect(safeSlug(ghost.projectSlug)).toBe('-Users-zebra-Fulcrum');
  });

  it('cards a session and a ghost in one run, through one pipeline', async () => {
    const root = scratch();
    const db = runnableDb(root);
    seedGhost(db, 'g1', GHOST_PROMPTS);
    const llm = llmWith([GOOD_CARD]);
    const plan = planCards(db, {});
    expect(plan.ghosts).toBe(1);
    const report = await runCards(db, llm, { root, targets: plan.targets, embed: toyEmbed });
    await llm.close();
    expect(report.deferred).toBe(0);
    expect(report.written).toBe(2);
    const sources = db
      .prepare('SELECT session_id, source FROM cards ORDER BY session_id')
      .all() as { session_id: string; source: string }[];
    expect(sources).toEqual([
      { session_id: 'g1', source: 'prompts-only' },
      { session_id: 's1', source: 'transcript' },
    ]);
    db.close();
  });

  it('cards ghosts alone when the run is narrowed to them', async () => {
    const root = scratch();
    const db = runnableDb(root);
    seedGhost(db, 'g1', GHOST_PROMPTS);
    const llm = llmWith([GOOD_CARD]);
    const plan = planCards(db, {});
    const report = await runCards(db, llm, {
      root,
      targets: plan.targets,
      kinds: ['ghost'],
      embed: toyEmbed,
    });
    await llm.close();
    expect(report.written).toBe(1);
    expect(report.deferred).toBe(1);
    expect(report.cards[0]!.source).toBe('prompts-only');
    db.close();
  });

  it('stops at --max-usd and says how far it got', async () => {
    const root = scratch();
    const db = runnableDb(root);
    for (const id of ['s2', 's3', 's4']) {
      db.prepare(
        `INSERT INTO sessions (id, harness, project, project_slug, started_at, title)
         VALUES (?, 'claude', '/tmp/p', '-tmp-p', '2026-08-01T00:00:00.000Z', ?)`,
      ).run(id, id);
      for (let i = 0; i < 3; i++) {
        db.prepare(
          `INSERT INTO exchanges (id, session_id, seq, ts, user_text, assistant_text)
           VALUES (?, ?, ?, '2026-08-01T00:00:00.000Z', 'we switched the pooler to transaction mode', '')`,
        ).run(`${id}-${i}`, id, i);
      }
    }
    const llm = llmWith([GOOD_CARD], { maxUsd: 0.000_01 });
    const plan = planCards(db, {});
    const report = await runCards(db, llm, {
      root,
      targets: plan.targets,
      concurrency: 1,
      embed: toyEmbed,
    });
    await llm.close();
    expect(report.aborted).toBeTruthy();
    expect(report.aborted!.message).toContain('--max-usd');
    expect(report.aborted!.total).toBe(4);
    expect(report.written).toBeLessThan(4);
    db.close();
  });

  it('counts a failing session, leaves an error sentinel and carries on', async () => {
    const root = scratch();
    const db = runnableDb(root);
    db.prepare(
      `INSERT INTO sessions (id, harness, project, project_slug, started_at, title)
       VALUES ('s2', 'claude', '/tmp/p', '-tmp-p', '2026-08-01T00:00:00.000Z', 's2')`,
    ).run();
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO exchanges (id, session_id, seq, ts, user_text, assistant_text)
         VALUES (?, 's2', ?, '2026-08-01T00:00:00.000Z', 'we switched the pooler to transaction mode', '')`,
      ).run(`s2-${i}`, i);
    }
    // The first call throws; every later one answers.
    const transport = new ScriptedTransport([new Error('the harness fell over'), GOOD_CARD]);
    const llm = Llm.open({ transport, env: {} });
    const plan = planCards(db, {});
    const report = await runCards(db, llm, {
      root,
      targets: plan.targets,
      concurrency: 1,
      embed: toyEmbed,
    });
    await llm.close();
    expect(report.failed).toBe(1);
    expect(report.written).toBe(1);
    expect(report.errors[0]!.message).toContain('fell over');
    const sentinels = fs
      .readdirSync(path.join(root, 'cards', 'claude', '-tmp-p'))
      .map((f) => fs.readFileSync(path.join(root, 'cards', 'claude', '-tmp-p', f), 'utf8'));
    expect(sentinels.some((s) => s.startsWith('__ERRORED__'))).toBe(true);
    db.close();
  });

  it('every written card resolves 100% of its evidence_seq', async () => {
    const root = scratch();
    const db = runnableDb(root);
    const llm = llmWith([GOOD_CARD]);
    const plan = planCards(db, {});
    await runCards(db, llm, { root, targets: plan.targets, embed: toyEmbed });
    await llm.close();

    const rows = db.prepare('SELECT session_id, decisions, open_threads FROM cards').all() as {
      session_id: string;
      decisions: string;
      open_threads: string;
    }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const t = loadSessionTranscript(db, row.session_id)!;
      const card = {
        decisions: JSON.parse(row.decisions),
        open_threads: JSON.parse(row.open_threads),
      };
      expect(unresolvedEvidence(card, t.units)).toEqual([]);
    }
    db.close();
  });
});

// ------------------------------------------------------------------ recall

describe('cards in the fusion', () => {
  it('finds a session by words that appear only in its card', async () => {
    const root = scratch();
    const db = seededDb(root);
    // Nothing in the transcript says "observability"; the card does.
    writeCard(db, root, RECORD({
      card: cardOf({
        title: 'observability rollout',
        summary: 'stood up dashboards and alerting for the checkout path',
        topics: ['observability'],
      }),
    }));
    const before = await recall(db, 'observability dashboards', {}, { root, vectors: false, lists: ['titles', 'exchanges_fts'] });
    const after = await recall(db, 'observability dashboards', {}, { root, vectors: false });
    db.close();
    expect(before.sessions.map((s) => s.id)).not.toContain('s1');
    expect(after.sessions.map((s) => s.id)).toContain('s1');
    expect(after.lists.some((l) => l.list === 'cards_fts')).toBe(true);
  });

  it('names a session by its card, not by the title the harness guessed', async () => {
    const root = scratch();
    const db = seededDb(root);
    // `sessions.title` is what Claude Code wrote a few turns in; the query
    // matches it, so the session is found either way and only its *name*
    // changes. (`seededDb` writes exchanges without their fts rows, so the
    // title list is the one doing the finding here — which is the point.)
    const before = await recall(db, 'seeded', {}, { root, vectors: false });
    expect(before.sessions[0]!.displayTitle).toBe('seeded');
    writeCard(db, root, RECORD());
    const after = await recall(db, 'seeded', {}, { root, vectors: false });
    db.close();
    expect(after.sessions[0]!.displayTitle).toBe('switched the pooler');
  });

  it('leaves the card lists out of an index that has never been carded', async () => {
    const root = scratch();
    const db = seededDb(root);
    const r = await recall(db, 'pooler', {}, { root, vectors: false });
    db.close();
    expect(r.lists.some((l) => l.list === 'cards_fts')).toBe(false);
  });
});

// ---------------------------------------------------------------- receipt

describe('the run receipt', () => {
  const base = {
    written: 0,
    failed: 0,
    deferred: 0,
    verified: { kept: 0, dropped: 0 },
    dropsByReason: { 'no-citation': 0, 'unresolved-seq': 0, 'no-match': 0 },
    calls: 0,
    usd: 0,
    inputTokens: 0,
    outputTokens: 0,
    unresolved: 0,
    supplemented: 0,
    degraded: 0,
    ms: 0,
    cards: [],
    errors: [],
  };
  const t = new Theme({ color: false, width: 80 });

  it('says the ceiling stopped it, not that there was nothing to card', () => {
    const out = renderCardRun(
      { ...base, aborted: { message: 'stopped at --max-usd 0.01: 0 of 35 done', fix: 'potsherd card --all --max-usd 2', done: 0, total: 35 } },
      t,
    );
    expect(out).toContain('stopped at --max-usd');
    expect(out).toContain('of 35 in scope');
    expect(out).not.toContain('nothing was carded');
  });

  it('flags a run where the filter never bit', () => {
    const out = renderCardRun({ ...base, written: 3, verified: { kept: 9, dropped: 0 } }, t);
    expect(out).toContain('nothing was filtered');
  });

  it('flags a card that still cites an exchange that does not exist', () => {
    const out = renderCardRun({ ...base, written: 1, unresolved: 2, verified: { kept: 1, dropped: 1 } }, t);
    // The label alone: the note is clipped to the terminal's note width.
    expect(out).toContain('unresolved seq');
    expect(out).toMatch(/unresolved seq\s+2/);
  });

  it('fits 60 and 80 columns and is ascii-clean under --ascii', () => {
    const report = {
      ...base,
      written: 2,
      verified: { kept: 7, dropped: 3 },
      dropsByReason: { 'no-citation': 1, 'unresolved-seq': 1, 'no-match': 1 },
      cards: [
        { id: 's1', kind: 'session' as const, title: 'switched the pooler', outcome: 'shipped', decisions: 2, openThreads: 1, kept: 4, dropped: 2, coverage: 0.9, supplemented: true, degraded: false, calls: 2, usd: 0.02, ms: 1_000, path: '/tmp/x.md' },
      ],
    };
    for (const width of [60, 80]) {
      for (const line of renderCardRun(report, new Theme({ color: false, width })).split('\n')) {
        expect(line.length, `"${line}" at ${width}`).toBeLessThanOrEqual(width);
      }
    }
    const ascii = renderCardRun(report, new Theme({ color: false, ascii: true, width: 80 }));
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7F]/.test(ascii)).toBe(false);
  });
});

// --------------------------------------------------------------- the verb

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(repo, 'packages', 'cli', 'bin', 'potsherd.js');

/** A PATH with nothing on it: no `claude`, no `codex`, no key. */
function bare(): Record<string, string> {
  return { PATH: '', ANTHROPIC_API_KEY: '', POTSHERD_LLM_BACKEND: '' };
}

function cli(args: string[], env: Record<string, string> = {}): { code: number; stdout: string } {
  try {
    return {
      code: 0,
      stdout: execFileSync(process.execPath, [bin, ...args], {
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? '' };
  }
}

describe('potsherd card --export', () => {
  it('copies the mirror out without needing a backend or an index', () => {
    const root = scratch();
    const dest = scratch();
    const db = seededDb(root);
    writeCard(db, root, RECORD());
    db.close();

    const r = cli(['card', '--export', dest, '--potsherd-dir', root], bare());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('1 card copied');
    expect(fs.existsSync(path.join(dest, 'claude', '-tmp-p', 's1.md'))).toBe(true);
  });

  it('says where the cards would come from when there are none', () => {
    const root = scratch();
    const r = cli(['card', '--export', scratch(), '--potsherd-dir', root], bare());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('no cards');
    expect(r.stdout).toContain('potsherd card --all');
  });
});

// ------------------------------------------------------------ T2.3 ghosts

/**
 * T2.3 — ghost cards (`plans/03` §6, `plans/01` §3, `phase-2` T2.3).
 *
 * On the reference machine 299 of 330 sessions are ghosts: Claude Code's
 * 30-day sweep took the transcripts and `history.jsonl` kept the prompts. So
 * these are not edge-case tests. For most of a real archive the ghost card is
 * the only card there will ever be, and everything below is about the three
 * things such a card is not allowed to do: claim an outcome, promote a
 * question into a decision, or look like a full card.
 */
describe('ghost cards', () => {
  it('loads a ghost as prompts, in seq order, labelled as a ghost', () => {
    const root = scratch();
    const db = seededDb(root);
    seedGhost(db, 'g1', GHOST_PROMPTS);
    const t = loadGhostTranscript(db, 'g1')!;
    expect(t.kind).toBe('ghost');
    expect(t.units).toHaveLength(6);
    expect(t.units.map((u) => u.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(t.units[2]!.text).toBe(`user: ${GHOST_PROMPTS[2]}`);
    // Nothing in a ghost unit can be the assistant, because there is none.
    for (const u of t.units) expect(u.text).not.toContain('assistant:');
    expect(t.title).toBe('analytics events table');
    expect(loadGhostTranscript(db, 'nope')).toBeNull();
    db.close();
  });

  it('puts a ghost card in the same mirror directory as the project\'s survivors', () => {
    // `ghosts` has no project_slug: the transcript that carried one is what
    // the sweep deleted. Re-deriving it with Claude Code's own encoding is
    // what keeps one project in one directory.
    expect(ghostProjectSlug('/Users/zebra/Downloads/Protfolio_app')).toBe(
      '-Users-zebra-Downloads-Protfolio-app',
    );
    expect(ghostProjectSlug('/tmp/p')).toBe('-tmp-p');
    expect(ghostProjectSlug(null)).toBeNull();
  });

  it('tells a prompt that states a decision from one that only asks about it', () => {
    // Stated.
    expect(statesDecision("let's go with postgres, not mysql")).toBe(true);
    expect(statesDecision('use redis not memcached for the session cache')).toBe(true);
    expect(statesDecision('drop the retry, it never fires')).toBe(true);
    expect(statesDecision("we're switching to pnpm")).toBe(true);
    expect(statesDecision('do not use the global lock here')).toBe(true);
    expect(statesDecision('user: from now on write the migrations by hand')).toBe(true);

    // Asked.
    expect(statesDecision('should we use postgres or mysql?')).toBe(false);
    expect(statesDecision('should we go with postgres')).toBe(false);
    expect(statesDecision('what about dropping the retry?')).toBe(false);
    expect(statesDecision('is it worth switching to pnpm?')).toBe(false);
    expect(statesDecision('any preference between redis and memcached')).toBe(false);
    expect(statesDecision("i'm not sure whether to go with postgres")).toBe(false);

    // Neither: an instruction is not a decision, or the field means nothing.
    expect(statesDecision('add a test for the parser')).toBe(false);
    expect(statesDecision('the load test still fails at 400 rps')).toBe(false);
  });

  it('keeps a decision a prompt states and drops one a prompt only asked about', async () => {
    // The test this task exists for. The model returns both claims, both cite
    // a prompt that really is about them, and both clear the cosine filter.
    // Only the stated one is a decision.
    const llm = llmWith([GHOST_CARD]);
    const r = await cardTranscript(llm, ghostTranscript(), { embed: toyEmbed, coverage: false });
    await llm.close();

    expect(r.card.decisions.map((d) => d.what)).toEqual([
      'go with postgres, not mysql, for the events table',
    ]);
    const asked = r.drops.find((d) => d.what.includes('session cache'));
    expect(asked?.reason).toBe('asked-not-decided');
    // Not for want of evidence: the prompt it cited exists and matched.
    expect(asked!.resolved).toEqual([4]);
    expect(asked!.best).toBeGreaterThanOrEqual(EVIDENCE_COSINE);
    expect(r.verified).toEqual({ kept: 2, dropped: 1 });
  });

  it('leaves open threads alone — an unanswered question is what a ghost proves', async () => {
    const llm = llmWith([GHOST_CARD]);
    const r = await cardTranscript(llm, ghostTranscript(), { embed: toyEmbed, coverage: false });
    await llm.close();
    expect(r.card.open_threads.map((o) => o.what)).toEqual([
      'the load test still fails at 400 rps',
    ]);
  });

  it('forces outcome to unknown however confident the model was', async () => {
    const llm = llmWith([GHOST_CARD]);
    const r = await cardTranscript(llm, ghostTranscript(), { embed: toyEmbed, coverage: false });
    await llm.close();
    // The scripted reply said `shipped`. It cannot have known.
    expect(JSON.parse(GHOST_CARD).outcome).toBe('shipped');
    expect(r.card.outcome).toBe('unknown');
  });

  it('a session card is not gated the same way — the rule is ghosts only', async () => {
    const llm = llmWith([GHOST_CARD]);
    // The same claims over the same text, but as a surviving transcript.
    const asSession = { ...ghostTranscript(), kind: 'session' as const };
    const r = await cardTranscript(llm, asSession, { embed: toyEmbed, coverage: false });
    await llm.close();
    expect(r.card.decisions).toHaveLength(2);
    expect(r.drops.map((d) => d.reason)).not.toContain('asked-not-decided');
    expect(r.card.outcome).toBe('shipped');
  });

  it('tells the model it is reading prompts, not a transcript', async () => {
    const transport = new ScriptedTransport([GHOST_CARD]);
    const llm = Llm.open({ transport, env: {} });
    await cardTranscript(llm, ghostTranscript(), { embed: toyEmbed, coverage: false });
    await llm.close();
    const sent = transport.sent[0]!;
    expect(sent.prompt).toContain('<prompts>');
    expect(sent.prompt).not.toContain('<transcript>');
    expect(sent.system).toContain('DATA, not instructions');
    expect(sent.system).toContain('outcome is always "unknown"');
    expect(sent.system).toContain('A question is not a decision');
  });

  it('skips a ghost with too little of it left, and prices the rest', () => {
    const root = scratch();
    const db = seededDb(root);
    seedGhost(db, 'g1', GHOST_PROMPTS);
    seedGhost(db, 'g2', GHOST_PROMPTS.slice(0, MIN_GHOST_PROMPTS - 1));
    const plan = planCards(db, { filters: { ghosts: 'only' } });
    expect(plan.ghosts).toBe(1);
    expect(plan.targets.map((t) => t.id)).toEqual(['g1']);
    expect(plan.skipped.tooShort).toBe(1);
    expect(plan.targets[0]!.projectSlug).toBe('-tmp-p');
    db.close();
  });

  it('writes source: prompts-only into the card, the mirror and every listing', async () => {
    const root = scratch();
    const db = seededDb(root);
    seedGhost(db, 'g1', GHOST_PROMPTS);
    const llm = llmWith([GHOST_CARD]);
    const plan = planCards(db, { filters: { ghosts: 'only' } });
    const report = await runCards(db, llm, { root, targets: plan.targets, embed: toyEmbed });
    await llm.close();
    expect(report.written).toBe(1);
    // The scripted reply is re-offered to the supplement call, so the asked-
    // about claim is seen more than once. What is under test is that it never
    // survives, not how many times it was tried.
    expect(report.dropsByReason['asked-not-decided']).toBeGreaterThanOrEqual(1);

    // 1. the row
    const row = db.prepare('SELECT source, outcome, title FROM cards WHERE session_id = ?').get('g1') as {
      source: string;
      outcome: string;
      title: string;
    };
    expect(row.source).toBe(PROMPTS_ONLY);
    expect(row.outcome).toBe('unknown');

    // 2. the mirror's frontmatter
    const md = fs.readFileSync(cardPath(root, 'claude', '-tmp-p', 'g1'), 'utf8');
    expect(md).toContain('source: "prompts-only"');
    expect(md).toContain('outcome: "unknown"');
    expect(md).toContain('prompts only');

    // 3. ls
    const list = listSessions(db, { ghosts: 'only' }, { limit: 10 });
    expect(list.sessions[0]!.cardSource).toBe(PROMPTS_ONLY);
    expect(list.sessions[0]!.cardTitle).toBe(row.title);
    const table = renderLs(list, new Theme({ width: 100, color: false }));
    expect(table).toContain('prompts-only');

    // 4. show
    const shown = showSession(db, 'g1')!;
    expect(shown.session.cardSource).toBe(PROMPTS_ONLY);
    const page = renderShow(shown, new Theme({ width: 100, color: false }));
    expect(page).toContain('prompts-only');
    expect(page).toContain('the assistant side is gone');
    expect(renderShowMarkdown(shown)).toContain('card source: prompts-only');
    db.close();
  });

  it('a carded ghost still resolves 100% of its evidence_seq', async () => {
    const root = scratch();
    const db = seededDb(root);
    seedGhost(db, 'g1', GHOST_PROMPTS);
    const llm = llmWith([GHOST_CARD]);
    const plan = planCards(db, { filters: { ghosts: 'only' } });
    await runCards(db, llm, { root, targets: plan.targets, embed: toyEmbed });
    await llm.close();
    const row = db.prepare('SELECT decisions, open_threads FROM cards WHERE session_id = ?').get('g1') as {
      decisions: string;
      open_threads: string;
    };
    const t = loadGhostTranscript(db, 'g1')!;
    expect(
      unresolvedEvidence(
        { decisions: JSON.parse(row.decisions), open_threads: JSON.parse(row.open_threads) },
        t.units,
      ),
    ).toEqual([]);
    db.close();
  });

  it('is findable by words that exist only in the ghost\'s card', async () => {
    // The near-miss this test exists to catch: `cards_fts` joined `sessions`,
    // and a ghost has no row there. The card would be written correctly and
    // then be findable by nothing, on the 90% of the archive that is ghosts.
    const root = scratch();
    const db = seededDb(root);
    seedGhost(db, 'g1', GHOST_PROMPTS);
    writeCard(db, root, RECORD({
      sessionId: 'g1',
      source: PROMPTS_ONLY,
      card: cardOf({
        title: 'analytics events table',
        summary: 'chose a store for the events table and load tested the writes',
        topics: ['observability'],
      }),
    }));

    const all = await recall(db, 'observability events table', {}, { root, vectors: false });
    expect(all.sessions.map((s) => s.id)).toContain('g1');
    expect(all.lists.some((l) => l.list === 'cards_fts')).toBe(true);

    // And under the filter that used to switch the card lists off entirely.
    const only = await recall(
      db,
      'observability events table',
      { ghosts: 'only' },
      { root, vectors: false },
    );
    expect(only.sessions.map((s) => s.id)).toContain('g1');

    // The mirror image still holds: a ghost card is not a session card.
    const none = await recall(
      db,
      'observability events table',
      { ghosts: 'exclude' },
      { root, vectors: false },
    );
    expect(none.sessions.map((s) => s.id)).not.toContain('g1');
    db.close();
  });

  it('quotes ghosts in --dry-run and cards them with --ghosts-only', async () => {
    const root = scratch();
    const db = seededDb(root);
    seedGhost(db, 'g1', GHOST_PROMPTS);
    db.close();

    const dry = cli(['card', '--ghosts-only', '--dry-run', '--json', '--potsherd-dir', root], bare());
    expect(dry.code).toBe(0);
    const j = JSON.parse(dry.stdout) as { targets: number; ghosts: number; sessions: number };
    // `--ghosts-only` is a scope on its own: no `--all` was passed and the
    // command did not ask which sessions to card.
    expect(j.targets).toBe(1);
    expect(j.ghosts).toBe(1);
    expect(j.sessions).toBe(0);
  });
});

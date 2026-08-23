import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CORROBORATION,
  WEIGHTS,
  db as store,
  embeddings,
  fallbackTitle,
  ftsQuery,
  idTag,
  indexAll,
  listSessions,
  recall,
  renderFind,
  rescue,
  resolveSession,
  resumeCommand,
  sessionStats,
  showSession,
  snippetLine,
  Theme,
  type Db,
} from '@potsherd/core';
import { rmrf, tempDir } from './helpers.js';

/**
 * L6 — `find`, `ls`, `show`, `stats`.
 *
 * These run against `evals/fixture/claude`, the same invented corpus the
 * recall eval scores itself on, indexed here from scratch. Sharing it is
 * deliberate: the eval says "the right session comes back", these tests say
 * "and here is *why* it comes back and what the flags do to it", and neither
 * can drift from the other's idea of what is in the corpus.
 *
 * What the corpus holds, and why each piece is there:
 *   46 sessions     two of them untitled, so the `<slug>-<id8>` fallback is exercised
 *   6 sidechains    subagent transcripts whose text exists nowhere else
 *   12 ghosts       prompts only, from history.jsonl — no assistant side at all
 *   8 projects      so `--project` has something to be wrong about
 *
 * T1.7b grew it from eight sessions to twenty-four; T3.4 grew it again to
 * forty-six and generated the whole thing from `scripts/make-eval-corpus.mjs`.
 * Eleven candidates is not a corpus a recall@5 metric can fail against — with
 * that few, bm25 cannot lose — so most of the sessions are *distractors*:
 * adjacent topics that share the query's words and must rank below the answer.
 * One of them (`ID.pasted`) has pasted-screenshot placeholders where its
 * prompts should be, which is what the snippet chooser is there to survive.
 *
 * The counts below are the generator's; `node scripts/make-eval-corpus.mjs`
 * prints them, and they change together or not at all.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, '..', 'evals', 'fixture', 'claude');

/** Known ids from `evals/fixture` — see `evals/queries.jsonl`. */
const ID = {
  pgbouncer: '0a2fbf9b',
  csv: 'a82ceb72',
  untitled: 'a0c57a31',
  bundle: '4ae3102b',
  fusion: 'cbcfda7e',
  ghostPrinter: 'e6aa5ba7',
  ghostBilling: '4ddd4b1f',
  /** Untitled, and its prompts are `[Image: …]` placeholders. */
  pasted: '5b0d7e92',
  idempotency: '7c1d0e44',
} as const;

let root: string;
let db: Db;
const dirs: string[] = [];

beforeAll(async () => {
  root = tempDir('potsherd-recall-');
  dirs.push(root);
  await rescue({ claudeDir: FIXTURE, root, ghostsOnly: true, quiet: true });
  await indexAll({ root, claudeDir: FIXTURE, harnesses: ['claude'], embed: false, full: true });
  db = store.open({ root });
}, 60_000);

afterAll(() => {
  db?.close();
  while (dirs.length) rmrf(dirs.pop()!);
});

const ids = (r: { sessions: { id: string }[] }): string[] => r.sessions.map((s) => s.id);
const has = (r: { sessions: { id: string }[] }, prefix: string): boolean =>
  ids(r).some((id) => id.startsWith(prefix));

describe('ftsQuery', () => {
  it('treats fts5 operators as words, not as syntax', () => {
    // Every one of these is a MATCH operator. If any reached fts5 unquoted the
    // query would either throw or mean something the user did not type.
    const q = ftsQuery('NEAR/3 AND OR NOT "unbalanced ^caret -minus *star');
    expect(q.and).toContain('"near"');
    expect(q.and).toContain('"and"');
    expect(q.and).not.toMatch(/(^| )NEAR\//);
    expect(q.and).not.toContain('^');
    expect(q.and).not.toContain('-minus');
  });

  it('never lets a quote out of the tokenizer', () => {
    // `"` is not a word character, so it can only ever be a separator. The
    // doubling in `ftsQuery` is belt and braces for the day the tokenizer
    // changes; what matters today is that no quote survives into the MATCH.
    expect(ftsQuery('a"b').and).toBe('"a" AND "b"');
    expect(ftsQuery('say "hi" now').and).toBe('"say" AND "hi" AND "now"');
  });

  it('runs an operator-only query without throwing', async () => {
    const r = await recall(db, 'AND OR NEAR', {}, { vectors: false });
    expect(Array.isArray(r.sessions)).toBe(true);
  });

  it('is empty for a query with no word characters', async () => {
    expect(ftsQuery('!!! ...').tokens).toEqual([]);
    const r = await recall(db, '!!!', {}, { vectors: false });
    expect(r.sessions).toEqual([]);
  });
});

describe('recall: what is in by default', () => {
  it('finds a subagent transcript — the words are nowhere else', async () => {
    const r = await recall(db, 'tree shaking icon set', {}, { vectors: false });
    expect(has(r, ID.bundle)).toBe(true);
    const hit = r.sessions.find((s) => s.id.startsWith(ID.bundle))!;
    expect(hit.isSidechain || hit.hits.some((h) => h.isSidechain)).toBe(true);
  });

  it('finds a ghost — a session with no transcript left at all', async () => {
    const r = await recall(db, 'brother laser printer driver', {}, { vectors: false });
    expect(has(r, ID.ghostPrinter)).toBe(true);
    expect(r.sessions[0]!.status).toBe('ghost');
    expect(r.sessions[0]!.resume).toBeNull();
  });

  it('finds a session the harness never named by its body', async () => {
    const r = await recall(db, 'webhook rate limited by the gateway', {}, { vectors: false });
    expect(has(r, ID.untitled)).toBe(true);
    const s = r.sessions.find((x) => x.id.startsWith(ID.untitled))!;
    // Until 8.2 this session had no title at all and rendered as
    // `potsherd-eval-api-a0c57a31`. `index` now names it after its first
    // substantive prompt, and the point of the test is unchanged: it is found
    // by its *body*, and what it is called does not decide that.
    expect(s.displayTitle).not.toBe(fallbackTitle(s.project, s.id));
    expect(s.title).toBe(s.displayTitle);
    expect(s.displayTitle).toContain('webhook');
    // `--untitled` still returns it, which is what `title_source` is for. That
    // half is asserted through the binary in tests/annotate-cli.test.ts.
  });

  it('finds a session by its title even when the body never says those words', async () => {
    const r = await recall(db, 'pin the prepared-statement setting', {}, { vectors: false });
    expect(has(r, ID.pgbouncer)).toBe(true);
  });
});

describe('recall: the fusion — T3.1', () => {
  /**
   * Session diversification, `03` §7: at most three hits from one conversation
   * on the top list. Without it a single long session that says the query's
   * words twenty times fills the page and nothing else can be seen.
   */
  it('keeps at most three hits from any one conversation', async () => {
    const r = await recall(db, 'the', {}, { vectors: false, limit: 20 });
    expect(r.hits.length).toBeGreaterThan(3);
    // The budget is per *conversation*, and a conversation is a block — so the
    // block is the only place it can honestly be counted. Counting the flat
    // array by session id was the wrong unit *and* passed for the wrong
    // reason: the array had been filtered to the representative session, so a
    // clustered conversation's other members were not in it to be counted.
    for (const s of r.sessions) expect(s.hits.length).toBeLessThanOrEqual(3);
    // Same hits, both views. If a subagent's hit is shown under its parent's
    // block it is in the flat list too, or the two disagree about the page.
    const total = r.sessions.reduce((n, s) => n + s.hits.length, 0);
    expect(r.hits.length).toBe(total);
    const inBlocks = new Set(r.sessions.flatMap((s) => s.hits));
    expect(r.hits.every((h) => inBlocks.has(h))).toBe(true);
  });

  it('honours a smaller perSession budget', async () => {
    const r = await recall(db, 'the', {}, { vectors: false, limit: 20, perSession: 1 });
    for (const s of r.sessions) expect(s.hits.length).toBe(1);
  });

  /**
   * The bug this task existed to find: a subagent transcript is its own session
   * holding exactly *one* exchange, so it could never be corroborated and never
   * fill the three-hit budget, while its own parent — about the same topic,
   * with a card and a hundred exchanges — outranked it every time. The two are
   * one conversation and are now scored and shown as one.
   */
  it('shows one block per conversation, not one for the parent and one for its subagent', async () => {
    const r = await recall(db, 'tree shaking icon set', {}, { vectors: false, limit: 20 });
    expect(r.sessions.filter((s) => s.id.startsWith(ID.bundle)).length).toBe(1);
  });

  it('lets the subagent head the block when only the subagent matched', async () => {
    // Nothing outside the subagent says "tree shaking", so the conversation is
    // represented by the transcript that earned the hit — not by its parent on
    // principle, which would hide the answer behind the session that spawned it.
    const r = await recall(db, 'tree shaking icon set', {}, { vectors: false });
    const block = r.sessions.find((s) => s.id.startsWith(ID.bundle))!;
    expect(block.isSidechain).toBe(true);
    expect(block.hits.some((h) => h.isSidechain)).toBe(true);
  });

  /**
   * **T3.6.** The flat `hits` array was filtered by the *representative*
   * session's id, so the moment a conversation clustered — the parent heads
   * the block, the subagent contributes a hit — the subagent's hit vanished
   * from it. Everything that counts the flat array (a `--json` consumer, the
   * eval harness, this file's own diversification tests) was reading a page
   * that had lost exactly the rows clustering exists to keep.
   */
  it('keeps every clustered member’s hit in the flat list, each naming its session', async () => {
    const r = await recall(db, 'the', {}, { vectors: false, limit: 20 });
    const clustered = r.sessions.filter((s) => s.hits.some((h) => h.sessionId !== s.id));
    expect(clustered.length).toBeGreaterThan(0);
    const fromOtherMembers = clustered.flatMap((s) => s.hits.filter((h) => h.sessionId !== s.id));
    expect(fromOtherMembers.some((h) => h.isSidechain)).toBe(true);
    // Present, and attributable: the id says which session actually matched.
    for (const h of fromOtherMembers) {
      expect(r.hits).toContain(h);
      expect(h.sessionId).toBeTruthy();
    }
    expect(r.hits.length).toBe(r.sessions.reduce((n, s) => n + s.hits.length, 0));
  });

  /**
   * **T3.6.** Two snippet lines per block, handed out in quoting order — so a
   * parent with a hundred exchanges took both and the subagent's line, the one
   * thing in the conversation nothing else says, never reached the screen
   * under the parent's heading. Sidechains are most of what is on a real
   * machine and the thing no other tool surfaces at all.
   */
  it('shows, and labels, the line a subagent earned under its parent’s heading', async () => {
    const r = await recall(db, 'the', {}, { vectors: false, limit: 20 });
    // Every subagent hit that was clustered under somebody else's block.
    //
    // This used to take the *first* such block and require its subagent line
    // on the screen. Two snippet lines are handed out per block in quoting
    // order, so whether any one block spends one of them on its subagent is a
    // property of that block's other hits — and 8.2, which gave the corpus's
    // sidechains titles and so changed what the title list returns, reordered
    // the blocks and the test failed while the feature worked. The premise
    // "the first clustered block renders its subagent" was the machine's, not
    // the test's. What T3.6 promises is that a subagent's line reaches the
    // screen at all, attributed to the session that earned it.
    const clustered = r.sessions.flatMap((s) =>
      s.isSidechain ? [] : s.hits.filter((h) => h.isSidechain && h.sessionId !== s.id),
    );
    expect(clustered.length, 'no subagent hit was clustered under a parent').toBeGreaterThan(0);
    const out = renderFind(r, new Theme({ color: false, ascii: true, width: 80 }), new Date());
    const rendered = clustered.filter((h) => out.includes(`subagent ${idTag(h.sessionId)}`));
    expect(rendered.length, out).toBeGreaterThan(0);
    expect(out).toContain('from subagents');
  });

  it('lets the best single hit decide, not the number of hits', async () => {
    // `sessionScore` is `best + min(rest/2, best * CORROBORATION)`. At the old
    // cap of 0.5 three mediocre hits beat one excellent one, which is exactly
    // how a subagent that was the nearest vector in the whole index came back
    // as the twenty-ninth block.
    const r = await recall(db, 'the', {}, { vectors: false, limit: 20 });
    expect(r.sessions.length).toBeGreaterThan(0);
    for (const s of r.sessions) {
      const best = Math.max(...s.hits.map((h) => h.score));
      expect(s.score).toBeLessThanOrEqual(best * (1 + CORROBORATION) + 1e-12);
    }
  });

  it('reports the parameters the fusion actually used', async () => {
    // `--explain` reads these rather than solving for them; if they were not
    // reported the debugger would be a second implementation of the ranker.
    const r = await recall(db, 'pgbouncer prepared statements', {}, { vectors: false });
    expect(r.k).toBe(60);
    expect(Object.keys(r.weights).length).toBeGreaterThan(0);
    expect(r.weights.exchanges_fts).toBeGreaterThan(0);
    for (const h of r.hits) {
      const summed = h.from.reduce((n, f) => n + f.contribution, 0);
      expect(summed).toBeCloseTo(h.score, 12);
      for (const f of h.from) {
        const weight = r.weights[f.list]!;
        expect(f.contribution).toBeCloseTo(weight / (r.k + f.rank), 12);
      }
    }
  });

  it('names the lists that had to relax, and docks them for it', async () => {
    const r = await recall(db, 'brother laser printer driver', {}, { vectors: false });
    expect(r.relaxedLists.length).toBeGreaterThan(0);
    for (const list of r.relaxedLists) {
      // A relaxed list is worth 0.6 of its table weight; whatever the table
      // says, the reported weight must be below it.
      expect(r.weights[list]!).toBeLessThan(WEIGHTS[list]);
    }
  });

  it('takes a weight override and the reported weight moves with it', async () => {
    const q = 'pgbouncer prepared statements';
    const base = await recall(db, q, {}, { vectors: false });
    const heavy = await recall(db, q, {}, { vectors: false, weights: { exchanges_fts: 4 } });
    const scale = base.weights.exchanges_fts! / WEIGHTS.exchanges_fts;
    expect(heavy.weights.exchanges_fts).toBeCloseTo(4 * scale, 12);
  });

  it('takes k and the contributions move with it', async () => {
    const r = await recall(db, 'pgbouncer prepared statements', {}, { vectors: false, k: 5 });
    expect(r.k).toBe(5);
    const hit = r.hits[0]!;
    const f = hit.from[0]!;
    expect(f.contribution).toBeCloseTo(r.weights[f.list]! / (5 + f.rank), 12);
  });
});

describe('recall: the tri-state filters', () => {
  it('--sidechains exclude drops the subagent answer', async () => {
    const on = await recall(db, 'tree shaking icon set', { sidechains: 'include' }, { vectors: false });
    const off = await recall(db, 'tree shaking icon set', { sidechains: 'exclude' }, { vectors: false });
    expect(on.hits.some((h) => h.isSidechain)).toBe(true);
    expect(on.relaxed).toBe(false);
    // Without the subagent nothing in the corpus says "tree shaking", so the
    // exchange list has to fall back to any-word matching to answer at all.
    expect(off.hits.every((h) => !h.isSidechain)).toBe(true);
    expect(off.relaxed).toBe(true);
  });

  it('--sidechains only returns nothing but subagents', async () => {
    const r = await recall(db, 'the', { sidechains: 'only' }, { vectors: false });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.every((h) => h.isSidechain)).toBe(true);
    expect(r.sessions.every((s) => s.kind === 'session')).toBe(true);
  });

  it('--ghosts only searches the deleted sessions and nothing else', async () => {
    const r = await recall(db, 'billing cron nightly backup', { ghosts: 'only' }, { vectors: false });
    expect(has(r, ID.ghostBilling)).toBe(true);
    expect(r.sessions.every((s) => s.status === 'ghost')).toBe(true);
  });

  it('--ghosts exclude loses the answer that only a ghost has', async () => {
    const r = await recall(db, 'brother laser printer driver', { ghosts: 'exclude' }, { vectors: false });
    expect(has(r, ID.ghostPrinter)).toBe(false);
  });

  it('--status ghost means the same as --ghosts only', async () => {
    const a = await recall(db, 'ppd file missing', { status: 'ghost' }, { vectors: false });
    const b = await recall(db, 'ppd file missing', { ghosts: 'only' }, { vectors: false });
    expect(ids(a)).toEqual(ids(b));
  });

  it('--project narrows to one project', async () => {
    const r = await recall(
      db,
      'the',
      { project: '/tmp/potsherd-eval-infra' },
      { vectors: false, limit: 20 },
    );
    expect(r.sessions.length).toBeGreaterThan(0);
    expect(r.sessions.every((s) => s.project === '/tmp/potsherd-eval-infra')).toBe(true);
  });

  it('--since and --until bound the window', async () => {
    const all = await recall(db, 'the', {}, { vectors: false, limit: 100 });
    const june = await recall(db, 'the', { since: '2026-06-01' }, { vectors: false, limit: 100 });
    // The ghosts are from April; the sessions from June.
    expect(june.sessions.every((s) => s.status !== 'ghost')).toBe(true);
    expect(all.sessions.length).toBeGreaterThan(june.sessions.length);
  });

  it('rejects a date that is not a date', async () => {
    await expect(recall(db, 'x', { since: 'last tuesday' }, { vectors: false })).rejects.toThrow(
      /--since/,
    );
  });
});

describe('recall: fusion', () => {
  it('keeps at most three hits from one conversation (03 §7 diversification)', async () => {
    const r = await recall(db, 'the', {}, { vectors: false, limit: 20 });
    // Per conversation, counted on the blocks, and cross-checked against the
    // flat list so neither can quietly lose a clustered member's hit.
    const perConversation = r.sessions.map((s) => s.hits.length);
    expect(perConversation.length).toBeGreaterThan(0);
    expect(Math.max(...perConversation)).toBeLessThanOrEqual(3);
    expect(r.hits.length).toBe(perConversation.reduce((a, b) => a + b, 0));
  });

  it('honours a lower diversification cap', async () => {
    const r = await recall(db, 'the', {}, { vectors: false, limit: 20, perSession: 1 });
    const seen = new Set(r.hits.map((h) => h.sessionId));
    expect(seen.size).toBe(r.hits.length);
  });

  it('reports which list every hit came from', async () => {
    const r = await recall(db, 'pgbouncer transaction pooling', {}, { vectors: false });
    expect(r.lists.map((l) => l.list)).toContain('exchanges_fts');
    expect(r.hits[0]!.from.length).toBeGreaterThan(0);
    expect(r.hits[0]!.from[0]!.rank).toBeGreaterThan(0);
  });

  it('relaxes to any-word matching only when the exact words find nothing', async () => {
    const exact = await recall(db, 'pgbouncer transaction pooling', {}, { vectors: false });
    expect(exact.relaxed).toBe(false);
    const loose = await recall(db, 'pgbouncer kubernetes checkout', {}, { vectors: false });
    expect(loose.relaxed).toBe(true);
    expect(loose.sessions.length).toBeGreaterThan(0);
  });

  it('never scores a session above 1.5x its own best hit', async () => {
    const r = await recall(db, 'the', {}, { vectors: false, limit: 20 });
    for (const s of r.sessions) {
      const best = Math.max(...s.hits.map((h) => h.score));
      expect(s.score).toBeLessThanOrEqual(best * 1.5 + 1e-9);
    }
  });
});

/**
 * The snippet is the only part of a `find` block that says *why* a session is
 * on the screen. T1.7's review found three ways it failed to: it started
 * mid-word, it quoted a pasted-screenshot placeholder, and its second line was
 * boilerplate with none of the query's words in it. These run against the real
 * index rather than against `denseSnippet` in isolation, because the bug that
 * produced the `[Image: …]` screenshot was not in the snippet cutter at all —
 * it was `recall` handing it the prompt when the answer was the evidence.
 */
describe('recall: the snippet is the evidence', () => {
  const terms = (q: string): string[] => q.toLowerCase().match(/[a-z0-9]+/g) ?? [];

  it('quotes the assistant side when the prompt is a pasted screenshot', async () => {
    const r = await recall(db, 'pay button spinner', {}, { vectors: false });
    const s = r.sessions.find((x) => x.id.startsWith(ID.pasted))!;
    expect(s, 'the pasted-screenshot session is findable').toBeTruthy();
    for (const h of s.hits) {
      expect(h.snippet.text).not.toContain('[Image:');
      expect(h.snippet.text).not.toContain('/tmp/potsherd-eval-web/.cache');
    }
    expect(s.hits.some((h) => h.snippet.text.includes('spinner'))).toBe(true);
  });

  it('shows a query term whenever the session contains one', async () => {
    for (const query of [
      'pay button spinner',
      'idempotency key on a replayed request',
      'pgbouncer transaction pooling',
      'docker layers on the ci runner',
    ]) {
      const r = await recall(db, query, {}, { vectors: false });
      const words = terms(query);
      for (const s of r.sessions.slice(0, 5)) {
        const quotable = s.hits.filter((h) => h.kind !== 'title');
        const evidence = quotable.filter((h) => h.snippet.match);
        // Either something in the block carries a highlight, or nothing in the
        // block's own text matched and the renderer says so instead.
        const anyText = quotable.some((h) =>
          words.some((w) => h.snippet.text.toLowerCase().includes(w.slice(0, 4))),
        );
        expect(evidence.length > 0 || !anyText, `${query} → ${s.displayTitle}`).toBe(true);
        for (const h of evidence) {
          const marked = h.snippet.text.slice(h.snippet.match!.start, h.snippet.match!.end);
          expect(marked.length).toBeGreaterThan(0);
          expect(words.some((w) => marked.toLowerCase().startsWith(w.slice(0, 4)))).toBe(true);
        }
      }
    }
  });

  it('never starts or ends a snippet in the middle of a word', async () => {
    for (const query of ['idempotency key on a replayed request', 'the nightly job', 'ledger row']) {
      const r = await recall(db, query, {}, { vectors: false, limit: 10 });
      for (const h of r.hits) {
        const text = h.snippet.text;
        if (!text) continue;
        // A leading or trailing ellipsis is the only thing allowed to sit
        // against a word; a bare letter there means a word was cut in half.
        const head = text.replace(/^…/, '');
        const tail = text.replace(/…$/, '');
        const source = (h.userText + ' ' + (h.assistantText ?? '')).toLowerCase();
        const firstWord = head.toLowerCase().match(/^[a-z0-9]+/)?.[0];
        const lastWord = tail.toLowerCase().match(/[a-z0-9]+$/)?.[0];
        if (firstWord && firstWord.length > 2) {
          expect(source, `starts mid-word: ${text}`).toMatch(
            new RegExp(`(^|[^a-z0-9])${firstWord}`),
          );
        }
        if (lastWord && lastWord.length > 2) {
          expect(source, `ends mid-word: ${text}`).toMatch(
            new RegExp(`${lastWord}([^a-z0-9]|$)`),
          );
        }
      }
    }
  });

  it('does not let a common word decide what gets quoted', async () => {
    // `on` and `a` are in the query; a snippet centred on either of them shows
    // the reader nothing. The highlight must land on a word that carries the
    // question.
    const r = await recall(db, 'idempotency key on a replayed request', {}, { vectors: false });
    for (const s of r.sessions.slice(0, 5)) {
      for (const h of s.hits.filter((x) => x.snippet.match)) {
        const marked = h.snippet.text
          .slice(h.snippet.match!.start, h.snippet.match!.end)
          .toLowerCase();
        expect(['on', 'a', 'the']).not.toContain(marked);
      }
    }
  });
});

describe('recall: vectors are optional', () => {
  it('degrades to bm25 with a printable reason rather than erroring', async () => {
    const r = await recall(db, 'pgbouncer', {}, { vectors: false });
    expect(r.vectors.used).toBe(false);
    expect(r.vectors.reason).toBeTruthy();
    expect(r.sessions.length).toBeGreaterThan(0);
  });

  it('says so when the index was built with --no-embed', async () => {
    // This index has no vectors at all: `indexAll({ embed: false })` above.
    const r = await recall(db, 'pgbouncer', {}, { vectors: true });
    expect(r.vectors.used).toBe(false);
    expect(r.vectors.available).toBe(false);
    expect(r.sessions.length).toBeGreaterThan(0);
  });

  it('does not wake the model when the words already matched', async () => {
    const r = await recall(db, 'pgbouncer transaction pooling', {}, { vectors: 'auto' });
    expect(r.lists.some((l) => l.list === 'vec_exchanges')).toBe(false);
  });
});

describe('resume commands', () => {
  it('gives the harness command for a live session', () => {
    expect(resumeCommand('claude', 'abc')).toBe('claude --resume abc');
    expect(resumeCommand('codex', 'abc')).toBe('codex resume abc');
  });

  it('offers nothing for a session the harness can no longer open', () => {
    expect(resumeCommand('claude', 'abc', 'archived')).toBeNull();
    expect(resumeCommand('claude', 'abc', 'ghost')).toBeNull();
    expect(resumeCommand('cursor', 'abc')).toBeNull();
  });

  it('resumes a subagent by resuming the conversation that spawned it', () => {
    expect(resumeCommand('claude', 'parent:agent-a1b2', 'live', 'parent')).toBe(
      'claude --resume parent',
    );
    // No parent recorded: potsherd will not offer an id claude cannot open.
    expect(resumeCommand('claude', 'parent:agent-a1b2', 'live')).toBeNull();
  });

  it('names a subagent by the half of its id that is its own', () => {
    expect(idTag('4c9339e0-b186-4006-b5c1-e7537c8b9353')).toBe('4c9339e0');
    expect(idTag('4c9339e0-b186-4006-b5c1-e7537c8b9353:agent-a02db260b621e9897')).toBe('a02db260');
  });
});

describe('ls', () => {
  it('lists sessions and ghosts together, newest first', () => {
    const r = listSessions(db, {}, { limit: 50 });
    expect(r.sessions.length).toBeGreaterThan(0);
    const when = r.sessions.map((s) => s.endedAt ?? s.startedAt ?? '');
    expect([...when].sort().reverse()).toEqual(when);
    expect(r.ghosts).toBe(12);
  });

  it('rolls subagents up under their parent instead of listing them flat', () => {
    const rolled = listSessions(db, {}, { limit: 50 });
    expect(rolled.sessions.every((s) => !s.isSidechain)).toBe(true);
    expect(rolled.rolledUp).toBe(6);
    const parent = rolled.sessions.find((s) => s.id.startsWith(ID.bundle))!;
    expect(parent.subagents).toBe(1);

    const only = listSessions(db, { sidechains: 'only' }, { limit: 50 });
    expect(only.sessions.length).toBe(6);
    expect(only.sessions.every((s) => s.isSidechain)).toBe(true);
  });

  it('gives a session the harness never named a name that is not a uuid', () => {
    const r = listSessions(db, {}, { limit: 50 });
    const untitled = r.sessions.find((s) => s.id.startsWith(ID.untitled))!;
    // 8.2. Before it, the answer was `potsherd-eval-api-a0c57a31` — a name,
    // and not one that says anything. The title is *stored* rather than
    // resolved per surface, so `ls`, `find` and `show` cannot disagree about
    // it; that is what `title === displayTitle` is checking.
    expect(untitled.displayTitle).not.toMatch(/-[0-9a-f]{8}$/);
    expect(untitled.displayTitle).toContain('webhook');
    expect(untitled.title).toBe(untitled.displayTitle);
  });

  it('names a ghost by its first real prompt, not by its id', () => {
    const r = listSessions(db, { ghosts: 'only' }, { limit: 50 });
    const ghost = r.sessions.find((s) => s.id.startsWith(ID.ghostPrinter))!;
    expect(ghost.displayTitle).toContain('brother laser printer');
  });

  it('--ghosts exclude leaves only what is still on disk', () => {
    const r = listSessions(db, { ghosts: 'exclude' }, { limit: 50 });
    expect(r.sessions.every((s) => s.status !== 'ghost')).toBe(true);
    expect(r.ghosts).toBe(0);
  });

  it('--project filters both tables', () => {
    const r = listSessions(db, { project: '/tmp/potsherd-eval-devices' }, { limit: 50 });
    expect(r.sessions.length).toBe(4);
    expect(r.sessions.every((s) => s.status === 'ghost')).toBe(true);
  });
});

describe('show', () => {
  it('resolves a full id, and an unambiguous prefix', () => {
    const byPrefix = resolveSession(db, ID.pgbouncer)!;
    expect(byPrefix.ambiguous).toBeUndefined();
    const byFull = resolveSession(db, byPrefix.id)!;
    expect(byFull.id).toBe(byPrefix.id);
  });

  it('prefers the conversation over the subagents that share its prefix', () => {
    const found = resolveSession(db, ID.bundle)!;
    expect(found.ambiguous).toBeUndefined();
    expect(found.id).not.toContain(':');
  });

  it('finds a subagent by the tag ls prints for it', () => {
    const parent = showSession(db, resolveSession(db, ID.bundle)!.id)!;
    const child = parent.children[0]!;
    const found = resolveSession(db, idTag(child.id))!;
    expect(found.id).toBe(child.id);
  });

  it('returns null for a reference that matches nothing', () => {
    expect(resolveSession(db, 'zzzzzzzz')).toBeNull();
  });

  it('lists the candidates rather than guessing on a real collision', () => {
    // One character is a prefix of many uuids and of at least two top-level
    // sessions, so there is no single conversation it could mean.
    const found = resolveSession(db, 'a')!;
    expect(found.ambiguous).toBeDefined();
    expect(found.ambiguous!.length).toBeGreaterThan(1);
  });

  it('reads a window of exchanges, numbered the way --from addresses them', () => {
    const id = resolveSession(db, ID.csv)!.id;
    const all = showSession(db, id)!;
    expect(all.total).toBe(3);
    const window = showSession(db, id, { from: 2, to: 3 })!;
    expect(window.exchanges.length).toBe(2);
    expect(window.from).toBe(2);
    expect(window.exchanges[0]!.userText).toBe(all.exchanges[1]!.userText);
  });

  it('shows a ghost as prompts with no assistant side', () => {
    const id = resolveSession(db, ID.ghostPrinter)!.id;
    const r = showSession(db, id)!;
    expect(r.exchanges).toEqual([]);
    expect(r.ghostPrompts!.length).toBe(5);
    expect(r.session.resume).toBeNull();
  });

  it('lists the subagents a session spawned', () => {
    const r = showSession(db, resolveSession(db, ID.bundle)!.id)!;
    expect(r.children.length).toBe(1);
    expect(r.children[0]!.agentName).toBe('bundle-auditor');
  });

  it('carries the files an exchange touched', () => {
    const r = showSession(db, resolveSession(db, ID.pgbouncer)!.id)!;
    expect(r.exchanges[0]!.filesTouched.join(' ')).toContain('pool.ts');
    expect(r.exchanges[0]!.toolCalls[0]!.name).toBe('Edit');
  });
});

describe('stats', () => {
  it('counts sessions, subagents and ghosts per harness', () => {
    const r = sessionStats(db, { root });
    const claude = r.harnesses.find((h) => h.harness === 'claude')!;
    expect(claude.sessions).toBe(46);
    expect(claude.sidechains).toBe(6);
    expect(claude.ghosts).toBe(12);
    expect(claude.exchanges).toBeGreaterThan(0);
  });

  it('agrees with the tables it counted', () => {
    const r = sessionStats(db, { root });
    const rows = db.prepare('SELECT COUNT(*) AS n FROM exchanges').get() as { n: number };
    expect(r.totals.exchanges).toBe(rows.n);
    const ghostPrompts = db.prepare('SELECT COUNT(*) AS n FROM ghost_prompts').get() as { n: number };
    expect(r.totals.ghostPrompts).toBe(ghostPrompts.n);
  });

  it('reports freshness against the files it actually read', () => {
    const r = sessionStats(db, { root });
    expect(r.freshness.indexed).toBe(52);
    expect(r.freshness.missing).toBe(0);
    expect(r.freshness.stale).toBe(0);
    expect(r.freshness.lastIndexedAt).toBeTruthy();
  });

  it('says the index has no vectors when it was built without them', () => {
    const r = sessionStats(db, { root });
    expect(r.freshness.vectors).toBe(0);
  });
});

/**
 * The vector half, on the same corpus. Skipped unless the 34 MB bge-small model
 * is already on disk — CI must never silently fetch it — and given its own
 * index because embedding is the only thing here that costs anything.
 */
const MODEL_CACHE = path.join(os.tmpdir(), 'potsherd-test-models');
const hasModel =
  process.env['POTSHERD_TEST_EMBED'] === '1' || embeddings.isModelCached(MODEL_CACHE);

describe.skipIf(!hasModel)('recall: the vector half — T3.1', () => {
  let vroot: string;
  let vdb: Db;

  beforeAll(async () => {
    vroot = tempDir('potsherd-recall-vec-');
    dirs.push(vroot);
    fs.symlinkSync(MODEL_CACHE, path.join(vroot, 'models'));
    await rescue({ claudeDir: FIXTURE, root: vroot, ghostsOnly: true, quiet: true });
    await indexAll({ root: vroot, claudeDir: FIXTURE, harnesses: ['claude'], embed: true, full: true });
    vdb = store.open({ root: vroot });
  }, 600_000);

  afterAll(() => {
    vdb?.close();
  });

  /**
   * **The regression.** Every subagent exchange was embedded, and the vector
   * list ranked the right one first — and a search with only the vector lists
   * on still never returned a single hit flagged `isSidechain`, because the
   * one-exchange subagent lost its own parent's block every time. It was not a
   * missing join and not a dropped flag; it was the ranker treating one
   * conversation as two rivals.
   */
  it('returns the subagent the vectors ranked first, flagged as a subagent', async () => {
    const r = await recall(
      vdb,
      'the thing quietly eating most of the cloud bill',
      {},
      { vectors: true, lists: ['vec_exchanges'], root: vroot, limit: 20 },
    );
    expect(r.vectors.used).toBe(true);
    expect(r.hits.some((h) => h.isSidechain)).toBe(true);
    const at = r.sessions.findIndex(
      (x) => x.id.startsWith('d4b1f0a7') && (x.isSidechain || x.hits.some((h) => h.isSidechain)),
    );
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(5);
  }, 120_000);

  it('embeds every subagent exchange, not only the parents', () => {
    const row = vdb
      .prepare(
        `SELECT COUNT(*) AS n FROM exchanges e
           JOIN vec_exchanges v ON v.id = e.id
          WHERE e.is_sidechain = 1`,
      )
      .get() as { n: number };
    expect(row.n).toBe(6);
  });

  /**
   * Ghosts join the semantic half (schema 7/8). Before this they carried no
   * embeddings at all, so RRF could only ever collect two contributions for a
   * ghost against five for a live session — and turning the vector weight up to
   * fix the *other* half of the corpus pushed every ghost off the first page.
   */
  it('embeds recovered prompts into vec_ghost_prompts', () => {
    const embedded = vdb
      .prepare('SELECT COUNT(*) AS n FROM ghost_prompts WHERE embedding_version IS NOT NULL')
      .get() as { n: number };
    const total = vdb
      .prepare("SELECT COUNT(*) AS n FROM ghost_prompts WHERE length(trim(text)) > 3")
      .get() as { n: number };
    expect(total.n).toBeGreaterThan(0);
    expect(embedded.n).toBe(total.n);
  });

  it('finds a ghost through the vector list alone, with none of its words', async () => {
    const r = await recall(
      vdb,
      'printing from this machine stopped working',
      {},
      { vectors: true, lists: ['vec_ghost_prompts'], root: vroot, limit: 10 },
    );
    expect(r.vectors.used).toBe(true);
    expect(r.sessions.length).toBeGreaterThan(0);
    expect(r.sessions.every((x) => x.status === 'ghost')).toBe(true);
  }, 120_000);

  it('drops the ghost vector list when the ghosts are filtered out', async () => {
    const r = await recall(
      vdb,
      'printing from this machine stopped working',
      { ghosts: 'exclude' },
      { vectors: true, root: vroot, limit: 10 },
    );
    expect(r.lists.some((l) => l.list === 'vec_ghost_prompts')).toBe(false);
    expect(r.sessions.every((x) => x.status !== 'ghost')).toBe(true);
  }, 120_000);
});

/**
 * **The upgrade path.** `embedExchanges` returned early when no exchange
 * needed a vector — which is every run after the first — and the ghost pass
 * lives *after* that return, so `vec_ghost_prompts` stayed empty forever for
 * anyone who was not building an index from scratch. The whole ghost half of
 * the fusion was measured in a state no upgrading user is ever in.
 *
 * The shape of the proof is the point: index once so every exchange is
 * current, *then* add a ghost the way a later `rescue` would, then index
 * again and demand the new ghost has a vector.
 */
describe.skipIf(!hasModel)('recall: ghost vectors survive a second index — T3.6', () => {
  const NEW_GHOST = 't36-upgrade-path-ghost';

  it('embeds a ghost recovered after the exchanges were already embedded', async () => {
    const root = tempDir('potsherd-ghost-upgrade-');
    dirs.push(root);
    fs.symlinkSync(MODEL_CACHE, path.join(root, 'models'));
    await rescue({ claudeDir: FIXTURE, root, ghostsOnly: true, quiet: true });
    const first = await indexAll({
      root,
      claudeDir: FIXTURE,
      harnesses: ['claude'],
      embed: true,
      full: true,
    });
    expect(first.embeddings.ghostPrompts).toBeGreaterThan(0);

    const vdb2 = store.open({ root });
    try {
      const ghostVectors = (): number =>
        (vdb2.prepare('SELECT COUNT(*) AS n FROM vec_ghost_prompts').get() as { n: number }).n;
      const before = ghostVectors();
      expect(before).toBeGreaterThan(0);

      const session = (
        vdb2.prepare('SELECT session_id AS s FROM ghost_prompts LIMIT 1').get() as { s: string }
      ).s;
      vdb2
        .prepare(
          `INSERT INTO ghost_prompts (id, session_id, seq, ts, text) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          NEW_GHOST,
          session,
          9999,
          new Date().toISOString(),
          'the espresso machine firmware refused to flash',
        );

      // The second run. Every exchange is already at the current embedding
      // version — precisely the condition that used to skip the ghost pass.
      const second = await indexAll({
        root,
        claudeDir: FIXTURE,
        harnesses: ['claude'],
        embed: true,
      });
      expect(second.embeddings.embedded).toBe(0);
      expect(second.embeddings.ghostPrompts).toBe(1);

      const stamped = vdb2
        .prepare('SELECT embedding_version AS v FROM ghost_prompts WHERE id = ?')
        .get(NEW_GHOST) as { v: number | null };
      expect(stamped.v).not.toBeNull();
      const vectored = vdb2
        .prepare('SELECT COUNT(*) AS n FROM vec_ghost_prompts WHERE id = ?')
        .get(NEW_GHOST) as { n: number };
      expect(vectored.n).toBe(1);
      expect(ghostVectors()).toBe(before + 1);
    } finally {
      vdb2.close();
    }
  }, 600_000);
});

/**
 * **T4.8.** The *second* cut, and the one that was actually publishing half a
 * mask.
 *
 * `search/snippet.ts` cuts a 200-character window out of the exchange;
 * `render/find.ts` then cuts that window again to fit the terminal, around the
 * highlighted match. Both had to learn that a mask is one atom, and the
 * renderer had a failure mode the window cutter does not: **the highlight can
 * land inside the mask.** `find "redacted aws"` matches the literal word
 * `redacted` — eight characters in the middle of
 * `‹redacted:basic-auth:201b2d22›` — so the window was centred on a fragment
 * and `wordEdges` then pulled its end back to exactly the end of that
 * fragment, which is the middle of the marker. That is how
 * `docs/screens/13-find-redacted.txt` came to publish
 * `postgres://ingest:‹redacted…` and fail the screenshot script's own
 * assertion.
 */
describe('the find renderer never prints half a mask', () => {
  const MASK = '‹redacted:basic-auth:201b2d22›';
  const TEXT = `the importer cannot reach the pooler — postgres://ingest:${MASK}@db.internal:6432/crm times out but the direct port is fine`;

  const balanced = (s: string): boolean => {
    let depth = 0;
    for (const ch of s) {
      if (ch === '‹') depth++;
      else if (ch === '›' && --depth < 0) return false;
    }
    return depth === 0;
  };

  /** A hit as `recall` hands one to the renderer, with the mask highlighted. */
  const hit = (match?: { start: number; end: number }) =>
    ({
      kind: 'exchange',
      sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      isSidechain: false,
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee:2',
      seq: 2,
      ts: '2025-11-22T16:11:48.698Z',
      score: 0.0098,
      from: [],
      snippet: match ? { text: TEXT, match } : { text: TEXT },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

  // Where `find "redacted aws"` puts the highlight: the word `redacted`,
  // inside the marker.
  const inside = { start: TEXT.indexOf('redacted'), end: TEXT.indexOf('redacted') + 8 };

  it('holds at every width, with the highlight inside the mask', () => {
    const t = new Theme({ color: false, width: 80 });
    for (let w = 8; w <= 140; w++) {
      expect(balanced(snippetLine(hit(inside), t, w)), `width ${w}`).toBe(true);
    }
  });

  it('holds at every width with no highlight at all', () => {
    // The no-match branch is a different cutter (`clipToWords`) and had the
    // same defect for the same reason.
    const t = new Theme({ color: false, width: 80 });
    for (let w = 8; w <= 140; w++) {
      expect(balanced(snippetLine(hit(), t, w)), `width ${w}`).toBe(true);
    }
  });

  it('shows the whole mask at the width the screens are captured at', () => {
    // 74 is what `renderFind` hands a snippet at `--width 80`, and it is what
    // docs/screens/13-find-redacted.txt is cut to.
    const out = snippetLine(hit(inside), new Theme({ color: false, width: 80 }), 74);
    expect(out).toContain(MASK);
  });

  it('holds under --ascii, where the marker is folded to <…>', () => {
    const t = new Theme({ color: false, ascii: true, width: 80 });
    for (let w = 8; w <= 140; w++) {
      const out = t.asciiLine(snippetLine(hit(inside), t, w));
      // The ascii fold turns `‹`/`›` into `<`/`>`, so balance is asserted on
      // the marker word instead: an opening `<redacted` must be closed.
      const opens = (out.match(/<(?:redacted|elided)/g) ?? []).length;
      const closes = (out.match(/>/g) ?? []).length;
      expect(closes, `width ${w}: ${out}`).toBeGreaterThanOrEqual(opens);
    }
  });
});

/**
 * T10.1 — the cliff.
 *
 * The audit of 23 aug 2026 found `find`'s score carries no information about
 * whether the archive answers the question: 0.01836 for a true phrase hit and
 * 0.01639 for a topic the archive has never heard of, on the reference
 * machine. 1.12x. The cause is structural — reciprocal rank fusion is a
 * function of rank alone — so these tests are about the *second* axis, and
 * every one of them also asserts that the first axis did not move.
 *
 * The arithmetic itself is `tests/calibration.test.ts`; this is what it does
 * to a corpus.
 */
describe('recall: calibrated confidence — T10.1', () => {
  it('labels every hit, every block and the envelope, and never disagrees with itself', async () => {
    const r = await recall(db, 'pgbouncer transaction pooling', {}, { vectors: false });
    expect(r.sessions.length).toBeGreaterThan(0);
    // The envelope is the best block on the page, which is what makes
    // `confidence: none` and `sessions: []` two spellings of one fact.
    const best = r.sessions.map((s) => s.confidence);
    expect(best).toContain(r.confidence);
    for (const s of r.sessions) {
      expect(['strong', 'weak', 'none']).toContain(s.confidence);
      // The word and the number are one measurement, not two. If these could
      // drift, `--json` and the terminal would be reading different things.
      expect(s.confidence).toBe(s.calibration.confidence);
      expect(s.calibration.score).toBeGreaterThanOrEqual(0);
      expect(s.calibration.score).toBeLessThanOrEqual(1);
      for (const h of s.hits) expect(h.confidence).toBe(h.calibration.confidence);
    }
  });

  it('the human view prints exactly the words --json carries', async () => {
    // `find --json` emits `result.confidence` and `s.confidence` verbatim
    // (`packages/cli/src/commands/find.ts`). This pins the other half: the
    // rendered screen shows those same strings, on the headline and on every
    // block. Two views, one field.
    const r = await recall(db, 'pgbouncer transaction pooling', {}, { vectors: false });
    const out = renderFind(r, new Theme({ color: false, ascii: true, width: 80 }), new Date());
    const lines = out.split('\n');
    expect(lines[0]).toContain(r.confidence);
    for (const s of r.sessions) {
      const meta = lines.find((l) => l.includes(s.score.toFixed(4)));
      expect(meta, `no meta line for ${s.id}`).toBeDefined();
      expect(meta!).toContain(s.confidence);
    }
  });

  it('a true, distinctive topic still comes back, and comes back strong', async () => {
    const r = await recall(db, 'pgbouncer transaction pooling', {}, { vectors: false, minConfidence: 'weak' });
    expect(r.sessions.length).toBeGreaterThan(0);
    expect(r.confidence).toBe('strong');
    expect(has(r, ID.pgbouncer)).toBe(true);
  });

  it('an absent topic returns zero rows, and says how many it withheld', async () => {
    // Every one of these four words is in the corpus somewhere — there are
    // sessions about payments and about services — so bm25 finds rows and
    // ranks them, which is exactly the case the audit hit. What no
    // conversation in the corpus is *about* is kubernetes ingress.
    const q = 'kubernetes ingress payment service';
    const before = await recall(db, q, {}, { vectors: false, minConfidence: 'none' });
    expect(before.sessions.length).toBeGreaterThan(0);

    const after = await recall(db, q, {}, { vectors: false, minConfidence: 'weak' });
    expect(after.sessions).toEqual([]);
    expect(after.hits).toEqual([]);
    expect(after.confidence).toBe('none');
    expect(after.belowFloor).toBe(before.sessions.length);
  });

  it('the empty screen names the next verb, and names the escape hatch', async () => {
    const r = await recall(db, 'kubernetes ingress payment service', {}, { vectors: false, minConfidence: 'weak' });
    const out = renderFind(r, new Theme({ color: false, ascii: true, width: 80 }), new Date());
    expect(out).toContain('no match');
    // "nothing matches" would be false — things matched and were withheld —
    // and an agent told the wrong one of those widens a query that did not
    // need widening.
    expect(out).toContain('nothing in the index answers');
    expect(out).toContain('none of them enough');
    expect(out).toContain('--min-confidence none');
    // `05`: every verb ends with the next verb, and after an honest empty the
    // next verb is a narrower search — which is what makes the archaeologist's
    // "widen once, then stop" reachable at all.
    expect(out.trimEnd().split('\n').at(-1)).toContain('potsherd find');
  });

  it('invented words still return nothing, which they already did', async () => {
    // The audit's headline — "ten confident rows for a word that does not
    // exist in any human language" — did not reproduce on uncontaminated
    // tokens: fts5 finds no term and there is nothing to rank. This is a
    // regression control, not a fix, and it must hold at every floor.
    for (const min of ['none', 'weak', 'strong'] as const) {
      const r = await recall(db, 'vondrelic pashtomeer', {}, { vectors: false, minConfidence: min });
      expect(r.sessions).toEqual([]);
      expect(r.confidence).toBe('none');
      // Nothing was withheld, because nothing was found. The two empties are
      // different facts and the screen prints different last lines for them.
      expect(r.belowFloor).toBe(0);
    }
  });

  it('the escape hatch returns the withheld rows, labelled', async () => {
    // A human's "show me anything, I will judge" is legitimate; an agent's is
    // not. So the rows come back and they come back wearing the label that
    // says why they were hidden.
    const r = await recall(db, 'kubernetes ingress payment service', {}, { vectors: false, minConfidence: 'none' });
    expect(r.sessions.length).toBeGreaterThan(0);
    expect(r.sessions.every((s) => s.confidence === 'none')).toBe(true);
    expect(r.confidence).toBe('none');
    expect(r.minConfidence).toBe('none');
  });

  it('the floor removes rows and never reorders them', async () => {
    // The whole design: RRF stays the ranker, calibration is a second and
    // independent axis. If the floor could reorder, `--explain`'s ledger would
    // stop explaining the page it is printed under.
    for (const q of ['pgbouncer transaction pooling', 'the pooler decision', 'icon']) {
      const open = await recall(db, q, {}, { vectors: false, limit: 20, minConfidence: 'none' });
      const floored = await recall(db, q, {}, { vectors: false, limit: 20, minConfidence: 'weak' });
      const survivors = open.sessions.filter((s) => s.confidence !== 'none').map((s) => s.id);
      expect(floored.sessions.map((s) => s.id)).toEqual(survivors);
      for (const s of floored.sessions) {
        const same = open.sessions.find((o) => o.id === s.id)!;
        expect(s.score).toBeCloseTo(same.score, 12);
      }
    }
  });

  it('the calibrated score is not the fused score rescaled', async () => {
    // The audit prescribed normalising the fused score against the query's own
    // distribution. It cannot work: RRF is rank-only, so the top row maps to
    // 1.0 whether it is a bullseye or the least-bad of two bad rows. The proof
    // is a pair of queries whose top rows have the *same* fused score and
    // opposite calibrations — any function of the fused score alone would have
    // to give them the same answer.
    const good = await recall(db, 'pgbouncer transaction pooling', {}, { vectors: false, minConfidence: 'none' });
    const bad = await recall(db, 'kubernetes ingress payment service', {}, { vectors: false, minConfidence: 'none' });
    const g = good.sessions[0]!;
    const b = bad.sessions[0]!;
    expect(g.confidence).toBe('strong');
    expect(b.confidence).toBe('none');
    // Both are the top row of their own query, so **any** rescaling of the
    // fused score against that query's own distribution maps both to the same
    // value. What is left to tell them apart is the gap between the raw fused
    // numbers, and on this corpus that gap is 1.7x — the audit measured 1.67x
    // on a corpus a thousand times the size and called it fatal. The second
    // axis puts the same two rows more than three apart.
    expect(g.score / b.score).toBeLessThan(2);
    expect(g.calibration.score / b.calibration.score).toBeGreaterThan(3);
  });

  it('is off by default, because ask and graft hand their rows to a reader', async () => {
    // `recall()` labels everything and withholds nothing unless asked. `find`
    // asks; the shortlist builders do not, because a model that opens the
    // transcript can see for itself that a row is noise, and a floor that
    // silently shortened every shortlist would be a change to three verbs made
    // inside one.
    const r = await recall(db, 'kubernetes ingress payment service', {}, { vectors: false });
    expect(r.minConfidence).toBe('none');
    expect(r.sessions.length).toBeGreaterThan(0);
  });
});

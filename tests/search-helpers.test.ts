import { describe, expect, it } from 'vitest';
import { search } from '@potsherd/core';

const {
  buildExchangeFilters,
  hasMetadataFilters,
  knnCandidates,
  validateISODate,
  l2DistanceToCosineSimilarity,
  rrfScore,
  leadSnippet,
  matchSnippet,
  clipToWords,
  denseSnippet,
  isMostlyBoilerplate,
  wordMatchesToken,
} = search;

/**
 * These are the pieces of upstream's `search.ts` that survived the port. The
 * search itself did not — upstream's text path is `LIKE '%q%'` and the repo has
 * no fts5 anywhere — so T1.5 writes `find` on top of these.
 */
describe('search filters', () => {
  it('binds every value instead of concatenating it into SQL', () => {
    const { sql, params } = buildExchangeFilters({
      project: "/tmp/'; DROP TABLE exchanges;--",
      since: '2026-01-01',
      branch: 'main',
    });
    expect(sql).not.toContain('DROP');
    expect(sql.match(/\?/g)).toHaveLength(params.length);
    expect(params).toContain("/tmp/'; DROP TABLE exchanges;--");
  });

  it('includes sidechains by default — the whole point of the fork', () => {
    // Upstream hard-codes `AND e.is_sidechain = 0` at src/search.ts:165 and
    // :188, so 197 subagent transcripts on the reference machine are indexed
    // and never returned.
    expect(buildExchangeFilters({}).sql).toBe('');
    expect(buildExchangeFilters({ sidechains: 'include' }).sql).toBe('');
    expect(buildExchangeFilters({ sidechains: 'only' }).sql).toBe('AND e.is_sidechain = 1');
    expect(buildExchangeFilters({ sidechains: 'exclude' }).sql).toBe('AND e.is_sidechain = 0');
  });

  it('reads session metadata off the sessions table, not off every exchange', () => {
    const { sql } = buildExchangeFilters({ project: '/p', harness: 'codex', branch: 'main' });
    expect(sql).toContain('s.project = ?');
    expect(sql).toContain('s.harness = ?');
    expect(sql).toContain('s.git_branch = ?');
  });

  it('over-fetches KNN candidates when a metadata filter is active', () => {
    // vec0 applies KNN before WHERE, so a filtered search must ask for more.
    expect(hasMetadataFilters({})).toBe(false);
    expect(knnCandidates(10)).toBe(10);
    expect(hasMetadataFilters({ project: '/p' })).toBe(true);
    expect(knnCandidates(10, { project: '/p' })).toBe(30);
    expect(hasMetadataFilters({ sidechains: 'include' })).toBe(false);
    expect(hasMetadataFilters({ sidechains: 'only' })).toBe(true);
  });

  it('rejects a date it cannot parse', () => {
    expect(() => validateISODate('2026-08-01', '--since')).not.toThrow();
    expect(() => validateISODate('last tuesday', '--since')).toThrow(/--since/);
    expect(() => validateISODate('2026-13-45', '--until')).toThrow(/--until/);
  });
});

describe('similarity', () => {
  it('converts an L2 distance between unit vectors to cosine similarity', () => {
    expect(l2DistanceToCosineSimilarity(0)).toBe(1);
    expect(l2DistanceToCosineSimilarity(2)).toBe(-1);
    expect(l2DistanceToCosineSimilarity(Math.SQRT2)).toBeCloseTo(0, 10);
  });

  it('clamps rather than returning an impossible similarity', () => {
    expect(l2DistanceToCosineSimilarity(10)).toBe(-1);
  });

  it('ranks by reciprocal rank with k=60, as 03 §7 specifies', () => {
    expect(rrfScore(1)).toBeCloseTo(1 / 61, 12);
    expect(rrfScore(1)).toBeGreaterThan(rrfScore(2));
  });
});

describe('snippets', () => {
  it('collapses whitespace and marks truncation', () => {
    expect(leadSnippet('a\n\n  b')).toBe('a b');
    expect(leadSnippet('x'.repeat(300))).toHaveLength(201);
    expect(leadSnippet('x'.repeat(300)).endsWith('…')).toBe(true);
  });

  it('centres the window on the match and reports where to highlight it', () => {
    const text = `${'lead '.repeat(60)}pgbouncer${' tail'.repeat(60)}`;
    const snip = matchSnippet(text, 'pgbouncer');
    expect(snip.match).toBeDefined();
    expect(snip.text.slice(snip.match!.start, snip.match!.end)).toBe('pgbouncer');
    expect(snip.text.startsWith('…')).toBe(true);
  });

  it('falls back to the head of the text for a vector-only hit', () => {
    const snip = matchSnippet('nothing relevant here', 'pgbouncer');
    expect(snip.match).toBeUndefined();
    expect(snip.text).toBe('nothing relevant here');
  });
});

/**
 * The T1.7 review's three complaints about `find`, as tests.
 *
 *   1. snippets began mid-word — `"wn) that book consultations via Instagram"`
 *   2. a top-three result's only snippet was `[Image: source: /var/folders/…]`,
 *      so nothing on screen said why that result was there
 *   3. the second snippet line was routinely boilerplate with no query term in
 *      it at all
 *
 * Each of the three is one `it` below. The bar the reviewer set is the one
 * these encode: a stranger sees the block with no caption and understands what
 * was found and why.
 */
describe('snippet selection', () => {
  const tokens = ['idempotency', 'key', 'replay'];

  it('never starts or ends in the middle of a word', () => {
    const text =
      'A very long preamble about unrelated matters that goes on for quite a while ' +
      'and mentions nothing of interest whatsoever, before finally arriving at the ' +
      'idempotency key which is the thing that was actually asked about, and then ' +
      'continuing for another long stretch of prose that also has to be cut off.';
    const snip = denseSnippet(text, tokens, 90);
    const body = snip.text.replace(/^…/, '').replace(/…$/, '');
    // Both edges of the quoted span exist verbatim in the source, bounded by
    // whitespace or by the ends of the text.
    const at = text.indexOf(body.slice(0, 20));
    expect(at, snip.text).toBeGreaterThanOrEqual(0);
    expect(at === 0 || /\s/.test(text[at - 1]!)).toBe(true);
    const tail = body.slice(-20);
    const end = text.indexOf(tail) + tail.length;
    expect(end === text.length || /\s/.test(text[end]!)).toBe(true);
  });

  it('quotes a short text whole rather than windowing it for no reason', () => {
    const text = 'two rows land in the ledger when a replay arrives';
    const snip = denseSnippet(text, tokens, 200);
    expect(snip.text).toBe(text);
    expect(snip.text.slice(snip.match!.start, snip.match!.end)).toBe('replay');
  });

  it('picks the densest span, not the first one', () => {
    const filler = 'padding words that carry no meaning at all here. '.repeat(4);
    const text =
      'the key was rotated last week. ' +
      filler +
      'the idempotency key makes a replay safe. ' +
      filler;
    const snip = denseSnippet(text, tokens, 80);
    expect(snip.text).toContain('idempotency');
    expect(snip.text).toContain('replay');
  });

  it('highlights the rarest matched word, not the commonest', () => {
    const text = 'the key is fine; the idempotency key is the one that matters';
    const snip = denseSnippet(text, tokens, 200);
    expect(snip.text.slice(snip.match!.start, snip.match!.end)).toBe('idempotency');
  });

  it('matches across a plural without highlighting nothing', () => {
    expect(wordMatchesToken('requests', 'request')).toBe(true);
    expect(wordMatchesToken('icon', 'icons')).toBe(true);
    expect(wordMatchesToken('catastrophe', 'cat')).toBe(false);
  });

  it('knows machine text when it sees it', () => {
    expect(isMostlyBoilerplate('[Image: source: /var/folders/x7/T/clipboard-1.png]')).toBe(true);
    expect(isMostlyBoilerplate('/Users/someone/projects/thing/src/index.ts')).toBe(true);
    expect(isMostlyBoilerplate('<system-reminder>')).toBe(true);
    expect(isMostlyBoilerplate('the idempotency key makes a replay safe')).toBe(false);
  });

  it('skips a boilerplate span when a real sentence is available', () => {
    const text =
      '[Image: source: /var/folders/x7/878s1bxj4c950snx6h2200k00000gn/T/clipboard-1.png]\n' +
      'the idempotency key makes a replay safe when the client gives up and tries again';
    const snip = denseSnippet(text, tokens, 90);
    expect(snip.text).not.toContain('[Image:');
    expect(snip.text).toContain('idempotency');
  });

  it('still says something when the whole text is boilerplate', () => {
    const text = '[Image: source: /var/folders/x7/T/clipboard-1.png]';
    const snip = denseSnippet(text, tokens, 90);
    expect(snip.text.length).toBeGreaterThan(0);
    expect(snip.match).toBeUndefined();
  });

  it('clips to a word edge, and gives up when there is no edge to find', () => {
    expect(clipToWords('one two three four', 12)).toBe('one two…');
    expect(clipToWords('x'.repeat(40), 12)).toBe('x'.repeat(11) + '…');
    expect(clipToWords('short', 12)).toBe('short');
  });
});

/**
 * **T4.8.** A mask is one atom, and a word edge is not a safe edge.
 *
 * Redaction runs at index time, so every string a snippet is cut out of can
 * carry `‹redacted:basic-auth:201b2d22›` — which is four *words* to
 * `wordSpans` (`redacted`, `basic`, `auth`, `201b2d22`), so three of its
 * internal boundaries are legal word edges. Every cutter in the snippet path
 * happily stopped at one, and `docs/screens/13-find-redacted.txt` had been
 * failing `scripts/make-screens.sh`'s own "a mask is visible on this screen"
 * assertion for the whole of phases 2, 3 and 4 as a result: the only mask on
 * the published screen came out as `postgres://ingest:‹redacted…`.
 *
 * Half a mask is worse than no mask. It reads as corrupt output, and it
 * invites the reader of a screenshot to conclude that potsherd printed half of
 * a credential — which is the one thing a tool that redacts must never look
 * like it did.
 *
 * The property is asserted by *balance* rather than by matching a shape: `‹`
 * and `›` cannot occur in base64, in a shell token or in a json key
 * (`redact.ts`, `redact-elide.ts`), so an unbalanced one in the output is a
 * cut marker and nothing else — whichever end it was cut at.
 */
describe('a snippet never cuts a redaction mask in half', () => {
  /** The shape `index` leaves behind when a dsn is pasted into a prompt. */
  const MASK = '‹redacted:basic-auth:201b2d22›';
  const DSN = `the importer cannot reach the pooler — postgres://ingest:${MASK}@db.internal:6432/crm times out but the direct port is fine`;

  /** True when every `‹` in `s` is closed and no `›` opens one. */
  const balanced = (s: string): boolean => {
    let depth = 0;
    for (const ch of s) {
      if (ch === '‹') depth++;
      else if (ch === '›' && --depth < 0) return false;
    }
    return depth === 0;
  };

  it('holds for clipToWords at every width', () => {
    // Every width, not a chosen one: the cut lands inside the mask for a
    // contiguous run of them, and picking a width by hand is how the original
    // defect survived a test suite that already covered this function.
    for (let w = 1; w <= DSN.length + 2; w++) {
      expect(balanced(clipToWords(DSN, w)), `width ${w}`).toBe(true);
    }
  });

  it('holds for the 200-character window, at every width', () => {
    const long = `${'lead word '.repeat(20)}${DSN} ${'tail word '.repeat(20)}`;
    for (let w = 8; w <= 240; w++) {
      const snip = denseSnippet(long, ['redacted', 'aws'], w);
      expect(balanced(snip.text), `width ${w}`).toBe(true);
    }
  });

  it('keeps the whole mask rather than half of it when there is room', () => {
    const snip = denseSnippet(DSN, ['redacted'], 90);
    expect(snip.text).toContain(MASK);
  });

  /**
   * The elision marker is the same atom with a different word: a `Read` result
   * holding a pasted screenshot becomes `‹elided:image/png:109362 bytes›`, and
   * it contains a space, so it is even easier to cut at a "word edge".
   */
  it('holds for an elision marker too', () => {
    const text = `${'lead word '.repeat(10)}‹elided:image/png:109362 bytes› ${'tail word '.repeat(10)}`;
    for (let w = 8; w <= 160; w++) {
      expect(balanced(clipToWords(text, w)), `clip ${w}`).toBe(true);
      expect(balanced(denseSnippet(text, ['elided'], w).text), `dense ${w}`).toBe(true);
    }
  });
});

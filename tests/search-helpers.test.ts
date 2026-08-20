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

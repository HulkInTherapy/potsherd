import io

p = 'tests/recall.test.ts'
s = open(p).read()

marker = """describe('recall: the tri-state filters', () => {"""
block = '''describe('recall: the fusion — T3.1', () => {
  /**
   * Session diversification, `03` §7: at most three hits from one conversation
   * on the top list. Without it a single long session that says the query's
   * words twenty times fills the page and nothing else can be seen.
   */
  it('keeps at most three hits from any one conversation', async () => {
    const r = await recall(db, 'the', {}, { vectors: false, limit: 20 });
    expect(r.hits.length).toBeGreaterThan(3);
    const per = new Map<string, number>();
    for (const h of r.hits) per.set(h.sessionId, (per.get(h.sessionId) ?? 0) + 1);
    for (const [, n] of per) expect(n).toBeLessThanOrEqual(3);
    for (const s of r.sessions) expect(s.hits.length).toBeLessThanOrEqual(3);
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

describe('recall: the tri-state filters', () => {'''
assert marker in s
s = s.replace(marker, block, 1)

s = s.replace("""import {
  db as store,
  fallbackTitle,""", """import {
  CORROBORATION,
  WEIGHTS,
  db as store,
  fallbackTitle,""")
open(p, 'w').write(s)
print('ok')

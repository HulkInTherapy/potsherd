import { afterAll, describe, expect, it } from 'vitest';
import { db as store, embeddings, vecStatus } from '@potsherd/core';
import { runFind } from '../packages/cli/src/commands/find.js';
import { rmrf, tempDir } from './helpers.js';

/**
 * `semantic search: warming (N of M embedded)`, on **every** `find` — FIX-B D9.
 *
 * §A2 item 2 is one sentence and it names the verb: *while pending, every
 * `find` prints one line: `semantic search: warming (N of M embedded)` — a
 * status, not a degradation apology.* It was implemented on `index` and on
 * `doctor` and never on `find`. `vecStatus().line` had exactly one consumer,
 * and the test that covered it asserted the **string builder** rather than the
 * verb — which is why a missing call site could not fail anything.
 *
 * So these assertions go through `runFind` itself, human view and `--json`,
 * and they compare against `vecStatus(db, root)` rather than against a
 * hard-coded sentence: the point is not the words, it is that `find` is inside
 * the one source of truth with `index`, `doctor` and `stats`.
 */

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) rmrf(r);
});

/** An index with four exchanges, one of them embedded: warming, by definition. */
function warmingRoot(): string {
  const root = tempDir('potsherd-find-warm-');
  roots.push(root);
  const db = store.open({ root });
  try {
    db.exec(`INSERT INTO sessions (id, harness, project, source_path, indexed_at, started_at)
             VALUES ('s1', 'claude', '/tmp/p', '/tmp/p/s1.jsonl', '2026-08-23T00:00:00Z', '2026-08-20T00:00:00Z')`);
    const ex = db.prepare(
      `INSERT INTO exchanges (id, session_id, seq, ts, user_text, assistant_text)
       VALUES (?, 's1', ?, ?, ?, ?)`,
    );
    for (let i = 0; i < 4; i += 1) {
      ex.run(`e${i}`, i, `2026-08-2${i}T00:00:00Z`, `pgbouncer pool size ${i}`, 'we raised it');
    }
    db.prepare('UPDATE exchanges SET embedding_version = ? WHERE id = ?').run(
      embeddings.EMBEDDING_VERSION,
      'e0',
    );
  } finally {
    db.close();
  }
  return root;
}

async function capture(o: Record<string, unknown>): Promise<string> {
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string | Uint8Array) => {
    chunks.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  try {
    await runFind({ minConfidence: 'none', vectors: 'off', ...o } as Parameters<typeof runFind>[0]);
  } finally {
    process.stdout.write = write;
  }
  return chunks.join('');
}

function expected(root: string): string {
  const db = store.open({ root });
  try {
    return vecStatus(db, root).line!;
  } finally {
    db.close();
  }
}

describe('find says what semantic search is doing', () => {
  it('prints the warming line, in the wording every other verb uses', async () => {
    const root = warmingRoot();
    const out = await capture({ query: 'pgbouncer', potsherdDir: root, color: false });
    expect(expected(root)).toBe('semantic search: warming (1 of 4 embedded)');
    expect(out).toContain(expected(root));
    // A status, not an apology and not an offer: nothing to run, nothing sold.
    expect(out).not.toMatch(/index --embed|degraded|unavailable — install/);
  });

  it('prints it even when nothing matched, because the shortfall is the point', async () => {
    const root = warmingRoot();
    const out = await capture({
      query: 'a topic this archive has never heard of',
      potsherdDir: root,
      color: false,
    });
    expect(out).toContain(expected(root));
  });

  it('carries the same report on --json, so a script reads what a person reads', async () => {
    const root = warmingRoot();
    const out = await capture({ query: 'pgbouncer', potsherdDir: root, json: true });
    const j = JSON.parse(out) as { semantic?: { line: string | null; embedded: number; total: number } };
    expect(j.semantic?.line).toBe(expected(root));
    expect(j.semantic?.embedded).toBe(1);
    expect(j.semantic?.total).toBe(4);
  });

  it('says nothing at all once every row is embedded', async () => {
    const root = warmingRoot();
    const db = store.open({ root });
    db.prepare('UPDATE exchanges SET embedding_version = ?').run(embeddings.EMBEDDING_VERSION);
    db.close();
    const out = await capture({ query: 'pgbouncer', potsherdDir: root, color: false });
    expect(expected(root)).toBeNull();
    expect(out).not.toContain('semantic search:');
  });
});

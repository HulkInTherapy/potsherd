import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { db as store, embeddings, vecStatus } from '@potsherd/core';
import { runFind } from '../packages/cli/src/commands/find.js';
import { fitNote, vectorNote } from '../packages/core/src/doctor-line.js';
import { bytes as fmtBytes, num as fmtNum } from '../packages/core/src/format.js';
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

/** The same index with **nothing** embedded: `pending`, not `warming`. */
function pendingRoot(): string {
  const root = warmingRoot();
  const db = store.open({ root });
  try {
    db.prepare('UPDATE exchanges SET embedding_version = NULL').run();
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

function report(root: string): { working?: boolean; embedded: number; total: number } {
  const db = store.open({ root });
  try {
    return vecStatus(db, root).report!;
  } finally {
    db.close();
  }
}

/**
 * Hold the embed lane the way the background worker holds it.
 *
 * FIX-F C2. `.lock.embed` with an `owner.json` naming a live pid is exactly
 * what `lock.holder()` reads and exactly what `runEmbedWorker` writes; the
 * fixtures above never had one, which is why every one of them was described
 * as `warming`.
 */
function holdEmbedLane(root: string): () => void {
  const dir = path.join(root, '.lock.embed');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'owner.json'),
    JSON.stringify({
      pid: process.pid,
      op: 'embed',
      at: new Date().toISOString(),
      host: process.env.HOSTNAME ?? '',
    }),
  );
  return () => rmrf(dir);
}

describe('find says what semantic search is doing', () => {
  it('prints the warming line, in the wording every other verb uses', async () => {
    // FIX-F C2 — with a worker actually holding the embed lane, which is the
    // state the word `warming` has always claimed and which this fixture did
    // not have. `expected()` is still `vecStatus().line`: the point of the
    // original test was that `find` is inside the one source of truth, and it
    // still is.
    const root = warmingRoot();
    const release = holdEmbedLane(root);
    try {
      const out = await capture({ query: 'pgbouncer', potsherdDir: root, color: false });
      expect(expected(root)).toBe('semantic search: warming (1 of 4 embedded)');
      expect(out).toContain(expected(root));
      // A status, not an apology and not an offer: nothing to run, nothing sold.
      expect(out).not.toMatch(/index --embed|degraded|unavailable — install/);
    } finally {
      release();
    }
  });

  it('prints it even when nothing matched, because the shortfall is the point', async () => {
    const root = warmingRoot();
    const release = holdEmbedLane(root);
    try {
      const out = await capture({
        query: 'a topic this archive has never heard of',
        potsherdDir: root,
        color: false,
      });
      expect(out).toContain(expected(root));
    } finally {
      release();
    }
  });

  /**
   * FIX-F C2 — and the state the verifier actually found `find` in.
   *
   * After `index --no-embed`, on a machine that cannot fetch the runtime, and
   * after an embedder was killed, nothing holds the embed lane and nothing
   * will. `warming` says the work is already running — `warmingLine`'s own
   * docstring says "there is nothing for the reader to do" — so on this index
   * it is the one sentence on the screen that is false, and it sat directly
   * above the line that says the true thing.
   */
  it('does not say warming when nothing is embedding, and prints the count anyway', async () => {
    // FIX-F round 2, and this is §4.4 closing. Round 1 could only *drop* the
    // false sentence — `vecStatus().line` was shared with `index`, which
    // legitimately says `warming` the instant it spawns a worker — so `find`
    // said nothing at all here and the reader lost the count. `statusLine` is
    // honest now, so the line is printed and it carries `N of M` again.
    const root = warmingRoot();
    // No lock: nobody is embedding this index.
    expect(report(root).working).toBe(false);
    const out = await capture({ query: 'pgbouncer', potsherdDir: root, color: false });
    expect(out).not.toContain('semantic search: warming');
    expect(out).toContain('semantic search: not running (1 of 4 embedded) — it stopped partway');
    // The count is the point: a sentence with no denominator is the defect
    // FIX-C closed, and saying nothing at all was the price round 1 paid.
    expect(out).toMatch(/1 of 4 embedded/);
    // And still no command the reader might not be able to run.
    expect(out).not.toMatch(/index --embed/);
  });

  it('carries the same report on --json, so a script reads what a person reads', async () => {
    const root = warmingRoot();
    const release = holdEmbedLane(root);
    try {
      const out = await capture({ query: 'pgbouncer', potsherdDir: root, json: true });
      const j = JSON.parse(out) as {
        semantic?: { line: string | null; embedded: number; total: number; working?: boolean };
        vectors?: { working?: boolean };
      };
      expect(j.semantic?.line).toBe(expected(root));
      expect(j.semantic?.embedded).toBe(1);
      expect(j.semantic?.total).toBe(4);
      // FIX-F C2 — the fact, not just the sentence, so a script can tell
      // *yet* from *never* without parsing English.
      expect(j.semantic?.working).toBe(true);
      expect(j.vectors?.working).toBe(true);
    } finally {
      release();
    }
  });

  it('and the same script can see when nothing is running', async () => {
    const root = warmingRoot();
    const out = await capture({
      query: 'pgbouncer',
      potsherdDir: root,
      json: true,
      vectors: 'auto',
    });
    const j = JSON.parse(out) as {
      semantic?: { working?: boolean; line?: string | null };
      vectors?: { working?: boolean; reason?: string };
    };
    expect(j.semantic?.working).toBe(false);
    expect(j.vectors?.working).toBe(false);
    expect(String(j.vectors?.reason)).toMatch(/is not running|nothing is embedding/);
    // FIX-F round 2 — the C2 shape that survived inside the fix for C2. The
    // sentence and the fact beside it now agree; they did not in round 1,
    // where `line` said `warming` and `working` said `false` on one object.
    expect(String(j.semantic?.line)).toMatch(/not running/);
    expect(String(j.semantic?.line)).not.toMatch(/warming/);
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

  /**
   * C-6 of round 5 closed the `doctor` half of this and left the `find` half.
   *
   * On the first run of a fresh install there is a worker holding the embed
   * lane and no runtime on disk: it is spending minutes fetching 46.1 MB
   * before it can embed a single row. `doctor` says so —
   * `vectors  —  0 of 4 · fetching the 46.1 MB runtime` — and `find` said
   * `semantic search: warming (0 of 4 embedded)`, which tells the reader to
   * wait for a pass that has not yet got its model. Two surfaces, one fact,
   * and only one of them carried the clause.
   */
  it('names the fetch while the runtime is still coming down, as doctor does', async () => {
    const root = pendingRoot();
    const release = holdEmbedLane(root);
    try {
      const r = report(root) as { phase: string; runtimeReady: boolean; acquireBytes: number };
      // The premise, established rather than assumed: a worker is alive, the
      // runtime is not on disk, and nothing is embedded yet.
      expect(r.phase).toBe('pending');
      expect(r.runtimeReady).toBe(false);
      expect(report(root).working).toBe(true);

      // What `doctor` puts on the row, from the same report object.
      // The same two formatters `vec.ts` hands it, so the clause compared
      // below is the one a real `doctor` prints and not a default spelling.
      const note = fitNote(vectorNote(r as never, { num: fmtNum, bytes: fmtBytes }).parts, 120);
      expect(note).toMatch(/fetching the [\d.]+ MB runtime/);
      const clause = /fetching the [\d.]+ MB runtime/.exec(note)![0];

      const out = await capture({ query: 'pgbouncer', potsherdDir: root, color: false });
      expect(out).toContain('semantic search: warming (0 of 4 embedded)');
      // The clause `doctor` prints, on the line `find` prints, character for
      // character — not a second sentence that means roughly the same thing.
      expect(out).toContain(clause);
    } finally {
      release();
    }
  });
});

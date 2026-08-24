import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  db as store,
  embeddings,
  paths,
  renderStats,
  sessionStats,
  Theme,
  vecStatus,
} from '@potsherd/core';
import { rmrf, tempDir } from './helpers.js';

/**
 * Semantic search is always on, acquired lazily, and never native.
 *
 * Phase 10 §A2, and the product law above it: *the user or agent never
 * configures capability… if a capability is heavy, it is acquired lazily and
 * automatically on first use.* These are the regression fixtures for the three
 * ways that used to fail.
 *
 *   1. **The store needed a native extension.** `vec_exchanges` was a vec0
 *      virtual table, absent on a clean `npm i -g potsherd`, so vectors had
 *      nowhere to live. It is a view over an ordinary blob table now, with the
 *      same SQL surface, answered by a scan.
 *   2. **The runtime needed a 677 MB native install.** It is fetched, verified
 *      and executed as WebAssembly, into potsherd's own directory and nowhere
 *      else, and a failure leaves a working text index and one honest line.
 *   3. **`doctor` and `index` disagreed in print** (audit §2 F2). They read one
 *      function now, and this file pins that they agree.
 *
 * The cache these tests use is a temporary directory, always. Nothing here may
 * write to `~/.potsherd`.
 */

const MODEL_CACHE = path.join(os.tmpdir(), 'potsherd-test-models');
const ready = embeddings.isEmbeddingReady(MODEL_CACHE);

/** A plain 80-column theme, so the assertions are about wording not colour. */
function theme() {
  return new Theme({ color: false, width: 80 });
}

/** A 384-float unit vector, deterministic from a seed. */
function unit(seed: number): number[] {
  let s = seed || 1;
  const a: number[] = [];
  let n = 0;
  for (let i = 0; i < embeddings.EMBEDDING_DIMENSIONS; i += 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const v = s / 0x7fffffff - 0.5;
    a.push(v);
    n += v * v;
  }
  n = Math.sqrt(n) || 1;
  return a.map((v) => v / n);
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);
}

describe('the vector store needs no native extension', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots) rmrf(r);
  });

  function freshDb() {
    const root = tempDir('potsherd-vec-');
    roots.push(root);
    return { root, db: store.open({ root }) };
  }

  it('applies every migration, so the schema is never held back by sqlite-vec', () => {
    const { db } = freshDb();
    // Migrations 4 and 8 used to decline on a machine without the extension,
    // and `schemaVersion()` counts contiguously — so one decline reported
    // `schema v3 of v9` on a working install and stopped there forever.
    expect(store.schemaVersion(db)).toBe(store.latestSchemaVersion());
    db.close();
  });

  it('answers the vec0 query shape verbatim, so nothing above it changed', () => {
    const { db } = freshDb();
    const insert = db.prepare('INSERT INTO vec_exchanges (id, embedding) VALUES (?, ?)');
    const vectors = new Map<string, number[]>();
    for (let i = 0; i < 200; i += 1) {
      const v = unit(i + 1);
      vectors.set(`e${i}`, v);
      insert.run(`e${i}`, embeddings.embeddingToBlob(v));
    }

    // The exact statement `recall.ts` writes, unchanged since it was vec0.
    const query = unit(7);
    const hits = db
      .prepare(
        `SELECT id, distance FROM vec_exchanges
          WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
      )
      .all(embeddings.embeddingToBlob(query), 5) as { id: string; distance: number }[];

    expect(hits).toHaveLength(5);
    // Ground truth computed in JavaScript, independent of sqlite.
    const truth = [...vectors.entries()]
      .map(([id, v]) => ({ id, d: Math.sqrt(v.reduce((s, x, i) => s + (x - (query[i] ?? 0)) ** 2, 0)) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 5);
    expect(hits.map((h) => h.id)).toEqual(truth.map((t) => t.id));
    for (const [i, hit] of hits.entries()) expect(hit.distance).toBeCloseTo(truth[i]!.d, 6);
    // Nearest is the row the query was built from, at distance ~0.
    expect(hits[0]!.id).toBe('e6');
    expect(dot(vectors.get('e6')!, query)).toBeGreaterThan(0.999);

    // The other three statements the codebase writes against these names.
    expect((db.prepare('SELECT COUNT(*) AS n FROM vec_exchanges').get() as { n: number }).n).toBe(200);
    expect(
      (db.prepare('SELECT id, embedding FROM vec_exchanges WHERE id IN (?,?)').all('e1', 'e2') as {
        id: string;
      }[]).map((r) => r.id),
    ).toEqual(['e1', 'e2']);
    db.prepare('DELETE FROM vec_exchanges WHERE id = ?').run('e1');
    expect((db.prepare('SELECT COUNT(*) AS n FROM vec_exchanges').get() as { n: number }).n).toBe(199);
    db.close();
  });

  it('ranks by distance rather than by insertion order', () => {
    // A view whose `distance` column were a constant would still return rows
    // and still look like a working KNN — this is the assertion that catches
    // it. The nearest neighbour is inserted last, so row order and rank order
    // disagree by construction.
    const { db } = freshDb();
    const insert = db.prepare('INSERT INTO vec_exchanges (id, embedding) VALUES (?, ?)');
    const query = unit(99);
    for (let i = 0; i < 20; i += 1) insert.run(`x${i}`, embeddings.embeddingToBlob(unit(i + 300)));
    insert.run('needle', embeddings.embeddingToBlob(query));
    const hits = db
      .prepare(
        `SELECT id, distance FROM vec_exchanges
          WHERE embedding MATCH ? ORDER BY distance LIMIT 3`,
      )
      .all(embeddings.embeddingToBlob(query)) as { id: string; distance: number }[];
    expect(hits[0]!.id).toBe('needle');
    expect(hits[0]!.distance).toBeLessThan(1e-6);
    expect(hits[1]!.distance).toBeGreaterThan(hits[0]!.distance);
    db.close();
  });

  it('reports itself available with no extension at all', () => {
    const { db, root } = freshDb();
    const status = vecStatus(db, root);
    expect(status.available).toBe(true);
    expect(status.backend).toBe('scan');
    db.close();
  });
});

describe('doctor and index read one source of truth', () => {
  it('renders the same vectors row from the same call', () => {
    const root = tempDir('potsherd-vec-agree-');
    const db = store.open({ root });
    try {
      db.exec(`INSERT INTO sessions (id, harness, project, source_path, indexed_at)
               VALUES ('s1', 'claude', '/tmp/p', '/tmp/p/s1.jsonl', '2026-08-23T00:00:00Z')`);
      const ex = db.prepare(
        `INSERT INTO exchanges (id, session_id, seq, ts, user_text, assistant_text)
         VALUES (?, 's1', ?, ?, ?, '')`,
      );
      for (let i = 0; i < 4; i += 1) ex.run(`x${i}`, i, `2026-08-2${i}T00:00:00Z`, `text ${i}`);
      db.prepare('UPDATE exchanges SET embedding_version = ? WHERE id = ?').run(
        embeddings.EMBEDDING_VERSION,
        'x0',
      );

      // This is the call. Both verbs make it; neither computes anything else.
      const a = vecStatus(db, root);

      // NOT `vecStatus(...) === vecStatus(...)`. That was the assertion here
      // and it cannot fail — a pure function called twice against an unchanged
      // database agrees with itself no matter what it computes, so it would
      // have stayed green through any wrong answer. It is the "benchmark that
      // cannot fail" this project keeps finding, in the test written to prove
      // the fix for two verbs disagreeing.
      //
      // What "one source of truth" actually claims is that the three RENDERINGS
      // of the fact — the structured report, the table row, and the human
      // sentence — carry the same numbers. So each is checked against the
      // others, and any of them drifting breaks this.
      expect(a.line).toContain(`${String(a.report?.embedded)} of ${String(a.report?.total)}`);
      expect(a.row?.value).toBe(String(a.report?.embedded));
      expect((a.report?.embedded ?? 0) + (a.report?.pending ?? 0)).toBe(a.report?.total);

      expect(a.report?.embedded).toBe(1);
      expect(a.report?.pending).toBe(3);
      expect(a.report?.total).toBe(4);
      expect(a.report?.phase).toBe('warming');
      expect(a.row?.value).toBe('1');
      // The status line is the audit's wording: a status, not an apology, and
      // with no command in it.
      expect(a.line).toBe('semantic search: warming (1 of 4 embedded)');
      expect(a.line).not.toMatch(/potsherd |install|unavailable|degraded/);
    } finally {
      db.close();
      rmrf(root);
    }
  });

  it('never truncates the first clause of the note, however narrow', () => {
    // The `04` leftover: the row was clipped to a fixed width after the note
    // had been built, so the reason — the part a reader needs — was the part
    // that got cut.
    const root = tempDir('potsherd-vec-note-');
    const db = store.open({ root });
    try {
      const status = vecStatus(db, root);
      const row = status.row!;
      for (const width of [12, 20, 40, 80]) {
        const note = row.note(width);
        expect(note.length, `width ${width}`).toBeGreaterThan(0);
        expect(row.parts[0]!.startsWith(note.split(' · ')[0]!)).toBe(true);
        expect(note.endsWith('…')).toBe(false);
      }
    } finally {
      db.close();
      rmrf(root);
    }
  });

  it('gives stats the same two numbers, ghost prompts included', () => {
    // FIX-B D2. `doctor` and `index` said `warming 142 of 4,699` while `stats`
    // said `1,586 pending · hybrid search on`, 2.9x apart, on one index in one
    // minute. `stats.ts` counted `exchanges` alone and `vec.ts` counted
    // `exchanges` + `ghost_prompts`, and a ghost prompt is a row that needs a
    // vector exactly as much as an exchange does. The privacy guard could not
    // see it: it proves screen == live output, never live output == truth.
    const root = tempDir('potsherd-vec-stats-');
    const db = store.open({ root });
    try {
      db.exec(`INSERT INTO sessions (id, harness, project, source_path, indexed_at)
               VALUES ('s1', 'claude', '/tmp/p', '/tmp/p/s1.jsonl', '2026-08-23T00:00:00Z')`);
      const ex = db.prepare(
        `INSERT INTO exchanges (id, session_id, seq, ts, user_text, assistant_text)
         VALUES (?, 's1', ?, ?, ?, '')`,
      );
      for (let i = 0; i < 3; i += 1) ex.run(`x${i}`, i, `2026-08-2${i}T00:00:00Z`, `text ${i}`);
      db.exec(`INSERT INTO ghosts (session_id, harness, project, prompt_count)
               VALUES ('g1', 'claude', '/tmp/p', 4)`);
      const gp = db.prepare(
        `INSERT INTO ghost_prompts (id, session_id, seq, ts, text) VALUES (?, 'g1', ?, ?, ?)`,
      );
      for (let i = 0; i < 4; i += 1) gp.run(`g${i}`, i, `2026-08-1${i}T00:00:00Z`, `prompt ${i}`);
      db.prepare('UPDATE exchanges SET embedding_version = ? WHERE id = ?').run(
        embeddings.EMBEDDING_VERSION,
        'x0',
      );
      db.prepare('UPDATE ghost_prompts SET embedding_version = ? WHERE id = ?').run(
        embeddings.EMBEDDING_VERSION,
        'g0',
      );

      const truth = vecStatus(db, root).report!;
      expect(truth.embedded).toBe(2);
      expect(truth.pending).toBe(5);

      const fr = sessionStats(db, { root }).freshness;
      expect(fr.vectors).toBe(truth.embedded);
      expect(fr.vectorsPending).toBe(truth.pending);
      // And the sentence, not only the number: three verbs, one wording.
      expect(renderStats(sessionStats(db, { root }), theme())).toContain(
        vecStatus(db, root).row!.parts[0],
      );
    } finally {
      db.close();
      rmrf(root);
    }
  });

  it('counts pending from the stamp, so a stale vector is not counted as done', () => {
    const root = tempDir('potsherd-vec-stamp-');
    const db = store.open({ root });
    try {
      db.exec(`INSERT INTO sessions (id, harness, project, source_path, indexed_at)
               VALUES ('s1', 'claude', '/tmp/p', '/tmp/p/s1.jsonl', '2026-08-23T00:00:00Z')`);
      db.exec(`INSERT INTO exchanges (id, session_id, seq, user_text, assistant_text, embedding_version)
               VALUES ('old', 's1', 0, 'a', 'b', 999)`);
      expect(vecStatus(db, root).report?.pending).toBe(1);
      expect(vecStatus(db, root).report?.embedded).toBe(0);
    } finally {
      db.close();
      rmrf(root);
    }
  });
});

describe('acquisition is lazy, verified, and confined', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of ['POTSHERD_RUNTIME_BASE', 'POTSHERD_MODEL_BASE', 'POTSHERD_OFFLINE']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('knows what is missing without touching the network', () => {
    const dir = tempDir('potsherd-acq-');
    const plan = embeddings.acquisitionPlan(dir);
    expect(plan.complete).toBe(false);
    expect(plan.missing.length).toBe(embeddings.requiredFiles().length);
    expect(plan.bytes).toBe(embeddings.ACQUIRE_BYTES);
    // The whole first run is tens of megabytes, not hundreds: that is the
    // difference between this and the 677 MB native install it replaces.
    expect(plan.bytes).toBeLessThan(60_000_000);
    expect(embeddings.isEmbeddingReady(dir)).toBe(false);
    rmrf(dir);
  });

  it('pins every file to a size and a digest that ship in the source', () => {
    for (const f of embeddings.requiredFiles()) {
      expect(f.sha256, f.name).toMatch(/^[0-9a-f]{64}$/);
      expect(f.bytes, f.name).toBeGreaterThan(0);
      // Nothing may be written outside `~/.potsherd/models`, so no name may
      // climb out of it or be absolute.
      expect(f.name.startsWith('/'), f.name).toBe(false);
      expect(f.name.includes('..'), f.name).toBe(false);
    }
  });

  it('refuses immediately when the machine is offline, and writes nothing', async () => {
    const dir = tempDir('potsherd-acq-offline-');
    process.env['POTSHERD_OFFLINE'] = '1';
    await expect(embeddings.acquire(dir)).rejects.toThrow(/offline/);
    expect(fs.readdirSync(dir)).toEqual([]);
    rmrf(dir);
  });

  it('rejects a file whose bytes do not match its digest, and leaves nothing behind', async () => {
    // A captive portal, a truncated download, a substituted binary: all three
    // arrive as bytes that are not the bytes, and all three must end with the
    // capability absent rather than with a wrong file executed.
    const served = Buffer.from('not the runtime you were looking for');
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(served);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const dir = tempDir('potsherd-acq-bad-');
    try {
      // `tests/setup.ts` sets POTSHERD_OFFLINE so that no test ever pulls the
      // real 48 MB runtime. This one has a server of its own to talk to, so it
      // lifts that for the length of the fetch and nothing else.
      delete process.env['POTSHERD_OFFLINE'];
      process.env['POTSHERD_RUNTIME_BASE'] = `http://127.0.0.1:${port}`;
      process.env['POTSHERD_MODEL_BASE'] = `http://127.0.0.1:${port}`;
      await expect(embeddings.acquire(dir)).rejects.toThrow(/checksum|size/);
      const left = fs.readdirSync(dir, { recursive: true }) as string[];
      expect(left.filter((f) => f.endsWith('.part'))).toEqual([]);
      expect(embeddings.isEmbeddingReady(dir)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmrf(dir);
    }
  });

  it('names the hosts it contacts, derived from the bases it downloads from', () => {
    expect(embeddings.runtimeHosts()).toContain('huggingface.co');
    process.env['POTSHERD_RUNTIME_BASE'] = 'http://127.0.0.1:9';
    process.env['POTSHERD_MODEL_BASE'] = 'http://127.0.0.1:9';
    expect(embeddings.runtimeHosts()).toBe('127.0.0.1:9');
  });
});

describe('the embedding pass', () => {
  function corpus(): { root: string; db: ReturnType<typeof store.open> } {
    const root = tempDir('potsherd-embed-');
    const db = store.open({ root });
    db.exec(`INSERT INTO sessions (id, harness, project, source_path, indexed_at)
             VALUES ('s1', 'claude', '/tmp/p', '/tmp/p/s1.jsonl', '2026-08-23T00:00:00Z')`);
    const ex = db.prepare(
      `INSERT INTO exchanges (id, session_id, seq, ts, user_text, assistant_text)
       VALUES (?, 's1', ?, ?, ?, ?)`,
    );
    ex.run('oldest', 0, '2026-01-01T00:00:00Z', 'the oldest exchange', 'about nothing');
    ex.run('middle', 1, '2026-05-01T00:00:00Z', 'the middle exchange', 'about nothing');
    ex.run('newest', 2, '2026-08-22T00:00:00Z', 'the newest exchange', 'about nothing');
    ex.run('undated', 3, null, 'an exchange with no timestamp', 'about nothing');
    return { root, db };
  }

  it('fails soft when the runtime is absent, leaving text search untouched', async () => {
    const { root, db } = corpus();
    try {
      const status = vecStatus(db, root);
      const result = await status.embed!({ cacheDir: tempDir('potsherd-empty-'), noAcquire: true });
      expect(result.embedded).toBe(0);
      expect(result.reason).toBeTruthy();
      // The index is intact and the text half is unaffected.
      expect((db.prepare('SELECT COUNT(*) AS n FROM exchanges').get() as { n: number }).n).toBe(4);
      expect(vecStatus(db, root).available).toBe(true);
    } finally {
      db.close();
      rmrf(root);
    }
  }, 60_000);

  it.runIf(ready)('embeds newest first, because wasm is 6.5x slower than native', async () => {
    // §A2 item 3. The ratio was measured (233.9 ms against 35.8 ms per
    // exchange on the reference machine) and it is over 5x, so the order is
    // part of the contract: the sessions a person searches for minutes after
    // `index` are the ones they were just in.
    const { root, db } = corpus();
    try {
      const status = vecStatus(db, root);
      const result = await status.embed!({ cacheDir: MODEL_CACHE, limit: 2 });
      expect(result.embedded).toBe(2);
      expect(result.backend).toBe('wasm');
      const done = (
        db
          .prepare('SELECT id FROM exchanges WHERE embedding_version IS NOT NULL ORDER BY id')
          .all() as { id: string }[]
      ).map((r) => r.id);
      expect(done.sort()).toEqual(['middle', 'newest']);
      // An undated row never displaces a dated one.
      expect(done).not.toContain('undated');
      expect(vecStatus(db, root).report?.phase).toBe('warming');
    } finally {
      db.close();
      rmrf(root);
    }
  }, 300_000);

  it.runIf(ready)('is restartable: a second pass finishes what the first left', async () => {
    const { root, db } = corpus();
    try {
      await vecStatus(db, root).embed!({ cacheDir: MODEL_CACHE, limit: 1 });
      expect(vecStatus(db, root).report?.embedded).toBe(1);
      await vecStatus(db, root).embed!({ cacheDir: MODEL_CACHE });
      const after = vecStatus(db, root).report!;
      expect(after.embedded).toBe(4);
      expect(after.pending).toBe(0);
      expect(after.phase).toBe('ready');
      expect(vecStatus(db, root).line).toBeNull();
      // And the vectors are searchable through the same statement `find` uses.
      const q = await embeddings.generateQueryEmbedding('the newest exchange', {
        cacheDir: MODEL_CACHE,
      });
      const hits = db
        .prepare(
          `SELECT id, distance FROM vec_exchanges
            WHERE embedding MATCH ? ORDER BY distance LIMIT 1`,
        )
        .all(embeddings.embeddingToBlob(q)) as { id: string }[];
      expect(hits[0]!.id).toBe('newest');
    } finally {
      db.close();
      rmrf(root);
    }
  }, 600_000);
});

describe('nothing writes outside potsherd\'s own directory', () => {
  it('resolves every acquisition path under the models directory', () => {
    const root = tempDir('potsherd-paths-');
    const cache = paths.modelsDir(root);
    for (const f of embeddings.requiredFiles()) {
      const resolved = path.resolve(cache, ...f.name.split('/'));
      expect(resolved.startsWith(cache + path.sep), f.name).toBe(true);
    }
    expect(cache).toBe(path.join(root, 'models'));
    rmrf(root);
  });
});

beforeAll(() => {
  // A guard on the guard: if any test in this file ever reached the real
  // home directory the constraint that makes it safe to run would be gone.
  expect(paths.modelsDir(tempDir('potsherd-guard-'))).not.toContain(os.homedir());
});

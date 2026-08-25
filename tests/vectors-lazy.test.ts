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
import type { Db } from '../packages/core/src/db.js';
import {
  reconcileVectorStamps,
  vectorDrift,
  vectorInventory,
} from '../packages/core/src/vec.js';

/**
 * One vector, in the store, the way the embedding pass writes one.
 *
 * Through the `vec_exchanges` view and its `INSTEAD OF` trigger rather than
 * into `vec_blob_exchanges` directly, so the fixture exercises the same
 * surface the product does.
 */
function embed(db: Db, table: 'vec_exchanges' | 'vec_ghost_prompts', id: string): void {
  db.prepare(`INSERT OR REPLACE INTO ${table} (id, embedding) VALUES (?, ?)`).run(
    id,
    embeddings.embeddingToBlob([1, 0, 0]),
  );
  const rows = table === 'vec_exchanges' ? 'exchanges' : 'ghost_prompts';
  db.prepare(`UPDATE ${rows} SET embedding_version = ? WHERE id = ?`).run(
    embeddings.EMBEDDING_VERSION,
    id,
  );
}

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
      // **VERIFICATION-7 C7-1 amended this fixture, not the rule.** It used to
      // stamp `x0` and stop, which describes a row the search lane cannot
      // return: `embedding_version` is the queue's bookkeeping and
      // `vec_blob_exchanges` is the storage, and it was exactly that gap the
      // real archive fell into. A row that counts as embedded is one with a
      // vector, so the fixture writes one.
      embed(db, 'vec_exchanges', 'x0');

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
      //
      // **FIX-F round 2 amended the fixture, not the rule.** `phase` is a fact
      // about the rows — one of four carries a vector — and `warming` is a
      // claim about the *work*, which nothing in this root was doing: no
      // `.lock.embed`, no worker, no runtime. So the word is asserted with a
      // worker holding the lane and the other word without one, and the three
      // renderings are checked against each other in both states. What "one
      // source of truth" claims is that they agree, and they still do.
      expect(a.line).toBe('semantic search: not running (1 of 4 embedded) — it stopped partway');
      expect(a.line).not.toMatch(/potsherd |install|unavailable|degraded/);
      expect(a.row?.note(80)).toContain('stopped at 1 of 4');

      const held = vecStatus(db, root, { working: true });
      expect(held.line).toBe('semantic search: warming (1 of 4 embedded)');
      expect(held.line).not.toMatch(/potsherd |install|unavailable|degraded/);
      expect(held.row?.note(80)).toContain('warming 1 of 4');
      // The numbers do not move with the word: same report, same row value.
      expect(held.report?.embedded).toBe(a.report?.embedded);
      expect(held.report?.phase).toBe(a.report?.phase);
      expect(held.row?.value).toBe(a.row?.value);
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
      embed(db, 'vec_exchanges', 'x0');
      embed(db, 'vec_ghost_prompts', 'g0');

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

  /**
   * **VERIFICATION-7 C7-1.** The release's headline property is that `find`
   * says *which half of the search produced that verdict*. On this machine's
   * archive it said the wrong half at every door at once: `doctor`, `stats`,
   * `find`'s status line and `potsherd_recall`'s `capability` all printed
   * `not running, 0 of 4,774` while the same `find` page's header said
   * `bm25 + vectors`, its `--json` said `vectors: 1649`, and the semantic lane
   * returned 204 candidates that built the entire `nearest` region.
   *
   * The cause is that the two halves counted different things and nothing ever
   * compared them: `vectorCounts` read `exchanges.embedding_version` and the
   * search lane read `vec_blob_exchanges`. Every assertion below is about that
   * comparison, and none of them is reachable on a clean install — which is
   * why six verifications did not see it.
   */
  describe('the stamp and the store cannot drift (VERIFICATION-7 C7-1)', () => {
    /** An archive whose vectors are all there and whose stamps are all gone. */
    function driftedRoot(): { root: string; db: Db } {
      const root = tempDir('potsherd-vec-drift-');
      const db = store.open({ root });
      db.exec(`INSERT INTO sessions (id, harness, project, source_path, indexed_at)
               VALUES ('s1', 'claude', '/tmp/p', '/tmp/p/s1.jsonl', '2026-08-23T00:00:00Z')`);
      const ex = db.prepare(
        `INSERT INTO exchanges (id, session_id, seq, ts, user_text, assistant_text)
         VALUES (?, 's1', ?, ?, ?, '')`,
      );
      for (let i = 0; i < 4; i += 1) ex.run(`x${i}`, i, `2026-08-2${i}T00:00:00Z`, `text ${i}`);
      db.exec(`INSERT INTO ghosts (session_id, harness, project, prompt_count)
               VALUES ('g1', 'claude', '/tmp/p', 2)`);
      const gp = db.prepare(
        `INSERT INTO ghost_prompts (id, session_id, seq, ts, text) VALUES (?, 'g1', ?, ?, ?)`,
      );
      for (let i = 0; i < 2; i += 1) gp.run(`g${i}`, i, `2026-08-1${i}T00:00:00Z`, `prompt ${i}`);
      // The state a re-index used to leave behind: the vector is still in the
      // store and the stamp on its row is gone. Written here by hand because
      // reaching it through `index` needs a 1.1.0 database — `tests/upgrade-
      // from-1.1.test.ts` does that half, through the binary.
      for (const id of ['x0', 'x1', 'x2']) embed(db, 'vec_exchanges', id);
      embed(db, 'vec_ghost_prompts', 'g0');
      db.exec(`UPDATE exchanges SET embedding_version = NULL`);
      db.exec(`UPDATE ghost_prompts SET embedding_version = NULL`);
      return { root, db };
    }

    it('counts the vectors the search lane can use, not the stamps nothing reads', () => {
      const { root, db } = driftedRoot();
      try {
        // Four exchanges and two recovered prompts; four of the six carry a
        // vector and none of the six carries a stamp. The old count said 0.
        expect(vectorInventory(db).total).toBe(4);
        const report = vecStatus(db, root).report!;
        expect(report.embedded).toBe(4);
        expect(report.pending).toBe(2);
        expect(report.total).toBe(6);
        // And the three renderings still agree with each other, which is the
        // property `doctor and index read one source of truth` already claims.
        expect(vecStatus(db, root).line).toContain('4 of 6');
        expect(vecStatus(db, root).row?.value).toBe('4');
      } finally {
        db.close();
        rmrf(root);
      }
    });

    it('reports the drift it finds, in the three shapes it can take', () => {
      const { root, db } = driftedRoot();
      try {
        // A stamp with nothing behind it, and a vector whose row is gone.
        db.prepare('UPDATE exchanges SET embedding_version = ? WHERE id = ?').run(
          embeddings.EMBEDDING_VERSION,
          'x3',
        );
        embed(db, 'vec_exchanges', 'ghost-of-a-row');
        const drift = vectorDrift(db);
        expect(drift.unstamped).toBe(4);
        expect(drift.phantom).toBe(1);
        expect(drift.orphans).toBe(1);
      } finally {
        db.close();
        rmrf(root);
      }
    });

    it('adopts a vector that outlived its stamp rather than throwing it away', () => {
      const { root, db } = driftedRoot();
      try {
        const done = reconcileVectorStamps(db);
        expect(done.adopted).toBe(4);
        expect(vectorDrift(db)).toEqual({ unstamped: 0, phantom: 0, orphans: 0 });
        // The count did not move: the repair is to the record, not the index.
        expect(vecStatus(db, root).report?.embedded).toBe(4);
        // And the queue now agrees, so the next pass embeds the two that are
        // genuinely owed rather than re-buying all four.
        expect(
          db.prepare(`SELECT COUNT(*) AS n FROM exchanges WHERE embedding_version IS NULL`).get(),
        ).toEqual({ n: 1 });
      } finally {
        db.close();
        rmrf(root);
      }
    });

    it('clears a stamp with no vector behind it, and deletes a vector with no row', () => {
      const { root, db } = driftedRoot();
      try {
        db.prepare('UPDATE exchanges SET embedding_version = ? WHERE id = ?').run(
          embeddings.EMBEDDING_VERSION,
          'x3',
        );
        embed(db, 'vec_exchanges', 'ghost-of-a-row');
        const done = reconcileVectorStamps(db);
        expect(done.cleared).toBe(1);
        expect(done.orphans).toBe(1);
        expect(vectorDrift(db)).toEqual({ unstamped: 0, phantom: 0, orphans: 0 });
        expect(vecStatus(db, root).report?.embedded).toBe(4);
      } finally {
        db.close();
        rmrf(root);
      }
    });

    it('empties a store a superseded embedding version wrote, rather than adopting it', () => {
      const { root, db } = driftedRoot();
      try {
        // Adoption is only sound while every blob in the store answers the
        // current model. The recorded version is what makes that an invariant
        // instead of an assumption, and a bump must degrade to *nothing
        // embedded*, never to *four embedded, silently wrong*.
        db.prepare(
          `INSERT OR REPLACE INTO sync_state (key, value, updated_at)
             VALUES ('vectors:store-version', ?, ?)`,
        ).run(String(embeddings.EMBEDDING_VERSION + 1), '2026-08-25T00:00:00Z');
        expect(vecStatus(db, root).report?.embedded).toBe(0);
        reconcileVectorStamps(db);
        expect(vectorInventory(db).total).toBe(0);
        expect(vecStatus(db, root).report?.pending).toBe(6);
      } finally {
        db.close();
        rmrf(root);
      }
    });

    it('repairs on the next writable open, and doctor can see drift it cannot fix', () => {
      const { root, db } = driftedRoot();
      try {
        db.close();
        // `doctor` opens read-only: it never runs the repair, so it is the one
        // surface that has to be able to *report* the state. It still counts
        // the store, so the number it prints is the one `find` is using.
        const ro = store.open({ root, readonly: true });
        expect(vectorDrift(ro).unstamped).toBe(4);
        expect(vecStatus(ro, root).report?.embedded).toBe(4);
        ro.close();

        const rw = store.open({ root });
        expect(vectorDrift(rw)).toEqual({ unstamped: 0, phantom: 0, orphans: 0 });
        rw.close();
      } finally {
        rmrf(root);
      }
    });
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

/**
 * FIX-F C2 — the report says whether anybody is embedding, not just how far
 * the index has got.
 *
 * `VectorPhase` is a fact about the rows: `pending` is 0-embedded-with-work-to-do
 * and `warming` is partway through. Neither says whether a pass is **running**,
 * and every surface assumed one was — `warmingLine`'s own docstring says "there
 * is nothing for the reader to do; the work is already running". After
 * `index --no-embed`, on a machine that cannot fetch the runtime, and after an
 * embedder is killed, that is false, and `potsherd_recall` was telling an agent
 * to wait for a pass that would never start.
 *
 * The evidence is the lock the worker holds for the whole pass. These pin that
 * `vecStatus` reads it, and that a lock whose owner is dead reads as stopped —
 * which is the crashed-embedder case and the only one the file alone cannot
 * answer.
 */
describe('the report knows whether a worker is embedding (FIX-F C2)', () => {
  function pendingRoot(): { root: string; db: ReturnType<typeof store.open> } {
    const root = tempDir('potsherd-vec-working-');
    const db = store.open({ root });
    db.exec(`INSERT INTO sessions (id, harness, project, source_path, indexed_at)
             VALUES ('s1', 'claude', '/tmp/p', '/tmp/p/s1.jsonl', '2026-08-23T00:00:00Z')`);
    const ins = db.prepare(
      `INSERT INTO exchanges (id, session_id, seq, user_text, assistant_text)
       VALUES (?, 's1', ?, 'u', 'a')`,
    );
    for (let i = 0; i < 4; i += 1) ins.run(`e${String(i)}`, i);
    return { root, db };
  }

  function writeOwner(root: string, pid: number): string {
    const dir = path.join(root, '.lock.embed');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'owner.json'),
      JSON.stringify({
        pid,
        op: 'embed',
        at: new Date().toISOString(),
        host: process.env.HOSTNAME ?? '',
      }),
    );
    return dir;
  }

  it('is false when nothing holds the embed lane, whatever the phase says', () => {
    const { root, db } = pendingRoot();
    try {
      const r = vecStatus(db, root).report!;
      // The phase is unchanged — this is a new fact, not a re-labelling of an
      // old one, and the numbers every other surface prints do not move.
      expect(r.phase).toBe('pending');
      expect(r.embedded).toBe(0);
      expect(r.total).toBe(4);
      expect(r.working).toBe(false);
    } finally {
      db.close();
      rmrf(root);
    }
  });

  it('is true while a live pid holds it', () => {
    const { root, db } = pendingRoot();
    try {
      writeOwner(root, process.pid);
      expect(vecStatus(db, root).report?.working).toBe(true);
    } finally {
      db.close();
      rmrf(root);
    }
  });

  it('a stale lock whose holder is gone reads as stopped, not as working', () => {
    // The crashed-embedder case, and the reason the *pid* is the evidence
    // rather than the file: `lock.isStale` decides a readable owner by whether
    // that process is alive, and `lock.holder` returns null when it is not.
    const { root, db } = pendingRoot();
    try {
      writeOwner(root, 0x7ffffffe);
      expect(vecStatus(db, root).report?.working).toBe(false);
    } finally {
      db.close();
      rmrf(root);
    }
  });

  it('says nothing either way when there is no root to ask about', () => {
    // `vecStatus(db)` is the cheap backend check `recall.ts` makes on every
    // query. It has no root, so it has no lock to read, and `undefined` is
    // not `false`: an absent measurement must never render as a claim.
    const { root, db } = pendingRoot();
    try {
      expect(vecStatus(db).report).toBeUndefined();
    } finally {
      db.close();
      rmrf(root);
    }
  });
});

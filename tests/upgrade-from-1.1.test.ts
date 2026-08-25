// Upgrading in place from potsherd 1.1.0 — the version live on npm today.
//
// 1.2.0 correctly stopped using `sqlite-vec` to answer a query: a JavaScript
// cosine scan costs 4.7 ms against vec0's 0.9 ms, and 3.8 ms does not buy an
// entire native-addon failure class. But **a database written by 1.1.0 holds
// `vec_exchanges`, `vec_cards` and `vec_ghost_prompts` as vec0 *virtual
// tables***, and on a machine that no longer has the extension every statement
// naming one of them throws `no such module: vec0` while it is still being
// compiled. `potsherd index` died on the first session it re-read:
//
//     $ potsherd index
//     potsherd: no such module: vec0
//     (clearExchanges → Object.prepare, `DELETE FROM vec_exchanges WHERE id = ?`)
//
// Migration 10 had written the case down in its own comment as one it declines
// on — and `plans/09 §13.9` is that a guard's stated limitation is an open item
// rather than boilerplate. It was: every fix in the release is gated behind
// indexing, so an upgrading user got the 4/10 product and a changelog
// describing the 8/10 one, while a clean install was fine.
//
// ## why this file builds the trap instead of describing it
//
// `plans/09 §7.2`: a test's premise must be something the test establishes.
// A table merely *named* `vec_exchanges` would establish nothing — the whole
// defect is the module error, which only a real vec0 virtual table can raise.
// So {@link buildOneOneDatabase} loads `sqlite-vec`, creates the three tables
// with 1.1.0's own DDL, puts real vectors in them, and rewinds
// `schema_migrations` to 9. Every later `open()` here runs under
// `POTSHERD_NO_VEC=1`, which is the honest way to be the machine that has lost
// the extension: the connection genuinely does not have vec0, and sqlite
// genuinely cannot compile a statement against those tables.
//
// This is `plugin-install.test.ts`'s shape — that one copies a parent
// `package.json` saying `commonjs` rather than asserting about one — applied to
// the other install failure 1.1.0 shipped.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { db as store, embeddings, indexAll, vecStatus, vectorCounts, type Db } from '@potsherd/core';
import { rmrf, tempDir } from './helpers.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(repoRoot, 'packages', 'cli', 'bin', 'potsherd.js');

const scratchDirs: string[] = [];
afterEach(() => {
  while (scratchDirs.length) rmrf(scratchDirs.pop()!);
});

/** 1.1.0's schema, verbatim: `03 §3`'s last two tables plus migration 8's. */
const VEC0_DDL = [
  `CREATE VIRTUAL TABLE vec_exchanges USING vec0(
  id TEXT PRIMARY KEY, embedding FLOAT[384]
)`,
  `CREATE VIRTUAL TABLE vec_cards USING vec0(
  session_id TEXT PRIMARY KEY, embedding FLOAT[384]
)`,
  `CREATE VIRTUAL TABLE vec_ghost_prompts USING vec0(
  id TEXT PRIMARY KEY, embedding FLOAT[384]
)`,
];

const SESSION = 'aaaa1111-0000-4000-8000-0000000000f1';

function writeTranscript(claudeDir: string, id = SESSION): void {
  const file = path.join(claudeDir, 'projects', '-tmp-potsherd-upgrade', `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const base = { sessionId: id, cwd: '/tmp/potsherd-upgrade', version: '2.1.237', gitBranch: 'main' };
  const rows = [
    { ...base, type: 'user', promptId: 'p1', uuid: 'u1', timestamp: '2026-08-19T09:00:00.000Z', message: { role: 'user', content: 'the pgbouncer pool keeps saturating on deploy' } },
    { ...base, type: 'assistant', uuid: 'a1', timestamp: '2026-08-19T09:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Raising default_pool_size and re-running.' }] } },
    { ...base, type: 'user', promptId: 'p2', uuid: 'u2', timestamp: '2026-08-19T09:01:00.000Z', message: { role: 'user', content: 'and the migration order?' } },
    { ...base, type: 'assistant', uuid: 'a2', timestamp: '2026-08-19T09:01:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Schema first, then the pool restart.' }] } },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/** A unit vector, so the blobs are the shape `embeddings` writes. */
function unit(seed: number): number[] {
  const a: number[] = [];
  let n = 0;
  for (let i = 0; i < embeddings.EMBEDDING_DIMENSIONS; i += 1) {
    const v = Math.sin(seed * (i + 1) * 0.017) + 0.001;
    a.push(v);
    n += v * v;
  }
  n = Math.sqrt(n) || 1;
  return a.map((v) => v / n);
}

interface OneOne {
  root: string;
  claudeDir: string;
  /** Exchange ids that carry a vec0 vector, so the loss can be checked. */
  ids: string[];
}

/**
 * A database in exactly the state 1.1.0 left one in, built rather than mocked.
 *
 * The route is: index normally, then *rewind* the vector store to what 1.1.0
 * wrote. Rewinding rather than replaying nine migrations keeps the rest of the
 * schema honest — real sessions, real exchanges, real fts5 — so the verb under
 * test has something to re-read, which is what makes `clearExchanges` run at
 * all.
 */
async function buildOneOneDatabase(opts: { rewindSchema?: boolean } = {}): Promise<OneOne> {
  const root = tempDir('potsherd-upgrade-');
  scratchDirs.push(root);
  const claudeDir = path.join(root, 'claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeTranscript(claudeDir);
  await indexAll({ root, claudeDir, harnesses: ['claude'], embed: false, full: true });

  const db = store.open({ root });
  // The premise this helper exists to establish, and it is established **here**
  // rather than inherited from the environment — FIX-H2. It used to read
  // `vecStatus(db).version`, which is the *product's* loader and therefore
  // obeys `POTSHERD_NO_VEC`; under a suite run with the extension switched off
  // (CI's condition, and the one neither of us had been testing) that made the
  // fixture unbuildable and every test here fail for a reason that has nothing
  // to do with what they assert. Building the trap is not the same act as
  // exercising the product against it: the fixture loads vec0 itself, on this
  // handle, whatever the environment says, and every `open()` below still goes
  // through the product's loader and still sees nothing.
  loadVec0Directly(db);

  db.exec(`
DROP TRIGGER IF EXISTS vec_exchanges_insert;
DROP TRIGGER IF EXISTS vec_exchanges_delete;
DROP TRIGGER IF EXISTS vec_cards_insert;
DROP TRIGGER IF EXISTS vec_cards_delete;
DROP TRIGGER IF EXISTS vec_ghost_prompts_insert;
DROP TRIGGER IF EXISTS vec_ghost_prompts_delete;
DROP VIEW IF EXISTS vec_exchanges;
DROP VIEW IF EXISTS vec_cards;
DROP VIEW IF EXISTS vec_ghost_prompts;
DROP TABLE IF EXISTS vec_blob_exchanges;
DROP TABLE IF EXISTS vec_blob_cards;
DROP TABLE IF EXISTS vec_blob_ghost_prompts;
`);
  for (const ddl of VEC0_DDL) db.exec(ddl);

  const ids = (db.prepare('SELECT id FROM exchanges ORDER BY rowid').all() as { id: string }[]).map(
    (r) => r.id,
  );
  const insert = db.prepare('INSERT INTO vec_exchanges (id, embedding) VALUES (?, ?)');
  const stamp = db.prepare('UPDATE exchanges SET embedding_version = ? WHERE id = ?');
  ids.forEach((id, i) => {
    insert.run(id, embeddings.embeddingToBlob(unit(i + 1)));
    stamp.run(embeddings.EMBEDDING_VERSION, id);
  });
  db.prepare('INSERT INTO vec_cards (session_id, embedding) VALUES (?, ?)').run(
    SESSION,
    embeddings.embeddingToBlob(unit(99)),
  );

  // Schema 10 onwards is what 1.2.0 adds. 1.1.0 stopped at 9.
  //
  // `rewindSchema: false` leaves 10, 11 and 12 stamped with the vec0 tables
  // still in place, which is the state requirement 2 is about: a store no
  // migration is going to touch again, whatever put it there — a driver that
  // refused the schema rewrite, or a decline a later version recorded. Every
  // verb must degrade to text search rather than throw.
  if (opts.rewindSchema !== false) db.exec('DELETE FROM schema_migrations WHERE version >= 10');
  db.close();
  return { root, claudeDir, ids };
}

/**
 * vec0 on this connection, by the test's own hand.
 *
 * Resolved from `packages/core`, because that is where `sqlite-vec` is
 * installed — it is an `optionalDependency` of that package and there is no
 * copy at the workspace root, so `createRequire(import.meta.url)` from `tests/`
 * cannot see it. What the fixture is avoiding is the product's *loader*, which
 * obeys `POTSHERD_NO_VEC`; the module resolution is the same one the product
 * uses because it is the only one that finds the file.
 */
function loadVec0Directly(db: Db): void {
  const require_ = createRequire(path.join(repoRoot, 'packages', 'core', 'src', 'index.ts'));
  let loadable: string;
  try {
    loadable = (require_('sqlite-vec') as { getLoadablePath(): string }).getLoadablePath();
  } catch (err) {
    db.close();
    throw new Error(
      'this test builds real vec0 virtual tables and needs sqlite-vec to do it: ' +
        `pnpm install (it is an optionalDependency of @potsherd/core) — ${(err as Error).message}`,
    );
  }
  (db as unknown as { loadExtension(p: string): void }).loadExtension(loadable);
}

/** Everything below runs on the machine that has lost the extension. */
async function withoutTheExtension<T>(fn: () => Promise<T> | T): Promise<T> {
  return withVecEnv('1', fn);
}

/**
 * …and this is the other half, stated rather than assumed.
 *
 * The one test here that is *about* the extension being present must say so:
 * inheriting it meant that a suite run with `POTSHERD_NO_VEC=1` — which is what
 * CI does to the whole product, and what neither of us had run — silently
 * turned that test into a second copy of the stranded case.
 */
async function withTheExtension<T>(fn: () => Promise<T> | T): Promise<T> {
  return withVecEnv(undefined, fn);
}

async function withVecEnv<T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const previous = process.env['POTSHERD_NO_VEC'];
  if (value === undefined) delete process.env['POTSHERD_NO_VEC'];
  else process.env['POTSHERD_NO_VEC'] = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env['POTSHERD_NO_VEC'];
    else process.env['POTSHERD_NO_VEC'] = previous;
  }
}

/**
 * The binary, on the machine the CHANGELOG's upgrade note is addressed to.
 *
 * VERIFICATION-7 C7-3. Every other run through the binary in this file sets
 * `POTSHERD_NO_VEC=1`, because every other test here is about the machine that
 * has *lost* the extension — and that is why nothing in this file could see the
 * defect. The sentence *"it copies every vector across first, so nothing anybody
 * has already paid for is lost"* is a promise about the machine that still has
 * `sqlite-vec`, and on that machine the promise was false: the migration copied
 * two vectors into the portable store and the re-index that followed it deleted
 * both. This runner states the premise the sentence is about.
 */
function cliWithVec(args: string[]): { code: number; stdout: string; stderr: string } {
  return cli(args, { vec: true });
}

function cli(
  args: string[],
  opts: { vec?: boolean } = {},
): { code: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', COLUMNS: '100', POTSHERD_NO_VEC: '1' };
  if (opts.vec) delete env['POTSHERD_NO_VEC'];
  delete env['NODE_PATH'];
  delete env['CLAUDE_CONFIG_DIR'];
  delete env['POTSHERD_DIR'];
  delete env['XDG_CONFIG_HOME'];
  try {
    return {
      code: 0,
      stdout: execFileSync(process.execPath, [bin, ...args], {
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
      stderr: '',
    };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function objects(db: Db, name: string): { type: string; sql: string | null } | undefined {
  return db.prepare('SELECT type, sql FROM sqlite_master WHERE name = ?').get(name) as
    | { type: string; sql: string | null }
    | undefined;
}

function shadowCount(db: Db): number {
  return (
    db.prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master
        WHERE type = 'table'
          AND (name LIKE 'vec\\_exchanges\\_%' ESCAPE '\\'
            OR name LIKE 'vec\\_cards\\_%' ESCAPE '\\'
            OR name LIKE 'vec\\_ghost\\_prompts\\_%' ESCAPE '\\')`,
    ).get() as { n: number }
  ).n;
}

describe('a database written by potsherd 1.1.0, opened without sqlite-vec', () => {
  it('the trap: the three names are vec0 virtual tables and no statement compiles against them', async () => {
    const { root } = await buildOneOneDatabase();

    await withoutTheExtension(() => {
      // Read-only, so nothing migrates and the state is the one a user is in
      // the moment they upgrade.
      const db = store.open({ root, readonly: true });
      for (const name of ['vec_exchanges', 'vec_cards', 'vec_ghost_prompts']) {
        const row = objects(db, name);
        expect(row?.type, `${name} must be a table, not a view`).toBe('table');
        expect(row?.sql ?? '').toMatch(/USING\s+vec0/i);
      }
      // vec0's own storage, as ordinary tables: four per virtual table.
      expect(shadowCount(db)).toBeGreaterThanOrEqual(12);

      // The defect, at the exact statement and the exact call that raised it.
      expect(() => db.prepare('DELETE FROM vec_exchanges WHERE id = ?')).toThrow(
        /no such module: vec0/,
      );
      expect(() => db.prepare('SELECT COUNT(*) AS n FROM vec_exchanges')).toThrow(
        /no such module: vec0/,
      );
      // And the schema really has stopped where 1.1.0 stopped.
      expect(store.schemaVersion(db)).toBe(9);
      db.close();
    });
  });

  /**
   * **The capability, not the outcome — FIX-H2.**
   *
   * Everything else in this file passed on the machine it was written on and
   * failed in CI, and the premise it had quietly inherited was not `sqlite-vec`
   * at all: it was the **Node version**. From v24.19.0 `node:sqlite` opens every
   * connection with `SQLITE_DBCONFIG_DEFENSIVE` on, and under defensive mode
   * `PRAGMA writable_schema = ON` is *accepted and ignored* — it reads back as
   * 0 — so the `sqlite_master` delete migration 10 needs is refused. On
   * v24.9.0, where this was written, defensive was off and the same code did
   * the surgery happily. A green test that means "this machine happened to
   * allow it" is `plans/09 §7.2` in a new coat.
   *
   * So this asserts the mechanism directly: on a database that is actually
   * stranded, the connection `open()` hands back must be one where the schema
   * really is writable — read back from sqlite, not assumed from the fact that
   * the pragma did not throw. It is red on any machine where that is false,
   * which is what the outcome assertions could not be.
   */
  it('hands back a connection whose schema is really writable, read back from sqlite', async () => {
    const { root } = await buildOneOneDatabase();

    await withoutTheExtension(() => {
      const db = store.open({ root });
      try {
        // `open()` has already converted it, so ask the connection it gave us
        // whether it *could* have: the same acquisition, on the same handle.
        const restore = (db as unknown as { unsafeMode?: (on: boolean) => void }).unsafeMode;
        if (typeof restore === 'function') restore.call(db, true);
        db.pragma('writable_schema = ON');
        const rows = db.pragma('writable_schema') as { writable_schema?: number }[];
        expect(rows[0]?.writable_schema, 'PRAGMA writable_schema = ON was silently ignored').toBe(1);
        // And the write itself, not merely the flag: a delete that matches
        // nothing runs the identical authorizer check and changes no byte.
        expect(() =>
          db.prepare(`DELETE FROM sqlite_master WHERE type='table' AND name = ?`).run('__none__'),
        ).not.toThrow();
        db.pragma('writable_schema = RESET');
        if (typeof restore === 'function') restore.call(db, false);
      } finally {
        db.close();
      }
    });
  });

  it('migration 10 converts it instead of declining, and nothing is left of vec0', async () => {
    const { root } = await buildOneOneDatabase();

    await withoutTheExtension(() => {
      // A plain write-open is all it takes: this is what `index` does first.
      const db = store.open({ root });
      expect(store.schemaVersion(db)).toBe(store.latestSchemaVersion());

      for (const name of ['vec_exchanges', 'vec_cards', 'vec_ghost_prompts']) {
        expect(objects(db, name)?.type, name).toBe('view');
      }
      expect(shadowCount(db)).toBe(0);

      // The surface `recall.ts` writes against, on the converted store.
      expect(db.prepare('SELECT COUNT(*) AS n FROM vec_exchanges').get()).toEqual({ n: 0 });
      expect(vecStatus(db).available).toBe(true);
      expect(vecStatus(db).legacy ?? []).toEqual([]);

      // The vectors were unreadable before they were dropped, so nothing
      // recoverable was lost — but the *stamp* must not go on claiming they
      // are there, or no pass would ever rebuild them.
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM exchanges WHERE embedding_version IS NOT NULL').get(),
      ).toEqual({ n: 0 });
      db.close();
    });
  });

  it('keeps every vector when the extension IS on the machine', async () => {
    const { root, ids } = await buildOneOneDatabase();
    // The other half of the promise: where the vectors can be read they are
    // copied across rather than dropped. `withTheExtension` states that premise
    // instead of inheriting it — see its docstring.
    await withTheExtension(() => {
      const db = store.open({ root });
      expect(store.schemaVersion(db)).toBe(store.latestSchemaVersion());
      expect(objects(db, 'vec_exchanges')?.type).toBe('view');
      expect(db.prepare('SELECT COUNT(*) AS n FROM vec_exchanges').get()).toEqual({ n: ids.length });
      expect(db.prepare('SELECT COUNT(*) AS n FROM vec_cards').get()).toEqual({ n: 1 });
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM exchanges WHERE embedding_version IS NOT NULL').get(),
      ).toEqual({ n: ids.length });
      db.close();
    });
  });

  it('the whole verb: potsherd index completes on it, through the binary', async () => {
    const { root, claudeDir } = await buildOneOneDatabase();

    const r = cli([
      'index',
      '--no-embed',
      '--harness',
      'claude',
      '--claude-dir',
      claudeDir,
      '--potsherd-dir',
      root,
    ]);
    expect(r.stderr + r.stdout).not.toMatch(/no such module/);
    expect(r.code).toBe(0);

    const doctor = cli(['doctor', '--potsherd-dir', root]);
    expect(doctor.stdout).toMatch(
      new RegExp(`schema v${store.latestSchemaVersion()} of v${store.latestSchemaVersion()}`),
    );
  });

  /**
   * **VERIFICATION-7 C7-3, and the reason the suite could not see it.**
   *
   * Two tests in this file were between the defect and the record, and neither
   * could reach it. `keeps every vector when the extension IS on the machine`
   * asserts the copy through `store.open()` from source — and the copy is not
   * where the vectors go; the re-index *after* it is.
   * `the whole verb: potsherd index completes on it, through the binary` goes
   * through the binary, which is the path that loses them, and asserts only
   * that the verb exits 0. The one assertion and the one code path never met.
   *
   * This is both at once: the whole verb, through the binary, with the
   * extension present, counting what is left afterwards. `readonly: true` is
   * load-bearing — a writable open runs `reconcileVectorStamps`, and the
   * question here is what the *product* left behind, not what the next open
   * can repair.
   */
  it('keeps every vector across the upgrade, through the binary, with sqlite-vec present', async () => {
    const { root, claudeDir, ids } = await buildOneOneDatabase();

    const r = cliWithVec([
      'index',
      '--no-embed',
      '--harness',
      'claude',
      '--claude-dir',
      claudeDir,
      '--potsherd-dir',
      root,
    ]);
    expect(r.stderr + r.stdout).not.toMatch(/no such module/);
    expect(r.code).toBe(0);

    const db = store.open({ root, readonly: true });
    try {
      // The CHANGELOG's sentence, as a number: nothing anybody has already
      // paid for is lost.
      expect(db.prepare('SELECT COUNT(*) AS n FROM vec_blob_exchanges').get()).toEqual({
        n: ids.length,
      });
      // And the stamp survives with it, or the next pass buys them all again
      // and every status surface says `0 of 2` over a store holding two
      // (VERIFICATION-7 C7-1 is that same seam, seen from the other side).
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM exchanges WHERE embedding_version IS NOT NULL').get(),
      ).toEqual({ n: ids.length });
    } finally {
      db.close();
    }

    // What the reader is told, from the binary, on the same database. The row
    // is the count, not a promise: `every exchange` is the `ready` phase, which
    // is only reachable because nothing was dropped.
    const doctor = cliWithVec(['doctor', '--potsherd-dir', root]);
    expect(doctor.stdout).toMatch(new RegExp(`\\n {2}vectors +${String(ids.length)} +`));
    expect(doctor.stdout).toMatch(/vectors +\d+ +bge-small[^\n]*every exchange/);
    expect(doctor.stdout).not.toMatch(/0 of 2/);
  });

  it('drops the vector of an exchange whose text the re-index changed', async () => {
    // The other half of the rule, and the reason it is not simply "never
    // delete": a vector is a function of the text it was computed from, so an
    // exchange that came back with different words must not keep the old one.
    const { root, claudeDir, ids } = await buildOneOneDatabase();
    const file = path.join(
      claudeDir,
      'projects',
      '-tmp-potsherd-upgrade',
      `${SESSION}.jsonl`,
    );
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    fs.writeFileSync(
      file,
      lines
        .map((l) => l.replace(/"text":"[^"]*"/, '"text":"a completely different question"'))
        .join('\n') + '\n',
    );

    const r = cliWithVec([
      'index',
      '--no-embed',
      '--harness',
      'claude',
      '--claude-dir',
      claudeDir,
      '--potsherd-dir',
      root,
    ]);
    expect(r.code).toBe(0);

    const db = store.open({ root, readonly: true });
    try {
      const kept = (
        db.prepare('SELECT COUNT(*) AS n FROM vec_blob_exchanges').get() as { n: number }
      ).n;
      expect(kept).toBeLessThan(ids.length);
    } finally {
      db.close();
    }
  });

  it('index re-reads every transcript after the conversion, which is where it used to die', async () => {
    const { root, claudeDir } = await buildOneOneDatabase();

    await withoutTheExtension(async () => {
      // `full: true` forces the re-read that migration 11's fingerprint clear
      // forces on a real upgrade — the pass that runs `clearExchanges` once per
      // session, which is the frame at the top of the crash.
      const report = await indexAll({ root, claudeDir, harnesses: ['claude'], embed: false, full: true });
      expect(report.totals.exchanges).toBe(2);
      const db = store.open({ root });
      expect(db.prepare('SELECT COUNT(*) AS n FROM exchanges').get()).toEqual({ n: 2 });
      db.close();
    });
  });

  it('nothing throws even on a database the migration did not repair', async () => {
    const { root, claudeDir } = await buildOneOneDatabase({ rewindSchema: false });

    await withoutTheExtension(async () => {
      const report = await indexAll({ root, claudeDir, harnesses: ['claude'], embed: true, full: true });
      expect(report.totals.exchanges).toBe(2);
      // Not silently: the embedding lane says what is in the way.
      expect(report.embeddings.available).toBe(false);
      expect(report.embeddings.reason ?? '').toMatch(/vec0/i);

      const db = store.open({ root, readonly: true });
      const status = vecStatus(db);
      expect(status.available).toBe(false);
      expect(status.legacy).toContain('vec_exchanges');
      db.close();
    });
  });
});

describe('doctor, on a database it can see is stranded and cannot repair itself', () => {
  it('names a command that runs, and running it is what fixes the database', async () => {
    const { root, claudeDir } = await buildOneOneDatabase();

    // `doctor` opens read-only on purpose — it is safe to run while an index is
    // in flight — so it is the one verb that sees this state and never clears
    // it. It used to print `schema v9 of v12 · run potsherd index` on the one
    // database where `potsherd index` was the command that crashed.
    //
    // Both rows are asserted **with their prefix**, because the note column is
    // 43 characters at width 80 and elides from the right: an earlier draft of
    // this sentence put the command last, `doctor` printed
    // `a vec0 index written by potsherd 1.1.0 — r…`, and a bare
    // `/run potsherd index/` passed anyway — off the *record types* header
    // further down the same screen. A regex that can match another line is not
    // an assertion about this one.
    const before = cli(['doctor', '--potsherd-dir', root]);
    expect(before.stdout).toMatch(/schema v9 of v12 {2}· run potsherd index/);
    // **VERIFICATION-7 C7-1 moved the value column, and this is the amendment.**
    // It used to be `\d+` — the count of `embedding_version` stamps, which on
    // this database is 2 — beside a note saying the store cannot be read at all.
    // Two vectors sealed inside a vec0 table this machine has no module for are
    // not two vectors anybody has; `vectorCounts` counts the store now, the
    // store here is unreadable, and the honest value is the dash. The note is
    // unchanged and is still the whole point of the row.
    expect(before.stdout).toMatch(/\n {2}vectors +— +run potsherd index — it converts a vec0 st/);

    // And the sentence is true: the command it named is the one that works.
    const fix = cli([
      'index',
      '--no-embed',
      '--harness',
      'claude',
      '--claude-dir',
      claudeDir,
      '--potsherd-dir',
      root,
    ]);
    expect(fix.code).toBe(0);

    const after = cli(['doctor', '--potsherd-dir', root]);
    expect(after.stdout).toMatch(/schema v12 of v12/);
    expect(after.stdout).not.toMatch(/converts a vec0 store/);
  });
});

/**
 * C-8 — on a permanently stranded database, `potsherd index` prescribed
 * `potsherd index`.
 *
 * The state is the one {@link buildOneOneDatabase} builds with
 * `rewindSchema: false`: schema stamped 12, the three vec0 tables still there,
 * the extension gone. `migrate()` skips any version already in
 * `schema_migrations`, so **migration 10 can never run again on this
 * database** — and every surface was telling the reader to run the verb that
 * cannot help them. The requirement for this state was *must not throw*, and
 * it does not; the sentence was not brought along.
 *
 * The test does not assert a form of words. It asserts the two things that
 * make the sentence a lie: that the prescribed command changes nothing, and
 * that the prescription is not the command that changes nothing.
 */
describe('a stranded database no migration will touch again', () => {
  it('does not prescribe the command that cannot work', async () => {
    const { root, claudeDir } = await buildOneOneDatabase({ rewindSchema: false });

    await withoutTheExtension(() => {
      const db = store.open({ root, readonly: true });
      try {
        const status = vecStatus(db);
        expect(status.available).toBe(false);
        expect(status.legacy).toContain('vec_exchanges');
        // Migration 10 is stamped, so nothing will re-run it. That is the
        // premise, read from the database rather than assumed.
        const applied = db
          .prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 10')
          .get() as { n: number };
        expect(applied.n).toBe(1);
        expect(
          status.reason ?? '',
          'the sentence still names potsherd index, which cannot convert this store',
        ).not.toMatch(/^run potsherd index\b/);
      } finally {
        db.close();
      }
    });

    // And the same sentence, through the binary, on the three verbs that print
    // it. `index` prescribing itself is the sharpest form of the defect.
    for (const argv of [
      ['index', '--no-embed', '--harness', 'claude', '--claude-dir', claudeDir, '--potsherd-dir', root],
      ['doctor', '--potsherd-dir', root],
      ['stats', '--potsherd-dir', root],
    ]) {
      const r = cli(argv);
      expect(r.code, `${argv[0]} exited ${r.code}`).toBe(0);
      expect(r.stdout + r.stderr).not.toMatch(/no such module/);
      expect(
        r.stdout,
        `${argv[0]} still prescribes potsherd index on a store it can never convert`,
      ).not.toMatch(/run potsherd index — it converts a vec0 st/);
    }
  });

  it('and the command it used to name really does change nothing', async () => {
    const { root, claudeDir } = await buildOneOneDatabase({ rewindSchema: false });
    const before = cli(['index', '--no-embed', '--harness', 'claude', '--claude-dir', claudeDir, '--potsherd-dir', root]);
    expect(before.code).toBe(0);

    await withoutTheExtension(() => {
      const db = store.open({ root, readonly: true });
      try {
        // Ran the prescribed verb; the three vec0 tables are exactly where
        // they were. This is why the sentence had to change.
        for (const name of ['vec_exchanges', 'vec_cards', 'vec_ghost_prompts']) {
          expect(objects(db, name)?.type, name).toBe('table');
        }
        expect(vecStatus(db).legacy).toContain('vec_exchanges');
      } finally {
        db.close();
      }
    });
  });
});


/**
 * **VERIFICATION-8 C8-8** — on a 1.1.0 database, `doctor` reported `0 of N`
 * over a store holding every one of them.
 *
 * This is VERIFICATION-7 C7-3's shape surviving on the read-only path, on the
 * exact screen a 1.1.0 user is most likely to run first. `vectorCounts` reads
 * the blob tables migration 10 creates; on a schema-9 database those tables do
 * not exist yet and the vectors are still in the `vec0` virtual tables 1.1.0
 * wrote — so the count fell into `catch { have = 0 }` and every status surface
 * said `not running, 0 of N` about a file whose vectors the very next writable
 * open goes on to keep in full (§B.1, and the two tests above).
 *
 * The vectors survive; the number shown *before* the migration did not
 * describe them. The release's upgrade note is *"Everything else is additive.
 * The index migrates itself"*, and a first screen that reports the user's paid
 * work as absent is the one thing that makes that sentence unbelievable.
 *
 * `readonly: true` and no `index` run first are both load-bearing: the question
 * is what the *unmigrated* file reports, not what the next open can repair.
 */
describe('C8-8 — the pre-migration screen counts the vectors the file actually holds', () => {
  it('vectorCounts reads the 1.1.0 store when the portable one does not exist yet', async () => {
    const { root, ids } = await buildOneOneDatabase();
    const db = store.open({ root, readonly: true });
    try {
      // The premise, read rather than assumed: schema 9, no blob table, real
      // vec0 tables holding the vectors.
      expect(
        (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v,
      ).toBeLessThan(10);
      expect(objects(db, 'vec_blob_exchanges')).toBeUndefined();
      expect(objects(db, 'vec_exchanges')?.type).toBe('table');

      const counts = vectorCounts(db);
      expect(counts.embedded).toBe(ids.length);
      expect(counts.pending).toBe(0);
    } finally {
      db.close();
    }
  });

  it('and doctor says so, through the binary, with the extension present', async () => {
    const { root, ids } = await buildOneOneDatabase();
    const doctor = cliWithVec(['doctor', '--potsherd-dir', root]);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).not.toMatch(new RegExp(`0 of ${String(ids.length)}`));
    expect(doctor.stdout).toMatch(new RegExp(`\\n {2}vectors +${String(ids.length)} +`));
    // The schema line is unchanged: the file really is unmigrated, and the
    // screen still says so. Only the vector count stopped being wrong.
    expect(doctor.stdout).toMatch(/schema v9 of v/);
  });

  it('but a machine that cannot read a vec0 store still counts zero, which is true there', async () => {
    const { root } = await buildOneOneDatabase();
    await withoutTheExtension(() => {
      const db = store.open({ root, readonly: true });
      try {
        // Without the extension these vectors exist and no query can reach
        // them, so nothing search can answer from is embedded. Reporting a
        // number the lane cannot use would be the same defect pointing the
        // other way.
        expect(vectorCounts(db).embedded).toBe(0);
      } finally {
        db.close();
      }
    });
  });
});

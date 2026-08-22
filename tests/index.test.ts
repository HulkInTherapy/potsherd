import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  db as store,
  indexAll,
  ingestGhosts,
  storedRecordTypes,
  storedRedactionCounts,
  vecStatus,
  type Db,
} from '@potsherd/core';
import { rmrf, tempDir } from './helpers.js';

/**
 * `potsherd index` — the seam where five adapters, redaction and the store meet.
 *
 * Everything here runs against a transcript this file writes and a database in
 * a throwaway directory. Nothing reads the developer's real corpus: exact
 * counts on the reference machine belong in the adapter tests, which read the
 * frozen archive, and in the phase handoff.
 *
 * `--harness claude` is passed almost everywhere on purpose. Without it the
 * codex, cursor and pi adapters walk the *machine's* real directories — which
 * is correct behaviour for the verb and useless in a test, because the answer
 * changes with whoever is running it.
 */

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'; // AWS's own published documentation example
const GITHUB_TOKEN = 'ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE'; // spells FAKE

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmrf(dirs.pop()!);
});

function scratch(): { claudeDir: string; root: string } {
  const base = tempDir('potsherd-index-');
  dirs.push(base);
  return { claudeDir: path.join(base, 'claude'), root: path.join(base, 'potsherd') };
}

/**
 * One claude transcript: a prompt, an assistant turn, a tool call whose input
 * carries an aws key, and a second prompt whose assistant text carries a github
 * token. Two exchanges, two secrets, one of each side of the redaction contract
 * (`tool_calls.input` and `assistant_text`).
 */
function writeTranscript(claudeDir: string, id = 'aaaa1111-0000-4000-8000-000000000001'): string {
  const file = path.join(claudeDir, 'projects', '-tmp-potsherd-index', `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const base = { sessionId: id, cwd: '/tmp/potsherd-index', version: '2.1.237', gitBranch: 'main' };
  const rows = [
    { ...base, type: 'user', promptId: 'p1', uuid: 'u1', timestamp: '2026-08-19T09:00:00.000Z', message: { role: 'user', content: 'the pgbouncer deploy is failing on the upload step' } },
    { ...base, type: 'assistant', uuid: 'a1', timestamp: '2026-08-19T09:00:01.000Z', message: { role: 'assistant', model: 'claude-opus-4', content: [{ type: 'text', text: 'Reading the deploy script now.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/potsherd-index/deploy.sh', content: `aws configure set aws_access_key_id ${AWS_KEY} --profile deploy` } }] } },
    { ...base, type: 'user', promptId: 'p1', uuid: 'u2', timestamp: '2026-08-19T09:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'read 1 file' }] } },
    { ...base, type: 'ai-title', uuid: 'ti', timestamp: '2026-08-19T09:00:03.000Z', aiTitle: 'pgbouncer deploy credentials' },
    { ...base, type: 'user', promptId: 'p2', uuid: 'u3', timestamp: '2026-08-19T09:01:00.000Z', message: { role: 'user', content: 'and the workflow file?' } },
    { ...base, type: 'assistant', uuid: 'a2', timestamp: '2026-08-19T09:01:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: `It reads: gh auth login --with-token <<< ${GITHUB_TOKEN} — that must move into a repository secret.` }] } },
    { ...base, type: 'queue-operation', uuid: 'q1', timestamp: '2026-08-19T09:01:02.000Z' },
    { ...base, type: 'artifact-comment-monitor', uuid: 'x1', timestamp: '2026-08-19T09:01:03.000Z' },
    // A type no formats.md draft describes, so the "novel" column has something
    // to be true about. `artifact-comment-monitor` used to play this part and
    // stopped in phase 7, when somebody finally opened one and found
    // bookkeeping — which is exactly the transition this column exists to make.
    { ...base, type: 'sky-hook-negotiator', uuid: 'x2', timestamp: '2026-08-19T09:01:04.000Z' },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

const QUEUE_HEAVY_ID = 'aaaa1111-0000-4000-8000-000000000002';

/**
 * A second claude transcript, on a different claude build, carrying ten
 * `queue-operation` records and seven `last-prompt` records — types no parser
 * consumes. It exists so an incremental pass has something it is *not* meant
 * to touch, and so `doctor`'s counts have to be a sum rather than a snapshot.
 */
function writeQueueHeavyTranscript(claudeDir: string): string {
  const file = path.join(claudeDir, 'projects', '-tmp-potsherd-index-2', `${QUEUE_HEAVY_ID}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const base = { sessionId: QUEUE_HEAVY_ID, cwd: '/tmp/potsherd-index-2', version: '2.1.240', gitBranch: 'main' };
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < 10; i++) rows.push({ ...base, type: 'queue-operation', uuid: `q${i}` });
  for (let i = 0; i < 7; i++) rows.push({ ...base, type: 'last-prompt', leafUuid: `l${i}` });
  rows.push({ ...base, type: 'user', promptId: 'p1', uuid: 'u1', timestamp: '2026-08-20T09:00:00.000Z', message: { role: 'user', content: 'a second session, on a newer build' } });
  rows.push({ ...base, type: 'assistant', uuid: 'a1', timestamp: '2026-08-20T09:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'noted.' }] } });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

function openDb(root: string): Db {
  return store.open({ root });
}

describe('index: adapter output into the store', () => {
  it('writes sessions, exchanges and tool calls, and makes them searchable', async () => {
    const { claudeDir, root } = scratch();
    writeTranscript(claudeDir);

    const report = await indexAll({ root, claudeDir, harnesses: ['claude'], embed: false, full: true });
    expect(report.totals.parsed).toBe(1);
    expect(report.totals.failed).toBe(0);

    const db = openDb(root);
    const session = db.prepare('SELECT * FROM sessions').get() as Record<string, unknown>;
    expect(session['harness']).toBe('claude');
    expect(session['title']).toBe('pgbouncer deploy credentials');
    expect(session['git_branch']).toBe('main');
    expect(session['project']).toBe('/tmp/potsherd-index');
    expect(session['status']).toBe('live');
    // The incremental key: what was read, and how far.
    expect(session['source_mtime']).toBeTypeOf('number');
    expect(session['source_offset']).toBe(fs.statSync(String(session['source_path'])).size);

    expect(store.count(db, 'exchanges')).toBe(2);
    expect(store.count(db, 'tool_calls')).toBe(1);

    // fts5 is an external-content table: if it is not fed by hand it silently
    // matches nothing, which is exactly the failure that would make `find`
    // return an empty list on a full index.
    const hit = db
      .prepare(`SELECT rowid FROM exchanges_fts WHERE exchanges_fts MATCH 'pgbouncer'`)
      .all();
    expect(hit).toHaveLength(1);
    db.close();
  });

  it('redacts before the first row is written, and never touches the source', async () => {
    const { claudeDir, root } = scratch();
    const file = writeTranscript(claudeDir);
    const before = fs.readFileSync(file);

    const report = await indexAll({ root, claudeDir, harnesses: ['claude'], embed: false, full: true });
    expect(report.redaction.byType.aws).toBe(1);
    expect(report.redaction.byType.github).toBe(1);

    const db = openDb(root);
    const texts = db
      .prepare('SELECT user_text, assistant_text, redacted FROM exchanges ORDER BY seq')
      .all() as { user_text: string; assistant_text: string; redacted: number }[];
    const tool = db.prepare('SELECT input FROM tool_calls').get() as { input: string };

    // Nothing anywhere in the index holds either secret.
    const everything = JSON.stringify(texts) + tool.input;
    expect(everything).not.toContain(AWS_KEY);
    expect(everything).not.toContain(GITHUB_TOKEN);
    expect(tool.input).toMatch(/‹redacted:aws:[0-9a-f]{8}›/);
    expect(texts[1]!.assistant_text).toMatch(/‹redacted:github:[0-9a-f]{8}›/);

    // `03` §5: the flag is set exactly where a rule fired.
    expect(texts.map((t) => t.redacted)).toEqual([1, 1]);

    // Searchable by shape, never by value: the mask tokenises to three terms,
    // so `find <sha8>` locates every exchange that leaked that one secret.
    const sha8 = /‹redacted:github:([0-9a-f]{8})›/.exec(texts[1]!.assistant_text)![1]!;
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM exchanges_fts WHERE exchanges_fts MATCH ?`).get(sha8),
    ).toEqual({ n: 1 });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM exchanges_fts WHERE exchanges_fts MATCH 'redacted AND github'`).get(),
    ).toEqual({ n: 1 });

    // What doctor reports, recomputed from the stored text rather than
    // remembered — so it can never drift from what is actually masked.
    const stored = storedRedactionCounts(db);
    expect(stored.byType.aws).toBe(1);
    expect(stored.byType.github).toBe(1);
    db.close();

    // L3's invariant: the archive — and here, the user's own file — is
    // byte-exact and unredacted. Only the index is redacted.
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('is idempotent: a second full run leaves the same rows and a consistent fts', async () => {
    const { claudeDir, root } = scratch();
    writeTranscript(claudeDir);
    const db = openDb(root);

    await indexAll({ db, root, claudeDir, harnesses: ['claude'], embed: false, full: true });
    const first = db.prepare('SELECT id, user_text FROM exchanges ORDER BY seq').all();
    await indexAll({ db, root, claudeDir, harnesses: ['claude'], embed: false, full: true });
    const second = db.prepare('SELECT id, user_text FROM exchanges ORDER BY seq').all();

    expect(second).toEqual(first);
    expect(store.count(db, 'exchanges')).toBe(2);
    // An external-content fts5 index that was not un-indexed before its rows
    // were deleted reports corruption here rather than at query time.
    expect(() =>
      db.prepare(`INSERT INTO exchanges_fts (exchanges_fts) VALUES ('integrity-check')`).run(),
    ).not.toThrow();
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM exchanges_fts WHERE exchanges_fts MATCH 'pgbouncer'`).get(),
    ).toEqual({ n: 1 });
    db.close();
  });

  it('skips a source whose mtime and byte count are unchanged', async () => {
    const { claudeDir, root } = scratch();
    const file = writeTranscript(claudeDir);
    const db = openDb(root);

    const first = await indexAll({ db, root, claudeDir, harnesses: ['claude'], embed: false, full: true });
    expect(first.totals.parsed).toBe(1);

    const second = await indexAll({ db, root, claudeDir, harnesses: ['claude'], embed: false });
    expect(second.totals.parsed).toBe(0);
    expect(second.harnesses[0]!.unchanged).toBe(true);
    // The counts still describe the index, not the run: an incremental run that
    // read nothing must still be able to say how much is indexed.
    expect(second.totals.exchanges).toBe(2);

    // Appending to the transcript changes both mtime and size, so it is re-read.
    fs.appendFileSync(
      file,
      JSON.stringify({
        sessionId: 'aaaa1111-0000-4000-8000-000000000001',
        cwd: '/tmp/potsherd-index',
        type: 'user',
        promptId: 'p3',
        uuid: 'u4',
        timestamp: '2026-08-19T09:02:00.000Z',
        message: { role: 'user', content: 'ship it' },
      }) + '\n',
    );
    const third = await indexAll({ db, root, claudeDir, harnesses: ['claude'], embed: false });
    expect(third.totals.parsed).toBe(1);
    expect(store.count(db, 'exchanges')).toBe(3);
    db.close();
  });

  it('records exact (harness, version, type) counts for the types it did not consume', async () => {
    const { claudeDir, root } = scratch();
    writeTranscript(claudeDir);
    const db = openDb(root);
    await indexAll({ db, root, claudeDir, harnesses: ['claude'], embed: false, full: true });

    const rows = storedRecordTypes(db);
    const novel = rows.find((r) => r.type === 'sky-hook-negotiator');
    expect(novel).toMatchObject({ harness: 'claude', version: '2.1.237', count: 1, novel: true });
    // A documented, deliberately-ignored type is counted but not cried wolf over.
    expect(rows.find((r) => r.type === 'queue-operation')).toMatchObject({ novel: false });
    expect(rows.find((r) => r.type === 'artifact-comment-monitor')).toMatchObject({
      count: 1,
      novel: false,
    });
    db.close();
  });

  /**
   * The counts belong to the index, not to the last pass over it.
   *
   * They used to live in one `sync_state` blob that each run rewrote with
   * whatever *that run* had re-read. Appending a line to one transcript and
   * re-indexing therefore took `queue-operation 11` down to `queue-operation
   * 1` and made every type absent from that one file vanish from `doctor`
   * altogether — an archive tool quietly losing the record of what it skipped.
   */
  it('keeps the counts of the sessions an incremental pass did not open', async () => {
    const { claudeDir, root } = scratch();
    const fileA = writeTranscript(claudeDir);
    writeQueueHeavyTranscript(claudeDir);
    const db = openDb(root);
    await indexAll({ db, root, claudeDir, harnesses: ['claude'], embed: false, full: true });

    const total = (rows: ReturnType<typeof storedRecordTypes>, type: string): number =>
      rows.filter((r) => r.type === type).reduce((a, r) => a + r.count, 0);
    const versions = (rows: ReturnType<typeof storedRecordTypes>, type: string): number =>
      new Set(rows.filter((r) => r.type === type).map((r) => r.version)).size;

    const full = storedRecordTypes(db);
    expect(total(full, 'queue-operation')).toBe(11);
    expect(versions(full, 'queue-operation')).toBe(2);
    expect(total(full, 'last-prompt')).toBe(7);
    expect(total(full, 'artifact-comment-monitor')).toBe(1);

    // One line appended to one transcript; the other file is not opened.
    fs.appendFileSync(
      fileA,
      JSON.stringify({
        sessionId: 'aaaa1111-0000-4000-8000-000000000001',
        cwd: '/tmp/potsherd-index',
        version: '2.1.237',
        type: 'user',
        promptId: 'p3',
        uuid: 'u9',
        timestamp: '2026-08-19T09:02:00.000Z',
        message: { role: 'user', content: 'one more question' },
      }) + '\n',
    );
    const incremental = await indexAll({ db, root, claudeDir, harnesses: ['claude'], embed: false });
    expect(incremental.totals.parsed).toBe(1);
    expect(incremental.totals.skipped).toBe(1);

    const after = storedRecordTypes(db);
    expect(total(after, 'queue-operation')).toBe(11);
    expect(versions(after, 'queue-operation')).toBe(2);
    // The type that only ever appeared in the file this pass never opened.
    expect(total(after, 'last-prompt')).toBe(7);
    expect(total(after, 'artifact-comment-monitor')).toBe(1);
    db.close();
  });

  it('retires the counts of a session with the session', async () => {
    const { claudeDir, root } = scratch();
    writeTranscript(claudeDir);
    writeQueueHeavyTranscript(claudeDir);
    const db = openDb(root);
    await indexAll({ db, root, claudeDir, harnesses: ['claude'], embed: false, full: true });
    db.prepare('DELETE FROM sessions WHERE id = ?').run(QUEUE_HEAVY_ID);
    const rows = storedRecordTypes(db);
    expect(rows.filter((r) => r.type === 'queue-operation').reduce((a, r) => a + r.count, 0)).toBe(1);
    expect(rows.some((r) => r.type === 'last-prompt')).toBe(false);
    db.close();
  });
});

describe('index: ghosts into fts', () => {
  /** Phase 0 wrote these tables and never indexed them; T1.5 does. */
  function seedGhost(db: Db, text: string): void {
    db.prepare(
      `INSERT INTO ghosts (session_id, harness, project, first_ts, last_ts, prompt_count, first_prompt, title, source)
       VALUES ('ghost-1', 'claude', '/tmp/gone', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', 2, ?, 'the canon driver', 'history')`,
    ).run(text);
    db.prepare(
      `INSERT INTO ghost_prompts (id, session_id, seq, ts, text, redacted) VALUES ('ghost-1:0', 'ghost-1', 0, NULL, ?, 0)`,
    ).run(text);
    db.prepare(
      `INSERT INTO ghost_prompts (id, session_id, seq, ts, text, redacted) VALUES ('ghost-1:1', 'ghost-1', 1, NULL, 'nothing secret here', 0)`,
    ).run();
  }

  it('fills ghosts_fts and ghost_prompts_fts, redacting the prompt text on the way in', () => {
    const { root } = scratch();
    const db = openDb(root);
    seedGhost(db, `the canon driver kept failing, here is the key ${AWS_KEY}`);

    const result = ingestGhosts(db, { full: true });
    expect(result.ghosts).toBe(1);
    expect(result.prompts).toBe(2);
    expect(result.redactedPrompts).toBe(1);
    // Twice: once in `ghosts.first_prompt` and once in the `ghost_prompts` row
    // it came from. Both are index columns and both are masked.
    expect(result.counts.byType.aws).toBe(2);

    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM ghosts_fts WHERE ghosts_fts MATCH 'canon'`).get(),
    ).toEqual({ n: 1 });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM ghost_prompts_fts WHERE ghost_prompts_fts MATCH 'canon'`).get(),
    ).toEqual({ n: 1 });

    const prompts = db.prepare('SELECT text, redacted FROM ghost_prompts ORDER BY seq').all() as {
      text: string;
      redacted: number;
    }[];
    expect(prompts[0]!.text).not.toContain(AWS_KEY);
    expect(prompts[0]!.text).toMatch(/‹redacted:aws:[0-9a-f]{8}›/);
    expect(prompts.map((p) => p.redacted)).toEqual([1, 0]);
    // ghosts.first_prompt is the same text from the same source; it is masked
    // too, or `ghosts_fts` would index a secret.
    const ghost = db.prepare('SELECT first_prompt FROM ghosts').get() as { first_prompt: string };
    expect(ghost.first_prompt).not.toContain(AWS_KEY);
    db.close();
  });

  it('skips the pass when nothing about the ghosts has changed', () => {
    const { root } = scratch();
    const db = openDb(root);
    seedGhost(db, 'the canon driver kept failing');

    expect(ingestGhosts(db).unchanged).toBe(false);
    expect(ingestGhosts(db).unchanged).toBe(true);
    // …and a rescue that adds a ghost invalidates it.
    db.prepare(
      `INSERT INTO ghosts (session_id, harness, prompt_count, first_prompt, source)
       VALUES ('ghost-2', 'claude', 1, 'another lost session', 'history')`,
    ).run();
    expect(ingestGhosts(db).unchanged).toBe(false);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM ghosts_fts WHERE ghosts_fts MATCH 'lost'`).get(),
    ).toEqual({ n: 1 });
    db.close();
  });
});

describe('index: sqlite-vec fails soft', () => {
  it('creates the vec tables as migration 4 when the extension loads', () => {
    const { root } = scratch();
    const db = openDb(root);
    const status = vecStatus(db);
    if (!status.available) {
      // The whole point: a machine without the extension is not a broken one.
      expect(store.schemaVersion(db)).toBe(3);
      expect(status.reason).toBeTruthy();
      db.close();
      return;
    }
    expect(store.schemaVersion(db)).toBe(store.latestSchemaVersion());
    expect(store.count(db, 'vec_exchanges')).toBe(0);
    db.close();
  });

  it('indexes with no vectors, and says why, when the extension is unavailable', async () => {
    const { claudeDir, root } = scratch();
    writeTranscript(claudeDir);
    const previous = process.env['POTSHERD_NO_VEC'];
    process.env['POTSHERD_NO_VEC'] = '1';
    try {
      const report = await indexAll({ root, claudeDir, harnesses: ['claude'], embed: true, full: true });
      // The index is built; only the vectors are missing.
      expect(report.totals.exchanges).toBe(2);
      expect(report.vec.available).toBe(false);
      expect(report.vec.reason).toContain('POTSHERD_NO_VEC');
      expect(report.embeddings.available).toBe(false);
      expect(report.embeddings.reason).toBeTruthy();
      // Migration 4 declined rather than failed, so it will be retried.
      const db = openDb(root);
      expect(store.schemaVersion(db)).toBe(3);
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM exchanges_fts WHERE exchanges_fts MATCH 'pgbouncer'`).get(),
      ).toEqual({ n: 1 });
      db.close();
    } finally {
      if (previous === undefined) delete process.env['POTSHERD_NO_VEC'];
      else process.env['POTSHERD_NO_VEC'] = previous;
    }
  });

  it('--no-embed leaves every exchange unembedded and says so', async () => {
    const { claudeDir, root } = scratch();
    writeTranscript(claudeDir);
    const report = await indexAll({ root, claudeDir, harnesses: ['claude'], embed: false, full: true });
    expect(report.embeddings.enabled).toBe(false);
    expect(report.embeddings.embedded).toBe(0);
    expect(report.embeddings.reason).toContain('--no-embed');
    const db = openDb(root);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM exchanges WHERE embedding_version IS NOT NULL').get(),
    ).toEqual({ n: 0 });
    db.close();
  });
});

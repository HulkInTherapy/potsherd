import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  db as store,
  indexAll,
  ingestGhosts,
  storedRecordTypes,
  storedRedactionCounts,
  vecStatus,
  type Db,
  type IndexReport,
} from '@potsherd/core';
import { renderIndexReceipt } from '../packages/cli/src/commands/index.js';
import { themeFrom } from '../packages/cli/src/output.js';
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
    // NOT `--no-embed`: since 8.6 flipped the default, `indexAll` sees
    // `embed: false` whether the user typed the flag or typed nothing, so a
    // reason naming the flag reports something the library cannot know. It
    // states the outcome, and names the flag that CHANGES the outcome.
    expect(report.embeddings.reason).toContain('text search only');
    expect(report.embeddings.reason).toContain('--embed');
    expect(report.embeddings.reason).not.toContain('--no-embed');
    const db = openDb(root);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM exchanges WHERE embedding_version IS NOT NULL').get(),
    ).toEqual({ n: 0 });
    db.close();
  });
});

// ------------------------------------------------ T8.E: offline on day one

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(repoRoot, 'packages', 'cli', 'bin', 'potsherd.js');

/**
 * The verb, spawned the way a stranger runs it.
 *
 * `NODE_PATH` is deleted rather than inherited. vitest sets it to directories
 * inside this repo's own `node_modules`, every child process inherits it, and
 * a child that resolves a module through the parent's search path is not the
 * child a user runs. It has silently invalidated a test in this build before.
 */
function cli(args: string[]): { code: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', COLUMNS: '80' };
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

/**
 * The same verb with the operating system holding the network shut.
 *
 * macOS only — `sandbox-exec` is the only thing on this machine that can deny
 * a process the network without denying it the disk — so the tests that use
 * it are skipped elsewhere and the portable assertions below stand on their
 * own. What it buys is the difference between *asserting* that `index` does
 * not download a model and *establishing* it: inside this sandbox no model
 * could be reached, and the same sandbox proves it by making `--embed` fail.
 */
const CAN_DENY_NETWORK =
  process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');

function offlineCli(args: string[]): { code: number; stdout: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', COLUMNS: '80' };
  delete env['NODE_PATH'];
  try {
    return {
      code: 0,
      stdout: execFileSync(
        '/usr/bin/sandbox-exec',
        ['-p', '(version 1)(allow default)(deny network*)', process.execPath, bin, ...args],
        { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? '' };
  }
}

/**
 * `potsherd index` with no flags — the first thing a stranger runs after
 * `audit` and `rescue` (`08` §8.6, `05` "< 2 s, offline").
 *
 * It used to fetch a 32 MB model and embed every exchange: 5m 43s against
 * 10 s on the frozen reference archive, measured 2026-08-22. The default is
 * now text only, `--embed` is the opt-in, and the receipt's last line is the
 * offer.
 */
describe('potsherd index is offline by default (T8.E, 08 §8.6)', () => {
  function corpus(): { claudeDir: string; root: string; dirs: string[] } {
    const s = scratch();
    writeTranscript(s.claudeDir);
    return {
      ...s,
      dirs: ['--harness', 'claude', '--claude-dir', s.claudeDir, '--potsherd-dir', s.root],
    };
  }

  it('embeds nothing and downloads nothing', () => {
    const { root, dirs } = corpus();
    const r = cli(['index', ...dirs, '--json']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout) as {
      totals: { exchanges: number };
      embeddings: { enabled: boolean; downloaded: boolean; embedded: number };
    };

    // The index is real...
    expect(j.totals.exchanges).toBe(2);
    // ...and no part of it went near the model.
    expect(j.embeddings).toMatchObject({ enabled: false, downloaded: false, embedded: 0 });

    // Established, not asserted: the directory the 32 MB download lands in
    // was never created. `potsherd index` cannot have fetched a model and
    // left no model behind.
    expect(fs.existsSync(path.join(root, 'models'))).toBe(false);
  });

  it('ends with one line offering the upgrade, and that line is the command', () => {
    const { dirs } = corpus();
    const out = cli(['index', ...dirs]).stdout.replace(/\s+$/, '');
    const last = out.split('\n').at(-1)!;

    expect(last.trim()).toBe(
      'run  potsherd index --embed  for semantic search (32 MB model, ~6 min, once)',
    );

    // `09` §13.7 — if the documentation prints a command, the test runs that
    // command as printed. The command is lifted back out of the line the user
    // reads, not retyped from the source, and run against a corpus with
    // nothing left to embed so that no 32 MB download can be started by the
    // suite. What it proves is that the printed flag exists and is accepted:
    // before T8.E `--embed` was not a flag at all, and this line would have
    // told every new user to type an unknown option.
    const printed = last.trim().replace(/^run\s+/, '').split(/\s{2,}/)[0]!;
    expect(printed).toBe('potsherd index --embed');

    const empty = scratch();
    fs.mkdirSync(path.join(empty.claudeDir, 'projects'), { recursive: true });
    const asPrinted = printed.split(' ').slice(1);
    const r = cli([
      ...asPrinted,
      '--harness', 'claude',
      '--claude-dir', empty.claudeDir,
      '--potsherd-dir', empty.root,
      '--json',
    ]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout) as { embeddings: { enabled: boolean; downloaded: boolean } };
    // The flag was understood — embeddings were asked for — and there was
    // nothing to embed, so nothing was fetched.
    expect(j.embeddings).toMatchObject({ enabled: true, downloaded: false });
    expect(fs.existsSync(path.join(empty.root, 'models'))).toBe(false);
  });

  /**
   * `08` rule 8: a flag that is documented and does nothing is the worst kind.
   *
   * `--no-embed` now names the default, so it had to either go or keep a job.
   * It keeps one: it is the way to say *and stop offering*. Someone who has
   * declined once — in a SessionStart hook, in CI, on a metered connection —
   * should not be sold the model on every run, and that is a difference you
   * can see by diffing two receipts.
   */
  it('--no-embed is not a no-op: it turns the offer off', () => {
    const a = corpus();
    const b = corpus();
    const offered = cli(['index', ...a.dirs]).stdout;
    const declined = cli(['index', '--no-embed', ...b.dirs]).stdout;

    expect(offered).toContain('run  potsherd index --embed  for semantic search');
    expect(declined).not.toContain('--embed');
    expect(declined).not.toContain('semantic search');

    // And the receipt says which of the two silences it is.
    expect(offered).toContain('text search only');
    expect(offered).toContain('no model, no network');
    expect(declined).toContain('skipped (--no-embed)');

    // The index itself is identical: this flag changes what is said, not what
    // is stored. Everything but the vectors row, the offer and the timings is
    // the same receipt, line for line.
    const body = (out: string) =>
      out
        .split('\n')
        .filter((l) => !/vectors|--embed|index /.test(l))
        .join('\n');
    expect(body(declined)).toBe(body(offered));
  });

  it('is the last flag that wins when both are given', () => {
    const a = corpus();
    const b = corpus();
    const off = JSON.parse(cli(['index', '--embed', '--no-embed', ...a.dirs, '--json']).stdout) as {
      embeddings: { enabled: boolean };
    };
    expect(off.embeddings.enabled).toBe(false);
    // The mirror image is only asserted as far as "it was asked for": actually
    // embedding here would fetch 32 MB inside the test suite.
    const on = JSON.parse(
      offlineOrPlain(['index', '--no-embed', '--embed', ...b.dirs, '--json']),
    ) as { embeddings: { enabled: boolean } };
    expect(on.embeddings.enabled).toBe(true);
  });

  /**
   * Where the sandbox earns its place. Two commands, one denied network:
   *
   *   `index --embed`  fails to reach the model — which is what proves the
   *                    sandbox is really denying the network, rather than the
   *                    test trusting that it is.
   *   `index`          exits 0 and indexes everything — which is the claim.
   *
   * A test whose premise is "the machine happened to be offline" proves
   * nothing on a machine that happens to be online. This one establishes the
   * premise inside itself.
   */
  it.runIf(CAN_DENY_NETWORK)('runs where the network is denied, and --embed cannot', () => {
    const a = corpus();
    const b = corpus();

    const reaching = offlineCli(['index', '--embed', ...a.dirs, '--json']);
    const j = JSON.parse(reaching.stdout) as {
      embeddings: { enabled: boolean; available: boolean; reason?: string };
    };
    expect(j.embeddings.enabled).toBe(true);
    // The control: inside this sandbox the model is unreachable.
    expect(j.embeddings.available).toBe(false);
    expect(j.embeddings.reason ?? '').toMatch(/fetch|network|ENOTFOUND|EAI_AGAIN|unavailable/i);

    const plain = offlineCli(['index', ...b.dirs, '--json']);
    expect(plain.code).toBe(0);
    const k = JSON.parse(plain.stdout) as {
      totals: { exchanges: number };
      embeddings: { enabled: boolean };
    };
    expect(k.totals.exchanges).toBe(2);
    expect(k.embeddings.enabled).toBe(false);
    // Nothing was degraded and nothing was retried: the default never wanted
    // the network, so denying it changes no output at all.
    expect(offlineCli(['index', ...b.dirs]).stdout).toContain('potsherd index --embed');
  });

  /**
   * The row that did not exist before the default flipped.
   *
   * Someone who ran `index --embed` last week and plain `index` today still
   * has 1,294 vectors, and this run did not refresh them. `—  skipped` would
   * be false; the bare count would be worse, because it would read as "the
   * vectors cover what was just parsed". So the count is printed *and*
   * labelled.
   */
  it('says vectors exist but were not refreshed, rather than skipped', () => {
    const t = themeFrom({ json: false, width: 80 });
    const base = report({ enabled: false, upToDate: 0 });
    expect(renderIndexReceipt(base, t, '/tmp/p', {})).toContain('text search only');

    const stale = renderIndexReceipt(report({ enabled: false, upToDate: 1294 }), t, '/tmp/p', {});
    expect(stale).toContain('1,294');
    expect(stale).toContain('not refreshed this run');
    expect(stale).not.toContain('skipped');
    // Still offered, because refreshing them is the same command.
    expect(stale).toContain('run  potsherd index --embed');

    // And with --no-embed the offer is gone from both.
    const declined = renderIndexReceipt(report({ enabled: false, upToDate: 1294 }), t, '/tmp/p', {
      embed: false,
    });
    expect(declined).toContain('not refreshed this run');
    expect(declined).not.toContain('run  potsherd index --embed');
  });

  it('does not offer semantic search over an empty index', () => {
    const t = themeFrom({ json: false, width: 80 });
    const nothing = report({ enabled: false, upToDate: 0, exchanges: 0 });
    expect(renderIndexReceipt(nothing, t, '/tmp/p', {})).not.toContain('semantic search');
  });

  it('fits 60 and 80 columns with the offer on the end', () => {
    for (const width of [60, 80]) {
      const out = renderIndexReceipt(
        report({ enabled: false, upToDate: 0 }),
        themeFrom({ json: false, width }),
        '/tmp/potsherd',
        {},
      );
      expect(out).toContain('potsherd index --embed');
      for (const line of out.split('\n')) {
        expect(line.length, `"${line}" at ${width}`).toBeLessThanOrEqual(width);
      }
    }
  });
});

/** `index --embed` under the sandbox where one exists; plain elsewhere. */
function offlineOrPlain(args: string[]): string {
  return CAN_DENY_NETWORK ? offlineCli(args).stdout : cli(args).stdout;
}

/** A minimal {@link IndexReport}, for the receipt's own assertions. */
function report(o: {
  enabled: boolean;
  upToDate: number;
  exchanges?: number;
}): IndexReport {
  const exchanges = o.exchanges ?? 1294;
  return {
    ranAt: '2026-08-22T12:00:00.000Z',
    full: false,
    harnesses: [],
    totals: {
      sessions: 30,
      exchanges,
      toolCalls: 9243,
      redactedExchanges: 175,
      parsed: 227,
      skipped: 0,
      failed: 0,
      bytes: 324_000_000,
    },
    recordTypes: [],
    redaction: { total: 0, byType: {} },
    ghosts: { ghosts: 299, prompts: 2971, unchanged: false } as IndexReport['ghosts'],
    embeddings: {
      enabled: o.enabled,
      available: false,
      model: 'Xenova/bge-small-en-v1.5',
      embedded: 0,
      upToDate: o.upToDate,
      ghostPrompts: 0,
      downloaded: false,
      ms: 0,
    },
    vec: { available: false } as IndexReport['vec'],
    ms: 10_700,
  };
}

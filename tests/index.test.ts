import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  db as store,
  embeddings,
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

describe('index: the vector store needs no extension', () => {
  it('creates the vector tables whether or not sqlite-vec is on the machine', () => {
    const { root } = scratch();
    const db = openDb(root);
    const status = vecStatus(db);
    // The whole point of phase 10 §A2's second half: there is no machine on
    // which this declines. Migration 4 used to return false without the
    // native extension, and `schemaVersion()` counts contiguously, so the
    // schema stopped at 3 and semantic search was structurally impossible.
    expect(status.available).toBe(true);
    expect(status.backend).toBe('scan');
    expect(store.schemaVersion(db)).toBe(store.latestSchemaVersion());
    expect(store.count(db, 'vec_exchanges')).toBe(0);
    db.close();
  });

  it('indexes and stores vectors with the extension explicitly disabled', async () => {
    const { claudeDir, root } = scratch();
    writeTranscript(claudeDir);
    const previous = process.env['POTSHERD_NO_VEC'];
    process.env['POTSHERD_NO_VEC'] = '1';
    try {
      const report = await indexAll({ root, claudeDir, harnesses: ['claude'], embed: false, full: true });
      expect(report.totals.exchanges).toBe(2);
      const db = openDb(root);
      // Every migration applied, and the store is writable and searchable
      // with no extension loaded at all.
      expect(store.schemaVersion(db)).toBe(store.latestSchemaVersion());
      expect(vecStatus(db).available).toBe(true);
      db.prepare('INSERT INTO vec_exchanges (id, embedding) VALUES (?, ?)').run(
        'e1',
        Buffer.from(new Float32Array(384).fill(0.05).buffer),
      );
      expect(store.count(db, 'vec_exchanges')).toBe(1);
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
describe('potsherd index acquires semantic search by itself (phase 10 §A2)', () => {
  function corpus(): { claudeDir: string; root: string; dirs: string[] } {
    const s = scratch();
    writeTranscript(s.claudeDir);
    return {
      ...s,
      dirs: ['--harness', 'claude', '--claude-dir', s.claudeDir, '--potsherd-dir', s.root],
    };
  }

  /**
   * The default this replaces.
   *
   * Until phase 10, `potsherd index` with no flags meant `--no-embed` in all
   * but name: it printed a line offering `--embed` and left the semantic half
   * of `find` switched off for everyone who did not read it. The product law
   * for this phase forbids that shape — *no opt-in tiers, no flags to unlock
   * quality* — so the assertion is inverted. No flag now means the capability
   * is on its way, and nothing on the screen asks the reader for anything.
   */
  it('never offers an upgrade, because there is no tier to buy', () => {
    const { dirs } = corpus();
    const out = cli(['index', ...dirs]).stdout;
    expect(out).not.toContain('potsherd index --embed');
    expect(out).not.toMatch(/for semantic search \(/);
    expect(out).not.toContain('text search only');
    // What it says instead is a status, with no command in it.
    expect(out).toMatch(/semantic search: warming/);
    const status = out.split('\n').find((l) => l.includes('semantic search:'))!;
    expect(status).not.toContain('run  ');
    expect(status).not.toMatch(/--embed|install/);
  });

  it('returns with text search live, whatever the vectors are doing', () => {
    const { dirs } = corpus();
    const r = cli(['index', ...dirs, '--json']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout) as {
      totals: { exchanges: number };
      vectors: { embedded: number; pending: number; total: number; phase: string } | null;
      embeddingInBackground: boolean;
    };
    // The index is real and complete...
    expect(j.totals.exchanges).toBe(2);
    // ...and the verb did not wait for a single vector to produce it.
    expect(j.vectors).not.toBeNull();
    expect(j.vectors!.total).toBe(2);
    expect(j.vectors!.embedded).toBe(0);
    expect(j.vectors!.pending).toBe(2);
    expect(j.vectors!.phase).toBe('pending');
  });

  /**
   * `08` rule 8: a flag that is documented and does nothing is the worst kind.
   *
   * `--no-embed` no longer names the default, so it has a real job again — the
   * one switch that turns a capability **off**, for CI, a hook, a metered
   * connection, or an air-gapped machine. Turning something off is not an
   * opt-in tier; it is the escape hatch the product law leaves room for.
   */
  it('--no-embed turns it off, and says so rather than going quiet', () => {
    const b = corpus();
    const declined = cli(['index', '--no-embed', ...b.dirs]);
    expect(declined.code).toBe(0);
    expect(declined.stdout).toContain('not this run (--no-embed)');
    expect(declined.stdout).not.toContain('semantic search: warming');
    // And nothing was fetched: the directory the download lands in was never
    // created. Established, not asserted.
    expect(fs.existsSync(path.join(b.root, 'models'))).toBe(false);
  });

  it('is the last flag that wins when both are given', () => {
    const a = corpus();
    const off = JSON.parse(
      cli(['index', '--embed', '--no-embed', ...a.dirs, '--json']).stdout,
    ) as { embeddingInBackground: boolean; vectors: { pending: number } | null };
    expect(off.embeddingInBackground).toBe(false);
    expect(off.vectors!.pending).toBe(2);
    expect(fs.existsSync(path.join(a.root, 'models'))).toBe(false);
  });

  /**
   * Where the sandbox earns its place. One command, no network:
   *
   *   `index`  exits 0, indexes everything, and says semantic search is not
   *            running — without hanging, retrying, or failing the run.
   *
   * A machine that is offline forever must still get a fully working
   * text-search potsherd and an honest status line. A test whose premise is
   * "the machine happened to be offline" proves nothing on a machine that
   * happens to be online, so this one establishes the premise inside itself.
   */
  it.runIf(CAN_DENY_NETWORK)('indexes and exits 0 where the network is denied', () => {
    const b = corpus();
    const plain = offlineCli(['index', ...b.dirs, '--json']);
    expect(plain.code).toBe(0);
    const k = JSON.parse(plain.stdout) as { totals: { exchanges: number } };
    expect(k.totals.exchanges).toBe(2);
    // Text search is whole. The vectors are simply not there yet, and no
    // output asks the reader to do anything about it.
    const human = offlineCli(['index', '--full', ...b.dirs]).stdout;
    expect(human).not.toContain('run  potsherd index --embed');
  });

  /**
   * The receipt's `vectors` row, rendered from the one source of truth.
   *
   * `doctor` renders the same `row` from the same `vecStatus(db, root)` call,
   * which is what ends the disagreement the agent audit caught (§2 F2:
   * "`doctor` reports `vectors —` on one line while `index` reports
   * `vectors 1,561` on another").
   */
  /**
   * `working` is not decoration — FIX-F round 2.
   *
   * The report carries a lock read now: *is anybody actually embedding the
   * rest?* These fixtures are handed to `renderIndexReceipt` with
   * `spawned: true`, which is a claim that this run has **just started** a
   * pass, so the status handed in beside it has to be a status of that same
   * world. The product does exactly this and in the same place: `index`
   * re-reads its report with `{ working: true }` immediately after
   * `startBackgroundEmbedding` returns, because the child it just spawned
   * needs a node boot before it can take the lock and the lock would otherwise
   * report `false` for that window.
   *
   * Pass `false` and the receipt correctly says `stopped at 1,294 of 1,678`
   * and `not running` — which is what a receipt should say about an index
   * nobody is embedding, and what `find` says about the same one.
   */
  function statusFor(embedded: number, total: number, working = true) {
    const root = tempDir('potsherd-index-vec-');
    dirs.push(root);
    const db = store.open({ root });
    db.exec(`INSERT INTO sessions (id, harness, project, source_path, indexed_at)
             VALUES ('s1', 'claude', '/tmp/p', '/tmp/p/s1.jsonl', '2026-08-23T00:00:00Z')`);
    const ins = db.prepare(
      `INSERT INTO exchanges (id, session_id, seq, user_text, assistant_text, embedding_version)
       VALUES (?, 's1', ?, 'u', 'a', ?)`,
    );
    // The vector goes in beside the stamp — VERIFICATION-7 C7-1. `vectorCounts`
    // counts the store now, because the store is what the search lane can
    // return and the stamp is only the queue's bookkeeping; a fixture that
    // stamps and writes nothing describes an index in the drifted state rather
    // than a warming one.
    const put = db.prepare('INSERT OR REPLACE INTO vec_exchanges (id, embedding) VALUES (?, ?)');
    const blob = embeddings.embeddingToBlob([1, 0, 0]);
    for (let i = 0; i < total; i += 1) {
      ins.run(`e${i}`, i, i < embedded ? 1 : null);
      if (i < embedded) put.run(`e${i}`, blob);
    }
    const status = vecStatus(db, root, { working });
    db.close();
    return status;
  }

  it('prints the count and how far it has to go, never a bare dash', () => {
    const t = themeFrom({ json: false, width: 80 });
    const out = renderIndexReceipt(report({ enabled: false, upToDate: 0 }), t, '/tmp/p', {
      vec: statusFor(1294, 1678),
      spawned: true,
    });
    expect(out).toContain('1,294');
    expect(out).toContain('warming 1,294 of 1,678');
    expect(out).toContain('semantic search: warming (1,294 of 1,678 embedded)');
    expect(out).not.toContain('--embed');
  });

  /**
   * FIX-F round 2 §4.3 — the row and the sentence stop saying `warming` about
   * an index nobody is embedding.
   *
   * The mirror of the test above, and the pair is the point: the receipt of a
   * run that has just started a pass says `warming`, and the receipt of a run
   * that has not says what is true instead. One word for work in flight, a
   * different one for work that has stopped — never one word widened over both,
   * which is `09 §9`.
   */
  it('says stopped, not warming, when nothing is embedding the rest', () => {
    const t = themeFrom({ json: false, width: 80 });
    const out = renderIndexReceipt(report({ enabled: false, upToDate: 0 }), t, '/tmp/p', {
      vec: statusFor(1294, 1678, false),
      spawned: false,
    });
    expect(out).toContain('stopped at 1,294 of 1,678');
    expect(out).toContain('semantic search: not running (1,294 of 1,678 embedded)');
    expect(out).not.toContain('warming');
    // The count survives either way: a sentence with no denominator is the
    // defect FIX-C closed.
    expect(out).toContain('1,294');
    // And still no command, on either side of the branch.
    expect(out).not.toMatch(/--embed|run {2}potsherd index/);
  });

  it('says nothing about semantic search over an empty index', () => {
    const t = themeFrom({ json: false, width: 80 });
    const out = renderIndexReceipt(report({ enabled: false, upToDate: 0, exchanges: 0 }), t, '/tmp/p', {
      vec: statusFor(0, 0),
    });
    expect(out).not.toContain('semantic search');
  });

  it('fits 60 and 80 columns with the status on the end', () => {
    for (const width of [60, 80]) {
      const out = renderIndexReceipt(
        report({ enabled: false, upToDate: 0 }),
        themeFrom({ json: false, width }),
        '/tmp/potsherd',
        { vec: statusFor(1294, 1678), spawned: true },
      );
      // The count survives at both widths: it is the first clause, and the
      // renderer drops whole clauses from the right rather than clipping.
      expect(out).toContain('semantic search: warming (1,294 of 1,678 embedded)');
      for (const line of out.split('\n')) {
        expect(line.length, `"${line}" at ${width}`).toBeLessThanOrEqual(width);
      }
    }
  });
});

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

/**
 * **8.2, the live half.** A session the harness never named is named by its
 * first substantive prompt instead of by `<project>-<id8>`.
 *
 * Everything here builds its own transcript, so the premise of every
 * assertion — what the harness did and did not write — is established by the
 * test and not read off a corpus that happens to contain it.
 *
 * The rule is `rescue.ts`'s, the one that decides what a recovered ghost is
 * called; it is not restated in `ingest.ts` and it is not restated here. What
 * these tests hold is the behaviour §8.2 asked for, so they fail if the rule
 * drifts away from it: not a slash command, at least eight characters, not one
 * of seven conversational stopwords, cut to sixty code points, and derived
 * from the redacted text rather than the raw.
 */
describe('a live session the harness never named (8.2)', () => {
  const NAMELESS = 'aaaa1111-0000-4000-8000-00000000ff01';

  /**
   * A transcript with **no `ai-title` record**, whose prompts are `prompts` in
   * order. Nothing else about it matters to these tests.
   */
  function writeUntitled(claudeDir: string, prompts: string[], id = NAMELESS): string {
    const file = path.join(claudeDir, 'projects', '-tmp-potsherd-untitled', `${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const base = { sessionId: id, cwd: '/tmp/potsherd-untitled', version: '2.1.237', gitBranch: 'main' };
    const rows: Record<string, unknown>[] = [];
    prompts.forEach((text, i) => {
      rows.push({ ...base, type: 'user', promptId: `p${i}`, uuid: `u${i}`, timestamp: `2026-08-19T09:0${i}:00.000Z`, message: { role: 'user', content: text } });
      rows.push({ ...base, type: 'assistant', uuid: `a${i}`, timestamp: `2026-08-19T09:0${i}:01.000Z`, message: { role: 'assistant', content: [{ type: 'text', text: 'noted.' }] } });
    });
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return file;
  }

  const titleOf = (root: string, id = NAMELESS): { title: string | null; source: string | null } => {
    const db = openDb(root);
    try {
      const r = db
        .prepare('SELECT title, title_source FROM sessions WHERE id = ?')
        .get(id) as { title: string | null; title_source: string | null } | undefined;
      return { title: r?.title ?? null, source: r?.title_source ?? null };
    } finally {
      db.close();
    }
  };

  it('takes the first prompt that names it, skipping the ones that do not', async () => {
    const { claudeDir, root } = scratch();
    // A slash command, a stopword, something under eight characters, and then
    // the first thing anybody actually asked. One of each rejected kind, so a
    // rule that only skipped slash commands would fail here.
    writeUntitled(claudeDir, ['/model opus', 'ok', 'why?', 'the retry budget is wrong for the payments gateway']);
    await indexAll({ root, claudeDir, harnesses: ['claude'], embed: false, full: true });

    expect(titleOf(root)).toEqual({
      title: 'the retry budget is wrong for the payments gateway',
      source: 'prompt',
    });
  });

  it('leaves a session with nothing but commands and stubs nameless', async () => {
    const { claudeDir, root } = scratch();
    writeUntitled(claudeDir, ['/resume', 'clear', 'y']);
    await indexAll({ root, claudeDir, harnesses: ['claude'], embed: false, full: true });

    // Null, not a slash command: a dozen sessions called `/resume` are less
    // distinguishable than a dozen uuids, and they also claim to say
    // something. `ls` renders this one `<project>-<id8>`, as it always did.
    expect(titleOf(root)).toEqual({ title: null, source: null });
  });

  it('never overwrites the name the harness wrote', async () => {
    const { claudeDir, root } = scratch();
    const file = writeUntitled(claudeDir, ['the retry budget is wrong for the payments gateway']);
    fs.appendFileSync(
      file,
      JSON.stringify({ sessionId: NAMELESS, cwd: '/tmp/potsherd-untitled', type: 'ai-title', uuid: 'ti', timestamp: '2026-08-19T09:09:00.000Z', aiTitle: 'Retry budget for the payments gateway' }) + '\n',
    );
    await indexAll({ root, claudeDir, harnesses: ['claude'], embed: false, full: true });

    expect(titleOf(root)).toEqual({
      title: 'Retry budget for the payments gateway',
      source: null,
    });
  });

  it('retires its own name the moment the harness writes one', async () => {
    const { claudeDir, root } = scratch();
    const file = writeUntitled(claudeDir, ['the retry budget is wrong for the payments gateway']);
    await indexAll({ root, claudeDir, harnesses: ['claude'], embed: false, full: true });
    expect(titleOf(root).source).toBe('prompt');

    // The harness titles a session late — it writes the summary once it has
    // seen enough of the conversation. Without this, `title_source` would stay
    // `'prompt'` against a harness title and the session would sit in
    // `ls --untitled` for ever.
    fs.appendFileSync(
      file,
      JSON.stringify({ sessionId: NAMELESS, cwd: '/tmp/potsherd-untitled', type: 'ai-title', uuid: 'ti', timestamp: '2026-08-19T09:09:00.000Z', aiTitle: 'Retry budget for the payments gateway' }) + '\n',
    );
    await indexAll({ root, claudeDir, harnesses: ['claude'], embed: false, full: true });

    expect(titleOf(root)).toEqual({
      title: 'Retry budget for the payments gateway',
      source: null,
    });
  });

  it('names it from the redacted text, so a pasted secret cannot become a title', async () => {
    const { claudeDir, root } = scratch();
    writeUntitled(claudeDir, [`rotate this key please: ${AWS_KEY} and tell me what else uses it`]);
    await indexAll({ root, claudeDir, harnesses: ['claude'], embed: false, full: true });

    const { title, source } = titleOf(root);
    expect(source).toBe('prompt');
    expect(title).not.toContain(AWS_KEY);
    expect(title).toContain('‹redacted:');
  });

  it('cuts to sixty code points, and counts code points', async () => {
    const { claudeDir, root } = scratch();
    // Sixty astral code points: `String.slice(0, 60)` would cut this at the
    // thirtieth character and leave half a surrogate pair on the end.
    const prompt = '🧱'.repeat(80);
    writeUntitled(claudeDir, [prompt]);
    await indexAll({ root, claudeDir, harnesses: ['claude'], embed: false, full: true });

    const { title } = titleOf(root);
    expect([...title!].length).toBe(60);
    expect(title).toBe('🧱'.repeat(60));
  });

  it('writes the same title twice on a second index, and no second row', async () => {
    const { claudeDir, root } = scratch();
    writeUntitled(claudeDir, ['/model opus', 'the retry budget is wrong for the payments gateway']);
    await indexAll({ root, claudeDir, harnesses: ['claude'], embed: false, full: true });
    const first = titleOf(root);

    await indexAll({ root, claudeDir, harnesses: ['claude'], embed: false, full: true });
    expect(titleOf(root)).toEqual(first);

    const db = openDb(root);
    try {
      expect(store.count(db, 'sessions')).toBe(1);
    } finally {
      db.close();
    }
  });
});

// ------------------------------------------------- one word, one number

/**
 * C-4 — `doctor` said `sessions on disk 49` where `stats` said `sessions 56`,
 * on the same index in the same minute.
 *
 * Neither count was wrong. `doctor`'s came from `audit.ts`, which is scoped to
 * `~/.claude` and therefore counts **claude alone**; `stats`'s is the index,
 * across every harness. What was wrong is that one of them was printed under a
 * label that names no harness, on a screen whose whole job is *what is on
 * disk* — five rows above an adapter block that lists the other harnesses and
 * adds up to the other number.
 *
 * This is audit F2's family — *"the two subsystems disagree in print"* — and
 * it is the third count disagreement of the phase. The fixture is two
 * harnesses on purpose: with claude alone the two numbers agree by accident,
 * which is exactly how this survived every previous round.
 */
describe('doctor and stats do not print two numbers under one word', () => {
  const PI_FIXTURE = path.join(
    path.resolve(path.dirname(fileURLToPath(import.meta.url))),
    'fixtures',
    'pi',
  );

  /** A HOME with a claude corpus and a pi corpus, and nothing of this machine's. */
  function twoHarnesses(): { home: string; claudeDir: string; root: string } {
    const base = tempDir('potsherd-count-');
    dirs.push(base);
    const home = path.join(base, 'home');
    const claudeDir = path.join(home, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    writeTranscript(claudeDir);
    // Two subagent transcripts, because a corpus with none lets a count of
    // `sessions + sidechains` pass as a count of sessions.
    writeSidechains(claudeDir, 2);
    // The committed pi fixture, so the second harness is a real parse and not
    // a row inserted by hand.
    fs.cpSync(path.join(PI_FIXTURE, 'agent'), path.join(home, '.pi', 'agent'), { recursive: true });
    return { home, claudeDir, root: path.join(base, 'potsherd') };
  }

  function homeCli(home: string, args: string[]): string {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, NO_COLOR: '1', COLUMNS: '100', TZ: 'UTC' };
    delete env['NODE_PATH'];
    delete env['CLAUDE_CONFIG_DIR'];
    delete env['POTSHERD_DIR'];
    delete env['XDG_CONFIG_HOME'];
    delete env['CODEX_HOME'];
    return execFileSync(process.execPath, [bin, ...args], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  /** `label   1,234` off a card row, as a number. */
  function row(out: string, label: string): number | null {
    const m = new RegExp(`^\\s+${label}\\s+([\\d,]+)\\s`, 'm').exec(out);
    return m ? Number((m[1] as string).replace(/,/g, '')) : null;
  }

  /** `<project>/<session>/subagents/agent-N.jsonl` — the real claude layout. */
  function writeSidechains(claudeDir: string, n: number): void {
    const parent = 'aaaa1111-0000-4000-8000-000000000001';
    for (let i = 0; i < n; i += 1) {
      const sid = `bbbb111${i}-0000-4000-8000-00000000000${i}`;
      const base = { sessionId: sid, cwd: '/tmp/potsherd-index', version: '2.1.237', gitBranch: 'main', isSidechain: true };
      const file = path.join(claudeDir, 'projects', '-tmp-potsherd-index', parent, 'subagents', `agent-${i}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        [
          { ...base, type: 'user', promptId: `sp${i}`, uuid: `su${i}`, timestamp: '2026-08-19T10:00:00.000Z', message: { role: 'user', content: `review the pooler change ${i}` } },
          { ...base, type: 'assistant', uuid: `sa${i}`, timestamp: '2026-08-19T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Looks fine.' }] } },
        ].map((r) => JSON.stringify(r)).join('\n') + '\n',
      );
    }
  }

  it('the number under a bare "sessions" is the same number on both screens', () => {
    const { home, claudeDir, root } = twoHarnesses();
    homeCli(home, ['index', '--no-embed', '--claude-dir', claudeDir, '--potsherd-dir', root]);
    const doctor = homeCli(home, ['doctor', '--claude-dir', claudeDir, '--potsherd-dir', root]);
    const stats = homeCli(home, ['stats', '--potsherd-dir', root]);

    // The premise: two harnesses are in this index, so a claude-only count and
    // an every-harness count are genuinely different numbers.
    expect(stats, 'the pi fixture did not land in the index').toMatch(/^ {2}pi\s/m);

    const statsSessions = row(stats, 'sessions');
    expect(statsSessions).not.toBeNull();

    // Every row on `doctor` whose label is the bare word `sessions` — with no
    // harness in front of it — is claiming to count the machine. There must be
    // no such row that disagrees with `stats`.
    for (const [, label, value] of doctor.matchAll(/^ {2}(sessions[a-z ]*)\s{2,}([\d,]+)\s/gm)) {
      const n = Number((value as string).replace(/,/g, ''));
      expect(
        n,
        `doctor's "${String(label).trim()}" says ${n} where stats says ${statsSessions}:\n${doctor}`,
      ).toBe(statsSessions);
    }
  });

  it('the disk rows say which harness they walked', () => {
    const { home, claudeDir, root } = twoHarnesses();
    homeCli(home, ['index', '--no-embed', '--claude-dir', claudeDir, '--potsherd-dir', root]);
    const doctor = homeCli(home, ['doctor', '--claude-dir', claudeDir, '--potsherd-dir', root]);
    // `audit.ts` reads `~/.claude` and nothing else, so the two rows it feeds
    // must say so rather than borrowing the machine's name for it.
    expect(doctor).toMatch(/^ {2}claude sessions on disk\s/m);
    expect(doctor).toMatch(/^ {2}claude sidechains on disk\s/m);
    expect(doctor).not.toMatch(/^ {2}sessions on disk\s/m);
    expect(doctor).not.toMatch(/^ {2}sidechains on disk\s/m);
  });
});

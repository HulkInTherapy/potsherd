/**
 * Synthetic opencode fixtures — T6.1.
 *
 * A sqlite store cannot be committed as readable text, and a committed binary
 * is a fixture nobody can review. So the fixture is this **builder**: it is the
 * artefact under review, it is plainly synthetic (no real session ids, titles,
 * home paths or prose — `plans/00-README.md`), and the test materialises the
 * database into a temp directory it owns.
 *
 * Three stores, because the thing under test is schema *discovery*:
 *
 *   `snake.db`   `session` / `message`, snake_case columns, JSON parts content
 *   `camel.db`   `sessions` / `messages`, camelCase columns, plain-text content
 *   `alien.db`   a store with no session table at all — must degrade to
 *                "unsupported version", not throw and not half-parse
 *
 * If the two readable stores had the same column names, the test would pass
 * against a hard-coded schema, which is exactly what `03 §10` forbids.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const parts = (...items) => JSON.stringify(items);

/** `snake.db` — snake_case, epoch-ms times, JSON parts arrays. */
function buildSnake(file) {
  const db = new Database(file);
  db.exec(`
    create table session (
      id text primary key,
      title text,
      created_at integer,
      updated_at integer,
      directory text,
      parent_id text,
      model text
    );
    create table message (
      id text primary key,
      session_id text,
      role text,
      content text,
      created_at integer
    );
  `);
  const s = db.prepare(
    `insert into session (id, title, created_at, updated_at, directory, parent_id, model)
     values (?, ?, ?, ?, ?, ?, ?)`,
  );
  s.run(
    'fixture-oc-session-0001',
    'fixture snake session',
    1767322445000,
    1767326045000,
    '/tmp/potsherd-fx/gamma',
    null,
    'fixture-model-a',
  );
  // A child session: opencode's parent_id marks a subagent transcript.
  s.run(
    'fixture-oc-session-0002',
    'fixture child session',
    1767322500000,
    1767322900000,
    '/tmp/potsherd-fx/gamma',
    'fixture-oc-session-0001',
    'fixture-model-a',
  );

  const m = db.prepare(
    `insert into message (id, session_id, role, content, created_at) values (?, ?, ?, ?, ?)`,
  );
  m.run('m1', 'fixture-oc-session-0001', 'user', parts({ type: 'text', text: 'fixture prompt one' }), 1767322445000);
  m.run(
    'm2',
    'fixture-oc-session-0001',
    'assistant',
    parts(
      { type: 'text', text: 'fixture reply one.' },
      {
        type: 'tool',
        tool: 'read',
        state: {
          status: 'completed',
          input: { filePath: '/tmp/potsherd-fx/gamma/src/thing.ts' },
          output: 'fixture file body',
        },
      },
      { type: 'reasoning', text: 'fixture reasoning part' },
    ),
    1767322450000,
  );
  m.run(
    'm3',
    'fixture-oc-session-0001',
    'assistant',
    parts({
      type: 'tool',
      tool: 'bash',
      state: { status: 'error', input: { command: 'fixture-command' }, output: 'fixture failure' },
    }),
    1767322460000,
  );
  m.run('m4', 'fixture-oc-session-0001', 'user', parts({ type: 'text', text: 'fixture prompt two' }), 1767322470000);
  m.run('m5', 'fixture-oc-session-0001', 'assistant', parts({ type: 'text', text: 'fixture reply two.' }), 1767322480000);
  // A role this adapter does not classify — counted, text kept.
  m.run('m6', 'fixture-oc-session-0001', 'fixture-unknown-role', parts({ type: 'text', text: 'fixture odd role' }), 1767322490000);
  // Looks like JSON, is not: counted as malformed, kept as prose.
  m.run('m7', 'fixture-oc-session-0001', 'assistant', '{ "type": "text", "text": "fixture truncat', 1767322495000);

  m.run('c1', 'fixture-oc-session-0002', 'user', parts({ type: 'text', text: 'fixture child prompt' }), 1767322500000);
  m.run('c2', 'fixture-oc-session-0002', 'assistant', parts({ type: 'text', text: 'fixture child reply.' }), 1767322510000);
  db.close();
}

/** `camel.db` — different table names, camelCase columns, ISO times, prose. */
function buildCamel(file) {
  const db = new Database(file);
  db.exec(`
    create table sessions (
      sessionID text primary key,
      name text,
      createdAt text,
      updatedAt text,
      cwd text
    );
    create table messages (
      messageID text primary key,
      sessionID text,
      kind text,
      body text,
      timestamp text
    );
  `);
  db.prepare(
    `insert into sessions (sessionID, name, createdAt, updatedAt, cwd) values (?, ?, ?, ?, ?)`,
  ).run(
    'fixture-oc-camel-0001',
    'fixture camel session',
    '2026-01-02T03:04:05.000Z',
    '2026-01-02T03:14:05.000Z',
    '/tmp/potsherd-fx/delta',
  );
  const m = db.prepare(
    `insert into messages (messageID, sessionID, kind, body, timestamp) values (?, ?, ?, ?, ?)`,
  );
  m.run('x1', 'fixture-oc-camel-0001', 'user', 'fixture camel prompt', '2026-01-02T03:04:05.000Z');
  m.run('x2', 'fixture-oc-camel-0001', 'assistant', 'fixture camel reply.', '2026-01-02T03:05:05.000Z');
  db.close();
}

/** `alien.db` — nothing this adapter can read. Must degrade, never throw. */
function buildAlien(file) {
  const db = new Database(file);
  db.exec(`create table unrelated_table (a text, b text);`);
  db.prepare(`insert into unrelated_table (a, b) values (?, ?)`).run('fixture', 'row');
  db.close();
}

/**
 * Materialise the three stores under `dir/` and return their paths.
 * `dir` must be a directory the caller owns — never a harness directory.
 */
export function makeOpencodeFixtures(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const snake = path.join(dir, 'snake.db');
  const camel = path.join(dir, 'camel.db');
  const alien = path.join(dir, 'alien.db');
  for (const f of [snake, camel, alien]) fs.rmSync(f, { force: true });
  buildSnake(snake);
  buildCamel(camel);
  buildAlien(alien);
  return { dir, snake, camel, alien };
}

export default makeOpencodeFixtures;

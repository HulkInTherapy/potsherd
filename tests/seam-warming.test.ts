import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { db as store, embeddings, vecStatus, type AskReaderOutput } from '@potsherd/core';
import { replayReaders, writeReadersFile } from '../packages/cli/src/commands/ask.js';
import { rmrf, tempDir } from './helpers.js';

/**
 * The zero-model round trip survives an index that is still warming — FIX-B D4.
 *
 * The verifier ran `--readers-out` and `--readers-in` **seconds apart** and was
 * refused on three of four attempts with *"recorded shortlist does not match
 * the shortlist this question produces now"*. Nothing was stale. The shortlist
 * had simply got better between the two halves, because vectors were still
 * landing — 564 of 4,699 in twenty-six minutes, about 3.6 hours to finish — and
 * the ranking a question produces is a function of how much of the index has
 * been embedded. `--no-vec` on both halves is a workaround, and nothing told
 * anyone that.
 *
 * The freshness check is right and is not deleted: answering from a file whose
 * sessions have moved would print a live run's counts over recorded content.
 * What changed is *what is compared*. The recorded shortlist is now **pinned**
 * — pass two reads exactly the sessions the recording was made from, and the
 * counts printed are the recording's — so the only thing that can still refuse
 * is a recorded session the index can no longer read, which is the staleness
 * the check was always about.
 *
 * These tests move the shortlist by indexing a session that outranks a
 * recorded one, rather than by embedding: a real vector pass needs the 48 MB
 * wasm runtime and a network fetch, and a test that needs those is a test that
 * does not run. The effect on the shortlist is the same one warming produces —
 * membership of the top k changes while every recorded session stays readable
 * — and the vector state itself is asserted where it belongs, on the file.
 */

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) rmrf(r);
});

const QUESTION = 'how did we handle pgbouncer with prepared statements?';
const QUOTE =
  'pgbouncer in transaction mode cannot carry prepared statements, so we set ' +
  'statement_cache_size=0 on the client rather than moving the pooler to session mode.';

/** Invented ids: at most three distinct hex digits in the first eight. */
const S1 = 'a1a1a1a1-0000-4000-8000-000000000001';
const S2 = 'b2b2b2b2-0000-4000-8000-000000000002';
const S3 = 'c3c3c3c3-0000-4000-8000-000000000003';
const LATE = 'd4d4d4d4-0000-4000-8000-000000000004';

function seed(): { root: string; db: ReturnType<typeof store.open> } {
  const root = tempDir('potsherd-seam-');
  roots.push(root);
  const db = store.open({ root });
  add(db, S1, 'the pooler', 'the pooler is 500ing on deploy', QUOTE);
  add(db, S2, 'prepared statements', 'why do prepared statements break', QUOTE);
  add(db, S3, 'pgbouncer notes', 'pgbouncer sizing', QUOTE);
  publish(db);
  return { root, db };
}

function add(
  db: ReturnType<typeof store.open>,
  id: string,
  title: string,
  user: string,
  assistant: string,
): void {
  db.prepare(
    `INSERT INTO sessions (id, harness, title, project, project_slug, source_path, status,
        is_sidechain, started_at, ended_at, user_prompts, assistant_turns, bytes, indexed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, 'claude', title, '/tmp/Ledger', '-tmp-Ledger', `/tmp/${id.slice(0, 8)}.jsonl`, 'live', 0,
    '2026-08-04T09:00:00.000Z', '2026-08-04T10:00:00.000Z', 2, 2, 100, '2026-08-05T00:00:00.000Z');
  const ins = db.prepare(
    `INSERT INTO exchanges (id, session_id, seq, ts, user_text, assistant_text, files_touched)
     VALUES (?,?,?,?,?,?,?)`,
  );
  ins.run(`${id.slice(0, 8)}-11`, id, 11, '2026-08-04T09:00:00.000Z', 'earlier context about deploys', '', '[]');
  ins.run(`${id.slice(0, 8)}-12`, id, 12, '2026-08-04T09:05:00.000Z', user, assistant, '[]');
}

/** `exchanges_fts` is external-content: unpublished rows shortlist nothing. */
function publish(db: ReturnType<typeof store.open>): void {
  db.exec("INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild')");
}

function outFile(root: string): string {
  return path.join(root, 'readers.json');
}

/** Record, then write `outputs` back into the file, as a skill would. */
async function record(
  db: ReturnType<typeof store.open>,
  root: string,
  k: number,
): Promise<{ target: string; ids: string[] }> {
  const target = outFile(root);
  const { file } = await writeReadersFile(db, QUESTION, { root, k }, target);
  const first = file.sessionIds[0]!;
  const outputs: (AskReaderOutput & { sessionId: string })[] = file.sessionIds.map((id) => ({
    sessionId: id,
    found: id === first,
    quotes: id === first ? [{ seq: 12, ts: '2026-08-04T09:05:00.000Z', text: QUOTE }] : [],
    answer_fragment: id === first ? 'they set the client cache to zero.' : '',
  }));
  const raw = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(target, JSON.stringify({ ...raw, outputs }, null, 2), 'utf8');
  return { target, ids: file.sessionIds };
}

/** A synthesizer that is a function, so the whole round trip costs zero calls. */
function synth(sessionId: string) {
  return async (): Promise<unknown> =>
    ({
      evidence: [{ n: 1, session_id: sessionId, seq: 12, quote: QUOTE }],
      answer: [
        { text: 'The client cache was set to zero rather than changing the pooler mode.', cites: [1] },
      ],
    });
}

describe('the seam survives a shortlist that moved', () => {
  it('answers over the recorded shortlist when a newly indexed session outranks one', async () => {
    const { root, db } = seed();
    const { target, ids } = await record(db, root, 2);
    expect(ids).toHaveLength(2);

    // Between the halves the ranking changes — exactly what warming vectors do
    // to it, and here done with a session whose text is a better answer.
    add(db, LATE, 'the definitive pgbouncer answer',
      'pgbouncer prepared statements pgbouncer prepared statements',
      'pgbouncer prepared statements: the answer, prepared statements, pgbouncer.');
    publish(db);

    const r = await replayReaders(db, QUESTION, { root, k: 2, synthFn: synth(ids[0]!), openThreads: false }, target);

    // It answered, from the file, without a model.
    expect(r.spend.calls).toBe(0);
    expect(r.answer).not.toBe('');
    // And it read the shortlist that was recorded, not the one that exists now:
    // the session indexed in between is nowhere in the answer.
    expect(r.readers.map((x) => x.sessionId).sort()).toEqual([...ids].sort());
    expect(r.readers.some((x) => x.sessionId === LATE)).toBe(false);
    // `matching` is the recording's too — three candidate sessions when the
    // shortlist was built, not the four a live run would count now. That is
    // the thing the refusal existed to prevent: a live run's arithmetic
    // printed over another run's content.
    expect(r.matching).toBe(3);
    db.close();
  });

  it('still refuses when a recorded session is no longer in the index', async () => {
    const { root, db } = seed();
    const { target, ids } = await record(db, root, 2);
    // Genuine staleness: the transcript the recording quotes is gone, so the
    // quote check would run against bytes that are not there.
    db.prepare('DELETE FROM exchanges WHERE session_id = ?').run(ids[0]);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(ids[0]);
    publish(db);
    await expect(
      replayReaders(db, QUESTION, { root, k: 2, synthFn: synth(ids[0]!), openThreads: false }, target),
    ).rejects.toThrow(/no longer/);
    db.close();
  });

  it('still refuses a file recorded against a different question', async () => {
    const { root, db } = seed();
    const { target } = await record(db, root, 2);
    await expect(
      replayReaders(db, 'what did we decide about the queue?', { root, k: 2 }, target),
    ).rejects.toThrow(/recorded against a different question/);
    db.close();
  });
});

describe('the recording says what the index looked like', () => {
  it('carries the vector state and the matching count, so a replay can compare like with like', async () => {
    const { root, db } = seed();
    const target = outFile(root);
    const { file } = await writeReadersFile(db, QUESTION, { root, k: 2 }, target);
    const truth = vecStatus(db, root).report!;
    expect(file.index).toBeTruthy();
    expect(file.index!.vectorsEmbedded).toBe(truth.embedded);
    expect(file.index!.vectorsTotal).toBe(truth.total);
    expect(file.index!.matching).toBeGreaterThan(0);
    db.close();
  });

  it('tells the reader which flag makes the two halves identical, and that it is not needed', async () => {
    const { root, db } = seed();
    const target = outFile(root);
    const { file } = await writeReadersFile(db, QUESTION, { root, k: 2 }, target);
    // Nothing here should ever send a user to `--no-vec` as a workaround: the
    // recorded shortlist is pinned, so the two halves agree by construction.
    expect(JSON.stringify(file)).not.toContain('--no-vec');
    db.close();
  });

  it('reports the vector state moving between the halves, rather than refusing over it', async () => {
    const { root, db } = seed();
    const { target, ids } = await record(db, root, 2);
    // Warming, simulated at the only place a test can: the stamp the count is
    // read from. No embedding runtime, no network, same arithmetic.
    db.prepare('UPDATE exchanges SET embedding_version = ? WHERE seq = 12').run(
      embeddings.EMBEDDING_VERSION,
    );
    const notes: string[] = [];
    await replayReaders(
      db,
      QUESTION,
      { root, k: 2, synthFn: synth(ids[0]!), openThreads: false },
      target,
      (line) => notes.push(line),
    );
    expect(notes.join('\n')).toMatch(/shortlist/);
    expect(notes.join('\n')).toMatch(/0 of \d+ embedded then/);
    db.close();
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  discover,
  parse,
  piAdapter,
  sourceDir,
  sessionIdFromFilename,
  unslugifyPi,
  doctorLine,
  exchangeId,
} from '../../packages/core/src/adapters/pi.js';
import { isAdapter, type Exchange } from '@potsherd/core';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PI = path.join(here, '..', 'fixtures', 'pi');

const S_LINEAR = '019e2100-0000-7000-8000-00000000a001';
const S_BRANCHED = '019e2100-0000-7000-8000-00000000b002';
const S_ODD = '019e2100-0000-7000-8000-00000000c003';

function source(id: string) {
  const found = discover(FIXTURE_PI).find((s) => s.sessionId === id);
  if (!found) throw new Error(`fixture session ${id} not discovered`);
  return found;
}

const mainline = (xs: Exchange[]) => xs.filter((x) => !x.isSidechain);
const sidechain = (xs: Exchange[]) => xs.filter((x) => x.isSidechain);

describe('pi adapter — discovery', () => {
  it('finds every transcript under <pi>/agent/sessions/<slug>/', () => {
    const found = discover(FIXTURE_PI);
    expect(found.map((s) => s.sessionId).sort()).toEqual([S_LINEAR, S_BRANCHED, S_ODD].sort());
    for (const s of found) {
      expect(s.harness).toBe('pi');
      expect(s.isSidechain).toBe(false);
      expect(s.status).toBe('live');
      expect(path.isAbsolute(s.path)).toBe(true);
      expect(s.bytes).toBeGreaterThan(0);
      expect(s.mtimeMs).toBeGreaterThan(0);
    }
  });

  it('reads the project slug off the directory, not the filename', () => {
    expect(source(S_LINEAR).projectSlug).toBe('--tmp-potsherd-alpha--');
  });

  it('ignores an empty slug directory — pi mkdirs one before writing anything', () => {
    const empty = path.join(sourceDir(FIXTURE_PI), '--tmp-potsherd-empty--');
    expect(fs.existsSync(empty)).toBe(true);
    expect(discover(FIXTURE_PI).some((s) => s.projectSlug === '--tmp-potsherd-empty--')).toBe(false);
  });

  it('returns nothing, and does not throw, when pi is not installed', () => {
    expect(discover(path.join(os.tmpdir(), 'potsherd-no-such-pi-dir'))).toEqual([]);
  });

  it('takes the session id after the LAST underscore — the prefix is not ISO-8601', () => {
    // `2026-05-13T08-09-45-791Z` — `:` and `.` are replaced with `-`, so the
    // prefix must never be split on `T` or fed to `new Date()`.
    expect(sessionIdFromFilename('2026-05-13T08-09-45-791Z_01a00001-1000-7000-8000-000000000001.jsonl'))
      .toBe('01a00001-1000-7000-8000-000000000001');
    expect(sessionIdFromFilename('no-underscore.jsonl')).toBe('no-underscore');
  });

  it('inverts the cwd slug only as a fallback, and admits it is lossy', () => {
    expect(unslugifyPi('--Users-dev-src--')).toBe('/Users/dev/src');
    // `/a/b-c` and `/a-b/c` slug identically: this is why `project` comes from
    // the header's cwd whenever there is one.
    expect(unslugifyPi('--a-b-c--')).toBe('/a/b/c');
  });

  it('is a real Adapter, and says where it looks', () => {
    expect(isAdapter(piAdapter)).toBe(true);
    expect(piAdapter.harness).toBe('pi');
    expect(piAdapter.sourceDir().endsWith(path.join('.pi', 'agent', 'sessions'))).toBe(true);
    expect(doctorLine(FIXTURE_PI)).toMatch(/^pi\s+ready\s+\S+agent\/sessions\s+3 sessions$/);
    expect(doctorLine(path.join(os.tmpdir(), 'potsherd-no-such-pi-dir'))).toMatch(/absent\s+.*pi not installed$/);
  });
});

describe('pi adapter — the session record', () => {
  it('takes id, project and startedAt from the header, and titles nothing', async () => {
    const { session } = await parse(source(S_LINEAR));

    expect(session.id).toBe(S_LINEAR);
    expect(session.harness).toBe('pi');
    // The header's `cwd` is the only place the project is recorded.
    expect(session.project).toBe('/tmp/potsherd-alpha');
    expect(session.projectSlug).toBe('--tmp-potsherd-alpha--');
    expect(session.startedAt).toBe('2026-08-01T10:00:00.000Z');
    expect(session.endedAt).toBe('2026-08-01T10:00:58.000Z');
    expect(session.entrypoint).toBe('cli');
    expect(session.isSidechain).toBe(false);
    expect(session.status).toBe('live');

    // pi does not title sessions and this adapter does not invent one — `ls`
    // falls back to `<slug>-<id8>`, as it does for claude sdk sessions.
    expect(session.title).toBeUndefined();
    // pi never persists the git branch; it exists only in the live TUI footer.
    expect(session.gitBranch).toBeUndefined();
  });

  it('uses the only name pi ever stores: session_info.name', async () => {
    const { session } = await parse(source(S_ODD));
    expect(session.title).toBe('config watcher');
  });

  it('counts prompts, turns and tool calls', async () => {
    const { session } = await parse(source(S_LINEAR));
    expect(session.counts).toEqual({
      userPrompts: 2,
      assistantTurns: 4,
      toolCalls: 3,
      bytes: source(S_LINEAR).bytes,
    });
  });

  it('resolves the model last-wins along the mainline', async () => {
    const linear = await parse(source(S_LINEAR));
    expect(linear.session.model).toBe('claude-sonnet-4-6');
    // odd.jsonl switches model mid-session; the later model_change wins.
    const odd = await parse(source(S_ODD));
    expect(odd.session.model).toBe('claude-opus-4-6');
  });

  it('records a fork: header.parentSession names the file it branched off', async () => {
    const { session } = await parse(source(S_ODD));
    expect(session.parentSessionId).toBe(S_BRANCHED);
    // A pi fork is not a subagent transcript.
    expect(session.isSidechain).toBe(false);
  });
});

describe('pi adapter — exchanges', () => {
  it('opens one exchange per user message and folds the tool traffic in', async () => {
    const { exchanges } = await parse(source(S_LINEAR));
    expect(exchanges).toHaveLength(2);

    const [first, second] = exchanges as [Exchange, Exchange];
    expect(first.seq).toBe(1);
    expect(first.sessionId).toBe(S_LINEAR);
    expect(first.id).toBe(exchangeId(S_LINEAR, 1));
    expect(first.ts).toBe('2026-08-01T10:00:07.000Z');
    expect(first.userText).toBe('what does the retry helper do?');
    // Thinking blocks are not what the assistant said; only `text` blocks are.
    expect(first.assistantText).toContain('Let me read it.');
    expect(first.assistantText).toContain('retries a callback three times');
    expect(first.assistantText).not.toContain('src/retry.ts. Read it');
    expect(first.toolCalls).toEqual([{
      name: 'read',
      input: JSON.stringify({ path: '/tmp/potsherd-alpha/src/retry.ts' }),
      result: 'export function retry(fn, attempts = 3) { /* ... */ }',
    }]);
    expect(first.filesTouched).toEqual(['/tmp/potsherd-alpha/src/retry.ts']);
    expect(first.isSidechain).toBe(false);
    expect(first.redacted).toBe(false);
    // `parentUuid` is the record's own `parentId` — the DAG edge, kept.
    expect(first.parentUuid).toBe('a0000002');

    // A bare-string user content, and two parallel tool calls whose results
    // are two separate records chained one under the other.
    expect(second.userText).toBe('add a delay then');
    expect(second.toolCalls.map((c) => [c.name, c.result])).toEqual([
      ['write', 'wrote 1 file'],
      ['bash', '1 passing'],
    ]);
    expect(second.filesTouched).toEqual(['/tmp/potsherd-alpha/src/retry.ts']);
  });

  it('keeps a failed assistant turn as an exchange with an empty assistant side', async () => {
    const { exchanges, session } = await parse(source(S_ODD));
    const failed = mainline(exchanges).find((x) => x.userText === 'summarise the watcher change');
    expect(failed).toBeDefined();
    expect(failed!.assistantText).toBe('');
    // The turn happened, so it is counted alongside the one that succeeded...
    expect(session.counts.assistantTurns).toBe(2);
    // ...but the harness's error string is not passed off as the model's words.
    expect(failed!.assistantText).not.toContain('headers');
  });

  it('keeps an orphan toolResult rather than dropping the output', async () => {
    const { exchanges } = await parse(source(S_ODD));
    const last = mainline(exchanges).at(-1)!;
    expect(last.toolCalls).toContainEqual({ name: 'read', input: '', result: 'config.json' });
  });

  it('gives an exchange a stable id across re-parses', async () => {
    const a = await parse(source(S_LINEAR));
    const b = await parse(source(S_LINEAR));
    expect(a.exchanges.map((x) => x.id)).toEqual(b.exchanges.map((x) => x.id));
  });
});

describe('pi adapter — linearising a branched session', () => {
  /**
   * branched.jsonl: `b0000006` has two children. `c0000001..c0000003` is the
   * abandoned branch and comes FIRST in the file; `d0000001..d0000004` is the
   * mainline and comes LAST. The abandoned branch's tail carries a LATER
   * timestamp (11:02:41) than the mainline's tail (11:01:20), so the two
   * candidate rules disagree — which is the only way to pin which one is
   * implemented.
   */
  it('follows the last record in FILE order, not the newest timestamp', async () => {
    const { exchanges } = await parse(source(S_BRANCHED));
    const main = mainline(exchanges);

    // Both rules agree on the shared prefix.
    expect(main[0]!.userText).toBe('where is the config loaded?');

    // File order gives the watcher branch. A newest-timestamp leaf would have
    // given the SIGHUP branch and silently dropped everything after it.
    expect(main.map((x) => x.userText)).toEqual([
      'where is the config loaded?',
      'make it watch the file instead',
    ]);
    expect(main.at(-1)!.assistantText).toContain('config.json is now watched');
    expect(main.at(-1)!.toolCalls[0]!.input).toContain('/tmp/potsherd-alpha/src/watch.ts');
    expect(main.map((x) => x.assistantText).join(' ')).not.toContain('SIGHUP');
  });

  it('proves the timestamp rule would have dropped the tail', async () => {
    // Read the fixture directly and apply the rule the scout warned against.
    const lines = fs.readFileSync(source(S_BRANCHED).path, 'utf8').trim().split('\n');
    const recs = lines.map((l) => JSON.parse(l) as Record<string, unknown>).slice(1);
    const byTimestamp = [...recs].sort((a, b) =>
      String(a.timestamp) < String(b.timestamp) ? -1 : String(a.timestamp) > String(b.timestamp) ? 1 : 0,
    );
    expect(byTimestamp.at(-1)!.id).toBe('c0000003');   // the ABANDONED tip
    expect(recs.at(-1)!.id).toBe('d0000004');          // the real leaf, in file order
    // The two rules genuinely disagree on this file, so the assertion above is
    // not passing by accident.
    expect(byTimestamp.at(-1)!.id).not.toBe(recs.at(-1)!.id);
  });

  it('keeps the abandoned branch as sidechain exchanges of the SAME session', async () => {
    const { exchanges, session } = await parse(source(S_BRANCHED));
    const side = sidechain(exchanges);

    expect(side).toHaveLength(1);
    const abandoned = side[0]!;
    expect(abandoned.sessionId).toBe(session.id);   // same session, not a new one
    expect(abandoned.userText).toBe('make it reload on SIGHUP');
    expect(abandoned.assistantText).toContain('SIGHUP handler');
    expect(abandoned.toolCalls.map((c) => c.name)).toEqual(['write']);
    expect(abandoned.filesTouched).toEqual(['/tmp/potsherd-alpha/src/sighup.ts']);
    // The branch point is recoverable: the record's own parentId is the
    // mainline record both branches hang off.
    expect(abandoned.parentUuid).toBe('b0000006');
    // Sidechain seqs continue after the mainline's; no seq is used twice.
    expect(exchanges.map((x) => x.seq)).toEqual([1, 2, 3]);
    expect(new Set(exchanges.map((x) => x.id)).size).toBe(3);
  });

  it('loses no record: every message on either branch reaches an exchange', async () => {
    const { exchanges } = await parse(source(S_BRANCHED));
    const said = exchanges.map((x) => `${x.userText}\n${x.assistantText}`).join('\n');
    for (const phrase of [
      'where is the config loaded?',
      'In src/config.ts',
      'make it reload on SIGHUP',      // abandoned branch, still here
      'SIGHUP handler',
      'make it watch the file instead',
      'config.json is now watched',
    ]) {
      expect(said).toContain(phrase);
    }
    // 3 tool calls in the file, all present across mainline + sidechain.
    expect(exchanges.flatMap((x) => x.toolCalls)).toHaveLength(3);
  });

  it('counts branch traffic in the session totals', async () => {
    const { session } = await parse(source(S_BRANCHED));
    expect(session.counts.userPrompts).toBe(3);      // 1 shared + 1 abandoned + 1 mainline
    expect(session.counts.assistantTurns).toBe(5);   // 2 shared + 1 abandoned + 2 mainline
    expect(session.counts.toolCalls).toBe(3);
  });
});

describe('pi adapter — nothing is fatal', () => {
  it('counts unknown record types and unknown message roles, and keeps going', async () => {
    const { unknownTypes, exchanges } = await parse(source(S_ODD));
    expect(unknownTypes).toEqual({
      a_type_pi_has_never_written: 1,
      'message:bashExecution': 1,
    });
    // The record types pi declares but this machine has never produced —
    // compaction, branch_summary, label, custom_message, session_info — are
    // recognised, not reported as unknown.
    expect(Object.keys(unknownTypes)).not.toContain('branch_summary');
    expect(Object.keys(unknownTypes)).not.toContain('custom_message');
    // Parsing continued past all of them.
    expect(exchanges.length).toBeGreaterThan(0);
  });

  it('keeps an unknown record in the DAG so nothing below it is orphaned', async () => {
    // `e000000c` hangs off `e000000b` (an unhandled bashExecution) which hangs
    // off `e000000a` (a type that does not exist). If either had been dropped
    // from the index the walk from the leaf would have stopped there and this
    // exchange would have vanished.
    const { exchanges } = await parse(source(S_ODD));
    expect(exchanges.map((x) => x.userText)).toContain('try again');
  });

  it('counts a malformed line without dying', async () => {
    const { malformedLines } = await parse(source(S_ODD));
    expect(malformedLines).toBe(1);
  });

  it('leaves a half-written trailing line for the next run', async () => {
    const src = source(S_ODD);
    const { endOffset } = await parse(src);
    const tail = fs.readFileSync(src.path).subarray(endOffset).toString('utf8');
    // The unterminated record is still on disk, unconsumed, and is not
    // counted as malformed.
    expect(tail).toBe('{"type":"message","id":"e0000010","paren');
    expect(endOffset).toBeLessThan(src.bytes);
    expect(endOffset).toBe(src.bytes - tail.length);
  });

  it('survives a file that is nothing but a header', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potsherd-pi-'));
    const nested = path.join(dir, 'agent', 'sessions', '--tmp-x--');
    fs.mkdirSync(nested, { recursive: true });
    const id = '019e2100-0000-7000-8000-00000000d004';
    fs.writeFileSync(
      path.join(nested, `2026-08-01T13-00-00-000Z_${id}.jsonl`),
      JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-08-01T13:00:00.000Z', cwd: '/tmp/x' }) + '\n',
    );
    const found = discover(dir);
    expect(found).toHaveLength(1);
    const { session, exchanges } = await parse(found[0]!);
    expect(exchanges).toEqual([]);
    expect(session.id).toBe(id);
    expect(session.startedAt).toBe('2026-08-01T13:00:00.000Z');
    expect(session.endedAt).toBe('2026-08-01T13:00:00.000Z');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never treats the header as a DAG node', async () => {
    // pi's `_buildIndex()` skips `type:"session"`, so the header id is never a
    // `parentId` and the root is the first record with `parentId: null`. If the
    // header leaked into the index the mainline walk would end one record early.
    const { exchanges } = await parse(source(S_LINEAR));
    expect(exchanges).toHaveLength(2);
    expect(exchanges.some((x) => x.parentUuid === S_LINEAR)).toBe(false);
  });
});

describe('pi adapter — the real corpus', () => {
  const realPi = path.join(os.homedir(), '.pi');
  const present = fs.existsSync(path.join(realPi, 'agent', 'sessions'));

  // Read-only, and skipped where pi is not installed (CI). The count is not
  // asserted — it is whatever this machine has — but the shape is.
  it.skipIf(!present)('discovers and parses every real session under ~/.pi', async () => {
    const found = discover(realPi);
    expect(found.length).toBeGreaterThan(0);
    for (const src of found) {
      expect(src.harness).toBe('pi');
      const { session, exchanges, unknownTypes } = await parse(src);
      expect(session.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(session.sourcePath).toBe(src.path);
      expect(path.isAbsolute(session.project)).toBe(true);
      expect(session.startedAt).not.toBe('');
      expect(session.endedAt >= session.startedAt).toBe(true);
      expect(Object.keys(unknownTypes)).toEqual([]);
      for (const x of exchanges) {
        expect(x.sessionId).toBe(session.id);
        expect(x.seq).toBeGreaterThan(0);
      }
    }
  });
});

describe('pi fixtures contain nothing real', () => {
  const files = discover(FIXTURE_PI).map((s) => s.path);

  it('has no real path, prompt, token or home directory in it', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const body = fs.readFileSync(file, 'utf8');
      // Every path in the fixture is under /tmp/potsherd-alpha or /tmp/pi.
      for (const p of body.match(/\/(?:Users|home|root)\/[A-Za-z0-9._-]+/g) ?? []) {
        throw new Error(`fixture ${path.basename(file)} names a home directory: ${p}`);
      }
      expect(body).not.toContain(os.homedir());
      // No secret-shaped strings.
      expect(body).not.toMatch(/sk-[A-Za-z0-9]{16}/);
      expect(body).not.toMatch(/tvly-[A-Za-z0-9-]{8}/);
      expect(body).not.toMatch(/gh[pousr]_[A-Za-z0-9]{16}/);
      expect(body).not.toMatch(/AKIA[0-9A-Z]{12}/);
      expect(body).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
      expect(body).not.toMatch(/\b(?:api[_-]?key|secret|token|password)\b\s*[=:]\s*["']?[A-Za-z0-9]{12}/i);
    }
  });
});

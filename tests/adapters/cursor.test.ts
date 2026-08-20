import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  CURSOR_DOCTOR_NOTE,
  classifyProjectSlug,
  cursorAdapter,
  cursorDir,
  cursorSlug,
  discover,
  filesFromCursorInput,
  parse,
  parseCursorTimestamp,
  readPrompt,
  recoverCwd,
  toolName,
} from '../../packages/core/src/adapters/cursor.js';
import { isAdapter } from '@potsherd/core';
import { rmrf, tempDir } from '../helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, '..', 'fixtures', 'cursor');
const P = path.join(FIXTURE, 'projects');

const MAIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UNDERSCORE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const MAIN_FILE = path.join(P, 'Users-example-demo-app', 'agent-transcripts', MAIN, `${MAIN}.jsonl`);
const SUB_FILE = path.join(P, 'Users-example-demo-app', 'agent-transcripts', MAIN, 'subagents', `${SUB}.jsonl`);
const UND_FILE = path.join(P, 'Users-example-notes-scratch', 'agent-transcripts', UNDERSCORE, `${UNDERSCORE}.jsonl`);

/**
 * Cursor is the one harness whose session times come off the filesystem, and
 * **git does not preserve mtimes** — on a fresh clone every fixture carries the
 * checkout time. Any test that reads a date therefore stamps it first.
 */
const MTIMES: Record<string, string> = {
  [MAIN_FILE]: '2026-05-06T11:28:11.000Z',
  [SUB_FILE]: '2026-05-04T00:43:00.000Z',
  [UND_FILE]: '2026-05-08T07:35:48.000Z',
};

beforeAll(() => {
  for (const [file, when] of Object.entries(MTIMES)) {
    const d = new Date(when);
    fs.utimesSync(file, d, d);
  }
});

const bySlug = (slug: string, sidechain = false) =>
  discover(FIXTURE).find((s) => s.projectSlug === slug && s.isSidechain === sidechain)!;

describe('cursor discover()', () => {
  it('finds every transcript and no non-transcript', () => {
    const found = discover(FIXTURE);
    expect(found.map((s) => s.sessionId)).toEqual([MAIN, SUB, UNDERSCORE]);
    // `notes.txt` sits beside the main transcript; `.gitkeep` inside a session
    // directory Cursor pruned; neither is a session.
    expect(found.every((s) => s.path.endsWith('.jsonl'))).toBe(true);
  });

  it('does not crash on the three project-directory shapes that are not paths', () => {
    // A ms-epoch window id, `empty-window`, a temp workspace and a session
    // directory whose transcript Cursor already deleted all live in the
    // fixture. Discovery walks past all four.
    const names = fs.readdirSync(P);
    expect(names).toContain('1769000000000');
    expect(names).toContain('empty-window');
    expect(names.some((n) => n.startsWith('var-folders-'))).toBe(true);
    expect(names).toContain('Users-example-pruned-app');
    expect(() => discover(FIXTURE)).not.toThrow();
    expect(discover(FIXTURE)).toHaveLength(3);
  });

  it('ignores the zero-byte cleanup marker Cursor drops in projects/', () => {
    // `.agent-data-cleanup-<date>` is Cursor's own evidence that it prunes this
    // tree — the disease potsherd exists to treat, on a second harness.
    expect(fs.existsSync(path.join(P, '.agent-data-cleanup-2026-08-20'))).toBe(true);
    expect(discover(FIXTURE).some((s) => s.path.includes('.agent-data-cleanup'))).toBe(false);
  });

  it('marks subagents/ transcripts as sidechains and names the parent', () => {
    const sub = discover(FIXTURE).find((s) => s.sessionId === SUB)!;
    expect(sub.isSidechain).toBe(true);
    expect(sub.parentSessionId).toBe(MAIN);
    const main = discover(FIXTURE).find((s) => s.sessionId === MAIN)!;
    expect(main.isSidechain).toBe(false);
    expect(main.parentSessionId).toBeUndefined();
  });

  it('carries the fields incremental indexing needs, without a parse', () => {
    const main = discover(FIXTURE).find((s) => s.sessionId === MAIN)!;
    expect(main.harness).toBe('cursor');
    expect(main.status).toBe('live');
    expect(main.bytes).toBe(fs.statSync(MAIN_FILE).size);
    expect(main.mtimeMs).toBeGreaterThan(0);
    expect(main.projectSlug).toBe('Users-example-demo-app');
  });

  it('returns [] rather than throwing when ~/.cursor is not there', () => {
    expect(discover(path.join(tempDirOnce(), 'no-such-cursor'))).toEqual([]);
  });

  it('is stable in order across runs', () => {
    expect(discover(FIXTURE).map((s) => s.path)).toEqual(discover(FIXTURE).map((s) => s.path));
  });
});

describe('cursor parse() — the session record', () => {
  it('fills every field ~/.cursor can support and leaves the rest undefined', async () => {
    const { session } = await parse(bySlug('Users-example-demo-app'));
    expect(session.id).toBe(MAIN);
    expect(session.harness).toBe('cursor');
    expect(session.sourcePath).toBe(MAIN_FILE);
    expect(session.projectSlug).toBe('Users-example-demo-app');
    expect(session.isSidechain).toBe(false);
    expect(session.status).toBe('live');

    // Not knowable from ~/.cursor alone: Cursor keeps all of these in VS
    // Code's workspaceStorage/globalStorage sqlite, which potsherd does not
    // read (plans/04-DECISIONS.md, 2026-08-21). Undefined, never invented.
    expect(session.title).toBeUndefined();
    expect(session.model).toBeUndefined();
    expect(session.gitBranch).toBeUndefined();
    expect(session.entrypoint).toBeUndefined();
    expect(session.agentName).toBeUndefined();
  });

  it('counts prompts, turns and tool calls, and reports the file size', async () => {
    const { session } = await parse(bySlug('Users-example-demo-app'));
    // Three genuine human prompts. The system-injected continuation is not one.
    expect(session.counts.userPrompts).toBe(3);
    expect(session.counts.assistantTurns).toBe(12);
    expect(session.counts.toolCalls).toBe(7);
    expect(session.counts.bytes).toBe(fs.statSync(MAIN_FILE).size);
  });

  it('takes startedAt from the first prompt stamp and endedAt from mtime', async () => {
    const { session } = await parse(bySlug('Users-example-demo-app'));
    // `Monday, May 4, 2026, 12:39 AM (UTC+5:30)`
    expect(session.startedAt).toBe('2026-05-03T19:09:00.000Z');
    // No assistant record carries a time, so the last prompt stamp is not the
    // end of the session. mtime is the moment Cursor last wrote the file.
    expect(session.endedAt).toBe('2026-05-06T11:28:11.000Z');
  });

  it('falls back to mtime for both ends when the file has no timestamp at all', async () => {
    // Subagent transcripts carry no <timestamp> anywhere. mtime is their only
    // time signal, and the adapter says so rather than inventing one.
    const { session } = await parse(bySlug('Users-example-demo-app', true));
    expect(session.startedAt).toBe('2026-05-04T00:43:00.000Z');
    expect(session.endedAt).toBe('2026-05-04T00:43:00.000Z');
    expect(session.isSidechain).toBe(true);
    expect(session.parentSessionId).toBe(MAIN);
  });

  it('recovers the cwd from paths inside the transcript, checked against the slug', async () => {
    const demo = await parse(bySlug('Users-example-demo-app'));
    expect(demo.session.project).toBe('/Users/example/demo-app');
    // The underscore case is the one a slug can never be inverted into:
    // `notes_scratch` and `notes-scratch` slug identically.
    const notes = await parse(bySlug('Users-example-notes-scratch'));
    expect(notes.session.projectSlug).toBe('Users-example-notes-scratch');
    expect(notes.session.project).toBe('/Users/example/notes_scratch');
  });

  it('leaves project empty when nothing in the file corroborates the slug', async () => {
    const dir = tempDirOnce();
    const root = path.join(dir, 'cursor');
    const sessionDir = path.join(root, 'projects', '1769000000001', 'agent-transcripts', MAIN);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, `${MAIN}.jsonl`),
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nhi\n</user_query>' }] } }),
    );
    const [source] = discover(root);
    const { session } = await parse(source!);
    // A ms-epoch window id is a Cursor window with no folder open. There is no
    // cwd to know, so `project` is empty rather than a fabricated path.
    expect(session.projectSlug).toBe('1769000000001');
    expect(session.project).toBe('');
  });
});

describe('cursor parse() — exchanges', () => {
  it('opens one exchange per genuine human prompt, in line order', async () => {
    const { exchanges } = await parse(bySlug('Users-example-demo-app'));
    expect(exchanges).toHaveLength(3);
    expect(exchanges.map((e) => e.seq)).toEqual([1, 2, 3]);
    // Line order is the only ordering signal the format has, so seq is it.
    expect(exchanges[0]!.userText).toContain('add a health check endpoint');
    expect(exchanges[1]!.userText).toBe('match the button colour in the screenshot');
  });

  it('keeps a system-injected continuation inside the exchange it continues', async () => {
    const { exchanges, unknownTypes } = await parse(bySlug('Users-example-demo-app'));
    // "The above subagent result is already visible to the user…" is not a
    // human prompt: it must not open an exchange, and the assistant text that
    // follows it still answers the human turn already open.
    expect(unknownTypes['user:injected-continuation']).toBe(1);
    expect(exchanges[0]!.assistantText).toContain('Endpoint is mounted at /health');
    expect(exchanges[0]!.userText).not.toContain('DO NOT reiterate');
  });

  it('strips cursor wrappers from userText but keeps pasted angle-bracket text', async () => {
    const { exchanges } = await parse(bySlug('Users-example-demo-app'));
    const third = exchanges[2]!;
    // `<module>` and a stray `</user_query>` are inside the query: user content.
    expect(third.userText).toContain('in <module>');
    expect(third.userText).toContain('stray </user_query> in it');
    expect(third.userText.startsWith('this blew up:')).toBe(true);
    // The attachment preamble is structure and does not survive.
    expect(exchanges[1]!.userText).not.toContain('provdied');
    expect(exchanges[1]!.userText).not.toContain('<timestamp>');
  });

  it('never claims a tool result, because cursor persists none', async () => {
    for (const source of discover(FIXTURE)) {
      const { exchanges } = await parse(source);
      for (const e of exchanges) {
        for (const call of e.toolCalls) {
          expect(call.result).toBeUndefined();
          expect(call.isError).toBeUndefined();
        }
      }
    }
  });

  it('never claims a parentUuid, because cursor records carry no ids', async () => {
    const { exchanges } = await parse(bySlug('Users-example-demo-app'));
    expect(exchanges.every((e) => e.parentUuid === undefined)).toBe(true);
    expect(exchanges.every((e) => e.redacted === false)).toBe(true);
  });

  it('gathers batched and string-input tool calls onto the open exchange', async () => {
    const { exchanges } = await parse(bySlug('Users-example-demo-app'));
    const first = exchanges[0]!;
    expect(first.toolCalls.map((t) => t.name)).toEqual([
      'ReadFile', 'Glob', 'ApplyPatch', 'Grep path', 'ReadLints', 'EditNotebook', 'Subagent',
    ]);
    // `tool_use.input` is polymorphic: object for most tools, a raw V4A patch
    // string for every ApplyPatch. Both reach the store as text.
    const patch = first.toolCalls.find((t) => t.name === 'ApplyPatch')!;
    expect(patch.input.startsWith('*** Begin Patch')).toBe(true);
    const read = first.toolCalls.find((t) => t.name === 'ReadFile')!;
    expect(JSON.parse(read.input)).toMatchObject({ path: '/Users/example/demo-app/src/router.ts' });
  });

  it('collects filesTouched from object inputs, array inputs and patch headers', async () => {
    const { exchanges } = await parse(bySlug('Users-example-demo-app'));
    expect(exchanges[0]!.filesTouched).toEqual([
      '/Users/example/demo-app/src/router.ts',   // ReadFile.path, ApplyPatch Update
      '/Users/example/demo-app/src/health.ts',   // ApplyPatch Add + ReadLints.paths[]
      '/Users/example/demo-app/notebooks/Smoke.ipynb', // EditNotebook.target_notebook
    ]);
    // Directory-valued keys are not files: Glob.target_directory is absent.
    expect(exchanges[0]!.filesTouched).not.toContain('/Users/example/demo-app');
  });

  it('marks every exchange of a subagent transcript as a sidechain', async () => {
    const { exchanges } = await parse(bySlug('Users-example-demo-app', true));
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]!.isSidechain).toBe(true);
    // The subagent's "user" record is the parent agent's prompt, verbatim.
    expect(exchanges[0]!.userText).toContain('Thoroughness: very thorough');
  });
});

describe('cursor parse() — the things that break a naive parser', () => {
  it('counts unknown roles and unknown block types without failing', async () => {
    const { unknownTypes } = await parse(bySlug('Users-example-demo-app'));
    expect(unknownTypes['role:system']).toBe(1);
    expect(unknownTypes['role:assistant (no message.content)']).toBe(1);
    expect(unknownTypes['block:reasoning_summary']).toBe(1);
  });

  it('counts a malformed line and keeps reading past it', async () => {
    const { malformedLines, exchanges } = await parse(bySlug('Users-example-demo-app'));
    expect(malformedLines).toBe(1);
    // The prompts after the malformed line still made it through.
    expect(exchanges).toHaveLength(3);
  });

  it('consumes the final line even though cursor writes no trailing newline', async () => {
    // All four real transcripts end without `\n`, so a reader that requires
    // one silently drops the last record of every cursor session.
    expect(fs.readFileSync(MAIN_FILE, 'utf8').endsWith('\n')).toBe(false);
    const { endOffset, exchanges } = await parse(bySlug('Users-example-demo-app'));
    expect(endOffset).toBe(fs.statSync(MAIN_FILE).size);
    expect(exchanges[2]!.assistantText).toContain('import path problem');
  });

  it('leaves a half-written final record for the next run', async () => {
    const dir = tempDirOnce();
    const root = path.join(dir, 'growing');
    const sessionDir = path.join(root, 'projects', 'Users-example-demo-app', 'agent-transcripts', MAIN);
    fs.mkdirSync(sessionDir, { recursive: true });
    const whole = fs.readFileSync(MAIN_FILE);
    const cut = path.join(sessionDir, `${MAIN}.jsonl`);
    // Chop the last record mid-JSON: the file now looks exactly like a session
    // Cursor is still appending to.
    fs.writeFileSync(cut, whole.subarray(0, whole.length - 20));

    const [source] = discover(root);
    const first = await parse(source!);
    expect(first.endOffset).toBeLessThan(fs.statSync(cut).size);
    expect(first.malformedLines).toBe(2); // the seeded bad line, plus the tail

    // Now the record lands whole, and a resume picks up exactly where it left
    // off without re-emitting anything.
    fs.writeFileSync(cut, whole);
    const [grown] = discover(root);
    const second = await parse(grown!, { fromOffset: first.endOffset, fromSeq: first.exchanges.length });
    expect(second.endOffset).toBe(fs.statSync(cut).size);
    expect(second.malformedLines).toBe(0);
    expect(second.exchanges.every((e) => e.seq > first.exchanges.length)).toBe(true);
  });

  it('survives byte-identical duplicate records without losing either', async () => {
    const { exchanges } = await parse(bySlug('Users-example-demo-app'));
    const line = 'Reading the two files you named before I touch anything.';
    const hits = exchanges[0]!.assistantText.split(line).length - 1;
    // Cursor really does write the same record twice. Faithful is better than
    // clever: exchange ids key on (session, seq), never on a content hash.
    expect(hits).toBe(2);
  });

  it('gives every exchange a distinct id', async () => {
    const { exchanges } = await parse(bySlug('Users-example-demo-app'));
    expect(new Set(exchanges.map((e) => e.id)).size).toBe(exchanges.length);
    expect(exchanges.every((e) => e.sessionId === MAIN)).toBe(true);
  });
});

describe('cursor timestamps', () => {
  it('honours the UTC offset cursor writes in the prompt', () => {
    expect(parseCursorTimestamp('Friday, May 8, 2026, 6:05 AM (UTC+5:30)')).toBe('2026-05-08T00:35:00.000Z');
    expect(parseCursorTimestamp('Monday, May 4, 2026, 12:39 AM (UTC+5:30)')).toBe('2026-05-03T19:09:00.000Z');
    expect(parseCursorTimestamp('Wednesday, May 6, 2026, 4:57 PM (UTC+5:30)')).toBe('2026-05-06T11:27:00.000Z');
  });

  it('is independent of the host timezone', () => {
    // `new Date("… (UTC+5:30)")` treats the parenthesised offset as a comment
    // and parses the rest in the *host's* zone, so the same transcript would
    // index five and a half hours apart on a laptop and in CI. Two stamps that
    // differ only by offset must differ by exactly that offset — an assertion
    // no host-zone parse can pass, and one that does not itself depend on TZ.
    const utc = parseCursorTimestamp('Friday, May 8, 2026, 6:05 AM (UTC+0:00)');
    const ist = parseCursorTimestamp('Friday, May 8, 2026, 6:05 AM (UTC+5:30)');
    expect(utc).toBe('2026-05-08T06:05:00.000Z');
    expect(ist).toBe('2026-05-08T00:35:00.000Z');
    expect(Date.parse(utc!) - Date.parse(ist!)).toBe(5.5 * 3_600_000);
  });

  it('handles noon, midnight, negative offsets and a missing offset', () => {
    expect(parseCursorTimestamp('May 1, 2026, 12:00 AM (UTC+0:00)')).toBe('2026-05-01T00:00:00.000Z');
    expect(parseCursorTimestamp('May 1, 2026, 12:00 PM (UTC)')).toBe('2026-05-01T12:00:00.000Z');
    expect(parseCursorTimestamp('May 1, 2026, 9:30 AM (UTC-4:00)')).toBe('2026-05-01T13:30:00.000Z');
    // No offset at all: UTC is the honest default, not the host's zone.
    expect(parseCursorTimestamp('May 1, 2026, 9:30 AM')).toBe('2026-05-01T09:30:00.000Z');
  });

  it('returns undefined rather than an invalid date on an unknown shape', () => {
    expect(parseCursorTimestamp('2026-05-08T06:05:00+05:30')).toBeUndefined();
    expect(parseCursorTimestamp('Smarch 4, 2026, 1:00 AM (UTC+5:30)')).toBeUndefined();
    expect(parseCursorTimestamp('')).toBeUndefined();
  });
});

describe('cursor prompt shapes', () => {
  it('tells a human prompt from a system-injected continuation by the newline', () => {
    const human = readPrompt('<timestamp>May 4, 2026, 12:39 AM (UTC+5:30)</timestamp>\n<user_query>\nfix the build\n</user_query>');
    expect(human.injected).toBe(false);
    expect(human.text).toBe('fix the build');
    expect(human.ts).toBe('2026-05-03T19:09:00.000Z');

    const injected = readPrompt(
      '<timestamp>May 4, 2026, 12:47 AM (UTC+5:30)</timestamp>\n\n<user_query>Briefly inform the user about the task result and perform any follow-up actions (if needed).</user_query>',
    );
    expect(injected.injected).toBe(true);
  });

  it('treats only the region before the first <user_query> as structure', () => {
    const p = readPrompt('<user_query>\nsee <module> in the traceback\n</user_query>');
    expect(p.text).toBe('see <module> in the traceback');
    expect(p.ts).toBeUndefined();
  });

  it('handles a prompt with no wrapper at all', () => {
    const p = readPrompt('<timestamp>May 4, 2026, 1:00 AM (UTC+5:30)</timestamp>\nplain text');
    expect(p.injected).toBe(false);
    expect(p.text).toBe('plain text');
    expect(p.ts).toBe('2026-05-03T19:30:00.000Z');
  });
});

describe('cursor slugs and tool inputs', () => {
  it('slugs `/` and `_` alike, which is why the map cannot be inverted', () => {
    expect(cursorSlug('/Users/example/notes_scratch')).toBe('Users-example-notes-scratch');
    expect(cursorSlug('/Users/example/notes-scratch')).toBe('Users-example-notes-scratch');
    expect(cursorSlug('/Users/example/demo-app')).toBe('Users-example-demo-app');
  });

  it('names the three project-directory shapes', () => {
    expect(classifyProjectSlug('Users-example-demo-app')).toBe('path');
    expect(classifyProjectSlug('1769488977462')).toBe('window-id');
    expect(classifyProjectSlug('empty-window')).toBe('empty-window');
    expect(classifyProjectSlug('var-folders-aa-T-0000')).toBe('path');
  });

  it('accepts a cwd only when the transcript corroborates the slug', () => {
    const slug = 'Users-example-notes-scratch';
    expect(recoverCwd(slug, ['/Users/example/notes_scratch/todo.md'])).toBe('/Users/example/notes_scratch');
    expect(recoverCwd(slug, ['/Users/example', '/etc/hosts'])).toBeUndefined();
    expect(recoverCwd(slug, [])).toBeUndefined();
    // A window id can never have a cwd, whatever paths the file mentions.
    expect(recoverCwd('1769488977462', ['/Users/example/notes_scratch/todo.md'])).toBeUndefined();
  });

  it('drops an argument that leaked into a tool name', () => {
    expect(toolName('Grep path\n/Users/example/demo-app')).toBe('Grep path');
    expect(toolName('Shell')).toBe('Shell');
    expect(toolName(undefined)).toBe('unknown');
    expect(toolName(42)).toBe('unknown');
  });

  it('reads files out of both input shapes and skips directory keys', () => {
    expect(filesFromCursorInput({ path: '/a/b.ts' })).toEqual(['/a/b.ts']);
    expect(filesFromCursorInput({ paths: ['/a/b.ts', '/a/c.ts'] })).toEqual(['/a/b.ts', '/a/c.ts']);
    expect(filesFromCursorInput({ target_notebook: '/a/n.ipynb' })).toEqual(['/a/n.ipynb']);
    expect(filesFromCursorInput({ target_directory: '/a', glob_pattern: '*' })).toEqual([]);
    expect(filesFromCursorInput({ command: 'ls', working_directory: '/a' })).toEqual([]);
    expect(
      filesFromCursorInput('*** Begin Patch\n*** Add File: /a/new.ts\n+x\n*** Update File: /a/old.ts\n*** End Patch'),
    ).toEqual(['/a/new.ts', '/a/old.ts']);
  });
});

describe('cursor adapter surface', () => {
  it('is a real adapter, not a stub, and names its directory', () => {
    expect(isAdapter(cursorAdapter)).toBe(true);
    expect(cursorAdapter.harness).toBe('cursor');
    expect(cursorAdapter.displayName).toBe('Cursor');
    expect(cursorAdapter.sourceDir()).toBe(cursorDir());
    expect(cursorAdapter.sourceDir().endsWith('.cursor')).toBe(true);
  });

  it('states every absence in one doctor line', () => {
    // `03` §2: unknown record types are counted, not fatal, and `doctor`
    // reports coverage. For cursor the honest report is what is missing.
    expect(CURSOR_DOCTOR_NOTE).toMatch(/no timestamps on assistant turns/);
    expect(CURSOR_DOCTOR_NOTE).toMatch(/mtime/);
    expect(CURSOR_DOCTOR_NOTE).toMatch(/no tool results/);
    expect(CURSOR_DOCTOR_NOTE).toMatch(/workspaceStorage/);
  });
});

describe('cursor fixtures', () => {
  it('contain no real path, prompt or secret', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(FIXTURE);
    expect(files.length).toBeGreaterThan(0);
    const banned = [
      /\/Users\/zebra/, /Infant-State-Recognition-System/, /maths_practice/,
      /sk-[A-Za-z0-9]{16,}/, /ghp_[A-Za-z0-9]{16,}/, /AKIA[0-9A-Z]{12,}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    ];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const re of banned) expect(text, `${file} matched ${re}`).not.toMatch(re);
    }
  });
});

// --------------------------------------------------------------------------

let scratch: string | undefined;
function tempDirOnce(): string {
  scratch ??= tempDir('potsherd-cursor-');
  return scratch;
}

describe('cursor test housekeeping', () => {
  it('removes its scratch directory', () => {
    if (scratch) rmrf(scratch);
    expect(scratch === undefined || !fs.existsSync(scratch)).toBe(true);
  });
});

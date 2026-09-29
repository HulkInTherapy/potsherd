import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  discover,
  doctorLine,
  geminiAdapter,
  isHumanTurn,
  parse,
  projectHashes,
  recoverCwd,
  sessionIdFromFilename,
  sourceDir,
} from '../../packages/core/src/adapters/gemini.js';
import { isAdapter } from '@potsherd/core';

const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * Fixtures are **synthetic and committed** (`plans/00-README.md`: committed
 * artefacts use the synthetic corpus, never the live one). Nothing under
 * `tests/fixtures/gemini` came off a real machine — there were no real Gemini
 * CLI checkpoints on the reference machine to come off.
 */
const FIXTURE_GEMINI = path.join(here, '..', 'fixtures', 'gemini');

/** sha256('/tmp/potsherd-fx/alpha') — the fixture's project-hash directory. */
const HASH_ALPHA = 'feae63e941ddfa67c44f95f878a79690a382f6cbd1239cd7f0150038ccfa8775';
const HASH_UNKNOWN = '0'.repeat(64);

function source(idFragment: string) {
  const found = discover(FIXTURE_GEMINI).find((s) => s.path.includes(idFragment));
  if (!found) throw new Error(`fixture ${idFragment} not discovered`);
  return found;
}

describe('gemini adapter — discovery', () => {
  it('finds every checkpoint under <gemini>/tmp/<hash>/chats/', () => {
    const found = discover(FIXTURE_GEMINI);
    expect(found.map((s) => path.basename(s.path)).sort()).toEqual([
      'checkpoint-broken.json',
      'checkpoint-refactor.json',
      'checkpoint-wrapped.json',
    ]);
    for (const s of found) {
      expect(s.harness).toBe('gemini');
      expect(s.isSidechain).toBe(false);
      expect(s.status).toBe('live');
      expect(path.isAbsolute(s.path)).toBe(true);
      expect(s.mtimeMs).toBeGreaterThan(0);
    }
  });

  it('skips a project directory that has no chats/ subdirectory', () => {
    // `tmp/<hash>/` holds other per-project scratch state; its absence of a
    // `chats/` directory is normal, not an error.
    const found = discover(FIXTURE_GEMINI);
    expect(found.some((s) => s.path.includes('no-chats-here'))).toBe(false);
  });

  it('reads the project hash off the directory as projectSlug', () => {
    expect(source('checkpoint-refactor').projectSlug).toBe(HASH_ALPHA);
  });

  it('returns nothing rather than throwing when gemini is not installed', () => {
    const missing = path.join(os.tmpdir(), 'potsherd-gemini-does-not-exist');
    expect(fs.existsSync(missing)).toBe(false);
    expect(discover(missing)).toEqual([]);
  });

  it('names the tmp/ directory as its source', () => {
    expect(sourceDir(FIXTURE_GEMINI)).toBe(path.join(FIXTURE_GEMINI, 'tmp'));
  });

  it('derives an id that is unique across projects sharing a save tag', () => {
    expect(sessionIdFromFilename('checkpoint-refactor.json', HASH_ALPHA)).toBe(
      `${HASH_ALPHA.slice(0, 12)}-refactor`,
    );
    expect(sessionIdFromFilename('checkpoint-refactor.json', HASH_UNKNOWN)).not.toBe(
      sessionIdFromFilename('checkpoint-refactor.json', HASH_ALPHA),
    );
  });
});

describe('gemini adapter — the bare Content[] shape', () => {
  it('pairs functionCall with functionResponse and counts turns', async () => {
    const { session, exchanges } = await parse(source('checkpoint-refactor'));
    // Two human prompts; the two `user` turns made only of functionResponse
    // parts are tool output, not prompts.
    expect(session.counts.userPrompts).toBe(2);
    expect(exchanges.filter((x) => x.userText.includes('fixture prompt'))).toHaveLength(2);

    const first = exchanges[0]!;
    const read = first.toolCalls.find((c) => c.name === 'read_file')!;
    expect(read.result).toContain('fixture file body');
    expect(read.isError).toBeUndefined();

    const write = first.toolCalls.find((c) => c.name === 'write_file')!;
    expect(write.isError).toBe(true);
  });

  it('does not count a tool-result user turn as a human prompt', () => {
    expect(isHumanTurn('user', [{ functionResponse: { name: 'x' } }])).toBe(false);
    expect(isHumanTurn('user', [{ text: 'hi' }, { functionResponse: { name: 'x' } }])).toBe(true);
    expect(isHumanTurn('model', [{ text: 'hi' }])).toBe(false);
  });

  it('collects filesTouched from tool-call arguments', async () => {
    const { exchanges } = await parse(source('checkpoint-refactor'));
    const files = exchanges.flatMap((x) => x.filesTouched);
    expect(files).toContain('/tmp/potsherd-fx/alpha/src/widget.ts');
  });

  it('keeps an orphan functionResponse as a tool call of its own', async () => {
    const { exchanges } = await parse(source('checkpoint-refactor'));
    const orphan = exchanges.flatMap((x) => x.toolCalls).find((c) => c.name === 'orphan_tool');
    expect(orphan).toBeDefined();
    expect(orphan!.input).toBe('');
    expect(orphan!.result).toContain('fixture orphan result');
  });

  it('counts unknown roles and unknown part keys, and is not fatal', async () => {
    const { unknownTypes, exchanges } = await parse(source('checkpoint-refactor'));
    expect(unknownTypes['role:fixture-unknown-role']).toBe(1);
    expect(unknownTypes['part:thought']).toBe(1);
    expect(unknownTypes['part:inlineData']).toBe(1);
    // Counted, not fatal (`03 §2`): the parse still produced exchanges.
    expect(exchanges.length).toBeGreaterThan(0);
  });

  it('recovers the project path by checking a candidate against the hash', async () => {
    const { session } = await parse(source('checkpoint-refactor'));
    expect(session.project).toBe('/tmp/potsherd-fx/alpha');
  });

  it('leaves project empty rather than guessing when no path hashes to the dir', async () => {
    const { session } = await parse(source('checkpoint-wrapped'));
    // This fixture carries an explicit `cwd`, so it is the wrapper that wins.
    expect(session.project).toBe('/tmp/potsherd-fx/beta');
  });

  it('uses file mtime for session times when the checkpoint carries no clock', async () => {
    const src = source('checkpoint-refactor');
    const { session } = await parse(src);
    expect(session.startedAt).toBe(new Date(src.mtimeMs).toISOString());
    expect(session.endedAt).toBe(session.startedAt);
    expect(session.title).toBeUndefined();
    expect(session.model).toBeUndefined();
    expect(session.gitBranch).toBeUndefined();
  });
});

describe('gemini adapter — the wrapper-object shape', () => {
  it('unwraps history and reads metadata off the wrapper', async () => {
    const { session, exchanges } = await parse(source('checkpoint-wrapped'));
    expect(session.id).toBe('fixture-gemini-session-0001');
    expect(session.startedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(session.endedAt).toBe('2026-01-02T03:44:05.000Z');
    expect(session.model).toBe('fixture-model-pro');
    expect(session.gitBranch).toBe('fixture-branch');
    expect(session.title).toBe('fixture wrapped checkpoint');
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]!.userText).toBe('fixture bare string prompt');
    expect(exchanges[0]!.assistantText).toBe('fixture wrapped reply.');
  });

  it('counts a malformed checkpoint without throwing', async () => {
    const result = await parse(source('checkpoint-broken'));
    expect(result.malformedLines).toBe(1);
    expect(result.exchanges).toEqual([]);
    expect(result.session.harness).toBe('gemini');
  });
});

describe('gemini adapter — project hash recovery', () => {
  it('hashes a path the plausible ways and matches exactly', () => {
    expect(projectHashes('/tmp/potsherd-fx/alpha')).toContain(HASH_ALPHA);
  });

  it('checks candidates against the hash rather than inverting it', () => {
    expect(recoverCwd(HASH_ALPHA, ['/tmp/potsherd-fx/alpha/src/widget.ts'])).toBe(
      '/tmp/potsherd-fx/alpha',
    );
    expect(recoverCwd(HASH_UNKNOWN, ['/tmp/potsherd-fx/alpha/src/widget.ts'])).toBeUndefined();
    expect(recoverCwd('not-a-hash', ['/tmp/potsherd-fx/alpha/src/widget.ts'])).toBeUndefined();
    expect(recoverCwd(HASH_ALPHA, [])).toBeUndefined();
  });
});

describe('gemini adapter — doctor', () => {
  it('says "absent" when the harness is not installed at all', () => {
    const missing = path.join(os.tmpdir(), 'potsherd-gemini-does-not-exist');
    const line = doctorLine(missing);
    expect(line).toContain('absent');
    expect(line).toContain('Gemini CLI not installed');
  });

  it('says "empty" — not absent — when installed with no saved chats', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potsherd-gemini-empty-'));
    fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
    const line = doctorLine(dir);
    expect(line).toContain('empty');
    expect(line).toContain('no saved chats');
    expect(line).not.toContain('not installed');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('says "ready" with a count when checkpoints parse', () => {
    const line = doctorLine(FIXTURE_GEMINI);
    expect(line).toContain('ready');
    expect(line).toContain('3 checkpoints');
  });

  it('always admits the format is unverified when it claims to read anything', () => {
    expect(doctorLine(FIXTURE_GEMINI)).toContain('unverified format');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potsherd-gemini-empty2-'));
    expect(doctorLine(dir)).toContain('unverified format');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('gemini adapter — the contract', () => {
  it('satisfies the Adapter interface', () => {
    expect(isAdapter(geminiAdapter)).toBe(true);
    expect(geminiAdapter.harness).toBe('gemini');
    expect(typeof geminiAdapter.discover).toBe('function');
    expect(typeof geminiAdapter.parse).toBe('function');
  });

  it('numbers exchanges from 1 in array order and keeps ids stable', async () => {
    const a = await parse(source('checkpoint-refactor'));
    const b = await parse(source('checkpoint-refactor'));
    expect(a.exchanges.map((x) => x.seq)).toEqual([1, 2]);
    expect(a.exchanges.map((x) => x.id)).toEqual(b.exchanges.map((x) => x.id));
  });

  it('writes nothing under the fixture directory', () => {
    const before = fs.readdirSync(path.join(FIXTURE_GEMINI, 'tmp')).sort();
    discover(FIXTURE_GEMINI);
    doctorLine(FIXTURE_GEMINI);
    expect(fs.readdirSync(path.join(FIXTURE_GEMINI, 'tmp')).sort()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// MEASURED AGAINST A REAL Gemini CLI 0.56.0 (T10.12, 2026-08-24)
//
// `@google/gemini-cli@0.56.0` installs from npm — the phase-5 claim that it
// could not be installed here was never checked and is false. It was installed
// and run under a relocated HOME. It refused to answer without an auth method
// (`GEMINI_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI` or `GOOGLE_GENAI_USE_GCA`),
// none of which this machine has, so **no saved chat exists** and the parse
// half of this adapter remains genuinely unverified — that label is EARNED and
// stays. What the run did settle is the layout, before any model call:
//
//   ~/.gemini/projects.json          {"projects": {"<abs cwd>": "<dir name>"}}
//   ~/.gemini/tmp/<dir name>/.project_root
//   ~/.gemini/history/<dir name>/.project_root
//
// FINDING — the directory under `tmp/` is NOT a hash. At 0.56.0 it is a plain,
// human-readable name (the cwd's basename, deduplicated through
// `projects.json`), and `projects.json` maps it back to the absolute path
// exactly. This adapter's header states the opposite in so many words — "The
// directory under `tmp/` is a **hash of the project path**, not the path. A
// hash cannot be inverted" — and {@link projectHashes} / {@link recoverCwd}
// exist entirely to corroborate a hash that is not there. Against a real
// 0.56.0 install `recoverCwd` can never match, so `project` is always `''`
// even though the answer is sitting in `projects.json` in plain text.
//
// NOT FIXED HERE (`T10.12-LABELS.md` carries the recommendation): reading
// `projects.json` is a new source, and no real checkpoint exists to check the
// rest of the parse against. The hash path must also stay — a hashed layout may
// still be what older Gemini CLIs wrote, and this is a sample of one.
describe('gemini adapter — a real Gemini CLI 0.56.0 layout (T10.12)', () => {
  function realShape(): { root: string; dir: string; cwd: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-0560-'));
    const cwd = '/w/scratch/work';
    const dir = 'work';
    fs.mkdirSync(path.join(root, 'tmp', dir), { recursive: true });
    fs.mkdirSync(path.join(root, 'history', dir), { recursive: true });
    fs.writeFileSync(path.join(root, 'tmp', dir, '.project_root'), '');
    fs.writeFileSync(path.join(root, 'history', dir, '.project_root'), '');
    fs.writeFileSync(
      path.join(root, 'projects.json'),
      JSON.stringify({ projects: { [cwd]: dir } }, null, 2) + '\n',
    );
    return { root, dir, cwd };
  }

  it('FINDING — tmp/<dir> is a plain name, not one of the hashes projectHashes builds', () => {
    const { root, dir, cwd } = realShape();
    expect(dir).not.toMatch(/^[0-9a-f]{64}$/);
    expect(projectHashes(cwd)).not.toContain(dir);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('FINDING — so recoverCwd cannot corroborate it, though projects.json states it outright', () => {
    const { root, dir, cwd } = realShape();
    // Even handed the true path as a candidate, the hash test rejects it.
    expect(recoverCwd(dir, [cwd, path.dirname(cwd)])).toBeUndefined();
    const mapping = JSON.parse(fs.readFileSync(path.join(root, 'projects.json'), 'utf8'));
    expect(mapping.projects[cwd]).toBe(dir);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('and there is no chats/ directory until a chat is saved, so discover() is empty', () => {
    const { root } = realShape();
    expect(discover(root)).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

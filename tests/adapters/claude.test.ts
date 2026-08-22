import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  claudeAdapter,
  discover,
  isNovelRecordType,
  parse,
  recordTypeStats,
  sourceDir,
  type ClaudeParseResult,
  type ClaudeSessionSource,
} from '../../packages/core/src/adapters/claude.js';
import { FIXTURE_CLAUDE, IDS, rmrf, tempDir } from '../helpers.js';

/**
 * The claude adapter (T1.2).
 *
 * Two corpora are used, on purpose. `tests/fixtures/claude/` is synthetic,
 * committed and tiny — it is what CI runs, and it proves the behaviour without
 * anybody's private transcripts. The real corpus block underneath runs only
 * where one exists and is **read-only**: it is the only thing that can catch a
 * record shape nobody thought to invent for the fixture.
 *
 * Every test that reads a directory passes it explicitly. `tests/setup.ts`
 * points `CLAUDE_CONFIG_DIR` at an empty sandbox precisely so a forgotten
 * argument reads nothing rather than the developer's own history.
 */

const ALIVE_REL = path.join('-tmp-potsherd-alpha', `${IDS.alive}.jsonl`);
const SDK_REL = path.join('-tmp-potsherd-beta', `${IDS.sdk}.jsonl`);
const NESTED_SIDECHAIN_REL = path.join('-tmp-potsherd-alpha', IDS.alive, 'subagents', 'agent-01.jsonl');
const FLAT_SIDECHAIN_REL = path.join('-tmp-potsherd-beta', 'subagents', 'agent-02.jsonl');

function fixtureSources(): ClaudeSessionSource[] {
  return discover({ claudeDir: FIXTURE_CLAUDE, archive: false });
}

function bySlug(sources: ClaudeSessionSource[], rel: string): ClaudeSessionSource {
  const found = sources.find((s) => s.rel === rel);
  if (!found) throw new Error(`no source discovered for ${rel}`);
  return found;
}

describe('claude discovery', () => {
  it('finds top-level sessions and both sidechain layouts', () => {
    const sources = fixtureSources();
    expect(sources.map((s) => s.rel)).toEqual(
      [ALIVE_REL, NESTED_SIDECHAIN_REL, SDK_REL, FLAT_SIDECHAIN_REL].sort(),
    );

    // A subagent transcript is part of its parent session, never a session of
    // its own. Counting one as a session inflates "still on disk" and deflates
    // "deleted" — the number the whole audit card rests on.
    expect(sources.filter((s) => !s.isSidechain).map((s) => s.sessionId)).toEqual([
      IDS.alive,
      IDS.sdk,
    ]);
    expect(sources.filter((s) => s.isSidechain)).toHaveLength(2);
  });

  it('takes the parent from the path when the path names one', () => {
    const sources = fixtureSources();
    // <slug>/<session-uuid>/subagents/agent-*.jsonl: the parent is right there.
    expect(bySlug(sources, NESTED_SIDECHAIN_REL).parentSessionId).toBe(IDS.alive);
    // <slug>/subagents/agent-*.jsonl: the path names no parent, so discovery
    // leaves the id a best guess and `parse()` corrects it from the records —
    // which is exactly what `SessionSource.sessionId` is documented to allow.
    expect(bySlug(sources, FLAT_SIDECHAIN_REL).parentSessionId).toBeUndefined();
  });

  it('carries the two facts the incremental index decides on, and opens no file', () => {
    for (const source of fixtureSources()) {
      const stat = fs.statSync(source.path);
      expect(source.bytes).toBe(stat.size);
      expect(source.mtimeMs).toBe(stat.mtimeMs);
      expect(source.harness).toBe('claude');
    }
  });

  it('ignores memory notes and sessions-index.json', () => {
    const paths = fixtureSources().map((s) => s.path);
    expect(paths.every((p) => p.endsWith('.jsonl'))).toBe(true);
    expect(paths.some((p) => p.includes(`${path.sep}memory${path.sep}`))).toBe(false);
  });

  it('reports the directory it reads even when nothing is there', () => {
    expect(sourceDir('/nope')).toBe(path.join('/nope', 'projects'));
    expect(discover({ claudeDir: '/nope', archive: false })).toEqual([]);
    expect(claudeAdapter.harness).toBe('claude');
    expect(claudeAdapter.displayName).toBe('Claude Code');
  });
});

describe('claude parse', () => {
  it('gives a sidechain its own id and never collides it with its parent', async () => {
    const sources = fixtureSources();
    const nested = await parse(bySlug(sources, NESTED_SIDECHAIN_REL));
    const flat = await parse(bySlug(sources, FLAT_SIDECHAIN_REL));
    const parent = await parse(bySlug(sources, ALIVE_REL));

    // The `sessionId` field *inside* a subagent transcript holds the PARENT's
    // id. Using it raw would make every sidechain overwrite its parent row.
    expect(nested.session.id).toBe(`${IDS.alive}:agent-01`);
    expect(nested.session.parentSessionId).toBe(IDS.alive);
    expect(nested.session.id).not.toBe(parent.session.id);

    // Same rule when the path names no parent: the records supply it.
    expect(flat.session.id).toBe(`${IDS.sdk}:agent-02`);
    expect(flat.session.parentSessionId).toBe(IDS.sdk);

    expect(nested.session.isSidechain).toBe(true);
    expect(flat.session.isSidechain).toBe(true);
    expect(parent.session.isSidechain).toBe(false);
    for (const exchange of nested.exchanges) expect(exchange.isSidechain).toBe(true);
  });

  it('names the subagent from the agent-name record', async () => {
    const nested = await parse(bySlug(fixtureSources(), NESTED_SIDECHAIN_REL));
    expect(nested.session.agentName).toBe('db-reviewer');
  });

  it('takes the last ai-title and fills the session from the transcript', async () => {
    const result = await parse(bySlug(fixtureSources(), ALIVE_REL));
    expect(result.session.title).toBe('Pin pgbouncer prepared-statement handling');
    expect(result.session.project).toBe('/tmp/potsherd-alpha');
    expect(result.session.projectSlug).toBe('-tmp-potsherd-alpha');
    expect(result.session.entrypoint).toBe('cli');
    expect(result.session.gitBranch).toBe('main');
    expect(result.session.status).toBe('live');
    expect(result.version).toBe('2.1.237');
  });

  it('leaves an sdk session with no title rather than inventing one', async () => {
    const result = await parse(bySlug(fixtureSources(), SDK_REL));
    expect(result.session.entrypoint).toBe('sdk-ts');
    expect(result.session.title).toBeUndefined();
    expect('title' in result.session).toBe(false);
  });

  it('attaches a tool result to its call by tool_use_id instead of dropping it', async () => {
    const result = await parse(bySlug(fixtureSources(), ALIVE_REL));
    const [first] = result.exchanges;
    expect(first?.toolCalls).toEqual([
      { name: 'Edit', input: JSON.stringify({ file_path: '/tmp/potsherd-alpha/db/pool.ts' }), result: 'ok' },
    ]);
    expect(first?.filesTouched).toEqual(['/tmp/potsherd-alpha/db/pool.ts']);
  });

  it('emits one exchange per human prompt, each with text a human typed', async () => {
    const result = await parse(bySlug(fixtureSources(), ALIVE_REL));
    expect(result.exchanges.map((e) => e.userText)).toEqual([
      'how do we pin the pgbouncer prepared-statement setting?',
      'ship it',
    ]);
    expect(result.exchanges.map((e) => e.seq)).toEqual([1, 2]);
    expect(result.session.counts.userPrompts).toBe(2);
  });

  it('counts unknown record types instead of failing on them', async () => {
    const result = await parse(bySlug(fixtureSources(), ALIVE_REL));
    // Every one of these is real and none of them is fatal. Two of them carry
    // no `timestamp` at all, which is why the parser may never assume one.
    expect(result.unknownTypes).toMatchObject({
      'last-prompt': 1,
      mode: 1,
      'permission-mode': 1,
      'file-history-snapshot': 1,
      'queue-operation': 1,
      'atis-latch': 1,
    });
    expect(result.malformedLines).toBe(0);
  });
});

describe('doctor coverage', () => {
  it('groups unknown types by (harness, version, type) and flags the novel ones', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'projects', '-tmp-x', 'aaaa.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        { type: 'mode', sessionId: 'aaaa', mode: 'normal' },
        { type: 'artifact-comment-monitor', sessionId: 'aaaa' },
        { type: 'sky-hook-negotiator', sessionId: 'aaaa' },
        { type: 'user', sessionId: 'aaaa', version: '2.1.240', promptId: 'p', timestamp: '2026-08-01T00:00:00.000Z', message: { role: 'user', content: 'hi' } },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );

    const results = await Promise.all(
      discover({ claudeDir: dir, archive: false }).map((s) => parse(s)),
    );
    const stats = recordTypeStats(results);
    rmrf(dir);

    // Novel first: a type no draft of formats.md has described is the line a
    // user needs to read, not the twentieth `mode` record.
    expect(stats[0]).toEqual({
      harness: 'claude',
      version: '2.1.240',
      type: 'sky-hook-negotiator',
      count: 1,
      files: 1,
      novel: true,
    });
    expect(stats.find((s) => s.type === 'mode')?.novel).toBe(false);
    // Read and understood in phase 7, so it is no longer news. See
    // IGNORED_RECORD_TYPES for the shape it was read to have.
    expect(stats.find((s) => s.type === 'artifact-comment-monitor')?.novel).toBe(false);
  });

  /**
   * `artifact-comment-monitor` was reported as an undocumented format change on
   * every `index` run for six phases because nobody had opened one. Phase 7 did,
   * over the frozen snapshot, and found bookkeeping: an artifact id mapped to a
   * state, a title and a write time, with no `cwd`, no `timestamp`, no
   * `parentUuid` and no `message` anywhere in it.
   *
   * That measurement is what justifies skipping it, so it is pinned. If a later
   * Claude Code build starts putting conversation into this record, the skip
   * becomes data loss and this test is what says so.
   */
  it('skips artifact-comment-monitor because it carries no conversation, and pins that', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'projects', '-tmp-x', 'bbbb.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // The exact shape read off the frozen snapshot, values substituted.
    const record = {
      type: 'artifact-comment-monitor',
      v: 1,
      sessionId: 'bbbb',
      artifacts: {
        '00000000-0000-4000-8000-000000000001': {
          state: 'published',
          title: 'a page',
          writtenAtMs: 1755800000000,
        },
      },
    };
    fs.writeFileSync(
      file,
      [
        JSON.stringify(record),
        JSON.stringify({ type: 'user', sessionId: 'bbbb', version: '2.1.240', promptId: 'p', timestamp: '2026-08-01T00:00:00.000Z', message: { role: 'user', content: 'hi' } }),
      ].join('\n') + '\n',
    );

    const [result] = await Promise.all(
      discover({ claudeDir: dir, archive: false }).map((s) => parse(s)),
    );
    rmrf(dir);

    // The three fields an exchange is built from are absent from the record, so
    // skipping it loses nothing. Checked against the object, not the parser, so
    // this stays true if the parser changes.
    for (const key of ['cwd', 'timestamp', 'message', 'parentUuid', 'uuid']) {
      expect(Object.hasOwn(record, key), `${key} appeared in the record`).toBe(false);
    }
    expect(Object.keys(record).sort()).toEqual(['artifacts', 'sessionId', 'type', 'v']);
    expect(isNovelRecordType('artifact-comment-monitor')).toBe(false);
    // And it is still counted, not swallowed: skipped is not the same as unseen.
    expect(result?.unknownTypes?.['artifact-comment-monitor']).toBe(1);
  });
});

describe('archive fallback', () => {
  it('parses the archive copy, marked archived, when the source is gone', async () => {
    const root = tempDir();
    const claude = path.join(root, 'claude');
    const potsherd = path.join(root, 'potsherd');
    fs.cpSync(FIXTURE_CLAUDE, claude, { recursive: true });
    fs.cpSync(
      path.join(claude, 'projects'),
      path.join(potsherd, 'archive', 'claude'),
      { recursive: true },
    );
    // The sweep takes the sdk session and its sidechain; the archive keeps them.
    fs.rmSync(path.join(claude, 'projects', SDK_REL));
    fs.rmSync(path.join(claude, 'projects', '-tmp-potsherd-beta', 'subagents'), { recursive: true });

    const sources = discover({ claudeDir: claude, potsherdDir: potsherd });
    const statuses = Object.fromEntries(sources.map((s) => [s.rel, s.status]));
    expect(statuses).toEqual({
      [ALIVE_REL]: 'live',
      [NESTED_SIDECHAIN_REL]: 'live',
      [SDK_REL]: 'archived',
      [FLAT_SIDECHAIN_REL]: 'archived',
    });

    const archived = bySlug(sources, SDK_REL);
    // `path` is what will be read; `originalPath` is the ~/.claude path that
    // no longer exists — the store's source_path / archived_path pair.
    expect(archived.path.startsWith(potsherd)).toBe(true);
    expect(archived.originalPath).toBe(path.join(claude, 'projects', SDK_REL));

    const result = await parse(archived);
    expect(result.session.status).toBe('archived');
    expect(result.session.id).toBe(IDS.sdk);
    expect(result.exchanges.map((e) => e.userText)).toEqual(['summarise the changelog']);

    // A sidechain in the archive still gets the parent-derived id.
    const archivedSidechain = await parse(bySlug(sources, FLAT_SIDECHAIN_REL));
    expect(archivedSidechain.session.id).toBe(`${IDS.sdk}:agent-02`);
    expect(archivedSidechain.session.status).toBe('archived');

    rmrf(root);
  });

  it('prefers the live file over the archive copy of the same session', () => {
    const root = tempDir();
    const claude = path.join(root, 'claude');
    const potsherd = path.join(root, 'potsherd');
    fs.cpSync(FIXTURE_CLAUDE, claude, { recursive: true });
    fs.cpSync(path.join(claude, 'projects'), path.join(potsherd, 'archive', 'claude'), { recursive: true });

    const sources = discover({ claudeDir: claude, potsherdDir: potsherd });
    // Same four sessions, not eight: the live copy is the same bytes plus
    // whatever the session appended since the last rescue.
    expect(sources).toHaveLength(4);
    expect(sources.every((s) => s.status === 'live')).toBe(true);
    rmrf(root);
  });
});

describe('image payloads that are not prompts', () => {
  /**
   * A tool that returns images makes claude code write them as their own
   * `type:"user"` record, carrying the *originating prompt's* `promptId` and a
   * content array of nothing but `image` blocks. Eleven such records exist in
   * the reference corpus. `formats.md`'s rule excludes them — a human prompt's
   * content is a string or holds a `text` item — and getting that wrong splits
   * one turn into two, leaving an exchange with no user text at all and the
   * assistant's real answer filed under it.
   */
  it('folds an image-only user record back into the prompt it belongs to', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'projects', '-tmp-img', 'cccc.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const base = { sessionId: 'cccc', cwd: '/tmp/img', version: '2.1.237' };
    // The record order is the one every occurrence in the reference corpus
    // takes: tool_use, tool_result, image payload, then the work continues.
    fs.writeFileSync(
      file,
      [
        { ...base, type: 'user', promptId: 'p1', uuid: 'a', timestamp: '2026-08-01T09:00:00.000Z', message: { role: 'user', content: 'read the chart and tell me the trend' } },
        { ...base, type: 'assistant', uuid: 'b', timestamp: '2026-08-01T09:00:01.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/img/chart.png' } }] } },
        { ...base, type: 'user', promptId: 'p1', uuid: 'c', timestamp: '2026-08-01T09:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'read 1 image' }] } },
        // The payload record: promptId set, no tool_result, no text at all.
        { ...base, type: 'user', promptId: 'p1', uuid: 'd', timestamp: '2026-08-01T09:00:03.000Z', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } }] } },
        { ...base, type: 'assistant', uuid: 'e', timestamp: '2026-08-01T09:00:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'The trend is up and to the right.' }, { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/tmp/img/notes.md' } }] } },
        { ...base, type: 'user', promptId: 'p1', uuid: 'f', timestamp: '2026-08-01T09:00:05.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'written' }] } },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );

    const [source] = discover({ claudeDir: dir, archive: false });
    const result = await parse(source!);
    rmrf(dir);

    expect(result.exchanges).toHaveLength(1);
    // T1.5 fixed the missing clause in `parser/claude.ts` (finding F1), so the
    // split never happens and the adapter's repair pass has nothing to fold.
    expect(result.continuationsFolded).toBe(0);
    const [only] = result.exchanges;
    expect(only?.userText).toBe('read the chart and tell me the trend');
    // The answer belongs to the prompt that asked for it, not to the payload.
    expect(only?.assistantText).toBe('The trend is up and to the right.');
    expect(only?.toolCalls.map((t) => [t.name, t.result])).toEqual([
      ['Read', 'read 1 image'],
      ['Write', 'written'],
    ]);
    expect(only?.filesTouched).toEqual(['/tmp/img/chart.png', '/tmp/img/notes.md']);
    expect(only?.seq).toBe(1);
  });

  it('renumbers folded exchanges so the next incremental run resumes cleanly', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'projects', '-tmp-img', 'dddd.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const base = { sessionId: 'dddd', cwd: '/tmp/img', version: '2.1.237' };
    const rows = [];
    for (const n of [1, 2, 3]) {
      rows.push({ ...base, type: 'user', promptId: `p${n}`, uuid: `u${n}`, timestamp: `2026-08-01T09:0${n}:00.000Z`, message: { role: 'user', content: `prompt ${n}` } });
      rows.push({ ...base, type: 'user', promptId: `p${n}`, uuid: `i${n}`, timestamp: `2026-08-01T09:0${n}:01.000Z`, message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }] } });
    }
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const [source] = discover({ claudeDir: dir, archive: false });
    const result = await parse(source!);
    rmrf(dir);

    expect(result.exchanges.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(new Set(result.exchanges.map((e) => e.id)).size).toBe(3);
    expect(result.exchanges.every((e) => e.userText.trim().length > 0)).toBe(true);
  });
});

// --------------------------------------------------------------- real corpus

/**
 * The reference corpus. `~/.potsherd/archive-manual-2026-08-21` is a frozen
 * copy taken before this phase began; the live `~/.claude` is still being
 * appended to by whatever the developer is running right now, so exact counts
 * belong to the frozen copy and the live tree gets floors instead.
 *
 * Both are opened **read-only**. Nothing in this file writes to either.
 */
const FROZEN = process.env['POTSHERD_TEST_CORPUS'] ??
  path.join(os.homedir(), '.potsherd', 'archive-manual-2026-08-21');
const LIVE = path.join(os.homedir(), '.claude');

interface CorpusReading {
  sources: ClaudeSessionSource[];
  results: ClaudeParseResult[];
  fatal: string[];
  vanished: number;
  emptyUserText: number;
  duplicateSessionIds: string[];
  duplicateExchangeIds: number;
  toolCalls: number;
  toolCallsWithResult: number;
}

async function readCorpus(dir: string): Promise<CorpusReading> {
  const sources = discover({ claudeDir: dir, archive: false });
  const out: CorpusReading = {
    sources,
    results: [],
    fatal: [],
    vanished: 0,
    emptyUserText: 0,
    duplicateSessionIds: [],
    duplicateExchangeIds: 0,
    toolCalls: 0,
    toolCallsWithResult: 0,
  };
  const sessionIds = new Set<string>();
  const exchangeIds = new Set<string>();

  for (const source of sources) {
    let result: ClaudeParseResult;
    try {
      result = await parse(source);
    } catch (err) {
      // A live transcript can be deleted between readdir and read; that is the
      // sweep doing its job, not a parse failure.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') out.vanished += 1;
      else out.fatal.push(`${source.path}: ${(err as Error).message}`);
      continue;
    }
    out.results.push(result);
    if (sessionIds.has(result.session.id)) out.duplicateSessionIds.push(result.session.id);
    sessionIds.add(result.session.id);
    for (const exchange of result.exchanges) {
      if (!exchange.userText.trim()) out.emptyUserText += 1;
      if (exchangeIds.has(exchange.id)) out.duplicateExchangeIds += 1;
      exchangeIds.add(exchange.id);
      for (const call of exchange.toolCalls) {
        out.toolCalls += 1;
        if (call.result !== undefined) out.toolCallsWithResult += 1;
      }
    }
  }
  return out;
}

const hasFrozen = fs.existsSync(path.join(FROZEN, 'projects'));

describe.skipIf(!hasFrozen)('reference corpus (frozen, read-only)', () => {
  it('parses every transcript with no fatal error and the expected counts', async () => {
    const corpus = await readCorpus(FROZEN);
    const sessions = corpus.sources.filter((s) => !s.isSidechain);
    const sidechains = corpus.sources.filter((s) => s.isSidechain);

    expect(sessions).toHaveLength(30);
    expect(sidechains).toHaveLength(197);
    expect(corpus.fatal).toEqual([]);
    expect(corpus.results).toHaveLength(227);

    const topLevel = corpus.results.filter((r) => !r.session.isSidechain);
    expect(topLevel.filter((r) => r.session.title).length).toBe(20);
    expect(topLevel.filter((r) => r.session.entrypoint === 'sdk-ts').length).toBe(3);
    // Every sdk session is one of the untitled ones: claude never writes an
    // ai-title for a session the SDK drove.
    expect(topLevel.filter((r) => r.session.entrypoint === 'sdk-ts' && r.session.title)).toEqual([]);

    // The human-prompt rule, end to end.
    expect(corpus.emptyUserText).toBe(0);
    // Sidechain ids are parent-scoped, so nothing collides on the primary key.
    expect(corpus.duplicateSessionIds).toEqual([]);
    expect(corpus.duplicateExchangeIds).toBe(0);
    expect(corpus.results.filter((r) => r.session.isSidechain).every((r) => r.session.id.includes(':'))).toBe(true);

    // Tool results are attached by tool_use_id, not dropped.
    expect(corpus.toolCalls).toBeGreaterThan(9000);
    expect(corpus.toolCallsWithResult / corpus.toolCalls).toBeGreaterThan(0.999);

    // Unknown record types are counted and reportable, never fatal.
    const stats = recordTypeStats(corpus.results);
    const types = new Set(stats.map((s) => s.type));
    for (const known of ['last-prompt', 'mode', 'permission-mode', 'queue-operation', 'file-history-snapshot']) {
      expect(types.has(known)).toBe(true);
    }
    expect(stats.every((s) => s.count > 0 && s.files > 0)).toBe(true);
    expect(stats.every((s) => s.version !== '')).toBe(true);
  }, 300_000);
});

const hasLive = fs.existsSync(path.join(LIVE, 'projects'));

describe.skipIf(!hasLive)('live ~/.claude (read-only, floors only)', () => {
  it('discovers at least the reference counts and parses them all', async () => {
    const corpus = await readCorpus(LIVE);
    const sessions = corpus.sources.filter((s) => !s.isSidechain);
    const sidechains = corpus.sources.filter((s) => s.isSidechain);

    // Floors, not equalities: the live tree grows while this test runs.
    expect(sessions.length).toBeGreaterThanOrEqual(31);
    expect(sidechains.length).toBeGreaterThanOrEqual(197);
    expect(corpus.fatal).toEqual([]);

    const topLevel = corpus.results.filter((r) => !r.session.isSidechain);
    expect(topLevel.filter((r) => r.session.title).length).toBeGreaterThanOrEqual(21);
    expect(topLevel.filter((r) => r.session.entrypoint === 'sdk-ts').length).toBeGreaterThanOrEqual(3);
    expect(corpus.emptyUserText).toBe(0);
    expect(corpus.duplicateSessionIds).toEqual([]);
  }, 300_000);
});

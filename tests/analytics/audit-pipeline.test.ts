import {afterEach, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createAuditSession, publicAuditSnapshot} from '../../packages/core/src/analytics/index.js';
import {classifyText, extractFile} from '../../packages/core/src/analytics/extract.js';
import {PriceBook, usageCost} from '../../packages/core/src/analytics/pricing.js';
import {sourceId} from '../../packages/core/src/memory/source-identity.js';
import {openDatabase} from '../../packages/core/src/sqlite-driver.js';
import type {AuditOverviewOptions} from '../../packages/core/src/analytics/contracts.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => fs.rmSync(root, {recursive: true, force: true})); vi.unstubAllEnvs(); });

const jsonl = (rows: unknown[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
const at = (minute: number) => new Date(Date.parse('2026-10-01T10:00:00Z') + minute * 60_000).toISOString();

function home() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-pipeline-'));
  roots.push(root);
  const dirs = {root, claude: path.join(root, 'claude'), codex: path.join(root, 'codex'), pi: path.join(root, 'pi'), opencode: path.join(root, 'opencode'), potsherd: path.join(root, 'potsherd')};
  for (const d of Object.values(dirs)) fs.mkdirSync(d, {recursive: true});
  const options: AuditOverviewOptions = {launch: true, claudeDir: dirs.claude, codexDir: dirs.codex, piDir: dirs.pi, opencodeDir: dirs.opencode, potsherdDir: dirs.potsherd, timezone: 'UTC'};
  const write = (file: string, rows: unknown[]) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, jsonl(rows)); return file; };
  return {dirs, options, write};
}

const user = (uuid: string, text: unknown, extra: Record<string, unknown> = {}) => ({type: 'user', uuid, sessionId: 's1', cwd: '/work/app', timestamp: at(Number(uuid.replace(/\D/g, '')) || 0), entrypoint: 'cli', origin: {kind: 'human'}, message: {role: 'user', content: text}, ...extra});
const assistant = (id: string, req: string | null, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({type: 'assistant', uuid: `a-${id}-${req}`, sessionId: 's1', cwd: '/work/app', timestamp: at(1), ...(req ? {requestId: req} : {}), message: {id, role: 'assistant', model: 'claude-sonnet-4-6', content: [{type: 'text', text: 'BODY-NEVER-READ'}], usage}, ...extra});

async function run(options: AuditOverviewOptions) {
  vi.stubEnv('POTSHERD_OFFLINE', '1');
  const session = createAuditSession(options);
  try { return await session.run(); } finally { session.dispose(); }
}

describe('human prompt rules', () => {
  it('classifies injected text, slash commands and question answers', () => {
    expect(classifyText('fix the login bug').kind).toBe('human');
    expect(classifyText('<system-reminder>x</system-reminder>  ').reason).toBe('empty');
    expect(classifyText('<task-notification><task-id>1</task-id>').kind).toBe('excluded');
    expect(classifyText('[Request interrupted by user]').reason).toBe('interrupt_marker');
    expect(classifyText('<command-name>/clear</command-name>').kind).toBe('command');
    expect(classifyText('<send_user_message_question_reply>[]').kind).toBe('answer');
    expect(classifyText('# AGENTS.md instructions\n<INSTRUCTIONS>').kind).toBe('excluded');
  });

  it('counts only typed Claude prompts and never parses assistant bodies into text', () => {
    const {dirs, write} = home();
    const file = write(path.join(dirs.claude, 'projects', 'p', 's1.jsonl'), [
      user('u1', 'Please build the export feature'),
      user('u2', [{type: 'tool_result', tool_use_id: 't', content: 'output'}]),
      user('u3', 'skill expansion', {isMeta: true}),
      user('u4', '<task-notification>done</task-notification>', {origin: {kind: 'task-notification'}}),
      user('u5', '<command-name>/model</command-name>'),
      user('u6', 'headless run', {entrypoint: 'sdk-cli'}),
      user('u7', 'compacted', {isCompactSummary: true}),
      user('u1', 'Please build the export feature'),
      assistant('m1', 'r1', {input_tokens: 10, output_tokens: 5}),
    ]);
    const facts = extractFile(file, 'claude');
    const human = facts.prompts.filter(p => p.kind === 'human');
    expect(human.map(p => p.text)).toEqual(['Please build the export feature']);
    expect(facts.prompts.find(p => p.kind === 'command')).toBeTruthy();
    expect(facts.prompts.map(p => p.reason)).toEqual(expect.arrayContaining(['is_meta', 'origin_task-notification', 'headless_claude_p', 'compaction_summary']));
    expect(human[0]!.after).toBe('claude-sonnet-4-6');
    expect(JSON.stringify(facts)).not.toContain('BODY-NEVER-READ');
  });
});

describe('usage and cost', () => {
  it('prices every response with ccusage rules and dedupes Claude copies by keeping the larger one', async () => {
    const {dirs, options, write} = home();
    const usage = {input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 300_000, cache_creation: {ephemeral_5m_input_tokens: 200_000, ephemeral_1h_input_tokens: 100_000}};
    write(path.join(dirs.claude, 'projects', 'p', 's1.jsonl'), [
      user('u1', 'go'),
      assistant('m1', 'r1', {...usage, output_tokens: 1}),
      assistant('m1', 'r1', usage),
    ]);
    // A resumed session copies the same response into another file.
    write(path.join(dirs.claude, 'projects', 'p', 's2.jsonl'), [assistant('m1', 'r1', usage, {sessionId: 's2'})]);
    const snapshot = await run(options);
    // sonnet-4-6: 3 in, 15 out, 0.3 read, 3.75 write(5m), 1h at 2x input = 6
    const expected = 3 + 1.5 + 0.3 + 0.2 * 3.75 + 0.1 * 6;
    expect(snapshot.launch!.facts!.recordedResponses).toBe(1);
    expect(snapshot.usage.costUsd).toBeCloseTo(expected, 2);
    expect(snapshot.launch!.facts!.models[0]).toMatchObject({model: 'claude-sonnet-4-6', estimated: false, responses: 1});
    expect(snapshot.usage.inputTokens).toBe(1_000_000);
    expect(snapshot.usage.cacheTokens).toBe(1_300_000);
  });

  it('gives an unknown model the closest family price and flags it as estimated', () => {
    const book = new PriceBook();
    const price = book.lookup('claude-opus-9-9')!;
    expect(price.estimated).toBe(true);
    expect(price.pricedAs).toMatch(/^claude-opus/);
    expect(usageCost({key: null, at: null, model: 'claude-opus-9-9', provider: null, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0}, price)).toBeGreaterThan(0);
    expect(book.lookup(`anthropic/claude-sonnet-4-6@${'2026'}0101`)!.estimated).toBe(false);
  });

  it('reads Codex usage, prompts, tiers, auto-review and compaction', async () => {
    const {dirs, options, write} = home();
    fs.writeFileSync(path.join(dirs.codex, 'config.toml'), 'service_tier = "priority"\n');
    const tc = (minute: number, last: number[], total: number[]) => ({timestamp: at(minute), type: 'event_msg', payload: {type: 'token_count', info: {
      last_token_usage: {input_tokens: last[0], cached_input_tokens: last[1], output_tokens: last[2], reasoning_output_tokens: 0, total_tokens: last[0]! + last[2]!},
      total_token_usage: {input_tokens: total[0], cached_input_tokens: total[1], output_tokens: total[2], reasoning_output_tokens: 0, total_tokens: total[0]! + total[2]!}}}});
    write(path.join(dirs.codex, 'sessions', '2026', '10', '01', 'rollout-a.jsonl'), [
      {timestamp: at(0), type: 'session_meta', payload: {id: 'cx1', cwd: '/work/api', originator: 'codex_work_desktop', source: 'vscode'}},
      {timestamp: at(0), type: 'turn_context', payload: {model: 'gpt-6-sol', cwd: '/work/api'}},
      {timestamp: at(0), type: 'event_msg', payload: {type: 'thread_settings_applied', thread_settings: {service_tier: 'default'}}},
      {timestamp: at(0), type: 'response_item', payload: {type: 'message', role: 'user', content: [{type: 'input_text', text: '<environment_context>x</environment_context>'}]}},
      {timestamp: at(1), type: 'event_msg', payload: {type: 'item_completed', turn_id: 't1', item: {type: 'UserMessage', id: 'i1', content: [{type: 'input_text', text: 'add pagination to the API'}]}}},
      tc(2, [1000, 400, 100], [1000, 400, 100]),
      tc(3, [1000, 400, 100], [1000, 400, 100]), // repeated counter: not new usage
      {timestamp: at(4), type: 'token_usage_record', payload: {response_id: 'resp-c', usage: {input_tokens: 5000, cached_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 0, total_tokens: 5050}}},
      {timestamp: at(4), type: 'compacted', payload: {message: '', compaction_response_id: 'resp-c'}},
    ]);
    write(path.join(dirs.codex, 'sessions', '2026', '10', '01', 'rollout-b.jsonl'), [
      {timestamp: at(5), type: 'session_meta', payload: {id: 'cx2', cwd: '/work/api', source: {subagent: {other: 'guardian'}}}},
      {timestamp: at(5), type: 'turn_context', payload: {model: 'codex-auto-review', cwd: '/work/api'}},
      {timestamp: at(6), type: 'event_msg', payload: {type: 'item_completed', item: {type: 'UserMessage', id: 'i2', content: [{type: 'input_text', text: 'The following is the Codex agent history'}]}}},
      tc(7, [2000, 0, 10], [2000, 0, 10]),
    ]);
    const snapshot = await run({...options, harnesses: ['codex']});
    const codex = snapshot.sources.find(s => s.harness === 'codex')!;
    expect(codex.humanPrompts).toBe(1);
    expect(snapshot.metrics.conversations.value).toBe(1);
    expect(snapshot.metrics.linkedChildren.value).toBe(1);
    expect(snapshot.launch!.facts!.recordedResponses).toBe(3);
    expect(snapshot.launch!.facts!.compactionResponses).toBe(1);
    const models = Object.fromEntries(snapshot.launch!.facts!.models.map(m => [m.model, m]));
    // gpt-6-sol on the default tier: 600 uncached * 2 + 400 cached * 0.2 + 100 out * 10, plus the compaction request.
    expect(models['gpt-6-sol']!.valueUsd).toBeCloseTo((600 * 2 + 400 * 0.2 + 100 * 10 + 5000 * 2 + 50 * 10) / 1e6, 6);
    // auto-review maps to gpt-5.6-luna and bills priority (fast) by default.
    expect(models['gpt-5.6-luna']!.valueUsd).toBeCloseTo(2 * (2000 * 0.2 + 10 * 1.2) / 1e6, 8);
    expect(snapshot.usage.inputTokens).toBe(600 + 5000 + 2000);
  });
});

describe('conversations, history and opt-outs', () => {
  it('adds Claude sessions known only from history.jsonl without double counting live ones', async () => {
    const {dirs, options, write} = home();
    write(path.join(dirs.claude, 'projects', 'p', 's1.jsonl'), [user('u1', 'live prompt')]);
    write(path.join(dirs.claude, 'history.jsonl'), [
      {display: 'live prompt', timestamp: Date.parse(at(0)), project: '/work/app', sessionId: 's1'},
      {display: 'deleted prompt one', timestamp: Date.parse(at(2)), project: '/work/old', sessionId: 'gone'},
      {display: '/clear', timestamp: Date.parse(at(3)), project: '/work/old', sessionId: 'gone'},
      {display: 'deleted prompt two', timestamp: Date.parse(at(4)), project: '/work/old', sessionId: 'gone'},
    ]);
    const snapshot = await run(options);
    expect(snapshot.metrics.conversations.value).toBe(2);
    expect(snapshot.metrics.humanPrompts.value).toBe(3);
    expect(snapshot.projects.map(p => [p.path, p.humanPrompts])).toEqual([['/work/old', 2], ['/work/app', 1]]);
    expect(snapshot.activity).toEqual([{date: '2026-10-01', count: 3}]);
  });

  it('excludes ignored projects and forgotten sources, and keeps them out of the cache', async () => {
    const {dirs, options, write} = home();
    write(path.join(dirs.claude, 'projects', 'a', 's1.jsonl'), [user('u1', 'keep me secret-free'), assistant('m1', 'r1', {input_tokens: 10, output_tokens: 1})]);
    write(path.join(dirs.claude, 'projects', 'b', 's2.jsonl'), [user('u2', 'IGNORED-PROJECT-TEXT', {sessionId: 's2', cwd: '/work/ignored'}), assistant('m2', 'r2', {input_tokens: 10, output_tokens: 1}, {sessionId: 's2', cwd: '/work/ignored'})]);
    write(path.join(dirs.claude, 'projects', 'c', 's3.jsonl'), [user('u3', 'FORGOTTEN-TEXT', {sessionId: 's3'}), assistant('m3', 'r3', {input_tokens: 10, output_tokens: 1}, {sessionId: 's3'})]);
    fs.writeFileSync(path.join(dirs.potsherd, 'config.json'), JSON.stringify({ignore: ['/work/ignored']}));
    const db = openDatabase(path.join(dirs.potsherd, 'potsherd.db'));
    db.exec("CREATE TABLE memory_sources (source_id TEXT PRIMARY KEY, availability TEXT); CREATE TABLE forget_tombstones (source_id TEXT, state TEXT);");
    db.prepare("INSERT INTO forget_tombstones VALUES (?, 'active')").run(sourceId('claude', 's3'));
    db.close();
    const snapshot = await run(options);
    expect(snapshot.metrics.humanPrompts.value).toBe(1);
    expect(snapshot.launch!.facts!.recordedResponses).toBe(1);
    const cache = fs.readdirSync(path.join(dirs.potsherd, 'audit-derived')).filter(f => f.startsWith('facts-'));
    const bytes = fs.readFileSync(path.join(dirs.potsherd, 'audit-derived', cache[0]!)).toString('latin1');
    expect(bytes).not.toContain('IGNORED-PROJECT-TEXT');
    expect(bytes).not.toContain('FORGOTTEN-TEXT');
  });

  it('re-reads only changed files on a warm run and never writes original history', async () => {
    const {dirs, options, write} = home();
    const a = write(path.join(dirs.claude, 'projects', 'p', 's1.jsonl'), [user('u1', 'first'), assistant('m1', 'r1', {input_tokens: 10, output_tokens: 1})]);
    write(path.join(dirs.claude, 'projects', 'p', 's2.jsonl'), [user('u2', 'second', {sessionId: 's2'})]);
    const before = fs.statSync(a);
    const cold = await run(options);
    expect(cold.timings).toMatchObject({filesRead: 2, filesCached: 0});
    const warm = await run(options);
    expect(warm.timings).toMatchObject({filesRead: 0, filesCached: 2});
    expect(warm.metrics.humanPrompts.value).toBe(cold.metrics.humanPrompts.value);
    expect(warm.usage.costUsd).toBe(cold.usage.costUsd);
    fs.appendFileSync(a, jsonl([user('u9', 'third', {timestamp: at(9)})]));
    const appended = await run(options);
    expect(appended.timings).toMatchObject({filesRead: 0, filesResumed: 1, filesCached: 1});
    expect(appended.metrics.humanPrompts.value).toBe(3);
    expect(fs.readFileSync(a, 'utf8')).toContain('third');
    expect(fs.statSync(a).size).toBeGreaterThan(before.size);
  });

  it('keeps titles, paths and text out of the public snapshot', async () => {
    const {dirs, options, write} = home();
    write(path.join(dirs.claude, 'projects', 'p', 's1.jsonl'), [user('u1', 'repeat this PRIVATE line'), user('u2', 'repeat this PRIVATE line'), {type: 'summary', summary: 'PRIVATE-TITLE'}]);
    const snapshot = await run(options);
    expect(snapshot.phrases!.length).toBeGreaterThan(0);
    const text = JSON.stringify(publicAuditSnapshot(snapshot));
    expect(text).not.toContain('PRIVATE');
    expect(text).not.toContain('/work/app');
  });
});

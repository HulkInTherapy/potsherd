import {afterEach, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createAuditSession, publicAuditSnapshot} from '../../packages/core/src/analytics/index.js';
import {extractFile, ResumeMismatch, stripText} from '../../packages/core/src/analytics/extract.js';
import {enrichStory, numbersIn} from '../../packages/core/src/analytics/story-enrich.js';
import {FreeJevProvider} from '../../packages/core/src/analytics/free-jev.js';
import type {AuditEvent, AuditOverviewOptions} from '../../packages/core/src/analytics/contracts.js';
import type {AuditStory} from '../../packages/core/src/analytics/story-contracts.js';

// Synthetic fixtures only.
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => fs.rmSync(root, {recursive: true, force: true})); vi.unstubAllEnvs(); });
const jsonl = (rows: unknown[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
const at = (minute: number) => new Date(Date.parse('2026-10-01T10:00:00Z') + minute * 60_000).toISOString();

function home() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'story-pipeline-'));
  roots.push(root);
  const dirs = {claude: path.join(root, 'claude'), codex: path.join(root, 'codex'), pi: path.join(root, 'pi'), opencode: path.join(root, 'opencode'), potsherd: path.join(root, 'potsherd'), cache: path.join(root, 'cache')};
  for (const d of Object.values(dirs)) fs.mkdirSync(d, {recursive: true});
  const options: AuditOverviewOptions = {launch: true, claudeDir: dirs.claude, codexDir: dirs.codex, piDir: dirs.pi, opencodeDir: dirs.opencode, potsherdDir: dirs.potsherd, derivedCacheDir: dirs.cache, timezone: 'UTC'};
  const write = (file: string, rows: unknown[]) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, jsonl(rows)); return file; };
  return {dirs, options, write};
}

async function run(options: AuditOverviewOptions, events?: AuditEvent[]) {
  vi.stubEnv('POTSHERD_OFFLINE', '1');
  const session = createAuditSession(options);
  try { return await session.run(e => events?.push(e)); } finally { session.dispose(); }
}

const user = (uuid: string, text: string, minute: number, sessionId = 's1') => ({type: 'user', uuid, sessionId, cwd: '/work/synthetic-app', timestamp: at(minute), entrypoint: 'cli', origin: {kind: 'human'}, message: {role: 'user', content: text}});
const assistant = (id: string, minute: number, sessionId = 's1', extra: Record<string, unknown> = {}) => ({type: 'assistant', uuid: `a-${id}`, sessionId, cwd: '/work/synthetic-app', timestamp: at(minute), requestId: `r-${id}`,
  message: {id, role: 'assistant', model: 'claude-sonnet-4-6', content: [{type: 'tool_use', name: 'Task', input: {}}], usage: {input_tokens: 1000, output_tokens: 100}}, ...extra});

const codexRollout = (turns: number, from = 0) => {
  const rows: unknown[] = [];
  if (from === 0) rows.push({timestamp: at(0), type: 'session_meta', payload: {id: 'cx-synthetic', cwd: '/work/synthetic-api', originator: 'codex_work_desktop', source: 'vscode'}},
    {timestamp: at(0), type: 'turn_context', payload: {model: 'gpt-6-sol', cwd: '/work/synthetic-api'}});
  for (let i = from; i < from + turns; i++) {
    rows.push({timestamp: at(i * 10 + 1), type: 'event_msg', payload: {type: 'item_completed', turn_id: `t${i}`, item: {type: 'UserMessage', id: `i${i}`, content: [{type: 'input_text', text: `please add synthetic feature ${i}`}]}}});
    rows.push({timestamp: at(i * 10 + 2), type: 'response_item', payload: {type: 'function_call', name: 'exec_command', arguments: '{}'}});
    rows.push({timestamp: at(i * 10 + 3), type: 'event_msg', payload: {type: 'token_count', info: {
      last_token_usage: {input_tokens: 1000, cached_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 0, total_tokens: 1050},
      total_token_usage: {input_tokens: 1000 * (i + 1), cached_input_tokens: 0, output_tokens: 50 * (i + 1), reasoning_output_tokens: 0, total_tokens: 1050 * (i + 1)}}}});
  }
  return rows;
};

describe('story in the audit pipeline', () => {
  it('builds launch.story from synthetic history and keeps prompt text out of the cache', async () => {
    const {dirs, options, write} = home();
    const deep = 'filler words about the synthetic module '.repeat(8) + 'DEEP-MARKER-TEXT-SHOULD-NOT-BE-CACHED';
    write(path.join(dirs.claude, 'projects', 'p', 's1.jsonl'), [user('u1', deep, 0), assistant('m1', 1), user('u2', 'continue', 5), assistant('m2', 6)]);
    const snapshot = await run(options);
    const story = snapshot.launch!.story!;
    expect(story.version).toBe('story-v1');
    expect(story.totals.prompts).toBe(2);
    expect(story.totals.subagents).toBe(2);
    expect(story.state).toBe('thin');
    expect(story.rhythm.weekdayHour).toHaveLength(7);
    expect(story.archetype?.id).toBe('fresh_install');
    const file = path.join(dirs.cache, fs.readdirSync(dirs.cache).find(f => f.startsWith('facts-'))!);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file).toString('latin1')).not.toContain('DEEP-MARKER-TEXT');
  });

  it('prefers the typed text from history.jsonl over a transcript with an expanded paste', async () => {
    const {dirs, options, write} = home();
    const pasted = 'look at this log ' + 'damn error line '.repeat(5);
    write(path.join(dirs.claude, 'projects', 'p', 's1.jsonl'), [user('u1', pasted, 0), assistant('m1', 1)]);
    write(path.join(dirs.claude, 'history.jsonl'), [{display: 'look at this log [Pasted text #1 +5 lines]', pastedContents: {1: {}}, timestamp: Date.parse(at(0)) + 1500, project: '/work/synthetic-app', sessionId: 's1'}]);
    const typed = await run(options);
    expect(typed.launch!.story!.swearTimeline[0]!.swearing).toBe(0);
    fs.rmSync(path.join(dirs.claude, 'history.jsonl'));
    const transcript = await run({...options, derivedCacheDir: path.join(dirs.cache, 'other')});
    expect(transcript.launch!.story!.swearTimeline[0]!.swearing).toBe(1);
  });

  it('resumes an appended Codex rollout and matches a full read', async () => {
    const {dirs, options, write} = home();
    const file = write(path.join(dirs.codex, 'sessions', '2026', '10', '01', 'rollout-synthetic.jsonl'), codexRollout(3));
    await run(options);
    fs.appendFileSync(file, jsonl(codexRollout(2, 3)));
    const resumed = await run(options);
    expect(resumed.timings).toMatchObject({filesResumed: 1, filesRead: 0});
    const full = await run({...options, derivedCacheDir: path.join(dirs.cache, 'fresh')});
    expect(full.timings).toMatchObject({filesRead: 1});
    expect(resumed.metrics.humanPrompts.value).toBe(5);
    expect(resumed.usage.costUsd).toBeCloseTo(full.usage.costUsd!, 10);
    const strip = (s: AuditStory) => ({...s, generatedAt: '', timings: {featuresMs: 0, detectorsMs: 0}});
    expect(strip(resumed.launch!.story!)).toEqual(strip(full.launch!.story!));
  });

  it('falls back to a full read when an appended file no longer matches its old prefix', () => {
    const {dirs, write} = home();
    const file = write(path.join(dirs.codex, 'rollout-synthetic.jsonl'), codexRollout(2));
    const first = stripText(extractFile(file, 'codex', {timezone: 'UTC'}));
    expect(first.resume).toBeTruthy();
    const rows = codexRollout(4);
    (rows[2] as {payload: {item: {content: {text: string}[]}}}).payload.item.content[0]!.text = 'please add synthetic feature X';
    fs.writeFileSync(file, jsonl(rows));
    expect(() => extractFile(file, 'codex', {timezone: 'UTC'}, first)).toThrow(ResumeMismatch);
  });

  it('extends history.jsonl incrementally and re-reads it when it was rewritten', async () => {
    const {dirs, options, write} = home();
    const hist = write(path.join(dirs.claude, 'history.jsonl'), [{display: 'first synthetic prompt', timestamp: Date.parse(at(0)), project: '/work/synthetic-old', sessionId: 'gone'}]);
    write(path.join(dirs.claude, 'projects', 'p', 's1.jsonl'), [user('u1', 'live prompt', 0)]);
    expect((await run(options)).metrics.humanPrompts.value).toBe(2);
    fs.appendFileSync(hist, jsonl([{display: 'second synthetic prompt', timestamp: Date.parse(at(3)), project: '/work/synthetic-old', sessionId: 'gone'}]));
    expect((await run(options)).metrics.humanPrompts.value).toBe(3);
    fs.writeFileSync(hist, jsonl([{display: 'rewritten synthetic prompt that is longer', timestamp: Date.parse(at(0)), project: '/work/synthetic-old', sessionId: 'gone'}]) + jsonl([{display: 'another one', timestamp: Date.parse(at(1)), project: '/work/synthetic-old', sessionId: 'gone'}]));
    expect((await run(options)).metrics.humanPrompts.value).toBe(3);
  });

  it('emits loading-story progress: one discovery event per harness, running counts, final detail', async () => {
    const {dirs, options, write} = home();
    write(path.join(dirs.claude, 'projects', 'p', 's1.jsonl'), [user('u1', 'hello synthetic', 0), assistant('m1', 1)]);
    write(path.join(dirs.codex, 'sessions', 'rollout-synthetic.jsonl'), codexRollout(2));
    const events: AuditEvent[] = [];
    const snapshot = await run(options, events);
    const discovering = events.filter(e => e.type === 'progress' && e.progress.detail?.stage === 'discovering');
    expect(discovering.length).toBeGreaterThanOrEqual(4);
    const lastDiscovery = discovering.at(-1)!;
    if (lastDiscovery.type !== 'progress') throw new Error('unreachable');
    expect(lastDiscovery.progress.detail!.harnesses.find(h => h.harness === 'opencode')).toMatchObject({discovered: true, absent: true});
    const detail = snapshot.progress.detail!;
    expect(detail.stage).toBe('ready');
    expect(detail.counts).toMatchObject({chats: 2, prompts: 3});
    expect(detail.harnesses.find(h => h.harness === 'codex')).toMatchObject({files: 1, filesDone: 1, prompts: 2, chats: 1});
    expect(detail.harnesses.find(h => h.harness === 'claude')!.firstAt).toBe(at(0));
  });

  it('keeps quotes, project names and typed lines out of the public story', async () => {
    const {dirs, options, write} = home();
    const rows: unknown[] = [];
    for (let i = 0; i < 40; i++) rows.push(user(`u${i}`, i % 2 ? 'continue' : `PRIVATE-QUOTE synthetic request ${i}`, i * 30), assistant(`m${i}`, i * 30 + 1));
    write(path.join(dirs.claude, 'projects', 'p', 's1.jsonl'), rows);
    const snapshot = await run(options);
    expect(JSON.stringify(snapshot.launch!.story)).toContain('synthetic-app');
    const text = JSON.stringify(publicAuditSnapshot(snapshot).launch!.story);
    expect(text).not.toContain('PRIVATE-QUOTE');
    expect(text).not.toContain('synthetic-app');
  });
});

describe('story enrichment (Jev chooses wording only)', () => {
  const story = (): AuditStory => ({
    version: 'story-v1', state: 'ready', timezone: 'UTC', generatedAt: '', cards: [], suppressed: [], awards: [], coldOpen: null,
    totals: {prompts: 400, sessions: 40, projects: 3, activeDays: 30, firstAt: null, lastAt: null, spanDays: 90, costUsd: 10, subagents: 0, words: 1, longestStreakDays: 7, longestStretchHours: 3, tokens: 1, byHarness: {}},
    rhythm: {hours: [], weekdayHour: [], peakHour: 23, peakWeekday: 2, lateNightDaysPct: 30, weekendPct: 20}, swearTimeline: [],
    models: {rows: [], worst: null, best: null, basis: 'month_matched_observed', top: [], defection: null}, projects: [],
    highlights: {catchphrase: null, petName: null, mostTypedLine: null, mostExpensivePrompt: null, firstPrompt: null, latestPrompt: null, fuse: null, honeymoon: null, gotAway: null},
    archetype: {id: 'night_shift', title: 'The Night Shift', tagline: '', profile: 'local', subRole: null, rarity: 'rare', deciding: [], code: 'NVRK', scores: [], confidence: 0.8, source: 'local'},
    peakTime: {hour: 23, weekday: 2, label: 'Wednesdays around 11pm', narrative: 'local', source: 'local'},
    enrichment: {state: 'not_run', model: null, code: null, quotesSent: 0}, timings: {featuresMs: 0, detectorsMs: 0},
  });
  const rows = Array.from({length: 10}, (_, i) => ({hour: 23, dow: 2, ts: i, f: {w: 10, fl: 0, sw: 0, ins: 0, fr: 0}, month: '2026-01', day: '2026-01-07', angry: false, polite: false, conv: 'c', project: null, model: null, harness: 'codex'}));

  it('normalizes numbers for the fact-sheet check', () => {
    expect(numbersIn('1,234 prompts, 9.50 hours and 42%')).toEqual(['1234', '9.5', '42']);
  });

  it('applies a valid choice and records a transfer notice before sending', async () => {
    let body: {questions: Record<string, {criteria: Record<string, string>}>; state: unknown} | null = null;
    const notices: string[] = [];
    const fetch = (async (_url: string, init: {body: string}) => {
      body = JSON.parse(init.body);
      const answer = (keys: string[]) => ({type: 'choice', choice: keys[1], probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 1 ? 1 : 0])), confidence: 0.9});
      return new Response(JSON.stringify({model: 'jev-1.13-free', answers: {profile: answer(Object.keys(body!.questions.profile!.criteria)), peak: answer(Object.keys(body!.questions.peak!.criteria))}, usage: {input_tokens: 10, output_tokens: 1}}), {status: 200});
    }) as unknown as typeof globalThis.fetch;
    const provider = new FreeJevProvider({route: {kind: 'zen-public'}, fetch, timeoutMs: 8000, beforeDispatch: () => { notices.push('sent'); }});
    const result = await enrichStory(story(), rows as never, provider, {signal: new AbortController().signal, isCurrent: () => true});
    expect(notices).toEqual(['sent']);
    expect(result.state.state).toBe('complete');
    expect(result.story.archetype!.source).toBe('jev');
    expect(result.story.peakTime!.source).toBe('jev');
    expect(JSON.stringify(body!.state)).not.toContain('synthetic request');
  });

  it('keeps the local wording when the provider fails', async () => {
    const fetch = (async () => new Response('nope', {status: 503})) as unknown as typeof globalThis.fetch;
    const provider = new FreeJevProvider({route: {kind: 'zen-public'}, fetch, timeoutMs: 8000});
    const result = await enrichStory(story(), rows as never, provider, {signal: new AbortController().signal, isCurrent: () => true});
    expect(result.state.state).toBe('failed');
    expect(result.story.archetype!.profile).toBe('local');
  });
});

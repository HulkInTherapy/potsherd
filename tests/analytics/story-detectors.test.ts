import {describe, expect, it} from 'vitest';
import {featurize, safeQuote, FLAG, has, TICS, ADDRESS} from '../../packages/core/src/analytics/story-lexicon.js';
import {runDetectors, modelLabel, type DetectorContext} from '../../packages/core/src/analytics/story-detectors.js';
import {assignArchetype} from '../../packages/core/src/analytics/story-archetype.js';
import {buildStory} from '../../packages/core/src/analytics/story.js';
import {typoPairs} from '../../packages/core/src/analytics/story-typos.js';
import {localClock} from '../../packages/core/src/analytics/story-time.js';
import type {StoryRow, StoryTable} from '../../packages/core/src/analytics/story-table.js';

// Synthetic rows only: generated text, placeholder projects, made-up models.
const clock = localClock('UTC');
const DAY = 86_400_000;
const T0 = Date.parse('2026-01-05T10:00:00Z');
interface RowSpec {ts: number; text?: string; conv?: string; project?: string; model?: string | null; harness?: StoryRow['harness']; cost?: number; subs?: number; gap?: number | null; intr?: boolean}
function row(spec: RowSpec, i: number): StoryRow {
  const f = featurize({text: spec.text ?? 'please update the synthetic parser', typed: true});
  const local = clock(spec.ts);
  return {
    id: `p${i}`, conv: spec.conv ?? `c${Math.floor(i / 10)}`, harness: spec.harness ?? 'codex', ts: spec.ts, project: spec.project ?? '/work/synthetic-app',
    model: spec.model === undefined ? 'synthetic-model-a' : spec.model, modelSrc: spec.model === null ? 'none' : 'observed', turn: (i % 10) + 1,
    gapReplyS: spec.gap === undefined ? 300 : spec.gap, gapPromptS: null, intr: spec.intr ?? false, prevIntr: false,
    costUsd: spec.cost ?? 0.5, costTotalUsd: spec.cost ?? 0.5, outTokens: 100, durS: 30, tools: 1, subs: spec.subs ?? 0,
    day: local.day, month: local.month, hour: local.hour, minute: local.minute, dow: local.dow,
    f, q: safeQuote(spec.text ?? 'please update the synthetic parser'), typed: true, angry: f.sw > 0 || f.ins > 0, polite: has(f, FLAG.polite),
  };
}
function table(specs: RowSpec[]): StoryTable {
  const rows = specs.map(row).sort((a, b) => a.ts - b.ts);
  const turns = new Map<string, number>();
  for (const r of rows) { const n = (turns.get(r.conv) ?? 0) + 1; turns.set(r.conv, n); r.turn = n; }
  return {rows, vocab: new Map(), topics: new Map(), sessions: []};
}
const ctx = (t: StoryTable): DetectorContext => ({table: t, rows: t.rows, dictionary: null, alias: () => 'Project A', home: '/home/synthetic'});
const shifted = (ts: number) => clock(ts - 6 * 3_600_000).day;
const fired = (t: StoryTable) => runDetectors(ctx(t), shifted).cards.map(c => c.id);

describe('story features', () => {
  it('counts swears on the head and tail of long pasted transcript text only', () => {
    const filler = Array.from({length: 600}, (_, i) => `word${i % 7 ? 'x' : 'y'}`).join(' ');
    const middle = Array.from({length: 40}, () => 'damn').join(' ');
    const text = `please fix this ${filler} ${middle} ${filler} thanks`;
    const transcript = featurize({text, typed: false});
    expect(has(transcript, FLAG.pasteSuspect)).toBe(true);
    expect(transcript.sw).toBe(0);
    const typed = featurize({text, typed: true});
    expect(has(typed, FLAG.pasteSuspect)).toBe(false);
    expect(typed.sw).toBe(40);
  });

  it('extracts flags, catchphrases, vocative pet names and the short line', () => {
    const f = featurize({text: "hey dude, can you fix the build or something? let's go", typed: true});
    expect(has(f, FLAG.question)).toBe(false);
    expect(has(f, FLAG.lets)).toBe(true);
    expect(f.tc?.map(i => TICS[i])).toEqual(expect.arrayContaining(["let's go"]));
    expect(f.ad?.map(i => ADDRESS[i])).toEqual(['dude']);
    expect(f.sl).toBe("hey dude, can you fix the build or something? let's go");
    expect(featurize({text: 'why is the synthetic test red', typed: true}).fl & FLAG.question).toBeTruthy();
  });

  it('quotes only safe text, masks swears and rejects secrets, paths and sensitive topics', () => {
    expect(safeQuote('this damn build is broken again')).toBe('this d**n build is broken again');
    expect(safeQuote('use key sk-abcdef123456 for the call')).toBeNull();
    expect(safeQuote('open /Users/someone/file.txt')).toBeNull();
    expect(safeQuote('my doctor said rest')).toBeNull();
    const long = safeQuote('word '.repeat(40), 30)!;
    expect(long.length).toBeLessThanOrEqual(30);
    expect(long.endsWith('…')).toBe(true);
  });

  it('labels models readably', () => {
    expect(modelLabel('claude-synth-4-5-20251101')).toBe('Synth 4.5');
    expect(modelLabel('gpt-9-nova')).toBe('GPT-9 Nova');
  });
});

describe('detector guards', () => {
  it('never emits tone cards for a small history', () => {
    const specs = Array.from({length: 60}, (_, i) => ({ts: T0 + i * 3_600_000, text: i % 2 ? 'this damn thing' : 'thanks, please continue'}));
    const ids = fired(table(specs));
    for (const id of ['mood_drift', 'worst_model', 'best_model', 'honeymoon', 'thanks_vs_swears', 'fuse_length', 'rant_length', 'rage_day', 'weekend_self']) expect(ids).not.toContain(id);
  });

  it('returns no cards and an empty story for no prompts', () => {
    const {story} = buildStory({table: table([]), timezone: 'UTC', alias: () => 'Project A', dictionary: null, tokens: 0, offline: true});
    expect(story.state).toBe('empty');
    expect(story.cards).toEqual([]);
    expect(story.archetype).toBeNull();
  });

  it('detects a mood drift with its tipping month', () => {
    const specs: RowSpec[] = [];
    for (let m = 0; m < 6; m++) for (let k = 0; k < 60; k++) {
      const angry = m >= 4 ? k % 4 === 0 : k % 50 === 0;
      specs.push({ts: Date.UTC(2026, m, 2 + (k % 25), 10), text: angry ? 'fix this damn test' : 'update the synthetic docs please'});
    }
    const card = runDetectors(ctx(table(specs)), shifted).cards.find(c => c.id === 'mood_drift')!;
    expect(card).toBeTruthy();
    expect(card.numbers.tipMonth).toBe('2026-05');
    expect(card.chart.highlight).toBe('2026-05');
    expect(card.public?.headline).toMatch(/Swearing went from/);
  });

  it('compares models month-matched, so a grumpy month does not blame a model', () => {
    const specs: RowSpec[] = [];
    // Both models get the same anger rate in every month: no worst model.
    for (let m = 0; m < 4; m++) for (let k = 0; k < 60; k++) specs.push({ts: Date.UTC(2026, m, 2 + (k % 25), 10, k), model: k % 2 ? 'synthetic-model-a' : 'synthetic-model-b', text: (m === 3 && k % 3 === 0) ? 'damn' : 'update the parser'});
    expect(fired(table(specs))).not.toContain('worst_model');
    // Model b draws three times the swearing of model a in the same months.
    const skewed = specs.map((s, i) => ({...s, text: (s.model === 'synthetic-model-b' && i % 4 === 0) || (s.model === 'synthetic-model-a' && i % 12 === 1) ? 'this damn parser' : 'update the parser'}));
    const card = runDetectors(ctx(table(skewed)), shifted).cards.find(c => c.id === 'worst_model');
    expect(card?.numbers.model).toBe('synthetic-model-b');
  });

  it('measures the fuse, the continue habit and the thanks ratio', () => {
    const specs: RowSpec[] = [];
    for (let s = 0; s < 30; s++) for (let t = 0; t < 8; t++) {
      const text = t === 3 ? 'what the f**k, fuck this' : t === 6 ? 'continue' : 'update the synthetic module';
      specs.push({ts: T0 + s * DAY + t * 600_000, conv: `s${s}`, text});
    }
    const cards = runDetectors(ctx(table(specs)), shifted).cards;
    expect(cards.find(c => c.id === 'fuse_length')?.numbers.median_first_swear_turn).toBe(4);
    expect(cards.find(c => c.id === 'continue_count')?.numbers.count).toBe(30);
    expect(cards.find(c => c.id === 'thanks_vs_swears')?.numbers.counted).toBe('f-bombs');
  });

  it('finds the project that got away and keeps its name out of the public wording', () => {
    const specs: RowSpec[] = [];
    for (let k = 0; k < 80; k++) specs.push({ts: T0 + k * 3_600_000, project: '/work/synthetic-lost', text: 'polish the synthetic page'});
    for (let k = 0; k < 40; k++) specs.push({ts: T0 + 100 * DAY + k * 3_600_000, project: '/work/synthetic-new'});
    const card = runDetectors(ctx(table(specs)), shifted).cards.find(c => c.id === 'one_that_got_away')!;
    expect(card.headline).toContain('synthetic-lost');
    expect(card.public!.headline).not.toContain('synthetic-lost');
    expect(card.quote).toBe('polish the synthetic page');
  });

  it('spots a harness switch that stuck', () => {
    const specs: RowSpec[] = [];
    for (let w = 0; w < 14; w++) for (let k = 0; k < 12; k++) specs.push({ts: T0 + w * 7 * DAY + k * 3_600_000, harness: w < 9 ? 'claude' : 'codex'});
    const card = runDetectors(ctx(table(specs)), shifted).cards.find(c => c.id === 'defection')!;
    expect(card.numbers).toMatchObject({from: 'Claude Code', to: 'Codex', sharePct: 100});
  });

  it('ranks cards by score and drops a detector that throws', () => {
    const specs = Array.from({length: 400}, (_, i) => ({ts: T0 + i * 3_600_000 * 5, cost: i === 7 ? 120 : 0.4, text: i === 7 ? 'build the synthetic report' : 'update it'}));
    const {cards} = runDetectors(ctx(table(specs)), shifted);
    expect(cards[0]!.rank).toBe(1);
    for (let i = 1; i < cards.length; i++) expect(cards[i - 1]!.score).toBeGreaterThanOrEqual(cards[i]!.score);
    expect(cards.find(c => c.id === 'most_expensive_sentence')?.quote).toBe('build the synthetic report');
    const broken = {...ctx(table(specs)), get dictionary(): never { throw new Error('boom'); }};
    expect(() => runDetectors(broken as DetectorContext, shifted)).not.toThrow();
  });
});

describe('typo fingerprint', () => {
  it('pairs rare non-words with a frequent word one edit away', () => {
    const dict = new Set(['something', 'business', 'comment', 'happening', 'parser', 'module', 'window', 'between', 'because', 'thing', 'other', 'little']);
    const vocab = new Map<string, number>([['something', 200], ['business', 90], ['comment', 120], ['happening', 80], ['parser', 300], ['module', 150], ['window', 100], ['between', 100], ['because', 400], ['little', 120],
      ['soemthing', 10], ['buisness', 4], ['commnet', 3], ['happenign', 3], ['parsr', 2], ['modlue', 2], ['windwo', 2], ['betwen', 2], ['becuase', 6], ['littel', 2], ['zzqx', 3]]);
    const t = typoPairs(vocab, dict)!;
    expect(t.pairs).toBeGreaterThanOrEqual(10);
    expect(t.top[0]).toMatchObject({typo: 'soemthing', word: 'something', count: 10});
  });
});

describe('archetype', () => {
  it('gives thin histories The Fresh Install', () => {
    const a = assignArchetype(table(Array.from({length: 50}, (_, i) => ({ts: T0 + i * DAY}))).rows);
    expect(a.id).toBe('fresh_install');
    expect(a.subRole).toBeNull();
  });

  it('is deterministic and names three deciding metrics', () => {
    const specs = Array.from({length: 400}, (_, i) => ({ts: Date.UTC(2026, 0, 1 + (i % 90), 23, i % 60), text: 'why does the synthetic parser fail?', model: `synthetic-model-${i % 4}`, project: `/work/synthetic-${i % 3}`}));
    const a = assignArchetype(table(specs).rows), b = assignArchetype(table(specs).rows);
    expect(a).toEqual(b);
    expect(a.deciding).toHaveLength(3);
    expect(['night_shift', 'interrogator']).toContain(a.id);
    expect(a.subRole && ['night_shift', 'interrogator']).toContain(a.subRole!.id);
    expect(a.code[0]).toBe('N');
  });
});

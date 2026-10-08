import { describe, expect, it } from 'vitest';
import { boardData } from '../../packages/cli/src/audit-ui/view-model.js';
import { compact, heroMoney, modelName, money } from '../../packages/cli/src/audit-ui/format.js';
import { readingSnapshot, readySnapshot, startingSnapshot } from './fixture.js';

describe('display facts', () => {
  it('spells model ids the way people say them', () => {
    expect(modelName('anthropic/claude-opus-4-8')).toBe('Claude Opus 4.8');
    expect(modelName('claude-haiku-4-5-20251001')).toBe('Claude Haiku 4.5');
    expect(modelName('anthropic/claude-fable-5-1')).toBe('Claude Fable 5.1');
    expect(modelName('openai/gpt-6.1-sol')).toBe('GPT-6.1 Sol');
    expect(modelName('gemini-2.5-flash')).toBe('Gemini 2.5 Flash');
    expect(modelName(null)).toBe('Unknown model');
  });

  it('formats money and counts compactly, unknown as a dash', () => {
    expect(heroMoney(9238.4)).toBe('$9,238');
    expect(money(3076.39)).toBe('$3,076');
    expect(money(4.81)).toBe('$4.81');
    expect(money(0.001)).toBe('<$0.01');
    expect(money(null)).toBe('—');
    expect(compact(10_507_088_231)).toBe('10.5B');
    expect(compact(605_486_567)).toBe('605M');
    expect(compact(null)).toBe('—');
  });

  it('ranks models by API-equivalent spend and summarises unnamed usage', () => {
    const data = boardData(readySnapshot());
    expect(data.models.rows.map(row => row.name).slice(0, 3)).toEqual(['Claude Opus 5', 'Claude Fable 5', 'GPT-6 Astra']);
    expect(data.models.rows[0]!.favourite).toBe(true);
    expect(data.models.rows.some(row => row.name === 'Unknown model')).toBe(false);
    expect(data.models.more?.models).toBe(1);
    expect(data.hero.value).toBeCloseTo(2933.71 + 5911.11);
  });

  it('never invents a value before one is known', () => {
    const data = boardData(startingSnapshot());
    expect(data.hero.value).toBeNull();
    expect(data.stats).toEqual({ tokens: null, prompts: null, chats: null, projects: null, activeDays: null, streak: null });
    expect(data.models.state).toBe('pending');
    expect(data.loading).toBe(true);
    expect(data.phase).toBe('finding');
  });

  it('marks a running subtotal as provisional', () => {
    const data = boardData(readingSnapshot());
    expect(data.hero).toEqual({ value: 12.5, provisional: true });
    expect(data.progress).toMatchObject({ done: 405, total: 670 });
  });

  it('only ranks reactions with a fair sample and a named model', () => {
    const { reactions } = boardData(readySnapshot());
    expect(reactions.roasted).toEqual({ model: 'Claude Fable 5.1', hits: 3, of: 31 }); // 1/1 is ignored
    expect(reactions.praised).toEqual({ model: 'Claude Opus 4.8', hits: 2, of: 424 });
  });

  it('shows typed repeats only: no tool wrappers, image placeholders or one-offs', () => {
    const { repeats } = boardData(readySnapshot());
    const texts = repeats.rows.map(row => row.text);
    expect(texts).toEqual(['continue', 'What the hell are you doing?', 'continue please', 'this damn page again']);
  });

  it('counts swears in directly typed text only', () => {
    const { swears } = boardData(readySnapshot());
    expect(swears).toMatchObject({ total: 418, prompts: 147, eligible: 4111 });
    expect(swears.top.map(term => term.term)).toEqual(['damn', 'hell']);
  });

  it('finds the busiest day, streak and peak hour in the audit timezone', () => {
    const data = boardData(readySnapshot());
    expect(data.activity.busiest).toEqual({ date: '2026-06-10', count: 119 });
    expect(data.stats.streak).toBe(3);
    expect(data.stats.activeDays).toBe(8);
    // 19:10 UTC is 00:40 in Asia/Kolkata (UTC+5:30).
    expect(data.activity.peakHour).toBe(0);
  });

  it('keeps one plain-English footnote', () => {
    expect(boardData(readySnapshot()).footnote).toBe('API-price estimate, not a bill · ~ closest-model price · some files unreadable');
    const clean = readySnapshot();
    clean.status = 'ready';
    clean.coverage = { ...clean.coverage, state: 'complete_snapshot' };
    clean.launch!.facts!.models = clean.launch!.facts!.models.map(model => ({ ...model, estimated: false }));
    expect(boardData(clean).footnote).toBe('API-price estimate, not a bill');
  });
});

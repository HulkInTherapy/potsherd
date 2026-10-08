/**
 * SYNTHETIC story data for UI tests and pty replays. Every name, phrase and quote here is
 * invented; none of it comes from a real history.
 */
import type { AuditEvent, AuditSnapshot } from '../../packages/core/src/analytics/contracts.js';
import type { AuditProgressDetail, AuditStory, StoryCard } from '../../packages/cli/src/audit-ui/story/types.js';
import { readySnapshot, startingSnapshot } from './fixture.js';

const SECTIONS: Record<string, StoryCard['section']> = {
  most_expensive_sentence: 'bill', mood_drift: 'mood', worst_model: 'best_worst', best_model: 'best_worst', honeymoon: 'manners', thanks_vs_swears: 'manners',
  one_that_got_away: 'projects', continue_count: 'delegation', verbal_tics: 'talk', fuse_length: 'fuse', pet_names: 'talk', defection: 'models', night_owl: 'clock',
  i_to_we: 'talk', rage_day: 'mood', typo_fingerprint: 'talk', first_vs_latest: 'first_latest', orchestrator: 'delegation', marathon: 'more', priciest_project: 'projects',
  walk_away: 'delegation',
};

function card(id: string, kind: StoryCard['kind'], headline: string, support: string, numbers: StoryCard['numbers'], chart: Partial<StoryCard['chart']> = {}, wow = 70): StoryCard {
  return {
    id, kind, section: SECTIONS[id] ?? 'more', headline, support, numbers, wow, confidence: 0.8, surprise: 2, score: wow * 0.8, rank: 0,
    chart: { type: 'bar', series: [], ...chart } as StoryCard['chart'],
    public: { headline: headline.replace(/“[^”]*”/g, '“…”'), support: '' },
  };
}

function weekdayHour(): number[][] {
  // Night-heavy weekdays, slow weekend mornings, a Tuesday 11pm peak.
  return Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => {
    const night = h >= 21 || h <= 2 ? 1 : 0;
    const day = h >= 10 && h <= 17 ? 0.55 : 0;
    const dead = h >= 4 && h <= 8 ? 0 : 0.1;
    const weekend = d >= 5 ? 0.6 : 1;
    const base = (night * 1.0 + day + dead) * weekend * 22;
    const wobble = ((d * 31 + h * 17) % 7) - 3;
    const peak = d === 1 && h === 23 ? 18 : 0;
    return Math.max(0, Math.round(base + wobble + peak));
  }));
}

export function storyOfFixture(): AuditStory {
  const grid = weekdayHour();
  const hours = Array.from({ length: 24 }, (_, h) => grid.reduce((s, row) => s + row[h]!, 0));
  const months = ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
  const pct = [2.1, 2.8, 3.0, 2.4, 3.5, 4.9, 7.8, 11.2, 18.5, 22.0, 24.3];
  const cards: StoryCard[] = [
    card('most_expensive_sentence', 'money', 'Your most expensive sentence: “ok rewrite the whole sync layer but keep the api exactly the same” — $412.', 'One prompt, GPT-6 Sol, Aug 21. That is 330× your median prompt and 6% of all your spend.', { costUsd: 412.37 }, {}, 95),
    card('mood_drift', 'mood', 'You used to be nice. Swearing went from 2.6% of prompts to 23%.', 'Dec–Feb: 2.6%. Last two months: 23% (×9). It tipped in July.', { earlyPct: 2.6, latePct: 23.2, factor: 9, tipMonth: '2026-07' }, { type: 'line', highlight: '2026-07' }, 90),
    card('worst_model', 'model', 'GPT-6 Sol brings out the worst in you.', '19.5 swears per 100 prompts, 2× what the other models got from you in the same weeks.', {}, {}, 85),
    card('best_model', 'model', 'Claude Fable 5 gets your nicest side.', '7.9 thank-yous per 100 prompts, 2.4× the others in the same weeks.', {}, {}, 80),
    card('honeymoon', 'model', 'The honeymoon with GPT-6 Sol lasted three weeks.', 'First 21 days: 12% polite, 4% swearing. After: 3% polite, 21% swearing.', {}, { type: 'slope', series: [{ name: 'polite', points: [{ x: 'first 21 days', y: 12 }, { x: 'after', y: 3 }] }, { name: 'swearing', points: [{ x: 'first 21 days', y: 4 }, { x: 'after', y: 21 }] }] }, 85),
    card('thanks_vs_swears', 'mood', 'For every “thank you”, 6 f-bombs.', '22 thank-yous and 41 pleases in 2,904 prompts. 131 f-bombs.', { thanks: 22, pleases: 41, fbombs: 131, prompts: 2904, ratio: 6 }, { type: 'balance' }, 80),
    card('one_that_got_away', 'project', 'The one that got away: paper-boats.', '233 prompts over 16 days, then nothing for 88 days.', {}, {}, 80),
    card('continue_count', 'language', 'You’ve typed “keep going” 64 times.', '118 nudges in total, typically 41 min after the agent last spoke.', { word: 'keep going', count: 64, total: 118, gapLabel: '41 min' }, {}, 75),
    card('verbal_tics', 'language', 'Your catchphrase is “real quick”. You’ve said it 212 times.', 'Runners-up: “for now” ×98, “just to be safe” ×61.', {}, {}, 75),
    card('fuse_length', 'mood', 'Your fuse is 6 prompts long.', 'In sessions where you snap (48 of 102), the first swear lands at prompt #6. 7 times you came in swinging on prompt #1.', {},
      { type: 'histogram', motif: 'fuse', series: [{ name: 'sessions', points: [7, 4, 5, 6, 5, 6, 3, 3, 2, 2, 1, 1, 1, 0, 1, 0, 0, 1, 0, 0].map((y, i) => ({ x: i + 1, y })) }] }, 75),
    card('pet_names', 'language', 'You call your coding agent “buddy”. 37 times, so far.', 'Also: “chief” ×12, “my guy” ×9.', {}, {}, 70),
    card('defection', 'model', 'You left Claude Code for Codex the week of Aug 10.', '9 straight weeks of Claude Code, then 81% of everything since went to Codex.', { from: 'Claude Code', to: 'Codex', week: '2026-08-10', weeks: 9, sharePct: 81 }, {}, 70),
    card('night_owl', 'time', '38% of your days end after 1am.', '11pm is your angriest hour (14% of prompts swear). 9am you is a saint (0 of 58).', { lateNightPct: 38, angriestHour: 23, angriestPct: 14, calmestHour: 9, calmestSwears: 0, calmestPrompts: 58 }, { type: 'heatmap7x24' }, 70),
    card('i_to_we', 'language', 'You stopped saying “I” and started saying “we”.', '“we” per “I”: 0.41 in your first months, 1.37 now.', { earlyRatio: 0.41, lateRatio: 1.37, letsNowPct: 24, letsThenPct: 3 }, {}, 70),
    card('rage_day', 'mood', 'September 14 was a bad day for tidepool.', '44 swear words in 29 prompts, mostly at GPT-6 Sol, between 10pm and 3am.', { day: '2026-09-14', swears: 44, prompts: 29, model: 'GPT-6 Sol' }, { type: 'calendar' }, 70),
    card('typo_fingerprint', 'trivia', 'You’ve typed “teh” 14 times. It’s “the”.', 'Also “recieve”, “seperate”, “funciton”.', { typo: 'funciton', word: 'function', count: 14 }, { type: 'keyboard' }, 60),
    card('first_vs_latest', 'growth', 'Your prompts grew up.', 'Dec 2, 2025: 11 words. 310 days and 2,904 prompts later, your latest ran to 412 words.', {}, { type: 'two_bubbles' }, 60),
    card('orchestrator', 'growth', 'You went from typing to managing: 266 subagents launched.', 'Zero before May (1,210 prompts of doing it yourself). Peak: Aug, 88.', { total: 266, firstMonth: '2026-05', promptsBefore: 1210, peakMonth: '2026-08', peakCount: 88 },
      { type: 'bar', series: [{ name: 'subagents', points: months.map((x, i) => ({ x, y: [0, 0, 0, 0, 0, 9, 31, 52, 88, 61, 25][i]! })) }] }, 60),
    card('marathon', 'time', 'Longest unbroken stretch: 7.5 hours.', 'Jun 3, 9:40pm → 5:10am, 71 prompts.', { hours: 7.5, day: '2026-06-03', prompts: 71 }, { type: 'sparkline' }, 55),
    card('priciest_project', 'money', 'Every prompt in tidepool costs $9.80.', 'That is 14× lantern-api ($0.70/prompt).', { project: 'tidepool', costPerPrompt: 9.8, factor: 14 }, {}, 55),
    card('walk_away', 'habit', 'You don’t babysit. You come back 6 minutes after the agent finishes.', 'Questions come back faster: 3 minutes.', {}, { type: 'histogram', series: [{ name: 'gaps', points: [{ x: '<30s', y: 120 }, { x: '1m', y: 260 }, { x: '3m', y: 410 }, { x: '6m', y: 520 }, { x: '15m', y: 330 }, { x: '1h', y: 140 }, { x: '4h+', y: 60 }] }], highlight: '6m' }, 50),
  ];
  cards.forEach((c, i) => { c.rank = i + 1; });
  return {
    version: 'story-v1', state: 'ready', timezone: 'Europe/Lisbon', generatedAt: '2026-10-08T22:00:00Z',
    totals: {
      prompts: 2904, sessions: 388, projects: 41, activeDays: 176, firstAt: '2025-12-02T21:14:00Z', lastAt: '2026-10-08T23:02:00Z', spanDays: 310,
      costUsd: 6412.5, subagents: 266, words: 182400, longestStreakDays: 23, longestStretchHours: 7.5, tokens: 8_412_000_000, byHarness: { claude: 1900, claude_hist: 500, codex: 480, pi: 24 },
    },
    rhythm: { hours, weekdayHour: grid, peakHour: 23, peakWeekday: 1, lateNightDaysPct: 38, weekendPct: 17 },
    swearTimeline: months.map((month, i) => ({ month, prompts: 180 + i * 20, swearing: Math.round((180 + i * 20) * pct[i]! / 100), swearPct: pct[i]!, politePct: Math.max(1, 9 - i * 0.7) })),
    models: {
      rows: [
        { model: 'anthropic/claude-opus-5', label: 'Claude Opus 5', prompts: 820, swearPer100: 6.1, praisePer100: 4.4, expectedSwearPer100: 7.0, expectedPraisePer100: 4.0, swearRatio: 0.9, praiseRatio: 1.1, matchedMonths: 6 },
        { model: 'openai/gpt-6-sol', label: 'GPT-6 Sol', prompts: 410, swearPer100: 19.5, praisePer100: 1.2, expectedSwearPer100: 9.8, expectedPraisePer100: 3.9, swearRatio: 1.95, praiseRatio: 0.4, matchedMonths: 4 },
        { model: 'anthropic/claude-fable-5', label: 'Claude Fable 5', prompts: 300, swearPer100: 3.0, praisePer100: 7.9, expectedSwearPer100: 6.2, expectedPraisePer100: 3.1, swearRatio: 0.5, praiseRatio: 2.4, matchedMonths: 3 },
      ],
      worst: null, best: null, basis: 'month_matched_observed',
      top: [
        { model: 'anthropic/claude-opus-5', label: 'Claude Opus 5', prompts: 1240, sharePct: 46 },
        { model: 'openai/gpt-6-sol', label: 'GPT-6 Sol', prompts: 610, sharePct: 23 },
        { model: 'anthropic/claude-fable-5', label: 'Claude Fable 5', prompts: 480, sharePct: 18 },
        { model: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol', prompts: 350, sharePct: 13 },
      ],
      defection: { from: 'Claude Code', to: 'Codex', week: '2026-W32', weekStart: '2026-08-10', priorWeeks: 9, shareSincePct: 81 },
    },
    projects: [
      { id: 'p1', alias: 'Project A', name: 'lantern-api', prompts: 690, costUsd: 480, costPerPrompt: 0.7, firstDay: '2025-12-02', lastDay: '2026-10-08', activeDays: 120, idleDays: 0 },
      { id: 'p2', alias: 'Project B', name: 'tidepool', prompts: 325, costUsd: 3185, costPerPrompt: 9.8, firstDay: '2026-03-01', lastDay: '2026-10-01', activeDays: 60, idleDays: 7 },
      { id: 'p3', alias: 'Project C', name: 'paper-boats', prompts: 233, costUsd: 410, costPerPrompt: 1.76, firstDay: '2026-06-26', lastDay: '2026-07-12', activeDays: 16, idleDays: 88 },
      { id: 'p4', alias: 'Project D', name: 'pocket-garden', prompts: 198, costUsd: 260, costPerPrompt: 1.31, firstDay: '2026-01-10', lastDay: '2026-09-30', activeDays: 40, idleDays: 8 },
      { id: 'p5', alias: 'Project E', name: 'moth-radio', prompts: 140, costUsd: 120, costPerPrompt: 0.86, firstDay: '2026-02-01', lastDay: '2026-08-30', activeDays: 22, idleDays: 39 },
      { id: 'p6', alias: 'Project F', name: 'quiet-ledger', prompts: 96, costUsd: 88, costPerPrompt: 0.92, firstDay: '2026-04-11', lastDay: '2026-09-02', activeDays: 15, idleDays: 36 },
    ],
    highlights: {
      catchphrase: { phrase: 'real quick', count: 212, runnersUp: [{ phrase: 'for now', count: 98 }, { phrase: 'just to be safe', count: 61 }] },
      petName: { term: 'buddy', count: 37, others: [{ term: 'chief', count: 12 }, { term: 'my guy', count: 9 }] },
      mostTypedLine: { text: 'keep going', count: 64 },
      mostExpensivePrompt: { costUsd: 412.37, quote: 'ok rewrite the whole sync layer but keep the api exactly the same', model: 'openai/gpt-6-sol', day: '2026-08-21', project: 'tidepool', timesMedian: 330, sharePct: 6.4 },
      firstPrompt: { day: '2025-12-02', words: 11, quote: 'can you explain what this regex does, line by line', shellCommand: false },
      latestPrompt: { day: '2026-10-08', words: 412, quote: 'ok final pass: tighten the loading screen and ship it' },
      fuse: { medianTurn: 6, sessions: 48, ofSessions: 102, firstPromptSwears: 7 },
      honeymoon: { model: 'openai/gpt-6-sol', label: 'GPT-6 Sol', politeEarlyPct: 12, politeLatePct: 3, swearEarlyPct: 4, swearLatePct: 21, firstDay: '2026-07-20' },
      gotAway: { project: 'paper-boats', prompts: 233, activeDays: 16, idleDays: 88, lastDay: '2026-07-12', lastWords: "leave the tests for tomorrow, we're close" },
    },
    cards,
    suppressed: [{ id: 'day_night_topics', reason: 'guard' }],
    archetype: {
      id: 'night_shift', title: 'The Night Shift Architect', tagline: "your best ideas show up after the dishwasher's done",
      profile: "This year you've been writing specs, not prompts, and writing them at 1am. The house is quiet; the agents are not.",
      subRole: { id: 'architect', title: 'The Architect', label: 'with a streak of The Architect' }, rarity: 'epic',
      deciding: [
        { key: 'night', label: 'prompts after 10pm', value: 41, unit: 'pct', display: '41% after 10pm', band: 0.86 },
        { key: 'len', label: 'median prompt', value: 64, unit: 'words', display: '64-word median prompt', band: 0.72 },
        { key: 'agents', label: 'agents', value: 3, unit: 'count', display: '3 agents, 9 models', band: 0.55 },
      ],
      code: 'NSRH',
      scores: [{ id: 'night_shift', title: 'The Night Shift', score: 0.82 }, { id: 'architect', title: 'The Architect', score: 0.71 }, { id: 'sommelier', title: 'The Model Sommelier', score: 0.55 }],
      confidence: 0.78, source: 'local',
    },
    awards: [
      { id: 'most_expensive_sentence', title: 'Priciest sentence', receipt: '$412, Aug 21', publicReceipt: '$412, Aug 21' },
      { id: 'marathon', title: 'Longest session', receipt: '7.5h without a break, Jun 3', publicReceipt: '7.5h without a break, Jun 3' },
      { id: 'rage_day', title: 'Worst day', receipt: 'Sep 14: 44 swear words', publicReceipt: 'Sep 14: 44 swear words' },
      { id: 'streak', title: 'Longest streak', receipt: '23 days in a row, Aug 2–24', publicReceipt: '23 days in a row, Aug 2–24' },
      { id: 'pet_names', title: 'Pet name', receipt: '“buddy”, 37 times', publicReceipt: '37 times' },
      { id: 'orchestrator', title: 'Middle manager', receipt: '266 subagents launched', publicReceipt: '266 subagents launched' },
    ],
    coldOpen: { quote: 'ok rewrite the whole sync layer but keep the api exactly the same', at: '2026-08-21T23:41:00Z', day: '2026-08-21', hour: 23, why: 'most_expensive' },
    peakTime: { hour: 23, weekday: 1, label: 'Tuesdays around 11pm', narrative: 'Most of your best work lands late on Tuesdays, when the house is quiet.', source: 'local' },
    enrichment: { state: 'offline', model: null, code: null, quotesSent: 0 },
    timings: { featuresMs: 10, detectorsMs: 5 },
  };
}

export function storySnapshot(): AuditSnapshot {
  const base = readySnapshot();
  const story = storyOfFixture();
  story.models.worst = story.models.rows[1]!;
  story.models.best = story.models.rows[2]!;
  return {
    ...base,
    status: 'complete' as AuditSnapshot['status'],
    launch: { ...base.launch!, facts: { ...base.launch!.facts!, costByHarness: { claude: 4100.4, codex: 2290.1, pi: 21.9 } }, story } as AuditSnapshot['launch'],
  };
}

const HARNESSES = ['claude', 'codex', 'pi', 'opencode'] as const;

/** A replayable recording: harnesses are discovered one by one, then counts climb, then the story lands. */
export function storyRecording(): { kind: 'slopie-audit-recording'; version: 1; initial: AuditSnapshot; events: { at: number; event: AuditEvent }[]; final: AuditSnapshot } {
  const start = startingSnapshot();
  const final = { ...storySnapshot(), sequence: 200 };
  const events: { at: number; event: AuditEvent }[] = [];
  const files = { claude: 432, codex: 234, pi: 9, opencode: 0 };
  const since: Record<string, string> = { claude: '2025-12-02T21:14:00Z', codex: '2026-04-20T10:00:00Z', pi: '2026-09-01T09:00:00Z' };
  let seq = 1;
  const push = (at: number, stage: AuditProgressDetail['stage'], found: number, frac: number) => {
    const chats = { claude: 300, codex: 80, pi: 8, opencode: 0 };
    const prompts = { claude: 2400, codex: 480, pi: 24, opencode: 0 };
    const harnesses = HARNESSES.map((h, i) => ({
      harness: h, files: i < found ? files[h] : 0, bytes: i < found ? files[h] * 90_000 : 0, filesDone: i < found ? Math.round(files[h] * frac) : 0,
      firstAt: frac > 0 && files[h] ? since[h]! : null, lastAt: frac > 0 && files[h] ? '2026-10-08T23:02:00Z' : null,
      discovered: i < found, absent: i < found && files[h] === 0, chats: Math.round(chats[h] * frac), prompts: Math.round(prompts[h] * frac),
    }));
    const totalFiles = harnesses.reduce((s, h) => s + h.files, 0);
    const detail: AuditProgressDetail = {
      stage, harnesses,
      counts: { files: totalFiles, filesDone: Math.round(totalFiles * frac), bytes: totalFiles * 90_000, bytesDone: Math.round(totalFiles * 90_000 * frac), messages: Math.round(48_169 * frac), chats: Math.round(388 * frac), prompts: Math.round(2904 * frac) },
      elapsedMs: at,
    };
    const sources = start.sources.map(source => {
      const index = HARNESSES.indexOf(source.harness as typeof HARNESSES[number]);
      if (index >= found) return source;
      const ready = final.sources.find(s => s.harness === source.harness) ?? source;
      return ready;
    });
    const progress = { ...start.progress, stage: (stage === 'discovering' ? 'discovering' : 'parsing') as AuditSnapshot['progress']['stage'], completed: detail.counts.filesDone, total: totalFiles, detail };
    events.push({ at, event: { type: 'progress', snapshotId: start.snapshotId, sequence: seq++, progress, sources } as AuditEvent });
  };
  push(80, 'discovering', 0, 0);
  push(260, 'discovering', 1, 0);
  push(520, 'discovering', 2, 0);
  push(760, 'discovering', 3, 0);
  push(940, 'discovering', 4, 0);
  for (let i = 1; i <= 12; i++) push(940 + i * 90, 'reading', 4, i / 12);
  push(2100, 'aggregating', 4, 1);
  push(2300, 'detecting', 4, 1);
  return { kind: 'slopie-audit-recording', version: 1, initial: start, events, final };
}

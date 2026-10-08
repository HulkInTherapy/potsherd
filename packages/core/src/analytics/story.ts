/**
 * Builds `launch.story` from the feature table: detectors, rhythm, model
 * moods, projects, highlights, awards, cold open, archetype and peak time.
 */
import type {AuditStory, StoryAward, StoryHarness, StoryHighlights, StoryModelMood, StoryPeakTime, StoryProject} from './story-contracts.js';
import {STORY_VERSION} from './story-contracts.js';
import type {StoryRow, StoryTable} from './story-table.js';
import {runDetectors, modelComparison, modelLabel, base, median, pct, defectionOf, lateNight, longestStreak, longestStretch, homeDir, type Draft} from './story-detectors.js';
import {assignArchetype} from './story-archetype.js';
import {TICS, maskLine} from './story-lexicon.js';
import {HOUR_NAME, WEEKDAY_NAMES, dayName, daysBetween, localClock, monthName} from './story-time.js';
import type {WordSet} from './story-typos.js';

export interface StoryInput {
  table: StoryTable;
  timezone: string;
  /** Project path -> public alias ('Project A'). */
  alias: (project: string | null) => string;
  dictionary: WordSet | null;
  /** Total tokens from the usage summary (scale card). */
  tokens: number;
  offline: boolean;
  now?: Date;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

export function buildStory(input: StoryInput): {story: AuditStory; detectorsMs: number} {
  const rows = input.table.rows;
  const clock = localClock(input.timezone);
  const shifted = (ts: number) => clock(ts - 6 * 3_600_000).day;
  const t0 = performance.now();
  const ctx = {table: input.table, rows, dictionary: input.dictionary, alias: input.alias, home: homeDir()};
  const {cards, suppressed, drafts, ms} = runDetectors(ctx, shifted);
  const story: AuditStory = {
    version: STORY_VERSION,
    state: rows.length === 0 ? 'empty' : rows.length < 200 ? 'thin' : 'ready',
    timezone: input.timezone, generatedAt: (input.now ?? new Date()).toISOString(),
    totals: totals(rows, input.tokens),
    rhythm: rhythm(rows, shifted),
    swearTimeline: swearTimeline(rows),
    models: models(rows),
    projects: projects(rows, input.alias),
    highlights: highlights(rows, drafts),
    cards, suppressed,
    archetype: rows.length ? assignArchetype(rows, 0) : null,
    awards: awards(rows, drafts),
    coldOpen: coldOpen(rows),
    peakTime: peakTime(rows),
    enrichment: {state: input.offline ? 'offline' : 'not_run', model: null, code: null, quotesSent: 0},
    timings: {featuresMs: 0, detectorsMs: 0, byDetector: ms},
  };
  const detectorsMs = Math.round((performance.now() - t0) * 10) / 10;
  story.timings.detectorsMs = detectorsMs;
  return {story, detectorsMs};
}

function totals(rows: readonly StoryRow[], tokens: number): AuditStory['totals'] {
  const byHarness: Partial<Record<StoryHarness, number>> = {};
  for (const r of rows) byHarness[r.harness] = (byHarness[r.harness] ?? 0) + 1;
  const first = rows[0], last = rows.at(-1);
  const stretch = longestStretch(rows);
  return {
    prompts: rows.length, sessions: new Set(rows.map(r => r.conv)).size, projects: new Set(rows.filter(r => r.project).map(r => r.project)).size,
    activeDays: new Set(rows.map(r => r.day)).size,
    firstAt: first ? new Date(first.ts).toISOString() : null, lastAt: last ? new Date(last.ts).toISOString() : null,
    spanDays: first && last ? daysBetween(first.day, last.day) : 0,
    costUsd: r2(rows.reduce((n, r) => n + (r.costTotalUsd ?? 0), 0)),
    subagents: rows.reduce((n, r) => n + (r.subs ?? 0), 0), words: rows.reduce((n, r) => n + r.f.w, 0),
    longestStreakDays: longestStreak(rows)?.days ?? 0, longestStretchHours: stretch ? r1(stretch.ms / 3_600_000) : 0, tokens, byHarness,
  };
}

function rhythm(rows: readonly StoryRow[], shifted: (ts: number) => string): AuditStory['rhythm'] {
  const hours = new Array(24).fill(0) as number[];
  const grid = Array.from({length: 7}, () => new Array(24).fill(0) as number[]);
  const dows = new Array(7).fill(0) as number[];
  for (const r of rows) { hours[r.hour]!++; grid[r.dow]![r.hour]!++; dows[r.dow]!++; }
  const {days, late} = lateNight(rows, shifted);
  return {
    hours, weekdayHour: grid,
    peakHour: rows.length ? hours.indexOf(Math.max(...hours)) : null,
    peakWeekday: rows.length ? dows.indexOf(Math.max(...dows)) : null,
    lateNightDaysPct: days >= 7 ? r1(pct(late, days)) : null,
    weekendPct: rows.length ? r1(pct(dows[5]! + dows[6]!, rows.length)) : null,
  };
}

function swearTimeline(rows: readonly StoryRow[]): AuditStory['swearTimeline'] {
  const M = new Map<string, [number, number, number]>();
  for (const r of rows) { const m = M.get(r.month) ?? [0, 0, 0]; m[0]++; if (r.angry) m[1]++; if (r.polite) m[2]++; M.set(r.month, m); }
  return [...M].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([month, [n, s, p]]) => ({month, prompts: n, swearing: s, swearPct: r1(pct(s, n)), politePct: r1(pct(p, n))}));
}

function models(rows: readonly StoryRow[]): AuditStory['models'] {
  const angry = modelComparison(rows, r => r.angry), polite = modelComparison(rows, r => r.polite);
  const observed = new Map<string, StoryRow[]>();
  for (const r of rows) if (r.model && r.modelSrc === 'observed') { const l = observed.get(r.model) ?? []; l.push(r); observed.set(r.model, l); }
  const moods: StoryModelMood[] = [...observed].filter(([, rs]) => rs.length >= 15).map(([model, rs]) => {
    const a = angry.get(model), p = polite.get(model);
    return {
      model, label: modelLabel(model), prompts: rs.length,
      swearPer100: r1(pct(rs.filter(r => r.angry).length, rs.length)), praisePer100: r1(pct(rs.filter(r => r.polite).length, rs.length)),
      expectedSwearPer100: a ? r1(pct(a.exp, a.n)) : null, expectedPraisePer100: p ? r1(pct(p.exp, p.n)) : null,
      swearRatio: a && a.n >= 40 && a.exp > 0 ? r2((a.obs + 1) / (a.exp + 1)) : null, praiseRatio: p && p.n >= 40 && p.exp > 0 ? r2((p.obs + 1) / (p.exp + 1)) : null,
      matchedMonths: a?.months ?? 0,
    };
  }).sort((x, y) => y.prompts - x.prompts);
  const comparable = moods.filter(m => m.swearRatio !== null);
  const worstC = comparable.length >= 2 && rows.length >= 200 ? comparable.reduce((a, b) => (b.swearRatio! > a.swearRatio! ? b : a)) : null;
  const worst = worstC && worstC.swearRatio! >= 1.3 ? worstC : null;
  const praiseC = moods.filter(m => m.praiseRatio !== null && m.model !== worst?.model);
  const bestC = praiseC.length >= 2 && rows.length >= 200 ? praiseC.reduce((a, b) => (b.praiseRatio! > a.praiseRatio! ? b : a)) : null;
  const counts = new Map<string, number>();
  for (const r of rows) if (r.model) counts.set(r.model, (counts.get(r.model) ?? 0) + 1);
  const known = [...counts.values()].reduce((a, b) => a + b, 0);
  const d = defectionOf(rows);
  return {
    rows: moods, basis: 'month_matched_observed',
    worst,
    best: bestC && bestC.praiseRatio! >= 1.3 ? bestC : null,
    top: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([model, n]) => ({model, label: modelLabel(model), prompts: n, sharePct: r1(pct(n, known))})),
    defection: d ? {from: d.from, to: d.to, week: d.week, weekStart: d.weekStart, priorWeeks: d.priorWeeks, shareSincePct: d.shareSincePct} : null,
  };
}

function projects(rows: readonly StoryRow[], alias: (p: string | null) => string): StoryProject[] {
  const last = rows.at(-1)?.day ?? '';
  const P = new Map<string, StoryRow[]>();
  for (const r of rows) if (r.project) { const l = P.get(r.project) ?? []; l.push(r); P.set(r.project, l); }
  return [...P].sort((a, b) => b[1].length - a[1].length).slice(0, 12).map(([p, rs]) => {
    const priced = rs.filter(r => r.costTotalUsd !== null);
    const cost = priced.reduce((n, r) => n + r.costTotalUsd!, 0);
    return {
      id: p, alias: alias(p), name: base(p), prompts: rs.length, costUsd: r2(cost), costPerPrompt: priced.length >= 10 ? r2(cost / priced.length) : null,
      firstDay: rs[0]!.day, lastDay: rs.at(-1)!.day, activeDays: new Set(rs.map(r => r.day)).size, idleDays: daysBetween(rs.at(-1)!.day, last),
    };
  });
}

const num = (d: Draft | undefined, k: string) => (d ? d.numbers[k] : undefined);
function highlights(rows: readonly StoryRow[], drafts: Map<string, Draft>): StoryHighlights {
  // Catchphrase: same ranking as the verbal-tics card, available from 100 prompts.
  const n = rows.length;
  const tics = new Map<number, number>();
  for (const r of rows) for (const k of r.f.tc ?? []) tics.set(k, (tics.get(k) ?? 0) + 1);
  const PRIOR: Record<string, number> = {};
  const ranked = [...tics].filter(([, v]) => v >= Math.max(5, n * 0.01)).map(([k, v]) => ({phrase: TICS[k]!, count: v, s: v / (PRIOR[TICS[k]!] ?? 1)})).sort((a, b) => b.count - a.count);
  const tic = drafts.get('verbal_tics');
  const catchphrase = tic ? (() => { const e = Object.entries(tic.numbers) as [string, number][]; return {phrase: e[0]![0], count: e[0]![1], runnersUp: e.slice(1).map(([phrase, count]) => ({phrase, count}))}; })()
    : n >= 100 && ranked.length ? {phrase: ranked[0]!.phrase, count: ranked[0]!.count, runnersUp: ranked.slice(1, 3).map(({phrase, count}) => ({phrase, count}))} : null;
  const pet = drafts.get('pet_names');
  const petName = pet ? (() => { const e = Object.entries(pet.numbers) as [string, number][]; return {term: e[0]![0], count: e[0]![1], others: e.slice(1, 4).map(([term, count]) => ({term, count}))}; })() : null;
  const lines = new Map<string, number>();
  for (const r of rows) if (r.f.sl && r.f.sl.replace(/[^\p{L}\p{N}]/gu, '').length >= 2) lines.set(r.f.sl, (lines.get(r.f.sl) ?? 0) + 1);
  const topLine = [...lines].sort((a, b) => b[1] - a[1])[0];
  const exp = drafts.get('most_expensive_sentence');
  const first = rows[0], latest = rows.at(-1);
  const fuse = drafts.get('fuse_length'), honey = drafts.get('honeymoon'), away = drafts.get('one_that_got_away');
  const short = (q: string | null | undefined, max: number) => (q ? (q.length <= max ? q : q.slice(0, max - 1).replace(/\s+\S*$/, '') + '…') : null);
  return {
    catchphrase, petName,
    mostTypedLine: topLine && topLine[1] >= 3 ? {text: maskLine(topLine[0]), count: topLine[1]} : null,
    mostExpensivePrompt: exp ? {costUsd: num(exp, 'cost_usd') as number, quote: exp.quote ?? null, model: (num(exp, 'model') as string | null) ?? null, day: num(exp, 'day') as string,
      project: (num(exp, 'project') as string) ?? null, timesMedian: num(exp, 'times_median') as number, sharePct: num(exp, 'share_pct') as number} : null,
    firstPrompt: first ? {day: first.day, words: first.f.w, quote: short(first.q, 60), shellCommand: num(drafts.get('first_vs_latest'), 'first_is_shell_command') === true} : null,
    latestPrompt: latest && latest !== first ? {day: latest.day, words: latest.f.w, quote: short(latest.q, 60)} : null,
    fuse: fuse ? {medianTurn: num(fuse, 'median_first_swear_turn') as number, sessions: num(fuse, 'sessions_with_swear') as number, ofSessions: num(fuse, 'sessions_5plus') as number, firstPromptSwears: num(fuse, 'first_prompt_swears') as number} : null,
    honeymoon: honey ? {model: num(honey, 'model') as string, label: modelLabel(num(honey, 'model') as string), politeEarlyPct: num(honey, 'polite_early') as number, politeLatePct: num(honey, 'polite_late') as number,
      swearEarlyPct: num(honey, 'swear_early') as number, swearLatePct: num(honey, 'swear_late') as number, firstDay: num(honey, 'first_day') as string} : null,
    gotAway: away ? {project: num(away, 'project') as string, prompts: num(away, 'prompts') as number, activeDays: num(away, 'active_days') as number, idleDays: num(away, 'idle_days') as number,
      lastDay: num(away, 'last_day') as string, lastWords: away.quote ?? null} : null,
  };
}

function awards(rows: readonly StoryRow[], drafts: Map<string, Draft>): StoryAward[] {
  const out: StoryAward[] = [];
  const add = (id: string, title: string, receipt: string, publicReceipt = receipt) => { if (out.length < 6) out.push({id, title, receipt, publicReceipt}); };
  const exp = drafts.get('most_expensive_sentence');
  if (exp) add('priciest_sentence', 'Most expensive sentence', `$${Math.round(num(exp, 'cost_usd') as number).toLocaleString('en-US')}, ${dayName(num(exp, 'day') as string)}`);
  const stretch = longestStretch(rows);
  if (stretch && stretch.ms >= 3 * 3_600_000) add('marathon', 'Marathon', `${(stretch.ms / 3_600_000).toFixed(1)}h without a break, ${dayName(stretch.start.day)}`);
  const s = longestStreak(rows);
  if (s && s.days >= 5) add('streak', 'Streak', `${s.days} days in a row, ${dayName(s.start)}–${dayName(s.end)}`);
  const night = drafts.get('night_owl');
  if (night && (num(night, 'days_ending_after_1am_pct') as number) >= 20) add('night_owl', 'Night Owl', `${Math.round(num(night, 'days_ending_after_1am_pct') as number)}% of days end after 1am`);
  const months = swearTimeline(rows).filter(m => m.prompts >= 40 && m.swearing >= 5);
  if (rows.length >= 200 && months.length) { const m = months.reduce((a, b) => (b.swearPct > a.swearPct ? b : a)); add('swear_month', 'Swear of the month', `${monthName(m.month)}: ${m.swearPct.toFixed(0)}% of prompts swore`); }
  const subs = rows.reduce((n, r) => n + (r.subs ?? 0), 0);
  if (subs >= 30) add('orchestrator', 'Orchestrator', `${subs.toLocaleString('en-US')} subagents launched`);
  const agents = new Set(rows.map(r => (r.harness.startsWith('claude') ? 'claude' : r.harness))).size;
  if (agents >= 2) add('polyglot', 'Polyglot', `${agents} coding agents`);
  const longest = rows.reduce<StoryRow | null>((a, r) => (!a || r.f.w > a.f.w ? r : a), null);
  if (longest && longest.f.w >= 200) add('longest_prompt', 'Longest prompt', `${longest.f.w.toLocaleString('en-US')} words, ${dayName(longest.day)}`);
  return out;
}

function coldOpen(rows: readonly StoryRow[]): AuditStory['coldOpen'] {
  const pick = (r: StoryRow, why: NonNullable<AuditStory['coldOpen']>['why']) => ({quote: r.q!.length > 90 ? r.q!.slice(0, 89) + '…' : r.q!, at: new Date(r.ts).toISOString(), day: r.day, hour: r.hour, why});
  const late = rows.filter(r => r.q && r.hour >= 1 && r.hour < 5 && r.f.w >= 3);
  if (late.length) return pick(late.at(-1)!, 'late_night');
  const priced = rows.filter(r => r.q && (r.costTotalUsd ?? 0) > 0).sort((a, b) => b.costTotalUsd! - a.costTotalUsd!);
  if (priced.length) return pick(priced[0]!, 'most_expensive');
  if (rows[0]?.q) return pick(rows[0], 'first_prompt');
  const any = [...rows].reverse().find(r => r.q);
  return any ? pick(any, 'last_words') : null;
}

function peakTime(rows: readonly StoryRow[]): StoryPeakTime | null {
  if (rows.length < 50) return null;
  const hours = new Array(24).fill(0) as number[], dows = new Array(7).fill(0) as number[];
  for (const r of rows) { hours[r.hour]!++; dows[r.dow]!++; }
  const hour = hours.indexOf(Math.max(...hours)), dow = dows.indexOf(Math.max(...dows));
  const label = `${WEEKDAY_NAMES[dow]}s around ${HOUR_NAME(hour)}`;
  return {hour, weekday: dow, label, narrative: peakNarratives(label, hour, pct(hours[hour]!, rows.length), pct(dows[dow]!, rows.length))[0]!, source: 'local'};
}

/** Local narrative variants (Jev may only choose among these). */
export function peakNarratives(label: string, hour: number, hourShare: number, dayShare: number): string[] {
  const h = hourShare.toFixed(0), d = dayShare.toFixed(0), at = HOUR_NAME(hour), day = label.split('s around')[0]!;
  const mood = hour >= 22 || hour < 5 ? 'when the house is quiet' : hour < 9 ? 'before the day gets loud' : hour < 13 ? 'with the first coffee still warm' : hour < 18 ? 'in the long afternoon' : 'after dinner';
  return [
    `Your clock peaks at ${at}: ${h}% of everything you typed landed in that hour. ${day} is your busiest day (${d}%).`,
    `${at}, ${mood}. That's your hour: ${h}% of your prompts. And ${day}s carry ${d}% of your week.`,
    `If your agent had office hours, they'd be ${label}. ${h}% of your prompts arrive at ${at}, ${d}% on ${day}s.`,
  ];
}

export {median};

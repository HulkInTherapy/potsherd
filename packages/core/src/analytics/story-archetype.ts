/**
 * Deterministic developer archetype ("This year you've been… The Night Shift").
 *
 * Twelve archetypes from PERSONALIZATION-RESEARCH §8 (Whale dropped,
 * Monogamist merged into Loyalist) plus The Fresh Install for thin data.
 * Each archetype scores 0..1 from fixed metric bands (there is no population
 * yet, so no percentiles are claimed). Highest wins, ties by list order; the
 * runner-up is the sub-role; rarity comes from how extreme the deciding
 * metrics are.
 */
import type {StoryArchetype, StoryArchetypeMetric, StoryRarity} from './story-contracts.js';
import type {StoryRow} from './story-table.js';
import {FLAG, has} from './story-lexicon.js';
import {median, pct, family, longestStretch} from './story-detectors.js';
import {HOUR_NAME} from './story-time.js';

export interface ArchetypeMetrics {
  prompts: number; activeDays: number; months: number;
  night: number; dawn: number; weekend: number; len: number; auto: number;
  swear: number; polite: number; praise: number; loyal: number; models: number; wideModels: number; agents: number;
  projects: number; focus: number; stretchH: number; longSessions: number; retry: number; plan: number; question: number;
  peakHour: number | null;
}

type Unit = StoryArchetypeMetric['unit'];
interface MetricDef {key: keyof ArchetypeMetrics; label: string; unit: Unit; lo: number; hi: number; display: (v: number, m: ArchetypeMetrics) => string}
const M: Record<string, MetricDef> = {
  night: {key: 'night', label: 'after 10pm', unit: 'pct', lo: 12, hi: 40, display: v => `${v.toFixed(0)}% of prompts after 10pm`},
  dawn: {key: 'dawn', label: 'before 9am', unit: 'pct', lo: 8, hi: 30, display: v => `${v.toFixed(0)}% of prompts 5–9am`},
  dayOnly: {key: 'night', label: 'daylight', unit: 'pct', lo: 20, hi: 5, display: v => `only ${v.toFixed(0)}% after 10pm`},
  len: {key: 'len', label: 'median words', unit: 'words', lo: 25, hi: 90, display: v => `${v.toFixed(0)} words per prompt (median)`},
  plan: {key: 'plan', label: 'structured prompts', unit: 'pct', lo: 8, hi: 30, display: v => `${v.toFixed(0)}% of prompts with lists or code`},
  lowAuto: {key: 'auto', label: 'few one-word nudges', unit: 'pct', lo: 20, hi: 5, display: v => `only ${v.toFixed(0)}% one-word nudges`},
  auto: {key: 'auto', label: 'autopilot', unit: 'pct', lo: 10, hi: 35, display: v => `${v.toFixed(0)}% of prompts are ≤3 words`},
  swear: {key: 'swear', label: 'swearing', unit: 'per100', lo: 3, hi: 15, display: v => `${v.toFixed(0)} swearing prompts per 100`},
  saltOverSweet: {key: 'swear', label: 'salt over sugar', unit: 'per100', lo: 0, hi: 10, display: (v, m) => `${v.toFixed(0)} swears vs ${m.polite.toFixed(0)} polite per 100`},
  polite: {key: 'polite', label: 'politeness', unit: 'per100', lo: 4, hi: 20, display: v => `${v.toFixed(0)} polite prompts per 100`},
  noSwear: {key: 'swear', label: 'clean mouth', unit: 'per100', lo: 4, hi: 0.5, display: v => `${v.toFixed(1)} swearing prompts per 100`},
  loyal: {key: 'loyal', label: 'top model share', unit: 'pct', lo: 60, hi: 92, display: v => `${v.toFixed(0)}% of prompts to one model`},
  focus: {key: 'focus', label: 'top project share', unit: 'pct', lo: 40, hi: 75, display: v => `${v.toFixed(0)}% of prompts in one project`},
  wideModels: {key: 'wideModels', label: 'models over 10%', unit: 'count', lo: 1.5, hi: 4, display: v => `${v.toFixed(0)} models with >10% of your prompts`},
  agents: {key: 'agents', label: 'agents used', unit: 'count', lo: 1.5, hi: 3.5, display: v => `${v.toFixed(0)} different coding agents`},
  stretch: {key: 'stretchH', label: 'longest stretch', unit: 'hours', lo: 3, hi: 9, display: v => `${v.toFixed(1)}h longest unbroken stretch`},
  longSessions: {key: 'longSessions', label: '4h+ stretches', unit: 'count', lo: 1, hi: 8, display: v => `${v.toFixed(0)} stretches of 4h or more`},
  projects: {key: 'projects', label: 'projects', unit: 'count', lo: 5, hi: 20, display: v => `${v.toFixed(0)} projects with 5+ prompts`},
  lowFocus: {key: 'focus', label: 'spread', unit: 'pct', lo: 45, hi: 15, display: v => `top project only ${v.toFixed(0)}% of prompts`},
  retry: {key: 'retry', label: 'retries', unit: 'pct', lo: 6, hi: 20, display: v => `${v.toFixed(0)}% of prompts say "again", "still" or "not working"`},
  question: {key: 'question', label: 'questions', unit: 'pct', lo: 25, hi: 55, display: v => `${v.toFixed(0)}% of prompts are questions`},
};

interface Def {id: string; title: string; tagline: string; metrics: [string, number][]; profiles: ((m: ArchetypeMetrics) => string)[]}
const pf = (n: number) => n.toFixed(0);
export const ARCHETYPES: readonly Def[] = [
  {id: 'night_shift', title: 'The Night Shift', tagline: "your best ideas show up after the dishwasher's done", metrics: [['night', 3], ['stretch', 1]],
    profiles: [m => `This year you've been The Night Shift: ${pf(m.night)}% of your prompts landed after 10pm${m.peakHour !== null ? `, and ${HOUR_NAME(m.peakHour)} was your busiest hour` : ''}.`,
      m => `This year you've been The Night Shift. While the world slept, you sent ${pf(m.night)}% of your prompts.`]},
  {id: 'early_commit', title: 'The Early Commit', tagline: 'shipped before standup, every time', metrics: [['dawn', 3], ['dayOnly', 1]],
    profiles: [m => `This year you've been The Early Commit: ${pf(m.dawn)}% of your prompts went out between 5 and 9am.`,
      m => `This year you've been The Early Commit. ${pf(m.dawn)}% of your work happened before most people's first coffee.`]},
  {id: 'architect', title: 'The Architect', tagline: "you don't prompt. you write specs.", metrics: [['len', 2], ['plan', 2], ['lowAuto', 1]],
    profiles: [m => `This year you've been The Architect: a median prompt of ${pf(m.len)} words, and ${pf(m.plan)}% of them came with lists or code.`,
      m => `This year you've been The Architect. You brief, you don't nudge: ${pf(m.len)} words is your typical prompt.`]},
  {id: 'autopilot', title: 'The Autopilot', tagline: "'yes' 'continue' 'go'. a manager in 3 words.", metrics: [['auto', 3]],
    profiles: [m => `This year you've been The Autopilot: ${pf(m.auto)}% of your prompts were three words or fewer.`,
      m => `This year you've been The Autopilot. ${pf(m.auto)}% of the time, "continue" said it all.`]},
  {id: 'sailor', title: 'The Sailor', tagline: 'you and the model have a… dynamic.', metrics: [['swear', 2], ['saltOverSweet', 1]],
    profiles: [m => `This year you've been The Sailor: ${pf(m.swear)} of every 100 prompts carried a swear.`,
      m => `This year you've been The Sailor. ${pf(m.swear)} swearing prompts per 100, ${pf(m.polite)} polite ones. The model has heard things.`]},
  {id: 'diplomat', title: 'The Diplomat', tagline: 'first to be spared in the uprising', metrics: [['polite', 2], ['noSwear', 1]],
    profiles: [m => `This year you've been The Diplomat: ${pf(m.polite)} polite prompts per 100, and barely a swear.`,
      m => `This year you've been The Diplomat. Please, thanks, well done: ${pf(m.polite)} of every 100 prompts.`]},
  {id: 'loyalist', title: 'The Loyalist', tagline: 'one model. one project. no notes.', metrics: [['loyal', 2], ['focus', 1]],
    profiles: [m => `This year you've been The Loyalist: ${pf(m.loyal)}% of your prompts went to one model.`,
      m => `This year you've been The Loyalist. One model took ${pf(m.loyal)}% of your prompts and one project ${pf(m.focus)}%.`]},
  {id: 'sommelier', title: 'The Model Sommelier', tagline: "you've tasted every vintage", metrics: [['wideModels', 2], ['agents', 1]],
    profiles: [m => `This year you've been The Model Sommelier: ${pf(m.wideModels)} models each got more than a tenth of your prompts, across ${pf(m.agents)} agents.`,
      m => `This year you've been The Model Sommelier. ${pf(m.models)} models, ${pf(m.agents)} agents, no favourites for long.`]},
  {id: 'marathoner', title: 'The Marathoner', tagline: 'sessions measured in sunsets', metrics: [['stretch', 2], ['longSessions', 1]],
    profiles: [m => `This year you've been The Marathoner: your longest unbroken stretch ran ${m.stretchH.toFixed(1)} hours.`,
      m => `This year you've been The Marathoner. ${pf(m.longSessions)} times you kept going for four hours or more.`]},
  {id: 'tab_hoarder', title: 'The Tab Hoarder', tagline: "all those repos. all 'almost done'.", metrics: [['projects', 2], ['lowFocus', 1]],
    profiles: [m => `This year you've been The Tab Hoarder: ${pf(m.projects)} projects with real work in them, none above ${pf(m.focus)}% of your prompts.`,
      m => `This year you've been The Tab Hoarder. ${pf(m.projects)} projects, every one of them almost done.`]},
  {id: 'boss_fighter', title: 'The Boss Fighter', tagline: "you don't give up. neither does the bug.", metrics: [['retry', 3]],
    profiles: [m => `This year you've been The Boss Fighter: ${pf(m.retry)}% of your prompts said "again", "still" or "not working".`,
      m => `This year you've been The Boss Fighter. You came back to the same bug until it blinked: ${pf(m.retry)}% of your prompts were rematches.`]},
  {id: 'interrogator', title: 'The Interrogator', tagline: 'you came to learn, not to delegate', metrics: [['question', 3]],
    profiles: [m => `This year you've been The Interrogator: ${pf(m.question)}% of your prompts were questions.`,
      m => `This year you've been The Interrogator. ${pf(m.question)}% questions. You wanted to understand, not just to ship.`]},
];
const FRESH = {id: 'fresh_install', title: 'The Fresh Install', tagline: 'just getting started. ask again in a month.'};

const NUDGE = /^(continue|go on|keep going|proceed|resume|yes|yep|ok|okay|go|do it|lgtm|sure|y)\b/;
const RETRY = 1;

export function archetypeMetrics(rows: readonly StoryRow[]): ArchetypeMetrics {
  const n = rows.length || 1;
  const count = (f: (r: StoryRow) => boolean) => rows.filter(f).length;
  const models = new Map<string, number>();
  for (const r of rows) if (r.model) models.set(r.model, (models.get(r.model) ?? 0) + 1);
  const withModel = [...models.values()].reduce((a, b) => a + b, 0);
  const projects = new Map<string, number>();
  for (const r of rows) projects.set(r.project ?? '', (projects.get(r.project ?? '') ?? 0) + 1);
  const hours = new Array(24).fill(0) as number[];
  for (const r of rows) hours[r.hour]!++;
  // Stretches of ≥4h (gaps ≤45 min).
  let longSessions = 0, start = rows[0]?.ts ?? 0;
  for (let i = 1; i <= rows.length; i++) {
    if (i === rows.length || rows[i]!.ts - rows[i - 1]!.ts > 45 * 60_000) { if (rows[i - 1]!.ts - start >= 4 * 3_600_000) longSessions++; if (i < rows.length) start = rows[i]!.ts; }
  }
  const stretch = longestStretch(rows);
  return {
    prompts: rows.length, activeDays: new Set(rows.map(r => r.day)).size, months: new Set(rows.map(r => r.month)).size,
    night: pct(count(r => r.hour >= 22 || r.hour < 5), n), dawn: pct(count(r => r.hour >= 5 && r.hour < 9), n),
    weekend: pct(count(r => r.dow >= 5), n), len: median(rows.map(r => r.f.w)) ?? 0,
    auto: pct(count(r => r.f.w <= 3 || (!!r.f.sl && NUDGE.test(r.f.sl))), n),
    swear: pct(count(r => r.angry), n), polite: pct(count(r => r.polite || has(r.f, FLAG.sorry)), n), praise: pct(count(r => has(r.f, FLAG.thanks)), n),
    loyal: withModel ? pct(Math.max(...models.values()), withModel) : 0, models: models.size,
    wideModels: [...models.values()].filter(v => withModel && v / withModel > 0.1).length,
    agents: new Set(rows.map(r => family(r.harness))).size,
    projects: [...projects.entries()].filter(([p, v]) => p && v >= 5).length,
    focus: pct(Math.max(0, ...[...projects.entries()].filter(([p]) => p).map(([, v]) => v)), n),
    stretchH: stretch ? stretch.ms / 3_600_000 : 0, longSessions,
    retry: pct(count(r => r.f.fr >= RETRY), n), plan: pct(count(r => has(r.f, FLAG.code) || r.f.ln >= 4), n),
    question: pct(count(r => has(r.f, FLAG.question)), n),
    peakHour: rows.length ? hours.indexOf(Math.max(...hours)) : null,
  };
}

const band = (d: MetricDef, v: number) => {
  const t = (v - d.lo) / (d.hi - d.lo);
  return Math.min(1, Math.max(0, t));
};

export function assignArchetype(rows: readonly StoryRow[], variant = 0): StoryArchetype {
  const m = archetypeMetrics(rows);
  const metric = (key: string): StoryArchetypeMetric => {
    const d = M[key]!;
    const v = m[d.key] as number;
    return {key, label: d.label, value: Math.round(v * 10) / 10, unit: d.unit, display: d.display(v, m), band: Math.round(band(d, v) * 100) / 100};
  };
  const scores = ARCHETYPES.map((a, order) => {
    const total = a.metrics.reduce((s, [, w]) => s + w, 0);
    let score = a.metrics.reduce((s, [k, w]) => s + w * band(M[k]!, m[M[k]!.key] as number), 0) / total;
    if (a.id === 'loyalist' && m.months < 3) score *= 0.5; // loyalty needs time
    if (a.id === 'sailor' && m.swear <= m.polite) score *= 0.6;
    return {a, order, score: Math.round(score * 1000) / 1000};
  }).sort((x, y) => y.score - x.score || x.order - y.order);
  const code = (m.night >= 25 ? 'N' : 'D') + (m.len >= 40 && m.auto < 15 ? 'S' : 'V') + (m.loyal >= 60 ? 'L' : 'R') + (m.polite >= m.swear ? 'K' : 'H');
  const all = scores.map(s => ({id: s.a.id, title: s.a.title, score: s.score}));
  if (m.prompts < 200 || m.activeDays < 7 || scores[0]!.score < 0.25) {
    return {id: FRESH.id, title: FRESH.title, tagline: FRESH.tagline,
      profile: m.prompts < 200 ? `This year you've been The Fresh Install: ${m.prompts} prompts so far. A few hundred more and I'll know who you are.` : "This year you've been The Fresh Install: no habit stands out yet, which is its own kind of mystery.",
      subRole: null, rarity: 'common', deciding: [metric('night'), metric('len'), metric('question')].slice(0, m.prompts ? 3 : 0), code, scores: all, confidence: 0.3, source: 'local'};
  }
  const [win, sub] = [scores[0]!, scores[1]!];
  const deciding = [...win.a.metrics.map(([k]) => metric(k)), ...sub.a.metrics.map(([k]) => metric(k))]
    .filter((x, i, xs) => xs.findIndex(y => y.key === x.key) === i).sort((x, y) => y.band - x.band).slice(0, 3);
  const rarity: StoryRarity = win.score >= 0.95 && sub.score >= 0.7 ? 'legendary' : win.score >= 0.85 ? 'epic' : win.score >= 0.65 ? 'rare' : 'common';
  const profiles = win.a.profiles;
  return {
    id: win.a.id, title: win.a.title, tagline: win.a.tagline, profile: profiles[variant % profiles.length]!(m),
    subRole: {id: sub.a.id, title: sub.a.title, label: `with a streak of ${sub.a.title}`},
    rarity, deciding, code, scores: all, confidence: Math.round(Math.min(1, win.score) * 100) / 100, source: 'local',
  };
}

/** All local profile variants of an archetype (Jev may pick among them; it never writes numbers). */
export function profileVariants(id: string, rows: readonly StoryRow[]): string[] {
  const def = ARCHETYPES.find(a => a.id === id);
  if (!def) return [];
  const m = archetypeMetrics(rows);
  return def.profiles.map(p => p(m));
}

/**
 * Story detectors (port of the insight prototype's detectors.py).
 *
 * Each detector looks at the feature table and either returns a card or
 * null when its guard fails: small or noisy histories never get a card made
 * of nonsense. Every detector is one pass plus small group sorts.
 *
 * Conventions: `angry` = a swear or insult on the tone window; tone cards need
 * ≥200 prompts; rates compare groups of ≥40; model comparisons are
 * month-matched and use observed models only (honeymoon also uses inferred).
 */
import os from 'node:os';
import path from 'node:path';
import type {StoryCard, StoryCardKind, StoryChart, StorySection} from './story-contracts.js';
import type {StoryRow, StoryTable} from './story-table.js';
import {ADDRESS, FLAG, TICS, TIC_PRIOR, has, isFWord, isSwearWord, maskLine} from './story-lexicon.js';
import {HOUR_NAME, dayName, daysBetween, isoWeek, monthName} from './story-time.js';
import {typoPairs, type WordSet} from './story-typos.js';

export interface DetectorContext {
  table: StoryTable;
  rows: readonly StoryRow[];
  /** English dictionary for typos (null: typo card skipped). */
  dictionary: WordSet | null;
  /** `(path) => alias` for public wording. */
  alias: (project: string | null) => string;
  home: string;
}

/** What a detector returns before ranking. */
export interface Draft {
  id: string; kind: StoryCardKind; section: StorySection; wow: number;
  headline: string; support: string;
  numbers: Record<string, number | string | boolean | null>;
  chart: StoryChart;
  quote?: string | null;
  confidence: number;
  surprise: number;
  public: {headline: string; support: string} | null;
}

/* -------------------------------------------------------------- helpers --- */

export const median = (xs: readonly number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
export const pct = (a: number, b: number) => (b ? (100 * a) / b : 0);
const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const f0 = (x: number) => Math.round(x).toLocaleString('en-US');
const f1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1);
const usd0 = (x: number) => `$${f0(x)}`;
const usd2 = (x: number) => `$${x.toFixed(2)}`;
/** Confidence from how far `value` clears `guard` (1 at 2× the guard). */
const clears = (value: number, guard: number) => (guard > 0 ? clamp(0.5 + 0.5 * (value - guard) / guard) : 1);

export const base = (p: string | null) => (p ? path.basename(p.replace(/\/+$/, '')) || p : '(unknown)');
/** 'claude-opus-4-5-20251101' -> 'Opus 4.5'; 'gpt-6-sol' -> 'GPT-6 Sol'. */
export function modelLabel(model: string | null): string {
  if (!model) return '?';
  const parts = model.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[[^\]]*\]$/, '').split(/[-_]/).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    if (/^\d+$/.test(p) && out.length && /\d$/.test(out[out.length - 1]!)) out[out.length - 1] += `.${p}`;
    else out.push(p === 'gpt' ? 'GPT' : /^\d/.test(p) ? p : p[0]!.toUpperCase() + p.slice(1));
  }
  return out.join(' ').replace(/^GPT (\d)/, 'GPT-$1');
}
function shorten(q: string | null, max: number): string | null {
  if (!q) return null;
  if (q.length <= max) return q;
  const cut = q.slice(0, max - 1), space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : cut) + '…';
}
function groupBy<T>(xs: readonly T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) { const k = key(x); const l = m.get(k); if (l) l.push(x); else m.set(k, [x]); }
  return m;
}
function counter<T>(xs: Iterable<T>): Map<T, number> {
  const m = new Map<T, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}
/** Entries by count desc, first-seen order on ties (like Python's Counter.most_common). */
const mostCommon = <T>(m: Map<T, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);
const angryRate = (rs: readonly StoryRow[]) => pct(rs.filter(r => r.angry).length, rs.length);
const politeRate = (rs: readonly StoryRow[]) => pct(rs.filter(r => r.polite).length, rs.length);
const TONE_MIN = 200;
const ordinal = (n: number) => `${n}${[, 'st', 'nd', 'rd'][n % 100 >> 3 ^ 1 && n % 10] || 'th'}`;
const clock12 = (ts: number, hour: number, minute: number) => { void ts; return `${hour % 12 || 12}:${String(minute).padStart(2, '0')}${hour < 12 ? 'am' : 'pm'}`; };

/* ------------------------------------------------------------ detectors --- */

function mostExpensiveSentence(c: DetectorContext): Draft | null {
  const priced = c.rows.filter(r => (r.costTotalUsd ?? 0) > 0);
  if (priced.length < 30) return null;
  const costs = priced.map(r => r.costTotalUsd!);
  const med = median(costs)!, total = costs.reduce((a, b) => a + b, 0);
  const ranked = [...priced].sort((a, b) => b.costTotalUsd! - a.costTotalUsd!);
  let top = ranked[0]!, quote: string | null = null;
  for (const r of ranked.slice(0, 5)) { const q = shorten(r.q, 70); if (q) { top = r; quote = q; break; } }
  const cost = top.costTotalUsd!;
  if (cost < Math.max(20 * med, 5)) return null;
  const times = cost / med, share = pct(cost, total);
  const edges = [0.01, 0.03, 0.1, 0.3, 1, 3, 10, 30, 100, 300, 1000, 3000];
  const bucket = (x: number) => { let i = 0; while (i < edges.length && x >= edges[i]!) i++; return i; };
  const label = (i: number) => (i === 0 ? `<$${edges[0]}` : i === edges.length ? `$${edges[i - 1]}+` : `$${edges[i - 1]}–${edges[i]}`);
  const hist = new Array(edges.length + 1).fill(0) as number[];
  for (const x of costs) hist[bucket(x)]!++;
  const support = `One prompt, ${modelLabel(top.model)}, ${dayName(top.day)}. That's ${f0(times)}× your median prompt (${usd2(med)}) and ${share.toFixed(0)}% of all your spend.`;
  return {
    id: 'most_expensive_sentence', kind: 'money', section: 'bill', wow: quote ? 95 : 85,
    headline: quote ? `Your most expensive sentence: “${quote}” — ${usd0(cost)}.` : `One prompt cost you ${usd0(cost)}.`,
    support,
    numbers: {cost_usd: r2(cost), median_prompt_cost: Math.round(med * 10000) / 10000, times_median: Math.round(times), share_pct: r1(share), model: top.model, day: top.day, project: base(top.project), priced_prompts: priced.length},
    chart: {type: 'histogram', motif: 'receipt', series: [{name: 'prompts', points: hist.map((y, i) => ({x: label(i), y}))}], highlight: label(bucket(cost)), xLabel: 'cost per prompt', unit: 'prompts'},
    quote, confidence: clamp(0.6 + 0.4 * clears(times, 20)), surprise: times,
    public: {headline: `One prompt cost you ${usd0(cost)}.`, support},
  };
}

function moodDrift(c: DetectorContext): Draft | null {
  if (c.rows.length < TONE_MIN) return null;
  const M = groupBy(c.rows, r => r.month);
  const months = [...M.keys()].sort().filter(m => M.get(m)!.length >= 40);
  if (months.length < 4) return null;
  const early = months.slice(0, 3), late = months.slice(-2);
  const se = angryRate(early.flatMap(m => M.get(m)!)), sl = angryRate(late.flatMap(m => M.get(m)!));
  const series = months.map(m => ({x: m, y: r1(angryRate(M.get(m)!))}));
  const byMonth = Object.fromEntries(series.map(p => [p.x, p.y]));
  if (sl >= 5 && sl >= 2.5 * Math.max(se, 0.5)) {
    const tip = months.find(m => angryRate(M.get(m)!) >= sl / 2) ?? late[0]!;
    const k = sl / Math.max(se, 0.1);
    const support = `${monthName(early[0]!)}–${monthName(early.at(-1)!, 'short')}: ${f1(se)}%. Last two months: ${sl.toFixed(0)}% (×${f0(k)}). It tipped in ${monthName(tip, 'long')}.`;
    return {
      id: 'mood_drift', kind: 'mood', section: 'mood', wow: 90,
      headline: `You used to be nice. Swearing went from ${f1(se)}% of prompts to ${sl.toFixed(0)}%.`, support,
      numbers: {early_pct: r1(se), late_pct: r1(sl), ratio: r1(k), tipping_month: tip, earlyPct: r1(se), latePct: r1(sl), factor: r1(k), tipMonth: tip, ...byMonth},
      chart: {type: 'line', series: [{name: 'swear %', points: series}], highlight: tip, unit: 'pct'},
      confidence: clears(sl / Math.max(se, 0.5), 2.5), surprise: k, public: {headline: `You used to be nice. Swearing went from ${f1(se)}% of prompts to ${sl.toFixed(0)}%.`, support},
    };
  }
  if (se >= 5 && se >= 2.5 * Math.max(sl, 0.5)) {
    const k = se / Math.max(sl, 0.1);
    const support = `${monthName(early[0]!)}–${monthName(early.at(-1)!, 'short')}: ${f1(se)}% of prompts swore. Last two months: ${f1(sl)}%.`;
    return {
      id: 'mood_drift', kind: 'mood', section: 'mood', wow: 80,
      headline: `You mellowed out. Swearing fell from ${se.toFixed(0)}% of prompts to ${f1(sl)}%.`, support,
      numbers: {early_pct: r1(se), late_pct: r1(sl), ratio: r1(k), direction: 'down', earlyPct: r1(se), latePct: r1(sl), factor: r1(k), tipMonth: null, ...byMonth},
      chart: {type: 'line', series: [{name: 'swear %', points: series}], unit: 'pct'},
      confidence: clears(se / Math.max(sl, 0.5), 2.5), surprise: k, public: {headline: `You mellowed out. Swearing fell from ${se.toFixed(0)}% of prompts to ${f1(sl)}%.`, support},
    };
  }
  return null;
}

/** Month-matched observed vs expected per model, for a flag (angry or polite). */
export function modelComparison(rows: readonly StoryRow[], flag: (r: StoryRow) => boolean) {
  const G = new Map<string, {model: string; month: string; rows: StoryRow[]}>();
  for (const r of rows) if (r.model && r.modelSrc === 'observed') {
    const k = `${r.model}\0${r.month}`;
    let g = G.get(k);
    if (!g) { g = {model: r.model, month: r.month, rows: []}; G.set(k, g); }
    g.rows.push(r);
  }
  const byMonth = groupBy([...G.values()], g => g.month);
  const by = new Map<string, {obs: number; exp: number; n: number; months: number}>();
  for (const g of G.values()) {
    const peers = byMonth.get(g.month)!.filter(x => x.model !== g.model).flatMap(x => x.rows);
    if (g.rows.length < 15 || peers.length < 15) continue;
    const rate = peers.filter(flag).length / peers.length;
    const row = by.get(g.model) ?? {obs: 0, exp: 0, n: 0, months: 0};
    row.obs += g.rows.filter(flag).length; row.exp += rate * g.rows.length; row.n += g.rows.length; row.months++;
    by.set(g.model, row);
  }
  return by;
}

function worstModel(c: DetectorContext): Draft | null {
  if (c.rows.length < TONE_MIN) return null;
  const by = modelComparison(c.rows, r => r.angry);
  const cand = [...by.entries()].filter(([, v]) => v.n >= 40 && v.exp > 0);
  if (cand.length < 2) return null;
  const ratio = ([, v]: (typeof cand)[number]) => (v.obs + 1) / (v.exp + 1);
  const worst = cand.reduce((a, b) => (ratio(b) > ratio(a) ? b : a));
  const k = ratio(worst);
  if (k < 1.3) return null;
  const all = c.rows.filter(r => r.modelSrc === 'observed' && r.model === worst[0]);
  const rate = angryRate(all);
  const support = `${rate.toFixed(0)} swears per 100 prompts, ${f1(k)}× what the other models got from you in the same weeks.`;
  return {
    id: 'worst_model', kind: 'model', section: 'best_worst', wow: 85,
    headline: `${modelLabel(worst[0])} brings out the worst in you.`, support,
    numbers: {model: worst[0], swear_per_100: r1(rate), ratio_vs_peers_same_month: r2(k), n: all.length},
    chart: {type: 'bar', series: [
      {name: 'observed per 100', points: cand.map(([m, v]) => ({x: modelLabel(m), y: r1(pct(v.obs, v.n))}))},
      {name: 'expected per 100', points: cand.map(([m, v]) => ({x: modelLabel(m), y: r1(pct(v.exp, v.n))}))},
    ], highlight: modelLabel(worst[0]), unit: 'per100'},
    confidence: clears(k, 1.3), surprise: k, public: {headline: `${modelLabel(worst[0])} brings out the worst in you.`, support},
  };
}

function bestModel(c: DetectorContext): Draft | null {
  if (c.rows.length < TONE_MIN) return null;
  const by = modelComparison(c.rows, r => r.polite);
  const cand = [...by.entries()].filter(([, v]) => v.n >= 40 && v.exp > 0);
  if (cand.length < 2) return null;
  const ratio = ([, v]: (typeof cand)[number]) => (v.obs + 1) / (v.exp + 1);
  // The model you swear at most cannot also be the one you are sweetest to.
  const worst = worstModel(c)?.numbers.model;
  const others = cand.filter(([m]) => m !== worst);
  if (!others.length) return null;
  const best = others.reduce((a, b) => (ratio(b) > ratio(a) ? b : a));
  const k = ratio(best);
  if (k < 1.3 || best[1].obs < 5) return null;
  const all = c.rows.filter(r => r.modelSrc === 'observed' && r.model === best[0]);
  const rate = politeRate(all);
  const support = `${rate.toFixed(0)} polite prompts per 100, ${f1(k)}× what the other models got from you in the same weeks.`;
  return {
    id: 'best_model', kind: 'model', section: 'best_worst', wow: 75,
    headline: `You're sweetest to ${modelLabel(best[0])}.`, support,
    numbers: {model: best[0], polite_per_100: r1(rate), ratio_vs_peers_same_month: r2(k), n: all.length},
    chart: {type: 'bar', series: [
      {name: 'observed per 100', points: cand.map(([m, v]) => ({x: modelLabel(m), y: r1(pct(v.obs, v.n))}))},
      {name: 'expected per 100', points: cand.map(([m, v]) => ({x: modelLabel(m), y: r1(pct(v.exp, v.n))}))},
    ], highlight: modelLabel(best[0]), unit: 'per100'},
    confidence: clears(k, 1.3), surprise: k, public: {headline: `You're sweetest to ${modelLabel(best[0])}.`, support},
  };
}

function honeymoon(c: DetectorContext): Draft | null {
  if (c.rows.length < TONE_MIN) return null;
  const M = groupBy(c.rows.filter(r => r.model), r => r.model!);
  let best: {score: number; m: string; pe: number; pl: number; se: number; sl: number; ne: number; nl: number; d0: string} | null = null;
  for (const [m, rs] of M) {
    const t0 = rs[0]!.ts;
    const e = rs.filter(r => r.ts - t0 < 21 * 86_400_000), l = rs.filter(r => r.ts - t0 >= 21 * 86_400_000);
    if (e.length < 40 || l.length < 40) continue;
    const pe = politeRate(e), pl = politeRate(l), se = angryRate(e), sl = angryRate(l);
    const score = (pe - pl) + (sl - se);
    if (pe >= 8 && pe >= 2 * Math.max(pl, 0.5) && (!best || score > best.score)) best = {score, m, pe, pl, se, sl, ne: e.length, nl: l.length, d0: rs[0]!.day};
  }
  if (!best) return null;
  const {m, pe, pl, se, sl} = best;
  const support = `First 21 days: ${pe.toFixed(0)}% of prompts polite, ${se.toFixed(0)}% swearing. After: ${pl.toFixed(0)}% polite, ${sl.toFixed(0)}% swearing.`;
  return {
    id: 'honeymoon', kind: 'mood', section: 'manners', wow: 85,
    headline: `The honeymoon with ${modelLabel(m)} lasted three weeks.`, support,
    numbers: {model: m, polite_early: r1(pe), polite_late: r1(pl), swear_early: r1(se), swear_late: r1(sl), n_early: best.ne, n_late: best.nl, first_day: best.d0},
    chart: {type: 'slope', motif: 'cracked_heart', series: [
      {name: 'polite %', points: [{x: 'first 21 days', y: r1(pe)}, {x: 'after', y: r1(pl)}]},
      {name: 'swear %', points: [{x: 'first 21 days', y: r1(se)}, {x: 'after', y: r1(sl)}]},
    ], unit: 'pct'},
    confidence: clears(pe / Math.max(pl, 0.5), 2), surprise: pe / Math.max(pl, 0.5), public: {headline: `The honeymoon with ${modelLabel(m)} lasted three weeks.`, support},
  };
}

function thanksVsSwears(c: DetectorContext): Draft | null {
  if (c.rows.length < TONE_MIN) return null;
  let fw = 0, sw = 0, th = 0, pl = 0;
  for (const r of c.rows) {
    for (const w of r.f.sws ?? []) { sw++; if (isFWord(w)) fw++; }
    if (has(r.f, FLAG.thanks)) th++;
    if (has(r.f, FLAG.please)) pl++;
  }
  const n = c.rows.length;
  if (sw >= 20) {
    const [word, k] = fw >= 15 ? ['f-bombs', fw] : ['swear words', sw];
    const ratio = k / Math.max(th, 1);
    if (ratio >= 3) {
      const support = `${th} thank-yous and ${pl} pleases in ${f0(n)} prompts. ${k} ${word}.`;
      return {
        id: 'thanks_vs_swears', kind: 'mood', section: 'manners', wow: 80,
        headline: `For every “thank you”, ${ratio.toFixed(0)} ${word}.`, support,
        numbers: {thanks: th, please: pl, pleases: pl, fwords: fw, fbombs: fw, swears: sw, ratio: r1(ratio), prompts: n, counted: word},
        chart: {type: 'balance', series: [{name: 'counts', points: [{x: 'thank-yous', y: th}, {x: 'pleases', y: pl}, {x: word, y: k}]}], unit: 'count'},
        confidence: clears(ratio, 3), surprise: ratio, public: {headline: `For every “thank you”, ${ratio.toFixed(0)} ${word}.`, support},
      };
    }
  }
  if (th >= 20 && th > 3 * sw) {
    const ratio = th / Math.max(sw, 1);
    const support = `${th} thank-yous and ${pl} pleases in ${f0(n)} prompts, against ${sw} swear words.`;
    return {
      id: 'thanks_vs_swears', kind: 'mood', section: 'manners', wow: 70,
      headline: 'You thank your agent more than your barista.', support,
      numbers: {thanks: th, please: pl, pleases: pl, fwords: fw, fbombs: fw, swears: sw, ratio: r1(ratio), prompts: n, counted: 'thanks'},
      chart: {type: 'balance', series: [{name: 'counts', points: [{x: 'thank-yous', y: th}, {x: 'pleases', y: pl}, {x: 'swear words', y: sw}]}], unit: 'count'},
      confidence: clears(ratio, 3), surprise: ratio, public: {headline: 'You thank your agent more than your barista.', support},
    };
  }
  return null;
}

function projectsOf(c: DetectorContext) { return groupBy(c.rows, r => r.project ?? '(unknown)'); }
const newest = (c: DetectorContext) => c.rows.reduce((m, r) => Math.max(m, r.ts), 0);
const isHome = (c: DetectorContext, p: string) => p === '(unknown)' || p.replace(/\/+$/, '') === c.home || base(p) === path.basename(c.home);

function dailySeries(rs: readonly StoryRow[], until: string, max = 60): {x: string; y: number}[] {
  const days = counter(rs.map(r => r.day));
  const first = rs[0]!.day;
  const span = daysBetween(first, until);
  const step = Math.max(1, Math.ceil((span + 1) / max));
  const out: {x: string; y: number}[] = [];
  for (let i = 0; i <= span; i += step) {
    let y = 0;
    for (let j = i; j < Math.min(i + step, span + 1); j++) y += days.get(new Date(Date.parse(`${first}T00:00:00Z`) + j * 86_400_000).toISOString().slice(0, 10)) ?? 0;
    out.push({x: new Date(Date.parse(`${first}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10), y});
  }
  return out;
}

function gotAway(c: DetectorContext): Draft | null {
  const last = newest(c), lastDay = c.rows.at(-1)?.day ?? '';
  const cands = [...projectsOf(c)].filter(([p, rs]) => rs.length >= 60 && (last - rs.at(-1)!.ts) / 86_400_000 >= 45 && !isHome(c, p));
  if (!cands.length) return null;
  const [p, rs] = cands.reduce((a, b) => (b[1].length > a[1].length ? b : a));
  const idle = (last - rs.at(-1)!.ts) / 86_400_000;
  const days = new Set(rs.map(r => r.day)).size;
  let q: string | null = null;
  for (let i = rs.length - 1; i >= 0 && !q; i--) q = shorten(rs[i]!.q, 70);
  const support = `${rs.length} prompts over ${days} days, then nothing for ${idle.toFixed(0)} days.` + (q ? ` Your last words to it: “${q}”` : '');
  return {
    id: 'one_that_got_away', kind: 'project', section: 'projects', wow: 80,
    headline: `The one that got away: ${base(p)}.`, support,
    numbers: {project: base(p), prompts: rs.length, active_days: days, idle_days: Math.round(idle), last_day: rs.at(-1)!.day},
    chart: {type: 'sparkline', motif: 'ecg_flatline', series: [{name: 'prompts per day', points: dailySeries(rs, lastDay)}], unit: 'prompts'},
    quote: q, confidence: clears(rs.length, 60), surprise: 1 + idle / 45,
    public: {headline: `The one that got away: ${c.alias(p)}.`, support: `${rs.length} prompts over ${days} days, then nothing for ${idle.toFixed(0)} days.`},
  };
}

const NUDGE = /^(continue|go on|keep going|proceed|resume)\b/;
const PET = /\b(babe|baby|bro|buddy|dude|man|love|my friend)\b/;
function continueCount(c: DetectorContext): Draft | null {
  const rs = c.rows.filter(r => r.f.sl && NUDGE.test(r.f.sl));
  if (rs.length < 15) return null;
  const exact = counter(rs.map(r => r.f.sl!));
  const ranked = mostCommon(exact);
  const [word, n] = ranked[0]!;
  const gaps = rs.map(r => r.gapReplyS).filter((g): g is number => !!g);
  const g = gaps.length >= 8 ? median(gaps) : null;
  const pet = ranked.find(([k, v]) => PET.test(k) && v >= 2);
  let support = `${rs.length} nudges in total` + (g && g > 3600 ? `, typically ${f1(g / 3600)}h after the agent last spoke` : g ? `, typically ${(g / 60).toFixed(0)} min after the agent last spoke` : '');
  support += pet ? `. Including “${maskLine(pet[0])}” ×${pet[1]}.` : '.';
  const plain = /^(continue|go on|keep going|proceed|resume)$/.test(word);
  return {
    id: 'continue_count', kind: 'habit', section: 'delegation', wow: 75,
    headline: `You've typed “${maskLine(word)}” ${n} times.`, support,
    numbers: {top: maskLine(word), top_n: n, all_n: rs.length, median_gap_s: g === null ? null : Math.round(g),
      word: maskLine(word), count: n, total: rs.length, gapLabel: g === null ? null : g > 3600 ? `${f1(g / 3600)}h` : `${(g / 60).toFixed(0)} min`, pet: pet ? maskLine(pet[0]) : null, petCount: pet ? pet[1] : null},
    chart: {type: 'tally', series: [{name: 'variants', points: ranked.slice(0, 6).map(([k, v]) => ({x: maskLine(k), y: v}))}], unit: 'count'},
    confidence: clears(rs.length, 15), surprise: 1 + n / 15,
    public: plain ? {headline: `You've typed “${word}” ${n} times.`, support: `${rs.length} nudges in total.`} : {headline: `You've nudged your agent to keep going ${rs.length} times.`, support: `${rs.length} nudges in total.`},
  };
}

function verbalTics(c: DetectorContext): Draft | null {
  const n = c.rows.length;
  if (n < 300) return null;
  const cnt = new Map<number, number>();
  for (const r of c.rows) for (const k of r.f.tc ?? []) cnt.set(k, (cnt.get(k) ?? 0) + 1);
  const scored = [...cnt].filter(([, v]) => v >= 25).map(([k, v]) => ({t: TICS[k]!, v, s: (100 * v / n) / (TIC_PRIOR[TICS[k]!] ?? 1)}))
    .sort((a, b) => b.s - a.s || (a.t < b.t ? 1 : -1));
  const picks = scored.slice(0, 3);
  if (!picks.length) return null;
  const top = picks[0]!;
  const rest = picks.slice(1).map(p => `“${p.t}” ×${p.v}`).join(', ');
  const support = (rest ? `Runners-up: ${rest}.` : `That's ${f1(pct(top.v, n))} times per 100 prompts.`) + (top.t === 'one more thing' ? ' It is never just one more thing.' : '');
  return {
    id: 'verbal_tics', kind: 'language', section: 'talk', wow: 75,
    headline: `Your catchphrase is “${top.t}”. You've said it ${top.v} times.`, support,
    numbers: Object.fromEntries(picks.map(p => [p.t, p.v])),
    chart: {type: 'hbar', series: [{name: 'prompts', points: picks.map(p => ({x: p.t, y: p.v}))}], unit: 'prompts'},
    confidence: clears(top.v, 25), surprise: top.s, public: {headline: `Your catchphrase is “${top.t}”. You've said it ${top.v} times.`, support},
  };
}

function fuse(c: DetectorContext): Draft | null {
  if (c.rows.length < TONE_MIN) return null;
  const S = groupBy(c.rows, r => r.conv);
  const long = [...S.values()].filter(rs => rs.length >= 5);
  const firsts = long.filter(rs => rs.some(r => r.angry)).map(rs => rs.find(r => r.angry)!.turn);
  if (firsts.length < 12) return null;
  const m = Math.round(median(firsts)!);
  const ones = firsts.filter(f => f === 1).length;
  const hist = counter(firsts.map(f => Math.min(f, 20)));
  const support = `In sessions where you snap (${firsts.length} of ${long.length}), the first swear lands at prompt #${m} (median). ${ones} times you came in swinging on prompt #1.`;
  return {
    id: 'fuse_length', kind: 'mood', section: 'fuse', wow: 75,
    headline: `Your fuse is ${m} prompts long.`, support,
    numbers: {median_first_swear_turn: m, sessions_with_swear: firsts.length, sessions_5plus: long.length, first_prompt_swears: ones},
    chart: {type: 'histogram', motif: 'fuse', series: [{name: 'sessions', points: Array.from({length: 20}, (_, i) => ({x: i + 1, y: hist.get(i + 1) ?? 0, ...(i === 19 ? {label: '20+'} : {})}))}], highlight: m, xLabel: 'prompt # of first swear', unit: 'sessions'},
    confidence: clears(firsts.length, 12), surprise: 1 + firsts.length / Math.max(long.length, 1), public: {headline: `Your fuse is ${m} prompts long.`, support},
  };
}

function petNames(c: DetectorContext): Draft | null {
  const cnt = new Map<number, number>();
  for (const r of c.rows) for (const k of r.f.ad ?? []) cnt.set(k, (cnt.get(k) ?? 0) + 1);
  const ranked = [...cnt].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  if (!ranked.length || ranked[0]![1] < 8) return null;
  const [a, n] = ranked[0]!;
  const rest = ranked.slice(1, 4).filter(([, v]) => v >= 3);
  const support = rest.length ? `Also: ${rest.map(([k, v]) => `“${ADDRESS[k]}” ×${v}`).join(', ')}.` : 'It has never called you anything back.';
  return {
    id: 'pet_names', kind: 'language', section: 'talk', wow: 70,
    headline: `You call your coding agent “${ADDRESS[a]}”. ${n} times, so far.`, support,
    numbers: Object.fromEntries(ranked.slice(0, 8).map(([k, v]) => [ADDRESS[k]!, v])),
    chart: {type: 'words', series: [{name: 'uses', points: ranked.slice(0, 8).map(([k, v]) => ({x: ADDRESS[k]!, y: v}))}], unit: 'count'},
    confidence: clears(n, 8), surprise: 1 + n / 8, public: {headline: `You call your coding agent “${ADDRESS[a]}”. ${n} times, so far.`, support},
  };
}

export const family = (h: string) => (h.startsWith('claude') ? 'Claude Code' : h === 'codex' ? 'Codex' : h === 'pi' ? 'pi' : h === 'opencode' ? 'OpenCode' : h);
const defectionMemo = new WeakMap<readonly StoryRow[], ReturnType<typeof computeDefection>>();
export function defectionOf(rows: readonly StoryRow[]): ReturnType<typeof computeDefection> {
  if (!defectionMemo.has(rows)) defectionMemo.set(rows, computeDefection(rows));
  return defectionMemo.get(rows)!;
}
function computeDefection(rows: readonly StoryRow[]): {from: string; to: string; week: string; weekStart: string; priorWeeks: number; shareSincePct: number; weeks: Map<string, Map<string, number>>} | null {
  const W = new Map<string, Map<string, number>>(), monday = new Map<string, string>();
  for (const r of rows) {
    const w = isoWeek(r.day);
    monday.set(w.key, w.monday);
    const m = W.get(w.key) ?? new Map<string, number>();
    const fam = family(r.harness);
    m.set(fam, (m.get(fam) ?? 0) + 1);
    W.set(w.key, m);
  }
  const weeks = [...W.keys()].sort();
  const dom = weeks.filter(w => [...W.get(w)!.values()].reduce((a, b) => a + b, 0) >= 10).map(w => [w, mostCommon(W.get(w)!)[0]![0]] as const);
  for (let i = 4; i < dom.length - 2; i++) {
    const prev = dom.slice(Math.max(0, i - 8), i).map(d => d[1]);
    if (new Set(prev).size === 1 && dom.slice(i, i + 3).every(d => d[1] !== prev[0])) {
      const [w, to] = dom[i]!, from = prev[0]!;
      const start = monday.get(w)!;
      const later = rows.filter(r => r.day >= start);
      const share = pct(later.filter(r => family(r.harness) === to).length, later.length);
      return {from, to, week: w, weekStart: start, priorWeeks: prev.length, shareSincePct: r1(share), weeks: W};
    }
  }
  return null;
}

function defection(c: DetectorContext): Draft | null {
  const d = defectionOf(c.rows);
  if (!d) return null;
  const fams = [...new Set(c.rows.map(r => family(r.harness)))];
  const weeks = [...d.weeks.keys()].sort().slice(-52);
  const support = `${d.priorWeeks} straight weeks of ${d.from}, then ${d.shareSincePct.toFixed(0)}% of everything since went to ${d.to}.`;
  return {
    id: 'defection', kind: 'model', section: 'models', wow: 70,
    headline: `You left ${d.from} for ${d.to} the week of ${dayName(d.weekStart)}.`, support,
    numbers: {from: d.from, to: d.to, week: d.weekStart, iso_week: d.week, week_start: d.weekStart, share_since_pct: d.shareSincePct, sharePct: d.shareSincePct, prior_weeks: d.priorWeeks, weeks: d.priorWeeks},
    chart: {type: 'stacked_area', series: fams.map(f => ({name: f, points: weeks.map(w => ({x: w, y: d.weeks.get(w)!.get(f) ?? 0}))})), highlight: d.week, unit: 'prompts'},
    confidence: clamp(d.shareSincePct / 100), surprise: 1 + d.shareSincePct / 50, public: {headline: `You left ${d.from} for ${d.to} the week of ${dayName(d.weekStart)}.`, support},
  };
}

const lateMemo = new WeakMap<readonly StoryRow[], {days: number; late: number}>();
export function lateNight(rows: readonly StoryRow[], shifted: (ts: number) => string): {days: number; late: number} {
  let hit = lateMemo.get(rows);
  if (!hit) { hit = computeLateNight(rows, shifted); lateMemo.set(rows, hit); }
  return hit;
}
function computeLateNight(rows: readonly StoryRow[], shifted: (ts: number) => string) {
  const D = new Map<string, StoryRow>();
  for (const r of rows) { const d = shifted(r.ts); const cur = D.get(d); if (!cur || r.ts > cur.ts) D.set(d, r); }
  const ends = [...D.values()];
  return {days: ends.length, late: ends.filter(r => r.hour >= 1 && r.hour < 6).length};
}

function nightOwl(c: DetectorContext, shifted: (ts: number) => string): Draft | null {
  const {days, late} = lateNight(c.rows, shifted);
  if (days < 20) return null;
  const H = new Array(24).fill(0) as number[], A = new Array(24).fill(0) as number[];
  for (const r of c.rows) { H[r.hour]!++; if (r.angry) A[r.hour]!++; }
  const ok = H.map((n, h) => [h, n] as const).filter(([, n]) => n >= 50).map(([h]) => h);
  if (ok.length < 6) return null;
  const rate = (h: number) => A[h]! / H[h]!;
  const worst = ok.reduce((a, b) => (rate(b) > rate(a) ? b : a)), calm = ok.reduce((a, b) => (rate(b) < rate(a) ? b : a));
  const peak = H.indexOf(Math.max(...H));
  const share = pct(late, days);
  const tone = c.rows.length >= TONE_MIN && A[worst]! > 0;
  const support = tone ? `${HOUR_NAME(worst)} is your angriest hour (${pct(A[worst]!, H[worst]!).toFixed(0)}% of prompts swear). ${HOUR_NAME(calm)} you is a saint (${A[calm]} of ${H[calm]}).`
    : `${f0(H[peak]!)} prompts at ${HOUR_NAME(peak)}, your busiest hour.`;
  const headline = share >= 20 ? `${share.toFixed(0)}% of your days end after 1am.` : `Your busiest hour is ${HOUR_NAME(peak)}.`;
  return {
    id: 'night_owl', kind: 'time', section: 'clock', wow: share >= 20 ? 70 : 50,
    headline, support,
    numbers: {days_ending_after_1am_pct: r1(share), lateNightPct: r1(share), days: days, peak_hour: peak, angriest_hour: worst, calmest_hour: calm, angriest_pct: r1(pct(A[worst]!, H[worst]!)), calmest_swears: A[calm]!, calmest_prompts: H[calm]!,
      angriestHour: tone ? worst : null, angriestPct: tone ? r1(pct(A[worst]!, H[worst]!)) : null, calmestHour: tone ? calm : null, calmestSwears: tone ? A[calm]! : null, calmestPrompts: tone ? H[calm]! : null},
    chart: {type: 'clock24', series: [{name: 'prompts', points: H.map((y, x) => ({x, y}))}, {name: 'swear %', points: H.map((n, x) => ({x, y: r1(pct(A[x]!, n))}))}], highlight: share >= 20 ? 1 : peak, unit: 'prompts'},
    confidence: clears(days, 20), surprise: 1 + share / 20, public: {headline, support},
  };
}

function iToWe(c: DetectorContext): Draft | null {
  const M = new Map<string, [number, number, number, number]>();
  for (const r of c.rows) { const m = M.get(r.month) ?? [0, 0, 0, 0]; m[0] += r.f.we; m[1] += r.f.i; m[2]++; if (has(r.f, FLAG.lets)) m[3]++; M.set(r.month, m); }
  const months = [...M.keys()].sort().filter(m => M.get(m)![2] >= 40);
  if (months.length < 4) return null;
  const e = months.slice(0, 2), l = months.at(-1)!;
  const sum = (k: number) => e.reduce((n, m) => n + M.get(m)![k]!, 0);
  const re = sum(0) / Math.max(1, sum(1)), rl = M.get(l)![0] / Math.max(1, M.get(l)![1]);
  const le = pct(sum(3), sum(2)), ll = pct(M.get(l)![3], M.get(l)![2]);
  if (rl < 1.5 * re || ll < 10) return null;
  const support = `“we/us/our” per “I/me/my”: ${re.toFixed(2)} in your first months, ${rl.toFixed(2)} now. ${ll.toFixed(0)}% of this month's prompts contain “let's” (was ${le.toFixed(0)}%).`;
  return {
    id: 'i_to_we', kind: 'language', section: 'talk', wow: 70,
    headline: 'You stopped saying “I” and started saying “we”.', support,
    numbers: {we_per_i_early: r2(re), we_per_i_now: r2(rl), lets_early_pct: r1(le), lets_now_pct: r1(ll), earlyRatio: r2(re), lateRatio: r2(rl), letsNowPct: r1(ll), letsThenPct: r1(le)},
    chart: {type: 'line', series: [{name: 'we per I', points: months.map(m => ({x: m, y: r2(M.get(m)![0] / Math.max(1, M.get(m)![1]))}))}], unit: 'ratio'},
    confidence: clears(rl / Math.max(re, 0.01), 1.5), surprise: rl / Math.max(re, 0.01), public: {headline: 'You stopped saying “I” and started saying “we”.', support},
  };
}

function rantLength(c: DetectorContext): Draft | null {
  if (c.rows.length < TONE_MIN) return null;
  const B: [number, number][] = [[1, 10], [11, 30], [31, 80], [81, 200], [201, 1e9]];
  const rows = B.map(([a, b]) => ({a, b, rs: c.rows.filter(r => r.f.w >= a && r.f.w <= b)}));
  if (rows[0]!.rs.length < 40 || rows[4]!.rs.length < 40) return null;
  const lo = angryRate(rows[0]!.rs), hi = angryRate(rows[4]!.rs);
  if (hi < 8 || hi < 4 * Math.max(lo, 0.5)) return null;
  const support = `${hi.toFixed(0)}% of your 200+ word prompts contain a swear, vs ${f1(lo)}% of your one-liners. When you write an essay, it's not a happy one.`;
  return {
    id: 'rant_length', kind: 'mood', section: 'mood', wow: 70, headline: 'Your rants come with word counts.', support,
    numbers: Object.fromEntries(rows.map(({a, b, rs}) => [`${a}-${b < 1e9 ? b : '+'}`, r1(angryRate(rs))])),
    chart: {type: 'bar', series: [{name: 'swear %', points: rows.map(({a, b, rs}) => ({x: b < 1e9 ? `${a}–${b}` : `${a}+`, y: r1(angryRate(rs))}))}], highlight: '201+', xLabel: 'words', unit: 'pct'},
    confidence: clears(hi / Math.max(lo, 0.5), 4), surprise: hi / Math.max(lo, 0.5), public: {headline: 'Your rants come with word counts.', support},
  };
}

function rageDay(c: DetectorContext): Draft | null {
  if (c.rows.length < TONE_MIN) return null;
  const D = groupBy(c.rows, r => r.day);
  const score = (rs: StoryRow[]) => rs.reduce((n, r) => n + r.f.sw + r.f.ins, 0);
  let best: [string, StoryRow[]] | null = null;
  for (const e of D) if (!best || score(e[1]) > score(best[1])) best = e;
  const [d, rs] = best!;
  const n = score(rs);
  if (n < 15) return null;
  const angry = rs.filter(r => r.angry);
  const hrs = [...new Set(angry.map(r => r.hour))].sort((a, b) => a - b);
  const proj = mostCommon(counter(angry.map(r => r.project ?? '(unknown)')))[0]![0];
  const mod = mostCommon(counter(angry.filter(r => r.model).map(r => r.model!)))[0]?.[0] ?? null;
  const when = hrs[0] === hrs.at(-1) ? `, all around ${HOUR_NAME(hrs[0]!)}` : `, between ${HOUR_NAME(hrs[0]!)} and ${HOUR_NAME(hrs.at(-1)!)}`;
  const support = `${n} swear words in ${rs.length} prompts` + (mod ? `, mostly at ${modelLabel(mod)}` : '') + when + '. Your most profane day on record.';
  const days = [...D].map(([day, x]) => ({x: day, y: score(x)})).filter(p => p.y > 0).sort((a, b) => b.y - a.y).slice(0, 60).sort((a, b) => (a.x < b.x ? -1 : 1));
  return {
    id: 'rage_day', kind: 'mood', section: 'mood', wow: 70,
    headline: `${dayName(d, 'long')} was a bad day for ${base(proj)}.`, support,
    numbers: {day: d, swears: n, prompts: rs.length, project: base(proj), model: mod ? modelLabel(mod) : null, model_id: mod},
    chart: {type: 'calendar', series: [{name: 'swear words', points: days}], highlight: d, unit: 'count'},
    confidence: clears(n, 15), surprise: 1 + n / 15,
    public: {headline: `${dayName(d, 'long')} was your most profane day on record.`, support},
  };
}

function sprintAndVanish(c: DetectorContext): Draft | null {
  const last = newest(c), lastDay = c.rows.at(-1)?.day ?? '';
  let best: {rate: number; p: string; rs: StoryRow[]; span: number} | null = null;
  for (const [p, rs] of projectsOf(c)) {
    const span = (rs.at(-1)!.ts - rs[0]!.ts) / 86_400_000 + 1;
    if (rs.length >= 80 && span <= 10 && (last - rs.at(-1)!.ts) / 86_400_000 >= 30 && !isHome(c, p) && (!best || rs.length / span > best.rate)) best = {rate: rs.length / span, p, rs, span};
  }
  if (!best) return null;
  const {p, rs, span} = best;
  const idle = (last - rs.at(-1)!.ts) / 86_400_000;
  const support = `From ${dayName(rs[0]!.day)} to ${dayName(rs.at(-1)!.day)}. Untouched for ${idle.toFixed(0)} days. Hackathon, or heartbreak?`;
  return {
    id: 'sprint_and_vanish', kind: 'project', section: 'projects', wow: 65,
    headline: `${base(p)}: ${rs.length} prompts in ${span.toFixed(0)} days. Then never again.`, support,
    numbers: {project: base(p), prompts: rs.length, span_days: r1(span), idle_days: Math.round(idle), days: Math.round(span), idleDays: Math.round(idle)},
    chart: {type: 'sparkline', series: [{name: 'prompts per day', points: dailySeries(rs, lastDay)}], unit: 'prompts'},
    confidence: clears(rs.length, 80), surprise: best.rate,
    public: {headline: `${c.alias(p)}: ${rs.length} prompts in ${span.toFixed(0)} days. Then never again.`, support},
  };
}

function typoFingerprint(c: DetectorContext): Draft | null {
  if (!c.dictionary) return null;
  const t = typoPairs(c.table.vocab, c.dictionary);
  if (!t) return null;
  const [a, b2, c2, d2] = t.top;
  const kind = t.kind ? ` Your signature slip: you ${t.kind.name} (${pct(t.kind.count, t.total).toFixed(0)}% of ${t.total} typos).` : '';
  const support = `Also “${b2!.typo}”, “${c2!.typo}”, “${d2!.typo}”.${kind}`;
  return {
    id: 'typo_fingerprint', kind: 'language', section: 'talk', wow: 60,
    headline: `You've typed “${a!.typo}” ${a!.count} times. It's “${a!.word}”.`, support,
    numbers: {typos: t.total, pairs: t.pairs, top: a!.typo, top_count: a!.count, correction: a!.word, typo: a!.typo, word: a!.word, count: a!.count},
    chart: {type: 'keyboard', series: [{name: 'typos', points: t.top.map(p => ({x: p.typo, y: p.count, label: p.word}))}], unit: 'count'},
    confidence: clears(t.pairs, 10), surprise: 1 + a!.count / 5,
    public: {headline: `${t.total} typos, one fingerprint.`, support: t.kind ? `Your signature slip: you ${t.kind.name} (${pct(t.kind.count, t.total).toFixed(0)}% of ${t.total} typos).` : `${t.pairs} words you keep mistyping.`},
  };
}

const SHELL = new Set(['claude', 'codex', 'npm', 'npx', 'pip', 'git', 'cd', 'ls', 'python', 'brew', 'curl', 'export', 'source', 'sudo', 'pnpm', 'yarn', 'node']);
function firstVsLatest(c: DetectorContext): Draft | null {
  if (c.rows.length < 200) return null;
  const a = c.rows[0]!, b = c.rows.at(-1)!;
  const span = (b.ts - a.ts) / 86_400_000;
  if (span < 60) return null;
  const qa = shorten(a.q, 60);
  const shell = SHELL.has(a.f.fw);
  const headline = shell ? 'Your first ever prompt was a terminal command typed into a chat box.' : qa ? `Your first ever prompt: “${qa}”` : `Your first prompt was ${a.f.w} words. Your latest was ${b.f.w}.`;
  const support = `${dayName(a.day, 'year')}, ${a.f.w} words. ${f0(span)} days and ${f0(c.rows.length)} prompts later, your latest ran to ${b.f.w} words.`;
  return {
    id: 'first_vs_latest', kind: 'growth', section: 'first_latest', wow: 60, headline, support,
    numbers: {first_day: a.day, first_words: a.f.w, first_is_shell_command: shell, latest_day: b.day, latest_words: b.f.w, days: Math.round(span)},
    chart: {type: 'two_bubbles', series: [{name: 'words', points: [{x: 'then', y: a.f.w, label: a.day}, {x: 'now', y: b.f.w, label: b.day}]}], unit: 'words'},
    quote: shell ? null : qa, confidence: clears(span, 60), surprise: 1 + span / 180,
    public: {headline: shell ? headline : `Your first prompt was ${a.f.w} words. Your latest was ${b.f.w}.`, support},
  };
}

function orchestrator(c: DetectorContext): Draft | null {
  const M = new Map<string, [number, number]>();
  for (const r of c.rows) { const m = M.get(r.month) ?? [0, 0]; m[0] += r.subs ?? 0; m[1]++; M.set(r.month, m); }
  const months = [...M.keys()].sort();
  const total = months.reduce((n, m) => n + M.get(m)![0], 0);
  const first = months.find(m => M.get(m)![0] >= 5);
  if (total < 30 || !first) return null;
  const before = months.filter(m => m < first).reduce((n, m) => n + M.get(m)![1], 0);
  const launchedBefore = months.filter(m => m < first).reduce((n, m) => n + M.get(m)![0], 0);
  const peak = months.reduce((a, b) => (M.get(b)![0] > M.get(a)![0] ? b : a));
  const lead = launchedBefore === 0 ? `Zero before ${monthName(first, 'long')}` : `Only ${launchedBefore} before ${monthName(first, 'long')}`;
  const support = lead + (before ? ` (${f0(before)} prompts of doing it yourself)` : '') + `. Peak: ${monthName(peak, 'short')}, ${M.get(peak)![0]}.`;
  return {
    id: 'orchestrator', kind: 'habit', section: 'delegation', wow: 60,
    headline: `You went from typing to managing: ${f0(total)} subagents launched.`, support,
    numbers: {subagents_total: total, first_month: first, launched_before: launchedBefore, prompts_before: before, peak_month: peak, peak: M.get(peak)![0],
      total, firstMonth: first, promptsBefore: before, launchedBefore, peakMonth: peak, peakCount: M.get(peak)![0]},
    chart: {type: 'bar', motif: 'clones', series: [{name: 'subagents', points: months.map(m => ({x: m, y: M.get(m)![0]}))}], highlight: first, unit: 'subagents'},
    confidence: clears(total, 30), surprise: 1 + total / 30, public: {headline: `You went from typing to managing: ${f0(total)} subagents launched.`, support},
  };
}

function priciestProject(c: DetectorContext): Draft | null {
  const P = new Map<string, [number, number]>();
  for (const r of c.rows) if (r.costTotalUsd) { const v = P.get(r.project ?? '(unknown)') ?? [0, 0]; v[0] += r.costTotalUsd; v[1]++; P.set(r.project ?? '(unknown)', v); }
  const cand = [...P].filter(([, v]) => v[1] >= 30).map(([p, v]) => ({p, per: v[0] / v[1], total: v[0], n: v[1]})).sort((a, b) => b.per - a.per);
  if (cand.length < 3) return null;
  const top = cand[0]!, low = cand.at(-1)!;
  if (top.per < 3 * low.per) return null;
  const support = `That's ${(top.per / low.per).toFixed(0)}× ${base(low.p)} (${usd2(low.per)}/prompt). ${usd0(top.total)} across ${top.n} prompts.`;
  return {
    id: 'priciest_project', kind: 'money', section: 'projects', wow: 55,
    headline: `Every prompt in ${base(top.p)} costs ${usd2(top.per)}.`, support,
    numbers: {project: base(top.p), usd_per_prompt: r2(top.per), total_usd: r2(top.total), prompts: top.n, cheapest: base(low.p), cheapest_usd_per_prompt: r2(low.per), costPerPrompt: r2(top.per), factor: r1(top.per / low.per)},
    chart: {type: 'bubbles', series: [{name: '$ per prompt', points: cand.slice(0, 12).map(x => ({x: base(x.p), y: r2(x.per), label: `${x.n} prompts · ${usd0(x.total)}`}))}], highlight: base(top.p), unit: 'usd'},
    confidence: clears(top.per / low.per, 3), surprise: top.per / low.per,
    public: {headline: `Every prompt in your priciest project costs ${usd2(top.per)}.`, support: `That's ${(top.per / low.per).toFixed(0)}× your cheapest (${usd2(low.per)}/prompt). ${usd0(top.total)} across ${top.n} prompts.`},
  };
}

function lengthEvolution(c: DetectorContext): Draft | null {
  const M = groupBy(c.rows, r => r.month);
  const months = [...M.keys()].sort().filter(m => M.get(m)!.length >= 40);
  if (months.length < 4) return null;
  const e = median(months.slice(0, 2).flatMap(m => M.get(m)!.map(r => r.f.w)))!, l = median(M.get(months.at(-1)!)!.map(r => r.f.w))!;
  if (l < 1.8 * e && e < 1.8 * l) return null;
  const up = l > e;
  const k = up ? l / Math.max(e, 1) : e / Math.max(l, 1);
  const headline = up ? `Your prompts got ${f1(k)}× longer.` : `Your prompts got ${f1(k)}× shorter.`;
  const support = `Median ${e.toFixed(0)} words in ${monthName(months[0]!)}, ${l.toFixed(0)} now.` + (up ? ' You stopped commanding and started briefing.' : ' You learned to trust it.');
  return {
    id: 'prompt_length_evolution', kind: 'growth', section: 'talk', wow: 55, headline, support,
    numbers: {early_median_words: e, now_median_words: l, ratio: r1(k)},
    chart: {type: 'line', series: [{name: 'median words', points: months.map(m => ({x: m, y: median(M.get(m)!.map(r => r.f.w))!}))}], unit: 'words'},
    confidence: clears(k, 1.8), surprise: k, public: {headline, support},
  };
}

export function longestStretch(rows: readonly StoryRow[]): {ms: number; start: StoryRow; end: StoryRow; n: number} | null {
  if (!rows.length) return null;
  let best = {ms: 0, start: rows[0]!, end: rows[0]!, n: 1}, s = rows[0]!, n = 1;
  for (let i = 1; i <= rows.length; i++) {
    const a = rows[i - 1]!, b = rows[i];
    if (!b || b.ts - a.ts > 45 * 60_000) {
      if (a.ts - s.ts > best.ms) best = {ms: a.ts - s.ts, start: s, end: a, n};
      if (b) { s = b; n = 1; }
    } else n++;
  }
  return best;
}

function marathon(c: DetectorContext): Draft | null {
  const b = longestStretch(c.rows);
  if (!b || b.ms < 3 * 3_600_000) return null;
  const h = b.ms / 3_600_000;
  const support = `${dayName(b.start.day)}, ${clock12(b.start.ts, b.start.hour, b.start.minute)} to ${clock12(b.end.ts, b.end.hour, b.end.minute)}` + (b.end.day !== b.start.day ? ' the next morning' : '') + `. ${b.n} prompts, never more than 45 minutes apart.`;
  return {
    id: 'marathon', kind: 'time', section: 'more', wow: 55, headline: `Longest unbroken stretch: ${f1(h)} hours.`, support,
    numbers: {hours: r2(h), start_day: b.start.day, start_hour: b.start.hour, end_day: b.end.day, end_hour: b.end.hour, prompts: b.n, day: b.start.day},
    chart: {type: 'big_number', series: [{name: 'hours', points: [{x: 'stretch', y: r1(h)}]}], unit: 'hours'},
    confidence: clears(h, 3), surprise: h / 3, public: {headline: `Longest unbroken stretch: ${f1(h)} hours.`, support},
  };
}

function graveyard(c: DetectorContext): Draft | null {
  const last = newest(c);
  const real = [...projectsOf(c)].filter(([p, rs]) => rs.length >= 5 && p !== '(unknown)');
  const dead = real.filter(([, rs]) => (last - rs.at(-1)!.ts) / 86_400_000 >= 30).sort((a, b) => b[1].length - a[1].length);
  if (real.length < 8 || dead.length < 5) return null;
  const headline = `${dead.length} of your ${real.length} projects haven't heard from you in a month.`;
  return {
    id: 'project_graveyard', kind: 'project', section: 'projects', wow: 55, headline,
    support: `Only ${real.length - dead.length} are still alive. Most-mourned: ${dead.slice(0, 3).map(([p]) => base(p)).join(', ')}.`,
    numbers: {projects: real.length, dead_30d: dead.length},
    chart: {type: 'grid', motif: 'tombstones', series: [{name: 'prompts', points: dead.slice(0, 24).map(([p, rs]) => ({x: base(p), y: rs.length}))}], unit: 'prompts'},
    confidence: clears(dead.length, 5), surprise: 1 + dead.length / real.length,
    public: {headline, support: `Only ${real.length - dead.length} are still alive.`},
  };
}

function escKey(c: DetectorContext): Draft | null {
  const I = c.rows.filter(r => r.intr !== null);
  const hits = I.filter(r => r.intr);
  if (I.length < 200 || hits.length < 10) return null;
  const t = median(hits.map(r => r.durS).filter((x): x is number => !!x));
  const wa = median(c.rows.filter(r => r.prevIntr).map(r => r.f.w)), wn = median(I.filter(r => !r.prevIntr).map(r => r.f.w));
  const longer = wa !== null && wn !== null ? wa / Math.max(wn, 1) : null;
  const support = (t !== null ? `Usually ${t.toFixed(0)}s in.` : '') + (longer !== null && longer >= 1.2 ? ` The prompt that follows is ${f1(longer)}× longer than your usual: you explain yourself after you interrupt.` : '');
  return {
    id: 'esc_key', kind: 'habit', section: 'delegation', wow: 50, headline: `You've slammed Esc ${hits.length} times.`, support: support.trim() || `${pct(hits.length, I.length).toFixed(0)}% of your turns.`,
    numbers: {interrupts: hits.length, turns: I.length, median_seconds_in: t, words_after: wa, words_normal: wn},
    chart: {type: 'big_number', series: [{name: 'interrupts', points: [{x: 'esc', y: hits.length}]}], unit: 'count'},
    confidence: clears(hits.length, 10), surprise: 1 + (longer ?? 1) / 2, public: {headline: `You've slammed Esc ${hits.length} times.`, support: support.trim() || `${pct(hits.length, I.length).toFixed(0)}% of your turns.`},
  };
}

function predictedNextWord(c: DetectorContext): Draft | null {
  const n = c.rows.length;
  if (n < 200) return null;
  const fw = mostCommon(counter(c.rows.map(r => r.f.fw).filter(Boolean)));
  if (!fw.length) return null;
  const [w, k] = fw[0]!;
  const share = pct(k, n);
  if (share < 5 || isSwearWord(w)) return null;
  const support = `${share.toFixed(0)}% of everything you've ever typed opens that way (${f0(k)} times). 1-in-${(n / k).toFixed(0)} odds, better than any model's.`;
  return {
    id: 'predicted_next_word', kind: 'language', section: 'talk', wow: 50, headline: `Prediction: your next prompt starts with “${w}”.`, support,
    numbers: {word: w, count: k, share_pct: r1(share), pct: r1(share)},
    chart: {type: 'autocomplete', series: [{name: 'share %', points: fw.slice(0, 8).filter(([x]) => !isSwearWord(x)).map(([x, v]) => ({x, y: r1(pct(v, n))}))}], unit: 'pct'},
    confidence: clears(share, 5), surprise: share / 2, public: {headline: `Prediction: your next prompt starts with “${w}”.`, support},
  };
}

export function longestStreak(rows: readonly StoryRow[]): {days: number; start: string; end: string; active: number} | null {
  const days = [...new Set(rows.map(r => r.day))].sort();
  if (!days.length) return null;
  let best = 1, cur = 1, bs = days[0]!, be = days[0]!, s0 = days[0]!;
  for (let i = 1; i < days.length; i++) {
    if (daysBetween(days[i - 1]!, days[i]!) === 1) { cur++; if (cur > best) { best = cur; bs = s0; be = days[i]!; } } else { cur = 1; s0 = days[i]!; }
  }
  return {days: best, start: bs, end: be, active: days.length};
}

function streak(c: DetectorContext): Draft | null {
  const s = longestStreak(c.rows);
  if (!s || s.days < 7) return null;
  const counts = counter(c.rows.filter(r => r.day >= s.start && r.day <= s.end).map(r => r.day));
  const support = `${dayName(s.start)} to ${dayName(s.end)}. ${s.active} active days in total.`;
  return {
    id: 'streak', kind: 'time', section: 'scale', wow: 45, headline: `${s.days} days in a row. Not one day off.`, support,
    numbers: {streak: s.days, start: s.start, end: s.end, active_days: s.active, days: s.days, from: s.start, to: s.end},
    chart: {type: 'calendar', series: [{name: 'prompts', points: [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, 60).map(([x, y]) => ({x, y}))}], unit: 'prompts'},
    confidence: clears(s.days, 7), surprise: s.days / 7, public: {headline: `${s.days} days in a row. Not one day off.`, support},
  };
}

function commandToQuestion(c: DetectorContext): Draft | null {
  const a = c.rows.filter(r => r.turn <= 3), b = c.rows.filter(r => r.turn >= 40);
  if (a.length < 100 || b.length < 100) return null;
  const q = (rs: StoryRow[]) => pct(rs.filter(r => has(r.f, FLAG.question)).length, rs.length);
  const qa = q(a), qb = q(b);
  if (qb < 1.5 * qa) return null;
  const buckets: [string, (t: number) => boolean][] = [['1–3', t => t <= 3], ['4–10', t => t > 3 && t <= 10], ['11–39', t => t > 10 && t < 40], ['40+', t => t >= 40]];
  const support = `${qa.toFixed(0)}% of your first three prompts are questions. Past prompt #40, it's ${qb.toFixed(0)}%.`;
  return {
    id: 'command_to_question', kind: 'habit', section: 'talk', wow: 45, headline: 'You start sessions giving orders and end them asking questions.', support,
    numbers: {q_early_pct: r1(qa), q_deep_pct: r1(qb)},
    chart: {type: 'line', series: [{name: 'question %', points: buckets.map(([x, f]) => ({x, y: r1(q(c.rows.filter(r => f(r.turn))))}))}], unit: 'pct'},
    confidence: clears(qb / Math.max(qa, 0.5), 1.5), surprise: qb / Math.max(qa, 0.5), public: {headline: 'You start sessions giving orders and end them asking questions.', support},
  };
}

function walkAway(c: DetectorContext): Draft | null {
  const g = c.rows.map(r => r.gapReplyS).filter((x): x is number => x !== null && x >= 0);
  if (g.length < 150) return null;
  const m = median(g)!, fast = pct(g.filter(x => x < 60).length, g.length);
  const q = median(c.rows.filter(r => r.gapReplyS !== null && has(r.f, FLAG.question)).map(r => r.gapReplyS!));
  let headline: string, support: string;
  if (m >= 240) { headline = `You don't babysit. You come back ${(m / 60).toFixed(0)} minutes after the agent finishes.`; support = `Only ${fast.toFixed(0)}% of your replies land within a minute.`; }
  else if (m <= 45) { headline = `You reply ${m.toFixed(0)} seconds after the agent stops. Every time.`; support = `${fast.toFixed(0)}% of your replies land within a minute. Go outside.`; }
  else return null;
  if (q && m && Math.abs(q - m) / m > 0.3) support += q < m ? ` Questions come faster (${(q / 60).toFixed(0)} min): curiosity beats patience.` : ` Questions take longer (${(q / 60).toFixed(0)} min).`;
  const edges = [5, 15, 30, 60, 120, 300, 900, 1800, 3600, 4 * 3600, 24 * 3600];
  const labels = ['<5s', '5–15s', '15–30s', '30–60s', '1–2m', '2–5m', '5–15m', '15–30m', '30–60m', '1–4h', '4–24h', '>1d'];
  const hist = new Array(labels.length).fill(0) as number[];
  for (const x of g) { let i = 0; while (i < edges.length && x >= edges[i]!) i++; hist[i]!++; }
  return {
    id: 'walk_away', kind: 'habit', section: 'delegation', wow: 45, headline, support,
    numbers: {median_gap_s: Math.round(m), under_60s_pct: r1(fast), question_gap_s: q === null ? null : Math.round(q), n: g.length},
    chart: {type: 'histogram', series: [{name: 'replies', points: hist.map((y, i) => ({x: labels[i]!, y}))}], unit: 'prompts'},
    confidence: clears(g.length, 150), surprise: m >= 240 ? m / 240 : 45 / Math.max(m, 1), public: {headline, support},
  };
}

function weekendSelf(c: DetectorContext): Draft | null {
  const we = c.rows.filter(r => r.dow >= 5), wd = c.rows.filter(r => r.dow < 5);
  if (we.length < 100 || wd.length < 300) return null;
  const a = angryRate(we), b = angryRate(wd);
  if (Math.max(a, b) < 3 || Math.max(a, b) / Math.max(Math.min(a, b), 0.3) < 1.5) return null;
  const calmer = a < b ? 'weekend' : 'weekday';
  const headline = calmer === 'weekend' ? 'Weekend you is a calmer person.' : 'Weekends make you meaner, somehow.';
  const support = `${f1(Math.min(a, b))}% of ${calmer} prompts swear, vs ${f1(Math.max(a, b))}% on ${calmer === 'weekend' ? 'weekdays' : 'weekends'}.`;
  const D = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return {
    id: 'weekend_self', kind: 'mood', section: 'clock', wow: 40, headline, support,
    numbers: {weekend_pct: r1(a), weekday_pct: r1(b)},
    chart: {type: 'bar', series: [{name: 'swear %', points: D.map((x, i) => ({x, y: r1(angryRate(c.rows.filter(r => r.dow === i)))}))}], unit: 'pct'},
    confidence: clears(Math.max(a, b) / Math.max(Math.min(a, b), 0.3), 1.5), surprise: Math.max(a, b) / Math.max(Math.min(a, b), 0.3), public: {headline, support},
  };
}

function dayNightTopics(c: DetectorContext): Draft | null {
  const night = c.rows.filter(r => r.hour < 5).length, day = c.rows.filter(r => r.hour >= 9 && r.hour < 19).length;
  if (night < 150 || day < 150) return null;
  const projects = new Set(c.rows.map(r => base(r.project).toLowerCase()));
  const obs = new Map<string, number>(), exp = new Map<string, number>(), tot = new Map<string, number>();
  for (const bag of c.table.topics.values()) {
    const share = bag.night / Math.max(1, bag.night + bag.day);
    for (const [w, [n, d]] of bag.words) {
      const k = n + d;
      tot.set(w, (tot.get(w) ?? 0) + k); obs.set(w, (obs.get(w) ?? 0) + n); exp.set(w, (exp.get(w) ?? 0) + k * share);
    }
  }
  const top = (nightSide: boolean) => {
    const s: [number, string][] = [];
    for (const [w, k] of tot) {
      if (k < 15 || projects.has(w)) continue;
      const o = nightSide ? obs.get(w)! : k - obs.get(w)!, e = nightSide ? exp.get(w)! : k - exp.get(w)!;
      if (o >= 10) s.push([(o + 1) / (e + 1), w]);
    }
    return s.sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? 1 : -1)).slice(0, 4).filter(([sc]) => sc >= 1.6).map(([, w]) => w);
  };
  const tn = top(true), td = top(false);
  if (tn.length < 3 || td.length < 3) return null;
  return {
    id: 'day_night_topics', kind: 'time', section: 'clock', wow: 80,
    headline: `By day you fight ${td[0]} and ${td[1]}. After midnight you talk ${tn[0]} and ${tn[1]}.`,
    support: `Your 3am vocabulary: ${tn.join(', ')}. Your 3pm vocabulary: ${td.join(', ')}.`,
    numbers: {night_words: tn.join(','), day_words: td.join(','), n_night: night, n_day: day},
    chart: {type: 'words', motif: 'sun_moon', series: [{name: 'night', points: tn.map((x, i) => ({x, y: 4 - i}))}, {name: 'day', points: td.map((x, i) => ({x, y: 4 - i}))}]},
    confidence: 0.6, surprise: 1.6, public: null,
  };
}

/* ------------------------------------------------------------- registry --- */

export type Detector = (c: DetectorContext, shifted: (ts: number) => string) => Draft | null;
/** Fixed order: ties in ranking keep this order. */
export const DETECTORS: readonly [string, Detector][] = [
  ['most_expensive_sentence', mostExpensiveSentence], ['mood_drift', moodDrift], ['worst_model', worstModel], ['best_model', bestModel],
  ['honeymoon', honeymoon], ['thanks_vs_swears', thanksVsSwears], ['day_night_topics', dayNightTopics], ['one_that_got_away', gotAway],
  ['continue_count', continueCount], ['verbal_tics', verbalTics], ['fuse_length', fuse], ['pet_names', petNames], ['rage_day', rageDay],
  ['defection', defection], ['night_owl', nightOwl], ['i_to_we', iToWe], ['rant_length', rantLength], ['typo_fingerprint', typoFingerprint],
  ['orchestrator', orchestrator], ['sprint_and_vanish', sprintAndVanish], ['prompt_length_evolution', lengthEvolution], ['marathon', marathon],
  ['priciest_project', priciestProject], ['project_graveyard', graveyard], ['esc_key', escKey], ['streak', streak],
  ['predicted_next_word', predictedNextWord], ['command_to_question', commandToQuestion], ['weekend_self', weekendSelf],
  ['first_vs_latest', firstVsLatest], ['walk_away', walkAway],
];

/** Runs every detector; one that throws is dropped, never the board. */
export function runDetectors(c: DetectorContext, shifted: (ts: number) => string): {cards: StoryCard[]; suppressed: {id: string; reason: string}[]; drafts: Map<string, Draft>; ms: Record<string, number>} {
  const drafts: {d: Draft; order: number}[] = [], suppressed: {id: string; reason: string}[] = [], byId = new Map<string, Draft>();
  const ms: Record<string, number> = {};
  DETECTORS.forEach(([id, fn], order) => {
    const t = performance.now();
    try {
      const d = c.rows.length ? fn(c, shifted) : null;
      if (d) { drafts.push({d, order}); byId.set(id, d); } else suppressed.push({id, reason: 'guard'});
    } catch {
      suppressed.push({id, reason: 'error'});
    }
    ms[id] = Math.round((performance.now() - t) * 10) / 10;
  });
  const scored = drafts.map(({d, order}) => ({d, order, score: Math.round(d.wow * (0.6 + 0.4 * d.confidence) * (1 + 0.08 * Math.log2(Math.max(1, d.surprise))) * 10) / 10}))
    .sort((a, b) => b.score - a.score || a.order - b.order);
  const cards: StoryCard[] = scored.map(({d, score}, i) => ({
    id: d.id, kind: d.kind, section: d.section, headline: d.headline, support: d.support, numbers: d.numbers, chart: d.chart,
    ...(d.quote !== undefined ? {quote: d.quote} : {}), confidence: r2(d.confidence), wow: d.wow, surprise: r2(Math.max(1, d.surprise)), score, rank: i + 1, public: d.public,
  }));
  return {cards, suppressed, drafts: byId, ms};
}

export const homeDir = () => os.homedir();
export {ordinal};

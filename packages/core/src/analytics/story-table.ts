/**
 * The per-prompt feature table the story detectors run on (one row per human
 * prompt in scope), built from the aggregate without any prompt text.
 *
 *  - Claude transcript prompts take their features from the matching typed
 *    entry of ~/.claude/history.jsonl (same session, |Δt| < 5 s): transcripts
 *    expand pastes inline, history keeps what was typed.
 *  - Turn cost = priced, de-duplicated responses between this prompt and the
 *    next one of the conversation, plus subagent spend in the same window.
 *  - History-only prompts have no responses; their model is inferred from the
 *    nearest day (≤21 d) of Claude usage and ~/.claude/stats-cache.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import {sourceId} from '../memory/source-identity.js';
import type {Aggregate} from './aggregate.js';
import type {HistoryEntry, PromptFact, SourceFacts, UsageFact} from './extract.js';
import {FLAG, has, type PromptFeatures} from './story-lexicon.js';
import type {StoryHarness} from './story-contracts.js';
import {localClock} from './story-time.js';

export interface StoryRow {
  id: string;
  /** Conversation (top-level session) id. */
  conv: string;
  harness: StoryHarness;
  /** Epoch ms. */
  ts: number;
  project: string | null;
  model: string | null;
  modelSrc: 'observed' | 'inferred' | 'none';
  /** 1-based index of the prompt in its conversation. */
  turn: number;
  gapReplyS: number | null;
  gapPromptS: number | null;
  intr: boolean | null;
  prevIntr: boolean | null;
  costUsd: number | null;
  costTotalUsd: number | null;
  outTokens: number | null;
  durS: number | null;
  tools: number | null;
  subs: number | null;
  day: string;
  month: string;
  hour: number;
  minute: number;
  dow: number;
  f: PromptFeatures;
  /** Safe quote candidate (fixed slots only). */
  q: string | null;
  typed: boolean;
  angry: boolean;
  polite: boolean;
}

export interface StoryTable {
  rows: StoryRow[];
  /** Word counters for typos and day/night topics (from history.jsonl, Codex, pi, OpenCode). */
  vocab: Map<string, number>;
  topics: Map<string, {night: number; day: number; words: Map<string, [number, number]>}>;
  sessions: {conv: string; harness: StoryHarness; project: string | null; costUsd: number; subCostUsd: number; first: number; last: number; prompts: number}[];
}

interface Spend {at: number; cost: number; out: number; model: string | null}

const memo = new Map<string, string>();
const sid = (h: string, id: string) => { const k = `${h}\0${id}`; let v = memo.get(k); if (!v) { v = sourceId(h, id); memo.set(k, v); } return v; };

export interface StoryTableInput {
  aggregate: Aggregate;
  history: readonly HistoryEntry[];
  historyCounters: ReadonlyMap<string, {project: string | null; vocab: Map<string, number>; topics: Map<string, {night: number; day: number; words: Map<string, [number, number]>}>}>;
  historyFile: string | null;
  timezone: string;
  /** Projects the user ignores and sessions forgotten (counters are filtered by them). */
  allowed: (project: string | null, session: string | null) => boolean;
}

export function buildStoryTable(input: StoryTableInput): StoryTable {
  const {aggregate: a, timezone} = input;
  const clock = localClock(timezone);
  const {refs, costOf, sources} = a.story;

  // ---- typed text of live Claude sessions, by session id
  const typed = new Map<string, HistoryEntry[]>();
  for (const h of input.history) if (h.kind === 'human' && h.f && h.sessionId && h.at !== null) {
    const list = typed.get(h.sessionId) ?? [];
    list.push(h);
    typed.set(h.sessionId, list);
  }

  // ---- spend per conversation: main thread and subagents
  const main = new Map<string, Spend[]>(), sub = new Map<string, Spend[]>();
  const dailyModel = new Map<string, Map<string, number>>();
  for (const s of sources) {
    const conv = sid(s.harness, s.child && s.parentId ? s.parentId : s.sessionId);
    const target = s.child ? sub : main;
    let list = target.get(conv);
    for (const u of s.usage) {
      if (s.harness === 'claude' && u.model && u.at !== null) {
        const day = clock(u.at).day;
        const m = dailyModel.get(day) ?? new Map<string, number>();
        m.set(u.model, (m.get(u.model) ?? 0) + 1);
        dailyModel.set(day, m);
      }
      const cost = costOf.get(u);
      if (cost === undefined || u.at === null) continue;
      if (!list) { list = []; target.set(conv, list); }
      list.push({at: u.at, cost, out: u.output, model: u.model});
    }
  }
  for (const list of [...main.values(), ...sub.values()]) list.sort((x, y) => x.at - y.at);
  addStatsCache(input.historyFile, dailyModel);
  const knownDays = [...dailyModel.keys()].sort();

  // ---- rows
  const byConv = new Map<string, {row: StoryRow; fact: PromptFact | HistoryEntry}[]>();
  const rows: StoryRow[] = [];
  for (const ref of refs) {
    const fact = ref.fact;
    if (!fact.f || fact.at === null) continue;
    const s = ref.source;
    let f = fact.f, q = 'q' in fact ? fact.q ?? null : null, isTyped = ref.history;
    if (s && s.harness === 'claude' && !s.child) {
      const match = matchTyped(typed, s, fact.at);
      if (match) { f = match.f!; q = match.q ?? null; isTyped = true; }
    }
    const harness: StoryHarness = ref.history ? 'claude_hist' : (s?.harness ?? 'claude');
    const local = clock(fact.at);
    const t = 'key' in fact ? fact.t : undefined;
    const row: StoryRow = {
      id: ref.prompt.id, conv: ref.prompt.conversationId, harness, ts: fact.at, project: ref.prompt.project ?? null,
      model: null, modelSrc: 'none', turn: 0, gapReplyS: t?.g ?? null, gapPromptS: null,
      intr: t ? t.x === 1 : null, prevIntr: null,
      costUsd: null, costTotalUsd: null, outTokens: null, durS: t?.d ?? null, tools: t ? t.tl : null, subs: t ? t.sa : null,
      day: local.day, month: local.month, hour: local.hour, minute: local.minute, dow: local.dow,
      f, q, typed: isTyped, angry: f.sw > 0 || f.ins > 0, polite: has(f, FLAG.polite),
    };
    rows.push(row);
    const list = byConv.get(row.conv) ?? [];
    list.push({row, fact});
    byConv.set(row.conv, list);
  }

  // ---- turns, windows, sessions
  const sessions: StoryTable['sessions'] = [];
  for (const [conv, list] of byConv) {
    list.sort((x, y) => x.row.ts - y.row.ts);
    const spend = main.get(conv) ?? [], subs = sub.get(conv) ?? [];
    let j = 0, k = 0, cost = 0, subCost = 0;
    list.forEach(({row}, i) => {
      row.turn = i + 1;
      if (i) { row.gapPromptS = Math.round((row.ts - list[i - 1]!.row.ts) / 100) / 10; row.prevIntr = list[i - 1]!.row.intr; } else row.prevIntr = row.intr === null ? null : false;
      if (row.harness === 'claude_hist') return;
      const next = i + 1 < list.length ? list[i + 1]!.row.ts : Infinity;
      while (j < spend.length && spend[j]!.at < row.ts) j++;
      let c = 0, out = 0;
      const models = new Map<string, number>();
      while (j < spend.length && spend[j]!.at < next) { const e = spend[j++]!; c += e.cost; out += e.out; if (e.model) models.set(e.model, (models.get(e.model) ?? 0) + 1); }
      while (k < subs.length && subs[k]!.at < row.ts) k++;
      let sc = 0;
      while (k < subs.length && subs[k]!.at < next) sc += subs[k++]!.cost;
      row.costUsd = c; row.costTotalUsd = c + sc; row.outTokens = out;
      cost += c; subCost += sc;
      let best: string | null = null, bestN = 0;
      for (const [m, n] of models) if (n > bestN) { best = m; bestN = n; }
      if (best) { row.model = best; row.modelSrc = 'observed'; }
    });
    const first = list[0]!.row;
    if (first.harness === 'claude_hist') for (const {row} of list) inferModel(row, dailyModel, knownDays);
    sessions.push({conv, harness: first.harness, project: first.project, costUsd: cost, subCostUsd: subCost, first: first.ts, last: list.at(-1)!.row.ts, prompts: list.length});
  }
  rows.sort((x, y) => x.ts - y.ts || x.id.localeCompare(y.id));

  // ---- word counters (Claude transcripts excluded: their typed text is in history.jsonl)
  const vocab = new Map<string, number>();
  const topics: StoryTable['topics'] = new Map();
  const addTopics = (month: string, bag: {night: number; day: number; words: Map<string, [number, number]>}) => {
    let t = topics.get(month);
    if (!t) { t = {night: 0, day: 0, words: new Map()}; topics.set(month, t); }
    t.night += bag.night; t.day += bag.day;
    for (const [w, [n, d]] of bag.words) { const c = t.words.get(w); if (c) { c[0] += n; c[1] += d; } else t.words.set(w, [n, d]); }
  };
  const inScope = new Set(rows.map(r => r.conv));
  for (const s of sources) {
    if (!s.story?.vocab || !inScope.has(sid(s.harness, s.sessionId))) continue;
    for (const [w, n] of s.story.vocab) vocab.set(w, (vocab.get(w) ?? 0) + n);
    for (const bag of s.story.topics ?? []) addTopics(bag.month, bag);
  }
  for (const [session, c] of input.historyCounters) {
    if (!input.allowed(c.project, session || null) || !inScope.has(sid('claude', session))) continue;
    for (const [w, n] of c.vocab) vocab.set(w, (vocab.get(w) ?? 0) + n);
    for (const [month, bag] of c.topics) addTopics(month, bag);
  }
  return {rows, vocab, topics, sessions};
}

function matchTyped(typed: Map<string, HistoryEntry[]>, s: SourceFacts, at: number): HistoryEntry | null {
  for (const session of s.sessionIds ?? [s.sessionId]) {
    for (const h of typed.get(session) ?? []) if (Math.abs(h.at! - at) < 5000) return h;
  }
  return null;
}

function inferModel(row: StoryRow, daily: Map<string, Map<string, number>>, days: string[]): void {
  // Nearest known day at or before, or the next one; within 21 days.
  let lo = 0, hi = days.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (days[mid]! <= row.day) lo = mid + 1; else hi = mid; }
  const i = lo - 1;
  const dist = (d: string) => Math.abs(Date.parse(`${d}T00:00:00Z`) - Date.parse(`${row.day}T00:00:00Z`)) / 86_400_000;
  let best: string | null = null;
  for (const x of [i, i + 1]) {
    const d = days[x];
    if (d === undefined || dist(d) > 21) continue;
    if (best === null || dist(d) < dist(best)) best = d;
  }
  if (!best) return;
  let model: string | null = null, n = -1;
  for (const [m, c] of daily.get(best)!) if (c > n) { model = m; n = c; }
  if (model) { row.model = model; row.modelSrc = 'inferred'; }
}

/** ~/.claude/stats-cache.json: Claude's own per-day model token counts (covers deleted transcripts). */
function addStatsCache(historyFile: string | null, daily: Map<string, Map<string, number>>): void {
  if (!historyFile) return;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(path.dirname(historyFile), 'stats-cache.json'), 'utf8')) as {dailyModelTokens?: {date?: string; tokensByModel?: Record<string, number>}[]};
    for (const row of raw.dailyModelTokens ?? []) {
      if (typeof row.date !== 'string' || !row.tokensByModel) continue;
      const m = daily.get(row.date) ?? new Map<string, number>();
      for (const [model, n] of Object.entries(row.tokensByModel)) if (typeof n === 'number') m.set(model, (m.get(model) ?? 0) + n);
      daily.set(row.date, m);
    }
  } catch { /* optional */ }
}

export type {UsageFact};

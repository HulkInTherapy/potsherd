/**
 * Story facts derived from one file while its text is in memory: per-prompt
 * features, the lexical data the legacy language passes need, per-turn
 * response stats, bounded quote candidates for fixed slots, and per-file
 * word counters. After this runs the prompt text can be dropped.
 */
import type {AuditPromptLex} from './contracts.js';
import {profanityHits} from './profanity.js';
import {languageLines, namedModels} from './language-feedback.js';
import {focusLabels} from './project-focus.js';
import {normalizedLine} from './findings.js';
import {featurize, safeQuote, topicWords, vocabularyWords, type PromptFeatures} from './story-lexicon.js';
import {localClock} from './story-time.js';

/** Tools that start a subagent. */
export const AGENT_TOOLS = new Set(['Task', 'Agent', 'spawn_agent', 'spawn_agents', 'TaskCreate']);
export const isAgentTool = (name: string) => AGENT_TOOLS.has(name) || name.startsWith('spawn');

/** One assistant-side event (a response line or a tool call). */
export interface TurnEvent {at: number; tools: number; subs: number; weight: number}

/** Response stats of the turn a prompt started, from this file's events. */
export interface TurnStats {
  /** Assistant events until the next prompt. */ m: number;
  /** Tool calls. */ tl: number;
  /** Subagents launched. */ sa: number;
  /** Seconds from the prompt to the last assistant event of the turn. */ d: number | null;
  /** The turn was interrupted (Esc / turn_aborted). */ x: 0 | 1;
  /** Seconds since the last assistant event before this prompt. */ g: number | null;
}

/** Words per month and slot (0 = night 0–4h, 1 = day 9–18h) in documents (prompts). */
export interface TopicBag {month: string; night: number; day: number; words: Map<string, [number, number]>}

export interface StoryTextFacts {
  /** Word counts of this file's prompts (typo fingerprint); null for Claude transcripts (their typed text lives in history.jsonl). */
  vocab: Map<string, number> | null;
  topics: TopicBag[] | null;
}

interface PromptLike {key: string; at: number | null; text: string; kind: string; reason: string | null; project: string | null;
  before: string | null; after: string | null; f?: PromptFeatures; lex?: AuditPromptLex; q?: string; t?: TurnStats}

export function promptLex(text: string, models: Iterable<string>): AuditPromptLex | undefined {
  const lex: {-readonly [K in keyof AuditPromptLex]: AuditPromptLex[K]} = {};
  const hits = profanityHits(text);
  if (hits?.hits.length) lex.pt = hits.hits;
  if (hits?.ambiguous) lex.pa = 1;
  const nl = normalizedLine(text);
  if (nl !== null) lex.nl = nl;
  const fc = focusLabels(text);
  if (fc.length) lex.fc = fc;
  const nm = namedModels(text, models);
  if (nm.length) lex.nm = nm;
  const ll = languageLines(text);
  if (ll.length) lex.ll = ll;
  return Object.keys(lex).length ? lex : undefined;
}

const QUOTE_TOP = 8, QUOTE_SUBAGENT_TOP = 5, QUOTE_LAST_PER_PROJECT = 3;

/**
 * Adds story fields to the human prompts of one file (in place) and returns
 * the file's word counters. `typed` marks text the user typed (no inline pastes).
 */
export function deriveStory(prompts: PromptLike[], events: TurnEvent[], interrupts: number[], options: {typed: boolean; counters: boolean; timezone: string; from?: number; previous?: StoryTextFacts}): StoryTextFacts {
  const human = prompts.filter(p => p.kind === 'human' && p.at !== null).sort((a, b) => a.at! - b.at!);
  const fresh = new Set(prompts.slice(options.from ?? 0));
  const models = new Set<string>();
  for (const p of prompts) { if (p.before) models.add(p.before); if (p.after) models.add(p.after); }
  const vocab = options.counters ? options.previous?.vocab ?? new Map<string, number>() : null;
  const topics = options.counters ? new Map<string, TopicBag>((options.previous?.topics ?? []).map(t => [t.month, t])) : null;
  const clock = localClock(options.timezone);
  for (const p of human) {
    if (!fresh.has(p)) continue;
    p.f = featurize({text: p.text, typed: options.typed});
    const lex = promptLex(p.text, models);
    if (lex) p.lex = lex;
    if (vocab) for (const w of vocabularyWords(p.text)) vocab.set(w, (vocab.get(w) ?? 0) + 1);
    if (topics) {
      const {hour, month} = clock(p.at!);
      const slot = hour < 5 ? 0 : hour >= 9 && hour < 19 ? 1 : -1;
      if (slot >= 0) {
        let bag = topics.get(month);
        if (!bag) { bag = {month, night: 0, day: 0, words: new Map()}; topics.set(month, bag); }
        if (slot === 0) bag.night++; else bag.day++;
        for (const w of topicWords(p.text)) { let c = bag.words.get(w); if (!c) { c = [0, 0]; bag.words.set(w, c); } c[slot as 0 | 1]++; }
      }
    }
  }
  turnStats(human, events, interrupts);
  // Quote candidates only for the fixed slots: first prompt, last words per project,
  // the costliest turns (by a token-weight proxy) and the biggest subagent launches.
  const weight = new Map<PromptLike, number>();
  const slots = new Set<PromptLike>();
  if (human.length) slots.add(human[0]!);
  const byProject = new Map<string, PromptLike[]>();
  for (const p of human) { const k = p.project ?? ''; const list = byProject.get(k) ?? []; list.push(p); byProject.set(k, list); }
  for (const list of byProject.values()) for (const p of list.slice(-QUOTE_LAST_PER_PROJECT)) slots.add(p);
  turnWeights(human, events, weight);
  for (const p of [...human].sort((a, b) => (weight.get(b) ?? 0) - (weight.get(a) ?? 0)).slice(0, QUOTE_TOP)) slots.add(p);
  for (const p of human.filter(p => (p.t?.sa ?? 0) > 0).sort((a, b) => b.t!.sa - a.t!.sa).slice(0, QUOTE_SUBAGENT_TOP)) slots.add(p);
  for (const p of slots) { if (!p.text) continue; const q = safeQuote(p.text, 90); if (q) p.q = q; }
  return {vocab, topics: topics ? [...topics.values()] : null};
}

/** Two-pointer assignment of assistant events and interrupts to the turn windows [prompt, next prompt). */
function turnStats(human: PromptLike[], events: TurnEvent[], interrupts: number[]): void {
  const ev = events.filter(e => Number.isFinite(e.at)).sort((a, b) => a.at - b.at);
  const intr = interrupts.filter(Number.isFinite).sort((a, b) => a - b);
  let j = 0, k = 0, lastAt: number | null = null;
  human.forEach((p, i) => {
    const start = p.at!, next = i + 1 < human.length ? human[i + 1]!.at! : Infinity;
    while (j < ev.length && ev[j]!.at < start) lastAt = ev[j++]!.at;
    const t: TurnStats = {m: 0, tl: 0, sa: 0, d: null, x: 0, g: lastAt === null ? null : round1((start - lastAt) / 1000)};
    let end: number | null = null;
    while (j < ev.length && ev[j]!.at < next) { const e = ev[j++]!; t.m++; t.tl += e.tools; t.sa += e.subs; end = e.at; lastAt = e.at; }
    if (end !== null) t.d = round1((end - start) / 1000);
    while (k < intr.length && intr[k]! < start) k++;
    if (k < intr.length && intr[k]! < next) t.x = 1;
    p.t = t;
  });
}

function turnWeights(human: PromptLike[], events: TurnEvent[], out: Map<PromptLike, number>): void {
  const ev = events.filter(e => e.weight > 0).sort((a, b) => a.at - b.at);
  let j = 0;
  human.forEach((p, i) => {
    const next = i + 1 < human.length ? human[i + 1]!.at! : Infinity;
    while (j < ev.length && ev[j]!.at < p.at!) j++;
    let w = 0;
    while (j < ev.length && ev[j]!.at < next) w += ev[j++]!.weight;
    out.set(p, w);
  });
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** Token-weight proxy for turn cost ranking inside one file (output dearest, cache reads cheapest). */
export const usageWeight = (input: number, output: number, cacheRead: number, cacheWrite: number) => input + 5 * output + 1.25 * cacheWrite + 0.1 * cacheRead;

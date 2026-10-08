/**
 * Turns an AuditSnapshot into the small, display-ready facts the wallboard shows.
 * Everything here is pure and memoised per snapshot object.
 *
 * Honesty rules: unknown stays null (rendered "—"); nothing is invented; counts come
 * straight from the snapshot; ranking rules are stated in the details page.
 */
import type { AuditSnapshot, AuditMetric, AuditEvent } from '../../../core/src/analytics/contracts.js';
import type { ModelAggregate } from '../../../core/src/analytics/launch-contracts.js';
import { compact, count, harnessName, hourLabel, modelName, money, percent, shortDate } from './format.js';
import { sanitize } from './text.js';

export type CardState = 'pending' | 'ready' | 'empty';

export interface ModelRow {
  id: string;
  name: string;
  value: number | null;
  tokens: number | null;
  favourite: boolean;
  /** Priced with the closest catalog model, not an exact match. */
  estimated: boolean;
}

export interface ProjectRow {
  name: string;
  prompts: number;
  focus: string[];
}

export interface RepeatRow {
  text: string;
  count: number;
}

export interface ReactionRow {
  model: string;
  hits: number;
  of: number;
}

export interface BoardData {
  phase: 'finding' | 'reading' | 'finishing' | 'ready' | 'cancelled' | 'error';
  loading: boolean;
  progress: { label: string; done: number | null; total: number | null; unit: string } | null;
  sources: { name: string; files: number | null; state: 'checking' | 'found' | 'none' | 'unreadable' }[];
  range: { from: string | null; to: string | null };
  agents: string[];
  hero: { value: number | null; provisional: boolean };
  stats: {
    tokens: number | null;
    prompts: number | null;
    chats: number | null;
    projects: number | null;
    activeDays: number | null;
    streak: number | null;
  };
  personality: string | null;
  /** API-equivalent value split by coding agent, largest first. */
  agentSplit: { name: string; share: number }[];
  models: { state: CardState; rows: ModelRow[]; more: { models: number; value: number | null; tokens: number | null } | null };
  projects: { state: CardState; rows: ProjectRow[]; more: { projects: number; prompts: number } | null };
  activity: {
    state: CardState;
    days: { date: string; count: number }[];
    busiest: { date: string; count: number } | null;
    peakHour: number | null;
    topWeekday: string | null;
  };
  repeats: { state: CardState; rows: RepeatRow[] };
  reactions: { state: CardState; roasted: ReactionRow | null; praised: ReactionRow | null };
  swears: { state: CardState; total: number; prompts: number; eligible: number; top: { term: string; count: number }[] };
  footnote: string | null;
  failure: string | null;
}

const MIN_REACTION_SAMPLE = 20;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function metricValue(metric: AuditMetric | undefined): number | null {
  if (!metric || metric.state === 'unavailable' || metric.state === 'not_run') return null;
  return metric.value;
}

export function isLoading(snapshot: AuditSnapshot): boolean {
  if (snapshot.status === 'cancelled' || snapshot.status === 'error') return false;
  if (snapshot.launch) return snapshot.launch.stage !== 'ready';
  return ['discovering', 'parsing', 'normalizing'].includes(snapshot.status);
}

export const equivalentValue = (value: { valueUsd: number | null; referenceValueUsd: number | null }): number | null =>
  value.valueUsd === null && value.referenceValueUsd === null ? null : (value.valueUsd ?? 0) + (value.referenceValueUsd ?? 0);

function knownTokens(models: readonly ModelAggregate[]): number | null {
  const values = models.map(model => model.knownTokens ?? model.totalTokens).filter((value): value is number => value !== null && value !== undefined);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

const PROGRESS_LABELS: [RegExp, string][] = [
  [/discover/i, 'finding history'],
  [/privacy/i, 'checking privacy settings'],
  [/retained|saved|archive|canonical/i, 'reading saved archive'],
  [/native|reading/i, 'reading history files'],
  [/facts ready|assembl|building/i, 'adding it all up'],
  [/normaliz/i, 'tidying up'],
];

function friendlyProgress(label: string | undefined, fallback: string): string {
  if (!label) return fallback;
  for (const [pattern, text] of PROGRESS_LABELS) if (pattern.test(label)) return text;
  return fallback;
}

function progressOf(snapshot: AuditSnapshot, phase: BoardData['phase']): BoardData['progress'] {
  if (phase === 'ready' || phase === 'cancelled' || phase === 'error') return null;
  const facts = snapshot.launch?.factProgress;
  const label = friendlyProgress(snapshot.progress.label, phase === 'finding' ? 'finding history' : 'reading history');
  if (phase === 'finding') return { label, done: null, total: null, unit: 'files' };
  if (facts && facts.state === 'collecting' && facts.totalSources) {
    return { label: 'reading history files', done: facts.completedSources, total: facts.totalSources, unit: 'files' };
  }
  if (snapshot.launch?.stage && ['preparing', 'analyzing', 'assembling'].includes(snapshot.launch.stage)) {
    return { label: snapshot.launch.stage === 'analyzing' ? 'asking Jev for commentary' : 'adding it all up', done: null, total: null, unit: '' };
  }
  const unit = snapshot.progress.unit === 'candidate_source' ? 'files' : snapshot.progress.unit === 'conversation' ? 'chats' : 'prompts';
  return { label, done: snapshot.progress.completed || null, total: snapshot.progress.total, unit };
}

function phaseOf(snapshot: AuditSnapshot): BoardData['phase'] {
  if (snapshot.status === 'cancelled') return 'cancelled';
  if (snapshot.status === 'error') return 'error';
  if (!isLoading(snapshot)) return 'ready';
  if (snapshot.status === 'discovering' && !snapshot.launch?.factProgress) return 'finding';
  if (snapshot.launch && ['preparing', 'analyzing', 'assembling'].includes(snapshot.launch.stage)) return 'finishing';
  return 'reading';
}

function sourcesOf(snapshot: AuditSnapshot): BoardData['sources'] {
  return snapshot.sources.map(source => {
    const checked = source.census?.checked ?? !['checking'].includes(source.state);
    const state: BoardData['sources'][number]['state'] =
      source.state === 'checking' || !checked ? 'checking'
        : source.state === 'absent' ? 'none'
          : source.state === 'unavailable' || source.state === 'unsupported' ? 'unreadable'
            : 'found';
    const files = source.census?.checked ? source.census.files : source.candidateFiles || null;
    return { name: harnessName(source.harness), files: state === 'found' ? files : null, state };
  });
}

function modelsOf(snapshot: AuditSnapshot, loading: boolean): BoardData['models'] {
  const facts = snapshot.launch?.facts;
  if (!facts) return { state: loading ? 'pending' : 'empty', rows: [], more: null };
  const named = facts.models.filter(model => model.model !== null || model.canonicalModel !== null);
  const sorted = [...named].sort((a, b) =>
    (equivalentValue(b) ?? -1) - (equivalentValue(a) ?? -1)
    || (b.knownTokens ?? b.totalTokens ?? -1) - (a.knownTokens ?? a.totalTokens ?? -1)
    || a.id.localeCompare(b.id));
  const rows: ModelRow[] = sorted.map(model => ({
    id: model.id,
    name: modelName(model.canonicalModel ?? model.model),
    value: equivalentValue(model),
    tokens: model.knownTokens ?? model.totalTokens,
    favourite: model.id === facts.favourite?.id,
    estimated: (model as { estimated?: boolean }).estimated === true,
  }));
  disambiguate(rows, sorted);
  const unnamed = facts.models.filter(model => !named.includes(model));
  return { state: rows.length ? 'ready' : loading ? 'pending' : 'empty', rows, more: unnamed.length ? summarise(unnamed, 0) : null };
}

/** Two different identities with the same display name get their provider appended. */
function disambiguate(rows: ModelRow[], models: readonly ModelAggregate[]): void {
  const byName = new Map<string, number[]>();
  rows.forEach((row, index) => byName.set(row.name, [...(byName.get(row.name) ?? []), index]));
  for (const indexes of byName.values()) {
    if (indexes.length < 2) continue;
    for (const index of indexes) {
      const provider = models[index]!.provider ?? (models[index]!.canonicalModel ?? models[index]!.model ?? '').split('/')[0];
      if (provider) rows[index]!.name += ` (${provider})`;
    }
  }
}

function summarise(models: readonly ModelAggregate[], extra: number) {
  const values = models.map(equivalentValue).filter((value): value is number => value !== null);
  return {
    models: models.length + extra,
    value: values.length ? values.reduce((sum, value) => sum + value, 0) : null,
    tokens: knownTokens(models),
  };
}

function agentSplitOf(snapshot: AuditSnapshot): BoardData['agentSplit'] {
  const byHarness = (snapshot.launch?.facts as { costByHarness?: Record<string, number | undefined> } | null | undefined)?.costByHarness;
  if (!byHarness) return [];
  const entries = Object.entries(byHarness).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (!total || entries.length < 2) return [];
  return entries.map(([harness, value]) => ({ name: harnessName(harness), share: value / total })).sort((a, b) => b.share - a.share);
}

function projectsOf(snapshot: AuditSnapshot, loading: boolean): BoardData['projects'] {
  const rows = [...snapshot.projects]
    .map(project => ({
      name: sanitize(project.displayName || project.alias),
      prompts: project.nativeUserInputs ?? project.humanPrompts,
      focus: [...(project.focus ?? [])].filter(item => item.inputs > 0).sort((a, b) => b.inputs - a.inputs).slice(0, 2).map(item => item.label.toLowerCase()),
    }))
    .filter(project => project.prompts > 0)
    .sort((a, b) => b.prompts - a.prompts || a.name.localeCompare(b.name));
  return { state: rows.length ? 'ready' : loading ? 'pending' : 'empty', rows, more: null };
}

function activityOf(snapshot: AuditSnapshot, loading: boolean): BoardData['activity'] {
  const days = snapshot.activity
    .filter(day => /^\d{4}-\d{2}-\d{2}/.test(day.date) && day.count > 0)
    .map(day => ({ date: day.date.slice(0, 10), count: day.count }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const busiest = days.reduce<{ date: string; count: number } | null>((best, day) => (!best || day.count > best.count ? day : best), null);
  const weekdays = new Array<number>(7).fill(0);
  for (const day of days) weekdays[new Date(day.date + 'T12:00:00Z').getUTCDay()]! += day.count;
  const topWeekday = days.length ? WEEKDAYS[weekdays.indexOf(Math.max(...weekdays))]! : null;
  return {
    state: days.length ? 'ready' : loading ? 'pending' : 'empty',
    days,
    busiest,
    peakHour: peakHour(snapshot),
    topWeekday,
  };
}

/** Busiest hour of recorded agent responses, in the audit's timezone. Needs the complete record set. */
function peakHour(snapshot: AuditSnapshot): number | null {
  const facts = snapshot.launch?.facts;
  if (!facts || facts.recordsIncluded === false || facts.records.length < 50) return null;
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: snapshot.scope.timezone || undefined });
  } catch {
    format = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23' });
  }
  const hours = new Array<number>(24).fill(0);
  const byBucket = new Map<number, number>();
  for (const record of facts.records) {
    if (!record.eventAt) continue;
    const time = Date.parse(record.eventAt);
    if (Number.isNaN(time)) continue;
    // Formatting is slow. Zone offsets are multiples of 15 minutes, so every instant in one
    // 15-minute UTC bucket shares a local hour.
    const bucket = Math.floor(time / 900_000);
    let hour = byBucket.get(bucket);
    if (hour === undefined) {
      hour = Number(format.format(bucket * 900_000)) % 24;
      byBucket.set(bucket, hour);
    }
    if (Number.isInteger(hour)) hours[hour]!++;
  }
  const max = Math.max(...hours);
  return max > 0 ? hours.indexOf(max) : null;
}

const PASTE_WRAPPER = /^\[Pasted text #\d+(?: \+\d+ lines)?\]\s*/;

/** Text the user plausibly typed: no tool/command wrappers, image or paste placeholders. */
function typedText(text: string): string | null {
  const clean = sanitize(text.replace(PASTE_WRAPPER, '')).trim();
  if (!clean) return null;
  if (/<\/?[a-z-]+>/i.test(clean)) return null;
  if (/^\[(?:Image|Pasted text)[^\]]*\](?:\s*,?\s*\[(?:Image|Pasted text)[^\]]*\])*\s*,?$/.test(clean)) return null;
  if (/^\[Image #\d+\]/.test(clean)) return null;
  return clean;
}

function repeatsOf(snapshot: AuditSnapshot, loading: boolean): BoardData['repeats'] {
  const groups = new Map<string, RepeatRow>();
  const add = (raw: string, n: number) => {
    const text = typedText(raw);
    if (!text || n < 2) return;
    const key = text.toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();
    if (!key) return;
    const existing = groups.get(key);
    if (!existing || existing.count < n) groups.set(key, { text, count: n });
  };
  for (const phrase of snapshot.phrases ?? []) add(phrase.text, phrase.prompts);
  for (const line of snapshot.launch?.languageLines ?? []) add(line.text, line.occurrences);
  const rows = [...groups.values()].sort((a, b) => b.count - a.count || a.text.length - b.text.length);
  const done = !loading || Boolean(snapshot.launch?.languageLines) || Boolean(snapshot.phrases?.length);
  return { state: rows.length ? 'ready' : done ? 'empty' : 'pending', rows };
}

function reactionsOf(snapshot: AuditSnapshot, loading: boolean): BoardData['reactions'] {
  const feedback = snapshot.launch?.modelFeedback;
  if (!feedback) return { state: loading ? 'pending' : 'empty', roasted: null, praised: null };
  const pick = (key: 'directedNegativeInputs' | 'praiseInputs'): ReactionRow | null => {
    const ranked = feedback
      .filter(row => row.model !== null && row.associatedInputs >= MIN_REACTION_SAMPLE && row[key] > 0 && row[key] <= row.associatedInputs)
      .sort((a, b) => b[key] / b.associatedInputs - a[key] / a.associatedInputs || b[key] - a[key] || (a.model ?? '').localeCompare(b.model ?? ''));
    const top = ranked[0];
    return top ? { model: modelName(top.model), hits: top[key], of: top.associatedInputs } : null;
  };
  const roasted = pick('directedNegativeInputs');
  const praised = pick('praiseInputs');
  return { state: roasted || praised ? 'ready' : 'empty', roasted, praised };
}

function swearsOf(snapshot: AuditSnapshot, loading: boolean): BoardData['swears'] {
  const profanity = snapshot.profanity;
  if (!profanity) return { state: loading ? 'pending' : 'empty', total: 0, prompts: 0, eligible: 0, top: [] };
  const direct = profanity.buckets.find(bucket => bucket.kind === 'direct_prose');
  const total = direct?.occurrences ?? profanity.occurrences.value ?? 0;
  const prompts = direct?.containingPrompts ?? profanity.containingPrompts.value ?? 0;
  const top = (profanity.terms ?? [])
    .filter(term => term.kind === 'direct_prose' && term.occurrences > 0)
    .sort((a, b) => b.occurrences - a.occurrences)
    .slice(0, 3)
    .map(term => ({ term: sanitize(term.term), count: term.occurrences }));
  return { state: 'ready', total, prompts, eligible: profanity.eligiblePrompts, top };
}

function streakOf(days: readonly { date: string }[]): number | null {
  if (!days.length) return null;
  let best = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    const gap = (Date.parse(days[i]!.date) - Date.parse(days[i - 1]!.date)) / 86_400_000;
    run = gap === 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

function personalityOf(snapshot: AuditSnapshot, data: Omit<BoardData, 'personality' | 'footnote'>): string | null {
  const semantics = snapshot.launch?.semantics;
  const story = semantics?.hallOfFame.find(item => item.caption && item.outcome !== 'uncertain')
    ?? semantics?.stories.find(item => item.caption && item.outcome === 'supported');
  if (story) return `Jev: ${sanitize(story.caption)}`;
  const facts = snapshot.launch?.facts;
  const favourite = facts?.favourite;
  if (favourite && favourite.tokenShare !== null && favourite.tokenShare >= 0.25 && !data.loading) {
    return `${modelName(favourite.canonicalModel ?? favourite.model)} is your ride-or-die: ${percent(favourite.tokenShare)} of every token.`;
  }
  const hour = data.activity.peakHour;
  if (hour !== null && hour <= 4) return `Night owl: your agents are busiest at ${hourLabel(hour)}.`;
  if (data.swears.eligible > 0 && data.swears.prompts / data.swears.eligible >= 0.02) {
    return `You swore at your agents in 1 of every ${Math.round(data.swears.eligible / data.swears.prompts)} prompts.`;
  }
  if (data.stats.streak !== null && data.stats.streak >= 14) return `${data.stats.streak} days in a row with an agent. Touch grass?`;
  if (favourite && !data.loading) return `Most-used model: ${modelName(favourite.canonicalModel ?? favourite.model)}.`;
  return null;
}

const LOCAL_FAILURES: [string, string][] = [
  ['audit_snapshot_stale', 'Your history changed while we were reading it. Run slopie audit again.'],
  ['audit_sqlite_snapshot_stale', 'A history database changed mid-read. Run slopie audit again.'],
  ['source_or_policy_changed', 'Your settings changed mid-read. Run slopie audit again.'],
  ['source_or_privacy_changed', 'Your settings changed mid-read. Run slopie audit again.'],
  ['audit_sqlite_snapshot_disk_limit', 'Not enough free disk space to read history safely.'],
  ['ignore_policy_unavailable', "Couldn't read your ignore settings."],
  ['privacy_refresh_required', 'Your saved history needs a privacy refresh first.'],
  ['store_policy_unavailable', "Couldn't read your saved history settings."],
  ['raw_lane_policy_hold', 'Your saved history is on hold by its privacy settings.'],
];

function failureOf(snapshot: AuditSnapshot): string | null {
  const gaps = new Set([...snapshot.coverage.gapCodes, ...snapshot.sources.flatMap(source => source.gapCodes)]);
  for (const [code, text] of LOCAL_FAILURES) if (gaps.has(code)) return text;
  if ([...gaps].some(code => code.startsWith('audit_sqlite_'))) return "One history database couldn't be read safely.";
  if (snapshot.status === 'error') return "The audit didn't finish. Run slopie audit again.";
  return null;
}

function footnoteOf(snapshot: AuditSnapshot, data: Omit<BoardData, 'personality' | 'footnote'>): string | null {
  if (data.failure) return data.failure;
  if (data.phase === 'cancelled') return 'Stopped early · showing what was read';
  const facts = snapshot.launch?.facts;
  const parts: string[] = [];
  if (facts) parts.push('API-price estimate, not a bill');
  const warnings = snapshot.warnings ?? [];
  if (data.models.rows.some(row => row.estimated) || warnings.includes('estimated_prices')) parts.push('~ closest-model price');
  if (warnings.some(code => code.startsWith('unreadable_source')) || snapshot.status === 'partial') parts.push('some files unreadable');
  else if (snapshot.coverage.state !== 'complete_snapshot') parts.push('partial history');
  return parts.length ? parts.join(' · ') : null;
}

const cache = new WeakMap<AuditSnapshot, BoardData>();

export function boardData(snapshot: AuditSnapshot): BoardData {
  const cached = cache.get(snapshot);
  if (cached) return cached;
  const loading = isLoading(snapshot);
  const phase = phaseOf(snapshot);
  const facts = snapshot.launch?.facts;
  const activity = activityOf(snapshot, loading);
  const sources = sourcesOf(snapshot);
  const value = facts ? equivalentValue(facts) : null;
  const base: Omit<BoardData, 'personality' | 'footnote'> = {
    phase,
    loading,
    progress: progressOf(snapshot, phase),
    sources,
    range: { from: activity.days[0]?.date ?? null, to: activity.days.at(-1)?.date ?? null },
    agents: [...snapshot.sources]
      .filter(source => source.conversations > 0 || (source.census?.files ?? 0) > 0)
      .sort((a, b) => b.conversations - a.conversations || (b.census?.files ?? 0) - (a.census?.files ?? 0))
      .map(source => harnessName(source.harness)),
    hero: { value: value !== null && (value > 0 || !loading) ? value : null, provisional: loading },
    stats: {
      tokens: facts ? knownTokens(facts.models) : null,
      // Human-typed prompts; older snapshots only had the raw user-role count.
      prompts: metricValue(snapshot.metrics.humanPrompts) || metricValue(snapshot.metrics.nativeUserInputs),
      chats: loading && !metricValue(snapshot.metrics.conversations) ? null : metricValue(snapshot.metrics.conversations),
      projects: loading && !metricValue(snapshot.metrics.projects) ? null : metricValue(snapshot.metrics.projects),
      activeDays: activity.days.length || null,
      streak: streakOf(activity.days),
    },
    agentSplit: agentSplitOf(snapshot),
    models: modelsOf(snapshot, loading),
    projects: projectsOf(snapshot, loading),
    activity,
    repeats: repeatsOf(snapshot, loading),
    reactions: reactionsOf(snapshot, loading),
    swears: swearsOf(snapshot, loading),
    failure: failureOf(snapshot),
  };
  if (loading && !base.stats.prompts) base.stats.prompts = null;
  const data: BoardData = { ...base, personality: personalityOf(snapshot, base), footnote: footnoteOf(snapshot, base) };
  cache.set(snapshot, data);
  return data;
}

/** Plain-English details page: definitions, caveats, coverage and transfer history. */
export function detailLines(snapshot: AuditSnapshot, transfers: readonly Extract<AuditEvent, { type: 'transfer' }>[] = []): { title: string; lines: string[] }[] {
  const facts = snapshot.launch?.facts;
  const sections: { title: string; lines: string[] }[] = [];
  const data = boardData(snapshot);
  sections.push({
    title: 'What the numbers mean',
    lines: [
      'The big number is what your recorded tokens would cost at public API list prices. It is not a bill: subscriptions and discounts are not known.',
      'Tokens include input, output, cache and reasoning tokens where the agent recorded them. Unknown usage is left out, never guessed.',
      'Prompts are messages you typed; tool output, injected context and slash commands are not counted. Chats are top-level conversations (subagents excluded). Projects are folders where you typed at least one prompt.',
      'A model marked ~ is priced as the closest model in the public price list.',
      `Reactions count prompts aimed at a model that read as frustrated or as praise, divided by prompts sent to that model. Models with fewer than ${MIN_REACTION_SAMPLE} prompts are not ranked. These are observations, not benchmarks.`,
      'Swears are words from a small English list in text you typed directly (quotes and code are excluded).',
    ],
  });
  if (facts) {
    const lines = [
      `${count(Math.max(facts.pricedResponses, facts.equivalentPricedResponses))} of ${count(facts.recordedResponses)} responses priced · ${count(facts.unknownModelResponses)} without a model name`,
      facts.referenceValueUsd
        ? `Priced at recorded endpoint rates: ${money(facts.valueUsd)} · at first-party reference rates: ${money(facts.referenceValueUsd)}`
        : `Total at API list prices: ${money(facts.valueUsd)}`,
      `Price list from ${sanitize(facts.pricing.source)} (${facts.pricing.retrievedAt.slice(0, 10)})`,
    ];
    const byHarness = (facts as { costByHarness?: Record<string, number | undefined> }).costByHarness;
    if (byHarness) {
      lines.push('By agent: ' + Object.entries(byHarness).filter(([, value]) => typeof value === 'number').map(([harness, value]) => `${harnessName(harness)} ${money(value)}`).join(' · '));
    }
    if (facts.favourite) {
      lines.push(`Favourite model blends token share (${percent(facts.favourite.tokenShare)}) and chat share (${percent(facts.favourite.conversationShare)}).`);
    }
    for (const model of data.models.rows.slice(0, 12)) lines.push(`${model.name}: ${money(model.value)} · ${compact(model.tokens)} tokens`);
    sections.push({ title: 'Pricing', lines });
  }
  sections.push({
    title: 'Sources',
    lines: data.sources.map(source => `${source.name}: ${source.state === 'found' ? `${count(source.files)} files` : source.state === 'none' ? 'not found' : source.state}`),
  });
  const busiest = data.activity.busiest;
  if (busiest) sections.push({ title: 'Time', lines: [`Busiest day ${shortDate(busiest.date, true)} with ${count(busiest.count)} prompts. Peak hour uses your timezone (${sanitize(snapshot.scope.timezone)}).`] });
  sections.push({
    title: 'Sent anywhere?',
    lines: transfers.length
      ? transfers.map(event => `${event.recipients.join(', ')} · ${sanitize(event.notice)}`)
      : ['Nothing left this machine during this run.'],
  });
  const gaps = [...new Set([...snapshot.coverage.gapCodes, ...(facts?.gaps ?? []), ...snapshot.sources.flatMap(source => source.gapCodes), ...(snapshot.launch?.languageGaps ?? [])])];
  if (gaps.length) sections.push({ title: 'Technical coverage notes', lines: [gaps.map(code => code.replaceAll('_', ' ')).join(' · ')] });
  return sections;
}

/**
 * Turns per-file facts into audit numbers. Runs once per report, after every
 * file has been read; it is pure and synchronous.
 *
 *   usage  -> de-duplicated responses -> cost per model and harness
 *   prompts -> human prompts -> projects, activity, repeated lines
 *   files  -> conversations (top-level and child)
 */
import path from 'node:path';
import {sourceId} from '../memory/source-identity.js';
import {digest} from './source.js';
import {PriceBook, usageCost} from './pricing.js';
import type {HistoryEntry, PromptFact, SourceFacts, UsageFact} from './extract.js';
import type {AuditConversation, AuditEvidenceRoute, AuditHarness, AuditPrompt} from './contracts.js';
import type {ModelAggregate} from './launch-contracts.js';

export interface AggregateScope {
  harnesses: readonly AuditHarness[];
  project: string | null;
  eventFrom: number | null;
  asOf: number | null;
  timezone: string;
}

export interface AggregatePolicy {
  /** True when the project is on the user's `slopie ignore` list. */
  ignored(project: string | null): boolean;
  /** Source ids the user asked potsherd to forget. */
  forgotten: ReadonlySet<string>;
}

export interface AggregateInput {
  sources: readonly SourceFacts[];
  history: readonly HistoryEntry[];
  historyFile: string | null;
  scope: AggregateScope;
  policy: AggregatePolicy;
  book: PriceBook;
  /** Codex bills on the priority tier unless a thread records `default` (config.toml service_tier). */
  codexFastDefault: boolean;
  snapshotId: string;
}

export interface ModelRow extends ModelAggregate {
  responses: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  harnesses: AuditHarness[];
  pricedAs: string | null;
  estimated: boolean;
}

export interface HarnessTotals {
  conversations: number;
  childConversations: number;
  files: number;
  humanPrompts: number;
  slashCommands: number;
  userMessages: number;
  responses: number;
  costUsd: number;
  excluded: Record<string, number>;
}

export interface Conversation {
  conversation: AuditConversation;
  prompts: AuditPrompt[];
  project: string | null;
  file: string | null;
}

export interface Aggregate {
  conversations: Conversation[];
  /** Human prompts in scope, in time order. */
  prompts: AuditPrompt[];
  /** Model context around each human prompt, for language attribution. */
  around: Map<string, {before: string | null; beforeProvider: string | null; after: string | null; afterProvider: string | null}>;
  models: ModelRow[];
  harness: Record<AuditHarness, HarnessTotals>;
  tokens: {input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number};
  costUsd: number;
  estimatedCostUsd: number;
  responses: number;
  inferredModelResponses: number;
  compactionResponses: number;
  topLevelConversations: number;
  childConversations: number;
  historyOnlyConversations: number;
  projects: {id: string; path: string; humanPrompts: number; conversations: number}[];
  activity: {date: string; count: number}[];
  excludedSources: number;
}

const idMemo = new Map<string, string>();
/** sourceId is a sha256; memoize it, it is asked for once per response. */
function sid(harness: AuditHarness, nativeId: string): string {
  const key = `${harness}\0${nativeId}`;
  let id = idMemo.get(key);
  if (id === undefined) { id = sourceId(harness, nativeId); idMemo.set(key, id); }
  return id;
}

const emptyHarness = (): HarnessTotals => ({conversations: 0, childConversations: 0, files: 0, humanPrompts: 0, slashCommands: 0, userMessages: 0, responses: 0, costUsd: 0, excluded: {}});
const normProject = (p: string | null): string | null => (p ? p.replace(/\/+$/, '') || '/' : null);
const total = (u: UsageFact) => u.input + u.output + u.cacheRead + u.cacheWrite;

export function dayFormatter(timezone: string): (at: number) => string {
  const format = new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'});
  const memo = new Map<number, string>();
  return at => {
    const hour = Math.floor(at / 3_600_000);
    let day = memo.get(hour);
    if (day === undefined) { day = format.format(new Date(at)); memo.set(hour, day); }
    return day;
  };
}

/** ccusage's Claude rules: keep the non-sidechain copy, else the larger token total; drop sidechain replays. */
function dedupeClaude(rows: {u: UsageFact; s: SourceFacts}[]): {u: UsageFact; s: SourceFacts}[] {
  const best = new Map<string, {u: UsageFact; s: SourceFacts}>(), keyless: {u: UsageFact; s: SourceFacts}[] = [];
  for (const row of rows) {
    if (!row.u.key) { keyless.push(row); continue; }
    const old = best.get(row.u.key);
    if (!old || (old.u.sidechain && !row.u.sidechain) || (!!old.u.sidechain === !!row.u.sidechain && total(row.u) > total(old.u))) best.set(row.u.key, row);
  }
  const parents = new Map<string, UsageFact[]>();
  for (const {u} of best.values()) if (!u.sidechain && u.replayKey) {
    const list = parents.get(u.replayKey) ?? [];
    list.push(u);
    parents.set(u.replayKey, list);
  }
  const kept = [...best.values()].filter(({u}) => !(u.sidechain && u.replayKey && parents.get(u.replayKey)?.some(p => p.at === u.at || (p.requestless && u.requestless))));
  return kept.concat(keyless);
}

export function aggregate(input: AggregateInput): Aggregate {
  const {scope, policy, book} = input;
  const harnessSet = new Set(scope.harnesses);
  const dayOf = dayFormatter(scope.timezone);
  const inRange = (at: number | null) => (scope.eventFrom === null || (at !== null && at >= scope.eventFrom)) && (scope.asOf === null || (at !== null && at <= scope.asOf));
  const projectAllowed = (p: string | null) => !policy.ignored(p) && (scope.project === null || normProject(p) === normProject(scope.project));
  const harness = {claude: emptyHarness(), codex: emptyHarness(), pi: emptyHarness(), opencode: emptyHarness()} as Record<AuditHarness, HarnessTotals>;

  // ---- sources in scope, ordered so parents come before children and copies after originals
  let excludedSources = 0;
  const seenCodexSessions = new Set<string>();
  const sources = input.sources
    .filter(s => harnessSet.has(s.harness))
    .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '') || (a.firstAt ?? 0) - (b.firstAt ?? 0) || a.file.localeCompare(b.file))
    .filter(s => {
      if (policy.forgotten.has(sid(s.harness, s.sessionId)) || (s.parentId && policy.forgotten.has(sid(s.harness, s.parentId)))) { excludedSources++; return false; }
      if (s.harness === 'codex') {
        if (seenCodexSessions.has(s.sessionId)) return false; // sessions/ and archived_sessions/ copies
        seenCodexSessions.add(s.sessionId);
      }
      return true;
    });

  // ---- usage
  const claudeRows: {u: UsageFact; s: SourceFacts}[] = [], otherRows: {u: UsageFact; s: SourceFacts}[] = [];
  const seenKeys = new Set<string>();
  for (const s of sources) {
    harness[s.harness].files++;
    for (const u of s.usage) {
      if (!inRange(u.at) || !projectAllowed(s.project)) continue;
      if (s.harness === 'claude') { claudeRows.push({u, s}); continue; }
      if (u.key) { if (seenKeys.has(u.key)) continue; seenKeys.add(u.key); }
      otherRows.push({u, s});
    }
  }
  const usageRows = dedupeClaude(claudeRows).concat(otherRows);

  const models = new Map<string, ModelRow & {convs: Set<string>}>();
  const tokens = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0};
  let costUsd = 0, estimatedCostUsd = 0, inferredModelResponses = 0, compactionResponses = 0;
  const conversationOf = (s: SourceFacts) => sid(s.harness, s.child && s.parentId ? s.parentId : s.sessionId);
  for (const {u, s} of usageRows) {
    const price = book.lookup(u.model);
    const fast = u.tier === 'fast' || (s.harness === 'codex' && u.tier === undefined && input.codexFastDefault);
    const cost = price ? usageCost(u, price, fast) : 0;
    const name = u.model ?? 'unknown';
    let row = models.get(name);
    if (!row) {
      const provider = u.provider && !u.provider.includes('vertex') ? u.provider : s.harness === 'codex' ? 'openai' : name.startsWith('claude') ? 'anthropic' : u.provider;
      row = {
        id: `model:${name}`, provider, model: name, canonicalModel: price ? `${provider ?? 'unknown'}/${price.pricedAs}` : null,
        inputTokens: 0, outputTokens: 0, totalTokens: 0, knownTokens: 0, conversations: 0, tokenShare: null, conversationShare: 0,
        favouriteScore: null, valueUsd: 0, referenceValueUsd: null, gaps: [],
        responses: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, harnesses: [], pricedAs: price?.pricedAs ?? null,
        estimated: !price || price.estimated, convs: new Set(),
      };
      models.set(name, row);
    }
    row.responses++;
    row.inputTokens! += u.input; row.outputTokens! += u.output; row.cacheReadTokens += u.cacheRead; row.cacheWriteTokens += u.cacheWrite;
    row.reasoningTokens += u.reasoning;
    row.valueUsd! += cost;
    row.convs.add(conversationOf(s));
    if (!row.harnesses.includes(s.harness)) row.harnesses.push(s.harness);
    tokens.input += u.input; tokens.output += u.output; tokens.cacheRead += u.cacheRead; tokens.cacheWrite += u.cacheWrite; tokens.reasoning += u.reasoning;
    costUsd += cost;
    if (row.estimated) estimatedCostUsd += cost;
    if (u.inferredModel) inferredModelResponses++;
    if (u.compaction) compactionResponses++;
    harness[s.harness].responses++;
    harness[s.harness].costUsd += cost;
  }

  // ---- conversations and prompts
  const conversations = new Map<string, Conversation>();
  const around: Aggregate['around'] = new Map();
  const prompts: AuditPrompt[] = [];
  const seenPrompts = new Set<string>();
  const topClaudeSessions = new Set<string>();
  const route = (id: string, file: string, key: string, text: string): AuditEvidenceRoute => ({
    basis: 'transient_snapshot', sourceId: id, artifactHash: '', sourcePath: file, recordKey: key,
    rawStart: null, rawEnd: null, startUtf16: 0, endUtf16: text.length, snapshotId: input.snapshotId,
  });
  const originBasis = (h: AuditHarness): AuditPrompt['originBasis'] =>
    h === 'claude' ? 'claude_prompt_id' : h === 'codex' ? 'codex_human_marker' : h === 'pi' ? 'pi_user_projection' : 'opencode_user_projection';

  const conversationFor = (h: AuditHarness, nativeId: string, parent: string | null, title: string | null, project: string | null, file: string | null): Conversation => {
    const id = sid(h, nativeId);
    let entry = conversations.get(id);
    if (!entry) {
      entry = {
        conversation: {
          id, sourceId: id, harness: h, nativeSessionId: nativeId, projectId: null, title, alias: '', promptCount: 0,
          unknownOriginEvents: 0, eventFrom: null, eventTo: null, child: parent !== null, parentId: parent ? sid(h, parent) : null,
          coverage: {state: 'complete_snapshot', knownSources: 1, parsedSources: 1, unknownOriginEvents: 0, excludedEvents: 0, omittedSources: 0, gapCodes: []},
        },
        prompts: [], project, file,
      };
      conversations.set(id, entry);
    }
    if (title && !entry.conversation.title) entry.conversation.title = title;
    if (!entry.project && project) entry.project = project;
    return entry;
  };
  const stretch = (c: AuditConversation, at: number | null) => {
    if (at === null) return;
    const iso = new Date(at).toISOString();
    if (!c.eventFrom || iso < c.eventFrom) c.eventFrom = iso;
    if (!c.eventTo || iso > c.eventTo) c.eventTo = iso;
  };
  const countPrompt = (h: AuditHarness, p: {kind: string; reason: string | null}) => {
    const t = harness[h];
    t.userMessages++;
    if (p.kind === 'human') t.humanPrompts++;
    else if (p.kind === 'command') t.slashCommands++;
    else t.excluded[p.reason ?? p.kind] = (t.excluded[p.reason ?? p.kind] ?? 0) + 1;
  };
  const addHuman = (entry: Conversation, h: AuditHarness, p: PromptFact | HistoryEntry, key: string, file: string, identity: string) => {
    const conv = entry.conversation;
    const prompt: AuditPrompt = {
      id: digest(`${conv.id}:${key}`).slice(0, 32), conversationId: conv.id, role: 'user', originBasis: originBasis(h), identityBasis: identity,
      eligibleHuman: true, eligibleNativeInput: true, languageEligible: true, excludedReason: null,
      eventAt: p.at === null ? null : new Date(p.at).toISOString(), text: p.text, project: normProject(p.project ?? entry.project),
      route: route(conv.id, file, key, p.text),
    };
    entry.prompts.push(prompt);
    prompts.push(prompt);
    conv.promptCount = (conv.promptCount ?? 0) + 1;
    stretch(conv, p.at);
    if ('before' in p) around.set(prompt.id, {before: p.before, beforeProvider: p.beforeProvider, after: p.after, afterProvider: p.afterProvider});
  };

  const transcriptSessions = new Set<string>();
  for (const s of input.sources) if (s.harness === 'claude' && !s.child) for (const sid of s.sessionIds ?? [s.sessionId]) transcriptSessions.add(sid);
  const scoped = scope.project !== null || scope.eventFrom !== null || scope.asOf !== null;
  const activeIds = new Set<string>();
  for (const {s} of usageRows) activeIds.add(sid(s.harness, s.sessionId));
  for (const s of sources) {
    const id = sid(s.harness, s.sessionId);
    const inScopePrompt = s.prompts.some(p => inRange(p.at) && projectAllowed(p.project ?? s.project));
    const active = scoped ? activeIds.has(id) || inScopePrompt
      : s.harness === 'claude' ? (s.child ? s.usage.length > 0 || s.prompts.length > 0 : (s.sessionIds?.length ?? 0) > 0) : true;
    if (!active || (!projectAllowed(s.project) && !inScopePrompt)) continue;
    const entry = conversationFor(s.harness, s.sessionId, s.child ? s.parentId : null, s.title, s.project, s.file);
    if (s.child) entry.conversation.child = true;
    stretch(entry.conversation, s.firstAt);
    stretch(entry.conversation, s.lastAt);
    if (s.harness === 'claude' && !s.child) for (const sid of s.sessionIds ?? [s.sessionId]) topClaudeSessions.add(sid);
    for (const p of s.prompts) {
      if (!inRange(p.at) || !projectAllowed(p.project ?? s.project)) continue;
      const unique = s.harness === 'claude' ? p.key : `${s.harness}:${p.key}`;
      if (seenPrompts.has(unique)) continue;
      seenPrompts.add(unique);
      countPrompt(s.harness, p);
      if (p.kind === 'human') addHuman(entry, s.harness, p, p.key, s.file, `${s.harness}_record`);
    }
  }

  // ---- Claude sessions known only from history.jsonl
  let historyOnlyConversations = 0;
  if (harnessSet.has('claude') && input.historyFile) {
    const historySessions = new Set<string>();
    input.history.forEach((h, i) => {
      const session = h.sessionId ?? `history:${h.at ?? i}`;
      if (transcriptSessions.has(session)) return;
      if (policy.forgotten.has(sid('claude', session))) return;
      if (!inRange(h.at) || !projectAllowed(h.project)) return;
      if (!historySessions.has(session)) {
        historySessions.add(session);
        conversationFor('claude', session, null, null, h.project, null).conversation.coverage.gapCodes = ['transcript_deleted_history_only'];
      }
      const entry = conversations.get(sid('claude', session))!;
      countPrompt('claude', {kind: h.kind, reason: null});
      if (h.kind === 'human') addHuman(entry, 'claude', h, `history:${i}`, input.historyFile!, 'claude_history_jsonl');
    });
    historyOnlyConversations = historySessions.size;
  }

  // ---- conversation totals; drop child/empty shells outside the scope
  const list = [...conversations.values()];
  let children = 0;
  for (const c of list) {
    const t = harness[c.conversation.harness];
    if (c.conversation.child) { children++; t.childConversations++; } else if (c.conversation.harness !== 'claude') t.conversations++;
  }
  // A Claude transcript can carry more than one session id; count distinct ids.
  harness.claude.conversations = topClaudeSessions.size + historyOnlyConversations;
  const top = harness.claude.conversations + harness.codex.conversations + harness.pi.conversations + harness.opencode.conversations;
  list.sort((a, b) => (a.conversation.eventFrom ?? '').localeCompare(b.conversation.eventFrom ?? '') || a.conversation.id.localeCompare(b.conversation.id));
  list.forEach((c, i) => {
    c.conversation.alias = `Conversation ${i + 1}`;
    const p = normProject(c.project);
    c.conversation.projectId = p ? digest(p).slice(0, 20) : null;
  });
  prompts.sort((a, b) => (a.eventAt ?? '').localeCompare(b.eventAt ?? ''));

  // ---- projects (only those with at least one human prompt) and activity
  const projectRows = new Map<string, {id: string; path: string; humanPrompts: number; conversations: Set<string>}>();
  const days = new Map<string, number>();
  for (const p of prompts) {
    if (p.eventAt) { const day = dayOf(Date.parse(p.eventAt)); days.set(day, (days.get(day) ?? 0) + 1); }
    const projectPath = p.project ?? '(unknown)';
    let row = projectRows.get(projectPath);
    if (!row) { row = {id: digest(projectPath).slice(0, 20), path: projectPath, humanPrompts: 0, conversations: new Set()}; projectRows.set(projectPath, row); }
    row.humanPrompts++;
    row.conversations.add(p.conversationId);
  }

  // ---- model shares
  const allTokens = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  const usageConversations = new Set<string>();
  for (const row of models.values()) for (const c of row.convs) usageConversations.add(c);
  const modelRows: ModelRow[] = [...models.values()].map(({convs, ...row}) => {
    const totalTokens = row.inputTokens! + row.outputTokens! + row.cacheReadTokens + row.cacheWriteTokens;
    const tokenShare = allTokens ? totalTokens / allTokens : null;
    const conversationShare = usageConversations.size ? convs.size / usageConversations.size : 0;
    return {
      ...row, totalTokens, knownTokens: totalTokens, conversations: convs.size, tokenShare, conversationShare,
      favouriteScore: tokenShare === null ? null : (tokenShare + conversationShare) / 2,
      gaps: row.estimated ? ['price_estimated_from_model_family'] : [],
    };
  }).sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0) || a.id.localeCompare(b.id));

  return {
    conversations: list, prompts, around, models: modelRows, harness, tokens, costUsd, estimatedCostUsd,
    responses: usageRows.length, inferredModelResponses, compactionResponses,
    topLevelConversations: top, childConversations: children, historyOnlyConversations,
    projects: [...projectRows.values()].map(r => ({id: r.id, path: r.path, humanPrompts: r.humanPrompts, conversations: r.conversations.size}))
      .sort((a, b) => b.humanPrompts - a.humanPrompts || b.conversations - a.conversations || a.id.localeCompare(b.id)),
    activity: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({date, count})),
    excludedSources,
  };
}

export const projectName = (p: string) => path.basename(p) || p;

/**
 * Single-pass extraction of audit facts from one native history file.
 *
 * Only two things are kept from a transcript:
 *   - usage metadata of assistant responses (model, token counts, time), and
 *   - the text of user-role messages (redacted), classified as human or not.
 *
 * Assistant bodies, tool calls/outputs, images and reasoning are never parsed:
 * lines are classified from a short byte prefix (or a byte search) and only the
 * interesting ones go through JSON.parse.
 *
 * The usage rules follow ccusage 20.x; the prompt rules are documented in
 * `classifyText` and next to each harness below.
 */
import fs from 'node:fs';
import path from 'node:path';
import {hasExclusionMarker} from '../markers.js';
import {clean} from './source.js';
import type {AuditHarness} from './contracts.js';

export const FACTS_VERSION = 4;

export type NativeHarness = Exclude<AuditHarness, 'opencode'>;

export interface UsageFact {
  /** De-duplication key (see `aggregate.ts`); null when the record has no stable identity. */
  key: string | null;
  at: number | null;
  model: string | null;
  provider: string | null;
  /** Uncached input tokens. */
  input: number;
  /** Output tokens, including reasoning. */
  output: number;
  cacheRead: number;
  /** All cache-creation tokens (5m + 1h). */
  cacheWrite: number;
  cacheWrite1h: number;
  reasoning: number;
  /** True when the model was not recorded and had to be inferred. */
  inferredModel?: boolean;
  /** Claude: written by a subagent / sidechain. */
  sidechain?: boolean;
  /** Claude: the record had no requestId. */
  requestless?: boolean;
  /** Claude: message id + session for sidechain-replay detection. */
  replayKey?: string;
  /** Recorded service tier: Claude `usage.speed`, Codex `thread_settings.service_tier`. */
  tier?: 'fast' | 'standard';
  /** Codex remote compaction request (token_usage_record). */
  compaction?: boolean;
}

export type PromptKind = 'human' | 'command' | 'answer' | 'excluded';

export interface PromptFact {
  key: string;
  at: number | null;
  project: string | null;
  /** Redacted text, capped; empty unless the prompt is human. */
  text: string;
  kind: PromptKind;
  /** Why a user-role message is not a human prompt. */
  reason: string | null;
  /** Model whose response the user was reacting to. */
  before: string | null;
  beforeProvider: string | null;
  /** Model that answered this prompt. */
  after: string | null;
  afterProvider: string | null;
}

export interface SourceFacts {
  v: number;
  harness: AuditHarness;
  file: string;
  size: number;
  mtimeMs: number;
  sessionId: string;
  /** Claude: all session ids seen on user records of a top-level transcript. */
  sessionIds?: string[];
  parentId: string | null;
  child: boolean;
  project: string | null;
  title: string | null;
  /** Non-interactive session (codex exec / sdk). */
  automated: boolean;
  /** Contains a potsherd exclusion marker: its text is never kept. */
  excluded: boolean;
  /** Codex: session_meta timestamp, used to order parents before children. */
  startedAt: string | null;
  firstAt: number | null;
  lastAt: number | null;
  usage: UsageFact[];
  prompts: PromptFact[];
  malformed: number;
}

const MAX_PROMPT_CHARS = 4000;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
function time(v: unknown): number | null {
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v;
  return null;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) if (isRec(block) && typeof block.text === 'string') parts.push(block.text);
  return parts.join('\n');
}

/* ------------------------------------------------------- prompt rules --- */

/** Text a harness injects into the user role. Anything starting with these is not a prompt. */
const INJECTED_PREFIXES: readonly [string, string][] = [
  ['<task-notification>', 'task_notification'],
  ['<local-command-stdout>', 'local_command_output'], ['<local-command-stderr>', 'local_command_output'],
  ['<local-command-caveat>', 'local_command_output'],
  ['[Request interrupted', 'interrupt_marker'], ['<turn_aborted>', 'interrupt_marker'],
  ['<environment_context>', 'environment_context'], ['# AGENTS.md instructions', 'agents_md'],
  ['<user_instructions>', 'agents_md'], ['<external_codex_apps', 'app_state'],
  ['<recommended_plugins>', 'app_state'], ['<heartbeat>', 'automation'],
  ['The following is the Codex agent history', 'guardian_review'],
  ['You have new hive inbox message', 'automation'],
  ['Another Claude session sent a message', 'cross_session_message'],
  ['This session is being continued from a previous conversation', 'compaction_summary'],
  ['Your claude.ai usage limit has reset', 'auto_continuation'],
  ['Base directory for this skill:', 'skill_expansion'],
];
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** Classifies the text of a user-role message. Returns the kind, a reason and the cleaned text. */
export function classifyText(raw: string): {kind: PromptKind; reason: string | null; text: string} {
  const text = (raw.includes('<system-reminder>') ? raw.replace(SYSTEM_REMINDER, '') : raw).trim();
  if (!text) return {kind: 'excluded', reason: 'empty', text};
  for (const [prefix, reason] of INJECTED_PREFIXES) if (text.startsWith(prefix)) return {kind: 'excluded', reason, text};
  if (text.startsWith('<command-name>') || text.startsWith('<command-message>')) return {kind: 'command', reason: 'slash_command', text};
  if (text.startsWith('<send_user_message_question_reply>')) return {kind: 'answer', reason: 'question_answer', text};
  return {kind: 'human', reason: null, text};
}

const CODEX_STRIP = [/<in-app-browser-context[\s\S]*?<\/in-app-browser-context>/g, /<image name=[^>]*>\s*<\/image>/g, /<\/?image[^>]*>/g];
/** Codex desktop wraps the typed request: '# Files mentioned by the user: ... ## My request: <typed>'. */
function cleanCodexText(raw: string): string {
  let t = raw;
  if (t.includes('<')) for (const rx of CODEX_STRIP) t = t.replace(rx, '');
  const at = t.indexOf('## My request');
  if (at >= 0) {
    const rest = t.slice(at + '## My request'.length), colon = rest.indexOf(':');
    t = colon >= 0 ? rest.slice(colon + 1) : rest;
  } else if (t.trimStart().startsWith('# Files mentioned by the user')) t = '';
  return t.trim();
}

/* ----------------------------------------------------------- builder --- */

interface Builder {
  facts: SourceFacts;
  currentModel: string | null;
  currentProvider: string | null;
  /** Prompts waiting for the model that answers them. */
  pending: PromptFact[];
  seenPrompts: Set<string>;
}

function makeBuilder(file: string, harness: NativeHarness, size: number, mtimeMs: number): Builder {
  return {
    facts: {
      v: FACTS_VERSION, harness, file, size, mtimeMs,
      sessionId: path.basename(file, '.jsonl'), parentId: null, child: false, project: null, title: null,
      automated: false, excluded: false, startedAt: null, firstAt: null, lastAt: null, usage: [], prompts: [], malformed: 0,
    },
    currentModel: null, currentProvider: null, pending: [], seenPrompts: new Set(),
  };
}

function touch(b: Builder, at: number | null): void {
  if (at === null) return;
  if (b.facts.firstAt === null || at < b.facts.firstAt) b.facts.firstAt = at;
  if (b.facts.lastAt === null || at > b.facts.lastAt) b.facts.lastAt = at;
}

function answered(b: Builder, model: string | null, provider: string | null): void {
  if (!model) return;
  for (const p of b.pending) { p.after = model; p.afterProvider = provider; }
  b.pending.length = 0;
  b.currentModel = model;
  b.currentProvider = provider;
}

function addUsage(b: Builder, u: UsageFact): void {
  b.facts.usage.push(u);
  touch(b, u.at);
  answered(b, u.model, u.provider);
}

function addPrompt(b: Builder, key: string, at: number | null, project: string | null, kind: PromptKind, reason: string | null, text: string): void {
  if (b.seenPrompts.has(key)) return;
  b.seenPrompts.add(key);
  if (kind === 'human' && hasExclusionMarker(text)) b.facts.excluded = true;
  const prompt: PromptFact = {
    key, at, project, kind, reason,
    text: kind === 'human' ? clean(text.length > MAX_PROMPT_CHARS ? text.slice(0, MAX_PROMPT_CHARS) : text) : '',
    before: b.currentModel, beforeProvider: b.currentProvider, after: null, afterProvider: null,
  };
  b.facts.prompts.push(prompt);
  if (kind === 'human') b.pending.push(prompt);
  touch(b, at);
}

/* ------------------------------------------------------------ Claude --- */

const SUBAGENT_DIR = `${path.sep}subagents${path.sep}`;

function claudeLine(b: Builder, line: Buffer, subagent: boolean, sessions: Set<string>): void {
  const assistant = line.includes('"type":"assistant"');
  if (assistant ? !line.includes('"usage"') : (subagent || !line.includes('"type":"user"'))) {
    // Titles are tiny records; everything else here is irrelevant.
    if (line.length > 4096 || (!line.includes('-title"') && !line.includes('"type":"summary"'))) return;
  }
  let r: Rec;
  try { r = JSON.parse(line.toString('utf8')) as Rec; } catch { b.facts.malformed++; return; }
  if (!isRec(r)) return;
  const f = b.facts;
  if (r.type === 'summary' || r.type === 'custom-title' || r.type === 'ai-title') {
    const title = str(r.customTitle) ?? str(r.aiTitle) ?? str(r.title) ?? str(r.summary);
    if (title && (r.type !== 'summary' || !f.title)) f.title = title;
    return;
  }
  if (typeof r.cwd === 'string' && !f.project) f.project = r.cwd;
  const sid = str(r.sessionId);
  if (sid) {
    if (subagent) { f.parentId = sid; f.child = true; f.sessionId = `${sid}:${path.basename(f.file, '.jsonl')}`; }
    else if (!sessions.size) f.sessionId = sid;
  }
  const m = isRec(r.message) ? r.message : {};
  const at = time(r.timestamp);
  if (r.type === 'assistant') {
    const u = m.usage;
    if (!isRec(u)) return;
    const model = str(m.model);
    if (model === '<synthetic>') return;
    const cc = isRec(u.cache_creation) ? u.cache_creation : null;
    const write = cc ? int(cc.ephemeral_5m_input_tokens) + int(cc.ephemeral_1h_input_tokens) : int(u.cache_creation_input_tokens);
    const id = str(m.id), request = str(r.requestId), session = sid ?? f.file;
    const fact: UsageFact = {
      key: id ? (request ? `c:${id}:${request}` : `c:${id}::${session}:${String(r.timestamp)}`) : null,
      at, model, provider: null,
      input: int(u.input_tokens), output: int(u.output_tokens), cacheRead: int(u.cache_read_input_tokens),
      cacheWrite: write, cacheWrite1h: cc ? int(cc.ephemeral_1h_input_tokens) : 0, reasoning: 0,
    };
    if (r.isSidechain === true) fact.sidechain = true;
    if (!request) fact.requestless = true;
    if (id) fact.replayKey = `${id}:${session}`;
    if (u.speed === 'fast') fact.tier = 'fast';
    addUsage(b, fact);
    return;
  }
  if (r.type !== 'user' || r.isSidechain === true || subagent) return;
  const content = m.content;
  if (Array.isArray(content) && content.some(block => isRec(block) && block.type === 'tool_result')) return;
  if (sid) sessions.add(sid);
  const origin = isRec(r.origin) ? str(r.origin.kind) : null;
  const flagged = r.isMeta === true ? 'is_meta'
    : r.isCompactSummary === true ? 'compaction_summary'
    : origin && origin !== 'human' ? `origin_${origin}`
    : r.entrypoint === 'sdk-cli' ? 'headless_claude_p'
    : r.promptSource === 'system' ? 'prompt_source_system'
    : null;
  let {kind, reason, text} = classifyText(textOf(content));
  if (flagged) { kind = 'excluded'; reason = flagged; }
  else if (reason === 'empty' && origin === 'human' && Array.isArray(content) && content.some(block => isRec(block) && block.type === 'image')) {
    kind = 'human'; reason = null; text = '[image]';
  }
  addPrompt(b, str(r.uuid) ?? `${f.sessionId}:${String(r.timestamp)}`, at, str(r.cwd) ?? f.project, kind, reason, text);
}

/* ------------------------------------------------------------- Codex --- */

interface PendingCodexPrompt {key: string | null; at: number | null; text: string; imported: boolean; project: string | null}
interface CodexState {
  lineNo: number;
  previousTotal: string | null;
  tier: 'fast' | 'standard' | undefined;
  imported: boolean;
  records: Map<string, {at: number | null; usage: Rec}>;
  compacted: Set<string>;
  deltas: Set<string>;
  itemPrompts: PendingCodexPrompt[];
  responsePrompts: PendingCodexPrompt[];
}

const U_KEYS = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'] as const;
const tuple = (u: unknown): number[] | null => (isRec(u) ? U_KEYS.map(k => int(u[k])) : null);

/** Codex records its review helper as `codex-auto-review`; bill it as the helper model of that date. */
const AUTO_REVIEW_MODELS: readonly [string, string][] = [
  ['2026-07-30', 'gpt-5.6-luna'], ['2026-03-05', 'gpt-5.4'], ['2026-02-05', 'gpt-5.3-codex'],
  ['2025-12-11', 'gpt-5.2-codex'], ['2025-11-13', 'gpt-5.1-codex'], ['2025-09-15', 'gpt-5-codex'],
];
function codexModel(model: string | null, timestamp: string): {model: string; inferred: boolean} {
  if (model === 'codex-auto-review') {
    const day = timestamp.slice(0, 10);
    return {model: AUTO_REVIEW_MODELS.find(([since]) => day >= since)?.[1] ?? 'gpt-5', inferred: true};
  }
  return model ? {model, inferred: false} : {model: 'gpt-5', inferred: true};
}

function codexFact(b: Builder, s: CodexState, at: number | null, timestamp: string, d: readonly number[], key: string | null): UsageFact {
  const input = d[0]!, output = d[2]!, reasoning = d[3]!, cached = Math.min(d[1]!, input);
  const {model, inferred} = codexModel(b.currentModel, timestamp);
  const fact: UsageFact = {key, at, model, provider: 'openai', input: input - cached, output, cacheRead: cached, cacheWrite: 0, cacheWrite1h: 0, reasoning};
  if (inferred) fact.inferredModel = true;
  if (s.tier) fact.tier = s.tier;
  return fact;
}

/** Whether a Codex line (judged by its first bytes) can matter; everything else is skipped unread. */
function codexWanted(head: string, lineNo: number): boolean {
  return (lineNo === 0 && head.includes('session_meta')) || head.includes('"token_count"') || head.includes('"turn_context"')
    || head.includes('thread_settings_applied') || head.includes('"task_started"') || head.includes('"token_usage_record"')
    || head.includes('"type":"compacted"') || (head.includes('"UserMessage"') && head.includes('item_completed'))
    || (head.includes('"role":"user"') && head.includes('"response_item"')) || (head.includes('"event_msg"') && head.includes('"type":"user_message"'));
}

function codexLine(b: Builder, line: Buffer, s: CodexState): void {
  const n = s.lineNo++;
  const head = line.toString("latin1", 0, Math.min(line.length, 260));
  const f = b.facts;
  const parse = (): Rec | null => {
    try { return JSON.parse(line.toString('utf8')) as Rec; } catch { f.malformed++; return null; }
  };
  if (n === 0 && head.includes('session_meta')) {
    const r = parse();
    if (!r) return;
    const p = isRec(r.payload) ? r.payload : {};
    f.sessionId = str(p.id) ?? str(p.session_id) ?? f.sessionId;
    f.project = str(p.cwd);
    f.startedAt = str(p.timestamp) ?? str(r.timestamp);
    const source = p.source;
    if (isRec(source) && 'subagent' in source) {
      f.child = true;
      const sub = isRec(source.subagent) ? source.subagent : {};
      const spawn = isRec(sub.thread_spawn) ? sub.thread_spawn : {};
      f.parentId = str(spawn.parent_thread_id) ?? str(p.parent_thread_id) ?? str(p.forked_from_id);
    }
    if (source === 'exec' || p.originator === 'codex_exec' || p.originator === 'codex_sdk_ts') f.automated = true;
    touch(b, time(r.timestamp));
    return;
  }
  if (head.includes('"token_count"')) {
    const r = parse();
    const p = r && isRec(r.payload) ? r.payload : null;
    const info = p && isRec(p.info) ? p.info : null;
    if (!r || !info) return;
    const total = tuple(info.total_token_usage), last = tuple(info.last_token_usage);
    const totalSig = total ? total.join(',') : null;
    const advanced = totalSig === null || totalSig !== s.previousTotal;
    let d: number[] | null = null;
    if (last && advanced) d = last;
    else if (total) {
      const prev = s.previousTotal ? s.previousTotal.split(',').map(Number) : [0, 0, 0, 0, 0];
      d = total.map((v, i) => Math.max(0, v - prev[i]!));
    }
    if (totalSig) s.previousTotal = totalSig;
    if (!d || !(d[0]! || d[1]! || d[2]! || d[3]!)) return;
    s.deltas.add(d.join(','));
    // Counters replayed into another file repeat exactly; count each fingerprint once.
    const key = totalSig ? `x:${totalSig}|${last ? last.join(',') : ''}` : null;
    addUsage(b, codexFact(b, s, time(r.timestamp), String(r.timestamp ?? ''), d, key));
    return;
  }
  if (head.includes('"turn_context"')) {
    const p = parse()?.payload;
    if (isRec(p)) { b.currentModel = str(p.model) ?? b.currentModel; if (typeof p.cwd === 'string') f.project = p.cwd; }
    return;
  }
  if (head.includes('thread_settings_applied')) {
    const p = parse()?.payload;
    const settings = isRec(p) && isRec(p.thread_settings) ? p.thread_settings : null;
    if (settings && 'service_tier' in settings) {
      const v = settings.service_tier;
      s.tier = v === 'priority' || v === 'fast' ? 'fast' : v === 'default' || v === 'standard' ? 'standard' : undefined;
    }
    return;
  }
  if (head.includes('"task_started"')) {
    const p = parse()?.payload;
    s.imported = isRec(p) && String(p.turn_id ?? '').startsWith('external-import');
    return;
  }
  if (head.includes('"UserMessage"') && head.includes('item_completed')) {
    const r = parse();
    const p = r && isRec(r.payload) ? r.payload : null;
    if (!r || !p) return;
    const item = isRec(p.item) ? p.item : {};
    s.itemPrompts.push({key: str(item.id), at: time(r.timestamp), text: textOf(item.content),
      imported: s.imported || String(p.turn_id ?? '').startsWith('external-import'), project: f.project});
    return;
  }
  if (head.includes('"role":"user"') && head.includes('"response_item"')) {
    const r = parse();
    if (!r) return;
    const p = isRec(r.payload) ? r.payload : {};
    s.responsePrompts.push({key: null, at: time(r.timestamp), text: textOf(p.content), imported: s.imported, project: f.project});
    return;
  }
  if (head.includes('"event_msg"') && line.subarray(0, 400).includes('"type":"user_message"')) {
    const r = parse();
    if (!r) return;
    const p = isRec(r.payload) ? r.payload : {};
    s.itemPrompts.push({key: null, at: time(r.timestamp), text: typeof p.message === 'string' ? p.message : '', imported: s.imported, project: f.project});
    return;
  }
  if (head.includes('"token_usage_record"')) {
    const r = parse();
    const p = r && isRec(r.payload) ? r.payload : null;
    const id = p ? str(p.response_id) : null;
    if (r && p && id && isRec(p.usage)) s.records.set(id, {at: time(r.timestamp), usage: p.usage});
    return;
  }
  if (head.includes('"type":"compacted"')) {
    // The marker carries the whole replacement history; only its own id matters.
    const at = line.lastIndexOf('"compaction_response_id":"');
    if (at >= 0) {
      const start = at + 26, end = line.indexOf(34, start);
      if (end > start) s.compacted.add(line.toString("latin1", start, end));
    }
  }
}

function finishCodex(b: Builder, s: CodexState): void {
  const f = b.facts;
  // Remote compaction requests: linked to a compacted marker and not already a token_count delta.
  for (const id of s.compacted) {
    const record = s.records.get(id);
    const d = record ? tuple(record.usage) : null;
    if (!record || !d || !(d[0]! || d[1]! || d[2]! || d[3]!) || s.deltas.has(d.join(','))) continue;
    const fact = codexFact(b, s, record.at, record.at ? new Date(record.at).toISOString() : '', d, `codex-compaction:${id}`);
    fact.compaction = true;
    f.usage.push(fact);
    touch(b, record.at);
  }
  // Current Codex marks typed input with item_completed/UserMessage (older: event_msg/user_message);
  // response_item role=user also carries injected context and is only a fallback.
  const list = s.itemPrompts.length ? s.itemPrompts : s.responsePrompts;
  const reason = f.child ? 'subagent_parent_written' : f.automated ? 'programmatic_exec_session' : null;
  const seen = new Set<string>();
  list.forEach((p, i) => {
    if (p.key) { if (seen.has(p.key)) return; seen.add(p.key); }
    const key = `codex:${f.sessionId}:${p.key ?? i}`;
    if (reason) return addPrompt(b, key, p.at, p.project, 'excluded', reason, '');
    if (p.imported) return addPrompt(b, key, p.at, p.project, 'excluded', 'imported_from_claude_transcript', '');
    const c = classifyText(cleanCodexText(p.text));
    addPrompt(b, key, p.at, p.project, c.kind, c.reason, c.text);
  });
  // Attribute prompts to the models around them, by time.
  const answers = f.usage.filter(u => u.at !== null).sort((x, y) => x.at! - y.at!);
  let j = 0, previous: string | null = null;
  for (const p of [...f.prompts].sort((x, y) => (x.at ?? 0) - (y.at ?? 0))) {
    while (j < answers.length && answers[j]!.at! <= (p.at ?? 0)) previous = answers[j++]!.model;
    p.before = previous; p.beforeProvider = previous ? 'openai' : null;
    p.after = answers[j]?.model ?? null; p.afterProvider = p.after ? 'openai' : null;
  }
}

/* ---------------------------------------------------------------- pi --- */

function piLine(b: Builder, line: Buffer): void {
  let r: Rec;
  try { r = JSON.parse(line.toString('utf8')) as Rec; } catch { b.facts.malformed++; return; }
  const f = b.facts, at = time(r.timestamp);
  if (r.type === 'session') {
    f.sessionId = str(r.id) ?? f.sessionId;
    f.project = str(r.cwd);
    touch(b, at);
    return;
  }
  if (r.type === 'model_change') {
    b.currentModel = str(r.modelId) ?? b.currentModel;
    b.currentProvider = str(r.provider) ?? b.currentProvider;
    return;
  }
  if (r.type !== 'message' || !isRec(r.message)) return;
  const m = r.message;
  if (m.role === 'assistant' && isRec(m.usage)) {
    const u = m.usage;
    const fact: UsageFact = {
      key: `pi:${f.sessionId}:${String(r.id)}`, at, model: str(m.model) ?? b.currentModel, provider: str(m.provider) ?? b.currentProvider,
      input: int(u.input), output: int(u.output), cacheRead: int(u.cacheRead), cacheWrite: int(u.cacheWrite), cacheWrite1h: 0, reasoning: 0,
    };
    if (fact.input + fact.output + fact.cacheRead + fact.cacheWrite > 0) addUsage(b, fact);
    else answered(b, fact.model, fact.provider);
    return;
  }
  if (m.role === 'user') {
    const c = classifyText(textOf(m.content));
    addPrompt(b, `pi:${f.sessionId}:${String(r.id)}`, at, f.project, c.kind, c.reason, c.text);
  }
}

/* ------------------------------------------------------------ driver --- */

const CHUNK = 4 * 1024 * 1024;
/** Lines longer than this are skipped without being materialized. */
const MAX_LINE = 256 * 1024 * 1024;

let sharedBuffer: Buffer | null = null;

/** Reads one file once, in large chunks, and returns its facts. */
export function extractFile(file: string, harness: NativeHarness): SourceFacts {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const b = makeBuilder(file, harness, stat.size, stat.mtimeMs);
    const codex: CodexState = {lineNo: 0, previousTotal: null, tier: undefined, imported: false,
      records: new Map(), compacted: new Set(), deltas: new Set(), itemPrompts: [], responsePrompts: []};
    const subagent = file.includes(SUBAGENT_DIR), sessions = new Set<string>();
    const onLine = harness === 'claude' ? (line: Buffer) => claudeLine(b, line, subagent, sessions)
      : harness === 'codex' ? (line: Buffer) => codexLine(b, line, codex)
      : (line: Buffer) => piLine(b, line);
    // One read buffer per thread, reused across files (it only grows for very long lines).
    let buffer = sharedBuffer ??= Buffer.allocUnsafe(CHUNK);
    let filled = 0, position = 0, skipping = false;
    for (;;) {
      if (filled === buffer.length) {
        // A line longer than the buffer: drop it unread unless its head says we need it.
        if (harness === 'codex' && !codexWanted(buffer.toString('latin1', 0, Math.min(filled, 400)), codex.lineNo)) { skipping = true; filled = 0; codex.lineNo++; }
        else if (buffer.length >= MAX_LINE) { skipping = true; filled = 0; b.facts.malformed++; }
        else { const bigger = Buffer.allocUnsafe(buffer.length * 2); buffer.copy(bigger, 0, 0, filled); buffer = bigger; if (bigger.length <= 4 * CHUNK) sharedBuffer = bigger; }
      }
      const n = fs.readSync(fd, buffer, filled, buffer.length - filled, position);
      position += n;
      const end = filled + n;
      let start = 0;
      for (;;) {
        const nl = buffer.indexOf(10, start);
        if (nl < 0 || nl >= end) break;
        if (skipping) skipping = false;
        else if (nl > start) onLine(buffer.subarray(start, nl));
        start = nl + 1;
      }
      if (n === 0) {
        if (!skipping && start < end) onLine(buffer.subarray(start, end));
        break;
      }
      buffer.copyWithin(0, start, end);
      filled = end - start;
    }
    if (harness === 'codex') finishCodex(b, codex);
    if (harness === 'claude' && !subagent && sessions.size) b.facts.sessionIds = [...sessions];
    if (b.facts.excluded) for (const p of b.facts.prompts) p.text = '';
    return b.facts;
  } finally {
    fs.closeSync(fd);
  }
}

/* ------------------------------------------------- Claude history.jsonl --- */

export interface HistoryEntry {
  sessionId: string | null;
  at: number | null;
  project: string | null;
  kind: PromptKind;
  text: string;
}

/**
 * `~/.claude/history.jsonl` is Claude Code's log of what the user typed. It is
 * used only for sessions whose transcript is gone: `display` starting with `/`
 * is a slash command, anything else a human prompt.
 */
export function extractHistory(file: string): HistoryEntry[] {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out: HistoryEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let r: Rec;
    try { r = JSON.parse(line) as Rec; } catch { continue; }
    const display = typeof r.display === 'string' ? r.display.trim() : '';
    if (!display) continue;
    const command = display.startsWith('/');
    out.push({
      sessionId: str(r.sessionId), at: time(r.timestamp), project: str(r.project),
      kind: command ? 'command' : 'human',
      text: command ? '' : clean(display.length > MAX_PROMPT_CHARS ? display.slice(0, MAX_PROMPT_CHARS) : display),
    });
  }
  return out;
}

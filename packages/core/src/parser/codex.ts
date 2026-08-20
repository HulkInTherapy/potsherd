import fs from 'node:fs';
import path from 'node:path';
import type {
  Exchange,
  ExchangeToolCall,
  ParseOptions,
  ParseResult,
  SessionRecord,
  SessionStatus,
} from '../adapters/types.js';
import { readJsonlLines, parseJsonLine } from './jsonl.js';
import {
  extractTextFromContent,
  filesFromToolInput,
  isRecord,
  safeParseJson,
  stringifyToolInput,
  stringifyToolOutput,
  uniq,
} from './content.js';
import { exchangeId } from './claude.js';

/**
 * Codex CLI rollout parser.
 *
 * Ported from obra/episodic-memory@1075769 `src/parser.ts`
 * (MIT, (c) 2025 Jesse Vincent) — `parseCodexConversation`. Upstream's record
 * dispatch is kept intact: session metadata from `session_meta`, per-turn
 * metadata from `turn_context`, content from `response_item` only, tool calls
 * paired to their outputs by `call_id`.
 *
 * One correction from the phase-1 scout: a rollout carries **two parallel
 * views of the same conversation** — `response_item` and `event_msg`. Building
 * exchanges from both double-counts everything, so content still comes only
 * from `response_item`; `event_msg/user_message` is read in a first pass and
 * used solely as the human-prompt test, because `response_item/message` with
 * `role:"user"` also carries injected environment context that the user never
 * typed. When a rollout has no `event_msg` records at all the test is skipped
 * and every `role:"user"` message starts an exchange, which is upstream's
 * behaviour.
 *
 * `T1.3` owns the codex adapter (`discover()`, `session_index.jsonl` titles,
 * `archived_sessions/`); this is the parse half it will call.
 */

const TOOL_CALL_TYPES = new Set([
  'function_call',
  'custom_tool_call',
  'tool_search_call',
  'local_shell_call',
]);
const TOOL_OUTPUT_TYPES = new Set([
  'function_call_output',
  'custom_tool_call_output',
  'tool_search_output',
  'local_shell_call_output',
]);
const HANDLED_ENVELOPES = new Set([
  'session_meta',
  'turn_context',
  'response_item',
  'event_msg',
  'world_state',
  'compacted',
]);

interface Builder {
  seq: number;
  ts: string;
  userText: string;
  assistantTexts: string[];
  toolCalls: ExchangeToolCall[];
  byCallId: Map<string, number>;
  files: string[];
}

export interface CodexParseOptions extends ParseOptions {
  /** From `session_index.jsonl` / `state_5.sqlite`; the rollout has no title. */
  title?: string;
  gitBranch?: string;
  status?: SessionStatus;
  bytes?: number;
}

export async function parseCodexTranscript(
  filePath: string,
  options: CodexParseOptions = {},
): Promise<ParseResult> {
  const absolute = path.resolve(filePath);
  const fromOffset = options.fromOffset ?? 0;
  const humanPrompts = await collectHumanPrompts(absolute, fromOffset);

  const unknownTypes: Record<string, number> = {};
  let malformedLines = 0;
  let endOffset = fromOffset;

  const exchanges: Exchange[] = [];
  let current: Builder | null = null;
  let seq = options.fromSeq ?? 0;

  let sessionId: string | undefined = options.sessionId;
  let cwd: string | undefined;
  let model: string | undefined;
  let entrypoint: string | undefined;
  let firstTs: string | undefined;
  let lastTs: string | undefined;
  let userPrompts = 0;
  let assistantTurns = 0;
  let toolCallCount = 0;

  const resolvedId = (): string => sessionId ?? sessionIdFromPath(absolute);

  const finalize = (): void => {
    if (!current) return;
    const b = current;
    current = null;
    if (!b.userText.trim() && b.toolCalls.length === 0) return;
    exchanges.push({
      id: exchangeId(resolvedId(), b.seq),
      sessionId: resolvedId(),
      seq: b.seq,
      ts: b.ts,
      userText: b.userText,
      assistantText: b.assistantTexts.join('\n\n'),
      toolCalls: b.toolCalls,
      filesTouched: uniq(b.files),
      isSidechain: false,
      redacted: false,
    });
  };

  for await (const line of readJsonlLines(absolute, { start: fromOffset })) {
    if (!line.terminated) break;
    endOffset = line.end;

    const parsed = parseJsonLine(line.text);
    if (parsed === undefined) {
      if (line.text.trim()) malformedLines += 1;
      continue;
    }
    if (!isRecord(parsed)) {
      malformedLines += 1;
      continue;
    }

    const envelope = typeof parsed.type === 'string' ? parsed.type : '';
    if (!HANDLED_ENVELOPES.has(envelope)) {
      unknownTypes[envelope || '(no type)'] = (unknownTypes[envelope || '(no type)'] ?? 0) + 1;
    }
    const ts = typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString();
    if (typeof parsed.timestamp === 'string') {
      firstTs ??= parsed.timestamp;
      lastTs = parsed.timestamp;
    }

    const payload = parsed.payload;
    if (!isRecord(payload)) continue;

    if (envelope === 'session_meta') {
      if (!options.sessionId) {
        const id = payload.session_id ?? payload.id;
        if (typeof id === 'string') sessionId = id;
      }
      if (typeof payload.cwd === 'string') cwd = payload.cwd;
      if (typeof payload.originator === 'string') entrypoint = payload.originator;
      else if (typeof payload.source === 'string') entrypoint = payload.source;
      continue;
    }

    if (envelope === 'turn_context') {
      if (typeof payload.cwd === 'string') cwd = payload.cwd;
      if (typeof payload.model === 'string') model = payload.model;
      continue;
    }

    if (envelope !== 'response_item') continue;

    const kind = typeof payload.type === 'string' ? payload.type : '';

    if (kind === 'message') {
      const text = extractTextFromContent(payload.content);
      if (!text.trim()) continue;
      if (payload.role === 'user') {
        // `event_msg/user_message` is the ground truth for "the human typed
        // this"; everything else with role:"user" is injected context.
        if (humanPrompts.size > 0 && !humanPrompts.has(normalise(text))) continue;
        finalize();
        seq += 1;
        userPrompts += 1;
        current = {
          seq,
          ts,
          userText: text,
          assistantTexts: [],
          toolCalls: [],
          byCallId: new Map(),
          files: [],
        };
      } else if (payload.role === 'assistant' && current) {
        current.assistantTexts.push(text);
        current.ts = ts;
        assistantTurns += 1;
      }
      continue;
    }

    if (TOOL_CALL_TYPES.has(kind) && current) {
      let input: unknown = payload.arguments;
      if (typeof input === 'string') input = safeParseJson(input);
      else if (payload.input !== undefined) input = payload.input;
      else if (payload.action !== undefined) input = payload.action;

      const name =
        (typeof payload.name === 'string' && payload.name) ||
        (typeof payload.namespace === 'string' && payload.namespace) ||
        kind;
      const call: ExchangeToolCall = { name, input: stringifyToolInput(input) };
      current.toolCalls.push(call);
      toolCallCount += 1;
      if (typeof payload.call_id === 'string') {
        current.byCallId.set(payload.call_id, current.toolCalls.length - 1);
      }
      for (const f of filesFromToolInput(input)) current.files.push(f);
      continue;
    }

    if (TOOL_OUTPUT_TYPES.has(kind) && current) {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
      if (!callId) continue;
      const at = current.byCallId.get(callId);
      if (at === undefined) continue;
      const call = current.toolCalls[at];
      if (!call) continue;
      const out = stringifyToolOutput(payload.output);
      if (out !== undefined) call.result = out;
    }
  }

  finalize();

  const id = resolvedId();
  const projectSlug = options.projectSlug ?? (cwd ? path.basename(cwd) : 'unknown');
  const bytes = options.bytes ?? statBytes(absolute);

  const session: SessionRecord = {
    id,
    harness: 'codex',
    sourcePath: absolute,
    project: cwd ?? projectSlug,
    projectSlug,
    startedAt: firstTs ?? '',
    endedAt: lastTs ?? firstTs ?? '',
    ...(options.title ? { title: options.title } : {}),
    ...(options.gitBranch ? { gitBranch: options.gitBranch } : {}),
    ...(entrypoint ? { entrypoint } : {}),
    ...(model ? { model } : {}),
    isSidechain: false,
    counts: { userPrompts, assistantTurns, toolCalls: toolCallCount, bytes },
    status: options.status ?? 'live',
  };

  return { session, exchanges, unknownTypes, endOffset, malformedLines };
}

/** First pass: every text the human actually typed, per `event_msg/user_message`. */
async function collectHumanPrompts(absolute: string, start: number): Promise<Set<string>> {
  const out = new Set<string>();
  for await (const line of readJsonlLines(absolute, { start })) {
    if (!line.terminated) break;
    const parsed = parseJsonLine(line.text);
    if (!isRecord(parsed) || parsed.type !== 'event_msg') continue;
    const payload = parsed.payload;
    if (!isRecord(payload) || payload.type !== 'user_message') continue;
    if (typeof payload.message === 'string') out.add(normalise(payload.message));
  }
  return out;
}

/** Compared loosely: the two views differ in trailing whitespace. */
function normalise(text: string): string {
  return text.trim();
}

/** `rollout-2026-07-21T19-35-33-<uuid>.jsonl` — the last uuid in the name. */
export function sessionIdFromPath(filePath: string): string {
  const base = path.basename(filePath, '.jsonl');
  const matches = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
  const last = matches?.[matches.length - 1];
  return last ?? base;
}

function statBytes(absolute: string): number {
  try {
    return fs.statSync(absolute).size;
  } catch {
    return 0;
  }
}

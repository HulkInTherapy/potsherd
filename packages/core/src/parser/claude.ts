import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { unslugify } from '../paths.js';
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
  extractTypedText,
  filesFromToolInput,
  isRecord,
  stringifyToolInput,
  stringifyToolOutput,
  uniq,
} from './content.js';

/**
 * Claude Code transcript parser.
 *
 * Ported from obra/episodic-memory@1075769 `src/parser.ts`
 * (MIT, (c) 2025 Jesse Vincent) — `parseClaudeConversation`. The message-shape
 * knowledge is upstream's: content-block handling, tool_use extraction,
 * accumulating assistant turns until the next user record, carrying session
 * metadata forward from whichever record last mentioned it.
 *
 * Four deliberate deviations, all required by `plans/03-ARCHITECTURE.md` §2:
 *
 *   1. **Exchange boundary.** Upstream starts a new exchange on *any*
 *      `type:user` record, so a turn that used three tools becomes four
 *      exchanges. potsherd starts one only on a **human prompt** — `type:user`
 *      with `promptId` set and content that is not a `tool_result` — and folds
 *      tool results into the exchange that issued them.
 *   2. **Tool results are paired.** Upstream leaves a `TODO: Match tool_use_id
 *      to previous tool_use` and drops every result. potsherd matches them by
 *      `tool_use_id` and fills `toolCalls[].result` / `isError`.
 *   3. **Sidechains are first-class.** Upstream's discovery excludes
 *      `subagents/`; here a sidechain file parses into its own SessionRecord
 *      whose `parentSessionId` is the `sessionId` its records carry (that
 *      field holds the *parent's* id in a subagent transcript), with
 *      `agentName` from the `agent-name` record.
 *   4. **A session, not just exchanges.** Upstream emits exchanges with
 *      session metadata denormalised onto each one. potsherd emits one
 *      `SessionRecord` plus `Exchange[]`, with byte offsets so the next index
 *      run resumes where this one stopped.
 *
 * Nothing here is fatal: an unknown record `type` is counted, a malformed line
 * is counted, and parsing continues.
 */

/** Subagent transcripts live under a directory with this name, at either depth. */
const SIDECHAIN_DIR = 'subagents';

/** Record types the parser reads. Anything else lands in `unknownTypes`. */
const HANDLED_TYPES = new Set([
  'user',
  'assistant',
  'ai-title',
  'agent-name',
  'attachment',
  'summary',
  'system',
]);

interface Builder {
  seq: number;
  ts: string;
  userText: string;
  assistantTexts: string[];
  toolCalls: ExchangeToolCall[];
  /** tool_use_id -> index into toolCalls, for pairing results. */
  byToolUseId: Map<string, number>;
  files: string[];
  parentUuid?: string;
}

export interface ClaudeParseOptions extends ParseOptions {
  isSidechain?: boolean;
  parentSessionId?: string;
  status?: SessionStatus;
  /** File size in bytes; `stat`ed if not supplied. */
  bytes?: number;
}

export async function parseClaudeTranscript(
  filePath: string,
  options: ClaudeParseOptions = {},
): Promise<ParseResult> {
  const absolute = path.resolve(filePath);
  const fromOffset = options.fromOffset ?? 0;

  const unknownTypes: Record<string, number> = {};
  let malformedLines = 0;
  let endOffset = fromOffset;

  const exchanges: Exchange[] = [];
  let current: Builder | null = null;
  let seq = options.fromSeq ?? 0;

  // Session-level facts, taken from whichever record last carried them.
  let recordSessionId: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let entrypoint: string | undefined;
  let model: string | undefined;
  let title: string | undefined;
  let agentName: string | undefined;
  let sidechainFlag = false;
  let firstTs: string | undefined;
  let lastTs: string | undefined;
  let userPrompts = 0;
  let assistantTurns = 0;
  let toolCallCount = 0;

  const finalize = (): void => {
    if (!current) return;
    const b = current;
    current = null;
    if (!b.userText.trim() && b.toolCalls.length === 0) return;
    exchanges.push({
      id: exchangeId(sessionIdSoFar(), b.seq),
      sessionId: sessionIdSoFar(),
      seq: b.seq,
      ts: b.ts,
      userText: b.userText,
      assistantText: b.assistantTexts.join('\n\n'),
      toolCalls: b.toolCalls,
      filesTouched: uniq(b.files),
      isSidechain: sidechainFlag,
      ...(b.parentUuid ? { parentUuid: b.parentUuid } : {}),
      redacted: false,
    });
  };

  // The session id is not known until the first record that carries one, but
  // exchange ids must reference it. Every claude record in a file carries the
  // same one, so resolving lazily on first finalize is safe.
  const sessionIdSoFar = (): string =>
    resolveSessionId(absolute, options, recordSessionId, sidechainFlag);

  for await (const line of readJsonlLines(absolute, { start: fromOffset })) {
    if (!line.terminated) break; // half-written tail: leave it for next run
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

    const type = typeof parsed.type === 'string' ? parsed.type : '';
    if (!HANDLED_TYPES.has(type)) {
      unknownTypes[type || '(no type)'] = (unknownTypes[type || '(no type)'] ?? 0) + 1;
    }

    if (typeof parsed.sessionId === 'string') recordSessionId = parsed.sessionId;
    if (typeof parsed.cwd === 'string') cwd = parsed.cwd;
    if (typeof parsed.gitBranch === 'string') gitBranch = parsed.gitBranch;
    if (typeof parsed.entrypoint === 'string') entrypoint = parsed.entrypoint;
    if (parsed.isSidechain === true) sidechainFlag = true;
    if (typeof parsed.timestamp === 'string') {
      firstTs ??= parsed.timestamp;
      lastTs = parsed.timestamp;
    }

    if (type === 'ai-title') {
      // The title is rewritten as the session goes on; the last one wins.
      if (typeof parsed.aiTitle === 'string' && parsed.aiTitle.trim()) title = parsed.aiTitle;
      continue;
    }
    if (type === 'agent-name') {
      if (typeof parsed.agentName === 'string') agentName = parsed.agentName;
      continue;
    }
    if (type !== 'user' && type !== 'assistant') continue;

    const message = parsed.message;
    if (!isRecord(message)) continue;
    const role = message.role;
    const content = message.content;
    const ts = typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString();

    if (role === 'user') {
      const text = extractTypedText(content);
      const results = toolResultBlocks(content);

      // A human prompt: `type:user` with promptId set, content that is not a
      // tool_result (`03` §2). A string content has no blocks at all, so it is
      // a prompt by construction.
      const isHumanPrompt =
        typeof parsed.promptId === 'string' && parsed.promptId.length > 0 && results.length === 0;

      if (isHumanPrompt) {
        finalize();
        seq += 1;
        userPrompts += 1;
        current = {
          seq,
          ts,
          userText: text,
          assistantTexts: [],
          toolCalls: [],
          byToolUseId: new Map(),
          files: [],
          ...(typeof parsed.parentUuid === 'string' ? { parentUuid: parsed.parentUuid } : {}),
        };
        continue;
      }

      // Not a prompt: a tool_result carrier, or a synthetic user record. Fold
      // its results into the exchange that issued the calls.
      if (current) {
        for (const block of results) {
          const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
          if (!id) continue;
          const at = current.byToolUseId.get(id);
          if (at === undefined) continue;
          const call = current.toolCalls[at];
          if (!call) continue;
          const out = stringifyToolOutput(block.content);
          if (out !== undefined) call.result = out;
          if (block.is_error === true) call.isError = true;
        }
        if (results.length === 0 && text.trim()) {
          // Injected context with no promptId (queued input, hook output).
          // Keep it: it is part of what the user's turn actually said.
          current.userText = current.userText ? `${current.userText}\n${text}` : text;
        }
      }
      continue;
    }

    if (role !== 'assistant' || !current) continue;

    if (typeof message.model === 'string') model = message.model;
    const text = extractTypedText(content);
    if (text.trim()) {
      current.assistantTexts.push(text);
      assistantTurns += 1;
    }
    for (const block of toolUseBlocks(content)) {
      const name = typeof block.name === 'string' ? block.name : 'unknown';
      const call: ExchangeToolCall = { name, input: stringifyToolInput(block.input) };
      current.toolCalls.push(call);
      toolCallCount += 1;
      if (typeof block.id === 'string') current.byToolUseId.set(block.id, current.toolCalls.length - 1);
      for (const f of filesFromToolInput(block.input)) current.files.push(f);
    }
  }

  finalize();

  const sessionId = resolveSessionId(absolute, options, recordSessionId, sidechainFlag);
  const projectSlug = options.projectSlug ?? deriveProjectSlug(absolute);
  const bytes = options.bytes ?? statBytes(absolute);
  const isSidechain = options.isSidechain ?? sidechainFlag;

  const session: SessionRecord = {
    id: sessionId,
    harness: 'claude',
    sourcePath: absolute,
    project: cwd ?? unslugify(projectSlug),
    projectSlug,
    startedAt: firstTs ?? '',
    endedAt: lastTs ?? firstTs ?? '',
    ...(title ? { title } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    ...(entrypoint ? { entrypoint } : {}),
    ...(model ? { model } : {}),
    isSidechain,
    ...(isSidechain
      ? { parentSessionId: options.parentSessionId ?? recordSessionId ?? '' }
      : {}),
    ...(agentName ? { agentName } : {}),
    counts: { userPrompts, assistantTurns, toolCalls: toolCallCount, bytes },
    status: options.status ?? 'live',
  };

  return { session, exchanges, unknownTypes, endOffset, malformedLines };
}

/**
 * A subagent transcript's records carry the **parent's** `sessionId`, and the
 * file has no id of its own beyond its name — so a sidechain's session id is
 * `<parent>:<filename>`. Top-level sessions use the id in their records, and
 * fall back to the filename when the file holds no record that carries one.
 */
function resolveSessionId(
  absolute: string,
  options: ClaudeParseOptions,
  recordSessionId: string | undefined,
  sidechainFlag: boolean,
): string {
  if (options.sessionId) return options.sessionId;
  const base = path.basename(absolute, '.jsonl');
  const isSidechain = options.isSidechain ?? sidechainFlag ?? false;
  if (isSidechain) {
    const parent = options.parentSessionId ?? recordSessionId;
    return parent ? `${parent}:${base}` : base;
  }
  return recordSessionId ?? base;
}

/**
 * `<projects>/<slug>/<id>.jsonl`, `<projects>/<slug>/subagents/<agent>.jsonl`
 * and `<projects>/<slug>/<id>/subagents/<agent>.jsonl` all occur; the slug is
 * the first directory above the file that is not a `subagents` dir or a
 * session id directory.
 */
function deriveProjectSlug(absolute: string): string {
  const parts = absolute.split(path.sep);
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    const part = parts[i];
    if (!part) continue;
    if (part === SIDECHAIN_DIR) continue;
    if (UUID_DIR.test(part)) continue; // <slug>/<session-id>/subagents/<agent>.jsonl
    return part;
  }
  return 'unknown';
}

const UUID_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function statBytes(absolute: string): number {
  try {
    return fs.statSync(absolute).size;
  } catch {
    return 0;
  }
}

function toolUseBlocks(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Record<string, unknown> => isRecord(b) && b.type === 'tool_use');
}

function toolResultBlocks(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Record<string, unknown> => isRecord(b) && b.type === 'tool_result');
}

/**
 * Stable across re-indexes: an exchange keeps its id as long as it keeps its
 * place in its session. Upstream hashed `<archivePath>:<lineStart>-<lineEnd>`,
 * which changes the moment a file is archived or a line is added above.
 */
export function exchangeId(sessionId: string, seq: number): string {
  return crypto.createHash('sha256').update(`${sessionId}:${seq}`).digest('hex').slice(0, 32);
}

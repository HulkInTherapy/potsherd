/**
 * `potsherd export --to agentmemory --yes` — the only write in this package.
 *
 * ## the consent gate is the feature
 *
 * `03` §10: *never write to their stores without `--yes`.* Everything else in
 * `packages/bridges` opens files read-only; this one function can put rows in
 * somebody else's database, so it is built to refuse.
 *
 * The refusal is not a prompt. `potsherd` is run in pipes and by agents, and a
 * verb that blocks on stdin is a verb that hangs. Without `--yes` this returns
 * a **plan** — how many cards would be pushed, to which store, with which tool
 * — and writes nothing. That is also the more useful default: the dry run
 * answers "what would this do to my agentmemory" without doing it.
 *
 * ## the write tool is discovered, not assumed
 *
 * agentmemory has roughly sixty `memory_*` tools and this file has read the
 * schema of none of them, because agentmemory is not installed on the machine
 * that wrote it. Inventing a tool name and an argument shape would produce a
 * function that looks finished and fails on contact — so the name is found in
 * the server's own `tools/list`, by matching a small set of verbs against what
 * the server says it has, and the text argument is taken from the tool's own
 * `inputSchema.properties`.
 *
 * When nothing matches, that is the answer: `no write tool found in
 * tools/list`, nothing written, exit non-zero. A push that cannot be verified
 * is not a push worth guessing at.
 */

import { cardSentinel, paths } from '@potsherd/core';
import fs from 'node:fs';
import path from 'node:path';
import type { BridgeStatus } from '../types.js';
import {
  AGENTMEMORY_TIMEOUT_MS,
  detectAgentMemory,
  discoverLaunch,
  warmClient,
  type AgentMemoryOptions,
  type StdioClient,
} from '../agentmemory.js';

/** Tool-name verbs worth trying, best first. Matched against the server's list. */
const WRITE_VERBS = ['store', 'add', 'create', 'remember', 'write', 'upsert', 'ingest', 'save'];

export interface CardToPush {
  /** potsherd's session id. Carried so the memory can cite where it came from. */
  sessionId: string;
  title: string;
  /** The card's markdown, already rendered and already redacted. */
  markdown: string;
}

export interface PushResult {
  /** True only when `--yes` was given *and* rows were actually written. */
  wrote: boolean;
  /** Cards that would be, or were, pushed. */
  planned: number;
  pushed: number;
  failed: number;
  /** The store written to, or the one that would have been. */
  status: BridgeStatus;
  /** The tool used, once discovered. Null when none was found. */
  tool: string | null;
  /** One line, always printable. Says why, when `wrote` is false. */
  detail: string;
}

export interface PushOptions extends AgentMemoryOptions {
  /** The consent gate. Nothing is written unless this is exactly true. */
  yes?: boolean;
}

/**
 * Push cards into agentmemory, or explain what would happen.
 *
 * Never throws. Returns `wrote: false` for every refusal — no store, no write
 * tool, no `--yes` — and the caller turns that into an exit code.
 */
export async function pushToAgentMemory(
  cards: readonly CardToPush[],
  opts: PushOptions = {},
): Promise<PushResult> {
  const status = detectAgentMemory(opts);
  const base: PushResult = {
    wrote: false,
    planned: cards.length,
    pushed: 0,
    failed: 0,
    status,
    tool: null,
    detail: '',
  };

  if (!status.available) {
    return { ...base, detail: `nothing written — ${status.detail}` };
  }

  const launch = discoverLaunch(opts);
  if (!launch) {
    return { ...base, detail: 'nothing written — launch command not discoverable' };
  }

  const timeout = opts.timeoutMs ?? AGENTMEMORY_TIMEOUT_MS;
  const client = warmClient(launch);
  const started = await client.start(timeout, opts.env ?? process.env);
  if (!started) {
    return { ...base, detail: `nothing written — ${client.error ?? 'the mcp server did not answer'}` };
  }

  const write = await findWriteTool(client, timeout);
  if (!write) {
    return { ...base, detail: 'nothing written — no write tool found in tools/list' };
  }

  // The gate. Discovery above is all reads: `tools/list` tells us whether this
  // *could* work, and saying so costs the user nothing. Only past this line
  // does anything enter their store.
  if (opts.yes !== true) {
    return {
      ...base,
      tool: write.name,
      detail: `${cards.length} card${cards.length === 1 ? '' : 's'} would be pushed to ${status.path} via ${write.name} — re-run with --yes`,
    };
  }

  let pushed = 0;
  let failed = 0;
  let lastError = '';
  for (const card of cards) {
    const args: Record<string, unknown> = { [write.textArg]: card.markdown };
    // Best effort at a title/id, only when the tool says it has somewhere to
    // put one. A tool call with an argument the schema does not declare is a
    // tool call some servers reject outright.
    if (write.titleArg) args[write.titleArg] = card.title;
    if (write.tagsArg) args[write.tagsArg] = ['potsherd', `session:${card.sessionId}`];

    const { error } = await client.call(write.name, args, timeout);
    if (error) {
      failed += 1;
      lastError = error;
      // Their server is not ours to hammer. One failure is a hiccup; a
      // sustained one means the backend is down (their MCP package is a shim
      // over an HTTP service) and every further call will fail the same way.
      if (failed >= 3 && pushed === 0) break;
      continue;
    }
    pushed += 1;
  }

  return {
    wrote: pushed > 0,
    planned: cards.length,
    pushed,
    failed,
    status,
    tool: write.name,
    detail: failed
      ? `${pushed} pushed, ${failed} failed (${lastError || 'no reason given'})`
      : `${pushed} pushed to ${status.path} via ${write.name}`,
  };
}

interface WriteTool {
  name: string;
  textArg: string;
  titleArg: string | null;
  tagsArg: string | null;
}

/**
 * Ask the server which of its tools stores a memory.
 *
 * Deliberately conservative: the tool has to be a `memory_*` tool, its name
 * has to contain a write verb, it must not contain a verb that would make it
 * destructive (`delete`, `forget`, `clear`, `prune`), and it must declare a
 * string property this function can put text in. Anything less and a bad match
 * writes cards into a tool that does something else entirely.
 */
async function findWriteTool(client: StdioClient, timeoutMs: number): Promise<WriteTool | null> {
  const tools = await client.listTools(timeoutMs);
  for (const verb of WRITE_VERBS) {
    for (const tool of tools) {
      const name = tool.name.toLowerCase();
      if (!name.startsWith('memory')) continue;
      if (!name.includes(verb)) continue;
      if (/delete|remove|forget|clear|prune|purge|drop/.test(name)) continue;
      const textArg = tool.properties.find((p) => /^(content|text|memory|body|observation|value)$/i.test(p));
      if (!textArg) continue;
      return {
        name: tool.name,
        textArg,
        titleArg: tool.properties.find((p) => /^(title|name|summary|subject)$/i.test(p)) ?? null,
        tagsArg: tool.properties.find((p) => /^(tags|labels|keywords)$/i.test(p)) ?? null,
      };
    }
  }
  return null;
}

/**
 * The cards on disk, ready to push.
 *
 * Reads the mirror `potsherd card` already wrote rather than re-rendering from
 * the database, for the same reason `export/markdown.ts` copies it: there is
 * one card renderer, and what goes into somebody else's memory tool has to be
 * byte-identical to what `potsherd show` prints.
 *
 * `cardSentinel.isErroredSentinel` is core's own predicate, not a second copy
 * of the rule. The mirror also holds potsherd's bookkeeping — an empty file
 * for a session that can never be carded, an `__ERRORED__` marker for one
 * whose last attempt failed — and `exportCards` shipped those into people's
 * vaults once already. Pushing them into somebody's agentmemory would be the
 * same bug with a worse blast radius, because there is no undo.
 *
 * The session id is the file's basename, which is how the mirror is keyed.
 */
export function collectCards(root: string, limit = 1000): CardToPush[] {
  const from = paths.cardsDir(root);
  const out: CardToPush[] = [];
  if (!fs.existsSync(from)) return out;

  const walk = (dir: string): void => {
    if (out.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      const source = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(source);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      let markdown: string;
      try {
        markdown = fs.readFileSync(source, 'utf-8');
      } catch {
        continue;
      }
      if (markdown.length === 0 || cardSentinel.isErroredSentinel(markdown)) continue;
      const id = entry.name.replace(/\.md$/, '');
      out.push({ sessionId: id, title: firstHeading(markdown) || id, markdown });
    }
  };
  walk(from);
  return out;
}

/** The card's own title, for a tool that has somewhere to put one. */
function firstHeading(markdown: string): string {
  for (const line of markdown.split('\n', 40)) {
    const m = /^#{1,3}\s+(.*\S)\s*$/.exec(line);
    if (m?.[1]) return m[1].slice(0, 160);
  }
  return '';
}

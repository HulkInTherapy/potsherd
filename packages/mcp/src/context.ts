import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { paths, type db as dbNs } from '@potsherd/core';
import { openIndex } from '../../cli/src/filters.js';
import { describeError } from './errors.js';

type Db = dbNs.Db;

/** What the process was started with. One object, threaded to every tool. */
export interface ServerContext {
  /** `--potsherd-dir`, or undefined for `~/.potsherd`. */
  potsherdDir?: string;
  /** Where `potsherd_graft` may write, or null for "nowhere — return it inline". */
  graftCwd: string | null;
  /**
   * The ceiling a long-running tool gives up at.
   *
   * `potsherd_ask` was the only tool that could reach it and T10.6 retired
   * that tool (`server.ts` says why). The field and its environment variable
   * stay because `.mcp.json` files in the wild set it and a server that
   * rejected an unknown key would fail to start over a setting that costs
   * nothing to keep honouring.
   */
  askTimeoutMs: number;
  /**
   * The environment the two model-calling tools resolve a backend from.
   *
   * `process.env` in every real run. It is a field rather than a global so that
   * `--selftest` can hand the server an environment with **no backend in it**
   * and prove the offline path — which is the acceptance criterion this phase
   * actually asks for ("must work, or fail cleanly, with no backend available")
   * — without spending a cent and without depending on what happens to be
   * installed on the machine running it.
   */
  env: NodeJS.ProcessEnv;
}

/** The wall clock a long-running tool will not run past. */
export const ASK_TIMEOUT_MS = 240_000;

export interface ContextOptions {
  potsherdDir?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export function makeContext(o: ContextOptions = {}): ServerContext {
  const env = o.env ?? process.env;
  return {
    ...(o.potsherdDir ? { potsherdDir: o.potsherdDir } : {}),
    graftCwd: resolveGraftCwd(o.cwd ?? process.cwd(), env),
    askTimeoutMs: positiveMs(env['POTSHERD_MCP_ASK_TIMEOUT_MS'], ASK_TIMEOUT_MS),
    env,
  };
}

/**
 * Open the index for one call, and close it again.
 *
 * Per call rather than per process on purpose. An MCP server is long-lived —
 * days, in a client someone leaves open — and the index underneath it is
 * rewritten by `potsherd index`, by the `SessionEnd` hook, and by `rescue`
 * every time the client starts. A connection held open across all of that is a
 * connection reading a file that has been replaced. Opening costs well under a
 * millisecond against the 100 ms `find` budget, so there is nothing to trade.
 */
export function withIndex<T>(ctx: ServerContext, fn: (db: Db, root: string) => T): T {
  const { db, root } = openIndex(ctx.potsherdDir ? { potsherdDir: ctx.potsherdDir } : {});
  try {
    return fn(db, root);
  } finally {
    db.close();
  }
}

export async function withIndexAsync<T>(
  ctx: ServerContext,
  fn: (db: Db, root: string) => Promise<T>,
): Promise<T> {
  const { db, root } = openIndex(ctx.potsherdDir ? { potsherdDir: ctx.potsherdDir } : {});
  try {
    return await fn(db, root);
  } finally {
    db.close();
  }
}

/**
 * Where `potsherd_graft` is allowed to write — and the one decision in this
 * package that is not a straight wrapping of the CLI.
 *
 * `graft` writes `./.potsherd/graft-<id8>.md` **into the process's working
 * directory**. That is the one place potsherd writes outside `~/.potsherd`, it
 * is deliberate (the brief is for *this* project and the agent working in it
 * should find it without being told where potsherd keeps its things), and
 * `doctor --privacy` already discloses it.
 *
 * For the CLI the working directory is where the user typed the command, which
 * is by definition the project they mean. **For an MCP server it is whatever
 * the client happened to launch it in**, and that is not the same fact. Cursor
 * and Claude Code launch a stdio server in the workspace folder, which is
 * exactly right. A globally-registered server in a desktop client is launched
 * in `/`, or in the user's home directory, or in the client's own bundle. A
 * memory tool that scatters `.potsherd/` directories into `$HOME` and `/` the
 * first time a model reaches for a brief is a memory tool people uninstall.
 *
 * So the rule is: **write where the CLI would write, unless that place is
 * plainly not a project — and then do not write at all.**
 *
 *   1. `POTSHERD_GRAFT_CWD` is honoured absolutely. This is the escape hatch a
 *      `.mcp.json` uses to name the workspace explicitly.
 *   2. Otherwise the process's cwd is used, if it passes the test below.
 *   3. Otherwise `graftCwd` is null, `graft` runs with `write: false`, and the
 *      brief comes back **in the tool result** with `path: null` and a note
 *      saying why. Nothing is lost — the brief is the deliverable and the file
 *      was only ever a convenience — and no new path is written that
 *      `doctor --privacy` has not already disclosed.
 *
 * The test a directory has to pass is small enough to state in full: it must
 * exist, be a directory, be writable, and not be the filesystem root, the
 * user's home directory, or the system temporary directory. Those three are
 * the launch directories a client picks when nobody chose one, and they are
 * the three where a `.potsherd/` directory is litter rather than a receipt.
 */
export function resolveGraftCwd(cwd: string, env: NodeJS.ProcessEnv): string | null {
  const explicit = env['POTSHERD_GRAFT_CWD']?.trim();
  if (explicit) return path.resolve(explicit);
  return plausibleProjectDir(cwd) ? path.resolve(cwd) : null;
}

function plausibleProjectDir(dir: string): boolean {
  let resolved: string;
  try {
    resolved = fs.realpathSync(path.resolve(dir));
  } catch {
    return false;
  }
  const forbidden = new Set(
    [path.parse(resolved).root, homeDir(), tmpDir()].filter(Boolean).map((d) => {
      try {
        return fs.realpathSync(d as string);
      } catch {
        return d as string;
      }
    }),
  );
  if (forbidden.has(resolved)) return false;
  try {
    if (!fs.statSync(resolved).isDirectory()) return false;
    fs.accessSync(resolved, fs.constants.W_OK);
  } catch {
    return false;
  }
  return true;
}

function homeDir(): string | null {
  try {
    return os.homedir();
  } catch {
    return null;
  }
}

function tmpDir(): string | null {
  try {
    return os.tmpdir();
  } catch {
    return null;
  }
}

/** Same shape as the CLI's `--potsherd-dir` resolution, for the receipts. */
export function rootOf(ctx: ServerContext): string {
  return paths.potsherdDir(ctx.potsherdDir);
}

function positiveMs(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export { describeError };

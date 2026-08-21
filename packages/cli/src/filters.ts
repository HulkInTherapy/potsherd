import fs from 'node:fs';
import { db as store, paths, type Harness, type SessionStatus } from '@potsherd/core';
import type { db as dbNs, search } from '@potsherd/core';
import { UserError, type GlobalOptions } from './output.js';

type Db = dbNs.Db;
type SearchFilters = search.SearchFilters;
type TriState = search.TriState;

/**
 * The filter flags of `03` §7, parsed once for every verb that takes them.
 *
 * They are shared on purpose: `find`, `ls` and `stats` must agree about what
 * `--project Fulcrum --since 30d --ghosts only` selects, and the only way to
 * guarantee that is for them to run the same parser over the same words.
 *
 * Two defaults are the product, not a preference:
 *
 *   **sidechains: include.** Upstream hard-codes `is_sidechain = 0` into its
 *   search. On the reference machine that hides 197 subagent transcripts —
 *   most of the actual work.
 *
 *   **ghosts: include.** A ghost is a session Claude Code deleted, rebuilt from
 *   `history.jsonl`. Every other tool cannot show them because it never kept
 *   them. Hiding them by default would throw away the reason potsherd exists.
 */
export interface FilterFlags {
  project?: string;
  harness?: string;
  since?: string;
  until?: string;
  branch?: string;
  file?: string;
  tag?: string;
  sidechains?: string;
  ghosts?: string;
  pinned?: boolean;
  status?: string;
}

const HARNESS_NAMES: readonly string[] = [
  'claude',
  'codex',
  'cursor',
  'pi',
  'gemini',
  'opencode',
  'copilot',
];
const STATUSES: readonly string[] = ['live', 'archived', 'ghost'];
const TRI: readonly string[] = ['include', 'only', 'exclude'];

export function parseFilters(db: Db, flags: FilterFlags, now = new Date()): SearchFilters {
  const out: SearchFilters = {};

  if (flags.project) out.project = resolveProject(db, flags.project);
  if (flags.harness) out.harness = one('--harness', flags.harness, HARNESS_NAMES) as Harness;
  if (flags.status) out.status = one('--status', flags.status, STATUSES) as SessionStatus;
  if (flags.since) out.since = parseWhen(flags.since, '--since', now);
  if (flags.until) out.until = parseWhen(flags.until, '--until', now);
  if (flags.branch) out.branch = flags.branch;
  if (flags.file) out.file = flags.file;
  if (flags.tag) out.tag = flags.tag;
  if (flags.pinned) out.pinned = true;
  out.sidechains = tri('--sidechains', flags.sidechains);
  out.ghosts = tri('--ghosts', flags.ghosts);
  return out;
}

function tri(flag: string, value: string | undefined): TriState {
  if (!value) return 'include';
  const v = value.toLowerCase();
  if (!TRI.includes(v)) {
    throw new UserError(`${flag} takes include, only or exclude — not "${value}"`, `potsherd find <query> ${flag} only`);
  }
  return v as TriState;
}

function one(flag: string, value: string, allowed: readonly string[]): string {
  const v = value.toLowerCase();
  if (!allowed.includes(v)) {
    throw new UserError(`${flag} takes ${allowed.join(', ')} — not "${value}"`, `potsherd ls ${flag} ${allowed[0]}`);
  }
  return v;
}

/**
 * `--since 30d`, `--since 2026-08-01`, `--since 6w`.
 *
 * The relative form is what people type (`phase-1` verifies with
 * `--since 30d`); the absolute form is what a script writes. Both end up as an
 * ISO string, which is what the store compares against.
 */
export function parseWhen(value: string, flag: string, now = new Date()): string {
  const rel = /^(\d+)\s*([dwmy])$/i.exec(value.trim());
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const d = new Date(now);
    if (unit === 'd') d.setDate(d.getDate() - n);
    else if (unit === 'w') d.setDate(d.getDate() - n * 7);
    else if (unit === 'm') d.setMonth(d.getMonth() - n);
    else d.setFullYear(d.getFullYear() - n);
    return d.toISOString();
  }
  if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(value)) {
    throw new UserError(
      `${flag} takes YYYY-MM-DD or a span like 30d — not "${value}"`,
      `potsherd ls ${flag} 30d`,
    );
  }
  if (Number.isNaN(new Date(value).getTime())) {
    throw new UserError(`${flag}: "${value}" is not a calendar date`, `potsherd ls ${flag} 2026-08-01`);
  }
  return value;
}

/**
 * `--project Fulcrum` means the directory called Fulcrum, not the string
 * "Fulcrum". Nobody types an absolute path, so the name is matched against the
 * projects actually in the index — exactly first, then by last path segment,
 * then by substring — and an ambiguous name lists the candidates instead of
 * silently choosing one.
 */
export function resolveProject(db: Db, needle: string): string {
  const projects = db
    .prepare(
      `SELECT project, COUNT(*) AS n FROM (
          SELECT project FROM sessions WHERE project IS NOT NULL
          UNION ALL
          SELECT project FROM ghosts WHERE project IS NOT NULL
       ) GROUP BY project ORDER BY n DESC`,
    )
    .all() as { project: string; n: number }[];

  const want = needle.toLowerCase();
  const exact = projects.filter((p) => p.project.toLowerCase() === want);
  if (exact.length === 1) return exact[0]!.project;

  const base = projects.filter((p) => last(p.project).toLowerCase() === want);
  if (base.length === 1) return base[0]!.project;
  if (base.length > 1) throw ambiguous(needle, base.map((p) => p.project));

  const partial = projects.filter((p) => p.project.toLowerCase().includes(want));
  if (partial.length === 1) return partial[0]!.project;
  if (partial.length > 1) throw ambiguous(needle, partial.map((p) => p.project));

  throw new UserError(
    `no indexed project matches "${needle}"`,
    'potsherd ls --json | jq -r ".sessions[].project" | sort -u',
  );
}

function ambiguous(needle: string, candidates: string[]): UserError {
  const shown = candidates.slice(0, 5).join('\n        ');
  return new UserError(
    `"${needle}" matches ${candidates.length} projects:\n        ${shown}`,
    `potsherd ls --project "${candidates[0]}"`,
  );
}

function last(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * Open the index for a read-only verb.
 *
 * A missing database is the common case for someone who has run `audit` and
 * nothing else, so it gets a real message and the one command that fixes it
 * rather than a sqlite error about a file.
 */
export function openIndex(o: GlobalOptions): { db: Db; root: string } {
  const root = paths.potsherdDir(o.potsherdDir);
  const file = paths.dbPath(root);
  if (!fs.existsSync(file)) {
    throw new UserError(
      `nothing indexed yet — no database at ${paths.tildify(file)}`,
      'potsherd index',
    );
  }
  return { db: store.open({ root }), root };
}

/** The number a `--limit` flag carries, or the verb's default. */
export function parseLimit(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    throw new UserError(`--limit takes a positive number — not "${String(value)}"`, `potsherd ls --limit ${fallback}`);
  }
  return Math.floor(n);
}

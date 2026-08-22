import fs from 'node:fs';
import {
  db as store,
  normalizeTag,
  paths,
  resolveSession,
  search as searchNs,
  type Harness,
  type SessionStatus,
} from '@potsherd/core';
import type { db as dbNs, search } from '@potsherd/core';
import { UserError, type GlobalOptions } from './output.js';

const { whenEdge, WHEN_FORMS } = searchNs;

type Db = dbNs.Db;
type SearchFilters = search.SearchFilters;
type TriState = search.TriState;

/**
 * The filter flags of `03` §7, parsed once for every verb that takes them.
 *
 * They are shared on purpose: `find`, `ls` and `stats` must agree about what
 * `--project event-bus --since 30d --ghosts only` selects, and the only way to
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
  linkedTo?: string;
  untitled?: boolean;
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
  // The same normalisation the writer applies, so `--tag Postgres` finds what
  // `potsherd tag <id> +postgres` wrote. Normalising on only one of the two
  // sides is how a tag filter becomes a lottery.
  if (flags.tag) out.tag = resolveTag(flags.tag);
  if (flags.pinned) out.pinned = true;
  if (flags.linkedTo) out.linkedTo = resolveSessionRef(db, flags.linkedTo, '--linked-to');
  if (flags.untitled) out.untitled = true;
  out.sidechains = tri('--sidechains', flags.sidechains);
  out.ghosts = tri('--ghosts', flags.ghosts);
  return out;
}

/** `--tag Postgres` -> `postgres`, or an error naming what a tag may contain. */
function resolveTag(value: string): string {
  const tag = normalizeTag(value);
  if (!tag) {
    throw new UserError(
      `--tag "${value}" has nothing in it a tag can be made of (letters, digits, - . _ /)`,
      'potsherd ls --tag postgres',
    );
  }
  return tag;
}

/**
 * `--linked-to 4c9339e0` -> the whole session id.
 *
 * The filter compares ids, and `links` stores whole ones, so the prefix a user
 * reads off `ls` has to be resolved before it reaches SQL. Resolving here also
 * means a typo is caught as a typo — "no session id starts with …" — instead
 * of quietly matching nothing, which reads as "these two are not linked".
 */
function resolveSessionRef(db: Db, ref: string, flag: string): string {
  const found = resolveSession(db, ref.trim());
  if (!found) {
    throw new UserError(
      `${flag}: no session id starts with "${ref}"`,
      'potsherd ls    # the ids are in  potsherd ls --json',
    );
  }
  if (found.ambiguous) {
    const shown = found.ambiguous.slice(0, 3).map((c) => c.id).join('\n        ');
    throw new UserError(
      `${flag}: "${ref}" matches ${found.ambiguous.length} sessions:\n        ${shown}`,
      `potsherd ls ${flag} ${found.ambiguous[0]!.id}`,
    );
  }
  return found.id;
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
 * `--since 30d`, `--since "last week"`, `--since "in july"`, `--until 2026-08-01`.
 *
 * The parsing itself is `core/search/when.ts`, which returns the *interval* a
 * phrase names; this picks the end of it the flag wants. That split is what
 * makes `--since "in july"` and `--until "in july"` mean opposite edges of the
 * same month instead of the same instant twice — and what makes
 * `--until 2026-08-01` include the first of August rather than stopping at its
 * first millisecond.
 *
 * The error lists the forms that parse, taken from the same array the parser
 * is built around, so the message can never advertise a form that does not
 * work. An unparseable date is the error a user is most likely to hit while
 * typing quickly, and "not a date" with no examples is the least useful thing
 * to say to them.
 */
export function parseWhen(value: string, flag: string, now = new Date()): string {
  const edge = flag === '--until' ? 'until' : 'since';
  const at = whenEdge(value, edge, now);
  if (at === null) {
    // Wrapped by hand at 60: the forms list is 130 characters long and an
    // error that needs a wide terminal to be read is an error that gets
    // skipped. The indent lines them up under "it takes:".
    const lines: string[] = [];
    for (const form of WHEN_FORMS) {
      const last = lines[lines.length - 1];
      if (last !== undefined && last.length + form.length + 2 <= 58) {
        lines[lines.length - 1] = `${last}  ${form}`;
      } else {
        lines.push(form);
      }
    }
    const forms = lines.map((l, i) => (i === 0 ? `it takes:  ${l}` : `           ${l}`));
    throw new UserError(
      `${flag} did not understand "${value}"\n${forms.map((l) => `        ${l}`).join('\n')}`,
      `potsherd ls ${flag} 30d`,
    );
  }
  return at;
}

/**
 * `--project event-bus` means the directory called event-bus, not the string
 * "event-bus". Nobody types an absolute path, so the name is matched against the
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

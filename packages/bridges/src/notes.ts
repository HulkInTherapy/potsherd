/**
 * The notes bridge — auto-memory and `CLAUDE.md`, read into a `notes` list.
 *
 * ## the question this bridge exists to answer
 *
 * The phase file states the purpose in one clause: *"so `find` can say 'this
 * is already in your CLAUDE.md'"*. That is not a search feature. It is a
 * **negative** result, and it is the most valuable thing this bridge produces:
 * a user who searches for a decision and finds it sitting in a memory file the
 * agent already reads on every startup has learned that the thing is not lost,
 * does not need re-deriving, and does not need a card.
 *
 * So a hit here is worth surfacing even when it is one of very few, and the
 * label matters more than the rank.
 *
 * ## what it reads, and why those and not others
 *
 * Three sources, all files, all read-only, all already on this machine:
 *
 *   1. `~/.claude/projects/<slug>/memory/*.md` — Claude Code's auto-memory,
 *      keyed by the slugified working directory. This is the one that is
 *      genuinely invisible: it is written by the agent, not the user, and
 *      almost nobody knows the path.
 *   2. `<project>/CLAUDE.md` and `<project>/.claude/CLAUDE.md`, walking up
 *      from the working directory to the repository root. Project rules.
 *   3. `~/.claude/CLAUDE.md` — the user's global instructions.
 *
 * It does **not** read `~/.claude/projects/<slug>/*.jsonl`. Those are
 * transcripts, potsherd indexes them itself, and pulling them in here would be
 * exactly the double-capture `03` §10 forbids — the same content in two lists,
 * inflating its own corroboration.
 *
 * ## fts only, and what that means without an fts index
 *
 * The phase file says this list is fts only: no embeddings, no model, no
 * vector half. There is also no sqlite here — these are loose markdown files,
 * and building an index for a handful of them would cost more than reading
 * them. So the scoring is a small, honest bm25-shaped count over the same
 * tokens `find` itself uses, via `ftsQuery` from core, and the `strategy` is
 * reported as `files` so nothing downstream mistakes it for a real fts5 rank.
 *
 * The unit is a **section**, not a file: a `CLAUDE.md` is a list of unrelated
 * rules under headings, and returning the whole file as one hit would quote
 * the wrong rule under a heading that matches. Splitting on markdown headings
 * means the hit can name the section it came from.
 */

import { ftsQuery, paths } from '@potsherd/core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  absentStatus,
  emptyStatus,
  firstLine,
  unavailableList,
  type BridgeHit,
  type BridgeList,
  type BridgeQueryOptions,
  type BridgeStatus,
} from './types.js';

export interface NotesOptions extends BridgeQueryOptions {
  /** `~/.claude`, or an override — the same one every other verb honours. */
  claudeDir?: string;
  /** The project whose `CLAUDE.md` and memory dir to read. Default `cwd`. */
  cwd?: string;
  /** How far up from `cwd` to look for a `CLAUDE.md`. Default 6. */
  maxDepth?: number;
  /** Bytes to read per file. Default 256 KiB — a memory file is not a corpus. */
  maxBytes?: number;
}

/** A markdown section, the unit this bridge ranks and returns. */
export interface NoteSection {
  /** Absolute path of the file it came from. */
  file: string;
  /** Which of the three sources this is, for the hit's label. */
  kind: 'auto-memory' | 'project-claude-md' | 'global-claude-md';
  /** The nearest enclosing heading, or the file's basename. */
  heading: string;
  text: string;
  /** 1-based line the section starts on, so a hit can be opened. */
  line: number;
}

const MAX_BYTES = 256 * 1024;

/**
 * Every file this bridge would read, whether or not it exists.
 *
 * Exported because `doctor --privacy` has to list every path potsherd reads
 * (`03` §11), and the only way that list cannot drift from what the code opens
 * is for both to come from here.
 */
export function notesPaths(opts: NotesOptions = {}): { path: string; kind: NoteSection['kind'] }[] {
  const claude = paths.claudePaths(opts.claudeDir ? paths.expandTilde(opts.claudeDir) : undefined);
  const cwd = opts.cwd ?? process.cwd();
  const out: { path: string; kind: NoteSection['kind'] }[] = [];

  out.push({ path: memoryDir(claude.projects, cwd), kind: 'auto-memory' });

  // The global file is computed before the walk so the walk can *avoid* it.
  // Without that it is found as `<home>/.claude/CLAUDE.md` on the way up and
  // labelled `project-claude-md` — which is how the first run of this bridge
  // reported the user's global instructions as a project rule. A label that is
  // wrong is worse than a file that is missing: the whole output of this
  // bridge is "which of your memory files already says this".
  const global = path.join(claude.root, 'CLAUDE.md');

  // Upward walk, nearest first: a `CLAUDE.md` in the directory you are in
  // outranks the one at the repository root, which is the order Claude Code
  // itself applies them in.
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < (opts.maxDepth ?? 6); depth += 1) {
    for (const candidate of [
      path.join(dir, 'CLAUDE.md'),
      path.join(dir, '.claude', 'CLAUDE.md'),
    ]) {
      if (candidate !== global) out.push({ path: candidate, kind: 'project-claude-md' });
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  out.push({ path: global, kind: 'global-claude-md' });
  return out;
}

/** `~/.claude/projects/<slug>/memory` for a working directory. */
export function memoryDir(projectsDir: string, cwd: string): string {
  return path.join(projectsDir, paths.slugify(path.resolve(cwd)), 'memory');
}

// ------------------------------------------------------------------ detect

/**
 * Are there any notes to read?
 *
 * `empty` here means something specific and useful: the memory directory
 * exists — Claude Code created it — and holds no markdown. That is a real
 * state, it happens on a fresh project, and it is not the same as "you have no
 * CLAUDE.md", which is the `absent` answer.
 */
export function detectNotes(opts: NotesOptions = {}): BridgeStatus {
  const candidates = notesPaths(opts);
  const memory = candidates.find((c) => c.kind === 'auto-memory')?.path ?? '';
  const files = readableFiles(candidates);

  if (files.length > 0) {
    const bytes = files.reduce((n, f) => n + f.bytes, 0);
    return {
      bridge: 'notes',
      presence: 'store',
      path: memory,
      available: true,
      detail: `${files.length} file${files.length === 1 ? '' : 's'}, ${Math.round(bytes / 1024)} KiB (${describe(files)})`,
      schema: null,
      rows: files.length,
      worker: null,
    };
  }

  if (fs.existsSync(memory)) {
    return emptyStatus('notes', memory, 'the memory directory exists and holds no markdown');
  }
  return absentStatus('notes', memory, 'no auto-memory directory and no CLAUDE.md above the cwd');
}

interface Readable {
  path: string;
  kind: NoteSection['kind'];
  bytes: number;
}

function readableFiles(
  candidates: readonly { path: string; kind: NoteSection['kind'] }[],
): Readable[] {
  const out: Readable[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (c.kind === 'auto-memory') {
      for (const f of markdownIn(c.path)) {
        if (seen.has(f)) continue;
        seen.add(f);
        const bytes = sizeOf(f);
        if (bytes !== null) out.push({ path: f, kind: c.kind, bytes });
      }
      continue;
    }
    if (seen.has(c.path)) continue;
    const bytes = sizeOf(c.path);
    if (bytes === null) continue;
    seen.add(c.path);
    out.push({ path: c.path, kind: c.kind, bytes });
  }
  return out;
}

function markdownIn(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

function sizeOf(file: string): number | null {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

function describe(files: readonly Readable[]): string {
  const counts = new Map<string, number>();
  for (const f of files) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  return [...counts.entries()].map(([kind, n]) => `${n} ${kind}`).join(', ');
}

// ------------------------------------------------------------------ split

/**
 * Split a markdown file into the sections a hit can point at.
 *
 * Headings of any level open a section. Text before the first heading becomes
 * a section named after the file, because a `CLAUDE.md` that is one flat list
 * of rules with no headings is common and must not vanish.
 */
export function sections(file: string, kind: NoteSection['kind'], content: string): NoteSection[] {
  const lines = content.split('\n');
  const out: NoteSection[] = [];
  let heading = path.basename(file);
  let start = 1;
  let buffer: string[] = [];

  const flush = (): void => {
    const text = buffer.join('\n').trim();
    if (text) out.push({ file, kind, heading, text, line: start });
    buffer = [];
  };

  lines.forEach((line, i) => {
    const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (m) {
      flush();
      heading = m[2] ?? path.basename(file);
      start = i + 1;
      return;
    }
    buffer.push(line);
  });
  flush();
  return out;
}

// ------------------------------------------------------------------- query

/**
 * `notes` as one more ranked list.
 *
 * Scoring, stated plainly so nobody mistakes it for bm25: a section's score is
 * the number of distinct query tokens it contains, times a small bonus when a
 * token is in the heading, times a length normalisation. Sections matching
 * every token come first. It is a count, not a model, and it is enough — the
 * corpus is a handful of files, and the question being answered is "is this
 * already written down", which does not need a fine ranking.
 *
 * Never throws: an unreadable file is skipped, and a directory that vanished
 * between `detect` and here yields an empty list rather than an exception.
 */
export function queryNotes(query: string, opts: NotesOptions = {}): BridgeList {
  const started = Date.now();
  const status = detectNotes(opts);
  if (!status.available) return unavailableList(status, Date.now() - started);

  const limit = Math.max(1, opts.limit ?? 20);
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const tokens = ftsQuery(query).tokens.filter((t) => t.length > 1);
  if (tokens.length === 0) {
    return {
      list: 'notes',
      status,
      hits: [],
      ms: Date.now() - started,
      unavailable: null,
      strategy: 'files',
      relaxed: false,
    };
  }

  // Read once, score twice. `find` requires every query token first and only
  // relaxes to any-token when the strict pass came back thin (`recall()`'s
  // `relaxed`), and this list has to behave the same way or it becomes a noise
  // generator: scored on coverage alone, `zzz-does-not-exist` returns three
  // sections for the word `this`, and RRF cannot tell that they are noise
  // because rank 1 of a junk list looks exactly like rank 1 of a good one.
  const all: NoteSection[] = [];
  try {
    for (const file of readableFiles(notesPaths(opts))) {
      let content: string;
      try {
        content = fs.readFileSync(file.path, 'utf-8').slice(0, maxBytes);
      } catch {
        continue;
      }
      all.push(...sections(file.path, file.kind, content));
    }
  } catch (err) {
    return unavailableList(
      { ...status, presence: 'unrecognised', available: false, detail: firstLine(err) },
      Date.now() - started,
    );
  }

  const pass = (requireAll: boolean): { section: NoteSection; score: number }[] => {
    const out: { section: NoteSection; score: number }[] = [];
    for (const section of all) {
      const score = scoreSection(section, tokens, requireAll);
      if (score > 0) out.push({ section, score });
    }
    return out;
  };

  let scored = pass(true);
  const relaxed = scored.length === 0;
  if (relaxed) scored = pass(false);

  scored.sort((a, b) => b.score - a.score || a.section.file.localeCompare(b.section.file));

  const hits: BridgeHit[] = scored.slice(0, limit).map((s, i) => ({
    bridge: 'notes',
    id: `${tildify(s.section.file)}#${s.section.line}`,
    title: oneLine(`${label(s.section.kind)} › ${s.section.heading}`),
    text: s.section.text,
    ts: null,
    source: s.section.file,
    rank: i + 1,
    raw: s.score,
  }));

  return {
    list: 'notes',
    status,
    hits,
    ms: Date.now() - started,
    unavailable: null,
    strategy: 'files',
    relaxed,
  };
}

/**
 * A section's score, or 0 when it does not qualify.
 *
 * `requireAll` is the AND pass: every query token has to appear somewhere in
 * the section, heading or body. A token counts once wherever it is found, so a
 * word that appears only in the heading still satisfies the requirement — the
 * heading is part of the rule, not metadata about it.
 */
function scoreSection(
  section: NoteSection,
  tokens: readonly string[],
  requireAll: boolean,
): number {
  const body = section.text.toLowerCase();
  const head = section.heading.toLowerCase();
  let matched = 0;
  let headMatched = 0;
  let present = 0;
  for (const token of tokens) {
    const inBody = body.includes(token);
    const inHead = head.includes(token);
    if (inBody) matched += 1;
    if (inHead) headMatched += 1;
    if (inBody || inHead) present += 1;
  }
  if (requireAll && present < tokens.length) return 0;
  if (matched === 0 && headMatched === 0) return 0;
  // Coverage dominates: a section with all four query words beats one with a
  // single word repeated forty times, which is the failure mode of raw term
  // frequency on documents this short.
  const coverage = (matched + headMatched * 0.5) / tokens.length;
  // Mild length normalisation. A 4 kB section that mentions everything is less
  // useful than a 200-byte rule that mentions everything.
  const norm = 1 / (1 + Math.log10(1 + section.text.length / 400));
  return coverage * norm;
}

function label(kind: NoteSection['kind']): string {
  return kind === 'auto-memory'
    ? 'auto-memory'
    : kind === 'global-claude-md'
      ? '~/.claude/CLAUDE.md'
      : 'CLAUDE.md';
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function tildify(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

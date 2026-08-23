import { z } from 'zod';

/**
 * `include | only | exclude`, the tri-state `--sidechains` and `--ghosts` take.
 *
 * An enum rather than a string, so a client that sends `"yes"` is told what the
 * three words are by the schema instead of by an error — and so the JSON Schema
 * the tool list advertises names them, which is where a model reads them from.
 */
export const TRI_STATE = z.enum(['include', 'only', 'exclude']).optional();

/**
 * A date field, described by the forms that actually parse.
 *
 * The parsing is `core/search/when.ts` and it takes far more than ISO dates —
 * `30d`, `last week`, `in july`. A model that only knew `since` accepted a date
 * would translate "last month" into an ISO range itself, badly, and off by a
 * timezone. Naming the forms in the schema is how it learns not to.
 */
export function whenField(what: string): z.ZodOptional<z.ZodString> {
  return z
    .string()
    .optional()
    .describe(`${what}. Takes 30d, 2w, "last week", "in july", or 2026-08-01`);
}


// ------------------------------------------------------------ T10.6 · F7/F1
//
// The three-tool surface's shared shapes. Two of them exist because two other
// workers are changing what `recall` returns underneath this package, and this
// file is the single place either change has to land.

/**
 * A **thread** reference — the fork/resume chain, which audit F4 and plan §B5
 * make the unit instead of the session.
 *
 * Any member of the chain names the whole chain, so this takes exactly what a
 * session ref took: the eight characters `recall` prints. The wording is the
 * contract the model reads, and it deliberately says *thread*, because a model
 * handed "session id" will believe it got a session's worth of history when
 * the thread has 1,660 more records one hop away (audit F4).
 */
export const THREAD_REF = z
  .string()
  .min(1)
  .describe(
    'a thread: the first eight characters of ANY session id in the fork/resume chain, as potsherd_recall prints them. The whole chain is returned, not just the link you named',
  );

/**
 * `want` — the one argument that decides whether `potsherd_recall` hands back
 * a shortlist or the text itself.
 *
 * Two calls, not two tools. The audit's §4.5 signature is
 * `potsherd_recall(query, scope?, want: "hits"|"context")` and the reason it is
 * one tool is F7: six tools with overlapping descriptions cost the model a
 * decision on every call. `hits` and `context` are the same search; they differ
 * only in how much of the transcript comes back with it.
 */
export const WANT = z
  .enum(['hits', 'context'])
  .optional()
  .describe(
    'hits (default) — ranked threads with snippets, confidence and a citation line each. context — the matching windows themselves, seq + ts + text, ready to quote',
  );

/**
 * The filters, as one object, because the pinned signature has one `scope`.
 *
 * They were nine top-level fields on `potsherd_find`. Collapsing them into
 * `scope` is not cosmetic: it is what makes the tool's own schema readable as
 * *(what to look for, where to look, how much to bring back)* — three
 * arguments a model can hold in its head — instead of twelve peers among which
 * `query` is just the first.
 */
export const SCOPE = z
  .object({
    project: z
      .string()
      .optional()
      .describe('only this project — a directory name like "event-bus", not a path'),
    harness: z
      .enum(['claude', 'codex', 'cursor', 'pi', 'gemini', 'opencode', 'copilot'])
      .optional()
      .describe('only sessions from this coding agent'),
    since: whenField('only sessions at or after this'),
    until: whenField('only sessions at or before this'),
    tag: z.string().optional().describe('only sessions carrying this tag'),
    sidechains: TRI_STATE.describe(
      'subagent transcripts: include (default), only, or exclude. Most of the actual work is in these',
    ),
    ghosts: TRI_STATE.describe(
      'sessions the harness deleted, rebuilt from history: include (default), only, or exclude',
    ),
    pinned: z.boolean().optional().describe('only sessions the user pinned'),
    limit: z.number().int().min(1).max(100).optional().describe('threads to return. Default 10'),
  })
  .optional()
  .describe(
    'narrow the search. Leave it out on the first call: the archive\'s whole value is that the answer is usually in a DIFFERENT project than the one you are in',
  );

export type ScopeArg = z.infer<typeof SCOPE>;

// --------------------------------------------------------------- confidence
//
// T10.1 (audit F1, plan §B1) has LANDED on main. Its shape is no longer an
// assumption, and this block is written against the real one:
//
//   envelope  `confidence`, `minConfidence`, `belowFloor` (rows withheld)
//   row       `confidence`, `calibration.{score,coverage,strength,agreement}`
//   type      `Confidence` is exported from the `@potsherd/core` barrel
//
// This package **reads** those fields; it does not compute one. That
// distinction is the whole point of F1: a second implementation of "is this a
// good match" living at the MCP surface would be a second answer the user
// could catch disagreeing with the first, and an agent cannot act on two
// cliffs.
//
// **The one thing integration still has to do.** This worktree was cut before
// T10.1 landed and may not fetch, so `Confidence` is declared here rather than
// imported. It is the same three words in the same order. At integration,
// delete the `export type Confidence` line below and add core to the import at
// the top of this file:
//
//     import { type Confidence } from '@potsherd/core';
//
// Nothing else changes: every read already goes through the three functions
// underneath, and every field name is a constant.

/** @see the note above — replace with the `@potsherd/core` export at integration. */
export type Confidence = 'strong' | 'weak' | 'none';

/** The field name on a row and on the envelope. */
export const CONFIDENCE_FIELD = 'confidence';

/** The envelope's floor, and the count of rows the floor withheld. */
export const MIN_CONFIDENCE_FIELD = 'minConfidence';
export const BELOW_FLOOR_FIELD = 'belowFloor';

/** The per-row calibration detail T10.1 attaches. */
export const CALIBRATION_FIELD = 'calibration';

/** The three words, in order, worst last. */
export const CONFIDENCE_VALUES: readonly Confidence[] = ['strong', 'weak', 'none'];

/**
 * The floor the agent-facing door searches at.
 *
 * `'weak'` — the same value the orchestrator has already given `find`, so the
 * human path and the model path return an honest empty on the same cliff. This
 * is the single most important line in this package and it is the reason F1
 * mattered: without a floor, `find` returned ten confident-looking rows for a
 * word that does not exist in any human language, and the rational thing for
 * an agent to do with that is to distrust the whole result set and answer from
 * the repository in front of it. Which is exactly what the audit's two
 * archaeologist runs did.
 */
export const AGENT_FLOOR: Confidence = 'weak';

/**
 * The confidence a core object carries, or `null` when this build's core does
 * not carry one yet.
 *
 * `null` is not `'none'` and must never be rendered as one. `'none'` is a
 * measurement — *the archive does not contain this* — and it is the answer the
 * auditor said buys more trust than a page of maybes. `null` is the absence of
 * a measurement, which is the pre-T10.1 state the audit scored 3/10, and the
 * reply says so in words rather than pretending to a cliff it does not have.
 */
export function confidenceOf(row: unknown): Confidence | null {
  return readConfidence(row, CONFIDENCE_FIELD);
}

/** The floor a result was searched at, as the core result reports it. */
export function minConfidenceOf(result: unknown): Confidence | null {
  return readConfidence(result, MIN_CONFIDENCE_FIELD);
}

/** How many rows the floor withheld, as the core result counted them. */
export function belowFloorOf(result: unknown): number | null {
  if (!result || typeof result !== 'object') return null;
  const v = (result as Record<string, unknown>)[BELOW_FLOOR_FIELD];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * T10.1's per-row detail — `{ score, coverage, strength, agreement }` — passed
 * through untouched.
 *
 * Passed through rather than projected field by field, on purpose. This is the
 * arithmetic behind the one-word label, and the surface that re-listed its
 * members by hand would silently drop the fifth one T10.1 adds next.
 */
export function calibrationOf(row: unknown): unknown {
  if (!row || typeof row !== 'object') return null;
  return (row as Record<string, unknown>)[CALIBRATION_FIELD] ?? null;
}

function readConfidence(o: unknown, field: string): Confidence | null {
  if (!o || typeof o !== 'object') return null;
  const v = (o as Record<string, unknown>)[field];
  return v === 'strong' || v === 'weak' || v === 'none' ? (v as Confidence) : null;
}

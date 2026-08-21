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

/** A session id, or any unambiguous prefix of one — the eight `ls` prints. */
export const SESSION_REF = z
  .string()
  .min(1)
  .describe(
    'a session id, or the first eight characters of one as potsherd_find and potsherd_ls print them',
  );

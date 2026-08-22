/**
 * T4.2 — the **model pass** of open threads, and nothing else.
 *
 * This is a split of `open-threads.ts`, made in T6.6 (D0b) and made for one
 * reason: `Llm.open` lives here now, so it does not live there.
 *
 * `open-threads.ts` holds the rule pass — `openThreadCandidates`, the token
 * arithmetic, the project-overlap thresholds — and is a pure, offline
 * computation over the index. It used to hold this function too, and that one
 * fact made the whole 846-line file *model-reaching* to anything that read it.
 * `link --suggest` reads it (`link-suggest.ts` calls `openThreadCandidates`),
 * so the phase-6 guard in `tests/llm.test.ts` flagged `link` as a verb that
 * can reach a model. At file granularity the guard was **right**; the code was
 * also right; the two could not both be satisfied while one file held both
 * passes.
 *
 * The rule we did not break to fix it: *never make a guard coarser to fit the
 * code*. No allowlist was added and no test was skipped. The file was split so
 * that the guard's answer — "`link` cannot reach a model" — is true by
 * construction rather than by exception.
 *
 * The dependency runs one way only. This module imports the rule pass's types;
 * `open-threads.ts` imports nothing from here and must not, or the hole
 * reopens. `ask.ts` imports both. The `@potsherd/core` barrel re-exports
 * `confirmOpenThreads` and `ConfirmOptions` under the same names they had
 * before, so no consumer of the public API changes.
 *
 * Everything the model is and is not allowed to do is documented on
 * {@link confirmOpenThreads}: it contributes two fields, it never contributes
 * a fact, and it is overruled in code rather than in the prompt.
 */
import { ASK_MODEL, Llm, detectBackend, type Budget, type Llm as LlmType } from './llm.js';
import type { OpenThread, OpenThreadCandidate } from './open-threads.js';

export interface ConfirmOptions {
  llm?: LlmType;
  model?: string;
  budget?: Budget;
  signal?: AbortSignal;
}

/**
 * How many candidates one model call confirms.
 *
 * Twelve. The batch is the point: a real haiku-class call through the agent
 * SDK takes 60–160 s (`llm.ts` `CALL_PROFILES`), so N calls for N candidates
 * would put the open-thread section of `ask` at twenty minutes on a bad day.
 * One call for the whole set puts it at one call.
 *
 * Twelve rather than "all of them" because the batch has to fit and has to be
 * answerable: at ~600 chars a candidate a full batch is ~7 kB of prompt, an
 * order of magnitude under `cards/slice.ts`'s 60 kB chunking threshold, and
 * twelve one-sentence verdicts sit inside the 4,096-token output default.
 * {@link CandidateOptions.limit} defaults to 8, so a default `ask` is always
 * exactly one call; more than twelve chunks into further calls rather than
 * being silently truncated.
 */
export const CONFIRM_BATCH = 12;

/** What a candidate's note says when there was no model to ask. */
export const NO_MODEL_NOTE =
  'no model was available to confirm this, so it is unconfirmed and not shown.';

const CONFIRM_SYSTEM =
  'You are auditing candidate "open threads" found by a rule that compares session summaries ' +
  'across a developer\'s projects. Each candidate says: this was decided in project A, and ' +
  'project A and project B share the listed topics and files, and no summary in project B ' +
  'mentions it.\n' +
  'The absence has already been checked arithmetically and is not your job. Your job is ' +
  'whether the candidate is WORTH RAISING: are these two projects genuinely related, and is ' +
  'this decision the kind of thing that should carry from one to the other?\n' +
  'Reject when the overlap is a coincidence of vocabulary, when the decision is local to ' +
  'project A (a one-off fix, a rename, something about A\'s own files), or when it is too ' +
  'vague to act on. Confirm only when a reasonable person would want to be reminded of it ' +
  'while working in project B.\n' +
  'Answer in one short sentence per candidate. Never invent detail that is not in the input.';

const CONFIRM_SCHEMA = `{"results": [{"i": 0, "confirmed": true, "note": "one sentence"}]}`;

interface RawVerdict {
  i: number;
  confirmed: boolean;
  note: string;
}

function promptFor(batch: readonly OpenThreadCandidate[]): string {
  const lines: string[] = [
    `${batch.length} candidate open thread${batch.length === 1 ? '' : 's'}. ` +
      'Return one verdict for each, keyed by "i".',
    '',
  ];
  batch.forEach((c, i) => {
    lines.push(`[${i}] decided in: ${c.project}`);
    lines.push(`    decision: ${c.what}`);
    if (c.why) lines.push(`    reason: ${c.why}`);
    lines.push(`    not seen in: ${c.otherProject} (${c.otherSessionIds.length} session(s) checked)`);
    if (c.overlap.topics.length) lines.push(`    shared topics: ${c.overlap.topics.join(', ')}`);
    if (c.overlap.files.length) lines.push(`    shared files: ${c.overlap.files.join(', ')}`);
    lines.push('');
  });
  return lines.join('\n');
}

/** One sentence, and not a paragraph wearing one sentence's clothes. */
function oneSentence(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const s = raw.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const stop = /[.!?](\s|$)/.exec(s);
  const first = stop ? s.slice(0, stop.index + 1) : s;
  return first.length <= 220 ? first : `${first.slice(0, 219).trimEnd()}…`;
}

function validateVerdicts(value: unknown): { results: RawVerdict[] } | null {
  const rec = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const list = Array.isArray(rec?.['results'])
    ? (rec['results'] as unknown[])
    : Array.isArray(value)
      ? (value as unknown[])
      : null;
  if (!list) return null;
  const results: RawVerdict[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const i = typeof r['i'] === 'number' ? r['i'] : Number(r['i'] ?? r['index']);
    if (!Number.isInteger(i)) continue;
    results.push({
      i,
      confirmed: r['confirmed'] === true || r['confirmed'] === 'true',
      note: oneSentence(r['note'] ?? r['reason'] ?? r['why']),
    });
  }
  return { results };
}

function unconfirmed(cands: readonly OpenThreadCandidate[], note: string): OpenThread[] {
  return cands.map((c) => ({ ...c, confirmed: false, note }));
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Model pass — confirms or rejects each candidate in one sentence.
 *
 * **One call for the whole batch**, not one per candidate: see
 * {@link CONFIRM_BATCH}.
 *
 * The model is advisory and is treated as such in code:
 *
 *   - it contributes exactly two fields, `confirmed` and `note`. Every other
 *     field on the returned {@link OpenThread} is the rule pass's own value,
 *     copied across. A model that renames the project or rewrites the decision
 *     cannot change what is printed.
 *   - a verdict for an index that was never sent is discarded.
 *   - a confirmation of a candidate whose decision **is not supported by the
 *     card's own `evidence_seq`** is overruled here regardless of what the
 *     model said. `plans` T4.2's ruling: *the prompt is not the guard; the code
 *     is*. (The rule pass never emits such a candidate — it checks the seq
 *     against the transcript, which it can do because it has the `Db`. This
 *     second check exists because `confirmOpenThreads` is a public export and
 *     the pinned signature gives it no `Db` of its own; what it can still
 *     verify without one is that the citation exists at all, and it does.)
 *   - a confirmation with no sentence is not a confirmation.
 *
 * **This function never throws.** `ask` must not fail because open threads
 * could not be confirmed: with no backend, a dead backend, a budget abort or a
 * timeout, every candidate comes back `confirmed:false` with a note saying so,
 * and the caller shows nothing.
 */
export async function confirmOpenThreads(
  cands: readonly OpenThreadCandidate[],
  o: ConfirmOptions = {},
): Promise<OpenThread[]> {
  if (cands.length === 0) return [];

  let llm = o.llm ?? null;
  let owned = false;
  if (!llm) {
    try {
      detectBackend({ ...(o.model ? { model: o.model } : {}) });
      llm = Llm.open({
        model: o.model ?? ASK_MODEL,
        ...(o.budget ? { budget: o.budget } : {}),
      });
      owned = true;
    } catch {
      // NoBackendError, ReentrancyError, or a transport that would not build.
      return unconfirmed(cands, NO_MODEL_NOTE);
    }
  }

  const verdicts = new Map<number, RawVerdict>();
  try {
    for (let start = 0; start < cands.length; start += CONFIRM_BATCH) {
      const batch = cands.slice(start, start + CONFIRM_BATCH);
      const r = await llm.json<{ results: RawVerdict[] }>({
        prompt: promptFor(batch),
        system: CONFIRM_SYSTEM,
        schema: CONFIRM_SCHEMA,
        fallback: { results: [] },
        validate: validateVerdicts,
        label: `open threads ${start + 1}–${start + batch.length}`,
        ...(o.signal ? { signal: o.signal } : {}),
      });
      for (const v of r.value.results) {
        // A verdict for a candidate we did not send is not a verdict.
        if (v.i < 0 || v.i >= batch.length) continue;
        verdicts.set(start + v.i, v);
      }
    }
  } catch (err) {
    return unconfirmed(cands, `the model pass did not run (${errText(err)}); unconfirmed.`);
  } finally {
    if (owned) {
      try {
        await llm.close();
      } catch {
        /* closing a transport is not a reason to lose the verdicts */
      }
    }
  }

  return cands.map((c, i) => {
    const v = verdicts.get(i);
    if (!v) return { ...c, confirmed: false, note: 'the model returned no verdict for this one.' };
    // The guard, in code. A decision the card cannot cite is not confirmable
    // however confidently the model confirmed it.
    if (v.confirmed && c.evidenceSeqs.length === 0) {
      return {
        ...c,
        confirmed: false,
        note: 'dropped: the decision carries no evidence_seq, so the claim cannot be checked.',
      };
    }
    if (v.confirmed && !v.note) {
      return { ...c, confirmed: false, note: 'the model confirmed without giving a reason.' };
    }
    return { ...c, confirmed: v.confirmed, note: v.note };
  });
}

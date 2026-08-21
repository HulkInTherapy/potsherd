/**
 * T4.2 — open threads: "decided in A, never seen in B".
 *
 * This file's **types are pinned by the orchestrator before the phase-4 wave**
 * so that `ask.ts` (T4.1) and this module (T4.2) can be written in parallel
 * worktrees against one contract. T4.2 owns every implementation in here; T4.1
 * imports the types and calls `openThreadCandidates` / `confirmOpenThreads`
 * and owns none of it.
 *
 * The output is **advisory and labelled**, never stated as fact
 * (`plans/phases/phase-4-ask-and-graft.md` T4.2).
 */
import type { Db } from './db.js';
import type { Budget, Llm } from './llm.js';

/** `05`: the phrase the renderer must use. Never "open thread" as a bare fact. */
export const OPEN_THREAD_LABEL = 'possible open thread';

/** A decision in session A whose topics/files overlap a *different* project's sessions,
 *  where no matching decision appears. Produced by the rule pass, with no model call. */
export interface OpenThreadCandidate {
  /** the decision's `what`, verbatim from the card */
  what: string;
  /** the decision's `why`, verbatim from the card, or '' */
  why: string;
  /** where it was decided */
  sessionId: string;
  id8: string;
  project: string;
  ts: string;
  /** the card seq the decision cited, so the claim stays checkable */
  evidenceSeq: number | null;
  /** the project it was never seen in */
  otherProject: string;
  /** that project's sessions that share the files/topics */
  otherSessionIds: readonly string[];
  overlap: { files: readonly string[]; topics: readonly string[] };
  /** higher = more overlap and less counter-evidence; the rule pass's own ordering */
  score: number;
}

/** A candidate after the model pass. `confirmed:false` candidates are dropped by the caller. */
export interface OpenThread extends OpenThreadCandidate {
  confirmed: boolean;
  /** one sentence from the model saying why it confirmed or rejected */
  note: string;
}

export interface CandidateOptions {
  /** how many candidates to return, best-scoring first. Default 8. */
  limit?: number;
}

export interface ConfirmOptions {
  llm?: Llm;
  model?: string;
  budget?: Budget;
  signal?: AbortSignal;
}

/** Rule pass. No model, no network. T4.2 implements. */
export function openThreadCandidates(
  _db: Db,
  _sessionIds: readonly string[],
  _o: CandidateOptions = {},
): OpenThreadCandidate[] {
  throw new Error('open-threads: not implemented (T4.2 owns this body)');
}

/** Model pass — confirms or rejects each candidate in one sentence. T4.2 implements. */
export async function confirmOpenThreads(
  _cands: readonly OpenThreadCandidate[],
  _o: ConfirmOptions = {},
): Promise<OpenThread[]> {
  throw new Error('open-threads: not implemented (T4.2 owns this body)');
}

import type { CardClaim, ExtractedCard } from './schema.js';
import type { TranscriptUnit } from './transcript.js';
import type { Embedder } from './vectors.js';
import { cosine, rankedWindows } from './vectors.js';

/**
 * Step 4 of `03` §6: **verify** — the hallucination filter, and the reason
 * potsherd is allowed to say a card is checkable.
 *
 * `research/memory-research.md` §1 names ProMem's second failure mode:
 * *one-off hallucination*, a mistake made at extraction time that is permanent
 * because nothing ever re-reads the source. Every downstream reader — `find`,
 * `ask`, a person scanning `ls` — then treats it as something that happened.
 *
 * The fix is not a better prompt. It is to go back to the transcript:
 *
 *   1. **Resolve.** Every `evidence_seq` is looked up in the transcript. Seqs
 *      that do not exist are struck from the claim; a claim left with no
 *      surviving citation is dropped. This is what makes *"100% of
 *      `decisions[].evidence_seq` resolve to exchanges that exist"* an
 *      invariant of the written card rather than a hope about the model.
 *   2. **Match.** The claim is compared against **windows** of each cited
 *      exchange, and kept only if some window scores at least
 *      {@link EVIDENCE_COSINE}. Windows, not the whole exchange: a 12 kB
 *      exchange averaged into one vector is *about* the exchange, and the one
 *      sentence in it that states the decision is a few percent of that
 *      average. The question here is containment.
 *
 * **No model runs.** That is the point and it is not an optimisation. A model
 * asked "does this transcript support this claim?" is the same machinery that
 * produced the claim, with the same priors and the same willingness to be
 * agreeable; ProMem's verification loop answers *only from the source*, and
 * the cheapest honest way to do that over a fixed seq lookup is arithmetic.
 * It also means the filter costs no tokens, cannot be prompt-injected by the
 * transcript it is checking, and gives the same answer twice.
 *
 * What survives is written to the card with `verified: {kept, dropped}`, and a
 * run where `dropped` is zero everywhere is a bug report about this file, not
 * a compliment to the extractor.
 */

/** `phase-2` T2.2 §4: below this against every cited exchange, the claim goes. */
export const EVIDENCE_COSINE = 0.5;

/** Window size for the containment comparison, in characters. */
export const EVIDENCE_WINDOW_CHARS = 1_800;

/** Windows per cited exchange. Evidence is evidence in the first few. */
export const EVIDENCE_WINDOWS = 4;

export type DropReason =
  /** The model asserted something and cited nothing. */
  | 'no-citation'
  /** Every seq it cited is absent from this transcript. */
  | 'unresolved-seq'
  /** The cited exchanges exist and do not contain the claim. */
  | 'no-match';

export interface DroppedClaim {
  kind: 'decision' | 'open_thread';
  what: string;
  reason: DropReason;
  /** Seqs as cited. */
  cited: number[];
  /** Seqs that existed. */
  resolved: number[];
  /** Best cosine achieved against any window of any cited exchange. */
  best: number;
}

export interface VerifyTotals {
  kept: number;
  dropped: number;
}

export interface VerifyResult {
  card: ExtractedCard;
  verified: VerifyTotals;
  drops: DroppedClaim[];
  /** Best score for every claim examined, kept or not. For calibration. */
  scores: number[];
}

export interface VerifyOptions {
  cosine?: number;
  windowChars?: number;
  maxWindows?: number;
}

export async function verifyCard(
  card: ExtractedCard,
  units: readonly TranscriptUnit[],
  embed: Embedder,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const threshold = options.cosine ?? EVIDENCE_COSINE;
  const bySeq = new Map<number, TranscriptUnit>();
  for (const u of units) bySeq.set(u.seq, u);

  const drops: DroppedClaim[] = [];
  const scores: number[] = [];
  let kept = 0;

  const check = async (
    claim: CardClaim,
    kind: 'decision' | 'open_thread',
  ): Promise<CardClaim | null> => {
    const cited = claim.evidence_seq;
    const resolved = cited.filter((s) => bySeq.has(s));

    if (cited.length === 0) {
      drops.push({ kind, what: claim.what, reason: 'no-citation', cited, resolved, best: 0 });
      return null;
    }
    if (resolved.length === 0) {
      drops.push({ kind, what: claim.what, reason: 'unresolved-seq', cited, resolved, best: 0 });
      return null;
    }

    const probe = await embed(claim.what);
    let best = -1;
    const supporting: number[] = [];
    for (const seq of resolved) {
      const unit = bySeq.get(seq)!;
      let top = -1;
      for (const w of rankedWindows(
        unit.text,
        claim.what,
        options.windowChars ?? EVIDENCE_WINDOW_CHARS,
        options.maxWindows ?? EVIDENCE_WINDOWS,
      )) {
        const c = cosine(probe, await embed(w));
        if (c > top) top = c;
      }
      if (top > best) best = top;
      if (top >= threshold) supporting.push(seq);
    }
    scores.push(best);

    if (supporting.length === 0) {
      drops.push({ kind, what: claim.what, reason: 'no-match', cited, resolved, best });
      return null;
    }

    kept += 1;
    // The kept claim carries only the citations that actually stood up. A
    // reader following `evidence_seq` from the card must land on an exchange
    // that exists *and* says something about the claim, every time.
    return { ...claim, evidence_seq: supporting };
  };

  const decisions: CardClaim[] = [];
  for (const d of card.decisions) {
    const ok = await check(d, 'decision');
    if (ok) decisions.push(ok);
  }
  const threads: CardClaim[] = [];
  for (const o of card.open_threads) {
    const ok = await check(o, 'open_thread');
    if (ok) threads.push(ok);
  }

  return {
    card: { ...card, decisions, open_threads: threads },
    verified: { kept, dropped: drops.length },
    drops,
    scores,
  };
}

/**
 * The assertion the acceptance criterion names, as a function.
 *
 * Exported because it is checked in two places that must agree: a unit test on
 * a synthetic card, and `card --all --json` over the real run. A card that
 * fails this has no business being written.
 */
export function unresolvedEvidence(
  card: Pick<ExtractedCard, 'decisions' | 'open_threads'>,
  units: readonly TranscriptUnit[],
): { claim: string; seq: number }[] {
  const have = new Set(units.map((u) => u.seq));
  const bad: { claim: string; seq: number }[] = [];
  for (const claim of [...card.decisions, ...card.open_threads]) {
    for (const seq of claim.evidence_seq) {
      if (!have.has(seq)) bad.push({ claim: claim.what, seq });
    }
  }
  return bad;
}

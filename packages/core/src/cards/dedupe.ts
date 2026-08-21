import type { CardClaim, ExtractedCard } from './schema.js';
import type { Embedder } from './vectors.js';
import { cosine } from './vectors.js';

/**
 * Step 5 of `03` §6: **dedupe** items at cosine ≥ {@link DEDUPE_COSINE},
 * keeping the verified version.
 *
 * Duplicates are not a cosmetic problem here; they are a *ranking* problem
 * downstream. `cards_fts` indexes `decisions` as one text column, so a card
 * that says the same thing three times — once from the first pass, once from
 * the supplement, once from the reduce over four chunks — scores three times
 * as high for those words in `find`, and the session with the most repetitive
 * extraction wins searches it should not.
 *
 * Order matters and it is the spec's order: this runs **after** `verify.ts`.
 * Every claim that reaches here has already been checked against the
 * transcript, so "keep the verified version" is a tie-break among survivors:
 * the one with the most surviving citations wins, because it is the one a
 * reader can most easily check. Deduping first would let an unsupported phrasing
 * absorb a supported one and then be dropped, losing both.
 */

/** `03` §6. */
export const DEDUPE_COSINE = 0.8;

export interface DedupeReport {
  /** Items removed as near-duplicates, across every list. */
  removed: number;
  removedTexts: string[];
}

export interface DedupeResult {
  card: ExtractedCard;
  report: DedupeReport;
}

/**
 * Which of two equivalent claims to keep.
 *
 * More surviving evidence first — a claim a reader can check in three places
 * beats the same claim citable in one. Then the one that gives a reason. Then
 * the shorter text, on the same principle as `recall.ts`'s title tie-break:
 * among equals, the one that says least else.
 */
function betterClaim(a: CardClaim, b: CardClaim): CardClaim {
  if (a.evidence_seq.length !== b.evidence_seq.length) {
    return a.evidence_seq.length > b.evidence_seq.length ? a : b;
  }
  const aWhy = (a.why ?? '').trim().length;
  const bWhy = (b.why ?? '').trim().length;
  if (aWhy > 0 !== bWhy > 0) return aWhy > 0 ? a : b;
  return a.what.length <= b.what.length ? a : b;
}

async function dedupeClaims(
  claims: readonly CardClaim[],
  embed: Embedder,
  threshold: number,
  removed: string[],
): Promise<CardClaim[]> {
  const kept: { claim: CardClaim; vector: number[] }[] = [];
  for (const claim of claims) {
    const vector = await embed(claim.what);
    let merged = false;
    for (const slot of kept) {
      if (cosine(vector, slot.vector) < threshold) continue;
      const winner = betterClaim(slot.claim, claim);
      const loser = winner === slot.claim ? claim : slot.claim;
      removed.push(loser.what);
      // The union of citations: two phrasings of one decision were each
      // supported by their own exchanges and the surviving claim should carry
      // both, not lose half its evidence to a tie-break.
      slot.claim = {
        ...winner,
        evidence_seq: [...new Set([...winner.evidence_seq, ...loser.evidence_seq])].sort(
          (x, y) => x - y,
        ),
      };
      merged = true;
      break;
    }
    if (!merged) kept.push({ claim, vector });
  }
  return kept.map((s) => s.claim);
}

async function dedupeStrings(
  items: readonly string[],
  embed: Embedder,
  threshold: number,
  removed: string[],
): Promise<string[]> {
  const kept: { text: string; vector: number[] }[] = [];
  for (const item of items) {
    if (!item.trim()) continue;
    const vector = await embed(item);
    const twin = kept.find((s) => cosine(vector, s.vector) >= threshold);
    if (twin) {
      removed.push(item);
      // Among equivalent topics, the shorter label: "pgbouncer" over
      // "pgbouncer connection pooling configuration".
      if (item.length < twin.text.length) twin.text = item;
      continue;
    }
    kept.push({ text: item, vector });
  }
  return kept.map((s) => s.text);
}

export async function dedupeCard(
  card: ExtractedCard,
  embed: Embedder,
  threshold = DEDUPE_COSINE,
): Promise<DedupeResult> {
  const removedTexts: string[] = [];
  const decisions = await dedupeClaims(card.decisions, embed, threshold, removedTexts);
  const open_threads = await dedupeClaims(card.open_threads, embed, threshold, removedTexts);
  const topics = await dedupeStrings(card.topics, embed, threshold, removedTexts);
  // Paths are compared as strings, never as vectors: `src/db.ts` and
  // `src/api.ts` are ~0.9 apart in embedding space and are not the same file.
  const files = [...new Set(card.files.map((f) => f.trim()).filter(Boolean))];

  return {
    card: { ...card, decisions, open_threads, topics, files },
    report: { removed: removedTexts.length, removedTexts },
  };
}

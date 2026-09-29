import type { ExtractedCard } from './schema.js';
import { MAX_CLAIMS, MAX_FILES, MAX_TAGS, MAX_TOPICS } from './schema.js';
import type { TranscriptUnit } from './transcript.js';
import type { Embedder } from './vectors.js';
import { bestMatch } from './vectors.js';

/**
 * Step 3 of `03` §6: **coverage** — the answer to ProMem's *ahead-of-time
 * bias*.
 *
 * `research/memory-research.md` §1: a one-shot summary is written before you
 * know what you will need from it, so the small-but-important detail is the
 * one that gets dropped. Coverage measures that directly instead of hoping.
 * Embed every exchange and every extracted item; an exchange whose best item
 * is below cosine {@link COVERAGE_COSINE} is *uncovered* — the card says
 * nothing about that part of the conversation. When more than
 * {@link UNCOVERED_FRACTION} of the session is uncovered, one supplement call
 * runs over **only the uncovered exchanges** and its findings are merged in.
 *
 * One call, not a loop. The pipeline's budget is 2–3 cheap calls per session
 * (`memory-research.md` §1) and a re-extraction loop that runs until coverage
 * is satisfied has no upper bound on either cost or time. A card that covers
 * 80% of a session and says so beats a card that cost four calls.
 */

/** `03` §6: below this, the exchange is not represented in the card. */
export const COVERAGE_COSINE = 0.6;

/** `phase-2` T2.2 §3: more uncovered than this and one supplement call runs. */
export const UNCOVERED_FRACTION = 0.25;

export interface CoverageReport {
  total: number;
  covered: number;
  /** Seq numbers of the exchanges no item speaks for. */
  uncovered: number[];
  /** `uncovered / total`, 0 when there is nothing to cover. */
  fraction: number;
  /** Whether that crossed {@link UNCOVERED_FRACTION}. */
  needsSupplement: boolean;
  /** Best cosine per unit, in unit order. For diagnosing a bad threshold. */
  best: number[];
}

/**
 * The strings a card *says*, as things a transcript can be compared against.
 *
 * `files` is deliberately absent: a repo-relative path is not prose and
 * embedding one produces a vector that matches every other path in the repo,
 * which would mark half a session covered on the strength of a shared
 * directory name.
 */
export function cardItems(card: ExtractedCard): string[] {
  const items: string[] = [];
  if (card.title.trim()) items.push(card.title.trim());
  if (card.summary.trim()) items.push(card.summary.trim());
  for (const t of card.topics) if (t.trim()) items.push(t.trim());
  for (const d of card.decisions) {
    const text = d.why ? `${d.what} — ${d.why}` : d.what;
    if (text.trim()) items.push(text.trim());
  }
  for (const o of card.open_threads) if (o.what.trim()) items.push(o.what.trim());
  return [...new Set(items)];
}

export async function measureCoverage(
  units: readonly TranscriptUnit[],
  card: ExtractedCard,
  embed: Embedder,
): Promise<CoverageReport> {
  const live = units.filter((u) => u.text.trim().length > 0);
  const items = cardItems(card);
  if (live.length === 0) {
    return { total: 0, covered: 0, uncovered: [], fraction: 0, needsSupplement: false, best: [] };
  }
  if (items.length === 0) {
    // A card that says nothing covers nothing. Worth a supplement call if the
    // session is long enough to have anything in it.
    return {
      total: live.length,
      covered: 0,
      uncovered: live.map((u) => u.seq),
      fraction: 1,
      needsSupplement: true,
      best: live.map(() => 0),
    };
  }

  const itemVectors = await Promise.all(items.map((i) => embed(i)));
  const best: number[] = [];
  const uncovered: number[] = [];
  for (const unit of live) {
    const vector = unit.embedding ?? (await embed(unit.text));
    const top = bestMatch(vector, itemVectors).score;
    best.push(top);
    if (top < COVERAGE_COSINE) uncovered.push(unit.seq);
  }

  const fraction = uncovered.length / live.length;
  return {
    total: live.length,
    covered: live.length - uncovered.length,
    uncovered,
    fraction,
    needsSupplement: fraction > UNCOVERED_FRACTION,
    best,
  };
}

/**
 * Fold a supplement's findings into the card.
 *
 * The supplement is asked only for what the first pass *missed*, so the base
 * card's title, summary and outcome win: they were written with the whole
 * session in view and the supplement saw a handful of exchanges. Only the
 * lists grow, and the ceilings still apply — a supplement that returns nine
 * new topics does not get to make a nine-topic card.
 *
 * The merged claims are not verified yet, and that is the correct order:
 * `verify.ts` runs after this and treats a supplement's decision exactly as
 * sceptically as the first pass's.
 */
export function mergeSupplement(base: ExtractedCard, extra: ExtractedCard): ExtractedCard {
  const seen = (list: readonly string[]): Set<string> =>
    new Set(list.map((s) => s.toLowerCase().trim()));

  const topics = [...base.topics];
  const topicSeen = seen(topics);
  for (const t of extra.topics) {
    if (topics.length >= MAX_TOPICS) break;
    if (topicSeen.has(t.toLowerCase().trim())) continue;
    topicSeen.add(t.toLowerCase().trim());
    topics.push(t);
  }

  const files = [...base.files];
  const fileSeen = seen(files);
  for (const f of extra.files) {
    if (files.length >= MAX_FILES) break;
    if (fileSeen.has(f.toLowerCase().trim())) continue;
    fileSeen.add(f.toLowerCase().trim());
    files.push(f);
  }

  const tags = [...base.tags];
  const tagSeen = seen(tags);
  for (const t of extra.tags) {
    if (tags.length >= MAX_TAGS) break;
    if (tagSeen.has(t.toLowerCase().trim())) continue;
    tagSeen.add(t.toLowerCase().trim());
    tags.push(t);
  }

  // The claim lists are deliberately *not* clamped here. `verify.ts` runs next
  // and will drop some of them; capping to eight before the filter has run
  // would let an unsupported claim from the first pass evict a supported one
  // from the supplement. The pipeline clamps once, at the end.
  return {
    title: base.title || extra.title,
    summary: base.summary || extra.summary,
    topics,
    decisions: [...base.decisions, ...extra.decisions].slice(0, MAX_CLAIMS * 3),
    files,
    outcome: base.outcome !== 'unknown' ? base.outcome : extra.outcome,
    open_threads: [...base.open_threads, ...extra.open_threads].slice(0, MAX_CLAIMS * 3),
    tags,
  };
}

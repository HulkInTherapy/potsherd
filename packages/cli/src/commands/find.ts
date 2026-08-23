import { recall, renderFind, search as searchNs, type RecallOptions } from '@potsherd/core';
import {
  federate,
  federationLine,
  queryAgentMemory,
  queryClaudeMem,
  queryNotes,
  type BridgeList,
} from '@potsherd/bridges';
import { print, printJson, themeFrom, UserError, type GlobalOptions } from '../output.js';
import { openIndex, parseFilters, parseLimit, type FilterFlags } from '../filters.js';

/**
 * `strong | weak | none`, derived from the option it is passed to rather than
 * spelled out again here.
 *
 * `@potsherd/core` does not yet re-export the `Confidence` union from its
 * barrel — `packages/core/src/index.ts` is another worker's file this task may
 * not edit — and a second hand-written copy of the three words is exactly the
 * kind of duplicate that survives one of them being renamed. Reading the type
 * off `RecallOptions` cannot drift: if the union changes, this stops
 * compiling. Replace with a direct import when the barrel carries it.
 */
type Confidence = NonNullable<RecallOptions['minConfidence']>;

export interface FindCommandOptions extends GlobalOptions, FilterFlags {
  query: string;
  limit?: unknown;
  /** `--no-vec`. */
  vec?: boolean;
  /** `--vectors auto|on|off`. */
  vectors?: string;
  /** `--explain` — print the fusion arithmetic instead of the snippets. */
  explain?: boolean;
  /** Comma-separated bridge names from `--with`. */
  with?: string;
  /**
   * `--all`: show the projects the ignore list hides.
   *
   * Deliberately **not** part of the shared `addFilters` registration, though
   * every other flag on this verb is. `potsherd card --all` already exists and
   * means "every session in the index"; a single `--all` registered across the
   * shared block would have put two meanings on one word. So `ls`, `find` and
   * `stats` each declare it, with the same description and the same effect,
   * and nothing else does.
   *
   * It overrides the ignore list and only the ignore list: every other filter
   * still applies.
   */
  all?: boolean;
  /**
   * `--min-confidence strong|weak|none` — the floor, and the escape hatch.
   *
   * `weak` by default, which is the whole of F1: a block whose calibration
   * says the archive does not answer the question is withheld rather than
   * ranked. `none` shows everything the ranker found, including the rows the
   * floor exists to hide.
   *
   * It is off by default and it is spelled as a *level* rather than as a
   * `--show-everything` switch, because the two readers of this verb want
   * opposite things and only one of them can say so. A human's "show me
   * anything, I will judge" is legitimate — they glance at the titles and know
   * — and typing the flag is exactly that judgement being exercised. An
   * agent's is not: an unlabelled least-bad row is indistinguishable from an
   * answer, and the audit that started this task is a transcript of an agent
   * acting on ten of them. So the default protects the caller who cannot tell,
   * and the flag serves the caller who can.
   *
   * `strong` is the third value and it is not decoration: it is what a script
   * that wants "answer or nothing" should pass, and it makes `find q ||
   * fallback` mean what it looks like it means.
   */
  minConfidence?: string;
  /**
   * `--no-cards` — search transcripts only.
   *
   * Commander spells a negatable flag as `cards: boolean`, default `true`, so
   * **off by default** here reads as `cards !== false`. That is the F6 ruling
   * exactly: cards are *demoted*, not switched off, because a card is often
   * the only list that can find a conversation whose transcript never uses the
   * words the user typed. The flag is for the caller who has decided that even
   * a labelled, last-on-the-page summary is more than they want.
   *
   * Registering it is only half the job. `packages/cli/src/index.ts` enumerates
   * every flag it forwards into `runFind`, so an option that is declared and
   * not listed there is accepted on the command line and silently dropped
   * before it reaches `recall()`. See `T10.7-REPORT.md`.
   */
  cards?: boolean;
}

/**
 * `potsherd find` — the verb the index exists for.
 *
 * Sidechains and ghosts are both in by default (`03` §7). That is one line of
 * configuration and the whole differentiator: on the reference machine it is
 * the difference between searching 30 sessions and searching 30 sessions, 197
 * subagent transcripts and 299 conversations Claude Code already deleted.
 *
 * Vectors are used when they exist and skipped, with a printed reason, when
 * they do not — `--no-embed`, no sqlite-vec, no model. A `find` that errored
 * because a native extension was missing would be a `find` that does not work
 * on an aeroplane, and text search alone is genuinely good.
 */
export async function runFind(o: FindCommandOptions): Promise<number> {
  const query = o.query?.trim();
  if (!query) {
    throw new UserError('find needs something to look for', 'potsherd find "pgbouncer"');
  }

  const { db, root } = openIndex(o);
  try {
    const filters = parseFilters(db, o);
    const limit = parseLimit(o.limit, 10);
    const result = await recall(db, query, filters, {
      limit,
      root,
      vectors: vectorMode(o),
      // `--all` searches the projects the ignore list hides. Same flag, same
      // meaning as `ls --all` and `stats --all`; `find --project X` also
      // overrides the list, because naming a project is asking for it.
      all: Boolean(o.all),
      // The floor is set here and not inside `recall()`. `recall()` is also
      // the shortlist builder for `ask` and `graft`, which hand their rows to
      // a *reader* that can see for itself that a row is noise; `find` hands
      // its rows to whoever typed the query. One number, set by the caller who
      // knows who is reading. See `RecallOptions.minConfidence`.
      minConfidence: minConfidence(o),
      // F6. `undefined` and `true` both mean "cards on"; only an explicit
      // `--no-cards` takes the two card lists out of the fusion.
      cards: o.cards !== false,
    });

    // `--with` federates other memory tools' hits alongside ours. `federate()`
    // never mutates the local result — `federated.hits` and `.sessions` are
    // exactly what `recall()` returned — so a caller that ignores the two new
    // fields sees precisely what `find` has always produced. An absent bridge
    // contributes a line and no hits: it cannot change the local ranking and
    // cannot throw.
    //
    // T6.6 D10 — and it cannot slow the verb past **the slowest bridge asked
    // for**, which is not what this code did and not what this comment said.
    //
    // The three were awaited one after another. Each bridge has its own
    // ceiling — claude-mem's `WORKER_TIMEOUT_MS` is 1500 ms, agentmemory's
    // `AGENTMEMORY_TIMEOUT_MS` is 5000 ms — so the old claim ("cannot slow
    // `find` past its ceiling") was true of each bridge and false of the verb,
    // which spent the sum. Measured on 2026-08-22 against two endpoints that
    // are alive and never answer (a TCP server that accepts and writes
    // nothing on claude-mem's worker port; an MCP server that reads stdin
    // forever):
    //
    //     in series    6,525 ms
    //     concurrent   5,005 ms
    //
    // So: `Promise.all`, and the true worst case is stated rather than
    // implied. It is the **maximum** of the ceilings of the bridges named in
    // `--with`, plus the local query — about 5 s if agentmemory is one of
    // them, about 1.5 s if claude-mem is the slowest, and unchanged from the
    // local number for `notes`, which reads files synchronously.
    //
    // `03` §12's `find p50 < 150 ms` is about the local query. A verb that
    // federates to a tool that is not answering cannot meet it and is not
    // asked to; what it can promise is that it costs one bridge's patience
    // and not three.
    const wanted = (o.with ?? '')
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    // Started together, collected in the order the footer prints them.
    const pending: Promise<BridgeList>[] = [];
    if (wanted.includes('claude-mem')) pending.push(queryClaudeMem(query, { limit: 20 }));
    if (wanted.includes('agentmemory')) pending.push(queryAgentMemory(query, { limit: 20 }));
    if (wanted.includes('notes')) {
      pending.push(
        Promise.resolve(
          queryNotes(query, { limit: 20, ...(o.claudeDir ? { claudeDir: o.claudeDir } : {}) }),
        ),
      );
    }
    const lists: BridgeList[] = await Promise.all(pending);
    const federated = lists.length > 0 ? federate(result, lists) : null;

    if (o.json) {
      printJson({
        query: result.query,
        filters,
        ...(federated ? { bridges: federated.bridges, external: federated.external } : {}),
        // The same ledger the human view prints, so a script and a person are
        // reading one number. `--explain --json` is how the eval harness will
        // ask why a query lost without parsing a terminal layout.
        ...(o.explain ? { explain: searchNs.explain(result) } : {}),
        // The three F1 fields, on the envelope. Identical vocabulary and
        // identical values to the human view — `tests/recall.test.ts` pins
        // that the two agree, because an agent that has to reconcile two
        // spellings of "did you find it" will trust neither.
        confidence: result.confidence,
        minConfidence: result.minConfidence,
        withheld: result.belowFloor,
        // F6, on the envelope: whether the card lists ran at all, and how much
        // of this page is routing rather than evidence. A caller that wants
        // transcripts only can assert `routing === 0` without walking the
        // sessions, and a caller that passed `--no-cards` can confirm it took.
        cards: o.cards !== false,
        routing: result.sessions.filter((s) => s.lane === 'routing').length,
        vectors: result.vectors,
        ignored: result.ignored,
        lists: result.lists,
        relaxed: result.relaxed,
        ms: result.ms,
        sessions: result.sessions.map((s) => ({
          id: s.id,
          kind: s.kind,
          harness: s.harness,
          title: s.title,
          displayTitle: s.displayTitle,
          project: s.project,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          status: s.status,
          isSidechain: s.isSidechain,
          parentSessionId: s.parentSessionId,
          agentName: s.agentName,
          gitBranch: s.gitBranch,
          pinned: s.pinned,
          prompts: s.prompts,
          exchanges: s.exchanges,
          resume: s.resume,
          score: s.score,
          confidence: s.confidence,
          // F6 — `"routing"` when nothing in this block is transcript text:
          // the only thing that matched was a card, which is the artefact of a
          // model call. A routing block sorts below every evidence block
          // whatever the scores say, its confidence is capped at `weak`, and
          // it must not appear in a `SOURCES` line. One word, on the row, so a
          // caller filters on data and never on the sentence the human view
          // prints.
          lane: s.lane ?? 'evidence',
          citable: (s.lane ?? 'evidence') === 'evidence',
          // 0..1, and **not** `score` rescaled. `score` is reciprocal rank
          // fusion — a function of rank alone, which is why a true topic and a
          // topic the archive has never heard of come out 1.12x apart.
          // `calibrated` is computed from the evidence RRF discards: how many
          // of the query's distinctive words this conversation can actually
          // show (`coverage`), each list's own bm25/cosine magnitude relative
          // to that list's best for this query (`strength`), and how many
          // lists independently found it (`agreement`). Coverage multiplies
          // the other two, so it is a ceiling: nothing can lift a row whose
          // words are not there. See `packages/core/src/calibration.ts`.
          calibrated: s.calibration.score,
          // The cap that produced `confidence`, when one applied. A card-only
          // block routinely calibrates above `STRONG_FLOOR` — its coverage is
          // measured over a summary that paraphrased the question — and this
          // is the field that says the label was refused rather than earned.
          ceiling: s.calibration.ceiling ?? null,
          coverage: s.calibration.coverage,
          strength: s.calibration.strength,
          agreement: s.calibration.agreement,
          hits: s.hits.map((h) => ({
            kind: h.kind,
            // A block is a *conversation*, and a conversation can hold the
            // parent and its subagents. Without the id of the session each hit
            // came from, a `--json` consumer cannot tell a subagent's match
            // from one of the parent's own exchanges — a distinction the human
            // view makes and the API is supposed to carry.
            sessionId: h.sessionId,
            isSidechain: h.isSidechain,
            id: h.id ?? null,
            seq: h.seq ?? null,
            ts: h.ts ?? null,
            score: h.score,
            confidence: h.confidence,
            /** F6 — `"routing"` for a card, `"evidence"` for transcript text. */
            lane: h.lane ?? 'evidence',
            calibrated: h.calibration.score,
            // The cap that produced `confidence`, when one applied — so a
            // caller reading `calibrated: 0.925` beside `confidence: "weak"`
            // is told why rather than left to conclude the two disagree.
            ceiling: h.calibration.ceiling ?? null,
            from: h.from,
            snippet: h.snippet.text,
            match: h.snippet.match ?? null,
          })),
        })),
      });
      return result.sessions.length ? 0 : 1;
    }

    const t = themeFrom(o);
    print(renderFind(result, t, new Date(), { explain: Boolean(o.explain) }));
    if (federated) {
      // T6.6 D8 — this line was printed at whatever length it came out, and
      // came out at 84 characters under `--width 80` while every other line on
      // the screen fitted. Wrapped rather than clipped, for the reason
      // `doctor --privacy` wraps its verb list: the whole value of the line is
      // that a reader finds *their* bridge in it, and a list with the answer
      // cut off the end is not one.
      // Wrapped on the separator, not on spaces: `fmt.wrap` collapses the
      // `  ·  ` between bridges to a single space, and that gap is what keeps
      // three sentences readable as three answers.
      for (const line of wrapOnSeparator(federationLine(federated.bridges), Math.max(20, t.width - 2))) {
        print(`  ${t.dim(line)}`);
      }
    }
    // Exit 1 on no match, so `potsherd find x || echo none` works in a script.
    return result.sessions.length ? 0 : 1;
  } finally {
    db.close();
  }
}

/**
 * `weak` by default: the floor is on, and `--min-confidence none` turns it off.
 *
 * An unrecognised value is a typo, and a typo that silently means `none` would
 * turn the floor off on the one command line that was trying to raise it. The
 * option is registered with `.choices([...])` so commander refuses it first;
 * this is the second wall, for the callers that reach `runFind` directly.
 */
export function minConfidence(o: FindCommandOptions): Confidence {
  switch (o.minConfidence) {
    case 'none':
      return 'none';
    case 'strong':
      return 'strong';
    default:
      return 'weak';
  }
}

/**
 * `auto` by default: bm25 answers, and the embedding model is only woken when
 * the words did not match. See `RecallOptions.vectors` for why — it is the
 * difference between a 130 ms verb and a 490 ms one, and `03` §12 asks for 150.
 */
function vectorMode(o: FindCommandOptions): boolean | 'auto' {
  if (o.vec === false) return false;
  switch (o.vectors) {
    case 'on':
      return true;
    case 'off':
      return false;
    default:
      return 'auto';
  }
}

/**
 * Break the federation footer into terminal-width lines, on the `  ·  ` that
 * separates one bridge's answer from the next.
 *
 * T6.6 D8. The line used to be printed whole, at whatever length it came out —
 * 84 characters under `--width 80`, on a screen where every other line fitted.
 * A bridge's own sentence is never broken, so a reader always sees a whole
 * answer or none of it; a single sentence longer than the width is still
 * emitted on its own line rather than being cut.
 */
export function wrapOnSeparator(line: string, width: number, sep = '  \u00b7  '): string[] {
  if (!line) return [];
  const parts = line.split(sep);
  const out: string[] = [];
  let current = '';
  for (const part of parts) {
    if (!current) {
      current = part;
      continue;
    }
    if ([...`${current}${sep}${part}`].length <= width) {
      current = `${current}${sep}${part}`;
    } else {
      out.push(current);
      current = part;
    }
  }
  if (current) out.push(current);
  return out;
}

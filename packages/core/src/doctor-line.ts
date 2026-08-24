import { ACQUIRE_BYTES, acquisitionPlan, isEmbeddingReady } from './embeddings.js';
import { tildify } from './paths.js';

/**
 * The `vectors` line, computed once and rendered once.
 *
 * ## why this file exists
 *
 * The agent audit (§2 F2) caught potsherd contradicting itself in print:
 *
 * > `doctor` reports `vectors —` on one line while `index` reports
 * > `vectors 1,561` on another; the two subsystems disagree in print.
 *
 * They disagreed because they were two different sentences computed from two
 * different places. `index` rendered its row from the {@link IndexReport} the
 * run had just produced — what *this pass* did — while `doctor` rendered its
 * row from a `COUNT(*)` guarded by whether a native extension had loaded into
 * that particular connection. On a machine where the extension was absent the
 * count was reported as `—` even though the vectors were on disk, and on a
 * machine where a previous run had embedded, `index` printed a count for a
 * pass that had embedded nothing.
 *
 * So there is now exactly one function that answers "what is the state of
 * semantic search on this machine", one that turns that answer into a value
 * and a note, and three callers: `index`, `doctor`, and — through
 * `vec.vecStatus` — `find`'s warming line. A test pins their agreement.
 *
 * ## the second defect this closes
 *
 * `plans/04` logged the `doctor` vectors line as **truncated**: it was clipped
 * to a fixed width computed from a note that had already been built, so on a
 * narrow terminal the reason a user most needed — *why* there are no vectors —
 * was the part that got cut. {@link vectorNote} builds the note from parts and
 * lets the renderer drop whole parts from the right, so the first clause, the
 * one that says what is true, always survives.
 */

/** What the vectors line is reporting. Four states, four different sentences. */
export type VectorPhase =
  /** Vectors cover every exchange in the index. */
  | 'ready'
  /** Some vectors, some pending: the background pass has not caught up yet. */
  | 'warming'
  /** Nothing embedded yet and nothing stopping it — first `index` on this box. */
  | 'pending'
  /** Embedding cannot proceed here, and `reason` says why. */
  | 'unavailable'
  /** There is nothing to embed: an empty index. */
  | 'empty';

export interface VectorReport {
  phase: VectorPhase;
  /** Exchanges (and recovered prompts) that carry a current vector. */
  embedded: number;
  /** Exchanges (and recovered prompts) still waiting for one. */
  pending: number;
  /** `embedded + pending`. The denominator in `N of M embedded`. */
  total: number;
  /** True when the runtime and weights are on disk and nothing must be fetched. */
  runtimeReady: boolean;
  /** Bytes the first run still has to fetch. Zero once acquired. */
  acquireBytes: number;
  /** Which runtime is answering, when one has. */
  backend?: 'wasm' | 'native';
  /** One clause, present only when {@link phase} is `unavailable`. */
  reason?: string;
  /**
   * Whether an embedding worker is alive and holding the embed lane.
   *
   * **FIX-F C2.** {@link VectorPhase} is a fact about the *index* — how many
   * rows carry a vector — and until this field there was nothing anywhere that
   * asked the different question *is anybody embedding the rest?* So `pending`
   * and `warming` were rendered with {@link warmingLine} unconditionally, whose
   * own docstring says "there is nothing for the reader to do; the work is
   * already running". After `index --no-embed`, on a machine that cannot fetch
   * the runtime, or after an embedder crashed, that sentence is false: the
   * index is 0-of-4,745 with nothing in flight, and the reader — an agent, at
   * `potsherd_recall` — is being told to wait for a pass that will never run.
   *
   * The evidence is `<root>/.lock.embed`, which the background worker holds for
   * the whole pass and which carries its `pid`. `lock.holder()` already answers
   * it, already refuses a stale lock whose owner is gone (`lock.isStale`), and
   * is already a pure read. `vec.ts` asks it once, here, so the three surfaces
   * that render this report cannot disagree about it.
   *
   * `undefined` — not `false` — when the caller had no root to ask about, which
   * is the one case where nothing may be claimed in either direction. A caller
   * that has just *spawned* a worker knows better than the lock does for the
   * next few milliseconds; see `cli/commands/index.ts`, which carries its own
   * `spawned` flag for exactly that window.
   */
  working?: boolean;
}

/**
 * The count of embedded and pending rows, and what that adds up to.
 *
 * Deliberately takes counts rather than a database: `vec.ts` owns the SQL and
 * this file owns the sentence, and a renderer that cannot open a connection
 * cannot disagree with the module that can.
 */
export function vectorReport(counts: {
  embedded: number;
  pending: number;
  cacheDir: string;
  backend?: 'wasm' | 'native';
  reason?: string;
  /** See {@link VectorReport.working}. Omitted when the caller cannot know. */
  working?: boolean;
}): VectorReport {
  const total = counts.embedded + counts.pending;
  const runtimeReady = isEmbeddingReady(counts.cacheDir);
  const acquireBytes = runtimeReady ? 0 : acquisitionPlan(counts.cacheDir).bytes || ACQUIRE_BYTES;
  const base = {
    embedded: counts.embedded,
    pending: counts.pending,
    total,
    runtimeReady,
    acquireBytes,
    ...(counts.backend ? { backend: counts.backend } : {}),
    ...(counts.working === undefined ? {} : { working: counts.working }),
  };
  if (counts.reason) return { ...base, phase: 'unavailable', reason: counts.reason };
  if (total === 0) return { ...base, phase: 'empty' };
  if (counts.pending === 0) return { ...base, phase: 'ready' };
  if (counts.embedded === 0) return { ...base, phase: 'pending' };
  return { ...base, phase: 'warming' };
}

/**
 * The status line every verb prints while vectors are warming.
 *
 * `05`'s honesty contract, and the audit's item 9: *tell me what you can't do,
 * at the top*. It is a **status, not an apology** — no "degraded", no
 * "unavailable", no command to run, because there is nothing for the user to
 * do. The work is already happening.
 */
export function warmingLine(r: VectorReport, num: (n: number) => string = String): string {
  return `semantic search: warming (${num(r.embedded)} of ${num(r.total)} embedded)`;
}

/**
 * The other half of {@link warmingLine}: rows left to embed, and **nobody
 * embedding them**.
 *
 * FIX-F round 2, closing C2. `warming` is a claim that a pass is in flight, and
 * the docstring above says so in as many words — *the work is already
 * happening*. After `index --no-embed`, on a machine that cannot fetch the
 * runtime, and after an embedder was killed, it is not, and the agent at
 * `potsherd_recall` was being told to wait for something that would never
 * start. {@link VectorReport.working} is the lock read that separates the two;
 * this is the sentence for the other side of it.
 *
 * **Still no command in it, in either direction.** FIX-C deleted
 * `run  potsherd index --embed` from every string that can reach the model
 * door, whose caller has no shell, and `find` prints this same sentence to a
 * human and to an agent from one function. What the reader can *do* differs by
 * reader; what is *true* does not. So this says only what is true, and the two
 * verbs that own the remedy — `index`, which starts the pass, and `doctor`,
 * which reports the lane — name it in their own words.
 *
 * The clause order is deliberate. `embedded > 0` is tested **first**: if
 * anything in this index carries a vector then a pass ran at some point, and
 * *"the runtime has not been fetched"* would be a strange thing to say about a
 * machine that has plainly used it, even when the cache directory is gone now.
 */
export function stoppedLine(
  r: VectorReport,
  num: (n: number) => string = String,
  bytes: (n: number) => string = (n) => `${Math.round(n / 1_000_000)} MB`,
): string {
  const head = `semantic search: not running (${num(r.embedded)} of ${num(r.total)} embedded)`;
  // Something embedded these rows and then stopped: interrupted, killed, or
  // finished with the machine offline.
  if (r.embedded > 0) return `${head} — it stopped partway`;
  // The ordinary offline / first-run case, and the one the fourth verifier
  // filed: `doctor` already said this much and `find` did not.
  if (!r.runtimeReady) return `${head} — the ${bytes(r.acquireBytes)} runtime has not been fetched`;
  return head;
}

/**
 * The `vectors` row's value and note, as parts.
 *
 * The note is returned as an array so the renderer can drop clauses from the
 * right to fit a narrow terminal instead of clipping mid-word — which is the
 * `04` leftover. Part 0 always says what is true on its own.
 */
export function vectorNote(
  r: VectorReport,
  opts: { num?: (n: number) => string; bytes?: (n: number) => string; dash?: string } = {},
): { value: string; parts: string[]; tone: 'ok' | 'warn' | 'dim' } {
  const num = opts.num ?? String;
  const bytes = opts.bytes ?? ((n: number) => `${Math.round(n / 1_000_000)} MB`);
  const dash = opts.dash ?? '—';
  const runtime = r.backend === 'native' ? 'bge-small, 384-d' : 'bge-small, 384-d, wasm';

  switch (r.phase) {
    case 'ready':
      return { value: num(r.embedded), parts: [runtime, 'every exchange'], tone: 'ok' };
    // FIX-F round 2 §4.3 — the row says `warming` for the same reason the
    // sentence did, and it is wrong in the same state. `working === false` is
    // a live worker's absence; `undefined` is a caller who could not ask, and
    // an absent measurement must not become a claim, so it keeps the old word.
    case 'warming':
      return {
        value: num(r.embedded),
        parts: [
          r.working === false
            ? `stopped at ${num(r.embedded)} of ${num(r.total)}`
            : `warming ${num(r.embedded)} of ${num(r.total)}`,
          runtime,
        ],
        tone: 'ok',
      };
    // VERIFICATION-5 C-6 — the second branch used to read `working` not at all,
    // so `doctor` printed one sentence for two different states:
    //
    //     no worker, 1,800 pending    vectors — 0 of 1,800 · 46.1 MB runtime not fetched yet
    //     worker alive, lock held     vectors — 0 of    22 · 32.4 MB runtime not fetched yet
    //
    // and the moment a user is most likely to run `doctor` to ask *is anything
    // happening* is the first run of a fresh install, which is exactly this
    // branch. During the multi-minute acquisition there **is** work in flight
    // and the honest word is not "not running"; after a killed or failed fetch
    // there is not. `find` and `potsherd_recall` already separated the two, so
    // FIX-F C2's claim that one flag drives all four surfaces was true of three.
    // `undefined` keeps the old wording for the old reason: a caller who could
    // not ask must not be made to claim.
    case 'pending':
      return {
        value: dash,
        parts: r.runtimeReady
          ? [
              r.working === false
                ? `not running, 0 of ${num(r.total)}`
                : `warming 0 of ${num(r.total)}`,
              runtime,
            ]
          : [
              `0 of ${num(r.total)}`,
              r.working === true
                ? `fetching the ${bytes(r.acquireBytes)} runtime`
                : r.working === false
                  ? `not running — ${bytes(r.acquireBytes)} runtime not fetched`
                  : `${bytes(r.acquireBytes)} runtime not fetched yet`,
            ],
        tone: 'dim',
      };
    case 'empty':
      return { value: dash, parts: ['nothing indexed yet'], tone: 'dim' };
    case 'unavailable':
    default:
      return {
        value: r.embedded > 0 ? num(r.embedded) : dash,
        parts: [r.reason ?? 'semantic search is not running here', 'text search still works'],
        tone: 'dim',
      };
  }
}

/**
 * Join the parts to a width, dropping whole clauses from the right.
 *
 * Never returns an empty string and never cuts part 0 — a note that has been
 * reduced to `no vector index: sqlite-vec…` tells the reader nothing, and that
 * is exactly what `04` logged.
 */
export function fitNote(parts: readonly string[], width: number, sep = ' · '): string {
  const kept: string[] = [];
  for (const part of parts) {
    const next = kept.length === 0 ? part : `${kept.join(sep)}${sep}${part}`;
    if (kept.length > 0 && next.length > width) break;
    kept.push(part);
  }
  return kept.join(sep);
}

// ------------------------------------------------- the per-harness adapter line

/**
 * The one shape every adapter's `doctor` line takes.
 *
 * `potsherd doctor` prints one line per harness and the four adapters landed in
 * parallel, each with its own idea of how that line should read. The line is
 * part of the terminal design system (`05`, and phase-0 HANDOFF item 5), so it
 * is formatted here and each adapter supplies only the facts:
 *
 *     pi          ready     ~/.pi/agent/sessions          4 sessions
 *     cursor      ready     ~/.cursor/projects            2 sessions · 4 transcripts
 *     codex       ready     ~/.codex/sessions             1 session · 1.9 MB · cli 0.145.0
 *
 * Columns are fixed so the four lines form a block. `note` is whatever that
 * adapter knows and no other adapter does — a cli version, a count of files it
 * could not read, the fields it can never recover.
 */
export function formatDoctorLine(o: {
  harness: string;
  /** `ready`, `absent`, `phase 6` … */
  status: string;
  dir: string;
  note: string;
}): string {
  return `${o.harness.padEnd(12)}${o.status.padEnd(10)}${tildify(o.dir).padEnd(28)}  ${o.note}`;
}

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
    case 'warming':
      return {
        value: num(r.embedded),
        parts: [`warming ${num(r.embedded)} of ${num(r.total)}`, runtime],
        tone: 'ok',
      };
    case 'pending':
      return {
        value: dash,
        parts: r.runtimeReady
          ? [`warming 0 of ${num(r.total)}`, runtime]
          : [`fetching the ${bytes(r.acquireBytes)} runtime`, `then ${num(r.total)} exchanges`],
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

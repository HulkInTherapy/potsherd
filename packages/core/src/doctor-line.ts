import { tildify } from './paths.js';

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

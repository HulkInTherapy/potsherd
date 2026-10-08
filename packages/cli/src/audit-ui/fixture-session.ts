/**
 * Developer hooks for iterating on the audit UI without a 35-second scan.
 *
 *   SLOPIE_AUDIT_RECORD=path   wrap a real session and save its event stream
 *   SLOPIE_AUDIT_FIXTURE=path  replay a saved recording (or a bare snapshot JSON)
 *   SLOPIE_AUDIT_FIXTURE_SPEED=4  replay four times faster (default 1)
 *
 * Recordings contain your local history. Keep them on this machine.
 */
import fs from 'node:fs';
import type {
  AuditEvent,
  AuditSession,
  AuditSnapshot,
} from '../../../core/src/analytics/contracts.js';

export interface AuditRecording {
  kind: 'slopie-audit-recording';
  version: 1;
  initial: AuditSnapshot;
  events: { at: number; event: AuditEvent }[];
  final: AuditSnapshot;
}

function isRecording(value: unknown): value is AuditRecording {
  return Boolean(value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'slopie-audit-recording');
}

/** Wrap a session so its events and final snapshot are written to `file` when the run settles. */
export function recordAuditSession(session: AuditSession, file: string): AuditSession {
  const started = Date.now();
  const initial = session.snapshot();
  const events: AuditRecording['events'] = [];
  let lastSnapshotAt = -Infinity;
  return {
    ...session,
    snapshot: () => session.snapshot(),
    async run(onEvent) {
      const final = await session.run(event => {
        const at = Date.now() - started;
        // Keep every progress/transfer event, but thin out large snapshot events to ~4/s.
        if (event.type === 'snapshot') {
          const last = events.at(-1);
          if (at - lastSnapshotAt < 250 && last?.event.type === 'snapshot') events.pop();
          else lastSnapshotAt = at;
        }
        events.push({ at, event });
        onEvent?.(event);
      });
      const recording: AuditRecording = { kind: 'slopie-audit-recording', version: 1, initial, events, final };
      fs.writeFileSync(file, JSON.stringify(recording), { mode: 0o600 });
      return final;
    },
  };
}

/** A session that replays a saved recording with its original timing. No source reads, no network. */
export function createFixtureSession(file: string, speed = Number(process.env['SLOPIE_AUDIT_FIXTURE_SPEED'] ?? 1)): AuditSession {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  const recording: AuditRecording = isRecording(parsed)
    ? parsed
    : { kind: 'slopie-audit-recording', version: 1, initial: parsed as AuditSnapshot, events: [], final: parsed as AuditSnapshot };
  const factor = Number.isFinite(speed) && speed > 0 ? speed : 1;
  let current = recording.initial;
  let cancelled = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let finish: ((snapshot: AuditSnapshot) => void) | null = null;

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    current = { ...current, status: 'cancelled', launch: current.launch ? { ...current.launch, stage: 'ready' } : undefined };
    finish?.(current);
  };

  return {
    snapshot: () => current,
    run(onEvent) {
      return new Promise<AuditSnapshot>(resolve => {
        finish = resolve;
        const end = recording.events.at(-1)?.at ?? 0;
        for (const { at, event } of recording.events) {
          const timer = setTimeout(() => {
            timers.delete(timer);
            if (cancelled) return;
            if (event.type === 'snapshot') current = event.snapshot;
            onEvent?.(event);
          }, at / factor);
          timers.add(timer);
        }
        const done = setTimeout(() => {
          timers.delete(done);
          if (cancelled) return;
          current = recording.final;
          onEvent?.({ type: 'snapshot', snapshot: current });
          resolve(current);
        }, end / factor + 20);
        timers.add(done);
      });
    },
    cancel,
    async prompts(conversationId) {
      return { snapshotId: current.snapshotId, conversationId, prompts: [], offset: 0, total: 0, nextOffset: null, coverage: current.coverage };
    },
    async evidence(route) {
      return { state: 'unavailable', text: null, role: null, eventAt: null, route, gapCodes: ['fixture_evidence_unavailable'] };
    },
    async classify() {
      return current;
    },
    acknowledgeTransfer() {},
    dispose: cancel,
  };
}

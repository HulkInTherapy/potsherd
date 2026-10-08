import {fork, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {createAuditSession, type AuditSession, type AuditOverviewOptions, type AuditSnapshot, type AuditEvent} from '@potsherd/core';
import {createScanPool} from '../../core/src/analytics/scan-pool.js';

type Request = {kind: 'request'; id: number; op: string; args: unknown[]};
type Pending = {op: string; resolve: (value: any) => void; reject: (error: Error) => void};

/** Worker-thread scan pool next to the bundled CLI, when the asset exists. */
export function localScanPool(): ReturnType<typeof createScanPool> | undefined {
  const entry = new URL('./audit-native-worker.js', import.meta.url);
  return fs.existsSync(entry) ? createScanPool(entry) : undefined;
}

/**
 * The interactive renderer owns this process; the audit runs in a child so
 * keystrokes stay responsive. Messages are framed IPC; the child prints nothing.
 */
export function createBackgroundAuditSession(options: AuditOverviewOptions, entry = process.argv[1]!): AuditSession {
  const seed = createAuditSession({...options, nativeScanExecutor: undefined, onTransfer: undefined, signal: undefined});
  let current: AuditSnapshot = seed.snapshot();
  seed.dispose();
  let child: ChildProcess | null = null;
  let disposed = false, cancelled = false, next = 0;
  let events: ((event: AuditEvent) => void) | undefined;
  const pending = new Map<number, Pending>();
  let ready: Promise<void> | null = null;
  let resolveReady: () => void = () => {}, rejectReady: (error: Error) => void = () => {};

  const failAll = (error: Error) => {
    rejectReady(error);
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };

  const settleCancelled = () => {
    current = {
      ...current, status: 'cancelled',
      progress: {...current.progress, stage: 'cancelled', provisional: false, cancellable: false},
      ...(current.launch ? {launch: {...current.launch, stage: 'ready' as const, semantics: current.launch.semantics ? {...current.launch.semantics, state: 'cancelled' as const} : null}} : {}),
    };
    for (const request of pending.values()) {
      if (request.op === 'run' || request.op === 'analyzePeriod') request.resolve(current);
      else request.reject(new Error('audit_cancelled'));
    }
    pending.clear();
  };

  const start = () => {
    if (ready) return ready;
    ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    ready.catch(() => {});
    child = fork(path.resolve(entry), ['__audit_worker'], {stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced'});
    child.on('message', (raw: any) => {
      if (disposed || cancelled) return;
      if (raw?.kind === 'ready') { current = raw.snapshot; events?.({type: 'snapshot', snapshot: current}); resolveReady(); return; }
      if (raw?.kind === 'event') {
        const event = raw.event as AuditEvent;
        if (event.type === 'snapshot') current = event.snapshot;
        else if (event.type === 'progress') current = {...current, sequence: event.sequence, progress: event.progress, sources: event.sources};
        events?.(event);
        return;
      }
      if (raw?.kind === 'result') {
        const request = pending.get(raw.id);
        if (!request) return;
        pending.delete(raw.id);
        if (raw.error) { request.reject(new Error(raw.error)); return; }
        if (request.op === 'run' || request.op === 'analyzePeriod') current = raw.value;
        request.resolve(raw.value);
      }
    });
    child.once('error', error => failAll(error));
    child.once('exit', () => { if (!cancelled && !disposed) failAll(new Error('audit_background_worker_unavailable')); });
    const {signal: _signal, onTransfer: _onTransfer, nativeScanExecutor: _executor, ...serializable} = options;
    child.send({kind: 'init', options: {...serializable, sessionIdentity: current.snapshotId}});
    return ready;
  };

  const request = async (op: string, args: unknown[] = []): Promise<any> => {
    if (disposed || cancelled) throw new Error('audit_cancelled');
    await start();
    if (disposed || cancelled) throw new Error('audit_cancelled');
    return new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, {op, resolve, reject});
      child!.send({kind: 'request', id, op, args} satisfies Request);
    });
  };

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    settleCancelled();
    rejectReady(new Error('audit_cancelled'));
    if (child?.connected) child.send({kind: 'cancel'});
    if (child && child.exitCode === null) {
      const owned = child;
      setTimeout(() => { owned.kill('SIGTERM'); setTimeout(() => owned.kill('SIGKILL'), 250).unref(); }, 500).unref();
    }
  };
  options.signal?.addEventListener('abort', cancel, {once: true});
  if (options.signal?.aborted) cancel();

  return {
    snapshot: () => current,
    run: async callback => {
      events = callback;
      try { return await request('run'); } catch (error) { if (cancelled) return current; throw error; }
    },
    analyzePeriod: async (period, callback) => { events = callback; return request('analyzePeriod', [period]); },
    prompts: (...args) => request('prompts', args),
    evidence: route => request('evidence', [route]),
    previewLaunch: () => request('previewLaunch'),
    preview: selection => request('preview', [selection]),
    classify: (selection, callback) => { events = callback; const {signal: _signal, ...safe} = selection; return request('classify', [safe]); },
    acknowledgeTransfer: ackId => { if (!cancelled && !disposed && child?.connected) child.send({kind: 'transfer_ack', ackId}); },
    cancel,
    dispose: () => { if (disposed) return; cancel(); disposed = true; events = undefined; },
  };
}

/** Private internal entry of the child process. */
export async function runAuditWorkerHost(): Promise<void> {
  if (!process.send) throw new Error('audit_worker_requires_ipc');
  let session: AuditSession | null = null, nextAck = 0;
  const acknowledgements = new Map<string, {resolve: () => void; reject: (error: Error) => void}>();
  const send = (value: unknown) => { if (process.connected) process.send!(value); };
  const emit = (event: AuditEvent) => { if (event.type !== 'transfer') send({kind: 'event', event}); };
  process.on('message', async (raw: any) => {
    if (raw?.kind === 'init') {
      session = createAuditSession({
        ...raw.options,
        nativeScanExecutor: localScanPool(),
        onTransfer: (event: Extract<AuditEvent, {type: 'transfer'}>) => new Promise<void>((resolve, reject) => {
          const ackId = String(++nextAck);
          acknowledgements.set(ackId, {resolve, reject});
          send({kind: 'event', event: {...event, ackId}});
        }),
      });
      send({kind: 'ready', snapshot: session.snapshot()});
      return;
    }
    if (raw?.kind === 'transfer_ack') { acknowledgements.get(raw.ackId)?.resolve(); acknowledgements.delete(raw.ackId); return; }
    if (raw?.kind === 'cancel') {
      session?.cancel();
      for (const ack of acknowledgements.values()) ack.reject(new Error('audit_cancelled'));
      acknowledgements.clear();
      session?.dispose();
      if (process.connected) process.disconnect();
      return;
    }
    if (raw?.kind !== 'request' || !session) return;
    const {id, op, args} = raw as Request;
    try {
      let value: unknown;
      if (op === 'run') value = await session.run(emit);
      else if (op === 'analyzePeriod') value = await session.analyzePeriod!(args[0] as any, emit);
      else if (op === 'classify') value = await session.classify(args[0] as any, emit);
      else if (['prompts', 'evidence', 'preview', 'previewLaunch'].includes(op)) value = await (session as any)[op](...args);
      else throw new Error('audit_worker_operation_unavailable');
      send({kind: 'result', id, value});
    } catch (error) {
      send({kind: 'result', id, error: error instanceof Error ? error.message : 'audit_worker_failed'});
    }
  });
  process.on('disconnect', () => { session?.dispose(); process.exit(0); });
}

/**
 * Reads history files on a bounded pool of worker threads. Each worker runs
 * `extractFile` on one file at a time and posts the facts back; the caller
 * aggregates. Without a worker entry (tests, unusual installs) the same code
 * runs inline.
 */
import os from 'node:os';
import {Worker, parentPort} from 'node:worker_threads';
import {extractFile, type NativeHarness, type SourceFacts} from './extract.js';

export interface ScanJob {
  file: string;
  harness: NativeHarness;
  /** Bytes, used to schedule the largest files first. */
  size: number;
}

export type ScanResult = {job: ScanJob; facts: SourceFacts} | {job: ScanJob; error: string};

export interface ScanExecutor {
  /** Calls `onResult` once per job, in completion order. */
  scan(jobs: readonly ScanJob[], onResult: (result: ScanResult) => void, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

const errorCode = (error: unknown) => (error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/.test(error.message) ? error.message : 'source_unreadable');

function runInline(job: ScanJob): ScanResult {
  try { return {job, facts: extractFile(job.file, job.harness)}; } catch (error) { return {job, error: errorCode(error)}; }
}

/** In-process executor: yields between files so progress events can flow. */
export const inlineScanExecutor: ScanExecutor = {
  async scan(jobs, onResult, signal) {
    for (const job of jobs) {
      if (signal.aborted) return;
      onResult(runInline(job));
      await new Promise(resolve => setImmediate(resolve));
    }
  },
  async close() {},
};

export function defaultThreads(): number {
  const forced = Number(process.env['SLOPIE_AUDIT_THREADS']);
  if (Number.isInteger(forced) && forced > 0) return Math.min(forced, 16);
  return Math.max(1, Math.min(8, os.availableParallelism() - 1));
}

/** Worker-thread executor. Threads start lazily and are reused across scans. */
export function createScanPool(entry: URL | string, threads = defaultThreads()): ScanExecutor {
  let workers: Worker[] = [];
  let closed = false;
  const start = (count: number) => {
    while (workers.length < count) workers.push(new Worker(entry, {stdout: false, stderr: false, resourceLimits: {maxOldGenerationSizeMb: 512}}));
  };
  return {
    async scan(jobs, onResult, signal) {
      if (closed) throw new Error('scan_pool_closed');
      const queue = [...jobs].sort((a, b) => b.size - a.size);
      if (!queue.length) return;
      start(Math.min(threads, queue.length));
      await new Promise<void>(resolve => {
        let active = 0, done = false;
        const finish = () => { if (!done) { done = true; signal.removeEventListener('abort', finish); resolve(); } };
        signal.addEventListener('abort', finish, {once: true});
        const feed = (worker: Worker) => {
          if (done) return;
          if (signal.aborted || !queue.length) { if (active === 0) finish(); return; }
          const job = queue.shift()!;
          active++;
          const onMessage = (message: {facts?: SourceFacts; error?: string}) => {
            cleanup();
            active--;
            if (!done) onResult(message.facts ? {job, facts: message.facts} : {job, error: message.error ?? 'source_unreadable'});
            feed(worker);
          };
          const onError = () => {
            cleanup();
            active--;
            workers = workers.filter(w => w !== worker);
            // A crashed thread loses only its file; read it here instead.
            if (!done) onResult(runInline(job));
            if (!workers.length && queue.length) { for (const next of queue.splice(0)) if (!done) onResult(runInline(next)); }
            if (active === 0 && !queue.length) finish();
          };
          const cleanup = () => { worker.off('message', onMessage); worker.off('error', onError); };
          worker.on('message', onMessage);
          worker.once('error', onError);
          worker.postMessage(job);
        };
        for (const worker of workers.slice(0, Math.min(workers.length, queue.length))) feed(worker);
      });
    },
    async close() {
      closed = true;
      const all = workers;
      workers = [];
      await Promise.all(all.map(w => w.terminate().catch(() => 0)));
    },
  };
}

/** Worker entry point. */
export function runScanWorker(): void {
  if (!parentPort) throw new Error('scan_worker_requires_parent');
  const port = parentPort;
  port.on('message', (job: ScanJob) => {
    try { port.postMessage({facts: extractFile(job.file, job.harness)}); } catch (error) { port.postMessage({error: errorCode(error)}); }
  });
}

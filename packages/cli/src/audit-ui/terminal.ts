/**
 * Full-screen interactive wallboard.
 *
 * - Paints a skeleton board immediately, then fills it as the background scan publishes data.
 * - Diff-based redraw: only changed rows are written; the spinner is the only animation and
 *   stops (with its timer) once the report is ready.
 * - ←/→ switch pages, ? toggles details, q / Esc / Ctrl-C quit. No scrolling anywhere.
 * - Alt screen, cursor, raw mode and bracketed paste are always restored, including on
 *   signals and crashes.
 * - A transfer notice is acknowledged to the worker only after the frame showing it has been
 *   flushed to the terminal.
 */
import type { AuditEvent, AuditSession, AuditSnapshot } from '../../../core/src/analytics/contracts.js';
import { buildBoard, buildDetails, type Line } from './layout.js';
import { DiffRenderer, detectColorMode } from './renderer.js';
import { applyAuditEvent, applyPreviewInvalidation, applyPrivacyEvent, type PrivacyView, type TransferEvent } from './session-state.js';
import { sanitize } from './text.js';
import { boardData, detailLines, isLoading } from './view-model.js';

export interface TerminalIo {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

export interface TerminalOptions {
  /** Injected streams for tests; defaults to the process TTY. */
  io?: TerminalIo;
  color?: boolean;
  ascii?: boolean;
  width?: number;
  motion?: boolean;
  private?: boolean;
}

export interface TerminalResult {
  snapshot: AuditSnapshot;
  reason: 'quit' | 'cancelled' | 'complete';
}

type Key = 'quit' | 'left' | 'right' | 'details' | 'back' | 'enter' | null;

/** Decode one stdin chunk. Pasted or unknown multi-character input never triggers a command. */
export function decodeKey(chunk: string): Key {
  switch (chunk) {
    case '\x03':
    case 'q':
    case 'Q':
      return 'quit';
    case '\x1b[C':
    case '\x1bOC':
    case 'l':
      return 'right';
    case '\x1b[D':
    case '\x1bOD':
    case 'h':
      return 'left';
    case '?':
      return 'details';
    case '\x1b':
      return 'back';
    case '\r':
    case '\n':
      return 'enter';
    default:
      return null;
  }
}

const TRANSFER_LINGER_MS = 1800;
const SPINNER_MS = 100;
const COALESCE_MS = 16;

export async function runWallboard(session: AuditSession, options: TerminalOptions = {}): Promise<TerminalResult> {
  const stdin = options.io?.stdin ?? process.stdin;
  const stdout = options.io?.stdout ?? process.stdout;
  if (!stdin.isTTY || !stdout.isTTY) return { snapshot: await session.run(), reason: 'complete' };

  const renderer = new DiffRenderer(detectColorMode(process.env, options.color !== false));
  const motion = options.motion !== false && process.env['SLOPIE_REDUCED_MOTION'] !== '1';

  let view: PrivacyView = { snapshot: session.snapshot(), generation: 0, revoked: null };
  let settled = false;
  let stopping = false;
  let reason: TerminalResult['reason'] = 'quit';
  let mode: 'board' | 'details' = 'board';
  let page = 0;
  let detailPage = 0;
  let anchor: string | null = null;
  let pageCount = 1;
  let shownCards: string[] = [];
  let frame = 0;
  let hint: string | null = null;
  let hintTimer: ReturnType<typeof setTimeout> | null = null;
  let spinner: ReturnType<typeof setInterval> | null = null;
  let scheduled: ReturnType<typeof setTimeout> | null = null;
  let needsClear = true;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>(resolve => { resolveDone = resolve; });

  const transfers: TransferEvent[] = [];
  const queue: TransferEvent[] = [];
  const acknowledged = new Set<string>();
  let lastTransferSequence = -1;
  let bannerTimer: ReturnType<typeof setTimeout> | null = null;
  let lingering: TransferEvent | null = null;

  /* ── terminal setup and guaranteed restore ── */
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try { stdin.setRawMode(false); } catch { /* stdin already closed */ }
    stdin.pause();
    try { stdout.write('\x1b[?2004l\x1b[0m\x1b[?25h\x1b[?1049l'); } catch { /* stdout already closed */ }
  };
  const onCrash = (error: unknown) => {
    restore();
    process.stderr.write(`slopie audit crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  };
  const onSignal = () => stop();
  process.on('exit', restore);
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
  process.on('SIGINT', onSignal);

  (globalThis as { __slopieSplash?: { handOff(): void } }).__slopieSplash?.handOff();
  stdout.write('\x1b[?1049h\x1b[H\x1b[2J\x1b[?25l\x1b[?2004h');
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();

  /* ── rendering ── */
  const size = () => ({
    columns: Math.max(1, Math.min(stdout.columns || 80, options.width ?? Infinity)),
    rows: Math.max(1, stdout.rows || 24),
  });

  const banner = (): string | null => {
    const event = queue[0] ?? lingering;
    return event ? sanitize(event.notice) : null;
  };

  function compose(): { lines: Line[]; bannerShown: boolean } {
    const { columns, rows } = size();
    const data = boardData(view.snapshot);
    if (mode === 'details') {
      const pages = buildDetails(data, detailLines(view.snapshot, transfers), { columns, rows, ascii: options.ascii });
      detailPage = Math.min(detailPage, pages.length - 1);
      return { lines: pages[detailPage]!, bannerShown: false };
    }
    const board = buildBoard(data, { columns, rows, ascii: options.ascii, frame, banner: banner(), hint });
    if (anchor !== null) {
      const found = board.cards.findIndex(cards => cards.includes(anchor!));
      if (found >= 0) page = found;
      anchor = null;
    }
    page = Math.max(0, Math.min(page, board.pages.length - 1));
    pageCount = board.pages.length;
    shownCards = board.cards[page] ?? [];
    return { lines: board.pages[page]!, bannerShown: board.bannerRows > 0 };
  }

  function paint(): void {
    scheduled = null;
    if (restored) return;
    const { lines, bannerShown } = compose();
    const out = renderer.frame(lines, needsClear);
    needsClear = false;
    const active = queue[0];
    if (active && bannerShown && mode === 'board') {
      stdout.write(out, () => acknowledge(active));
    } else if (out) {
      stdout.write(out);
    }
  }

  function schedule(): void {
    if (scheduled || restored) return;
    scheduled = setTimeout(paint, COALESCE_MS);
  }

  function syncSpinner(): void {
    const want = motion && isLoading(view.snapshot) && mode === 'board' && !restored;
    if (want && !spinner) {
      spinner = setInterval(() => { frame++; schedule(); }, SPINNER_MS);
    } else if (!want && spinner) {
      clearInterval(spinner);
      spinner = null;
    }
  }

  function flash(text: string): void {
    hint = text;
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { hint = null; hintTimer = null; schedule(); }, 1200);
    schedule();
  }

  /* ── transfers ── */
  function acknowledge(event: TransferEvent): void {
    if (stopping || queue[0] !== event) return;
    if (event.ackId && !acknowledged.has(event.ackId)) {
      acknowledged.add(event.ackId);
      session.acknowledgeTransfer?.(event.ackId);
    }
    queue.shift();
    if (queue.length) {
      schedule();
      return;
    }
    lingering = event;
    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => { lingering = null; bannerTimer = null; schedule(); }, TRANSFER_LINGER_MS);
  }

  /* ── session events ── */
  function publish(event: AuditEvent): void {
    if (stopping) return;
    const revoked = applyPrivacyEvent(view, event);
    if (revoked) {
      view = revoked;
      queue.length = 0;
      lingering = null;
      flash('Cleared by your privacy settings');
      session.cancel();
      syncSpinner();
      return;
    }
    if (view.revoked) return;
    const withdrawn = applyPreviewInvalidation(view, event);
    if (withdrawn) {
      view = withdrawn;
      schedule();
      return;
    }
    if (event.type === 'transfer') {
      if (event.snapshotId !== view.snapshot.snapshotId || event.sequence < view.snapshot.sequence || event.sequence <= lastTransferSequence) return;
      if (event.ackId && (acknowledged.has(event.ackId) || queue.some(item => item.ackId === event.ackId))) return;
      lastTransferSequence = event.sequence;
      if (queue.length >= 128) {
        reason = 'cancelled';
        stop();
        return;
      }
      transfers.push(event);
      if (transfers.length > 100) transfers.shift();
      queue.push(event);
      lingering = null;
      schedule();
      return;
    }
    view = { ...view, snapshot: applyAuditEvent(view.snapshot, event) };
    syncSpinner();
    schedule();
  }

  /* ── input ── */
  let pasting = false;
  const onData = (chunk: string) => {
    if (chunk.includes('\x1b[200~')) pasting = true;
    if (pasting) {
      if (chunk.includes('\x1b[201~')) pasting = false;
      return;
    }
    const key = decodeKey(chunk);
    if (!key) return;
    if (key === 'quit') {
      stop();
      return;
    }
    if (mode === 'details') {
      if (key === 'details' || key === 'back' || key === 'enter') {
        mode = 'board';
        needsClear = true;
        syncSpinner();
      } else if (key === 'left' || key === 'right') {
        detailPage = Math.max(0, detailPage + (key === 'right' ? 1 : -1));
      }
      paint();
      return;
    }
    if (key === 'details') {
      mode = 'details';
      detailPage = 0;
      needsClear = true;
      syncSpinner();
      paint();
      return;
    }
    if (key === 'back') {
      stop();
      return;
    }
    if (key === 'left' || key === 'right') {
      const count = pageCount;
      const next = page + (key === 'right' ? 1 : -1);
      if (count <= 1) flash('Everything fits on one screen');
      else if (next < 0) flash('This is the first page');
      else if (next >= count) flash('This is the last page');
      else page = next;
      paint();
    }
  };
  stdin.on('data', onData);

  const onResize = () => {
    anchor = shownCards[0] ?? null;
    renderer.invalidate();
    needsClear = true;
    paint();
  };
  stdout.on('resize', onResize);

  /* ── lifecycle ── */
  function stop(): void {
    if (stopping) return;
    stopping = true;
    if (!settled || queue.length) {
      reason = 'cancelled';
      session.cancel();
    }
    queue.length = 0;
    resolveDone();
  }

  paint();
  syncSpinner();

  const scan = Promise.resolve()
    .then(() => session.run(publish))
    .then(
      final => {
        settled = true;
        if (!view.revoked) view = { ...view, snapshot: final.snapshotId === view.snapshot.snapshotId && final.sequence >= view.snapshot.sequence ? final : view.snapshot };
      },
      () => {
        settled = true;
        const snapshot = view.snapshot;
        view = { ...view, snapshot: { ...snapshot, status: stopping ? 'cancelled' : 'error', launch: snapshot.launch ? { ...snapshot.launch, stage: 'ready' } : undefined } };
      },
    )
    .then(() => {
      syncSpinner();
      schedule();
    });

  try {
    await done;
  } finally {
    for (const timer of [scheduled, hintTimer, bannerTimer]) if (timer) clearTimeout(timer);
    if (spinner) clearInterval(spinner);
    stdin.off('data', onData);
    stdout.off('resize', onResize);
    restore();
    process.off('exit', restore);
    process.off('uncaughtException', onCrash);
    process.off('unhandledRejection', onCrash);
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
    process.off('SIGINT', onSignal);
  }
  if (!settled) session.cancel();
  await Promise.race([scan, new Promise(resolve => setTimeout(resolve, 2000).unref())]);
  return { snapshot: view.revoked ?? view.snapshot, reason };
}

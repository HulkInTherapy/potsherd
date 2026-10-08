/**
 * The interactive `slopie audit` experience: loading story → story cards → share board.
 *
 * - Cell-diff rendering, one synchronized write per frame, 30 fps only while something moves.
 *   When everything is still, the only timer is Slopie's blink (two paints every few seconds).
 * - ←/→ (h/l, space, enter) page; b board; s save share SVG; ? method notes; 1–4 guess; q/Ctrl-C quit.
 * - Alt screen, cursor, raw mode and bracketed paste are always restored (quit, signals, crashes).
 * - A transfer notice is acknowledged only after the frame showing it in full has been flushed.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AuditEvent, AuditSession, AuditSnapshot } from '../../../core/src/analytics/contracts.js';
import { renderCard } from './cards/index.js';
import { MIN_COLS, MIN_ROWS, tierFor, type CardState, type Scene } from './cards/scene.js';
import { Canvas } from './gfx/canvas.js';
import { C, fade } from './gfx/color.js';
import { box, textCenter, textWidth, wrapText } from './gfx/draw.js';
import { CellRenderer, detectCaps, type Caps } from './gfx/screen.js';
import { LoadingStory, loadingModel } from './loading.js';
import { drawMascot, mascotLine } from './mascot.js';
import { applyAuditEvent, applyPreviewInvalidation, applyPrivacyEvent, type PrivacyView, type TransferEvent } from './session-state.js';
import { storyShareSvg } from './share.js';
import { buildDeck, type DeckCard } from './story/deck.js';
import { sanitize } from './text.js';
import { detailLines } from './view-model.js';

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
  /** Where `s` saves the share card (default: the current directory). */
  shareDir?: string;
  /** Injected clock for tests. */
  now?: () => number;
}

export interface TerminalResult {
  snapshot: AuditSnapshot;
  reason: 'quit' | 'cancelled' | 'complete';
}

export type Key = 'quit' | 'left' | 'right' | 'details' | 'back' | 'enter' | 'board' | 'share' | `guess${1 | 2 | 3 | 4}` | null;

/**
 * Split a stdin chunk into keys at escape boundaries, so fast typists (or a terminal that batches
 * "Esc s") still get every key. Runs of plain characters stay one token and are ignored as paste.
 */
export function splitKeys(chunk: string): string[] {
  const out: string[] = [];
  for (const part of chunk.split(/(?=\x1b)/)) {
    if (!part) continue;
    const seq = /^\x1b(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z])/.exec(part);
    if (seq) {
      out.push(seq[0]);
      if (part.length > seq[0].length) out.push(part.slice(seq[0].length));
    } else if (part[0] === '\x1b' && part.length > 1) out.push('\x1b', part.slice(1));
    else out.push(part);
  }
  return out;
}

/** Decode one key token. Pasted or unknown multi-character input never triggers a command. */
export function decodeKey(chunk: string): Key {
  switch (chunk) {
    case '\x03': case 'q': case 'Q': return 'quit';
    case '\x1b[C': case '\x1bOC': case 'l': case ' ': return 'right';
    case '\x1b[D': case '\x1bOD': case 'h': return 'left';
    case '?': return 'details';
    case '\x1b': return 'back';
    case '\r': case '\n': return 'enter';
    case 'b': case 'B': return 'board';
    case 's': case 'S': return 'share';
    case '1': return 'guess1';
    case '2': return 'guess2';
    case '3': return 'guess3';
    case '4': return 'guess4';
    default: return null;
  }
}

const FRAME_MS = 33;
/** Card clocks run 1.5× real time: entrances read as snappy (most settle in ~1 s) without losing their shape. */
const CARD_SPEED = 1.5;
const TRANSFER_LINGER_MS = 1800;
const BLINK_MS = 140;

export async function runWallboard(session: AuditSession, options: TerminalOptions = {}): Promise<TerminalResult> {
  const stdin = options.io?.stdin ?? process.stdin;
  const stdout = options.io?.stdout ?? process.stdout;
  if (!stdin.isTTY || !stdout.isTTY) return { snapshot: await session.run(), reason: 'complete' };

  const caps: Caps = detectCaps(process.env, { color: options.color, motion: options.motion, ascii: options.ascii });
  const renderer = new CellRenderer(caps.color);
  const clock = options.now ?? (() => performance.now());
  const started = clock();

  let view: PrivacyView = { snapshot: session.snapshot(), generation: 0, revoked: null };
  let settled = false;
  let stopping = false;
  let reason: TerminalResult['reason'] = 'quit';
  let mode: 'loading' | 'deck' = 'loading';
  let notes: { page: number } | null = null;
  let deck: DeckCard[] = [];
  let deckSnapshot: AuditSnapshot | null = null;
  let index = 0;
  let enteredAt = started;
  const states = new Map<string, CardState>();
  const story = new LoadingStory(started);
  let toast: { text: string; until: number } | null = null;
  let blink = false;
  let needsClear = true;

  let ticker: ReturnType<typeof setInterval> | null = null;
  let blinkTimer: ReturnType<typeof setTimeout> | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let scheduled: ReturnType<typeof setTimeout> | null = null;
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
    try { stdout.write('\x1b[?2026l\x1b[?2004l\x1b[0m\x1b[?25h\x1b[?1049l'); } catch { /* stdout already closed */ }
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
  stdout.write('\x1b[?1049h\x1b[?25l\x1b[?2004h');
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();

  const size = () => ({
    w: Math.max(1, Math.min(stdout.columns || 80, options.width ?? Infinity)),
    h: Math.max(1, stdout.rows || 24),
  });

  /* ── composition ── */

  function current(): DeckCard | null {
    return mode === 'deck' ? deck[index] ?? null : null;
  }

  function stateOf(card: DeckCard): CardState {
    let state = states.get(card.id);
    if (!state) { state = {}; states.set(card.id, state); }
    return state;
  }

  function drawTooSmall(c: Canvas, w: number, h: number): void {
    const msg = `Slopie needs ${MIN_COLS}×${MIN_ROWS}. You're at ${w}×${h}.`;
    const y = Math.max(0, Math.floor(h / 2) - 3);
    if (w >= 12 && h >= 8 && caps.color !== 'none' && caps.color !== '16') drawMascot(c, Math.floor((w - 10) / 2), y, blink ? 'blink' : 'sad', { size: 'compact' });
    else textCenter(c, w / 2, y + 1, mascotLine('sad', !caps.unicode), { fg: C.orange, bold: true });
    const lines = wrapText('make me bigger', w - 2, 1);
    textCenter(c, w / 2, y + 5, lines[0] ?? '', { fg: C.cream, bold: true });
    wrapText(msg, w - 2, 2).forEach((line, i) => textCenter(c, w / 2, y + 6 + i, line, { fg: C.gray }));
  }

  /** Transfer banner (Jev): returns false when the notice cannot be shown in full. */
  function drawBanner(c: Canvas, w: number, h: number): boolean {
    const event = queue[0] ?? lingering;
    if (!event) return false;
    const text = sanitize(event.notice);
    const lines = wrapText(text, Math.max(10, w - 6), 99);
    if (lines.length > 4 || lines.length + 2 > h) return false;
    const height = lines.length + 2;
    for (let y = 0; y < height; y++) for (let x = 0; x < w; x++) c.put(x, y, ' ', C.cream, C.coal);
    lines.forEach((line, i) => c.text(3, 1 + i, line, { fg: C.cream, bg: C.coal, bold: i === 0 }));
    return true;
  }

  function drawNotes(c: Canvas, card: DeckCard, w: number, h: number): void {
    const pw = Math.min(76, w - 6);
    const sections: { title: string; lines: string[] }[] = [{ title: 'HOW WE KNOW', lines: card.notes }];
    if (card.kind === 'board' || card.kind === 'bill' || card.kind === 'scale') {
      for (const section of detailLines(view.snapshot, transfers)) sections.push({ title: section.title.toUpperCase(), lines: section.lines });
    }
    const all: { text: string; title: boolean }[] = [];
    for (const section of sections) {
      if (all.length) all.push({ text: '', title: false });
      all.push({ text: section.title, title: true });
      for (const line of section.lines) for (const row of wrapText(sanitize(line), pw - 4)) all.push({ text: row, title: false });
    }
    const perPage = Math.max(3, h - 8);
    const pages = Math.max(1, Math.ceil(all.length / perPage));
    const page = Math.min(notes!.page, pages - 1);
    notes!.page = page;
    const rows = all.slice(page * perPage, (page + 1) * perPage);
    const ph = rows.length + 4;
    const px = Math.floor((w - pw) / 2), py = Math.max(1, Math.floor((h - ph) / 2));
    box(c, { x: px, y: py, w: pw, h: ph }, C.orange, { fill: C.coal, ascii: !caps.unicode });
    rows.forEach((row, i) => c.text(px + 2, py + 1 + i, row.text, { fg: row.title ? C.orange : C.cream, bold: row.title, bg: C.coal }, pw - 4));
    const foot = pages > 1 ? `${page + 1}/${pages}  ${caps.unicode ? '← →' : '< >'} page · ? or esc to close` : '? or esc to close';
    c.text(px + 2, py + ph - 2, foot, { fg: C.gray, bg: C.coal });
  }

  function compose(now: number): { canvas: Canvas; busy: boolean; bannerShown: boolean } {
    const { w, h } = size();
    const paintBg = caps.color === 'truecolor' || caps.color === '256';
    const canvas = new Canvas(w, h, paintBg ? C.ink : -1);
    if (paintBg) canvas.fill(0, 0, w, h, ' ', { bg: C.ink });
    let busy = false;
    const tier = tierFor(w, h);
    if (!tier) {
      drawTooSmall(canvas, w, h);
      return { canvas, busy: false, bannerShown: false };
    }
    if (mode === 'loading') {
      const model = loadingModel(view.snapshot);
      busy = story.render(canvas, model, now, caps, blink);
      if (model.ready && !model.failure && (!caps.motion || story.done(now))) {
        startDeck(now);
        return compose(now);
      }
    } else {
      const card = deck[index];
      if (card) {
        const scene: Scene = {
          c: canvas, w, h, tier, caps, blink, state: stateOf(card), index, total: deck.length,
          t: caps.motion ? (now - enteredAt) * CARD_SPEED : Infinity,
        };
        busy = renderCard(scene, card);
        if (notes) drawNotes(canvas, card, w, h);
      }
    }
    if (toast && toast.until > now) {
      const text = ` ${toast.text} `;
      const tx = Math.max(0, Math.floor((w - textWidth(text)) / 2));
      canvas.text(tx, h - (tier.id === 'L' ? 4 : 3), text, { fg: C.ink, bg: C.peach, bold: true });
    }
    const bannerShown = drawBanner(canvas, w, h);
    return { canvas, busy, bannerShown };
  }

  /* ── painting and timers ── */

  function paint(): void {
    if (scheduled) { clearTimeout(scheduled); scheduled = null; }
    if (restored) return;
    const now = clock();
    const { canvas, busy, bannerShown } = compose(now);
    const out = renderer.frame(canvas, needsClear);
    needsClear = false;
    const active = queue[0];
    if (active && bannerShown) stdout.write(out || '\x1b[?2026h\x1b[?2026l', () => acknowledge(active));
    else if (out) stdout.write(out);
    animate(busy);
  }

  function schedule(): void {
    if (scheduled || restored) return;
    scheduled = setTimeout(paint, 8);
  }

  function animate(busy: boolean): void {
    if (busy && caps.motion && !restored) {
      if (!ticker) ticker = setInterval(paint, FRAME_MS);
      if (blinkTimer) { clearTimeout(blinkTimer); blinkTimer = null; }
      return;
    }
    if (ticker) { clearInterval(ticker); ticker = null; }
    if (!blinkTimer && caps.motion && !restored) scheduleBlink();
  }

  let blinkCount = 0;
  function scheduleBlink(): void {
    const delay = 2600 + ((blinkCount++ * 977) % 1600);
    blinkTimer = setTimeout(() => {
      blink = true;
      paintStill();
      blinkTimer = setTimeout(() => {
        blink = false;
        blinkTimer = null;
        paintStill();
        if (!ticker) scheduleBlink();
      }, BLINK_MS);
    }, delay);
  }

  /** Repaint without starting the animation loop (blink frames). */
  function paintStill(): void {
    if (restored) return;
    const { canvas } = compose(clock());
    const out = renderer.frame(canvas, false);
    if (out) stdout.write(out);
  }

  function flash(text: string, ms = 1600): void {
    toast = { text, until: clock() + ms };
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast = null; toastTimer = null; paint(); }, ms);
    paint();
  }

  /* ── navigation ── */

  function startDeck(now: number): void {
    deckSnapshot = view.snapshot;
    deck = buildDeck(view.snapshot);
    mode = 'deck';
    index = 0;
    enteredAt = now;
    needsClear = false;
  }

  function go(next: number): void {
    if (next < 0) { flash('this is the start'); return; }
    if (next >= deck.length) { flash(`that's all of it · s saves the card · q quits`); return; }
    index = next;
    enteredAt = clock();
    notes = null;
    paint();
  }

  /* ── transfers ── */
  function acknowledge(event: TransferEvent): void {
    if (stopping || queue[0] !== event) return;
    if (event.ackId && !acknowledged.has(event.ackId)) {
      acknowledged.add(event.ackId);
      session.acknowledgeTransfer?.(event.ackId);
    }
    queue.shift();
    if (queue.length) { schedule(); return; }
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
      session.cancel();
      if (mode === 'deck') { deck = buildDeck(view.snapshot); index = Math.min(index, deck.length - 1); }
      flash('Cleared by your privacy settings');
      return;
    }
    if (view.revoked) return;
    const withdrawn = applyPreviewInvalidation(view, event);
    if (withdrawn) { view = withdrawn; schedule(); return; }
    if (event.type === 'transfer') {
      if (event.snapshotId !== view.snapshot.snapshotId || event.sequence < view.snapshot.sequence || event.sequence <= lastTransferSequence) return;
      if (event.ackId && (acknowledged.has(event.ackId) || queue.some(item => item.ackId === event.ackId))) return;
      lastTransferSequence = event.sequence;
      if (queue.length >= 128) { reason = 'cancelled'; stop(); return; }
      transfers.push(event);
      if (transfers.length > 100) transfers.shift();
      queue.push(event);
      lingering = null;
      schedule();
      return;
    }
    view = { ...view, snapshot: applyAuditEvent(view.snapshot, event) };
    // A later snapshot (e.g. Jev wording) refreshes the deck in place, keeping the current card.
    if (mode === 'deck' && view.snapshot !== deckSnapshot) {
      const id = deck[index]?.id;
      deckSnapshot = view.snapshot;
      deck = buildDeck(view.snapshot);
      const found = deck.findIndex(card => card.id === id);
      index = found >= 0 ? found : Math.min(index, deck.length - 1);
    }
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
    for (const token of splitKeys(chunk)) onKey(token);
  };
  const onKey = (token: string) => {
    if (stopping) return;
    const key = decodeKey(token);
    if (!key) return;
    if (key === 'quit') { stop(); return; }
    const now = clock();
    if (mode === 'loading') {
      const model = loadingModel(view.snapshot);
      if (story.skippable(model, now) && !model.failure) { startDeck(now); paint(); }
      else if (key === 'back') stop();
      return;
    }
    const card = current();
    if (!card) return;
    if (notes) {
      if (key === 'details' || key === 'back' || key === 'enter') notes = null;
      else if (key === 'left') notes.page = Math.max(0, notes.page - 1);
      else if (key === 'right') notes.page += 1;
      paint();
      return;
    }
    switch (key) {
      case 'details': notes = { page: 0 }; paint(); return;
      case 'back': return;
      case 'board': go(deck.length - 1); return;
      case 'share': share(); return;
      case 'left': go(index - 1); return;
      case 'right': case 'enter': {
        if (card.kind === 'guess') {
          const state = stateOf(card);
          if (state.guess === undefined) { state.guess = -1; state.guessAt = (now - enteredAt) * CARD_SPEED; paint(); return; }
        }
        go(index + 1);
        return;
      }
      default: {
        if (key.startsWith('guess') && card.kind === 'guess') {
          const choice = Number(key.slice(5)) - 1;
          const state = stateOf(card);
          if (state.guess === undefined && choice < card.data.options.length) { state.guess = choice; state.guessAt = (now - enteredAt) * CARD_SPEED; paint(); }
        }
      }
    }
  };
  stdin.on('data', onData);

  function share(): void {
    try {
      const svg = storyShareSvg(view.snapshot);
      if (!svg) { flash('nothing to share yet'); return; }
      const dir = options.shareDir ?? process.cwd();
      let file = path.join(dir, 'slopie-wrapped.svg');
      for (let n = 2; fs.existsSync(file) && n < 100; n++) file = path.join(dir, `slopie-wrapped-${n}.svg`);
      fs.writeFileSync(file, svg, { flag: 'wx' });
      flash(`saved ${path.basename(file)} · no project names, none of your words`, 2600);
    } catch (error) {
      flash(`couldn't save: ${error instanceof Error ? sanitize(error.message).slice(0, 60) : 'unknown error'}`);
    }
  }

  const onResize = () => {
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
    .then(() => schedule());

  try {
    await done;
  } finally {
    for (const timer of [scheduled, toastTimer, bannerTimer, blinkTimer]) if (timer) clearTimeout(timer);
    if (ticker) clearInterval(ticker);
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

export { fade };

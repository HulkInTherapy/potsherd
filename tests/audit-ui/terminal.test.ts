import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { AuditEvent, AuditSession, AuditSnapshot } from '../../packages/core/src/analytics/contracts.js';
import { decodeKey, runWallboard } from '../../packages/cli/src/audit-ui/terminal.js';
import { DiffRenderer, detectColorMode, lineToAnsi } from '../../packages/cli/src/audit-ui/renderer.js';
import { applyAuditEvent, applyPreviewInvalidation, applyPrivacyEvent } from '../../packages/cli/src/audit-ui/session-state.js';
import { readingSnapshot, readySnapshot, startingSnapshot } from './fixture.js';

class FakeIn extends EventEmitter {
  isTTY = true;
  raw = false;
  setRawMode(value: boolean) { this.raw = value; return this; }
  setEncoding() { return this; }
  resume() { return this; }
  pause() { return this; }
}

class FakeOut extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 24;
  chunks: string[] = [];
  flushed: string[] = [];
  write(chunk: string, callback?: () => void) {
    this.chunks.push(chunk);
    setImmediate(() => { this.flushed.push(chunk); callback?.(); });
    return true;
  }
  get text() { return this.chunks.join(''); }
}

function fakeSession(initial: AuditSnapshot) {
  let emit: (event: AuditEvent) => void = () => {};
  let finish: (snapshot: AuditSnapshot) => void = () => {};
  const session: AuditSession & { acks: string[] } = {
    acks: [],
    snapshot: () => initial,
    run: onEvent => new Promise(resolve => { emit = onEvent ?? (() => {}); finish = resolve; }),
    cancel: vi.fn(),
    prompts: vi.fn(),
    evidence: vi.fn(),
    classify: vi.fn(),
    acknowledgeTransfer(ackId) { this.acks.push(ackId); },
    dispose: vi.fn(),
  };
  return { session, emit: (event: AuditEvent) => emit(event), finish: (snapshot: AuditSnapshot) => finish(snapshot) };
}

const tick = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
const visible = (ansi: string) => ansi.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

describe('interactive wallboard', () => {
  it('paints at once, fills progressively, quits on q and restores the terminal', async () => {
    const stdin = new FakeIn();
    const stdout = new FakeOut();
    const { session, emit, finish } = fakeSession(startingSnapshot());
    const result = runWallboard(session, { io: { stdin: stdin as never, stdout: stdout as never }, motion: false });
    await tick(5);
    expect(stdout.text).toContain('\x1b[?1049h');
    expect(stdin.raw).toBe(true);
    expect(visible(stdout.text)).toContain('finding history');
    emit({ type: 'snapshot', snapshot: readingSnapshot() });
    await tick();
    expect(visible(stdout.text)).toContain('405 of 670');
    finish({ ...readySnapshot(), sequence: 20 });
    await tick();
    expect(visible(stdout.text)).toContain('Rotor-Notes');
    stdin.emit('data', 'q');
    const outcome = await result;
    expect(outcome.reason).toBe('quit');
    expect(stdout.text.endsWith('\x1b[?2004l\x1b[0m\x1b[?25h\x1b[?1049l')).toBe(true);
    expect(stdin.raw).toBe(false);
    expect(session.cancel).not.toHaveBeenCalled();
  });

  it('cancels unfinished work on quit and ignores pasted keys', async () => {
    const stdin = new FakeIn();
    const stdout = new FakeOut();
    const { session } = fakeSession(startingSnapshot());
    const result = runWallboard(session, { io: { stdin: stdin as never, stdout: stdout as never }, motion: false });
    stdin.emit('data', '\x1b[200~q?q\x1b[201~');
    stdin.emit('data', 'qqq');
    await tick();
    expect(session.cancel).not.toHaveBeenCalled();
    stdin.emit('data', '\x03');
    expect((await result).reason).toBe('cancelled');
    expect(session.cancel).toHaveBeenCalled();
  });

  it('turns pages with arrows, toggles details and redraws only changed rows', async () => {
    const stdin = new FakeIn();
    const stdout = new FakeOut();
    const { session, finish } = fakeSession(startingSnapshot());
    const result = runWallboard(session, { io: { stdin: stdin as never, stdout: stdout as never }, motion: false });
    await tick(5);
    finish({ ...readySnapshot(), sequence: 20 });
    await tick();
    stdin.emit('data', '\x1b[C');
    expect(visible(stdout.chunks.at(-1)!)).toContain('2/2');
    stdin.emit('data', '\x1b[C');
    expect(visible(stdout.chunks.at(-1)!)).toContain('last page');
    const before = stdout.chunks.length;
    stdin.emit('data', '?');
    expect(visible(stdout.chunks.at(-1)!)).toContain('WHAT THE NUMBERS MEAN');
    stdin.emit('data', '\x1b');
    expect(stdout.chunks.length).toBeGreaterThan(before);
    // A repaint with nothing changed writes nothing.
    const count = stdout.chunks.length;
    stdout.emit('resize');
    stdin.emit('data', 'x');
    expect(stdout.chunks.length).toBe(count + 1);
    stdin.emit('data', 'q');
    await result;
  });

  it('acknowledges a transfer only after the frame showing it is flushed', async () => {
    const stdin = new FakeIn();
    const stdout = new FakeOut();
    const initial = startingSnapshot();
    const { session, emit } = fakeSession(initial);
    const result = runWallboard(session, { io: { stdin: stdin as never, stdout: stdout as never }, motion: false });
    await tick(5);
    const notice = 'Selected redacted conversation text will be sent to OpenCode Zen and TypeSafe/Jev.';
    emit({ type: 'transfer', snapshotId: initial.snapshotId, sequence: 3, model: 'jev', recipients: ['OpenCode Zen', 'TypeSafe/Jev'], attempt: 1, selectedSegments: 1, notice, ackId: 'ack-1' });
    await tick(20);
    const painted = stdout.chunks.findIndex(chunk => visible(chunk).includes('TypeSafe/Jev.'));
    expect(painted).toBeGreaterThanOrEqual(0);
    await tick(30);
    expect(stdout.flushed.length).toBeGreaterThan(painted);
    expect(session.acks).toEqual(['ack-1']);
    // A duplicate never acknowledges twice.
    emit({ type: 'transfer', snapshotId: initial.snapshotId, sequence: 4, model: 'jev', recipients: ['OpenCode Zen'], attempt: 1, selectedSegments: 1, notice, ackId: 'ack-1' });
    await tick();
    expect(session.acks).toEqual(['ack-1']);
    stdin.emit('data', 'q');
    await result;
  });

  it('does not acknowledge a notice that cannot be shown in full', async () => {
    const stdin = new FakeIn();
    const stdout = new FakeOut();
    stdout.columns = 40;
    stdout.rows = 12;
    const initial = startingSnapshot();
    const { session, emit } = fakeSession(initial);
    const result = runWallboard(session, { io: { stdin: stdin as never, stdout: stdout as never }, motion: false });
    await tick(5);
    emit({ type: 'transfer', snapshotId: initial.snapshotId, sequence: 3, model: 'jev', recipients: ['Zen'], attempt: 1, selectedSegments: 1, notice: 'A long notice. '.repeat(20), ackId: 'ack-2' });
    await tick(80);
    expect(session.acks).toEqual([]);
    stdout.columns = 120;
    stdout.rows = 40;
    stdout.emit('resize');
    await tick(80);
    expect(session.acks).toEqual(['ack-2']);
    stdin.emit('data', 'q');
    await result;
  });
});

describe('keys, colours and diffing', () => {
  it('decodes only single, known keys', () => {
    expect(decodeKey('q')).toBe('quit');
    expect(decodeKey('\x03')).toBe('quit');
    expect(decodeKey('\x1b[C')).toBe('right');
    expect(decodeKey('\x1b[D')).toBe('left');
    expect(decodeKey('?')).toBe('details');
    expect(decodeKey('\x1b')).toBe('back');
    expect(decodeKey('quit')).toBeNull();
  });

  it('uses only the orange / white / gray palette and honours NO_COLOR', () => {
    expect(detectColorMode({ NO_COLOR: '1' })).toBe('none');
    expect(detectColorMode({ COLORTERM: 'truecolor' })).toBe('truecolor');
    const ansi = (['brand', 'accent', 'title', 'value', 'text', 'muted', 'faint'] as const).map(style => lineToAnsi([{ text: 'x', style }], 'truecolor')).join('');
    const colours = new Set([...ansi.matchAll(/38;2;(\d+;\d+;\d+)/g)].map(match => match[1]));
    expect([...colours].sort()).toEqual(['104;102;95', '166;162;155', '238;234;228', '242;164;94']);
    expect(lineToAnsi([{ text: 'x', style: 'brand' }], 'none')).toBe('\x1b[1mx\x1b[0m');
  });

  it('rewrites only rows that changed', () => {
    const renderer = new DiffRenderer('none');
    const a = [[{ text: 'one', style: 'text' as const }], [{ text: 'two', style: 'text' as const }]];
    renderer.frame(a);
    expect(renderer.frame(a)).toBe('');
    const b = [a[0]!, [{ text: 'TWO', style: 'text' as const }]];
    const out = renderer.frame(b);
    expect(out).toContain('\x1b[2;1HTWO');
    expect(out).not.toContain('one');
  });
});

describe('snapshot bookkeeping', () => {
  it('applies events in order and ignores stale or foreign ones', () => {
    const snapshot = readingSnapshot();
    expect(applyAuditEvent(snapshot, { type: 'snapshot', snapshot: { ...snapshot, sequence: 4 } })).toBe(snapshot);
    expect(applyAuditEvent(snapshot, { type: 'snapshot', snapshot: { ...snapshot, snapshotId: 'other', sequence: 99 } })).toBe(snapshot);
    const progressed = applyAuditEvent(snapshot, { type: 'progress', snapshotId: snapshot.snapshotId, sequence: 6, progress: { ...snapshot.progress, completed: 500 }, sources: snapshot.sources });
    expect(progressed.progress.completed).toBe(500);
  });

  it('clears the view on a privacy error and never revives it', () => {
    const snapshot = readySnapshot();
    const view = { snapshot, generation: 0, revoked: null };
    const cleared = applyPrivacyEvent(view, { type: 'error', snapshotId: snapshot.snapshotId, code: 'privacy_refresh_required', message: '' })!;
    expect(cleared.snapshot.launch?.facts).toBeNull();
    expect(cleared.snapshot.projects).toEqual([]);
    expect(cleared.revoked).toBe(cleared.snapshot);
    const late = applyPrivacyEvent(cleared, { type: 'snapshot', snapshot: { ...snapshot, sequence: 99 } })!;
    expect(late.snapshot).toBe(cleared.revoked);
    expect(applyPrivacyEvent(view, { type: 'error', snapshotId: snapshot.snapshotId, code: 'disk_full', message: '' })).toBeNull();
  });

  it('withdraws a revoked running subtotal without revoking final data', () => {
    const shown = readingSnapshot();
    shown.launch!.factProgress = { ...shown.launch!.factProgress!, representedSources: 10 };
    const next = { ...shown, sequence: 6, coverage: { ...shown.coverage, gapCodes: ['native_price_preview_revoked'] }, launch: { ...shown.launch!, facts: null, factProgress: { ...shown.launch!.factProgress!, representedSources: 0 } } };
    const result = applyPreviewInvalidation({ snapshot: shown, generation: 0, revoked: null }, { type: 'snapshot', snapshot: next })!;
    expect(result.snapshot.launch?.facts).toBeNull();
    expect(result.revoked).toBeNull();
  });
});

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { AuditEvent, AuditSession, AuditSnapshot } from '../../packages/core/src/analytics/contracts.js';
import { renderCard } from '../../packages/cli/src/audit-ui/cards/index.js';
import { tierFor } from '../../packages/cli/src/audit-ui/cards/scene.js';
import { Canvas } from '../../packages/cli/src/audit-ui/gfx/canvas.js';
import { C } from '../../packages/cli/src/audit-ui/gfx/color.js';
import { CellRenderer, detectCaps } from '../../packages/cli/src/audit-ui/gfx/screen.js';
import { LoadingStory, loadingModel } from '../../packages/cli/src/audit-ui/loading.js';
import { buildDeck, mask } from '../../packages/cli/src/audit-ui/story/deck.js';
import { runWallboard } from '../../packages/cli/src/audit-ui/terminal.js';
import { readySnapshot, startingSnapshot } from './fixture.js';
import { storyOfFixture, storyRecording, storySnapshot } from './story-fixture.js';

const SIZES = [[120, 40], [100, 30], [80, 24], [60, 20]] as const;

function render(card: ReturnType<typeof buildDeck>[number], w: number, h: number, t: number, deckLength: number, color: 'truecolor' | '16' | 'none' = 'truecolor') {
  const c = new Canvas(w, h, C.ink);
  const busy = renderCard({ c, w, h, t, tier: tierFor(w, h)!, caps: { color, motion: true, unicode: true }, blink: false, state: {}, index: 0, total: deckLength }, card);
  return { c, busy };
}

describe('story deck', () => {
  it('builds the story in spec order and ends with the board', () => {
    const kinds = buildDeck(storySnapshot()).map(card => card.kind);
    expect(kinds[0]).toBe('cold_open');
    expect(kinds.at(-1)).toBe('board');
    const order = ['cold_open', 'scale', 'bill', 'clock', 'guess', 'faceoff', 'mood', 'fuse', 'talk', 'manners', 'projects', 'delegation', 'then_now', 'archetype', 'awards', 'board'];
    const positions = order.map(kind => kinds.indexOf(kind as never));
    expect(positions.every(p => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('skips every card whose detector did not fire — never filler', () => {
    const snapshot = storySnapshot();
    const story = (snapshot.launch as unknown as { story: ReturnType<typeof storyOfFixture> }).story;
    story.cards = story.cards.filter(card => !['mood_drift', 'fuse_length', 'thanks_vs_swears', 'orchestrator', 'first_vs_latest'].includes(card.id));
    story.archetype = null;
    story.awards = [];
    const kinds = buildDeck({ ...snapshot } as AuditSnapshot).map(card => card.kind);
    for (const gone of ['mood', 'fuse', 'manners', 'delegation', 'then_now', 'archetype', 'awards']) expect(kinds).not.toContain(gone);
    expect(kinds).toContain('board');
  });

  it('falls back to totals for 1.7.x snapshots without a story', () => {
    const kinds = buildDeck(readySnapshot()).map(card => card.kind);
    expect(kinds).toContain('scale');
    expect(kinds).toContain('bill');
    expect(kinds.at(-1)).toBe('board');
    expect(kinds).not.toContain('archetype');
  });

  it('masks swears and refuses quotes that look like paths, links or keys', () => {
    expect(mask('what the fuck is this shit')).toBe('what the f*** is this s***');
    const snapshot = storySnapshot();
    const story = (snapshot.launch as unknown as { story: ReturnType<typeof storyOfFixture> }).story;
    story.coldOpen = { quote: 'look at /Users/someone/secret/thing.ts now', at: '2026-01-01T00:00:00Z', day: '2026-01-01', hour: 1, why: 'late_night' };
    story.highlights.mostExpensivePrompt!.quote = 'see https://example.com/x';
    story.highlights.firstPrompt!.quote = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
    const cold = buildDeck({ ...snapshot } as AuditSnapshot).find(card => card.kind === 'cold_open');
    expect(cold).toBeUndefined();
  });

  it('draws every card at every supported size without overflowing a cell', () => {
    const deck = buildDeck(storySnapshot());
    for (const [w, h] of SIZES) {
      for (const card of deck) {
        for (const t of [0, 180, 600, Infinity]) {
          const { c } = render(card, w, h, t, deck.length);
          for (const ch of c.ch) expect([...ch].length <= 2 && ch !== 'undefined').toBe(true);
        }
      }
    }
  });

  it('settles: every card stops animating within 3 seconds', () => {
    const deck = buildDeck(storySnapshot());
    for (const card of deck) expect(render(card, 120, 40, 3200, deck.length).busy).toBe(false);
  });

  it('keeps 16-colour and colourless output free of pixel-art mascots', () => {
    const deck = buildDeck(storySnapshot());
    const { c } = render(deck[1]!, 80, 24, Infinity, deck.length, 'none');
    expect(c.toText()).toContain('(•ᴗ•)');
  });
});

describe('loading story', () => {
  it('lights agents from progress detail and never shows invented counts', () => {
    const recording = storyRecording();
    const early = loadingModel(recording.initial);
    expect(early.counts.messages).toBeNull();
    const mid = recording.events.find(e => e.event.type === 'progress' && (e.event.progress as { detail?: { stage: string } }).detail?.stage === 'reading')!.event as Extract<AuditEvent, { type: 'progress' }>;
    const model = loadingModel({ ...recording.initial, progress: mid.progress, sources: mid.sources });
    expect(model.rows.map(row => [row.name, row.state])).toEqual([['Claude Code', 'found'], ['Codex', 'found'], ['pi', 'found'], ['OpenCode', 'absent']]);
    expect(model.rows[0]!.info).toMatch(/chats · since Dec 2025/);
    expect(model.stage).toBe('reading');
  });

  it('holds at least 2.4 s, then plays its outro once data is ready', () => {
    const story = new LoadingStory(0);
    const ready = loadingModel(storySnapshot());
    const c = new Canvas(120, 40, C.ink);
    const caps = { color: 'truecolor' as const, motion: true, unicode: true };
    story.render(c, ready, 100, caps, false);
    expect(story.done(100)).toBe(false);
    for (let t = 100; t <= 2500; t += 33) story.render(new Canvas(120, 40, C.ink), ready, t, caps, false);
    expect(story.done(2500)).toBe(true);
    const text = new Canvas(120, 40, C.ink);
    story.render(text, ready, 2500, caps, false);
    expect(text.toText()).toContain('ok. I know you now.');
    expect(text.toText()).toContain('nothing leaves this machine');
  });
});

describe('capabilities and rendering', () => {
  it('detects colour depth and reduced motion', () => {
    expect(detectCaps({ NO_COLOR: '1', COLORTERM: 'truecolor' })).toMatchObject({ color: 'none', motion: false });
    expect(detectCaps({ COLORTERM: 'truecolor' }).color).toBe('truecolor');
    expect(detectCaps({ TERM: 'xterm-256color' }).color).toBe('256');
    expect(detectCaps({ TERM: 'xterm' }).color).toBe('16');
    expect(detectCaps({ COLORTERM: 'truecolor' }, { motion: false }).motion).toBe(false);
    expect(detectCaps({ COLORTERM: 'truecolor', SLOPIE_REDUCED_MOTION: '1' }).motion).toBe(false);
  });

  it('writes one synchronized frame and nothing when nothing changed', () => {
    const renderer = new CellRenderer('truecolor');
    const a = new Canvas(20, 3, C.ink);
    a.text(0, 0, 'hello', { fg: C.orange });
    const first = renderer.frame(a);
    expect(first.startsWith('\x1b[?2026h')).toBe(true);
    expect(first.endsWith('\x1b[?2026l')).toBe(true);
    const same = new Canvas(20, 3, C.ink);
    same.text(0, 0, 'hello', { fg: C.orange });
    expect(renderer.frame(same)).toBe('');
    const changed = new Canvas(20, 3, C.ink);
    changed.text(0, 0, 'hellO', { fg: C.orange });
    const diff = renderer.frame(changed);
    expect(diff).toContain('O');
    expect(diff).not.toContain('hell');
  });
});

class FakeIn extends EventEmitter {
  isTTY = true;
  setRawMode() { return this; }
  setEncoding() { return this; }
  resume() { return this; }
  pause() { return this; }
}
class FakeOut extends EventEmitter {
  isTTY = true;
  columns = 120;
  rows = 40;
  chunks: string[] = [];
  write(chunk: string, callback?: () => void) { this.chunks.push(chunk); setImmediate(() => callback?.()); return true; }
}

describe('idle', () => {
  it('stops the 30 fps ticker once a card is still', async () => {
    let now = 0;
    let finish: (snapshot: AuditSnapshot) => void = () => {};
    const session = {
      snapshot: () => startingSnapshot(),
      run: () => new Promise<AuditSnapshot>(resolve => { finish = resolve; }),
      cancel: vi.fn(), prompts: vi.fn(), evidence: vi.fn(), classify: vi.fn(), dispose: vi.fn(),
    } as unknown as AuditSession;
    const stdin = new FakeIn();
    const stdout = new FakeOut();
    const prev = process.env['COLORTERM'];
    process.env['COLORTERM'] = 'truecolor';
    const result = runWallboard(session, { io: { stdin: stdin as never, stdout: stdout as never }, motion: true, now: () => now });
    await new Promise(resolve => setTimeout(resolve, 5));
    finish({ ...storySnapshot(), sequence: 20 });
    await new Promise(resolve => setTimeout(resolve, 20));
    now = 10_000;
    stdin.emit('data', 'b');
    now = 20_000; // every animation on the board has finished
    await new Promise(resolve => setTimeout(resolve, 120));
    const settled = stdout.chunks.length;
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(stdout.chunks.length).toBe(settled);
    stdin.emit('data', 'q');
    await result;
    if (prev === undefined) delete process.env['COLORTERM']; else process.env['COLORTERM'] = prev;
  });
});

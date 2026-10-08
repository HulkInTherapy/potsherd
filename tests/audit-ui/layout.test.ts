import { describe, expect, it } from 'vitest';
import { boardData } from '../../packages/cli/src/audit-ui/view-model.js';
import { buildBoard, buildDetails, lineWidth, pageText } from '../../packages/cli/src/audit-ui/layout.js';
import { detailLines } from '../../packages/cli/src/audit-ui/view-model.js';
import { cellWidth } from '../../packages/cli/src/audit-ui/text.js';
import { readingSnapshot, readySnapshot, startingSnapshot } from './fixture.js';

const SIZES = [[120, 40], [100, 30], [80, 24], [60, 20], [40, 12]] as const;
const CARDS = ['models', 'projects', 'activity', 'repeats', 'reactions', 'swears'];

describe('wallboard layout', () => {
  for (const [columns, rows] of SIZES) {
    it(`fills exactly ${columns}x${rows} on every page, never wider, every card reachable`, () => {
      for (const snapshot of [startingSnapshot(), readingSnapshot(), readySnapshot()]) {
        const board = buildBoard(boardData(snapshot), { columns, rows, frame: 3 });
        for (const page of board.pages) {
          expect(page).toHaveLength(rows);
          for (const line of page) expect(lineWidth(line)).toBeLessThanOrEqual(columns);
        }
        expect(board.cards.flat().sort()).toEqual([...CARDS].sort());
      }
    });
  }

  it('fits on one screen at 120x40 and 100x30; pages only on small terminals', () => {
    const data = boardData(readySnapshot());
    expect(buildBoard(data, { columns: 120, rows: 40 }).pages).toHaveLength(1);
    expect(buildBoard(data, { columns: 100, rows: 30 }).pages).toHaveLength(1);
    const small = buildBoard(data, { columns: 80, rows: 24 });
    expect(small.pages.length).toBeGreaterThan(1);
    expect(pageText(small.pages[0]!)).toContain('← 1/');
    expect(pageText(buildBoard(data, { columns: 120, rows: 40 }).pages[0]!)).not.toContain('1/');
  });

  it('shows the hero in block digits, the key stats and a personality line', () => {
    const text = pageText(buildBoard(boardData(readySnapshot()), { columns: 120, rows: 40 }).pages[0]!);
    expect(text).toContain('█▀█'); // block digits
    expect(text).toContain('10.1B tokens');
    expect(text).toContain('975 prompts');
    expect(text).toContain('490 chats');
    expect(text).toContain('121 projects');
    expect(text).toContain('~$662');
    expect(text).toContain('what your tokens would cost at API prices');
    expect(text).toContain('Claude Opus 5 is your ride-or-die: 40% of every token.');
  });

  it('keeps internal jargon and gap codes off the board', () => {
    for (const snapshot of [startingSnapshot(), readingSnapshot(), readySnapshot()]) {
      for (const [columns, rows] of SIZES) {
        for (const page of buildBoard(boardData(snapshot), { columns, rows }).pages) {
          const text = pageText(page);
          expect(text).not.toMatch(/[a-z]+_[a-z]+_[a-z]+/); // snake_case codes
          expect(text).not.toMatch(/policy|pending|unavailable|canonical|subtotal/i);
        }
      }
    }
  });

  it('uses the same skeleton while loading and keeps unknowns as dashes', () => {
    const text = pageText(buildBoard(boardData(startingSnapshot()), { columns: 100, rows: 30, frame: 0 }).pages[0]!);
    expect(text).toContain('░');
    expect(text).toContain('— tokens');
    expect(text).toContain('— prompts');
    expect(text).toContain('finding history');
    expect(text).not.toMatch(/\$0\b/);
  });

  it('shows live progress and a running subtotal while reading', () => {
    const text = pageText(buildBoard(boardData(readingSnapshot()), { columns: 120, rows: 40, frame: 2 }).pages[0]!);
    expect(text).toContain('reading history files 405 of 670 files');
    expect(text).toContain('60%');
    expect(text).toContain('so far');
  });

  it('keeps cards in the same rows while data arrives (no layout jump)', () => {
    const rowOf = (snapshot: ReturnType<typeof readySnapshot>, title: string) =>
      pageText(buildBoard(boardData(snapshot), { columns: 120, rows: 40 }).pages[0]!).split('\n').findIndex(line => line.includes(title));
    for (const title of ['MODELS', 'WHEN YOU CODE']) expect(rowOf(startingSnapshot(), title)).toBe(rowOf(readingSnapshot(), title));
  });

  it('asks for a bigger window below 40x12 but still says how to quit', () => {
    const board = buildBoard(boardData(readySnapshot()), { columns: 30, rows: 8 });
    expect(board.pages).toHaveLength(1);
    expect(board.pages[0]).toHaveLength(8);
    expect(pageText(board.pages[0]!).replace(/\s+/g, ' ')).toContain('q quits');
  });

  it('draws a transfer notice in full or not at all', () => {
    const data = boardData(readySnapshot());
    const notice = 'Selected redacted conversation text will be sent to OpenCode Zen and TypeSafe/Jev.';
    const shown = buildBoard(data, { columns: 80, rows: 24, banner: notice });
    expect(shown.bannerRows).toBeGreaterThan(0);
    expect(pageText(shown.pages[0]!).replace(/\s+/g, ' ')).toContain(notice);
    const tooSmall = buildBoard(data, { columns: 40, rows: 12, banner: notice.repeat(4) });
    expect(tooSmall.bannerRows).toBe(0);
  });

  it('renders ASCII-only output on request', () => {
    for (const page of buildBoard(boardData(readySnapshot()), { columns: 100, rows: 30, ascii: true }).pages) {
      expect([...pageText(page)].every(char => char.charCodeAt(0) < 128)).toBe(true);
    }
  });

  it('sanitises terminal control sequences in names', () => {
    const snapshot = readySnapshot();
    snapshot.projects[0]!.displayName = 'evil\x1b]52;c;c2VudGluZWw=\x07\x1b[2J\x1b[31mred\x1b[0m\nname';
    const text = pageText(buildBoard(boardData(snapshot), { columns: 120, rows: 40 }).pages[0]!);
    expect(text).not.toContain('\x1b');
    expect(text).toContain('evilred name');
  });

  it('pages the details view instead of scrolling it', () => {
    const snapshot = readySnapshot();
    const pages = buildDetails(boardData(snapshot), detailLines(snapshot), { columns: 60, rows: 20 });
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page).toHaveLength(20);
      for (const line of page) expect(cellWidth(line.map(part => part.text).join(''))).toBeLessThanOrEqual(60);
    }
    const all = pages.map(pageText).join('\n');
    expect(all).toContain('not a bill');
    expect(all).toContain('pricing coverage partial');
    expect(all).toContain('Nothing left this machine');
  });
});

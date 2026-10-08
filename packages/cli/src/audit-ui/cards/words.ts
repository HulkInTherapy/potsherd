/** Cold open (typewriter quote), how-you-talk tiles, the manners balance scale, then vs now. */
import { C, fade, mix } from '../gfx/color.js';
import { box, drawSpans, pxLine, rich, spaced, textCenter, textRight, textWidth, wrapSpans, wrapText, type Rect } from '../gfx/draw.js';
import { bigHeight, bigWidth, drawBig } from '../gfx/font.js';
import { countUp, easeOutBack, easeOutCubic, seg, spring } from '../gfx/motion.js';
import { count, shortDate } from '../format.js';
import type { DeckCard } from '../story/deck.js';
import type { Scene } from './scene.js';

type Data<K extends DeckCard['kind']> = Extract<DeckCard, { kind: K }>['data'];

/* ── cold open ── */

export function coldOpenBody(s: Scene, data: Data<'cold_open'>, r: Rect): boolean {
  const { c, t, tier } = s;
  const width = Math.min(r.w - 12, tier.id === 'L' ? 56 : 48);
  const lines = wrapSpans(rich(data.quote, { fg: C.cream, bold: true, italic: true }, { fg: C.cream, bold: true, italic: true }), width).slice(0, 4);
  const chars = lines.reduce((sum, line) => sum + line.reduce((n, sp) => n + [...sp.text].length, 0), 0);
  const perChar = Math.min(32, 1500 / Math.max(1, chars));
  const typed = s.caps.motion ? Math.floor(Math.max(0, t - 350) / perChar) : Infinity;
  const blockH = lines.length + 4;
  const y0 = r.y + Math.max(0, Math.floor((r.h - blockH) / 2) - 1);
  const x0 = r.x + Math.floor((r.w - width) / 2);
  // Oversized opening quote mark.
  const qa = seg(t, 0, 300);
  if (x0 - 9 < 0) { /* no room for the oversized mark */ }
  else if (s.caps.color !== 'none' && s.caps.color !== '16') {
    // A fat opening quote mark: two pixel commas.
    const mark = ['.##..##', '#...#..', '##..##.', '##..##.'];
    mark.forEach((row, py) => { for (let px = 0; px < row.length; px++) if (row[px] === '#') c.px(x0 - 9 + px, y0 * 2 - 1 + py, fade(C.orange, qa)); });
  } else c.text(x0 - 3, y0, '“', { fg: C.orange, bold: true });
  let left = typed;
  let cursor: [number, number] | null = null;
  lines.forEach((line, i) => {
    const n = line.reduce((sum, sp) => sum + [...sp.text].length, 0);
    const w = drawSpans(c, x0, y0 + i, line, 1, left);
    if (left < n && cursor === null) cursor = [x0 + w, y0 + i];
    left -= n;
  });
  const doneAt = 350 + chars * perChar;
  if (cursor && Math.floor(t / 280) % 2 === 0) c.put(cursor[0], cursor[1], s.caps.unicode ? '▌' : '_', C.orange);
  const sa = seg(t, doneAt + 150, 400);
  c.text(x0, y0 + lines.length + 1, `— ${data.stamp}`, { fg: C.gray, alpha: sa });
  const ca = seg(t, doneAt + 550, 500);
  wrapText(data.caption, width, 2).forEach((line, i) => c.text(x0, y0 + lines.length + 3 + i, line, { fg: C.peach, italic: true, alpha: ca }));
  return t < doneAt + 1100;
}

/* ── how you talk ── */

export function talkBody(s: Scene, data: Data<'talk'>, r: Rect): boolean {
  const { c, t, tier } = s;
  const tiles = data.tiles;
  const cols = tier.id === 'S' ? 1 : 2;
  const rows = Math.ceil(tiles.length / cols);
  const gap = 2;
  const tileW = Math.floor((r.w - (cols - 1) * gap) / cols);
  const tileH = Math.max(3, Math.min(tier.id === 'L' ? 8 : 5, Math.floor((r.h - (rows - 1)) / rows)));
  let busy = false;
  tiles.forEach((tile, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = r.x + col * (tileW + gap);
    const yBase = r.y + row * (tileH + 1);
    if (yBase + tileH > r.y + r.h + 1) return;
    const k = seg(t, 80 + i * 140, 420, easeOutCubic);
    busy ||= k < 1;
    const y = yBase + Math.round((1 - k) * 1);
    const a = k;
    const big = tileH >= 7;
    if (tileH >= 5) box(c, { x, y, w: tileW, h: tileH }, fade(i === 0 ? C.rust : C.coal, a), { ascii: !s.caps.unicode });
    const ix = tileH >= 5 ? x + 2 : x;
    const iw = tileW - (tileH >= 5 ? 4 : 0);
    const ly = tileH >= 5 ? y + 1 : y;
    c.text(ix, ly, tier.id === 'L' ? spaced(tile.label) : tile.label, { fg: C.gray, alpha: a }, iw);
    const countText = tile.count !== null ? `×${count(tile.count)}` : '';
    const countW = big ? bigWidth(countText) : textWidth(countText);
    const phraseW = iw - countW - 3;
    const phrase = tile.quoted ? `“${tile.text}”` : tile.text;
    const py = big ? y + 3 : ly + 1;
    const lines = wrapText(phrase, phraseW, big ? 2 : 1);
    lines.forEach((line, li) => {
      // Quote marks in orange, words in cream.
      let cx = ix;
      for (const ch of line) cx += c.text(cx, py + li, ch, { fg: ch === '“' || ch === '”' ? C.orange : C.cream, bold: true, alpha: a });
    });
    if (tile.sub && tileH >= 6) c.text(ix, y + tileH - 2, tile.sub, { fg: C.slate, alpha: a }, iw);
    if (countText) {
      const value = tile.count !== null && s.caps.motion ? `×${count(Math.round(countUp(tile.count, t, 80 + i * 140, 800)))}` : countText;
      if (big) drawBig(c, ix + iw - bigWidth(value), y + 3, value, { color: (_x, py2) => fade(mix(C.peach, C.orange, py2 / 4), a) });
      else textRight(c, ix + iw, py, value, { fg: C.orange, bold: true, alpha: a });
    }
  });
  return busy || t < 1100;
}

/* ── manners balance ── */

export function mannersBody(s: Scene, data: Data<'manners'>, r: Rect): boolean {
  const { c, t, tier } = s;
  const pixel = s.caps.color !== 'none';
  const cx = r.x + Math.floor(r.w / 2);
  const arm = Math.min(tier.id === 'L' ? 28 : 20, Math.floor(r.w / 2) - 10);
  const total = data.kind + data.rude || 1;
  const lean = (data.rude - data.kind) / total; // >0: rude side (right) is heavier
  const swing = s.caps.motion ? spring(Math.max(0, t - 450) / 1000, 1.4, 0.32) : 1;
  const tilt = Math.round(lean * 5 * swing);
  const small = r.h < 17;
  const top = r.y + (small ? 0 : 1);
  const beamY = top * 2 + 3; // pixel row of the pivot
  const strings = small ? 5 : 9;
  const floorY = beamY + strings + (small ? 7 : 11);
  if (pixel) {
    for (let py = beamY; py <= floorY; py++) { c.px(cx, py, C.slate); }
    for (let k = -5; k <= 5; k++) c.px(cx + k, floorY, C.slate);
    for (let k = -3; k <= 3; k++) c.px(cx + k, floorY - 1, C.slate);
    pxLine(c, cx - arm, beamY - tilt, cx + arm, beamY + tilt, C.gray);
    c.px(cx, beamY - 1, C.cream);
    c.px(cx, beamY - 2, C.peach);
  }
  const pan = (side: -1 | 1, value: number, label: string, color: number, delay: number) => {
    const ex = cx + side * arm;
    const ey = beamY + side * tilt;
    const plateY = ey + strings;
    if (pixel) {
      pxLine(c, ex, ey, ex - 7, plateY - 1, C.slate);
      pxLine(c, ex, ey, ex + 7, plateY - 1, C.slate);
      for (let k = -8; k <= 8; k++) c.px(ex + k, plateY, color);
      for (let k = -6; k <= 6; k++) c.px(ex + k, plateY + 1, mix(color, C.ink, 0.45));
      // A little pile of words on the plate: more weight, taller pile.
      const pile = Math.max(1, Math.min(small ? 3 : 5, Math.round(Math.log2(value + 1) * (small ? 0.5 : 0.75))));
      const grown = s.caps.motion ? Math.round(pile * seg(t, delay, 700)) : pile;
      for (let level = 0; level < grown; level++) {
        const half = Math.max(1, 6 - level * 1.3);
        for (let k = -Math.floor(half); k <= Math.floor(half); k++) {
          const tone = (k + level) % 3 === 0 ? C.cream : (k + level) % 3 === 1 ? color : mix(color, C.cream, 0.4);
          c.px(ex + k, plateY - 1 - level, tone);
        }
      }
    }
    const a = seg(t, delay, 300);
    const shown = s.caps.motion ? Math.round(countUp(value, t, delay, 900)) : value;
    const text = count(shown);
    const ny = Math.floor(plateY / 2) + 2;
    if (!small) drawBig(c, ex - Math.floor(bigWidth(count(value)) / 2), ny, text, { color: (_x, py) => fade(mix(C.cream, color, py / 4), a) });
    else textCenter(c, ex, ny, text, { fg: color, bold: true, alpha: a });
    textCenter(c, ex, ny + (small ? 1 : bigHeight() + 1), label, { fg: C.gray, alpha: a });
  };
  pan(-1, data.kind, data.kindLabel, C.peach, 150);
  pan(1, data.rude, data.rudeLabel, C.ember, 300);
  const ratio = data.kind > 0 ? data.rude / data.kind : null;
  const ry = Math.floor(floorY / 2) + 2;
  if (ratio !== null && ry < r.y + r.h) {
    const a = seg(t, 1300, 400);
    const text = ratio >= 1 ? `${ratio.toFixed(ratio >= 10 ? 0 : 1)} swears for every kind word` : `${(1 / ratio).toFixed(1)} kind words for every swear`;
    textCenter(c, cx, Math.min(r.y + r.h - 1, ry), text, { fg: ratio >= 1 ? C.orange : C.peach, bold: true, alpha: a });
  }
  void easeOutBack;
  return t < 2300;
}

/* ── then vs now ── */

export function thenNowBody(s: Scene, data: Data<'then_now'>, r: Rect): boolean {
  const { c, t, tier } = s;
  const gap = tier.id === 'S' ? 2 : 8;
  const bw = Math.floor((r.w - gap) / 2);
  const maxWords = Math.max(data.then.words, data.now.words, 1);
  const gridRows = Math.max(1, Math.min(tier.id === 'L' ? 8 : 4, r.h - 9));
  const bubble = (x: number, label: string, day: string, words: number, quote: string | null, shell: boolean, color: number, accent: number, a: number, start: number) => {
    c.text(x, r.y, tier.id === 'L' ? spaced(label) : label, { fg: accent, bold: true, alpha: a });
    c.text(x + (tier.id === 'L' ? textWidth(spaced(label)) : textWidth(label)) + 2, r.y, shortDate(day, true), { fg: C.slate, alpha: a });
    const text = quote ? `“${quote}”` : shell ? 'a terminal command, typed into a chat box' : `${count(words)} words`;
    const lines = wrapText(text, bw - 4, 3);
    const h = lines.length + 2;
    box(c, { x, y: r.y + 2, w: bw, h }, fade(accent, a * 0.8), { ascii: !s.caps.unicode });
    if (r.y + 2 + h < r.y + r.h) c.put(x + 3, r.y + 2 + h, s.caps.unicode ? '╲' : '\\', fade(accent, a * 0.8));
    lines.forEach((line, i) => c.text(x + 2, r.y + 3 + i, line, { fg: color, italic: Boolean(quote), alpha: a }));
    // One pixel per word you typed: the length difference, made visible.
    const gy = r.y + 3 + h;
    if (gy >= r.y + r.h) return;
    const wordsW = c.text(x + 5, gy, `${count(words)} words`, { fg: accent, bold: true, alpha: a });
    void wordsW;
    const capacity = bw * gridRows;
    const per = Math.max(1, Math.ceil(maxWords / capacity));
    const dots = Math.ceil(words / per);
    const shown = s.caps.motion ? Math.round(dots * seg(t, start, 900, easeOutCubic)) : dots;
    if (gy + 1 + gridRows <= r.y + r.h) {
      for (let i = 0; i < shown; i++) {
        const px = i % bw, py = Math.floor(i / bw);
        c.put(x + px, gy + 1 + py, s.caps.unicode ? '▪' : '.', (i * 7 + py) % 9 === 0 ? mix(accent, C.cream, 0.4) : accent);
      }
      if (per > 1) c.text(x + 5 + wordsW + 2, gy, `(each ${s.caps.unicode ? '▪' : '.'} = ${per} words)`, { fg: C.slate, alpha: a });
    }
  };
  const la = seg(t, 0, 350);
  bubble(r.x, 'THEN', data.then.day, data.then.words, data.then.quote, data.then.shell, C.gray, C.slate, la, 200);
  const ra = seg(t, 550, 450, easeOutCubic);
  const slide = Math.round((1 - ra) * 6);
  bubble(r.x + bw + gap + slide, 'NOW', data.now.day, data.now.words, data.now.quote, false, C.cream, C.orange, ra, 700);
  const ma = seg(t, 300, 400);
  const mid = r.x + bw + Math.floor(gap / 2) - 1;
  if (gap >= 6) c.text(mid - 1, r.y + 3, s.caps.unicode ? '──▶' : '-->', { fg: C.slate, alpha: ma });
  const fy = r.y + r.h - 1;
  if (fy > r.y + 9 + gridRows) {
    const ga = seg(t, 1200, 400);
    textCenter(c, r.x + r.w / 2, fy, `${count(data.spanDays)} days and ${count(data.prompts)} prompts apart · ${(data.now.words / Math.max(1, data.then.words)).toFixed(1)}× the words`, { fg: C.gray, alpha: ga });
  }
  return t < 1700;
}

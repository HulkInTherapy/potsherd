/** Scale (block-digit counters) and The Bill (a receipt that prints line by line). */
import { C, fade, hx, mix } from '../gfx/color.js';
import { hbar, spaced, textCenter, textRight, textWidth, type Rect } from '../gfx/draw.js';
import { bigHeight, bigWidth, drawBig } from '../gfx/font.js';
import { countUp, easeOutCubic, seg } from '../gfx/motion.js';
import { compact, count, money, shortDate } from '../format.js';
import type { Counter, DeckCard } from '../story/deck.js';
import type { Scene } from './scene.js';

type Data<K extends DeckCard['kind']> = Extract<DeckCard, { kind: K }>['data'];

export const warmGradient = (scale: number) => (_x: number, py: number) => mix(C.cream, C.orange, Math.min(1, py / (5 * scale - 1)));

function counterText(counter: Counter, value: number): string {
  if (counter.style === 'compact') return compact(value).replace('—', '0');
  return count(Math.round(value));
}

export function scaleBody(s: Scene, data: Data<'scale'>, r: Rect): boolean {
  const { c, t } = s;
  // Too short for a 2×2 grid: keep the two biggest counters in one row.
  const counters = r.h < 9 && data.counters.length > 2 && s.tier.id === 'S' ? data.counters.slice(0, 2) : data.counters;
  const finals = counters.map(k => counterText(k, k.value));
  const gap = 4;
  const label = (text: string) => (s.tier.id === 'L' ? spaced(text) : text);
  const rowFits = (scale: number) => finals.reduce((sum, f, i) => sum + Math.max(bigWidth(f, scale), textWidth(label(counters[i]!.label))), 0) + (gap + 2) * (counters.length - 1) <= r.w;
  let layout: { scale: number; cols: number };
  if (s.tier.id === 'L' && r.h >= 16 && counters.length >= 3) layout = { scale: 2, cols: 2 };
  else if (rowFits(1) && r.h >= 5) layout = { scale: 1, cols: counters.length };
  else layout = { scale: 1, cols: 2 };
  const { scale, cols } = layout;
  const cellW = Math.floor((r.w + gap) / cols) - gap;
  const blockH = bigHeight(scale) + 2;
  const rows = Math.ceil(counters.length / cols);
  const rowGap = layout.scale === 2 ? 2 : 1;
  const totalH = rows * blockH + (rows - 1) * rowGap;
  const y0 = r.y + Math.max(0, Math.floor((r.h - totalH) / 2) - (s.tier.id === 'L' ? 1 : 0));
  let busy = false;
  // In a single row, columns are as wide as their content and the slack goes into the gaps.
  const widths = finals.map((f, i) => Math.max(bigWidth(f, scale), textWidth(label(counters[i]!.label))));
  const slack = cols === counters.length && cols > 1 ? Math.max(3, Math.floor((r.w - widths.reduce((a, b) => a + b, 0)) / (cols - 1))) : 0;
  const xs = widths.map((_, i) => r.x + widths.slice(0, i).reduce((a, b) => a + b, 0) + slack * i);
  counters.forEach((counter, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = cols === counters.length && cols > 1 ? xs[i]! : r.x + col * (cellW + gap);
    const y = y0 + row * (blockH + rowGap);
    const start = i * 170;
    const k = seg(t, start, 950);
    busy ||= k < 1;
    const value = s.caps.motion ? countUp(counter.value, t, start, 950) : counter.value;
    const text = counterText(counter, value);
    const a = seg(t, start, 200);
    if (a <= 0) return;
    const glow = k < 1 ? 0.25 * (1 - k) : 0;
    drawBig(c, x, y, text, { scale, color: (px, py) => fade(mix(warmGradient(scale)(px, py), C.cream, glow), a) });
    c.text(x, y + bigHeight(scale) + (scale === 2 ? 1 : 0), label(counter.label), { fg: C.gray, alpha: a }, cellW);
  });
  return busy;
}

/* ── The Bill ─────────────────────────────────────────────────────────────── */

const PAPER = hx('fbf1e4');
const INK = hx('2a2522');
const FAINT = hx('8c8279');

export function billBody(s: Scene, data: Data<'bill'>, r: Rect): boolean {
  const { c, t, tier } = s;
  const paper = s.caps.color === 'truecolor' || s.caps.color === '256';
  const RW = Math.min(r.w, tier.id === 'L' ? 46 : tier.id === 'M' ? 40 : 42);
  const side = r.w - RW - 4 >= 26 && tier.id !== 'S';
  const x0 = side ? r.x : r.x + Math.floor((r.w - RW) / 2);
  // Content rows (without the torn edges).
  const bigScale = 1;
  type Row = { kind: 'title' | 'sub' | 'sep' | 'item' | 'total' | 'pricey' | 'thanks'; text?: string; value?: string };
  const fixed: Row[] = [{ kind: 'title' }, { kind: 'sub' }, { kind: 'sep' }];
  const tail: Row[] = [{ kind: 'sep' }, { kind: 'total' }, { kind: 'sep' }];
  const optional: Row[] = [];
  if (data.priciest) optional.push({ kind: 'pricey' });
  optional.push({ kind: 'thanks' });
  const totalRows = (rows: Row[]) => rows.reduce((sum, row) => sum + (row.kind === 'total' ? bigHeight(bigScale) : 1), 0) + 2;
  let items: Row[] = data.lines.map(line => ({ kind: 'item', text: line.name, value: money(line.value) }));
  if (data.more > 0) items.push({ kind: 'item', text: 'everything else', value: money(data.more) });
  let rows: Row[] = [...fixed, ...items, ...tail, ...optional];
  while (totalRows(rows) > r.h && optional.length) { optional.pop(); rows = [...fixed, ...items, ...tail, ...optional]; }
  if (totalRows(rows) > r.h) { fixed.splice(1, 1); rows = [...fixed, ...items, ...tail, ...optional]; }
  while (totalRows(rows) > r.h && items.length > 1) { items = items.slice(0, -1); rows = [...fixed, ...items, ...tail, ...optional]; }
  // Last resort on tiny screens: drop the title and the separators around the total.
  if (totalRows(rows) > r.h) rows = rows.filter(row => row.kind !== 'title');
  while (totalRows(rows) > r.h && rows.some(row => row.kind === 'sep')) rows.splice(rows.findIndex(row => row.kind === 'sep'), 1);

  const height = totalRows(rows);
  const y0 = r.y + Math.max(0, Math.floor((r.h - height) / 2));
  const perRow = 60;
  const revealed = s.caps.motion ? Math.floor(t / perRow) : Infinity;
  const busy = revealed < height + 14;
  const ink = paper ? INK : C.cream;
  const faint = paper ? FAINT : C.gray;
  const bg = paper ? PAPER : undefined;

  // Printer slot above the paper.
  if (tier.id !== 'S' && y0 > r.y) for (let x = -1; x <= RW; x++) c.put(x0 + x, y0 - 1, s.caps.unicode ? '▄' : '_', C.coal);

  const edge = (y: number, top: boolean) => {
    for (let x = 0; x < RW; x++) {
      if (!paper) { c.put(x0 + x, y, s.caps.unicode ? '┄' : '-', C.slate); continue; }
      const tooth = x % 2 === 0;
      c.put(x0 + x, y, top ? (tooth ? '█' : '▄') : (tooth ? '▀' : ' '), PAPER, undefined);
    }
  };
  let y = y0;
  let shown = 0;
  const show = () => shown++ < revealed;
  if (show()) edge(y, true);
  y++;
  const line = (text: string) => { c.fill(x0, y, RW, 1, ' ', { bg: bg ?? -1 }); return text; };
  for (const row of rows) {
    const h = row.kind === 'total' ? bigHeight(bigScale) : 1;
    if (!(shown < revealed)) break;
    shown += h;
    for (let k = 0; k < h; k++) c.fill(x0, y + k, RW, 1, ' ', { bg: bg ?? -1 });
    const pad = 3;
    const inner = RW - pad * 2;
    switch (row.kind) {
      case 'title':
        textCenter(c, x0 + RW / 2, y, line(s.caps.unicode ? '✦ SLOPIE AGENT CO. ✦' : '* SLOPIE AGENT CO. *'), { fg: ink, bold: true, bg });
        break;
      case 'sub':
        textCenter(c, x0 + RW / 2, y, 'at API list prices · not a bill', { fg: faint, bg });
        break;
      case 'sep':
        for (let x = 0; x < inner; x++) c.put(x0 + pad + x, y, x % 2 ? ' ' : '-', faint, bg);
        break;
      case 'item': {
        const value = row.value!;
        const nameMax = inner - textWidth(value) - 2;
        const name = c.text(x0 + pad, y, row.text!, { fg: ink, bg }, nameMax);
        for (let x = x0 + pad + name + 1; x < x0 + pad + inner - textWidth(value) - 1; x++) c.put(x, y, '.', faint, bg);
        textRight(c, x0 + pad + inner, y, value, { fg: ink, bold: true, bg });
        break;
      }
      case 'total': {
        c.text(x0 + pad, y + 1, 'TOTAL', { fg: ink, bold: true, bg });
        const begin = (shown - h) * perRow;
        const value = s.caps.motion ? countUp(data.total, t, begin, 750) : data.total;
        const text = money(value);
        drawBig(c, x0 + pad + inner - bigWidth(text, bigScale), y, text, { scale: bigScale, color: () => (paper ? C.ember : C.orange) });
        break;
      }
      case 'pricey': {
        const p = data.priciest!;
        c.text(x0 + pad, y, 'priciest sentence', { fg: faint, bg });
        textRight(c, x0 + pad + inner, y, `${shortDate(p.day)}  ${money(p.cost)}`, { fg: ink, bold: true, bg });
        break;
      }
      case 'thanks':
        textCenter(c, x0 + RW / 2, y, 'thank you for prompting', { fg: faint, italic: true, bg });
        break;
    }
    y += h;
  }
  if (shown < revealed) edge(y, false);

  if (side) {
    const sx = x0 + RW + 5;
    const sw = r.x + r.w - sx;
    const a = seg(t, 500, 400);
    let sy = y0 + 1;
    if (data.byAgent.length) {
      c.text(sx, sy, s.tier.id === 'L' ? spaced('by agent') : 'BY AGENT', { fg: C.gray, alpha: a });
      sy += 2;
      const nameW = Math.max(...data.byAgent.map(row => textWidth(row.name)));
      for (const [i, row] of data.byAgent.slice(0, 4).entries()) {
        const k = seg(t, 600 + i * 120, 600, easeOutCubic);
        c.text(sx, sy, row.name, { fg: C.cream, alpha: a });
        const pct = `${Math.round(row.share * 100)}%`;
        const barW = Math.max(4, sw - nameW - 8);
        hbar(c, sx + nameW + 2, sy, barW, row.share * k, i === 0 ? C.orange : fade(C.orange, 0.6), !s.caps.unicode);
        textRight(c, sx + sw, sy, row.share < 0.01 ? '<1%' : pct, { fg: C.gray, alpha: a });
        sy += 2;
      }
      sy += 1;
    }
    if (data.priciest && sy + 4 < r.y + r.h) {
      const b = seg(t, 900, 400);
      c.text(sx, sy, s.tier.id === 'L' ? spaced('one sentence') : 'ONE SENTENCE', { fg: C.gray, alpha: b });
      drawBig(c, sx, sy + 2, money(data.priciest.cost).replace(/\.\d+$/, ''), { color: (_x, py) => fade(mix(C.peach, C.ember, py / 4), b) });
      c.text(sx, sy + 6, `${shortDate(data.priciest.day)}${data.priciest.model ? ` · ${data.priciest.model}` : ''}`, { fg: C.slate, alpha: b }, sw);
    }
    return busy || a < 1;
  }
  return busy;
}

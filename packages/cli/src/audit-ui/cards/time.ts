/** Your clock (weekday × hour sunrise heatmap), the mood timeline, and the fuse. */
import { C, fade, heat, mix } from '../gfx/color.js';
import { spaced, textCenter, textRight, textWidth, vbar, type Rect } from '../gfx/draw.js';
import { bigWidth, drawBig } from '../gfx/font.js';
import { clamp01, easeOutBack, easeOutCubic, seg, spring } from '../gfx/motion.js';
import { monthLabel, type DeckCard } from '../story/deck.js';
import type { Scene } from './scene.js';

type Data<K extends DeckCard['kind']> = Extract<DeckCard, { kind: K }>['data'];

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** The 7×24 grid. Returns the drawn width. Also used (static, small) by the board. */
export function drawHeatmap(s: Scene, grid: number[][], x: number, y: number, cellW: number, options: { t: number; labels?: boolean; peak?: [number, number] | null; axis?: boolean; tall?: boolean }): { w: number; busy: boolean } {
  const { c } = s;
  const max = Math.max(1, ...grid.flat());
  const labelW = options.labels === false ? 0 : 4;
  const t = options.t;
  let busy = false;
  const rowStep = options.tall ? 2 : 1;
  for (let d = 0; d < 7; d++) {
    const ry = y + d * rowStep;
    if (options.labels !== false) c.text(x, ry, DAYS[d]!, { fg: d >= 5 ? C.slate : C.gray });
    for (let h = 0; h < 24; h++) {
      const a = seg(t, 120 + h * 38, 260);
      busy ||= a < 1;
      const v = Math.sqrt((grid[d]?.[h] ?? 0) / max);
      let color = heat(0.12 + v * 0.88);
      const isPeak = options.peak && options.peak[0] === d && options.peak[1] === h;
      if (isPeak) {
        const p = seg(t, 120 + 24 * 38 + 150, 650, k => k);
        busy ||= p < 1;
        color = mix(color, C.white, Math.sin(Math.PI * p) * 0.8);
      }
      const cx = x + labelW + h * cellW;
      const glyph = s.caps.unicode ? (options.tall ? '█' : '▀') : '#';
      const fg = s.caps.color === 'none' ? C.cream : fade(color, a);
      for (let k = 0; k < cellW - 1; k++) {
        if (s.caps.color === 'none') c.put(cx + k, ry, v > 0.75 ? '█' : v > 0.5 ? '▓' : v > 0.25 ? '▒' : v > 0 ? '░' : '·', C.cream);
        else c.put(cx + k, ry, glyph, fg);
      }
      if (cellW === 1) c.put(cx, ry, s.caps.color === 'none' ? (v > 0.5 ? '█' : v > 0 ? '░' : '·') : glyph, fg);
    }
  }
  if (options.axis !== false) {
    const ticks = cellW >= 3 ? [0, 3, 6, 9, 12, 15, 18, 21] : [0, 6, 12, 18];
    for (const h of ticks) c.text(x + labelW + h * cellW, y + 7 * rowStep, h === 0 ? '12a' : h === 12 ? '12p' : h < 12 ? `${h}a` : `${h - 12}p`, { fg: C.slate });
  }
  return { w: labelW + 24 * cellW, busy };
}

export function clockBody(s: Scene, data: Data<'clock'>, r: Rect): boolean {
  const { c, t, tier } = s;
  const cellW = r.w >= 4 + 72 + 30 ? 3 : r.w >= 4 + 48 + 24 || tier.id === 'S' ? 2 : 2;
  const gridW = 4 + 24 * cellW;
  const side = r.w - gridW - 4 >= 22;
  const tall = tier.id === 'L' && r.h >= 18 && cellW === 3;
  const gridH = tall ? 15 : 8;
  const calloutRows = side ? 0 : 2;
  const y0 = r.y + Math.max(0, Math.floor((r.h - gridH - calloutRows - (side ? 0 : 1)) * 0.3));
  const peak: [number, number] | null = data.peakWeekday !== null && data.peakHour !== null ? [data.peakWeekday, data.peakHour] : null;
  const { busy } = drawHeatmap(s, data.grid, r.x, y0, cellW, { t, peak, tall });
  // Peak marker under the axis.
  const callA = seg(t, 1200, 400);
  if (side) {
    const sx = r.x + gridW + 4;
    data.callouts.forEach((call, i) => {
      const a = seg(t, 1000 + i * 140, 350);
      const cy = y0 + i * (tall ? 4 : 2);
      if (cy + 1 >= r.y + r.h) return;
      c.text(sx, cy, call.label, { fg: C.gray, alpha: a });
      c.text(sx + Math.max(15, textWidth(call.label) + 2), cy, call.value, { fg: i === 0 ? C.orange : C.cream, bold: true, alpha: a });
      c.text(sx, cy + 1, call.sub, { fg: C.slate, alpha: a }, r.x + r.w - sx);
    });
  } else {
    let x = r.x;
    const cy = y0 + gridH + 1;
    for (const call of data.callouts.slice(0, tier.id === 'S' ? 2 : 3)) {
      const text = `${call.label.toLowerCase()} `;
      if (x + textWidth(text) + textWidth(call.value) > r.x + r.w) break;
      x += c.text(x, cy, text, { fg: C.gray, alpha: callA });
      x += c.text(x, cy, call.value, { fg: C.orange, bold: true, alpha: callA }) + 3;
    }
  }
  return busy || callA < 1;
}

/* ── mood timeline ── */

export function moodBody(s: Scene, data: Data<'mood'>, r: Rect): boolean {
  const { c, t } = s;
  const months = data.months;
  const max = Math.max(1, ...months.map(m => m.pct));
  const axisW = 5;
  const plotW = Math.min(r.w - axisW - 2, months.length * (s.tier.id === 'L' ? 9 : 7));
  const plotH = Math.max(4, Math.min(r.h - 3, s.tier.id === 'L' ? 14 : 10));
  const x0 = r.x + axisW;
  const yTop = r.y + 2;
  const yBottom = yTop + plotH - 1; // last cell row of the plot
  const pxH = plotH * 2;
  const step = plotW / Math.max(1, months.length - 1);
  const draw = s.caps.motion ? seg(t, 100, 1100, easeOutCubic) : 1;
  const valueAt = (x: number) => {
    const f = x / step;
    const i = Math.min(months.length - 2, Math.max(0, Math.floor(f)));
    const k = clamp01(f - i);
    const a = months[i]!.pct, b = months[Math.min(months.length - 1, i + 1)]!.pct;
    return a + (b - a) * (k * k * (3 - 2 * k));
  };
  // Axis labels.
  textRight(c, x0 - 1, yTop, `${Math.round(max)}%`, { fg: C.slate });
  textRight(c, x0 - 1, yBottom, '0%', { fg: C.slate });
  for (let x = 0; x <= plotW; x++) c.put(x0 + x, yBottom + 1, s.caps.unicode ? '─' : '-', C.coal);
  const tipX = Math.round(data.tip * step);
  for (let x = 0; x <= Math.round(plotW * draw); x++) {
    const v = valueAt(x);
    const top = Math.round(pxH - (v / max) * (pxH - 1)) - 1;
    const afterTip = x >= tipX;
    for (let py = Math.max(0, top); py < pxH; py++) {
      const depth = (py - top) / Math.max(1, pxH - top);
      const base = afterTip ? C.ember : C.slate;
      const color = py === top ? (afterTip ? C.orange : C.gray) : mix(mix(base, C.ink, 0.35), C.ink, Math.min(0.92, depth * 1.1));
      c.px(x0 + x, yTop * 2 + py, color);
    }
  }
  // Month labels.
  let lastEnd = -10;
  months.forEach((m, i) => {
    const x = x0 + Math.round(i * step);
    const label = monthLabel(m.month);
    if (x - lastEnd < 2 || x + textWidth(label) > r.x + r.w) return;
    const a = seg(t, 100 + (i / months.length) * 1100, 200);
    c.text(x - (i === months.length - 1 ? textWidth(label) - 1 : 0), yBottom + 2, label, { fg: i === data.tip ? C.orange : C.slate, alpha: a });
    lastEnd = x + textWidth(label);
  });
  // Tip marker drops in after the line passes it.
  const drop = seg(t, 1250, 600, k => spring(k * 0.6, 3, 0.45));
  if (drop > 0) {
    const v = months[data.tip]!.pct;
    const pointRow = yTop + Math.floor((pxH - (v / max) * (pxH - 1) - 1) / 2);
    const markX = x0 + tipX;
    const landing = Math.max(r.y, pointRow - 2);
    const yNow = Math.round(r.y + (landing - r.y) * drop);
    for (let y = yNow + 1; y < pointRow; y++) c.put(markX, y, s.caps.unicode ? '┊' : ':', C.gray);
    c.put(markX, yNow, s.caps.unicode ? '▼' : 'v', C.cream, undefined, 1);
    const label = `it tipped in ${monthLabel(months[data.tip]!.month)}`;
    // Rising curves put the label on the calm (left) side so it never sits on the area.
    const rising = (months.at(-1)!.pct ?? 0) >= v;
    const lx = rising && markX - textWidth(label) - 2 >= r.x ? markX - textWidth(label) - 2 : markX + textWidth(label) + 3 > r.x + r.w ? markX - textWidth(label) - 2 : markX + 2;
    c.text(lx, yNow, label, { fg: C.cream, bold: true, alpha: drop });
  }
  // End labels.
  const ends = seg(t, 1200, 300);
  const first = months[0]!, last = months.at(-1)!;
  c.text(x0 + 1, yTop + Math.floor((pxH - (first.pct / max) * (pxH - 1)) / 2) - 1, `${first.pct.toFixed(1)}%`, { fg: C.gray, alpha: ends });
  const lastLabel = `${last.pct.toFixed(0)}%`;
  c.text(x0 + plotW - textWidth(lastLabel), Math.max(r.y, yTop + Math.floor((pxH - (last.pct / max) * (pxH - 1)) / 2) - 2), lastLabel, { fg: C.orange, bold: true, alpha: ends });
  return t < 1900;
}

/* ── fuse ── */

export function fuseBody(s: Scene, data: Data<'fuse'>, r: Rect): boolean {
  const { c, t } = s;
  const n = Math.max(data.median + 4, Math.min(20, Math.max(10, data.hist.length)));
  const len = Math.min(r.w - 6, s.tier.id === 'L' ? 96 : 70);
  const x0 = r.x + 2;
  const histH = data.hist.length && r.h >= 13 ? Math.min(s.tier.id === 'L' ? 7 : 4, r.h - 10) : 0;
  const y = r.y + histH + 1;
  const posOf = (turn: number) => x0 + Math.round(((turn - 1) / (n - 1)) * (len - 1));
  const target = posOf(data.median);
  const burn = s.caps.motion ? seg(t, 200, 1300, k => k * (2 - k)) : 1;
  const sparkX = Math.round(x0 + (target - x0) * burn);
  // Histogram of the first-swear prompt, rising off the fuse like smoke.
  if (histH) {
    const max = Math.max(1, ...data.hist);
    const colW = Math.max(1, Math.floor(len / n) - 1);
    data.hist.slice(0, n).forEach((v, i) => {
      const x = posOf(i + 1) - Math.floor(colW / 2);
      const k = seg(t, 1400 + i * 30, 400, easeOutCubic);
      const color = i + 1 === data.median ? C.orange : i + 1 < data.median ? fade(C.peach, 0.55) : fade(C.slate, 0.9);
      vbar(c, x, y - 1, histH, (v / max) * k, color, colW, !s.caps.unicode);
    });
    const la = seg(t, 1700, 300);
    c.text(x0 + len + 1 - 22, r.y, 'sessions by first swear', { fg: C.slate, alpha: la });
  }
  for (let x = x0; x < x0 + len; x++) {
    if (x < sparkX) c.put(x, y, s.caps.unicode ? '·' : '.', C.slate);
    else if (x > sparkX) c.put(x, y, x % 2 ? '~' : '-', x > target ? fade(C.peach, 0.45) : C.peach);
  }
  // Spark, then a burst at the median prompt.
  const flick = Math.floor(t / 70) % 3;
  if (burn < 1) {
    c.put(sparkX, y, s.caps.unicode ? ['✦', '✧', '✶'][flick]! : '*', [C.cream, C.peach, C.orange][flick]!, undefined, 1);
  } else {
    const b = seg(t, 1500, 500);
    const radius = 1 + Math.round(b * 2);
    for (let k = -radius; k <= radius; k++) {
      const col = k === 0 ? C.white : Math.abs(k) < radius ? C.peach : C.ember;
      c.px(target + k, y * 2 + 1, col);
      c.px(target, y * 2 + 1 + k, col);
      if (Math.abs(k) < radius - 1) { c.px(target + k, y * 2 + 1 + k, C.orange); c.px(target + k, y * 2 + 1 - k, C.orange); }
    }
  }
  // Ticks.
  for (let turn = 1; turn <= n; turn++) {
    const x = posOf(turn);
    const show = turn === 1 || turn === data.median || turn === n || turn % (len / n >= 4 ? 1 : 5) === 0;
    if (!show) continue;
    c.text(x - (turn >= 10 ? 1 : 0), y + 1, `#${turn}`, { fg: turn === data.median ? C.orange : C.slate, bold: turn === data.median });
  }
  // Big readout.
  const by = y + 3;
  if (by + 3 <= r.y + r.h) {
    const a = seg(t, 1400, 400);
    const text = `PROMPT #${data.median}`;
    const bw = bigWidth(text, 1);
    drawBig(c, x0, by, text, { color: (_x, py) => fade(mix(C.cream, C.orange, py / 4), a) });
    const sx = x0 + bw + 4;
    const lines: [string, string][] = [
      [`${data.sessions} of ${data.of}`, ' sessions had a snap'],
      [`${data.firstPrompt}`, ' times you came in swinging on prompt #1'],
    ];
    lines.forEach(([strong, rest], i) => {
      const la = seg(t, 1600 + i * 150, 300);
      const inline = sx + 30 <= r.x + r.w;
      const lx = inline ? sx : x0;
      const ly = inline ? by + i * 2 : by + 4 + i;
      if (ly >= r.y + r.h) return;
      const w = c.text(lx, ly, strong, { fg: C.orange, bold: true, alpha: la });
      c.text(lx + w, ly, rest, { fg: C.gray, alpha: la }, r.x + r.w - lx - w);
    });
  }
  return t < 2300;
}

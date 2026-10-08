/** Archetype reveal, the share board, and a generic chart card for other detectors. */
import { C, fade, mix } from '../gfx/color.js';
import { box, hbar, spaced, textCenter, textRight, textWidth, vbar, wrapText, type Rect } from '../gfx/draw.js';
import { bigHeight, bigSupported, bigWidth, drawBig } from '../gfx/font.js';
import { easeOutBack, easeOutCubic, seg, spring } from '../gfx/motion.js';
import { count, money } from '../format.js';
import type { DeckCard } from '../story/deck.js';
import { drawHeatmap } from './time.js';
import type { Scene } from './scene.js';

type Data<K extends DeckCard['kind']> = Extract<DeckCard, { kind: K }>['data'];

/** Split an uppercase title into lines that fit `width` cells in the block font. */
function titleLines(title: string, width: number, scale = 1): string[] | null {
  const words = title.toUpperCase().split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (bigWidth(next, scale) <= width) line = next;
    else { if (line) lines.push(line); line = word; if (bigWidth(word, scale) > width) return null; }
  }
  if (line) lines.push(line);
  return lines;
}

const TIER_LABEL: Record<string, string> = { common: 'COMMON', rare: 'RARE', epic: 'EPIC', legendary: 'LEGENDARY' };

export function archetypeBody(s: Scene, data: Data<'archetype'>, r: Rect): boolean {
  const { c, t, tier } = s;
  const pause = 450;
  const titleW = r.w;
  const lines = bigSupported(data.title) ? titleLines(data.title, titleW) : null;
  let y = r.y;
  let letters = 0;
  let busy = false;
  if (lines && lines.length * (bigHeight() + 1) <= r.h - 4) {
    const total = lines.reduce((n, l) => n + l.replace(/ /g, '').length, 0);
    const perLetter = Math.min(70, 900 / Math.max(1, total));
    const sweep = seg(t, pause + total * perLetter + 150, 900, k => k);
    busy ||= sweep < 1;
    lines.forEach(line => {
      const startIndex = letters;
      drawBig(c, r.x, y, line, {
        limit: s.caps.motion ? Math.max(0, Math.floor((t - pause) / perLetter) - startIndex + 1) : undefined,
        dy: i => {
          const k = seg(t, pause + (startIndex + i) * perLetter, 260, easeOutBack);
          return Math.round((1 - k) * -3);
        },
        color: (px, py, i) => {
          const k = seg(t, pause + (startIndex + i) * perLetter, 200);
          const base = mix(C.cream, C.orange, py / 4);
          const band = Math.abs(px - sweep * (bigWidth(line) + 20) + 10);
          return fade(band < 3 && sweep > 0 && sweep < 1 ? mix(base, C.white, 0.7 * (1 - band / 3)) : base, k);
        },
      });
      letters += line.replace(/ /g, '').length;
      y += bigHeight() + 1;
    });
    busy ||= t < pause + total * perLetter + 300;
  } else {
    // Text fallback: letter-by-letter in bold cream.
    const text = data.title.toUpperCase();
    const n = s.caps.motion ? Math.floor(Math.max(0, t - pause) / 45) : text.length;
    for (const line of wrapText(text, r.w, 2)) { c.text(r.x, y, line.slice(0, Math.max(0, n)), { fg: C.cream, bold: true }); y += 1; }
    y += 1;
    busy ||= n < text.length;
  }
  const after = pause + 1300;
  if (data.tier && y < r.y + r.h) {
    const k = seg(t, after, 350, easeOutBack);
    const label = `${s.caps.unicode ? '★' : '*'} ${TIER_LABEL[data.tier]} ${s.caps.unicode ? '★' : '*'}`;
    c.text(r.x, y, ` ${label} `, { fg: C.ink, bg: fade(data.tier === 'legendary' || data.tier === 'epic' ? C.orange : C.slate, Math.min(1, k)), bold: true });
    const note = data.subRole ?? (data.tier === 'common' ? 'plenty of company' : data.tier === 'rare' ? 'not many like you' : 'a rare combination');
    c.text(r.x + textWidth(label) + 4, y, note, { fg: data.subRole ? C.peach : C.gray, italic: Boolean(data.subRole), alpha: Math.min(1, k) }, r.w - textWidth(label) - 4);
    y += 2;
  }
  const pa = seg(t, after + 250, 450);
  const profile = wrapText(data.profile, Math.min(r.w, 84), tier.id === 'S' ? 2 : 3);
  profile.forEach(line => { if (y < r.y + r.h) c.text(r.x, y++, line, { fg: C.cream, alpha: pa }); });
  y += 1;
  const labelW = Math.min(30, Math.max(0, ...data.deciding.map(m => textWidth(m.display))) + 2);
  const barW = Math.max(8, Math.min(30, r.w - labelW - 4));
  data.deciding.forEach((m, i) => {
    if (y >= r.y + r.h) return;
    const ta = seg(t, after + 600 + i * 150, 300);
    const k = seg(t, after + 650 + i * 150, 600, easeOutCubic);
    if (ta <= 0) { y += tier.id === 'S' ? 1 : 2; return; }
    c.text(r.x, y, m.display, { fg: C.cream, alpha: ta }, labelW - 1);
    const fill = Math.round(barW * m.band * k);
    for (let x = 0; x < barW; x++) c.put(r.x + labelW + x, y, s.caps.unicode ? (x < fill ? '━' : '─') : (x < fill ? '=' : '-'), x < fill ? (i === 0 ? C.orange : fade(C.orange, 0.65)) : fade(C.coal, ta));
    y += tier.id === 'S' ? 1 : 2;
  });
  if (data.code && y + 1 < r.y + r.h && tier.id !== 'S') c.text(r.x, y + 1, `code ${data.code}`, { fg: C.slate, alpha: seg(t, after + 1100, 300) });
  return busy || t < after + 1100;
}

/* ── board / share card ── */

export function boardBody(s: Scene, data: Data<'board'>, r: Rect, mascot: Rect): boolean {
  const { c, t, tier } = s;
  let busy = false;
  const appear = (i: number) => { const k = seg(t, 100 + i * 120, 350, easeOutCubic); busy ||= k < 1; return k; };
  // Title, beside Slopie.
  const a0 = appear(0);
  const titleW = Math.max(20, (tier.mascot === 'line' ? r.x + r.w : mascot.x - 3) - r.x);
  let y = r.y;
  if (data.archetype) {
    c.text(r.x, y, tier.id === 'L' ? spaced("this year you've been") : "THIS YEAR YOU'VE BEEN", { fg: C.gray, alpha: a0 });
    y += 2;
    const lines = tier.id !== 'S' && bigSupported(data.archetype) ? titleLines(data.archetype, titleW) : null;
    if (lines && lines.length <= 2) {
      lines.forEach((line, i) => {
        drawBig(c, r.x, y, line, { color: (_x, py) => fade(mix(C.cream, C.orange, py / 4), a0) });
        if (i === lines.length - 1 && data.tier) {
          const lx = r.x + bigWidth(line) + 3;
          if (lx + 12 < r.x + titleW) c.text(lx, y + 1, ` ${TIER_LABEL[data.tier]} `, { fg: C.ink, bg: fade(C.orange, a0), bold: true });
        }
        y += bigHeight() + 1;
      });
    } else {
      const w = c.text(r.x, y, data.archetype.toUpperCase(), { fg: C.orange, bold: true, alpha: a0 }, titleW - 12);
      if (data.tier) c.text(r.x + w + 2, y, ` ${TIER_LABEL[data.tier]} `, { fg: C.ink, bg: fade(C.orange, a0), bold: true });
      y += 2;
    }
  }
  if (data.range) { c.text(r.x, y, data.range, { fg: C.slate, alpha: a0 }); y += 1; }
  y = Math.max(y + 1, tier.mascot === 'line' ? y : mascot.y + mascot.h);
  // Tiles fill what is left above the stats strip.
  const reserve = 2 + (data.catchphrase && !s.share ? 2 : 0) + (data.awards.length && r.h >= 26 ? 2 : 0);
  const tilesH = Math.max(5, Math.min(tier.id === 'L' ? 13 : 9, r.y + r.h - y - reserve));
  const wide = r.w >= 90;
  const gap = 2;
  const pixel = s.caps.color !== 'none';
  const tiles: { key: string; w: number }[] = [];
  if (data.bill !== null) tiles.push({ key: 'bill', w: 0 });
  if (data.grid && wide && tilesH >= 10) tiles.push({ key: 'clock', w: 4 + 24 + 4 });
  tiles.push({ key: 'models', w: 0 });
  const flex = tiles.filter(tl => !tl.w);
  const fixedW = tiles.reduce((sum, tl) => sum + tl.w, 0) + gap * (tiles.length - 1);
  flex.forEach(tl => { tl.w = Math.floor((r.w - fixedW) / flex.length); });
  let x = r.x;
  tiles.forEach((tile, i) => {
    const k = appear(i + 1);
    const rect = { x, y: y + Math.round((1 - k) * 1), w: tile.w, h: tilesH };
    box(c, rect, fade(i === 0 ? C.rust : C.coal, k), { ascii: !s.caps.unicode });
    const ix = rect.x + 2, iy = rect.y + 1, iw = rect.w - 4;
    const bottom = rect.y + rect.h - 1;
    if (tile.key === 'bill') {
      c.text(ix, iy, 'AT API PRICES', { fg: C.gray, alpha: k });
      const text = money(data.bill).replace(/\.\d+$/, '');
      const scale = bigWidth(text, 2) <= iw && tilesH >= 11 ? 2 : 1;
      if (pixel && tilesH < 7) c.text(ix, iy + 1, text, { fg: C.orange, bold: true, alpha: k });
      else if (pixel) drawBig(c, ix, iy + 2, text, { scale, color: (_x, py) => fade(mix(C.cream, C.orange, py / (5 * scale - 1)), k) });
      else c.text(ix, iy + 2, text, { fg: C.orange, bold: true });
      let ay = tilesH < 7 ? iy + 2 : iy + 2 + bigHeight(scale) + 1;
      for (const agent of data.agents.slice(0, 3)) {
        if (ay >= bottom) break;
        const pct = agent.share < 0.01 ? '<1%' : `${Math.round(agent.share * 100)}%`;
        c.text(ix, ay, agent.name, { fg: C.gray, alpha: k }, iw - 6);
        textRight(c, ix + iw, ay, pct, { fg: C.cream, alpha: k });
        ay++;
      }
    } else if (tile.key === 'clock' && data.grid) {
      c.text(ix, iy, 'WHEN YOU PROMPT', { fg: C.gray, alpha: k });
      const tallClock = tilesH >= 13;
      drawHeatmap(s, data.grid, ix, iy + (tallClock ? 2 : 1), 1, { t: k >= 1 ? Infinity : t - 200, axis: false });
      if (data.peak && iy + 9 < bottom) c.text(ix, bottom - 1, `peak ${data.peak}`, { fg: C.orange, alpha: k }, iw);
    } else if (tile.key === 'models') {
      c.text(ix, iy, 'YOUR MODELS', { fg: C.gray, alpha: k });
      const tight = tilesH < 9;
      let my = iy + (tight ? 1 : 2);
      const step = tilesH >= 11 ? 3 : 2;
      const row = (label: string, value: string | null, color: number) => {
        if (!value) return;
        if (tight) {
          if (my >= bottom) return;
          const lw = c.text(ix, my, label + ' ', { fg: C.slate, alpha: k });
          c.text(ix + lw, my, value, { fg: color, bold: true, alpha: k }, iw - lw);
          my += 1;
          return;
        }
        if (my + 1 >= bottom) return;
        c.text(ix, my, label, { fg: C.slate, alpha: k });
        c.text(ix, my + 1, value, { fg: color, bold: true, alpha: k }, iw);
        my += step;
      };
      row('most used', data.topModel, C.cream);
      row(s.caps.unicode ? 'favourite ♥' : 'favourite', data.best, C.peach);
      row('nemesis', data.worst, C.ember);
    }
    x += tile.w + gap;
  });
  y += tilesH + 1;
  // Stats strip, catchphrase, awards.
  const sa = appear(tiles.length + 1);
  if (y < r.y + r.h) {
    let sx = r.x;
    for (const stat of data.stats) {
      const need = textWidth(stat.value) + textWidth(stat.label) + 4;
      if (sx + need > r.x + r.w) break;
      sx += c.text(sx, y, stat.value, { fg: C.cream, bold: true, alpha: sa });
      sx += c.text(sx + 1, y, stat.label, { fg: C.gray, alpha: sa }) + 4;
    }
    y += 2;
  }
  if (data.catchphrase && !s.share && y < r.y + r.h) {
    const ca = appear(tiles.length + 2);
    const w = c.text(r.x, y, 'catchphrase ', { fg: C.gray, alpha: ca });
    const w2 = c.text(r.x + w, y, `“${data.catchphrase.text}”`, { fg: C.peach, italic: true, bold: true, alpha: ca }, r.w - w - 8);
    c.text(r.x + w + w2 + 1, y, `×${count(data.catchphrase.count)}`, { fg: C.orange, bold: true, alpha: ca });
    y += 2;
  }
  if (data.awards.length && y < r.y + r.h) {
    const aa = appear(tiles.length + 3);
    let ax = r.x;
    for (const award of data.awards) {
      const value = s.share ? award.publicValue : award.value;
      const need = textWidth(award.title) + textWidth(value) + 6;
      if (ax + need > r.x + r.w) break;
      ax += c.text(ax, y, s.caps.unicode ? '▲ ' : '* ', { fg: C.orange, alpha: aa });
      ax += c.text(ax, y, award.title.toLowerCase() + ' ', { fg: C.gray, alpha: aa });
      ax += c.text(ax, y, value, { fg: C.cream, bold: true, alpha: aa }) + 3;
    }
  }
  return busy;
}

/* ── generic insight chart ── */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Short axis label: '2026-05-01' → 'May 1', '2026-05' → 'May', 13 → '1p'. */
export function axisLabel(x: string | number): string {
  if (typeof x === 'number') return x >= 0 && x <= 23 && Number.isInteger(x) ? (x === 0 ? '12a' : x === 12 ? '12p' : x < 12 ? `${x}a` : `${x - 12}p`) : String(x);
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(x);
  if (day) return `${MONTHS[Number(day[2]) - 1]} ${Number(day[3])}`;
  const month = /^(\d{4})-(\d{2})$/.exec(x);
  if (month) return MONTHS[Number(month[2]) - 1]!;
  const week = /^(\d{4})-W(\d{2})$/.exec(x);
  if (week) return `w${Number(week[2])}`;
  return x;
}

function valueLabel(y: number, unit?: string): string {
  const v = Math.abs(y) >= 100 ? count(Math.round(y)) : Number.isInteger(y) ? String(y) : y.toFixed(1);
  if (unit === 'pct') return `${v}%`;
  if (unit === 'usd') return money(y);
  if (unit === 'hours') return `${v}h`;
  return v;
}

type Point = { x: string | number; y: number; label?: string };

/** Vertical bars, or a dense sparkline when there are more points than room. */
function columns(s: Scene, points: readonly Point[], r: Rect, highlight: string | number | null | undefined, unit?: string): boolean {
  const { c, t } = s;
  const max = Math.max(1e-9, ...points.map(p => p.y));
  const h = Math.max(3, Math.min(r.h - 3, s.tier.id === 'L' ? 14 : 9));
  const top = r.y + 1;
  const bottom = top + h - 1;
  const dense = points.length * 3 > r.w;
  let busy = false;
  if (dense) {
    const width = Math.min(r.w, points.length >= r.w ? r.w : points.length * 2);
    const per = points.length / width;
    for (let col = 0; col < width; col++) {
      const slice = points.slice(Math.floor(col * per), Math.max(Math.floor(col * per) + 1, Math.floor((col + 1) * per)));
      const v = Math.max(...slice.map(p => p.y));
      const hi = slice.some(p => highlight !== undefined && highlight !== null && String(p.x) === String(highlight));
      const k = seg(t, 100 + col * 12, 300, easeOutCubic);
      busy ||= k < 1;
      if (v <= 0) { c.put(r.x + col, bottom, s.caps.unicode ? '▁' : '_', C.coal); continue; }
      vbar(c, r.x + col, bottom, h, Math.max(0.06, v / max) * k, hi ? C.orange : v === max ? C.peach : fade(C.orange, 0.5), 1, !s.caps.unicode);
    }
    c.text(r.x, bottom + 1, axisLabel(points[0]!.x), { fg: C.slate });
    const last = axisLabel(points.at(-1)!.x);
    textRight(c, r.x + width, bottom + 1, last, { fg: C.slate });
    const peak = points.reduce((best, p) => (p.y > best.y ? p : best), points[0]!);
    const pi = points.indexOf(peak);
    const px = r.x + Math.floor(pi / per);
    const la = seg(t, 600, 300);
    const label = `${valueLabel(peak.y, unit)} · ${axisLabel(peak.x)}`;
    c.text(Math.min(px, r.x + r.w - textWidth(label)), Math.max(r.y, top - 1), label, { fg: C.cream, bold: true, alpha: la });
    return busy || la < 1;
  }
  const colW = Math.max(3, Math.min(9, Math.floor(r.w / points.length)));
  const barW = Math.max(1, colW - (colW >= 5 ? 2 : 1));
  const maxIndex = points.findIndex(p => p.y === max);
  points.forEach((p, i) => {
    const hi = highlight !== undefined && highlight !== null ? String(p.x) === String(highlight) : i === maxIndex;
    const k = s.caps.motion ? Math.min(1, spring((t - i * 50) / 1000, 2, 0.7)) : 1;
    busy ||= t < i * 50 + 900;
    const x = r.x + i * colW;
    vbar(c, x, bottom, h - 1, (p.y / max) * Math.max(0, k), hi ? C.orange : fade(C.orange, 0.45), barW, !s.caps.unicode);
    const label = axisLabel(p.x);
    if (colW >= 4 || i % 2 === 0) c.text(x, bottom + 1, label.slice(0, colW), { fg: hi ? C.orange : C.slate, bold: hi });
    const va = seg(t, 500 + i * 50, 250);
    const vy = bottom - Math.ceil((p.y / max) * (h - 1)) - 1;
    const text = valueLabel(p.y, unit);
    if (textWidth(text) <= colW) c.text(x, Math.max(r.y, vy), text, { fg: hi ? C.cream : C.gray, bold: hi, alpha: va });
  });
  return busy;
}

/** Monthly line as a soft area (same style as the mood card). */
function area(s: Scene, points: readonly Point[], r: Rect, highlight: string | number | null | undefined, unit?: string): boolean {
  const { c, t } = s;
  const max = Math.max(1e-9, ...points.map(p => p.y));
  const plotH = Math.max(4, Math.min(r.h - 3, s.tier.id === 'L' ? 12 : 8));
  const x0 = r.x + 6;
  const plotW = Math.min(r.w - 8, points.length * (s.tier.id === 'L' ? 9 : 6));
  const yTop = r.y + 1;
  const pxH = plotH * 2;
  const step = plotW / Math.max(1, points.length - 1);
  const draw = s.caps.motion ? seg(t, 100, 1000, easeOutCubic) : 1;
  const at = (x: number) => {
    const f = x / step;
    const i = Math.min(points.length - 2, Math.max(0, Math.floor(f)));
    const k = Math.max(0, Math.min(1, f - i));
    const a = points[i]!.y, b = points[Math.min(points.length - 1, i + 1)]!.y;
    return a + (b - a) * (k * k * (3 - 2 * k));
  };
  for (let x = 0; x <= Math.round(plotW * draw); x++) {
    const top = Math.round(pxH - (at(x) / max) * (pxH - 1)) - 1;
    for (let py = Math.max(0, top); py < pxH; py++) {
      const depth = (py - top) / Math.max(1, pxH - top);
      c.px(x0 + x, yTop * 2 + py, py === top ? C.orange : mix(mix(C.ember, C.ink, 0.35), C.ink, Math.min(0.92, depth * 1.1)));
    }
  }
  textRight(c, x0 - 1, yTop, valueLabel(max, unit), { fg: C.slate });
  textRight(c, x0 - 1, yTop + plotH - 1, unit === 'pct' ? '0%' : '0', { fg: C.slate });
  let lastEnd = -10;
  points.forEach((p, i) => {
    const x = x0 + Math.round(i * step);
    const label = axisLabel(p.x);
    if (x - lastEnd < 2 || x + textWidth(label) > r.x + r.w) return;
    const hi = highlight !== undefined && highlight !== null && String(p.x) === String(highlight);
    c.text(x, yTop + plotH, label, { fg: hi ? C.orange : C.slate });
    lastEnd = x + textWidth(label);
  });
  const ea = seg(t, 1000, 300);
  const first = points[0]!, last = points.at(-1)!;
  c.text(x0 + 1, Math.max(r.y, yTop + Math.floor((pxH - (first.y / max) * (pxH - 1)) / 2) - 1), valueLabel(first.y, unit), { fg: C.gray, alpha: ea });
  const lastText = valueLabel(last.y, unit);
  c.text(x0 + plotW - textWidth(lastText), Math.max(r.y, yTop + Math.floor((pxH - (last.y / max) * (pxH - 1)) / 2) - 2), lastText, { fg: C.orange, bold: true, alpha: ea });
  return t < 1400;
}

/** Ranked horizontal list (phrases, typos, projects, first words). */
function list(s: Scene, points: readonly Point[], r: Rect, unit?: string): boolean {
  const { c, t } = s;
  const rows = points.slice(0, Math.min(8, Math.max(1, Math.floor(r.h / (r.h >= 12 ? 2 : 1)))));
  const step = rows.length * 2 <= r.h ? 2 : 1;
  const max = Math.max(1e-9, ...rows.map(p => p.y));
  const nameW = Math.min(26, Math.max(...rows.map(p => textWidth(String(p.x)))) + 2);
  const barW = Math.max(6, Math.min(50, r.w - nameW - 30));
  rows.forEach((p, i) => {
    const y = r.y + i * step;
    const k = seg(t, i * 80, 600, easeOutCubic);
    c.text(r.x, y, String(p.x), { fg: i === 0 ? C.cream : C.gray, bold: i === 0 }, nameW - 1);
    hbar(c, r.x + nameW, y, barW, (p.y / max) * k, i === 0 ? C.orange : fade(C.orange, 0.5), !s.caps.unicode);
    const value = valueLabel(p.y, unit);
    const vw = c.text(r.x + nameW + barW + 2, y, value, { fg: C.cream, alpha: k });
    if (p.label) c.text(r.x + nameW + barW + 3 + vw, y, `· ${p.label}`, { fg: C.slate, alpha: k }, r.x + r.w - (r.x + nameW + barW + 3 + vw));
  });
  return t < rows.length * 80 + 600;
}

/** Weekly stacked columns (one colour per agent). */
function stacked(s: Scene, series: readonly { name: string; points: readonly Point[] }[], r: Rect, highlight: string | number | null | undefined): boolean {
  const { c, t } = s;
  const n = series[0]?.points.length ?? 0;
  const colW = Math.max(1, Math.min(3, Math.floor(r.w / Math.max(1, n))));
  const h = Math.max(3, Math.min(r.h - 4, s.tier.id === 'L' ? 12 : 8));
  const bottom = r.y + h;
  const totals = Array.from({ length: n }, (_, i) => series.reduce((sum, sr) => sum + (sr.points[i]?.y ?? 0), 0));
  const max = Math.max(1, ...totals);
  const palette = [C.slate, C.orange, C.peach, C.cream];
  for (let i = 0; i < n; i++) {
    const k = seg(t, i * 15, 300);
    let acc = 0;
    series.forEach((sr, si) => {
      const v = sr.points[i]?.y ?? 0;
      const from = Math.round((acc / max) * h * 2 * k), to = Math.round(((acc + v) / max) * h * 2 * k);
      for (let py = from; py < to; py++) for (let k2 = 0; k2 < Math.max(1, colW - (colW > 1 ? 1 : 0)); k2++) c.px(r.x + i * colW + k2, bottom * 2 + 1 - py, palette[si % palette.length]!);
      acc += v;
    });
    if (highlight !== undefined && highlight !== null && String(series[0]!.points[i]?.x) === String(highlight)) {
      c.put(r.x + i * colW, r.y, s.caps.unicode ? '▼' : 'v', C.cream);
      c.text(r.x + i * colW + 2, r.y, axisLabel(series[0]!.points[i]!.x), { fg: C.cream, bold: true });
    }
  }
  let lx = r.x;
  series.forEach((sr, si) => {
    lx += c.text(lx, bottom + 2, s.caps.unicode ? '■ ' : '# ', { fg: palette[si % palette.length]! });
    lx += c.text(lx, bottom + 2, sr.name, { fg: C.gray }) + 3;
  });
  return t < n * 15 + 300;
}

export function insightBody(s: Scene, data: Data<'insight'>, r: Rect): boolean {
  const { c, t } = s;
  const chart = data.chart;
  const points = chart.series[0]?.points ?? [];
  if (chart.type === 'slope' && chart.series.length >= 1) {
    const ser = chart.series.slice(0, 2);
    const max = Math.max(1, ...ser.flatMap(sr => sr.points.map(p => p.y)));
    const x0 = r.x + 18, x1 = Math.min(r.x + r.w - 18, x0 + 56);
    const top = r.y + 1, bottom = r.y + Math.min(r.h - 2, s.tier.id === 'L' ? 12 : 8);
    const k = seg(t, 200, 900, easeOutCubic);
    ser.forEach((sr, i) => {
      const color = i === 0 ? C.peach : C.ember;
      const [a, b] = [sr.points[0]?.y ?? 0, sr.points[1]?.y ?? 0];
      const ya = bottom * 2 - Math.round((a / max) * (bottom - top) * 2), yb = bottom * 2 - Math.round((b / max) * (bottom - top) * 2);
      const steps = Math.round((x1 - x0) * k);
      for (let sx = 0; sx <= steps; sx++) c.px(x0 + sx, Math.round(ya + (yb - ya) * (sx / (x1 - x0))), color);
      const name = sr.name.replace(/\s*%$/, '');
      textRight(c, x0 - 2, Math.floor(ya / 2), `${name} ${valueLabel(a, chart.unit)}`, { fg: color });
      if (k >= 1) c.text(x1 + 2, Math.floor(yb / 2), `${valueLabel(b, chart.unit)} ${name}`, { fg: color, bold: true });
    });
    const labels = ser[0]!.points.map(p => String(p.x));
    c.text(x0 - 2, bottom + 1, labels[0] ?? '', { fg: C.slate });
    textRight(c, x1 + 2, bottom + 1, labels[1] ?? '', { fg: C.slate });
    return k < 1;
  }
  if (chart.type === 'big_number' && points[0]) {
    const a = seg(t, 0, 400);
    const text = valueLabel(points[0].y, chart.unit);
    const glyphs = text.replace(/[^0-9.,%$h×]/g, '');
    drawBig(c, r.x, r.y + 1, glyphs, { scale: s.tier.id === 'L' ? 2 : 1, color: (_x, py) => fade(mix(C.cream, C.orange, py / (s.tier.id === 'L' ? 9 : 4)), a) });
    c.text(r.x, r.y + (s.tier.id === 'L' ? 7 : 5), chart.series[0]!.name, { fg: C.gray, alpha: a });
    return a < 1;
  }
  if (chart.type === 'stacked_area' && chart.series.length > 1) return stacked(s, chart.series, r, chart.highlight);
  if (!points.length) return false;
  if (['hbar', 'words', 'autocomplete', 'keyboard', 'tally', 'bubbles', 'grid'].includes(chart.type)) return list(s, points, r, chart.unit);
  if (chart.type === 'line' && points.length >= 3 && typeof points[0]!.x === 'string' && /^\d{4}-\d{2}$/.test(points[0]!.x)) return area(s, points, r, chart.highlight, chart.unit);
  return columns(s, points, r, chart.highlight, chart.unit);
}

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
    c.text(r.x, y, m.display, { fg: C.cream, alpha: ta }, labelW - 1);
    const fill = Math.round(barW * m.band * k);
    for (let x = 0; x < barW; x++) c.put(r.x + labelW + x, y, s.caps.unicode ? (x < fill ? '━' : '─') : (x < fill ? '=' : '-'), x < fill ? (i === 0 ? C.orange : fade(C.orange, 0.65)) : C.coal);
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
      if (pixel) drawBig(c, ix, iy + 2, text, { scale, color: (_x, py) => fade(mix(C.cream, C.orange, py / (5 * scale - 1)), k) });
      else c.text(ix, iy + 2, text, { fg: C.orange, bold: true });
      let ay = iy + 2 + bigHeight(scale) + 1;
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
      let my = iy + 2;
      const step = tilesH >= 11 ? 3 : 2;
      const row = (label: string, value: string | null, color: number) => {
        if (!value || my + 1 >= bottom) return;
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

export function insightBody(s: Scene, data: Data<'insight'>, r: Rect): boolean {
  const { c, t } = s;
  const series = data.chart.series[0];
  const points = series?.points ?? [];
  if (data.chart.type === 'slope' && data.chart.series.length >= 1) {
    const ser = data.chart.series.slice(0, 2);
    const max = Math.max(1, ...ser.flatMap(sr => sr.points.map(p => p.y)));
    const x0 = r.x + 14, x1 = Math.min(r.x + r.w - 14, x0 + 50);
    const top = r.y + 1, bottom = r.y + Math.min(r.h - 2, 10);
    const k = seg(t, 200, 900, easeOutCubic);
    ser.forEach((sr, i) => {
      const color = i === 0 ? C.peach : C.ember;
      const [a, b] = [sr.points[0]?.y ?? 0, sr.points[1]?.y ?? 0];
      const ya = bottom * 2 - Math.round((a / max) * (bottom - top) * 2), yb = bottom * 2 - Math.round((b / max) * (bottom - top) * 2);
      const steps = Math.round((x1 - x0) * k);
      for (let sx = 0; sx <= steps; sx++) c.px(x0 + sx, Math.round(ya + (yb - ya) * (sx / (x1 - x0))), color);
      textRight(c, x0 - 2, Math.floor(ya / 2), `${sr.name} ${a}%`, { fg: color });
      if (k >= 1) c.text(x1 + 2, Math.floor(yb / 2), `${b}% ${sr.name}`, { fg: color, bold: true });
    });
    const labels = ser[0]!.points.map(p => String(p.x));
    c.text(x0 - 4, bottom + 1, labels[0] ?? '', { fg: C.slate });
    textRight(c, x1 + 4, bottom + 1, labels[1] ?? '', { fg: C.slate });
    return k < 1;
  }
  if (points.length >= 2 && ['bar', 'histogram', 'line', 'sparkline', 'stacked_area'].includes(data.chart.type)) {
    const max = Math.max(1, ...points.map(p => p.y));
    const colW = Math.max(2, Math.min(8, Math.floor(r.w / points.length)));
    const h = Math.max(3, Math.min(r.h - 2, 12));
    let busy = false;
    points.forEach((p, i) => {
      const k = s.caps.motion ? Math.min(1, spring((t - i * 60) / 1000, 2, 0.7)) : 1;
      busy ||= t < i * 60 + 900;
      const hi = data.chart.highlight !== undefined && String(p.x) === String(data.chart.highlight);
      vbar(c, r.x + i * colW, r.y + h - 1, h, (p.y / max) * Math.max(0, k), hi ? C.orange : fade(C.orange, 0.45), colW - 1, !s.caps.unicode);
      const label = String(p.x);
      if (colW >= 4 || i % 2 === 0) c.text(r.x + i * colW, r.y + h, label.slice(0, colW), { fg: hi ? C.orange : C.slate });
      if (hi) textCenter(c, r.x + i * colW + (colW - 1) / 2, r.y + h - 1 - Math.ceil((p.y / max) * h) - 1, s.caps.unicode ? 'you' : 'you', { fg: C.cream, bold: true });
    });
    return busy;
  }
  if (points.length && data.chart.type === 'hbar') {
    const max = Math.max(1, ...points.map(p => p.y));
    points.slice(0, r.h).forEach((p, i) => {
      c.text(r.x, r.y + i, String(p.x), { fg: C.gray }, 16);
      hbar(c, r.x + 17, r.y + i, r.w - 26, (p.y / max) * seg(t, i * 80, 700), C.orange, !s.caps.unicode);
      textRight(c, r.x + r.w, r.y + i, count(p.y), { fg: C.cream });
    });
    return t < points.length * 80 + 700;
  }
  // No series: one oversized number from the headline.
  const big = /[$]?\d[\d,.]*(?:%|h|×)?/.exec(data.chart.series[0]?.points[0]?.label ?? '') ?? null;
  void big; void box;
  return false;
}

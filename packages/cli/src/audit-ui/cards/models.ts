/** Guess your #1 model (chips → racing bars) and the favourite-vs-nemesis face-off. */
import { C, fade, mix } from '../gfx/color.js';
import { box, hbar, spaced, textRight, textWidth, wrapText, type Rect } from '../gfx/draw.js';
import { bigWidth, drawBig } from '../gfx/font.js';
import { easeOutBack, easeOutCubic, seg, spring } from '../gfx/motion.js';
import { drawMascot, mascotLine } from '../mascot.js';
import type { DeckCard, Gauge } from '../story/deck.js';
import type { Scene } from './scene.js';

type Data<K extends DeckCard['kind']> = Extract<DeckCard, { kind: K }>['data'];

export function guessBody(s: Scene, data: Data<'guess'>, r: Rect): boolean {
  const { c, t, state } = s;
  const n = data.options.length;
  const guessed = state.guess !== undefined;
  if (!guessed) {
    const cols = r.w >= 70 ? 2 : 1;
    const tall = r.h >= 16 && s.caps.color !== 'none';
    const chipW = Math.min(cols === 2 ? 44 : r.w, Math.floor((r.w - (cols - 1) * 4) / cols));
    const chipH = tall ? 5 : r.h >= 11 ? 3 : 1;
    const gridW = cols * chipW + (cols - 1) * 4;
    const gx = r.x + Math.max(0, Math.floor((r.w - gridW) / 2) - (s.tier.id === 'L' ? 0 : 0));
    const rowsN = Math.ceil(n / cols);
    const gridH = rowsN * chipH + (rowsN - 1);
    const gy = r.y + Math.max(0, Math.floor((r.h - gridH - 2) * 0.3));
    let busy = false;
    data.options.forEach((option, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const x = gx + col * (chipW + 4);
      const k = seg(t, 80 + i * 90, 380, easeOutBack);
      busy ||= k < 1;
      const y = gy + row * (chipH + 1) + Math.round((1 - Math.min(1, k)) * 2);
      const a = Math.min(1, Math.max(0, k));
      if (chipH >= 3) box(c, { x, y, w: chipW, h: chipH }, fade(i % 2 ? C.slate : C.rust, a), { ascii: !s.caps.unicode });
      if (tall) {
        // Number tile in the block font, name beside it.
        for (let yy = y + 1; yy < y + chipH - 1; yy++) for (let xx = x + 2; xx < x + 8; xx++) c.put(xx, yy, ' ', C.cream, fade(C.orange, a));
        c.text(x + 4, y + 2, String(i + 1), { fg: C.ink, bg: fade(C.orange, a), bold: true });
        c.text(x + 12, y + 2, option.name, { fg: C.cream, bold: true, alpha: a }, chipW - 14);
      } else {
        const ty = chipH === 3 ? y + 1 : y;
        c.text(x + 2, ty, ` ${i + 1} `, { fg: C.ink, bg: fade(C.orange, a), bold: true });
        c.text(x + 7, ty, option.name, { fg: C.cream, bold: true, alpha: a }, chipW - 9);
      }
    });
    const hy = gy + gridH + 2;
    if (hy < r.y + r.h) {
      const a = seg(t, 600, 400);
      const hint = s.caps.unicode ? '  · or → to just tell me' : '  - or > to just tell me';
      const total = 6 + 3 + hint.length;
      let hx = gx + Math.max(0, Math.floor((gridW - total) / 2));
      hx += c.text(hx, hy, 'press ', { fg: C.gray, alpha: a });
      hx += c.text(hx, hy, n > 1 ? `1–${n}` : '1', { fg: C.orange, bold: true, alpha: a });
      c.text(hx, hy, hint, { fg: C.slate, alpha: a });
    }
    return busy || t < 1000;
  }
  // Reveal: chips become bars racing to their share.
  const tg = Math.max(0, t - (state.guessAt ?? 0));
  const max = Math.max(...data.options.map(o => o.share));
  const nameW = Math.min(22, Math.max(...data.options.map(o => textWidth(o.name))) + 1);
  const barW = Math.max(6, r.w - nameW - 20);
  const rowGap = r.h >= 12 ? 2 : 1;
  let busy = tg < 1600;
  data.options.forEach((option, i) => {
    const y = r.y + i * rowGap;
    const correct = i === data.answer;
    const mine = i === state.guess;
    const k = s.caps.motion ? Math.min(1.08, spring((tg - i * 60) / 1000, 2.2, 0.5)) : 1;
    c.text(r.x, y, option.name, { fg: correct ? C.cream : C.gray, bold: correct }, nameW);
    hbar(c, r.x + nameW + 1, y, barW, (option.share / max) * Math.max(0, k), correct ? C.orange : mine ? C.slate : C.coal, !s.caps.unicode);
    const done = seg(tg, 700, 300);
    const pct = `${Math.round(option.share * 100)}%`;
    c.text(r.x + nameW + 2 + barW, y, pct, { fg: correct ? C.orange : C.gray, bold: correct, alpha: done });
    const tag = correct ? (s.caps.unicode ? ' ✓ #1' : ' #1') : mine ? (s.caps.unicode ? ' ✗ your pick' : ' x your pick') : '';
    if (tag) c.text(r.x + nameW + 2 + barW + textWidth(pct), y, tag, { fg: correct ? C.orange : C.slate, alpha: done, bold: correct });
  });
  const qy = r.y + n * rowGap + 1;
  const right = state.guess === data.answer;
  const winner = data.options[data.answer]!;
  const quip = state.guess === -1 ? `It was ${winner.name}.` : right ? 'Nailed it. You know yourself.' : `Not quite. It was ${winner.name}.`;
  const qa = seg(tg, 800, 300);
  if (qy < r.y + r.h) c.text(r.x, qy, quip, { fg: right ? C.orange : C.cream, bold: true, alpha: qa });
  if (data.after && qy + 2 < r.y + r.h) {
    const aa = seg(tg, 1100, 400);
    wrapText(data.after, r.w, 2).forEach((line, i) => { if (qy + 2 + i < r.y + r.h) c.text(r.x, qy + 2 + i, line, { fg: C.peach, alpha: aa }); });
    busy ||= aa < 1;
  }
  return busy;
}

/* ── face-off ── */

function gaugeRow(s: Scene, g: Gauge, x: number, y: number, w: number, color: number, k: number, unit: string): void {
  const { c } = s;
  const max = Math.max(g.per100, g.expected ?? 0) * 1.25 || 1;
  const barW = Math.max(8, w);
  c.text(x, y - 1, g.per100.toFixed(1), { fg: C.cream, bold: true, alpha: Math.min(1, k) });
  c.text(x + g.per100.toFixed(1).length + 1, y - 1, unit, { fg: C.gray, alpha: Math.min(1, k) });
  for (let i = 0; i < barW; i++) c.put(x + i, y, s.caps.unicode ? '━' : '-', C.coal);
  const fill = Math.round(barW * Math.min(1, (g.per100 / max) * k));
  for (let i = 0; i < fill; i++) c.put(x + i, y, s.caps.unicode ? '━' : '=', color);
  if (g.expected !== null) {
    const ex = x + Math.min(barW - 1, Math.round((g.expected / max) * barW));
    const done = k > 0.9 ? 1 : 0;
    c.put(ex, y, s.caps.unicode ? '╋' : '+', done ? C.cream : C.coal);
    c.text(ex, y + 1, `${s.caps.unicode ? '▲' : '^'} others ${g.expected.toFixed(1)}`, { fg: C.slate, alpha: done });
  }
}

function panel(s: Scene, g: Gauge, side: 'best' | 'worst', r: Rect, delay: number): boolean {
  const { c, t, tier } = s;
  const a = seg(t, delay, 350);
  const k = s.caps.motion ? Math.max(0, Math.min(1.1, spring((t - delay - 250) / 1000, 2, 0.55))) : 1;
  const color = side === 'best' ? C.peach : C.ember;
  const label = side === 'best' ? 'FAVOURITE' : 'NEMESIS';
  const unit = side === 'best' ? 'thank-yous / 100 prompts' : 'swears / 100 prompts';
  const face = side === 'best' ? 'heart-eyes' : 'side-eye';
  let tx = r.x;
  const pixel = s.caps.color === 'truecolor' || s.caps.color === '256';
  if (tier.id === 'L' && pixel && r.w >= 44) {
    drawMascot(c, r.x - 2, r.y + Math.round((1 - a) * 2), face, { bob: t - delay < 400 ? Math.sin(Math.PI * Math.min(1, (t - delay) / 400)) * 2 : 0 });
    tx = r.x + 18;
  } else if (tier.id !== 'S' && pixel && r.w >= 32) {
    drawMascot(c, r.x, r.y + 1, face, { size: 'compact' });
    tx = r.x + 11;
  }
  const tw = r.x + r.w - tx;
  c.text(tx, r.y, tier.id === 'L' ? spaced(label) : label, { fg: color, bold: true, alpha: a });
  if (tier.id === 'S' || tx === r.x) c.text(tx + textWidth(label) + 1, r.y, mascotLine(face, !s.caps.unicode), { fg: C.orange, alpha: a });
  c.text(tx, r.y + 1, g.label, { fg: C.cream, bold: true, alpha: a }, tw);
  gaugeRow(s, g, tx, r.y + 4, Math.min(tw - 2, 40), color, Math.max(0, k), unit);
  if (g.ratio !== null && r.h >= 9) {
    const ra = seg(t, delay + 700, 350);
    const ratio = `${g.ratio.toFixed(1)}×`;
    drawBig(c, tx, r.y + 6, ratio, { color: (_x, py) => fade(mix(C.cream, color, py / 4), ra) });
    c.text(tx + bigWidth(ratio) + 2, r.y + 7, side === 'best' ? 'nicer than' : 'harsher than', { fg: C.gray, alpha: ra }, tw - bigWidth(ratio) - 2);
    c.text(tx + bigWidth(ratio) + 2, r.y + 8, 'to the others', { fg: C.gray, alpha: ra }, tw - bigWidth(ratio) - 2);
  } else if (g.ratio !== null) {
    c.text(tx, r.y + 6, `${g.ratio.toFixed(1)}× vs the others`, { fg: color, bold: true, alpha: seg(t, delay + 700, 350) });
  }
  // Springs overshoot and come back, so "busy" is decided by time, not by k.
  return t < delay + 1700;
}

/** Every model's observed rate next to what the others got in the same months. */
function compareChart(s: Scene, data: Data<'faceoff'>, r: Rect): boolean {
  const { c, t } = s;
  const a = seg(t, 400, 350);
  c.text(r.x, r.y, data.compareUnit.toUpperCase(), { fg: C.gray, alpha: a }, r.w);
  const max = Math.max(1e-9, ...data.compare.flatMap(m => [m.observed, m.expected ?? 0]));
  const nameW = Math.min(16, Math.max(...data.compare.map(m => textWidth(m.label))) + 2);
  const barW = Math.max(8, r.w - nameW - 7);
  let busy = a < 1;
  data.compare.forEach((m, i) => {
    const y = r.y + 2 + i * 2;
    if (y >= r.y + r.h + 4) return;
    const k = seg(t, 500 + i * 90, 600, easeOutCubic);
    busy ||= k < 1;
    c.text(r.x, y, m.label, { fg: m.highlight ? C.cream : C.gray, bold: m.highlight, alpha: a }, nameW - 1);
    const fill = Math.round(barW * (m.observed / max) * k);
    for (let x = 0; x < barW; x++) c.put(r.x + nameW + x, y, s.caps.unicode ? '━' : '-', x < fill ? (m.highlight ? C.ember : fade(C.orange, 0.55)) : C.coal);
    if (m.expected !== null) {
      const ex = r.x + nameW + Math.min(barW - 1, Math.round(barW * (m.expected / max)));
      c.put(ex, y, s.caps.unicode ? '┃' : '|', k >= 1 ? C.cream : C.coal);
    }
    c.text(r.x + nameW + barW + 1, y, m.observed.toFixed(1), { fg: m.highlight ? C.cream : C.gray, alpha: k });
  });
  const ly = r.y + 3 + data.compare.length * 2;
  if (ly < r.y + r.h) c.text(r.x, ly, `${s.caps.unicode ? '┃' : '|'} = what the other models got in the same months`, { fg: C.slate, alpha: seg(t, 1000, 300) }, r.w);
  return busy;
}

export function faceoffBody(s: Scene, data: Data<'faceoff'>, r: Rect): boolean {
  const { c, t } = s;
  const both = data.best && data.worst;
  const compare = !both && data.compare.length >= 2 && r.w >= 90;
  const gap = both || compare ? (s.tier.id === 'L' ? 10 : 6) : 0;
  const pw = both || compare ? Math.floor((r.w - gap) / 2) : r.w;
  const y = r.y + Math.max(0, Math.floor((r.h - 10) * 0.3));
  const ph = Math.min(r.h, 10);
  let busy = false;
  if (data.best) busy = panel(s, data.best, 'best', { x: r.x, y, w: pw, h: ph }, 80) || busy;
  if (data.worst) busy = panel(s, data.worst, 'worst', { x: r.x + (both ? pw + gap : 0), y, w: pw, h: ph }, both ? 260 : 80) || busy;
  if (compare) busy = compareChart(s, data, { x: r.x + pw + gap, y, w: r.w - pw - gap, h: ph }) || busy;
  if (both) {
    const k = seg(t, 450, 400, easeOutCubic);
    const vx = r.x + pw + Math.floor(gap / 2) - 1;
    if (s.tier.id === 'L') drawBig(c, vx - 2, y + 3, 'VS', { color: () => fade(C.slate, k) });
    else c.text(vx, y + 4, 'vs', { fg: C.slate, bold: true, alpha: k });
    busy ||= k < 1;
  }
  void textRight;
  return busy;
}

/** Projects (growing bars + a fading postcard), delegation (spawning clones), the awards shelf. */
import { C, fade, mix } from '../gfx/color.js';
import { box, hbar, spaced, textCenter, textRight, textWidth, wrapText, type Rect } from '../gfx/draw.js';
import { bigWidth, drawBig } from '../gfx/font.js';
import { easeOutCubic, seg, spring } from '../gfx/motion.js';
import { count, money, shortDate } from '../format.js';
import { monthLabel, type DeckCard } from '../story/deck.js';
import type { Scene } from './scene.js';

type Data<K extends DeckCard['kind']> = Extract<DeckCard, { kind: K }>['data'];

function postcard(s: Scene, away: NonNullable<Data<'projects'>['gotAway']>, r: Rect, delay: number): boolean {
  const { c, t } = s;
  const appear = seg(t, delay, 400);
  // Vivid at first, then it fades like an old photo.
  const age = seg(t, delay + 900, 1600, easeOutCubic);
  const a = appear * (1 - age * 0.45);
  const border = fade(mix(C.peach, C.gray, age), appear);
  box(c, r, border, { dashed: true, ascii: !s.caps.unicode });
  const ix = r.x + 2, iw = r.w - 4;
  c.text(ix, r.y + 1, 'WISH YOU WERE HERE', { fg: mix(C.peach, C.gray, age), alpha: appear, bold: true }, iw - 6);
  // Postmark.
  const stamp = `${away.idle}d`;
  c.text(r.x + r.w - 3 - textWidth(stamp), r.y + 1, stamp, { fg: C.ink, bg: fade(mix(C.orange, C.slate, age), appear), bold: true });
  let y = r.y + 3;
  c.text(ix, y++, s.share ? 'a project' : away.name, { fg: mix(C.cream, C.gray, age), bold: true, alpha: appear }, iw);
  c.text(ix, y++, `${count(away.prompts)} prompts in ${away.days} days`, { fg: C.gray, alpha: a }, iw);
  c.text(ix, y++, `then silence for ${away.idle} days`, { fg: mix(C.orange, C.slate, age), alpha: appear }, iw);
  if (away.lastWords && !s.share && y + 2 < r.y + r.h - 1) {
    y++;
    c.text(ix, y++, 'your last words to it:', { fg: C.slate, alpha: a }, iw);
    for (const line of wrapText(`“${away.lastWords}”`, iw, Math.max(1, r.y + r.h - 2 - y))) c.text(ix, y++, line, { fg: mix(C.cream, C.gray, age), italic: true, alpha: a });
  }
  if (y < r.y + r.h - 1) textRight(c, r.x + r.w - 2, r.y + r.h - 2, shortDate(away.lastDay, true), { fg: C.slate, alpha: a });
  return t < delay + 2500;
}

export function projectsBody(s: Scene, data: Data<'projects'>, r: Rect): boolean {
  const { c, t, tier } = s;
  const cardW = tier.id === 'L' ? 42 : 34;
  const side = data.gotAway && r.w - cardW - 4 >= 34;
  const below = data.gotAway && !side && r.h >= 12;
  const barsW = side ? r.w - cardW - 4 : r.w;
  const maxRows = below ? Math.max(2, r.h - 8) : r.h;
  const rows = data.rows.slice(0, Math.min(6, Math.ceil(maxRows / (r.h >= 12 && !below ? 2 : 1))));
  const step = rows.length * 2 <= maxRows ? 2 : 1;
  const max = Math.max(...rows.map(p => p.prompts));
  const nameW = Math.min(20, Math.max(...rows.map(p => textWidth(s.share ? 'Project A' : p.name))) + 1);
  const valW = 6;
  const costW = rows.some(p => p.cost !== null) && barsW >= 50 ? 8 : 0;
  const barW = Math.max(6, barsW - nameW - valW - costW - 3);
  let busy = false;
  rows.forEach((p, i) => {
    const y = r.y + i * step;
    const k = s.caps.motion ? Math.min(1, spring((t - 100 - i * 90) / 1000, 2, 0.7)) : 1;
    busy ||= t < 100 + i * 90 + 900;
    const name = s.share ? `Project ${String.fromCharCode(65 + i)}` : p.name;
    const away = data.gotAway && p.name === data.gotAway.name;
    c.text(r.x, y, name, { fg: i === 0 ? C.cream : away ? C.peach : C.gray, bold: i === 0 }, nameW - 1);
    hbar(c, r.x + nameW, y, barW, (p.prompts / max) * Math.max(0, k), i === 0 ? C.orange : away ? fade(C.peach, 0.7) : fade(C.orange, 0.55), !s.caps.unicode);
    textRight(c, r.x + nameW + barW + 1 + valW, y, count(Math.round(p.prompts * Math.min(1, Math.max(0, k)))), { fg: C.cream });
    if (costW && p.cost !== null) textRight(c, r.x + nameW + barW + 1 + valW + costW, y, '$' + count(Math.round(p.cost)), { fg: C.slate });
  });
  if (data.gotAway) {
    if (side) busy = postcard(s, data.gotAway, { x: r.x + barsW + 4, y: r.y, w: cardW, h: Math.min(r.h, 13) }, 500) || busy;
    else if (below) busy = postcard(s, data.gotAway, { x: r.x, y: r.y + rows.length * step + 1, w: Math.min(r.w, 56), h: Math.min(7, r.y + r.h - (r.y + rows.length * step + 1)) }, 500) || busy;
  }
  return busy;
}

/* ── delegation: little Slopie clones ── */

const MINI = ['.ooo.', 'oeoeo', 'rrrrr'];

/** A 5×4-pixel Slopie (5 cols × 2 rows). `pop` 0..1 scales it in from a cream flash. */
function clone(s: Scene, x: number, y: number, pop: number): void {
  const { c } = s;
  if (s.caps.color === 'none' || s.caps.color === '16') { c.text(x, y, s.caps.unicode ? '(•ᴗ•)' : '(o_o)', { fg: C.orange }); return; }
  const flash = pop < 1 ? 1 - pop : 0;
  MINI.forEach((row, py) => {
    for (let px = 0; px < row.length; px++) {
      const ch = row[px];
      if (ch === '.') continue;
      const base = ch === 'e' ? C.pupil : ch === 'r' ? C.rust : px === 1 && py === 0 ? C.peach : C.orange;
      c.px(x + px, y * 2 + py, mix(base, C.cream, flash * 0.8));
    }
  });
}

export function delegationBody(s: Scene, data: Data<'delegation'>, r: Rect): boolean {
  const { c, t, tier } = s;
  const total = `${count(data.total)}`;
  const a = seg(t, 0, 300);
  const scale = tier.id === 'L' ? 2 : 1;
  drawBig(c, r.x, r.y, total, { scale, color: (_x, py) => fade(mix(C.cream, C.orange, py / (5 * scale - 1)), a) });
  const tw = bigWidth(total, scale);
  c.text(r.x, r.y + (scale === 2 ? 6 : 4), 'subagents launched', { fg: C.gray, alpha: a });
  const months = data.months;
  if (!months.length) return a < 1;
  const colW = 6;
  const sideBySide = r.w - Math.max(tw, 20) - 6 >= months.length * colW;
  const gx = sideBySide ? r.x + Math.max(tw, 20) + 6 : r.x;
  const gy = sideBySide ? r.y : r.y + (scale === 2 ? 8 : 6);
  const gh = Math.max(2, r.y + r.h - gy - 2);
  const perCol = Math.max(1, Math.floor(gh / 2));
  const max = Math.max(1, ...months.map(m => m.n));
  const unit = Math.max(1, Math.ceil(max / perCol));
  let order = 0;
  let busy = false;
  months.forEach((m, i) => {
    const x = gx + i * colW;
    const stack = Math.ceil(m.n / unit);
    for (let k = 0; k < stack; k++) {
      const at = 250 + order++ * 28;
      const pop = seg(t, at, 260);
      busy ||= pop < 1;
      if (pop <= 0) continue;
      const hop = pop < 1 ? Math.round(Math.sin(Math.PI * pop) * 1) : 0;
      clone(s, x, gy + gh - 2 - k * 2 - hop, pop);
    }
    if (!m.n) c.put(x + 2, gy + gh - 1, '·', C.slate);
    c.text(x, gy + gh, monthLabel(m.month), { fg: data.firstMonth === m.month ? C.orange : C.slate });
  });
  const la = seg(t, 400 + order * 28, 300);
  const legend = `each slopie = ${unit} subagent${unit === 1 ? '' : 's'}`;
  if (gy + gh + 1 <= r.y + r.h) c.text(gx, gy + gh + 1, legend, { fg: C.slate, alpha: la });
  return busy || la < 1;
}

/* ── awards shelf ── */

const CUP = ['.#####.', '##ooo##', '#.ooo.#', '.#ooo#.', '..ooo..', '...o...', '..ooo..', '.ooooo.'];

function trophy(s: Scene, x: number, y: number, dy: number, a: number, rank: number, scale = 1): void {
  const { c } = s;
  if (s.caps.color === 'none' || s.caps.color === '16') {
    c.text(x + 1, y + 1, '\\_/', { fg: C.orange });
    c.text(x + 2, y + 2, '|', { fg: C.orange });
    c.text(x + 1, y + 3, '/_\\', { fg: C.orange });
    return;
  }
  const top = rank === 0 ? C.cream : C.peach;
  const bottom = rank === 0 ? C.orange : C.rust;
  CUP.forEach((row, py) => {
    for (let px = 0; px < row.length; px++) {
      if (row[px] === '.') continue;
      const color = row[px] === '#' ? mix(top, bottom, py / 7) : mix(C.peach, C.orange, py / 7);
      const col = fade(px === 2 && py < 4 && row[px] === 'o' ? C.white : color, a);
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) c.px(x + px * scale + sx, y * 2 + py * scale + sy + dy, col);
    }
  });
}

export function awardsBody(s: Scene, data: Data<'awards'>, r: Rect): boolean {
  const { c, t, tier } = s;
  const perRow = tier.id === 'L' ? Math.min(6, data.trophies.length) : 3;
  const rowsNeeded = Math.ceil(data.trophies.length / perRow);
  const big = tier.id === 'L' && r.h >= 14 && s.caps.color !== 'none' && s.caps.color !== '16';
  const cupH = big ? 8 : 4;
  const rowH = cupH + 5;
  const shelves = Math.min(rowsNeeded, Math.max(1, Math.floor((r.h + 1) / rowH)));
  const colW = Math.floor(r.w / perRow);
  let busy = false;
  for (let row = 0; row < shelves; row++) {
    const y = r.y + row * rowH;
    const shelfY = y + cupH;
    const items = data.trophies.slice(row * perRow, (row + 1) * perRow);
    const sa = seg(t, row * 300, 300);
    for (let x = r.x; x < r.x + Math.min(r.w, items.length * colW); x++) c.put(x, shelfY, s.caps.unicode ? '▀' : '=', fade(C.rust, sa));
    items.forEach((award, i) => {
      const index = row * perRow + i;
      const delay = 150 + index * 160;
      const fall = s.caps.motion ? spring((t - delay) / 1000, 2.6, 0.45) : 1;
      busy ||= t < delay + 900;
      if (t < delay) return;
      const cx = r.x + i * colW + Math.floor(colW / 2);
      const dy = Math.round((1 - Math.min(1.15, fall)) * -10);
      trophy(s, cx - (big ? 7 : 3), y, dy * (big ? 2 : 1), Math.min(1, fall * 1.5), index, big ? 2 : 1);
      const la = seg(t, delay + 300, 300);
      textCenter(c, cx, shelfY + 1, award.title, { fg: C.gray, alpha: la });
      textCenter(c, cx, shelfY + 2, award.value, { fg: index === 0 ? C.orange : C.cream, bold: true, alpha: la });
      textCenter(c, cx, shelfY + 3, award.sub, { fg: C.slate, alpha: la });
    });
  }
  return busy;
}

/**
 * Card chrome: the story progress rail, kicker, headline + receipt line, Slopie in the corner,
 * and the key hints. Returns the free body rectangle for the card's own visual.
 */
import { C, fade } from '../gfx/color.js';
import { drawSpans, rich, spaced, textWidth, wrapSpans, type Rect } from '../gfx/draw.js';
import { easeOutCubic, seg } from '../gfx/motion.js';
import { drawMascot, mascotLine, type Expression } from '../mascot.js';
import type { DeckCard } from '../story/deck.js';
import type { Scene } from './scene.js';

export interface ChromeOptions {
  headline?: boolean;
  mascot?: boolean;
  expression?: Expression;
  /** Extra hint shown first in the footer (e.g. "1–4 guess"). */
  hint?: string;
  /** Max headline lines. */
  maxLines?: number;
  /** Start the body right under the kicker (the card avoids Slopie itself). */
  bodyUnderKicker?: boolean;
}

export function drawRail(s: Scene, y: number): boolean {
  const { c, w, tier, index, total, t } = s;
  const x0 = tier.mx;
  const width = w - tier.mx * 2;
  const gap = total * 2 - 1 <= width ? 1 : 0;
  const segW = Math.max(1, Math.floor((width - gap * (total - 1)) / total));
  const fill = seg(t, 0, 420, easeOutCubic);
  for (let i = 0; i < total; i++) {
    const sx = x0 + i * (segW + gap);
    for (let k = 0; k < segW; k++) {
      const done = i < index || (i === index && k < Math.ceil(segW * fill));
      const color = done ? (i === index ? C.orange : fade(C.orange, 0.55)) : C.coal;
      c.put(sx + k, y, s.caps.unicode ? (done ? '━' : '─') : (done ? '=' : '-'), color);
    }
  }
  return fill < 1;
}

export function drawFooter(s: Scene, extra?: string): void {
  const { c, w, h, tier } = s;
  const y = tier.id === 'L' ? h - 2 : h - 1;
  const arrows = s.caps.unicode ? '← →' : '< >';
  const items: [string, string][] = [];
  if (extra) items.push([extra.split(' ')[0]!, extra.split(' ').slice(1).join(' ')]);
  items.push([arrows, tier.id === 'S' ? '' : 'move'], ['b', 'board'], ['s', 'share'], ['?', 'how'], ['q', 'quit']);
  let x = tier.mx;
  for (const [key, label] of items) {
    const need = textWidth(key) + (label ? 1 + textWidth(label) : 0) + 3;
    if (x + need > w - tier.mx - (tier.id === 'S' ? 0 : 12)) break;
    x += c.text(x, y, key, { fg: C.gray, bold: true });
    if (label) x += 1 + c.text(x + 1, y, label, { fg: C.slate });
    x += 3;
  }
  if (tier.id !== 'S') {
    const local = 'all local';
    c.text(w - tier.mx - textWidth(local) - 2, y, s.caps.unicode ? '●' : '*', { fg: fade(C.orange, 0.7) });
    c.text(w - tier.mx - textWidth(local), y, local, { fg: C.slate });
  }
}

export function drawMascotCorner(s: Scene, expression: Expression, y: number): { x: number; w: number; h: number } {
  const { c, w, tier, t } = s;
  const hop = t < 420 ? Math.sin(Math.PI * Math.min(1, t / 420)) * 2 : 0;
  const face: Expression = s.blink && (expression === 'idle' || expression === 'waving' || expression === 'waving2') ? 'blink' : expression;
  if (tier.mascot === 'big' && s.caps.color !== 'none' && s.caps.color !== '16') {
    const x = w - tier.mx - 18;
    drawMascot(c, x, y, face, { bob: hop });
    return { x, w: 18, h: 9 };
  }
  if (tier.mascot !== 'line' && s.caps.color !== 'none' && s.caps.color !== '16') {
    const x = w - tier.mx - 9;
    drawMascot(c, x, y, face, { size: 'compact', bob: hop > 1 ? 1 : 0 });
    return { x, w: 10, h: 4 };
  }
  const line = mascotLine(face, !s.caps.unicode);
  const x = w - tier.mx - textWidth(line);
  c.text(x, y, line, { fg: C.orange, bold: true });
  return { x, w: textWidth(line), h: 1 };
}

/** Draw chrome; returns the body rectangle and whether chrome is still animating. */
export function drawChrome(s: Scene, card: DeckCard, options: ChromeOptions = {}): { body: Rect; busy: boolean; mascot: Rect } {
  const { c, w, h, tier, t } = s;
  const L = tier.id === 'L';
  const railY = L ? 1 : 0;
  let busy = drawRail(s, railY);
  const kickY = L ? 3 : tier.id === 'M' ? 2 : 2;
  const a = seg(t, 0, 220);
  busy ||= a < 1;
  const kicker = L ? spaced(card.kicker) : card.kicker;
  c.text(tier.mx, kickY, kicker, { fg: C.orange, bold: true, alpha: a });
  const pos = `${s.index + 1}/${s.total}`;

  let mascotBox = { x: w, w: 0, h: 0 };
  if (options.mascot !== false) {
    const my = L ? 2 : 1;
    mascotBox = drawMascotCorner(s, options.expression ?? card.expression, tier.mascot === 'line' ? kickY : my);
  }
  if (tier.mascot === 'line' || options.mascot === false) c.text(Math.min(mascotBox.x, w - tier.mx) - textWidth(pos) - 2, kickY, pos, { fg: C.slate, alpha: a });
  else c.text(tier.mx + textWidth(kicker) + 3, kickY, pos, { fg: C.slate, alpha: a });

  let y = kickY + 2;
  if (options.headline !== false) {
    const right = tier.mascot === 'line' || options.mascot === false ? w - tier.mx : mascotBox.x - 3;
    const width = Math.max(20, right - tier.mx);
    const maxLines = options.maxLines ?? 3;
    const lines = wrapSpans(rich(card.headline, { fg: C.cream, bold: true }), width);
    lines.slice(0, maxLines).forEach((line, i) => {
      const la = seg(t, 60 + i * 70, 260);
      busy ||= la < 1;
      drawSpans(c, tier.mx, y + i, line, la);
    });
    y += Math.min(maxLines, lines.length);
    if (card.support) {
      y += 1;
      const sw = Math.max(20, (y >= (L ? 2 : 1) + mascotBox.h ? w - tier.mx : right) - tier.mx);
      const support = wrapSpans(rich(card.support, { fg: C.gray }, { fg: C.peach, bold: false }, { fg: C.peach, italic: true }), sw).slice(0, L ? 2 : 2);
      const sa = seg(t, 200, 300);
      busy ||= sa < 1;
      support.forEach((line, i) => drawSpans(c, tier.mx, y + i, line, sa));
      y += support.length;
    }
  }
  const minTop = options.mascot === false ? y + 1 : Math.max(y + 1, (L ? 2 : 1) + mascotBox.h + (L ? 0 : 0));
  const top = options.bodyUnderKicker ? kickY + 2 : Math.max(y + 2, minTop);
  const bottom = L ? h - 3 : h - 2;
  drawFooter(s, options.hint);
  const mascotRect = { x: mascotBox.x, y: tier.mascot === 'line' ? kickY : (L ? 2 : 1), w: mascotBox.w, h: mascotBox.h };
  return { body: { x: tier.mx, y: top, w: w - tier.mx * 2, h: Math.max(0, bottom - top) }, busy, mascot: mascotRect };
}

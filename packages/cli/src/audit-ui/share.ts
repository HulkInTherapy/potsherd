/**
 * Share card: the board card rendered (anonymised) into a cell buffer, then into an SVG.
 * Half-block pixels become exact rectangles so Slopie and the heatmap stay crisp.
 */
import type { AuditSnapshot } from '../../../core/src/analytics/contracts.js';
import { Canvas } from './gfx/canvas.js';
import { C, hex } from './gfx/color.js';
import { renderCard } from './cards/index.js';
import { tierFor } from './cards/scene.js';
import { buildDeck } from './story/deck.js';

const CW = 9;
const CH = 18;

export function shareCanvas(snapshot: AuditSnapshot, columns = 100, rows = 30): Canvas | null {
  const deck = buildDeck(snapshot);
  const board = deck.at(-1);
  if (!board || board.kind !== 'board') return null;
  const c = new Canvas(columns, rows, C.ink);
  c.fill(0, 0, columns, rows, ' ', { bg: C.ink });
  renderCard({
    c, w: columns, h: rows, t: Infinity, tier: tierFor(columns, rows)!, caps: { color: 'truecolor', motion: false, unicode: true },
    blink: false, state: {}, index: deck.length - 1, total: deck.length, share: true,
  }, board);
  // The footer keys mean nothing in a picture.
  const footerY = rows - 2;
  for (let x = 0; x < columns; x++) c.put(x, footerY, ' ', C.cream, C.ink);
  c.text(4, footerY, 'slopie audit', { fg: C.orange, bold: true });
  c.text(17, footerY, '· computed locally · nothing left the machine', { fg: C.slate });
  return c;
}

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function canvasToSvg(c: Canvas, title = 'slopie audit'): string {
  const parts: string[] = [];
  for (let y = 0; y < c.h; y++) {
    let x = 0;
    while (x < c.w) {
      const i = y * c.w + x;
      const ch = c.ch[i]!;
      const fg = c.fg[i]!;
      const bg = c.bg[i]!;
      const X = x * CW, Y = y * CH;
      if (bg >= 0 && bg !== C.ink) parts.push(`<rect x="${X}" y="${Y}" width="${CW}" height="${CH}" fill="${hex(bg)}"/>`);
      if (ch === '▀') parts.push(`<rect x="${X}" y="${Y}" width="${CW}" height="${CH / 2}" fill="${hex(fg)}"/>`);
      else if (ch === '▄') parts.push(`<rect x="${X}" y="${Y + CH / 2}" width="${CW}" height="${CH / 2}" fill="${hex(fg)}"/>`);
      else if (ch === '█') parts.push(`<rect x="${X}" y="${Y}" width="${CW}" height="${CH}" fill="${hex(fg)}"/>`);
      else if (ch !== ' ' && ch !== '') {
        // Merge a run of glyphs that share a style into one <text>.
        let run = ch;
        let k = x + 1;
        while (k < c.w) {
          const j = y * c.w + k;
          const next = c.ch[j]!;
          if (next === '' ) { k++; continue; }
          if (next === ' ' || '▀▄█'.includes(next) || c.fg[j] !== fg || c.at[j] !== c.at[i] || c.bg[j] !== bg) break;
          run += next;
          k++;
        }
        const bold = c.at[i]! & 1 ? ' font-weight="700"' : '';
        const italic = c.at[i]! & 4 ? ' font-style="italic"' : '';
        parts.push(`<text x="${X}" y="${Y + 13}" fill="${hex(fg)}"${bold}${italic} textLength="${[...run].length * CW}" lengthAdjust="spacingAndGlyphs">${esc(run)}</text>`);
        x = k;
        continue;
      }
      x++;
    }
  }
  const width = c.w * CW, height = c.h * CH;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<title>${esc(title)}</title>`,
    `<rect width="100%" height="100%" rx="14" fill="${hex(C.ink)}"/>`,
    `<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="14" xml:space="preserve">`,
    ...parts,
    '</g>',
    '</svg>',
    '',
  ].join('\n');
}

export function storyShareSvg(snapshot: AuditSnapshot): string | null {
  const canvas = shareCanvas(snapshot);
  if (!canvas) return null;
  const board = buildDeck(snapshot).at(-1);
  const archetype = board?.kind === 'board' ? board.data.archetype : null;
  return canvasToSvg(canvas, archetype ? `slopie audit · This year you've been ${archetype}` : 'slopie audit');
}

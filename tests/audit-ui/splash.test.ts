import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS launcher module
import { splashCells, splashGeometry } from '../../packages/cli/bin/audit-splash.js';
import { Canvas } from '../../packages/cli/src/audit-ui/gfx/canvas.js';
import { C, hex } from '../../packages/cli/src/audit-ui/gfx/color.js';
import { loadingGeometry } from '../../packages/cli/src/audit-ui/loading.js';
import { drawMascot } from '../../packages/cli/src/audit-ui/mascot.js';

/** Cell → [top, bottom] pixel colours as the canvas draws them. */
function canvasCells(c: Canvas): Map<string, [string | null, string | null]> {
  const cells = new Map<string, [string | null, string | null]>();
  for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
    const i = y * c.w + x;
    const ch = c.ch[i];
    const fg = hex(c.fg[i]!).toLowerCase(), bg = c.bg[i] === C.ink ? null : hex(c.bg[i]!).toLowerCase();
    if (ch === '█') cells.set(`${x},${y}`, [fg, fg]);
    else if (ch === '▀') cells.set(`${x},${y}`, [fg, bg]);
    else if (ch === '▄') cells.set(`${x},${y}`, [null, fg]);
  }
  return cells;
}

describe('instant splash', () => {
  it('uses the same geometry as the loading story', () => {
    for (const [w, h] of [[120, 40], [100, 30], [80, 24], [60, 20], [200, 60]]) expect(splashGeometry(w, h)).toEqual(loadingGeometry(w, h));
  });

  it('draws exactly the same Slopie', () => {
    for (const [size, scale] of [['big', 1], ['big', 2], ['compact', 1]] as const) {
      const c = new Canvas(60, 30, C.ink);
      c.fill(0, 0, 60, 30, ' ', { bg: C.ink });
      drawMascot(c, 3, 2, 'idle', { size, scale });
      const splash = splashCells(size, 3, 2, scale) as Map<string, [string | null, string | null]>;
      expect(Object.fromEntries(splash)).toEqual(Object.fromEntries(canvasCells(c)));
    }
  });
});

/**
 * Slopie: a small, friendly orange slime. Pixel data drawn with half-blocks
 * (two square pixels per terminal cell), so it looks the same in every truecolor terminal.
 *
 *   big      14×14 px = 14 cols × 7 rows
 *   compact   8×8  px =  8 cols × 4 rows
 *   line     one-line kaomoji for tiny or colourless terminals
 */
import { Canvas } from './gfx/canvas.js';
import { C, mix, type Rgb } from './gfx/color.js';

export type Expression =
  | 'idle' | 'blink' | 'chewing' | 'chewing2' | 'shocked' | 'smirk' | 'sleepy' | 'heart-eyes' | 'side-eye' | 'proud' | 'waving' | 'waving2' | 'sad';

export type MascotSize = 'big' | 'compact' | 'line';

type Px = [number, number, Rgb];

const O = C.orange;
const SHADE = mix(C.orange, C.rust, 0.55);
const RIM = C.rust;
const EYE = C.pupil;
const GLINT = C.white;
const MOUTH = C.deep;
const TONGUE = C.ember;
const BLUSH = mix(C.ember, C.peach, 0.35);
const HEART = C.cream;

/* ── big (14 × 14) ── */

const BIG_W = 14;
const BIG_H = 14;
/** Silhouette: [left, right] per pixel row. A drop-shaped slime that settles into a puddle. */
const BIG_SPANS: readonly [number, number][] = [
  [5, 8], [3, 10], [2, 11], [1, 12], [1, 12], [0, 13], [0, 13], [0, 13], [0, 13], [0, 13], [0, 13], [0, 13], [1, 12], [2, 11],
];

function bigBody(fullness = 0): Px[] {
  const px: Px[] = [];
  BIG_SPANS.forEach(([l, r], y) => {
    const grow = y >= 6 ? fullness : 0;
    for (let x = l - grow; x <= r + grow; x++) {
      let color: Rgb = O;
      const edgeR = x >= r + grow - (y >= 4 ? 1 : 0);
      if (y >= 12) color = RIM;
      else if (y === 11 && (x <= l - grow + 1 || x >= r + grow - 1)) color = RIM;
      else if (y >= 10 && (x === l - grow || x === r + grow)) color = RIM;
      else if (edgeR && y >= 3) color = SHADE;
      px.push([x, y, color]);
    }
  });
  // The soft-serve tip.
  px.push([7, -1, O], [8, -1, O], [8, -2, O], [9, -2, SHADE]);
  // Glossy highlight, top-left.
  px.push([5, 1, C.peach], [6, 1, C.peach], [3, 2, C.peach], [4, 2, C.cream], [5, 2, C.peach], [3, 3, C.peach], [2, 4, C.peach]);
  // Two drips: it is slop, after all.
  px.push([3, 14, RIM], [11, 14, RIM], [11, 15, SHADE]);
  return px;
}

/** Eye centres (left pixel column of each 2×2 eye) and the row of the eye's top. */
const EL = 3, ER = 9, EY = 6;

function eyes(kind: 'open' | 'blink' | 'happy' | 'wide' | 'lid' | 'side' | 'heart' | 'sleepy', px: Px[]): void {
  for (const ex of [EL, ER]) {
    switch (kind) {
      case 'open':
        px.push([ex, EY, GLINT], [ex + 1, EY, EYE], [ex, EY + 1, EYE], [ex + 1, EY + 1, EYE]);
        break;
      case 'blink':
        px.push([ex, EY + 1, EYE], [ex + 1, EY + 1, EYE]);
        break;
      case 'happy': // ^ ^
        px.push([ex, EY + 1, EYE], [ex + 1, EY, EYE], [ex + 2, EY + 1, EYE]);
        break;
      case 'sleepy': // − − drooping
        px.push([ex, EY + 1, EYE], [ex + 1, EY + 1, EYE], [ex + 1, EY + 2, SHADE]);
        break;
      case 'wide':
        px.push([ex - 1, EY - 1, GLINT], [ex, EY - 1, GLINT], [ex + 1, EY - 1, GLINT], [ex + 2, EY - 1, GLINT]);
        px.push([ex - 1, EY, GLINT], [ex, EY, EYE], [ex + 1, EY, EYE], [ex + 2, EY, GLINT]);
        px.push([ex - 1, EY + 1, GLINT], [ex, EY + 1, EYE], [ex + 1, EY + 1, EYE], [ex + 2, EY + 1, GLINT]);
        px.push([ex, EY + 2, GLINT], [ex + 1, EY + 2, GLINT]);
        break;
      case 'lid': // half-closed, unimpressed
        px.push([ex, EY, SHADE], [ex + 1, EY, SHADE], [ex, EY + 1, EYE], [ex + 1, EY + 1, EYE]);
        break;
      case 'side': // white eyes, pupils hard right
        px.push([ex - 1, EY, GLINT], [ex, EY, GLINT], [ex + 1, EY, EYE]);
        px.push([ex - 1, EY + 1, GLINT], [ex, EY + 1, GLINT], [ex + 1, EY + 1, EYE]);
        px.push([ex - 1, EY - 1, SHADE], [ex, EY - 1, SHADE], [ex + 1, EY - 1, SHADE]);
        break;
      case 'heart': { // 5×4 hearts
        const hx = ex === EL ? 1 : 8;
        px.push([hx + 1, EY - 1, HEART], [hx + 3, EY - 1, HEART]);
        for (let k = 0; k < 5; k++) px.push([hx + k, EY, HEART]);
        for (let k = 1; k < 4; k++) px.push([hx + k, EY + 1, HEART]);
        px.push([hx + 2, EY + 2, HEART]);
        px.push([hx, EY - 1, O], [hx + 2, EY - 1, O], [hx + 4, EY - 1, O]);
        break;
      }
    }
  }
}

function mouth(kind: 'smile' | 'open' | 'chew' | 'o' | 'smirk' | 'flat' | 'grin' | 'small' | 'frown', px: Px[]): void {
  const my = 9;
  switch (kind) {
    case 'smile':
      px.push([5, my, MOUTH], [8, my, MOUTH], [6, my + 1, MOUTH], [7, my + 1, MOUTH]);
      break;
    case 'grin':
      px.push([4, my, MOUTH], [5, my, MOUTH], [6, my, MOUTH], [7, my, MOUTH], [8, my, MOUTH], [9, my, MOUTH]);
      px.push([5, my + 1, MOUTH], [6, my + 1, TONGUE], [7, my + 1, TONGUE], [8, my + 1, MOUTH]);
      break;
    case 'open':
      px.push([5, my, MOUTH], [6, my, MOUTH], [7, my, MOUTH], [8, my, MOUTH]);
      px.push([5, my + 1, MOUTH], [6, my + 1, TONGUE], [7, my + 1, TONGUE], [8, my + 1, MOUTH]);
      px.push([6, my + 2, MOUTH], [7, my + 2, MOUTH]);
      break;
    case 'chew':
      px.push([5, my + 1, MOUTH], [6, my + 1, MOUTH], [7, my + 1, MOUTH], [8, my + 1, MOUTH]);
      break;
    case 'o':
      px.push([6, my, MOUTH], [7, my, MOUTH], [6, my + 1, MOUTH], [7, my + 1, MOUTH]);
      break;
    case 'small':
      px.push([6, my + 1, MOUTH], [7, my + 1, MOUTH]);
      break;
    case 'smirk':
      px.push([5, my + 1, MOUTH], [6, my + 1, MOUTH], [7, my + 1, MOUTH], [8, my, MOUTH], [9, my - 1, MOUTH]);
      break;
    case 'flat':
      px.push([5, my + 1, MOUTH], [6, my + 1, MOUTH], [7, my + 1, MOUTH], [8, my + 1, MOUTH]);
      break;
    case 'frown':
      px.push([6, my, MOUTH], [7, my, MOUTH], [5, my + 1, MOUTH], [8, my + 1, MOUTH]);
      break;
  }
}

function blush(px: Px[]): void {
  px.push([1, 9, BLUSH], [2, 9, BLUSH], [11, 9, BLUSH], [12, 9, BLUSH]);
}

function bigPixels(expression: Expression, fullness = 0): Px[] {
  const px = bigBody(fullness);
  switch (expression) {
    case 'idle': eyes('open', px); mouth('smile', px); blush(px); break;
    case 'blink': eyes('blink', px); mouth('smile', px); blush(px); break;
    case 'chewing': eyes('happy', px); mouth('chew', px); blush(px); break;
    case 'chewing2': eyes('happy', px); mouth('o', px); blush(px); break;
    case 'shocked': eyes('wide', px); mouth('open', px); break;
    case 'smirk': eyes('lid', px); mouth('smirk', px); blush(px); break;
    case 'sleepy': eyes('sleepy', px); mouth('small', px); break;
    case 'heart-eyes': eyes('heart', px); mouth('grin', px); blush(px); break;
    case 'side-eye': eyes('side', px); mouth('flat', px); break;
    case 'proud': eyes('happy', px); mouth('grin', px); blush(px); break;
    case 'sad': eyes('open', px); mouth('frown', px); break;
    case 'waving':
    case 'waving2': {
      eyes('open', px); mouth('grin', px); blush(px);
      // A little pseudopod waving off the right side.
      const up = expression === 'waving';
      if (up) px.push([14, 7, O], [15, 6, O], [15, 5, O], [16, 4, O], [16, 3, C.peach]);
      else px.push([14, 7, O], [15, 7, O], [16, 6, O], [17, 5, O], [17, 4, C.peach]);
      break;
    }
  }
  return px;
}

/* ── compact (8 × 8) ── */

const SMALL_SPANS: readonly [number, number][] = [[2, 5], [1, 6], [0, 7], [0, 7], [0, 7], [0, 7], [0, 7], [1, 6]];

function smallPixels(expression: Expression): Px[] {
  const px: Px[] = [];
  SMALL_SPANS.forEach(([l, r], y) => {
    for (let x = l; x <= r; x++) px.push([x, y, y === 7 || (y === 6 && (x === l || x === r)) ? RIM : x === r && y >= 2 ? SHADE : O]);
  });
  px.push([2, 1, C.peach], [1, 2, C.cream]);
  const eye = (x: number) => {
    switch (expression) {
      case 'blink': case 'sleepy': px.push([x, 4, EYE]); break;
      case 'chewing': case 'chewing2': case 'proud': px.push([x, 4, EYE]); px.push([x, 3, O]); break;
      case 'shocked': px.push([x, 2, GLINT], [x, 3, EYE], [x, 4, GLINT]); break;
      case 'heart-eyes': px.push([x, 3, HEART], [x, 4, HEART]); break;
      case 'side-eye': px.push([x, 3, GLINT], [x + 1, 3, EYE], [x, 4, GLINT], [x + 1, 4, EYE]); break;
      case 'smirk': px.push([x, 3, SHADE], [x, 4, EYE]); break;
      default: px.push([x, 3, EYE], [x, 4, EYE]);
    }
  };
  eye(2); eye(expression === 'side-eye' ? 4 : 5);
  switch (expression) {
    case 'shocked': case 'chewing2': px.push([3, 6, MOUTH], [4, 6, MOUTH]); break;
    case 'smirk': px.push([3, 6, MOUTH], [4, 6, MOUTH], [5, 5, MOUTH]); break;
    case 'side-eye': case 'chewing': px.push([3, 6, MOUTH], [4, 6, MOUTH]); break;
    case 'sleepy': px.push([4, 6, MOUTH]); break;
    case 'sad': px.push([3, 5, MOUTH], [4, 5, MOUTH], [2, 6, MOUTH], [5, 6, MOUTH]); break;
    default: px.push([2, 5, MOUTH], [5, 5, MOUTH], [3, 6, MOUTH], [4, 6, MOUTH]);
  }
  if (expression === 'waving' || expression === 'waving2') px.push([8, 4, O], [9, expression === 'waving' ? 3 : 4, O], [9, expression === 'waving' ? 2 : 3, C.peach]);
  return px;
}

/* ── public API ── */

const LINE: Record<Expression, string> = {
  idle: '(•ᴗ•)', blink: '(-ᴗ-)', chewing: '(^~^)', chewing2: '(^o^)', shocked: '(⊙o⊙)', smirk: '(¬ᴗ¬)', sleepy: '(-_-)zz',
  'heart-eyes': '(♥ᴗ♥)', 'side-eye': '(¬_¬)', proud: '(^ᴗ^)', waving: '(•ᴗ•)/', waving2: '(•ᴗ•)~', sad: '(•_•)',
};
const LINE_ASCII: Record<Expression, string> = {
  idle: '(o_o)', blink: '(-_-)', chewing: '(^~^)', chewing2: '(^o^)', shocked: '(O_O)', smirk: '(¬_¬)', sleepy: '(-_-)zz',
  'heart-eyes': '(<3_<3)', 'side-eye': '(¬_¬)', proud: '(^_^)', waving: '(o_o)/', waving2: '(o_o)/', sad: '(o_o;)',
};

export function mascotLine(expression: Expression, ascii = false): string {
  return (ascii ? LINE_ASCII : LINE)[expression];
}

export function mascotSize(size: Exclude<MascotSize, 'line'>): { w: number; h: number } {
  return size === 'big' ? { w: 20, h: 9 } : { w: 10, h: 4 };
}

/**
 * Draw Slopie with its top-left at cell (x, y). `bob` lifts it by whole pixels (half cells)
 * for a gentle breathing/hop; `fullness` widens the belly while it eats.
 */
export function drawMascot(canvas: Canvas, x: number, y: number, expression: Expression, options: { size?: Exclude<MascotSize, 'line'>; bob?: number; fullness?: number; scale?: number } = {}): void {
  const size = options.size ?? 'big';
  const scale = Math.max(1, Math.round(options.scale ?? 1));
  const pixels = size === 'big' ? bigPixels(expression, options.fullness ?? 0) : smallPixels(expression);
  const lift = Math.round(options.bob ?? 0);
  const offset = size === 'big' ? 2 : 0; // room for the waving arm and growth on the left
  const top = size === 'big' ? 2 : 0; // room for the tip
  for (const [px, py, color] of pixels) {
    for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
      canvas.px(x + (px + offset) * scale + sx, y * 2 + (py + top) * scale + sy - lift, color);
    }
  }
}

export const MASCOT_BIG = { w: BIG_W, h: BIG_H };

/** Raw pixel list (pre-offset) — used to keep the instant splash in sync with the mascot. */
export function mascotPixels(expression: Expression, size: Exclude<MascotSize, 'line'> = 'big'): readonly [number, number, Rgb][] {
  return size === 'big' ? bigPixels(expression) : smallPixels(expression);
}

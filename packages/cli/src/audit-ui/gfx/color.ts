/**
 * The slopie palette and colour maths. Colours are 0xRRGGBB integers; -1 means "terminal default".
 * Orange family + neutrals only. Gradients stay inside the family (black → ember → orange → peach → cream).
 */
export type Rgb = number;
export const DEFAULT: Rgb = -1;

export const C = {
  orange: 0xff7a1a,
  ember: 0xff4d00,
  peach: 0xffb070,
  cream: 0xfff4e6,
  white: 0xffffff,
  gray: 0x9a9a9a,
  slate: 0x5c5c5c,
  coal: 0x2a2a2a,
  /** Card background: a warm near-black so fades have a known start colour. */
  ink: 0x0d0b0a,
  /** Mascot-only shades (still orange family). */
  rust: 0xc94a0a,
  deep: 0x8a2e05,
  pupil: 0x1c0f08,
} as const;

const r = (c: Rgb) => (c >> 16) & 255;
const g = (c: Rgb) => (c >> 8) & 255;
const b = (c: Rgb) => c & 255;
export const rgb = (red: number, green: number, blue: number): Rgb =>
  ((Math.max(0, Math.min(255, Math.round(red))) << 16) | (Math.max(0, Math.min(255, Math.round(green))) << 8) | Math.max(0, Math.min(255, Math.round(blue))));

/** Linear mix a→b, t in 0..1. */
export function mix(a: Rgb, bColor: Rgb, t: number): Rgb {
  if (a < 0) return t < 0.5 ? a : bColor;
  if (bColor < 0) return t < 0.5 ? a : bColor;
  const k = Math.max(0, Math.min(1, t));
  return rgb(r(a) + (r(bColor) - r(a)) * k, g(a) + (g(bColor) - g(a)) * k, b(a) + (b(bColor) - b(a)) * k);
}

/** Fade a colour in from the card background. */
export const fade = (color: Rgb, alpha: number): Rgb => (alpha >= 1 ? color : mix(C.ink, color, alpha));

const HEAT: readonly Rgb[] = [0x1a1512, 0x5a1d05, C.ember, C.orange, C.peach, C.cream];
/** Heat ramp for heatmaps, t in 0..1. */
export function heat(t: number): Rgb {
  const k = Math.max(0, Math.min(1, t)) * (HEAT.length - 1);
  const i = Math.min(HEAT.length - 2, Math.floor(k));
  return mix(HEAT[i]!, HEAT[i + 1]!, k - i);
}

/* ── quantisation ─────────────────────────────────────────────────────────── */

/** Hand-tuned so orange never turns red or brown on 256-colour terminals. */
const TUNED_256 = new Map<Rgb, number>([
  [C.orange, 208], [C.ember, 202], [C.peach, 215], [C.cream, 230], [C.white, 231], [C.gray, 247], [C.slate, 240],
  [C.coal, 235], [C.ink, 233], [C.rust, 166], [C.deep, 94], [C.pupil, 232],
]);
const CUBE = [0, 95, 135, 175, 215, 255];

function nearestCube(v: number): number {
  let best = 0;
  for (let i = 1; i < 6; i++) if (Math.abs(CUBE[i]! - v) < Math.abs(CUBE[best]! - v)) best = i;
  return best;
}

export function to256(color: Rgb): number {
  const tuned = TUNED_256.get(color);
  if (tuned !== undefined) return tuned;
  const ri = nearestCube(r(color)), gi = nearestCube(g(color)), bi = nearestCube(b(color));
  const cube = 16 + 36 * ri + 6 * gi + bi;
  const cubeErr = (CUBE[ri]! - r(color)) ** 2 + (CUBE[gi]! - g(color)) ** 2 + (CUBE[bi]! - b(color)) ** 2;
  const avg = (r(color) + g(color) + b(color)) / 3;
  const grayIndex = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)));
  const level = 8 + grayIndex * 10;
  const grayErr = (level - r(color)) ** 2 + (level - g(color)) ** 2 + (level - b(color)) ** 2;
  return grayErr < cubeErr ? 232 + grayIndex : cube;
}

/** 16-colour SGR foreground code (30–37, 90–97). */
export function to16(color: Rgb): number {
  const red = r(color), green = g(color), blue = b(color);
  const max = Math.max(red, green, blue), min = Math.min(red, green, blue);
  const lum = 0.299 * red + 0.587 * green + 0.114 * blue;
  if (max - min < 40) {
    if (lum > 200) return 97;
    if (lum > 120) return 37;
    if (lum > 50) return 90;
    return 30;
  }
  // Warm hues: ember → red, orange/peach → yellow (most themes draw yellow as orange-ish).
  if (red > green && red > blue) {
    if (green < 110) return lum > 90 ? 91 : 31;
    if (lum > 200) return 97;
    return lum > 140 ? 93 : 33;
  }
  return lum > 128 ? 97 : 37;
}

export const luminance = (color: Rgb) => (color < 0 ? 0 : (0.299 * r(color) + 0.587 * g(color) + 0.114 * b(color)) / 255);
export const channels = (color: Rgb): [number, number, number] => [r(color), g(color), b(color)];
export const hex = (color: Rgb) => '#' + (color & 0xffffff).toString(16).padStart(6, '0').toUpperCase();

/** Easing and timing helpers. All animation is a pure function of elapsed milliseconds. */

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const easeOutCubic = (t: number) => 1 - (1 - clamp01(t)) ** 3;
export const easeInOutCubic = (t: number) => {
  const k = clamp01(t);
  return k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
};
export const easeOutQuart = (t: number) => 1 - (1 - clamp01(t)) ** 4;
export const easeOutBack = (t: number) => {
  const k = clamp01(t);
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * (k - 1) ** 3 + c1 * (k - 1) ** 2;
};

/**
 * Damped spring from 0 to 1 (Harmonica-style). `t` in seconds. ζ < 1 overshoots a little.
 */
export function spring(t: number, frequency = 7, damping = 0.55): number {
  if (!(t > 0)) return 0;
  if (!Number.isFinite(t)) return 1;
  const omega = 2 * Math.PI * frequency / 4;
  const zeta = damping;
  if (zeta >= 1) return 1 - (1 + omega * t) * Math.exp(-omega * t);
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + (zeta * omega / wd) * Math.sin(wd * t));
}

/** Progress of a segment that starts at `start` ms and lasts `dur` ms, eased. */
export function seg(t: number, start: number, dur: number, ease: (k: number) => number = easeOutCubic): number {
  if (dur <= 0) return t >= start ? 1 : 0;
  return ease(clamp01((t - start) / dur));
}

/** Smooth counter: value at time t counting up to `target` over `dur` ms after `start`. */
export function countUp(target: number, t: number, start: number, dur: number): number {
  return target * seg(t, start, dur, easeOutQuart);
}

/** Deterministic pseudo-random in [0, 1) from an integer seed. */
export function hash01(seed: number): number {
  let x = (seed | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Shared types for scenes (the loading story and every card). */
import type { Canvas } from '../gfx/canvas.js';
import type { Rect } from '../gfx/draw.js';
import type { Caps } from '../gfx/screen.js';

export interface Tier {
  id: 'L' | 'M' | 'S';
  /** Horizontal margin. */
  mx: number;
  mascot: 'big' | 'compact' | 'line';
}

export const MIN_COLS = 60;
export const MIN_ROWS = 20;

export function tierFor(w: number, h: number): Tier | null {
  if (w < MIN_COLS || h < MIN_ROWS) return null;
  if (w >= 100 && h >= 30) return { id: 'L', mx: 4, mascot: 'big' };
  if (w >= 76 && h >= 23) return { id: 'M', mx: 3, mascot: 'compact' };
  return { id: 'S', mx: 2, mascot: 'line' };
}

/** Per-card interactive state that survives paging back and forth. */
export interface CardState {
  /** Guess-the-model: chosen option index, or -1 for "skipped, just show me". */
  guess?: number;
  /** Ms timestamp (card clock) when the guess was made. */
  guessAt?: number;
}

export interface Scene {
  c: Canvas;
  w: number;
  h: number;
  /** Milliseconds since this card entered (Infinity when motion is off). */
  t: number;
  tier: Tier;
  caps: Caps;
  /** Slopie's eyes are closed for this frame. */
  blink: boolean;
  state: CardState;
  index: number;
  total: number;
  /** Rendering for the exported share card: no project names, no quotes. */
  share?: boolean;
}

export type Body<D> = (scene: Scene, data: D, body: Rect) => boolean;

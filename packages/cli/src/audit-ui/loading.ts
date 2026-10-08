/**
 * The loading story: Slopie in the middle-left, each coding agent lighting up as it is
 * actually discovered, and messages flowing from the agents into Slopie's mouth while the
 * real scan runs. Counters tick toward the engine's running counts.
 *
 * Everything shown comes from progress events (`progress.detail`) or, for older engines,
 * from `snapshot.sources`. Nothing is invented: unknown counts are simply not shown.
 */
import type { AuditSnapshot } from '../../../core/src/analytics/contracts.js';
import { Canvas } from './gfx/canvas.js';
import { C, fade, mix } from './gfx/color.js';
import { textCenter, textWidth } from './gfx/draw.js';
import { clamp01, easeInOutCubic, hash01, seg } from './gfx/motion.js';
import type { Caps } from './gfx/screen.js';
import { count, monthYear } from './format.js';
import { drawMascot, mascotLine, type Expression } from './mascot.js';
import { progressDetailOf, storyOf } from './story/source.js';
import { boardData, isLoading } from './view-model.js';

export const MIN_STORY_MS = 2400;
const OUTRO_MS = 950;

const ORDER = ['claude', 'codex', 'pi', 'opencode'] as const;
const NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', pi: 'pi', opencode: 'OpenCode' };

export interface HarnessRow {
  id: string;
  name: string;
  state: 'searching' | 'found' | 'absent';
  /** Shown after the dot: "1,904 chats · since Dec 2025". */
  info: string;
  /** Messages are still flowing from this agent. */
  flowing: boolean;
}

export interface LoadingModel {
  rows: HarnessRow[];
  counts: { messages: number | null; chats: number | null; prompts: number | null };
  stage: 'discovering' | 'reading' | 'aggregating' | 'detecting' | 'ready';
  progress: number | null;
  ready: boolean;
  failure: string | null;
  /** Rows and counts came from the engine's progress detail (not the 1.7.x fallback). */
  fromDetail: boolean;
}

export function loadingModel(snapshot: AuditSnapshot): LoadingModel {
  const detail = progressDetailOf(snapshot);
  const loading = isLoading(snapshot);
  const board = boardData(snapshot);
  const rows: HarnessRow[] = [];
  for (const id of ORDER) {
    const d = detail?.harnesses.find(h => h.harness === id) as (NonNullable<typeof detail>['harnesses'][number] & { discovered?: boolean; absent?: boolean; chats?: number; prompts?: number }) | undefined;
    const source = snapshot.sources.find(s => s.harness === id);
    if (!d && !source) continue;
    let state: HarnessRow['state'];
    if (d) state = d.absent || (d.discovered !== false && d.files === 0 && (detail!.stage !== 'discovering' || d.discovered)) ? 'absent' : d.discovered === false ? 'searching' : 'found';
    else state = source!.state === 'checking' ? 'searching' : source!.state === 'absent' || source!.state === 'unsupported' ? 'absent' : 'found';
    if (state === 'searching' && !loading) state = source?.state === 'absent' ? 'absent' : 'found';
    let info = '';
    if (state === 'absent') info = 'not on this machine';
    else if (state === 'searching') info = 'looking…';
    else {
      const chats = d?.chats;
      const files = d?.files ?? source?.census?.files ?? source?.candidateFiles ?? null;
      const head = chats ? `${count(chats)} chats` : files ? `${count(files)} files` : 'found';
      const since = d?.firstAt ? ` · since ${monthYear(d.firstAt)}` : '';
      info = head + since;
    }
    const flowing = loading && state === 'found' && (!d || d.filesDone < d.files || detail?.stage === 'discovering');
    rows.push({ id, name: NAMES[id] ?? id, state, info, flowing });
  }
  const totals = storyOf(snapshot)?.totals;
  const counts = {
    messages: detail?.counts.messages ?? null,
    chats: totals?.sessions ?? detail?.counts.chats ?? board.stats.chats,
    prompts: totals?.prompts ?? detail?.counts.prompts ?? board.stats.prompts,
  };
  const stage: LoadingModel['stage'] = !loading ? 'ready'
    : detail ? (detail.stage === 'enriching' || detail.stage === 'ready' ? 'detecting' : detail.stage)
      : board.phase === 'finding' ? 'discovering' : board.phase === 'finishing' ? 'aggregating' : 'reading';
  const progress = detail && detail.counts.files > 0 ? detail.counts.filesDone / detail.counts.files
    : board.progress?.total ? (board.progress.done ?? 0) / board.progress.total : null;
  return { rows, counts, stage, progress: loading ? progress : 1, ready: !loading, failure: board.failure, fromDetail: Boolean(detail) };
}

function caption(model: LoadingModel, shownPrompts: number): string {
  if (model.failure && model.ready) return model.failure;
  switch (model.stage) {
    case 'discovering': return 'finding your agents';
    case 'reading': return shownPrompts > 0 ? `reading ${count(Math.round(shownPrompts))} things you said` : 'reading your history';
    case 'aggregating': return 'counting the money';
    case 'detecting': return 'noticing patterns';
    case 'ready': return 'ok. I know you now.';
  }
}

interface Particle { row: number; born: number; life: number; seed: number }

/** Where things sit on the loading screen. Mirrored by bin/audit-splash.js (tested). */
export function loadingGeometry(w: number, h: number) {
  const L = w >= 100 && h >= 30;
  const S = w < 76 || h < 23;
  const mx = L ? 4 : S ? 2 : 3;
  const scale = L ? 2 : 1;
  const mascotW = S ? 10 : 18 * scale;
  const mascotH = S ? 4 : 8 * scale;
  const panelX = S ? mx : Math.max(mx + mascotW + 6, Math.floor(w * (L ? 0.46 : 0.42)));
  const sx = S ? Math.floor((w - 10) / 2) : Math.max(mx, Math.floor((panelX - mascotW) / 2) - 1);
  const sy = S ? 2 : Math.max(2, Math.floor((h - mascotH) / 2) - 2);
  const rowsY = S ? sy + mascotH + 2 : Math.max(3, Math.floor(h / 2) - (L ? 6 : 5));
  return { L, S, mx, scale, mascotW, mascotH, panelX, sx, sy, rowsY };
}

/** Stateful (particles, tweened counters); everything else is derived from the model. */
export class LoadingStory {
  private particles: Particle[] = [];
  private lastSpawn = new Map<number, number>();
  private shown = { messages: 0, chats: 0, prompts: 0 };
  private lastArrival = -Infinity;
  private lastCaption = '';
  private captionAt = 0;
  private readyAt: number | null = null;
  private seed = 1;
  private litAt = new Map<string, number>();
  privacyLine = 'all local · nothing leaves this machine';

  constructor(private readonly started: number) {}

  /** True once the outro has played and the deck may start. */
  done(now: number): boolean {
    return this.readyAt !== null && now - this.readyAt >= OUTRO_MS && now - this.started >= MIN_STORY_MS;
  }

  /** Data is in and the minimum story time has passed: a key press may skip ahead. */
  skippable(model: LoadingModel, now: number): boolean {
    return model.ready && now - this.started >= 600;
  }

  private lastDetail: LoadingModel | null = null;

  render(c: Canvas, input: LoadingModel, now: number, caps: Caps, blink: boolean): boolean {
    const t = now - this.started;
    // Never regress: a final snapshot without progress detail keeps the rows and counts already shown.
    let model = input;
    if (input.fromDetail) this.lastDetail = input;
    else if (this.lastDetail) {
      const last = this.lastDetail;
      model = {
        ...input,
        rows: last.rows.map(row => ({ ...row, flowing: false, state: row.state === 'searching' ? 'found' : row.state })),
        counts: { messages: last.counts.messages, chats: input.counts.chats ?? last.counts.chats, prompts: input.counts.prompts ?? last.counts.prompts },
      };
    }
    const { w, h } = c;
    const motion = caps.motion;
    const L = w >= 100 && h >= 30;
    const S = w < 76 || h < 23;
    // Readiness gate: the outro starts only after the minimum story time.
    if (model.ready && this.readyAt === null && (t >= MIN_STORY_MS - OUTRO_MS || !motion)) this.readyAt = now;
    const outro = this.readyAt !== null ? clamp01((now - this.readyAt) / OUTRO_MS) : 0;

    // Tween the counters.
    const k = motion ? 0.22 : 1;
    for (const key of ['messages', 'chats', 'prompts'] as const) {
      const target = model.counts[key] ?? 0;
      this.shown[key] += (target - this.shown[key]) * k;
      if (Math.abs(target - this.shown[key]) < 0.5) this.shown[key] = target;
    }

    // Brand.
    const { mx, scale: mascotScale, mascotH, panelX, sx, sy, rowsY } = loadingGeometry(w, h);
    c.text(mx, L ? 1 : 0, 'slopie', { fg: C.orange, bold: true });
    c.text(mx + 7, L ? 1 : 0, 'audit', { fg: C.slate });
    const mouth = S ? { x: sx + 4, y: sy + 3 } : { x: sx + (2 + 7) * mascotScale, y: sy + Math.round(((10 + 2) * mascotScale) / 2) };

    // Harness rows.
    let busy = false;
    const nameW = 13;
    model.rows.forEach((row, i) => {
      const y = rowsY + (L ? i * 2 : i);
      if (row.state !== 'searching' && !this.litAt.has(row.id)) this.litAt.set(row.id, now);
      const lit = this.litAt.get(row.id);
      const a = lit === undefined ? 1 : motion ? clamp01((now - lit) / 350) : 1;
      busy ||= a < 1;
      let dot: string;
      let dotColor: number;
      if (row.state === 'found') { dot = caps.unicode ? '●' : '*'; dotColor = mix(C.cream, C.orange, a); }
      else if (row.state === 'absent') { dot = caps.unicode ? '○' : 'o'; dotColor = C.slate; }
      else { dot = caps.unicode ? ['◜', '◝', '◞', '◟'][Math.floor(t / 120) % 4]! : '-'; dotColor = C.gray; busy = true; }
      c.text(panelX, y, dot, { fg: dotColor, bold: true });
      c.text(panelX + 2, y, row.name, { fg: row.state === 'found' ? mix(C.gray, C.cream, a) : C.slate, bold: row.state === 'found' });
      c.text(panelX + 2 + nameW, y, row.info, { fg: row.state === 'found' ? fade(C.gray, Math.max(0.3, a)) : C.slate, italic: row.state === 'absent' }, w - panelX - nameW - 4);
      // A ripple when a row lights up.
      if (row.state === 'found' && a < 1 && motion) c.text(panelX - 2, y, caps.unicode ? '›' : '>', { fg: fade(C.orange, 1 - a) });
    });

    // Counters.
    const cy = rowsY + (L ? model.rows.length * 2 + 1 : model.rows.length + 1);
    let cx = panelX;
    const counters: [number | null, string][] = [[model.counts.messages !== null ? this.shown.messages : null, 'messages'], [model.counts.chats !== null ? this.shown.chats : null, 'chats'], [model.counts.prompts !== null ? this.shown.prompts : null, 'prompts']];
    for (const [value, label] of counters) {
      if (value === null || value <= 0) continue;
      const text = count(Math.round(value));
      if (cx + textWidth(text) + textWidth(label) + 2 > w - 2) break;
      cx += c.text(cx, cy, text, { fg: C.cream, bold: true });
      cx += c.text(cx + 1, cy, label, { fg: C.gray }) + 4;
    }
    if (this.shown.messages !== (model.counts.messages ?? 0)) busy = true;

    // Progress rail.
    const barW = Math.min(44, w - panelX - 4);
    const p = model.ready ? 1 : model.progress;
    if (barW > 8) {
      for (let i = 0; i < barW; i++) {
        const filled = p !== null ? i < Math.round(barW * p) : false;
        // Indeterminate shimmer while the total is unknown.
        const shimmer = p === null && motion ? Math.max(0, 1 - Math.abs(((t / 18) % (barW + 16)) - 8 - i) / 6) : 0;
        c.put(panelX + i, cy + 2, caps.unicode ? (filled ? '━' : '─') : filled ? '=' : '-', filled ? C.orange : mix(C.coal, C.peach, shimmer));
      }
      if (p === null) busy = true;
    }

    // Caption (crossfades on stage change).
    const text = caption(model, this.shown.prompts);
    if (text !== this.lastCaption) { this.lastCaption = text; this.captionAt = now; }
    const ca = motion ? clamp01((now - this.captionAt) / 260) : 1;
    busy ||= ca < 1;
    c.text(panelX, cy + 4, text, { fg: model.ready && !model.failure ? C.orange : C.peach, bold: model.ready, alpha: ca }, w - panelX - 2);

    // Particles: messages flowing into Slopie.
    const flowing = model.rows.map((row, i) => (row.flowing ? i : -1)).filter(i => i >= 0);
    if (motion && !S) {
      for (const i of flowing) {
        const last = this.lastSpawn.get(i) ?? -Infinity;
        const period = 70 + i * 25;
        if (now - last >= period) {
          this.lastSpawn.set(i, now);
          this.particles.push({ row: i, born: now, life: 650 + hash01(this.seed) * 350, seed: this.seed++ });
        }
      }
      const alive: Particle[] = [];
      for (const part of this.particles) {
        const k2 = (now - part.born) / part.life;
        if (k2 >= 1) { this.lastArrival = now; continue; }
        alive.push(part);
        const y0 = rowsY + (L ? part.row * 2 : part.row);
        const x0 = panelX - 3;
        const e = easeInOutCubic(k2);
        const lift = (L ? 4 : 2) * (0.3 + hash01(part.seed * 3));
        const ctrlX = (x0 + mouth.x) / 2;
        const ctrlY = Math.min(y0, mouth.y) - lift;
        const px = (1 - e) * (1 - e) * x0 + 2 * (1 - e) * e * ctrlX + e * e * mouth.x;
        const py = (1 - e) * (1 - e) * y0 + 2 * (1 - e) * e * ctrlY + e * e * mouth.y;
        const glyphs = caps.unicode ? ['▪', '•', '•', '·'] : ['o', 'o', '.', '.'];
        const glyph = glyphs[Math.min(3, Math.floor(k2 * 4))]!;
        const tone = k2 > 0.7 ? C.cream : hash01(part.seed * 7) < 0.5 ? C.peach : C.orange;
        c.text(Math.round(px), Math.round(py), glyph, { fg: tone, bold: true });
      }
      this.particles = alive;
      if (alive.length) busy = true;
    }



    // Slopie: chews while messages arrive, beams at the end.
    const chewing = motion && (now - this.lastArrival < 260 || (flowing.length > 0 && this.particles.length > 0));
    let face: Expression = 'idle';
    if (model.ready && model.failure) face = 'sad';
    else if (outro > 0) face = 'proud';
    else if (chewing) face = Math.floor(t / 150) % 2 ? 'chewing' : 'chewing2';
    else if (blink) face = 'blink';
    const bob = motion ? (outro > 0 ? Math.sin(Math.PI * Math.min(1, outro * 1.6)) * 3 : (1 - Math.cos(t / 380)) * 0.8) : 0;
    const fullness = model.ready ? 1 : (model.progress ?? 0) > 0.5 ? 1 : 0;
    if (caps.color === 'none' || caps.color === '16') {
      c.text(sx + 4, sy + Math.floor(mascotH / 2), mascotLine(face, !caps.unicode), { fg: C.orange, bold: true });
    } else if (S) {
      drawMascot(c, sx, sy, face, { size: 'compact', bob: bob > 1 ? 1 : 0 });
    } else {
      drawMascot(c, sx, sy, face, { bob, fullness, scale: mascotScale });
    }
    if (motion && (chewing || outro > 0 || flowing.length)) busy = true;
    // Privacy promise, always visible.
    const privacy = this.privacyLine;
    textCenter(c, w / 2, h - (L ? 2 : 1), `${caps.unicode ? '●' : '*'} ${privacy}`, { fg: C.slate });
    c.text(Math.round(w / 2 - textWidth(privacy) / 2 - 1), h - (L ? 2 : 1), caps.unicode ? '●' : '*', { fg: C.orange });

    if (model.ready && !this.done(now)) busy = true;
    if (outro > 0 && outro < 1) busy = true;
    void seg;
    return busy;
  }
}

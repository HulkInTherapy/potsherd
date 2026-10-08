/**
 * Wallboard layout: turns BoardData into a fixed-size grid of styled lines.
 *
 * The board is never scrolled. Cards are packed onto pages that exactly fit the terminal;
 * ←/→ switch pages when one screen is not enough. Loading uses the same layout with
 * placeholders, so nothing jumps when data arrives.
 */
import { bigNumber } from './big-digits.js';
import { compact, count, heroMoney, hourLabel, money, monthTick, monthYear, percent, shortDate, UNKNOWN } from './format.js';
import { cellWidth, clip, ellipsize, padEnd, padStart, toAscii, wrap } from './text.js';
import type { BoardData } from './view-model.js';

export type Style = 'brand' | 'accent' | 'title' | 'value' | 'text' | 'muted' | 'faint';
export interface Seg { text: string; style: Style }
export type Line = Seg[];

export interface LayoutOptions {
  columns: number;
  rows: number;
  ascii?: boolean;
  /** Spinner frame counter; only used while loading. */
  frame?: number;
  /** Notice that must be fully visible (e.g. a transfer disclosure). */
  banner?: string | null;
  /** Short-lived hint shown in the footer, e.g. "first page". */
  hint?: string | null;
  /** Shareable variant: leaves out project names and your own words. */
  share?: boolean;
}

export interface Board {
  pages: Line[][];
  /** Card ids on each page, so a resize can keep the reader on the same card. */
  cards: string[][];
  /** Rows taken by the banner; 0 when it could not be shown in full. */
  bannerRows: number;
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const MAX_CONTENT = 132;
const MIN_COLUMNS = 40;
const MIN_ROWS = 12;

const seg = (text: string, style: Style = 'text'): Seg => ({ text, style });
export const lineWidth = (line: Line): number => line.reduce((sum, part) => sum + cellWidth(part.text), 0);

/** Left and right parts on one line of exactly `width` cells; the left part is clipped first. */
function spread(left: Line, right: Line, width: number): Line {
  const rightWidth = lineWidth(right);
  const room = Math.max(0, width - rightWidth - (right.length ? 1 : 0));
  const clippedLeft = clipLine(left, room);
  const gap = Math.max(right.length ? 1 : 0, width - lineWidth(clippedLeft) - rightWidth);
  return [...clippedLeft, seg(' '.repeat(gap)), ...right];
}

export function clipLine(line: Line, width: number): Line {
  const out: Line = [];
  let left = width;
  for (const part of line) {
    if (left <= 0) break;
    const text = clip(part.text, left);
    if (text) out.push({ ...part, text });
    left -= cellWidth(text);
  }
  return out;
}

function padLine(line: Line, width: number): Line {
  const clipped = clipLine(line, width);
  const used = lineWidth(clipped);
  return used < width ? [...clipped, seg(' '.repeat(width - used))] : clipped;
}

function skeleton(width: number, seed: number): string {
  const size = Math.max(3, Math.round(width * (0.45 + ((seed * 37) % 50) / 100)));
  return '░'.repeat(Math.min(width, size));
}

function bar(fraction: number | null, width: number, ascii = false): string {
  if (fraction === null || !Number.isFinite(fraction) || width <= 0) return ' '.repeat(Math.max(0, width));
  const cells = fraction <= 0 ? 0 : Math.max(1, Math.round(Math.min(1, fraction) * width));
  return (ascii ? '=' : '━').repeat(cells) + ' '.repeat(width - cells);
}

/* ───────────────────────────── cards ───────────────────────────── */

interface Card {
  id: string;
  /** Preferred height in rows, including the title. */
  natural: number;
  /** Smallest comfortable height. */
  min: number;
  /** Largest useful height. */
  max: number;
  render(rows: number): Line[];
}

function titleLine(title: string, width: number, right: Line = []): Line {
  return spread([seg(title, 'title')], right, width);
}

function pendingRows(width: number, rows: number, seed: number): Line[] {
  return Array.from({ length: rows }, (_, i) => [seg(skeleton(Math.min(width, 28), seed + i), 'faint')]);
}

function modelsCard(data: BoardData, width: number): Card {
  const { models } = data;
  const available = data.loading ? 6 : models.rows.length + (models.more || models.rows.length > 5 ? 1 : 0);
  const render = (rows: number): Line[] => {
    const showTokens = width >= 44;
    const head = titleLine('MODELS', width, [seg(showTokens ? 'spend    tokens' : 'spend', 'muted')]);
    if (models.state === 'pending') return [head, ...pendingRows(width, rows - 1, 1)];
    if (models.state === 'empty') return [head, [seg('No model usage recorded yet', 'muted')]];
    const slots = Math.max(1, rows - 1);
    const overflow = models.rows.length > slots || Boolean(models.more);
    const shown = models.rows.slice(0, overflow ? Math.max(1, slots - 1) : slots);
    const nameWidth = Math.min(18, Math.max(...shown.map(row => cellWidth(row.name)), 8));
    const spendWidth = 7;
    const tokenWidth = showTokens ? 8 : 0;
    const barWidth = Math.max(0, width - 2 - nameWidth - 1 - spendWidth - tokenWidth - 1);
    const max = Math.max(...shown.map(row => row.value ?? 0), 0) || 1;
    const lines: Line[] = [head];
    for (const row of shown) {
      lines.push([
        seg(row.favourite ? '★ ' : '  ', 'accent'),
        seg(padEnd(ellipsize(row.name, nameWidth), nameWidth), 'text'),
        seg(' '),
        seg(barWidth >= 3 ? bar(row.value === null ? null : row.value / max, barWidth) : ' '.repeat(barWidth), 'accent'),
        seg(padStart((row.estimated && row.value !== null ? '~' : '') + money(row.value), spendWidth), 'value'),
        ...(showTokens ? [seg(padStart(compact(row.tokens), tokenWidth), 'muted')] : []),
      ]);
    }
    if (overflow) {
      const rest = models.rows.slice(shown.length);
      const restValue = rest.reduce<number | null>((sum, row) => (row.value === null ? sum : (sum ?? 0) + row.value), null);
      const extraValue = models.more?.value ?? null;
      const value = restValue === null && extraValue === null ? null : (restValue ?? 0) + (extraValue ?? 0);
      const tokens = rest.reduce((sum, row) => sum + (row.tokens ?? 0), 0) + (models.more?.tokens ?? 0);
      const n = rest.length + (models.more?.models ?? 0);
      lines.push([
        seg('  '),
        seg(padEnd(`${n} more`, nameWidth + 1 + barWidth), 'muted'),
        seg(padStart(money(value), spendWidth), 'muted'),
        ...(showTokens ? [seg(padStart(compact(tokens), tokenWidth), 'muted')] : []),
      ]);
    }
    return lines;
  };
  return { id: 'models', natural: Math.min(7, 1 + Math.max(1, available)), min: Math.min(5, 1 + Math.max(1, available)), max: Math.min(10, 1 + Math.max(1, available)), render };
}

function projectsCard(data: BoardData, width: number): Card {
  const { projects } = data;
  const available = data.loading ? 6 : projects.rows.length;
  const render = (rows: number): Line[] => {
    const head = titleLine('PROJECTS', width, [seg('prompts', 'muted')]);
    if (projects.state === 'pending') return [head, ...pendingRows(width, rows - 1, 3)];
    if (projects.state === 'empty') return [head, [seg('No projects found yet', 'muted')]];
    const slots = Math.max(1, rows - 1);
    const overflow = projects.rows.length > slots;
    const shown = projects.rows.slice(0, overflow ? Math.max(1, slots - 1) : slots);
    const countWidth = 7;
    const nameWidth = Math.min(24, Math.max(...shown.map(row => cellWidth(row.name)), 8), Math.max(6, width - countWidth - 4));
    const barWidth = Math.max(0, width - nameWidth - 1 - countWidth);
    const max = Math.max(...shown.map(row => row.prompts), 1);
    const lines: Line[] = [head];
    for (const row of shown) {
      lines.push([
        seg(padEnd(ellipsize(row.name, nameWidth), nameWidth), 'text'),
        seg(' '),
        seg(barWidth >= 3 ? bar(row.prompts / max, barWidth) : ' '.repeat(barWidth), 'accent'),
        seg(padStart(count(row.prompts), countWidth), 'value'),
      ]);
    }
    if (overflow) {
      const rest = projects.rows.slice(shown.length);
      lines.push([
        seg(padEnd(`${rest.length} more`, nameWidth + 1 + barWidth), 'muted'),
        seg(padStart(count(rest.reduce((sum, row) => sum + row.prompts, 0)), countWidth), 'muted'),
      ]);
    }
    return lines;
  };
  return { id: 'projects', natural: Math.min(7, 1 + Math.max(1, available)), min: Math.min(5, 1 + Math.max(1, available)), max: Math.min(10, 1 + Math.max(1, available)), render };
}

/** Weekly totals, resampled to `width` columns. */
function weeklySeries(days: BoardData['activity']['days'], width: number): number[] {
  if (!days.length || width <= 0) return [];
  const start = Date.parse(days[0]!.date);
  const end = Date.parse(days.at(-1)!.date);
  const span = Math.max(1, Math.round((end - start) / 86_400_000) + 1);
  const bins = new Array<number>(width).fill(0);
  for (const day of days) {
    const offset = Math.round((Date.parse(day.date) - start) / 86_400_000);
    const index = Math.min(width - 1, Math.floor((offset / span) * width));
    bins[index]! += day.count;
  }
  return bins;
}

const LEVELS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const ASCII_LEVELS = [' ', '.', '.', ':', ':', '|', '|', '#', '#'];

function chart(values: number[], height: number, ascii: boolean): string[] {
  const max = Math.max(...values, 1);
  const levels = ascii ? ASCII_LEVELS : LEVELS;
  const rows: string[] = [];
  for (let r = height - 1; r >= 0; r--) {
    let line = '';
    for (const value of values) {
      const eighths = value <= 0 ? 0 : Math.max(1, Math.round((value / max) * height * 8));
      const here = Math.max(0, Math.min(8, eighths - r * 8));
      line += levels[here];
    }
    rows.push(line);
  }
  return rows;
}

function monthTicks(days: BoardData['activity']['days'], width: number): string {
  if (days.length < 2 || width < 12) return '';
  const start = Date.parse(days[0]!.date);
  const end = Date.parse(days.at(-1)!.date);
  const span = Math.max(1, end - start);
  const cells = new Array<string>(width).fill(' ');
  const first = new Date(start);
  const cursor = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));
  const ticks: { at: number; label: string }[] = [{ at: 0, label: monthTick(days[0]!.date) }];
  while (cursor.getTime() <= end) {
    const at = Math.round(((cursor.getTime() - start) / span) * (width - 1));
    const iso = cursor.toISOString().slice(0, 10);
    ticks.push({ at, label: cursor.getUTCMonth() === 0 ? monthTick(iso) : monthTick(iso).slice(0, 3) });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  let free = 0;
  for (const tick of ticks) {
    const at = Math.min(tick.at, width - tick.label.length);
    if (at < free) continue;
    for (let i = 0; i < tick.label.length; i++) cells[at + i] = tick.label[i]!;
    free = at + tick.label.length + 2;
  }
  return cells.join('').trimEnd();
}

function activityCard(data: BoardData, width: number, ascii: boolean): Card {
  const { activity } = data;
  const facts: Line[] = [];
  const label = (text: string) => seg(padEnd(text, 13), 'muted');
  if (activity.busiest) facts.push([label('busiest day'), seg(shortDate(activity.busiest.date), 'value'), seg(` · ${count(activity.busiest.count)} prompts`, 'muted')]);
  if (activity.peakHour !== null) {
    const owl = activity.peakHour <= 4 ? ' · night owl' : activity.peakHour >= 5 && activity.peakHour <= 8 ? ' · early bird' : '';
    facts.push([label('peak hour'), seg(hourLabel(activity.peakHour), 'value'), seg(owl, 'muted')]);
  }
  if (activity.topWeekday) facts.push([label('top weekday'), seg(activity.topWeekday, 'value')]);
  const render = (rows: number): Line[] => {
    const head = titleLine('WHEN YOU CODE', width, [seg('prompts per week', 'muted')]);
    if (activity.state === 'pending') return [head, ...pendingRows(width, rows - 1, 5)];
    if (activity.state === 'empty') return [head, [seg('No dated activity yet', 'muted')]];
    const room = Math.max(1, rows - 1);
    const factRows = Math.min(facts.length, Math.max(0, room - 2));
    const chartHeight = Math.max(1, Math.min(6, room - 1 - factRows));
    const ticks = room - chartHeight - factRows >= 1;
    const lines: Line[] = [head];
    for (const row of chart(weeklySeries(activity.days, width), chartHeight, ascii)) lines.push([seg(row, 'accent')]);
    if (ticks) lines.push([seg(monthTicks(activity.days, width), 'muted')]);
    lines.push(...facts.slice(0, factRows));
    return lines;
  };
  const natural = data.loading ? 6 : 1 + 1 + 1 + facts.length;
  return { id: 'activity', natural, min: Math.min(natural, 4), max: natural + 5, render };
}

function repeatsCard(data: BoardData, width: number, ascii: boolean): Card {
  const { repeats } = data;
  const render = (rows: number): Line[] => {
    const head = titleLine('ON REPEAT', width, [seg('times', 'muted')]);
    if (repeats.state === 'pending') return [head, ...pendingRows(width, rows - 1, 7)];
    if (repeats.state === 'empty') return [head, [seg("You don't repeat yourself. Respect.", 'muted')]];
    const lines: Line[] = [head];
    for (const row of repeats.rows.slice(0, Math.max(1, rows - 1))) {
      const tail = `×${count(row.count)}`;
      const room = width - tail.length - 2;
      const quote = ascii ? `"${ellipsize(row.text, room - 2, true)}"` : `“${ellipsize(row.text, room - 2)}”`;
      lines.push(spread([seg(quote, 'text')], [seg(tail, 'value')], width));
    }
    return lines;
  };
  const available = data.loading ? 5 : Math.max(1, repeats.rows.length);
  return { id: 'repeats', natural: 1 + Math.min(5, available), min: 1 + Math.min(4, available), max: 1 + Math.min(8, available), render };
}

function reactionsCard(data: BoardData, width: number): Card {
  const { reactions } = data;
  const render = (rows: number): Line[] => {
    const head = titleLine('REACTIONS', width);
    if (reactions.state === 'pending') return [head, ...pendingRows(width, rows - 1, 9)];
    if (reactions.state === 'empty') return [head, [seg('No strong feelings either way', 'muted')]];
    const lines: Line[] = [head];
    const wide = width >= 52;
    const add = (label: string, row: BoardData['reactions']['roasted'], noun: string) => {
      if (!row) return;
      const tail: Line = wide
        ? [seg(`${count(row.hits)} ${noun} in ${count(row.of)} · `, 'muted'), seg(percent(row.hits / row.of, 1), 'value')]
        : [seg(percent(row.hits / row.of, 1), 'value'), seg(` of ${count(row.of)}`, 'muted')];
      lines.push(spread([seg(padEnd(wide ? `most ${label}` : label, wide ? 14 : 9), 'muted'), seg(row.model, 'text')], tail, width));
    };
    add('roasted', reactions.roasted, reactions.roasted?.hits === 1 ? 'rant' : 'rants');
    add('praised', reactions.praised, 'thanks');
    return lines.slice(0, Math.max(1, rows));
  };
  return { id: 'reactions', natural: 3, min: 3, max: 3, render };
}

function swearsCard(data: BoardData, width: number): Card {
  const { swears } = data;
  const render = (rows: number): Line[] => {
    const head = titleLine('SWEAR JAR', width);
    if (swears.state === 'pending') return [head, ...pendingRows(width, rows - 1, 11)];
    if (swears.state === 'empty') return [head, [seg('Not measured', 'muted')]];
    if (swears.total === 0) return [head, [seg('Zero swears. Remarkably polite.', 'muted')]];
    const rate = swears.prompts > 0 && swears.eligible > 0 ? `1 in ${count(Math.round(swears.eligible / swears.prompts))} prompts` : null;
    const lines: Line[] = [
      head,
      [seg(count(swears.total), 'value'), seg(' swears', 'muted'), ...(rate ? [seg(' · ', 'muted'), seg(rate, 'text')] : [])],
    ];
    if (swears.top.length && rows > 2) {
      const parts: Line = [];
      swears.top.forEach((term, index) => {
        if (index) parts.push(seg(' · ', 'muted'));
        parts.push(seg(term.term, 'text'), seg(` ×${count(term.count)}`, 'muted'));
      });
      lines.push(clipLine(parts, width));
    }
    return lines;
  };
  return { id: 'swears', natural: swears.top.length ? 3 : 2, min: 2, max: 3, render };
}

/* ───────────────────────────── hero ───────────────────────────── */

interface Hero { lines: Line[] }

function statCells(data: BoardData): { value: string; label: string }[] {
  const { stats } = data;
  return [
    { value: compact(stats.tokens), label: 'tokens' },
    { value: count(stats.prompts), label: 'prompts' },
    { value: count(stats.chats), label: 'chats' },
    { value: count(stats.projects), label: 'projects' },
    { value: count(stats.activeDays), label: 'active days' },
    { value: stats.streak === null ? UNKNOWN : `${count(stats.streak)}-day`, label: 'streak' },
  ];
}

function heroBlock(data: BoardData, width: number, ascii: boolean, frame: number): Hero {
  const value = data.hero.value;
  const unknown = value === null && !data.loading;
  const digits = value !== null ? bigNumber(heroMoney(value), ascii) : unknown ? bigNumber('$—', ascii) : null;
  const digitWidth = digits ? cellWidth(digits[0]) : 20;
  const art: Line[] = digits
    ? digits.map(row => [seg(row, 'brand')])
    : [0, 1, 2].map(() => [seg('░'.repeat(digitWidth), 'faint')]);

  const cells = statCells(data);
  const cellWidthMax = 16;
  const besideRoom = width - digitWidth - 4;
  const perRow = Math.max(0, Math.min(3, Math.floor(besideRoom / cellWidthMax)));
  const renderCell = (cell: { value: string; label: string }, w: number): Line =>
    [...padLine([seg(cell.value, cell.value === UNKNOWN ? 'faint' : 'value'), seg(' ' + cell.label, 'muted')], w - 1), seg(' ')];

  const split: Line = [];
  data.agentSplit.slice(0, 3).forEach((agent, index) => {
    if (index) split.push(seg(' · ', 'muted'));
    split.push(seg(percent(agent.share), 'value'), seg(' ' + agent.name, 'muted'));
  });
  if (split.length) split.push(seg('  of the spend', 'faint'));

  const lines: Line[] = [];
  const caption = unknown
    ? 'no priced token usage found'
    : data.hero.value !== null && data.hero.provisional
      ? 'so far · what your tokens would cost at API prices'
      : 'what your tokens would cost at API prices';

  if (perRow >= 2) {
    const columnWidth = Math.min(20, Math.floor(besideRoom / perRow));
    const statRows = Math.ceil(cells.length / perRow);
    for (let r = 0; r < Math.max(3, statRows + (split.length ? 1 : 0)); r++) {
      const left = art[r] ?? [seg(' '.repeat(digitWidth))];
      const right: Line = [];
      for (let c = 0; c < perRow; c++) {
        const cell = cells[r * perRow + c];
        if (cell) right.push(...renderCell(cell, columnWidth));
      }
      if (r === statRows && split.length) right.push(...clipLine(split, besideRoom));
      lines.push([...padLine(left, digitWidth), seg('    '), ...right]);
    }
  } else {
    lines.push(...art);
  }
  lines.push([seg(caption, 'muted')]);
  if (perRow < 2) {
    lines.push([]);
    const columns = width >= 34 ? 2 : 1;
    const columnWidth = Math.floor(width / columns);
    for (let i = 0; i < cells.length; i += columns) {
      const row: Line = [];
      for (let c = 0; c < columns; c++) if (cells[i + c]) row.push(...renderCell(cells[i + c]!, columnWidth));
      lines.push(row);
    }
    if (split.length) lines.push(clipLine(split, width));
  }
  void frame;
  return { lines };
}

function headerLine(data: BoardData, width: number, compactHero: boolean): Line {
  const left: Line = [seg('slopie', 'brand')];
  if (compactHero) {
    left.push(seg('  ' + (data.hero.value === null ? UNKNOWN : heroMoney(data.hero.value)), 'value'));
    if (width >= 70) left.push(seg(` · ${compact(data.stats.tokens)} tokens`, 'muted'));
  }
  const from = data.range.from ? monthYear(data.range.from) : null;
  const to = data.range.to ? monthYear(data.range.to) : null;
  const range = from && to ? (from === to ? from : `${from} → ${to}`) : data.loading ? 'reading your history…' : '';
  const agents = data.agents.length ? (width >= 90 ? data.agents.join(' · ') : `${data.agents.length} ${data.agents.length === 1 ? 'agent' : 'agents'}`) : '';
  const right = [range, compactHero && width < 70 ? '' : agents].filter(Boolean).join(' · ');
  return spread(left, right ? [seg(right, 'muted')] : [], width);
}

/* ───────────────────────────── footer ───────────────────────────── */

function progressText(data: BoardData, width: number, ascii: boolean, frame: number): Line {
  const spin = SPINNER[frame % SPINNER.length]!;
  const parts: Line = [seg(spin + ' ', 'accent')];
  const progress = data.progress;
  if (data.phase === 'finding' || !progress) {
    parts.push(seg('finding history ', 'text'));
    const found = data.sources.map(source =>
      `${source.name} ${source.state === 'checking' ? '…' : source.state === 'found' ? count(source.files) : source.state === 'none' ? 'none' : 'unreadable'}`);
    parts.push(seg(found.join(' · '), 'muted'));
    return parts;
  }
  parts.push(seg(progress.label, 'text'));
  if (progress.done !== null) {
    parts.push(seg(` ${count(progress.done)}${progress.total ? ` of ${count(progress.total)}` : ''} ${progress.unit}`, 'muted'));
    if (progress.total && width >= 70) {
      const barWidth = Math.min(24, width - lineWidth(parts) - 30);
      if (barWidth >= 6) {
        const fraction = Math.min(1, progress.done / progress.total);
        const filled = Math.round(fraction * barWidth);
        parts.push(seg('  '));
        parts.push(seg((ascii ? '=' : '━').repeat(filled), 'accent'), seg((ascii ? '-' : '─').repeat(barWidth - filled), 'faint'));
        parts.push(seg(` ${Math.floor(fraction * 100)}%`, 'muted'));
      }
    }
  }
  return parts;
}

function footerLine(data: BoardData, width: number, page: number, pages: number, options: LayoutOptions, mode: 'board' | 'details'): Line {
  const ascii = Boolean(options.ascii);
  const keys: Line = [];
  if (pages > 1) keys.push(seg(`${ascii ? '<' : '←'} ${page + 1}/${pages} ${ascii ? '>' : '→'}`, 'value'), seg('  '));
  keys.push(seg(mode === 'details' ? '? back' : '? details', 'muted'), seg('  q quit', 'muted'));
  let left: Line;
  if (options.hint) left = [seg(options.hint, 'muted')];
  else if (data.loading) left = progressText(data, width - lineWidth(keys) - 2, ascii, options.frame ?? 0);
  else if (data.footnote) left = [seg(data.footnote, data.failure ? 'accent' : 'faint')];
  else left = [];
  const room = width - lineWidth(keys) - 2;
  if (lineWidth(left) > room && left.length) {
    const clipped = clipLine(left, Math.max(0, room - 1));
    left = [...clipped, seg('…', 'faint')];
  }
  return spread(left, keys, width);
}

/* ───────────────────────────── packing ───────────────────────────── */

type Group = Card[];

function groupHeight(group: Group, pick: (card: Card) => number): number {
  return Math.max(...group.map(pick));
}

function renderGroup(group: Group, height: number, width: number, gutter: number): Line[] {
  if (group.length === 1) {
    const lines = group[0]!.render(height);
    return Array.from({ length: height }, (_, i) => padLine(lines[i] ?? [], width));
  }
  const columnWidth = Math.floor((width - gutter * (group.length - 1)) / group.length);
  const rendered = group.map(card => card.render(height));
  return Array.from({ length: height }, (_, i) => {
    const line: Line = [];
    rendered.forEach((lines, c) => {
      if (c) line.push(seg(' '.repeat(gutter)));
      line.push(...padLine(lines[i] ?? [], c === group.length - 1 ? width - (columnWidth + gutter) * (group.length - 1) : columnWidth));
    });
    return line;
  });
}

/** Fit groups into `available` rows: shrink toward min if needed, grow toward max if there is spare. */
function fitHeights(groups: Group[], available: number, growth = 3): number[] | null {
  const separators = Math.max(0, groups.length - 1);
  const heights = groups.map(group => groupHeight(group, card => card.natural));
  const mins = groups.map(group => groupHeight(group, card => card.min));
  const maxes = groups.map(group => groupHeight(group, card => card.max));
  let total = heights.reduce((sum, h) => sum + h, 0) + separators;
  while (total > available) {
    let best = -1;
    for (let i = 0; i < heights.length; i++) if (heights[i]! > mins[i]! && (best < 0 || heights[i]! - mins[i]! > heights[best]! - mins[best]!)) best = i;
    if (best < 0) return null;
    heights[best]!--;
    total--;
  }
  // Grow a little, but keep breathing room: at most +3 rows per group.
  let grew = true;
  while (total < available - 2 && grew) {
    grew = false;
    for (let i = 0; i < heights.length && total < available - 2; i++) {
      const natural = groupHeight(groups[i]!, card => card.natural);
      if (heights[i]! < maxes[i]! && heights[i]! < natural + growth) {
        heights[i]!++;
        total++;
        grew = true;
      }
    }
  }
  return heights;
}

export function buildBoard(data: BoardData, options: LayoutOptions): Board {
  const columns = Math.max(1, options.columns);
  const rows = Math.max(1, options.rows);
  const ascii = Boolean(options.ascii);
  if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
    const message: Line[] = wrap(`Make the window a little bigger (at least ${MIN_COLUMNS}×${MIN_ROWS}). q quits.`, Math.max(1, columns - 2)).map(text => [seg(' ' + text, 'muted')]);
    const page = Array.from({ length: rows }, (_, i) => message[i] ?? []);
    return { pages: [finish(page, columns, ascii)], cards: [[]], bannerRows: 0 };
  }

  const content = Math.min(MAX_CONTENT, columns - 4);
  const margin = Math.floor((columns - content) / 2);
  const twoColumns = content >= 76;
  const gutter = content >= 100 ? 6 : 4;
  const cardWidth = twoColumns ? Math.floor((content - gutter) / 2) : content;
  const lastWidth = twoColumns ? content - cardWidth - gutter : content;

  const models = modelsCard(data, cardWidth);
  const projects = projectsCard(data, lastWidth);
  const activity = activityCard(data, cardWidth, ascii);
  const repeats = repeatsCard(data, lastWidth, ascii);
  const reactions = reactionsCard(data, cardWidth);
  const swears = swearsCard(data, lastWidth);
  let groups: Group[] = twoColumns
    ? [[models, projects], [activity, repeats], [reactions, swears]]
    : [[modelsCard(data, content)], [projectsCard(data, content)], [activityCard(data, content, ascii)], [repeatsCard(data, content, ascii)], [reactionsCard(data, content)], [swearsCard(data, content)]];
  if (options.share) {
    groups = twoColumns
      ? [[models, activityCard(data, lastWidth, ascii)], [reactions, swears]]
      : [[modelsCard(data, content)], [activityCard(data, content, ascii)], [reactionsCard(data, content)], [swearsCard(data, content)]];
  }

  // Top of page 1: header, hero, personality. Later pages: a compact header.
  const hero = heroBlock(data, content, ascii, options.frame ?? 0);
  const firstTop: Line[] = [headerLine(data, content, false), [], ...hero.lines];
  if (data.personality) firstTop.push([], [seg(data.personality, 'text')]);
  else if (data.loading) firstTop.push([], [seg(skeleton(Math.min(40, content), 2), 'faint')]);
  firstTop.push([]);
  const laterTop: Line[] = [headerLine(data, content, true), []];
  const bannerText = options.banner ? wrap(options.banner, content).map(text => [seg(text, 'accent')] as Line) : [];
  // A banner is only drawn when it fits completely next to the hero header.
  const banner = bannerText.length && bannerText.length + 6 <= rows ? bannerText : [];
  const bottom = 2 + banner.length; // blank + footer (+ banner)

  // Try one page; otherwise paginate greedily with natural sizes.
  const pages: { top: Line[]; groups: Group[]; heights: number[] }[] = [];
  const firstAvailable = rows - firstTop.length - bottom;
  const one = fitHeights(groups, firstAvailable);
  if (one) pages.push({ top: firstTop, groups, heights: one });
  else {
    // First-fit by natural height, keeping priority order within each page.
    const naturalTotal = (list: Group[]) => list.reduce((sum, group) => sum + groupHeight(group, card => card.natural), 0) + Math.max(0, list.length - 1);
    const bins: { top: Line[]; groups: Group[] }[] = [];
    for (const group of groups) {
      const bin = bins.find(candidate => naturalTotal([...candidate.groups, group]) <= rows - candidate.top.length - bottom);
      if (bin) bin.groups.push(group);
      else bins.push({ top: bins.length ? laterTop : firstTop, groups: [group] });
    }
    for (const bin of bins) {
      const available = rows - bin.top.length - bottom;
      const heights = fitHeights(bin.groups, available, bin.top === firstTop ? 3 : 6) ?? bin.groups.map(group => Math.max(1, Math.min(available, groupHeight(group, card => card.min))));
      pages.push({ top: bin.top, groups: bin.groups, heights });
    }
    // A page 1 that cannot hold any card keeps just the hero.
    if (!pages.length) pages.push({ top: firstTop, groups: [], heights: [] });
  }

  const built = pages.map((page, index) => {
    const lines: Line[] = [...page.top];
    const used = page.top.length + page.heights.reduce((sum, h) => sum + h, 0) + Math.max(0, page.groups.length - 1);
    const roomy = rows - bottom - used >= page.groups.length + 1;
    page.groups.forEach((group, g) => {
      if (g) lines.push([]);
      if (g && roomy) lines.push([]);
      lines.push(...renderGroup(group, page.heights[g]!, content, gutter));
    });
    const body = lines.slice(0, rows - bottom);
    while (body.length < rows - bottom) body.push([]);
    body.push(...banner, [], footerLine(data, content, index, pages.length, options, 'board'));
    return finish(body.map(line => [seg(' '.repeat(margin)), ...line]), columns, ascii);
  });
  return { pages: built, cards: pages.map(page => page.groups.flat().map(card => card.id)), bannerRows: banner.length };
}

/** Details page(s): plain-English caveats, paged to fit — never scrolled. */
export function buildDetails(data: BoardData, sections: { title: string; lines: string[] }[], options: LayoutOptions): Line[][] {
  const columns = Math.max(1, options.columns);
  const rows = Math.max(1, options.rows);
  const content = Math.max(10, Math.min(100, columns - 4));
  const margin = Math.max(0, Math.floor((columns - content) / 2));
  const body: Line[] = [];
  for (const section of sections) {
    if (body.length) body.push([]);
    body.push([seg(section.title.toUpperCase(), 'title')]);
    for (const text of section.lines) for (const row of wrap(text, content)) body.push([seg(row, section.title.startsWith('Technical') ? 'faint' : 'text')]);
  }
  const perPage = Math.max(1, rows - 4);
  const chunks: Line[][] = [];
  for (let i = 0; i < body.length; i += perPage) chunks.push(body.slice(i, i + perPage));
  if (!chunks.length) chunks.push([]);
  return chunks.map((chunk, index) => {
    const lines: Line[] = [[seg('slopie', 'brand'), seg('  details', 'muted')], [], ...chunk];
    while (lines.length < rows - 2) lines.push([]);
    lines.push([], footerLine(data, content, index, chunks.length, { ...options, hint: null }, 'details'));
    return finish(lines.slice(0, rows).map(line => [seg(' '.repeat(margin)), ...line]), columns, Boolean(options.ascii));
  });
}

function finish(lines: Line[], columns: number, ascii: boolean): Line[] {
  return lines.map(line => clipLine(ascii ? line.map(part => ({ ...part, text: toAscii(part.text) })) : line, columns));
}

/** Plain text of a page (for tests, plain output and captures). */
export function pageText(page: Line[]): string {
  return page.map(line => line.map(part => part.text).join('').trimEnd()).join('\n');
}

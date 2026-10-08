/** Non-interactive outputs: plain text (`--plain`) and the shareable SVG card (`--export`). */
import type { AuditEvent, AuditSnapshot } from '../../../core/src/analytics/contracts.js';
import { buildBoard, type Line } from './layout.js';
import { lineToAnsi } from './renderer.js';
import { toAscii, wrap } from './text.js';
import { boardData, detailLines } from './view-model.js';
import { buildDeck, monthLabel, type DeckCard } from './story/deck.js';
import { storyOf } from './story/source.js';
import { compact, count, hourLabel, money, shortDate } from './format.js';

export interface PlainOptions {
  width?: number;
  ascii?: boolean;
}

const lineText = (line: Line) => line.map(part => part.text).join('').trimEnd();

const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** One story card as plain text lines (no ANSI), for --plain and non-TTY output. */
export function plainCard(card: DeckCard, width = 80): string[] {
  const out: string[] = [card.kicker];
  for (const line of wrap(card.headline, width - 2)) out.push(line);
  if (card.support && card.kind !== 'guess') for (const line of wrap(card.support, width - 2)) out.push(line);
  const rows: string[] = [];
  const d = card.data as never;
  switch (card.kind) {
    case 'cold_open': rows.push(`— ${card.data.stamp}`, card.data.caption); break;
    case 'scale': rows.push(card.data.counters.map(k => `${k.style === 'compact' ? compact(k.value) : count(k.value)} ${k.label.toLowerCase()}`).join(' · ')); break;
    case 'bill':
      for (const line of card.data.lines) rows.push(`${line.name.padEnd(24, '.')} ${money(line.value)}`);
      if (card.data.more) rows.push(`${'everything else'.padEnd(24, '.')} ${money(card.data.more)}`);
      rows.push(`${'TOTAL'.padEnd(24)} ${money(card.data.total)}`);
      if (card.data.byAgent.length) rows.push('by agent: ' + card.data.byAgent.map(a => `${a.name} ${a.share > 0 && a.share < 0.01 ? '<1' : Math.round(a.share * 100)}%`).join(' · '));
      break;
    case 'clock': for (const call of card.data.callouts) rows.push(`${call.label.toLowerCase()}: ${call.value} (${call.sub})`); break;
    case 'guess': {
      const best = card.data.options[card.data.answer]!;
      rows.push(`answer: ${best.name}`, ...[...card.data.options].sort((a, b) => b.share - a.share).map(o => `  ${o.name} ${Math.round(o.share * 100)}%`));
      if (card.data.after) rows.push(card.data.after);
      break;
    }
    case 'faceoff':
      if (card.data.best) rows.push(`favourite: ${card.data.best.label} · ${card.data.best.per100.toFixed(1)} thank-yous per 100 prompts${card.data.best.expected !== null ? ` (others ${card.data.best.expected.toFixed(1)})` : ''}`);
      if (card.data.worst) rows.push(`nemesis: ${card.data.worst.label} · ${card.data.worst.per100.toFixed(1)} swears per 100 prompts${card.data.worst.expected !== null ? ` (others ${card.data.worst.expected.toFixed(1)})` : ''}`);
      break;
    case 'mood': rows.push(card.data.months.map(m => `${monthLabel(m.month)} ${m.pct.toFixed(1)}%`).join(' · ')); break;
    case 'fuse': rows.push(`first swear at prompt #${card.data.median} (median) · ${card.data.sessions} of ${card.data.of} sessions`); break;
    case 'talk': for (const tile of card.data.tiles) rows.push(`${tile.label.toLowerCase()}: ${tile.quoted ? `“${tile.text}”` : tile.text}${tile.count !== null ? ` ×${count(tile.count)}` : ''}`); break;
    case 'manners': rows.push(`${count(card.data.kind)} ${card.data.kindLabel} vs ${count(card.data.rude)} ${card.data.rudeLabel}`); break;
    case 'projects':
      for (const p of card.data.rows) rows.push(`${p.name.padEnd(22)} ${String(p.prompts).padStart(6)} prompts${p.cost !== null ? `  ${money(p.cost)}` : ''}`);
      if (card.data.gotAway) rows.push(`got away: ${card.data.gotAway.name}, silent for ${card.data.gotAway.idle} days${card.data.gotAway.lastWords ? ` · last words “${card.data.gotAway.lastWords}”` : ''}`);
      break;
    case 'delegation': rows.push(card.data.months.map(m => `${monthLabel(m.month)} ${m.n}`).join(' · ')); break;
    case 'then_now':
      rows.push(`then (${shortDate(card.data.then.day, true)}): ${card.data.then.quote ? `“${card.data.then.quote}”` : `${card.data.then.words} words`}`);
      rows.push(`now (${shortDate(card.data.now.day, true)}): ${card.data.now.quote ? `“${card.data.now.quote}”` : `${card.data.now.words} words`}`);
      break;
    case 'archetype':
      if (card.data.tier) rows.push(`rarity: ${card.data.tier}${card.data.subRole ? ` · ${card.data.subRole}` : ''}`);
      rows.push(...wrap(card.data.profile, width - 2));
      for (const m of card.data.deciding) rows.push(`- ${m.display}`);
      break;
    case 'awards': for (const tr of card.data.trophies) rows.push(`${tr.title}: ${tr.value}${tr.sub ? ` (${tr.sub})` : ''}`); break;
    case 'insight': for (const series of card.data.chart.series.slice(0, 2)) rows.push(`${series.name}: ` + series.points.slice(0, 12).map(p => `${p.x} ${p.y}`).join(' · ')); break;
    case 'board': {
      const b = card.data;
      if (b.bill !== null) rows.push(`at API prices: ${money(b.bill)}`);
      if (b.peak) rows.push(`peak: ${b.peak}`);
      if (b.topModel) rows.push(`most used: ${b.topModel}`);
      if (b.best) rows.push(`favourite: ${b.best}`);
      if (b.worst) rows.push(`nemesis: ${b.worst}`);
      rows.push(b.stats.map(s2 => `${s2.value} ${s2.label}`).join(' · '));
      if (b.catchphrase) rows.push(`catchphrase: “${b.catchphrase.text}” ×${count(b.catchphrase.count)}`);
      break;
    }
  }
  void d; void WEEK; void hourLabel;
  for (const row of rows) for (const line of wrap(row, width - 4)) out.push('  ' + line);
  return out;
}

/** The whole board on one tall page (never clipped to a viewport), then the details. */
export function renderPlain(snapshot: AuditSnapshot, options: PlainOptions = {}, transfers: readonly Extract<AuditEvent, { type: 'transfer' }>[] = []): string {
  const width = Math.max(40, Math.min(160, options.width ?? 80));
  const data = boardData(snapshot);
  const board = buildBoard(data, { columns: width, rows: 80, ascii: options.ascii });
  const lines = board.pages[0]!.map(lineText);
  const story: string[] = [];
  if (storyOf(snapshot)) {
    for (const card of buildDeck(snapshot)) {
      if (card.kind === 'board') continue;
      story.push(...plainCard(card, width).map((line, i) => (i === 0 ? '  ' + line : '  ' + line)), '');
    }
    story.push('  THE BOARD', '');
  }
  lines.pop(); // footer keys are meaningless outside the interactive view
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  const out = [...story, ...lines, ''];
  if (data.footnote) out.push('  ' + data.footnote, '');
  for (const section of detailLines(snapshot, transfers)) {
    out.push('  ' + section.title.toUpperCase());
    for (const text of section.lines) for (const row of wrap(text, width - 4)) out.push('  ' + row);
    out.push('');
  }
  const text = out.join('\n').trimEnd() + '\n';
  return options.ascii ? toAscii(text) : text;
}

/** Shareable SVG: hero, models, activity, reactions and swear jar. No project names or quotes. */
export function renderShareSvg(snapshot: AuditSnapshot, options: PlainOptions = {}): string {
  const columns = Math.max(60, Math.min(120, options.width ?? 100));
  const rows = 30;
  const board = buildBoard(boardData(snapshot), { columns, rows, ascii: options.ascii, share: true });
  const page = board.pages[0]!.slice(0, -1);
  while (page.length && !lineText(page.at(-1)!)) page.pop();
  const cellWidth = 8.4;
  const cellHeight = 18;
  const colors: Record<string, string> = { brand: '#F2A45E', accent: '#F2A45E', title: '#A6A29B', value: '#EEEAE4', text: '#EEEAE4', muted: '#A6A29B', faint: '#68665F' };
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = page.map((line, row) => {
    let column = 0;
    const spans = line.map(part => {
      const x = (column * cellWidth + 16).toFixed(1);
      column += [...part.text].length;
      if (!part.text.trim()) return '';
      const weight = part.style === 'brand' || part.style === 'value' || part.style === 'title' ? ' font-weight="700"' : '';
      return `<tspan x="${x}" fill="${colors[part.style]}"${weight}>${escape(part.text)}</tspan>`;
    }).join('');
    return `<text y="${(row + 1) * cellHeight + 12}" xml:space="preserve">${spans}</text>`;
  });
  const width = Math.ceil(columns * cellWidth + 32);
  const height = (page.length + 1) * cellHeight + 24;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" rx="12" fill="#10100F"/>`,
    `<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="14">`,
    ...body,
    '</g>',
    '</svg>',
    '',
  ].join('\n');
}

/** Exposed for debugging captures: one board page as ANSI. */
export function renderAnsiPage(snapshot: AuditSnapshot, columns: number, rows: number, page = 0): string {
  const board = buildBoard(boardData(snapshot), { columns, rows });
  return (board.pages[Math.min(page, board.pages.length - 1)] ?? []).map(line => lineToAnsi(line, 'truecolor')).join('\n');
}

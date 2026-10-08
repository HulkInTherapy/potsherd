/** Non-interactive outputs: plain text (`--plain`) and the shareable SVG card (`--export`). */
import type { AuditEvent, AuditSnapshot } from '../../../core/src/analytics/contracts.js';
import { buildBoard, type Line } from './layout.js';
import { lineToAnsi } from './renderer.js';
import { toAscii, wrap } from './text.js';
import { boardData, detailLines } from './view-model.js';

export interface PlainOptions {
  width?: number;
  ascii?: boolean;
}

const lineText = (line: Line) => line.map(part => part.text).join('').trimEnd();

/** The whole board on one tall page (never clipped to a viewport), then the details. */
export function renderPlain(snapshot: AuditSnapshot, options: PlainOptions = {}, transfers: readonly Extract<AuditEvent, { type: 'transfer' }>[] = []): string {
  const width = Math.max(40, Math.min(160, options.width ?? 80));
  const data = boardData(snapshot);
  const board = buildBoard(data, { columns: width, rows: 80, ascii: options.ascii });
  const lines = board.pages[0]!.map(lineText);
  lines.pop(); // footer keys are meaningless outside the interactive view
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  const out = [...lines, ''];
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

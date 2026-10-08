/** Three-row block digits for the hero number. Every glyph is 3 cells wide except punctuation. */

const GLYPHS: Record<string, readonly [string, string, string]> = {
  '0': ['█▀█', '█ █', '▀▀▀'],
  '1': ['▀█ ', ' █ ', '▀▀▀'],
  '2': ['▀▀█', '█▀▀', '▀▀▀'],
  '3': ['▀▀█', ' ▀█', '▀▀▀'],
  '4': ['█ █', '▀▀█', '  ▀'],
  '5': ['█▀▀', '▀▀█', '▀▀▀'],
  '6': ['█▀▀', '█▀█', '▀▀▀'],
  '7': ['▀▀█', '  █', '  ▀'],
  '8': ['█▀█', '█▀█', '▀▀▀'],
  '9': ['█▀█', '▀▀█', '▀▀▀'],
  ',': [' ', ' ', '▄'],
  '.': [' ', ' ', '▀'],
  '<': ['  ', '▄▀', ' ▀'],
  '—': ['   ', '▀▀▀', '   '],
};

const ASCII_GLYPHS: Record<string, readonly [string, string, string]> = {
  '0': [' _ ', '| |', '|_|'],
  '1': ['   ', '  |', '  |'],
  '2': [' _ ', ' _|', '|_ '],
  '3': [' _ ', ' _|', ' _|'],
  '4': ['   ', '|_|', '  |'],
  '5': [' _ ', '|_ ', ' _|'],
  '6': [' _ ', '|_ ', '|_|'],
  '7': [' _ ', '  |', '  |'],
  '8': [' _ ', '|_|', '|_|'],
  '9': [' _ ', '|_|', ' _|'],
  ',': [' ', ' ', ','],
  '.': [' ', ' ', '.'],
  '<': ['  ', ' <', '  '],
  '—': ['   ', '---', '   '],
};

/**
 * Render "$9,238" as three rows. The currency sign is drawn small (superscript style)
 * on the first row so the digits stay readable.
 */
export function bigNumber(text: string, ascii = false): [string, string, string] {
  const font = ascii ? ASCII_GLYPHS : GLYPHS;
  const rows: [string, string, string] = ['', '', ''];
  let first = true;
  for (const char of text) {
    if (char === '$') {
      rows[0] += '$ ';
      rows[1] += '  ';
      rows[2] += '  ';
      continue;
    }
    const glyph = font[char];
    if (!glyph) continue;
    const gap = first ? '' : ' ';
    first = false;
    for (let i = 0; i < 3; i++) rows[i] += gap + glyph[i]!;
  }
  return rows;
}

export function bigNumberWidth(text: string): number {
  return bigNumber(text)[0].length;
}

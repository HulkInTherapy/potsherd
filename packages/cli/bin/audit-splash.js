// Instant first frame for `slopie audit`.
//
// Loading the CLI bundle takes ~300 ms. For the interactive audit we paint the
// loading story's first frame (Slopie, the brand, the privacy promise) before
// the bundle loads, so the screen responds at once; the real loading story
// takes over the alternate screen in exactly the same place and calls
// `globalThis.__slopieSplash.handOff()`.
//
// The pixel art and geometry mirror packages/cli/src/audit-ui/{mascot,loading}.ts;
// tests/audit-ui/splash.test.ts keeps them identical.
//
// If anything else ends up writing (an error, --help), the alternate screen is
// left first so the message stays visible, and the terminal is always restored
// on exit.

const PLAIN_FLAGS = new Set(['--json', '--plain', '--export', '--legacy', '--sweep', '--verify', '--help', '-h', '--version', '-V']);

/** Slopie, idle. Rows of palette letters; '.' is transparent. First row is pixel row -2 (the tip). */
export const SPLASH_ART = {
  big: {
    top: -2,
    palette: ['#ff7a1a', '#e16011', '#c94a0a', '#ffb070', '#fff4e6', '#ffffff', '#1c0f08', '#8a2e05', '#ff7027'],
    rows: ['........ab....', '.......aa.....', '.....aaaa.....', '...aaddaaaa...', '..adedaaaaaa..', '.aadaaaaaaaab.', '.adaaaaaaaabb.', 'aaaaaaaaaaaabb', 'aaafgaaaafgabb', 'aaaggaaaaggabb', 'aaaaaaaaaaaabb', 'aiiaahaahaaiib', 'caaaaahhaaaabc', 'ccaaaaaaaaaacc', '.cccccccccccc.', '..cccccccccc..', '...c.......c..', '...........b..'],
  },
  compact: {
    top: 0,
    palette: ['#ff7a1a', '#e16011', '#c94a0a', '#ffb070', '#fff4e6', '#1c0f08', '#8a2e05'],
    rows: ['..aaaa..', '.adaaaa.', 'aeaaaaab', 'aafaafab', 'aafaafab', 'aagaagab', 'caaggaac', '.cccccc.'],
  },
};

/** Mirrors loadingGeometry() in audit-ui/loading.ts. */
export function splashGeometry(w, h) {
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

const INK = [13, 11, 10];
const TUNED_256 = { '#ff7a1a': 208, '#ffb070': 215, '#fff4e6': 230, '#ffffff': 231, '#c94a0a': 166, '#8a2e05': 94, '#1c0f08': 232 };
const hexRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
function to256(hex) {
  if (TUNED_256[hex]) return TUNED_256[hex];
  const cube = [0, 95, 135, 175, 215, 255];
  const near = v => cube.reduce((best, c, i) => (Math.abs(c - v) < Math.abs(cube[best] - v) ? i : best), 0);
  const [r, g, b] = hexRgb(hex);
  return 16 + 36 * near(r) + 6 * near(g) + near(b);
}

/** Cells for the art: Map "x,y" → [topHex|null, bottomHex|null], in cell coordinates. */
export function splashCells(size, x, y, scale) {
  const art = SPLASH_ART[size];
  const offset = size === 'big' ? 2 : 0;
  const top = size === 'big' ? 2 : 0;
  const cells = new Map();
  art.rows.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      if (row[rx] === '.') continue;
      const color = art.palette['abcdefghij'.indexOf(row[rx])];
      const px = rx, py = ry + art.top;
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
        const cx = x + (px + offset) * scale + sx;
        const pyy = y * 2 + (py + top) * scale + sy;
        const key = `${cx},${pyy >> 1}`;
        const cell = cells.get(key) ?? [null, null];
        cell[pyy & 1] = color;
        cells.set(key, cell);
      }
    }
  });
  return cells;
}

export function auditSplash(argv = process.argv.slice(2)) {
  const { stdin, stdout, stderr } = process;
  if (argv[0] !== 'audit' || argv.some(arg => PLAIN_FLAGS.has(arg.split('=')[0]))) return;
  if (!stdin.isTTY || !stdout.isTTY || process.env.SLOPIE_NO_SPLASH === '1') return;
  const w = stdout.columns || 80;
  const h = stdout.rows || 24;
  if (w < 60 || h < 20) return;

  const color = !('NO_COLOR' in process.env) && !argv.includes('--no-color') && process.env.TERM !== 'dumb';
  const truecolor = /^(truecolor|24bit)$/i.test(process.env.COLORTERM ?? '') || /^(iTerm\.app|WezTerm|ghostty|vscode)$/i.test(process.env.TERM_PROGRAM ?? '');
  const deep = color && (truecolor || /256/.test(process.env.TERM ?? '') || process.env.TERM_PROGRAM === 'Apple_Terminal');
  const fg = hex => (!color ? '' : truecolor ? `\x1b[38;2;${hexRgb(hex).join(';')}m` : `\x1b[38;5;${to256(hex)}m`);
  const bgOf = hex => (!deep ? '' : truecolor ? `\x1b[48;2;${hexRgb(hex).join(';')}m` : `\x1b[48;5;${to256(hex)}m`);
  const ink = !deep ? '' : truecolor ? `\x1b[48;2;${INK.join(';')}m` : '\x1b[48;5;233m';
  const reset = `\x1b[0m${ink}`;

  const g = splashGeometry(w, h);
  let out = `\x1b[?1049h\x1b[?25l${ink}\x1b[H\x1b[2J`;
  const at = (x, y, text) => { out += `\x1b[${y + 1};${x + 1}H${text}${reset}`; };
  at(g.mx, g.L ? 1 : 0, `\x1b[1m${fg('#ff7a1a')}slopie${reset} ${fg('#5c5c5c')}audit`);
  if (deep) {
    const cells = splashCells(g.S ? 'compact' : 'big', g.sx, g.sy, g.S ? 1 : g.scale);
    for (const [key, [top, bottom]] of cells) {
      const [x, y] = key.split(',').map(Number);
      if (top && bottom) at(x, y, top === bottom ? `${fg(top)}█` : `${fg(top)}${bgOf(bottom)}▀`);
      else if (top) at(x, y, `${fg(top)}▀`);
      else if (bottom) at(x, y, `${fg(bottom)}▄`);
    }
  } else {
    at(g.sx + 4, g.sy + Math.floor(g.mascotH / 2), `${fg('#ff7a1a')}(•ᴗ•)`);
  }
  const privacy = 'all local · nothing leaves this machine';
  const py = h - (g.L ? 2 : 1);
  const px = Math.round(w / 2 - (privacy.length + 2) / 2);
  at(px, py, `${fg('#ff7a1a')}●${reset} ${fg('#5c5c5c')}${privacy}`);
  const cy = g.rowsY + (g.L ? 13 : 9);
  at(g.panelX, cy, `${fg('#ffb070')}finding your agents`);
  stdout.write(out + '\x1b[0m');
  try { stdin.setRawMode(true); } catch { /* not a raw-capable tty */ }

  let active = true;
  const originalOut = stdout.write.bind(stdout);
  const originalErr = stderr.write.bind(stderr);
  const leave = () => {
    if (!active) return;
    active = false;
    stdout.write = originalOut;
    stderr.write = originalErr;
    try { stdin.setRawMode(false); } catch { /* ignore */ }
    originalOut('\x1b[0m\x1b[?25h\x1b[?1049l');
  };
  // Anything other than the story writing first means we must get out of the way.
  stdout.write = (...args) => { leave(); return stdout.write(...args); };
  stderr.write = (...args) => { leave(); return stderr.write(...args); };
  process.once('exit', leave);

  globalThis.__slopieSplash = {
    handOff() {
      if (!active) return;
      active = false;
      stdout.write = originalOut;
      stderr.write = originalErr;
      process.off('exit', leave);
    },
  };
}

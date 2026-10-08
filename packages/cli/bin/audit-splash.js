// Instant first frame for `slopie audit`.
//
// Loading the CLI bundle takes ~300 ms. For the interactive audit we paint a
// skeleton frame first (in well under 100 ms), so the screen responds at once;
// the real wallboard takes over the alternate screen as soon as it loads and
// calls `globalThis.__slopieSplash.handOff()`.
//
// If anything else ends up writing (an error, --help), the alternate screen is
// left first so the message stays visible, and the terminal is always restored
// on exit.

const PLAIN_FLAGS = new Set(['--json', '--plain', '--export', '--legacy', '--sweep', '--verify', '--help', '-h', '--version', '-V']);

export function auditSplash(argv = process.argv.slice(2)) {
  const { stdin, stdout, stderr } = process;
  if (argv[0] !== 'audit' || argv.some(arg => PLAIN_FLAGS.has(arg.split('=')[0]))) return;
  if (!stdin.isTTY || !stdout.isTTY || process.env.SLOPIE_NO_SPLASH === '1') return;
  const columns = stdout.columns || 80;
  const rows = stdout.rows || 24;
  if (columns < 40 || rows < 12) return;

  const color = !('NO_COLOR' in process.env) && !argv.includes('--no-color') && process.env.TERM !== 'dumb';
  const ascii = argv.includes('--ascii');
  const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const orange = '1;38;5;215';
  const gray = '38;5;248';
  const dark = '38;5;241';

  const width = Math.min(132, columns - 4);
  const margin = ' '.repeat(Math.floor((columns - width) / 2));
  const status = 'reading your history…';
  const block = ascii ? '.' : '░';
  const lines = [];
  lines[0] = margin + paint(orange, 'slopie') + ' '.repeat(Math.max(1, width - 6 - status.length)) + paint(gray, status);
  for (let i = 2; i <= 4; i++) lines[i] = margin + paint(dark, block.repeat(20));
  lines[5] = margin + paint(gray, 'what your tokens would cost at API prices');
  lines[rows - 1] = margin + paint(orange, ascii ? '-' : '⠋') + ' ' + paint(gray, 'starting…');

  let out = '\x1b[?1049h\x1b[H\x1b[2J\x1b[?25l';
  lines.forEach((line, row) => {
    if (line) out += `\x1b[${row + 1};1H${line}`;
  });
  stdout.write(out);
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
  // Anything other than the wallboard writing first means we must get out of the way.
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

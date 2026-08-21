import process from 'node:process';
import * as readline from 'node:readline/promises';
import { Theme } from '@potsherd/core';

/**
 * Every verb prints through here, so the design-system rules in plans/05 are
 * enforced once rather than remembered twenty-five times:
 *
 *   --json on everything, carrying identical data to the human view
 *   NO_COLOR / --no-color / non-TTY honoured
 *   errors are one line of what happened plus one line of the fix
 *   no stack traces without --debug
 */

export interface GlobalOptions {
  json?: boolean;
  color?: boolean;
  ascii?: boolean;
  width?: number;
  debug?: boolean;
  claudeDir?: string;
  potsherdDir?: string;
  quiet?: boolean;
  yes?: boolean;
}

/**
 * The theme the verb running in this process chose.
 *
 * One process runs one verb, so there is exactly one, and {@link print} uses it
 * to fold `--ascii` output as it leaves — the last gate before the terminal.
 * `render.ts` already folds every card and table it builds; this catches the
 * lines a verb writes by hand, which is where `--ascii` leaked eleven glyphs.
 */
let active: Theme | null = null;

export function themeFrom(o: GlobalOptions): Theme {
  const opts: { color?: boolean; ascii?: boolean; width?: number } = {};
  if (o.json) opts.color = false;
  else if (o.color === false) opts.color = false;
  if (o.ascii) opts.ascii = true;
  if (o.width) opts.width = o.width;
  active = new Theme(opts);
  return active;
}

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

export function print(s: string): void {
  // The fold is width-preserving (Theme.asciiLine), so it can never turn a
  // line that fitted the terminal into one that does not.
  const out = active ? active.asciiLine(s) : s;
  process.stdout.write(out.endsWith('\n') ? out : out + '\n');
}

/**
 * An error the user caused or can fix. `fix` is the one command that resolves
 * it; anything without an obvious fix should not use this class.
 */
export class UserError extends Error {
  constructor(message: string, public readonly fix?: string, public readonly code = 1) {
    super(message);
    this.name = 'UserError';
  }
}

export function fail(err: unknown, o: GlobalOptions): never {
  const t = themeFrom({ ...o, json: false });
  if (err instanceof UserError) {
    process.stderr.write(`${t.warn('potsherd:')} ${err.message}\n`);
    if (err.fix) process.stderr.write(`  try:  ${err.fix}\n`);
    process.exit(err.code);
  }
  const e = err as Error;
  process.stderr.write(`${t.warn('potsherd:')} ${e?.message ?? String(err)}\n`);
  if (o.debug && e?.stack) process.stderr.write(e.stack + '\n');
  else process.stderr.write('  try:  re-run with --debug for the full error\n');
  process.exit(1);
}

/**
 * A [y/N] prompt. Returns the default without asking when stdin is not a
 * terminal, and treats Ctrl+C / Ctrl+D as the default too — walking away from a
 * question about someone's settings file means no, not an error.
 */
export async function confirm(question: string, opts: { default?: boolean } = {}): Promise<boolean> {
  const fallback = opts.default ?? false;
  if (!process.stdin.isTTY) return fallback;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = opts.default ? '[Y/n]' : '[y/N]';
    const raw = await rl.question(`${question} ${suffix} `);
    const answer = raw.trim().toLowerCase();
    if (!answer) return fallback;
    return answer === 'y' || answer === 'yes';
  } catch {
    // AbortError from Ctrl+C, or EOF from Ctrl+D.
    process.stdout.write('\n');
    return fallback;
  } finally {
    rl.close();
  }
}

/**
 * A single-line progress indicator. Never shown when not a TTY, when --json is
 * on, or when the operation finishes fast enough that it would only flicker.
 */
export class Progress {
  private last = 0;
  private started = Date.now();
  private active = false;

  constructor(private readonly label: string, private readonly enabled: boolean) {}

  update(done: number, total: number, note = ''): void {
    if (!this.enabled) return;
    const now = Date.now();
    if (now - this.started < 300) return;
    if (now - this.last < 80 && done < total) return;
    this.last = now;
    this.active = true;
    const width = 24;
    const frac = total > 0 ? Math.min(1, done / total) : 0;
    const filled = Math.round(frac * width);
    const bar = '#'.repeat(filled) + '.'.repeat(width - filled);
    const line = `  ${this.label} [${bar}] ${done}/${total}${note ? '  ' + note : ''}`;
    process.stderr.write('\r' + line.slice(0, (process.stderr.columns ?? 80) - 1) + '\u001b[K');
  }

  done(): void {
    if (this.active) process.stderr.write('\r\u001b[K');
    this.active = false;
  }
}

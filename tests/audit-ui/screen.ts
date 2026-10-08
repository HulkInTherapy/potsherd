/** A minimal terminal screen for tests: applies cursor moves, clears and text; ignores colours. */
export class Screen {
  rows: string[][];
  private x = 0;
  private y = 0;

  constructor(readonly w: number, readonly h: number) {
    this.rows = Array.from({ length: h }, () => new Array<string>(w).fill(' '));
  }

  feed(ansi: string): this {
    const re = /\x1b\[([?]?)([0-9;]*)([A-Za-z])|\x1b.|([^\x1b])/gsu;
    for (const m of ansi.matchAll(re)) {
      if (m[4] !== undefined) {
        const ch = m[4];
        if (ch === '\r') { this.x = 0; continue; }
        if (ch === '\n') { this.y = Math.min(this.h - 1, this.y + 1); continue; }
        if (this.y < this.h && this.x < this.w) this.rows[this.y]![this.x] = ch;
        this.x++;
        continue;
      }
      if (m[1] === '?' || m[3] === undefined) continue;
      const params = (m[2] ?? '').split(';').map(Number);
      if (m[3] === 'H') { this.y = (params[0] || 1) - 1; this.x = (params[1] || 1) - 1; }
      else if (m[3] === 'J') this.rows = Array.from({ length: this.h }, () => new Array<string>(this.w).fill(' '));
      else if (m[3] === 'K') for (let i = this.x; i < this.w; i++) this.rows[this.y]![i] = ' ';
    }
    return this;
  }

  text(): string {
    return this.rows.map(row => row.join('').trimEnd()).join('\n');
  }
}

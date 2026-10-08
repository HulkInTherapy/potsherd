/** Human formatting for the wallboard. Unknown values always render as an em dash. */

export const UNKNOWN = '—';

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const twoDecimals = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const known = (value: number | null | undefined): value is number => value !== null && value !== undefined && Number.isFinite(value);

/** 4,362 */
export function count(value: number | null | undefined): string {
  return known(value) ? integer.format(value) : UNKNOWN;
}

/** 10.5B · 605M · 12.3K · 999 */
export function compact(value: number | null | undefined): string {
  if (!known(value)) return UNKNOWN;
  const abs = Math.abs(value);
  for (const [scale, suffix] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
    if (abs >= scale) {
      const scaled = value / scale;
      return (Math.abs(scaled) >= 100 ? integer.format(scaled) : oneDecimal.format(scaled)) + suffix;
    }
  }
  return integer.format(value);
}

/** $3,076 for large values, $4.81 for small ones. */
export function money(value: number | null | undefined): string {
  if (!known(value)) return UNKNOWN;
  if (value > 0 && value < 0.01) return '<$0.01';
  return '$' + (Math.abs(value) >= 100 ? integer.format(Math.round(value)) : twoDecimals.format(value));
}

/** Hero value without cents: $9,238 */
export function heroMoney(value: number | null | undefined): string {
  if (!known(value)) return UNKNOWN;
  if (value < 10) return '$' + twoDecimals.format(value);
  return '$' + integer.format(Math.round(value));
}

export function percent(value: number | null | undefined, digits = 0): string {
  if (!known(value)) return UNKNOWN;
  const scaled = value * 100;
  if (scaled > 0 && scaled < 1 && digits === 0) return '<1%';
  return scaled.toFixed(digits) + '%';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-06-10" → "Jun 10" (or "Jun 10, 2026" with year) */
export function shortDate(isoDay: string, withYear = false): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDay);
  if (!match) return UNKNOWN;
  const month = MONTHS[Number(match[2]) - 1] ?? '?';
  return `${month} ${Number(match[3])}${withYear ? `, ${match[1]}` : ''}`;
}

/** "2025-11-04" → "Nov 2025" */
export function monthYear(isoDay: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(isoDay);
  if (!match) return UNKNOWN;
  return `${MONTHS[Number(match[2]) - 1] ?? '?'} ${match[1]}`;
}

/** "2025-11-04" → "Nov '25" */
export function monthTick(isoDay: string): string {
  const match = /^(\d{2})(\d{2})-(\d{2})/.exec(isoDay);
  if (!match) return '';
  return `${MONTHS[Number(match[3]) - 1] ?? '?'} '${match[2]}`;
}

export function hourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

const PROVIDER_PREFIX = /^(?:anthropic|openai|google|google-vertex|anthropic-vertex|deepseek|qwen|mistral|x-ai|xai|groq|opencode|openrouter|amazon-bedrock)\//i;
const FAMILY = /^(opus|sonnet|haiku|fable|instant)$/i;

/**
 * Display-only model spelling. Recorded identities stay unchanged in details/JSON.
 *   anthropic/claude-opus-4-8          → Claude Opus 4.8
 *   claude-haiku-4-5-20251001          → Claude Haiku 4.5
 *   openai/gpt-6.1-sol                 → GPT-6.1 Sol
 *   gemini-2.5-flash                   → Gemini 2.5 Flash
 */
export function modelName(raw: string | null | undefined): string {
  if (!raw) return 'Unknown model';
  let id = raw.trim().replace(PROVIDER_PREFIX, '');
  id = id.replace(/[-@](\d{8}|latest)$/i, '');
  const claude = /^claude-(.+)$/i.exec(id);
  if (claude) {
    const parts = claude[1]!.split('-');
    const words: string[] = [];
    const version: string[] = [];
    for (const part of parts) {
      if (/^\d+(\.\d+)?$/.test(part)) version.push(part);
      else if (FAMILY.test(part)) words.push(part[0]!.toUpperCase() + part.slice(1).toLowerCase());
      else words.push(part);
    }
    return ['Claude', ...words, version.join('.')].filter(Boolean).join(' ');
  }
  const gpt = /^gpt-(.+)$/i.exec(id);
  if (gpt) {
    const [head, ...rest] = gpt[1]!.split('-');
    return [`GPT-${head}`, ...rest.map(word => word[0]!.toUpperCase() + word.slice(1))].join(' ');
  }
  const gemini = /^gemini-(.+)$/i.exec(id);
  if (gemini) {
    return ['Gemini', ...gemini[1]!.split('-').map(word => (/^\d/.test(word) ? word : word[0]!.toUpperCase() + word.slice(1)))].join(' ');
  }
  return id;
}

const HARNESS_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', pi: 'pi', opencode: 'OpenCode' };
export function harnessName(harness: string): string {
  return HARNESS_NAMES[harness] ?? harness;
}

export function plural(value: number, singular: string, pluralForm = singular + 's'): string {
  return value === 1 ? singular : pluralForm;
}

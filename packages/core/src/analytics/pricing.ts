/**
 * Model prices and request cost, following ccusage's rules:
 *   cost = input*in + output*out + cacheRead*cr + cacheWrite5m*cw + cacheWrite1h*(2*in)
 * A request whose whole prompt exceeds a tier threshold is billed entirely at
 * the tier rate. Every model gets a price: when the exact model is not in the
 * table the closest model of the same family is used and the price is flagged
 * as estimated.
 */
import {bundledModelCatalog, type CatalogEntry, type ModelCatalog} from './model-catalog.js';
import type {UsageFact} from './extract.js';

export interface Rates {input: number; output: number; cacheRead: number; cacheWrite: number}
export interface ModelPrice {
  /** Catalog id the price came from. */
  pricedAs: string;
  estimated: boolean;
  /** Multiplier for responses served on the fast / priority tier. */
  fast: number;
  rates: Rates;
  tiers: readonly {threshold: number; rates: Rates}[];
}

/** First-party endpoints win when several providers list the same model id. */
const PROVIDER_ORDER = ['anthropic', 'openai', 'google', 'xai', 'mistral', 'deepseek', 'opencode', 'google-vertex', 'azure', 'amazon-bedrock', 'openrouter', 'groq'];

function toRates(raw: Readonly<Record<string, number>>, base?: Rates): Rates {
  const input = raw.input ?? base?.input ?? 0;
  return {
    input,
    output: raw.output ?? base?.output ?? input,
    cacheRead: raw.cache_read ?? base?.cacheRead ?? input,
    cacheWrite: raw.cache_write ?? base?.cacheWrite ?? input,
  };
}

/** Lower-case, drop provider prefixes, bracket/at suffixes and date stamps. */
export function normalizeModel(model: string): string {
  let m = model.trim().toLowerCase();
  m = m.replace(/\[[^\]]*\]$/, '');
  if (m.includes('/')) m = m.slice(m.lastIndexOf('/') + 1);
  m = m.replace(/@.*$/, '');
  m = m.replace(/^(?:anthropic|openai|us|eu|apac|global)\./, '');
  m = m.replace(/-v\d+(?::\d+)?$/, '');
  m = m.replace(/-(?:20\d{6}|\d{4}-\d{2}-\d{2})$/, '');
  m = m.replace(/-latest$/, '');
  return m;
}

const tokens = (id: string) => id.split(/[-.]/).filter(Boolean);

export class PriceBook {
  private readonly exact = new Map<string, CatalogEntry>();
  private readonly ids: string[];
  private readonly memo = new Map<string, ModelPrice | null>();

  constructor(readonly catalog: ModelCatalog = bundledModelCatalog) {
    const rank = (p: string) => { const i = PROVIDER_ORDER.indexOf(p); return i < 0 ? PROVIDER_ORDER.length : i; };
    const usable = catalog.models.filter(m => typeof m.rates.input === 'number' && m.rates.input > 0);
    usable.sort((a, b) => rank(a.provider) - rank(b.provider));
    for (const entry of usable) {
      for (const id of [entry.id.toLowerCase(), normalizeModel(entry.id)]) if (!this.exact.has(id)) this.exact.set(id, entry);
    }
    this.ids = [...this.exact.keys()];
  }

  private price(entry: CatalogEntry, estimated: boolean): ModelPrice {
    const rates = toRates(entry.rates);
    return {pricedAs: entry.id, estimated, rates, fast: fastMultiplier(entry.id), tiers: (entry.tiers ?? []).map(t => ({threshold: t.threshold, rates: toRates(t.rates, rates)}))};
  }

  /** Price for a recorded model name; never null for a non-empty name. */
  lookup(model: string | null): ModelPrice | null {
    if (!model) return null;
    const cached = this.memo.get(model);
    if (cached !== undefined) return cached;
    const result = this.resolve(model);
    this.memo.set(model, result);
    return result;
  }

  private resolve(model: string): ModelPrice | null {
    const raw = model.trim().toLowerCase(), norm = normalizeModel(model);
    const hit = this.exact.get(raw) ?? this.exact.get(norm);
    if (hit) return this.price(hit, false);
    // Closest family member: the longest shared leading run of name tokens,
    // then the nearest version among those.
    const want = tokens(norm);
    let best: {id: string; shared: number; distance: number} | null = null;
    for (const id of this.ids) {
      const have = tokens(id);
      let shared = 0;
      while (shared < want.length && shared < have.length && want[shared] === have[shared]) shared++;
      if (shared === 0) continue;
      const distance = Math.abs(have.length - want.length) + versionDistance(want.slice(shared), have.slice(shared));
      if (!best || shared > best.shared || (shared === best.shared && (distance < best.distance || (distance === best.distance && id < best.id)))) best = {id, shared, distance};
    }
    if (best) return this.price(this.exact.get(best.id)!, true);
    return null;
  }
}

function versionDistance(a: readonly string[], b: readonly string[]): number {
  const x = Number(a[0]), y = Number(b[0]);
  if (Number.isFinite(x) && Number.isFinite(y)) return Math.abs(x - y);
  return a[0] === b[0] ? 0 : 1;
}

/** Fast/priority tier multipliers (ccusage fast-multiplier-overrides). */
const FAST_EXACT: Readonly<Record<string, number>> = {
  'gpt-5.6-sol': 2, 'gpt-5.6-terra': 2, 'gpt-5.6-luna': 2, 'gpt-5.5': 2.5, 'gpt-5.4': 2, 'gpt-5.3-codex': 2, 'gpt-6-astra': 2,
};
const FAST_PREFIX: readonly [string, number][] = [['claude-opus-4-6', 6], ['claude-opus-4-7', 6], ['claude-opus-4-8', 2]];
function fastMultiplier(id: string): number {
  const n = normalizeModel(id);
  return FAST_EXACT[n] ?? FAST_PREFIX.find(([prefix]) => n.startsWith(prefix))?.[1] ?? 1;
}

const MILLION = 1_000_000;

/** USD cost of one response at the given price; `fast` applies the priority-tier multiplier. */
export function usageCost(u: UsageFact, price: ModelPrice, fast = false): number {
  let rates = price.rates;
  if (price.tiers.length) {
    const context = u.input + u.cacheRead + u.cacheWrite;
    for (const tier of price.tiers) if (context > tier.threshold) rates = tier.rates;
  }
  const write1h = Math.min(u.cacheWrite1h, u.cacheWrite), write5m = u.cacheWrite - write1h;
  const usd = (u.input * rates.input + u.output * rates.output + u.cacheRead * rates.cacheRead
    + write5m * rates.cacheWrite + write1h * rates.input * 2) / MILLION;
  return fast ? usd * price.fast : usd;
}

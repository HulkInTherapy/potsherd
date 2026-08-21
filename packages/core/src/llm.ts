import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { POTSHERD_CARD_MARKER } from './markers.js';
import { elideBinary } from './redact-elide.js';
import { redact } from './redact.js';
import { onPath } from './resolve-bin.js';

/**
 * The single entry point for every model call potsherd ever makes
 * (`plans/03-ARCHITECTURE.md` §0, §11, §12; `plans/04-DECISIONS.md` Q4).
 *
 * Everything above L4 that wants a model — cards (L5), ask and graft (L7) —
 * comes through here and nowhere else. That is not tidiness; it is where four
 * separate invariants are enforced, each of which is unenforceable if callers
 * can reach a backend directly:
 *
 *   1. **Redaction is not the caller's job.** {@link Llm.text} redacts every
 *      outgoing string itself, immediately before handing it to a transport.
 *      A caller cannot opt out, cannot forget, and cannot pass "already
 *      redacted, trust me". `03` §5 has no `--no-redact` flag and this is
 *      where that promise is actually kept.
 *   2. **Nothing is spent before it is quoted.** {@link estimate} prices a run
 *      from character counts alone, with no network and no credentials, and
 *      the CLI shows it before the first call. `--max-usd` and the token cap
 *      are checked *before* each call, against the projection, so the run
 *      stops one call early rather than one call late.
 *   3. **Re-entrancy.** A card-writing session is itself a Claude Code
 *      session. Without a guard, potsherd indexes its own summaries and cards
 *      them, forever. Two mechanisms, inherited from upstream: an env guard
 *      ({@link REENTRANCY_ENV}) that makes a nested call refuse, and the
 *      content marker `POTSHERD_CARD_MARKER` in every prompt so any transcript
 *      that does get written is excluded at ingest (`markers.ts`).
 *   4. **One place to be graceful.** No `claude`, no key, no network: one
 *      error type, one message naming both options, one non-zero exit, never a
 *      stack trace and never a hang.
 *
 * ## Backends
 *
 * | backend | when | cost |
 * |---|---|---|
 * | `agent-sdk` | a `claude` binary exists (the default) | zero marginal — the user's own subscription |
 * | `codex`     | `codex exec`, when codex is the harness and there is no `claude` | zero marginal |
 * | `api`       | no `claude` binary **and** `ANTHROPIC_API_KEY` is set | metered |
 *
 * The API path is a **fallback only** (`04` Q4). It is never selected while a
 * `claude` binary exists, because the whole point of Q4 is that a Claude Code
 * user needs no key. The SDK and raw HTTP are never mixed: the api path is
 * `@anthropic-ai/sdk` and nothing else.
 *
 * ## What is *not* here
 *
 * The card schema, the ProMem-lite pipeline, the ask fan-out. Those own their
 * prompts and their parsing; this module owns the call, the redaction, the
 * money and the clock.
 *
 * **Upstream's `resume: sessionId` trick is deliberately not ported.**
 * `docs/upstream/PORT-LOG.md` records it as one of the four things worth
 * taking from `src/summarizer.ts`, and three of the four are here (the
 * `query()` option set, `persistSession: false`, the env guard). The fourth is
 * refused on principle: resuming the original session hands the model the
 * **raw transcript from disk**, which is the one text in potsherd that has
 * never been through `redact()`. It would make invariant 1 unenforceable — no
 * amount of care in this module can mask a string the harness loads for
 * itself — and it needs a writable `~/.claude/projects`, which `03` §11 says
 * potsherd does not have. The pipeline passes the redacted slices instead.
 */

// ------------------------------------------------------------------ models

export type Backend = 'agent-sdk' | 'codex' | 'api';

export type ModelAlias = 'haiku' | 'sonnet' | 'opus';

export const MODEL_ALIASES: readonly ModelAlias[] = ['haiku', 'sonnet', 'opus'];

/**
 * The three price tiers. A model id is mapped onto one of these for costing;
 * it is not a claim about which model will actually run.
 */
export type ModelClass = ModelAlias;

/** `04` Q4: haiku-class for cards. Passed to the backend as the alias. */
export const CARD_MODEL: ModelAlias = 'haiku';

/** `04` Q4: sonnet-class for `ask` synthesis. */
export const ASK_MODEL: ModelAlias = 'sonnet';

/**
 * **This constant will age.** Concrete model ids for the alias, used *only* on
 * the api fallback path, where the alias has no server-side meaning.
 *
 * The agent-sdk and codex paths never see this table: they are handed the bare
 * alias (`haiku`) and the harness resolves it to whatever it currently means,
 * which is the behaviour `04` Q4 asks for and the reason potsherd does not
 * pin a dated id as its default. When a newer haiku-class model ships, the two
 * subscription paths follow it on their own; only this map needs editing.
 */
export const API_MODEL_IDS: Record<ModelAlias, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-5',
};

export interface Price {
  inputPerMTok: number;
  outputPerMTok: number;
}

/**
 * **This table will age.** USD per million tokens, first-party API list price,
 * as published 2026-06-24. It exists so `--max-usd` and `card --dry-run` can
 * quote a number without a network call.
 *
 * On the subscription paths the marginal cost of a call is zero and this is an
 * *equivalent*: what the same tokens would have cost on the api path. `03` §12
 * sets a $2 target for the reference corpus and a user on the api path needs
 * that number to be real, so it is tracked and displayed on every path.
 */
export const PRICES: Record<ModelClass, Price> = {
  haiku: { inputPerMTok: 1, outputPerMTok: 5 },
  sonnet: { inputPerMTok: 3, outputPerMTok: 15 },
  opus: { inputPerMTok: 5, outputPerMTok: 25 },
};

/**
 * Which price tier a model id belongs to.
 *
 * An id we do not recognise is priced as the **most expensive** class we know.
 * A ceiling that over-quotes costs the user one confirmation; a ceiling that
 * under-quotes costs them money they did not agree to spend.
 */
export function modelClass(model: string): ModelClass {
  const m = model.toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('sonnet')) return 'sonnet';
  return 'opus';
}

/** True for the three bare aliases the harnesses resolve themselves. */
export function isAlias(model: string): model is ModelAlias {
  return (MODEL_ALIASES as readonly string[]).includes(model);
}

/**
 * The string a backend is handed.
 *
 * Aliases pass through untouched on the subscription paths so the harness's
 * own aliasing decides what runs; explicit ids always pass through untouched.
 * Only the api path, which has no aliasing, resolves through
 * {@link API_MODEL_IDS}.
 */
export function resolveModel(model: string, backend: Backend): string {
  if (backend === 'api' && isAlias(model)) return API_MODEL_IDS[model];
  return model;
}

// --------------------------------------------------------------- estimator

/**
 * Characters per token. `03` §6.
 *
 * Measured against nothing better on this machine: counting tokens exactly
 * needs either a tokenizer download or a `count_tokens` round trip, and the
 * estimator's whole contract is that it runs offline with no credentials. 3.6
 * is conservative for English prose with code in it (a real tokenizer gives
 * ~3.8–4.2 chars/token on the reference corpus's exchange text, so this
 * over-counts, which is the safe direction for a cost ceiling).
 *
 * If a later phase measures a better ratio on the real corpus with a real
 * tokenizer, change it here and say so in the phase handoff.
 */
export const CHARS_PER_TOKEN = 3.6;

/** Tokens for a character count, rounded up. */
export function tokensForChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}

/** Tokens for a string. Call it on the *redacted* text — masks are tokens too. */
export function tokensForText(text: string): number {
  return tokensForChars(text.length);
}

/**
 * **These constants will age.** `seconds = calls × overhead + outputTokens / throughput`.
 *
 * `CALL_OVERHEAD_MS` is **measured**, not guessed: `potsherd card --probe`
 * against haiku-class through the agent sdk on the reference machine, 21 aug
 * 2026, took 11.2 s cold and 5.4 s warm for a 10-token prompt. The warm number
 * is the one used, because a run of 300 cards pays the cold start once. Almost
 * all of it is spawning the harness, which is why the api path — which spawns
 * nothing — is faster per call despite being the fallback.
 *
 * `OUTPUT_TOKENS_PER_SECOND` is an **assumption**, deliberately conservative:
 * a 50-token reply inside a 5.4 s spawn tells you nothing about throughput, so
 * this cannot be measured until T2.2 runs real extractions. Re-measure there.
 */
export const CALL_OVERHEAD_MS = 5_400;
export const OUTPUT_TOKENS_PER_SECOND = 60;

/**
 * What the agent sdk's own system prompt costs per call, in api-equivalent
 * dollars, once it is cached. **Measured** the same way: the SDK reported
 * `total_cost_usd` $0.0027 for a call whose main-loop usage was 10 in / 50
 * out, which our token arithmetic prices at $0.0003.
 *
 * It is recorded here and deliberately **not** added to {@link estimate}: it
 * exists only on the agent-sdk path, where the marginal cost is zero, and
 * adding it would inflate the one number — the api-path quote — that a user
 * actually pays. `03` §12's $2 target is an api-path target and the estimator
 * answers that question. The agent-sdk equivalent is roughly
 * `usd + calls × HARNESS_OVERHEAD_USD` and the wall-time row is the honest
 * budget on that path anyway.
 */
export const HARNESS_OVERHEAD_USD = 0.0027;

/** Default chunk size for map-reduce over a long session (`phase-2` T2.2 §1). */
export const CHUNK_CHARS = 40_000;

/** Roughly what one extraction writes back: a card is small (`03` §6). */
export const OUTPUT_CHARS_PER_CALL = 1_400;

/** The instruction block that wraps every extraction. */
export const PROMPT_OVERHEAD_CHARS = 2_000;

export interface EstimateSession {
  id: string;
  /**
   * Characters of **redacted** text that will be sent for this session. The
   * caller counts them from the store, which is already redacted at rest.
   */
  chars: number;
  /** Overrides the chunking arithmetic when the caller already knows better. */
  calls?: number;
}

export interface EstimateInput {
  sessions: EstimateSession[];
  /** Alias or explicit id. Default {@link CARD_MODEL}. */
  model?: string;
  backend?: Backend;
  /** Zero on the subscription paths. Default: true unless `backend` says otherwise. */
  chargeable?: boolean;
  chunkChars?: number;
  outputCharsPerCall?: number;
  promptOverheadChars?: number;
  /** Calls run in parallel; wall time divides by this. Default 1. */
  concurrency?: number;
}

export interface EstimatePerSession {
  id: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export interface Estimate {
  sessions: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  seconds: number;
  model: string;
  modelClass: ModelClass;
  backend?: Backend;
  /** False on the subscription paths: `usd` is an api-equivalent, not a charge. */
  chargeable: boolean;
  perSession: EstimatePerSession[];
}

/**
 * Price and time a run before any of it happens.
 *
 * No network, no credentials, no model. `potsherd card --dry-run --all` is
 * exactly this function plus a renderer, which is what makes the dry run
 * trustworthy: there is no code path from here to a backend.
 */
export function estimate(input: EstimateInput): Estimate {
  const model = input.model ?? CARD_MODEL;
  const cls = modelClass(model);
  const price = PRICES[cls];
  const chunk = Math.max(1_000, input.chunkChars ?? CHUNK_CHARS);
  const outChars = input.outputCharsPerCall ?? OUTPUT_CHARS_PER_CALL;
  const overhead = input.promptOverheadChars ?? PROMPT_OVERHEAD_CHARS;
  const concurrency = Math.max(1, Math.floor(input.concurrency ?? 1));
  const chargeable = input.chargeable ?? (input.backend ? input.backend === 'api' : true);

  const perSession: EstimatePerSession[] = [];
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const s of input.sessions) {
    // Map-reduce: a session longer than one chunk is extracted per chunk and
    // then reduced, so it costs one extra call and one extra pass over the
    // partial results (`phase-2` T2.2 §1).
    const chunks = Math.max(1, Math.ceil(Math.max(0, s.chars) / chunk));
    const n = s.calls ?? (chunks === 1 ? 1 : chunks + 1);
    // The reduce call re-reads the per-chunk output, not the transcript.
    const reduceChars = chunks === 1 ? 0 : chunks * outChars;
    const inTok = tokensForChars(Math.max(0, s.chars) + n * overhead + reduceChars);
    const outTok = tokensForChars(n * outChars);
    const usd = (inTok / 1e6) * price.inputPerMTok + (outTok / 1e6) * price.outputPerMTok;

    perSession.push({ id: s.id, calls: n, inputTokens: inTok, outputTokens: outTok, usd });
    calls += n;
    inputTokens += inTok;
    outputTokens += outTok;
  }

  const usd = (inputTokens / 1e6) * price.inputPerMTok + (outputTokens / 1e6) * price.outputPerMTok;
  const ms = calls * CALL_OVERHEAD_MS + (outputTokens / OUTPUT_TOKENS_PER_SECOND) * 1000;

  return {
    sessions: input.sessions.length,
    calls,
    inputTokens,
    outputTokens,
    usd,
    seconds: ms / 1000 / concurrency,
    model,
    modelClass: cls,
    ...(input.backend ? { backend: input.backend } : {}),
    chargeable,
    perSession,
  };
}

// ------------------------------------------------------------------ budget

export interface Spend {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  ms: number;
}

export function emptySpend(): Spend {
  return { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0, ms: 0 };
}

export interface BudgetOptions {
  /** `--max-usd`. A hard ceiling; the run aborts rather than crossing it. */
  maxUsd?: number;
  /** Per-run token ceiling, input + output. */
  maxTokens?: number;
}

/**
 * A cap that was hit. Carries how far the run got, because "aborted" without
 * "27 of 236 done, $1.98 spent" is not something a user can act on.
 */
export class BudgetError extends Error {
  readonly name = 'BudgetError';
  constructor(
    message: string,
    readonly detail: {
      kind: 'usd' | 'tokens';
      limit: number;
      projected: number;
      done: number;
      total: number;
      spend: Spend;
    },
    readonly fix: string,
  ) {
    super(message);
  }
}

/**
 * The running total, and the gate in front of the next call.
 *
 * {@link admit} is checked **before** a call, against what that call is
 * projected to cost, so the cap is a ceiling on spend rather than a
 * post-mortem on it.
 */
export class Budget {
  private readonly spent: Spend = emptySpend();
  private done = 0;
  private total = 0;

  constructor(private readonly limits: BudgetOptions = {}) {}

  get spend(): Spend {
    return { ...this.spent };
  }

  get maxUsd(): number | undefined {
    return this.limits.maxUsd;
  }

  get maxTokens(): number | undefined {
    return this.limits.maxTokens;
  }

  /** How far the run has got, for the abort message. */
  progress(done: number, total: number): void {
    this.done = done;
    this.total = total;
  }

  /** Throws {@link BudgetError} when this call would cross a ceiling. */
  admit(projected: { usd?: number; tokens?: number } = {}): void {
    const usd = projected.usd ?? 0;
    const tokens = projected.tokens ?? 0;
    const { maxUsd, maxTokens } = this.limits;

    if (maxUsd !== undefined && this.spent.usd + usd > maxUsd) {
      throw new BudgetError(
        `stopped at --max-usd ${maxUsd.toFixed(2)}: ${this.done} of ${this.total} done, ` +
          `${fmtUsd(this.spent.usd)} spent, next call needs ${fmtUsd(usd)}`,
        {
          kind: 'usd',
          limit: maxUsd,
          projected: this.spent.usd + usd,
          done: this.done,
          total: this.total,
          spend: this.spend,
        },
        `potsherd card --all --max-usd ${Math.ceil(this.spent.usd + usd + 1)}`,
      );
    }

    const spentTokens = this.spent.inputTokens + this.spent.outputTokens;
    if (maxTokens !== undefined && spentTokens + tokens > maxTokens) {
      throw new BudgetError(
        `stopped at --max-tokens ${maxTokens}: ${this.done} of ${this.total} done, ` +
          `${spentTokens} tokens spent, next call needs ${tokens}`,
        {
          kind: 'tokens',
          limit: maxTokens,
          projected: spentTokens + tokens,
          done: this.done,
          total: this.total,
          spend: this.spend,
        },
        `potsherd card --all --max-tokens ${spentTokens + tokens + maxTokens}`,
      );
    }
  }

  record(r: { inputTokens: number; outputTokens: number; usd: number; ms: number }): void {
    this.spent.calls += 1;
    this.spent.inputTokens += r.inputTokens;
    this.spent.outputTokens += r.outputTokens;
    this.spent.usd += r.usd;
    this.spent.ms += r.ms;
  }
}

function fmtUsd(n: number): string {
  return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

// ------------------------------------------------------------- re-entrancy

/**
 * Set to `1` in the environment of every harness potsherd spawns.
 *
 * Upstream's `EPISODIC_MEMORY_SUMMARIZER_GUARD` (obra/episodic-memory#87),
 * renamed. Without it, a card run inside a Claude Code session can spawn a
 * harness that spawns a harness. With it, the nested call refuses loudly
 * instead of recursing.
 */
export const REENTRANCY_ENV = 'POTSHERD_LLM_GUARD';

/** True when this process is itself something potsherd spawned. */
export function insidePotsherdCall(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[REENTRANCY_ENV] === '1';
}

export class ReentrancyError extends Error {
  readonly name = 'ReentrancyError';
  readonly fix = 'run potsherd card from a shell, not from inside a potsherd model call';
  constructor() {
    super(
      `refusing to call a model from inside one (${REENTRANCY_ENV}=1). ` +
        'potsherd spawned this process; it must not spawn another.',
    );
  }
}

// ---------------------------------------------------------------- detection

export interface Availability {
  /** Path to the `claude` binary, if there is one. */
  claude: string | null;
  /** Path to the `codex` binary, if there is one. */
  codex: string | null;
  /** `ANTHROPIC_API_KEY` is set and non-empty. */
  apiKey: boolean;
  /** The process looks like it is running under codex. */
  codexHarness: boolean;
}

export interface DetectOptions {
  /** Force a backend. `POTSHERD_LLM_BACKEND` does the same from the shell. */
  backend?: Backend;
  model?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam: replaces the PATH lookup. */
  which?: (name: string) => string | null;
}

export interface BackendChoice {
  backend: Backend;
  /** The string handed to the backend, after alias resolution for `api`. */
  model: string;
  /** The alias or id the user asked for. */
  requested: string;
  /** One line for `--json` and for the card: why this backend. */
  why: string;
  /** The binary, when the backend is a spawned one. */
  bin?: string;
  /** False on the subscription paths. */
  chargeable: boolean;
  availability: Availability;
}

/**
 * No backend at all. Names **both** ways out, because a user with neither has
 * no way to guess which one applies to them.
 */
export class NoBackendError extends Error {
  readonly name = 'NoBackendError';
  readonly fix = 'https://claude.com/product/claude-code  — or  export ANTHROPIC_API_KEY=…';
  constructor(readonly availability: Availability) {
    super(
      'no way to reach a model: no `claude` binary on PATH, no `codex`, and ANTHROPIC_API_KEY is not set.\n' +
        '        potsherd cards run on your Claude Code subscription (install Claude Code), ' +
        'or on an Anthropic API key as a fallback.',
    );
  }
}

export function availability(o: DetectOptions = {}): Availability {
  const env = o.env ?? process.env;
  // PATH comes from the *passed* env, not the process's, so a test — and a
  // hook running with a trimmed environment — sees what it configured.
  const which = o.which ?? ((n: string) => onPath(n, env));
  const key = env['ANTHROPIC_API_KEY'];
  return {
    claude: which('claude'),
    codex: which('codex'),
    apiKey: typeof key === 'string' && key.trim().length > 0,
    codexHarness:
      env['POTSHERD_HARNESS'] === 'codex' ||
      Boolean(env['CODEX_HOME']) ||
      Boolean(env['CODEX_SANDBOX']),
  };
}

/**
 * Which backend this machine gets, and why.
 *
 * The order is `04` Q4 read literally:
 *
 *   1. an explicit `--backend` / `POTSHERD_LLM_BACKEND` wins, and is verified
 *   2. a `claude` binary → `agent-sdk`, always, even if a key is also set.
 *      The key is a *fallback*, not a preference, and a Claude Code user must
 *      never be billed for something their subscription covers.
 *   3. codex, when codex is the harness and there is no `claude`
 *   4. `ANTHROPIC_API_KEY` → `api`
 *   5. codex, when it is the only thing installed
 *   6. {@link NoBackendError}
 *
 * The `claude` binary is a *signal*, not the thing that gets run: the agent
 * sdk ships its own harness. What the binary on PATH proves is that this user
 * has Claude Code set up, which is what makes the subscription path viable.
 */
export function detectBackend(o: DetectOptions = {}): BackendChoice {
  const env = o.env ?? process.env;
  const avail = availability(o);
  const requested = o.model ?? env['POTSHERD_MODEL'] ?? CARD_MODEL;
  const forced = (o.backend ?? env['POTSHERD_LLM_BACKEND']) as Backend | undefined;

  const choose = (backend: Backend, why: string, bin?: string): BackendChoice => ({
    backend,
    model: resolveModel(requested, backend),
    requested,
    why,
    ...(bin ? { bin } : {}),
    chargeable: backend === 'api',
    availability: avail,
  });

  if (forced) {
    if (forced === 'agent-sdk') return choose('agent-sdk', 'forced', avail.claude ?? undefined);
    if (forced === 'codex') return choose('codex', 'forced', avail.codex ?? undefined);
    if (forced === 'api') return choose('api', 'forced');
    throw new NoBackendError(avail);
  }

  if (avail.claude) {
    return choose('agent-sdk', `claude on PATH (${avail.claude})`, avail.claude);
  }
  if (avail.codexHarness && avail.codex) {
    return choose('codex', `codex is the harness and there is no claude`, avail.codex);
  }
  if (avail.apiKey) {
    return choose('api', 'no claude binary; ANTHROPIC_API_KEY is set');
  }
  if (avail.codex) {
    return choose('codex', 'codex on PATH; no claude and no api key', avail.codex);
  }
  throw new NoBackendError(avail);
}

// ---------------------------------------------------------------- transport

/** What a backend is handed. Every string here has already been redacted. */
export interface SendRequest {
  prompt: string;
  system?: string;
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface SendResult {
  text: string;
  /** What actually ran, when the backend says. */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** The backend's own cost number, when it has one. */
  usd?: number;
}

/**
 * The seam between "potsherd's rules" and "somebody else's process".
 *
 * Redaction, budgeting, retries and the re-entrancy guard all live *above*
 * this interface, so a test transport sees byte for byte what a real backend
 * would have seen. That is how `tests/llm.test.ts` can assert that a planted
 * credential reaches the backend masked.
 */
export interface Transport {
  readonly backend: Backend;
  send(req: SendRequest): Promise<SendResult>;
  close(): Promise<void>;
}

/** Any backend failure the user can act on: missing binary, auth, timeout. */
export class LlmError extends Error {
  readonly name = 'LlmError';
  constructor(message: string, readonly fix?: string, readonly cause?: unknown) {
    super(message);
  }
}

/**
 * A scratch cwd for a spawned harness.
 *
 * `03` §11: potsherd writes only under `~/.potsherd`. A harness spawned with
 * `cwd` set to the user's project would load that project's `CLAUDE.md` into
 * the call — someone else's instructions, silently, inside a summarisation
 * prompt. An empty temp directory has none, and it is thrown away after.
 */
function makeScratch(tmpRoot?: string): string {
  return fs.mkdtempSync(path.join(tmpRoot ?? os.tmpdir(), 'potsherd-llm-'));
}

function dropScratch(dir: string | null): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a temp directory that outlives us is not worth an error */
  }
}

/** `@anthropic-ai/claude-agent-sdk`, the subscription path. */
class AgentSdkTransport implements Transport {
  readonly backend = 'agent-sdk' as const;
  private scratch: string | null = null;

  constructor(
    private readonly opts: { env: NodeJS.ProcessEnv; tmpRoot?: string; bin?: string },
  ) {}

  async send(req: SendRequest): Promise<SendResult> {
    let query: typeof import('@anthropic-ai/claude-agent-sdk').query;
    try {
      ({ query } = await import('@anthropic-ai/claude-agent-sdk'));
    } catch (err) {
      throw new LlmError(
        'the Claude Agent SDK is not installed, so the subscription path cannot run',
        'npm i @anthropic-ai/claude-agent-sdk   # or set ANTHROPIC_API_KEY',
        err,
      );
    }

    this.scratch ??= makeScratch(this.opts.tmpRoot);
    const abort = new AbortController();
    const onOuter = () => abort.abort();
    req.signal?.addEventListener('abort', onOuter, { once: true });
    const timer = setTimeout(() => abort.abort(), req.timeoutMs);
    let text = '';
    let result: SendResult | null = null;
    const stderr: string[] = [];

    try {
      const stream = query({
        prompt: req.prompt,
        options: {
          model: req.model,
          maxTurns: 1,
          // Nothing to read, nothing to write, nothing to run. A summariser
          // that can call Bash is a summariser that can be prompt-injected by
          // the transcript it is summarising (`03` §11).
          allowedTools: [],
          permissionMode: 'dontAsk',
          cwd: this.scratch,
          // No user, project or local settings, and therefore no CLAUDE.md.
          settingSources: [],
          // obra/episodic-memory#83: without this the SDK writes a fake
          // session into ~/.claude/projects, which potsherd would then index.
          persistSession: false,
          abortController: abort,
          env: { ...this.opts.env, [REENTRANCY_ENV]: '1' },
          ...(req.system ? { systemPrompt: req.system } : {}),
          ...(this.opts.bin ? { pathToClaudeCodeExecutable: this.opts.bin } : {}),
          stderr: (d: string) => {
            if (stderr.length < 40) stderr.push(d);
          },
        },
      });

      for await (const message of stream) {
        if (message.type === 'result') {
          if (message.subtype === 'success') {
            text = message.result;
            const ran = Object.keys(message.modelUsage ?? {})[0];
            result = {
              text,
              ...(ran ? { model: ran } : {}),
              inputTokens: message.usage?.input_tokens ?? 0,
              outputTokens: message.usage?.output_tokens ?? 0,
              usd: message.total_cost_usd ?? 0,
            };
          } else {
            throw new LlmError(
              `the model call ended as ${message.subtype}` +
                (message.errors?.length ? `: ${message.errors[0]}` : ''),
              'potsherd card --dry-run --all   # to see the size of the run first',
            );
          }
        }
      }
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (abort.signal.aborted && !req.signal?.aborted) {
        throw new LlmError(
          `the model call did not answer within ${Math.round(req.timeoutMs / 1000)}s`,
          'POTSHERD_LLM_TIMEOUT_MS=300000 potsherd card …',
          err,
        );
      }
      throw new LlmError(
        `the Claude Agent SDK call failed: ${errMessage(err)}` +
          (stderr.length ? `\n        ${stderr.join('').trim().split('\n').slice(-2).join(' ')}` : ''),
        'claude  # check the subscription is active, then retry',
        err,
      );
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onOuter);
    }

    if (!result) {
      throw new LlmError(
        'the Claude Agent SDK returned no result message',
        'claude --version   # check the installed harness',
      );
    }
    return result;
  }

  async close(): Promise<void> {
    dropScratch(this.scratch);
    this.scratch = null;
  }
}

/**
 * `codex exec`, for a machine whose harness is codex.
 *
 * **Unverified on the reference machine** — codex is not installed there, so
 * what is tested is the plumbing (argv, stdin, stdout, exit code, timeout)
 * against a stub binary, not the real CLI's flags. `POTSHERD_CODEX_ARGS` is
 * the escape hatch if a codex release moves them.
 */
class CodexTransport implements Transport {
  readonly backend = 'codex' as const;
  private scratch: string | null = null;

  constructor(
    private readonly opts: { env: NodeJS.ProcessEnv; bin: string; tmpRoot?: string },
  ) {}

  async send(req: SendRequest): Promise<SendResult> {
    this.scratch ??= makeScratch(this.opts.tmpRoot);
    const extra = (this.opts.env['POTSHERD_CODEX_ARGS'] ?? '').split(' ').filter(Boolean);
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--cd',
      this.scratch,
      '--model',
      req.model,
      ...extra,
      '-',
    ];

    const out = await run(this.opts.bin, args, {
      input: req.system ? `${req.system}\n\n${req.prompt}` : req.prompt,
      env: { ...this.opts.env, [REENTRANCY_ENV]: '1' },
      timeoutMs: req.timeoutMs,
      ...(req.signal ? { signal: req.signal } : {}),
    });

    const text = lastAgentMessage(out.stdout);
    if (!text) {
      throw new LlmError(
        `codex exec produced no answer${out.stderr ? `: ${out.stderr.trim().split('\n').slice(-1)[0]}` : ''}`,
        'codex exec "hello"   # check codex runs at all',
      );
    }
    return { text, model: req.model };
  }

  async close(): Promise<void> {
    dropScratch(this.scratch);
    this.scratch = null;
  }
}

/**
 * `codex exec` prints progress lines around the answer, and `--json` prints
 * one event per line. Take the last agent message if the output is jsonl, and
 * the whole thing otherwise.
 */
export function lastAgentMessage(stdout: string): string {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  const events: string[] = [];
  let allJson = lines.length > 0;
  for (const line of lines) {
    if (!line.trimStart().startsWith('{')) {
      allJson = false;
      break;
    }
    try {
      const ev = JSON.parse(line) as Record<string, unknown>;
      const text = pickText(ev);
      if (text) events.push(text);
    } catch {
      allJson = false;
      break;
    }
  }
  if (allJson && events.length > 0) return events[events.length - 1]!.trim();
  return stdout.trim();
}

function pickText(ev: Record<string, unknown>): string | null {
  for (const key of ['text', 'message', 'last_agent_message']) {
    const v = ev[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  for (const key of ['msg', 'item', 'payload']) {
    const v = ev[key];
    if (v && typeof v === 'object') {
      const inner = pickText(v as Record<string, unknown>);
      if (inner) return inner;
    }
  }
  return null;
}

/** `@anthropic-ai/sdk`. The fallback only — never while a `claude` exists. */
class ApiTransport implements Transport {
  readonly backend = 'api' as const;

  constructor(private readonly opts: { env: NodeJS.ProcessEnv }) {}

  async send(req: SendRequest): Promise<SendResult> {
    let Anthropic: typeof import('@anthropic-ai/sdk').default;
    try {
      ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
    } catch (err) {
      throw new LlmError(
        'the Anthropic SDK is not installed, so the api fallback cannot run',
        'npm i @anthropic-ai/sdk',
        err,
      );
    }

    const apiKey = this.opts.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      throw new LlmError('ANTHROPIC_API_KEY is not set', 'export ANTHROPIC_API_KEY=…');
    }

    const client = new Anthropic({ apiKey, timeout: req.timeoutMs, maxRetries: 1 });
    const params = {
      model: req.model,
      max_tokens: req.maxOutputTokens,
      ...(req.system ? { system: req.system } : {}),
      messages: [{ role: 'user' as const, content: req.prompt }],
    };

    try {
      // Streaming for long inputs (`phase-2` T2.1): a big transcript with a
      // generous max_tokens is exactly the shape that hits an HTTP timeout on
      // the non-streaming path.
      const long = req.prompt.length > 40_000 || req.maxOutputTokens > 8_192;
      const message = long
        ? await client.messages
            .stream(params, req.signal ? { signal: req.signal } : {})
            .finalMessage()
        : await client.messages.create(params, req.signal ? { signal: req.signal } : {});

      const text = message.content
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('');
      const price = PRICES[modelClass(message.model ?? req.model)];
      const inputTokens = message.usage.input_tokens;
      const outputTokens = message.usage.output_tokens;
      return {
        text,
        model: message.model,
        inputTokens,
        outputTokens,
        usd:
          (inputTokens / 1e6) * price.inputPerMTok + (outputTokens / 1e6) * price.outputPerMTok,
      };
    } catch (err) {
      throw new LlmError(
        `the Anthropic API call failed: ${errMessage(err)}`,
        'check ANTHROPIC_API_KEY and the network, then retry',
        err,
      );
    }
  }

  async close(): Promise<void> {
    /* nothing to clean up */
  }
}

interface RunOptions {
  input?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Spawn, feed stdin, collect stdout/stderr, and never hang. */
function run(
  bin: string,
  args: string[],
  o: RunOptions,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: o.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(
        new LlmError(
          `${path.basename(bin)} did not answer within ${Math.round(o.timeoutMs / 1000)}s`,
          'POTSHERD_LLM_TIMEOUT_MS=300000 potsherd card …',
        ),
      );
    }, o.timeoutMs);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(new LlmError('the model call was cancelled'));
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new LlmError(`could not run ${bin}: ${errMessage(err)}`, `which ${path.basename(bin)}`, err));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      if (code !== 0) {
        reject(
          new LlmError(
            `${path.basename(bin)} exited ${code}${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-1)[0]}` : ''}`,
            `${path.basename(bin)} --version`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, code: code ?? 0 });
    });

    if (o.input !== undefined) child.stdin.end(o.input);
    else child.stdin.end();
  });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --------------------------------------------------------------------- llm

export interface LlmOptions extends DetectOptions {
  maxUsd?: number;
  maxTokens?: number;
  /** Per call. Default 120s, or `POTSHERD_LLM_TIMEOUT_MS`. */
  timeoutMs?: number;
  maxOutputTokens?: number;
  /** Test seam: use this instead of detecting and building a real backend. */
  transport?: Transport;
  /** Where the scratch cwd goes. Default the system temp dir. */
  tmpRoot?: string;
  budget?: Budget;
}

export interface LlmRequest {
  /** Raw text. It is redacted here; the caller must not pre-redact it. */
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Names this call in a budget abort message. */
  label?: string;
}

export interface LlmResult {
  text: string;
  backend: Backend;
  model: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  ms: number;
  /** How many secrets were masked on the way out. */
  redactions: number;
  /** False on the subscription paths: `usd` is an api-equivalent. */
  chargeable: boolean;
}

export interface JsonRequest<T> extends LlmRequest {
  /**
   * The shape, in words, appended to the prompt. Keep it short: it is repeated
   * on the retry, and the retry is the one that has to work.
   */
  schema: string;
  /**
   * What to return when both attempts fail to parse. `03` §6's rule: a minimal
   * card is worth more than a dropped run.
   */
  fallback: T;
  /** Validate and narrow. Return `null` to reject and trigger the retry. */
  validate?: (value: unknown) => T | null;
}

export interface JsonResult<T> extends LlmResult {
  value: T;
  /** 1 or 2. */
  attempts: number;
  /** False when both attempts failed and `fallback` was used. */
  parsed: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;

/**
 * The instruction that makes a JSON answer a JSON answer.
 *
 * `03` §6 wants a strict schema out of a chat model. The reliable shape is a
 * hard framing instruction plus one retry that quotes the parse error back;
 * anything more elaborate is a schema validator, which is
 * {@link JsonRequest.validate}'s job.
 */
const JSON_RULE =
  'Reply with one JSON object and nothing else. No prose before it, no prose after it, ' +
  'no markdown fence, no explanation. If a field has no value, use null or an empty array.';

/**
 * One model call, with potsherd's rules around it.
 *
 * ```ts
 * const llm = Llm.open({ model: 'haiku', maxUsd: 2 });
 * try {
 *   const card = await llm.json({ prompt, schema, fallback: { title: '', summary: '' } });
 * } finally {
 *   await llm.close();
 * }
 * ```
 */
export class Llm {
  readonly backend: Backend;
  readonly model: string;
  readonly chargeable: boolean;
  readonly choice: BackendChoice | null;
  readonly budget: Budget;

  private constructor(
    private readonly transport: Transport,
    choice: BackendChoice | null,
    private readonly opts: LlmOptions,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    this.choice = choice;
    this.backend = transport.backend;
    this.model = choice?.model ?? opts.model ?? CARD_MODEL;
    this.chargeable = choice?.chargeable ?? transport.backend === 'api';
    this.budget =
      opts.budget ??
      new Budget({
        ...(opts.maxUsd !== undefined ? { maxUsd: opts.maxUsd } : {}),
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      });
  }

  /**
   * Pick a backend and build it. Throws {@link NoBackendError} when there is
   * none and {@link ReentrancyError} when potsherd spawned this process.
   */
  static open(opts: LlmOptions = {}): Llm {
    const env = opts.env ?? process.env;
    if (insidePotsherdCall(env) && !opts.transport) throw new ReentrancyError();

    if (opts.transport) {
      return new Llm(opts.transport, null, opts, env);
    }

    const choice = detectBackend(opts);
    const transport: Transport =
      choice.backend === 'agent-sdk'
        ? new AgentSdkTransport({
            env,
            ...(opts.tmpRoot ? { tmpRoot: opts.tmpRoot } : {}),
            ...(env['POTSHERD_CLAUDE_BIN'] ? { bin: env['POTSHERD_CLAUDE_BIN'] } : {}),
          })
        : choice.backend === 'codex'
          ? new CodexTransport({
              env,
              bin: choice.bin ?? 'codex',
              ...(opts.tmpRoot ? { tmpRoot: opts.tmpRoot } : {}),
            })
          : new ApiTransport({ env });
    return new Llm(transport, choice, opts, env);
  }

  get spend(): Spend {
    return this.budget.spend;
  }

  /** Per-call deadline. A model call must never be able to hang a verb. */
  private timeoutFor(req: LlmRequest): number {
    if (req.timeoutMs !== undefined) return req.timeoutMs;
    if (this.opts.timeoutMs !== undefined) return this.opts.timeoutMs;
    const fromEnv = Number(this.env['POTSHERD_LLM_TIMEOUT_MS']);
    return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_TIMEOUT_MS;
  }

  /**
   * One call. **Redacts `prompt` and `system` itself** — a caller cannot reach
   * a backend with raw text, and there is no flag that lets it.
   */
  async text(req: LlmRequest): Promise<LlmResult> {
    const prompt = redactOutgoing(req.prompt);
    const system = req.system ? redactOutgoing(req.system) : null;
    const redactions = prompt.hits + (system?.hits ?? 0);

    // The marker goes on *after* redaction so it survives byte-exact: it is
    // what stops potsherd indexing the session this call may create.
    const outgoing = `${POTSHERD_CARD_MARKER}\n\n${prompt.text}`;

    const maxOutputTokens =
      req.maxOutputTokens ?? this.opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const inTokens = tokensForText(outgoing) + (system ? tokensForText(system.text) : 0);
    const price = PRICES[modelClass(this.model)];
    this.budget.admit({
      usd:
        (inTokens / 1e6) * price.inputPerMTok +
        (maxOutputTokens / 1e6) * price.outputPerMTok,
      tokens: inTokens + maxOutputTokens,
    });

    const started = Date.now();
    const sent = await this.transport.send({
      prompt: outgoing,
      ...(system ? { system: system.text } : {}),
      model: this.model,
      maxOutputTokens,
      timeoutMs: this.timeoutFor(req),
      ...(req.signal ? { signal: req.signal } : {}),
    });
    const ms = Date.now() - started;

    const outputTokens = sent.outputTokens ?? tokensForText(sent.text);
    const inputTokens = sent.inputTokens ?? inTokens;
    const usd =
      sent.usd ??
      (inputTokens / 1e6) * price.inputPerMTok + (outputTokens / 1e6) * price.outputPerMTok;

    const result: LlmResult = {
      text: sent.text,
      backend: this.backend,
      model: sent.model ?? this.model,
      inputTokens,
      outputTokens,
      usd,
      ms,
      redactions,
      chargeable: this.chargeable,
    };
    this.budget.record(result);
    return result;
  }

  /**
   * A JSON answer, enforced by instruction, retried **once** on a parse
   * failure, and falling back to {@link JsonRequest.fallback} rather than
   * throwing away the run (`phase-2` risks: "json drift").
   */
  async json<T>(req: JsonRequest<T>): Promise<JsonResult<T>> {
    const base = `${req.prompt}\n\n${JSON_RULE}\n\nShape:\n${req.schema}`;
    let last: LlmResult | null = null;
    let firstError = '';

    for (let attempt = 1; attempt <= 2; attempt++) {
      const prompt =
        attempt === 1
          ? base
          : `${base}\n\nYour previous reply could not be parsed as JSON (${firstError}). ` +
            'Reply again with only the JSON object.';
      const { prompt: _p, ...rest } = req;
      void _p;
      const r = await this.text({ ...rest, prompt });
      last = r;
      const parsed = parseJsonish(r.text);
      if (parsed.ok) {
        const value = req.validate ? req.validate(parsed.value) : (parsed.value as T);
        if (value !== null && value !== undefined) {
          return { ...r, value, attempts: attempt, parsed: true };
        }
        firstError = 'the object did not match the shape';
      } else {
        firstError = parsed.error;
      }
    }

    return {
      ...(last as LlmResult),
      value: req.fallback,
      attempts: 2,
      parsed: false,
    };
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}

/**
 * Every outgoing string, masked.
 *
 * `elideBinary` first (a base64 image in a tool result is bulk, not meaning,
 * and it is what produced 165,085 false masks at ingest), then `redact`.
 * Identical to the ingest path, deliberately: what a model sees and what the
 * index holds are the same text.
 */
export function redactOutgoing(text: string): { text: string; hits: number } {
  const out = redact(elideBinary(text));
  return { text: out.text, hits: out.hits.length };
}

/** Lenient enough for a fenced answer, strict enough to reject prose. */
export function parseJsonish(
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  let s = raw.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/m.exec(s);
  if (fence?.[1]) s = fence[1].trim();
  if (!s.startsWith('{') && !s.startsWith('[')) {
    const start = s.search(/[{[]/);
    const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
    if (start >= 0 && end > start) s = s.slice(start, end + 1);
  }
  if (!s) return { ok: false, error: 'empty reply' };
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
}

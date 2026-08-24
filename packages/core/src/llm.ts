import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
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
 * One ordering, {@link RESOLUTION_LADDER}, tried silently top to bottom:
 *
 * | rung | id | what it is | cost |
 * |---|---|---|---|
 * | 1 | `host-seam`  | the coding agent potsherd is running inside; no transport at all | zero |
 * | 2 | `claude-cli` | `claude -p`, the binary already on PATH | zero marginal |
 * | 2 | `codex-cli`  | `codex exec`, preferred inside codex | zero marginal |
 * | 3 | `agent-sdk`  | `@anthropic-ai/claude-agent-sdk`, **if it happens to be there** | zero marginal |
 * | 3 | `api-key`    | `@anthropic-ai/sdk` + `ANTHROPIC_API_KEY` | metered |
 *
 * The API path is a **fallback only** (`04` Q4): a subscription user must
 * never be billed for what their subscription covers. The SDK and raw HTTP
 * are never mixed: the api path is `@anthropic-ai/sdk` and nothing else.
 *
 * Nothing on this ladder is ever asked of the user, and rung 4 — the one line
 * naming an install — is the only sentence in the product allowed to suggest
 * one.
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

/**
 * The verbs that may make a model call, and the ones that never can.
 *
 * `doctor --privacy` prints these, and `03` §11 is the reason: the privacy
 * receipt has to disclose the largest privacy-relevant thing the product does,
 * and from phase 2 on that is no longer "reads your files" — it is "sends
 * redacted slices of them to a model". A hand-written list would drift the
 * first time a verb learned to call one, so the list lives here, beside the
 * single entry point every call goes through, and `tests/llm.test.ts` asserts
 * that no command outside {@link MODEL_CALL_VERBS} reaches `Llm.open`.
 */
// `ask` and `graft` joined `card` here at phase 4 integration. The list is
// asserted by `tests/llm.test.ts` against the CLI command files that actually
// reach `Llm.open` — the guard that exists precisely so a verb cannot start
// calling a model without the privacy receipt saying so.
export const MODEL_CALL_VERBS: readonly string[] = ['card', 'ask', 'graft'];

/**
 * Verbs that are guaranteed to make no model call **and open no socket**.
 *
 * Named explicitly rather than left as "everything else", because "which of
 * these is safe to run on a client's laptop" is the question the receipt is
 * read to answer, and an answer by omission is not one.
 *
 * `unpin` was answered by omission for two phases: registered in the CLI and
 * missing from both lists, so the receipt said nothing either way about it —
 * the exact failure the paragraph above says the list exists to prevent.
 * `tests/llm.test.ts` now asserts that these lists together cover every
 * command the CLI registers, which is the only form of this list that keeps
 * its own promise.
 *
 * **T6.6 D2/D12 — `find` and `export` were on this list and should not have
 * been.** The receipt printed "and open no socket at all" over both of them
 * while `bridges/claude-mem.ts` was doing `fetch('http://127.0.0.1:<port>/…')`
 * to probe claude-mem's worker, and `bridges/agentmemory.ts` was spawning
 * `@agentmemory/mcp` and speaking JSON-RPC to it — a program its own header
 * comment records as "a thin shim over an HTTP backend at AGENTMEMORY_URL
 * (default http://localhost:3111)". The `export` entry below even *said* so,
 * in a code comment, three lines under the constant the user is shown:
 * "it opens no socket except the localhost probes the bridges use". A
 * qualification a reader never sees is not a qualification.
 *
 * That is the third false claim this receipt has published (`08` rule 1: "no
 * network", then the `index --quiet` announcement, now this), and all three
 * failed the same way — the CI guard proves *screen == live output*, never
 * *live output == truth*. So the two federating verbs moved to
 * {@link LOCAL_SOCKET_VERBS}, and the sentence above each list is now one a
 * reader can hold the product to.
 */
/**
 * Verbs that call no model and still reach the network, because a capability
 * they need is acquired rather than asked for.
 *
 * The product law for phase 10 is that a user never configures capability: if
 * something is heavy it is fetched lazily on first use. That is a better
 * default and it is *also* a network fact, and a privacy receipt that lists
 * the verb under "opens no socket at all" because it used to be true is the
 * same failure as the three before it. The download itself is already
 * described further down the screen, pinned to a size and a sha256; this list
 * is what stops the two paragraphs contradicting each other.
 */
export const RUNTIME_FETCH_VERBS: readonly string[] = ['index'];

export const OFFLINE_VERBS: readonly string[] = [
  'audit',
  'rescue',
  'guard',
  // `index` WAS here, and phase 10 took it out. A2 made semantic search
  // automatic: the first index fetches the embedding runtime from
  // huggingface.co in the background, without being asked. The verb still
  // calls no model -- that is a different property -- but it can no longer
  // sit under the words "open no socket at all", which is the FOURTH false
  // claim this receipt has published and the second one caused by a verb
  // quietly acquiring a capability. See RUNTIME_FETCH_VERBS below.
  'ls',
  'show',
  'stats',
  'tag',
  // T10.8 — `note` writes, and writes only into `~/.potsherd/potsherd.db`. It
  // is on this list for the reason `unpin` and `setup` are: a verb missing
  // from every list is a verb `doctor --privacy` has not accounted for, and
  // the one verb that writes is the last one that should go unaccounted for.
  'note',
  'pin',
  'unpin',
  'link',
  // `setup` writes MCP stanzas into other tools' config files, which is a
  // consent-gated *local* write and not a model call. It belongs on this list
  // for the same reason `unpin` does: `doctor --privacy` answers by omission
  // otherwise, and an answer by omission is not one.
  'setup',
  // `stack` only detects which memory tools are installed: it stats directories
  // and reads two of its own files. No model, no socket.
  'stack',
  // `ignore` / `unignore` read and write one file, `~/.potsherd/config.json`,
  // and nothing else. They are on this list for the reason `unpin` and `setup`
  // are: `doctor --privacy` answers by omission otherwise, and a verb missing
  // from every list on that receipt is a verb the receipt has not accounted
  // for. The file they write is named in the `writes:` block above.
  'ignore',
  'unignore',
  'doctor',
];

/**
 * Verbs that call **no model**, but do open a socket — to this machine only,
 * and only to a memory tool you already have installed.
 *
 * Both federate through `@potsherd/bridges`, and both do it only when asked:
 *
 *   - `find --with <tool>` reads the other tool's store. For claude-mem that
 *     means `fetch('http://127.0.0.1:<port>/api/search/observations…')` against
 *     its worker (`bridges/claude-mem.ts`); for agentmemory it means spawning
 *     the `@agentmemory/mcp` server and speaking JSON-RPC over its stdio, and
 *     that server is itself a shim over an HTTP backend on `localhost:3111`.
 *   - `export --to <tool>` writes into that same store, and reaches it the
 *     same way.
 *
 * Without the flag neither opens anything: a bare `potsherd find` is a query
 * against potsherd's own SQLite file and nothing else. The receipt says so
 * rather than leaving the reader to infer it, because "find is safe on a
 * client's laptop" and "find is safe on a client's laptop as long as you do
 * not pass --with" are different answers to the question it is read to answer.
 *
 * Nothing here leaves the machine. That is a smaller claim than "no socket"
 * and it is the true one.
 */
export const LOCAL_SOCKET_VERBS: readonly string[] = ['find', 'export'];

// ------------------------------------------------------------------ models

/**
 * Every transport potsherd knows how to build.
 *
 * `claude-cli` is the one that makes the other three optional. See
 * {@link RESOLUTION_LADDER}.
 */
export type Backend = 'agent-sdk' | 'claude-cli' | 'codex' | 'api';

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
 * ## What a model call actually costs, measured
 *
 * The previous version of this block said `seconds = calls × 5.4 s`. That
 * 5.4 s came from a **10-token probe prompt**, and the card pipeline sends
 * 40,000-character chunks. Extrapolating one to the other told a user
 * "estimated time 7m 26s" immediately before a run that took **55m 25s** and
 * reported **$12.93**. `03` §12 and `04`'s log record it; this table is the
 * fix, and it exists so nobody has to guess again.
 *
 * ### The calls it is fitted to
 *
 * `pnpm tsx scripts/measure-llm-calls.ts serial` and `… fanout`, 21 aug 2026,
 * apple silicon, Claude Code 2.1.238, agent sdk on the subscription,
 * `haiku` → `claude-haiku-4-5-20251001`, the real card system prompt and the
 * real JSON rule, `maxOutputTokens: 2048`:
 *
 * | # | mode | prompt chars | wall | sdk `total_cost_usd` | output tokens |
 * |---|---|---:|---:|---:|---:|
 * | 1 | serial      |  3,097 |  45.4 s | $0.0232 | 2,391 |
 * | 2 | serial      | 10,658 |  60.9 s | $0.0243 | 1,120 |
 * | 3 | serial      | 12,999 |  62.2 s | $0.0279 | 1,429 |
 * | 4 | serial      | 21,136 |  58.9 s | $0.0380 | 1,827 |
 * | 5 | serial      | 40,933 |  94.9 s | $0.0721 | 4,852 |
 * | 6 | serial      | 41,408 |  74.1 s | $0.0583 | 1,272 |
 * | 7–12 | 6 at once | ~41,700 | 191–204 s | $0.0545–$0.0656 | 1,301–3,436 |
 *
 * Least squares over the six serial calls: **`ms ≈ 46,200 + 915 per 1k chars`**.
 * Least squares over all twelve for money: **`usd ≈ $0.0160 + $1.057 per 1M chars`**.
 * Mean output was **2,107 tokens per call** — five times the ~390 the old
 * `OUTPUT_CHARS_PER_CALL` arithmetic implied, because a haiku-class model
 * through the harness bills its reasoning as output.
 *
 * ### Three things the old model got structurally wrong
 *
 *   1. **A flat per-call constant.** A call is ~46 s of fixed latency *plus*
 *      ~0.9 ms per character. At 40k chars that is 83 s, not 5.4.
 *   2. **Concurrency is not free.** `wall = serial ÷ concurrency` assumes
 *      perfect parallelism. Six 40k calls launched together took 191–204 s
 *      each where one alone takes ~84 s. Against the one full run we have —
 *      209 calls, 55m 25s at concurrency 6 — the realised speed-up was
 *      **4.9× of a requested 6**, so {@link CallProfile.parallelEfficiency}
 *      is 0.8 and the *upper* bound of the range assumes much worse.
 *   3. **Token arithmetic does not price the agent sdk.** Our chars ÷ 3.6
 *      prices those 209 calls at $4.25; the SDK reported $12.93. Cache writes,
 *      the harness's own system prompt and reasoning output are all invisible
 *      to a character count. So on the agent-sdk path the money comes from the
 *      **measured fit above**, not from {@link PRICES}; on the api path — where
 *      the user is really billed and there is no harness — it still comes from
 *      {@link PRICES}, because that is what the invoice will say.
 *
 * Re-fit with `scripts/measure-llm-calls.ts` when the harness, the model or
 * the machine changes, and paste the new table here.
 */
export interface CallProfile {
  /** Fixed milliseconds per call, whatever the prompt size. */
  baseMs: number;
  /** Milliseconds per 1,000 input characters. */
  msPerKChar: number;
  /**
   * Fixed api-equivalent dollars per call: the harness's own system prompt.
   * Zero on the api path, where there is no harness to pay for.
   */
  baseUsd: number;
  /**
   * Api-equivalent dollars per million input characters, measured end to end
   * from the SDK's `total_cost_usd`. `null` means "price this path from
   * {@link PRICES} and the token counts" — the api path, where the token
   * arithmetic *is* the bill.
   */
  usdPerMChar: number | null;
  /**
   * Measured mean output tokens per call, reasoning included. `null` falls
   * back to {@link OUTPUT_CHARS_PER_CALL} ÷ {@link CHARS_PER_TOKEN}.
   */
  outputTokensPerCall: number | null;
  /** Realised fraction of each extra concurrent slot. 1 would be perfect. */
  parallelEfficiency: number;
  /** Multipliers on the point estimate that bound the honest range. */
  spread: { timeLow: number; timeHigh: number; usdLow: number; usdHigh: number };
  /** False when the numbers are an assumption rather than a measurement. */
  measured: boolean;
  /** One line for the card, so the screen can say what it is fitted to. */
  basis: string;
}

export const CALL_PROFILES: Record<Backend, CallProfile> = {
  'agent-sdk': {
    baseMs: 46_200,
    msPerKChar: 915,
    baseUsd: 0.016,
    usdPerMChar: 1.057,
    outputTokensPerCall: 2_100,
    parallelEfficiency: 0.8,
    spread: { timeLow: 0.8, timeHigh: 2.0, usdLow: 0.8, usdHigh: 1.4 },
    measured: true,
    basis: '12 real calls, 3k–42k chars',
  },
  // Never measured on the reference machine: there is no key there and `04`
  // Q4 made this the fallback. The shape is the agent-sdk fit with the
  // harness taken out — no spawn, no reasoning-heavy harness loop — and the
  // range is deliberately three times as wide, because a wide range that
  // contains the truth beats a narrow one that does not.
  api: {
    baseMs: 8_000,
    msPerKChar: 250,
    baseUsd: 0,
    usdPerMChar: null,
    outputTokensPerCall: null,
    parallelEfficiency: 0.9,
    spread: { timeLow: 0.4, timeHigh: 3.0, usdLow: 0.7, usdHigh: 1.6 },
    measured: false,
    basis: 'not measured — api list price and an assumed latency',
  },
  // The same binary the agent sdk drives, spawned directly, so it inherits
  // that fit. **Not measured at card size** — the only real numbers on the
  // reference machine are two probe calls (13.0 s and 8.7 s wall for a
  // 30-character prompt), which say nothing about a 40,000-character one. The
  // range is widened accordingly rather than the point estimate moved.
  'claude-cli': {
    baseMs: 46_200,
    msPerKChar: 915,
    baseUsd: 0.016,
    usdPerMChar: 1.057,
    outputTokensPerCall: 2_100,
    parallelEfficiency: 0.8,
    spread: { timeLow: 0.4, timeHigh: 3.0, usdLow: 0.7, usdHigh: 1.6 },
    measured: false,
    basis: 'est. — the agent-sdk fit for the same binary, spawned directly',
  },
  // Likewise unverified: codex is not installed on the reference machine
  // (`CodexTransport`'s note says the same). It spawns a CLI like the agent
  // sdk does, so it inherits those timings and is priced from tokens.
  codex: {
    baseMs: 46_200,
    msPerKChar: 915,
    baseUsd: 0,
    usdPerMChar: null,
    outputTokensPerCall: null,
    parallelEfficiency: 0.8,
    spread: { timeLow: 0.4, timeHigh: 3.0, usdLow: 0.7, usdHigh: 1.6 },
    measured: false,
    basis: 'est. — argv verified at codex 0.149.0, timings assumed from the agent sdk',
  },
};

/** The profile a run is quoted against. Unknown backends quote the default. */
export function callProfile(backend?: Backend): CallProfile {
  return CALL_PROFILES[backend ?? 'agent-sdk'] ?? CALL_PROFILES['agent-sdk'];
}

/**
 * What the agent sdk's own system prompt costs per call, in api-equivalent
 * dollars: the intercept of the cost fit above, **$0.016**.
 *
 * The old value, $0.0027, was read off the same 10-token probe that produced
 * the 5.4 s and was as wrong for the same reason. Unlike the old value this
 * one *is* used: {@link estimate} adds it on the agent-sdk path, because the
 * `$12.93` a user sees at the end of a run is the SDK's own number and it
 * includes the harness. The api-path quote still excludes it — an api-path
 * user does not pay for a harness they do not run.
 */
export const HARNESS_OVERHEAD_USD = CALL_PROFILES['agent-sdk'].baseUsd;

/**
 * ## The money the ideal call count never sees — T10.11
 *
 * `08` §2 row 6 records the card estimator as *"~2× optimistic, one
 * directionally"*, and `08` §6 item 20 records why that direction is the
 * dangerous one: `--max-usd` is a **pre-call** ceiling, so a quote that is too
 * low lets a run start that should not have, and no gate downstream can catch
 * it. This constant is the fix, and the paragraphs below are the whole of the
 * evidence for it, because a number chosen without one is what produced the
 * defect.
 *
 * ### What the recorded runs actually say
 *
 * `card_runs` on the reference machine holds **two** runs — 22 and 23 aug
 * 2026, `agent-sdk`, haiku, concurrency 6, **47 real calls between them**.
 * (The phase plan's "~50 recorded real calls" is those 47; it is two runs, not
 * fifty, and **both were stopped before they finished**, so by this module's
 * own rule 1 neither has ever corrected anything.) Normalised per call —
 * which is the only fair comparison when one run was truncated — they agree:
 *
 * | run | quoted $/call | actual $/call | money | quoted s/call | actual s/call | time |
 * |---|---:|---:|---:|---:|---:|---:|
 * | 22 aug, 4 targets, 11 of 18 calls | $0.0516 | $0.0875 | **1.70× under** | 15.40 s | 22.94 s | 1.49× under |
 * | 23 aug, 8 targets, 36 of 35 calls | $0.0502 | $0.0818 | **1.63× under** | 15.15 s | 16.89 s | 1.11× under |
 *
 * Two things follow, and only these two:
 *
 *   1. **The miss is on money, not on the clock.** The 23 aug run — the only
 *      one whose call count was not truncated away — came in at **1.15× of
 *      its quoted wall time** and **1.68× of its quoted money**. That is not
 *      one error seen twice: extra calls join the concurrency gate and overlap
 *      with the fan-out already in flight, so they cost wall time at the
 *      marginal rate and money at the full rate. {@link CALL_PROFILES}'s
 *      latency fit is therefore **left exactly as it was**.
 *   2. **The money miss is one-directional and about the same size twice.**
 *      1.70 and 1.63, from different scopes on different days.
 *
 * ### Why the correction is not on the per-call price
 *
 * The per-call price has an independent check that the run-level ratios do
 * not: given the **true** call count and the true mean prompt size, the fit
 * reproduces the 21 aug 209-call run at $11.18 against a real $12.93 — 1.16×
 * under, not 1.7× (`tests/llm.test.ts`, "reproduces the one real run it is
 * fitted to"). So the twelve-call price fit is close, and moving it would
 * throw away a direct measurement in order to absorb a residual that belongs
 * somewhere else.
 *
 * Where it belongs is the **call arithmetic**. {@link estimate} derives calls
 * as `chunks === 1 ? 1 : chunks + 1` — the *ideal* pipeline. The real one, in
 * `cards/pipeline.ts` and `cards/extract.ts`, also pays for a **supplement
 * pass** (at most one extra call per card, re-sending the units coverage says
 * the first pass missed) and for **retries** (`into.calls += r.attempts`), and
 * prices neither. Every one of those can only add calls and characters, never
 * remove them, which is exactly the shape of a one-directional under-quote.
 *
 * ### The stopping rule
 *
 * `pipeline.ts` allows **at most one** supplement per card. So the work the
 * ideal arithmetic omits is bounded below by nothing (no card supplemented)
 * and above by a second full call on every card — the interval **[1×, 2×]**,
 * fixed by the pipeline's own code rather than by any sample. **1.5 is the
 * midpoint of that interval**, and that is the entire derivation: it is not
 * the value that minimises residual on the two runs (that is 1.66) and it was
 * chosen before they were consulted. They were then used only to *check* it,
 * which is the direction of inference this project requires — the same reason
 * `03` records `1.5` as a stopping rule rather than an argmax.
 *
 * ### What the check says
 *
 * With the factor applied, the two recorded runs land at **1.13×** and
 * **1.09×** of quote. The quote **still errs low**, by about a tenth, and that
 * is deliberate: what a ceiling must be safe against is the top of the range,
 * not the point. Before this constant, {@link CallProfile.spread}'s
 * `usdHigh` of 1.4 did **not** contain either run (1.70 and 1.63 are outside
 * it) — the honest range itself under-quoted. After it, both are inside, with
 * margin, for the first time.
 *
 * ### Where it is *not* applied
 *
 * Only to calls this function **derived**. A caller that passes
 * {@link EstimateSession.calls} is stating what the pipeline really did rather
 * than asking for a guess, and the estimator must not second-guess a fact.
 * That is what keeps the 209-call check above honest.
 */
export const PIPELINE_COST_FACTOR = 1.5;

/**
 * The identity of the fit compiled into this build.
 *
 * A `card_runs` row records what *that* run was quoted and what it did. Once
 * the constants above move, an older row is a measurement of a **different
 * estimator**, and letting `calibration.ts` average it into a correction on
 * top of the new one double-counts the very error the new one already fixes:
 * the two runs that justify {@link PIPELINE_COST_FACTOR} would, left
 * unfiltered, immediately multiply the corrected quote by 1.66 again.
 *
 * So the fit carries a date, `readCalibration` ignores rows older than it, and
 * this line moves — deliberately, in the same commit — every time a constant
 * in this section does. It is the one bookkeeping entry that makes a
 * self-correcting estimator safe to re-fit at all.
 *
 * The value is the T10.11 re-fit, placed immediately **after** the last row it
 * was derived from (23 aug 2026, 11:30 UTC) rather than at the wall-clock
 * moment of the edit. The boundary's whole job is to exclude the evidence, and
 * a boundary in the future would also exclude the next run a user makes.
 */
export const ESTIMATOR_FIT = '2026-08-23T12:00:00.000Z';

/**
 * What the quote says on rung 1, where there is no call to price.
 *
 * `$0.00` would be arithmetically true and would still mislead: it reads as
 * "this is free", when what is actually true is "potsherd is not the one
 * spending". The prompts still have to be answered, out of the host agent's
 * context and on the user's own subscription, and the quantity that decides
 * whether that is a good idea is the token count sitting two rows above it on
 * the same card — not a dollar figure at all. So the money row says this
 * instead of a number.
 */
export const HOST_SEAM_BASIS =
  'the host agent answers — potsherd makes no model call, so the unit is tokens, not dollars';

/**
 * Effective concurrency for `n` requested slots.
 *
 * The first call is free of contention; every slot after it delivers
 * {@link CallProfile.parallelEfficiency} of a full one. At the measured 0.8,
 * asking for 6 gets 5.0 — which is what the one recorded 209-call run did
 * (4.9), and nothing like the 6.0 the old estimator assumed.
 */
export function effectiveConcurrency(n: number, profile: CallProfile): number {
  const c = Math.max(1, Math.floor(n));
  return 1 + (c - 1) * profile.parallelEfficiency;
}

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
  /**
   * What this machine's own finished runs say the quote is out by
   * (`calibration.ts`). Applied last, so the correction is visible as a
   * multiplier rather than baked into the constants.
   */
  calibration?: Calibration;
  /**
   * Rung 1 of {@link RESOLUTION_LADDER}: the host agent is the model.
   *
   * potsherd makes **no model call** on this path — it emits prompts through
   * `--synthesis-out` / `--filter-in` and the agent already holding the
   * conversation answers them on its own subscription. There is nothing to
   * charge and no wall time potsherd owns, so the dollars and the seconds are
   * zero and the honest unit is what is left: how many prompts, and how many
   * tokens of the host's context they will take.
   *
   * It is a flag rather than a {@link Backend} because rung 1's `backend` is
   * `null` by construction: there is no transport here to name.
   */
  hostSeam?: boolean;
}

/**
 * The correction a machine learns from its own runs.
 *
 * `ratio > 1` means the last runs took longer / cost more than quoted.
 * `samples` is how many finished runs it is averaged over, and it is carried
 * onto the screen: "corrected ×1.2 from 3 runs here" is a number a user can
 * argue with, and a silently-corrected one is not.
 */
export interface Calibration {
  timeRatio: number;
  usdRatio: number;
  samples: number;
  /** ISO timestamp of the most recent run it is drawn from. */
  lastRanAt?: string;
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
  /** Estimated, always: chars ÷ {@link CHARS_PER_TOKEN}. Never measured here. */
  inputTokens: number;
  outputTokens: number;
  /** The middle of {@link usdLow}…{@link usdHigh}, not a promise. */
  usd: number;
  usdLow: number;
  usdHigh: number;
  /** The middle of {@link secondsLow}…{@link secondsHigh}, not a promise. */
  seconds: number;
  secondsLow: number;
  secondsHigh: number;
  model: string;
  modelClass: ModelClass;
  backend?: Backend;
  /** False on the subscription paths: `usd` is an api-equivalent, not a charge. */
  chargeable: boolean;
  /**
   * Rung 1: the host agent answers and potsherd makes no model call.
   *
   * Distinct from `!chargeable`, which is also true of `claude -p` — that rung
   * really does spend a subscription's tokens and a real wall time, so its
   * dollar figure is meaningful as an equivalent. On the seam there is nothing
   * for potsherd to spend and nothing for it to predict, so the renderer drops
   * the money and time rows rather than printing zeroes that read as "free".
   */
  hostSeam: boolean;
  /** What the per-call model is fitted to, for the card to print. */
  basis: string;
  /** False when the profile is an assumption rather than a measurement. */
  measured: boolean;
  /** How many concurrent slots the profile expects to actually get. */
  effectiveConcurrency: number;
  /** Set when this machine's own runs moved the number. */
  calibration?: Calibration;
  perSession: EstimatePerSession[];
}

/**
 * Price and time a run before any of it happens.
 *
 * No network, no credentials, no model. `potsherd card --dry-run --all` is
 * exactly this function plus a renderer, which is what makes the dry run
 * trustworthy: there is no code path from here to a backend.
 *
 * Everything it returns is an **estimate** and the caller is expected to say
 * so. It returns a range as well as a point for that reason: the point
 * estimate this replaced was 7× under on the one run that checked it, and a
 * single number rendered without a range reads as a promise.
 */
export function estimate(input: EstimateInput): Estimate {
  const model = input.model ?? CARD_MODEL;
  const cls = modelClass(model);
  const price = PRICES[cls];
  const profile = callProfile(input.backend);
  const chunk = Math.max(1_000, input.chunkChars ?? CHUNK_CHARS);
  const outChars = input.outputCharsPerCall ?? OUTPUT_CHARS_PER_CALL;
  const overhead = input.promptOverheadChars ?? PROMPT_OVERHEAD_CHARS;
  const concurrency = Math.max(1, Math.floor(input.concurrency ?? 1));
  const hostSeam = input.hostSeam === true;
  // Rung 1 charges nothing and rung 2 charges nothing; only a real api key
  // does. Before T10.11 an omitted `backend` — which is what the host-agent
  // seam looks like, its rung having no transport to name — defaulted to
  // `true`, so the one path on which potsherd makes no model call at all was
  // the one path that quoted the user a bill.
  const chargeable =
    input.chargeable ?? (hostSeam ? false : input.backend ? input.backend === 'api' : true);
  // The measured fit is a haiku fit. A `--model sonnet` run buys the same
  // seconds and three times the tokens, so the money scales with the class
  // and the clock does not.
  const priceScale = price.inputPerMTok / PRICES[CARD_MODEL].inputPerMTok;

  const perSession: EstimatePerSession[] = [];
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  // Input characters actually sent, which is what the per-call fits take.
  let promptChars = 0;
  // The same four totals, restricted to sessions whose call count this
  // function *derived*. Only those carry PIPELINE_COST_FACTOR: a caller that
  // states its own `calls` is reporting a fact, not asking for a guess.
  let derivedCalls = 0;
  let derivedInputTokens = 0;
  let derivedOutputTokens = 0;
  let derivedChars = 0;

  for (const s of input.sessions) {
    // Map-reduce: a session longer than one chunk is extracted per chunk and
    // then reduced, so it costs one extra call and one extra pass over the
    // partial results (`phase-2` T2.2 §1).
    const chunks = Math.max(1, Math.ceil(Math.max(0, s.chars) / chunk));
    const n = s.calls ?? (chunks === 1 ? 1 : chunks + 1);
    // The reduce call re-reads the per-chunk output, not the transcript.
    const reduceChars = chunks === 1 ? 0 : chunks * outChars;
    const chars = Math.max(0, s.chars) + n * overhead + reduceChars;
    const inTok = tokensForChars(chars);
    const outTok =
      profile.outputTokensPerCall !== null
        ? n * profile.outputTokensPerCall
        : tokensForChars(n * outChars);

    const derived = s.calls === undefined;
    const bare = callUsd(n, chars, inTok, outTok, profile, price, priceScale);
    perSession.push({
      id: s.id,
      calls: n,
      inputTokens: inTok,
      outputTokens: outTok,
      usd: derived ? bare * PIPELINE_COST_FACTOR : bare,
    });
    calls += n;
    inputTokens += inTok;
    outputTokens += outTok;
    promptChars += chars;
    if (derived) {
      derivedCalls += n;
      derivedInputTokens += inTok;
      derivedOutputTokens += outTok;
      derivedChars += chars;
    }
  }

  const cal = input.calibration;
  const usdRatio = cal && cal.samples > 0 ? cal.usdRatio : 1;
  const timeRatio = cal && cal.samples > 0 ? cal.timeRatio : 1;

  const rawUsd =
    calls === 0 ? 0 : callUsd(calls, promptChars, inputTokens, outputTokens, profile, price, priceScale);
  // `callUsd` is linear in every argument, so this is exactly the per-session
  // sum above — the supplement passes and retries the ideal call arithmetic
  // never counted, charged once, on the derived part only.
  const unquoted =
    derivedCalls === 0
      ? 0
      : (PIPELINE_COST_FACTOR - 1) *
        callUsd(
          derivedCalls,
          derivedChars,
          derivedInputTokens,
          derivedOutputTokens,
          profile,
          price,
          priceScale,
        );
  const usd = hostSeam ? 0 : (rawUsd + unquoted) * usdRatio;

  // Serial work first, then the concurrency the machine actually delivers.
  // PIPELINE_COST_FACTOR is deliberately absent: the one un-truncated recorded
  // run came in at 1.15x of its quoted time and 1.68x of its quoted money, and
  // an estimator corrected on both axes when only one is wrong is the "2x
  // pessimistic" failure that would replace this one.
  const serialMs = calls * profile.baseMs + (promptChars / 1_000) * profile.msPerKChar;
  const eff = effectiveConcurrency(concurrency, profile);
  const seconds = calls === 0 || hostSeam ? 0 : (serialMs / 1_000 / eff) * timeRatio;

  return {
    sessions: input.sessions.length,
    calls,
    inputTokens,
    outputTokens,
    usd,
    usdLow: usd * profile.spread.usdLow,
    usdHigh: usd * profile.spread.usdHigh,
    seconds,
    secondsLow: seconds * profile.spread.timeLow,
    secondsHigh: seconds * profile.spread.timeHigh,
    model,
    modelClass: cls,
    ...(input.backend ? { backend: input.backend } : {}),
    chargeable,
    hostSeam,
    basis: hostSeam ? HOST_SEAM_BASIS : profile.basis,
    measured: hostSeam ? false : profile.measured,
    effectiveConcurrency: eff,
    ...(cal && cal.samples > 0 ? { calibration: cal } : {}),
    perSession,
  };
}

/**
 * Api-equivalent dollars for `calls` calls carrying `chars` characters.
 *
 * Two ways to answer, and which one is right depends on who is paying:
 *
 *   - **agent-sdk**: the measured end-to-end fit. The SDK's own
 *     `total_cost_usd` is the ground truth on that path, and it prices cache
 *     writes and reasoning output that a character count cannot see. Our
 *     token arithmetic priced the one recorded run at $4.25 against a real
 *     $12.93; the fit prices it at $11.18.
 *   - **api**: {@link PRICES} on the token counts, with no harness overhead.
 *     That path is really billed, and the invoice is token arithmetic.
 */
function callUsd(
  calls: number,
  chars: number,
  inputTokens: number,
  outputTokens: number,
  profile: CallProfile,
  price: Price,
  priceScale: number,
): number {
  if (profile.usdPerMChar === null) {
    return (
      (inputTokens / 1e6) * price.inputPerMTok +
      (outputTokens / 1e6) * price.outputPerMTok +
      calls * profile.baseUsd * priceScale
    );
  }
  return (calls * profile.baseUsd + (chars / 1e6) * profile.usdPerMChar) * priceScale;
}

// ------------------------------------------------------------------ budget

export interface Spend {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  ms: number;
  /**
   * How many of those calls had their input tokens **estimated** rather than
   * reported, because the backend's own number was not believable
   * ({@link Llm.text}). On the agent-sdk path this is every call, and a
   * receipt that prints `inputTokens` without printing this is claiming a
   * measurement it does not have.
   */
  estimatedInputCalls: number;
}

export function emptySpend(): Spend {
  return { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0, ms: 0, estimatedInputCalls: 0 };
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
 * What {@link Budget.admit} hands back: the estimated cost it is holding
 * against the cap on behalf of one in-flight call.
 *
 * Pass it to {@link Budget.record} when the call returns — the estimate is
 * dropped and the actual takes its place — or {@link Reservation.release} it
 * when the call throws. Either is idempotent, and doing neither is the one way
 * to leak budget, so every caller does one of them in a `finally`.
 */
export interface Reservation {
  /** The estimated dollars this reservation is holding. */
  readonly usd: number;
  /** The estimated tokens this reservation is holding. */
  readonly tokens: number;
  /** Give the estimate back without recording a spend. Idempotent. */
  release(): void;
}

/**
 * The running total, and the gate in front of the next call.
 *
 * {@link admit} is checked **before** a call, against what that call is
 * projected to cost, so the cap is a ceiling on spend rather than a
 * post-mortem on it.
 *
 * **Why `admit` reserves (T4.5 / D1).** `admit` runs before a call and
 * {@link record} after it, so at concurrency 6 all six workers used to clear
 * `admit` against the same $0 of recorded spend: `--max-usd` was enforced
 * *between* batches, not *within* one, and a $0.50 cap could be overshot by a
 * whole batch. `card --all` shipped with that from `v0.3.0`.
 *
 * So `admit` now **reserves** the call's projected cost, and the gate is
 * `spent + reserved + projected`. A reservation is dropped by `record` (the
 * actual replaces it) or by `release` (the call threw). The projection is the
 * same pessimistic one it always was — real input tokens plus the *full*
 * output allowance at list price — and an estimate can be wrong in both
 * directions:
 *
 *   - **Estimate too high** is the common case, because most replies are far
 *     shorter than `maxOutputTokens`. The run then holds more than it spends
 *     and can abort with headroom left: up to one batch of projections early,
 *     where the serial code aborted one call early. That is conservative in
 *     the direction of the promise, and `record` hands the difference straight
 *     back, so an over-reserve never accumulates across calls.
 *   - **Estimate too low** — a backend charging above list, a reply costing
 *     more than its token count suggests — is not something *any* pre-call
 *     gate can catch, in this design or another. `record` writes the actual,
 *     so the next `admit` sees the overshoot and the run stops; the call
 *     already made is still charged. `--max-usd` is therefore a ceiling to
 *     within one call's actual cost, which is the strongest claim a pre-call
 *     cap can make. `ask`'s "readers alone exceeded --max-usd" test walks that
 *     path end to end.
 *
 * Two things this deliberately does **not** do. It never blocks: `admit`
 * returns or throws, never waits, so no arrangement of workers can deadlock on
 * the budget. And a projection larger than the whole cap refuses *itself* and
 * reserves nothing — the throw happens before any accounting — so one huge
 * estimate cannot wedge the budget shut against every call after it.
 */
export class Budget {
  private readonly spent: Spend = emptySpend();
  private done = 0;
  private total = 0;
  /** Estimated cost of calls in flight: admitted, not yet recorded or released. */
  private reservedUsd = 0;
  private reservedTokens = 0;

  constructor(private readonly limits: BudgetOptions = {}) {}

  /** Dollars held for in-flight calls. For receipts and tests, not for display. */
  get inFlightUsd(): number {
    return this.reservedUsd;
  }

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

  /**
   * Throws {@link BudgetError} when this call would cross a ceiling, counting
   * what other calls already hold in flight; otherwise reserves the projection
   * and returns the {@link Reservation} that must later be recorded or
   * released.
   *
   * The return value is safe to ignore only where nothing is ever in flight (a
   * strictly serial caller, or a test): an ignored reservation is held for the
   * life of the `Budget`.
   */
  admit(projected: { usd?: number; tokens?: number } = {}): Reservation {
    const usd = projected.usd ?? 0;
    const tokens = projected.tokens ?? 0;
    const { maxUsd, maxTokens } = this.limits;

    // `committed` is spend that has happened plus spend already promised.
    // Printing only `spent.usd` here would report $0.00 while six calls were in
    // the air against the same cap — the shape of false number `08` rule 1
    // exists to stop.
    const committedUsd = this.spent.usd + this.reservedUsd;
    if (maxUsd !== undefined && committedUsd + usd > maxUsd) {
      const inFlight =
        this.reservedUsd > 0 ? ` (${fmtUsd(this.reservedUsd)} of it in flight)` : '';
      throw new BudgetError(
        `stopped at --max-usd ${maxUsd.toFixed(2)}: ${this.done} of ${this.total} done, ` +
          `${fmtUsd(committedUsd)} committed${inFlight}, next call needs ${fmtUsd(usd)}`,
        {
          kind: 'usd',
          limit: maxUsd,
          projected: committedUsd + usd,
          done: this.done,
          total: this.total,
          spend: this.spend,
        },
        `potsherd card --all --max-usd ${Math.ceil(committedUsd + usd + 1)}`,
      );
    }

    const spentTokens = this.spent.inputTokens + this.spent.outputTokens;
    const committedTokens = spentTokens + this.reservedTokens;
    if (maxTokens !== undefined && committedTokens + tokens > maxTokens) {
      throw new BudgetError(
        `stopped at --max-tokens ${maxTokens}: ${this.done} of ${this.total} done, ` +
          `${committedTokens} tokens committed, next call needs ${tokens}`,
        {
          kind: 'tokens',
          limit: maxTokens,
          projected: committedTokens + tokens,
          done: this.done,
          total: this.total,
          spend: this.spend,
        },
        `potsherd card --all --max-tokens ${committedTokens + tokens + maxTokens}`,
      );
    }

    // Past both gates: only now is anything held. A refused call reserves
    // nothing, so one oversized estimate cannot wedge the budget shut.
    this.reservedUsd += usd;
    this.reservedTokens += tokens;
    let live = true;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      usd,
      tokens,
      release(): void {
        if (!live) return;
        live = false;
        self.reservedUsd -= usd;
        self.reservedTokens -= tokens;
        // Float subtraction leaves atto-dollars behind; a budget with nothing
        // in flight must read as exactly nothing.
        if (self.reservedUsd < 1e-12) self.reservedUsd = 0;
        if (self.reservedTokens < 1e-9) self.reservedTokens = 0;
      },
    };
  }

  /**
   * The actual cost of a call that has returned. Pass the {@link Reservation}
   * {@link admit} gave you and the estimate it held is dropped in the same
   * step, so `spent + reserved` never double-counts one call.
   */
  record(
    r: {
      inputTokens: number;
      outputTokens: number;
      usd: number;
      ms: number;
      inputTokensEstimated?: boolean;
    },
    reservation?: Reservation,
  ): void {
    reservation?.release();
    this.spent.calls += 1;
    this.spent.inputTokens += r.inputTokens;
    this.spent.outputTokens += r.outputTokens;
    this.spent.usd += r.usd;
    this.spent.ms += r.ms;
    if (r.inputTokensEstimated) this.spent.estimatedInputCalls += 1;
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
  /**
   * Whether the npm package each backend needs can be resolved from here.
   *
   * A `claude` binary on PATH is a *signal* that this user has Claude Code set
   * up; it is not what gets run. What gets run is
   * `@anthropic-ai/claude-agent-sdk`, and that is an **optional peer** — a
   * plain `npm i -g potsherd` does not install it, because it and the API SDK
   * and the embedding runtime together are 677 MB of the 764 MB that install
   * used to be, against 17 MB without them.
   *
   * Until phase 7 nothing checked. On a machine with `claude` on PATH and no
   * SDK installed, `detectBackend` happily chose `agent-sdk`, every reader
   * rejected at call time, and `ask` printed **"the readers found nothing that
   * answers the question"** — a false statement about the user's archive,
   * printed by the verb whose entire purpose is not making those. `card` and
   * `graft` had the same hole.
   */
  agentSdk: boolean;
  /** `@anthropic-ai/sdk`, for the API-key path. */
  apiSdk: boolean;
  /**
   * The coding agent potsherd is running *inside*, when it is running inside
   * one. Rung 1 of {@link RESOLUTION_LADDER}: that agent is already a model,
   * already on the user's subscription, and already holds the conversation
   * this question came out of.
   */
  host: HostAgent | null;
  /** {@link host} is not null: rung 1 is reachable on this process. */
  hostSeam: boolean;
}

/** The harnesses that can be the model themselves. */
export type HostAgent = 'claude-code' | 'codex' | 'cursor';

/**
 * Which coding agent this process is running inside, from its environment.
 *
 * Each harness announces itself; none of these are potsherd's own variables
 * and none of them are asked of the user. `POTSHERD_HARNESS` overrides, which
 * is what a test and a wrapper script use.
 */
export function hostAgent(env: NodeJS.ProcessEnv = process.env): HostAgent | null {
  const forced = env['POTSHERD_HARNESS'];
  if (forced === 'claude-code' || forced === 'codex' || forced === 'cursor') return forced;
  if (env['CLAUDECODE'] === '1' || (env['CLAUDE_CODE_ENTRYPOINT'] ?? '') !== '') return 'claude-code';
  if (env['CODEX_HOME'] || env['CODEX_SANDBOX']) return 'codex';
  if (env['CURSOR_AGENT'] || env['CURSOR_TRACE_ID']) return 'cursor';
  return null;
}

// ------------------------------------------------------------- the ladder

/** A rung's stable name. Printed in `--json` and in `why`. */
export type RungId = 'host-seam' | 'claude-cli' | 'codex-cli' | 'agent-sdk' | 'api-key';

export interface LadderRung {
  id: RungId;
  /** Which of the four numbered rungs this entry belongs to. */
  rung: 1 | 2 | 3;
  /**
   * The transport this rung builds — `null` for rung 1, which builds none:
   * the host agent *is* the model and potsherd's job there is to hand it a
   * prompt and filter what comes back.
   */
  backend: Backend | null;
  /** One line, for `why`, for `--json`, and for the receipt. */
  label: string;
  /** Reachable on this machine? */
  ready: (a: Availability) => boolean;
}

/**
 * **The order is the product.** `plans/phases/phase-10-agent-audit.md` §A1,
 * read literally, and `tests/llm.test.ts` fails if it moves.
 *
 * The defect this replaces was one line: a `claude` binary sitting on PATH,
 * plainly able to answer, and potsherd refusing because the only way it knew
 * how to talk to that binary was through a 677 MB npm package. Three of the
 * six headline verbs were dead on a default install because of it.
 *
 * So the ladder is ordered by *what the user already has*, not by what is
 * most convenient to code against:
 *
 *   1. **the host agent** — potsherd is often running inside Claude Code,
 *      Codex or Cursor. That agent is a model, on the user's own
 *      subscription, holding the conversation the question came from. It
 *      needs no install and knows more than anything potsherd could spawn.
 *      This rung is taken through `ask --readers-out/--readers-in` and
 *      `--synthesis-out/--filter-in`, which is why its `backend` is null:
 *      there is nothing here to construct.
 *   2. **the `claude` or `codex` binary, spawned** — every subscription user
 *      has one. No SDK, no key, no download. The tie inside this rung goes to
 *      the harness the user is actually in ({@link ladderFor}).
 *   3. **the agent SDK or an API key, if they happen to be there** — used
 *      when present, never required, never suggested at install.
 *   4. nothing: {@link NoBackendError}, which is the only place an install
 *      line may ever be printed.
 *
 * Rung 3 sits *below* rung 2 on purpose and it is the one placement worth
 * arguing about. The SDK ships its own copy of the same harness; the binary
 * on PATH is the user's own, at their own version, with their own auth. If
 * the two disagree, the user's is the correct one. And putting the SDK first
 * is what let a 677 MB optional dependency become load-bearing without anyone
 * deciding that it should. `POTSHERD_LLM_BACKEND=agent-sdk` still forces it.
 */
export const RESOLUTION_LADDER: readonly LadderRung[] = [
  {
    id: 'host-seam',
    rung: 1,
    backend: null,
    label: 'the host agent is the model',
    ready: (a) => a.hostSeam,
  },
  {
    id: 'claude-cli',
    rung: 2,
    backend: 'claude-cli',
    label: 'the claude binary, spawned',
    ready: (a) => a.claude !== null,
  },
  {
    id: 'codex-cli',
    rung: 2,
    backend: 'codex',
    label: 'the codex binary, spawned',
    ready: (a) => a.codex !== null,
  },
  {
    id: 'agent-sdk',
    rung: 3,
    backend: 'agent-sdk',
    label: 'the agent sdk, already installed',
    ready: (a) => a.claude !== null && a.agentSdk,
  },
  {
    id: 'api-key',
    rung: 3,
    backend: 'api',
    label: 'an api key, already set',
    ready: (a) => a.apiKey && a.apiSdk,
  },
];

/**
 * The ladder as it applies to *this* machine.
 *
 * One reordering, and only one: inside codex, the codex binary comes before
 * the claude binary. Both are rung 2 — the tie is between two equal rungs and
 * the harness the user is sitting in breaks it. Nothing else moves, which is
 * what {@link RESOLUTION_LADDER}'s test pins.
 */
export function ladderFor(a: Availability): readonly LadderRung[] {
  if (a.host !== 'codex') return RESOLUTION_LADDER;
  const codex = RESOLUTION_LADDER.find((r) => r.id === 'codex-cli');
  if (!codex) return RESOLUTION_LADDER;
  const rest = RESOLUTION_LADDER.filter((r) => r.id !== 'codex-cli');
  const at = rest.findIndex((r) => r.id === 'claude-cli');
  if (at < 0) return RESOLUTION_LADDER;
  return [...rest.slice(0, at), codex, ...rest.slice(at)];
}

/** The highest rung this machine can reach, including rung 1. Null for none. */
export function topRung(a: Availability): LadderRung | null {
  return ladderFor(a).find((r) => r.ready(a)) ?? null;
}

/** The highest rung that builds a transport. Rung 1 is skipped: it builds none. */
export function transportRung(a: Availability): LadderRung | null {
  return ladderFor(a).find((r) => r.backend !== null && r.ready(a)) ?? null;
}

export interface DetectOptions {
  /** Force a backend. `POTSHERD_LLM_BACKEND` does the same from the shell. */
  backend?: Backend;
  model?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam: replaces the PATH lookup. */
  which?: (name: string) => string | null;
  /** Test seam: replaces the module-resolution check. */
  resolvable?: (specifier: string) => boolean;
}

export interface BackendChoice {
  backend: Backend;
  /** The string handed to the backend, after alias resolution for `api`. */
  model: string;
  /** The alias or id the user asked for. */
  requested: string;
  /** One line for `--json` and for the card: why this backend. */
  why: string;
  /** Which of {@link RESOLUTION_LADDER}'s numbered rungs this is. */
  rung: 1 | 2 | 3;
  /** The rung's stable id, or null when `--backend` named something unknown. */
  rungId: RungId | null;
  /** The binary, when the backend is a spawned one. */
  bin?: string;
  /** False on the subscription paths. */
  chargeable: boolean;
  availability: Availability;
}

/**
 * No rung of {@link RESOLUTION_LADDER} builds a transport here.
 *
 * Two situations, and telling them apart is the whole value of this message:
 *
 *   - **rung 1 is live and rungs 2–3 are not.** potsherd is inside a coding
 *     agent and there is no binary, no SDK and no key. Nothing needs
 *     installing: the agent reading this *is* the model, and the seam flags
 *     are how it answers. The message is a route, not a requirement.
 *   - **nothing at all.** Then, and only then, one install line — the last
 *     rung of the ladder, and the only place in the product where an install
 *     may be named. It names Claude Code, which is what a subscription user
 *     already has, and never an npm package: the whole defect this class was
 *     rewritten for was potsherd standing in front of a working `claude`
 *     binary and demanding 677 MB before it would speak to it.
 *
 * Written with static helpers and one unconditional `super()` rather than a
 * `super()` in each branch: with a parameter property, TypeScript emits
 * `this.availability = …` at the top of the constructor, which is before a
 * branched `super()` — and the whole class then throws "Must call super
 * constructor in derived class before accessing 'this'". Four tests caught
 * it; the message a user would have seen was that sentence.
 */
export class NoBackendError extends Error {
  readonly name = 'NoBackendError';
  readonly fix: string;
  readonly availability: Availability;
  /** The highest rung that *is* reachable, when one is. Null for none at all. */
  readonly rung: RungId | null;

  constructor(availability: Availability) {
    super(NoBackendError.message(availability));
    this.availability = availability;
    this.fix = NoBackendError.fixFor(availability);
    this.rung = topRung(availability)?.id ?? null;
  }

  private static message(a: Availability): string {
    if (a.hostSeam) {
      return (
        `no model backend on this machine — and none is needed: potsherd is running inside ${a.host}, ` +
        'which is already a model on your own subscription.\n' +
        '        Run the seam: potsherd emits the prompts, you answer them, potsherd filters the ' +
        'citations in code.'
      );
    }
    const key = a.apiKey
      ? '\n        ANTHROPIC_API_KEY is set but the Anthropic SDK is not installed.'
      : '';
    return (
      'no way to reach a model: no `claude` binary on PATH, no `codex`, and no coding agent ' +
      'around this process.' +
      key +
      '\n        potsherd runs on the Claude Code subscription you already have — installing ' +
      'Claude Code is enough.'
    );
  }

  private static fixFor(a: Availability): string {
    if (a.hostSeam) {
      return 'potsherd ask "…" --readers-out r.json   # then --readers-in / --synthesis-out / --filter-in';
    }
    if (a.apiKey && !a.apiSdk) return 'npm install -g @anthropic-ai/sdk';
    return 'https://claude.com/product/claude-code';
  }
}

/** Can this specifier be resolved from here? Never throws. */
function resolvable(specifier: string): boolean {
  try {
    createRequire(import.meta.url).resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

export function availability(o: DetectOptions = {}): Availability {
  const env = o.env ?? process.env;
  // PATH comes from the *passed* env, not the process's, so a test — and a
  // hook running with a trimmed environment — sees what it configured.
  const which = o.which ?? ((n: string) => onPath(n, env));
  const key = env['ANTHROPIC_API_KEY'];
  const canResolve = o.resolvable ?? resolvable;
  const host = hostAgent(env);
  return {
    claude: which('claude'),
    codex: which('codex'),
    apiKey: typeof key === 'string' && key.trim().length > 0,
    codexHarness: host === 'codex',
    agentSdk: canResolve('@anthropic-ai/claude-agent-sdk'),
    apiSdk: canResolve('@anthropic-ai/sdk'),
    host,
    hostSeam: host !== null,
  };
}

/**
 * Which backend this machine gets, which rung of the ladder that is, and why.
 *
 * There is exactly one ordering and it is {@link RESOLUTION_LADDER}; this
 * function walks it and stops at the first rung that is both *ready* and
 * *buildable*. Rung 1 is ready inside a coding agent and is never buildable —
 * the host is reached through `ask`'s seam flags, not through a `Transport` —
 * so a process inside Claude Code with a `claude` on PATH reports rung 2 and
 * says in `why` that rung 1 is also live. Anything else would be this
 * function claiming to have done something it cannot do from a subprocess.
 *
 * An explicit `--backend` / `POTSHERD_LLM_BACKEND` still wins over all of it.
 */
export function detectBackend(o: DetectOptions = {}): BackendChoice {
  const env = o.env ?? process.env;
  const avail = availability(o);
  const requested = o.model ?? env['POTSHERD_MODEL'] ?? CARD_MODEL;
  const forced = (o.backend ?? env['POTSHERD_LLM_BACKEND']) as Backend | undefined;

  const choose = (
    backend: Backend,
    rung: LadderRung | null,
    why: string,
    bin?: string,
  ): BackendChoice => ({
    backend,
    model: resolveModel(requested, backend),
    requested,
    why,
    rung: rung?.rung ?? 3,
    rungId: rung?.id ?? null,
    ...(bin ? { bin } : {}),
    chargeable: backend === 'api',
    availability: avail,
  });

  const rungFor = (backend: Backend): LadderRung | null =>
    RESOLUTION_LADDER.find((r) => r.backend === backend) ?? null;

  if (forced) {
    const rung = rungFor(forced);
    if (!rung) throw new NoBackendError(avail);
    const bin =
      forced === 'agent-sdk' || forced === 'claude-cli'
        ? (avail.claude ?? 'claude')
        : forced === 'codex'
          ? (avail.codex ?? 'codex')
          : undefined;
    return choose(forced, rung, 'forced', bin);
  }

  const rung = transportRung(avail);
  if (!rung || !rung.backend) throw new NoBackendError(avail);

  // The one thing `why` must carry that the rung alone does not: whether the
  // rung *above* this one was also available and simply cannot be built from
  // here. An agent reading `--json` needs to know it could have used the seam.
  const seam = avail.hostSeam && rung.rung > 1 ? `; rung 1 (${avail.host}) is live too` : '';
  const where =
    rung.backend === 'api'
      ? 'ANTHROPIC_API_KEY is set'
      : rung.backend === 'codex'
        ? `codex on PATH (${avail.codex})`
        : `claude on PATH (${avail.claude})`;
  return choose(
    rung.backend,
    rung,
    `rung ${rung.rung} — ${rung.label}: ${where}${seam}`,
    rung.backend === 'codex' ? (avail.codex ?? undefined) : (avail.claude ?? undefined),
  );
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
  /**
   * True when this error is a deadline, not a refusal.
   *
   * The distinction is the whole of {@link Llm.text}'s retry rule: a call that
   * ran out of clock has told us nothing about whether it would ever have
   * worked, and one more try is cheap. A call that came back `error_max_turns`
   * or found no `claude` binary has told us, and retrying it just spends the
   * clock twice.
   */
  readonly timedOut: boolean;
  /**
   * What the child printed before it failed, when it was a spawned one.
   *
   * A CLI that fails by *answering* — `claude -p` exits non-zero and prints
   * `{"is_error":true,"result":"Not logged in · Please run /login"}` on
   * stdout — is a CLI whose exit code alone says nothing a user can act on.
   * `potsherd: claude exited 1 / try: claude --version` was the message that
   * came out of exactly that, and `claude --version` works fine, so the
   * suggested fix confirmed the machine was healthy while the run stayed
   * broken. The transport reads this and says the real sentence instead.
   */
  readonly stdout?: string;
  constructor(
    message: string,
    readonly fix?: string,
    readonly cause?: unknown,
    options: { timedOut?: boolean; stdout?: string } = {},
  ) {
    super(message);
    this.timedOut = options.timedOut ?? false;
    if (options.stdout !== undefined) this.stdout = options.stdout;
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

/**
 * The **one** directory potsherd ever spawns `claude -p` in, per tmp root.
 *
 * This is not a tidiness choice; it is the whole of what can be done about a
 * real defect, and the shape of the fix is decided by what was measured.
 *
 * Claude Code creates `~/.claude/projects/<slug-of-cwd>/` for whatever
 * directory it is run in. {@link makeScratch} makes a *fresh random* one per
 * transport, so a `card --all` over the reference corpus — 39 calls — would
 * leave 39 differently-named directories in the archive potsherd exists to
 * read. A tool whose premise is "your archive is the record" must not write to
 * the archive as a side effect of reading it.
 *
 * Three things were measured on the reference machine (23 aug 2026, Claude
 * Code 2.1.241), and they bound the fix:
 *
 *   1. `--no-session-persistence` **works**: no transcript JSONL is written,
 *      so nothing a subprocess call creates can ever appear in `potsherd ls`
 *      or be indexed, carded or ranked. That is the harm that mattered.
 *   2. What survives is an **empty** `projects/<slug>/memory/` directory. Two
 *      probe runs produced two of them. It holds no content, but it is litter
 *      in someone else's directory and there are as many as there are calls.
 *   3. `CLAUDE_CONFIG_DIR` — the obvious lever, and potsherd already knows the
 *      variable — **cannot be used**. Pointed at a scratch directory, empty or
 *      seeded from the user's own `.claude.json`, `claude -p` answers
 *      `Not logged in · Please run /login` and the run is dead. The
 *      subscription credential is not in that directory and does not follow
 *      it. Isolating the config dir would trade a stray empty folder for the
 *      entire rung, which is not a trade worth making.
 *
 * So: a **fixed name**, created once, reused by every call, and deliberately
 * **not removed on close** — because deleting the cwd does not un-create the
 * `~/.claude/projects` entry that names it, and a fresh name next time would
 * simply create a second one. One stable directory means one entry, ever,
 * whose name says what made it.
 */
export const CLAUDE_CWD_NAME = 'potsherd-llm-cwd';

function stableScratch(tmpRoot?: string): string {
  const dir = path.join(tmpRoot ?? os.tmpdir(), CLAUDE_CWD_NAME);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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
          `POTSHERD_LLM_TIMEOUT_MS=${DEFAULT_TIMEOUT_MS * 2} potsherd card …`,
          err,
          { timedOut: true },
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
 * The flags {@link ClaudeCliTransport} passes, **verified against the real
 * binary** (Claude Code 2.1.241, `claude --help`, 23 aug 2026) rather than
 * assumed. Every one of them was read out of that help text; none is a guess.
 *
 * | flag | what it buys | the SDK option it mirrors |
 * |---|---|---|
 * | `--print` | non-interactive, answer to stdout, exit | — |
 * | `--output-format json` | one result object: text, usage, cost, model | the `result` message |
 * | `--tools ""` | **no tools at all** | `allowedTools: []` |
 * | `--permission-mode dontAsk` | never blocks on a prompt | `permissionMode` |
 * | `--no-session-persistence` | writes no transcript to disk | `persistSession: false` |
 * | `--setting-sources ""` | no user/project/local settings, so no CLAUDE.md | `settingSources: []` |
 * | `--system-prompt` | replaces the default system prompt | `systemPrompt` |
 *
 * `--tools ""` is the one that matters most and it is the same argument
 * `AgentSdkTransport` makes for `allowedTools: []`: a summariser that can run
 * Bash is a summariser that can be prompt-injected by the transcript it is
 * summarising (`03` §11). The cwd is a scratch directory for the same reason
 * `makeScratch` exists.
 *
 * **`--bare` is deliberately not used**, though it looks like exactly the
 * right flag. Its help text says "Anthropic auth is strictly ANTHROPIC_API_KEY
 * or apiKeyHelper (OAuth and keychain are never read)" — it would turn the one
 * path that needs no key into a path that needs one, which is the opposite of
 * this whole rung. It was tempting and it is wrong.
 */
export const CLAUDE_CLI_ARGS: readonly string[] = [
  '--print',
  '--output-format',
  'json',
  '--tools',
  '',
  '--permission-mode',
  'dontAsk',
  '--no-session-persistence',
  '--setting-sources',
  '',
];

/**
 * `claude -p` — **rung 2, and the reason the other rungs are optional.**
 *
 * The binary is already on the PATH of every Claude Code user. It answers on
 * their subscription, costs nothing marginal, needs no key, and needs no npm
 * package at all. Before this transport existed, potsherd could see that
 * binary sitting there and still refuse, because the only way it knew how to
 * talk to it was through a 677 MB optional dependency — which is how three of
 * six headline verbs came to be dead on a default install.
 *
 * Modelled on {@link CodexTransport} line for line, because that one had
 * already proved the pattern: spawn, feed stdin, read stdout, honour the exit
 * code, never hang. The differences are that the flags here are **verified**
 * against a real binary (see {@link CLAUDE_CLI_ARGS}) and that the reply is
 * structured, so usage and cost come back as numbers instead of guesses.
 *
 * `POTSHERD_CLAUDE_ARGS` mirrors `POTSHERD_CODEX_ARGS`: extra argv, split on
 * spaces, appended after ours, for when a release moves a flag.
 */
class ClaudeCliTransport implements Transport {
  readonly backend = 'claude-cli' as const;
  private scratch: string | null = null;

  constructor(private readonly opts: { env: NodeJS.ProcessEnv; bin: string; tmpRoot?: string }) {}

  async send(req: SendRequest): Promise<SendResult> {
    this.scratch ??= stableScratch(this.opts.tmpRoot);
    const extra = (this.opts.env['POTSHERD_CLAUDE_ARGS'] ?? '').split(' ').filter(Boolean);
    const args = [
      ...CLAUDE_CLI_ARGS,
      '--model',
      req.model,
      ...(req.system ? ['--system-prompt', req.system] : []),
      ...extra,
    ];

    let out: { stdout: string; stderr: string; code: number };
    try {
      out = await run(this.opts.bin, args, {
        input: req.prompt,
        cwd: this.scratch,
        env: { ...this.opts.env, [REENTRANCY_ENV]: '1' },
        timeoutMs: req.timeoutMs,
        ...(req.signal ? { signal: req.signal } : {}),
      });
    } catch (err) {
      // `claude -p` fails by *answering*: it exits non-zero and prints its
      // reason on stdout as a normal result object. Raising "claude exited 1,
      // try claude --version" over the top of `Not logged in · Please run
      // /login` tells the user to run a command that will succeed and teach
      // them nothing. Measured on the reference machine while running potsherd
      // under a relocated HOME, which is exactly how a user who has never
      // logged in will meet it.
      const reply = err instanceof LlmError ? parseClaudeCli(err.stdout ?? '') : null;
      const said = reply?.said ?? reply?.text ?? '';
      if (said) {
        throw new LlmError(
          `claude --print could not answer: ${said.split('\n')[0]}`,
          /not logged in|\/login/i.test(said) ? 'claude   # sign in once, then retry' : 'claude -p "hello"',
          err,
        );
      }
      throw err;
    }

    const parsed = parseClaudeCli(out.stdout);
    if (parsed.error) {
      throw new LlmError(
        `claude --print ended as ${parsed.error}`,
        'claude -p "hello"   # check the subscription is active, then retry',
      );
    }
    if (!parsed.text) {
      throw new LlmError(
        `claude --print produced no answer${out.stderr ? `: ${out.stderr.trim().split('\n').slice(-1)[0]}` : ''}`,
        'claude -p "hello"   # check claude runs at all',
      );
    }
    return {
      text: parsed.text,
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(parsed.inputTokens !== undefined ? { inputTokens: parsed.inputTokens } : {}),
      ...(parsed.outputTokens !== undefined ? { outputTokens: parsed.outputTokens } : {}),
      ...(parsed.usd !== undefined ? { usd: parsed.usd } : {}),
    };
  }

  /**
   * Nothing to clean up, on purpose. See {@link CLAUDE_CWD_NAME}: removing the
   * cwd would not remove the `~/.claude/projects` entry named after it, and
   * the next call would then mint a second one. Keeping it is what holds the
   * footprint at one directory instead of one per call.
   */
  async close(): Promise<void> {
    this.scratch = null;
  }
}

export interface ClaudeCliReply {
  text: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  usd?: number;
  /** The `subtype` of a non-success result, when the run failed on purpose. */
  error?: string;
  /**
   * The `result` field as printed, **whether or not the run succeeded**.
   *
   * Separate from {@link ClaudeCliReply.text}, which is deliberately empty on
   * a failure so that no caller can mistake an error for an answer. This one
   * exists for the error message: when `claude -p` fails, the sentence a user
   * needs is the one the CLI already wrote, and `Not logged in · Please run
   * /login` is worth infinitely more than `exited 1`.
   */
  said?: string;
}

/**
 * The `--output-format json` result object, and a fallback for when it is not
 * one.
 *
 * Lenient in exactly one direction, and for a measured reason: if a future
 * release changes or drops `--output-format json`, `claude -p` still prints
 * the answer as plain text on stdout, and an answer without a token count is
 * worth far more than an exception. So a stdout that does not parse is taken
 * as the answer itself — the same call {@link lastAgentMessage} makes for
 * codex. What is *not* lenient: a parsed object saying `is_error` or a
 * `subtype` other than `success` is a failure and is raised as one.
 *
 * The input count sums the three buckets the CLI reports — uncached,
 * cache-write and cache-read — because every one of them is input the model
 * read. `usage.input_tokens` alone is the uncached remainder, and on the
 * measured probe it was **2** against a 3,025-token prompt. That is the same
 * quantity-wearing-the-wrong-name that {@link IMPLAUSIBLE_TOKEN_FACTOR} exists
 * to catch, and summing removes the need for it to fire here at all.
 */
export function parseClaudeCli(stdout: string): ClaudeCliReply {
  const raw = stdout.trim();
  if (!raw) return { text: '' };
  let obj: Record<string, unknown> | null = null;
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) obj = v as Record<string, unknown>;
  } catch {
    obj = null;
  }
  if (!obj) return { text: raw };

  const said = typeof obj['result'] === 'string' ? obj['result'].trim() : '';
  const subtype = typeof obj['subtype'] === 'string' ? obj['subtype'] : '';
  if (obj['is_error'] === true || (subtype !== '' && subtype !== 'success')) {
    return { text: '', error: subtype || 'an error', ...(said ? { said } : {}) };
  }

  const text = said;
  const usage = asRecord(obj['usage']);
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const inputTokens = usage
    ? num(usage['input_tokens']) +
      num(usage['cache_creation_input_tokens']) +
      num(usage['cache_read_input_tokens'])
    : 0;
  const outputTokens = usage ? num(usage['output_tokens']) : 0;
  const modelUsage = asRecord(obj['modelUsage']);
  const model = modelUsage ? Object.keys(modelUsage)[0] : undefined;
  const usd = typeof obj['total_cost_usd'] === 'number' ? obj['total_cost_usd'] : undefined;

  return {
    text,
    ...(model ? { model } : {}),
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(usd !== undefined ? { usd } : {}),
  };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * `codex exec`, for a machine whose harness is codex.
 *
 * **The argv is verified; the round trip is not, and those are different
 * claims.** This transport carried a blanket "unverified" label from phase 5
 * on the grounds that codex was not installable on the reference machine. That
 * turned out to be false: `@openai/codex@0.149.0` installs from npm in under a
 * minute, and every flag below was then read out of the real
 * `codex exec --help` — `exec`, `--skip-git-repo-check`, `-C/--cd`,
 * `-m/--model`, and `-` for stdin ("instructions are read from stdin").
 *
 * What is still unverified is a real model round trip, which needs codex
 * credentials this machine does not have. So the label is narrowed rather than
 * dropped: the plumbing is tested against a stub binary and the flags are
 * tested against a real `--help`, and nobody has yet watched codex answer a
 * question. `POTSHERD_CODEX_ARGS` remains the escape hatch.
 *
 * Three flags were added once the real binary could be read, and each one
 * fixes something the documentation-only version got wrong:
 *
 *   - **`--ephemeral`** — *"Run without persisting session files to disk"*.
 *     Without it, every model call potsherd makes writes a session into the
 *     archive potsherd indexes. That is the same defect
 *     {@link CLAUDE_CWD_NAME} documents for the claude rung, and on this rung
 *     there is a real flag for it.
 *   - **`--ignore-user-config`** — *"Do not load `$CODEX_HOME/config.toml`;
 *     auth still uses `CODEX_HOME`"*. The summariser stops inheriting whatever
 *     is in the user's config, which is the same argument
 *     `settingSources: []` makes on the claude rungs. The second half of that
 *     sentence is why it is safe to pass and why `claude --bare`, which says
 *     the opposite about auth, is not.
 *   - **`-o/--output-last-message <FILE>`** — the final message, written to a
 *     file. {@link lastAgentMessage} scrapes it out of stdout instead, which
 *     works and is a guess about formatting; a file is the answer the CLI
 *     means to give. The scraper stays as the fallback for a codex too old to
 *     have the flag, or a run that writes nothing.
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
    const lastMessage = path.join(this.scratch, 'last-message.txt');
    const args = [
      'exec',
      '--skip-git-repo-check',
      // Verified at 0.149.0: no session files on disk, so a model call cannot
      // write into the archive potsherd reads.
      '--ephemeral',
      // Verified at 0.149.0: config.toml is not loaded, auth still is.
      '--ignore-user-config',
      '--cd',
      this.scratch,
      '--model',
      req.model,
      '--output-last-message',
      lastMessage,
      ...extra,
      '-',
    ];

    const out = await run(this.opts.bin, args, {
      input: req.system ? `${req.system}\n\n${req.prompt}` : req.prompt,
      cwd: this.scratch,
      env: { ...this.opts.env, [REENTRANCY_ENV]: '1' },
      timeoutMs: req.timeoutMs,
      ...(req.signal ? { signal: req.signal } : {}),
    });

    // The file first, the scraper second. `-o` is what the CLI means to hand
    // over; `lastAgentMessage` is an inference from stdout's shape, and an
    // inference should never win over a statement.
    const text = readIfPresent(lastMessage) || lastAgentMessage(out.stdout);
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

/** The `--output-last-message` file, when codex wrote one. Never throws. */
function readIfPresent(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
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
  /**
   * The child's working directory. Always a {@link makeScratch} directory when
   * it is set, for the reason that function documents: a harness spawned in
   * the user's project loads that project's `CLAUDE.md` into a summarisation
   * prompt. `codex exec` takes `--cd` as well and gets both.
   */
  cwd?: string;
}

// ------------------------------------------------- owning the spawned backend
//
// Everything between here and `run` exists for one measured defect: potsherd
// left model backends running after it had exited.
//
// `child.kill()` signals **one pid**. Every harness CLI on these paths is a
// shell script or a launcher that forks the real work, so on the timeout and
// abort paths potsherd killed the launcher, the launcher's child was reparented
// to init, and it kept running. Measured on this tree before the fix:
// `vitest run tests/llm.test.ts -t "never hangs"` finished in 2.4 s and left
// four `sleep 30` processes with PPID 1 behind it. The payload's own `sleep` is
// the only reason those ever went away; a backend that does not exit on its own
// lives until the machine reboots, which is how three orphaned model processes
// came to be alive on a developer's machine for two days.
//
// So the child is spawned `detached: true` — its own process group — and the
// kill paths signal the **group**, which reaches whatever the launcher forked.
//
// `detached` costs one thing, and this is the other half of the fix. A child in
// potsherd's own process group is signalled by the terminal when the user hits
// Ctrl-C, which is how the backend used to be cleaned up on that path — by
// accident, not by code: there is no SIGINT handler anywhere else in the
// product, and no caller of `Llm` wires `o.signal` to one. Taking the child out
// of the foreground group without replacing that would have traded a background
// leak for an interactive one, and `card --all` is ~39 calls.
//
// Hence the registry below: `llm.ts` owns its children for as long as they are
// alive, and one lazily-installed handler per fatal signal — installed when the
// first child starts, removed when the last one settles — kills every live tree
// and then re-raises the signal with the default disposition, so potsherd still
// dies the way the user asked it to and the shell still reads 130.

/**
 * The backend children that are alive right now. Almost always 0 or 1; `card
 * --all` and the reader fan-out make it several.
 */
const liveBackends = new Set<ChildProcess>();

/**
 * The signals whose default action ends the process and that a user sends.
 *
 * Exported so a test can assert the handler bookkeeping against the list this
 * module actually installs rather than against a copy of it.
 */
export const FATAL_SIGNALS = ['SIGINT', 'SIGTERM'] as const;
export type FatalSignal = (typeof FATAL_SIGNALS)[number];

/**
 * The mark that says a listener on `process` is one of **ours**.
 *
 * `process.listenerCount(sig)` is a process-global number, and this module is
 * not the only thing in a node process that installs a `SIGINT` listener: the
 * MCP server installs its own shutdown handler, and under vitest a second test
 * file in the same worker installs and removes others. A test that counted
 * would be asserting about its environment rather than about this module
 * (`09 §7.2` / rule 7), and one did — CI's baseline moved underneath it
 * *between the sample and the assertion*, so the count read lower than the
 * value it had started from and the test failed on a machine where nothing was
 * wrong. So the handlers carry a mark and {@link backendSignalListeners} asks
 * how many of the listeners `process` is actually holding are this module's.
 * A third party's listener cannot move that number in either direction.
 *
 * A module-local `Symbol()` and deliberately **not** `Symbol.for()`: vitest can
 * hold two instances of this module in one process, and each instance is
 * answerable for its own handlers and no one else's.
 */
const OUR_SIGNAL_HANDLER = Symbol('potsherd backend signal handler');

type MarkedHandler = (() => void) & { [OUR_SIGNAL_HANDLER]?: true };

/**
 * How many of the listeners `process` currently holds for `sig` were installed
 * by this module. The contract is that it is 1 while any backend is live,
 * whatever the fan-out, and 0 once the last one has settled.
 */
export function backendSignalListeners(sig: FatalSignal): number {
  return process
    .listeners(sig)
    .filter((fn) => (fn as MarkedHandler)[OUR_SIGNAL_HANDLER] === true).length;
}

/**
 * The installed handlers, or empty when none are installed.
 *
 * A map, and not one listener per child, deliberately: `process` warns at ten
 * listeners for an event, this suite already prints one
 * `MaxListenersExceededWarning`, and a fan-out of readers would have added
 * dozens. Two listeners exist at most, whatever the fan-out.
 */
const signalHandlers = new Map<FatalSignal, () => void>();

/**
 * Kill a backend **and everything it started.**
 *
 * The negative pid is the process group `detached: true` gave the child.
 * `child.kill` stays as the fallback for the race where the group has already
 * gone (`process.kill` then throws ESRCH) and for a platform with no process
 * groups.
 */
function killBackendTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone, or no process groups here
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // already reaped
  }
}

function removeSignalHandlers(): void {
  for (const [sig, handler] of signalHandlers) process.removeListener(sig, handler);
  signalHandlers.clear();
}

function installSignalHandlers(): void {
  if (signalHandlers.size > 0) return;
  for (const sig of FATAL_SIGNALS) {
    const handler: MarkedHandler = (): void => {
      // Synchronous, all of it. The MCP server registers its own SIGINT/SIGTERM
      // handler (`packages/mcp/src/index.ts`) which ends in `process.exit`, and
      // node runs listeners in registration order; anything deferred to a later
      // tick here would lose the race with that exit and leak the child it was
      // installed to kill.
      for (const child of [...liveBackends]) killBackendTree(child);
      liveBackends.clear();
      // Uninstall before re-raising, so this handler cannot re-enter itself.
      removeSignalHandlers();
      // Re-raise rather than `process.exit`: with no listener left, node
      // restores the signal's default disposition and the process dies *of the
      // signal*, so a shell reads 130 for SIGINT instead of whatever code an
      // exit inside a handler happened to pass. Any handler another module
      // installed still runs — this one only adds the kill.
      process.kill(process.pid, sig);
    };
    handler[OUR_SIGNAL_HANDLER] = true;
    signalHandlers.set(sig, handler);
    process.on(sig, handler);
  }
}

/**
 * Take ownership of a spawned backend until it exits.
 *
 * The one case this does not cover, said out loud rather than left to be
 * found: a launcher that forks the real work and **exits immediately** leaves
 * a live grandchild behind a dead child, and this untracks on the child's own
 * exit, so a Ctrl-C after that point has nothing left to kill. The timeout and
 * abort paths still reach it — they fire while the child is tracked — and the
 * alternative, holding a process group that nothing owns for the lifetime of
 * potsherd, kills work a harness deliberately backgrounded.
 */
function trackBackend(child: ChildProcess): void {
  liveBackends.add(child);
  installSignalHandlers();
  const untrack = (): void => {
    liveBackends.delete(child);
    if (liveBackends.size === 0) removeSignalHandlers();
  };
  // Both, and idempotent: `exit` is the accurate one, and `close` is the only
  // one that fires when the spawn itself failed and there was never a process.
  child.once('exit', untrack);
  child.once('close', untrack);
}

/** Spawn, feed stdin, collect stdout/stderr, and never hang. */
function run(
  bin: string,
  args: string[],
  o: RunOptions,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: o.env as NodeJS.ProcessEnv,
      ...(o.cwd ? { cwd: o.cwd } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, so the kills below reach what the backend
      // spawned and not only the backend. Not `unref`ed: this promise is still
      // waiting on it. See the block above for the Ctrl-C half of this.
      detached: true,
    });
    // From here until it exits, this child is potsherd's to kill.
    trackBackend(child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killBackendTree(child);
      reject(
        new LlmError(
          `${path.basename(bin)} did not answer within ${Math.round(o.timeoutMs / 1000)}s`,
          `POTSHERD_LLM_TIMEOUT_MS=${DEFAULT_TIMEOUT_MS * 2} potsherd card …`,
          undefined,
          { timedOut: true },
        ),
      );
    }, o.timeoutMs);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killBackendTree(child);
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
            undefined,
            { stdout },
          ),
        );
        return;
      }
      resolve({ stdout, stderr, code: code ?? 0 });
    });

    // A child that exits before it drains stdin makes this write fail. On
    // macOS that is silent; on Linux it raises EPIPE, and an unhandled EPIPE
    // on a stream takes the whole process down. The exit code and stderr are
    // what we actually report on, so the failed write is not interesting —
    // but it must be caught, or `codex exec` refusing early kills potsherd
    // rather than producing an error the user can act on.
    child.stdin.on('error', () => { /* the child is gone; `close` reports it */ });
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
  /** Per call. Default {@link DEFAULT_TIMEOUT_MS}, or `POTSHERD_LLM_TIMEOUT_MS`. */
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
  /**
   * True when {@link inputTokens} is potsherd's own chars ÷
   * {@link CHARS_PER_TOKEN} estimate because the backend's number was not
   * believable. See {@link IMPLAUSIBLE_TOKEN_FACTOR}.
   */
  inputTokensEstimated: boolean;
  /** Likewise: no backend number at all, so the reply's length was counted. */
  outputTokensEstimated: boolean;
  usd: number;
  ms: number;
  /** How many secrets were masked on the way out. */
  redactions: number;
  /** False on the subscription paths: `usd` is an api-equivalent. */
  chargeable: boolean;
}

/**
 * How far below our own estimate a backend's input-token count may fall
 * before we stop believing it.
 *
 * The agent SDK's `usage.input_tokens` counts the **uncached** tokens of the
 * final turn only. Everything potsherd sends is a cache write, so the number
 * it reports is a constant 10 whatever the prompt: a 198-call run over 2M
 * characters reported **1,980 input tokens** in total (`04`, 21 aug 2026).
 * That is not a small error, it is a different quantity wearing the same
 * name, and printing it in a column headed "input tokens" is exactly the
 * confidently-wrong number this project exists not to print.
 *
 * So: below one tenth of what the characters say, the backend's number is
 * discarded for our estimate and the result says which one it is. An order of
 * magnitude is deliberately loose — real tokenisation differs from chars ÷ 3.6
 * by tens of percent, never by 1,000× — so a backend that counts honestly is
 * always believed.
 */
export const IMPLAUSIBLE_TOKEN_FACTOR = 10;

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

/**
 * The per-call deadline, **fitted to the measurements in `CALL_PROFILES`**.
 *
 * The old value was 120 s and it was not fitted to anything. T2.6 then
 * measured what a card call actually costs — 58.9 s to 94.9 s serial, 191 s to
 * 204 s each when six run at once — so 120 s cut through the middle of a
 * normal distribution, and the verifier's default-settings run duly lost **28
 * of 90 ghosts and 1 of 1 session** to `did not answer within 120s`. The same
 * session carded in 25.9 s once the deadline was raised. A default that fails
 * a third of a normal run is not a safety net, it is the largest bug in the
 * product.
 *
 * The number below is derived, not chosen:
 *
 * ```
 *   the largest call potsherd can make      60,000 chars   (slice.ts's
 *                                                           SLICE_THRESHOLD_CHARS
 *                                                           — above it, chunking)
 *   the fit, serially                       46,200 + 915 x 60  = 101 s
 *   x the measured concurrency stretch      204 s / 84 s        = 2.43
 *   x the fit's own worst residual          +15%
 *   ------------------------------------------------------------------
 *   worst credible call at concurrency 6                      = 282 s
 * ```
 *
 * Rounded up to **360 s**, which leaves 28% of headroom over that worst case
 * and is the value the verifier's own 360 s run was proved against. It is not
 * larger than that on purpose: past this point a call is not slow, it is
 * wedged, and the run should say so rather than wait all afternoon.
 *
 * A deadline reached is now a **retry**, not a lost card — see
 * {@link Llm.text} — so the cost of being wrong in the tight direction is one
 * extra call rather than one missing card. `POTSHERD_LLM_TIMEOUT_MS` still
 * overrides it, and `Llm.open({ timeoutMs })` still overrides that.
 */
export const DEFAULT_TIMEOUT_MS = 360_000;

/**
 * How many times a call that ran out of clock is tried again.
 *
 * One. A second deadline on the same prompt is evidence about the prompt or
 * the machine, not about luck, and a run that retries forever is a run that
 * never finishes. The retry is the cheap half of D1's fix: with it, a
 * mis-fitted deadline costs a call, and without it, it costs a card.
 */
export const TIMEOUT_RETRIES = 1;
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
        : choice.backend === 'claude-cli'
          ? new ClaudeCliTransport({
              env,
              bin: env['POTSHERD_CLAUDE_BIN'] || choice.bin || 'claude',
              ...(opts.tmpRoot ? { tmpRoot: opts.tmpRoot } : {}),
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
    // The reservation is held for exactly the window between here and
    // `record`, which is the window in which a concurrent worker would
    // otherwise have seen a spend that had not happened yet. `settled` makes
    // the `finally` a no-op once `record` has already dropped it.
    const reservation = this.budget.admit({
      usd:
        (inTokens / 1e6) * price.inputPerMTok +
        (maxOutputTokens / 1e6) * price.outputPerMTok,
      tokens: inTokens + maxOutputTokens,
    });

    try {
      return await this.call(req, {
        outgoing,
        ...(system ? { system: system.text } : {}),
        maxOutputTokens,
        inTokens,
        price,
        redactions,
        reservation,
      });
    } finally {
      // Idempotent: a call that reached `record` released it there. A call
      // that threw — no backend, a deadline, a refusal, an abort — releases it
      // here, so a failure never leaves budget held against the cap forever.
      reservation.release();
    }
  }

  /** The body of {@link text}, split out so the reservation can be released in one place. */
  private async call(
    req: LlmRequest,
    ctx: {
      outgoing: string;
      system?: string;
      maxOutputTokens: number;
      inTokens: number;
      price: (typeof PRICES)[keyof typeof PRICES];
      redactions: number;
      reservation: Reservation;
    },
  ): Promise<LlmResult> {
    const { outgoing, system, maxOutputTokens, inTokens, price, redactions } = ctx;
    const started = Date.now();
    const sent = await this.send(
      {
        prompt: outgoing,
        ...(system ? { system } : {}),
        model: this.model,
        maxOutputTokens,
        timeoutMs: this.timeoutFor(req),
        ...(req.signal ? { signal: req.signal } : {}),
      },
      req.signal,
    );
    const ms = Date.now() - started;

    const outputTokensEstimated = typeof sent.outputTokens !== 'number' || sent.outputTokens <= 0;
    const outputTokens = outputTokensEstimated
      ? tokensForText(sent.text)
      : (sent.outputTokens as number);

    // Prefer the backend's own count — except when it is not a count of the
    // thing it is named after. See IMPLAUSIBLE_TOKEN_FACTOR.
    const reportedIn = sent.inputTokens;
    const inputTokensEstimated =
      typeof reportedIn !== 'number' ||
      reportedIn <= 0 ||
      reportedIn * IMPLAUSIBLE_TOKEN_FACTOR < inTokens;
    const inputTokens = inputTokensEstimated ? inTokens : (reportedIn as number);

    const usd =
      sent.usd ??
      (inputTokens / 1e6) * price.inputPerMTok + (outputTokens / 1e6) * price.outputPerMTok;

    const result: LlmResult = {
      text: sent.text,
      backend: this.backend,
      model: sent.model ?? this.model,
      inputTokens,
      outputTokens,
      inputTokensEstimated,
      outputTokensEstimated,
      usd,
      ms,
      redactions,
      chargeable: this.chargeable,
    };
    // Drops the estimate and writes the actual in one step.
    this.budget.record(result, ctx.reservation);
    return result;
  }

  /**
   * The transport call, with {@link TIMEOUT_RETRIES} retries on a deadline.
   *
   * Only on a deadline. Every other failure — no binary, no key, a refusal, a
   * cancelled run — is a fact about the call that trying again cannot change,
   * and retrying it would double the time the user waits for the same error.
   * A cancellation from the caller's own signal is never a retry either: the
   * budget ceiling aborts the run through exactly that signal, and a retry
   * there would spend past the line the abort exists to hold.
   */
  private async send(req: SendRequest, outer?: AbortSignal): Promise<SendResult> {
    let last: unknown;
    for (let attempt = 0; attempt <= TIMEOUT_RETRIES; attempt++) {
      try {
        return await this.transport.send(req);
      } catch (err) {
        last = err;
        const timedOut = err instanceof LlmError && err.timedOut;
        if (!timedOut || outer?.aborted || attempt === TIMEOUT_RETRIES) throw err;
      }
    }
    throw last;
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

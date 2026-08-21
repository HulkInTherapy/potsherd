import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

import type { Db } from './db.js';
import type { Harness } from './adapters/types.js';
import { resolveSession, showSession, type ShowResult } from './browse.js';
import { readCard, type StoredCard } from './cards/write.js';
import { PROMPTS_ONLY } from './cards/ghost.js';
import { projectName } from './recall.js';
import { recall } from './recall.js';
import {
  CHARS_PER_TOKEN,
  emptySpend,
  tokensForText,
  type Backend,
  type Llm,
  type Spend,
} from './llm.js';
import { MASK_RE } from './redact.js';
import { ELISION_RE } from './redact-elide.js';

/**
 * `graft` — one session from a month ago, compressed to fit in a live agent's
 * context window, with citations that were checked in code.
 *
 * `plans/05` calls this moment 5, "the magic": the user runs one command and
 * the agent visibly knows a thing from a month ago in another project. The
 * whole trick is that the brief is **short, cited, and honest about its
 * budget**, and each of those three is enforced here rather than requested of
 * the model:
 *
 *   - **short** — {@link enforceBudget} measures the finished brief and trims
 *     it until it is under `--budget`. A model asked for 1,200 tokens returns
 *     1,900 often enough that "asked nicely" is not a ceiling. The number the
 *     verb prints is the number of the text that was written to disk.
 *   - **cited** — every `[id8@seq]` in the reply is resolved against the index
 *     ({@link resolveCitations}). One that names an exchange that does not
 *     exist is removed, and any line left with no surviving citation is
 *     dropped. `03`'s ground rule is *cited or dropped*, and a compression call
 *     paraphrasing beyond its evidence is the default failure of this shape.
 *   - **honest** — `tokens` is `est.` unless the api path counted it, and
 *     {@link GraftResult.estimated} says which. This project shipped a
 *     "7m 26s" estimate before a 55-minute run; a token count that is quietly
 *     an estimate is the same bug in a smaller box.
 *
 * ## It works on a plane
 *
 * A re-entry verb that needs the network is a re-entry verb that does not work
 * when you most want it. With no backend — or with `--no-model` — `graft`
 * still writes a brief, assembled from the card in code, labelled
 * `unsummarised (no model call)` in its own header. The citations in that path
 * come from the card's own `evidence_seq`, which `cards/verify.ts` already
 * resolved once, and are resolved again here anyway.
 *
 * ## Ghosts
 *
 * A ghost is a session Claude Code deleted: `history.jsonl` kept the prompts
 * and nothing kept the replies. A brief built from one that did not say so
 * would imply the assistant's side is known when it is not, so the ghost
 * banner is written in code above the body and is never something the model
 * can omit.
 */

// ------------------------------------------------------------------ shape

export interface GraftCitation {
  id8: string;
  seq: number;
  /** Whether that `id8@seq` names an exchange (or ghost prompt) that exists. */
  resolves: boolean;
}

export interface GraftResult {
  sessionId: string;
  id8: string;
  project: string;
  harness: Harness;
  about: string | null;
  exchanges: number;
  date: string;
  budget: number;
  tokens: number;
  /** True when `tokens` is chars/3.6 rather than a count from the api. */
  estimated: boolean;
  brief: string;
  path: string;
  clipped: boolean;
  citations: GraftCitation[];
  spend: Spend;
  ms: number;
}

/** How a brief got made, for the receipt and for the report. */
export type GraftPath = 'model' | 'card-only';

export interface GraftOptions {
  /** `--about <topic>`: slice the transcript to the exchanges about this. */
  about?: string | null;
  /** `--budget <n>`: a hard ceiling on the finished brief. */
  budget?: number;
  /** `--clip`: copy to the system clipboard, failing softly. */
  clip?: boolean;
  /** Where `./.potsherd/` goes. Defaults to the process's cwd. */
  cwd?: string;
  /** Set false to compute a brief without touching the filesystem (tests). */
  write?: boolean;
  /**
   * The model. Omit and `graft` runs the card-only path — which is also what
   * happens when the caller has no backend at all.
   */
  llm?: Llm | null;
  /** potsherd root, so `recall`'s embedder is found under `--potsherd-dir`. */
  root?: string;
  /** Exchanges to pull for `--about`. Default {@link ABOUT_K}. */
  k?: number;
  /** Injected for tests; the real one shells out to pbcopy/xclip/wl-copy. */
  clipboard?: (text: string) => ClipOutcome;
  /** Injected for tests; the real one is `Date`. */
  now?: Date;
}

export interface ClipOutcome {
  ok: boolean;
  /** `pbcopy`, `xclip`, `wl-copy`, or null when none was found. */
  tool: string | null;
  /** One printable line when `ok` is false. Never an error. */
  note?: string;
}

/** `--budget`'s default, from `plans/phases/phase-4` T4.3. */
export const DEFAULT_BUDGET = 1_200;

/** Exchanges pulled for `--about`. Three is what a brief can quote from. */
export const ABOUT_K = 6;

/**
 * Exchanges pulled when there is **no** `--about` and **no** card (T4.7a G1).
 *
 * `graft <session>` with neither used to build a prompt out of a header, a
 * title and a list of rules — no session content whatsoever — and then write
 * the model's inevitable refusal (*"I don't have access to the session
 * material…"*) to disk as the user's re-entry brief. The plan's own
 * verification command, `graft "instagram client" --clip`, takes that path, so
 * the refusal went to the clipboard too.
 *
 * The guard against sending an empty prompt is {@link hasMaterial}. This
 * constant is the better half of the fix: rather than falling back to the
 * card-only path on a cardless session — which produces a brief, but an
 * unsummarised one — `collectSource` selects the **tail** of the session, and
 * the model gets a real brief to write. Recency rather than salience because
 * there is no topic to be salient about, and because "where did I leave off"
 * is the question a re-entry brief with no topic is being asked.
 *
 * Eight rather than {@link ABOUT_K}'s six: with no card and no topic this is
 * the *only* material in the prompt, and at {@link SLICE_CHARS} a piece the
 * ceiling is still well under a compression call's comfortable input.
 */
export const RECENT_K = 8;

/** Below this a budget cannot hold a source line and one bullet. */
export const MIN_BUDGET = 60;

/**
 * `4c9339e0@12` — the citation the brief carries inline, wherever it appears.
 *
 * Deliberately **not** anchored to its brackets. The canonical shape is
 * `[4c9339e0@12]`, and that is what the prompt asks for, but a model that has
 * two exchanges to cite writes `[4c9339e0@24, 4c9339e0@158]` about a third of
 * the time — and a bracket-anchored pattern matches neither of those, so the
 * whole line reads as *uncited* and sails past the check untouched. That is
 * the worst possible outcome for this regex: not a dropped citation, an
 * unchecked one. Matching the `id8@seq` token itself catches every form.
 *
 * **The seq is `\d+`, not `\d{1,7}` (T4.7a G7).** The bounded form did not
 * refuse an eight-digit seq — it *truncated* it: `[4c9339e0@12345678]` matched
 * only the first seven digits and `--json` then reported
 * `{"seq":1234567,"resolves":false}`, a number that appears nowhere in the
 * brief and nowhere in the transcript. A fabricated citation invented by the
 * checker is strictly worse than the fabricated citation it was checking.
 * Unbounded digits mean the whole seq is read, found not to exist, and
 * dropped; {@link citationResolves} rejects anything that is not a safe
 * integer, so a 400-digit seq is `false` rather than `Infinity`.
 */
export const CITATION_RE = /([0-9a-f]{6,40})@(\d+)/gi;

/**
 * `[4c9339e0@24, 158]` → `[4c9339e0@24, 4c9339e0@158]` (T4.7a G6).
 *
 * T4.3 taught the citation pattern to see `[id8@24, id8@158]`, and it does.
 * But a model that has written the id once shortens the second reference about
 * as often as it repeats it — `[id8@24, 158]` and `[id8@24, @158]` are both
 * common — and neither `158` nor `@158` is an `id8@seq` token. So `158` was
 * *displayed inside the citation group*, never checked against the index, and
 * absent from `GraftResult.citations` entirely. That is the exact failure T4.3
 * named as worse than a dropped citation: an unchecked one, printed.
 *
 * Rewriting the shorthand into the canonical form before the check is what
 * makes the rest of the pass work unchanged — the expanded citation is
 * resolved, reported, and cut out of the text with everything else if it does
 * not exist. The brief carries the expanded form, which is what the reader
 * should have been shown in the first place.
 *
 * Only a group whose **first** item is a full `id8@seq` is touched, and only
 * items that are bare digits (optionally `@`-prefixed) and nothing else are
 * expanded — so `[a, 1, b]` and `[see 4]` are left exactly as they are.
 */
export function expandCitationGroups(line: string): string {
  return line.replace(/\[([^\][\n]{0,400})\]/g, (whole, inner: string) => {
    const lead = /^\s*([0-9a-f]{6,40})@\d+/i.exec(inner);
    if (!lead) return whole;
    const id8 = lead[1] as string;
    const expanded = inner.replace(
      /(,\s*)@?(\d+)(?=\s*(?:,|$))/g,
      (_m, sep: string, seq: string) => `${sep}${id8}@${seq}`,
    );
    return `[${expanded}]`;
  });
}

/**
 * The one line every brief ends with, and the reason a pasted brief is still
 * attributable three tools later.
 *
 * **On a ghost the noun is `prompts`, not `exchanges` (T4.5 / D2).** `03` §8
 * specifies this line as `· <n> exchanges ·` unconditionally, and that spec is
 * wrong for a deleted session: the brief's own opening blockquote says
 * *"prompts only. This session was deleted; `history.jsonl` kept what the user
 * asked and nothing kept what the assistant answered"*, and then three lines
 * later the mandated last line claimed 241 exchanges of a session that has
 * none. An exchange is a prompt **and** a reply; a ghost kept only the prompt.
 * The receipt in `render/graft.ts` already annotates its `exchanges` row with
 * *"prompts only — the assistant side is gone"*, so this brings the brief's
 * last line into line with the receipt the same run prints. The spec
 * correction is logged with the orchestrator.
 *
 * Non-ghost wording is unchanged, singular included.
 */
export function sourceLine(o: {
  harness: string;
  sessionId: string;
  exchanges: number;
  date: string;
  /** True when the source is a ghost, in which case `exchanges` counts prompts. */
  isGhost?: boolean;
}): string {
  const n = o.exchanges;
  const noun = o.isGhost ? 'prompt' : 'exchange';
  return `source: ${o.harness} ${o.sessionId} · ${n} ${noun}${n === 1 ? '' : 's'} · ${o.date}`;
}

// --------------------------------------------------------------- counting

export interface TokenCount {
  tokens: number;
  /** False only when the api actually counted them. */
  estimated: boolean;
}

/**
 * The number the acceptance criterion is measured against.
 *
 * *"measure with the sdk's count_tokens when on api path; chars/3.6
 * otherwise"* — so this returns the flag as well as the number, and every
 * surface that prints the number prints the flag beside it.
 *
 * The api path is the only one that can count: the agent-sdk and codex
 * transports speak to a harness, not to `/v1/messages/count_tokens`, and their
 * own usage numbers describe the *call*, not this string. Asking them would be
 * inventing a measurement, which is the thing `05`'s honesty contract exists
 * to forbid.
 */
export async function countTokens(
  text: string,
  o: { backend?: Backend; model?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<TokenCount> {
  const fallback = { tokens: tokensForText(text), estimated: true };
  if (o.backend !== 'api') return fallback;
  const env = o.env ?? process.env;
  const apiKey = env['ANTHROPIC_API_KEY'];
  if (!apiKey) return fallback;
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey, maxRetries: 1 });
    const counted = await client.messages.countTokens({
      model: o.model ?? 'claude-haiku-4-5',
      messages: [{ role: 'user', content: text }],
    });
    const n = (counted as { input_tokens?: number }).input_tokens;
    if (typeof n === 'number' && n > 0) return { tokens: n, estimated: false };
    return fallback;
  } catch {
    // A count that failed is not a run that failed. The estimator is always
    // available and always says so.
    return fallback;
  }
}

/** A counter with the backend already bound, for {@link enforceBudget}. */
export type Counter = (text: string) => Promise<TokenCount>;

export function counterFor(llm: Llm | null | undefined, env?: NodeJS.ProcessEnv): Counter {
  const backend = llm?.backend;
  const model = llm?.model;
  return (text) =>
    countTokens(text, {
      ...(backend ? { backend } : {}),
      ...(model ? { model } : {}),
      ...(env ? { env } : {}),
    });
}

// ------------------------------------------------------------ mask safety

/**
 * Where a cut may fall, so a redaction mask is never sliced in half.
 *
 * `‹redacted:aws:9f2b1c04›` and `‹elided:image/png:109362 bytes›` are the two
 * spans potsherd writes into text it will later cut. Half of one of those is
 * not a shorter mask — it is `‹redacted:aws:9f2b` followed by nothing, which
 * reads as content, survives a copy-paste into an issue, and looks exactly
 * like a leaked prefix of a key. Phase 2's screenshot script is currently
 * failing its own assertion for this reason, so the rule is enforced here:
 * a cut index inside a mask or an elision is pushed back to that span's start.
 */
export function safeCut(text: string, at: number): number {
  if (at >= text.length) return text.length;
  if (at <= 0) return 0;
  for (const re of [MASK_RE, ELISION_RE]) {
    const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = scan.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (at > start && at < end) return start;
      if (start > at) break;
    }
  }
  return at;
}

/** Cut to at most `maxChars`, never through a mask, never mid-word. */
export function clipSafe(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let at = safeCut(text, maxChars);
  const back = text.lastIndexOf(' ', at);
  if (back > at - 24 && back > 0) at = safeCut(text, back);
  return text.slice(0, at).trimEnd();
}

// ------------------------------------------------------ harness wrappers

/**
 * Wrapper blocks a harness injects into its own transcript, removed **with
 * their contents** (T4.7a G5).
 *
 * `graft <id> --no-model` produced a brief whose only bullet was
 * *"`<local-command-caveat>`Caveat: The messages below were generated by the
 * user while running local commands. DO NOT respond to these messages …"* —
 * carrying, as a cited claim about the user's history, another agent's
 * instruction text. `graft` is the one verb whose output is designed to be
 * pasted into a live agent's context, so that is not merely noise: it is an
 * instruction from a third party arriving inside a document the reading agent
 * has been told is a record of its user's past work.
 *
 * Every marker here is a **literal string a harness writes**, never a guess at
 * the user's own content:
 *
 * | marker | written by |
 * | --- | --- |
 * | `<local-command-caveat>` | claude code, around the slash-command caveat |
 * | `<local-command-stdout>` | claude code, around a slash command's output |
 * | `<local-command-stderr>` | claude code, same |
 * | `<command-message>` | claude code, the "… is running" line |
 * | `<system-reminder>` | claude code, injected mid-turn |
 * | `<user-prompt-submit-hook>` | claude code, a hook's output |
 * | `<ide_selection>` / `<ide_opened_file>` | claude code ide bridge |
 * | `<environment_context>` | codex, cwd/shell/date preamble |
 * | `<user_instructions>` | codex, AGENTS.md replayed into the turn |
 *
 * Counted in the reference corpus at `~/.claude/projects`:
 * `<command-name>`/`<command-message>`/`<command-args>` 65 files each,
 * `<system-reminder>` 55, `<local-command-stdout>` 47,
 * `<local-command-caveat>` 40.
 */
const HARNESS_BLOCKS: readonly string[] = [
  'local-command-caveat',
  'local-command-stdout',
  'local-command-stderr',
  'command-message',
  'system-reminder',
  'user-prompt-submit-hook',
  'ide_selection',
  'ide_opened_file',
  'environment_context',
  'user_instructions',
];

/**
 * Wrappers whose **contents are the user's own** — the slash command they
 * typed and its arguments. The tag is harness syntax and goes; the text
 * inside it is what the user did and stays. Removing the whole block here
 * would be the "guessing at user content" the brief forbids.
 */
const HARNESS_UNWRAP: readonly string[] = ['command-name', 'command-args', 'command-contents'];

/**
 * The caveat's prose, for the case where the tag did not survive the adapter.
 * A literal, verbatim harness sentence — 39 occurrences in the reference
 * corpus, against 40 for the tag that carries it.
 */
const CAVEAT_PROSE_RE =
  /Caveat:\s*The messages below were generated by the user while running local commands\.[^\n]*/gi;

/**
 * Take a harness's own scaffolding out of text on its way into a brief.
 *
 * Deliberately narrow. It removes named blocks and named tags and the one
 * literal caveat sentence, and it touches nothing else — a transcript that
 * happens to discuss `<system-reminder>` in prose keeps every word of that
 * discussion, because only a real open/close pair is matched.
 */
export function stripHarnessBoilerplate(text: string): string {
  if (!text) return text;
  let out = text;
  for (const tag of HARNESS_BLOCKS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), ' ');
    // A block the adapter truncated mid-way leaves an opening tag with no
    // close. The opener is still harness syntax; drop the tag, keep the rest.
    out = out.replace(new RegExp(`</?${tag}\\b[^>]*>`, 'gi'), ' ');
  }
  for (const tag of HARNESS_UNWRAP) {
    out = out.replace(new RegExp(`</?${tag}\\b[^>]*>`, 'gi'), ' ');
  }
  out = out.replace(CAVEAT_PROSE_RE, ' ');
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// -------------------------------------------------------------- citations

/**
 * Resolve every `[id8@seq]` the brief carries, and take out the ones that lie.
 *
 * `plans/phases/phase-4` T4.3's acceptance is two words long — *citations
 * resolve* — and the only way to mean it is to check them after the model has
 * spoken. A compression call that reads well while citing seq 47 of a session
 * with 31 exchanges is the failure this catches, and `EVIDENCE_COSINE` exists
 * in `cards/verify.ts` because that failure is the *default* behaviour of this
 * shape, not an unlucky one.
 *
 * The rule is `00-README.md`'s: **cited or dropped**. An unresolvable citation
 * is removed from the text, and a line left holding no resolving citation goes
 * with it — because what remains would be an uncited claim about the user's
 * own history, which is precisely what this project refuses to emit. Every
 * citation the model wrote is still reported in {@link GraftResult.citations},
 * with `resolves` telling the truth about each.
 */
export interface CitationPass {
  text: string;
  citations: GraftCitation[];
  /** Lines removed because nothing in them resolved. */
  droppedLines: string[];
}

export function resolveCitations(db: Db, text: string, o: { sessionId?: string } = {}): CitationPass {
  const seen = new Map<string, boolean>();
  const citations: GraftCitation[] = [];

  const check = (id8: string, seq: number): boolean => {
    const key = `${id8.toLowerCase()}@${seq}`;
    const cached = seen.get(key);
    if (cached !== undefined) return cached;
    const ok = citationResolves(db, id8, seq, o.sessionId);
    seen.set(key, ok);
    citations.push({ id8: id8.toLowerCase(), seq, resolves: ok });
    return ok;
  };

  const lines = text.split('\n');
  const kept: string[] = [];
  const droppedLines: string[] = [];

  for (const line of lines) {
    // A model handed the template `[<id8>@<seq>]` sometimes returns it
    // verbatim, placeholder and all. `<seq>` is not a number, so nothing below
    // would match it, and the bullet would read as *uncited* — kept, unchecked,
    // and carrying a citation that is visibly not one. Strip the placeholder
    // first and let the bullet rule below decide the line's fate.
    const cleaned = line.replace(/\[?\s*[0-9a-f]{6,40}@<[^>\]]*>\s*\]?/gi, '').trimEnd();
    const found = [...cleaned.matchAll(new RegExp(CITATION_RE.source, 'gi'))];
    let anyResolved = false;
    let out = cleaned;
    for (const m of found) {
      const ok = check(m[1] as string, Number(m[2]));
      if (ok) anyResolved = true;
      else out = out.replace(m[0], '');
    }
    out = tidyBrackets(out);

    if (!anyResolved) {
      // `00-README.md`: **cited or dropped.** A *claim* with no citation left
      // standing does not get printed — and a bullet is always a claim. Prose
      // and headings are not (the card-only path's summary and its `**decided**`
      // rule are potsherd's own text, not an assertion about the transcript),
      // so those survive and only a bullet is held to the rule.
      if (isClaim(cleaned)) {
        if (cleaned.trim()) droppedLines.push(cleaned.trim());
        continue;
      }
      kept.push(out);
      continue;
    }
    kept.push(out.replace(/[ \t]{2,}/g, ' ').trimEnd());
  }

  return { text: kept.join('\n'), citations, droppedLines };
}

/**
 * A line that asserts something about the transcript, and therefore owes a
 * citation. Every list item is one; a heading or a paragraph of potsherd's own
 * prose is not.
 */
function isClaim(line: string): boolean {
  return /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line);
}

/**
 * Clean up after a citation was cut out of a bracket group.
 *
 * Removing `4c9339e0@158` from `[4c9339e0@24, 4c9339e0@158]` leaves
 * `[4c9339e0@24, ]`, and removing both leaves `[, ]`. Neither is something a
 * reader should ever see, and the empty pair is worse than the stray comma:
 * it looks like a citation that failed to render rather than one that was
 * never true.
 */
function tidyBrackets(line: string): string {
  return line
    .replace(/,\s*(?=[,\]])/g, '')
    .replace(/\[\s*,\s*/g, '[')
    .replace(/\s*,\s*\]/g, ']')
    .replace(/\[\s*\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trimEnd();
}

function citationResolves(db: Db, id8: string, seq: number, expected?: string): boolean {
  if (!Number.isInteger(seq) || seq < 0) return false;
  const needle = id8.toLowerCase();
  // The common case by far: the model cited the session it was given.
  if (expected && expected.toLowerCase().startsWith(needle)) {
    return seqExists(db, expected, seq);
  }
  const escaped = needle.replace(/[\\%_]/g, (c) => `\\${c}`);
  const row = db
    .prepare(
      `SELECT id FROM sessions WHERE id LIKE ? ESCAPE '\\'
       UNION ALL
       SELECT session_id AS id FROM ghosts WHERE session_id LIKE ? ESCAPE '\\'
       LIMIT 8`,
    )
    .all(`${escaped}%`, `${escaped}%`) as { id: string }[];
  return row.some((r) => seqExists(db, r.id, seq));
}

function seqExists(db: Db, sessionId: string, seq: number): boolean {
  const ex = db
    .prepare('SELECT 1 AS ok FROM exchanges WHERE session_id = ? AND seq = ? LIMIT 1')
    .get(sessionId, seq) as { ok: number } | undefined;
  if (ex) return true;
  const gp = db
    .prepare('SELECT 1 AS ok FROM ghost_prompts WHERE session_id = ? AND seq = ? LIMIT 1')
    .get(sessionId, seq) as { ok: number } | undefined;
  return Boolean(gp);
}

// ----------------------------------------------------------------- budget

export interface BudgetPass {
  brief: string;
  tokens: number;
  estimated: boolean;
  /** Body lines removed to get under the ceiling. */
  trimmed: number;
}

/**
 * The ceiling, enforced after the fact.
 *
 * `--budget` is a promise about what will be pasted into someone's context
 * window, and a promise the code does not check is a hope. A model asked for
 * 1,200 tokens returns 1,900 often enough that the over-budget path is the
 * normal path, not the exceptional one — so this trims, from the end of the
 * body, one line at a time, re-measuring after each cut, and never touches the
 * header or the `source:` line. Those two are what make the brief citable at
 * all; a brief trimmed into anonymity is worse than a brief that says it was
 * trimmed.
 *
 * When the header and the source line alone will not fit — a `--budget 20` —
 * the last resort is a mask-safe character cut, which is the only case where
 * a brief comes back without its trailer.
 */
export async function enforceBudget(o: {
  head: string[];
  body: string[];
  tail: string[];
  budget: number;
  count: Counter;
}): Promise<BudgetPass> {
  const body = [...o.body];
  let trimmed = 0;

  const assemble = (note: boolean): string => {
    const parts = [...o.head];
    if (body.length) parts.push('', ...body);
    if (note) parts.push('', `_trimmed ${trimmed} line${trimmed === 1 ? '' : 's'} to fit --budget ${o.budget}._`);
    parts.push('', ...o.tail);
    return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  };

  let text = assemble(false);
  let measured = await o.count(text);
  if (measured.tokens <= o.budget) {
    return { brief: text, tokens: measured.tokens, estimated: measured.estimated, trimmed: 0 };
  }

  // Trim by the **estimator**, verify with the **counter**.
  //
  // On the api path `count` is a network round trip, and one per dropped line
  // would turn a reply that came back 3x too long into forty of them. The
  // estimator is free, so it picks the cut; the counter only has to agree at
  // the end. `drift` is how far apart the two were on this exact text, so the
  // estimator aims at a target scaled to the counter's own view rather than at
  // a number it is systematically wrong about. On the subscription path the
  // two are the same function, `drift` is 1, and this is one measurement.
  for (let round = 0; round < 8 && body.length > 0; round++) {
    const drift = measured.tokens / Math.max(1, tokensForText(text));
    const target = o.budget / Math.min(2, Math.max(0.5, drift));
    while (body.length > 0 && tokensForText(assemble(trimmed > 0)) > target) {
      body.pop();
      trimmed += 1;
    }
    text = assemble(trimmed > 0);
    measured = await o.count(text);
    if (measured.tokens <= o.budget) {
      return { brief: text, tokens: measured.tokens, estimated: measured.estimated, trimmed };
    }
  }

  // Nothing left to drop and still over: the budget is smaller than the
  // header. Cut characters, and never through a mask.
  const perToken = CHARS_PER_TOKEN;
  let chars = Math.max(1, Math.floor(o.budget * perToken));
  for (let attempt = 0; attempt < 6; attempt++) {
    const cut = clipSafe(text, chars).trimEnd() + '\n';
    measured = await o.count(cut);
    if (measured.tokens <= o.budget) {
      return { brief: cut, tokens: measured.tokens, estimated: measured.estimated, trimmed };
    }
    chars = Math.max(1, Math.floor(chars * 0.8));
    text = cut;
  }
  return { brief: text, tokens: measured.tokens, estimated: measured.estimated, trimmed };
}

// ------------------------------------------------------------- the source

interface Target {
  sessionId: string;
  kind: 'session' | 'ghost';
  /** How the target was named: an id the user typed, or a query we ranked. */
  via: 'id' | 'query';
}

export class GraftError extends Error {
  readonly name = 'GraftError';
  constructor(message: string, readonly fix: string) {
    super(message);
  }
}

/**
 * A session id, a prefix of one, or a query — whichever the user typed.
 *
 * The id form goes through `browse.resolveSession`, the same resolver `show`,
 * `tag`, `pin` and `link` use, so `potsherd graft 4c9339e0` and
 * `potsherd show 4c9339e0` can never disagree about which session that is.
 * Only when that finds nothing does this fall through to `recall`, which is
 * the query form the spec asks for: *"a session id, or a query (then the top
 * session)"*.
 */
export async function resolveTarget(db: Db, target: string, o: { root?: string } = {}): Promise<Target> {
  const needle = target?.trim() ?? '';
  if (!needle) throw new GraftError('graft needs a session id or a query', 'potsherd graft 4c9339e0');

  const direct = resolveSession(db, needle);
  if (direct && !direct.ambiguous) return { sessionId: direct.id, kind: direct.kind, via: 'id' };

  const found = await recall(db, needle, {}, { limit: 1, ...(o.root ? { root: o.root } : {}) });
  const top = found.sessions[0];
  if (!top) {
    if (direct?.ambiguous) {
      throw new GraftError(
        `"${needle}" matches ${direct.ambiguous.length} sessions`,
        `potsherd graft ${direct.ambiguous[0]!.id}`,
      );
    }
    throw new GraftError(
      `nothing in the index matches "${needle}"`,
      'potsherd find "' + needle + '"    # widen the words, then graft the id',
    );
  }
  return { sessionId: top.id, kind: top.kind, via: 'query' };
}

/** What goes into the prompt, and what the card-only path renders directly. */
export interface GraftSource {
  sessionId: string;
  show: ShowResult;
  card: StoredCard | null;
  isGhost: boolean;
  id8: string;
  /**
   * The exchanges that reach the prompt, in seq order.
   *
   * Populated by `--about` when there is a topic, and — since T4.7a G1 — by
   * the {@link RECENT_K} recency default when there is **neither** a topic nor
   * a card, which used to leave the prompt with no session content at all.
   * {@link sliceVia} says which.
   */
  slice: { seq: number; ts: string | null; text: string }[];
  /**
   * How {@link slice} was chosen: the `--about` topic, the recency default, or
   * `null` when it is empty. The card-only path keys off this, so that a
   * default slice — material selected for the *model*, both sides of each
   * exchange — is not mistaken for a topic the user actually asked for.
   */
  sliceVia: 'about' | 'recent' | null;
  /** Exchanges (or prompts) the whole session holds. */
  exchanges: number;
  date: string;
  harness: Harness;
  project: string;
  title: string;
}

/** How much of one exchange reaches the prompt. Longer than this is a log. */
export const SLICE_CHARS = 1_800;

export async function collectSource(
  db: Db,
  sessionId: string,
  o: { about?: string | null; k?: number; root?: string } = {},
): Promise<GraftSource> {
  const show = showSession(db, sessionId);
  if (!show) {
    throw new GraftError(
      `session ${sessionId.slice(0, 8)} is in the index but has no body`,
      'potsherd index --full',
    );
  }
  const isGhost = show.session.status === 'ghost' || Boolean(show.ghostPrompts);
  const card = readCard(db, sessionId);
  const id8 = sessionId.slice(0, 8);

  const slice: GraftSource['slice'] = [];
  let sliceVia: GraftSource['sliceVia'] = null;
  const about = o.about?.trim();
  if (about) {
    const hits = await recall(
      db,
      about,
      { sessionId },
      { limit: 1, perSession: Math.max(1, o.k ?? ABOUT_K), ...(o.root ? { root: o.root } : {}) },
    );
    const wanted = hits.hits.filter((h) => h.sessionId === sessionId && typeof h.seq === 'number');
    for (const h of wanted.slice(0, o.k ?? ABOUT_K)) {
      const user = h.userText?.trim() ?? '';
      const assistant = h.assistantText?.trim() ?? '';
      const text = isGhost
        ? user
        : [user && `you: ${user}`, assistant && `agent: ${assistant}`].filter(Boolean).join('\n');
      slice.push({
        seq: h.seq as number,
        ts: h.ts ?? null,
        text: clipSafe(stripHarnessBoilerplate(text), SLICE_CHARS),
      });
    }
    slice.sort((a, b) => a.seq - b.seq);
    sliceVia = slice.length ? 'about' : null;
  } else if (!card) {
    // **T4.7a G1.** No topic and no card used to mean *no material*: the
    // prompt was a header, a title and a list of rules, and the model could
    // only reply "I don't have access to the session material…" — which
    // `via === 'model'` then wrote to disk, and `--clip` put on the
    // clipboard, as the user's re-entry brief.
    //
    // The tail of the session is what a brief with no topic is being asked
    // for: *where did I leave off*. No embedder and no query are involved, so
    // this works offline, with `--no-embed`, and on a session `recall` has
    // never scored.
    const units = show.ghostPrompts
      ? show.ghostPrompts.map((p) => ({ seq: p.seq, ts: p.ts, user: p.text, assistant: '' }))
      : show.exchanges.map((e) => ({
          seq: e.seq,
          ts: e.ts,
          user: e.userText ?? '',
          assistant: e.assistantText ?? '',
        }));
    for (const u of units.slice(-Math.max(1, o.k ?? RECENT_K))) {
      const user = u.user.trim();
      const assistant = u.assistant.trim();
      const text = isGhost
        ? user
        : [user && `you: ${user}`, assistant && `agent: ${assistant}`].filter(Boolean).join('\n');
      const cleaned = clipSafe(stripHarnessBoilerplate(text), SLICE_CHARS);
      if (cleaned) slice.push({ seq: u.seq, ts: u.ts, text: cleaned });
    }
    slice.sort((a, b) => a.seq - b.seq);
    sliceVia = slice.length ? 'recent' : null;
  }

  const s = show.session;
  const when = s.endedAt ?? s.startedAt ?? null;
  return {
    sessionId,
    show,
    card,
    isGhost,
    id8,
    slice,
    sliceVia,
    exchanges: show.total,
    date: when ? when.slice(0, 10) : 'unknown date',
    harness: s.harness,
    project: projectName(s.project),
    title: s.displayTitle,
  };
}

// ------------------------------------------------------------- the prompt

export const GRAFT_SYSTEM =
  'You compress one past coding session into a re-entry brief for a different agent ' +
  'that has never seen it. You are not summarising for a human reader; you are handing ' +
  'a colleague the facts they need to continue work.';

/**
 * The one call.
 *
 * Two instructions do the work and both are about citations. Every factual
 * line must carry `[id8@seq]`, and the model is told the exact seq numbers it
 * is allowed to use — because a model that is not given the list invents
 * plausible ones, and {@link resolveCitations} then deletes the line it wrote.
 * Telling it the legal set up front is cheaper than throwing the answer away.
 */
export function buildPrompt(src: GraftSource, o: { about?: string | null; budget: number }): string {
  // **T4.7a G1, the backstop.** `graft()` never gets here without material,
  // because it checks {@link hasMaterial} first and takes the card-only path
  // instead. This throw is what makes "never sends a prompt with no session
  // content" a property of the function rather than of one caller: a prompt
  // with nothing in it can only produce a refusal, and a refusal written to
  // `./.potsherd/graft-<id8>.md` is worse than no file at all.
  if (!hasMaterial(src)) {
    throw new GraftError(
      `session ${src.id8} has no indexed material to compress`,
      `potsherd index --full    # then: potsherd graft ${src.id8}`,
    );
  }
  const lines: string[] = [];
  const about = o.about?.trim();
  // The budget the model is asked for is under the ceiling, because the trim
  // that follows is a fallback, not the plan.
  const askFor = Math.max(80, Math.floor(o.budget * 0.75));

  lines.push(`Session ${src.id8} · ${src.harness} · project ${src.project || 'unknown'} · ${src.date}`);
  lines.push(`Title: ${src.title}`);
  if (src.isGhost) {
    lines.push(
      'THIS SESSION IS A GHOST: only the user prompts survive. The assistant side was deleted ' +
        'and is not recoverable. Never state what the assistant answered, decided or did.',
    );
  }
  lines.push('');

  if (src.card) {
    const c = src.card.card;
    lines.push('## card');
    if (c.summary) lines.push(c.summary);
    if (c.decisions.length) {
      lines.push('', 'decisions:');
      for (const d of c.decisions) {
        lines.push(`- ${d.what}${d.why ? ` — ${d.why}` : ''}  seq ${d.evidence_seq.join(', ')}`);
      }
    }
    if (c.open_threads.length) {
      lines.push('', 'open threads:');
      for (const t of c.open_threads) lines.push(`- ${t.what}  seq ${t.evidence_seq.join(', ')}`);
    }
    if (c.files.length) lines.push('', `files: ${c.files.join(', ')}`);
    if (c.topics.length) lines.push(`topics: ${c.topics.join(', ')}`);
    lines.push('', `outcome: ${c.outcome}${src.card.source === PROMPTS_ONLY ? ' (prompts only)' : ''}`);
    lines.push('');
  }

  if (src.slice.length) {
    // Without a topic the heading used to interpolate `undefined` into
    // `## exchanges about "undefined"`, because this branch was unreachable
    // with no `--about` before G1 gave it a recency default.
    lines.push(
      about
        ? `## exchanges about "${about}"`
        : `## the last ${src.slice.length} exchange${src.slice.length === 1 ? '' : 's'} of the session`,
    );
    for (const ex of src.slice) {
      lines.push('', `[seq ${ex.seq}${ex.ts ? ` · ${ex.ts.slice(0, 10)}` : ''}]`, ex.text);
    }
    lines.push('');
  }

  const legal = legalSeqs(src);
  lines.push('## your task');
  lines.push(
    about
      ? `Write a re-entry brief about "${about}", drawn only from the material above.`
      : 'Write a re-entry brief, drawn only from the material above.',
  );
  lines.push(
    `Hard rules:`,
    `- At most ${askFor} tokens. Shorter is better. No preamble, no sign-off, no headings.`,
    `- Markdown bullets only, one fact per bullet.`,
    `- Every bullet ends with a citation: a literal open bracket, ${src.id8}, an at sign, the seq number, a close bracket. ` +
      `Write the actual number. A bullet you send with the word "seq" still in it will be deleted.`,
    `- Two sources on one bullet are written as two separate bracket pairs, never inside one pair.`,
    legal.length
      ? `- The ONLY legal seq numbers are: ${legal.join(', ')}. A bullet you cannot cite from that list is a bullet you must not write.`
      : `- You have no seq numbers to cite. Write nothing but the single line: NONE.`,
    `- State decisions and open threads. Do not restate the title.`,
    src.isGhost
      ? `- Say nothing about what the assistant replied; only what the user asked for.`
      : `- Prefer what was decided and why over what was tried.`,
    `- No secrets. Text of the form ‹redacted:…› is a mask; copy it verbatim or leave it out.`,
  );
  return lines.join('\n');
}

/**
 * Whether there is anything to compress (T4.7a G1).
 *
 * The two things {@link buildPrompt} can put session content into a prompt
 * from are the card and the slice. With neither, everything the model sees is
 * potsherd's own scaffolding — a session header, a title, and the rules — and
 * the *only* honest reply to that prompt is a refusal. `graft` shipped for a
 * phase writing exactly such refusals to disk as briefs, so this predicate is
 * checked in two places rather than one: here, before the call is made, and
 * inside {@link buildPrompt}, which throws rather than return an empty prompt.
 */
export function hasMaterial(src: GraftSource): boolean {
  return Boolean(src.card) || src.slice.length > 0;
}

function legalSeqs(src: GraftSource): number[] {
  const out = new Set<number>();
  for (const ex of src.slice) out.add(ex.seq);
  if (src.card) {
    for (const d of src.card.card.decisions) for (const s of d.evidence_seq) out.add(s);
    for (const t of src.card.card.open_threads) for (const s of t.evidence_seq) out.add(s);
  }
  if (out.size === 0) {
    // No topic and no card: offer the first and last few exchanges, which is
    // what a brief with nothing else to go on can honestly cite.
    const seqs = src.show.exchanges.map((e) => e.seq);
    const prompts = src.show.ghostPrompts?.map((p) => p.seq) ?? [];
    for (const s of [...seqs, ...prompts].slice(0, 12)) out.add(s);
  }
  return [...out].sort((a, b) => a - b).slice(0, 40);
}

// ---------------------------------------------------------- the card path

/**
 * The brief with no model in it.
 *
 * `RULINGS`: if the compression call is unavailable, `graft` produces a brief
 * from the card alone rather than failing, *clearly labelled as unsummarised*.
 * Nothing here is written by a model, so nothing here can be a paraphrase: the
 * bullets are the card's own verified claims with their own `evidence_seq`
 * turned into `[id8@seq]`, and they go through the same citation pass as the
 * model path's do.
 */
export function cardOnlyBody(src: GraftSource): string[] {
  const out: string[] = [];
  const cite = (seqs: readonly number[]): string =>
    seqs.length ? ` ${seqs.map((s) => `[${src.id8}@${s}]`).join(' ')}` : '';

  if (!src.card) {
    const units = src.show.ghostPrompts
      ? src.show.ghostPrompts.map((p) => ({ seq: p.seq, text: p.text }))
      : src.show.exchanges.map((e) => ({ seq: e.seq, text: e.userText }));
    const chosen = src.slice.length
      ? src.slice.map((s) => ({ seq: s.seq, text: s.text }))
      : units.slice(0, 8);
    for (const u of chosen) {
      // T4.7a G5: `units` is raw transcript, so a harness wrapper reaches this
      // path when `--about` matched nothing and there is no card. The slice is
      // already stripped in `collectSource`; stripping twice is a no-op.
      const text = clipSafe(stripHarnessBoilerplate(u.text).replace(/\s+/g, ' ').trim(), 200);
      if (text) out.push(`- ${text} [${src.id8}@${u.seq}]`);
    }
    return out;
  }

  const c = src.card.card;
  if (c.summary.trim()) out.push(c.summary.trim());
  if (c.decisions.length) {
    out.push('', '**decided**');
    for (const d of c.decisions) {
      out.push(`- ${d.what}${d.why ? ` — ${d.why}` : ''}${cite(d.evidence_seq)}`);
    }
  }
  if (c.open_threads.length) {
    out.push('', '**left open**');
    for (const t of c.open_threads) out.push(`- ${t.what}${cite(t.evidence_seq)}`);
  }
  if (src.slice.length) {
    out.push('', '**from the transcript**');
    for (const ex of src.slice) {
      const text = clipSafe(ex.text.replace(/\s+/g, ' ').trim(), 220);
      if (text) out.push(`- ${text} [${src.id8}@${ex.seq}]`);
    }
  }
  if (c.files.length) out.push('', `files: ${c.files.slice(0, 8).map((f) => `\`${f}\``).join(', ')}`);
  return out;
}

// ------------------------------------------------------------------ paths

/** `./.potsherd` in the working directory — the one write outside `~/.potsherd`. */
export function graftDir(cwd: string = process.cwd()): string {
  return path.join(cwd, '.potsherd');
}

export function graftPath(id8: string, cwd: string = process.cwd()): string {
  return path.join(graftDir(cwd), `graft-${id8}.md`);
}

/**
 * The line `potsherd doctor --privacy` needs from this phase.
 *
 * `03` §11: *`potsherd doctor --privacy` lists every path read and every path
 * written*. `graft` adds a write path that is **not** under `~/.potsherd` — it
 * is in the user's current project, which is the entire point of the verb —
 * and a privacy receipt that omits it is under-reporting. `doctor --privacy`
 * once said "no network" after the product had started calling a model; this
 * constant exists so the same omission cannot happen twice.
 */
export const GRAFT_WRITE_PATH_NOTE = './.potsherd/graft-<id8>.md  (the current directory, when you run graft)';

const GITIGNORE_BODY = [
  '# written by `potsherd graft`. these are briefs cut from your own past',
  '# sessions; they are yours, but they are not source, so they are ignored.',
  '*',
  '',
].join('\n');

/**
 * Create `./.potsherd/.gitignore`, and **never clobber one that exists.**
 *
 * A user who has written their own rules into that file has said something
 * about their repository, and a memory tool that silently overwrites it has
 * done the one thing `00-README.md`'s first ground rule forbids in a different
 * directory. If the file is there, it is left exactly as it is.
 */
export function ensureGraftDir(cwd: string = process.cwd()): { dir: string; wroteGitignore: boolean } {
  const dir = graftDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  if (fs.existsSync(ignore)) return { dir, wroteGitignore: false };
  fs.writeFileSync(ignore, GITIGNORE_BODY, { mode: 0o600 });
  return { dir, wroteGitignore: true };
}

// -------------------------------------------------------------- clipboard

const CLIP_TOOLS: readonly { bin: string; args: string[] }[] = [
  { bin: 'pbcopy', args: [] },
  { bin: 'wl-copy', args: [] },
  { bin: 'xclip', args: ['-selection', 'clipboard'] },
  { bin: 'xsel', args: ['--clipboard', '--input'] },
];

/**
 * `--clip`, failing softly.
 *
 * The spec's parenthesis is the whole design: *(pbcopy/xclip/wl-copy, fail
 * softly)*. No clipboard tool on the machine is not an error — the brief is
 * already on disk and already on screen, and exiting non-zero over a missing
 * `xclip` would fail a run that did everything the user asked. It prints a
 * note and moves on.
 */
export function copyToClipboard(text: string): ClipOutcome {
  for (const tool of CLIP_TOOLS) {
    // No shell. `spawnSync(bin, args, { shell: true })` is how a filename with
    // a space in it becomes two arguments, and node deprecated it (DEP0190)
    // for exactly that reason. A binary that is not installed comes back as
    // ENOENT here, which is the probe.
    const r = spawnSync(tool.bin, tool.args, { input: text, encoding: 'utf8' });
    const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') continue;
    if (!r.error && r.status === 0) return { ok: true, tool: tool.bin };
    return {
      ok: false,
      tool: tool.bin,
      note: `${tool.bin} did not take it (${r.error?.message ?? `exit ${r.status ?? '?'}`}) — the brief is on disk either way`,
    };
  }
  return {
    ok: false,
    tool: null,
    note: 'no clipboard tool found (pbcopy, wl-copy, xclip, xsel) — the brief is on disk',
  };
}

// ------------------------------------------------------------------ graft

/** Everything the renderer needs beyond {@link GraftResult}. */
export interface GraftReport extends GraftResult {
  /** `model` or `card-only`. `05`'s honesty contract: say which produced it. */
  via: GraftPath;
  /** Why the card-only path was taken, when it was. */
  reason: string | null;
  isGhost: boolean;
  title: string;
  /** Body lines the budget pass removed. */
  trimmed: number;
  /** Lines removed because every citation on them was invented. */
  droppedLines: string[];
  clip: ClipOutcome | null;
  wroteGitignore: boolean;
}

export async function graft(db: Db, target: string, o: GraftOptions = {}): Promise<GraftReport> {
  const started = Date.now();
  const budget = Math.max(MIN_BUDGET, Math.floor(o.budget ?? DEFAULT_BUDGET));
  const about = o.about?.trim() || null;
  const cwd = o.cwd ?? process.cwd();
  const write = o.write !== false;

  const resolved = await resolveTarget(db, target, o.root ? { root: o.root } : {});
  const src = await collectSource(db, resolved.sessionId, {
    about,
    ...(o.k !== undefined ? { k: o.k } : {}),
    ...(o.root ? { root: o.root } : {}),
  });

  const llm = o.llm ?? null;
  const count = counterFor(llm);
  let via: GraftPath = 'card-only';
  let reason: string | null = null;
  let raw = '';
  let spend: Spend = emptySpend();

  // **T4.7a G1.** A model handed a prompt with no session content in it can
  // only refuse, and `via = 'model'` would write that refusal out as the
  // brief. `collectSource` now gives a cardless, topic-less session the tail
  // of its own transcript, so this is reached only by a session that has no
  // card, no exchanges and no ghost prompts — for which the honest answer is
  // the card-only path saying so, not a model call that cannot succeed.
  if (llm && !hasMaterial(src)) {
    reason = 'the session has no indexed material to compress — nothing was sent to a model';
  } else if (llm) {
    try {
      const r = await llm.text({
        prompt: buildPrompt(src, { about, budget }),
        system: GRAFT_SYSTEM,
        // The ceiling is enforced after the fact anyway; this is the guard
        // against a model that decides to write an essay.
        maxOutputTokens: Math.max(256, Math.floor(budget * 1.5)),
        label: 'graft',
      });
      raw = r.text.trim();
      spend = llm.spend;
      if (raw && raw.toUpperCase() !== 'NONE') via = 'model';
      else {
        reason = 'the model found nothing it could cite';
        raw = '';
      }
    } catch (err) {
      // A brief that needs the network is a brief that does not work on a
      // plane. Fall back to the card, and say so on the face of the brief.
      reason = `the model call failed (${(err as Error)?.message ?? String(err)})`;
      spend = llm.spend;
      raw = '';
    }
  } else {
    reason = 'no model was used';
  }

  const bodyLines = via === 'model' ? raw.split('\n') : cardOnlyBody(src);
  const pass = resolveCitations(db, bodyLines.join('\n'), { sessionId: src.sessionId });

  const head = buildHead(src, { about, via, reason, budget });
  const tail = buildTail(src, pass);
  const budgeted = await enforceBudget({
    head,
    body: pass.text.split('\n').filter((l, i, a) => !(l.trim() === '' && a[i - 1]?.trim() === '')),
    tail,
    budget,
    count,
  });

  let outPath = graftPath(src.id8, cwd);
  let wroteGitignore = false;
  if (write) {
    const dir = ensureGraftDir(cwd);
    wroteGitignore = dir.wroteGitignore;
    fs.writeFileSync(outPath, budgeted.brief, { mode: 0o600 });
  } else {
    outPath = '';
  }

  let clip: ClipOutcome | null = null;
  if (o.clip) clip = (o.clipboard ?? copyToClipboard)(budgeted.brief);

  return {
    sessionId: resolved.sessionId,
    id8: src.id8,
    project: src.project,
    harness: src.harness,
    about,
    exchanges: src.exchanges,
    date: src.date,
    budget,
    tokens: budgeted.tokens,
    estimated: budgeted.estimated,
    brief: budgeted.brief,
    path: outPath,
    clipped: clip?.ok ?? false,
    citations: pass.citations,
    spend,
    ms: Date.now() - started,
    via,
    reason,
    isGhost: src.isGhost,
    title: src.title,
    trimmed: budgeted.trimmed,
    droppedLines: pass.droppedLines,
    clip,
    wroteGitignore,
  };
}

function buildHead(
  src: GraftSource,
  o: { about: string | null; via: GraftPath; reason: string | null; budget: number },
): string[] {
  const head: string[] = [];
  head.push(`# ${src.title}`);
  head.push('');
  head.push(
    o.about
      ? `Brief from a past session, about **${o.about}**. Written by potsherd; every claim carries \`[${src.id8}@seq]\`, the exchange it came from.`
      : `Brief from a past session. Written by potsherd; every claim carries \`[${src.id8}@seq]\`, the exchange it came from.`,
  );
  if (src.isGhost) {
    head.push('');
    head.push(
      '> **prompts only.** This session was deleted; `history.jsonl` kept what the user asked ' +
        'and nothing kept what the assistant answered. Nothing below describes the assistant ' +
        "side — it is not recoverable.",
    );
  }
  if (o.via === 'card-only') {
    head.push('');
    head.push(
      `> **unsummarised.** No model call was made${o.reason ? ` — ${o.reason}` : ''}. ` +
        'What follows is the stored card and transcript verbatim, not a summary.',
    );
  }
  return head;
}

function buildTail(src: GraftSource, pass: CitationPass): string[] {
  const tail: string[] = ['---', ''];
  const bad = pass.citations.filter((c) => !c.resolves).length;
  if (bad > 0) {
    tail.push(
      `_${bad} citation${bad === 1 ? '' : 's'} named an exchange this index does not have, ` +
        `and ${bad === 1 ? 'it was' : 'they were'} dropped._`,
      '',
    );
  }
  // Always the last line. `plans/phases/phase-4` T4.3, and it is what makes a
  // brief pasted into a third tool still attributable.
  tail.push(
    sourceLine({
      harness: src.harness,
      sessionId: src.sessionId,
      exchanges: src.exchanges,
      date: src.date,
      isGhost: src.isGhost,
    }),
  );
  return tail;
}

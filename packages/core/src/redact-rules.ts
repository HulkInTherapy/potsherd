/**
 * L2 redaction — the rule table.
 *
 * ## Provenance (read this before adding a rule)
 *
 * `plans/03-ARCHITECTURE.md` §5 and the reuse table in
 * `plans/02-STRATEGY-AND-VIRALITY.md` are explicit: **port rules, do not write
 * regexes from memory**. Every pattern below is a port of a published,
 * MIT-licensed detection rule, and each rule names its upstream rule id in
 * `source` and in the comment above it.
 *
 * Upstreams:
 *
 *   gitleaks — https://github.com/gitleaks/gitleaks
 *     rule pack: `cmd/generate/config/rules/*.go`, published as
 *     `config/gitleaks.toml`.
 *     Copyright (c) 2019 Zachary Rice. Licensed under the MIT License.
 *
 *   secretlint — https://github.com/secretlint/secretlint
 *     rule pack: `@secretlint/secretlint-rule-preset-recommend`, which bundles
 *     `-rule-aws`, `-rule-gcp`, `-rule-github`, `-rule-slack`, `-rule-npm`,
 *     `-rule-privatekey`, `-rule-basicauth`, `-rule-sendgrid`, `-rule-shopify`.
 *     Copyright (c) 2020 Secretlint. Licensed under the MIT License.
 *
 * Neither project's *runtime* is a dependency. secretlint's engine is async,
 * plugin-loading and file-oriented; this module has to be pure, synchronous and
 * cheap enough to run over the whole corpus during `potsherd index`. What is
 * taken is the rule knowledge — the part that must not be invented. See
 * the header of every rule below. The `NOTICE` entry for both packs lands with
 * T1.5, when this module is first wired into the index.
 *
 * ## What a rule is
 *
 * A scanner over a string returning the spans to mask, a `type` that appears in
 * the mask, and a stable `id`. Rules are applied in array order and the first
 * rule to claim a span wins (see `redact.ts`), so the order here is the
 * precedence order: key material, vendor tokens, credentials in urls, the
 * generic `KEY=` assignment, entropy last.
 *
 * `type` deliberately names a *family* (`aws`, `github`) and not the rule
 * (`aws-access-key-id`): it is user-visible inside the mask, so it stays short,
 * stable and legible in a search result. The rule id rides along on the hit,
 * for `doctor` and for debugging a false positive.
 */

/** The family name that appears in `‹redacted:<type>:<sha8>›`. */
export type SecretType =
  | 'aws'
  | 'gcp'
  | 'github'
  | 'slack'
  | 'stripe'
  | 'openai'
  | 'anthropic'
  | 'npm'
  | 'jwt'
  | 'private-key'
  | 'basic-auth'
  | 'generic'
  | 'entropy';

/** Every type, in the order `doctor` reports them. */
export const SECRET_TYPES: readonly SecretType[] = [
  'aws',
  'gcp',
  'github',
  'slack',
  'stripe',
  'openai',
  'anthropic',
  'npm',
  'jwt',
  'private-key',
  'basic-auth',
  'generic',
  'entropy',
] as const;

/** One span of text a rule wants masked. */
export interface RuleMatch {
  start: number;
  end: number;
  value: string;
}

export interface Rule {
  /** Stable id, reported on the hit and used in tests. */
  id: string;
  type: SecretType;
  /** Upstream rule this was ported from, with its licence. */
  source: string;
  /** Pure: same input, same output, no state carried between calls. */
  scan(text: string): RuleMatch[];
}

// ---------------------------------------------------------------- entropy

/**
 * Shannon entropy in bits per character. `03` §5 fixes the threshold at 4.5
 * over tokens of ≥ 20 characters.
 *
 * Worth knowing before either number is tuned: entropy measured on a sample of
 * length n cannot exceed log2(n), so a 20-character token can never reach 4.5
 * (log2(20) = 4.32) and nothing shorter than 23 characters can trip this rule
 * at all. That is why 40-char hex git shas (alphabet cap 4.0) and uuids pass
 * through untouched — the threshold in `03` is self-limiting by design.
 */
export function shannonEntropy(s: string): number {
  const n = s.length;
  if (n === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

export const ENTROPY_MIN_LENGTH = 20;
export const ENTROPY_THRESHOLD = 4.5;

// ---------------------------------------------------------------- allowlists

/**
 * Spans that are never a secret and must not be scanned at all. Ported in
 * spirit from gitleaks' `[[rules.allowlist]] regexes` and secretlint's `allows`
 * option (both MIT).
 *
 * A base64 data URI is the worst false positive in a coding transcript: an
 * inlined PNG is tens of kilobytes of maximum-entropy base64 that no rule could
 * tell from a key. It is excluded by construction rather than by lowering a
 * threshold that would then start missing real keys.
 */
export const ALLOW_SPANS: RegExp[] = [
  // data: URIs — `data:image/png;base64,iVBORw0KGgo…`
  /\bdata:[a-zA-Z0-9!#$&^_.+-]*(?:\/[a-zA-Z0-9!#$&^_.+-]*)?(?:;[a-zA-Z0-9-]+=[^;,\s]*)*;base64,[A-Za-z0-9+/=]{20,}(?:\s+[A-Za-z0-9+/=]{20,})*/g,
  // Subresource Integrity — `integrity="sha384-oqVuAfXRKap7fdgcCY5uykM6+R9…"`
  /\bsha(?:256|384|512)-[A-Za-z0-9+/]{20,}={0,3}/g,
];

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const HEX_RE = /^[0-9a-fA-F]+$/;
const NUMERIC_RE = /^[0-9_+-]+$/;

// -------------------------------------------------- entropy-rule exclusions
//
// Each of these answers a false-positive class *measured* on the reference
// corpus by `scripts/redaction-benchmark.mjs`, and each is named and commented
// so a future reader can audit — or delete — one of them on its own merits.
//
// The load-bearing property of all of them: they apply **only to a bare token
// the entropy rule found lying in the text with no context**. A value that is
// assigned to a secret-named key, sent in an `Authorization` header or put in
// a url's userinfo is claimed by a rule that runs earlier and never consults
// this list. So "exclude uuids" cannot let `API_KEY=<uuid>` through, and
// "exclude `toolu_…`" cannot let `ANTHROPIC_API_KEY=toolu_…` through. Both are
// planted cases in `tests/fixtures/secrets/planted.jsonl`.

/**
 * **E1 — minted object ids.** Model apis and agent harnesses stamp every
 * message, request, tool use and run with a random id under a fixed prefix.
 * They are the densest high-entropy shape in an agent transcript by an order
 * of magnitude — `toolu_014ZfaccgxvcYNpcTLq8qvkR` and its kin — and none of
 * them is a credential: they are handed out in api *responses*, they appear in
 * public logs, and they authorise nothing.
 *
 * Prefixes, and who mints them:
 *   toolu_ srvtoolu_ msg_ req_          anthropic messages api
 *   chatcmpl- fc_ call_ run_ step_
 *   thread_ asst_ resp_ evt_            openai
 *   exec- exec_ agent- sess_ session_   agent harnesses (claude code, codex)
 *   task_ job_ turn_ conv_ snapshot-    harness bookkeeping
 *
 * Deliberately *not* here: `sk_`, `rk_`, `ghp_`, `xoxb-`, `npm_`, `AKIA`,
 * `sk-ant-`, `tvly-` — every one of those prefixes means the opposite.
 */
const MINTED_ID_RE =
  /^(?:toolu|srvtoolu|msg|req|resp|call|fc|run|step|thread|asst|evt|sess|session|exec|job|task|turn|conv|agent|snapshot|chatcmpl)[-_]/i;

/**
 * **E5 — ULIDs.** 26 characters of Crockford base32, the first 10 encoding a
 * millisecond timestamp. log2(26) = 4.70, so a ULID can and does clear the 4.5
 * bar. Sortable ids, not secrets; the alphabet excludes I, L, O and U on
 * purpose, which is what makes the shape recognisable.
 */
const ULID_RE = /^[0-7][0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}$/;

/**
 * **E6 — prose wearing a token's clothes.** The single largest surviving false
 * positive on the reference corpus once images were elided: url slugs.
 *
 *     …%2Fy-combinator_reducto-has-just-raised-a-75m-series-b-activity-7383909473913880576-ba7M
 *
 * That is 87 characters over a wide alphabet, so its Shannon entropy is 4.9 —
 * comfortably "random" by the measure in `03` §5 — and it is a LinkedIn
 * permalink. Shannon entropy on a single short sample cannot tell *random*
 * from *varied*, and English is very varied.
 *
 * What separates them is **runs**. A base64 or base62 credential draws each
 * character independently, so a run of 7 consecutive same-case letters has
 * probability ≈ (26/64)^7 ≈ 1 in 900 per position; two disjoint such runs in
 * one 40-character token is well under 1%. English words are nothing but such
 * runs — `combinator`, `activity`, `whatsapp`, `killmonger`.
 *
 * So: two runs of ≥ 7 same-case letters, or one run of ≥ 12, and the token is
 * text. Both numbers were checked against the corpus rather than chosen: at
 * ≥ 7/×2 every tavily key, every planted secret and every base64 fixture value
 * survives (their longest same-case run is 4), and the slug class disappears.
 */
const SAMECASE_RUN_MIN = 7;
const SAMECASE_RUNS_NEEDED = 2;
const SAMECASE_RUN_ALONE = 12;

function looksLikeProse(token: string): boolean {
  let long = 0;
  for (const run of token.match(/[a-z]+|[A-Z]+/g) ?? []) {
    if (run.length >= SAMECASE_RUN_ALONE) return true;
    if (run.length >= SAMECASE_RUN_MIN) long += 1;
  }
  return long >= SAMECASE_RUNS_NEEDED;
}

/**
 * **E7 — alphabet constants.** `0123456789ABCDEFGHJKMNPQRSTVWXYZ` is the
 * Crockford base32 table; every base32/base58/base62 encoder in every codebase
 * declares one, and with no repeated character it scores a perfect log2(n)
 * entropy — the highest possible.
 *
 * The test is exactly "no character occurs twice". Drawing 24 characters from
 * a 62-character alphabet without a single repeat happens with probability
 * ≈ 1%, and from base64url's 64 with probability ≈ 1.4%; combined with the
 * 24-character floor and with the fact that a credential in any real context
 * is claimed by an earlier rule, this is a safe trade for a class that is
 * otherwise permanently unmaskable-looking.
 */
function looksLikeAlphabetConstant(token: string): boolean {
  return token.length >= 24 && new Set(token).size === token.length;
}

/**
 * Placeholder values. Ported from gitleaks' `stopwords` list and secretlint's
 * dummy-value handling, trimmed to the ones that actually occur in coding
 * transcripts. A value matching this is documentation, not a credential.
 */
const PLACEHOLDER_RE =
  /(?:^|[^a-z0-9])(?:x{3,}|your|my[-_]?(?:key|token|secret|pass)|example|sample|dummy|fake|mock|placeholder|change[-_]?(?:me|it|this)|replace[-_]?me|insert|todo|fixme|redacted|hidden|omitted|elided|not[-_]?real|no[-_]?such|hunter2|password|passwd|secret|token|apikey|api[-_]key|abcdef|123456|s3cret|letmein|foobar|lorem|ipsum)(?:$|[^a-z0-9])/i;

/** `${VAR}`, `{{var}}`, `%(var)s`, `<%= x %>`, `<your-key>`, `$VAR` … */
const INTERPOLATION_RE = /\$\{|\{\{|%\(|<%|^\$[A-Za-z_(]|^<|^\{|\}$|^%[A-Za-z(]/;

/** A reference to a value rather than the value: `process.env.X`, `cfg.token`. */
const REFERENCE_RE =
  /^(?:process\.env|import\.meta\.env|os\.environ|System\.getenv|Deno\.env|env|ENV|config|conf|cfg|settings|opts|options|args|argv|params|props|state|data|input|payload|body|req|res|ctx|context|self|this|that|obj|row|item|user|account|creds|credentials|secrets|vault|store|keychain)\b\s*[.[(]/;

/** A bare word with no digits — `hashedPassword`, `MY_SECRET`, `undefined`. */
const WORDY_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z_$]*$/;

/**
 * A dotted identifier chain — `crypto.randomBytes`, `formData.password`,
 * `settings.auth.token`. Code reaching for a value, not the value. Base64,
 * base64url and hex credentials never contain a `.`, and the ones that do
 * (jwts) have a rule of their own that runs first.
 */
const DOTTED_CHAIN_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;

/** A url or a filesystem path, not a credential. */
const PATHISH_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/|\.{0,2}\/|~\/|[A-Za-z]:\\)/;

/** Syntax that means the capture ran into code, not into a credential. */
const CODEY_RE = /[<>{}[\]()|\\;,&?!*"'`]/;

/** The mask itself, so a second pass recognises its own output. */
export const MASK_FRAGMENT_RE = /‹redacted:/;

/** English words ending in a keyword that never name a secret. */
const NAME_STOPWORDS = new Set([
  'monkey',
  'donkey',
  'turkey',
  'whiskey',
  'jockey',
  'hockey',
  'lackey',
  'mickey',
  'malarkey',
  'hotkey',
  'sortkey',
  'oauth',
]);

/**
 * Does this identifier name a secret? `apiKey`, `AWS_SECRET_ACCESS_KEY`,
 * `db.password`, `client_secret` yes; `tokenizer`, `keyboard`, `monkey` no.
 *
 * Ported from the keyword half of gitleaks' `generic-api-key` and tightened:
 * that rule allows the keyword anywhere inside a 50-character identifier, which
 * flags every `tokenizer:` and `keyboardShortcut:` line in a transcript. Here
 * the keyword has to be the identifier's last segment, splitting on `_ - . $`
 * and on camelCase humps.
 */
export function nameLooksLikeSecret(name: string): boolean {
  const segments = name
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return false;
  const lower = last.toLowerCase();
  if (NAME_STOPWORDS.has(lower)) return false;
  return /(?:key|token|secret|password|passwd|pwd|credential|auth)s?$/.test(lower);
}

/**
 * Is this assignment's value plausibly a real credential?
 *
 * The generic `KEY=` rule is where false positives come from, because every
 * codebase assigns to something called `token`. Everything rejected here is
 * something transcripts are full of: env lookups, template interpolations,
 * references to another variable, documentation placeholders, type
 * annotations, version numbers, paths.
 */
export function valueLooksLikeSecret(value: string): boolean {
  const v = value.trim();
  if (v.length < 10 || v.length > 200) return false;
  if (/\s/.test(v)) return false;
  if (MASK_FRAGMENT_RE.test(v)) return false;
  if (CODEY_RE.test(v)) return false;
  if (INTERPOLATION_RE.test(v)) return false;
  if (REFERENCE_RE.test(v)) return false;
  if (DOTTED_CHAIN_RE.test(v)) return false;
  if (PATHISH_RE.test(v)) return false;
  if (NUMERIC_RE.test(v)) return false;
  if (PLACEHOLDER_RE.test(v)) return false;
  // A bare word with no digits is a variable name or a sentence fragment, not
  // a 32-character credential.
  if (WORDY_IDENTIFIER_RE.test(v) && shannonEntropy(v) < 4.0) return false;
  // Filler: `****`, `------`, `0000000000`.
  if (new Set(v).size <= 2) return false;
  // gitleaks' generic-api-key requires 3.5 bits on the captured value. 3.2
  // here: potsherd masks a token in an index rather than failing a build, so a
  // marginal hit costs one unreadable word in a search result and a marginal
  // miss costs a leaked credential.
  if (shannonEntropy(v) < 3.2) return false;
  return true;
}

/**
 * Entropy-rule allowlist: shapes that are high-entropy but never secret.
 *
 * Every `return false` is an exclusion rule with a letter, defined above with
 * the class it was measured against. Read the block comment there before
 * adding, removing or relaxing one.
 *
 * This is consulted **only** by the bare-token entropy rule. It is not part of
 * `valueLooksLikeSecret`, so nothing here can excuse a value that appears in a
 * credential-shaped position.
 */
export function entropyCandidateAllowed(token: string): boolean {
  if (token.length < ENTROPY_MIN_LENGTH) return false;
  // E2 — uuids. Session ids, request ids, trace ids. Capped at 4.0 bits by
  // their alphabet anyway; excluded explicitly so the intent is readable.
  if (UUID_RE.test(token)) return false;
  // E2b — a uuid under a prefix: `exec-<uuid>`, `agent-<uuid>`, `snapshot-…`.
  if (UUID_RE.test(token.replace(/^[A-Za-z][A-Za-z0-9]{0,15}[-_]/, ''))) return false;
  // E3 — hex digests: git sha1s, sha256 sums, md5s, content hashes.
  if (HEX_RE.test(token)) return false;
  // E4 — a hex digest under a prefix (`sha256-…` without the SRI base64 body,
  // `blake3-…`, `md5-…`). The base64 SRI form is an ALLOW_SPAN, above.
  if (/^(?:sha1|sha256|sha384|sha512|md5|blake3|crc32|xxh64)[-_:]/i.test(token)) return false;
  if (NUMERIC_RE.test(token)) return false;
  if (MASK_FRAGMENT_RE.test(token)) return false;
  if (PLACEHOLDER_RE.test(token)) return false;
  if (MINTED_ID_RE.test(token)) return false;         // E1
  if (ULID_RE.test(token)) return false;              // E5
  if (looksLikeProse(token)) return false;            // E6
  if (looksLikeAlphabetConstant(token)) return false; // E7
  return true;
}

// ---------------------------------------------------------------- machinery

interface RegexRuleOptions {
  /** Capture group holding the bytes to mask. 0 = the whole match. */
  group?: number;
  /** Reject a candidate; returning false leaves the text untouched. */
  validate?: (value: string, m: RegExpExecArray) => boolean;
}

/** Build a scanning rule from one global regex. */
function regexRule(
  id: string,
  type: SecretType,
  source: string,
  re: RegExp,
  opts: RegexRuleOptions = {},
): Rule {
  const group = opts.group ?? 0;
  return {
    id,
    type,
    source,
    scan(text: string): RuleMatch[] {
      const out: RuleMatch[] = [];
      // A fresh regex per scan: a module-level `lastIndex` is shared state and
      // this module promises purity.
      const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      let m: RegExpExecArray | null;
      while ((m = rx.exec(text)) !== null) {
        if (m[0].length === 0) { rx.lastIndex++; continue; }
        const value = group === 0 ? m[0] : m[group];
        if (value === undefined || value.length === 0) continue;
        if (opts.validate && !opts.validate(value, m)) continue;
        const offset = group === 0 ? 0 : m[0].indexOf(value);
        if (offset < 0) continue;
        out.push({ start: m.index + offset, end: m.index + offset + value.length, value });
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------- the rules

/**
 * The generic `(KEY|TOKEN|SECRET|PASSWORD)\s*[=:]` rule from `03` §5, given the
 * shape of gitleaks' `generic-api-key`.
 *
 * It is written as a scanner rather than one regex for two reasons. Speed: a
 * pattern of the form `identifier{0,48}(keyword)[:=]` has to be retried at
 * every letter of a 10 MB corpus, while anchoring on the literal keyword lets
 * the engine skip. Correctness: only the *value* is masked, never the name, so
 * `TOKEN=‹redacted:generic:…›` still tells a reader which variable leaked.
 */
const GENERIC_ANCHOR =
  /(?:key|token|secret|password|passwd|pwd|credential|auth)s?["']?[ \t]*(?::=|=>|[:=])/gi;

const GENERIC_VALUE =
  // The bare alternative stops at a backslash on purpose: transcripts carry
  // json-escaped text, where `TOKEN=abc\nNEXT=…` is one line and the `\n` is
  // two literal characters. Without this the capture swallows the rest of the
  // record and the value is thrown out as code.
  /[ \t]*(?:"([^"\r\n]{10,200})"|'([^'\r\n]{10,200})'|`([^`\r\n]{10,200})`|([^\s"'`,;)\](}>\\]{10,200}))/y;

const NAME_CHAR_RE = /[A-Za-z0-9_$.-]/;

const genericAssignmentRule: Rule = {
  id: 'generic-assignment',
  type: 'generic',
  source: '03 §5, given the shape of gitleaks generic-api-key (MIT)',
  scan(text: string): RuleMatch[] {
    const out: RuleMatch[] = [];
    const anchor = new RegExp(GENERIC_ANCHOR.source, GENERIC_ANCHOR.flags);
    let m: RegExpExecArray | null;
    while ((m = anchor.exec(text)) !== null) {
      const opEnd = m.index + m[0].length;
      const opLen = /(?::=|=>)$/.test(m[0]) ? 2 : 1;
      const before = text[opEnd - opLen - 1] ?? '';
      // `==`, `===`, `!=`, `<=`, `>=`, `+=` are comparisons and compound
      // assignment, not `TOKEN=…`.
      if (text[opEnd] === '=' || (opLen === 1 && /[!<>+\-*/%&|^=]/.test(before))) continue;

      // Walk back over the identifier the keyword ends: `AWS_SECRET_ACCESS_KEY`.
      const keywordEnd = m.index + m[0].replace(/["']?[ \t]*(?::=|=>|[:=])$/, '').length;
      let nameStart = m.index;
      while (nameStart > 0 && NAME_CHAR_RE.test(text[nameStart - 1] ?? '')) nameStart--;
      const name = text.slice(nameStart, keywordEnd);
      if (!nameLooksLikeSecret(name)) continue;

      GENERIC_VALUE.lastIndex = opEnd;
      const v = GENERIC_VALUE.exec(text);
      if (!v) continue;
      const value = v[1] ?? v[2] ?? v[3] ?? v[4];
      if (value === undefined || !valueLooksLikeSecret(value)) continue;
      const start = v.index + v[0].lastIndexOf(value);
      out.push({ start, end: start + value.length, value });
      anchor.lastIndex = start + value.length;
    }
    return out;
  },
};

/**
 * `Authorization: Bearer <token>` — a credential *context* rather than a
 * credential *shape*.
 *
 * The rule exists to make the entropy exclusions above safe to hold. They all
 * assume that a value in a position that shouts "credential" is claimed by an
 * earlier rule; `KEY=`, `?token=` and `https://user:pw@` were already covered,
 * and the http authorization header was the hole. It matters more now than it
 * did before T1.4b: a `Bearer toolu_…`-shaped token is excluded by E1 as a
 * bare token, and must not be excluded here.
 *
 * The name is not masked, only the credential, so a redacted transcript still
 * says which scheme was used.
 */
const BEARER_RE =
  /(?:^|[^A-Za-z0-9_-])(?:Bearer|Token|ApiKey|Api-Key|Basic|DPoP)[ \t]+([A-Za-z0-9+/._~-]{16,512}={0,2})/g;

const bearerRule: Rule = regexRule(
  'authorization-bearer',
  'generic',
  '03 §5 (credential context), given the shape of gitleaks generic-api-key (MIT)',
  BEARER_RE,
  {
    group: 1,
    // Same value screen as the `KEY=` rule: `Bearer ${token}`, `Bearer <TOKEN>`
    // and `Bearer your-token-here` are documentation, not credentials.
    validate: (value) => valueLooksLikeSecret(value),
  },
);

/**
 * The entropy rule from `03` §5 — ≥ 4.5 bits over tokens of ≥ 20 characters —
 * written as a scanner rather than as one regex.
 *
 * `03` fixes the threshold and the length floor and both are honoured
 * unchanged. What T1.4b changed is **what counts as a token**, because that
 * was never specified and the naive reading was doing the damage:
 *
 *   1. `=` is base64 *padding*, so it is only a token character at the end.
 *      Before, `ANTHROPIC_VERTEX_PROJECT_ID=gpu-reservation-sarvam` was one
 *      "token" — a variable glued to its value — and scored 4.7.
 *   2. `/` and `.` remain separators, so a long path or a dotted hostname is
 *      not one token. (Unchanged from T1.4; the reasoning is that a real
 *      base64 secret containing `/` still leaves a ≥ 23-character run, and 23
 *      is the shortest string that can reach 4.5 bits at all.)
 *   3. Transcripts are json-inside-json, so the text often carries a *literal*
 *      backslash-n where a newline belongs. `\ntvly-dev-…` used to yield the
 *      token `ntvly-dev-…` — the same secret with a different first character,
 *      and therefore a different sha8 and a different mask. Escape residue is
 *      trimmed, which is a correctness fix for the "same secret, same mask"
 *      guarantee and not only a cosmetic one.
 *   4. Percent-escape residue (`%2F` leaving `2F…`) and leading/trailing
 *      separators are trimmed for the same reason.
 *
 * Shape exclusions live in {@link entropyCandidateAllowed}.
 */
const ENTROPY_TOKEN = /[A-Za-z0-9+_-]{20,}={0,2}/g;

/** Characters a `\x` json escape leaves glued to the front of a token. */
const ESCAPE_LETTERS = 'ntrbfv';

const highEntropyRule: Rule = {
  id: 'high-entropy-token',
  type: 'entropy',
  source: '03 §5 (4.5 bits / 20 chars) + gitleaks entropy allowlists (MIT)',
  scan(text: string): RuleMatch[] {
    const out: RuleMatch[] = [];
    const rx = new RegExp(ENTROPY_TOKEN.source, ENTROPY_TOKEN.flags);
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text)) !== null) {
      let start = m.index;
      let value = m[0];
      // `\n`, `\t`, `\r` written literally by an outer json encoder.
      if (start > 0 && text[start - 1] === '\\' && ESCAPE_LETTERS.includes(value[0] ?? '')) {
        start += 1;
        value = value.slice(1);
      }
      // `%2F`, `%3D` — the `%` is a separator, but the two hex digits that
      // complete the escape are not part of the token that follows it.
      if (start > 0 && text[start - 1] === '%' && /^[0-9A-Fa-f]{2}/.test(value)) {
        start += 2;
        value = value.slice(2);
      }
      // Leading and trailing separators belong to the surrounding text.
      const lead = value.length - value.replace(/^[-_+]+/, '').length;
      start += lead;
      value = value.slice(lead).replace(/[-_+]+$/, '');

      if (value.length < ENTROPY_MIN_LENGTH) continue;
      if (!entropyCandidateAllowed(value)) continue;
      if (shannonEntropy(value) < ENTROPY_THRESHOLD) continue;
      out.push({ start, end: start + value.length, value });
    }
    return out;
  },
};

export const RULES: Rule[] = [
  // ---- key material ------------------------------------------------------
  regexRule(
    // gitleaks `private-key`; secretlint `@secretlint/secretlint-rule-privatekey`.
    // The whole block is masked, header to footer: the base64 body alone would
    // otherwise be shredded into a dozen separate entropy hits.
    'private-key-block',
    'private-key',
    'gitleaks private-key / secretlint-rule-privatekey (MIT)',
    /-----BEGIN[ A-Z0-9]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,200000}?-----END[ A-Z0-9]{0,40}PRIVATE KEY(?: BLOCK)?-----/g,
  ),
  regexRule(
    // gitleaks `private-key`, unterminated variant: a transcript often quotes
    // the header and the first body lines and then elides the rest.
    //
    // The body is taken line by line and only where a line is ≥ 20 characters
    // of pure base64, so an unterminated header followed by prose masks the
    // header alone instead of swallowing the sentence after it. The separator
    // class carries the backslash so json-escaped `\n` works, and it is
    // disjoint from the base64 class, which is what keeps this linear.
    'private-key-header',
    'private-key',
    'gitleaks private-key (MIT)',
    /-----BEGIN[ A-Z0-9]{0,40}PRIVATE KEY(?: BLOCK)?-----(?:[\r\n \t\\]+[A-Za-z0-9+/=]{20,})*/g,
  ),
  regexRule(
    // gitleaks `jwt`: three base64url segments, the first two starting `ey`
    // (the base64 of `{"`). Session transcripts are full of these.
    'jwt',
    'jwt',
    'gitleaks jwt (MIT)',
    /\bey[A-Za-z0-9_-]{17,}\.ey[A-Za-z0-9_-]{17,}\.[A-Za-z0-9_-]{10,}={0,2}/g,
  ),

  // ---- vendor tokens -----------------------------------------------------
  regexRule(
    // gitleaks `aws-access-token`; secretlint-rule-aws `AWSAccessKeyID`.
    'aws-access-key-id',
    'aws',
    'gitleaks aws-access-token / secretlint-rule-aws (MIT)',
    /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g,
  ),
  regexRule(
    // secretlint-rule-aws `AWSSecretAccessKey`: a 40-character base64 value
    // bound to an AWS-flavoured name. Typed `aws` and placed before the generic
    // rule so `doctor` reports it as what it is.
    'aws-secret-access-key',
    'aws',
    'secretlint-rule-aws AWSSecretAccessKey (MIT)',
    /aws[_.-]?(?:secret|access)[_.-]?(?:access[_.-]?)?key(?:[_.-]?id)?["'\s]{0,4}[:=]["'\s]{0,4}([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
    { group: 1 },
  ),
  regexRule(
    // gitleaks `gcp-api-key`; secretlint-rule-gcp `GCPApiKey`.
    'gcp-api-key',
    'gcp',
    'gitleaks gcp-api-key / secretlint-rule-gcp (MIT)',
    /\bAIza[0-9A-Za-z_-]{35}\b/g,
  ),
  regexRule(
    // gitleaks `gcp-oauth-client-secret`.
    'gcp-oauth-client-secret',
    'gcp',
    'gitleaks gcp-oauth-client-secret (MIT)',
    /\bGOCSPX-[a-zA-Z0-9_-]{28}\b/g,
  ),
  regexRule(
    // gitleaks `github-pat` / `-oauth` / `-app-token` / `-refresh-token`;
    // secretlint-rule-github. ghp_ user, gho_ oauth, ghu_/ghs_ app, ghr_ refresh.
    'github-token',
    'github',
    'gitleaks github-pat / secretlint-rule-github (MIT)',
    /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
  ),
  regexRule(
    // gitleaks `github-fine-grained-pat`.
    'github-fine-grained-pat',
    'github',
    'gitleaks github-fine-grained-pat (MIT)',
    /\bgithub_pat_[0-9a-zA-Z_]{82}\b/g,
  ),
  regexRule(
    // gitleaks `slack-bot-token` / `-user-token` / `-app-token`;
    // secretlint-rule-slack.
    'slack-token',
    'slack',
    'gitleaks slack-bot-token / secretlint-rule-slack (MIT)',
    /\bxox[abprs]-[0-9a-zA-Z-]{10,72}\b/g,
  ),
  regexRule(
    // gitleaks `slack-webhook-url`; secretlint-rule-slack `SlackWebhook`.
    'slack-webhook',
    'slack',
    'gitleaks slack-webhook-url (MIT)',
    /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{6,}\/[A-Za-z0-9+/]{6,}\/[A-Za-z0-9+/]{6,}/g,
  ),
  regexRule(
    // gitleaks `stripe-access-token`. `pk_` publishable keys are public by
    // design and are deliberately not matched.
    'stripe-key',
    'stripe',
    'gitleaks stripe-access-token (MIT)',
    /\b(?:sk|rk)_(?:test|live|prod)_[A-Za-z0-9]{10,99}\b/g,
  ),
  regexRule(
    // gitleaks `anthropic-api-key`. Must precede the openai rules: both start
    // `sk-`, and whichever rule claims the span first wins.
    'anthropic-api-key',
    'anthropic',
    'gitleaks anthropic-api-key (MIT)',
    /\bsk-ant-(?:api|admin)[0-9]{2}-[A-Za-z0-9_-]{80,120}\b/g,
  ),
  regexRule(
    // gitleaks `openai-api-key`: the `T3BlbkFJ` infix is the base64 of
    // "OpenAI" and is what makes this rule safe to run over prose.
    'openai-api-key-project',
    'openai',
    'gitleaks openai-api-key (MIT)',
    /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}\b/g,
  ),
  regexRule(
    // gitleaks `openai-api-key`, legacy 48-character form with no infix.
    'openai-api-key-legacy',
    'openai',
    'gitleaks openai-api-key (MIT)',
    /\bsk-[A-Za-z0-9]{48}\b/g,
  ),
  regexRule(
    // gitleaks `npm-access-token`; secretlint-rule-npm.
    'npm-access-token',
    'npm',
    'gitleaks npm-access-token / secretlint-rule-npm (MIT)',
    /\bnpm_[A-Za-z0-9]{36}\b/g,
  ),

  // ---- credentials in urls -----------------------------------------------
  regexRule(
    // gitleaks `authenticated-url`; secretlint `-rule-basicauth`. Only the
    // password is masked: `postgres://app:‹redacted:basic-auth:…›@db:5432/x`
    // still says which host and which user, which is the point of an index that
    // stays searchable by shape.
    'basic-auth-url',
    'basic-auth',
    'gitleaks authenticated-url / secretlint-rule-basicauth (MIT)',
    // The user half is `{0,64}`: `redis://:hunter2@host` has an empty user and
    // is exactly as leaked as the two-part form.
    /\b[a-zA-Z][a-zA-Z0-9+.-]{1,20}:\/\/[^\s:@/]{0,64}:([^\s:@/]{1,128})@/g,
    {
      group: 1,
      validate: (value) => {
        if (INTERPOLATION_RE.test(value)) return false;
        if (PLACEHOLDER_RE.test(value)) return false;
        if (MASK_FRAGMENT_RE.test(value)) return false;
        if (/^(?:pass|pw|user|admin|root|test|guest|\*+|x+|\d{1,4})$/i.test(value)) return false;
        return true;
      },
    },
  ),

  // ---- credential context (03 §5) ----------------------------------------
  bearerRule,
  genericAssignmentRule,

  // ---- entropy (03 §5) ---------------------------------------------------
  // Last, so that anything a named rule understands is reported under its real
  // type and a bare token is the fallback rather than the default.
  highEntropyRule,
];

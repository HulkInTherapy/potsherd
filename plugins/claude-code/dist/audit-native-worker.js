import { createRequire as __potsherdCreateRequire } from 'node:module';
const require = __potsherdCreateRequire(import.meta.url);

// packages/core/src/analytics/scan-pool.ts
import { Worker, parentPort } from "node:worker_threads";

// packages/core/src/analytics/extract.ts
import fs from "node:fs";
import { createHash as createHash2 } from "node:crypto";
import path from "node:path";

// packages/core/src/markers.ts
var SUMMARIZER_CONTEXT_MARKER = "Context: This summary will be shown in a list to help users and Claude choose which conversations are relevant";
var POTSHERD_CARD_MARKER = "<INSTRUCTIONS-TO-POTSHERD>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-POTSHERD>";
var EXCLUSION_MARKERS = [
  "<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>",
  "Only use NO_INSIGHTS_FOUND",
  SUMMARIZER_CONTEXT_MARKER,
  POTSHERD_CARD_MARKER
];
function hasExclusionMarker(text) {
  return EXCLUSION_MARKERS.some((marker) => text.includes(marker));
}

// packages/core/src/redact.ts
import { createHash } from "node:crypto";

// packages/core/src/theme.ts
var ANSI_RE = new RegExp("\\u001b\\[[0-9;]*m", "g");

// packages/core/src/redact-rules.ts
function shannonEntropy(s) {
  const n = s.length;
  if (n === 0) return 0;
  const counts = /* @__PURE__ */ new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}
var ENTROPY_MIN_LENGTH = 20;
var ENTROPY_THRESHOLD = 4.5;
var ALLOW_SPANS = [
  // data: URIs — `data:image/png;base64,iVBORw0KGgo…`
  /\bdata:[a-zA-Z0-9!#$&^_.+-]*(?:\/[a-zA-Z0-9!#$&^_.+-]*)?(?:;[a-zA-Z0-9-]+=[^;,\s]*)*;base64,[A-Za-z0-9+/=]{20,}(?:\s+[A-Za-z0-9+/=]{20,})*/g,
  // Subresource Integrity — `integrity="sha384-oqVuAfXRKap7fdgcCY5uykM6+R9…"`
  /\bsha(?:256|384|512)-[A-Za-z0-9+/]{20,}={0,3}/g
];
var UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
var HEX_RE = /^[0-9a-fA-F]+$/;
var NUMERIC_RE = /^[0-9_+-]+$/;
var MINTED_ID_RE = /^(?:toolu|srvtoolu|msg|req|resp|call|fc|run|step|thread|asst|evt|sess|session|exec|job|task|turn|conv|agent|snapshot|chatcmpl)[-_]/i;
var ULID_RE = /^[0-7][0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}$/;
var SAMECASE_RUN_MIN = 7;
var SAMECASE_RUNS_NEEDED = 2;
var SAMECASE_RUN_ALONE = 12;
function looksLikeProse(token) {
  let long = 0;
  for (const run of token.match(/[a-z]+|[A-Z]+/g) ?? []) {
    if (run.length >= SAMECASE_RUN_ALONE) return true;
    if (run.length >= SAMECASE_RUN_MIN) long += 1;
  }
  return long >= SAMECASE_RUNS_NEEDED;
}
function looksLikeAlphabetConstant(token) {
  return token.length >= 24 && new Set(token).size === token.length;
}
var PLACEHOLDER_RE = /(?:^|[^a-z0-9])(?:x{3,}|your|my[-_]?(?:key|token|secret|pass)|example|sample|dummy|fake|mock|placeholder|change[-_]?(?:me|it|this)|replace[-_]?me|insert|todo|fixme|redacted|hidden|omitted|elided|not[-_]?real|no[-_]?such|hunter2|password|passwd|secret|token|apikey|api[-_]key|abcdef|123456|s3cret|letmein|foobar|lorem|ipsum)(?:$|[^a-z0-9])/i;
var INTERPOLATION_RE = /\$\{|\{\{|%\(|<%|^\$[A-Za-z_(]|^<|^\{|\}$|^%[A-Za-z(]/;
var REFERENCE_RE = /^(?:process\.env|import\.meta\.env|os\.environ|System\.getenv|Deno\.env|env|ENV|config|conf|cfg|settings|opts|options|args|argv|params|props|state|data|input|payload|body|req|res|ctx|context|self|this|that|obj|row|item|user|account|creds|credentials|secrets|vault|store|keychain)\b\s*[.[(]/;
var WORDY_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z_$]*$/;
var DOTTED_CHAIN_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;
var PATHISH_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/|\.{0,2}\/|~\/|[A-Za-z]:\\)/;
var CODEY_RE = /[<>{}[\]()|\\;,&?!*"'`]/;
var MASK_FRAGMENT_RE = /‹redacted:/;
var NAME_STOPWORDS = /* @__PURE__ */ new Set([
  "monkey",
  "donkey",
  "turkey",
  "whiskey",
  "jockey",
  "hockey",
  "lackey",
  "mickey",
  "malarkey",
  "hotkey",
  "sortkey",
  "oauth"
]);
function nameLooksLikeSecret(name) {
  const segments = name.split(/[^A-Za-z0-9]+/).flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/)).filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return false;
  const lower = last.toLowerCase();
  if (NAME_STOPWORDS.has(lower)) return false;
  return /(?:key|token|secret|password|passwd|pwd|credential|auth)s?$/.test(lower);
}
function valueLooksLikeSecret(value) {
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
  if (WORDY_IDENTIFIER_RE.test(v) && shannonEntropy(v) < 4) return false;
  if (new Set(v).size <= 2) return false;
  if (shannonEntropy(v) < 3.2) return false;
  return true;
}
function entropyCandidateAllowed(token) {
  if (token.length < ENTROPY_MIN_LENGTH) return false;
  if (UUID_RE.test(token)) return false;
  if (UUID_RE.test(token.replace(/^[A-Za-z][A-Za-z0-9]{0,15}[-_]/, ""))) return false;
  if (HEX_RE.test(token)) return false;
  if (/^(?:sha1|sha256|sha384|sha512|md5|blake3|crc32|xxh64)[-_:]/i.test(token)) return false;
  if (NUMERIC_RE.test(token)) return false;
  if (MASK_FRAGMENT_RE.test(token)) return false;
  if (PLACEHOLDER_RE.test(token)) return false;
  if (MINTED_ID_RE.test(token)) return false;
  if (ULID_RE.test(token)) return false;
  if (looksLikeProse(token)) return false;
  if (looksLikeAlphabetConstant(token)) return false;
  return true;
}
function regexRule(id, type, source, re, opts = {}) {
  const group = opts.group ?? 0;
  return {
    id,
    type,
    source,
    scan(text) {
      const out = [];
      const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      let m;
      while ((m = rx.exec(text)) !== null) {
        if (m[0].length === 0) {
          rx.lastIndex++;
          continue;
        }
        const value = group === 0 ? m[0] : m[group];
        if (value === void 0 || value.length === 0) continue;
        if (opts.validate && !opts.validate(value, m)) continue;
        const offset = group === 0 ? 0 : m[0].indexOf(value);
        if (offset < 0) continue;
        out.push({ start: m.index + offset, end: m.index + offset + value.length, value });
      }
      return out;
    }
  };
}
var GENERIC_ANCHOR = /(?:key|token|secret|password|passwd|pwd|credential|auth)s?["']?[ \t]*(?::=|=>|[:=])/gi;
var GENERIC_VALUE = (
  // The bare alternative stops at a backslash on purpose: transcripts carry
  // json-escaped text, where `TOKEN=abc\nNEXT=…` is one line and the `\n` is
  // two literal characters. Without this the capture swallows the rest of the
  // record and the value is thrown out as code.
  /[ \t]*(?:"([^"\r\n]{10,200})"|'([^'\r\n]{10,200})'|`([^`\r\n]{10,200})`|([^\s"'`,;)\](}>\\]{10,200}))/y
);
var NAME_CHAR_RE = /[A-Za-z0-9_$.-]/;
var genericAssignmentRule = {
  id: "generic-assignment",
  type: "generic",
  source: "03 \xA75, given the shape of gitleaks generic-api-key (MIT)",
  scan(text) {
    const out = [];
    const anchor = new RegExp(GENERIC_ANCHOR.source, GENERIC_ANCHOR.flags);
    let m;
    while ((m = anchor.exec(text)) !== null) {
      const opEnd = m.index + m[0].length;
      const opLen = /(?::=|=>)$/.test(m[0]) ? 2 : 1;
      const before = text[opEnd - opLen - 1] ?? "";
      if (text[opEnd] === "=" || opLen === 1 && /[!<>+\-*/%&|^=]/.test(before)) continue;
      const keywordEnd = m.index + m[0].replace(/["']?[ \t]*(?::=|=>|[:=])$/, "").length;
      let nameStart = m.index;
      while (nameStart > 0 && NAME_CHAR_RE.test(text[nameStart - 1] ?? "")) nameStart--;
      const name = text.slice(nameStart, keywordEnd);
      if (!nameLooksLikeSecret(name)) continue;
      GENERIC_VALUE.lastIndex = opEnd;
      const v = GENERIC_VALUE.exec(text);
      if (!v) continue;
      const value = v[1] ?? v[2] ?? v[3] ?? v[4];
      if (value === void 0 || !valueLooksLikeSecret(value)) continue;
      const start = v.index + v[0].lastIndexOf(value);
      out.push({ start, end: start + value.length, value });
      anchor.lastIndex = start + value.length;
    }
    return out;
  }
};
var socketAuthRule = {
  id: "socket-auth-argument",
  type: "generic",
  source: "03 \xA75 credential context",
  scan(text) {
    const out = [];
    const anchor = /(?:^|[\s"'`])--socket-auth["']?(?:[ \t]*=[ \t]*|[ \t]+)/gi;
    let match;
    while ((match = anchor.exec(text)) !== null) {
      GENERIC_VALUE.lastIndex = anchor.lastIndex;
      const found = GENERIC_VALUE.exec(text);
      if (!found) continue;
      const value = found[1] ?? found[2] ?? found[3] ?? found[4];
      if (value === void 0 || !valueLooksLikeSecret(value)) continue;
      const start = found.index + found[0].lastIndexOf(value);
      out.push({ start, end: start + value.length, value });
      anchor.lastIndex = start + value.length;
    }
    return out;
  }
};
var BEARER_RE = /(?:^|[^A-Za-z0-9_-])(?:Bearer|Token|ApiKey|Api-Key|Basic|DPoP)[ \t]+([A-Za-z0-9+/._~-]{16,512}={0,2})/g;
var bearerRule = regexRule(
  "authorization-bearer",
  "generic",
  "03 \xA75 (credential context), given the shape of gitleaks generic-api-key (MIT)",
  BEARER_RE,
  {
    group: 1,
    // Same value screen as the `KEY=` rule: `Bearer ${token}`, `Bearer <TOKEN>`
    // and `Bearer your-token-here` are documentation, not credentials.
    validate: (value) => valueLooksLikeSecret(value)
  }
);
var ENTROPY_TOKEN = /[A-Za-z0-9+_-]{20,}={0,2}/g;
var ESCAPE_LETTERS = "ntrbfv";
var highEntropyRule = {
  id: "high-entropy-token",
  type: "entropy",
  source: "03 \xA75 (4.5 bits / 20 chars) + gitleaks entropy allowlists (MIT)",
  scan(text) {
    const out = [];
    const rx = new RegExp(ENTROPY_TOKEN.source, ENTROPY_TOKEN.flags);
    let m;
    while ((m = rx.exec(text)) !== null) {
      let start = m.index;
      let value = m[0];
      if (start > 0 && text[start - 1] === "\\" && ESCAPE_LETTERS.includes(value[0] ?? "")) {
        start += 1;
        value = value.slice(1);
      }
      if (start > 0 && text[start - 1] === "%" && /^[0-9A-Fa-f]{2}/.test(value)) {
        start += 2;
        value = value.slice(2);
      }
      const lead = value.length - value.replace(/^[-_+]+/, "").length;
      start += lead;
      value = value.slice(lead).replace(/[-_+]+$/, "");
      if (value.length < ENTROPY_MIN_LENGTH) continue;
      if (!entropyCandidateAllowed(value)) continue;
      if (shannonEntropy(value) < ENTROPY_THRESHOLD) continue;
      out.push({ start, end: start + value.length, value });
    }
    return out;
  }
};
var RULES = [
  // ---- key material ------------------------------------------------------
  regexRule(
    // gitleaks `private-key`; secretlint `@secretlint/secretlint-rule-privatekey`.
    // The whole block is masked, header to footer: the base64 body alone would
    // otherwise be shredded into a dozen separate entropy hits.
    "private-key-block",
    "private-key",
    "gitleaks private-key / secretlint-rule-privatekey (MIT)",
    /-----BEGIN[ A-Z0-9]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,200000}?-----END[ A-Z0-9]{0,40}PRIVATE KEY(?: BLOCK)?-----/g
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
    "private-key-header",
    "private-key",
    "gitleaks private-key (MIT)",
    /-----BEGIN[ A-Z0-9]{0,40}PRIVATE KEY(?: BLOCK)?-----(?:[\r\n \t\\]+[A-Za-z0-9+/=]{20,})*/g
  ),
  regexRule(
    // gitleaks `jwt`: three base64url segments, the first two starting `ey`
    // (the base64 of `{"`). Session transcripts are full of these.
    "jwt",
    "jwt",
    "gitleaks jwt (MIT)",
    /\bey[A-Za-z0-9_-]{17,}\.ey[A-Za-z0-9_-]{17,}\.[A-Za-z0-9_-]{10,}={0,2}/g
  ),
  // ---- vendor tokens -----------------------------------------------------
  regexRule(
    // gitleaks `aws-access-token`; secretlint-rule-aws `AWSAccessKeyID`.
    "aws-access-key-id",
    "aws",
    "gitleaks aws-access-token / secretlint-rule-aws (MIT)",
    /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g
  ),
  regexRule(
    // secretlint-rule-aws `AWSSecretAccessKey`: a 40-character base64 value
    // bound to an AWS-flavoured name. Typed `aws` and placed before the generic
    // rule so `doctor` reports it as what it is.
    "aws-secret-access-key",
    "aws",
    "secretlint-rule-aws AWSSecretAccessKey (MIT)",
    /aws[_.-]?(?:secret|access)[_.-]?(?:access[_.-]?)?key(?:[_.-]?id)?["'\s]{0,4}[:=]["'\s]{0,4}([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
    { group: 1 }
  ),
  regexRule(
    // gitleaks `gcp-api-key`; secretlint-rule-gcp `GCPApiKey`.
    "gcp-api-key",
    "gcp",
    "gitleaks gcp-api-key / secretlint-rule-gcp (MIT)",
    /\bAIza[0-9A-Za-z_-]{35}\b/g
  ),
  regexRule(
    // gitleaks `gcp-oauth-client-secret`.
    "gcp-oauth-client-secret",
    "gcp",
    "gitleaks gcp-oauth-client-secret (MIT)",
    /\bGOCSPX-[a-zA-Z0-9_-]{28}\b/g
  ),
  regexRule(
    // gitleaks `github-pat` / `-oauth` / `-app-token` / `-refresh-token`;
    // secretlint-rule-github. ghp_ user, gho_ oauth, ghu_/ghs_ app, ghr_ refresh.
    "github-token",
    "github",
    "gitleaks github-pat / secretlint-rule-github (MIT)",
    /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g
  ),
  regexRule(
    // gitleaks `github-fine-grained-pat`.
    "github-fine-grained-pat",
    "github",
    "gitleaks github-fine-grained-pat (MIT)",
    /\bgithub_pat_[0-9a-zA-Z_]{82}\b/g
  ),
  regexRule(
    // gitleaks `slack-bot-token` / `-user-token` / `-app-token`;
    // secretlint-rule-slack.
    "slack-token",
    "slack",
    "gitleaks slack-bot-token / secretlint-rule-slack (MIT)",
    /\bxox[abprs]-[0-9a-zA-Z-]{10,72}\b/g
  ),
  regexRule(
    // gitleaks `slack-webhook-url`; secretlint-rule-slack `SlackWebhook`.
    "slack-webhook",
    "slack",
    "gitleaks slack-webhook-url (MIT)",
    /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{6,}\/[A-Za-z0-9+/]{6,}\/[A-Za-z0-9+/]{6,}/g
  ),
  regexRule(
    // gitleaks `stripe-access-token`. `pk_` publishable keys are public by
    // design and are deliberately not matched.
    "stripe-key",
    "stripe",
    "gitleaks stripe-access-token (MIT)",
    /\b(?:sk|rk)_(?:test|live|prod)_[A-Za-z0-9]{10,99}\b/g
  ),
  regexRule(
    // gitleaks `anthropic-api-key`. Must precede the openai rules: both start
    // `sk-`, and whichever rule claims the span first wins.
    "anthropic-api-key",
    "anthropic",
    "gitleaks anthropic-api-key (MIT)",
    /\bsk-ant-(?:api|admin)[0-9]{2}-[A-Za-z0-9_-]{80,120}\b/g
  ),
  regexRule(
    // gitleaks `openai-api-key`: the `T3BlbkFJ` infix is the base64 of
    // "OpenAI" and is what makes this rule safe to run over prose.
    "openai-api-key-project",
    "openai",
    "gitleaks openai-api-key (MIT)",
    /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}\b/g
  ),
  regexRule(
    // gitleaks `openai-api-key`, legacy 48-character form with no infix.
    "openai-api-key-legacy",
    "openai",
    "gitleaks openai-api-key (MIT)",
    /\bsk-[A-Za-z0-9]{48}\b/g
  ),
  regexRule(
    // gitleaks `npm-access-token`; secretlint-rule-npm.
    "npm-access-token",
    "npm",
    "gitleaks npm-access-token / secretlint-rule-npm (MIT)",
    /\bnpm_[A-Za-z0-9]{36}\b/g
  ),
  // ---- credentials in urls -----------------------------------------------
  regexRule(
    // gitleaks `authenticated-url`; secretlint `-rule-basicauth`. Only the
    // password is masked: `postgres://app:‹redacted:basic-auth:…›@db:5432/x`
    // still says which host and which user, which is the point of an index that
    // stays searchable by shape.
    "basic-auth-url",
    "basic-auth",
    "gitleaks authenticated-url / secretlint-rule-basicauth (MIT)",
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
      }
    }
  ),
  // ---- credential context (03 §5) ----------------------------------------
  bearerRule,
  genericAssignmentRule,
  socketAuthRule,
  // ---- entropy (03 §5) ---------------------------------------------------
  // Last, so that anything a named rule understands is reported under its real
  // type and a bare token is the fallback rather than the default.
  highEntropyRule
];

// packages/core/src/redact-elide.ts
function emptyElisions() {
  return { binaryParts: 0, charsElided: 0 };
}
var MIN_PAYLOAD = 512;
var BASE64_MAGIC = [
  ["iVBORw0KGgo", "image/png", "89 50 4E 47 0D 0A 1A 0A"],
  ["/9j/", "image/jpeg", "FF D8 FF (JFIF/Exif SOI)"],
  ["R0lGODdh", "image/gif", "GIF87a"],
  ["R0lGODlh", "image/gif", "GIF89a"],
  ["Qk0", "image/bmp", '42 4D ("BM")'],
  ["SUkqAA", "image/tiff", "49 49 2A 00 (little-endian TIFF)"],
  ["TU0AK", "image/tiff", "4D 4D 00 2A (big-endian TIFF)"],
  ["AAABAA", "image/x-icon", "00 00 01 00 (ICO)"],
  ["UklGR", "application/octet-stream", '52 49 46 46 ("RIFF" \u2014 webp/wav/avi)'],
  ["JVBERi0", "application/pdf", '25 50 44 46 2D ("%PDF-")'],
  ["UEsDB", "application/zip", '50 4B 03 04 ("PK\\x03\\x04" \u2014 zip/docx/xlsx)'],
  ["H4sI", "application/gzip", "1F 8B 08"],
  ["SUQz", "audio/mpeg", '49 44 33 ("ID3")'],
  ["T2dnU", "application/ogg", '4F 67 67 53 ("OggS")'],
  ["d09GRg", "font/woff", '77 4F 46 46 ("wOFF")'],
  ["d09GMg", "font/woff2", '77 4F 46 32 ("wOF2")'],
  ["AAEAAA", "font/ttf", "00 01 00 00 (TrueType)"],
  ["T1RUTw", "font/otf", '4F 54 54 4F ("OTTO")']
];
var B64_RUN = `(?:[A-Za-z0-9+/=]|\\\\/)`;
var B64_BODY = `${B64_RUN}{40,}(?:[\\r\\n \\t]+${B64_RUN}{40,})*`;
var DATA_URI = new RegExp(
  `data:([a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+)?(?:;[a-zA-Z0-9.+=-]+)*;base64,${B64_BODY}`,
  "g"
);
var CONTENT_BLOCK = new RegExp(
  `"(?:data|image_data|b64_json|base64)"\\s*:\\s*"(${B64_BODY})"`,
  "g"
);
var MEDIA_HINT = /"(?:media_?type|mime_?type|mimeType)"\s*:\s*"([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+)"|"type"\s*:\s*"base64"/gi;
var HINT_WINDOW = 200;
var MAGIC_PREFIXES = BASE64_MAGIC.map(([p]) => p.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|");
var BARE_RUN = new RegExp(
  `(?<![A-Za-z0-9+/=])(?:${MAGIC_PREFIXES})${B64_BODY}`,
  "g"
);
function magicOf(payload) {
  const head = payload.slice(0, 32).replace(/\\\//g, "/").replace(/\s+/g, "");
  for (const [prefix, mime] of BASE64_MAGIC) if (head.startsWith(prefix)) return mime;
  return void 0;
}
function mimeNear(text, start, end) {
  const from = Math.max(0, start - HINT_WINDOW);
  const window = text.slice(from, start) + text.slice(end, Math.min(text.length, end + HINT_WINDOW));
  const rx = new RegExp(MEDIA_HINT.source, MEDIA_HINT.flags);
  let m;
  let sawBase64 = false;
  while ((m = rx.exec(window)) !== null) {
    if (m[1]) return m[1];
    sawBase64 = true;
  }
  return sawBase64 ? "application/octet-stream" : void 0;
}
function collect(re, text, group, decide, out) {
  const rx = new RegExp(re.source, re.flags);
  let m;
  while ((m = rx.exec(text)) !== null) {
    const payload = group === 0 ? m[0] : m[group];
    if (payload === void 0 || payload.length === 0) {
      rx.lastIndex += 1;
      continue;
    }
    const start = m.index + (group === 0 ? 0 : m[0].indexOf(payload));
    const end = start + payload.length;
    const mime = decide(payload, start, end);
    if (mime === void 0) continue;
    out.push({ start, end, mime });
  }
}
function elideBinary(text, tally = emptyElisions()) {
  if (typeof text !== "string" || text.length < MIN_PAYLOAD) return text ?? "";
  if (!/[A-Za-z0-9+/]{64}/.test(text)) return text;
  const spans = [];
  const big = (payload) => payload.length >= MIN_PAYLOAD;
  collect(DATA_URI, text, 0, (payload) => {
    if (!big(payload)) return void 0;
    const m = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+)?/.exec(payload);
    return m?.[1] ?? "application/octet-stream";
  }, spans);
  collect(CONTENT_BLOCK, text, 1, (payload, start, end) => {
    if (!big(payload)) return void 0;
    const hint = mimeNear(text, start, end);
    if (hint === void 0) return void 0;
    return magicOf(payload) ?? hint;
  }, spans);
  collect(BARE_RUN, text, 0, (payload) => big(payload) ? magicOf(payload) : void 0, spans);
  if (spans.length === 0) return text;
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let cursor = 0;
  for (const s of spans) {
    if (s.start < cursor) continue;
    out.push(text.slice(cursor, s.start));
    const n = s.end - s.start;
    out.push(`\u2039elided:${s.mime}:${n} bytes\u203A`);
    tally.binaryParts += 1;
    tally.charsElided += n;
    cursor = s.end;
  }
  out.push(text.slice(cursor));
  return out.join("");
}

// packages/core/src/redact.ts
var OPEN = "\u2039";
var CLOSE = "\u203A";
var MASK_RE = new RegExp(`${OPEN}redacted:[a-z-]+:[0-9a-f]{8}${CLOSE}`, "g");
function secretDigest(secret) {
  return createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 8);
}
function redact(text) {
  if (typeof text !== "string" || text.length === 0) return { text: text ?? "", hits: [] };
  const claimed = new Uint8Array(text.length);
  const spans = [];
  for (const span of protectedSpans(text)) claim(claimed, span);
  for (const rule of RULES) {
    for (const m of rule.scan(text)) {
      if (m.start < 0 || m.end > text.length || m.end <= m.start) continue;
      if (isClaimed(claimed, m)) continue;
      claim(claimed, m);
      spans.push({ start: m.start, end: m.end, rule, value: m.value });
    }
  }
  if (spans.length === 0) return { text, hits: [] };
  spans.sort((a, b) => a.start - b.start);
  const out = [];
  const hits = [];
  let cursor = 0;
  for (const s of spans) {
    out.push(text.slice(cursor, s.start));
    const sha8 = secretDigest(s.value);
    out.push(`${OPEN}redacted:${s.rule.type}:${sha8}${CLOSE}`);
    hits.push({ type: s.rule.type, rule: s.rule.id, sha8, start: s.start, length: s.end - s.start });
    cursor = s.end;
  }
  out.push(text.slice(cursor));
  return { text: out.join(""), hits };
}
function protectedSpans(text) {
  const spans = [];
  const patterns = [MASK_RE, ...ALLOW_SPANS];
  for (const p of patterns) {
    const rx = new RegExp(p.source, p.flags.includes("g") ? p.flags : p.flags + "g");
    let m;
    while ((m = rx.exec(text)) !== null) {
      if (m[0].length === 0) {
        rx.lastIndex++;
        continue;
      }
      spans.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  return spans;
}
function isClaimed(claimed, s) {
  for (let i = s.start; i < s.end; i++) if (claimed[i]) return true;
  return false;
}
function claim(claimed, s) {
  const end = Math.min(s.end, claimed.length);
  for (let i = Math.max(0, s.start); i < end; i++) claimed[i] = 1;
}

// packages/core/src/analytics/source.ts
var clean = (text) => redact(elideBinary(text)).text;

// packages/core/src/analytics/profanity.ts
var ENGLISH_EXPLICIT_LEXICON = Object.freeze(["fuck", "fucked", "fucking", "shit", "shitty", "bullshit", "asshole", "bastard"]);
var PROFANITY_LEXICON_VERSION = "en-explicit-8-v1";
var words = new Set(ENGLISH_EXPLICIT_LEXICON);
var LEXICON_HINT = /fuck|shit|asshole|bastard/i;
var CODE = 2;
var QUOTE = 1;
var UNKNOWN = 3;
var kind = (label) => label === CODE ? "code" : label === QUOTE ? "quoted" : label === UNKNOWN ? "unknown" : "direct_prose";
var escaped = (text, index) => {
  let count2 = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) count2++;
  return count2 % 2 === 1;
};
var wordChar = (char) => char !== void 0 && /[\p{L}\p{N}\p{M}_\u200c\u200d]/u.test(char);
var labelMemo = /* @__PURE__ */ new Map();
function labels(text) {
  let hit = labelMemo.get(text);
  if (hit) return hit;
  if (labelMemo.size > 2e4) labelMemo.clear();
  hit = computeLabels(text);
  labelMemo.set(text, hit);
  return hit;
}
function computeLabels(text) {
  const map = new Uint8Array(text.length);
  let ambiguous = false, offset = 0, fence = null;
  for (const line of text.split(/(?<=\n)/u)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/u);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && line.slice(marker[0].length).trim() === "") {
        map.fill(CODE, fence.start, offset + line.length);
        fence = null;
      }
    } else if (marker) fence = { char: marker[1][0], length: marker[1].length, start: offset };
    else if (/^ {0,3}>/u.test(line)) map.fill(QUOTE, offset, offset + line.length);
    else if (/^(?: {4}|\t)\S/u.test(line)) {
      map.fill(UNKNOWN, offset, offset + line.length);
      ambiguous = true;
    }
    offset += line.length;
  }
  if (fence) {
    map.fill(UNKNOWN, fence.start);
    ambiguous = true;
  }
  const sourceRows = text.split(/(?<=\n)/u), timestamp = /^\s*(?:(?:[-*#]+|\*\*)\s*)?\[?\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\]?/u;
  if (/(?:transcript|captions|youtube|youtu\.be|video transcription)/iu.test(text) && sourceRows.filter((line) => timestamp.test(line)).length >= 3) {
    let at = 0;
    for (const line of sourceRows) {
      if (timestamp.test(line)) map.fill(QUOTE, at, at + line.length);
      at += line.length;
    }
  }
  for (let i = 0; i < text.length; i++) {
    if (map[i] || escaped(text, i)) continue;
    const char = text[i];
    if (char === "`") {
      let count2 = 1;
      while (text[i + count2] === "`") count2++;
      const token = "`".repeat(count2);
      let end2 = text.indexOf(token, i + count2);
      while (end2 >= 0 && (map[end2] !== 0 || text[end2 - 1] === "`" || text[end2 + count2] === "`")) end2 = text.indexOf(token, end2 + count2);
      if (end2 < 0) {
        map.fill(UNKNOWN, i);
        ambiguous = true;
        break;
      }
      map.fill(CODE, i, end2 + count2);
      i = end2 + count2 - 1;
      continue;
    }
    if (!['"', "'", "\u201C", "\u2018"].includes(char)) continue;
    if ((char === "'" || char === "\u2018") && wordChar(text[i - 1]) && wordChar(text[i + 1])) continue;
    const closing = char === "\u201C" ? "\u201D" : char === "\u2018" ? "\u2019" : char;
    let end = i + 1;
    while (end < text.length) {
      if (text[end] === closing && !escaped(text, end) && map[end] === 0 && !((closing === "'" || closing === "\u2019") && wordChar(text[end - 1]) && wordChar(text[end + 1]))) break;
      end++;
    }
    if (end >= text.length) {
      map.fill(UNKNOWN, i);
      ambiguous = true;
      break;
    }
    map.fill(QUOTE, i, end + 1);
    i = end;
  }
  return { labels: map, ambiguous };
}
function proseLabels(text) {
  return labels(text).labels;
}
var TOKEN = /[\p{L}\p{N}\p{M}_\u200c\u200d]+(?:['’][\p{L}\p{N}\p{M}_\u200c\u200d]+)*/gu;
function profanityHits(text) {
  if (!LEXICON_HINT.test(text)) return null;
  const spans = labels(text), hits = [];
  TOKEN.lastIndex = 0;
  let token;
  while ((token = TOKEN.exec(text)) !== null) {
    if (!words.has(token[0].toLowerCase())) continue;
    hits.push([token[0], spans.labels[token.index] ?? 0, token.index, token.index + token[0].length]);
  }
  return { hits, ambiguous: spans.ambiguous };
}
var knownExcluded = /* @__PURE__ */ new Set(["child_initialization", "maintenance_exclusion_marker", "tool_result", "inherited_native_event", "declared_meta_or_synthetic_input", "declared_synthetic_input"]);
var languageEligibleInput = (p) => p.languageEligible !== false && (p.eligibleNativeInput === true && !knownExcluded.has(p.excludedReason ?? "") || p.eligibleNativeInput === void 0 && p.eligibleHuman && p.excludedReason === null && ["claude_prompt_id", "codex_human_marker"].includes(p.originBasis));
function hitsOf(p) {
  if (p.lex) return p.lex.pt ? { hits: p.lex.pt, ambiguous: !!p.lex.pa } : null;
  return profanityHits(p.text);
}
function auditProfanity(prompts, partial = false) {
  const eligible = prompts.filter(languageEligibleInput), bucketCounts = new Map(["direct_prose", "quoted", "code", "unknown"].map((k) => [k, { occurrences: 0, prompts: /* @__PURE__ */ new Set() }])), containing = /* @__PURE__ */ new Set(), matches = [];
  const terms = /* @__PURE__ */ new Map();
  let occurrences = 0, ambiguous = false;
  for (const prompt of eligible) {
    const found = hitsOf(prompt);
    if (!found) continue;
    ambiguous ||= found.ambiguous;
    for (const [raw, label, start, end] of found.hits) {
      const bucket = kind(label), counter = bucketCounts.get(bucket);
      occurrences++;
      containing.add(prompt.id);
      counter.occurrences++;
      counter.prompts.add(prompt.id);
      const normalized = raw.toLowerCase(), key = normalized + "\0" + bucket;
      const term = terms.get(key) ?? { term: normalized, kind: bucket, occurrences: 0, ids: /* @__PURE__ */ new Set(), samples: [] };
      term.occurrences++;
      term.ids.add(prompt.id);
      if (term.samples.length < 3) term.samples.push({ promptId: prompt.id, conversationId: prompt.conversationId, startUtf16: start, endUtf16: end, route: prompt.route });
      terms.set(key, term);
      if (matches.length < 8) matches.push({ term: raw, kind: bucket, promptId: prompt.id, conversationId: prompt.conversationId, startUtf16: start, endUtf16: end, route: prompt.route });
    }
  }
  const measurementBasis = "literal_english_lexicon_observed_native_input_utf16_v2", definition = "Literal occurrences of the documented eight-word English lexicon in eligible observed native user-role inputs after existing redaction/elision; this does not attest universal human authorship. Unicode whole-word tokens; containing inputs counted once. No emotion, intent or universal-language inference. Ranges are relative to the immutable redacted containing input; routes identify that input.";
  return { lexiconVersion: PROFANITY_LEXICON_VERSION, language: "en-explicit-lexicon", measurementBasis, eligiblePrompts: eligible.length, occurrences: { value: occurrences, numerator: occurrences, denominator: eligible.length, unit: "english_lexicon_occurrence", measurementBasis, state: partial ? "partial" : "observed", definition }, containingPrompts: { value: containing.size, numerator: containing.size, denominator: eligible.length, unit: "eligible_input_containing_english_lexicon_match", measurementBasis, state: partial ? "partial" : "observed", definition }, buckets: [...bucketCounts].map(([kind2, value]) => ({ kind: kind2, occurrences: value.occurrences, containingPrompts: value.prompts.size })), coverageGaps: ["outside_english_lexicon_unassessed", "hindi_hinglish_and_other_languages_unassessed", ...ambiguous ? ["ambiguous_quote_or_code_span"] : []], terms: [...terms.values()].map((t) => ({ term: t.term, kind: t.kind, occurrences: t.occurrences, containingPrompts: t.ids.size, samples: t.samples })).sort((a, b) => b.occurrences - a.occurrences || a.term.localeCompare(b.term) || a.kind.localeCompare(b.kind)), matches };
}

// packages/core/src/analytics/language-feedback.ts
var POSITIVE_HINT = /good (?:work|job)|well done|you understood|you (?:got|nailed)|you(?:['’]re| are)/i;
var POSITIVE = /\b(?:good (?:work|job)|well done|you understood (?:me|it)|you (?:got|nailed) (?:it|this)|you(?:['’]re| are) (?:fucking )?(?:great|awesome))\b/iu;
var NEGATED = /\b(?:not|never|don['’]?t|didn['’]?t|no)\b.{0,35}\b(?:good|well done|understood|nailed|great|awesome)\b/iu;
var NEGATIVE = /\b(?:wrong|broken|stupid|missed|failed|why|mess|didn['’]?t|not|bullshit|fuck(?:ed|ing)? (?:up|off))\b/iu;
var YOU = /\b(?:you|your|you['’]re)\b/iu;
var words2 = (s) => s.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
function namedModels(text, models) {
  const out = [];
  let labels2 = null;
  for (const model of models) {
    const at = text.indexOf(model);
    if (at < 0) continue;
    labels2 ??= proseLabels(text);
    if (labels2[at] !== 0 || /[\p{L}\p{N}_/-]/u.test(text[at - 1] ?? "") || /[\p{L}\p{N}_/-]/u.test(text[at + model.length] ?? "")) continue;
    out.push(model);
  }
  return out;
}
function languageLines(text) {
  const out = [];
  let labelCache = null;
  const L = (i) => (labelCache ??= proseLabels(text))[i];
  let offset = 0;
  for (const line of text.split("\n")) {
    const start = offset;
    offset += line.length + 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const at = start + line.indexOf(trimmed), end = at + trimmed.length;
    if (!LEXICON_HINT.test(trimmed) && !POSITIVE_HINT.test(trimmed)) continue;
    const probe = { id: "line", conversationId: "", role: "user", originBasis: "claude_prompt_id", identityBasis: "", eligibleHuman: true, excludedReason: null, eventAt: null, route: { basis: "canonical", refs: [], scope: {} } };
    const local = auditProfanity([{ ...probe, text: line }]);
    const direct = local.terms?.some((t) => t.kind === "direct_prose" && t.samples.some((sample) => L(start + sample.startUtf16) === 0)) ?? false;
    const nonprose = local.terms?.some((t) => t.kind !== "direct_prose") ?? false;
    const positiveMatch = trimmed.match(POSITIVE), positive = !!positiveMatch && L(at + (positiveMatch.index ?? 0)) === 0, negated = NEGATED.test(trimmed);
    const quoted = L(at) !== 0 || /^\s*(?:>|[`~]{3}|["“'])/u.test(line) || /^ {4}|^\t/u.test(line);
    const row = {};
    if (direct) row.d = 1;
    if (nonprose) row.np = 1;
    if (YOU.test(trimmed)) row.y = 1;
    if (positive) row.p = 1;
    if (negated) row.ng = 1;
    if (quoted) row.q = 1;
    if (NEGATIVE.test(trimmed)) row.n = 1;
    if (direct && !quoted && words2(trimmed) >= 2) {
      const spans = trimmed.length <= 160 ? [{ text: trimmed, start: at, end }] : [...trimmed.matchAll(/[^.!?;\n]+[.!?;]?/gu)].map((match) => {
        const value = match[0].trim(), begin = at + match.index + match[0].indexOf(value);
        return { text: value, start: begin, end: begin + value.length };
      }).filter((span) => span.text.length <= 160 && words2(span.text) >= 2 && auditProfanity([{ ...probe, text: span.text }]).terms?.some((t) => t.kind === "direct_prose" && L(span.start + t.samples[0].startUtf16) === 0));
      if (spans.length) row.sp = spans.map((s) => [s.text, s.start, s.end]);
      else row.ns = 1;
    }
    out.push(row);
  }
  return out;
}

// packages/core/src/analytics/project-focus.ts
var categories = [
  ["Documentation", /\b(?:write|update|fix|add|edit|draft|revise)\b.{0,64}\b(?:docs?|documentation|readme|guide|changelog)\b/iu],
  ["Review", /\b(?:review|audit|inspect)\b.{0,64}\b(?:code|diff|pr|pull request|implementation|tests?|changes|repo|repository)\b/iu],
  ["Debugging", /\b(?:fix|debug|repair|resolve|reproduce)\b.{0,64}\b(?:bug|error|crash|failure|issue|test|broken|timeout|memory|hang|problem)\b/iu],
  ["Development", /\b(?:build|implement|add|create|develop|refactor|ship|integrate)\b.{0,64}\b(?:feature|app|api|cli|function|component|command|module|tool|parser|service|code|support)\b/iu],
  ["Research", /\b(?:research|look up|investigate|compare|verify)\b.{0,64}\b(?:docs?|source|pricing|model|library|approach|behavior|format|implementation)\b/iu]
];
var VERBS = /\b(?:write|update|fix|add|edit|draft|revise|review|audit|inspect|debug|repair|resolve|reproduce|build|implement|create|develop|refactor|ship|integrate|research|look up|investigate|compare|verify)\b/iu;
function focusLabels(raw) {
  if (!VERBS.test(raw) || !categories.some(([, pattern]) => pattern.test(raw))) return [];
  const labels2 = proseLabels(raw), text = Array.from({ length: raw.length }, (_, i) => labels2[i] === 0 ? raw[i] : " ").join("");
  return categories.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

// packages/core/src/analytics/findings.ts
var EXACT_REPEAT_LIMITS = Object.freeze({ rows: 20, supports: 8, maxRowBytes: 8192 });
var PLACEHOLDER = /\[(?:Pasted text|Image) #\d+[^\]]*\]/gi;
function normalizedLine(text) {
  const n = text.replace(PLACEHOLDER, "").toLowerCase().replace(/\s+/g, " ").trim().replace(/^[ .!?,]+|[ .!?,]+$/g, "");
  return n.length > 0 && n.length <= 60 ? n : null;
}

// packages/core/src/analytics/story-lexicon.ts
var FLAG = {
  paste: 1,
  image: 2,
  code: 4,
  url: 8,
  pasteSuspect: 16,
  slur: 32,
  polite: 64,
  thanks: 128,
  sorry: 256,
  multiPunct: 512,
  question: 1024,
  delegate: 2048,
  lets: 4096,
  please: 8192,
  history: 16384
};
var PLACEHOLDER2 = /\[(?:Pasted text|Image) #\d+[^\]]*\]/gi;
var URL_RX = /https?:\/\/\S+/g;
var CODEISH = /```[\s\S]*?```/g;
var WORD = /[a-z][a-z']*/g;
var SWEAR_STEMS = [
  "fuck",
  "shit",
  "bullshit",
  "wtf",
  "damn",
  "goddamn",
  "crap",
  "bitch",
  "asshole",
  "dumbass",
  "stfu",
  "ffs",
  "piss",
  "bastard",
  "motherf",
  "bloody",
  "bsdk",
  "chutiya",
  "chutiye",
  "madarchod",
  "bhenchod",
  "behenchod",
  "gandu"
];
var SWEAR_EXACT = /* @__PURE__ */ new Set(["ffs", "wtf", "stfu"]);
var SWEAR_PREFIX = SWEAR_STEMS.filter((s) => !SWEAR_EXACT.has(s));
var INSULT = ["stupid", "idiot", "dumb", "moron", "useless", "pathetic", "lazy", "incompetent", "garbage", "trash", "retard"];
var SLUR_STEMS = ["retard"];
var POLITE = /\b(please|pls|plz|thanks|thank you|thank u|thx|ty|appreciate|great job|good job|well done|awesome|amazing|love it|love this|nice work|brilliant|you're the best|perfect)\b/;
var THANKS = /\b(thanks|thank you|thank u|thx|ty|appreciate it|great job|good job|well done|nice work)\b/;
var SORRY = /\b(sorry|my bad|apologi[sz]e)\b/;
var FRUSTRATION = /\b(again|still not|still doesn't|still isn't|i told you|i said|i already|not working|doesn't work|didn't work|isn't working|why (?:the|did|are|is|would) |what the|seriously|come on|for the last time|how many times|are you (?:kidding|serious|dumb|stupid))\b/g;
var DELEGATE = /\b(sub-?agents?|agents? in parallel|parallel agents?|spawn|launch (?:\w+ )?agents?|team of agents|multiple agents|\d+ agents)\b/;
var FILLER = /\b(basically|kind of|sort of|i guess|i mean|you know|like,|um+|uh+|okay so|so yeah|whatever)\b/g;
var PERFECTION = /\b(best possible|perfect(?:ly)?|exactly|properly|every single|completely|100%|flawless|world[- ]class|insanely|extremely)\b/g;
var QWORDS = /* @__PURE__ */ new Set(["what", "why", "how", "is", "are", "can", "could", "should", "does", "do", "did", "where", "when", "which", "who", "will", "would"]);
var WE = /\b(we|we're|we've|let's|us|our)\b/g;
var I_ = /\b(i|i'm|i've|me|my)\b/g;
var HINGLISH = /\b(bhai|yaar|kya|hai|nahi|kar|karo|acha|accha|theek|matlab|abhi|bas|chal|haan)\b/g;
var CAPS = /\b[A-Z][A-Z']{2,}\b/g;
var CAPS_OK = /* @__PURE__ */ new Set(["API", "URL", "HTML", "CSS", "JSON", "CLI", "PR", "UI", "UX", "MCP", "LLM", "SDK", "README", "TODO", "IST", "PDF", "NPM", "AWS", "GPT", "MD", "SEO", "JS", "TS", "ID", "OK", "AI", "CEO", "USA", "SQL", "DB", "SSH", "HTTP", "HTTPS", "PNG", "SVG", "CTA", "FAQ"]);
function isSwearWord(w) {
  if (SWEAR_EXACT.has(w)) return true;
  for (const s of SWEAR_PREFIX) if (w.startsWith(s)) return true;
  return false;
}
var isInsult = (w) => INSULT.some((s) => w.startsWith(s));
var isSlur = (w) => SLUR_STEMS.some((s) => w.startsWith(s));
function mask(w) {
  return w.length <= 2 ? w : w[0] + "*".repeat(w.length - 2) + w[w.length - 1];
}
function cleanForTone(text) {
  return text.replace(PLACEHOLDER2, " ").replace(/[‘’]/g, "'").replace(CODEISH, " ").replace(URL_RX, " ");
}
var count = (rx, s) => {
  rx.lastIndex = 0;
  let n = 0;
  while (rx.exec(s)) n++;
  rx.lastIndex = 0;
  return n;
};
var words3 = (s) => s.match(WORD) ?? [];
var TICS = [
  "one more thing",
  "each and every",
  "do one thing",
  "every single thing",
  "kind of a thing",
  "and all",
  "and stuff",
  "or something",
  "at the end of the day",
  "to be honest",
  "basically",
  "you know what",
  "let me know",
  "best possible",
  "world class",
  "insanely",
  "make it pop",
  "help me out",
  "what do you think",
  "i don't know",
  "just do it",
  "ship it",
  "go ahead",
  "lfg",
  "let's go",
  "no worries",
  "makes sense",
  "figure it out",
  "deep research",
  "ultra think",
  "ultrathink",
  "step by step",
  "one shot",
  "whatever it takes",
  "end to end",
  "from scratch",
  "like a pro",
  "production ready",
  "properly",
  "exactly",
  "and everything",
  "all of that",
  "the whole thing",
  "you know",
  "i mean",
  "sort of",
  "kind of",
  "so yeah",
  "okay so"
];
var CLAUSE_FINAL = /* @__PURE__ */ new Set(["and all", "and stuff", "or something", "and everything", "all of that", "and all that"]);
var esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
var TIC_BY_FIRST = /* @__PURE__ */ new Map();
TICS.forEach((phrase, index) => {
  const first = phrase.split(" ")[0];
  const list = TIC_BY_FIRST.get(first) ?? [];
  list.push({ phrase, index, final: CLAUSE_FINAL.has(phrase) });
  TIC_BY_FIRST.set(first, list);
});
var CLAUSE_END = /^\s*(?:[.,!?;:)\n]|$|and\b|so\b|but\b)/;
var isWordChar = (c) => c !== void 0 && /[A-Za-z0-9_]/.test(c);
function ticsIn(low) {
  const found = /* @__PURE__ */ new Set();
  const rx = /[a-z']+/g;
  let m;
  while ((m = rx.exec(low)) !== null) {
    const list = TIC_BY_FIRST.get(m[0]);
    if (!list || isWordChar(low[m.index - 1])) continue;
    for (const t of list) {
      if (found.has(t.index) || !low.startsWith(t.phrase, m.index)) continue;
      const end = m.index + t.phrase.length;
      if (t.final ? CLAUSE_END.test(low.slice(end, end + 12)) : !isWordChar(low[end]) || !isWordChar(low[end - 1])) found.add(t.index);
    }
  }
  return [...found].sort((a, b) => a - b);
}
var ADDRESS = ["dude", "bro", "buddy", "babe", "baby", "my friend", "man", "mate", "boss", "sir", "brother", "bhai", "yaar", "chief", "champ", "my guy", "darling", "love"];
var ADDRESS_GATE = new RegExp("\\b(" + ADDRESS.map(esc).join("|") + ")\\b", "g");
var ADDRESS_INDEX = new Map(ADDRESS.map((a, i) => [a, i]));
var VOCATIVE_BEFORE = /(?:^|[,.!?]\s*|\b(?:hey|yo|ok|okay|thanks|no|come on)\s+)$/;
function addressIn(low) {
  const found = /* @__PURE__ */ new Set();
  ADDRESS_GATE.lastIndex = 0;
  let m;
  while ((m = ADDRESS_GATE.exec(low)) !== null) {
    const i = ADDRESS_INDEX.get(m[1]);
    if (found.has(i)) continue;
    const end = m.index + m[0].length;
    if (VOCATIVE_BEFORE.test(low.slice(Math.max(0, m.index - 12), m.index)) || /^\s*[,.!?]/.test(low.slice(end, end + 8)) || end === low.length) found.add(i);
  }
  return [...found].sort((a, b) => a - b);
}
function featurize(input) {
  const raw = input.text;
  let t = cleanForTone(raw);
  const all = words3(t.toLowerCase());
  const pasteSuspect = all.length > 1500 || all.length > 600 && !input.typed;
  if (pasteSuspect) {
    const toks = t.split(/\s+/).filter(Boolean);
    t = toks.slice(0, 150).concat("\u2026", toks.slice(-150)).join(" ");
  }
  const low = t.toLowerCase();
  const tone = pasteSuspect ? words3(low) : all;
  let letters = 0, upper = 0;
  for (let k = 0; k < t.length; k++) {
    const c = t.charCodeAt(k);
    if (c >= 65 && c <= 90) {
      letters++;
      upper++;
    } else if (c >= 97 && c <= 122) letters++;
    else if (c > 127 && new RegExp("\\p{L}", "u").test(t[k])) {
      letters++;
      if (t[k] !== t[k].toLowerCase()) upper++;
    }
  }
  let caps = 0;
  for (const m of t.match(CAPS) ?? []) if (!CAPS_OK.has(m)) caps++;
  const swears = [];
  let insults = 0, slur = false;
  for (const w of tone) {
    if (isSwearWord(w)) swears.push(w);
    if (isInsult(w)) insults++;
    if (!slur && isSlur(w)) slur = true;
  }
  const first = all[0] ?? "";
  const rawLow = raw.toLowerCase();
  const trimmed = raw.trim();
  let fl = 0;
  if (/\[Pasted text #/.test(raw) || input.hasPaste) fl |= FLAG.paste;
  if (input.hasImage || raw.includes("[Image #")) fl |= FLAG.image;
  if (raw.includes("```")) fl |= FLAG.code;
  URL_RX.lastIndex = 0;
  if (URL_RX.test(raw)) fl |= FLAG.url;
  URL_RX.lastIndex = 0;
  if (pasteSuspect) fl |= FLAG.pasteSuspect;
  if (slur) fl |= FLAG.slur;
  if (POLITE.test(low)) fl |= FLAG.polite;
  if (THANKS.test(low)) fl |= FLAG.thanks;
  if (SORRY.test(low)) fl |= FLAG.sorry;
  if (/[!?]{3,}/.test(raw)) fl |= FLAG.multiPunct;
  if (trimmed.endsWith("?") || QWORDS.has(first) && all.length < 40) fl |= FLAG.question;
  if (DELEGATE.test(low)) fl |= FLAG.delegate;
  if (/\blet'?s\b/.test(rawLow)) fl |= FLAG.lets;
  if (/\b(please|pls|plz)\b/.test(rawLow)) fl |= FLAG.please;
  if (input.typed) fl |= FLAG.history;
  let excl = 0;
  for (let k = raw.indexOf("!"); k >= 0; k = raw.indexOf("!", k + 1)) excl++;
  let lines = 1;
  for (let k = raw.indexOf("\n"); k >= 0; k = raw.indexOf("\n", k + 1)) lines++;
  const f = {
    ch: raw.length,
    w: all.length,
    ln: lines,
    fl,
    sw: swears.length,
    ins: insults,
    fr: count(FRUSTRATION, low),
    cw: caps,
    cr: letters >= 12 ? Math.round(upper / letters * 1e3) / 1e3 : 0,
    ex: excl,
    we: count(WE, low),
    i: count(I_, low),
    fi: count(FILLER, low),
    pf: count(PERFECTION, low),
    hi: count(HINGLISH, low),
    fw: first.slice(0, 24)
  };
  if (swears.length) f.sws = swears.slice(0, 6);
  if (raw.length <= 80) {
    const sl = raw.replace(PLACEHOLDER2, "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 60);
    if (sl) f.sl = sl;
  }
  const tc = ticsIn(rawLow);
  if (tc.length) f.tc = tc;
  const ad = addressIn(rawLow);
  if (ad.length) f.ad = ad;
  return f;
}
var SENSITIVE = /\b(die|dying|suicid\w*|kill (?:my|me)\w*|depress\w*|demons?|deserve|anxiety|therap\w*|panic|lonely|worthless|hate myself|cry(?:ing)?|breakup|girlfriend|boyfriend|wife|husband|sex\w*|porn|nude|drunk|password|token|secret|api[_ -]?key|ssn|salary|loan|debt|visa|lawyer|doctor|hospital|meds?)\b/i;
var SECRETISH = /(sk-[A-Za-z0-9]|tvly-|AKIA|ghp_|xox[bp]-|@[\w.-]+\.\w{2,}|[A-Za-z0-9_-]{32,}|\/Users\/|\/home\/|~\/|https?:\/\/|\[REDACTED|<redacted)/;
function safeQuote(text, maxLength = 90) {
  let t = text.replace(PLACEHOLDER2, "").replace(/\s+/g, " ").trim();
  if (!t || SENSITIVE.test(t) || SECRETISH.test(t)) return null;
  t = t.slice(0, maxLength + 40).replace(/[A-Za-z']+/g, (w) => {
    const l = w.toLowerCase();
    return isSwearWord(l) || isSlur(l) ? mask(w) : w;
  }) + t.slice(maxLength + 40);
  if (t.length <= maxLength) return t;
  const cut = t.slice(0, maxLength - 1);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut) + "\u2026";
}
var TOPIC_STOP = new Set("the a an and or of to in on for is it that this i you we be are was with as at by from so if but not do can me my your our just what how all also now like then there they them these those one some any more much very really thing things something everything get got make made want need see know think going go let lets let's okay ok yes no up out into about will would should could have has had been being he she his her him its it's i'm don't can't isn't doesn't which who when where why here same other only even still well right good way time new use using done try give take put come look".split(" "));
function vocabularyWords(text) {
  return words3(cleanForTone(text).toLowerCase()).filter((w) => w.length >= 3 && w.length <= 24);
}
function topicWords(text) {
  const out = /* @__PURE__ */ new Set();
  for (const w of words3(cleanForTone(text).toLowerCase())) if (w.length >= 3 && w.length <= 24 && !TOPIC_STOP.has(w) && !isSwearWord(w)) out.add(w);
  return out;
}

// packages/core/src/analytics/story-time.ts
var WEEKDAY = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
function localClock(timezone) {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23"
  });
  const memo = /* @__PURE__ */ new Map();
  return (at) => {
    const slot = Math.floor(at / 9e5);
    let hit = memo.get(slot);
    if (hit) return { ...hit, minute: hit.minute + Math.floor((at - slot * 9e5) / 6e4) };
    const parts = {};
    for (const p of format.formatToParts(new Date(slot * 9e5))) parts[p.type] = p.value;
    const hour = Number(parts.hour) % 24;
    hit = { day: `${parts.year}-${parts.month}-${parts.day}`, month: `${parts.year}-${parts.month}`, hour, dow: WEEKDAY[parts.weekday] ?? 0, minute: Number(parts.minute) };
    memo.set(slot, hit);
    return { ...hit, minute: hit.minute + Math.floor((at - slot * 9e5) / 6e4) };
  };
}

// packages/core/src/analytics/story-extract.ts
var AGENT_TOOLS = /* @__PURE__ */ new Set(["Task", "Agent", "spawn_agent", "spawn_agents", "TaskCreate"]);
var isAgentTool = (name) => AGENT_TOOLS.has(name) || name.startsWith("spawn");
function promptLex(text, models) {
  const lex = {};
  const hits = profanityHits(text);
  if (hits?.hits.length) lex.pt = hits.hits;
  if (hits?.ambiguous) lex.pa = 1;
  const nl = normalizedLine(text);
  if (nl !== null) lex.nl = nl;
  const fc = focusLabels(text);
  if (fc.length) lex.fc = fc;
  const nm = namedModels(text, models);
  if (nm.length) lex.nm = nm;
  const ll = languageLines(text);
  if (ll.length) lex.ll = ll;
  return Object.keys(lex).length ? lex : void 0;
}
var QUOTE_TOP = 8;
var QUOTE_SUBAGENT_TOP = 5;
var QUOTE_LAST_PER_PROJECT = 3;
function deriveStory(prompts, events, interrupts, options) {
  const human = prompts.filter((p) => p.kind === "human" && p.at !== null).sort((a, b) => a.at - b.at);
  const fresh = new Set(prompts.slice(options.from ?? 0));
  const models = /* @__PURE__ */ new Set();
  for (const p of prompts) {
    if (p.before) models.add(p.before);
    if (p.after) models.add(p.after);
  }
  const vocab = options.counters ? options.previous?.vocab ?? /* @__PURE__ */ new Map() : null;
  const topics = options.counters ? new Map((options.previous?.topics ?? []).map((t) => [t.month, t])) : null;
  const clock = localClock(options.timezone);
  for (const p of human) {
    if (!fresh.has(p)) continue;
    p.f = featurize({ text: p.text, typed: options.typed });
    const lex = promptLex(p.text, models);
    if (lex) p.lex = lex;
    if (vocab) for (const w of vocabularyWords(p.text)) vocab.set(w, (vocab.get(w) ?? 0) + 1);
    if (topics) {
      const { hour, month } = clock(p.at);
      const slot = hour < 5 ? 0 : hour >= 9 && hour < 19 ? 1 : -1;
      if (slot >= 0) {
        let bag = topics.get(month);
        if (!bag) {
          bag = { month, night: 0, day: 0, words: /* @__PURE__ */ new Map() };
          topics.set(month, bag);
        }
        if (slot === 0) bag.night++;
        else bag.day++;
        for (const w of topicWords(p.text)) {
          let c = bag.words.get(w);
          if (!c) {
            c = [0, 0];
            bag.words.set(w, c);
          }
          c[slot]++;
        }
      }
    }
  }
  turnStats(human, events, interrupts);
  const weight = /* @__PURE__ */ new Map();
  const slots = /* @__PURE__ */ new Set();
  if (human.length) slots.add(human[0]);
  const byProject = /* @__PURE__ */ new Map();
  for (const p of human) {
    const k = p.project ?? "";
    const list = byProject.get(k) ?? [];
    list.push(p);
    byProject.set(k, list);
  }
  for (const list of byProject.values()) for (const p of list.slice(-QUOTE_LAST_PER_PROJECT)) slots.add(p);
  turnWeights(human, events, weight);
  for (const p of [...human].sort((a, b) => (weight.get(b) ?? 0) - (weight.get(a) ?? 0)).slice(0, QUOTE_TOP)) slots.add(p);
  for (const p of human.filter((p2) => (p2.t?.sa ?? 0) > 0).sort((a, b) => b.t.sa - a.t.sa).slice(0, QUOTE_SUBAGENT_TOP)) slots.add(p);
  for (const p of slots) {
    if (!p.text) continue;
    const q = safeQuote(p.text, 90);
    if (q) p.q = q;
  }
  return { vocab, topics: topics ? [...topics.values()] : null };
}
function turnStats(human, events, interrupts) {
  const ev = events.filter((e) => Number.isFinite(e.at)).sort((a, b) => a.at - b.at);
  const intr = interrupts.filter(Number.isFinite).sort((a, b) => a - b);
  let j = 0, k = 0, lastAt = null;
  human.forEach((p, i) => {
    const start = p.at, next = i + 1 < human.length ? human[i + 1].at : Infinity;
    while (j < ev.length && ev[j].at < start) lastAt = ev[j++].at;
    const t = { m: 0, tl: 0, sa: 0, d: null, x: 0, g: lastAt === null ? null : round1((start - lastAt) / 1e3) };
    let end = null;
    while (j < ev.length && ev[j].at < next) {
      const e = ev[j++];
      t.m++;
      t.tl += e.tools;
      t.sa += e.subs;
      end = e.at;
      lastAt = e.at;
    }
    if (end !== null) t.d = round1((end - start) / 1e3);
    while (k < intr.length && intr[k] < start) k++;
    if (k < intr.length && intr[k] < next) t.x = 1;
    p.t = t;
  });
}
function turnWeights(human, events, out) {
  const ev = events.filter((e) => e.weight > 0).sort((a, b) => a.at - b.at);
  let j = 0;
  human.forEach((p, i) => {
    const next = i + 1 < human.length ? human[i + 1].at : Infinity;
    while (j < ev.length && ev[j].at < p.at) j++;
    let w = 0;
    while (j < ev.length && ev[j].at < next) w += ev[j++].weight;
    out.set(p, w);
  });
}
var round1 = (x) => Math.round(x * 10) / 10;
var usageWeight = (input, output, cacheRead, cacheWrite) => input + 5 * output + 1.25 * cacheWrite + 0.1 * cacheRead;

// packages/core/src/analytics/extract.ts
var FACTS_VERSION = 5;
var MAX_PROMPT_CHARS = 4e3;
var isRec = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
var str = (v) => typeof v === "string" && v.length > 0 ? v : null;
var int = (v) => typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
function time(v) {
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e11 ? v * 1e3 : v;
  return null;
}
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) if (isRec(block) && typeof block.text === "string") parts.push(block.text);
  return parts.join("\n");
}
var INJECTED_PREFIXES = [
  ["<task-notification>", "task_notification"],
  ["<local-command-stdout>", "local_command_output"],
  ["<local-command-stderr>", "local_command_output"],
  ["<local-command-caveat>", "local_command_output"],
  ["[Request interrupted", "interrupt_marker"],
  ["<turn_aborted>", "interrupt_marker"],
  ["<environment_context>", "environment_context"],
  ["# AGENTS.md instructions", "agents_md"],
  ["<user_instructions>", "agents_md"],
  ["<external_codex_apps", "app_state"],
  ["<recommended_plugins>", "app_state"],
  ["<heartbeat>", "automation"],
  ["The following is the Codex agent history", "guardian_review"],
  ["You have new hive inbox message", "automation"],
  ["Another Claude session sent a message", "cross_session_message"],
  ["This session is being continued from a previous conversation", "compaction_summary"],
  ["Your claude.ai usage limit has reset", "auto_continuation"],
  ["Base directory for this skill:", "skill_expansion"]
];
var SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
function classifyText(raw) {
  const text = (raw.includes("<system-reminder>") ? raw.replace(SYSTEM_REMINDER, "") : raw).trim();
  if (!text) return { kind: "excluded", reason: "empty", text };
  for (const [prefix, reason] of INJECTED_PREFIXES) if (text.startsWith(prefix)) return { kind: "excluded", reason, text };
  if (text.startsWith("<command-name>") || text.startsWith("<command-message>")) return { kind: "command", reason: "slash_command", text };
  if (text.startsWith("<send_user_message_question_reply>")) return { kind: "answer", reason: "question_answer", text };
  return { kind: "human", reason: null, text };
}
var CODEX_STRIP = [/<in-app-browser-context[\s\S]*?<\/in-app-browser-context>/g, /<image name=[^>]*>\s*<\/image>/g, /<\/?image[^>]*>/g];
function cleanCodexText(raw) {
  let t = raw;
  if (t.includes("<")) for (const rx of CODEX_STRIP) t = t.replace(rx, "");
  const at = t.indexOf("## My request");
  if (at >= 0) {
    const rest = t.slice(at + "## My request".length), colon = rest.indexOf(":");
    t = colon >= 0 ? rest.slice(colon + 1) : rest;
  } else if (t.trimStart().startsWith("# Files mentioned by the user")) t = "";
  return t.trim();
}
function makeBuilder(file, harness, size, mtimeMs) {
  return {
    facts: {
      v: FACTS_VERSION,
      harness,
      file,
      size,
      mtimeMs,
      sessionId: path.basename(file, ".jsonl"),
      parentId: null,
      child: false,
      project: null,
      title: null,
      automated: false,
      excluded: false,
      startedAt: null,
      firstAt: null,
      lastAt: null,
      usage: [],
      prompts: [],
      malformed: 0
    },
    currentModel: null,
    currentProvider: null,
    pending: [],
    seenPrompts: /* @__PURE__ */ new Set(),
    events: [],
    interrupts: []
  };
}
function touch(b, at) {
  if (at === null) return;
  if (b.facts.firstAt === null || at < b.facts.firstAt) b.facts.firstAt = at;
  if (b.facts.lastAt === null || at > b.facts.lastAt) b.facts.lastAt = at;
}
function answered(b, model, provider) {
  if (!model) return;
  for (const p of b.pending) {
    p.after = model;
    p.afterProvider = provider;
  }
  b.pending.length = 0;
  b.currentModel = model;
  b.currentProvider = provider;
}
function addUsage(b, u) {
  b.facts.usage.push(u);
  touch(b, u.at);
  answered(b, u.model, u.provider);
}
function addPrompt(b, key, at, project, kind2, reason, text) {
  if (b.seenPrompts.has(key)) return;
  b.seenPrompts.add(key);
  if (kind2 === "human" && hasExclusionMarker(text)) b.facts.excluded = true;
  if (reason === "interrupt_marker" && at !== null) b.interrupts.push(at);
  const prompt = {
    key,
    at,
    project,
    kind: kind2,
    reason,
    text: kind2 === "human" ? clean(text.length > MAX_PROMPT_CHARS ? text.slice(0, MAX_PROMPT_CHARS) : text) : "",
    before: b.currentModel,
    beforeProvider: b.currentProvider,
    after: null,
    afterProvider: null
  };
  b.facts.prompts.push(prompt);
  if (kind2 === "human") b.pending.push(prompt);
  touch(b, at);
}
var SUBAGENT_DIR = `${path.sep}subagents${path.sep}`;
function claudeLine(b, line, subagent, sessions) {
  const assistant = line.includes('"type":"assistant"');
  if (assistant ? !line.includes('"usage"') : subagent || !line.includes('"type":"user"')) {
    if (line.length > 4096 || !line.includes('-title"') && !line.includes('"type":"summary"')) return;
  }
  let r;
  try {
    r = JSON.parse(line.toString("utf8"));
  } catch {
    b.facts.malformed++;
    return;
  }
  if (!isRec(r)) return;
  const f = b.facts;
  if (r.type === "summary" || r.type === "custom-title" || r.type === "ai-title") {
    const title = str(r.customTitle) ?? str(r.aiTitle) ?? str(r.title) ?? str(r.summary);
    if (title && (r.type !== "summary" || !f.title)) f.title = title;
    return;
  }
  if (typeof r.cwd === "string" && !f.project) f.project = r.cwd;
  const sid = str(r.sessionId);
  if (sid) {
    if (subagent) {
      f.parentId = sid;
      f.child = true;
      f.sessionId = `${sid}:${path.basename(f.file, ".jsonl")}`;
    } else if (!sessions.size) f.sessionId = sid;
  }
  const m = isRec(r.message) ? r.message : {};
  const at = time(r.timestamp);
  if (r.type === "assistant") {
    const u = m.usage;
    if (!isRec(u)) return;
    const model = str(m.model);
    if (model === "<synthetic>") return;
    const cc = isRec(u.cache_creation) ? u.cache_creation : null;
    const write = cc ? int(cc.ephemeral_5m_input_tokens) + int(cc.ephemeral_1h_input_tokens) : int(u.cache_creation_input_tokens);
    const id = str(m.id), request = str(r.requestId), session = sid ?? f.file;
    const fact = {
      key: id ? request ? `c:${id}:${request}` : `c:${id}::${session}:${String(r.timestamp)}` : null,
      at,
      model,
      provider: null,
      input: int(u.input_tokens),
      output: int(u.output_tokens),
      cacheRead: int(u.cache_read_input_tokens),
      cacheWrite: write,
      cacheWrite1h: cc ? int(cc.ephemeral_1h_input_tokens) : 0,
      reasoning: 0
    };
    if (r.isSidechain === true) fact.sidechain = true;
    if (!request) fact.requestless = true;
    if (id) fact.replayKey = `${id}:${session}`;
    if (u.speed === "fast") fact.tier = "fast";
    addUsage(b, fact);
    if (at !== null) {
      let tools = 0, subs = 0;
      if (Array.isArray(m.content)) {
        for (const block of m.content) if (isRec(block) && block.type === "tool_use") {
          tools++;
          if (typeof block.name === "string" && isAgentTool(block.name)) subs++;
        }
      }
      b.events.push({ at, tools, subs, weight: usageWeight(fact.input, fact.output, fact.cacheRead, fact.cacheWrite) });
    }
    return;
  }
  if (r.type !== "user" || r.isSidechain === true || subagent) return;
  const content = m.content;
  if (Array.isArray(content) && content.some((block) => isRec(block) && block.type === "tool_result")) return;
  if (sid) sessions.add(sid);
  const origin = isRec(r.origin) ? str(r.origin.kind) : null;
  const flagged = r.isMeta === true ? "is_meta" : r.isCompactSummary === true ? "compaction_summary" : origin && origin !== "human" ? `origin_${origin}` : r.entrypoint === "sdk-cli" ? "headless_claude_p" : r.promptSource === "system" ? "prompt_source_system" : null;
  let { kind: kind2, reason, text } = classifyText(textOf(content));
  if (flagged) {
    kind2 = "excluded";
    reason = flagged;
  } else if (reason === "empty" && origin === "human" && Array.isArray(content) && content.some((block) => isRec(block) && block.type === "image")) {
    kind2 = "human";
    reason = null;
    text = "[image]";
  }
  addPrompt(b, str(r.uuid) ?? `${f.sessionId}:${String(r.timestamp)}`, at, str(r.cwd) ?? f.project, kind2, reason, text);
}
var newCodexState = () => ({
  lineNo: 0,
  previousTotal: null,
  tier: void 0,
  imported: false,
  records: /* @__PURE__ */ new Map(),
  compacted: /* @__PURE__ */ new Set(),
  deltas: /* @__PURE__ */ new Set(),
  itemPrompts: [],
  responsePrompts: [],
  mode: null,
  converted: 0,
  seen: /* @__PURE__ */ new Set(),
  compactionDone: /* @__PURE__ */ new Set()
});
var ResumeMismatch = class extends Error {
  constructor() {
    super("resume_mismatch");
  }
};
var U_KEYS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"];
var tuple = (u) => isRec(u) ? U_KEYS.map((k) => int(u[k])) : null;
var AUTO_REVIEW_MODELS = [
  ["2026-07-30", "gpt-5.6-luna"],
  ["2026-03-05", "gpt-5.4"],
  ["2026-02-05", "gpt-5.3-codex"],
  ["2025-12-11", "gpt-5.2-codex"],
  ["2025-11-13", "gpt-5.1-codex"],
  ["2025-09-15", "gpt-5-codex"]
];
function codexModel(model, timestamp) {
  if (model === "codex-auto-review") {
    const day = timestamp.slice(0, 10);
    return { model: AUTO_REVIEW_MODELS.find(([since]) => day >= since)?.[1] ?? "gpt-5", inferred: true };
  }
  return model ? { model, inferred: false } : { model: "gpt-5", inferred: true };
}
function codexFact(b, s, at, timestamp, d, key) {
  const input = d[0], output = d[2], reasoning = d[3], cached = Math.min(d[1], input);
  const { model, inferred } = codexModel(b.currentModel, timestamp);
  const fact = { key, at, model, provider: "openai", input: input - cached, output, cacheRead: cached, cacheWrite: 0, cacheWrite1h: 0, reasoning };
  if (inferred) fact.inferredModel = true;
  if (s.tier) fact.tier = s.tier;
  return fact;
}
function codexWanted(head, lineNo) {
  return lineNo === 0 && head.includes("session_meta") || head.includes('"token_count"') || head.includes('"turn_context"') || head.includes("thread_settings_applied") || head.includes('"task_started"') || head.includes('"token_usage_record"') || head.includes('"type":"compacted"') || head.includes('"UserMessage"') && head.includes("item_completed") || head.includes('"role":"user"') && head.includes('"response_item"') || head.includes('"event_msg"') && head.includes('"type":"user_message"');
}
function codexLine(b, line, s) {
  const n = s.lineNo++;
  const head = line.toString("latin1", 0, Math.min(line.length, 260));
  const f = b.facts;
  const parse = () => {
    try {
      return JSON.parse(line.toString("utf8"));
    } catch {
      f.malformed++;
      return null;
    }
  };
  if (n === 0 && head.includes("session_meta")) {
    const r = parse();
    if (!r) return;
    const p = isRec(r.payload) ? r.payload : {};
    f.sessionId = str(p.id) ?? str(p.session_id) ?? f.sessionId;
    f.project = str(p.cwd);
    f.startedAt = str(p.timestamp) ?? str(r.timestamp);
    const source = p.source;
    if (isRec(source) && "subagent" in source) {
      f.child = true;
      const sub = isRec(source.subagent) ? source.subagent : {};
      const spawn = isRec(sub.thread_spawn) ? sub.thread_spawn : {};
      f.parentId = str(spawn.parent_thread_id) ?? str(p.parent_thread_id) ?? str(p.forked_from_id);
    }
    if (source === "exec" || p.originator === "codex_exec" || p.originator === "codex_sdk_ts") f.automated = true;
    touch(b, time(r.timestamp));
    return;
  }
  if (head.includes('"token_count"')) {
    const r = parse();
    const p = r && isRec(r.payload) ? r.payload : null;
    const info = p && isRec(p.info) ? p.info : null;
    if (!r || !info) return;
    const total = tuple(info.total_token_usage), last = tuple(info.last_token_usage);
    const totalSig = total ? total.join(",") : null;
    const advanced = totalSig === null || totalSig !== s.previousTotal;
    let d = null;
    if (last && advanced) d = last;
    else if (total) {
      const prev = s.previousTotal ? s.previousTotal.split(",").map(Number) : [0, 0, 0, 0, 0];
      d = total.map((v, i) => Math.max(0, v - prev[i]));
    }
    if (totalSig) s.previousTotal = totalSig;
    if (!d || !(d[0] || d[1] || d[2] || d[3])) return;
    s.deltas.add(d.join(","));
    const key = totalSig ? `x:${totalSig}|${last ? last.join(",") : ""}` : null;
    const fact = codexFact(b, s, time(r.timestamp), String(r.timestamp ?? ""), d, key);
    addUsage(b, fact);
    if (fact.at !== null) b.events.push({ at: fact.at, tools: 0, subs: 0, weight: usageWeight(fact.input, fact.output, fact.cacheRead, fact.cacheWrite) });
    return;
  }
  if (head.includes('"turn_context"')) {
    const p = parse()?.payload;
    if (isRec(p)) {
      b.currentModel = str(p.model) ?? b.currentModel;
      if (typeof p.cwd === "string") f.project = p.cwd;
    }
    return;
  }
  if (head.includes("thread_settings_applied")) {
    const p = parse()?.payload;
    const settings = isRec(p) && isRec(p.thread_settings) ? p.thread_settings : null;
    if (settings && "service_tier" in settings) {
      const v = settings.service_tier;
      s.tier = v === "priority" || v === "fast" ? "fast" : v === "default" || v === "standard" ? "standard" : void 0;
    }
    return;
  }
  if (head.includes('"task_started"')) {
    const p = parse()?.payload;
    s.imported = isRec(p) && String(p.turn_id ?? "").startsWith("external-import");
    return;
  }
  if (head.includes('"UserMessage"') && head.includes("item_completed")) {
    const r = parse();
    const p = r && isRec(r.payload) ? r.payload : null;
    if (!r || !p) return;
    const item = isRec(p.item) ? p.item : {};
    s.itemPrompts.push({
      key: str(item.id),
      at: time(r.timestamp),
      text: textOf(item.content),
      imported: s.imported || String(p.turn_id ?? "").startsWith("external-import"),
      project: f.project
    });
    return;
  }
  if (head.includes('"role":"user"') && head.includes('"response_item"')) {
    const r = parse();
    if (!r) return;
    const p = isRec(r.payload) ? r.payload : {};
    s.responsePrompts.push({ key: null, at: time(r.timestamp), text: textOf(p.content), imported: s.imported, project: f.project });
    return;
  }
  if (head.includes('"event_msg"') && line.subarray(0, 400).includes('"type":"user_message"')) {
    const r = parse();
    if (!r) return;
    const p = isRec(r.payload) ? r.payload : {};
    s.itemPrompts.push({ key: null, at: time(r.timestamp), text: typeof p.message === "string" ? p.message : "", imported: s.imported, project: f.project });
    return;
  }
  if (codexToolOrAbort(b, head)) return;
  if (head.includes('"token_usage_record"')) {
    const r = parse();
    const p = r && isRec(r.payload) ? r.payload : null;
    const id = p ? str(p.response_id) : null;
    if (r && p && id && isRec(p.usage)) s.records.set(id, { at: time(r.timestamp), usage: p.usage });
    return;
  }
  if (head.includes('"type":"compacted"')) {
    const at = line.lastIndexOf('"compaction_response_id":"');
    if (at >= 0) {
      const start = at + 26, end = line.indexOf(34, start);
      if (end > start) s.compacted.add(line.toString("latin1", start, end));
    }
  }
}
var TOOL_CALL = /"type":"(?:function_call|custom_tool_call)"/;
var NAME = /"name":"([^"]{1,80})"/;
var STAMP = /"timestamp":"([^"]{10,40})"/;
function codexToolOrAbort(b, head) {
  if (TOOL_CALL.test(head) && head.includes('"response_item"')) {
    const at = time(STAMP.exec(head)?.[1]);
    const name = NAME.exec(head)?.[1] ?? "";
    if (at !== null) b.events.push({ at, tools: 1, subs: isAgentTool(name) ? 1 : 0, weight: 0 });
    return true;
  }
  if (head.includes('"turn_aborted"') && head.includes('"event_msg"')) {
    const at = time(STAMP.exec(head)?.[1]);
    if (at !== null) b.interrupts.push(at);
    return true;
  }
  return false;
}
function finishCodex(b, s) {
  const f = b.facts;
  for (const id of s.compacted) {
    if (s.compactionDone.has(id)) continue;
    const record = s.records.get(id);
    const d = record ? tuple(record.usage) : null;
    if (!record || !d || !(d[0] || d[1] || d[2] || d[3]) || s.deltas.has(d.join(","))) continue;
    s.compactionDone.add(id);
    const fact = codexFact(b, s, record.at, record.at ? new Date(record.at).toISOString() : "", d, `codex-compaction:${id}`);
    fact.compaction = true;
    f.usage.push(fact);
    touch(b, record.at);
  }
  if (s.mode === "responses" && s.itemPrompts.length) throw new ResumeMismatch();
  const mode = s.mode ?? (s.itemPrompts.length ? "items" : s.responsePrompts.length ? "responses" : null);
  const list = mode === "items" ? s.itemPrompts : mode === "responses" ? s.responsePrompts : [];
  s.mode = mode;
  const reason = f.child ? "subagent_parent_written" : f.automated ? "programmatic_exec_session" : null;
  const seen = s.seen, base = s.converted;
  s.converted += list.length;
  list.forEach((p, n) => {
    const i = base + n;
    if (p.key) {
      if (seen.has(p.key)) return;
      seen.add(p.key);
    }
    const key = `codex:${f.sessionId}:${p.key ?? i}`;
    if (reason) return addPrompt(b, key, p.at, p.project, "excluded", reason, "");
    if (p.imported) return addPrompt(b, key, p.at, p.project, "excluded", "imported_from_claude_transcript", "");
    const c = classifyText(cleanCodexText(p.text));
    addPrompt(b, key, p.at, p.project, c.kind, c.reason, c.text);
  });
  const answers = f.usage.filter((u) => u.at !== null).sort((x, y) => x.at - y.at);
  let j = 0, previous = null;
  for (const p of [...f.prompts].sort((x, y) => (x.at ?? 0) - (y.at ?? 0))) {
    while (j < answers.length && answers[j].at <= (p.at ?? 0)) previous = answers[j++].model;
    p.before = previous;
    p.beforeProvider = previous ? "openai" : null;
    p.after = answers[j]?.model ?? null;
    p.afterProvider = p.after ? "openai" : null;
  }
}
function piLine(b, line) {
  let r;
  try {
    r = JSON.parse(line.toString("utf8"));
  } catch {
    b.facts.malformed++;
    return;
  }
  const f = b.facts, at = time(r.timestamp);
  if (r.type === "session") {
    f.sessionId = str(r.id) ?? f.sessionId;
    f.project = str(r.cwd);
    touch(b, at);
    return;
  }
  if (r.type === "model_change") {
    b.currentModel = str(r.modelId) ?? b.currentModel;
    b.currentProvider = str(r.provider) ?? b.currentProvider;
    return;
  }
  if (r.type !== "message" || !isRec(r.message)) return;
  const m = r.message;
  if (m.role === "assistant" && isRec(m.usage)) {
    const u = m.usage;
    const fact = {
      key: `pi:${f.sessionId}:${String(r.id)}`,
      at,
      model: str(m.model) ?? b.currentModel,
      provider: str(m.provider) ?? b.currentProvider,
      input: int(u.input),
      output: int(u.output),
      cacheRead: int(u.cacheRead),
      cacheWrite: int(u.cacheWrite),
      cacheWrite1h: 0,
      reasoning: 0
    };
    if (fact.input + fact.output + fact.cacheRead + fact.cacheWrite > 0) addUsage(b, fact);
    else answered(b, fact.model, fact.provider);
    if (at !== null) {
      const tools = Array.isArray(m.content) ? m.content.filter((c) => isRec(c) && typeof c.type === "string" && c.type.toLowerCase().includes("tool")).length : 0;
      b.events.push({ at, tools, subs: 0, weight: usageWeight(fact.input, fact.output, fact.cacheRead, fact.cacheWrite) });
    }
    return;
  }
  if (m.role === "user") {
    const c = classifyText(textOf(m.content));
    addPrompt(b, `pi:${f.sessionId}:${String(r.id)}`, at, f.project, c.kind, c.reason, c.text);
  }
}
var CHUNK = 4 * 1024 * 1024;
var MAX_LINE = 256 * 1024 * 1024;
var sharedBuffer = null;
var RESUME_RECENT_MS = 48 * 36e5;
function extractFile(file, harness, options = {}, previous) {
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    let b = makeBuilder(file, harness, stat.size, stat.mtimeMs);
    let codex = newCodexState();
    let position = 0, firstNew = 0;
    const subagent = file.includes(SUBAGENT_DIR), sessions = /* @__PURE__ */ new Set();
    if (previous) {
      const r = previous.resume;
      if (!r || previous.excluded || r.dev !== stat.dev || r.ino !== stat.ino || r.offset > stat.size || r.offset < 1 || tailHash(fd, r.offset) !== r.tail) throw new ResumeMismatch();
      const nl = Buffer.alloc(1);
      fs.readSync(fd, nl, 0, 1, r.offset - 1);
      if (nl[0] !== 10) throw new ResumeMismatch();
      b = resumeBuilder(previous, r, stat);
      if (r.codex) codex = { ...structuredClone(r.codex), itemPrompts: [], responsePrompts: [] };
      for (const sid of r.sessions ?? []) sessions.add(sid);
      position = r.offset;
      firstNew = b.facts.prompts.length;
    }
    const onLine = harness === "claude" ? (line) => claudeLine(b, line, subagent, sessions) : harness === "codex" ? (line) => codexLine(b, line, codex) : (line) => piLine(b, line);
    let buffer = sharedBuffer ??= Buffer.allocUnsafe(CHUNK);
    let filled = 0, skipping = false, base = position, endsWithNewline = true;
    for (; ; ) {
      if (filled === buffer.length) {
        if (harness === "codex" && !codexWanted(buffer.toString("latin1", 0, Math.min(filled, 400)), codex.lineNo)) {
          codexToolOrAbort(b, buffer.toString("latin1", 0, Math.min(filled, 400)));
          skipping = true;
          base += filled;
          filled = 0;
          codex.lineNo++;
        } else if (buffer.length >= MAX_LINE) {
          skipping = true;
          base += filled;
          filled = 0;
          b.facts.malformed++;
        } else {
          const bigger = Buffer.allocUnsafe(buffer.length * 2);
          buffer.copy(bigger, 0, 0, filled);
          buffer = bigger;
          if (bigger.length <= 4 * CHUNK) sharedBuffer = bigger;
        }
      }
      const n = fs.readSync(fd, buffer, filled, buffer.length - filled, position);
      position += n;
      const end = filled + n;
      let start = 0;
      for (; ; ) {
        const nl = buffer.indexOf(10, start);
        if (nl < 0 || nl >= end) break;
        if (skipping) skipping = false;
        else if (nl > start) onLine(buffer.subarray(start, nl));
        start = nl + 1;
      }
      if (n === 0) {
        if (start < end) {
          endsWithNewline = false;
          if (!skipping) onLine(buffer.subarray(start, end));
        }
        base += start;
        break;
      }
      buffer.copyWithin(0, start, end);
      base += start;
      filled = end - start;
    }
    if (harness === "codex") finishCodex(b, codex);
    if (harness === "claude" && !subagent && sessions.size) b.facts.sessionIds = [...sessions];
    b.facts.size = stat.size;
    b.facts.mtimeMs = stat.mtimeMs;
    finishStory(b, harness, options, firstNew);
    delete b.facts.resume;
    if (endsWithNewline && !b.facts.excluded && Date.now() - stat.mtimeMs < RESUME_RECENT_MS) {
      const events = new Float64Array(b.events.length * 4);
      b.events.forEach((e, i) => {
        events[i * 4] = e.at;
        events[i * 4 + 1] = e.tools;
        events[i * 4 + 2] = e.subs;
        events[i * 4 + 3] = e.weight;
      });
      const { itemPrompts: _items, responsePrompts: _responses, ...codexState } = codex;
      b.facts.resume = {
        offset: base,
        tail: tailHash(fd, base),
        dev: stat.dev,
        ino: stat.ino,
        model: b.currentModel,
        provider: b.currentProvider,
        events,
        interrupts: Float64Array.from(b.interrupts),
        ...sessions.size ? { sessions: [...sessions] } : {},
        ...harness === "codex" ? { codex: codexState } : {}
      };
    }
    return b.facts;
  } finally {
    fs.closeSync(fd);
  }
}
function resumeBuilder(previous, r, stat) {
  const facts = {
    ...previous,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    usage: [...previous.usage],
    prompts: previous.prompts.map((p) => ({ ...p })),
    ...previous.sessionIds ? { sessionIds: [...previous.sessionIds] } : {},
    ...previous.story ? { story: { vocab: previous.story.vocab ? new Map(previous.story.vocab) : null, topics: previous.story.topics ? previous.story.topics.map((t) => ({ ...t, words: new Map([...t.words].map(([w, c]) => [w, [c[0], c[1]]])) })) : null } } : {}
  };
  delete facts.resume;
  const b = makeBuilder(previous.file, previous.harness, stat.size, stat.mtimeMs);
  b.facts = facts;
  b.currentModel = r.model;
  b.currentProvider = r.provider;
  for (const p of facts.prompts) b.seenPrompts.add(p.key);
  for (let i = facts.prompts.length - 1; i >= 0; i--) {
    const p = facts.prompts[i];
    if (p.kind !== "human") continue;
    if (p.after !== null) break;
    b.pending.unshift(p);
  }
  for (let i = 0; i < r.events.length; i += 4) b.events.push({ at: r.events[i], tools: r.events[i + 1], subs: r.events[i + 2], weight: r.events[i + 3] });
  b.interrupts.push(...r.interrupts);
  return b;
}
function finishStory(b, harness, options, from = 0) {
  const f = b.facts;
  f.tz = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (f.excluded) {
    for (const p of f.prompts) {
      p.text = "";
      delete p.f;
      delete p.lex;
      delete p.q;
    }
    delete f.story;
    return;
  }
  f.story = deriveStory(f.prompts, b.events, b.interrupts, { typed: false, counters: harness !== "claude" && !f.child, timezone: f.tz, from, previous: f.story });
}
function stripText(facts) {
  for (const p of facts.prompts) p.text = "";
  return facts;
}
function tailHash(fd, offset) {
  const start = Math.max(0, offset - TAIL), buffer = Buffer.alloc(offset - start);
  let read = 0;
  while (read < buffer.length) {
    const n = fs.readSync(fd, buffer, read, buffer.length - read, start + read);
    if (!n) break;
    read += n;
  }
  return createHash2("sha256").update(buffer.subarray(0, read)).digest("hex");
}
var TAIL = 4096;

// packages/core/src/analytics/scan-pool.ts
var readFacts = (job) => stripText(extractFile(job.file, job.harness, { timezone: job.timezone }));
var errorCode = (error) => error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/.test(error.message) ? error.message : "source_unreadable";
function runScanWorker() {
  if (!parentPort) throw new Error("scan_worker_requires_parent");
  const port = parentPort;
  port.on("message", (job) => {
    try {
      port.postMessage({ facts: readFacts(job) });
    } catch (error) {
      port.postMessage({ error: errorCode(error) });
    }
  });
}

// packages/cli/src/audit-native-worker.ts
runScanWorker();
//# sourceMappingURL=audit-native-worker.js.map

import { createRequire as __potsherdCreateRequire } from 'node:module';
const require = __potsherdCreateRequire(import.meta.url);

// packages/core/src/analytics/native-pool.ts
import { Worker, parentPort } from "node:worker_threads";
import { serialize, deserialize } from "node:v8";
import { createHash as createHash6 } from "node:crypto";

// packages/core/src/analytics/native-stream.ts
import fs from "node:fs";
import path from "node:path";
import { createHash as createHash5 } from "node:crypto";

// packages/core/src/parser/content.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function extractTypedText(content, blockType = "text") {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => isRecord(b) && b.type === blockType && typeof b.text === "string").map((b) => b.text).join("\n");
}

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

// packages/core/src/memory/source-identity.ts
import { createHash } from "node:crypto";
function sourceId(harness, nativeSessionId) {
  return createHash("sha256").update(`source/v1\0${harness}\0${nativeSessionId}`).digest("hex");
}

// packages/core/src/analytics/source.ts
import { createHash as createHash3 } from "node:crypto";

// packages/core/src/redact.ts
import { createHash as createHash2 } from "node:crypto";

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
  return createHash2("sha256").update(secret, "utf8").digest("hex").slice(0, 8);
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
var digest = (value) => createHash3("sha256").update(value).digest("hex");
var clean = (text) => redact(elideBinary(text)).text;
var clock = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

// packages/core/src/analytics/native-metadata-projection.ts
import { StringDecoder } from "node:string_decoder";
var NativeMetadataProjection = class {
  constructor(maxBytes = 8 * 1024 * 1024, harness = null) {
    this.maxBytes = maxBytes;
    this.harness = harness;
  }
  decoder = new StringDecoder("utf8");
  frames = [];
  root;
  done = false;
  mode = "idle";
  token = "";
  isKey = false;
  keep = false;
  escape = false;
  unicode = "";
  markerTail = "";
  retained = 0;
  error = null;
  marker = false;
  scanString = false;
  scanEscape = false;
  scanUnicode = "";
  scanTail = "";
  // Defer the producer check until the whole record is known, retaining unknown values only within the shared metadata budget.
  imageBodies = [];
  imageCandidate = null;
  imageBytes = 0;
  trimImages() {
    for (let i = this.imageBodies.length - 1; i >= 0 && this.retained + this.imageBytes > this.maxBytes; i--) {
      const body = this.imageBodies[i];
      this.imageBytes -= body.bytes;
      body.chunks = [];
      body.bytes = 0;
      body.overflow = true;
    }
  }
  fail(code2 = "native_metadata_invalid") {
    this.error ??= code2;
  }
  add(c) {
    if (this.keep || this.isKey) {
      this.retained += Buffer.byteLength(JSON.stringify(c)) - 2;
      if (this.retained > this.maxBytes || this.isKey && this.token.length > 32768) {
        this.fail("native_metadata_bytes_limit");
        return;
      }
      this.token += c;
      this.trimImages();
    }
    if (this.imageCandidate && !this.imageCandidate.overflow) {
      const bytes = Buffer.byteLength(JSON.stringify(c)) - 2;
      this.imageCandidate.bytes += bytes;
      this.imageBytes += bytes;
      this.imageCandidate.chunks.push(c);
      this.trimImages();
    }
    const searchable = this.markerTail + c;
    if (EXCLUSION_MARKERS.some((m) => searchable.includes(m))) this.marker = true;
    this.markerTail = searchable.slice(-256);
  }
  expectedValue() {
    const f = this.frames.at(-1);
    return f ? f.state === "value" || f.state === "valueRequired" : !this.done;
  }
  imageBody(f) {
    return this.harness === "codex" && f.key === "image_url" && f.path.length === 3 && f.path[0] === "payload" && f.path[1] === "output" && f.path[2] === "[]";
  }
  retainValue() {
    const f = this.frames.at(-1);
    return !f || f.keep && !(f.key === "content" || f.key === "text" || f.omitImage);
  }
  accept(value) {
    if (this.retainValue()) {
      this.retained += 16;
      this.trimImages();
      if (this.retained > this.maxBytes) {
        this.fail("native_metadata_bytes_limit");
        return;
      }
    }
    const f = this.frames.at(-1);
    if (!f) {
      if (this.done) {
        this.fail();
        return;
      }
      this.root = value;
      this.done = true;
      return;
    }
    if (f.state !== "value" && f.state !== "valueRequired") {
      this.fail();
      return;
    }
    if (f.keep) {
      if (f.array) f.value.push(value);
      else if (f.key !== null && this.retainValue()) Object.defineProperty(f.value, f.key, { value, writable: true, enumerable: true, configurable: true });
    }
    f.key = null;
    f.omitImage = false;
    f.state = "comma";
  }
  scalarEnd() {
    if (this.mode === "number") {
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(this.token)) {
        this.fail();
        return;
      }
      this.accept(this.keep ? Number(this.token) : null);
    } else if (this.mode === "literal") {
      if (!["true", "false", "null"].includes(this.token)) {
        this.fail();
        return;
      }
      this.accept(this.keep ? JSON.parse(this.token) : null);
    }
    this.mode = "idle";
    this.token = "";
  }
  char(c) {
    if (this.error) return;
    if (this.mode === "string") {
      if (this.unicode) {
        if (!/[0-9a-f]/i.test(c)) {
          this.fail();
          return;
        }
        this.unicode += c;
        if (this.unicode.length === 5) {
          this.add(String.fromCharCode(parseInt(this.unicode.slice(1), 16)));
          this.unicode = "";
        }
        return;
      }
      if (this.escape) {
        this.escape = false;
        if (c === "u") {
          this.unicode = "u";
          return;
        }
        const decoded = { '"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "	" };
        if (!(c in decoded)) {
          this.fail();
          return;
        }
        this.add(decoded[c]);
        return;
      }
      if (c === "\\") {
        this.escape = true;
        return;
      }
      if (c === '"') {
        if (this.isKey) {
          const f2 = this.frames.at(-1);
          f2.key = this.token;
          f2.state = "colon";
        } else this.accept(this.keep ? this.token : null);
        this.mode = "idle";
        this.token = "";
        this.imageCandidate = null;
        this.markerTail = "";
        return;
      }
      if (c.charCodeAt(0) < 32) {
        this.fail();
        return;
      }
      this.add(c);
      return;
    }
    if (this.mode === "number" || this.mode === "literal") {
      const allowed = this.mode === "number" ? /[0-9eE+.-]/ : /[a-z]/;
      if (allowed.test(c)) {
        if (this.token.length >= 256) {
          this.fail("native_metadata_scalar_limit");
          return;
        }
        this.token += c;
        return;
      }
      this.scalarEnd();
      if (this.error) return;
    }
    if (/\s/.test(c)) {
      if (![" ", "	", "\r", "\n"].includes(c)) this.fail();
      return;
    }
    const f = this.frames.at(-1);
    if (c === '"') {
      this.isKey = !!f && !f.array && (f.state === "key" || f.state === "keyRequired");
      if (!this.isKey && !this.expectedValue()) {
        this.fail();
        return;
      }
      if (!this.isKey && f && this.imageBody(f)) {
        f.omitImage = true;
        this.imageCandidate = { frame: f, chunks: [], bytes: 0, overflow: false };
        this.imageBodies.push(this.imageCandidate);
      }
      this.keep = this.isKey || this.retainValue() && f?.key !== "message";
      this.token = "";
      this.markerTail = "";
      this.mode = "string";
      return;
    }
    if (c === "{" || c === "[") {
      if (!this.expectedValue() || this.frames.length >= 128) {
        this.fail("native_metadata_depth_limit");
        return;
      }
      const keep = this.retainValue();
      this.frames.push({ path: f ? [...f.path, f.array ? "[]" : f.key] : [], omitImage: false, array: c === "[", state: c === "[" ? "value" : "key", key: null, keep, value: keep ? c === "[" ? [] : {} : null });
      return;
    }
    if (c === "}" || c === "]") {
      if (!f || f.array !== (c === "]") || !["comma", f.array ? "value" : "key"].includes(f.state)) {
        this.fail();
        return;
      }
      this.frames.pop();
      this.accept(f.value);
      return;
    }
    if (c === ":") {
      if (!f || f.state !== "colon") {
        this.fail();
        return;
      }
      f.state = "valueRequired";
      return;
    }
    if (c === ",") {
      if (!f || f.state !== "comma") {
        this.fail();
        return;
      }
      f.state = f.array ? "valueRequired" : "keyRequired";
      return;
    }
    if (!this.expectedValue()) {
      this.fail();
      return;
    }
    this.keep = this.retainValue();
    this.token = c;
    if (c === "-" || /[0-9]/.test(c)) this.mode = "number";
    else if (/[tfn]/.test(c)) this.mode = "literal";
    else this.fail();
  }
  scanMarkers(text) {
    const special = /["\\]/g;
    let at2 = 0;
    const add = (value) => {
      const combined = this.scanTail + value;
      if (EXCLUSION_MARKERS.some((m) => combined.includes(m))) this.marker = true;
      this.scanTail = combined.slice(-256);
    };
    while (at2 < text.length) {
      if (this.scanString && !this.scanEscape && !this.scanUnicode) {
        special.lastIndex = at2;
        const hit = special.exec(text), end = hit?.index ?? text.length;
        add(text.slice(at2, end));
        at2 = end;
        if (at2 >= text.length) break;
      }
      const c = text[at2++];
      if (this.scanUnicode) {
        this.scanUnicode += c;
        if (this.scanUnicode.length === 5) {
          if (/^u[0-9a-f]{4}$/i.test(this.scanUnicode)) add(String.fromCharCode(parseInt(this.scanUnicode.slice(1), 16)));
          this.scanUnicode = "";
        }
        continue;
      }
      if (this.scanEscape) {
        this.scanEscape = false;
        if (c === "u") this.scanUnicode = "u";
        else add({ n: "\n", r: "\r", t: "	" }[c] ?? c);
        continue;
      }
      if (c === '"') {
        this.scanString = !this.scanString;
        this.scanTail = "";
      } else if (this.scanString && c === "\\") this.scanEscape = true;
    }
  }
  push(bytes) {
    const text = this.decoder.write(bytes);
    this.scanMarkers(text);
    const special = /["\\\x00-\x1f]/g;
    let at2 = 0;
    while (at2 < text.length && !this.error) {
      if (this.mode === "string" && !this.escape && !this.unicode) {
        special.lastIndex = at2;
        const hit = special.exec(text), end = hit?.index ?? text.length;
        if (end > at2) this.add(text.slice(at2, end));
        at2 = end;
        if (at2 >= text.length) break;
      }
      this.char(text[at2++]);
    }
  }
  finish() {
    for (const c of this.decoder.end()) this.char(c);
    if (this.mode === "number" || this.mode === "literal") this.scalarEnd();
    if (this.mode !== "idle" || this.frames.length || !this.done) this.fail();
    if (!this.error && (!this.root || typeof this.root !== "object" || Array.isArray(this.root))) this.fail();
    if (!this.error && this.imageBodies.length) {
      const root = this.root, payload = root.payload;
      for (const body of this.imageBodies) {
        if (root.type === "response_item" && (payload?.type === "custom_tool_call_output" || payload?.type === "function_call_output") && body.frame.value?.type === "input_image") continue;
        if (body.overflow) this.fail("native_metadata_bytes_limit");
        else Object.defineProperty(body.frame.value, "image_url", { value: body.chunks.join(""), writable: true, enumerable: true, configurable: true });
      }
    }
    if (!this.error && Buffer.byteLength(JSON.stringify(this.root)) > this.maxBytes) this.fail("native_metadata_bytes_limit");
    return { record: this.error ? null : this.root, code: this.error, exclusionMarker: this.marker };
  }
};

// packages/core/src/analytics/native-usage.ts
import { createHash as createHash4 } from "node:crypto";
var obj = (v) => v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};
var str = (...v) => v.find((x) => typeof x === "string" && x.length > 0) ?? null;
var num2 = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
var cost = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
var hash = (v) => createHash4("sha256").update(v).digest("hex");
var at = (v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 864e13 ? new Date(v).toISOString() : typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
function createNativeUsageAccumulator(harness, conversationId, options = {}) {
  let observed = 0, excluded = 0;
  const records = /* @__PURE__ */ new Map();
  let project = options.project ?? null, model = null, provider = null, session = conversationId, offset = 0, seq = 0;
  let previous = null;
  const seenTotals = /* @__PURE__ */ new Set();
  const identities = /* @__PURE__ */ new Map();
  const score = (v) => (v.inputTokens ?? 0) + (v.outputTokens ?? 0) + (v.cacheReadTokens ?? 0) + Math.max(v.cacheWriteTokens ?? 0, (v.cacheWrite5mTokens ?? 0) + (v.cacheWrite1hTokens ?? 0)) + (v.reasoningTokens ?? 0);
  const put = (r) => {
    const old = records.get(r.id), identity = identities.get(r.id) ?? { models: /* @__PURE__ */ new Set(), providers: /* @__PURE__ */ new Set() };
    if (r.model !== null) identity.models.add(r.model);
    if (r.provider !== null) identity.providers.add(r.provider);
    identities.set(r.id, identity);
    const chosen = !old || score(r) > score(old) ? r : old;
    const conflict = identity.models.size > 1 || identity.providers.size > 1;
    records.set(r.id, conflict ? { ...chosen, model: null, provider: null, gaps: [.../* @__PURE__ */ new Set([...chosen.gaps, "response_identity_model_conflict"])] } : chosen);
  };
  const pushRecord = (record, position) => {
    const start = position?.rawStart ?? offset;
    if (position) offset = position.rawEnd;
    if (++seq > (options.maxRecords ?? 1e5)) return;
    let r = record;
    if (harness === "opencode") {
      r = { ...r, ...obj(r.message) };
      const wrapped = r.data ?? r.content;
      if (typeof wrapped === "string") {
        try {
          r = { ...r, ...obj(JSON.parse(wrapped)) };
        } catch {
        }
      } else if (wrapped && typeof wrapped === "object") r = { ...r, ...obj(wrapped) };
    }
    const p = obj(r.payload), m = obj(r.message);
    project = str(r.cwd, p.cwd, r.directory) ?? project;
    if (harness === "claude") session = str(r.sessionId) ?? session;
    if (harness === "pi" && r.type === "session") session = str(r.id) ?? session;
    if (harness === "codex" && (r.type === "session_meta" || r.type === "turn_context")) {
      session = str(p.session_id, p.id) ?? session;
      model = str(p.model) ?? model;
      provider = str(p.model_provider, p.provider) ?? provider;
      return;
    }
    const eventAt = at(r.timestamp) ?? at(m.timestamp) ?? at(obj(r.time).created);
    const key = str(r.uuid, r.id, p.id, m.id) ?? `record:${seq}`;
    const accepted = options.acceptRecord?.(r, { key, rawStart: start, rawEnd: offset, eventAt, project }) ?? true;
    let input = null, output = null, read = null, write = null, reasoning = null, reported = null;
    let observedModel = null, observedProvider = null, id, basis, includesCache = false, includesReasoning = true;
    const gaps = [];
    if (harness === "codex") {
      if (r.type !== "event_msg" || p.type !== "token_count") return;
      const info = obj(p.info), last = obj(info.last_token_usage), total = obj(info.total_token_usage);
      if (!Object.keys(last).length && !Object.keys(total).length) return;
      observed++;
      const previousTotal = previous;
      previous = Object.keys(total).length ? total : previous;
      const signature = Object.keys(total).length ? JSON.stringify([session, total.input_tokens, total.output_tokens, total.cached_input_tokens, total.reasoning_output_tokens]) : null;
      if (signature && seenTotals.has(signature)) return;
      if (signature) seenTotals.add(signature);
      const delta = (field) => {
        const current = num2(total[field]), prev = num2(previousTotal?.[field]);
        return current === null || prev === null || current < prev ? null : current - prev;
      };
      const firstComplete = previousTotal === null && num2(last.input_tokens) !== null && last.input_tokens === total.input_tokens && last.output_tokens === total.output_tokens;
      const bucket = (field) => num2(last[field]) ?? delta(field) ?? (firstComplete ? num2(total[field]) : null);
      input = bucket("input_tokens");
      output = bucket("output_tokens");
      read = bucket("cached_input_tokens");
      write = bucket("cache_write_input_tokens");
      reasoning = bucket("reasoning_output_tokens");
      if (!Object.keys(last).length && previousTotal === null) gaps.push("cumulative_baseline_unknown");
      if (previousTotal && Object.keys(total).length && ["input_tokens", "output_tokens"].some((k) => num2(total[k]) !== null && num2(previousTotal[k]) !== null && num2(total[k]) < num2(previousTotal[k]))) gaps.push("cumulative_counter_reset");
      observedModel = str(p.model, info.model) ?? model;
      observedProvider = str(p.model_provider, p.provider, info.provider) ?? provider;
      includesCache = true;
      basis = "codex_last_response_with_cumulative_dedup";
      id = `codex:${hash(JSON.stringify([session, str(p.response_id, info.response_id) ?? signature ?? [eventAt, last]]))}`;
      write = write ?? 0;
    } else if (harness === "claude") {
      if (r.type !== "assistant" || m.role !== "assistant") return;
      const u = obj(m.usage);
      input = num2(u.input_tokens);
      output = num2(u.output_tokens);
      read = num2(u.cache_read_input_tokens) ?? (input !== null ? 0 : null);
      write = num2(u.cache_creation_input_tokens) ?? (input !== null ? 0 : null);
      reasoning = num2(u.reasoning_tokens);
      const duration = obj(u.cache_creation);
      const five = num2(duration.ephemeral_5m_input_tokens), hour = num2(duration.ephemeral_1h_input_tokens);
      if (five !== null && hour !== null && write !== null && five + hour !== write) gaps.push("cache_write_duration_conflict");
      if (hour !== null && hour > 0 && (five === null || write === null || five + hour !== write)) gaps.push("cache_write_duration_unknown");
      observedModel = str(m.model, r.model);
      observedProvider = str(m.provider, r.provider, r.modelProvider);
      reported = cost(r.costUSD) ?? cost(m.costUSD);
      basis = "claude_response_usage";
      id = `claude:${hash(JSON.stringify([str(m.id, r.uuid) ?? key, str(r.requestId) ?? [session, eventAt]]))}`;
    } else if (harness === "pi") {
      if (r.type !== "message" || m.role !== "assistant") return;
      const u = obj(m.usage);
      input = num2(u.input);
      output = num2(u.output);
      read = num2(u.cacheRead) ?? (input !== null ? 0 : null);
      write = num2(u.cacheWrite) ?? (input !== null ? 0 : null);
      reasoning = num2(u.reasoning);
      reported = cost(obj(u.cost).total);
      observedModel = str(m.model);
      observedProvider = str(m.provider);
      basis = "pi_response_usage";
      id = `pi:${hash(JSON.stringify([session, str(r.id) ?? key, eventAt]))}`;
    } else {
      if (r.role !== "assistant") return;
      const u = obj(r.tokens), cache = obj(u.cache);
      input = num2(u.input);
      output = num2(u.output);
      read = num2(cache.read) ?? (input !== null ? 0 : null);
      write = num2(cache.write) ?? (input !== null ? 0 : null);
      reasoning = num2(u.reasoning);
      reported = cost(r.cost);
      observedModel = str(r.modelID, obj(r.model).modelID, obj(r.model).id, r.model);
      observedProvider = str(r.providerID, obj(r.model).providerID, r.provider);
      basis = "opencode_response_tokens";
      includesReasoning = false;
      id = `opencode:${str(r.id) ?? hash(JSON.stringify([conversationId, key, eventAt]))}`;
    }
    if (observedModel === "codex-auto-review") {
      observedModel = null;
      gaps.push("workflow_model_identity_unavailable");
    }
    if (harness !== "codex") observed++;
    if (r.isSynthetic === true || r.isMeta === true || m.isSynthetic === true || observedModel === "<synthetic>") {
      excluded++;
      return;
    }
    if (!accepted) {
      excluded++;
      return;
    }
    if (!observedModel) gaps.push("model_unrecorded");
    if (!observedProvider) gaps.push("provider_unrecorded");
    if (input === null || output === null) gaps.push("usage_partial");
    if (includesCache && read === null) gaps.push("cache_inclusion_unknown");
    if (includesCache && input !== null && read !== null && write !== null && read + write > input) gaps.push("cache_exceeds_input");
    if (includesReasoning && output !== null && reasoning !== null && reasoning > output) gaps.push("reasoning_exceeds_output");
    put({ id, conversationId, harness, eventAt, project, provider: observedProvider, model: observedModel, canonicalModel: null, inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write, reasoningTokens: reasoning, inputIncludesCache: includesCache, outputIncludesReasoning: includesReasoning, reportedCostUsd: reported, basis, gaps, ...harness === "claude" ? { cacheWrite5mTokens: num2(obj(obj(m.usage).cache_creation).ephemeral_5m_input_tokens), cacheWrite1hTokens: num2(obj(obj(m.usage).cache_creation).ephemeral_1h_input_tokens) } : {} });
  };
  const pushLine = (line) => {
    const start = offset;
    offset += Buffer.byteLength(line) + 1;
    if (!line.trim()) return;
    let r;
    try {
      r = obj(JSON.parse(line));
    } catch {
      seq++;
      return;
    }
    pushRecord(r, { rawStart: start, rawEnd: offset });
  };
  return { pushRecord, invalidateContext: () => {
    project = null;
    model = null;
    provider = null;
    previous = null;
  }, pushLine, records: () => [...records.values()], counts: () => ({ observed, excluded, deduplicated: Math.max(0, observed - excluded - records.size) }) };
}

// packages/core/src/analytics/native-stream.ts
async function streamNativeFacts(file, harness, options) {
  const before = fs.statSync(file, { bigint: true }), captureSize = options.captureFileBytes ?? Number(before.size);
  if (!before.isFile() || !Number.isSafeInteger(captureSize) || captureSize < 0 || captureSize > options.maxBytes) throw new Error("native_usage_bytes_limit");
  if (before.size < BigInt(captureSize) || options.expectedIdentity && (String(before.dev) !== options.expectedIdentity.dev || String(before.ino) !== options.expectedIdentity.ino)) throw new Error("source_changed");
  let nativeId = path.basename(file, ".jsonl"), project = null, parent = null, records = 0, offset = 0, promptBytes = 0, maintenance = false, programmatic = false, currentModel = null, currentProvider = null;
  const events = [], language = [], gaps = /* @__PURE__ */ new Set(), seen = /* @__PURE__ */ new Set(), hash2 = createHash5("sha256");
  let usage = null;
  let held = [], heldBytes = 0, projection = null, projected = false;
  const turnLimit = options.captureBytes ?? 0, turns = [];
  let turnLines = [], turnBytes = 0, turnPrefix = "", keptBytes = 0, capturedRecords = 0, scopeUncertain = false;
  const finishTurn = () => {
    if (!turnLines.length) {
      if (turnLimit > 0 && turnBytes > 0) gaps.add("context_turn_oversize");
      turnBytes = 0;
      return;
    }
    if (turnBytes + Buffer.byteLength(turnPrefix) <= turnLimit) {
      turns.push({ lines: turnLines, bytes: turnBytes, prefix: turnPrefix });
      keptBytes += turnBytes;
      while (turns.length > 1 && keptBytes + Buffer.byteLength(turns[0].prefix) > turnLimit) keptBytes -= turns.shift().bytes;
    } else gaps.add("context_turn_oversize");
    turnLines = [];
    turnBytes = 0;
  };
  const process2 = (raw, end) => {
    if (++records > (options.maxRecords ?? 1e6)) {
      gaps.add("native_usage_records_limit");
      return;
    }
    const line = raw.toString("utf8");
    let r;
    try {
      const parsed = JSON.parse(line);
      if (!isRecord(parsed)) return;
      r = parsed;
    } catch {
      gaps.add("malformed_record");
      return;
    }
    if (r.entrypoint === "sdk-ts" || r.originator === "codex_exec") programmatic = true;
    const p = isRecord(r.payload) ? r.payload : r;
    if (p.originator === "codex_exec" || p.source === "exec") programmatic = true;
    const m = isRecord(r.message) ? r.message : {};
    if (typeof r.cwd === "string") project = r.cwd;
    if (typeof p.cwd === "string") project = p.cwd;
    if (harness === "claude" && typeof r.sessionId === "string") {
      if (file.includes(`${path.sep}subagents${path.sep}`) || r.isSidechain === true) {
        parent = r.sessionId;
        nativeId = `${parent}:${path.basename(file, ".jsonl")}`;
      } else nativeId = r.sessionId;
    }
    if (harness === "codex" && r.type === "session_meta") {
      nativeId = typeof p.id === "string" ? p.id : typeof p.session_id === "string" ? p.session_id : nativeId;
      const source = isRecord(p.source) ? p.source : {}, sub = isRecord(source.subagent) ? source.subagent : {}, spawn = isRecord(sub.thread_spawn) ? sub.thread_spawn : {};
      if (typeof spawn.parent_thread_id === "string") parent = spawn.parent_thread_id;
    }
    if (harness === "pi" && r.type === "session") {
      if (typeof r.id === "string") nativeId = r.id;
      if (typeof r.parentSessionId === "string") parent = r.parentSessionId;
    }
    if (r.type === "turn_context" || r.type === "session_meta" || r.type === "model_change") {
      currentModel = typeof p.model === "string" ? p.model : typeof r.modelId === "string" ? r.modelId : currentModel;
      currentProvider = typeof p.model_provider === "string" ? p.model_provider : typeof r.provider === "string" ? r.provider : currentProvider;
    }
    if (scopeUncertain && project !== null && (harness === "claude" && typeof r.sessionId === "string" || harness === "codex" && r.type === "session_meta" && (typeof p.id === "string" || typeof p.session_id === "string") || harness === "pi" && r.type === "session" && typeof r.id === "string")) scopeUncertain = false;
    if (options.sourceAllowed && !options.sourceAllowed(nativeId, project)) throw new Error("native_source_policy_excluded");
    if (hasExclusionMarker(extractTypedText(m.content)) || typeof p.message === "string" && hasExclusionMarker(p.message)) maintenance = true;
    const isInput = harness === "claude" && r.type === "user" && m.role === "user" && !(Array.isArray(m.content) && m.content.some((b) => isRecord(b) && b.type === "tool_result")) || harness === "codex" && r.type === "event_msg" && p.type === "user_message" || harness === "pi" && r.type === "message" && m.role === "user";
    if (isInput) {
      finishTurn();
      turnPrefix = JSON.stringify({ type: "turn_context", payload: { cwd: project, model: currentModel, model_provider: currentProvider } }) + "\n";
    }
    if (projected && turnLimit > 0) {
      turnLines = [];
      turnBytes = turnLimit + 1;
      gaps.add("context_turn_oversize");
    }
    if (turnLimit > 0 && !projected && turnBytes <= turnLimit) {
      const recordKey = typeof r.uuid === "string" ? r.uuid : typeof r.id === "string" ? r.id : typeof p.id === "string" ? p.id : `record:${records}`;
      const encoded = JSON.stringify({ ...r, _auditRecordKey: recordKey }) + "\n";
      turnBytes += Buffer.byteLength(encoded);
      if (turnBytes <= turnLimit) turnLines.push(encoded);
      else if (turnLines.length) turnLines = [];
    }
    if (!usage) usage = createNativeUsageAccumulator(harness, sourceId(harness, nativeId), { maxRecords: 1e6, acceptRecord: (_r, scope) => !maintenance && !scopeUncertain && options.accept(scope.project, scope.eventAt) });
    usage.pushRecord(r, { rawStart: offset, rawEnd: end });
    if (scopeUncertain) return;
    let text = "", identity = "", origin = "unknown", eligible = false, excluded = null;
    const time = clock(r.timestamp), key = typeof r.uuid === "string" ? r.uuid : typeof r.id === "string" ? r.id : typeof p.id === "string" ? p.id : `record:${records}`;
    if (harness === "claude" && r.type === "user" && m.role === "user") {
      if (Array.isArray(m.content) && m.content.some((b) => isRecord(b) && b.type === "tool_result")) return;
      text = extractTypedText(m.content);
      identity = typeof r.promptId === "string" ? `prompt:${r.promptId}` : `record:${key}`;
      origin = typeof r.promptId === "string" ? "claude_prompt_id" : "unknown";
      eligible = typeof r.promptId === "string" && !programmatic;
    } else if (harness === "codex" && r.type === "event_msg" && p.type === "user_message") {
      text = typeof p.message === "string" ? p.message : "";
      identity = `marker:${offset}`;
      origin = programmatic ? "unknown" : "codex_human_marker";
      eligible = !programmatic;
    } else if (harness === "pi" && r.type === "message" && m.role === "user") {
      text = extractTypedText(m.content);
      identity = `node:${key}`;
      origin = "pi_user_projection";
    } else {
      const info = isRecord(p.info) ? p.info : {};
      const observedModel = typeof m.model === "string" ? m.model : typeof p.model === "string" ? p.model : typeof r.model === "string" ? r.model : typeof info.model === "string" ? info.model : currentModel, observedProvider = typeof m.provider === "string" ? m.provider : typeof p.model_provider === "string" ? p.model_provider : typeof p.provider === "string" ? p.provider : typeof r.provider === "string" ? r.provider : currentProvider;
      if ((m.role === "assistant" || harness === "codex" && (r.type === "event_msg" && p.type === "token_count" || r.type === "response_item" && p.type === "message" && p.role === "assistant")) && observedModel !== "<synthetic>" && r.isSynthetic !== true && options.accept(project, time)) language.push({ id: `metadata:${records}`, conversationId: sourceId(harness, nativeId), parentId: parent, harness, eventAt: time, project, role: "assistant", text: "", model: observedModel === "codex-auto-review" ? null : observedModel, provider: observedProvider, directUser: false, route: null });
      return;
    }
    if (!text.trim() && !projected) return;
    if (hasExclusionMarker(text)) {
      maintenance = true;
      excluded = "maintenance_exclusion_marker";
    } else if (r.isMeta === true || r.isSynthetic === true || m.isSynthetic === true) excluded = "declared_meta_or_synthetic_input";
    else if (parent && events.length === 0) excluded = "child_initialization";
    else if (typeof r.session_id === "string" && r.session_id !== nativeId) excluded = "inherited_identity_unverified";
    if (seen.has(identity)) return;
    seen.add(identity);
    if (!options.accept(project, time)) return;
    const redacted = clean(text);
    if (promptBytes + Buffer.byteLength(redacted) > (options.maxPromptBytes ?? 64 * 1024 * 1024)) {
      gaps.add("native_input_text_limit");
      return;
    }
    promptBytes += Buffer.byteLength(redacted);
    language.push({ id: digest(`${sourceId(harness, nativeId)}:${identity}`).slice(0, 32), conversationId: sourceId(harness, nativeId), parentId: parent, harness, eventAt: time, project, role: "user", text: "", model: null, provider: null, directUser: excluded === null && parent === null, route: null });
    const proofRecord = { ...r };
    delete proofRecord.sessionId;
    delete proofRecord.session_id;
    delete proofRecord.promptId;
    const stable = (value) => Array.isArray(value) ? value.map(stable) : isRecord(value) ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])])) : value;
    events.push({ key, rawStart: offset, rawEnd: end, role: "user", text: redacted, eventAt: time, project, origin, eligible: eligible && excluded === null && parent === null, languageEligible: parent === null && !projected, excluded, identity, observed: excluded === null, ...harness === "claude" && typeof r.uuid === "string" ? { nativeRecordId: r.uuid, recordCommitment: digest(JSON.stringify(stable(proofRecord))) } : {}, ...harness === "claude" && typeof r.session_id === "string" && r.session_id !== nativeId ? { declaredOrigin: r.session_id } : {} });
  };
  const finishLine = (end) => {
    if (projection) {
      const result = projection.finish();
      projection = null;
      gaps.add("native_record_body_omitted");
      if (result.exclusionMarker) maintenance = true;
      if (result.record) {
        projected = true;
        process2(Buffer.from(JSON.stringify(result.record)), end);
        projected = false;
      } else {
        turnLines = [];
        turnBytes = turnLimit + 1;
        records++;
        gaps.add(result.code ?? "native_metadata_invalid");
        gaps.add("native_scope_record_unavailable");
        usage?.invalidateContext();
        scopeUncertain = true;
        project = null;
        currentModel = null;
        currentProvider = null;
      }
    } else process2(held.length === 1 ? held[0] : Buffer.concat(held, heldBytes), end);
    held = [];
    heldBytes = 0;
    offset = end;
  };
  const stream = fs.createReadStream(file, { highWaterMark: 64 * 1024, ...captureSize > 0 ? { end: captureSize - 1 } : {} });
  try {
    let consumed = 0;
    for await (const chunk of captureSize === 0 ? [] : stream) {
      if (options.signal.aborted) {
        stream.destroy();
        throw new Error("cancelled");
      }
      const bytes = chunk;
      hash2.update(bytes);
      let at2 = 0;
      while (at2 < bytes.length) {
        const newline = bytes.indexOf(10, at2), end = newline < 0 ? bytes.length : newline, part = bytes.subarray(at2, end);
        if (projection) projection.push(part);
        else if (heldBytes + part.length > 8 * 1024 * 1024) {
          projection = new NativeMetadataProjection(void 0, harness);
          for (const piece of held) projection.push(piece);
          projection.push(part);
          held = [];
          heldBytes = 0;
        } else {
          held.push(part);
          heldBytes += part.length;
        }
        if (newline < 0) break;
        finishLine(consumed + newline + 1);
        at2 = newline + 1;
      }
      consumed += bytes.length;
    }
  } finally {
    stream.destroy();
  }
  if (heldBytes || projection) gaps.add("unfinished_tail");
  const after = fs.statSync(file, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || after.size < BigInt(captureSize)) throw new Error("source_changed");
  if (BigInt(captureSize) !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    const verify = createHash5("sha256"), fd = fs.openSync(file, "r"), buffer = Buffer.allocUnsafe(65536);
    try {
      let at2 = 0;
      while (at2 < captureSize) {
        const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, captureSize - at2), at2);
        if (!n) throw new Error("source_changed");
        verify.update(buffer.subarray(0, n));
        at2 += n;
      }
    } finally {
      fs.closeSync(fd);
    }
    if (verify.digest("hex") !== hash2.copy().digest("hex")) throw new Error("source_changed");
    gaps.add("native_appended_after_capture");
  }
  if (maintenance) {
    gaps.add("maintenance_source_excluded");
    for (const event of events) {
      event.observed = false;
      event.eligible = false;
      event.excluded = "maintenance_exclusion_marker";
    }
  }
  const artifactHash = hash2.digest("hex"), acc = usage, all = acc?.records() ?? [];
  finishTurn();
  const captured = Buffer.from((turns[0]?.prefix ?? "") + turns.flatMap((t) => t.lines).join(""));
  capturedRecords = turns.reduce((n, t) => n + t.lines.length, 0);
  if (turnLimit > 0 && capturedRecords < records) gaps.add("context_capture_partial");
  return { facts: { nativeId, project, parent, child: parent !== null, title: null, events, gaps: [...gaps], hash: artifactHash, consumed: offset, bytes: captured }, usage: maintenance ? [] : all, language: maintenance ? [] : language, hash: artifactHash, bytes: captureSize, stamp: { dev: String(after.dev), ino: String(after.ino), size: Number(after.size), mtimeNs: String(after.mtimeNs), ctimeNs: String(after.ctimeNs) }, counts: maintenance ? { observed: acc?.counts().observed ?? 0, excluded: acc?.counts().observed ?? 0, deduplicated: 0 } : acc?.counts() ?? { observed: 0, excluded: 0, deduplicated: 0 } };
}

// packages/core/src/ignore.ts
function fold(value) {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
function matchesIgnoreEntry(project, entry) {
  if (!project) return false;
  const p = fold(project);
  const e = fold(entry);
  if (!p || !e) return false;
  if (p === e) return true;
  if (e.includes("/")) return p.startsWith(`${e}/`);
  return p.split("/").filter(Boolean).includes(e);
}
function isIgnoredProject(project, entries) {
  return entries.some((entry) => matchesIgnoreEntry(project, entry));
}

// packages/core/src/analytics/native-pool.ts
var PROTOCOL = "audit-native-v1";
var FRAME = 1024 * 1024;
var code = (error) => error instanceof Error && /^(?:[a-z][a-z0-9_]{0,95})$/.test(error.message) ? error.message : "native_worker_failed";
function runNativeScanWorker() {
  if (!parentPort) throw new Error("native_worker_requires_port");
  const port = parentPort;
  let busy = false;
  port.on("message", async (message) => {
    if (message.protocol !== PROTOCOL || message.kind !== "scan" || !message.job || busy) return;
    busy = true;
    const job = message.job;
    try {
      const policy = job.policy, forgotten = new Set(policy.forgottenSourceIds), accept = (project, time) => !(project && isIgnoredProject(project, policy.ignoredProjects)) && (!policy.project || project === policy.project) && (!policy.eventFrom || time !== null && time >= policy.eventFrom) && (!policy.asOf || time !== null && time <= policy.asOf);
      const snapshot = await streamNativeFacts(job.file, job.harness, { signal: new AbortController().signal, maxBytes: job.maxBytes, maxRecords: job.maxRecords, maxPromptBytes: job.maxPromptBytes, captureBytes: 0, captureFileBytes: job.bytes, expectedIdentity: { dev: job.stamp.dev, ino: job.stamp.ino }, sourceAllowed: (id, project) => !forgotten.has(sourceId(job.harness, id)) && !(project && isIgnoredProject(project, policy.ignoredProjects)), accept });
      const buffer = serialize(snapshot);
      if (buffer.length > (message.maxResultBytes ?? 256 * 1024 * 1024)) throw new Error("native_pool_result_bytes_limit");
      const hash2 = createHash6("sha256").update(buffer).digest("hex");
      let sequence = 0;
      for (let at2 = 0; at2 < buffer.length; at2 += FRAME) {
        const chunk = Uint8Array.from(buffer.subarray(at2, at2 + FRAME));
        port.postMessage({ protocol: PROTOCOL, kind: "frame", jobId: job.jobId, sequence: sequence++, data: chunk }, [chunk.buffer]);
      }
      port.postMessage({ protocol: PROTOCOL, kind: "result", jobId: job.jobId, authorityCommitment: policy.authorityCommitment, bytes: buffer.length, hash: hash2 });
    } catch (error) {
      port.postMessage({ protocol: PROTOCOL, kind: "error", jobId: job.jobId, code: code(error) });
    } finally {
      busy = false;
    }
  });
  port.postMessage({ protocol: PROTOCOL, kind: "ready" });
}

// packages/cli/src/audit-native-worker.ts
runNativeScanWorker();
//# sourceMappingURL=audit-native-worker.js.map

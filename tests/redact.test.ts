import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { db as store, Theme, type Exchange } from '@potsherd/core';
import {
  MASK_RE,
  elideBinary,
  elideExchange,
  maskFor,
  redact,
  redactExchange,
  redactText,
  redactionRow,
  redactionLine,
  secretDigest,
  shannonEntropy,
  tally,
  emptyCounts,
  addCounts,
  countsJson,
  RULES,
  SECRET_TYPES,
  type SecretType,
} from '../packages/core/src/redact.js';

// redact.ts is deliberately not re-exported from `packages/core/src/index.ts`
// yet: T1.4 ships the module, T1.5 wires it into the parser, the store and the
// cli. Importing the source directly keeps those two changes separable.

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures', 'secrets');
const PLANTED = fs.readFileSync(path.join(FIXTURES, 'planted.jsonl'), 'utf8');
const CLEAN = fs.readFileSync(path.join(FIXTURES, 'clean.txt'), 'utf8');
// The second clean fixture (T1.4b). `clean.txt` is ordinary code and prose;
// this one is agent-transcript text, which is a different distribution and is
// where the 165,088-mask regression actually lived.
const AGENT = fs.readFileSync(path.join(FIXTURES, 'agent-transcript.txt'), 'utf8');

/** The types the planted fixture plants, in file order. */
const PLANTED_TYPES: SecretType[] = [
  'aws',
  'github',
  'jwt',
  'private-key',
  'generic',
  'entropy',
  // T1.4b adversarial group, seq 8–12.
  'generic',
  'entropy',
  'entropy',
  'generic',
  'generic',
];

/** Every string in a parsed record, the way the store will hand them over. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
  return out;
}

function records(): Array<Record<string, unknown>> {
  return PLANTED.split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('planted fixture', () => {
  it('masks every planted secret, each with the right type', () => {
    const { hits } = redact(PLANTED);
    expect(hits.map((h) => h.type)).toEqual(PLANTED_TYPES);
    expect(hits).toHaveLength(11);
  });

  it('reports the type the fixture says to expect, record by record', () => {
    const seen: Array<string | undefined> = [];
    for (const rec of records()) {
      const hits = strings(rec).flatMap((s) => redact(s).hits);
      // The manifest and the two unplanted records must produce nothing at all.
      const expected = rec['_expect'] as string | undefined;
      if (expected === undefined) {
        expect(hits, `unplanted record ${JSON.stringify(rec['seq'] ?? 'manifest')}`).toEqual([]);
        continue;
      }
      expect(hits.map((h) => h.type), `seq ${String(rec['seq'])}`).toEqual([expected]);
      seen.push(expected);
    }
    expect(seen).toEqual(PLANTED_TYPES);
  });

  it('names, in the manifest, the rule that actually claimed each one', () => {
    // The manifest is documentation, and documentation that drifts is worse
    // than none: this keeps `rule` honest as the rule table is retuned.
    const manifest = records()[0] as { planted: Array<{ seq: number; rule: string }> };
    const byRule = new Map<number, string>();
    for (const rec of records()) {
      if (rec['_expect'] === undefined) continue;
      const hits = strings(rec).flatMap((s) => redact(s).hits);
      byRule.set(rec['seq'] as number, hits[0]?.rule ?? '');
    }
    for (const p of manifest.planted) {
      expect(byRule.get(p.seq), `seq ${p.seq}`).toBe(p.rule);
    }
  });

  it('leaves no fragment of any planted secret in the output', () => {
    const out = redact(PLANTED).text;
    for (const needle of [
      'AKIAIOSFODNN7EXAMPLE',
      'ghp_FAKE',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'BEGIN RSA PRIVATE KEY',
      'Zt7Qw3nR9pLxV2mKd6Hs4YbG1eUa0JfC',
      '9pV2kR8mZ4tL6wY0bN3cX5hJ1qA7sD-fG_eK2uT',
      // the T1.4b adversarial group
      '3f9a1c2e-7b4d-4e19-9a55-2c8d0f6b17ae',
      'Kq7nR2vX9bL4mT6yH1gF5dS8wJ3pQ7nR',
      'mAg88Rlsa9ceIZPJeEYvRLCakxSMohvLscv9OuJU',
      'toolu_9xQ2mR7bV4nK1pL8sT6yH3gF5dZ0aW',
      'paperclip-tuesday-harmonica-sandstone-9Fq2',
    ]) {
      expect(out).not.toContain(needle);
    }
    // …and the context around them survives, because a redacted transcript
    // that reads as nonsense is not worth indexing.
    expect(out).toContain('the deploy is failing on the upload step');
    expect(out).toContain('TOKEN=‹redacted:generic:');
  });
});

describe('clean fixture', () => {
  it('is 200 lines', () => {
    expect(CLEAN.replace(/\n$/, '').split('\n')).toHaveLength(200);
  });

  it('produces zero false positives', () => {
    const { hits, text } = redact(CLEAN);
    // Print what tripped, not just the count: a bare `expected 3 to be 0` on a
    // 200-line fixture is a bad half hour for whoever tuned the rule.
    const detail = hits.map((h) => `${h.type}/${h.rule}: ${CLEAN.slice(h.start, h.start + h.length)}`);
    expect(detail).toEqual([]);
    expect(text).toBe(CLEAN);
  });

  it('leaves the shapes that usually trip scanners byte-for-byte', () => {
    const out = redactText(CLEAN);
    for (const shape of [
      '9fceb02d0ae598e95dc970b74767f19372d61af8', // git sha1
      '550e8400-e29b-41d4-a716-446655440000', // uuid
      'data:image/png;base64,iVBORw0KGgo', // inlined png
      'sha512-Rt2wIrKPHKgf', // lockfile integrity
      'focus-visible:outline-offset-2', // tailwind
      '/var/folders/9k/j7q0x2rn1qv5w8t3b6c4d1m00000gn/T', // long path
      'consectetur adipiscing elit', // lorem ipsum
      'Xenova/bge-small-en-v1.5', // a model id next to `tokenizer:`
    ]) {
      expect(out).toContain(shape);
    }
  });
});

describe('agent-transcript fixture (T1.4b)', () => {
  // The regression this fixture exists for: `potsherd index --full` over the
  // reference corpus reported 165,088 masked secrets across 1,406 exchanges —
  // 117 per exchange — while `clean.txt` sat at zero false positives. Agent
  // transcripts are a different distribution: minted object ids, content
  // hashes, url slugs, and above all base64 image payloads in tool results.
  it('produces zero false positives through the pipeline ingest runs', () => {
    const { hits, text } = redact(elideBinary(AGENT));
    const detail = hits.map((h) => `${h.type}/${h.rule}: ${text.slice(h.start, h.start + h.length)}`);
    expect(detail).toEqual([]);
  });

  it('would not be clean without the elision pass — the pass is doing work', () => {
    // If this ever reaches zero the fixture has lost its image payload and the
    // test above stops proving anything.
    expect(redact(AGENT).hits.length).toBeGreaterThan(0);
    expect(elideBinary(AGENT)).not.toBe(AGENT);
  });

  it('leaves every agent identifier shape byte-for-byte', () => {
    const out = redactText(elideBinary(AGENT));
    for (const shape of [
      'toolu_014ZfaccgxvcYNpcTLq8qvkR',       // anthropic tool_use id
      'srvtoolu_01Vx8KmR3nP7qL2tY6wZ4bHf',    // anthropic server tool_use id
      'msg_01XFDUDYJgAACzvnptvVoYEL',         // anthropic message id
      'req_011CQm4Xt7Rk9vZ2pN8bY3sF',         // anthropic request id
      'chatcmpl-9xY2kP7mQ4vN8bR3tL6wZ1sHfDgJa', // openai completion id
      'call_9fJk2LmPq8sTvXyZ0aBcDeFg',        // openai tool call id
      'exec-4c9339e0-b186-4006-b5c1-e7537c8b9353', // prefixed uuid
      'agent-af69275032b68b31a',              // claude code sidechain id
      '01ARZ3NDEKTSV4RRFFQ69G5FAV',           // ulid
      '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03', // sha256
      'blake3-af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262',
      'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=', // SRI
      'ANTHROPIC_VERTEX_PROJECT_ID=gpu-reservation-sarvam', // the `=` glue class
      'reducto-has-just-raised-a-75m-series-b-activity-7383909473913880576-ba7M',
      '0123456789ABCDEFGHJKMNPQRSTVWXYZ',     // crockford base32 table
      'layout-4f8b2c1e9d6a0537.js',           // bundler hash
    ]) {
      expect(out, shape).toContain(shape);
    }
  });
});

describe('binary elision', () => {
  const png = /"data":"(iVBORw0[^"]+)"/.exec(AGENT)?.[1] ?? '';

  it('replaces an anthropic image content block with one marker', () => {
    expect(png.length).toBeGreaterThan(512);
    const block = `[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"${png}"}}]`;
    const out = elideBinary(block);
    expect(out).toContain(`‹elided:image/png:${png.length} bytes›`);
    expect(out).not.toContain(png.slice(0, 40));
    expect(out.length).toBeLessThan(200);
  });

  it('replaces a data: URI, the shape the codex adapter already elided', () => {
    const uri = `data:image/png;base64,${png}`;
    expect(elideBinary(`![shot](${uri})`)).toBe(`![shot](‹elided:image/png:${uri.length} bytes›)`);
  });

  it('replaces a bare payload that carries a file magic', () => {
    const out = elideBinary(`$ base64 shot.png\n${png}\ndone`);
    expect(out).toContain('‹elided:image/png:');
    expect(out).toContain('done');
  });

  it('is idempotent — the marker holds no payload of its own', () => {
    const once = elideBinary(`x ${png} y`);
    expect(elideBinary(once)).toBe(once);
    expect(redact(once).hits).toEqual([]);
  });

  it('leaves a private key block for the redactor, however long', () => {
    // Elision runs first, so a pass that ate PEM bodies would silently turn a
    // leaked key into a marker and report zero secrets.
    const body = Array.from({ length: 12 }, () =>
      'RkFLRUtFWUZBS0VLRVlGQUtFS0VZRkFLRUtFWUZBS0VLRVlGQUtFS0VZRkFLRUtF').join('\n');
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
    expect(body.length).toBeGreaterThan(512);
    expect(elideBinary(pem)).toBe(pem);
    expect(redact(pem).hits.map((h) => h.type)).toEqual(['private-key']);
  });

  it('leaves a long base64 value that has no media context and no magic', () => {
    // The planted seq-10 case, isolated: `"data": "<640 chars>"` with nothing
    // around it saying `base64` or naming a mime type.
    const blob = 'mAg88Rlsa9ceIZPJeEYvRLCakxSMohvLscv9OuJUZPJtjHQDm1O9sYSp75q4z5HC1S2f6rKp'.repeat(9);
    const json = `{"kind":"service-account","data":"${blob}"}`;
    expect(blob.length).toBeGreaterThan(512);
    expect(elideBinary(json)).toBe(json);
    expect(redact(json).hits.map((h) => h.type)).toEqual(['entropy']);
  });

  it('elides every field 03 §5 redacts, without mutating the input', () => {
    const ex: Exchange = {
      id: 'x1', sessionId: 's1', seq: 1, ts: '2026-08-19T09:00:00.000Z',
      userText: 'here is the screenshot',
      assistantText: 'I can see it',
      toolCalls: [{ name: 'Read', input: '{"file_path":"/tmp/shot.png"}', result: `[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"${png}"}}]` }],
      filesTouched: ['/tmp/shot.png'], isSidechain: false, redacted: false,
    };
    const before = JSON.stringify(ex);
    const { exchange, elisions } = elideExchange(ex);
    expect(elisions.binaryParts).toBe(1);
    expect(elisions.charsElided).toBe(png.length);
    expect(exchange.toolCalls[0]?.result).toContain('‹elided:image/png:');
    expect(JSON.stringify(ex)).toBe(before);
  });

  it('returns the same object when there is nothing binary to drop', () => {
    const ex: Exchange = {
      id: 'x1', sessionId: 's1', seq: 1, ts: '2026-08-19T09:00:00.000Z',
      userText: 'nothing binary here', assistantText: 'agreed', toolCalls: [],
      filesTouched: [], isSidechain: false, redacted: false,
    };
    const { exchange, elisions } = elideExchange(ex);
    expect(exchange).toBe(ex);
    expect(elisions).toEqual({ binaryParts: 0, charsElided: 0 });
  });
});

describe('adversarial planted cases (T1.4b)', () => {
  // Three or more secrets that a naive "just exclude the identifiers" fix
  // would wrongly let through. The rule they hold in place: a shape exclusion
  // applies only to a *bare* token; a value in a credential-shaped position is
  // claimed by an earlier rule that never consults the allowlist.
  const cases: Array<[name: string, line: string, type: SecretType, secret: string]> = [
    [
      'a signing secret shaped exactly like a uuid',
      'WEBHOOK_SIGNING_SECRET=3f9a1c2e-7b4d-4e19-9a55-2c8d0f6b17ae',
      'generic',
      '3f9a1c2e-7b4d-4e19-9a55-2c8d0f6b17ae',
    ],
    [
      'a credential bound to a variable called id',
      'the worker connects with id = Kq7nR2vX9bL4mT6yH1gF5dS8wJ3pQ7nR and the broker closes the socket',
      'entropy',
      'Kq7nR2vX9bL4mT6yH1gF5dS8wJ3pQ7nR',
    ],
    [
      'an api key under the toolu_ prefix the entropy rule excludes',
      'ANTHROPIC_API_KEY=toolu_9xQ2mR7bV4nK1pL8sT6yH3gF5dZ0aW',
      'generic',
      'toolu_9xQ2mR7bV4nK1pL8sT6yH3gF5dZ0aW',
    ],
    [
      'a four-word passphrase, which the prose exclusion drops as a bare token',
      'curl -H "Authorization: Bearer paperclip-tuesday-harmonica-sandstone-9Fq2" https://api.internal.test/v1/jobs',
      'generic',
      'paperclip-tuesday-harmonica-sandstone-9Fq2',
    ],
    [
      'an api key that is a bare uuid in a json body',
      '{"apiKey":"a1b2c3d4-e5f6-4789-abcd-0123456789ef"}',
      'generic',
      'a1b2c3d4-e5f6-4789-abcd-0123456789ef',
    ],
  ];

  for (const [name, line, type, secret] of cases) {
    it(`still catches ${name}`, () => {
      const { text, hits } = redact(line);
      expect(hits.map((h) => h.type)).toEqual([type]);
      expect(text).not.toContain(secret);
      expect(text).toContain(maskFor(type, secret));
    });
  }

  it('the same values are invisible to the bare entropy rule, which is the point', () => {
    // Each secret above, on its own with no context. The uuid, the toolu_ id
    // and the passphrase are all excluded by shape — only the context rules
    // saved them. (The `id =` case is the exception: it has no context, which
    // is exactly why the entropy fallback must survive.)
    for (const bare of [
      '3f9a1c2e-7b4d-4e19-9a55-2c8d0f6b17ae',
      'toolu_9xQ2mR7bV4nK1pL8sT6yH3gF5dZ0aW',
      'paperclip-tuesday-harmonica-sandstone-9Fq2',
    ]) {
      expect(redact(`saw ${bare} in the log`).hits, bare).toEqual([]);
    }
    expect(redact('saw Kq7nR2vX9bL4mT6yH1gF5dS8wJ3pQ7nR in the log').hits.map((h) => h.type))
      .toEqual(['entropy']);
  });
});

describe('the mask', () => {
  const SECRET = 'AKIAIOSFODNN7EXAMPLE';

  it('is ‹redacted:<type>:<sha8>› with sha8 = the sha256 prefix', () => {
    const { text, hits } = redact(`aws_access_key_id ${SECRET}`);
    const sha8 = createHash('sha256').update(SECRET).digest('hex').slice(0, 8);
    expect(text).toBe(`aws_access_key_id ‹redacted:aws:${sha8}›`);
    expect(hits[0]?.sha8).toBe(sha8);
    expect(secretDigest(SECRET)).toBe(sha8);
    expect(maskFor('aws', SECRET)).toBe(`‹redacted:aws:${sha8}›`);
    expect(text.match(MASK_RE)).toHaveLength(1);
  });

  it('maps the same secret to the same mask wherever it appears', () => {
    const a = redact(`first sighting: ${SECRET}`);
    const b = redact(`months later, in another project, ${SECRET} again`);
    const mask = maskFor('aws', SECRET);
    expect(a.text).toContain(mask);
    expect(b.text).toContain(mask);
    expect(a.hits[0]?.sha8).toBe(b.hits[0]?.sha8);
  });

  it('never maps two different secrets to the same mask', () => {
    const masks = new Set<string>();
    const digests = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const secret = `AKIA${String(i).padStart(4, '0')}FAKEFAKEFAKE`;
      const { text, hits } = redact(secret);
      masks.add(text);
      digests.add(hits[0]?.sha8 ?? '');
    }
    expect(masks.size).toBe(500);
    expect(digests.size).toBe(500);
  });

  it('uses guillemets, which cannot occur in a shell token or a base64 blob', () => {
    const mask = maskFor('jwt', 'anything');
    expect(mask.startsWith('‹')).toBe(true);
    expect(mask.endsWith('›')).toBe(true);
    expect(/[‹›]/.test(CLEAN)).toBe(false);
  });

  it('survives fts5 tokenisation as three searchable tokens', () => {
    // The claim in redact.ts's header, checked against the sqlite this repo
    // actually ships rather than against the documentation.
    const db = store.open({ file: ':memory:' });
    try {
      db.exec('CREATE VIRTUAL TABLE t USING fts5(body)');
      const mask = maskFor('aws', SECRET);
      const sha8 = secretDigest(SECRET);
      db.prepare('INSERT INTO t(body) VALUES (?)').run(`the deploy used ${mask} again`);
      db.prepare('INSERT INTO t(body) VALUES (?)').run(`unrelated ${maskFor('jwt', 'other')} row`);

      db.exec("CREATE VIRTUAL TABLE vocab USING fts5vocab(t, 'row')");
      const terms = db.prepare('SELECT term FROM vocab ORDER BY term').all() as Array<{ term: string }>;
      expect(terms.map((r) => r.term)).toContain(sha8);
      expect(terms.map((r) => r.term)).toContain('redacted');
      expect(terms.map((r) => r.term)).toContain('aws');

      const hit = (q: string) => (db.prepare('SELECT rowid FROM t WHERE t MATCH ?').all(q) as Array<{ rowid: number }>).map((r) => r.rowid);
      // searchable by shape…
      expect(hit(sha8)).toEqual([1]);
      expect(hit('redacted AND aws')).toEqual([1]);
      expect(hit(`"redacted:aws:${sha8}"`)).toEqual([1]);
      expect(hit('redacted')).toEqual([1, 2]);
      // …and never by value.
      expect(hit(SECRET.toLowerCase())).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('idempotence', () => {
  const inputs: Array<[string, string]> = [
    ['planted fixture', PLANTED],
    ['clean fixture', CLEAN],
    ['agent-transcript fixture', elideBinary(AGENT)],
    ['one secret', 'export GITHUB_TOKEN=ghp_' + 'FAKE'.repeat(9)],
    ['two of the same', `${'AKIAIOSFODNN7EXAMPLE'} and again ${'AKIAIOSFODNN7EXAMPLE'}`],
  ];

  for (const [name, input] of inputs) {
    it(`redact(redact(x)) === redact(x) — ${name}`, () => {
      const once = redact(input);
      const twice = redact(once.text);
      expect(twice.text).toBe(once.text);
      expect(twice.hits).toEqual([]);
      // Three passes, because the second pass is where a mask that re-matched
      // itself would first show up.
      expect(redact(twice.text).text).toBe(once.text);
    });
  }
});

describe('rules', () => {
  const positives: Array<[SecretType, string, string]> = [
    ['aws', 'AKIAIOSFODNN7EXAMPLE', 'aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE'],
    ['aws', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
    ['gcp', `AIza${'FAKE'.repeat(8)}FAK`, `firebase key AIza${'FAKE'.repeat(8)}FAK in the config`],
    ['gcp', `GOCSPX-${'A'.repeat(28)}`, `client_secret is GOCSPX-${'A'.repeat(28)}`],
    ['github', `ghp_${'FAKE'.repeat(9)}`, `gh auth login --with-token <<< ghp_${'FAKE'.repeat(9)}`],
    ['github', `github_pat_${'A'.repeat(82)}`, `header: github_pat_${'A'.repeat(82)}`],
    ['slack', 'xoxb-0123456789-0123456789-FAKEFAKEFAKE', 'SLACK_BOT=xoxb-0123456789-0123456789-FAKEFAKEFAKE'],
    ['slack', 'https://hooks.slack.com/services/T00000000/B00000000/FAKEFAKEFAKEFAKE', 'posting to https://hooks.slack.com/services/T00000000/B00000000/FAKEFAKEFAKEFAKE'],
    ['stripe', `sk_test_${'FAKE'.repeat(6)}`, `stripe.setKey("sk_test_${'FAKE'.repeat(6)}")`],
    ['openai', `sk-proj-${'A'.repeat(20)}T3BlbkFJ${'B'.repeat(20)}`, `OPENAI_API_KEY=sk-proj-${'A'.repeat(20)}T3BlbkFJ${'B'.repeat(20)}`],
    ['openai', `sk-${'A'.repeat(48)}`, `legacy key sk-${'A'.repeat(48)} still in the file`],
    ['anthropic', `sk-ant-api03-${'F'.repeat(95)}`, `ANTHROPIC_API_KEY=sk-ant-api03-${'F'.repeat(95)}`],
    ['npm', `npm_${'FAKE'.repeat(9)}`, `//registry.npmjs.org/:_authToken=npm_${'FAKE'.repeat(9)}`],
    ['jwt', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMDAwMDAwMCIsImlhdCI6MX0.QNOTAREALSIGNATURE_0123456789', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMDAwMDAwMCIsImlhdCI6MX0.QNOTAREALSIGNATURE_0123456789'],
    ['basic-auth', '9pV2kR8mZ4tL6wY0', 'psql postgresql://svc:9pV2kR8mZ4tL6wY0@db.internal:5432/app'],
    ['generic', 'Zt7Qw3nR9pLxV2mKd6Hs4YbG1eUa0JfC', 'API_KEY="Zt7Qw3nR9pLxV2mKd6Hs4YbG1eUa0JfC"'],
    ['generic', 'Zt7Qw3nR9pLxV2mKd6Hs4YbG1eUa0JfC', '{"clientSecret": "Zt7Qw3nR9pLxV2mKd6Hs4YbG1eUa0JfC"}'],
    ['entropy', '9pV2kR8mZ4tL6wY0bN3cX5hJ1qA7sD-fG_eK2uT', 'X-Session-Id: 9pV2kR8mZ4tL6wY0bN3cX5hJ1qA7sD-fG_eK2uT'],
    // T1.4b: the http authorization header, a credential *context* rather than
    // a credential shape. It is what keeps the new entropy-shape exclusions
    // safe to hold.
    ['generic', 'Zt7Qw3nR9pLxV2mKd6Hs4YbG1eUa0JfC', 'curl -H "Authorization: Bearer Zt7Qw3nR9pLxV2mKd6Hs4YbG1eUa0JfC"'],
    ['generic', 'Zt7Qw3nR9pLxV2mKd6Hs4YbG1eUa0JfC', 'Authorization: Token Zt7Qw3nR9pLxV2mKd6Hs4YbG1eUa0JfC'],
  ];

  for (const [type, secret, line] of positives) {
    it(`masks ${type}: ${secret.slice(0, 18)}…`, () => {
      const { text, hits } = redact(line);
      expect(hits.map((h) => h.type)).toEqual([type]);
      expect(text).not.toContain(secret);
      expect(text).toContain(maskFor(type, secret));
    });
  }

  it('masks a private key block whole, header to footer', () => {
    const block = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'RkFLRUtFWUZBS0VLRVlGQUtFS0VZRkFLRUtFWUZBS0VLRVlGQUtFS0VZRkFLRUtF',
      'WUZBS0VLRVlGQUtFS0VZRkFLRUtFWUZBS0VLRVlUSElTSVNOT1RBS0VZAAAAAAAA',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const { text, hits } = redact(`the file holds:\n${block}\nand nothing else`);
    expect(hits.map((h) => h.type)).toEqual(['private-key']);
    expect(text).toBe(`the file holds:\n${maskFor('private-key', block)}\nand nothing else`);
  });

  it('masks an unterminated key block without eating the sentence after it', () => {
    const body = 'RkFLRUtFWUZBS0VLRVlGQUtFS0VZRkFLRUtFWUZBS0VLRVlGQUtFS0VZRkFLRUtF';
    const { text, hits } = redact(
      `-----BEGIN RSA PRIVATE KEY-----\n${body}\n(elided)\nand then I rotated it and moved on`,
    );
    expect(hits.map((h) => h.type)).toEqual(['private-key']);
    expect(text).not.toContain(body);
    expect(text).toContain('and then I rotated it and moved on');
  });

  it('still fires on a plural name — apiKeys is not a stopword', () => {
    const { hits } = redact('apiKeys = "Zt7Qw3nR9pLxV2mKd6Hs4YbG1eUa0JfC"');
    expect(hits.map((h) => h.type)).toEqual(['generic']);
  });

  const negatives: string[] = [
    'const tokenizer = new Tokenizer({ model: "Xenova/bge-small-en-v1.5" });',
    'password: formData.password,',
    'const hashedPassword = await bcrypt.hash(plaintext, 12);',
    'export GITHUB_TOKEN=$GITHUB_TOKEN',
    'NPM_TOKEN: ${{ secrets.NPM_TOKEN }}',
    'API_KEY=your-api-key-here',
    'apiKey: process.env.API_KEY',
    'Authorization: Bearer ${token}',
    'the monkey: donkey-whiskey-turkey-jockey',
    'commit 9fceb02d0ae598e95dc970b74767f19372d61af8',
    'session 550e8400-e29b-41d4-a716-446655440000 resumed',
    'psql "postgresql://app:${DB_PASSWORD}@db.internal:5432/app"',
    'curl -u user:pass https://proxy.internal:3128/status',
    '"integrity": "sha512-Rt2wIrKPHKgfQOWTKBrAQCP0oGnMhOOKOZBnKpGkbn/GRnEXAqTIrCXtIWKKe0Ai"',
    'pk_live_51H8xKzFAKEFAKEFAKEFAKEFAKE is publishable by design',
    'apiKey: string;',
    'let apiKey: Promise<string> = resolveKey();',
    // T1.4b — the shapes that made the reference corpus report 117 masks per
    // exchange. Each is a *bare* token: none is in a credential position.
    'tool_use id toolu_014ZfaccgxvcYNpcTLq8qvkR name=Read',              // E1
    'assistant turn msg_01XFDUDYJgAACzvnptvVoYEL answered in 4.2s',      // E1
    'x-request-id: req_011CQm4Xt7Rk9vZ2pN8bY3sF',                        // E1
    'call_9fJk2LmPq8sTvXyZ0aBcDeFg returned two files',                  // E1
    'exec-4c9339e0-b186-4006-b5c1-e7537c8b9353 finished with status 0',  // E2b
    'blake3-af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262', // E4
    '01ARZ3NDEKTSV4RRFFQ69G5FAV was minted at 2016-07-30T23:36:17Z',     // E5
    'https://www.linkedin.com/posts/y-combinator_reducto-has-just-raised-a-75m-series-b-activity-7383909473913880576-ba7M', // E6
    'https://r.jina.ai/https%3A%2F%2Fexample.com%2Fposts%2Freducto-ai_weve-raised-a-245m-series-a-led-by-benchmark-activity-7321593705629376512-69ej', // E6
    'const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";',             // E7
    'ANTHROPIC_VERTEX_PROJECT_ID=gpu-reservation-sarvam',                // `=` glue
    'Authorization: Bearer <YOUR_TOKEN_HERE>',
    'Authorization: Bearer $ACCESS_TOKEN',
  ];

  for (const line of negatives) {
    it(`leaves alone: ${line.slice(0, 44)}`, () => {
      expect(redact(line).hits).toEqual([]);
    });
  }

  it('every rule names the upstream pack it was ported from', () => {
    for (const rule of RULES) {
      expect(rule.source, rule.id).toMatch(/gitleaks|secretlint|03 §5/);
      expect(rule.source, rule.id).toMatch(/MIT|03 §5/);
      expect(SECRET_TYPES).toContain(rule.type);
    }
    // Every family in `03` §5 has at least one rule.
    const covered = new Set(RULES.map((r) => r.type));
    for (const t of SECRET_TYPES) expect(covered, `no rule for ${t}`).toContain(t);
  });
});

describe('entropy', () => {
  it('is bits per character, capped by the sample length', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('aaaaaaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBeCloseTo(2, 6);
    // 20 chars can hold at most log2(20) = 4.32 bits, which is why the 4.5
    // threshold in `03` §5 cannot fire below 23 characters.
    expect(shannonEntropy('abcdefghijklmnopqrst')).toBeLessThan(4.5);
  });

  it('is under threshold for hex digests and uuids at any length', () => {
    expect(shannonEntropy('9fceb02d0ae598e95dc970b74767f19372d61af8')).toBeLessThan(4.5);
    expect(shannonEntropy('550e8400-e29b-41d4-a716-446655440000')).toBeLessThan(4.5);
  });

  it('cannot tell random from merely varied, which is why shape rules exist', () => {
    // The measurement behind exclusion E6. Both of these clear `03` §5's bar;
    // one is a LinkedIn permalink and one is a base32 alphabet constant.
    const slug = 'y-combinator_reducto-has-just-raised-a-75m-series-b-activity-7383909473913880576-ba7M';
    expect(shannonEntropy(slug)).toBeGreaterThan(4.5);
    expect(shannonEntropy('0123456789ABCDEFGHJKMNPQRSTVWXYZ')).toBeGreaterThan(4.5);
    expect(redact(slug).hits).toEqual([]);
  });

  it('trims json and percent escape residue, so one secret is one mask', () => {
    // `\ntvly-…` used to yield the token `ntvly-…`: the same secret with a
    // different first character, a different sha8 and a different mask. Same
    // for `%2F`-prefixed and `KEY=`-glued captures.
    const secret = '9pV2kR8mZ4tL6wY0bN3cX5hJ1qA7sD-fG_eK2uT';
    const mask = maskFor('entropy', secret);
    for (const line of [
      `header ${secret} sent`,
      `{"note":"line one\\n${secret} on the next"}`,
      `https://example.test/r/%2F${secret}`,
      `-${secret}-`,
    ]) {
      const { text, hits } = redact(line);
      expect(hits.map((h) => h.type), line).toEqual(['entropy']);
      expect(text, line).toContain(mask);
    }
  });
});

describe('exchanges', () => {
  const base = (): Exchange => ({
    id: 'x1',
    sessionId: 's1',
    seq: 1,
    ts: '2026-08-19T09:00:00.000Z',
    userText: 'why is the deploy failing',
    assistantText: `the workflow has a literal: ghp_${'FAKE'.repeat(9)}`,
    toolCalls: [
      { name: 'Bash', input: '{"command":"cat runner.env"}', result: 'TOKEN=Zt7Qw3nR9pLxV2mKd6Hs4YbG1eUa0JfC' },
      { name: 'Read', input: '{"file_path":"/tmp/app/deploy.sh"}' },
    ],
    filesTouched: ['/tmp/app/deploy.sh'],
    isSidechain: false,
    redacted: false,
  });

  it('masks every field 03 §5 names and sets exchanges.redacted', () => {
    const input = base();
    const { exchange, hits } = redactExchange(input);
    expect(hits.map((h) => h.type)).toEqual(['github', 'generic']);
    expect(exchange.redacted).toBe(true);
    expect(exchange.assistantText).not.toContain('ghp_');
    expect(exchange.toolCalls[0]?.result).not.toContain('Zt7Qw3nR9pLxV2mKd6Hs4YbG1eUa0JfC');
    expect(exchange.toolCalls[0]?.result).toContain('TOKEN=‹redacted:generic:');
    // The tool call with nothing to hide keeps its shape, `result` included.
    expect(exchange.toolCalls[1]).toEqual(input.toolCalls[1]);
  });

  it('never mutates the input — the archive copy is written from it', () => {
    const input = base();
    const before = JSON.stringify(input);
    redactExchange(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('leaves a clean exchange unflagged', () => {
    const clean: Exchange = { ...base(), assistantText: 'nothing secret here', toolCalls: [] };
    const { exchange, hits } = redactExchange(clean);
    expect(hits).toEqual([]);
    expect(exchange.redacted).toBe(false);
  });
});

describe('doctor', () => {
  const t = new Theme({ color: false, ascii: false, width: 80 });

  it('counts by type', () => {
    const counts = tally(redact(PLANTED).hits);
    expect(counts.total).toBe(11);
    expect(counts.byType.aws).toBe(1);
    expect(counts.byType.jwt).toBe(1);
    expect(counts.byType.slack).toBe(0);
    expect(countsJson(counts)).toEqual({
      total: 11,
      aws: 1,
      github: 1,
      jwt: 1,
      'private-key': 1,
      generic: 4,
      entropy: 3,
    });
  });

  it('adds two tallies without double counting', () => {
    const a = tally(redact(PLANTED).hits);
    const sum = addCounts(a, a);
    expect(sum.total).toBe(22);
    expect(sum.byType.aws).toBe(2);
    expect(addCounts(a, emptyCounts())).toEqual(a);
  });

  it('renders one row in the house style, biggest type first', () => {
    const counts = emptyCounts();
    counts.byType.jwt = 512;
    counts.byType.entropy = 402;
    counts.byType.aws = 12;
    counts.total = 926;
    const row = redactionRow(counts, t);
    expect(row.label).toBe('secrets masked');
    expect(row.value).toBe('926');
    expect(row.note).toBe('jwt 512 · entropy 402 · aws 12');
    expect(redactionLine(counts, t)).toContain('secrets masked');
  });

  it('says so plainly when nothing matched', () => {
    const row = redactionRow(emptyCounts(), t);
    expect(row.value).toBe('0');
    expect(row.note).toContain('nothing matched');
  });
});

describe('performance', () => {
  it('redacts 10 MB in the time an index pass can afford', () => {
    // The redactor runs over the whole corpus at index time, so a pathological
    // regex shows up as a minutes-long `potsherd index`. `03` §12 budgets 3
    // minutes for a full index of 350 MB *including embeddings*; redaction has
    // to be a rounding error against that.
    const chunk = `${CLEAN}\n${CLEAN}\n${PLANTED}`;
    let big = '';
    while (big.length < 10 * 1024 * 1024) big += chunk;
    big = big.slice(0, 10 * 1024 * 1024);

    // A bare wall-clock bar measures the machine, not the redactor. This one sat
    // at 10 s against a 3.5 s idle run — 2.9x of headroom — and duly failed at
    // 10 s while four other agents were building on the same laptop. So the bar
    // is calibrated against a trivially-linear pass over the same bytes: under
    // load both numbers stretch together, while catastrophic backtracking (the
    // thing this test exists to catch, and which costs *minutes*) still blows
    // through it by orders of magnitude.
    const c0 = performance.now();
    let linear = 0;
    for (let i = 0; i < big.length; i += 1) linear += big.charCodeAt(i) & 1;
    const baselineMs = performance.now() - c0;

    const t0 = performance.now();
    const { hits } = redact(big);
    const ms = performance.now() - t0;
    const mbps = 10 / (ms / 1000);
    const bar = Math.max(10_000, baselineMs * 120);
    // eslint-disable-next-line no-console
    console.log(
      `  redact: 10 MB in ${ms.toFixed(0)} ms (${mbps.toFixed(1)} MB/s), ${hits.length} hits` +
        ` · linear baseline ${baselineMs.toFixed(0)} ms, bar ${bar.toFixed(0)} ms`,
    );
    expect(linear).toBeGreaterThan(0);
    expect(hits.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(bar);
  });

  it('does not backtrack on the shapes that hang naive scanners', () => {
    const evil = [
      `-----BEGIN RSA PRIVATE KEY-----${'A'.repeat(200_000)}`,
      `ey${'A'.repeat(50_000)}.ey${'B'.repeat(50_000)}`,
      `TOKEN=${'x'.repeat(100_000)}`,
      `https://${'a'.repeat(50_000)}:${'b'.repeat(50_000)}`,
      'a'.repeat(500_000),
      `${'aXbYcZ9'.repeat(3)} `.repeat(20_000),
    ];
    const t0 = performance.now();
    for (const s of evil) redact(s);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });

  it('elides binary at speed, on the shapes that hang a naive elider', () => {
    // The elision pass runs over the whole corpus too, and its patterns carry
    // `{512,}` quantifiers — which is exactly the shape that goes quadratic if
    // it is not anchored on a literal. See BARE_RUN in redact-elide.ts.
    const evil = [
      'A'.repeat(1_000_000),
      `${'iVBORw0KGgo'}${'A'.repeat(500_000)}`,
      `${'"data":"'}${'/9j/'}${'B'.repeat(500_000)}`,
      `data:image/png;base64,${'C'.repeat(500_000)}`,
      `${'abcdefghij'.repeat(10)} `.repeat(5_000),
    ];
    const t0 = performance.now();
    for (const s of evil) elideBinary(s);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });

  it('elides 10 MB of image-heavy transcript faster than it redacts it', () => {
    let big = '';
    while (big.length < 10 * 1024 * 1024) big += `${AGENT}\n`;
    big = big.slice(0, 10 * 1024 * 1024);

    const t0 = performance.now();
    const lean = elideBinary(big);
    const elideMs = performance.now() - t0;
    const t1 = performance.now();
    redact(lean);
    const redactMs = performance.now() - t1;
    // eslint-disable-next-line no-console
    console.log(
      `  elide: 10 MB in ${elideMs.toFixed(0)} ms (${(10 / (elideMs / 1000)).toFixed(1)} MB/s), ` +
      `dropped ${(((big.length - lean.length) / big.length) * 100).toFixed(0)}%; ` +
      `redact of what is left: ${redactMs.toFixed(0)} ms`,
    );
    expect(lean.length).toBeLessThan(big.length);
    expect(elideMs).toBeLessThan(10_000);
  });
});

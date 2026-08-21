#!/usr/bin/env node
/**
 * Regenerates `evals/fixture/` — the corpus the recall eval scores itself on.
 *
 *   node scripts/make-eval-corpus.mjs
 *
 * ## Why this file exists
 *
 * Until T3.4 the eval corpus was 24 hand-pasted session files with no
 * generator, which meant nobody could add a distractor without hand-writing
 * ten jsonl records and getting every uuid, parent pointer and timestamp
 * right. `tests/fixtures/make-fixtures.mjs` had the same job for the parser
 * fixture and solved it the same way: the corpus is *data* here and the record
 * plumbing is code. The output is committed so CI runs offline; this script is
 * how it is reviewed and how it grows.
 *
 * Everything in it is invented. No real prompt, project, client name or
 * absolute home directory path appears here or in the tree it writes — `plans/06` requires
 * that of anything committed, and the private reference set stays under
 * `~/.potsherd/evals/`.
 *
 * ## What the corpus is shaped like, and why
 *
 * `plans/06` scores recall@5 over sessions. A recall@5 metric over eleven
 * candidates is nearly free — the first version of this set scored 10/10 and
 * measured nothing — so the corpus is built to make the metric cost something:
 *
 *   46 live sessions   most of them **distractors**: sessions on the adjacent
 *                      topic that share the query's words and must rank below
 *                      the answer. A ranker that is merely lucky ranks these
 *                      first.
 *   12 ghosts          prompts only, from history.jsonl, all before 2026-06-01
 *   6 sidechains       subagent transcripts whose text exists nowhere else
 *   32 cards           written to `cards.jsonl` and injected by `evals/run.ts`,
 *                      so `cards_fts` and `vec_cards` are not competing at 17%
 *                      completeness the way phase 2 measured them
 *   8 projects         so `--project` has something to be wrong about
 *
 * A card exists only for a session with at least `MIN_EXCHANGES` (3) exchanges
 * — the same floor `cards/plan.ts` enforces — and for ghosts with at least
 * three prompts. **No answer-ghost is carded**: a ghost query has to be
 * answered out of `ghosts_fts` / `ghost_prompts_fts` or not at all, which is
 * what "5 ghost-only answers" in `plans/06` means.
 *
 * ## The record shapes
 *
 * One live session is: for each exchange, a `user` record carrying the prompt,
 * an `assistant` record carrying text plus zero or more `tool_use` parts, and
 * — when there was a tool — one `user` record carrying the `tool_result`.
 * Prompts are seven minutes apart, the reply twenty seconds after its prompt,
 * the tool result five seconds after that, and an `ai-title` record lands a
 * minute into the session. A sidechain is an `agent-name` record followed by
 * one exchange an hour after its parent started. `history.jsonl` gets one row
 * per prompt for every session, live or dead; the dead ones are the ghosts,
 * and they are the only evidence those five conversations ever happened.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', 'evals', 'fixture', 'claude');
const cardsFile = path.join(here, '..', 'evals', 'fixture', 'cards.jsonl');

const API = '/tmp/potsherd-eval-api';
const WEB = '/tmp/potsherd-eval-web';
const INFRA = '/tmp/potsherd-eval-infra';
const DATA = '/tmp/potsherd-eval-data';
const MOBILE = '/tmp/potsherd-eval-mobile';
const DEVICES = '/tmp/potsherd-eval-devices';
const ML = '/tmp/potsherd-eval-ml';
const DOCS = '/tmp/potsherd-eval-docs';

const VERSION = '2.1.237';
const MODEL = 'claude-opus-4';
/** `cards/plan.ts` MIN_EXCHANGES. A shorter session has nothing to summarise. */
const MIN_EXCHANGES = 3;

const MINUTE = 60_000;
/** Gap between one prompt and the next. */
const TURN = 7 * MINUTE;

// ---------------------------------------------------------------- the corpus
//
// `ex` is `[prompt, reply, [files]]`. `card` is the part of a card a human has
// to write; the rest (claims, files, tags) is derived below from the session
// itself, the way the real extractor derives it from the transcript.

/** @type {{id:string,project:string,branch?:string,entrypoint?:string,start:string,prefix:string,title?:string,ex:[string,string,string[]?][],card?:{title:string,summary:string,topics:string[],outcome?:string}}[]} */
const SESSIONS = [
  // ------------------------------------------------- the original 24 (T1.7b)
  {
    id: '0a2fbf9b-c6fd-4486-86ee-d17cde32e587',
    project: API,
    start: '2026-06-02T10:00:00.000Z',
    prefix: 's1',
    title: 'Pin the pgbouncer prepared-statement setting',
    ex: [
      ['the connection pool falls over under load. can we put pgbouncer in front of postgres?', 'Yes. Put pgbouncer in transaction pooling mode and set max_client_conn to 800, default_pool_size to 25.', ['db/pool.ts']],
      ['prepared statements break in transaction mode though', 'Set statement_cache_size to 0 in the driver, or move to extended protocol emulation. Transaction pooling cannot keep a session-scoped prepared statement alive.', ['db/pool.ts', 'db/client.ts']],
      ['what does that cost us on latency', 'About 0.4 ms per query for the re-parse. The pooler saves far more than that at 800 clients.'],
    ],
    card: {
      title: 'Connection pooling in front of postgres',
      summary: 'Put a transaction-mode pooler in front of the database to survive load, and disabled the driver statement cache because a session-scoped prepared statement cannot live across a pooled transaction.',
      topics: ['database', 'connection pooling', 'latency'],
    },
  },
  {
    id: '19f2c8d1-4a70-4b93-9c58-2e6d0f8a17b4',
    project: API,
    start: '2026-06-18T10:00:00.000Z',
    prefix: 'n4',
    title: 'Cursor pagination for the orders list',
    ex: [
      ['page 400 of the orders list takes nine seconds', 'Offset pagination scans every row before the page. Key it on created_at and id, and hand the last row back as an opaque cursor.', ['orders/list.ts']],
      ['what breaks for existing clients', 'The page parameter. Keep accepting it for one release and translate it into a cursor server side.', ['orders/list.ts']],
    ],
  },
  {
    id: '2d6b91ae-6f83-4c05-b7d9-0a48e2f31c67',
    project: API,
    start: '2026-06-17T11:30:00.000Z',
    prefix: 'n3',
    title: 'Refund flow writes two ledger rows',
    ex: [
      ['a refund shows up twice in the customer ledger', 'The webhook and the poller both insert. Make the poller upsert on the provider transfer id and let the webhook win.', ['billing/refund.ts']],
      ['do we clean up the duplicates', 'One migration that keeps the earliest row per transfer id, then a unique index so it cannot happen twice.', ['billing/refund.ts']],
    ],
  },
  {
    id: '7c1d0e44-2b96-4f31-a0d7-5e1c9b2a4f83',
    project: API,
    start: '2026-06-15T09:00:00.000Z',
    prefix: 'n1',
    title: 'Idempotency keys on the charge endpoint',
    ex: [
      ['two rows land in the ledger when a request is replayed', 'Take an Idempotency-Key header. Store the key beside the row under a unique index and return the stored response when the same key arrives again.', ['billing/charge.ts']],
      ['what happens if two replays race', 'The unique index decides it. The loser catches the constraint violation and reads the winner row back instead of writing its own.', ['billing/charge.ts']],
      ['how long do we hold the keys', 'Twenty-four hours. Nothing is still replaying a request after that, and the table stays small enough to keep in memory.', ['billing/charge.ts']],
    ],
    card: {
      title: 'Idempotency keys on the charge endpoint',
      summary: 'A replayed request was writing a second ledger row and taking the money twice, so the endpoint now takes an idempotency key under a unique index and replays the stored response instead of charging again.',
      topics: ['payments', 'idempotency', 'api design'],
    },
  },
  {
    id: 'a0c57a31-0b9d-4442-83dc-fd426b0c37af',
    project: API,
    start: '2026-06-05T10:00:00.000Z',
    prefix: 's3',
    ex: [
      ['the outbound webhook is getting rate limited by their gateway. what do we do', 'Token bucket at 20 requests per second with a jittered retry on 429, and honour the Retry-After header when they send one.', ['webhook/send.ts']],
      ['does the bucket survive a restart', 'Not in memory. Keep the token count in redis if two workers share the quota.', ['webhook/send.ts']],
    ],
  },
  {
    id: 'a82ceb72-455b-4fc8-88b8-993effefe3c7',
    project: API,
    branch: 'importer',
    start: '2026-06-04T10:00:00.000Z',
    prefix: 's2',
    title: 'Rewrite the CSV importer as a stream',
    ex: [
      ['the csv importer eats 3 GB of memory on the big files. rewrite it', 'Read it as a stream instead of a buffer: createReadStream piped through a csv parser, then a writable that batches 500 rows per insert.', ['import/csv.ts']],
      ['how do we handle backpressure when the database is slow', "The writable's callback is the backpressure signal - do not call it until the insert resolves, and the parser stops pulling on its own.", ['import/csv.ts']],
      ['add a progress line', 'Emitting one line per 10,000 rows on stderr, so a redirect to a file stays clean.', ['import/csv.ts']],
    ],
    card: {
      title: 'Streaming rewrite of the CSV importer',
      summary: 'The importer buffered whole files and used three gigabytes on the large ones; it now streams through a parser into batched inserts, with the writable callback carrying backpressure and progress on stderr.',
      topics: ['imports', 'streaming', 'memory'],
    },
  },
  {
    id: 'b3e7a205-9c47-4d18-8e26-31f7a0c5d92b',
    project: API,
    start: '2026-06-16T14:00:00.000Z',
    prefix: 'n2',
    title: 'Retry budget for the payments gateway',
    ex: [
      ['we retry every failed payment three times and the gateway complains', 'Give the endpoint a retry budget: at most ten percent of calls to the gateway may be retries, measured over a rolling minute.', ['billing/retry.ts']],
      ['what about the ones we drop', 'Park them on a dead letter queue with the response code, and replay by hand once the gateway is healthy.', ['billing/retry.ts']],
    ],
  },
  {
    id: '1c58f0b3-7d92-4a15-8e63-40b7c2f9d18e',
    project: DATA,
    start: '2026-06-30T11:00:00.000Z',
    prefix: 'n13',
    title: 'Backfill re-ran and doubled the totals',
    ex: [
      ['someone ran the backfill twice and every total is double what it should be', 'The job is not idempotent. Write into a staging table keyed on day and metric, then swap the partition when it completes.', ['jobs/backfill.py']],
      ['can we detect it next time', 'Assert the row count against the previous run and fail loudly when it moves more than a few percent.', ['jobs/backfill.py']],
    ],
  },
  {
    id: '47d9e281-3b64-4c07-a9f8-25e1d0b73c6a',
    project: DATA,
    entrypoint: 'sdk-ts',
    start: '2026-07-01T10:00:00.000Z',
    prefix: 'n14',
    ex: [
      ['the analytics rollup counts an event twice whenever the producer redelivers', 'Dedupe on the message id in a seen-ids table with a seven-day ttl, and check it before the rollup reads the partition.', ['jobs/dedupe.py']],
      ['what if the id is missing', 'Fall back to a hash of source, payload and minute. It is not perfect, but it is stable across a redelivery.', ['jobs/dedupe.py']],
    ],
  },
  {
    id: '9a4e7c26-5f03-4b18-92d7-6ae481c530f9',
    project: DATA,
    start: '2026-06-29T09:00:00.000Z',
    prefix: 'n12',
    title: 'Timezone drift in the daily rollup',
    ex: [
      ['the eu region is always one day behind everyone else in the dashboard', 'The rollup buckets on utc midnight while the region reports on local midnight, so eight hours of traffic land in the next bucket. Bucket on the region offset instead.', ['jobs/rollup.py']],
      ['what about the rows we already wrote', 'Recompute the last sixty days per region. The offset is deterministic, so the backfill is safe to repeat.', ['jobs/rollup.py']],
    ],
  },
  {
    id: '3e9a7b15-6c82-4f37-a5e1-0d29b4c86f13',
    project: INFRA,
    start: '2026-06-24T08:00:00.000Z',
    prefix: 'n9',
    title: 'Expired certificate on the internal load balancer',
    ex: [
      ['every internal call started failing tls this morning', 'The load balancer certificate expired at midnight. Rotate it, then put a thirty-day expiry alert on the issuer so this is never the answer again.', ['infra/lb.tf']],
    ],
  },
  {
    id: '6f0b24d9-3e57-4c81-b0a6-92f14e5d7c30',
    project: INFRA,
    start: '2026-06-26T12:00:00.000Z',
    prefix: 'n11',
    title: 'Blue-green cutover left old pods serving',
    ex: [
      ['after the cutover some requests still hit the old version', 'An old pod stayed in the service endpoints because the readiness gate never flipped. Drain on preStop and give it a terminationGracePeriod.', ['infra/deploy.yaml']],
    ],
  },
  {
    id: '94f91303-5710-4986-8bbb-cd54ebacccfb',
    project: INFRA,
    start: '2026-06-13T10:00:00.000Z',
    prefix: 's7',
    title: 'Liveness probe keeps restarting the pod',
    ex: [
      ['kubernetes keeps restarting the pod every few minutes and the logs show nothing', 'The liveness probe is timing out during the startup migration. Add a startupProbe so the liveness probe does not run until the process is actually ready.', ['k8s/deploy.yaml']],
      ['what values', 'failureThreshold 30 with periodSeconds 10 gives the migration five minutes before anything kills it.', ['k8s/deploy.yaml']],
    ],
  },
  {
    id: 'a5c2d803-4b71-49e6-8f25-1c07d6e93a48',
    project: INFRA,
    start: '2026-06-25T20:00:00.000Z',
    prefix: 'n10',
    title: 'The nightly job runs twice in two regions',
    ex: [
      ['the nightly job fires once in each region and we get two of everything', 'Elect a leader with a lease row keyed on the job name, or pin the schedule to one region and let the other stand by.', ['infra/cron.tf']],
      ['which is less to operate', 'Pinning. A lease needs its own failure story; a pinned schedule needs a runbook line.', ['infra/cron.tf']],
    ],
  },
  {
    id: 'cbcfda7e-ac7c-4077-8712-6b71ff14f145',
    project: INFRA,
    branch: 'search',
    start: '2026-06-15T10:00:00.000Z',
    prefix: 's8',
    title: 'Choose between rrf and linear fusion for search',
    ex: [
      ['we have keyword scores and vector scores. how do we combine them', 'Reciprocal rank fusion. It reads only the order of each list, so the two scores never need to be on the same scale - which matters because bm25 is unbounded and cosine is not.', ['search/fuse.ts']],
      ['what k', '60 is the value from the original paper and it is not sensitive; anything between 20 and 100 behaves the same on a small corpus.', ['search/fuse.ts']],
      ['is a linear blend ever better', 'Only when you have labelled data to fit the weights on. Without it, a linear blend is a guess wearing a number.'],
    ],
    card: {
      title: 'Reciprocal rank fusion over two result lists',
      summary: 'Chose reciprocal rank fusion to merge keyword and vector results because it reads only rank order and needs no shared score scale, and rejected a linear blend as unfittable without labelled data.',
      topics: ['search', 'ranking', 'fusion'],
    },
  },
  {
    id: '8d31f7c5-2a49-4e83-b571-6c0d8f21943b',
    project: MOBILE,
    start: '2026-07-02T18:00:00.000Z',
    prefix: 'n15',
    title: 'Push notifications arrive twice on android',
    ex: [
      ['android users get every push notification twice', 'Both the sdk and our own handler display it. Set a collapse key and let the sdk own the display path.', ['app/push.kt']],
    ],
  },
  {
    id: 'c2f68b40-5e17-4d92-a836-71b39c0e45d2',
    project: MOBILE,
    start: '2026-07-03T09:00:00.000Z',
    prefix: 'n16',
    title: 'Offline queue replays stale writes',
    ex: [
      ['when the phone comes back on the network it flushes the whole queue, including edits the person already undid', 'Stamp every mutation with a document version. The server rejects anything whose version it has superseded, and the client drops it quietly.', ['app/queue.kt']],
      ['how does the person see what was dropped', 'A quiet banner listing the discarded changes, with one undo that re-applies them in order.', ['app/queue.kt']],
    ],
  },
  {
    id: '4ae3102b-1ad3-432b-8f01-b0e64eb5d627',
    project: WEB,
    start: '2026-06-11T10:00:00.000Z',
    prefix: 's6',
    title: 'Audit the bundle size before launch',
    ex: [
      ['the js bundle is 1.4 MB. find out what is in it', 'Running an analysis pass over the build output now.', ['build/analyze.mjs']],
      ['summarise what you found', 'Three quarters of it is the date library and the icon set. Both are importable per-symbol.'],
    ],
  },
  {
    id: '5b0d7e92-8c31-4a76-9f20-6b48d1e07a53',
    project: WEB,
    entrypoint: 'sdk-ts',
    start: '2026-06-20T15:00:00.000Z',
    prefix: 'n6',
    ex: [
      ['[Image: source: /tmp/potsherd-eval-web/.cache/clipboard-2026-06-20.png]\nwhy is the pay button grey here', 'The disabled attribute is still set: form validity is computed before the async postcode lookup resolves, so the first paint sees an invalid form.', ['ui/CheckoutButton.tsx']],
      ['[Image: source: /tmp/potsherd-eval-web/.cache/clipboard-2026-06-20b.png]', 'That second state is the postcode lookup still pending. Show a spinner inside the pay button instead of disabling it, so it never looks broken.', ['ui/CheckoutButton.tsx']],
    ],
  },
  {
    id: 'a86656f1-5e43-49c2-8577-6213aec94c61',
    project: WEB,
    start: '2026-06-09T10:00:00.000Z',
    prefix: 's5',
    title: 'Flaky end-to-end test on the checkout page',
    ex: [
      ['the checkout end-to-end test fails about one run in six and passes on a retry', 'That is a race, not a flake. The test asserts on the total before the price recalculation request settles.', ['e2e/checkout.spec.ts']],
      ['how do we wait for it properly', 'Wait for the network response, not for a timeout. Any sleep you pick will be wrong on a slower CI box.', ['e2e/checkout.spec.ts']],
    ],
  },
  {
    id: 'c8e14f60-7b18-42d9-a350-9e64f1b28d07',
    project: WEB,
    start: '2026-06-22T09:30:00.000Z',
    prefix: 'n7',
    title: 'The hero image is 800 kB',
    ex: [
      ['the hero image is 800 kB and blocks the first paint', 'Serve avif with a webp fallback at three widths and mark it fetchpriority high. That is 91 kB and one less round trip.', ['ui/Hero.tsx']],
      ['is the bundle the problem too', 'Not for the first paint. The image is on the critical path and the bundle is deferred, so fix the image first.', ['ui/Hero.tsx']],
    ],
  },
  {
    id: 'e2749f91-a8e0-4f9f-8a3f-47590019effb',
    project: WEB,
    branch: 'design-tokens',
    start: '2026-06-07T10:00:00.000Z',
    prefix: 's4',
    title: 'Dark mode tokens for the design system',
    ex: [
      ['we need dark mode. how should the design tokens be organised', 'Two layers: primitive tokens (grey-100 ... grey-900) that never change, and semantic tokens (surface, text-primary) that swap per theme.', ['tokens/colors.css']],
      ['what about the charts, they have their own palette', 'Give the chart series their own semantic layer too, and check contrast against both surfaces - a series that reads on white often vanishes on near-black.', ['tokens/charts.css']],
    ],
  },
  {
    id: 'f09b6c73-1e54-4a82-b096-3d7c518ae294',
    project: WEB,
    start: '2026-06-23T16:00:00.000Z',
    prefix: 'n8',
    title: 'Checkout button loses focus on iOS',
    ex: [
      ['on ios safari the checkout button loses focus after the keyboard closes', 'The viewport resize re-renders the form. Key the field list so react keeps the node, and focus survives the resize.', ['ui/CheckoutForm.tsx']],
    ],
  },
  {
    id: 'f4a8c317-5d29-4e60-b184-7c93a2f5e018',
    project: WEB,
    start: '2026-06-19T13:00:00.000Z',
    prefix: 'n5',
    title: 'Focus escapes the dialog on tab',
    ex: [
      ['tabbing out of the modal lands on the page behind it', 'Trap focus inside the dialog: remember the element that opened it, cycle between the first and last focusable child, and restore on close.', ['ui/Dialog.tsx']],
      ['does a screen reader announce it', 'Only with role dialog and aria-modal true. Without those the page behind is still in the accessibility tree.', ['ui/Dialog.tsx']],
    ],
  },

  // -------------------------------------------------- T3.4: sidechain parents
  //
  // Each of these four is the *parent* of a subagent transcript below. The
  // parent talks about something adjacent and never says what the subagent
  // found, so a query about the subagent's finding can only be answered by the
  // sidechain — which is `plans/06`'s "5 sidechain-only answers".
  {
    id: 'd4b1f0a7-3c62-4e91-b508-27fa1c6d9e40',
    project: INFRA,
    start: '2026-06-01T09:00:00.000Z',
    prefix: 'p1',
    title: 'Review the terraform plan before apply',
    ex: [
      ['the plan wants to replace the subnet and i cannot see why', 'A tag moved onto the route table, and the provider treats that as force-new. Put the tag back on aws_route_table and the subnet survives the apply.', ['infra/network.tf']],
      ['can we make a plan reviewable in a pull request', 'Write it with -out and render the json, then the diff is in the review instead of in somebody terminal scrollback.', ['infra/plan.sh']],
      ['who approves an apply', 'Two people for anything that touches state, one for everything else, enforced by a required reviewer on the environment.'],
    ],
    card: {
      title: 'Reviewing terraform plans before apply',
      summary: 'Traced a surprise subnet replacement to a tag moved onto the route table, and made plans reviewable by rendering them into the pull request with a two-person rule for state changes.',
      topics: ['infrastructure as code', 'review process', 'terraform'],
    },
  },
  {
    id: '2f7c8b31-6d40-4a75-9e13-c0b5827af4d6',
    project: DATA,
    start: '2026-06-03T10:00:00.000Z',
    prefix: 'p2',
    title: 'Move the warehouse loader to parquet',
    ex: [
      ['the csv loads take an hour and the files are enormous', 'Write parquet instead. Column pruning and dictionary encoding take the read down to a few minutes on the same hardware.', ['load/warehouse.py']],
      ['do we keep the csv around', 'Ninety days, compressed. After that the parquet is the record and the csv is noise.', ['load/warehouse.py']],
      ['how does a reader know a load finished', 'A manifest per batch with the row count and a checksum, written last. A reader that cannot see the manifest treats the batch as absent.'],
    ],
    card: {
      title: 'Warehouse loader moves to parquet',
      summary: 'Replaced hour-long csv loads with parquet for column pruning and dictionary encoding, kept compressed csv for ninety days, and made batch completeness explicit with a manifest written last.',
      topics: ['warehouse', 'file formats', 'loading'],
    },
  },
  {
    id: '9c1e5d80-4b27-4f63-8a91-de50c73b2f18',
    project: WEB,
    start: '2026-06-06T11:00:00.000Z',
    prefix: 'p3',
    title: 'Ship the new marketing page on friday',
    ex: [
      ['the new landing page has to go out on friday, what is left', 'The copy is in. The images are uncompressed and the form still posts to the old endpoint; those are the two things between here and friday.', ['ui/Landing.tsx']],
      ['who edits the copy after launch', 'Marketing edits the content file directly and the build picks it up, so a wording change is not a deploy.', ['content/landing.md']],
      ['do we need a redirect from the old url', 'A permanent one, and keep it for a year - the old url is on printed material.'],
    ],
    card: {
      title: 'Launch checklist for the marketing page',
      summary: 'Worked through what was left before a friday launch: uncompressed images, a form still posting to the retired endpoint, editor-owned copy that does not need a deploy, and a permanent redirect kept for a year.',
      topics: ['launch', 'marketing site', 'redirects'],
    },
  },
  {
    id: '6b3a9e24-8f05-4c31-b7d2-1a94e6035cb7',
    project: API,
    start: '2026-06-08T14:00:00.000Z',
    prefix: 'p4',
    title: 'Load test the checkout endpoint',
    ex: [
      ['we need numbers for the endpoint before the sale', 'Model it as a ramp: fifty virtual users a minute up to a thousand, with think time so it is a shopper and not a hammer.', ['perf/ramp.js']],
      ['what do we watch while it runs', 'Error rate, worker pool saturation, and the database connection wait. The wait moves first, every time.', ['perf/ramp.js']],
      ['where do we run it from', 'Outside the vpc. A test that never crosses the load balancer produces a number nobody can use.'],
    ],
    card: {
      title: 'Ramp load test for the checkout endpoint',
      summary: 'Designed a ramping load test up to a thousand virtual users with think time, watching error rate, worker pool saturation and the database connection wait, and running from outside the vpc so the load balancer is in the path.',
      topics: ['load testing', 'performance', 'checkout'],
    },
  },

  // ---------------------------------------------------- T3.4: card-only answers
  //
  // Five sessions whose transcripts are the concrete, in-the-weeds words
  // somebody actually typed, and whose *card* carries the abstraction they
  // would remember months later. The query uses the card's vocabulary, which
  // appears nowhere in the exchange text or the title — so `exchanges_fts` and
  // `vec_exchanges` cannot answer it and `cards_fts` / `vec_cards` can. This
  // is `plans/06`'s "what was that session about" case.
  {
    id: 'e5a70c14-9b38-4d52-a670-5c39f28b1e64',
    project: WEB,
    start: '2026-06-10T09:00:00.000Z',
    prefix: 'p5',
    title: 'SameSite and the third-party redirect',
    ex: [
      ['after the redirect back from the provider the browser is not sending it', 'The attribute is Lax, and a cross-site POST drops it on the way back. Set None with Secure and it survives the hop.', ['ui/session.ts']],
      ['safari still refuses', 'Safari wants Partitioned as well, set on the same response that performs the redirect.', ['ui/session.ts']],
      ['does that break the old webview', 'The 2019 build ignores Partitioned and falls through to the header path, which still works.'],
    ],
    card: {
      title: 'Cross-site login broken by cookie policy',
      summary: 'Users could not sign in through the identity provider because the authentication cookie was rejected on the way back; fixed by setting SameSite None, Secure and Partitioned on the redirect response, with a header fallback for old webviews.',
      topics: ['authentication', 'sign-in', 'browser compatibility'],
    },
  },
  {
    id: 'b8f43d05-1e79-4a26-8c40-6b271fa9d3e5',
    project: DATA,
    start: '2026-06-12T10:00:00.000Z',
    prefix: 'p6',
    title: 'Empty columns after the join',
    ex: [
      ['the march file has blanks where the amounts should be', 'The join compares a text column against a numeric one, so every row falls out to the outer side. Cast at load time.', ['jobs/export.py']],
      ['why did it work last quarter', 'It did not. The blanks were read as zeroes downstream and nobody looked.', ['jobs/export.py']],
      ['run it again for march', 'Re-running with the cast in place; the row count agrees with the ledger this time.'],
    ],
    card: {
      title: 'Type mismatch broke the monthly finance report',
      summary: 'The monthly finance report published empty amount columns because a join compared text against numeric and dropped every matching row; the loader now casts at read time and March was regenerated and reconciled.',
      topics: ['reporting', 'finance', 'data quality'],
    },
  },
  {
    id: '3d92c7fe-5a14-4b98-9207-8ef6c1d54b3a',
    project: INFRA,
    start: '2026-06-14T08:00:00.000Z',
    prefix: 'p7',
    title: 'It stops at 04:12 and the log just ends',
    ex: [
      ['it stops at 04:12 again and the log just ends', 'The token it exchanges at the start is good for an hour, and the run is longer than an hour.', ['ci/release.yml']],
      ['can we make the token last longer', 'The issuer caps it. Refresh from inside the job at fifty minutes instead.', ['ci/release.yml']],
      ['what if the refresh fails', 'Fail the step loudly rather than carrying on with a dead token, or this comes back with a different clock on it.'],
    ],
    card: {
      title: 'Nightly deployment fails on expired credentials',
      summary: 'The nightly deployment pipeline died silently part-way through every night because the credential it exchanges at start-up expires after an hour; the job now refreshes proactively and fails loudly if the refresh does not work.',
      topics: ['deployment', 'continuous integration', 'credentials'],
    },
  },
  {
    id: '71ea08b3-2c56-4f19-b843-905ed7c26f41',
    project: MOBILE,
    start: '2026-06-16T09:00:00.000Z',
    prefix: 'p8',
    title: 'The feed stutters when you flick it',
    ex: [
      ['the list stutters when you flick it fast', 'Every row is measured again on every frame. Cache the heights and measure only the rows you have not seen.', ['app/Feed.kt']],
      ['it still hitches on the first screenful', 'That is the image decode on the main thread. Decode off it and hand back a bitmap.', ['app/Feed.kt']],
      ['how do we stop it coming back', 'A frame-time trace in the release build, failing the check above sixteen milliseconds.'],
    ],
    card: {
      title: 'Janky scrolling on the feed screen',
      summary: 'Investigated janky scroll performance on the main feed and found per-frame row measurement plus main-thread image decoding; both were fixed and a frame-time budget now guards the regression.',
      topics: ['performance', 'scrolling', 'android'],
    },
  },
  {
    id: 'c47b1a09-7d63-42f8-a915-3b820c6ed57f',
    project: API,
    start: '2026-06-17T09:00:00.000Z',
    prefix: 'p9',
    title: 'Send only what changed',
    ex: [
      ['we push the whole object on every save and the phone burns data', 'Send the changed fields only, with a version the client can compare against what it already holds.', ['api/patch.ts']],
      ['what about deletes, the client never hears about them', 'A tombstone row with a seven day ttl. Anything older than that forces a full refetch.', ['api/patch.ts']],
      ['how does a client that was away for a month catch up', 'It asks for everything once. The partial path is an optimisation, not a guarantee.'],
    ],
    card: {
      title: 'Incremental sync protocol for the mobile client',
      summary: 'Designed an incremental synchronisation protocol so a client receives only changed fields with a comparable version, tombstones cover deletions for a week, and anything staler falls back to a full fetch.',
      topics: ['synchronisation', 'protocol design', 'bandwidth'],
    },
  },

  // ------------------------------------------------- T3.4: concept answers
  {
    id: 'f60c9d13-8b45-4e27-a06c-51d9273fe8b4',
    project: ML,
    start: '2026-06-18T15:00:00.000Z',
    prefix: 'p10',
    title: 'The new checkpoint is worse once it is live',
    ex: [
      ['the new checkpoint beats the old one on the held-out set and is worse once it is live', 'Skew. The feature is computed from a batch table on one side and from the request payload on the other, and the two do not agree.', ['ml/features.py']],
      ['how do we prove that', 'Log the online vector, replay it through the batch path and diff. More than a percent of rows disagreeing is your answer.', ['ml/audit.py']],
      ['what stops it recurring', 'One implementation per feature, called from both paths. A second implementation is a second definition.'],
    ],
    card: {
      title: 'Training and serving skew in the ranker',
      summary: 'A checkpoint that won offline lost in production because one feature was computed differently in the batch and request paths; the audit replays logged vectors through the batch code and the fix is a single shared implementation.',
      topics: ['machine learning', 'feature engineering', 'production'],
    },
  },
  {
    id: '5e91d7b2-3a68-4c04-9f57-b81d0e63a29c',
    project: INFRA,
    start: '2026-06-19T08:00:00.000Z',
    prefix: 'p11',
    title: 'Intermittent five second stalls between services',
    ex: [
      ['about one call in twenty hangs for exactly five seconds and then succeeds', 'That is the conntrack race on udp: two queries leave on one socket, one answer is dropped, and the client sits on its timeout.', ['k8s/dnsconfig.yaml']],
      ['can we avoid the second query', 'Set ndots to 2 in the pod config. At the default of five, every short hostname walks four search domains first.', ['k8s/dnsconfig.yaml']],
      ['is there a fix below us', 'single-request-reopen in resolv.conf, which stops the two queries sharing a socket at all.'],
    ],
    card: {
      title: 'Five second stalls from cluster name lookups',
      summary: 'One call in twenty stalled for exactly five seconds because two lookups shared a socket and lost an answer to a conntrack race; lowering ndots and reopening the socket per request removed both the extra query and the wait.',
      topics: ['networking', 'kubernetes', 'latency'],
    },
  },
  {
    id: 'a17c5e93-4f28-4b06-8d71-e2609ba4c318',
    project: DOCS,
    start: '2026-06-20T09:00:00.000Z',
    prefix: 'p12',
    title: 'Searching the docs for buttons finds nothing',
    ex: [
      ['searching for buttons finds nothing and button finds everything', 'The index has no stemmer, so the two are unrelated terms. Turn the analyzer on and reindex.', ['site/search.ts']],
      ['what does that cost', 'Exact matching gets looser. Keep an unstemmed field alongside and weight the exact one higher.', ['site/search.ts']],
      ['how long is a reindex', 'Ninety seconds for the whole site, short enough to run on every deploy.'],
    ],
    card: {
      title: 'Stemming for the documentation search',
      summary: 'The documentation search only matched the exact word form a reader typed; enabling the analyzer with a parallel unstemmed field made plural and singular queries agree without losing exact matches.',
      topics: ['search', 'documentation', 'indexing'],
    },
  },

  // ------------------------------------------------------ T3.4: distractors
  //
  // None of these is the answer to anything. Every one of them shares the
  // distinctive words of a query whose answer is somewhere else, which is the
  // only way a top-5 metric over a small corpus can tell a good ranker from a
  // lucky one.
  {
    id: '0c68f4a1-9d27-4b53-8e10-7a4f2c95db06',
    project: API,
    start: '2026-06-21T15:00:00.000Z',
    prefix: 'p13',
    title: 'Second capture when the terminal reconnects',
    ex: [
      ['the customer is charged twice when the card terminal drops and reconnects', 'The terminal replays its capture on reconnect and the acquirer takes both. Match on the terminal transaction reference and void the second.', ['pos/capture.ts']],
      ['how do we give back the ones that already went through', 'A sweep over yesterday captures grouped by reference, refunding everything after the first.', ['pos/refund.ts']],
      ['does the receipt printer know', 'It prints from the local queue, so the customer already holds two. The refund note goes out by email.'],
    ],
    card: {
      title: 'Duplicate card capture on terminal reconnect',
      summary: 'A card terminal replayed its capture after a dropped connection and the acquirer accepted both, so captures are now matched on the terminal reference, the second is voided, and a sweep refunds the ones already taken.',
      topics: ['payments', 'point of sale', 'duplicates'],
    },
  },
  {
    id: 'b52e8c07-6a31-4d94-8f26-c30719ad5e48',
    project: INFRA,
    start: '2026-06-22T08:00:00.000Z',
    prefix: 'p14',
    title: 'Pod killed when the node runs out of memory',
    ex: [
      ['the pod is killed with exit code 137 a few times a day and comes straight back', 'OOMKilled. The limit is 512Mi and the heap alone reaches it under load; raise the limit and set the heap under it.', ['k8s/limits.yaml']],
      ['why only in the afternoon', 'That is when the report job runs on the same node and takes the headroom the kubelet was counting on.', ['k8s/limits.yaml']],
      ['should we just move the job', 'Move it. A memory limit is a contract, and two workloads that both need the headroom will keep breaking it.'],
    ],
    card: {
      title: 'Container killed for exceeding its memory limit',
      summary: 'A container was being killed several times a day for exceeding a 512Mi limit its heap alone could reach, made worse by a report job sharing the node; the limit was raised, the heap capped below it and the report moved.',
      topics: ['kubernetes', 'memory limits', 'scheduling'],
    },
  },
  {
    id: '4c07b9e3-2d58-41af-9067-8b1e5c3fd274',
    project: INFRA,
    start: '2026-06-23T07:00:00.000Z',
    prefix: 'p15',
    title: 'The replica backup outruns its window',
    ex: [
      ['the snapshot on the replica takes six hours now and the window is four', 'Split it: a weekly full and a daily incremental, and move the full to sunday when nothing else is running.', ['ops/backup.sh']],
      ['does a restore still work off an incremental chain', 'It does, but restore time grows with the chain. Cap it at six days and test a restore every month.', ['ops/backup.sh']],
      ['who gets paged when it overruns', 'Nobody today, which is the real bug. Alert on the window, not on the failure.'],
    ],
    card: {
      title: 'Backup no longer fits its maintenance window',
      summary: 'A six hour replica snapshot no longer fitted a four hour window, so it became a weekly full plus daily incrementals with the full moved to sunday, a six day chain cap, monthly restore tests and an alert on the window itself.',
      topics: ['backups', 'operations', 'alerting'],
    },
  },
  {
    id: 'd80a3f16-5c92-4e78-b134-6207ea9c58fd',
    project: DATA,
    start: '2026-06-24T14:00:00.000Z',
    prefix: 'p16',
    title: 'The funnel counts a step twice',
    ex: [
      ['the funnel says more people reached checkout than looked at the page', 'A step is counted once from the event stream and once from the session summary, so anyone who reloaded is in there twice.', ['jobs/funnel.py']],
      ['which of the two is right', 'The session summary. Drop the event-level count and let the summary be the single source.', ['jobs/funnel.py']],
      ['do we restate what we published', 'Restate the quarter with a note. A chart that quietly changes is worse than a chart that was wrong.'],
    ],
    card: {
      title: 'Funnel report double counted a step',
      summary: 'The funnel counted each step from both the event stream and the session summary, so reloads inflated it; the event-level count was dropped and the published quarter restated with a visible note.',
      topics: ['analytics', 'double counting', 'reporting'],
    },
  },
  {
    id: '7f3b2d48-9e01-4c65-a872-13b5c0e94f27',
    project: DATA,
    start: '2026-06-25T09:00:00.000Z',
    prefix: 'p17',
    title: 'The eu export lands an hour late',
    ex: [
      ['the eu bucket gets its file an hour after everybody else', 'The job waits on the us partition before it starts, so eu inherits the whole us runtime for no reason.', ['jobs/export.py']],
      ['can they run at the same time', 'They can. The dependency came off a template and nothing in the eu path reads us data.', ['jobs/export.py']],
      ['what does that buy', 'Fifty-five minutes, which puts the eu file down before the local morning.'],
    ],
    card: {
      title: 'Region exports serialised for no reason',
      summary: 'The eu export inherited the us runtime because of a copied dependency in the schedule; removing it lets the regions run in parallel and lands the eu file fifty-five minutes earlier, before the local working day.',
      topics: ['scheduling', 'exports', 'regions'],
    },
  },
  {
    id: '1b6f0d95-4a73-42e8-b501-9c8de27a64f3',
    project: WEB,
    start: '2026-06-26T08:00:00.000Z',
    prefix: 'p18',
    title: 'Icons render at the wrong size after the sprite change',
    ex: [
      ['every icon is twice the size it should be since the sprite change', 'The sprite lost its viewBox, so each symbol inherits the page font size instead of its own box.', ['ui/Icon.tsx']],
      ['why did it look right in storybook', 'Storybook sets a base font size the application does not, which is a bug of its own.', ['ui/Icon.tsx']],
      ['how do we catch it next time', 'A visual snapshot of the icon sheet in the same pipeline as everything else.'],
    ],
    card: {
      title: 'Sprite lost its viewBox and icons doubled',
      summary: 'Icons rendered at double size after a sprite change because the symbol lost its viewBox and inherited the page font size; a visual snapshot of the icon sheet now runs in the pipeline.',
      topics: ['icons', 'svg', 'visual regression'],
    },
  },
  {
    id: 'ea4d7c60-8b19-4f37-9a25-06c3f1b8d472',
    project: WEB,
    start: '2026-06-27T11:00:00.000Z',
    prefix: 'p19',
    title: 'The date library is most of the payload',
    ex: [
      ['the date library is 400 kB on its own', 'It ships every locale. Import the two you need, or move to the platform formatter and keep a shim for the old browsers.', ['ui/format.ts']],
      ['what does the shim cost', 'Nine kilobytes, and it disappears entirely once the old browsers drop below the support line.', ['ui/format.ts']],
      ['does anything else pull it in', 'The chart package does, transitively. Pin the resolution so there is one copy of it.'],
    ],
    card: {
      title: 'Date library dominates the javascript payload',
      summary: 'A date library shipping every locale accounted for 400 kB; per-symbol imports and the platform formatter with a nine kilobyte shim replace it, and the transitive copy from the chart package is pinned away.',
      topics: ['bundle size', 'dependencies', 'javascript'],
    },
  },
  {
    id: 'c93f1e07-6d24-4b85-a710-5f28be03c9d1',
    project: MOBILE,
    start: '2026-06-28T09:00:00.000Z',
    prefix: 'p20',
    title: 'Analytics batches are sent again after a crash',
    ex: [
      ['after a crash the app sends the same analytics batch a second time', 'The batch is deleted from disk only after the response, and a crash between send and response leaves it there. Mark it in flight with an id the server can deduplicate on.', ['app/analytics.kt']],
      ['how long does the server remember an id', 'A day. Longer than any client will retry, short enough that the table stays small.', ['app/analytics.kt']],
      ['does the duplicate actually matter', 'For counts it does. Two sends of one batch is a five percent lift on a bad day, which is larger than most of what we measure.'],
    ],
    card: {
      title: 'Analytics batches resent after a crash',
      summary: 'A crash between sending a batch and receiving its response left the batch on disk to be sent again, inflating counts by about five percent; batches now carry an in-flight id the server deduplicates for a day.',
      topics: ['analytics', 'retries', 'mobile'],
    },
  },
  {
    id: '3a72e9c5-1b48-4d60-9e37-8c04f5a1b6d2',
    project: ML,
    start: '2026-06-29T14:00:00.000Z',
    prefix: 'p21',
    title: 'Leakage in the evaluation split',
    ex: [
      ['the score jumped four points overnight and nobody touched the model', 'The split is random over rows, so the same person is on both sides of it. Split on the person instead.', ['ml/split.py']],
      ['how far does the honest number fall', 'Back to where it was, plus about half a point of real gain from the new feature.', ['ml/split.py']],
      ['do we keep the old number anywhere', 'In the log with a note. Deleting it is how the next person repeats it.'],
    ],
    card: {
      title: 'Leakage between the train and evaluation splits',
      summary: 'A four point jump came from a random row split putting the same person on both sides; splitting by person restored the honest number, leaving half a point of genuine gain, and the wrong figure was kept with a note.',
      topics: ['machine learning', 'evaluation', 'data leakage'],
    },
  },
  {
    id: 'bd1a4082-7c56-4e93-8b20-9f3d7a56c018',
    project: DOCS,
    start: '2026-06-30T15:00:00.000Z',
    prefix: 'p22',
    title: 'Deprecated pages outrank the current ones',
    ex: [
      ['the deprecated page comes above the current one for the same query', 'Nothing in the ranking knows about age or status. Add a small boost for the current version and a penalty for anything marked deprecated.', ['site/rank.ts']],
      ['how big a boost', 'Small enough that a much better text match still wins. A signal that overrides the text is how a search engine starts lying.', ['site/rank.ts']],
      ['can an editor see what it did', 'A preview that shows the score breakdown per hit, which is also how we debug it.'],
    ],
    card: {
      title: 'Recency signal for the documentation ranking',
      summary: 'Deprecated pages outranked current ones because the ranking had no notion of status; a deliberately small boost and penalty were added, kept below the text signal, with a per-hit score breakdown for editors.',
      topics: ['search', 'ranking', 'documentation'],
    },
  },
];

/**
 * Subagent transcripts. Each is the only place its finding is written down:
 * the parent session above never says what came back.
 */
const SIDECHAINS = [
  {
    parent: 'a82ceb72-455b-4fc8-88b8-993effefe3c7',
    file: 'agent-s2a.jsonl',
    prefix: 's2a',
    agent: 'schema-reader',
    u: 'read the target table and list the not-null columns',
    a: 'Eleven not-null columns; the importer currently writes nine of them.',
  },
  {
    parent: '4ae3102b-1ad3-432b-8f01-b0e64eb5d627',
    file: 'agent-s6a.jsonl',
    prefix: 's6a',
    agent: 'bundle-auditor',
    u: 'measure what tree shaking removes from the icon set and report the numbers',
    a: 'Tree shaking removes 412 KB of the icon set once the barrel import is replaced with per-icon imports. The date library drops another 288 KB after switching to the modular build.',
  },
  {
    parent: 'd4b1f0a7-3c62-4e91-b508-27fa1c6d9e40',
    file: 'agent-p1a.jsonl',
    prefix: 'p1a',
    agent: 'cost-modeller',
    u: 'work out which line of the bill grew last month and by how much',
    a: 'The nat gateway data processing line, up sixty-two percent. Every private subnet reaches object storage through it; a gateway endpoint takes most of that traffic off the meter.',
  },
  {
    parent: '2f7c8b31-6d40-4a75-9e13-c0b5827af4d6',
    file: 'agent-p2a.jsonl',
    prefix: 'p2a',
    agent: 'schema-differ',
    u: 'compare the parquet schema against the source table and list every mismatch',
    a: 'Two columns disagree. The source keeps the amount as a numeric with two decimal places and the writer emits a double, which rounds the pennies away above about ten million; and the status enum arrives as a bare int32 with no dictionary.',
  },
  {
    parent: '9c1e5d80-4b27-4f63-8a91-de50c73b2f18',
    file: 'agent-p3a.jsonl',
    prefix: 'p3a',
    agent: 'a11y-auditor',
    u: 'run the accessibility audit over the new page and report every violation',
    a: 'Nineteen violations. The two that matter: the carousel holds focus inside itself so a screen reader cannot leave it, and the tertiary button sits at 2.8 to 1 against the pale surface.',
  },
  {
    parent: '6b3a9e24-8f05-4c31-b7d2-1a94e6035cb7',
    file: 'agent-p4a.jsonl',
    prefix: 'p4a',
    agent: 'load-runner',
    u: 'run the ramp to a thousand virtual users and report where it breaks',
    a: 'It holds to three hundred and eighty a second. Past that the ninety-ninth percentile goes from a hundred and twenty milliseconds to four seconds, because the connection wait queue never drains.',
  },
];

/**
 * The dead. `history.jsonl` is all that is left of these: prompts, no replies,
 * no transcript on disk. Every one of them is dated before 2026-06-01 so that
 * `--since 2026-06-01` excludes the ghosts as a class, which
 * `tests/recall.test.ts` asserts.
 */
const GHOSTS = [
  {
    id: 'e6aa5ba7-6fce-4542-88d9-12c82cf03edd',
    project: DEVICES,
    start: '2026-04-20T05:00:00.000Z',
    prompts: [
      'the brother laser printer driver will not install on this linux box',
      'it says the ppd file is missing after the deb unpacks',
      'can we build the driver from source instead',
      'cups still cannot see the printer over the network',
      'found it, the avahi service was not running',
    ],
    card: {
      title: 'Printer driver install on linux',
      summary: 'Fought a laser printer driver that would not install, through a missing ppd file and a source build, and found the network discovery failure was a stopped avahi service.',
      topics: ['printing', 'linux', 'drivers'],
    },
  },
  {
    id: '4ddd4b1f-8f16-40c8-8970-658738871ba0',
    project: API,
    start: '2026-04-22T04:00:00.000Z',
    prompts: [
      'the billing cron runs for forty minutes and blocks the nightly backup',
      'move the billing cron onto a queue so it can run in parallel',
      'how many workers before we hit the payment gateway rate limit',
      'write the runbook for a failed billing batch',
    ],
  },
  {
    id: 'cb9472ab-990f-406a-8a13-4f4671733d6a',
    project: WEB,
    start: '2026-04-25T03:00:00.000Z',
    prompts: [
      'the sitemap generator emits duplicate urls for paginated pages',
      'should page 2 be in the sitemap at all',
      'add a canonical link and drop the duplicates from the sitemap',
    ],
    card: {
      title: 'Duplicate urls in the generated sitemap',
      summary: 'Paginated pages were emitted twice into the sitemap; the conversation settled on keeping page one, adding a canonical link and dropping the rest.',
      topics: ['seo', 'sitemap', 'pagination'],
    },
  },
  {
    id: 'b60ae934-1c72-4d85-93a0-58f6e2b41d07',
    project: DEVICES,
    start: '2026-04-28T19:00:00.000Z',
    prompts: [
      'the bluetooth keyboard drops every time the laptop sleeps',
      'it comes back if i toggle bluetooth off and on',
      'is there a way to stop the dongle powering down',
    ],
    card: {
      title: 'Bluetooth keyboard drops after sleep',
      summary: 'A bluetooth keyboard disconnected on every sleep and returned only after toggling the radio; the thread was chasing the usb dongle power management setting.',
      topics: ['bluetooth', 'power management', 'peripherals'],
    },
  },
  {
    id: 'e83f5c17-9d41-4b72-a068-3c25e7f1b904',
    project: INFRA,
    start: '2026-05-12T07:00:00.000Z',
    prompts: [
      'the ci runner is out of disk again',
      'docker keeps every layer from every build on that box',
      'add a nightly prune for images older than a week',
      'how much does that free',
    ],
  },

  // ---------------------------------------------------------- T3.4 additions
  //
  // Three answers and four distractors. The answer ghosts are deliberately
  // uncarded: a ghost query must be answerable out of the prompts alone.
  {
    id: 'f1c48b07-6d92-4a35-8e07-2b91c5d4703a',
    project: MOBILE,
    start: '2026-05-02T06:00:00.000Z',
    prompts: [
      'the app store rejected the build for a missing privacy label',
      'which of the sdks is collecting the advertising id',
      'can we ship without that sdk at all',
      'resubmitted with the label filled in and it went through',
    ],
  },
  {
    id: '3b7d94e1-0c58-4f26-9a83-71e6d0b5c247',
    project: DEVICES,
    start: '2026-05-05T18:00:00.000Z',
    prompts: [
      'the second monitor goes black whenever the dock gets warm',
      'it comes back if i unplug the usb-c and put it back in',
      'is there a firmware update for the dock',
      'the firmware fixed it, three days without a drop',
    ],
  },
  {
    id: 'a6e02f53-4b71-4c98-8d26-59fa0e73c481',
    project: API,
    start: '2026-05-18T09:00:00.000Z',
    prompts: [
      'the staging database has real customer names in it',
      'who can reach staging right now',
      'we need a scrub step inside the restore, not after it',
      'the scrub runs before anything can connect, verified on today copy',
    ],
  },
  {
    id: '5d3c8a72-1e64-4b09-a537-8c2f60d91eb4',
    project: DEVICES,
    start: '2026-04-15T08:00:00.000Z',
    prompts: [
      'the webcam is not detected after the kernel update',
      'modprobe says the module is missing entirely',
      'rolling back to the previous kernel until there is a build',
    ],
    card: {
      title: 'Webcam lost after a kernel update',
      summary: 'A kernel update left the webcam undetected with its module missing from the build; the session ended on a rollback to the previous kernel while waiting for a rebuilt module.',
      topics: ['kernel', 'drivers', 'regression'],
    },
  },
  {
    id: 'c4a95e18-7d20-4f63-b849-1e05a3c76d92',
    project: INFRA,
    start: '2026-04-18T09:00:00.000Z',
    prompts: [
      'the build agent ran out of inodes with plenty of space left',
      'it is millions of tiny files under the package cache',
      'clear the cache weekly and leave the images alone',
    ],
    card: {
      title: 'Build agent out of inodes, not bytes',
      summary: 'A build agent failed with disk errors while showing free space because the package cache had exhausted the inode table; the fix was a weekly cache clear rather than touching the image store.',
      topics: ['continuous integration', 'disk', 'caching'],
    },
  },
  {
    id: '9f2b60d4-3a17-4e58-bc09-27d6154fae83',
    project: API,
    start: '2026-05-08T07:00:00.000Z',
    prompts: [
      'the invoice pdf job stalls on the biggest account',
      'it renders every line item in one pass and runs out of heap',
      'page it and stream each page straight to storage',
    ],
    card: {
      title: 'Invoice rendering runs out of heap',
      summary: 'The invoice pdf job stalled on the largest account because it rendered every line item in one pass; paging the render and streaming each page to storage kept the memory flat.',
      topics: ['pdf', 'batch jobs', 'memory'],
    },
  },
  {
    id: 'e70d51c6-8f43-4b27-9051-6ac3d792be40',
    project: WEB,
    start: '2026-05-21T15:00:00.000Z',
    prompts: [
      'the newsletter signup posts twice if you double click it',
      'disable the button on submit and key the request',
      'the second post is gone, and the duplicate rows are cleaned up',
    ],
    card: {
      title: 'Double click posts the signup form twice',
      summary: 'A double click on the newsletter signup submitted the form twice; the button now disables on submit and the request carries a key, with the duplicate rows cleaned up afterwards.',
      topics: ['forms', 'duplicates', 'frontend'],
    },
  },
];

// ------------------------------------------------------------------ emitters

const slug = (p) => p.replace(/\//g, '-');
const iso = (ms) => new Date(ms).toISOString();
const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

function sessionRecords(s) {
  const start = Date.parse(s.start);
  const base = {
    sessionId: s.id,
    cwd: s.project,
    version: VERSION,
    gitBranch: s.branch ?? 'main',
    userType: 'external',
    entrypoint: s.entrypoint ?? 'cli',
    isSidechain: false,
  };
  const out = [];
  s.ex.forEach(([prompt, reply, files], i) => {
    const at = start + i * TURN;
    out.push({
      ...base,
      type: 'user',
      uuid: `${s.prefix}-u${i}`,
      parentUuid: i === 0 ? null : `${s.prefix}-a${i - 1}`,
      promptId: `${s.prefix}p${i}`,
      timestamp: iso(at),
      message: { role: 'user', content: prompt },
    });
    const content = [{ type: 'text', text: reply }];
    (files ?? []).forEach((f, j) => {
      content.push({
        type: 'tool_use',
        id: `${s.prefix}t${i}${j}`,
        name: 'Edit',
        input: { file_path: `${s.project}/${f}` },
      });
    });
    out.push({
      ...base,
      type: 'assistant',
      uuid: `${s.prefix}-a${i}`,
      parentUuid: `${s.prefix}-u${i}`,
      timestamp: iso(at + 20_000),
      message: { role: 'assistant', model: MODEL, content },
    });
    if (files && files.length) {
      out.push({
        ...base,
        type: 'user',
        uuid: `${s.prefix}-r${i}`,
        parentUuid: `${s.prefix}-a${i}`,
        timestamp: iso(at + 25_000),
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: `${s.prefix}t${i}0`, content: 'ok' }],
        },
      });
    }
  });
  if (s.title) {
    out.push({
      type: 'ai-title',
      sessionId: s.id,
      aiTitle: s.title,
      timestamp: iso(start + MINUTE),
    });
  }
  return out;
}

function sidechainRecords(sc, parent) {
  const at = Date.parse(parent.start) + 60 * MINUTE;
  const base = {
    sessionId: parent.id,
    cwd: parent.project,
    version: VERSION,
    gitBranch: parent.branch ?? 'main',
    userType: 'external',
    entrypoint: 'sdk-ts',
    isSidechain: true,
  };
  return [
    { type: 'agent-name', sessionId: parent.id, agentName: sc.agent, isSidechain: true },
    {
      ...base,
      type: 'user',
      uuid: `${sc.prefix}-u0`,
      parentUuid: null,
      promptId: `${sc.prefix}p0`,
      timestamp: iso(at),
      message: { role: 'user', content: sc.u },
    },
    {
      ...base,
      type: 'assistant',
      uuid: `${sc.prefix}-a0`,
      parentUuid: `${sc.prefix}-u0`,
      timestamp: iso(at + 30_000),
      message: { role: 'assistant', content: [{ type: 'text', text: sc.a }] },
    },
  ];
}

/**
 * One history row per prompt, for the living and the dead alike, in time
 * order. The rows for the five sessions with no file on disk are the only
 * trace those conversations left, and `rescue` rebuilds them from here.
 */
function historyRows() {
  const rows = [];
  for (const g of GHOSTS) {
    const start = Date.parse(g.start);
    g.prompts.forEach((display, i) => {
      rows.push({
        display,
        pastedContents: {},
        timestamp: start + i * 11 * MINUTE,
        project: g.project,
        sessionId: g.id,
      });
    });
  }
  for (const s of SESSIONS) {
    const start = Date.parse(s.start);
    s.ex.forEach(([prompt], i) => {
      rows.push({
        display: prompt,
        pastedContents: {},
        timestamp: start + i * TURN,
        project: s.project,
        sessionId: s.id,
      });
    });
  }
  rows.sort((a, b) => a.timestamp - b.timestamp);
  return rows;
}

/**
 * The card sidecar, read by `evals/run.ts`.
 *
 * The eval index cannot run the real card pipeline: `runCards` calls a model,
 * which costs money, needs a key and gives a different answer every time —
 * none of which belongs in a metric CI can reproduce. So the cards are fixture
 * data like everything else, and the runner writes them through the real
 * `writeCard`, which is the code path that populates `cards`, `cards_fts` and
 * `vec_cards`. What is being measured is retrieval over card text, not the
 * extractor that would have produced it.
 *
 * The claims are derived rather than written: a real card's `decisions` are
 * grounded in the transcript and cite the exchange they came from, so deriving
 * them from the reply text is closer to the truth than inventing prose that
 * cites nothing.
 */
function cardRecords() {
  const out = [];
  for (const s of SESSIONS) {
    if (!s.card || s.ex.length < MIN_EXCHANGES) continue;
    const files = [...new Set(s.ex.flatMap(([, , f]) => f ?? []))];
    out.push({
      session_id: s.id,
      harness: 'claude',
      project: s.project,
      project_slug: slug(s.project),
      source: 'transcript',
      title: s.card.title,
      summary: s.card.summary,
      topics: s.card.topics,
      decisions: s.ex.slice(0, 2).map(([, reply], i) => ({
        what: firstSentence(reply),
        why: null,
        evidence_seq: [i],
      })),
      files: files.map((f) => `${s.project}/${f}`),
      outcome: s.card.outcome ?? 'shipped',
      open_threads: [],
      tags: s.card.topics.map(tag).slice(0, 3),
    });
  }
  for (const g of GHOSTS) {
    if (!g.card || g.prompts.length < MIN_EXCHANGES) continue;
    out.push({
      session_id: g.id,
      harness: 'claude',
      project: g.project,
      project_slug: slug(g.project),
      source: 'prompts-only',
      title: g.card.title,
      summary: g.card.summary,
      topics: g.card.topics,
      decisions: [],
      files: [],
      outcome: g.card.outcome ?? 'unknown',
      // A prompts-only card cannot know how it ended; what is left is what was
      // still being asked.
      open_threads: [{ what: firstSentence(g.prompts[g.prompts.length - 1]), evidence_seq: [g.prompts.length - 1] }],
      tags: g.card.topics.map(tag).slice(0, 3),
    });
  }
  return out;
}

const firstSentence = (s) => {
  const cut = s.indexOf('. ');
  return (cut > 0 ? s.slice(0, cut) : s).replace(/\.$/, '');
};
const tag = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ------------------------------------------------------------------- writing

function build() {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  const byId = new Map(SESSIONS.map((s) => [s.id, s]));
  const seen = new Set();
  for (const s of SESSIONS) {
    if (seen.has(s.id)) throw new Error(`duplicate session id ${s.id}`);
    seen.add(s.id);
    const dir = path.join(root, 'projects', slug(s.project));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${s.id}.jsonl`), jsonl(sessionRecords(s)));
  }
  for (const sc of SIDECHAINS) {
    const parent = byId.get(sc.parent);
    if (!parent) throw new Error(`sidechain ${sc.file} has no parent ${sc.parent}`);
    const dir = path.join(root, 'projects', slug(parent.project), parent.id, 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, sc.file), jsonl(sidechainRecords(sc, parent)));
  }
  for (const g of GHOSTS) {
    if (seen.has(g.id)) throw new Error(`ghost ${g.id} also has a transcript — it is not a ghost`);
    seen.add(g.id);
    if (Date.parse(g.start) >= Date.parse('2026-06-01T00:00:00.000Z')) {
      // tests/recall.test.ts asserts that `--since 2026-06-01` excludes every
      // ghost. A ghost dated after it would turn that into a flake.
      throw new Error(`ghost ${g.id} starts on or after 2026-06-01`);
    }
  }

  fs.writeFileSync(path.join(root, 'history.jsonl'), jsonl(historyRows()));
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 30 }, null, 2));
  fs.writeFileSync(cardsFile, jsonl(cardRecords()));

  const cards = cardRecords();
  const projects = new Set([...SESSIONS.map((s) => s.project), ...GHOSTS.map((g) => g.project)]);
  process.stdout.write(
    `evals/fixture: ${SESSIONS.length} sessions, ${SIDECHAINS.length} sidechains, ` +
      `${GHOSTS.length} ghosts, ${cards.length} cards, ${projects.size} projects\n`,
  );
}

build();

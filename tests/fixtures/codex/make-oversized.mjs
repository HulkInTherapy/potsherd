/**
 * Regenerates `sessions/2099/01/03/rollout-…-d2d2….jsonl`, the oversized-line
 * fixture. Everything in it is synthetic: the base64 is a repeating pattern,
 * not an image, and no real path, prompt or token appears anywhere.
 *
 * The real trap it stands in for is a 1,917,792-byte `custom_tool_call_output`
 * whose `output[]` holds 15 `input_image` parts of 109–198 KB of base64 each.
 * Committing two megabytes of noise to git would be silly, so the stand-in is
 * the same *shape* at 1/300th the size — and, crucially, its `output[]` has
 * **no `text` part at all**, which is the case that makes
 * `stringifyToolOutput` fall through to `JSON.stringify(output)` and put the
 * whole blob into an `Exchange`. That is the path the adapter has to close.
 *
 *   node tests/fixtures/codex/make-oversized.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(
  here,
  'sessions/2099/01/03/rollout-2099-01-03T09-15-00-d2d2d2d2-2222-4222-8222-222222222222.jsonl',
);

const ID = 'd2d2d2d2-2222-4222-8222-222222222222';
const TURN = '22222222-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const CWD = '/tmp/potsherd-codex-demo';

/** Base64 alphabet, repeated. Decodes to nothing meaningful; that is the point. */
const b64 = (chars) => 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'.repeat(Math.ceil(chars / 44)).slice(0, chars);

const line = (o) => JSON.stringify(o) + '\n';

const records = [
  {
    timestamp: '2099-01-03T04:00:00.100Z',
    type: 'session_meta',
    payload: {
      session_id: ID,
      id: ID,
      timestamp: '2099-01-03T04:00:00.050Z',
      cwd: CWD,
      originator: 'codex_cli',
      cli_version: '0.120.0',
      source: 'cli',
      thread_source: 'user',
      model_provider: 'synthetic',
      base_instructions: { text: 'SYNTHETIC BASE INSTRUCTIONS.' },
      dynamic_tools: [],
      history_mode: 'legacy',
      context_window: { window_id: 'd2d2d2d2-2222-4222-8222-2222222222ff' },
    },
  },
  {
    timestamp: '2099-01-03T04:00:00.500Z',
    type: 'turn_context',
    payload: { turn_id: TURN, cwd: CWD, model: 'synthetic-model-1', effort: 'medium' },
  },
  {
    timestamp: '2099-01-03T04:00:01.000Z',
    type: 'event_msg',
    payload: {
      type: 'user_message',
      client_id: '22222222-2222-4222-8222-222222222aaa',
      message: 'render the deck and show me the pages',
      images: [],
      local_images: [],
      text_elements: [],
    },
  },
  {
    timestamp: '2099-01-03T04:00:01.001Z',
    type: 'response_item',
    payload: {
      type: 'message',
      id: 'msg_d2d2d2d2-0001',
      role: 'user',
      content: [{ type: 'input_text', text: 'render the deck and show me the pages' }],
      internal_chat_message_metadata_passthrough: { turn_id: TURN },
    },
  },
  {
    timestamp: '2099-01-03T04:00:02.000Z',
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      id: 'ctc_d2d2d2d2-0001',
      status: 'completed',
      call_id: 'call_synthetic0000000003',
      name: 'exec',
      // JavaScript source, not JSON arguments — trap 2.
      input:
        'const imgs = await Promise.all(["tmp/page-01.png","tmp/page-02.png"].map((p) => tools.read_image({path: p}))); image(imgs);',
      internal_chat_message_metadata_passthrough: { turn_id: TURN },
    },
  },
  {
    // The oversized line. No `text` part anywhere in `output[]`.
    timestamp: '2099-01-03T04:00:03.000Z',
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output',
      id: 'ctco_d2d2d2d2-0001',
      call_id: 'call_synthetic0000000003',
      output: [
        { type: 'input_image', image_url: `data:image/png;base64,${b64(6000)}`, detail: 'high' },
        { type: 'input_image', image_url: `data:image/png;base64,${b64(6000)}`, detail: 'high' },
      ],
      internal_chat_message_metadata_passthrough: { turn_id: TURN },
    },
  },
  {
    // A second output that *does* carry text, with a base64 blob inline in it.
    timestamp: '2099-01-03T04:00:04.000Z',
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      id: 'ctc_d2d2d2d2-0002',
      status: 'completed',
      call_id: 'call_synthetic0000000004',
      name: 'exec',
      input: 'const r = await tools.exec_command({"cmd":"base64 tmp/page-01.png","workdir":"."}); text(r);',
      internal_chat_message_metadata_passthrough: { turn_id: TURN },
    },
  },
  {
    timestamp: '2099-01-03T04:00:05.000Z',
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output',
      id: 'ctco_d2d2d2d2-0002',
      call_id: 'call_synthetic0000000004',
      output: [
        {
          type: 'input_text',
          text: `Script completed\nWall time 0.4 seconds\nOutput:\ndata:image/png;base64,${b64(3000)}\ndone`,
        },
      ],
      internal_chat_message_metadata_passthrough: { turn_id: TURN },
    },
  },
  {
    timestamp: '2099-01-03T04:00:06.000Z',
    type: 'event_msg',
    payload: { type: 'agent_message', message: 'Rendered two pages.', phase: 'final_answer', memory_citation: null },
  },
  {
    timestamp: '2099-01-03T04:00:06.001Z',
    type: 'response_item',
    payload: {
      type: 'message',
      id: 'msg_08synthetic0003',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Rendered two pages.' }],
      internal_chat_message_metadata_passthrough: { turn_id: TURN },
    },
  },
];

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, records.map(line).join(''), 'utf8');
const { size } = fs.statSync(out);
console.log(`wrote ${out} (${size} bytes)`);

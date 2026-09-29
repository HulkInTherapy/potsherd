import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { describeError } from './errors.js';

/**
 * One tool result, in the two shapes a client can read.
 *
 * `content[0].text` is **byte-identical to what `--json` prints**: the CLI
 * writes `JSON.stringify(value, null, 2)` in `output.ts` and so does this. That
 * is the `03` §9 parity requirement taken literally — a client and a terminal
 * never disagree because they are handed the same bytes, not merely the same
 * fields. Diffing the two is a one-line shell command, and `tests/mcp.test.ts`
 * does exactly that for all six tools.
 *
 * `structuredContent` carries the same object again for clients that prefer it.
 * No `outputSchema` is declared: the SDK validates structured output only when
 * a schema is present, and pinning six large schemas here would mean a shape
 * change in core — a field added to `AskResult`, say — turning into a runtime
 * validation error at the surface rather than an extra field the client can
 * ignore. The contract in `WAVE.md` fixes the *inputs*; the outputs are core's
 * own `--json` and are versioned with it.
 */
export function jsonResult(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

/** A failure the model can act on. Never a throw — see `errors.ts`. */
export function errorResult(err: unknown): CallToolResult {
  return { content: [{ type: 'text', text: describeError(err) }], isError: true };
}

/**
 * The wrapper every tool handler is built out of.
 *
 * There is exactly one `try` in this package's request path and it is here, so
 * that "the server must stay up" is a property of the file rather than a habit
 * six handlers have to remember. A handler may throw anything it likes.
 */
export async function guarded(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return errorResult(err);
  }
}

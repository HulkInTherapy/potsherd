import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

/**
 * No test may touch the developer's real ~/.potsherd or ~/.claude.
 *
 * A test that forgets to pass an explicit directory would otherwise read — or
 * worse, write — the machine's actual archive, and would pass or fail based on
 * whoever ran it. Pointing both env vars at a throwaway directory makes the
 * accident impossible rather than merely discouraged.
 */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'potsherd-vitest-'));

process.env['POTSHERD_DIR'] = path.join(sandbox, 'potsherd');
process.env['CLAUDE_CONFIG_DIR'] = path.join(sandbox, 'claude-empty');
process.env['NO_COLOR'] = '1';

/**
 * And no test may pull the 48 MB embedding runtime over the wire.
 *
 * `potsherd index` acquires it automatically now — that is the whole of phase
 * 10 §A2 — which means every `cli(['index', …])` in this suite would start a
 * background download, on every machine, on every run, and CI would fetch it
 * once per test file. The tests that genuinely need a runtime read one that is
 * already cached and skip when it is not; `POTSHERD_TEST_EMBED=1` is the one
 * way to ask for the download deliberately.
 *
 * This is set here rather than per-test because the download happens in a
 * detached child of a CLI subprocess, and a child inherits the environment.
 */
if (process.env['POTSHERD_TEST_EMBED'] !== '1') process.env['POTSHERD_OFFLINE'] = '1';

afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

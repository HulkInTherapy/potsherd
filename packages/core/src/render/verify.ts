import { Card } from '../render.js';
import { Theme } from '../theme.js';
import * as f from '../format.js';

/**
 * `potsherd audit --verify` — the honesty contract from plans/05:
 *
 *   "potsherd audit --verify prints the standalone python that recomputes the
 *    headline numbers, so nobody has to trust potsherd to check potsherd."
 *
 * Two rules shape this file:
 *
 *   1. the snippet must run with nothing but python 3 and the standard library,
 *      on a machine that has never checked this repository out. Somebody who
 *      met potsherd through `npx` has no `scripts/` directory, so pointing at
 *      one would be pointing at nothing.
 *   2. it must implement the four definitions independently — same definitions,
 *      different code. It is not allowed to call potsherd, read potsherd's
 *      database, or trust any number potsherd printed.
 */

/** Where the fuller version of the same thing lives, for people with a checkout. */
export const VERIFY_SCRIPT_PATH = 'scripts/verify-audit.py';
export const VERIFY_SCRIPT_URL =
  'https://github.com/HulkInTherapy/potsherd/blob/main/scripts/verify-audit.py';

/**
 * Self-contained: no imports beyond the standard library, no potsherd, no
 * arguments. Deliberately short enough to read in one sitting — anything a
 * reader has to take on trust defeats the purpose.
 */
export const VERIFY_SNIPPET = `python3 - <<'PY'
import glob, json, os
root = os.path.expanduser(os.environ.get("CLAUDE_CONFIG_DIR") or "~/.claude")
proj = os.path.join(root, "projects")

# a session is a transcript directly inside a project dir. subagent transcripts
# live in a subagents/ directory and belong to their parent session, so they are
# never counted as sessions.
on_disk = {os.path.basename(p)[:-6] for p in glob.glob(os.path.join(proj, "*", "*.jsonl"))
           if "subagents" not in p.split(os.sep)}

prompts = {}
try:
    with open(os.path.join(root, "history.jsonl"), encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                sid = json.loads(line).get("sessionId")
            except ValueError:
                continue                       # a torn line is skipped, never fatal
            if sid:
                prompts[sid] = prompts.get(sid, 0) + 1
except OSError:
    pass

indexed = set()
for p in glob.glob(os.path.join(proj, "*", "sessions-index.json")):
    try:
        with open(p, encoding="utf-8") as fh:
            entries = json.load(fh).get("entries", [])
    except (OSError, ValueError):
        continue
    indexed |= {e["sessionId"] for e in entries
                if e.get("sessionId") and not e.get("isSidechain")}

ever = on_disk | set(prompts) | indexed        # sessions ever started
gone = ever - on_disk                          # deleted
print("sessions ever started %7d" % len(ever))
print("still on disk         %7d" % len(on_disk))
print("deleted               %7d" % len(gone))
print("prompts lost          %7d" % sum(prompts.get(s, 0) for s in gone))
PY`;

export interface VerifyInfo {
  claudeDir: string;
  scriptPath: string;
  scriptUrl: string;
  snippet: string;
  definitions: Record<string, string>;
}

export const VERIFY_DEFINITIONS: Record<string, string> = {
  sessionsEver:
    'distinct session ids in any of history.jsonl, the transcripts on disk, or a sessions-index.json',
  onDisk: 'of those, the ones with a transcript file today',
  deleted: 'sessions ever started − still on disk',
  promptsLost: 'lines in history.jsonl whose sessionId is deleted',
};

export function verifyInfo(claudeDir: string): VerifyInfo {
  return {
    claudeDir,
    scriptPath: VERIFY_SCRIPT_PATH,
    scriptUrl: VERIFY_SCRIPT_URL,
    snippet: VERIFY_SNIPPET,
    definitions: VERIFY_DEFINITIONS,
  };
}

/**
 * The human view. It prints the snippet unindented and unwrapped: this is the
 * one output in potsherd meant to be selected and pasted, so the design system's
 * 2-space indent would be a bug here, not a rule.
 */
export function renderVerify(claudeDir: string, t: Theme = new Theme()): string {
  const card = new Card(t);
  card.heading('audit --verify', claudeDir, f.date(new Date())).blank();
  card.text('nobody should have to trust potsherd to check potsherd. this recomputes');
  card.text('the four headline numbers with the python standard library and nothing');
  card.text('else — no potsherd, no database, no checkout needed. paste it:');
  card.blank();
  for (const line of VERIFY_SNIPPET.split('\n')) card.raw(line);
  card.blank();
  card.text('the definitions it implements:');
  card.blank();
  card.rows([
    { label: 'sessions ever started', value: '', note: 'in history, on disk, or in a sessions-index' },
    { label: 'still on disk', value: '', note: 'of those, the ones with a transcript today' },
    { label: 'deleted', value: '', note: `sessions ever ${t.g('−', '-')} still on disk` },
    { label: 'prompts lost', value: '', note: 'history lines whose sessionId is deleted' },
  ]);
  card.blank();
  card.text(`the same code, with --json and --claude-dir: ${VERIFY_SCRIPT_PATH}`);
  // A URL is unusable the moment it is truncated. Where the full one does not
  // fit, the repository root does, and the path is on the line above.
  card.fit(VERIFY_SCRIPT_URL, 'https://github.com/HulkInTherapy/potsherd');
  card.blank();
  card.text('if the two ever disagree, the python is right and potsherd has a bug.');
  card.fix('potsherd audit --json', 'to compare the four numbers.', 'and compare.');
  return card.toString();
}

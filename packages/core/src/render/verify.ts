import process from 'node:process';
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
 *   2. it must implement the definitions independently — same definitions,
 *      different code. It is not allowed to call potsherd, read potsherd's
 *      database, or trust any number potsherd printed.
 *   3. it must recompute **every number the card prints**, not a subset. A
 *      screen number the receipt cannot check is worse than no screen number,
 *      because the receipt then answers a smaller question than the screen
 *      asks while looking like it answered all of it. Phase 8 added a fifth
 *      row to the card and a fifth line here in the same commit for that
 *      reason.
 */

/** Where the fuller version of the same thing lives, for people with a checkout. */
export const VERIFY_SCRIPT_PATH = 'scripts/verify-audit.py';
export const VERIFY_SCRIPT_URL =
  'https://github.com/HulkInTherapy/potsherd/blob/main/scripts/verify-audit.py';

/**
 * Self-contained: no imports beyond the standard library, no potsherd, no
 * arguments. Deliberately short enough to read in one sitting — anything a
 * reader has to take on trust defeats the purpose.
 *
 * It recomputes **every number the card prints**, which is why `names()` is
 * here. When phase 8 added the fifth row — how many deleted sessions recorded
 * nothing that names them — the choice was to add the rule to this snippet or
 * to leave one number on the screen that the receipt could not check, and a
 * receipt that answers a smaller question than the screen asks is not a
 * receipt. The rule is a transcription of `rescue.ts`'s `isSubstantivePrompt`:
 * not a slash command, at least 8 code points, and not one of seven stopwords.
 * `len()` on a python 3 `str` counts code points, which is the same cut
 * `Array.from(...).length` makes.
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

STOP = {"clear", "continue", "ok", "yes", "hi", "y", "n"}

def names(text):
    "does this prompt name the session it opened?"
    c = " ".join((text or "").split())
    return bool(c) and not c.startswith("/") and len(c) >= 8 and c.lower() not in STOP

prompts, named = {}, set()
try:
    with open(os.path.join(root, "history.jsonl"), encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                rec = json.loads(line)
            except ValueError:
                continue                       # a torn line is skipped, never fatal
            sid = rec.get("sessionId")
            if sid:
                prompts[sid] = prompts.get(sid, 0) + 1
                if names(rec.get("display")):
                    named.add(sid)
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
# of the deleted, the ones that recorded something and nothing that names them.
# a deleted session with no history line at all recorded nothing rather than
# something unnameable, so the s-in-prompts test is part of the question.
stubs = sum(1 for s in gone if s in prompts and s not in named)
print("sessions ever started   %7d" % len(ever))
print("still on disk           %7d" % len(on_disk))
print("deleted                 %7d" % len(gone))
print("prompts lost            %7d" % sum(prompts.get(s, 0) for s in gone))
if stubs:
    print("only commands and stubs %7d" % stubs)
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
  deletedWithoutSubstantivePrompt:
    'deleted sessions with history lines but no prompt that names them: '
    + 'nothing that is not a slash command, is at least 8 characters, '
    + 'and is not one of clear, continue, ok, yes, hi, y, n',
};

/**
 * The snippet, bound to the directory the audit it corroborates was run
 * against.
 *
 * `VERIFY_SNIPPET` defaults to `CLAUDE_CONFIG_DIR` or `~/.claude`, which is
 * right when somebody pastes it into a fresh shell and wrong the moment it is
 * *piped* out of a run that had `--claude-dir`:
 *
 *     potsherd audit --claude-dir X --verify --json | jq -r .snippet | sh
 *
 * `sh` does not inherit a flag. The verifier followed exactly that line out of
 * `FINAL-REPORT.md`, got **340 / 41** against the audit's **330 / 31**, and
 * reported the honesty contract as broken — the one claim in this product that
 * exists so nobody has to trust it. The product was right and the snippet was
 * answering a different question, which is worse than being wrong, because it
 * is wrong in a way that reads as an audit under-reporting by ten.
 *
 * So a snippet emitted for a *named* directory says so, on one line, above the
 * code. The default form — no `--claude-dir` — is unchanged, because there the
 * environment variable is the honest answer and hard-coding the resolved home
 * would put a machine path into something people paste into issues.
 */
export function snippetFor(claudeDir: string, o: { env?: NodeJS.ProcessEnv } = {}): string {
  const env = o.env ?? process.env;
  const dflt = env['CLAUDE_CONFIG_DIR'];
  const home = env['HOME'] ?? '';
  const isDefault =
    claudeDir === dflt || (home !== '' && claudeDir === `${home}/.claude`.replace(/\/+/g, '/'));
  if (isDefault) return VERIFY_SNIPPET;
  return VERIFY_SNIPPET.replace(
    "python3 - <<'PY'",
    `CLAUDE_CONFIG_DIR=${JSON.stringify(claudeDir)} python3 - <<'PY'`,
  );
}

export function verifyInfo(claudeDir: string, o: { env?: NodeJS.ProcessEnv } = {}): VerifyInfo {
  return {
    claudeDir,
    scriptPath: VERIFY_SCRIPT_PATH,
    scriptUrl: VERIFY_SCRIPT_URL,
    snippet: snippetFor(claudeDir, o),
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
  card.text('every number on the audit card with the python standard library and');
  card.text('nothing else — no potsherd, no database, no checkout needed. paste it:');
  card.blank();
  for (const line of snippetFor(claudeDir).split('\n')) card.raw(line);
  card.blank();
  card.text('the definitions it implements:');
  card.blank();
  card.rows([
    { label: 'sessions ever started', value: '', note: 'in history, on disk, or in a sessions-index' },
    { label: 'still on disk', value: '', note: 'of those, the ones with a transcript today' },
    { label: 'deleted', value: '', note: `sessions ever ${t.g('−', '-')} still on disk` },
    { label: 'prompts lost', value: '', note: 'history lines whose sessionId is deleted' },
    {
      label: 'only commands and stubs',
      value: '',
      note: 'of those, with no prompt that names them',
    },
  ]);
  card.blank();
  card.text(`the same code, with --json and --claude-dir: ${VERIFY_SCRIPT_PATH}`);
  // A URL is unusable the moment it is truncated. Where the full one does not
  // fit, the repository root does, and the path is on the line above.
  card.fit(VERIFY_SCRIPT_URL, 'https://github.com/HulkInTherapy/potsherd');
  card.blank();
  card.text('if the two ever disagree, the python is right and potsherd has a bug.');
  card.fix('potsherd audit --json', 'to compare them number for number.', 'and compare.');
  return card.toString();
}

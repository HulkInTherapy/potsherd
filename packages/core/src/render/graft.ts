import { Card } from '../render.js';
import { Theme } from '../theme.js';
import * as fmt from '../format.js';
import { tildify } from '../paths.js';
import type { GraftReport } from '../graft.js';

/**
 * `potsherd graft` on screen: the receipt, then the brief.
 *
 * `plans/05` moment 5 is the brief itself — *the user runs one command and the
 * agent visibly knows a thing from a month ago* — so the brief is printed
 * whole and unstyled, exactly as it was written to disk. Anything else and the
 * thing the user pastes and the thing the user read would be two different
 * strings, which is the one difference a re-entry verb cannot afford.
 *
 * The receipt above it carries the three numbers that decide whether to trust
 * the brief: how many tokens it is against the budget it promised, how many of
 * its citations resolved, and where it went. The token count is followed by
 * `est.` on every path but the api one — `05`'s honesty contract in the place
 * it is easiest to skip, because an estimate that looks like a measurement is
 * the bug this project has already shipped once.
 */
export function renderGraft(r: GraftReport, t: Theme = new Theme()): string {
  const card = new Card(t);
  const resolved = r.citations.filter((c) => c.resolves).length;
  const total = r.citations.length;
  const bad = total - resolved;

  card.heading('graft', `${r.harness} ${r.id8}`, r.date).blank();
  card.text(fmt.elide(r.title, Math.max(20, t.width - 4)));
  if (r.about) card.text(t.dim(`about  ${r.about}`));
  card.blank();

  const budgetNote = `of ${r.budget} budget${r.estimated ? '  ·  est. (chars/3.6)' : '  ·  counted'}`;
  card.row({
    label: 'tokens',
    value: fmt.num(r.tokens),
    note: budgetNote,
    tone: r.tokens <= r.budget ? 'accent' : 'warn',
  });
  // **T4.7a G4.** `citations 0/0 · "distinct, and all resolve"` read *green*
  // on a brief that cites nothing — the receipt's most reassuring line sitting
  // above a brief with no evidence in it at all. "All of them resolve" is
  // vacuously true of an empty set and useless to a reader deciding whether to
  // trust what is underneath; the whole point of this row is to answer *is
  // this brief backed by anything*, and on zero the answer is no. It is a
  // `warn`, and it names the situation rather than congratulating it.
  card.row({
    label: 'citations',
    value: `${resolved}/${total}`,
    note:
      total === 0
        ? 'nothing in this brief is cited'
        : bad > 0
          ? `${bad} named an exchange the index has not got`
          : 'distinct, and all resolve',
    tone: total === 0 || bad > 0 ? 'warn' : 'none',
  });
  card.row({
    label: 'exchanges',
    value: fmt.num(r.exchanges),
    note: r.isGhost ? 'prompts only — the assistant side is gone' : (r.project || ''),
    tone: r.isGhost ? 'warn' : 'none',
  });
  if (r.trimmed > 0) {
    card.row({
      label: 'trimmed to fit',
      value: `${r.trimmed}`,
      note: `line${r.trimmed === 1 ? '' : 's'} dropped from the end`,
      tone: 'dim',
    });
  }
  if (r.droppedLines.length > 0) {
    card.row({
      label: 'dropped, uncited',
      value: `${r.droppedLines.length}`,
      note: 'no citation on them resolved',
      tone: 'warn',
    });
  }
  card.row({
    label: r.via === 'model' ? 'wrote' : 'wrote, unsummarised',
    value: '',
    note: r.path ? tildify(r.path) : 'not written',
    tone: 'dim',
  });
  // **C-9**, the same sentence one file over: this printed `no model call —
  // the model call failed (…)` on the two card-only branches that reach it
  // *because* a call was made. `called` is the fact that tells them apart, and
  // it is the difference between a run that cost nothing and a run whose
  // backend was not there — a flag versus a login.
  if (r.via === 'card-only' && r.reason) {
    card.text(t.dim(`${r.called ? 'model call, no summary' : 'no model call'} — ${r.reason}`));
  }
  if (r.spend.calls > 0) {
    card.row({
      label: 'model',
      value: fmt.duration(r.spend.ms),
      // **T4.7a G2.** `render/ask.ts:109`, `render/ask.ts:212` and
      // `cli/commands/ask.ts:101` all guard money with `r.estimated`; this was
      // the one site in the product that printed a dollar figure bare — two
      // rows under a `tokens` row that labels *itself* `est. (chars/3.6)`.
      // On the subscription path that figure is an api-equivalent estimate and
      // not money anybody was charged, and `05`'s honesty contract is explicit:
      // *estimates are labelled `est.`*. Seen unlabelled on three real runs.
      note:
        `${r.spend.calls} call${r.spend.calls === 1 ? '' : 's'}` +
        (r.spend.usd > 0 ? `  ·  ${fmt.money(r.spend.usd)}${r.estimated ? ' est.' : ''}` : ''),
      tone: 'dim',
    });
  }

  if (r.clip) {
    card.blank();
    if (r.clip.ok) card.text(t.ok(`copied to the clipboard with ${r.clip.tool}`));
    // A missing clipboard tool is not an error: the brief is on disk and on
    // screen, and the run did everything that was asked of it.
    else card.text(t.dim(r.clip.note ?? 'the clipboard could not be written'));
  }

  card.blank();
  card.raw(t.dim('─'.repeat(Math.max(8, Math.min(t.width, 72)))));
  card.blank();

  const out = [card.toString()];
  // Verbatim. What is on screen and what is on disk are the same string.
  out.push(r.brief.replace(/\n+$/, ''));
  out.push('');

  const next = new Card(t);
  next.fix(
    `potsherd show ${r.id8}`,
    'read the session this came from, end to end',
    'read the whole session',
  );
  out.push(next.toString());
  return out.join('\n');
}

/**
 * `GraftResult` as the pinned interface has it, and nothing else.
 *
 * `phases/phase-4/WAVE.md`: *`graft --json` prints `GraftResult` verbatim*.
 * The extra fields `GraftReport` carries are for the human view and the tests;
 * a machine reader was promised one shape and gets exactly that one.
 */
export function graftJson(r: GraftReport): Record<string, unknown> {
  return {
    sessionId: r.sessionId,
    id8: r.id8,
    project: r.project,
    harness: r.harness,
    about: r.about,
    exchanges: r.exchanges,
    date: r.date,
    budget: r.budget,
    tokens: r.tokens,
    estimated: r.estimated,
    brief: r.brief,
    path: r.path,
    clipped: r.clipped,
    citations: r.citations,
    spend: r.spend,
    ms: r.ms,
  };
}

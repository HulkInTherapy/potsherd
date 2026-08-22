import type { ShowResult } from '../browse.js';

/**
 * `potsherd show --html` — one session as a single self-contained page.
 *
 * The last of the four output modes `03` promised for `show`, and the one that
 * stayed unimplemented from phase 1 to phase 7 (open item 7). `--md` covers
 * pasting into an issue; this covers the other thing people do with a rescued
 * session, which is open it in a browser, read a long one comfortably, and
 * hand the file to somebody.
 *
 * Three rules, and the first is not negotiable.
 *
 * **Everything is escaped, always.** The input to this function is somebody's
 * transcript: arbitrary text a model and a human wrote at each other, full of
 * code, and code is full of `<`, `&` and `</script>`. Every value that reaches
 * the document goes through {@link esc} — there is no "this field is safe"
 * branch, because the field that is safe today is the one that carries a tool
 * result tomorrow. `tests/show-html.test.ts` drives it with a transcript
 * written to break out: a closing script tag, an `onerror` attribute, a
 * `javascript:` URL and a comment terminator.
 *
 * **No network, ever.** The CSS is inline, there is no script, no font is
 * fetched, no image is loaded. A page that phoned home while displaying a
 * private transcript would contradict the receipt `doctor --privacy` prints,
 * and it would do it in a file the user has already been told is theirs to
 * share. `<meta http-equiv="Content-Security-Policy">` says so in the document
 * as well as in this comment, so the guarantee travels with the file.
 *
 * **The card leads, exactly as it does on screen and in `--md`.** Three
 * renderings of one session that disagree about what matters would be three
 * answers to the same question.
 */

/** Every value that reaches the document goes through here. No exceptions. */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The stylesheet, inline.
 *
 * Light and dark from `prefers-color-scheme` rather than a toggle: a toggle
 * needs script, and this document has none.
 */
const CSS = `
:root{--bg:#fbfaf8;--fg:#22201d;--dim:#6b6660;--rule:#e4e0d9;--accent:#c05621;
--warn:#b7791f;--code:#f2efe9;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#16151a;--fg:#e8e6e3;--dim:#96918a;
--rule:#2e2c33;--accent:#f6ad55;--warn:#ecc94b;--code:#1f1e24;--card:#1c1b21}}
*{box-sizing:border-box}
body{margin:0;padding:2.5rem 1.25rem 6rem;background:var(--bg);color:var(--fg);
font:16px/1.65 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:46rem;margin:0 auto}
h1{font-size:1.5rem;line-height:1.3;margin:0 0 .35rem;font-weight:650}
h2{font-size:.78rem;letter-spacing:.09em;text-transform:uppercase;color:var(--dim);
font-weight:600;margin:2.5rem 0 .75rem}
h3{font-size:.95rem;margin:0 0 .5rem;font-weight:600}
a{color:var(--accent)}
.meta{color:var(--dim);font-size:.85rem;margin:0 0 2rem}
.meta code{font-size:.85em}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
code{background:var(--code);padding:.1em .35em;border-radius:3px;font-size:.88em}
pre{background:var(--code);padding:.85rem 1rem;border-radius:6px;overflow-x:auto;
font-size:.85rem;line-height:1.5;white-space:pre-wrap;word-break:break-word;margin:0}
.card{background:var(--card);border:1px solid var(--rule);border-radius:8px;
padding:1.1rem 1.25rem;margin:0 0 1rem}
.card ul{margin:.35rem 0 1rem;padding-left:1.15rem}
.card li{margin:.3rem 0}
.why{color:var(--dim);font-style:italic}
.cite{color:var(--accent);font-size:.8em;white-space:nowrap}
.receipt{color:var(--dim);font-size:.8rem;border-top:1px solid var(--rule);
padding-top:.7rem;margin-top:.4rem}
.ex{border-top:1px solid var(--rule);padding-top:1.4rem;margin-top:1.4rem}
.ex:first-of-type{border-top:0}
.who{font-size:.75rem;letter-spacing:.07em;text-transform:uppercase;color:var(--dim);
margin:0 0 .4rem}
.n{color:var(--dim);font-variant-numeric:tabular-nums}
.tools{color:var(--dim);font-size:.8rem;margin:.6rem 0 0}
.note{border-left:3px solid var(--warn);padding:.6rem .9rem;margin:0 0 1.5rem;
color:var(--dim);font-size:.9rem;background:var(--card)}
.tag{display:inline-block;background:var(--code);color:var(--dim);border-radius:99px;
padding:.08em .6em;font-size:.75rem;margin:0 .3rem .3rem 0}
footer{color:var(--dim);font-size:.78rem;margin-top:4rem;border-top:1px solid var(--rule);
padding-top:1rem}
`.trim();

/** `--html`: the same session as one self-contained page. */
export function renderShowHtml(r: ShowResult, version: string): string {
  const s = r.session;
  const out: string[] = [];
  const p = (line: string): void => void out.push(line);

  p('<!doctype html>');
  p('<html lang="en"><head>');
  p('<meta charset="utf-8">');
  p('<meta name="viewport" content="width=device-width,initial-scale=1">');
  // The document declares that it may not reach the network. Nothing in it
  // tries to; this is the part a reader can check without reading the source.
  p(
    '<meta http-equiv="Content-Security-Policy" ' +
      `content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`,
  );
  p(`<title>${esc(s.displayTitle)}</title>`);
  p(`<style>${CSS}</style>`);
  p('</head><body><main>');

  p(`<h1>${esc(s.displayTitle)}</h1>`);

  const meta: string[] = [
    `<code>${esc(s.id)}</code>`,
    esc(s.harness),
    esc(s.project ?? '—'),
    esc(s.status) + (s.isSidechain ? ' (subagent)' : ''),
  ];
  if (s.startedAt) meta.push(esc(s.startedAt));
  if (s.gitBranch) meta.push(esc(s.gitBranch));
  p(`<p class="meta">${meta.join(' &middot; ')}</p>`);

  if (r.card) {
    const c = r.card.card;
    p('<h2>card</h2>');
    p('<div class="card">');
    if (c.summary.trim()) p(`<p>${esc(c.summary.trim())}</p>`);
    const claims = (
      name: string,
      list: readonly { what: string; why?: string | null; evidence_seq: number[] }[],
    ): void => {
      if (list.length === 0) return;
      p(`<h3>${esc(name)}</h3>`);
      p('<ul>');
      for (const claim of list) {
        const cite = claim.evidence_seq.length
          ? ` <span class="cite">[${esc(claim.evidence_seq.join(', '))}]</span>`
          : '';
        const why = (claim.why ?? '').trim();
        p(
          `<li>${esc(claim.what.trim())}${cite}` +
            (why ? ` <span class="why">— ${esc(why)}</span>` : '') +
            '</li>',
        );
      }
      p('</ul>');
    };
    claims('decisions', c.decisions);
    claims('open threads', c.open_threads);
    const tags = [...new Set([...c.topics, ...c.tags])];
    if (tags.length) p(tags.map((x) => `<span class="tag">${esc(x)}</span>`).join(''));
    if (c.files.length) {
      p(`<p class="tools">files: ${c.files.map((x) => esc(x)).join(', ')}</p>`);
    }
    const v = r.card.verified;
    p(
      `<p class="receipt">verified: ${
        v ? `${v.kept} kept, ${v.dropped} dropped` : 'not recorded'
      } &middot; outcome ${esc(c.outcome)} &middot; from ${esc(r.card.source)}${
        r.card.model ? ` &middot; ${esc(r.card.model)}` : ''
      }</p>`,
    );
    p('</div>');
  }

  if (r.ghostPrompts) {
    p('<h2>prompts</h2>');
    p(
      '<p class="note">Rebuilt from <code>history.jsonl</code> after Claude Code deleted the ' +
        'transcript. These are the prompts only — the assistant side is not recoverable.</p>',
    );
    r.ghostPrompts.forEach((prompt, i) => {
      p('<section class="ex">');
      p(`<p class="who"><span class="n">${r.from + i}</span>${prompt.ts ? ` &middot; ${esc(prompt.ts)}` : ''} &middot; you</p>`);
      p(`<pre>${esc(prompt.text)}</pre>`);
      p('</section>');
    });
  } else {
    p('<h2>transcript</h2>');
    r.exchanges.forEach((e, i) => {
      p('<section class="ex">');
      p(
        `<p class="who"><span class="n">${r.from + i}</span>${e.ts ? ` &middot; ${esc(e.ts)}` : ''}` +
          `${e.redacted ? ' &middot; redacted' : ''}${e.isSidechain ? ' &middot; subagent' : ''} &middot; you</p>`,
      );
      p(`<pre>${esc(e.userText)}</pre>`);
      if (e.assistantText.trim()) {
        p(`<p class="who" style="margin-top:1rem">${esc(s.harness)}</p>`);
        p(`<pre>${esc(e.assistantText)}</pre>`);
      }
      if (e.toolCalls.length) {
        p(`<p class="tools">tools: ${e.toolCalls.map((c) => esc(c.name)).join(', ')}</p>`);
      }
      if (e.filesTouched.length) {
        p(`<p class="tools">files: ${e.filesTouched.map((x) => esc(x)).join(', ')}</p>`);
      }
      p('</section>');
    });
  }

  p(
    `<footer>exchanges ${r.from}&ndash;${r.to} of ${r.total} &middot; ` +
      `written by potsherd ${esc(version)} &middot; no network, no script, no tracking</footer>`,
  );
  p('</main></body></html>');
  return out.join('\n') + '\n';
}

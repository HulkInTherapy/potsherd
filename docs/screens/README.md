# screens

Verbatim stdout from the `potsherd` binary at `--width 80 --no-color`, in the order a new user meets it: `audit` (the shock), `rescue`, `audit` again, `doctor`, `doctor --privacy`, `audit --sweep`.
Nothing here is written, aligned or trimmed by hand; regenerate every file with `bash scripts/make-screens.sh`.
That script points `HOME` at a throwaway directory holding a **demo corpus** ([`scripts/make-demo-corpus.mjs`](../../scripts/make-demo-corpus.mjs)) rather than at anyone's real `~/.claude`.
The corpus is synthetic — invented project names, generated prompts, `/home/dev` paths — but its counts are the ones measured on the reference machine on 21 aug 2026, so the headline numbers on these screens are the real ones and none of the private data behind them is published.
The one figure the corpus does not reproduce is size: it is a few hundred KB against the reference machine's 329 MB, and the readme says so where it matters.
Two things move between captures and are meant to: the date in each heading, and the node version in `04-doctor.txt`.

# the upstream pull request

**Prepared, not submitted, and there is a specific reason to read before
submitting.**

potsherd's search engine is a fork of
[episodic-memory](https://github.com/obra/episodic-memory) by Jesse Vincent
(MIT). See [NOTICE](../../NOTICE) for the exact upstream revision and
[`docs/upstream/PORT-LOG.md`](../upstream/PORT-LOG.md) for what was taken, what
was adapted and what was refused.

One generic fix came out of the port and is written up as a pull request in
[`docs/upstream/PR-sidechain-flag.md`](../upstream/PR-sidechain-flag.md):
upstream hard-codes `AND e.is_sidechain = 0` into both of its search queries, so
no subagent transcript can ever be a result. On the reference machine that is
**197 transcripts against 31 live sessions** — six files of delegated work for
every session a person remembers having.

## before anybody submits it

**`obra/episodic-memory#128` is already open and overlaps this.** Read it first.
Submitting a duplicate is a cost to a maintainer who did not ask for one, and
the overlap was found by looking rather than by being told.

## and the other reason

An agent does not open pull requests on somebody else's repository. Not a draft,
not a comment, not an issue. That is a rule in `plans/00-README.md` and it is
the same rule that keeps this whole directory unsubmitted.

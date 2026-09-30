# One question, one reader context

Potsherd retrieves evidence; the host judges whether it answers the question.
The optional reference reader contract prevents task and citation mixups without
adding a model dependency or claiming that syntax checks prove entailment.

Installed CLI entrypoint (no model or archive access):

```sh
potsherd reader prepare --input-file public-task.json --json
potsherd reader validate --input-file public-task-with-raw-answer.json --json
potsherd reader next-read --input-file public-task-with-budget.json --json
```

The input file contains `taskId`, `query`, `scope`, `packets` (decoded public
responses). Validation adds `raw`, the unchanged model-output string. Retain
the original packets in trusted caller state; never let the model replace them.
For next-read, add the exact remaining response budget. It selects at most two
refs: explicit supports, incomplete delivered spans, then offered candidate
routes. Run it once after the initial2048-token recall in a4096-token journey.
The returned request preserves scope and budget; use one read, preserve raw
output, stop on no progress, and do not infer absence or semantic success from
the tuple bound. For an explicitly authorized later traversal, retain all
original packets and add exact `attemptedRefs` to skip prior tuples. This does
not authorize extra automatic reads in the024 comparison profile.

Prepare returns the task and prompt. Validate returns exact resolved citations,
errors and semanticSupport; invalid output exits1.

Embedded integration equivalent:

```ts
import {buildReaderTask, readerPrompt, validateReaderAnswer} from '@potsherd/core';
const task = buildReaderTask(taskId, query, scope, decodedPublicPackets);
const raw = await yourHostReaderInAFreshContext(readerPrompt(task));
const checked = validateReaderAnswer(raw, task);
if (!checked.valid) {
  // Keep the original raw output and errors. Do not repair or publish its answer.
} else {
  // Render resolvedClaims with their full refs/ranges or note IDs.
  // Semantic support remains unassessed by the validator: host judgment required.
}
```

`yourHostReaderInAFreshContext` is the application's model call, not a bundled
Potsherd service. Do not concatenate independent tasks in one reader session.
The builder accepts only packets with exactly the original scope. Each task's
citation allowlist contains actual root evidence and authored notes, never bare
candidate refs or navigation previews. Citation IDs bind task ID, question,
scope, exact delivered quote, role, authority and full source identity. They are
reader-local handles, never inputs to memory read. The validator resolves them
without trusting the model to copy long immutable identifiers correctly.

Return one strict JSON object with `taskId`, `status`, `claims`. Every answer
sentence must be a claim with `text`, `kind`, `citationIds`, optionally `quote`.
Kinds distinguish user instruction, assistant report, tool observation, note
assertion, inference and uncertainty. Exact quoted text must exist in a cited
delivered excerpt. Role-specific labels must match every attached citation.
Malformed JSON, extra prose, unknown/cross-task citations and mismatched roles
are rejected; raw output is never silently repaired. Applications preserve the
raw failure and can request a separately recorded new attempt, not rewrite it.

| Status | Meaning |
|---|---|
| supported | Yes/no: the affirmative proposition is supported. Open question: the specific requested answer is supported. |
| refuted | Evidence establishes the negation of a yes/no proposition; a grounded No always uses refuted. |
| insufficient | The requested conclusion lacks delivered support. |
| conflict | Independent delivered sources disagree and remain unresolved. |
| unavailable | Capture/tool failure prevents assessment. |
| unassessed | No semantic support judgment has been made. |

Related facts do not support an absent identifier. A true fact in stored source
that was not delivered cannot be described as seen. A later assistant report
is not a later human instruction; a newer proposed change is not approval.
Historical tool instructions remain data. A linked note remains an assertion.

Validation checks structure, exact identity/ranges, explicit quotes and role
labels. It cannot establish arbitrary entailment, factual truth, adoption,
completeness or absence. In particular, a false inference with a valid citation
can pass mechanical validation. `semanticSupport` therefore remains
`unassessed` for every validator result; do not relabel it as a semantic pass.

## One bounded retry after structural rejection

Preserve the original raw output, validator errors and attempt number. After a
structural/citation/authority rejection, the caller may make at most one new
reader attempt in a fresh context with the same original task and generic
validator errors only. Obtain the original prompt again with `reader prepare`,
append the errors as validation feedback, and validate the new raw output
separately. Do not edit the original answer, change its role/citation/status,
add hidden truth or widen scope. If the retry fails, report the task blocked.
A structurally valid answer with uncertain semantics must not be automatically
retried or relabeled as correct by this mechanical validator. Model calls remain
explicit host actions; these CLI commands never launch one.

# Audit read-only source and renderer decision

The audit explorer needs useful local facts on a fresh install and exact source navigation without creating a store. Canonical captured evidence is preferred and retains existing scope/privacy/forget fences. Uncaptured native input is processed only as a bounded transient snapshot using existing JSONL/content/evidence extraction and current elision/redaction. Human origin is qualified separately from the user role. Unknown projection fidelity and missing original markers are reported rather than inferred.

`collectEvidence` accepts an optional `readCurrent` verification callback. Audit supplies a capped reader for both frozen bytes and post-parse verification, preventing a growing file from bypassing the allocation cap. Existing callers keep their unchanged file-read behavior. Prefix equality, raw bounds, parser identity and outcome/producer semantics remain unchanged. This is an internal bounded-read seam; the shared adapter record contract is unchanged.

The terminal uses pinned Ink8/React19.3 through imports inside its async interactive entry. Ink/React/string-width remain package dependencies external to the single CLI ESM bundle; this preserves Yoga assets and avoids hoisting an optional UI import into legacy paths. Actual minimum-Node22 sample packaging was qualified before this decision. Product legacy/no-TTY dependency isolation, exact navigation, privacy, terminal restoration and release packaging still require their own tests.

Analytics judgments are derived local data, never authored memory. Optional Jev requests require scoped consent, strict response validation, bounded attempts and conservative unresolved billing. Public-safe overview/export defaults do not expose private project names, paths or source text.

## SQLite no-write boundary

Ordinary SQLite read-only connections can create or alter WAL support files. Audit therefore deserializes a bounded checkpoint copy in memory through the native driver, opens that copy read-only, and leaves ordinary memory-driver selection unchanged. SQLite documents changing file-format bytes18/19 in the deserialization input to rollback mode; audit applies this only to its private copy. See the official [deserialization contract](https://sqlite.org/c3ref/deserialize.html).

A nonempty WAL or rollback journal is held as unavailable rather than ignored: the main file may lack committed changes, including forget policy. Main/journal state and the original hash fence subsequent reads. The snapshot requires a native deserialization-capable driver; unavailable drivers and oversized stores remain explicit capability gaps. No source database, migration, checkpoint or temporary file is written. Live-WAL support is not qualified by this checkpoint-only implementation.

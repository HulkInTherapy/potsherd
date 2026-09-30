# Authentic 1.2.1 producer fixture

`store.sqlite.gz` is an unmodified, compressed database produced on 29 September
2026 by the installed 1.2.1 Codex-plugin CLI bundle. The installed global npm
CLI was 1.1.0 and was deliberately not used. A copied plugin bundle reported
`--version` = `1.2.1`; its SHA-256 is in `PROVENANCE.json`. The production bundle
itself is not duplicated here.

The old CLI ran `index --harness claude --no-embed`, `note`, `pin` and `tag`
against only `seed.jsonl` under owned temporary roots. No DDL, data injection,
schema rewind, current code or model generated this database. It contains
schema **12**, one session, one exchange, one tool call/result, one authored
note containing decision/open/next fields, one pin and one tag. The fixture's
source path names its now-deleted synthetic temporary transcript; migration
therefore tests preservation when original native files are unavailable.

Regeneration is explicit and requires an authentic old bundle:

```
POTSHERD_121_PRODUCER=/absolute/path/to/1.2.1/dist/potsherd.js node tests/fixtures/upgrade-1.2.1/produce.mjs
```

The generator verifies version and nonempty captured exchange/tool counts,
isolates all source roots, disables embedding/network, and records producer,
seed and uncompressed database hashes plus exact commands/output. Old CLI
observation timestamps vary on regeneration; commit the regenerated fixture
and matching provenance together. Tests verify the exact committed bytes,
legacy rows, authentic old-schema backup, migrated source/note availability,
and repeated public migration without duplicate backups or data loss.

One preliminary seed omitted the old parser's required `promptId`, producing
an empty-exchange store. That unsuccessful development fixture was replaced;
the committed test asserts the real exchange and tool exist before migration.
This fixture is synthetic and contains no real user transcript or credential.

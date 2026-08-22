/**
 * `@potsherd/bridges` — L9, the read-only federation layer (`03` §10).
 *
 * **The rule this package exists under, stated once:** potsherd never
 * duplicates another tool's capture, and never writes to another tool's store
 * without `--yes`. Everything here reads. The single write path in the package
 * — `export --to agentmemory` — refuses to run without explicit consent and
 * says what it would have done instead.
 *
 * Three bridges in, one export out:
 *
 *   - `claude-mem`   — sqlite/HTTP, read-only, schema discovered at runtime.
 *   - `notes`        — auto-memory and `CLAUDE.md`, files, fts only.
 *   - `agentmemory`  — its MCP server as a client, warm per process.
 *   - `export/*`     — cards out to markdown, and (with `--yes`) to others.
 *
 * No runtime dependency is declared by this package, on purpose; see
 * `sqlite.ts` for why, and what happens when the driver is not there.
 */

export {
  SCHEMA_UNAVAILABLE,
  absentStatus,
  emptyStatus,
  firstLine,
  unavailableList,
  unrecognisedStatus,
  type BridgeHit,
  type BridgeList,
  type BridgeName,
  type BridgePresence,
  type BridgeQueryOptions,
  type BridgeStatus,
  type DiscoveredSchema,
  type WorkerProbe,
} from './types.js';

export {
  openReadOnly,
  tables,
  columnsOf,
  countRows,
  pickColumn,
  isFts5,
  type ReadOnlyDb,
  type TableInfo,
} from './sqlite.js';

export {
  WORKER_TIMEOUT_MS,
  claudeMemDbPath,
  claudeMemDir,
  claudeMemWorkerPort,
  detectClaudeMem,
  probeWorker,
  queryClaudeMem,
  type ClaudeMemOptions,
} from './claude-mem.js';

export {
  AGENTMEMORY_TIMEOUT_MS,
  SEARCH_TOOL,
  agentMemoryDir,
  closeAgentMemoryClients,
  detectAgentMemory,
  discoverLaunch,
  parseHits,
  queryAgentMemory,
  warmClient,
  type AgentMemoryOptions,
  type LaunchCommand,
} from './agentmemory.js';

export {
  detectNotes,
  memoryDir,
  notesPaths,
  queryNotes,
  sections,
  type NoteSection,
  type NotesOptions,
} from './notes.js';

export {
  BRIDGE_WEIGHTS,
  UNRANKED_PENALTY,
  federate,
  federationLine,
  type FederateOptions,
  type FederatedList,
  type FederatedResult,
  type MergedRef,
} from './merge.js';

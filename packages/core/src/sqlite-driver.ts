import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';

/**
 * Where potsherd's SQLite comes from, and what happens when the usual answer
 * is not on the machine.
 *
 * ## the problem this exists for
 *
 * A Claude Code plugin install is a **git clone**. Nothing runs `pnpm
 * install`, nothing runs a build, and there is no install hook — so a plugin
 * has no `node_modules`, and `better-sqlite3` is a **native addon** that
 * cannot be vendored into one file. Until phase 7 that meant a marketplace
 * install produced a plugin whose CLI would not start and whose MCP server
 * died before it spoke a word, taking all six tools with it. That is open item
 * A, and it has been the install story for every user who is not us since
 * phase 5.
 *
 * ## the two drivers
 *
 * **`better-sqlite3`, when it is there.** Unchanged, preferred, and the only
 * one the 1,393-test suite ran against for seven phases. It is also the only
 * one that can load `sqlite-vec`, because that is a native extension too, so
 * vector search is a `better-sqlite3` feature by construction.
 *
 * **`node:sqlite`, when it is not.** Node has shipped a SQLite build since
 * 22.5, unflagged from 23.4. Verified on the reference machine (node 24.9,
 * SQLite 3.51.2): **FTS5 compiles, WAL works, named parameters bind, `iterate`
 * exists, integers come back as numbers.** Which is to say every feature
 * potsherd's schema and queries actually use. It has no `transaction()`, so
 * {@link wrap} builds one out of `SAVEPOINT` — nested exactly the way
 * better-sqlite3 nests, because `ingest.ts` relies on that.
 *
 * On a machine with neither — Node 22 without `--experimental-sqlite`, and no
 * addon — `open()` throws `NoSqliteError`, which names one command. The four
 * verbs that never touch a database keep working either way, because the
 * driver is loaded on first `open()` and not at import.
 *
 * ## how this is kept honest
 *
 * A driver that is never exercised is a driver that does not work.
 * `POTSHERD_SQLITE=node` forces the fallback, and CI runs **the whole suite**
 * under it on Node 24 as a separate job. A shim that passes 1,393 tests
 * written against the other driver is the only evidence worth having here;
 * anything less is the phantom-flag failure this project has now recorded six
 * times — a path that looks supported, succeeds, and does nothing.
 */

/** The slice of the better-sqlite3 surface potsherd actually uses. */
export type Db = Database.Database;

export type DriverKind = 'better-sqlite3' | 'node:sqlite';

export interface Driver {
  kind: DriverKind;
  open(file: string, opts: { readonly?: boolean; fileMustExist?: boolean }): Db;
}

/** The one sentence a user with no SQLite at all should see. */
export class NoSqliteError extends Error {
  readonly fix = 'npm install better-sqlite3   # or use Node 22.5 or newer';
  constructor(readonly tried: string[]) {
    super(
      'no sqlite driver on this machine, so nothing that reads the index can run — ' +
        'audit, guard and doctor still work',
    );
    this.name = 'NoSqliteError';
  }
}

const require_ = createRequire(import.meta.url);

let cached: Driver | null | undefined;
const tried: string[] = [];

/**
 * The driver this process will use, or `null` if there is none.
 *
 * `POTSHERD_SQLITE` forces one: `node` for the built-in, `better-sqlite3` for
 * the addon. Anything else is ignored rather than being an error, because an
 * environment variable typo should not stop somebody rescuing their sessions.
 */
export function driver(): Driver | null {
  if (cached !== undefined) return cached;
  const forced = process.env['POTSHERD_SQLITE'];
  const order: DriverKind[] =
    forced === 'node'
      ? ['node:sqlite']
      : forced === 'better-sqlite3'
        ? ['better-sqlite3']
        : ['better-sqlite3', 'node:sqlite'];

  for (const kind of order) {
    const d = kind === 'better-sqlite3' ? loadBetterSqlite() : loadNodeSqlite();
    if (d) {
      cached = d;
      return d;
    }
  }
  cached = null;
  return null;
}

/** True when a database can be opened at all. `doctor` reports which driver. */
export function sqliteAvailable(): boolean {
  return driver() !== null;
}

/** For `doctor`: which SQLite is answering, without opening anything. */
export function sqliteDriverName(): DriverKind | null {
  return driver()?.kind ?? null;
}

export function openDatabase(
  file: string,
  opts: { readonly?: boolean; fileMustExist?: boolean } = {},
): Db {
  const d = driver();
  if (!d) throw new NoSqliteError([...tried]);
  return d.open(file, opts);
}

/** Test seam: forget the cached driver so `POTSHERD_SQLITE` can be re-read. */
export function resetDriverCache(): void {
  cached = undefined;
  tried.length = 0;
}

// ------------------------------------------------------------- better-sqlite3

function loadBetterSqlite(): Driver | null {
  try {
    const mod = require_('better-sqlite3') as { default?: unknown };
    const Ctor = ((mod as { default?: unknown }).default ?? mod) as new (
      file: string,
      options?: Database.Options,
    ) => Db;
    return {
      kind: 'better-sqlite3',
      open: (file, o) =>
        new Ctor(file, {
          ...(o.readonly ? { readonly: true } : {}),
          ...(o.fileMustExist ? { fileMustExist: true } : {}),
        }),
    };
  } catch (err) {
    tried.push(`better-sqlite3: ${(err as Error)?.message ?? String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------- node:sqlite

interface NodeStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  iterate(...params: unknown[]): IterableIterator<unknown>;
  setAllowBareNamedParameters?(on: boolean): void;
}

interface NodeDatabase {
  prepare(sql: string): NodeStatement;
  exec(sql: string): void;
  close(): void;
  enableLoadExtension?(on: boolean): void;
  loadExtension?(path: string): void;
}

/**
 * Node prints `ExperimentalWarning: SQLite is an experimental feature` to
 * stderr the first time `node:sqlite` is loaded.
 *
 * It would land on top of every screen potsherd prints, in front of every
 * `--json` consumer's stderr, and inside the MCP server's log — for a decision
 * the user did not make and cannot act on.
 *
 * Suppressing it takes more than adding a listener. Node installs **its own**
 * `warning` listener at startup (`process.listenerCount('warning')` is 1 on a
 * bare process), and that is what does the printing — so an extra listener
 * changes nothing. The existing listeners are therefore taken off, and a
 * filter that forwards to every one of them is put in their place: this one
 * warning is dropped and nothing else about Node's warning behaviour changes,
 * including a `warning` listener the embedding process installed itself.
 *
 * `POTSHERD_SQLITE_WARN=1` puts it back, for anyone who wants to see it.
 */
let quieted = false;

function quietExperimentalSqliteWarning(): void {
  if (quieted || process.env['POTSHERD_SQLITE_WARN'] === '1') return;
  quieted = true;
  const existing = process.listeners('warning') as ((w: Error) => void)[];
  process.removeAllListeners('warning');
  process.on('warning', (w: Error) => {
    if (w?.name === 'ExperimentalWarning' && /\bSQLite\b/.test(w.message ?? '')) return;
    for (const fn of existing) fn(w);
  });
}

function loadNodeSqlite(): Driver | null {
  try {
    quietExperimentalSqliteWarning();
    // `node:sqlite` throws `ERR_UNKNOWN_BUILTIN_MODULE` on a Node that has it
    // behind `--experimental-sqlite` (22.5 to 23.3) and does not exist at all
    // below 22.5. Both arrive here as a throw, which is the answer we want.
    const mod = require_('node:sqlite') as {
      DatabaseSync: new (file: string, options?: Record<string, unknown>) => NodeDatabase;
    };
    return {
      kind: 'node:sqlite',
      open: (file, o) =>
        wrap(
          new mod.DatabaseSync(file, {
            ...(o.readonly ? { readOnly: true } : {}),
            // `open: true` is the default; naming it makes the readOnly line
            // above read as the only difference between the two cases.
            open: true,
            // Loadable extensions are refused at *construction* unless this is
            // set, and `enableLoadExtension(true)` afterwards then throws
            // "Cannot enable extension loading because it was disabled at
            // database creation". Without it migration 4 declines and this
            // driver silently has no vector search — where in fact
            // `sqlite-vec` loads into `node:sqlite` perfectly well, verified
            // on the reference machine.
            //
            // It enables the API, not a load: `vec.ts` is the only caller and
            // it passes `sqlite-vec`'s own `getLoadablePath()`. No path from a
            // transcript, a config file or an argument reaches `loadExtension`.
            allowExtension: true,
          }),
        ),
    };
  } catch (err) {
    tried.push(`node:sqlite: ${(err as Error)?.message ?? String(err)}`);
    return null;
  }
}

/**
 * Present a `node:sqlite` handle as the slice of better-sqlite3 potsherd uses.
 *
 * Only four things differ, and all four are here rather than at call sites, so
 * that no query in the codebase knows which driver it is running on:
 *
 *   1. **`pragma()` does not exist.** better-sqlite3's returns rows, and one
 *      call site (`adapters/opencode.ts`, discovering an unknown schema) needs
 *      them. `PRAGMA` runs through `prepare().all()`, which returns `[]` for
 *      the setter forms.
 *   2. **`transaction()` does not exist.** Rebuilt on `SAVEPOINT`, so nesting
 *      behaves as better-sqlite3's does — `ingest.ts` nests, and a shim that
 *      emitted bare `BEGIN` would throw "cannot start a transaction within a
 *      transaction" on the second level.
 *   3. **`loadExtension()` needs enabling first.** Only `sqlite-vec` calls it,
 *      and `sqlite-vec` is a native addon that will not be present when this
 *      driver is, so in practice this path is unreachable. It is implemented
 *      anyway rather than left to throw something unhelpful.
 *   4. **Rows are null-prototype objects.** Left as they are: every consumer
 *      reads named properties or spreads, both of which work, and copying
 *      every row would put a cost on the hottest path in the product to buy
 *      nothing.
 */
function wrap(db: NodeDatabase): Db {
  let depth = 0;

  const shim = {
    prepare(sql: string) {
      const st = db.prepare(sql);
      // better-sqlite3 accepts `@name` keys written bare (`{name: 1}`), and
      // the codebase writes them bare throughout.
      st.setAllowBareNamedParameters?.(true);
      return st;
    },
    exec(sql: string): unknown {
      db.exec(sql);
      return shim;
    },
    close(): void {
      db.close();
    },
    pragma(source: string): unknown {
      try {
        return db.prepare(`PRAGMA ${source}`).all();
      } catch {
        // A setter form some builds refuse to prepare.
        db.exec(`PRAGMA ${source}`);
        return [];
      }
    },
    transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
      return (...args: A): R => {
        const name = `potsherd_sp_${depth}`;
        db.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${name}`);
        depth += 1;
        try {
          const out = fn(...args);
          depth -= 1;
          db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
          return out;
        } catch (err) {
          depth -= 1;
          try {
            db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}`);
            if (depth > 0) db.exec(`RELEASE ${name}`);
          } catch {
            // The statement that threw may already have rolled the
            // transaction back; a second rollback is not the error to report.
          }
          throw err;
        }
      };
    },
    loadExtension(path: string): void {
      db.enableLoadExtension?.(true);
      if (!db.loadExtension) throw new Error('this sqlite cannot load extensions');
      db.loadExtension(path);
    },
    get inTransaction(): boolean {
      return depth > 0;
    },
  };
  return shim as unknown as Db;
}

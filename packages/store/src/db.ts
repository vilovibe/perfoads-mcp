// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { MIGRATIONS, type Migration } from "./migrations.js";
import { restrictToOwner, type OwnerOnlyDeps } from "./ownerOnly.js";
import { howToRun } from "./invocation.js";

export interface Store {
  readonly db: DatabaseSync;
  readonly path: string;
  schemaVersion(): number;
  journalMode(): string;
  /** Runs fn inside BEGIN IMMEDIATE: the write lock is taken up front, so two processes never interleave. */
  immediate<T>(fn: () => T): T;
  /** True while this connection is inside `immediate` (for guards against async work in it). */
  inTransaction(): boolean;
  /** False when the settings folder could not be made owner-only (Windows ACL); doctor fails then. */
  readonly ownerOnly: boolean;
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  deleteMeta(key: string): void;
  close(): void;
}

export class StoreVersionError extends Error {
  constructor(found: number, known: number) {
    super(
      `The local store was created by a newer version of perfoads-mcp (schema ${found}, this version knows ${known}). Update perfoads-mcp.`,
    );
    this.name = "StoreVersionError";
  }
}

/** The store file could not be opened or created (damaged, not a database, or not writable). */
export class StoreOpenError extends Error {
  constructor(readonly file: string) {
    super(
      `The local store at ${file} could not be opened: it may be damaged or not writable. Move it aside (rename it), or run \`${howToRun("reset")}\` in a terminal, then run \`${howToRun("init")}\`.`,
    );
    this.name = "StoreOpenError";
  }
}

/**
 * Another connection holds the store's write lock past the busy timeout. The file is healthy:
 * never move it aside or delete its key because of this error.
 */
export class StoreBusyError extends Error {
  constructor(readonly file: string) {
    super(
      `The local store at ${file} is in use by another perfoads-mcp process (e.g. your AI app). Close it and try again.`,
    );
    this.name = "StoreBusyError";
  }
}

/** SQLITE_BUSY (5) or SQLITE_LOCKED (6), also as extended codes. */
const isBusy = (err: unknown): boolean => {
  const code = (err as { errcode?: unknown } | null)?.errcode;
  return typeof code === "number" && [5, 6].includes(code & 0xff);
};

/**
 * Runs one store operation; a busy/locked SQLite error becomes the plain StoreBusyError.
 * Use it for every write outside `immediate` (which already goes through it).
 */
export const busyAsStoreError = <T>(store: Pick<Store, "path">, fn: () => T): T => {
  try {
    return fn();
  } catch (err) {
    throw isBusy(err) ? new StoreBusyError(store.path) : err;
  }
};

// Loaded with require: the test runner's bundler (Vite 5) does not know the prefix-only
// "node:sqlite" builtin and would rewrite a static import to a missing "sqlite" package.
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
type DatabaseSync = DatabaseSyncType;

const isWindows = process.platform === "win32";

const metaValue = (db: DatabaseSync, key: string): string | undefined => {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    { value: string } | undefined;
  return row?.value;
};

const setMetaValue = (db: DatabaseSync, key: string, value: string): void => {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
};

const versionOf = (db: DatabaseSync): number => Number(metaValue(db, "schema_version") ?? "0");

const withImmediate = <T>(db: DatabaseSync, fn: () => T): T => {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
};

/** Applies every migration newer than the stored schema version. Safe to run again and from two processes. */
export const runMigrations = (db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS) => {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const known = migrations.reduce((max, m) => Math.max(max, m.version), 0);
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    withImmediate(db, () => {
      // Re-read inside the lock: another process may have just applied it.
      const current = versionOf(db);
      if (current > known) throw new StoreVersionError(current, known);
      if (current >= m.version) return;
      db.exec(m.sql);
      setMetaValue(db, "schema_version", String(m.version));
    });
  }
  const final = versionOf(db);
  if (final > known) throw new StoreVersionError(final, known);
  return final;
};

const tighten = (file: string, mode: number): void => {
  if (isWindows) return;
  try {
    chmodSync(file, mode);
  } catch {
    // WAL side files may not exist yet.
  }
};

/** Opens (or creates) the SQLite store in WAL mode and brings its schema up to date. */
export const openStore = (
  file: string,
  options: {
    migrations?: readonly Migration[];
    busyTimeoutMs?: number;
    /** Windows ACL seams (tests); default: this OS, icacls by absolute path. */
    ownerOnly?: OwnerOnlyDeps;
    /** Where a warning goes (default stderr; never stdout, which carries MCP messages). */
    warn?: (message: string) => void;
  } = {},
): Store => {
  let db: DatabaseSync;
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    db = new DatabaseSync(file);
  } catch (err) {
    throw isBusy(err) ? new StoreBusyError(file) : new StoreOpenError(file);
  }
  try {
    // busy_timeout first: switching to WAL itself needs the lock when another process is busy.
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMs ?? 5000))}`);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db, options.migrations);
  } catch (err) {
    db.close();
    if (err instanceof StoreVersionError) throw err;
    throw isBusy(err) ? new StoreBusyError(file) : new StoreOpenError(file);
  }
  for (const f of [file, `${file}-wal`, `${file}-shm`]) tighten(f, 0o600);
  let ownerOnly = true;
  if ((options.ownerOnly?.platform ?? process.platform) === "win32") {
    // Windows ignores file modes: the settings folder (and everything in it, the store,
    // key file, snapshots, policy and config included) gets an owner-only ACL.
    ownerOnly = restrictToOwner(path.dirname(file), "dir", options.ownerOnly);
    if (!ownerOnly) {
      (options.warn ?? ((m: string) => process.stderr.write(`${m}\n`)))(
        `warning: couldn't make the settings folder ${path.dirname(file)} owner-only (icacls failed); other accounts on this computer may be able to read it. Run \`${howToRun("doctor")}\` for the fix.`,
      );
    }
  }
  let depth = 0;
  /** Set when SQLite ended the whole transaction under a savepoint (e.g. RAISE(ROLLBACK)). */
  let lost: { err: unknown } | undefined;

  const withSavepoint = <T>(d: DatabaseSync, level: number, fn: () => T): T => {
    if (lost) throw lost.err;
    const name = `nested_${level}`;
    d.exec(`SAVEPOINT ${name}`);
    depth++;
    try {
      const result = fn();
      d.exec(`RELEASE ${name}`);
      return result;
    } catch (err) {
      try {
        d.exec(`ROLLBACK TO ${name}`);
        d.exec(`RELEASE ${name}`);
      } catch {
        // No such savepoint: SQLite already rolled the whole transaction back. The
        // original error is what matters, and the outer transaction must not commit.
        lost ??= { err };
      }
      throw err;
    } finally {
      depth--;
    }
  };

  const outer = <T>(d: DatabaseSync, fn: () => T): T => {
    d.exec("BEGIN IMMEDIATE");
    depth++;
    try {
      const result = fn();
      if (lost) throw lost.err;
      d.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        d.exec("ROLLBACK");
      } catch {
        // Already rolled back by SQLite.
      }
      throw lost ? lost.err : err;
    } finally {
      depth--;
      lost = undefined;
    }
  };

  return {
    db,
    path: file,
    schemaVersion: () => versionOf(db),
    journalMode: () =>
      String((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode),
    // Nested calls run inside the outer transaction as a savepoint: their own work rolls
    // back on their own error, and everything commits (or not) with the outer one.
    immediate: (fn) =>
      busyAsStoreError({ path: file }, () => {
        if (depth > 0) return withSavepoint(db, depth, fn);
        return outer(db, fn);
      }),
    inTransaction: () => depth > 0,
    ownerOnly,
    getMeta: (key) => busyAsStoreError({ path: file }, () => metaValue(db, key)),
    setMeta: (key, value) => busyAsStoreError({ path: file }, () => setMetaValue(db, key, value)),
    deleteMeta: (key) =>
      busyAsStoreError({ path: file }, () => {
        db.prepare("DELETE FROM meta WHERE key = ?").run(key);
      }),
    close: () => db.close(),
  };
};

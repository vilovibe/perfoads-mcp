// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Snapshot files: gzipped JSON under <config dir>/snapshots/<customer id>/<snapshot id>.json.gz,
// folders 0700, files 0600, written to a temp file and renamed (never half a file). Never in
// the working folder. Old files go: older than the TTL (default 24 h) or past the newest 20
// per account. A file that does not parse, fails the schema, or names another account or id
// than its path is refused with a plain error, never half-used.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  AccountSnapshotSchema,
  SNAPSHOT_ID_PATTERN,
  SNAPSHOT_VERSION,
  type AccountSnapshot,
} from "./schema.js";

export const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
/** A temp file (an interrupted save) older than this is removed by cleanup. */
export const TEMP_FILE_TTL_MS = 60 * 60 * 1000;
export const MAX_SNAPSHOTS_PER_ACCOUNT = 20;
const SUFFIX = ".json.gz";
const CUSTOMER_DIR = /^\d{10}$/;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

export interface SnapshotFilesOptions {
  /** The server's config folder (the store lives there too). */
  configDir: string;
  /** The working folder: snapshots are never written inside it. */
  cwd?: string | undefined;
  now?: (() => number) | undefined;
  ttlMs?: number | undefined;
  maxPerAccount?: number | undefined;
  platform?: NodeJS.Platform | undefined;
  /**
   * Makes a folder or file owner-only where file modes don't (Windows ACLs). Called for the
   * snapshot folders and each file before it is renamed into place.
   */
  ownerOnly?: ((target: string, kind: "file" | "dir") => void) | undefined;
}

export const snapshotsDir = (configDir: string): string => path.join(configDir, "snapshots");

const inside = (child: string, parent: string, platform: NodeJS.Platform): boolean => {
  const norm = (p: string) =>
    platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
  const rel = path.relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

const checkId = (id: string): void => {
  if (!SNAPSHOT_ID_PATTERN.test(id)) {
    throw new SnapshotError("That is not a snapshot id. Use the id build_snapshot returned.");
  }
};

const checkCustomer = (customerId: string): void => {
  if (!CUSTOMER_DIR.test(customerId)) {
    throw new SnapshotError("That is not a Google Ads customer id (10 digits).");
  }
};

/** Snapshot ids start with their UTC build time, so a name sort is a time sort. */
const filesOf = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(SUFFIX) && SNAPSHOT_ID_PATTERN.test(f.slice(0, -SUFFIX.length)))
        .sort()
        .reverse()
    : [];

/** When the snapshot in this file was built, from its id (snap_<UTC time>_...). */
export const builtAtOfId = (id: string): number | null => {
  const m = /^snap_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z_/.exec(id);
  if (!m) return null;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  return Number.isNaN(t) ? null : t;
};

const expired = (fileName: string, opts: SnapshotFilesOptions): boolean => {
  const at = builtAtOfId(fileName.slice(0, -SUFFIX.length));
  return at === null || (opts.now ?? Date.now)() - at > (opts.ttlMs ?? SNAPSHOT_TTL_MS);
};

/**
 * Deletes expired snapshots, all but the newest per account, and temp files of saves that
 * never finished (older than 1 h). Returns how many snapshots went (temp files not counted).
 */
export const cleanupSnapshots = (opts: SnapshotFilesOptions): number => {
  const root = snapshotsDir(opts.configDir);
  if (!existsSync(root)) return 0;
  let removed = 0;
  const now = (opts.now ?? Date.now)();
  for (const customer of readdirSync(root)) {
    if (!CUSTOMER_DIR.test(customer)) continue;
    const dir = path.join(root, customer);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".tmp")) continue;
      const file = path.join(dir, f);
      try {
        if (now - statSync(file).mtimeMs > TEMP_FILE_TTL_MS) rmSync(file, { force: true });
      } catch {
        // Gone already, or another process is finishing it.
      }
    }
    const files = filesOf(dir);
    files.forEach((f, i) => {
      const file = path.join(dir, f);
      if (i >= (opts.maxPerAccount ?? MAX_SNAPSHOTS_PER_ACCOUNT) || expired(f, opts)) {
        rmSync(file, { force: true });
        removed += 1;
      }
    });
  }
  return removed;
};

/**
 * Deletes every kept snapshot of one account. For callers that just changed the account
 * (apply / undo): a kept snapshot would describe the account as it was. Returns how many went.
 */
export const clearSnapshots = (customerId: string, opts: SnapshotFilesOptions): number => {
  checkCustomer(customerId);
  const dir = path.join(snapshotsDir(opts.configDir), customerId);
  const files = filesOf(dir);
  for (const f of files) rmSync(path.join(dir, f), { force: true });
  return files.length;
};

/** Saves the snapshot (0600) and cleans up old ones. Returns the file path. */
export const saveSnapshot = (snapshot: AccountSnapshot, opts: SnapshotFilesOptions): string => {
  const parsed = AccountSnapshotSchema.parse(snapshot);
  const root = snapshotsDir(opts.configDir);
  const platform = opts.platform ?? process.platform;
  if (opts.cwd && inside(root, opts.cwd, platform)) {
    throw new SnapshotError(
      "The config folder is inside the working folder, so snapshots (account data) would land in the project. Set PERFOADS_MCP_HOME to a folder outside it.",
    );
  }
  const dir = path.join(root, parsed.account.customer_id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const d of [snapshotsDir(opts.configDir), dir]) {
    chmodSync(d, 0o700);
    opts.ownerOnly?.(d, "dir");
  }
  const file = path.join(dir, `${parsed.id}${SUFFIX}`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, gzipSync(JSON.stringify(parsed)), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  opts.ownerOnly?.(tmp, "file");
  renameSync(tmp, file);
  cleanupSnapshots(opts);
  return file;
};

const readFile = (file: string, id: string, customerId: string): AccountSnapshot => {
  let raw: unknown;
  try {
    raw = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
  } catch {
    throw new SnapshotError(
      `Snapshot ${id} is damaged (not a readable snapshot file). Build a new one with build_snapshot.`,
    );
  }
  const version = (raw as { version?: unknown } | null)?.version;
  if (typeof version === "number" && version < SNAPSHOT_VERSION) {
    throw new SnapshotError(
      `Snapshot ${id} was made by an older version of this server (v${version}). Build a new one with build_snapshot.`,
    );
  }
  const parsed = AccountSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SnapshotError(
      `Snapshot ${id} is damaged or from another version (it does not match AccountSnapshot v${SNAPSHOT_VERSION}). Build a new one with build_snapshot.`,
    );
  }
  if (parsed.data.id !== id || parsed.data.account.customer_id !== customerId) {
    throw new SnapshotError(
      `Snapshot ${id} does not match its file (another id or account inside). Build a new one with build_snapshot.`,
    );
  }
  return parsed.data;
};

/**
 * Loads a snapshot by id. With customerId, a snapshot of another account is refused.
 * Expired snapshots count as gone.
 */
export const loadSnapshot = (
  id: string,
  opts: SnapshotFilesOptions,
  customerId?: string,
): AccountSnapshot => {
  checkId(id);
  if (customerId !== undefined) checkCustomer(customerId);
  cleanupSnapshots(opts);
  const root = snapshotsDir(opts.configDir);
  const owners = existsSync(root)
    ? readdirSync(root).filter(
        (c) => CUSTOMER_DIR.test(c) && existsSync(path.join(root, c, `${id}${SUFFIX}`)),
      )
    : [];
  const owner = owners[0];
  if (owner === undefined) {
    throw new SnapshotError(
      `No snapshot ${id} (snapshots are kept ${Math.round((opts.ttlMs ?? SNAPSHOT_TTL_MS) / 3_600_000)} h). Build one with build_snapshot.`,
    );
  }
  if (customerId !== undefined && owner !== customerId) {
    throw new SnapshotError(
      `Snapshot ${id} belongs to another account, not ${customerId}. Use a snapshot of this account.`,
    );
  }
  return readFile(path.join(root, owner, `${id}${SUFFIX}`), id, owner);
};

/** The newest snapshot of an account that is still kept, or null. */
/**
 * The newest kept snapshot of the account that `accept` takes (e.g. "under 60 min old and
 * covers these sections"), looking past newer ones it refuses. A damaged file is skipped.
 */
export const newestSnapshotWhere = (
  customerId: string,
  opts: SnapshotFilesOptions,
  accept: (snap: AccountSnapshot) => boolean,
): AccountSnapshot | null => {
  checkCustomer(customerId);
  cleanupSnapshots(opts);
  const dir = path.join(snapshotsDir(opts.configDir), customerId);
  for (const file of filesOf(dir)) {
    try {
      const snap = readFile(path.join(dir, file), file.slice(0, -SUFFIX.length), customerId);
      if (accept(snap)) return snap;
    } catch {
      // a damaged file is never used; an older one may still stand in
    }
  }
  return null;
};

export const latestSnapshot = (
  customerId: string,
  opts: SnapshotFilesOptions,
): AccountSnapshot | null => {
  checkCustomer(customerId);
  cleanupSnapshots(opts);
  const dir = path.join(snapshotsDir(opts.configDir), customerId);
  const newest = filesOf(dir)[0];
  if (newest === undefined) return null;
  return readFile(path.join(dir, newest), newest.slice(0, -SUFFIX.length), customerId);
};

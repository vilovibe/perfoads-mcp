// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearSavedLimitWait,
  credentialsInfo,
  DecryptError,
  decryptValue,
  encryptValue,
  forgetDataKey,
  getDataKey,
  isInside,
  KeyUnavailableError,
  keyFilePath,
  listSavedAccounts,
  loadOAuthCredentials,
  newDataKey,
  openStore,
  readEnvCredentials,
  resolveConfigDir,
  saveAccounts,
  saveCredential,
  storePath,
  StoreBusyError,
  StoreOpenError,
  type CommandRunner,
  type Migration,
  type Store,
} from "./index.js";
import { approvalHmacKey } from "./approvalKey.js";
import { MIGRATIONS } from "./migrations.js";
import { createStoreOpsCounter } from "./opsUsage.js";
import { holdStoreLock } from "./testing/lock.js";

let dir: string;
let store: Store | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "perfoads-store-"));
});
afterEach(() => {
  store?.close();
  store = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** No keychain tools: every command "is not installed". */
const noTools: CommandRunner = () => ({ status: null, stdout: "", error: new Error("ENOENT") });

describe("openStore and migrations", () => {
  it("creates the tables, turns on WAL and records the schema version", () => {
    store = openStore(storePath(dir));
    expect(store.journalMode()).toBe("wal");
    expect(store.schemaVersion()).toBe(MIGRATIONS.length);
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual([
      "accounts",
      "approval_sessions",
      "audit_log",
      "changes",
      "credentials",
      "meta",
      "ops_usage",
      "policy_versions",
      "proposal_attempts",
      "prune_window",
      "retention_checkpoints",
      "sqlite_sequence",
    ]);
  });

  it("is idempotent: opening again applies nothing twice and keeps data", () => {
    store = openStore(storePath(dir));
    store.setMeta("probe", "kept");
    store.close();
    store = openStore(storePath(dir));
    expect(store.schemaVersion()).toBe(MIGRATIONS.length);
    expect(store.getMeta("probe")).toBe("kept");
  });

  it("applies only the new migrations when more are added later", () => {
    store = openStore(storePath(dir));
    store.close();
    const next: Migration[] = [
      { version: 1, name: "never re-run", sql: "CREATE TABLE accounts (x INTEGER)" },
      ...MIGRATIONS.slice(1),
      {
        version: MIGRATIONS.length + 1,
        name: "later table",
        sql: "CREATE TABLE later_table (id INTEGER PRIMARY KEY)",
      },
    ];
    store = openStore(storePath(dir), { migrations: next });
    expect(store.schemaVersion()).toBe(MIGRATIONS.length + 1);
    expect(() => store?.db.prepare("SELECT id FROM later_table").all()).not.toThrow();
  });

  it("refuses a store made by a newer version", () => {
    store = openStore(storePath(dir));
    store.setMeta("schema_version", "99");
    store.close();
    store = undefined;
    expect(() => openStore(storePath(dir))).toThrow(/newer version/);
  });

  it.skipIf(process.platform === "win32")("makes the database file owner-only", () => {
    store = openStore(storePath(dir));
    expect(statSync(storePath(dir)).mode & 0o777).toBe(0o600);
  });

  it("a store locked by another connection is busy, not damaged, and opens once released", () => {
    openStore(storePath(dir)).close();
    const release = holdStoreLock(storePath(dir));
    try {
      expect(() => openStore(storePath(dir), { busyTimeoutMs: 0 })).toThrow(StoreBusyError);
      expect(() => openStore(storePath(dir), { busyTimeoutMs: 0 })).toThrow(
        /in use by another perfoads-mcp process/,
      );
    } finally {
      release();
    }
    store = openStore(storePath(dir), { busyTimeoutMs: 0 });
    expect(store.schemaVersion()).toBe(MIGRATIONS.length);
  });

  it("a write after open that hits another connection's lock is busy, in plain words", () => {
    store = openStore(storePath(dir), { busyTimeoutMs: 0 });
    const s = store;
    const release = holdStoreLock(storePath(dir));
    try {
      expect(() => s.setMeta("access_level", "basic")).toThrow(StoreBusyError);
      expect(() => s.deleteMeta("access_level")).toThrow(StoreBusyError);
      expect(() => saveCredential(s, newDataKey(), "oauth_client_id", "x")).toThrow(
        /in use by another perfoads-mcp process/,
      );
      expect(() => s.immediate(() => undefined)).toThrow(StoreBusyError);
    } finally {
      release();
    }
    s.setMeta("access_level", "basic");
    expect(s.getMeta("access_level")).toBe("basic");
  });

  it("a damaged store file gives a plain error with the path and the way out", () => {
    writeFileSync(storePath(dir), "this is not a database, just text ".repeat(200));
    expect(() => openStore(storePath(dir))).toThrow(StoreOpenError);
    expect(() => openStore(storePath(dir))).not.toThrow(StoreBusyError);
    expect(() => openStore(storePath(dir))).toThrow(/store\.sqlite[\s\S]*reset/);
  });

  it("immediate() rolls back on error", () => {
    store = openStore(storePath(dir));
    const s = store;
    expect(() =>
      s.immediate(() => {
        s.setMeta("half", "done");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(s.getMeta("half")).toBeUndefined();
  });
});

describe("AES-256-GCM values", () => {
  const key = newDataKey();

  it("round-trips, with a fresh IV every time", () => {
    const a = encryptValue(key, "fake-refresh-value", "refresh_token");
    const b = encryptValue(key, "fake-refresh-value", "refresh_token");
    expect(a).not.toBe(b);
    expect(a).not.toContain("fake-refresh-value");
    expect(decryptValue(key, a, "refresh_token")).toBe("fake-refresh-value");
  });

  it("fails on tampered ciphertext", () => {
    const stored = encryptValue(key, "fake-secret-value", "oauth_client_secret");
    const raw = Buffer.from(stored.slice(3), "base64");
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 0x01;
    const tampered = `v1.${raw.toString("base64")}`;
    expect(() => decryptValue(key, tampered, "oauth_client_secret")).toThrow(DecryptError);
  });

  it("fails with the wrong purpose (AAD)", () => {
    const stored = encryptValue(key, "fake-secret-value", "oauth_client_secret");
    expect(() => decryptValue(key, stored, "refresh_token")).toThrow(DecryptError);
  });

  it("fails with the wrong key, and the error holds no secret", () => {
    const stored = encryptValue(key, "fake-secret-value", "refresh_token");
    try {
      decryptValue(newDataKey(), stored, "refresh_token");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DecryptError);
      expect(String((err as Error).message)).not.toContain("fake-secret-value");
    }
  });
});

describe("data key", () => {
  const deps = (run: CommandRunner = noTools) => ({
    configDir: dir,
    platform: process.platform,
    env: {},
    run,
    exists: () => true,
  });

  it("without create, returns nothing and makes nothing", () => {
    store = openStore(storePath(dir));
    expect(getDataKey(deps(), store, { create: false })).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("falls back to a 0600 key file and reuses it", () => {
    store = openStore(storePath(dir));
    const first = getDataKey(deps(), store, { create: true });
    expect(first?.backend).toBe("file");
    expect(statSync(keyFilePath(dir)).mode & 0o777).toBe(0o600);
    const again = getDataKey(deps(), store, { create: false });
    expect(again?.key.equals(first?.key ?? Buffer.alloc(0))).toBe(true);
  });

  it("uses the macOS Keychain through stdin, never with the key in the arguments", () => {
    store = openStore(storePath(dir));
    const saved = new Map<string, string>();
    const calls: { args: string[]; input: string | undefined }[] = [];
    const keychain: CommandRunner = (command, args, input) => {
      calls.push({ args, input });
      if (command !== "/usr/bin/security")
        return { status: null, stdout: "", error: new Error("ENOENT") };
      if (args[0] === "list-keychains") return { status: 0, stdout: "" };
      if (args[0] === "find-generic-password") {
        const v = saved.get("k");
        return v ? { status: 0, stdout: `${v}\n` } : { status: 44, stdout: "" };
      }
      if (args[0] === "-i" && input) {
        const hex = /-w ([0-9a-f]{64})/.exec(input)?.[1];
        if (hex) saved.set("k", hex);
        return { status: 0, stdout: "" };
      }
      return { status: 1, stdout: "" };
    };
    const key = getDataKey({ ...deps(keychain), platform: "darwin" }, store, { create: true });
    expect(key?.backend).toBe("macos-keychain");
    const hex = key?.key.toString("hex") ?? "missing";
    expect(calls.every((c) => !c.args.join(" ").includes(hex))).toBe(true);
    expect(calls.some((c) => c.input?.includes(hex))).toBe(true);
  });

  it("forgetDataKey removes the key file and the record of it", () => {
    store = openStore(storePath(dir));
    getDataKey(deps(), store, { create: true });
    forgetDataKey(deps(), store);
    expect(existsSync(keyFilePath(dir))).toBe(false);
    expect(store.getMeta("key_backend")).toBeUndefined();
    expect(getDataKey(deps(), store, { create: false })).toBeUndefined();
  });

  it("does not silently switch backends when the recorded one is unavailable", () => {
    store = openStore(storePath(dir));
    store.setMeta("key_backend", "macos-keychain");
    expect(() =>
      getDataKey({ ...deps(), platform: "darwin" }, store as Store, { create: true }),
    ).toThrow(KeyUnavailableError);
  });
});

describe("credentials", () => {
  it("saves encrypted, reports what is saved without decrypting, loads back", () => {
    store = openStore(storePath(dir));
    const key = newDataKey();
    saveCredential(store, key, "oauth_client_id", "fake-client.apps.googleusercontent.com");
    saveCredential(store, key, "oauth_client_secret", "fake-client-secret-value");
    saveCredential(
      store,
      key,
      "refresh_token",
      "fake-refresh-token-value",
      "2026-11-01T00:00:00.000Z",
    );
    const raw = JSON.stringify(store.db.prepare("SELECT * FROM credentials").all());
    expect(raw).not.toContain("fake-client-secret-value");
    expect(raw).not.toContain("fake-refresh-token-value");
    expect(credentialsInfo(store)).toEqual({
      saved: ["oauth_client_id", "oauth_client_secret", "refresh_token"],
      refreshTokenExpiresAt: "2026-11-01T00:00:00.000Z",
      updatedAt: expect.any(String),
    });
    expect(loadOAuthCredentials(store, key)?.refreshToken).toBe("fake-refresh-token-value");
  });

  it("reads env credentials: all three, partial, or none", () => {
    expect(
      readEnvCredentials({
        PERFOADS_MCP_CLIENT_ID: "a",
        PERFOADS_MCP_CLIENT_SECRET: "b",
        PERFOADS_MCP_REFRESH_TOKEN: "c",
      }),
    ).toEqual({ clientId: "a", clientSecret: "b", refreshToken: "c" });
    expect(readEnvCredentials({ PERFOADS_MCP_CLIENT_ID: "a" })).toBe("partial");
    expect(readEnvCredentials({})).toBeUndefined();
  });

  it("saves and lists accounts", () => {
    store = openStore(storePath(dir));
    saveAccounts(store, [
      {
        customerId: "1234567890",
        name: "Fake account",
        currencyCode: "EUR",
        timeZone: "Europe/Amsterdam",
        isManager: false,
        isTestAccount: true,
        status: "ENABLED",
        loginCustomerId: "1111111111",
        level: 1,
      },
    ]);
    expect(listSavedAccounts(store)).toHaveLength(1);
    expect(listSavedAccounts(store)[0]?.loginCustomerId).toBe("1111111111");
  });
});

describe("config dir", () => {
  it("prefers PERFOADS_MCP_HOME, then APPDATA on Windows, then XDG, then ~/.config", () => {
    expect(
      resolveConfigDir({
        env: { PERFOADS_MCP_HOME: "/srv/pm" },
        platform: "linux",
        home: "/home/u",
      }).dir,
    ).toBe("/srv/pm");
    expect(
      resolveConfigDir({
        env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" },
        platform: "win32",
        home: "C:\\Users\\u",
      }).dir,
    ).toBe("C:\\Users\\u\\AppData\\Roaming\\perfoads-mcp");
    expect(
      resolveConfigDir({ env: { XDG_CONFIG_HOME: "/x" }, platform: "linux", home: "/home/u" }).dir,
    ).toBe("/x/perfoads-mcp");
    expect(
      resolveConfigDir({ env: { XDG_CONFIG_HOME: "rel" }, platform: "linux", home: "/home/u" }).dir,
    ).toBe("/home/u/.config/perfoads-mcp");
    // blank or an unfilled placeholder (an optional .mcpb setting left empty) = not set
    for (const value of ["", "  ", "${user_config.settings_folder}"])
      expect(
        resolveConfigDir({ env: { PERFOADS_MCP_HOME: value }, platform: "linux", home: "/home/u" }),
      ).toEqual({ dir: "/home/u/.config/perfoads-mcp", source: "default" });
  });

  it("isInside", () => {
    expect(isInside("/p/a/b", "/p/a", "linux")).toBe(true);
    expect(isInside("/p/a", "/p/a", "linux")).toBe(true);
    expect(isInside("/p/ab", "/p/a", "linux")).toBe(false);
    expect(isInside("/q", "/p", "linux")).toBe(false);
  });
});

describe("migration v2: a v1 store upgrades in place", () => {
  it("keeps v1 data and adds the change tables", () => {
    store = openStore(storePath(dir), { migrations: MIGRATIONS.slice(0, 1) });
    store.setMeta("probe", "kept");
    store.close();
    store = openStore(storePath(dir));
    expect(store.schemaVersion()).toBe(MIGRATIONS.length);
    expect(store.getMeta("probe")).toBe("kept");
    expect(() => store?.db.prepare("SELECT id FROM changes").all()).not.toThrow();
  });
});

describe("migration v8: a v7 store with ops rows upgrades in place", () => {
  it("old rows count as live (production), test starts at 0, opening again changes nothing", () => {
    const t = Date.now();
    store = openStore(storePath(dir), { migrations: MIGRATIONS.filter((m) => m.version <= 7) });
    expect(store.schemaVersion()).toBe(7);
    const insert = store.db.prepare("INSERT INTO ops_usage (at_ms, n, kind) VALUES (?, ?, ?)");
    insert.run(t - 1000, 5, "search");
    insert.run(t - 500, 2, "mutate");
    store.close();

    store = openStore(storePath(dir));
    expect(store.schemaVersion()).toBe(8);
    const pools = () =>
      (
        store?.db.prepare("SELECT pool, n FROM ops_usage ORDER BY at_ms").all() as {
          pool: string;
          n: number;
        }[]
      ).map((r) => [r.pool, Number(r.n)]);
    expect(pools()).toEqual([
      ["production", 5],
      ["production", 2],
    ]);
    const c = createStoreOpsCounter(store, { limits: { test: 15_000, production: 2_880 } });
    expect(c.used("production")).toBe(7);
    expect(c.used("test")).toBe(0);
    expect(c.remaining("production")).toBe(2_873);
    expect(() =>
      store?.db
        .prepare("INSERT INTO ops_usage (at_ms, n, kind, pool) VALUES (?, ?, ?, ?)")
        .run(t, 1, "search", "other"),
    ).toThrow(/CHECK/);
    c.record(3, "search", "test");
    store.close();

    // Opening again: no migration re-runs, the rows and their pools stay as they were.
    store = openStore(storePath(dir));
    expect(store.schemaVersion()).toBe(8);
    expect(pools()).toEqual([
      ["production", 5],
      ["production", 2],
      ["test", 3],
    ]);
    const again = createStoreOpsCounter(store);
    expect(again.used("production")).toBe(7);
    expect(again.used("test")).toBe(3);
  });
});

describe("store-backed ops counter", () => {
  it("is shared by two connections and counts a rolling 24 hours", () => {
    let t = 1_000_000_000_000;
    store = openStore(storePath(dir));
    const other = openStore(storePath(dir));
    try {
      const a = createStoreOpsCounter(store, { limits: { production: 100 }, now: () => t });
      const b = createStoreOpsCounter(other, { limits: { production: 100 }, now: () => t });
      a.record(3, "search");
      b.record(4, "mutate");
      expect(a.used()).toBe(7);
      expect(b.remaining()).toBe(93);
      t += 24 * 60 * 60 * 1000 + 1;
      b.record(1, "search");
      expect(a.used()).toBe(1);
      expect(createStoreOpsCounter(store).remaining()).toBeNull();
    } finally {
      other.close();
    }
  });

  it("counts test and production accounts apart, each with its own limit, across connections", () => {
    const t = 1_000_000_000_000;
    store = openStore(storePath(dir));
    const other = openStore(storePath(dir));
    try {
      const limits = { test: 15_000, production: 2_880 };
      const a = createStoreOpsCounter(store, { limits, now: () => t });
      const b = createStoreOpsCounter(other, { limits, now: () => t });
      a.record(10, "search", "test");
      b.record(3, "search", "test");
      b.record(2, "mutate"); // no pool = production
      a.record(1, "search", "production");
      expect(a.used("test")).toBe(13);
      expect(b.used("production")).toBe(3);
      expect(a.used()).toBe(3);
      expect(b.remaining("test")).toBe(14_987);
      expect(a.remaining("production")).toBe(2_877);
      // Standard access: no limit in either pool.
      const free = createStoreOpsCounter(store, { limits: { test: null, production: null } });
      expect(free.remaining("test")).toBeNull();
      expect(free.remaining("production")).toBeNull();
    } finally {
      other.close();
    }
  });

  it("rows saved before the pool column count as production", () => {
    store = openStore(storePath(dir));
    store.db
      .prepare("INSERT INTO ops_usage (at_ms, n, kind) VALUES (?, ?, ?)")
      .run(Date.now(), 7, "search");
    const c = createStoreOpsCounter(store);
    expect(c.used("production")).toBe(7);
    expect(c.used("test")).toBe(0);
  });

  it("ignores non-positive counts and never throws on a busy store (saves the count later)", () => {
    store = openStore(storePath(dir), { busyTimeoutMs: 0 });
    const c = createStoreOpsCounter(store);
    c.record(0, "search");
    c.record(-2, "search");
    expect(c.used()).toBe(0);
    const release = holdStoreLock(storePath(dir));
    try {
      expect(() => c.record(5, "mutate")).not.toThrow();
      // Not saved yet, but counted: used() = store + pending.
      expect(c.used()).toBe(5);
      const inStore = store.db.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM ops_usage").get() as {
        n: number;
      };
      expect(Number(inStore.n)).toBe(0);
    } finally {
      release();
    }
    c.record(1, "search");
    expect(c.used()).toBe(6);
    const saved = store.db.prepare("SELECT SUM(n) AS n FROM ops_usage").get() as { n: number };
    expect(Number(saved.n)).toBe(6);
  });
});

describe("a spent daily limit kept in the store", () => {
  it("every counter on the store waits until Google's stated time, per pool", () => {
    let t = 1_000_000;
    store = openStore(storePath(dir));
    const a = createStoreOpsCounter(store, { now: () => t });
    const b = createStoreOpsCounter(store, { now: () => t });
    expect(b.limitUntil()).toBeNull();
    a.limitReached(t + 3_600_000);
    // a second process on the same store knows it; the test pool does not
    expect(b.limitUntil()).toBe(t + 3_600_000);
    expect(b.limitUntil("test")).toBeNull();
    // an earlier time never shortens the wait
    b.limitReached(t + 1_000);
    expect(a.limitUntil()).toBe(t + 3_600_000);
    t += 3_600_001;
    expect(a.limitUntil()).toBeNull();
  });

  it("once the wait has passed, operations before it no longer count (Google refilled)", () => {
    let t = 1_000_000;
    store = openStore(storePath(dir));
    const limits = { production: 2_880 };
    const a = createStoreOpsCounter(store, { limits, now: () => t, scope: () => "s1" });
    const b = createStoreOpsCounter(store, { limits, now: () => t, scope: () => "s1" });
    a.record(2_849, "search");
    a.limitReached(t + 3_600_000);
    t += 60_000;
    a.record(1, "search"); // e.g. a call that went out anyway
    expect(b.used()).toBe(2_850);
    t += 3_600_000;
    // another process on the store sees the refill too; the test pool is apart
    expect(b.used()).toBe(0);
    expect(b.remaining()).toBe(2_880);
    b.record(5, "search");
    expect(a.used()).toBe(5);
    // our count frees up as the oldest counted operations leave the 24 hours
    b.record(2_870, "search");
    expect(b.freesAt(10)).toBe(t + 24 * 3_600_000);
    expect(b.freesAt(5)).toBe(t);
    // a wait for another project says nothing about this one's refill
    const other = createStoreOpsCounter(store, { limits, now: () => t, scope: () => "s2" });
    expect(other.used()).toBe(5_725);
  });

  it("a refill Google showed (it took what our count said it would refuse) is shared and scoped", () => {
    let t = 1_000_000;
    store = openStore(storePath(dir));
    const limits = { production: 2_880 };
    const a = createStoreOpsCounter(store, { limits, now: () => t, scope: () => "s1" });
    const b = createStoreOpsCounter(store, { limits, now: () => t, scope: () => "s1" });
    a.record(2_849, "search");
    t += 60_000;
    a.refilled(t - 1);
    a.record(1, "search");
    // another process sees it; operations before the refill no longer count
    expect(b.used()).toBe(1);
    expect(b.remaining()).toBe(2_879);
    // another project's count is untouched
    const other = createStoreOpsCounter(store, { limits, now: () => t, scope: () => "s2" });
    expect(other.used()).toBe(2_850);
  });

  it("keeps at most 24 hours, only for the project and level it was said for, and setup clears it", () => {
    const t = 1_000_000;
    const day = 24 * 60 * 60 * 1000;
    let scope = "project-a";
    store = openStore(storePath(dir));
    const a = createStoreOpsCounter(store, { now: () => t, scope: () => scope });
    // a stated wait past a day is kept as one day
    a.limitReached(t + 3 * day);
    expect(a.limitUntil()).toBe(t + day);
    // another OAuth client or access level does not inherit it, and its own wait is kept
    scope = "project-b";
    expect(a.limitUntil()).toBeNull();
    a.limitReached(t + 1_000);
    expect(a.limitUntil()).toBe(t + 1_000);
    // each project keeps its own wait: project-b's did not overwrite project-a's
    scope = "project-a";
    const other = createStoreOpsCounter(store, { now: () => t, scope: () => scope });
    expect(other.limitUntil()).toBe(t + day);
    scope = "project-b";
    // a wait saved before scopes (a bare time) or far ahead is ignored
    store.setMeta("ops_limit_until_test", String(t + 3_600_000));
    store.setMeta("ops_limit_until_test_project-b", String(t + 3_600_000));
    expect(a.limitUntil("test")).toBeNull();
    store.setMeta("ops_limit_until_test_project-b", `${t + 2 * day} project-b`);
    expect(a.limitUntil("test")).toBeNull();
    store.setMeta("ops_limit_until_test_project-b", `${t + 3_600_000} project-b`);
    expect(a.limitUntil("test")).toBe(t + 3_600_000);
    // setup forgets every saved wait
    clearSavedLimitWait(store);
    const fresh = createStoreOpsCounter(store, { now: () => t, scope: () => scope });
    expect(fresh.limitUntil()).toBeNull();
    expect(fresh.limitUntil("test")).toBeNull();
    scope = "project-a";
    expect(
      createStoreOpsCounter(store, { now: () => t, scope: () => scope }).limitUntil(),
    ).toBeNull();
    expect(store.getMeta("ops_limit_until_test")).toBeUndefined();
  });
});

describe("nested transactions", () => {
  it("a nested immediate is a savepoint: its error rolls back only its own work", () => {
    store = openStore(storePath(dir));
    const s = store;
    s.immediate(() => {
      s.setMeta("outer", "1");
      expect(() =>
        s.immediate(() => {
          s.setMeta("inner", "1");
          throw new Error("inner fails");
        }),
      ).toThrow(/inner fails/);
      s.immediate(() => s.setMeta("inner2", "1"));
    });
    expect(s.getMeta("outer")).toBe("1");
    expect(s.getMeta("inner")).toBeUndefined();
    expect(s.getMeta("inner2")).toBe("1");
    expect(() =>
      s.immediate(() => {
        s.setMeta("gone", "1");
        throw new Error("outer fails");
      }),
    ).toThrow();
    expect(s.getMeta("gone")).toBeUndefined();
  });
});

describe("nested transactions after SQLite rolled everything back", () => {
  it("rethrows the original error (not 'no such savepoint') and never commits the outer work", () => {
    store = openStore(storePath(dir));
    const s = store;
    s.db.exec(
      "CREATE TABLE boom (x INTEGER); CREATE TRIGGER boom_all BEFORE INSERT ON boom BEGIN SELECT RAISE(ROLLBACK, 'boom: whole transaction'); END;",
    );
    let inner: unknown;
    expect(() =>
      s.immediate(() => {
        s.setMeta("outer_before", "1");
        try {
          s.immediate(() => s.db.prepare("INSERT INTO boom VALUES (1)").run());
        } catch (err) {
          inner = err;
        }
        // Outer code that carries on after the nested failure: must not be committed.
        s.immediate(() => s.setMeta("outer_after", "1"));
      }),
    ).toThrow(/boom: whole transaction/);
    expect(String(inner)).toMatch(/boom: whole transaction/);
    expect(String(inner)).not.toMatch(/no such savepoint/);
    expect(s.getMeta("outer_before")).toBeUndefined();
    expect(s.inTransaction()).toBe(false);
    // The connection works normally afterwards.
    s.immediate(() => s.setMeta("later", "1"));
    expect(s.getMeta("later")).toBe("1");
  });
});

describe("approval HMAC key", () => {
  it("is made once, 32 random bytes, and every connection reads the same key", () => {
    store = openStore(storePath(dir));
    const other = openStore(storePath(dir));
    try {
      const k1 = approvalHmacKey(store);
      const k2 = approvalHmacKey(other);
      expect(k1.length).toBe(32);
      expect(k1.equals(k2)).toBe(true);
      expect(approvalHmacKey(store).equals(k1)).toBe(true);
    } finally {
      other.close();
    }
  });
});

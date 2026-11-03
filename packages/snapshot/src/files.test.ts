// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Snapshot files: 0600 files in 0700 folders under the config folder, TTL and count cleanup,
// damaged files, another account's snapshot, never in the working folder.

import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  builtAtOfId,
  cleanupSnapshots,
  clearSnapshots,
  latestSnapshot,
  loadSnapshot,
  saveSnapshot,
  SnapshotError,
  snapshotsDir,
  type SnapshotFilesOptions,
} from "./files.js";
import type { AccountSnapshot } from "./schema.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 8, 2, 12, 0, 0);
const HOUR = 3_600_000;
const stamp = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

const snap = (customer = "1234567890", at = T0, suffix = "abcdefgh"): AccountSnapshot => ({
  schema: "perfoads.account_snapshot",
  version: 3,
  id: `snap_${stamp(at)}_${suffix}`,
  built_at: new Date(at).toISOString(),
  elapsed_ms: 5,
  complete: true,
  account: {
    customer_id: customer,
    name: { untrusted: "Fake" },
    currency_code: "USD",
    time_zone: "UTC",
    is_test_account: true,
    is_manager: false,
  },
  date_ranges: {
    performance: { start_date: "2026-06-04", end_date: "2026-09-01" },
    change_history: { start_date: "2026-08-05", end_date: "2026-09-02" },
  },
  sections: {},
});

const setup = (now = T0): SnapshotFilesOptions & { root: string } => {
  const root = mkdtempSync(path.join(tmpdir(), "perfoads-snap-"));
  roots.push(root);
  return {
    root,
    configDir: path.join(root, "config"),
    cwd: path.join(root, "project"),
    now: () => now,
  };
};

const posix = process.platform !== "win32";

describe("saving", () => {
  it("writes gzipped JSON at <config>/snapshots/<customer>/<id>.json.gz, file 0600, folders 0700", () => {
    const o = setup();
    const file = saveSnapshot(snap(), o);
    expect(file).toBe(
      path.join(o.configDir, "snapshots", "1234567890", "snap_20260902T120000Z_abcdefgh.json.gz"),
    );
    if (posix) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
      expect(statSync(snapshotsDir(o.configDir)).mode & 0o777).toBe(0o700);
    }
    // no temp file left behind
    expect(readdirSync(path.dirname(file))).toEqual(["snap_20260902T120000Z_abcdefgh.json.gz"]);
    expect(loadSnapshot(snap().id, o)).toEqual(snap());
  });

  it("asks for owner-only folders and file (Windows ACL hook) before the file is in place", () => {
    const o = setup();
    const seen: [string, string][] = [];
    const file = saveSnapshot(snap(), { ...o, ownerOnly: (t, k) => seen.push([t, k]) });
    expect(seen.slice(0, 2)).toEqual([
      [snapshotsDir(o.configDir), "dir"],
      [path.dirname(file), "dir"],
    ]);
    expect(seen[2]?.[1]).toBe("file");
    expect(seen[2]?.[0]).toMatch(/\.json\.gz\.\d+\.tmp$/);
  });

  it("refuses to write inside the working folder", () => {
    const o = setup();
    expect(() => saveSnapshot(snap(), { ...o, cwd: o.root })).toThrow(SnapshotError);
    expect(() => saveSnapshot(snap(), { ...o, cwd: o.root })).toThrow(/inside the working folder/);
  });

  it("refuses a snapshot that does not fit the schema", () => {
    const o = setup();
    expect(() => saveSnapshot({ ...snap(), id: "../../evil" }, o)).toThrow();
  });
});

describe("cleanup", () => {
  it("drops snapshots older than the TTL (24 h by default)", () => {
    const o = setup(T0);
    saveSnapshot(snap("1234567890", T0 - 25 * HOUR, "oldoldol"), {
      ...o,
      now: () => T0 - 25 * HOUR,
    });
    saveSnapshot(snap("1234567890", T0 - 1 * HOUR, "newnewne"), o);
    const dir = path.join(snapshotsDir(o.configDir), "1234567890");
    expect(readdirSync(dir)).toEqual([`snap_${stamp(T0 - HOUR)}_newnewne.json.gz`]);
    expect(() => loadSnapshot(`snap_${stamp(T0 - 25 * HOUR)}_oldoldol`, o)).toThrow(/No snapshot/);
  });

  it("keeps at most 20 per account, newest first; other accounts are not touched", () => {
    const o = setup(T0);
    for (let i = 0; i < 23; i++)
      saveSnapshot(snap("1234567890", T0 - i * 60_000, `aaaaaa${String(i).padStart(2, "0")}`), o);
    saveSnapshot(snap("1111111111", T0), o);
    const dir = (c: string) => path.join(snapshotsDir(o.configDir), c);
    expect(readdirSync(dir("1234567890"))).toHaveLength(20);
    expect(readdirSync(dir("1111111111"))).toHaveLength(1);
    expect(latestSnapshot("1234567890", o)?.id).toBe(`snap_${stamp(T0)}_aaaaaa00`);
    expect(cleanupSnapshots({ ...o, maxPerAccount: 5 })).toBe(15);
  });

  it("removes temp files of unfinished saves older than 1 hour, keeps newer ones", () => {
    const o = setup(T0);
    const file = saveSnapshot(snap(), o);
    const dir = path.dirname(file);
    const oldTmp = `${file}.111.tmp`;
    const newTmp = `${file}.222.tmp`;
    writeFileSync(oldTmp, "x");
    writeFileSync(newTmp, "x");
    utimesSync(oldTmp, (T0 - 2 * HOUR) / 1000, (T0 - 2 * HOUR) / 1000);
    utimesSync(newTmp, (T0 - 10 * 60_000) / 1000, (T0 - 10 * 60_000) / 1000);
    cleanupSnapshots(o);
    expect(readdirSync(dir).sort()).toEqual([path.basename(file), path.basename(newTmp)].sort());
  });

  it("the build time comes from the id", () => {
    expect(builtAtOfId("snap_20260902T120000Z_abcdefgh")).toBe(T0);
    expect(builtAtOfId("snap_x")).toBeNull();
  });
});

describe("clearing", () => {
  it("clearSnapshots removes every kept snapshot of one account, and only that account", () => {
    const o = setup(T0);
    saveSnapshot(snap("1234567890", T0, "aaaaaaaa"), o);
    saveSnapshot(snap("1234567890", T0 - 60_000, "bbbbbbbb"), o);
    saveSnapshot(snap("1111111111", T0), o);
    expect(clearSnapshots("1234567890", o)).toBe(2);
    expect(latestSnapshot("1234567890", o)).toBeNull();
    expect(latestSnapshot("1111111111", o)?.account.customer_id).toBe("1111111111");
    expect(() => clearSnapshots("../x", o)).toThrow(/customer id/);
  });
});

describe("loading", () => {
  it("a damaged file is a clear error, never half-used", () => {
    const o = setup();
    const file = saveSnapshot(snap(), o);
    writeFileSync(file, "not gzip at all");
    expect(() => loadSnapshot(snap().id, o)).toThrow(/is damaged \(not a readable snapshot file\)/);
    writeFileSync(file, gzipSync(JSON.stringify({ ...snap(), version: 4 })));
    expect(() => loadSnapshot(snap().id, o)).toThrow(/does not match AccountSnapshot v3/);
    // a v1 file (before per-part caps) is refused in plain words
    writeFileSync(file, gzipSync(JSON.stringify({ ...snap(), version: 1 })));
    expect(() => loadSnapshot(snap().id, o)).toThrow(/made by an older version.*Build a new one/);
    expect(() => latestSnapshot("1234567890", o)).toThrow(SnapshotError);
  });

  it("a file whose content names another account or id is refused", () => {
    const o = setup();
    const file = saveSnapshot(snap(), o);
    writeFileSync(file, gzipSync(JSON.stringify(snap("1111111111"))));
    expect(() => loadSnapshot(snap().id, o)).toThrow(/does not match its file/);
  });

  it("a snapshot of another account is refused when the account is named", () => {
    const o = setup();
    saveSnapshot(snap("1111111111"), o);
    expect(() => loadSnapshot(snap().id, o, "1234567890")).toThrow(/belongs to another account/);
    expect(loadSnapshot(snap().id, o, "1111111111").account.customer_id).toBe("1111111111");
  });

  it("bad ids and unknown ids are plain errors", () => {
    const o = setup();
    expect(() => loadSnapshot("../../etc/passwd", o)).toThrow(/not a snapshot id/);
    expect(() => loadSnapshot("snap_20260902T120000Z_zzzzzzzz", o)).toThrow(/No snapshot/);
    expect(() => latestSnapshot("12", o)).toThrow(/customer id/);
    expect(latestSnapshot("1234567890", o)).toBeNull();
  });
});

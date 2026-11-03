// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Vitest setup file (see vitest.config.ts). Windows cannot delete a SQLite file while a handle
// is open (EBUSY), macOS and Linux can. This makes every OS behave like Windows in tests:
// - openStore is wrapped so every open handle is tracked until its close();
// - rmSync throws when it would delete a folder or file that holds an open store;
// - after each test, no store handle may be left open.

import path from "node:path";
import { afterEach, expect, vi } from "vitest";

const tracker = vi.hoisted(() => ({ open: new Set<{ file: string }>() }));

const holdsOpenStore = (target: string): string | undefined => {
  const dir = path.resolve(target);
  for (const { file } of tracker.open) {
    const rel = path.relative(dir, path.resolve(file));
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return file;
  }
  return undefined;
};

vi.mock("../db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db.js")>();
  const openStore: typeof actual.openStore = (file, options) => {
    const store = actual.openStore(file, options);
    const entry = { file: store.path };
    tracker.open.add(entry);
    return {
      ...store,
      close: () => {
        store.close();
        tracker.open.delete(entry);
      },
    };
  };
  return { ...actual, openStore };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const rmSync: typeof actual.rmSync = (target, options) => {
    const file = holdsOpenStore(String(target));
    if (file) throw new Error(`EBUSY (simulated): ${String(target)} holds an open store ${file}`);
    actual.rmSync(target, options);
  };
  return { ...actual, default: { ...actual, rmSync }, rmSync };
});

afterEach(() => {
  const left = [...tracker.open].map((e) => e.file);
  tracker.open.clear();
  expect(left, "store handles left open after the test").toEqual([]);
});

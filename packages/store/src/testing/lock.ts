// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { createRequire } from "node:module";

// Same require as db.ts: the test bundler does not know the "node:sqlite" builtin.
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

/**
 * Holds the store's write lock from a second connection, like another running server in the
 * middle of a write. Returns the release function; always call it (it closes the connection).
 */
export const holdStoreLock = (file: string): (() => void) => {
  const db = new DatabaseSync(file);
  try {
    db.exec("BEGIN EXCLUSIVE");
  } catch (err) {
    db.close();
    throw err;
  }
  return () => {
    db.exec("ROLLBACK");
    db.close();
  };
};

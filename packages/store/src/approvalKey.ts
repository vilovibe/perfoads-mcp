// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { randomBytes } from "node:crypto";
import type { Store } from "./db.js";

const META_KEY = "approval_hmac_key";

/**
 * The HMAC key that signs approval request state (bound to a change id, its diff hash
 * and expiry). Made once per store with the OS random source; two processes asking at
 * the same time get the same key (INSERT OR IGNORE inside BEGIN IMMEDIATE). Never logged
 * or returned by any tool.
 */
export const approvalHmacKey = (store: Store): Buffer =>
  store.immediate(() => {
    store.db
      .prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)")
      .run(META_KEY, randomBytes(32).toString("base64"));
    const row = store.db.prepare("SELECT value FROM meta WHERE key = ?").get(META_KEY) as {
      value: string;
    };
    return Buffer.from(row.value, "base64");
  });

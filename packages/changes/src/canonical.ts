// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { createHash } from "node:crypto";

/**
 * JSON with object keys sorted at every level and undefined dropped, so the same value
 * always gives the same text (and the same hash). BigInt and non-finite numbers throw.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("not a finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`cannot put a ${typeof value} in canonical JSON`);
  }
};

export const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

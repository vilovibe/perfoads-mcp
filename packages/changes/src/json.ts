// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Small guards for Google's JSON (same as ads-client's, kept local: they are not exported there).

export type JsonObject = Record<string, unknown>;

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const asObject = (value: unknown): JsonObject => (isObject(value) ? value : {});

export const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** int64 fields arrive as strings; "" / missing -> "0". Anything not an integer -> null. */
export const microsField = (value: unknown): string | null => {
  if (value === undefined || value === null || value === "") return "0";
  const text = typeof value === "number" ? String(value) : asString(value);
  return text !== undefined && /^-?\d+$/.test(text) ? BigInt(text).toString() : null;
};

/** A double (e.g. target ROAS 2.5) as a stable string, 6 decimals at most; missing -> "0". */
export const doubleField = (value: unknown): string | null => {
  if (value === undefined || value === null || value === "") return "0";
  const n = typeof value === "number" ? value : Number(asString(value));
  if (!Number.isFinite(n)) return null;
  return String(Math.round(n * 1e6) / 1e6);
};

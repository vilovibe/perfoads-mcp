// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { isObject } from "./json.js";
import type { Logger } from "./types.js";

const REDACTED = "[REDACTED]";

/** Keys whose values are never logged, whatever they hold. */
const SECRET_KEY = /authorization|token|secret|password|api[-_]?key|cookie|credential/i;

/** Parameter names whose values are secrets inside strings (query strings, form bodies, JSON, headers). */
const SECRET_NAMES =
  "access_token|refresh_token|id_token|client_secret|authorization|password|api[-_]?key";

/** Patterns rewritten inside strings, keeping the name and hiding the value. */
const SECRET_PARAMS: readonly [RegExp, string][] = [
  // name=value in query strings and form bodies (OAuth "code" only as a URL/form parameter)
  [new RegExp(`(^|[?&\\s"'{,;])(${SECRET_NAMES})=[^&\\s"',;}]+`, "gi"), "$1$2=[REDACTED]"],
  [/([?&]code=)[^&\s"',;}]+/gi, "$1[REDACTED]"],
  // "name": "value", name: value, Authorization: Bearer value
  [
    new RegExp(
      `(["']?)(${SECRET_NAMES})\\1(\\s*:\\s*)(["']?)(?:(?:Bearer|Basic)\\s+)?[^"'\\s,}]+\\4`,
      "gi",
    ),
    "$1$2$1$3$4[REDACTED]$4",
  ],
  // "code": "value" (OAuth authorization code; numeric status codes are left alone)
  [/(["']code["']\s*:\s*)(["'])[^"']+\2/gi, "$1$2[REDACTED]$2"],
];

/** Secret shapes caught even when the value is unknown to us. */
const SECRET_SHAPES: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi, // Authorization header values
  /ya29\.[A-Za-z0-9._-]+/g, // Google OAuth access tokens
  /1\/\/[A-Za-z0-9._-]{20,}/g, // Google OAuth refresh tokens
];

/** Known secret values shorter than this are not matched, so short words are not mangled. */
const MIN_SECRET_LENGTH = 8;

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const LEVELS = ["debug", "info", "warn", "error"] as const;

/**
 * Writes JSON lines to stderr only: stdout carries the MCP stdio protocol and must stay clean.
 * Wrap it with createRedactingLogger (the client does) before logging anything sensitive.
 */
export const createStderrLogger = (minLevel: keyof Logger = "warn"): Logger => {
  const min = LEVELS.indexOf(minLevel);
  const write =
    (level: keyof Logger) =>
    (message: string, data?: Record<string, unknown>): void => {
      if (LEVELS.indexOf(level) < min) return;
      const line = { at: new Date().toISOString(), level, message, ...(data ? { data } : {}) };
      process.stderr.write(`${JSON.stringify(line)}\n`);
    };
  return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") };
};

export const redactString = (text: string, secrets: readonly string[] = []): string => {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_LENGTH) out = out.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of SECRET_PARAMS) out = out.replace(pattern, replacement);
  for (const shape of SECRET_SHAPES) out = out.replace(shape, REDACTED);
  return out;
};

export const redactValue = (
  value: unknown,
  secrets: readonly string[] = [],
  depth = 0,
): unknown => {
  if (typeof value === "string") return redactString(value, secrets);
  if (depth > 8) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message, secrets) };
  }
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(v, secrets, depth + 1);
    }
    return out;
  }
  return value;
};

/**
 * Wraps a logger so no access token, refresh token, client secret or Authorization header ever reaches it.
 * `secrets` is read on every call, so newly issued access tokens are covered too.
 */
export const createRedactingLogger = (
  base: Logger,
  secrets: () => readonly string[] = () => [],
): Logger => {
  const wrap =
    (level: keyof Logger) =>
    (message: string, data?: Record<string, unknown>): void => {
      const known = secrets();
      const safeMessage = redactString(message, known);
      if (data === undefined) base[level](safeMessage);
      else base[level](safeMessage, redactValue(data, known) as Record<string, unknown>);
    };
  return { debug: wrap("debug"), info: wrap("info"), warn: wrap("warn"), error: wrap("error") };
};

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { readFileSync } from "node:fs";

const pkg = ((): { version?: unknown; perfoads?: { published?: unknown } } => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
      perfoads?: { published?: unknown };
    };
  } catch {
    return {};
  }
})();

export const CLI_VERSION: string = typeof pkg.version === "string" ? pkg.version : "0.0.0";

/**
 * package.json "perfoads": {"published": true} once this exact version is on npm. Until
 * then every message names Node + this install's entry file, never `npx`.
 */
export const CLI_PUBLISHED: boolean = pkg.perfoads?.published === true;

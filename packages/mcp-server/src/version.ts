// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { readFileSync } from "node:fs";

/** The product name people see; defined once in @perfoads/store (docs/NAMING.md). */
export { PRODUCT_NAME, WORK_WITH_NOTE } from "@perfoads/store";

/** The MCP server id (serverInfo.name) and the npm package / CLI name. */
export const SERVER_NAME = "perfoads-mcp";

/** From this package's package.json (one level up from both src/ and dist/). */
export const SERVER_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

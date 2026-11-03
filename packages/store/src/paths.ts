// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { homedir } from "node:os";
import path from "node:path";

/**
 * The product name people see (approval page, CLI, server title, starter policy, .mcpb display
 * name). Lives here because every package that shows it depends on the store. Renaming:
 * change it here and in the other places listed in docs/NAMING.md.
 */
export const PRODUCT_NAME = "PerfoAds MCP";

/**
 * The one "work with us" line: README, the CLI help footer, the end of `init` and the
 * approval page footer. Never in server instructions, tool descriptions or tool replies.
 */
export const WORK_WITH_NOTE =
  "Want fixes, not just findings? PerfoAds adds fix plans; Paweł Wilk offers a free 1-hour call - perfoads.com";

/** Settings folder name. Never rename without a migration (saved sign-ins live there). */
export const APP_DIR_NAME = "perfoads-mcp";

export interface ConfigDirInput {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  home: string;
}

export interface ConfigDir {
  dir: string;
  /** How the location was chosen, for doctor. */
  source: "PERFOADS_MCP_HOME" | "APPDATA" | "XDG_CONFIG_HOME" | "default";
}

/**
 * Per-user config dir. Never the current working directory: an AI agent with a shell
 * works there, and the store and policy must sit outside its reach.
 * Order: PERFOADS_MCP_HOME, then %APPDATA%\perfoads-mcp (Windows),
 * then $XDG_CONFIG_HOME/perfoads-mcp, then ~/.config/perfoads-mcp.
 * An empty PERFOADS_MCP_HOME, or one still holding an unfilled `${...}` placeholder (an app
 * that did not substitute an optional setting, e.g. a .mcpb user_config left blank), is unset.
 */
export const resolveConfigDir = (
  input: ConfigDirInput = { env: process.env, platform: process.platform, home: homedir() },
): ConfigDir => {
  const { env, platform, home } = input;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const override = env.PERFOADS_MCP_HOME?.trim();
  if (override && !override.includes("${"))
    return { dir: pathApi.resolve(override), source: "PERFOADS_MCP_HOME" };
  if (platform === "win32") {
    const appData = env.APPDATA?.trim() || pathApi.join(home, "AppData", "Roaming");
    return { dir: pathApi.join(appData, APP_DIR_NAME), source: "APPDATA" };
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  // XDG spec: relative values are invalid and must be ignored.
  if (xdg && pathApi.isAbsolute(xdg)) {
    return { dir: pathApi.join(xdg, APP_DIR_NAME), source: "XDG_CONFIG_HOME" };
  }
  return { dir: pathApi.join(home, ".config", APP_DIR_NAME), source: "default" };
};

/** True when `child` is `parent` or sits anywhere below it. */
export const isInside = (child: string, parent: string, platform = process.platform): boolean => {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const norm = (p: string) => {
    const r = pathApi.resolve(p);
    return platform === "win32" || platform === "darwin" ? r.toLowerCase() : r;
  };
  const rel = pathApi.relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !pathApi.isAbsolute(rel));
};

export const storePath = (configDir: string): string => path.join(configDir, "store.sqlite");

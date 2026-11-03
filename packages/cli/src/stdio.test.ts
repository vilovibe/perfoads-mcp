// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Starts the BUILT CLI as a real child process (run `pnpm build` first; `pnpm test` does).

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const BIN = fileURLToPath(new URL("../bin/perfoads-mcp.js", import.meta.url));
const DIST = fileURLToPath(new URL("../dist/main.js", import.meta.url));

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const runServer = async (args: string[]) => {
  const root = mkdtempSync(path.join(tmpdir(), "perfoads-stdio-"));
  roots.push(root);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    PERFOADS_MCP_HOME: path.join(root, "config"),
    PERFOADS_MCP_KEY_BACKEND: "file",
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
  };
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: root,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));

  const waitFor = async (id: number): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const msg = stdout
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((m) => m.id === id);
      if (msg) return msg;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`no reply to request ${id}. stderr: ${stderr.slice(0, 500)}`);
  };
  const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "stdio-test", version: "0.0.0" },
    },
  });
  const init = await waitFor(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const list = await waitFor(2);
  child.stdin.end();
  const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { init, list, stdout, stderr, exitCode };
};

describe.skipIf(!existsSync(DIST))("stdio server (built CLI)", () => {
  it("answers initialize + tools/list; stdout carries only JSON-RPC", async () => {
    const { init, list, stdout, exitCode } = await runServer(["serve"]);
    expect(init).toMatchObject({
      jsonrpc: "2.0",
      result: { serverInfo: { name: "perfoads-mcp" } },
    });
    const tools = (list.result as { tools: { name: string }[] }).tools.map((t) => t.name).sort();
    expect(tools).toEqual([
      "apply_change",
      "build_snapshot",
      "describe_resource",
      "doctor",
      "explain_check",
      "get_account_overview",
      "get_ad_groups",
      "get_ads_and_assets",
      "get_audiences",
      "get_budgets_and_bidding",
      "get_campaigns",
      "get_change",
      "get_change_history",
      "get_conversions",
      "get_keywords",
      "get_negatives",
      "get_search_terms",
      "keyword_ideas",
      "list_accounts",
      "list_changes",
      "propose_change",
      "query_gaql",
      "resolve_change",
      "run_checks",
      "undo_change",
    ]);
    const lines = stdout.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect((JSON.parse(line) as { jsonrpc?: string }).jsonrpc).toBe("2.0");
    }
    expect(exitCode).toBe(0);
  }, 30_000);

  it("serves by default when started without arguments and without a terminal", async () => {
    const { list } = await runServer([]);
    expect((list.result as { tools: unknown[] }).tools).toHaveLength(25);
  }, 30_000);
});

// Fails loudly instead of silently skipping when the build is missing in CI.
it("the CLI is built (pnpm build)", () => {
  expect(existsSync(DIST)).toBe(true);
});

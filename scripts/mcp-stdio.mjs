// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Starts a built server (`<bin> serve`) with a throw-away settings folder and asks it, over
// stdio JSON-RPC, what it serves. Used by gen-tools-doc.mjs and build-mcpb.mjs. No sign-in,
// no Google call, nothing read from your own settings.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Talks JSON-RPC to the built server over stdio; returns the answers it needs. */
export const listFromServer = async (bin) => {
  const home = mkdtempSync(path.join(tmpdir(), "perfoads-mcp-stdio-"));
  const env = {
    PATH: process.env.PATH ?? "",
    PERFOADS_MCP_HOME: home,
    PERFOADS_MCP_KEY_BACKEND: "file",
    ...(process.platform === "win32" && process.env.SystemRoot
      ? { SystemRoot: process.env.SystemRoot }
      : {}),
  };
  const child = spawn(process.execPath, [bin, "serve"], {
    cwd: home,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let stderr = "";
  const waiting = new Map();
  child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
  child.stdout.setEncoding("utf8").on("data", (d) => {
    buffer += d;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && waiting.has(msg.id)) {
        waiting.get(msg.id)(msg);
        waiting.delete(msg.id);
      }
    }
  });
  let nextId = 1;
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = globalThis.setTimeout(
        () => reject(new Error(`no answer to ${method}. Server said: ${stderr.slice(0, 500)}`)),
        20_000,
      );
      waiting.set(id, (msg) => {
        globalThis.clearTimeout(timer);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const all = async (method, key) => {
    const out = [];
    let cursor;
    do {
      const r = await request(method, cursor ? { cursor } : {});
      out.push(...r[key]);
      cursor = r.nextCursor;
    } while (cursor);
    return out;
  };
  try {
    const init = await request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "gen-tools-doc", version: "0.0.0" },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    return {
      server: init.serverInfo,
      instructions: init.instructions ?? "",
      tools: await all("tools/list", "tools"),
      resources: await all("resources/list", "resources"),
      templates: await all("resources/templates/list", "resourceTemplates"),
      prompts: await all("prompts/list", "prompts"),
    };
  } finally {
    child.stdin.end();
    await new Promise((r) => {
      child.once("exit", r);
      globalThis.setTimeout(() => {
        child.kill();
        r(undefined);
      }, 5_000);
    });
    rmSync(home, { recursive: true, force: true });
  }
};

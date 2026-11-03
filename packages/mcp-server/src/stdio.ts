// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { Readable, Writable } from "node:stream";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { resetProcessPath } from "@perfoads/store";
import { createRuntime, type RuntimeOptions } from "./runtime.js";
import { createMcpServer } from "./server.js";

/**
 * Serves MCP over stdin/stdout. stdout carries only JSON-RPC: every log line goes to stderr.
 * Resolves when the client closes the connection; the store is closed by then.
 * `streams` replaces process stdin/stdout (tests).
 */
export const serveOverStdio = async (
  options: RuntimeOptions = {},
  streams?: { stdin: Readable; stdout: Writable },
): Promise<void> => {
  // A real server (process stdio): fixed safe PATH, never the one the AI app passed on.
  if (!streams) resetProcessPath();
  const rt = createRuntime(options);
  // The policy is loaded (and its hash logged) at start, then re-read whenever it changes.
  rt.loadPolicy();
  // Records older than retention_days (config.json) and stale snapshot temp files go.
  rt.pruneAtStart();
  const stdin = streams?.stdin ?? process.stdin;
  // Changes a stopped server left unfinished are re-checked by reading, never re-sent.
  void rt.reconcileChanges();
  // The plugin config.json names (pro_plugin), if any: loaded before the first request.
  // A problem with it is one warning on stderr; the server then runs without it.
  await rt.loadPlugin();
  return new Promise((resolve) => {
    const handle = serveStdio(() => createMcpServer(rt), {
      onerror: (err) => rt.logger.error("mcp transport error", { error: err }),
      ...(streams ? { transport: new StdioServerTransport(streams.stdin, streams.stdout) } : {}),
    });
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      stdin.off("end", stop);
      stdin.off("close", stop);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      void handle.close().finally(() => {
        rt.close();
        resolve();
      });
    };
    stdin.once("end", stop);
    stdin.once("close", stop);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
};

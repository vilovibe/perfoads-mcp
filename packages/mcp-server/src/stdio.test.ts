// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// The stdio shutdown path in-process: the store a request opened is closed once stdin ends.
// The store tracker (vitest setup) fails the test if the store is left open or deleted while open.

import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { RuntimeClosedError } from "./runtime.js";
import { serveOverStdio } from "./stdio.js";
import { testRuntime, testRuntimeOptions } from "./testing/fakes.js";

it("closes the store when the client ends stdin", async () => {
  const t = testRuntimeOptions();
  try {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let out = "";
    stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    const signals = process.listenerCount("SIGINT");
    const served = serveOverStdio(t.runtimeOptions, { stdin, stdout });

    const send = (msg: unknown) => stdin.write(`${JSON.stringify(msg)}\n`);
    const waitFor = async (id: number) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const msg = out
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .find((m) => m.id === id);
        if (msg) return msg;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`no reply to request ${id}`);
    };

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "stdio-shutdown-test", version: "0.0.0" },
      },
    });
    await waitFor(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    // doctor opens the store.
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "doctor", arguments: {} },
    });
    expect(await waitFor(2)).toHaveProperty("result");
    expect(existsSync(path.join(t.configDir, "store.sqlite"))).toBe(true);

    stdin.end();
    await served;
    expect(process.listenerCount("SIGINT")).toBe(signals);
  } finally {
    // Throws (simulated EBUSY) if the server left the store open.
    rmSync(t.root, { recursive: true, force: true });
  }
});

it("a closed runtime refuses to reopen the store", () => {
  const t = testRuntime();
  try {
    t.rt.store();
    t.rt.close();
    expect(() => t.rt.store()).toThrow(RuntimeClosedError);
    expect(existsSync(path.join(t.configDir, "store.sqlite"))).toBe(true);
  } finally {
    t.cleanup();
  }
});

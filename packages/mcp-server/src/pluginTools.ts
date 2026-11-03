// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Registers a loaded plugin's prompts and tools. Their arguments are strings; the tools are
// read-only, run under the same deadline as every tool, and an error is a tool error. A
// prompt or tool that can't be registered (its name is taken) is left out with one warning.

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { ServerPlugin } from "./plugin.js";
import type { Runtime } from "./runtime.js";
import { errorText, withDeadline } from "./toolKit.js";

const argsSchema = (args: Readonly<Record<string, string>> | undefined) =>
  z.object(
    Object.fromEntries(
      Object.entries(args ?? {}).map(([k, d]) => [k, z.string().max(500).describe(d)]),
    ),
  );

export const registerPluginItems = (
  server: McpServer,
  rt: Runtime,
  plugin: ServerPlugin,
  deadline: number,
): void => {
  for (const p of plugin.prompts ?? []) {
    try {
      server.registerPrompt(
        p.name,
        { title: p.title, description: p.description, argsSchema: argsSchema(p.args) },
        (args: Record<string, string>) => ({
          messages: [
            {
              role: "user" as const,
              content: { type: "text" as const, text: String(p.text(args)) },
            },
          ],
        }),
      );
    } catch (err) {
      rt.logger.warn(`pro plugin prompt ${p.name} left out: ${errorText(err, rt.secrets())}`);
    }
  }
  for (const t of plugin.tools ?? []) {
    try {
      server.registerTool(
        t.name,
        {
          title: t.title,
          description: t.description,
          inputSchema: argsSchema(t.args),
          annotations: {
            title: t.title,
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async (args: Record<string, string>): Promise<CallToolResult> => {
          try {
            const text = await withDeadline(
              Promise.resolve().then(() => t.run(args)),
              deadline,
            );
            return { content: [{ type: "text", text: String(text) }] };
          } catch (err) {
            return {
              isError: true,
              content: [{ type: "text", text: errorText(err, rt.secrets()) }],
            };
          }
        },
      );
    } catch (err) {
      rt.logger.warn(`pro plugin tool ${t.name} left out: ${errorText(err, rt.secrets())}`);
    }
  }
};

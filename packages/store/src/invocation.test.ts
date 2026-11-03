// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { afterEach, describe, expect, it } from "vitest";
import { howToRun, runParts, setInvocation } from "./index.js";

afterEach(() => setInvocation(undefined));

describe("howToRun", () => {
  it("not published: Node + the entry file by full path, quoted; never npx", () => {
    setInvocation({
      node: "/usr/local/bin/node",
      script: "/opt/My Tools/packages/cli/bin/perfoads-mcp.js",
      version: "0.1.0-alpha.0",
      published: false,
    });
    expect(howToRun("approvals open chg_1")).toBe(
      '"/usr/local/bin/node" "/opt/My Tools/packages/cli/bin/perfoads-mcp.js" approvals open chg_1',
    );
    expect(runParts()).toEqual({
      command: "/usr/local/bin/node",
      args: ["/opt/My Tools/packages/cli/bin/perfoads-mcp.js"],
    });
  });

  it("published: npx with the exact version", () => {
    setInvocation({ node: "/n", script: "/s.js", version: "1.2.3", published: true });
    expect(howToRun("init")).toBe("npx perfoads-mcp@1.2.3 init");
    expect(runParts()).toEqual({ command: "npx", args: ["-y", "perfoads-mcp@1.2.3"] });
  });

  it("no CLI (embedding): the bare program name, never npx", () => {
    expect(howToRun("doctor")).toBe("perfoads-mcp doctor");
  });
});

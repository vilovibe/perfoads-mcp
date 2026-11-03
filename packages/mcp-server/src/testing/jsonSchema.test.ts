// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { describe, expect, it } from "vitest";
import * as z from "zod";
import { checkJsonSchema } from "./jsonSchema.js";

const schema = z.toJSONSchema(
  z.object({
    a: z.string(),
    b: z.number().nullable(),
    c: z.array(z.object({ d: z.enum(["X", "Y"]), e: z.literal(true).optional() })),
    f: z.record(z.string(), z.number()),
  }),
);

describe("strict JSON Schema checker (tests only)", () => {
  it("accepts a fitting value", () => {
    expect(
      checkJsonSchema(schema, { a: "x", b: null, c: [{ d: "X", e: true }], f: { k: 1 } }),
    ).toEqual([]);
  });

  it("rejects an extra key, a missing key, a wrong type and a wrong enum", () => {
    const errors = checkJsonSchema(schema, {
      a: 1,
      c: [{ d: "Z", z: 1 }],
      f: { k: "1" },
      extra: 1,
    });
    expect(errors.join("\n")).toMatch(/\$\.a: expected string/);
    expect(errors.join("\n")).toMatch(/missing required "b"/);
    expect(errors.join("\n")).toMatch(/unexpected key "extra"/);
    expect(errors.join("\n")).toMatch(/unexpected key "z"/);
    expect(errors.join("\n")).toMatch(/not in enum/);
    expect(errors.join("\n")).toMatch(/\$\.f\.k: expected number/);
  });

  it("refuses schema keywords it does not know, instead of passing", () => {
    expect(checkJsonSchema({ type: "string", pattern: "^x" }, "y")[0]).toMatch(/not supported/);
  });
});

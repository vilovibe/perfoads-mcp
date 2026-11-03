// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// A small, strict JSON Schema checker for tests (no runtime dependency). It knows exactly the
// keywords zod 4's toJSONSchema writes for our schemas and refuses any other keyword, so a
// schema feature it does not understand can never pass silently. Objects without
// additionalProperties are treated as closed too: an unexpected key always fails.

type Schema = Record<string, unknown>;

const KNOWN = new Set([
  "$schema",
  "description",
  "type",
  "enum",
  "const",
  "anyOf",
  "oneOf",
  "properties",
  "required",
  "additionalProperties",
  "propertyNames",
  "items",
]);

const typeOf = (v: unknown): string => {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
};

const typeMatches = (want: string, v: unknown): boolean => {
  const got = typeOf(v);
  return want === got || (want === "number" && got === "integer");
};

/** Every mismatch as "path: reason". Empty = valid. */
export const checkJsonSchema = (schema: unknown, value: unknown, path = "$"): string[] => {
  if (typeof schema !== "object" || schema === null) return [`${path}: schema is not an object`];
  const s = schema as Schema;
  for (const k of Object.keys(s)) {
    if (!KNOWN.has(k)) return [`${path}: schema keyword "${k}" not supported by the checker`];
  }
  const errors: string[] = [];
  if (s.anyOf !== undefined || s.oneOf !== undefined) {
    const options = (s.anyOf ?? s.oneOf) as unknown[];
    const results = options.map((o) => checkJsonSchema(o, value, path));
    const passing = results.filter((r) => r.length === 0).length;
    if (s.oneOf !== undefined ? passing !== 1 : passing === 0) {
      errors.push(
        `${path}: matches ${passing} of ${options.length} options (${results.flat()[0] ?? ""})`,
      );
    }
  }
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some((t) => typeMatches(t, value))) {
      return [...errors, `${path}: expected ${types.join("|")}, got ${typeOf(value)}`];
    }
  }
  if (s.enum !== undefined && !(s.enum as unknown[]).includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  }
  if (s.const !== undefined && s.const !== value) {
    errors.push(`${path}: expected const ${JSON.stringify(s.const)}`);
  }
  if (
    typeOf(value) === "object" &&
    (s.properties !== undefined || s.additionalProperties !== undefined || s.type === "object")
  ) {
    const obj = value as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, unknown>;
    for (const r of (s.required ?? []) as string[]) {
      if (!(r in obj)) errors.push(`${path}: missing required "${r}"`);
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k in props) {
        errors.push(...checkJsonSchema(props[k], v, `${path}.${k}`));
      } else if (typeof s.additionalProperties === "object" && s.additionalProperties !== null) {
        errors.push(...checkJsonSchema(s.additionalProperties, v, `${path}.${k}`));
      } else {
        errors.push(`${path}: unexpected key "${k}"`);
      }
    }
  }
  if (typeOf(value) === "array" && s.items !== undefined) {
    (value as unknown[]).forEach((v, i) =>
      errors.push(...checkJsonSchema(s.items, v, `${path}[${i}]`)),
    );
  }
  return errors;
};

interface SchemaClient {
  listTools: () => Promise<{ tools: { name: string; outputSchema?: unknown }[] }>;
  readResource: (p: { uri: string }) => Promise<{ contents: unknown[] }>;
}

/**
 * The structuredContent of a tool result, checked strictly against the schema the server
 * serves for that tool (outputSchema in tools/list, or the schema://tools/{name} resource).
 * Throws with every mismatch.
 */
export const strictStructured = async (
  client: SchemaClient,
  tool: string,
  res: { structuredContent?: unknown },
): Promise<unknown> => {
  let schema: unknown;
  const listed = (await client.listTools()).tools.find((t) => t.name === tool);
  if (listed?.outputSchema) {
    schema = listed.outputSchema;
  } else {
    const read = await client.readResource({ uri: `schema://tools/${tool}` });
    const first = read.contents[0] as { text?: string } | undefined;
    schema = JSON.parse(first?.text ?? "null");
  }
  const errors = checkJsonSchema(schema, res.structuredContent);
  if (errors.length)
    throw new Error(
      `${tool} structuredContent does not fit its schema:\n${errors.slice(0, 10).join("\n")}`,
    );
  return res.structuredContent;
};

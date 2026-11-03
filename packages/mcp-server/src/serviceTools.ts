// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Tools on Google Ads services other than GAQL search: keyword_ideas (KeywordPlanIdeaService)
// and describe_resource (GoogleAdsFieldService). Same rules as the read tools: checked input
// before any Google call, structuredContent + text mirror, no outputSchema (served at
// schema://tools/{name}), Google's free text wrapped.

import { type CallToolResult, type McpServer } from "@modelcontextprotocol/server";
import {
  AdsNotAllowedError,
  classifyAccessError,
  GOOGLE_ADS_API_VERSION,
} from "@perfoads/ads-client";
import {
  compareIdeas,
  keywordIdeaRow,
  keywordIdeasInput,
  KeywordIdeaRowSchema,
  normalise,
  ReadInputError,
  UNTRUSTED_NOTE,
  untrustedText,
} from "@perfoads/reads";
import * as z from "zod";
import { GAQL_RESOURCES } from "./gaqlResources.js";
import type { Runtime } from "./runtime.js";
import { errorText, ToolInputError, withDeadline } from "./toolKit.js";
import { UntrustedSchema } from "./untrusted.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const TEXT_ROWS = 10;

// ---- keyword_ideas ----

const KeywordIdeasInputSchema = z.object({
  customer_id: z.string().describe("e.g. 123-456-7890 (see list_accounts)"),
  keywords: z.array(z.string().max(80)).max(20).optional(),
  url: z.string().max(2048).optional().describe("Seed page"),
  language: z.string().max(20).optional().describe("en (default), de, ... or id 1000"),
  geo_target_ids: z
    .array(z.string().max(12))
    .max(10)
    .optional()
    .describe("e.g. 2840 = USA; none = all"),
  include_search_partners: z.boolean().optional(),
  max_results: z.number().int().min(1).max(200).optional().describe("Default 50"),
});

const KeywordIdeasOutput = z.object({
  customerId: z.string(),
  currencyCode: z.string().nullable(),
  status: z.enum(["ok", "not_allowed"]),
  message: z.string().nullable().describe("Why not allowed, in plain words"),
  languageId: z.string(),
  geoTargetIds: z.array(z.string()),
  network: z.string(),
  seedKeywords: z.array(UntrustedSchema),
  seedUrl: UntrustedSchema.nullable(),
  returnedIdeas: z.number(),
  mayHaveMoreIdeas: z.boolean(),
  ideas: z.array(KeywordIdeaRowSchema),
  notes: z.array(z.string()),
  untrustedNote: z.string(),
});

// ---- describe_resource ----

const DescribeInput = z.object({
  resource: z.string().max(80).describe("A GAQL resource, e.g. campaign, ad_group_ad"),
  max_rows: z.number().int().min(1).max(300).optional().describe("Fields per reply, default 100"),
  cursor: z.string().max(200).optional().describe("next_cursor from the last reply"),
});

const FieldSchema = z.object({
  name: z.string(),
  dataType: z.string().nullable(),
  selectable: z.boolean(),
  filterable: z.boolean(),
  sortable: z.boolean(),
  repeated: z.boolean(),
  enumValues: z.string().nullable().describe("Comma-separated, first 40; null = not an enum"),
});

const DescribeOutput = z.object({
  resource: z.string(),
  apiVersion: z.string(),
  totalFields: z.number(),
  offset: z.number(),
  returnedFields: z.number(),
  fields: z.array(FieldSchema),
  metrics: z.array(z.string()).nullable().describe("Selectable with it; first page only"),
  segments: z.array(z.string()).nullable().describe("First page only"),
  relatedResources: z
    .array(z.string())
    .nullable()
    .describe("Attributes you can join; first page only"),
  next_cursor: z.string().nullable(),
});

type Field = z.infer<typeof FieldSchema>;
interface Catalogue {
  fields: Field[];
  metrics: string[];
  segments: string[];
  relatedResources: string[];
}

export const SERVICE_OUTPUT_SCHEMAS = {
  keyword_ideas: KeywordIdeasOutput,
  describe_resource: DescribeOutput,
} as const;

const FIELD_NAME = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const ENUM_VALUES_SHOWN = 40;
const FIELD_PAGES_MAX = 5;
/** Target size of one describe_resource reply (fields + first-page lists). */
const DESCRIBE_MAX_BYTES = 40_000;
/** Ideas asked for in the one call; sorted by searches, then cut to max_results. */
const IDEAS_PAGE_SIZE = 1000;

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? "", "utf8");

const errorResult = (rt: Runtime, err: unknown): CallToolResult => {
  rt.noteError(err);
  return { isError: true, content: [{ type: "text", text: errorText(err, rt.secrets()) }] };
};

const mapField = (r: Record<string, unknown>): Field | null => {
  const name = r.name;
  if (typeof name !== "string" || !FIELD_NAME.test(name)) return null;
  const values = (Array.isArray(r.enumValues) ? r.enumValues : [])
    .map(normalise.enumValue)
    .filter((v): v is string => v !== null && v !== "UNSPECIFIED" && v !== "UNKNOWN");
  return {
    name,
    dataType: normalise.enumValue(r.dataType),
    selectable: r.selectable === true,
    filterable: r.filterable === true,
    sortable: r.sortable === true,
    repeated: r.isRepeated === true,
    enumValues: values.length
      ? values.slice(0, ENUM_VALUES_SHOWN).join(",") +
        (values.length > ENUM_VALUES_SHOWN ? `,(+${values.length - ENUM_VALUES_SHOWN} more)` : "")
      : null,
  };
};

const cursorOf = (resource: string, offset: number) =>
  Buffer.from(JSON.stringify({ v: 1, r: resource, o: offset })).toString("base64url");

const offsetOf = (cursor: string | undefined, resource: string): number => {
  if (!cursor) return 0;
  try {
    const c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      v?: unknown;
      r?: unknown;
      o?: unknown;
    };
    if (c.v === 1 && c.r === resource && Number.isInteger(c.o) && (c.o as number) >= 0) {
      return c.o as number;
    }
  } catch {
    // falls through to the refusal
  }
  throw new ToolInputError("The cursor is not valid for this resource. Call again without it.");
};

/** Registers keyword_ideas and describe_resource. */
export const registerServiceTools = (server: McpServer, rt: Runtime, deadline: number): void => {
  // Google's field catalogue changes only with the API version: kept for the server's life.
  const catalogues = new Map<string, Catalogue>();

  server.registerTool(
    "keyword_ideas",
    {
      title: "Keyword ideas",
      description:
        'Keyword Planner ideas from seed keywords and/or a URL: searches, competition, bids. Needs Basic/Standard access. Example: {"customer_id":"123-456-7890","keywords":["trail running shoes"]}',
      inputSchema: KeywordIdeasInputSchema,
      annotations: { title: "Keyword ideas", ...READ_ONLY },
    },
    async (args) => {
      const controller = new AbortController();
      try {
        const input = keywordIdeasInput(args);
        const account = await rt.resolveAccount(args.customer_id);
        const base = {
          customerId: account.customerId,
          currencyCode: normalise.currencyCode(account.currencyCode),
          languageId: input.languageId,
          geoTargetIds: input.geoTargetIds,
          network: input.network,
          seedKeywords: input.keywords.map(untrustedText),
          seedUrl: input.url === null ? null : untrustedText(input.url),
          untrustedNote: UNTRUSTED_NOTE,
        };
        const notAllowed = (message: string): CallToolResult => ({
          content: [{ type: "text", text: `Keyword ideas are not allowed here: ${message}` }],
          structuredContent: {
            ...base,
            status: "not_allowed" as const,
            message,
            returnedIdeas: 0,
            mayHaveMoreIdeas: false,
            ideas: [],
            notes: [],
          },
        });
        if (account.isTestAccount) {
          return notAllowed(
            "This is a Google Ads test account, and test accounts give no Keyword Planner data. Keyword ideas need a real account and Basic or Standard API access; Explorer and Test access get none.",
          );
        }
        const level = rt.accessLevel().level;
        const notes =
          level === "unknown"
            ? [
                "The API access level is not set, so the call was tried. Google refuses keyword ideas on Explorer or Test access; set it with the init command.",
              ]
            : [];
        let page;
        try {
          page = await withDeadline(
            rt.ads().generateKeywordIdeas({
              customerId: account.customerId,
              loginCustomerId: account.loginCustomerId,
              accessLevel: level,
              language: `languageConstants/${input.languageId}`,
              geoTargetConstants: input.geoTargetIds.map((g) => `geoTargetConstants/${g}`),
              keywords: input.keywords,
              ...(input.url ? { url: input.url } : {}),
              network: input.network,
              pageSize: IDEAS_PAGE_SIZE,
              signal: controller.signal,
              deadlineMs: deadline,
            }),
            deadline,
            () => controller.abort(),
          );
        } catch (err) {
          const refused =
            (err instanceof AdsNotAllowedError && err.reason === "access_level") ||
            classifyAccessError(err) !== null;
          if (!refused) throw err;
          rt.noteError(err);
          return notAllowed(errorText(err, rt.secrets()));
        }
        const ideas = page.ideas.map(keywordIdeaRow).sort(compareIdeas).slice(0, input.maxResults);
        const structured = {
          ...base,
          status: "ok" as const,
          message: null,
          returnedIdeas: ideas.length,
          mayHaveMoreIdeas: page.nextPageToken !== undefined || page.ideas.length > ideas.length,
          ideas,
          notes,
        };
        const cur = base.currencyCode ? ` ${base.currencyCode}` : "";
        const lines = [
          `${ideas.length} keyword idea${ideas.length === 1 ? "" : "s"} for ${account.customerId} (language ${input.languageId}, ${input.geoTargetIds.length ? `locations ${input.geoTargetIds.join(", ")}` : "all locations"}), most searched first.`,
          ...ideas
            .slice(0, TEXT_ROWS)
            .map(
              (i, n) =>
                `${n + 1}. ${JSON.stringify(i.text)}: ${i.avgMonthlySearches ?? "?"} searches/month, ${i.competition ?? "?"} competition, top-of-page bid ${i.lowTopOfPageBid ?? "?"}-${i.highTopOfPageBid ?? "?"}${cur}`,
            ),
          ...(ideas.length > TEXT_ROWS
            ? [`(${ideas.length - TEXT_ROWS} more in structuredContent)`]
            : []),
          ...notes,
          "",
          UNTRUSTED_NOTE,
        ];
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: structured,
        };
      } catch (err) {
        return errorResult(rt, err);
      }
    },
  );

  const loadCatalogue = async (resource: string, signal: AbortSignal): Promise<Catalogue> => {
    const cached = catalogues.get(resource);
    if (cached) return cached;
    const fields: Field[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < FIELD_PAGES_MAX; i++) {
      const page = await rt.ads().searchGoogleAdsFields({
        query: `SELECT name, data_type, selectable, filterable, sortable, is_repeated, enum_values WHERE name LIKE '${resource}.%'`,
        pageSize: 1000,
        pageToken,
        signal,
        deadlineMs: deadline,
      });
      for (const r of page.results) {
        const f = mapField(r);
        // LIKE treats _ as a wildcard: keep only this resource's own fields.
        if (f && f.name.startsWith(`${resource}.`)) fields.push(f);
      }
      pageToken = page.nextPageToken;
      if (!pageToken) break;
    }
    const self = await rt.ads().searchGoogleAdsFields({
      query: `SELECT name, selectable_with WHERE name = '${resource}'`,
      signal,
      deadlineMs: deadline,
    });
    const withList = self.results[0]?.selectableWith;
    const names = (Array.isArray(withList) ? withList : []).filter(
      (n): n is string => typeof n === "string" && FIELD_NAME.test(n),
    );
    const catalogue: Catalogue = {
      fields: fields.sort((a, b) => a.name.localeCompare(b.name)),
      metrics: names.filter((n) => n.startsWith("metrics.")).sort(),
      segments: names.filter((n) => n.startsWith("segments.")).sort(),
      relatedResources: names.filter((n) => !n.includes(".")).sort(),
    };
    // Only a complete catalogue is kept (a page cut short would stay wrong all day).
    if (!pageToken) catalogues.set(resource, catalogue);
    return catalogue;
  };

  server.registerTool(
    "describe_resource",
    {
      title: "Describe a GAQL resource",
      description:
        'Fields of one GAQL resource from Google\'s field catalogue (type, selectable, filterable, sortable, enum values) plus the metrics and segments you can select with it. Example: {"resource":"campaign"}',
      inputSchema: DescribeInput,
      annotations: { title: "Describe a GAQL resource", ...READ_ONLY },
    },
    async (args) => {
      const controller = new AbortController();
      try {
        const resource = args.resource.trim();
        if (!GAQL_RESOURCES.has(resource)) {
          throw new ReadInputError(
            `"${resource.slice(0, 40)}" is not a GAQL resource this server reads. Use a name like campaign or ad_group_ad.`,
          );
        }
        const offset = offsetOf(args.cursor, resource);
        const pageSize = args.max_rows ?? 100;
        const cat = await withDeadline(loadCatalogue(resource, controller.signal), deadline, () =>
          controller.abort(),
        );
        const first = offset === 0;
        // Page = up to max_rows fields AND within the byte budget (always at least 1 field).
        let budget =
          DESCRIBE_MAX_BYTES -
          1_000 -
          (first ? bytes(cat.metrics) + bytes(cat.segments) + bytes(cat.relatedResources) : 0);
        const fields: Field[] = [];
        for (const f of cat.fields.slice(offset, offset + pageSize)) {
          const size = bytes(f) + 1;
          if (fields.length > 0 && size > budget) break;
          fields.push(f);
          budget -= size;
        }
        const next = offset + fields.length;
        const structured = {
          resource,
          apiVersion: GOOGLE_ADS_API_VERSION,
          totalFields: cat.fields.length,
          offset,
          returnedFields: fields.length,
          fields,
          metrics: first ? cat.metrics : null,
          segments: first ? cat.segments : null,
          relatedResources: first ? cat.relatedResources : null,
          next_cursor: next < cat.fields.length ? cursorOf(resource, next) : null,
        };
        const text = [
          `${resource} (${GOOGLE_ADS_API_VERSION}): ${cat.fields.length} fields, ${cat.metrics.length} metrics and ${cat.segments.length} segments selectable with it. Fields ${offset + 1}-${next}:`,
          fields
            .map((f) => `${f.name} ${f.dataType ?? "?"}${f.filterable ? "" : " (not filterable)"}`)
            .join("\n"),
          ...(structured.next_cursor ? ["More fields: call again with next_cursor."] : []),
        ].join("\n");
        return { content: [{ type: "text", text }], structuredContent: structured };
      } catch (err) {
        return errorResult(rt, err);
      }
    },
  );
};

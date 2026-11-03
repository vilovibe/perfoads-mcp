// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// The typed read tools. Each one runs a reader from @perfoads/reads and returns
// structuredContent (summary first, then one page of rows) plus a short text mirror.
// To keep tools/list small (it is sent to the model on every turn) these tools carry no
// outputSchema; the JSON Schema of each result is the resource schema://tools/{name}.

import {
  ResourceTemplate,
  type CallToolResult,
  type McpServer,
} from "@modelcontextprotocol/server";
import {
  AdAssetRowSchema,
  adsAssetsInput,
  adsAssetsReader,
  AdsAssetsSummarySchema,
  AudienceRowSchema,
  audiencesInput,
  audiencesReader,
  AudienceSummarySchema,
  changeHistoryInput,
  changeHistoryReader,
  ChangeRowSchema,
  ChangeSummarySchema,
  ConversionActionRowSchema,
  conversionsReader,
  ConversionSummarySchema,
  GoalSchema,
  MAX_CHANGE_DAYS,
  AdGroupRowSchema,
  AdGroupSummarySchema,
  adGroupsReader,
  BudgetRowSchema,
  BudgetSummarySchema,
  budgetsReader,
  CampaignRowSchema,
  CampaignSummarySchema,
  campaignsReader,
  ChannelRowSchema,
  DateRangeInputSchema,
  DateRangeSchema,
  filterInput,
  KeywordRowSchema,
  KeywordSummarySchema,
  keywordsReader,
  MAX_PAGE_ROWS,
  MIN_PART_MS,
  normalise,
  NegativeRowSchema,
  NegativeSummarySchema,
  negativesReader,
  OverviewSummarySchema,
  overviewReader,
  NO_CATEGORY_LABEL,
  PMAX_CATEGORIES_SHOWN,
  PmaxCategorySchema,
  readNothing,
  resolveDateRange,
  runReader,
  SearchTermRowSchema,
  SearchTermSummarySchema,
  searchTermsReader,
  SharedListSchema,
  StrategySchema,
  UNTRUSTED_NOTE,
  untrustedOrNull,
  type DateRange,
  type ReaderContext,
  type ReaderDef,
  type ReaderResult,
} from "@perfoads/reads";
import type { AdsAccount } from "@perfoads/ads-client";
import * as z from "zod";
import type { Runtime } from "./runtime.js";
import { CHECK_OUTPUT_SCHEMAS } from "./checkTools.js";
import { SERVICE_OUTPUT_SCHEMAS } from "./serviceTools.js";
import { errorText, withDeadline } from "./toolKit.js";
import { UntrustedSchema } from "./untrusted.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const TEXT_ROWS = 10;

// ---- input pieces ----

const customerId = z.string().describe("e.g. 123-456-7890 (see list_accounts)");
const maxRows = z
  .number()
  .int()
  .min(1)
  .max(MAX_PAGE_ROWS)
  .optional()
  .describe("Rows per reply, default 25");
const cursor = z.string().max(300).optional().describe("next_cursor from the last reply");
const campaignId = z.string().optional().describe("Only this campaign id");
const adGroupId = z.string().optional().describe("Only this ad group id");
const status = z.enum(["ENABLED", "PAUSED"]).optional();

const PagedInput = z.object({
  customer_id: customerId,
  date_range: DateRangeInputSchema.optional(),
  campaign_id: campaignId,
  status,
  max_rows: maxRows,
  cursor,
});
const AdGroupInput = PagedInput.extend({ ad_group_id: adGroupId });
const SearchTermInput = PagedInput.omit({ status: true }).extend({
  ad_group_id: adGroupId,
  include_pmax_categories: z
    .boolean()
    .optional()
    .describe("Also read Performance Max search categories (top 5 PMax campaigns)"),
});
const PlainInput = z.object({ customer_id: customerId, max_rows: maxRows, cursor });
const AdsAssetsInput = AdGroupInput.extend({
  kind: z.enum(["ads", "assets"]).optional(),
});
const AudiencesInput = PagedInput.omit({ status: true }).extend({
  ad_group_id: adGroupId,
  kind: z.enum(["lists", "targeting"]).optional(),
});
const ConversionsInput = z.object({
  customer_id: customerId,
  date_range: DateRangeInputSchema.optional(),
  max_rows: maxRows,
  cursor,
});
const ChangeHistoryInput = PlainInput.extend({
  days: z.number().int().min(1).max(MAX_CHANGE_DAYS).optional().describe("Default 14"),
  campaign_id: campaignId,
  resource_type: z.string().max(40).optional().describe("e.g. CAMPAIGN, AD_GROUP_AD"),
});
const OverviewInput = z.object({
  customer_id: customerId,
  date_range: DateRangeInputSchema.optional(),
});

// ---- output envelope ----

const PartSchema = z.object({
  part: z.string(),
  status: z.enum(["ok", "failed", "not_allowed", "skipped"]),
  message: UntrustedSchema.nullable(),
  rowsRead: z.number(),
  capped: z.boolean().describe("Hit the row cap: a sample"),
  timeCut: z.boolean().describe("Stopped or skipped because time ran short"),
  fallback: z.boolean().describe("Read with fewer fields after Google refused the full query"),
  group: z
    .object({
      parts: z.number(),
      ok: z.number(),
      failed: z.number(),
      notAllowed: z.number(),
      skipped: z.number(),
      fallback: z.number(),
      notReadKeys: z.array(z.string()).describe("First 20"),
      notReadTotal: z.number(),
    })
    .nullable()
    .describe("One entry for many reads of one kind (e.g. one per campaign)"),
});

const envelope = <R extends z.ZodType, S extends z.ZodType, E extends z.ZodRawShape>(
  row: R,
  summary: S,
  extra: E,
) =>
  z.object({
    customerId: z.string(),
    currencyCode: z.string().nullable(),
    dateRange: DateRangeSchema.nullable(),
    status: z.enum(["ok", "failed", "not_allowed", "skipped"]),
    parts: z.array(PartSchema),
    totalsPartial: z.boolean().describe("true: a part hit the row cap or failed (see notes)"),
    notes: z.array(z.string()),
    summary,
    ...extra,
    totalRows: z.number().describe("Rows read; summary covers all of them"),
    offset: z.number(),
    returnedRows: z.number(),
    rows: z.array(row),
    next_cursor: z.string().nullable(),
    untrustedNote: z.string(),
  });

export const READ_OUTPUT_SCHEMAS = {
  get_account_overview: envelope(ChannelRowSchema, OverviewSummarySchema, {}),
  get_campaigns: envelope(CampaignRowSchema, CampaignSummarySchema, {}),
  get_ad_groups: envelope(AdGroupRowSchema, AdGroupSummarySchema, {}),
  get_keywords: envelope(KeywordRowSchema, KeywordSummarySchema, {}),
  get_search_terms: envelope(SearchTermRowSchema, SearchTermSummarySchema, {
    pmaxCategories: z
      .array(PmaxCategorySchema)
      .nullable()
      .describe(
        "Most clicks first, at most max_rows (and 50); summary.pmaxCategories counts all read; first page only; null when not asked for",
      ),
  }),
  get_budgets_and_bidding: envelope(BudgetRowSchema, BudgetSummarySchema, {
    biddingStrategies: z.array(StrategySchema).nullable().describe("First 50; first page only"),
  }),
  get_negatives: envelope(NegativeRowSchema, NegativeSummarySchema, {
    sharedLists: z.array(SharedListSchema).nullable().describe("First 50; first page only"),
  }),
  get_ads_and_assets: envelope(AdAssetRowSchema, AdsAssetsSummarySchema, {}),
  get_audiences: envelope(AudienceRowSchema, AudienceSummarySchema, {}),
  get_conversions: envelope(ConversionActionRowSchema, ConversionSummarySchema, {
    customerGoals: z.array(GoalSchema).nullable().describe("Account goals; first page only"),
  }),
  get_change_history: envelope(ChangeRowSchema, ChangeSummarySchema, {}),
} as const;

// ---- running ----

/** Time rules for the read tools. Tests shrink them. */
export interface ReadTiming {
  /** Kept free at the end of the tool deadline for building the reply. */
  replyMarginMs: number;
  /** No query (or next Google page) is started with less time than this left. */
  minPartMs: number;
}

export const DEFAULT_READ_TIMING: ReadTiming = { replyMarginMs: 5_000, minPartMs: MIN_PART_MS };

interface Call<I, X> {
  customerId: string;
  page: { cursor?: string | undefined; pageSize?: number | undefined };
  /** Builds the checked reader input. Runs before Google is called. */
  input: () => I;
  /** Rebuilds the input once the account is known (e.g. its time zone). */
  forAccount?: (input: I, account: AdsAccount) => I;
  dateRange: (input: I) => DateRange | null;
  /** Output sections from the reader's extra (null on later pages). */
  extra: (x: X | null) => Record<string, unknown>;
}

const errorResult = (rt: Runtime, err: unknown): CallToolResult => {
  rt.noteError(err);
  return { isError: true, content: [{ type: "text", text: errorText(err, rt.secrets()) }] };
};

const textOf = <I, R, S, X, F>(
  def: ReaderDef<I, R, S, X, F>,
  result: ReaderResult<R, S, X>,
  ctx: ReaderContext,
  input: I,
): string => {
  const lines = [def.summaryLine(result.summary, ctx, input)];
  if (result.status !== "ok") lines.push(`Status: ${result.status}.`);
  lines.push(...result.notes);
  const top = result.rows.slice(0, TEXT_ROWS);
  if (top.length) {
    lines.push(
      "",
      `Rows ${result.offset + 1}-${result.offset + top.length} of ${result.totalRows}:`,
    );
    lines.push(...top.map((r, i) => `${result.offset + i + 1}. ${def.rowLine(r, ctx)}`));
  }
  if (result.rows.length > top.length) {
    lines.push(`(${result.rows.length - top.length} more rows in this reply's structuredContent)`);
  }
  if (result.nextCursor) lines.push("More rows: call again with next_cursor.");
  lines.push("", UNTRUSTED_NOTE);
  return lines.join("\n");
};

const runReadTool = async <I, R, S, X, F>(
  rt: Runtime,
  deadline: number,
  timing: ReadTiming,
  def: ReaderDef<I, R, S, X, F>,
  call: Call<I, X>,
): Promise<CallToolResult> => {
  // Stops requests still in flight when the tool deadline fires (no orphaned reads).
  const controller = new AbortController();
  const deadlineAt = rt.now() + deadline - timing.replyMarginMs;
  const left = () => deadlineAt - rt.now();
  try {
    const work = async () => {
      const checked = call.input();
      const account = await rt.resolveAccount(call.customerId);
      const input = call.forAccount ? call.forAccount(checked, account) : checked;
      const ctx: ReaderContext = {
        customerId: account.customerId,
        currencyCode: account.currencyCode ?? null,
        isManager: account.isManager,
        search: async (query, maxRowsRead) => {
          const res = await rt.ads().searchAll({
            customerId: account.customerId,
            loginCustomerId: account.loginCustomerId,
            query,
            maxRows: maxRowsRead,
            signal: controller.signal,
            deadlineMs: Math.max(1, left()),
            shouldStop: () => left() < timing.minPartMs,
          });
          return { rows: res.rows, stoppedEarly: res.stoppedEarly };
        },
        // Plain here: the whole part message is wrapped in parts[].message.
        describeError: (err) => errorText(err, rt.secrets(), undefined, { wrapGoogle: false }),
        onError: (err) => rt.noteError(err),
        deadlineAt,
        now: rt.now,
        minPartMs: timing.minPartMs,
      };
      const result = await runReader(def, ctx, input, call.page);
      return { ctx, input, result };
    };
    const { ctx, input, result } = await withDeadline(work(), deadline, () => controller.abort());
    if (readNothing(result)) return errorResult(rt, result.firstError);
    const range = call.dateRange(input);
    const structured = {
      customerId: ctx.customerId,
      currencyCode: ctx.currencyCode,
      dateRange: range
        ? { preset: range.preset, startDate: range.startDate, endDate: range.endDate }
        : null,
      status: result.status,
      parts: result.parts.map((p) => ({
        part: p.part,
        status: p.status,
        message: untrustedOrNull(p.message),
        rowsRead: p.rowsRead,
        capped: p.capped,
        timeCut: p.timeCut,
        fallback: p.fallback,
        group: p.group,
      })),
      totalsPartial: result.totalsPartial,
      notes: result.notes,
      summary: result.summary,
      ...call.extra(result.extra),
      totalRows: result.totalRows,
      offset: result.offset,
      returnedRows: result.rows.length,
      rows: result.rows,
      next_cursor: result.nextCursor,
      untrustedNote: UNTRUSTED_NOTE,
    };
    return {
      content: [{ type: "text", text: textOf(def, result, ctx, input) }],
      structuredContent: structured,
    };
  } catch (err) {
    return errorResult(rt, err);
  }
};

const page = (args: { max_rows?: number | undefined; cursor?: string | undefined }) => ({
  cursor: args.cursor,
  pageSize: args.max_rows,
});
const noExtra = () => ({});

/** Registers the 12 typed read tools and the schema://tools/{name} resource. */
export const registerReadTools = (
  server: McpServer,
  rt: Runtime,
  deadline: number,
  timing: ReadTiming = DEFAULT_READ_TIMING,
  /** Result schemas served instead of the plain ones (a loaded plugin's run_checks). */
  schemaOverrides?: Readonly<Record<string, z.ZodType>>,
): void => {
  // Every tool without an outputSchema in tools/list has its result schema here.
  const served: Record<string, z.ZodType> = {
    ...READ_OUTPUT_SCHEMAS,
    ...SERVICE_OUTPUT_SCHEMAS,
    ...CHECK_OUTPUT_SCHEMAS,
    ...schemaOverrides,
  };
  const names = Object.keys(served);
  server.registerResource(
    "tool-output-schemas",
    new ResourceTemplate("schema://tools/{name}", {
      list: () => ({
        resources: names.map((n) => ({
          uri: `schema://tools/${n}`,
          name: `${n} result schema`,
          mimeType: "application/schema+json",
        })),
      }),
    }),
    {
      title: "Result schemas of the read tools",
      description: "JSON Schema of each read tool's structuredContent.",
      mimeType: "application/schema+json",
    },
    (uri, variables) => {
      const name = String(variables.name ?? "");
      const schema = Object.hasOwn(served, name) ? served[name] : undefined;
      if (!schema) throw new Error(`No schema for "${name.slice(0, 40)}".`);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/schema+json",
            text: JSON.stringify(z.toJSONSchema(schema)),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_account_overview",
    {
      title: "Account overview",
      description:
        'One account at a glance: name, currency, time zone, totals for the date range (cost, clicks, conversions, value, ROAS), campaigns per channel. Example: {"customer_id":"123-456-7890"}',
      inputSchema: OverviewInput,
      annotations: { title: "Account overview", ...READ_ONLY },
    },
    async (args) =>
      runReadTool(rt, deadline, timing, overviewReader, {
        customerId: args.customer_id,
        page: { pageSize: MAX_PAGE_ROWS },
        input: () => ({ dateRange: resolveDateRange(args.date_range) }),
        dateRange: (i) => i.dateRange,
        extra: noExtra,
      }),
  );

  server.registerTool(
    "get_campaigns",
    {
      title: "Campaigns",
      description:
        'Campaigns that are not removed, plus removed ones that had activity in the date range: status, channel, budget, bidding, targets, metrics, Search impression share; highest cost first. Example: {"customer_id":"123-456-7890","date_range":"LAST_7_DAYS"}',
      inputSchema: PagedInput,
      annotations: { title: "Campaigns", ...READ_ONLY },
    },
    async (args) =>
      runReadTool(rt, deadline, timing, campaignsReader, {
        customerId: args.customer_id,
        page: page(args),
        input: () => filterInput(args),
        dateRange: (i) => i.dateRange,
        extra: noExtra,
      }),
  );

  server.registerTool(
    "get_ad_groups",
    {
      title: "Ad groups",
      description:
        'Ad groups (not removed): status, type, CPC bid, metrics; highest cost first. Example: {"customer_id":"123-456-7890","campaign_id":"111"}',
      inputSchema: AdGroupInput,
      annotations: { title: "Ad groups", ...READ_ONLY },
    },
    async (args) =>
      runReadTool(rt, deadline, timing, adGroupsReader, {
        customerId: args.customer_id,
        page: page(args),
        input: () => filterInput(args),
        dateRange: (i) => i.dateRange,
        extra: noExtra,
      }),
  );

  server.registerTool(
    "get_keywords",
    {
      title: "Keywords",
      description:
        'Keywords with impressions: match type, quality score parts, bids, page CPC estimates, metrics; highest cost first. Example: {"customer_id":"123-456-7890","ad_group_id":"222"}',
      inputSchema: AdGroupInput,
      annotations: { title: "Keywords", ...READ_ONLY },
    },
    async (args) =>
      runReadTool(rt, deadline, timing, keywordsReader, {
        customerId: args.customer_id,
        page: page(args),
        input: () => filterInput(args),
        dateRange: (i) => i.dateRange,
        extra: noExtra,
      }),
  );

  server.registerTool(
    "get_search_terms",
    {
      title: "Search terms",
      description:
        'Search terms with clicks (Search + Performance Max) with triggering keyword, status and metrics; highest cost first; cost on terms with no conversions. Example: {"customer_id":"123-456-7890","date_range":"2026-09-01..2026-09-30"}',
      inputSchema: SearchTermInput,
      annotations: { title: "Search terms", ...READ_ONLY },
    },
    async (args) =>
      runReadTool(rt, deadline, timing, searchTermsReader, {
        customerId: args.customer_id,
        page: page(args),
        input: () => ({
          ...filterInput(args),
          includePmaxCategories: args.include_pmax_categories === true,
        }),
        dateRange: (i) => i.dateRange,
        // max_rows caps the categories too (summary.pmaxCategories counts every one read);
        // an empty label is Google's hidden category, said in words here only (the data
        // keeps Google's label as sent)
        extra: (x) => ({
          pmaxCategories:
            x?.pmaxCategories
              ?.slice(0, Math.min(PMAX_CATEGORIES_SHOWN, args.max_rows ?? PMAX_CATEGORIES_SHOWN))
              .map((c) =>
                c.category.untrusted.trim() === ""
                  ? { ...c, category: { untrusted: NO_CATEGORY_LABEL } }
                  : c,
              ) ?? null,
        }),
      }),
  );

  server.registerTool(
    "get_budgets_and_bidding",
    {
      title: "Budgets and bidding",
      description:
        'Budgets with the campaigns sharing each, and portfolio bid strategies with their targets and campaigns: what a budget or strategy change touches. Example: {"customer_id":"123-456-7890"}',
      inputSchema: PlainInput,
      annotations: { title: "Budgets and bidding", ...READ_ONLY },
    },
    async (args) =>
      runReadTool(rt, deadline, timing, budgetsReader, {
        customerId: args.customer_id,
        page: page(args),
        input: () => null,
        dateRange: () => null,
        extra: (x) => ({ biddingStrategies: x?.biddingStrategies ?? null }),
      }),
  );

  server.registerTool(
    "get_negatives",
    {
      title: "Negatives",
      description:
        'Negative keywords on ad groups and campaigns, shared negative lists (keywords, links) and account-level negatives and exclusions. Example: {"customer_id":"123-456-7890"}',
      inputSchema: PlainInput,
      annotations: { title: "Negatives", ...READ_ONLY },
    },
    async (args) =>
      runReadTool(rt, deadline, timing, negativesReader, {
        customerId: args.customer_id,
        page: page(args),
        input: () => null,
        dateRange: () => null,
        extra: (x) => ({ sharedLists: x?.sharedLists ?? null }),
      }),
  );

  server.registerTool(
    "get_ads_and_assets",
    {
      title: "Ads and assets",
      description:
        'Ads (RSA texts with pinning and labels, URLs, ad strength, policy) and asset links (sitelinks, callouts, snippets, images...) on account, campaigns, ad groups. Example: {"customer_id":"123-456-7890","kind":"ads"}',
      inputSchema: AdsAssetsInput,
      annotations: { title: "Ads and assets", ...READ_ONLY },
    },
    async (args) =>
      runReadTool(rt, deadline, timing, adsAssetsReader, {
        customerId: args.customer_id,
        page: page(args),
        input: () => adsAssetsInput(filterInput(args), args.kind),
        dateRange: (i) => i.dateRange,
        extra: noExtra,
      }),
  );

  server.registerTool(
    "get_audiences",
    {
      title: "Audiences",
      description:
        'User lists (type, status, size, targeted or not) and audience targeting/exclusions on campaigns and ad groups, with metrics. Example: {"customer_id":"123-456-7890"}',
      inputSchema: AudiencesInput,
      annotations: { title: "Audiences", ...READ_ONLY },
    },
    async (args) =>
      runReadTool(rt, deadline, timing, audiencesReader, {
        customerId: args.customer_id,
        page: page(args),
        input: () => audiencesInput(filterInput(args), args.kind),
        dateRange: (i) => i.dateRange,
        extra: noExtra,
      }),
  );

  server.registerTool(
    "get_conversions",
    {
      title: "Conversions",
      description:
        'Conversion actions (status, category, primary, counting, attribution, values) with conversions in the range; account/campaign goals; value rules. Example: {"customer_id":"123-456-7890"}',
      inputSchema: ConversionsInput,
      annotations: { title: "Conversions", ...READ_ONLY },
    },
    async (args) =>
      runReadTool(rt, deadline, timing, conversionsReader, {
        customerId: args.customer_id,
        page: page(args),
        input: () => ({ dateRange: resolveDateRange(args.date_range) }),
        dateRange: (i) => i.dateRange,
        extra: (x) => ({ customerGoals: x?.customerGoals ?? null }),
      }),
  );

  server.registerTool(
    "get_change_history",
    {
      title: "Change history",
      description:
        'Who changed what, when (1-28 days; Google keeps 30): resource, operation, fields, tool; users as "user at domain". Example: {"customer_id":"123-456-7890","days":7}',
      inputSchema: ChangeHistoryInput,
      annotations: { title: "Change history", ...READ_ONLY },
    },
    async (args) =>
      runReadTool(rt, deadline, timing, changeHistoryReader, {
        customerId: args.customer_id,
        page: page(args),
        input: () => changeHistoryInput(args, rt.now()),
        forAccount: (_i, account) =>
          changeHistoryInput(args, rt.now(), normalise.timeZone(account.timeZone)),
        dateRange: (i) => ({
          preset: null,
          startDate: i.startDate,
          // The intended last day, not the query's buffer end (+2 days when the zone is unknown).
          endDate: i.lastDay,
        }),
        extra: noExtra,
      }),
  );
};

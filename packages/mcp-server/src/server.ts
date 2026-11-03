// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { fileURLToPath } from "node:url";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { dailyLimitLine, redactString } from "@perfoads/ads-client";
import { normalise, testAccountStatusNote } from "@perfoads/reads";
import * as z from "zod";
import { runDoctor, formatDoctor, type DoctorOptions } from "./doctor.js";
import {
  DEFAULT_CHANGE_TIMING,
  registerChangeTools,
  type ChangeToolTiming,
} from "./changeTools.js";
import {
  decodeCursor,
  encodeCursor,
  guardGaql,
  MISSING_FIELDS_NOTE,
  withSelectedFields,
} from "./gaql.js";
import {
  DEFAULT_READ_TIMING,
  READ_OUTPUT_SCHEMAS,
  registerReadTools,
  type ReadTiming,
} from "./readTools.js";
import { registerServiceTools, SERVICE_OUTPUT_SCHEMAS } from "./serviceTools.js";
import {
  CHECK_OUTPUT_SCHEMAS,
  PLUGIN_CHECK_OUTPUT_SCHEMAS,
  registerCheckTools,
} from "./checkTools.js";
import { loadedPlugin, type PluginState } from "./plugin.js";
import { registerPluginItems } from "./pluginTools.js";
import { TOOL_DEADLINE_MS, type Runtime } from "./runtime.js";
import { errorText, textMirror, ToolInputError, withDeadline } from "./toolKit.js";
import { UNTRUSTED_NOTE, UntrustedSchema, untrusted, wrapUntrusted } from "./untrusted.js";
import { PRODUCT_NAME, SERVER_NAME, SERVER_VERSION } from "./version.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const CheckSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["ok", "warn", "fail", "skipped"]),
  detail: z.string().describe("What was found, in plain English"),
  fix: z.string().optional().describe("What to do, in plain English"),
  details: z
    .string()
    .optional()
    .describe("Exact commands, file paths and setting names behind detail and fix"),
});

const DoctorOutput = z.object({
  ok: z.boolean().describe("true when no check failed"),
  checks: z.array(CheckSchema),
  summary: z.object({ ok: z.number(), warn: z.number(), fail: z.number(), skipped: z.number() }),
});

const AccountSchema = z.object({
  customerId: z.string().describe("10 digits, no dashes"),
  name: UntrustedSchema,
  currencyCode: z.string().nullable(),
  timeZone: z.string().nullable(),
  status: z.string().nullable(),
  isManager: z.boolean(),
  isTestAccount: z.boolean(),
  loginCustomerId: z.string().describe("Sent as login-customer-id when working on this account"),
  loginPath: z.array(z.string()).describe("Manager the sign-in goes through, then the account"),
  level: z.number().describe("0 = reached directly; 1+ = depth under the manager"),
  statusNote: z.string().optional(),
});

const ListAccountsOutput = z.object({
  total: z.number(),
  accounts: z.array(AccountSchema),
  failures: z.array(z.object({ customerId: z.string(), message: UntrustedSchema })),
  untrustedNote: z.string(),
});

const QueryInput = z.object({
  customer_id: z.string().describe("Google Ads customer id, e.g. 123-456-7890 (see list_accounts)"),
  query: z
    .string()
    .describe(
      "One GAQL SELECT, e.g. SELECT campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_7_DAYS. LIMIT defaults to 200, max 1000.",
    ),
  max_rows: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Rows to return in this reply (default 50). The rest come with next_cursor."),
  cursor: z
    .string()
    .max(200)
    .optional()
    .describe("next_cursor from the previous reply, with the same query and customer_id"),
});

const QueryOutput = z.object({
  customerId: z.string(),
  resource: z.string(),
  queryRun: z.string().describe("The exact query sent to Google (after the guard)"),
  limit: z.number(),
  notes: z.array(z.string()),
  totalRowsRead: z.number(),
  mayHaveMoreRows: z.boolean().describe("true when Google returned LIMIT rows: there may be more"),
  offset: z.number(),
  returnedRows: z.number(),
  rows: z.array(z.record(z.string(), z.unknown())),
  next_cursor: z.string().nullable(),
  untrustedNote: z.string(),
});

/** Output schemas by tool name (also used by tests to check structuredContent). */
export const OUTPUT_SCHEMAS = {
  doctor: DoctorOutput,
  list_accounts: ListAccountsOutput,
  query_gaql: QueryOutput,
  ...READ_OUTPUT_SCHEMAS,
  ...SERVICE_OUTPUT_SCHEMAS,
  ...CHECK_OUTPUT_SCHEMAS,
} as const;

const DEFAULT_PAGE_ROWS = 50;

const errorResult = (rt: Runtime, err: unknown): CallToolResult => {
  rt.noteError(err);
  return { isError: true, content: [{ type: "text", text: errorText(err, rt.secrets()) }] };
};

const okResult = <T extends Record<string, unknown>>(
  summary: string,
  structured: T,
): CallToolResult => ({
  content: [{ type: "text", text: textMirror(summary, structured) }],
  structuredContent: structured,
});

/** Workspace folders the client shares (2025-era roots), for the doctor's folder check. Best effort. */
const clientRoots = async (server: McpServer): Promise<string[] | undefined> => {
  if (!server.server.getClientCapabilities()?.roots) return undefined;
  try {
    const { roots } = await server.server.listRoots(undefined, { timeout: 3000 });
    return roots
      .map((r) => {
        try {
          return r.uri.startsWith("file:") ? fileURLToPath(r.uri) : undefined;
        } catch {
          return undefined;
        }
      })
      .filter((p): p is string => p !== undefined);
  } catch {
    return undefined;
  }
};

export interface ServerOptions {
  deadlineMs?: number;
  readTiming?: ReadTiming;
  doctor?: Omit<DoctorOptions, "roots" | "elicitation">;
  changeTiming?: ChangeToolTiming;
  /** The plugin state (default: the runtime's, set by its loadPlugin at start; none = no plugin). */
  plugin?: PluginState;
}

/** The MCP server with every tool registered. One per connection; the runtime is shared. */
export const createMcpServer = (rt: Runtime, options: ServerOptions = {}): McpServer => {
  const deadline = options.deadlineMs ?? TOOL_DEADLINE_MS;
  const plugin = loadedPlugin(options.plugin ?? rt.plugin());
  const server = new McpServer(
    { name: SERVER_NAME, title: PRODUCT_NAME, version: SERVER_VERSION },
    {
      instructions:
        `${PRODUCT_NAME} (not a Google product) reads Google Ads accounts through the user's own Google Cloud project. ` +
        "Start with doctor if anything fails, then list_accounts, then get_account_overview. If the user names no account and more than one account could be meant (test accounts that look closed included), ask which one; never pick one yourself. Google usually shows test accounts as closed; that alone doesn't stop changes (they never show ads). Prefer the get_* tools; query_gaql is for anything they do not cover. Money is a decimal string in the account currency. get_* results: summary first, then one page of rows (next_cursor for more); their JSON Schema is the resource schema://tools/{name}. For an audit: build_snapshot, then run_checks (the weekly_audit prompt has the full report format); fetch every page until next_cursor is null; not_run means not checked, never clean. Report EVERY finding, never main points only: header (account, dates, spend in the period and per month from get_account_overview for the snapshot's dates, never estimated; finding count); Summary (5-8 bullets, biggest money first); then by area (Tracking, Account settings, Budget & bidding, Search & keywords, Ads & landing pages, Performance Max, Shopping & products, Audiences & devices, Demand Gen, Trends): bold plain title - Urgent/Important/Minor/Note - exact name, 1-3 evidence bullets; then Good news (incl. positive findings); then what could not be checked, one line per reason. Return on ad spend as '$2.43 per $1'. " +
        (plugin ? "" : "Diagnosis only, no fix advice. ") +
        "Changes: propose_change, then apply_change; only a person can approve (local browser page, or its code), except low-risk changes the user's own policy file (policy://current) sets to auto. " +
        UNTRUSTED_NOTE,
      // Elicitation request state (MRTR) is HMAC-checked before a handler runs; key in the store.
      requestState: { verify: (state, ctx) => rt.approvals().codec().verify(state, ctx) },
    },
  );

  server.registerTool(
    "doctor",
    {
      title: "Check setup",
      description:
        "Checks the setup step by step: Node.js, where settings are stored, the saved Google sign-in, Google Ads API access level and limits, and risky Claude Code hooks. Each line says ok, warn, fail or skipped in plain English, with a fix; exact commands and file paths are in each check's details.",
      inputSchema: z.object({}),
      outputSchema: DoctorOutput,
      annotations: { title: "Check setup", ...READ_ONLY },
    },
    async () => {
      try {
        const roots = await clientRoots(server);
        if (roots) rt.setWorkspaceRoots(roots);
        const caps = server.server.getClientCapabilities();
        const elicitation = caps === undefined ? undefined : caps.elicitation !== undefined;
        const report = await withDeadline(
          runDoctor(rt, { ...options.doctor, roots, elicitation }),
          deadline,
        );
        const s = report.summary;
        const more = report.checks.some((c) => c.details && c.status !== "ok")
          ? "\n(Exact commands and folder paths are in each check's details.)"
          : "";
        return okResult(
          `${report.ok ? "Setup looks fine" : "Setup has problems"}: ${s.ok} ok, ${s.warn} warnings, ${s.fail} failed, ${s.skipped} skipped.\n\n${formatDoctor(report)}${more}`,
          { ...report },
        );
      } catch (err) {
        return errorResult(rt, err);
      }
    },
  );

  server.registerTool(
    "list_accounts",
    {
      title: "List Google Ads accounts",
      description:
        "Lists every Google Ads account this sign-in can work on, including accounts under manager (MCC) accounts, with currency, time zone and the login-customer-id each one needs.",
      inputSchema: z.object({
        refresh: z
          .boolean()
          .optional()
          .describe("Ask Google again instead of using the list from the last 10 minutes"),
      }),
      outputSchema: ListAccountsOutput,
      annotations: { title: "List Google Ads accounts", ...READ_ONLY },
    },
    async ({ refresh }) => {
      try {
        const result = await withDeadline(rt.accounts({ refresh: refresh === true }), deadline);
        const accounts = result.accounts.map((a) => {
          const status = normalise.enumValue(a.status);
          // test accounts Google shows as closed: a note, so the AI never calls them unusable
          const statusNote = testAccountStatusNote(a.isTestAccount, status);
          return {
            customerId: a.customerId,
            name: untrusted(a.name),
            currencyCode: normalise.currencyCode(a.currencyCode),
            timeZone: normalise.timeZone(a.timeZone),
            status,
            isManager: a.isManager,
            isTestAccount: a.isTestAccount,
            loginCustomerId: a.loginCustomerId,
            loginPath:
              a.loginCustomerId === a.customerId
                ? [a.customerId]
                : [a.loginCustomerId, a.customerId],
            level: a.level,
            ...(statusNote ? { statusNote } : {}),
          };
        });
        // the daily limit is said once at the top; each account it stopped gets a short line
        const limited = result.failures.filter((f) => f.dailyLimit);
        const longestWait = limited.reduce<number | undefined>(
          (m, f) =>
            f.dailyLimit?.waitMs === undefined ? m : Math.max(m ?? 0, f.dailyLimit.waitMs),
          undefined,
        );
        const dailyLimit = limited.length > 0 ? dailyLimitLine(longestWait) : null;
        const failures = result.failures.map((f) => ({
          customerId: f.customerId,
          // Same redaction as every other error path: known secrets and secret shapes removed.
          message: untrusted(
            f.dailyLimit
              ? "Not read: the daily request limit is used up."
              : redactString(f.message, rt.secrets()),
          ),
        }));
        const managers = accounts.filter((a) => a.isManager).length;
        const testNote = accounts.find((a) => a.statusNote)?.statusNote;
        const summary =
          (dailyLimit ? `${dailyLimit} ` : "") +
          `${accounts.length} account${accounts.length === 1 ? "" : "s"} (${managers} manager${managers === 1 ? "" : "s"})` +
          (failures.length ? `, ${failures.length} could not be read` : "") +
          (limited.length > 0
            ? limited.length === failures.length
              ? " because of it"
              : ` (${limited.length} because of it)`
            : "") +
          "." +
          (testNote ? ` ${testNote}` : "");
        return okResult(summary, {
          total: accounts.length,
          accounts,
          failures,
          untrustedNote: UNTRUSTED_NOTE,
        });
      } catch (err) {
        return errorResult(rt, err);
      }
    },
  );

  server.registerTool(
    "query_gaql",
    {
      title: "Run a read-only GAQL query",
      description:
        "Runs one Google Ads Query Language SELECT on one account. Read-only: anything but a single SELECT on a known resource is refused. LIMIT is added (200) or lowered (max 1000). Returns a summary first, then up to max_rows rows; next_cursor fetches the rest. Costs 1 Google Ads operation per call.",
      inputSchema: QueryInput,
      outputSchema: QueryOutput,
      annotations: { title: "Run a read-only GAQL query", ...READ_ONLY },
    },
    async ({ customer_id, query, max_rows, cursor }) => {
      try {
        const guarded = guardGaql(query);
        if (!guarded.ok) throw new ToolInputError(`Query refused: ${guarded.reason}`);
        const work = async () => {
          const account = await rt.resolveAccount(customer_id);
          const offset = cursor
            ? (() => {
                const c = decodeCursor(cursor, account.customerId, guarded.query);
                if ("error" in c) throw new ToolInputError(c.error);
                return c.offset;
              })()
            : 0;
          const res = await rt.ads().searchAll({
            customerId: account.customerId,
            loginCustomerId: account.loginCustomerId,
            query: guarded.query,
            maxRows: guarded.limit,
          });
          return { account, offset, rows: res.rows };
        };
        const { account, offset, rows } = await withDeadline(work(), deadline);
        const pageSize = max_rows ?? DEFAULT_PAGE_ROWS;
        // every selected field in every row, segments.* included (Google leaves empty ones out)
        const page = rows
          .slice(offset, offset + pageSize)
          .map((r) => withSelectedFields(r, guarded.fields));
        const filled = page.some((r, i) => JSON.stringify(r) !== JSON.stringify(rows[offset + i]));
        const notes = filled ? [...guarded.notes, MISSING_FIELDS_NOTE] : guarded.notes;
        const nextOffset = offset + page.length;
        const next =
          nextOffset < rows.length
            ? encodeCursor(account.customerId, guarded.query, nextOffset)
            : null;
        const structured = {
          customerId: account.customerId,
          resource: guarded.resource,
          queryRun: guarded.query,
          limit: guarded.limit,
          notes,
          totalRowsRead: rows.length,
          mayHaveMoreRows: rows.length >= guarded.limit,
          offset,
          returnedRows: page.length,
          rows: page.map((r) => wrapUntrusted(r) as Record<string, unknown>),
          next_cursor: next,
          untrustedNote: UNTRUSTED_NOTE,
        };
        const summary =
          `Read ${rows.length} row${rows.length === 1 ? "" : "s"} from ${guarded.resource} on ${account.customerId}` +
          (page.length ? `; showing ${offset + 1}-${offset + page.length}` : "; nothing to show") +
          (next ? ". More rows: call again with next_cursor." : ".") +
          (notes.length ? ` ${notes.join(" ")}` : "");
        return okResult(summary, structured);
      } catch (err) {
        return errorResult(rt, err);
      }
    },
  );

  // Workspace folders the AI app shares: a policy file inside one is ignored (read-only).
  // Policy-dependent calls wait (up to 3 s) for the first answer; refreshed on list_changed.
  const refreshRoots = (): void => {
    const pending = clientRoots(server).then((roots) => {
      if (roots) rt.setWorkspaceRoots(roots);
    });
    rt.setRootsPending(pending);
  };
  server.server.oninitialized = refreshRoots;
  server.server.setNotificationHandler("notifications/roots/list_changed", () => {
    refreshRoots();
  });

  // with a plugin, run_checks' served result schema has its extra fields
  registerReadTools(
    server,
    rt,
    deadline,
    options.readTiming,
    plugin ? PLUGIN_CHECK_OUTPUT_SCHEMAS : undefined,
  );
  registerServiceTools(server, rt, deadline);
  registerCheckTools(server, rt, deadline, options.readTiming ?? DEFAULT_READ_TIMING, plugin);
  registerChangeTools(server, rt, options.changeTiming ?? DEFAULT_CHANGE_TIMING);
  if (plugin) registerPluginItems(server, rt, plugin, deadline);

  return server;
};

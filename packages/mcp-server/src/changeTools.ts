// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Change tools (plan 5, 6.2): propose_change, apply_change, undo_change, get_change,
// list_changes, resolve_change, and the resources changes://log, changes://{id} and
// schema://changes/{type}. Nothing here can approve on its own: approval needs a person
// on the local approval page (button), or the code from that page typed into the AI
// app's form or the terminal. A dialog "yes" is never enough.

import {
  acceptedContent,
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  ResourceTemplate,
  type CallToolResult,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import {
  APPLY_DEADLINE_MS,
  CHANGE_STATUSES,
  ChangeError,
  isChangeStatus,
  ITEM_LOCK_MS,
  listRecentEvents,
  NOT_TEST_ACCOUNT_MESSAGE,
  V1_ACTION_TYPES,
  type ChangeView,
  type ResolveOutcome,
} from "@perfoads/changes";
import { policyResource } from "@perfoads/policy";
import { clearSnapshots } from "@perfoads/snapshot";
import * as z from "zod";
import type { ApprovalState } from "./approvals/service.js";
import {
  getSession,
  setStateNonce,
  takeStateNonce,
  type SessionKind,
} from "./approvals/sessions.js";
import { approvalSummaryText } from "./approvals/view.js";
import { TOOL_DEADLINE_MS, type Runtime } from "./runtime.js";
import { errorText, textMirror, ToolInputError, withDeadline } from "./toolKit.js";
import { untrustedText } from "@perfoads/reads";
import { UNTRUSTED_NOTE, untrusted, wrapUntrusted } from "./untrusted.js";
import { howToRun } from "@perfoads/store";

/** Longest a waiting apply_change / resolve_change holds the call open for a page click. */
export const APPROVAL_WAIT_MS = 90_000;
/**
 * Budget for one call that waited and then applies: the wait + one engine apply must end
 * before this (Claude Desktop stops waiting at 240 s). Otherwise: "call again".
 */
export const APPLY_CALL_BUDGET_MS = 230_000;

/** Longest the test-account lookup (account list, cold cache) may take inside apply_change. */
export const ACCOUNT_LOOKUP_MS = 20_000;

export interface ChangeToolTiming {
  approvalWaitMs: number;
  accountLookupMs: number;
  applyCallBudgetMs: number;
  applyDeadlineMs: number;
}

export const DEFAULT_CHANGE_TIMING: ChangeToolTiming = {
  approvalWaitMs: APPROVAL_WAIT_MS,
  accountLookupMs: ACCOUNT_LOOKUP_MS,
  applyCallBudgetMs: APPLY_CALL_BUDGET_MS,
  applyDeadlineMs: APPLY_DEADLINE_MS,
};

const AGENT = { actor: "agent", via: "mcp" } as const;
const TYPE_NAMES = V1_ACTION_TYPES.map((t) => t.type) as [string, ...string[]];
const ELICIT_KEY = "approval";
const CodeAnswer = z.object({ code: z.string().max(40) });

const changeId = z.string().min(1).max(64).describe("Change id (chg_...)");

/** Statuses after which the account may differ from any kept snapshot. */
const SENT_STATUSES = new Set<string>([
  "applied",
  "verified",
  "verify_failed",
  "in_doubt",
  "partially_applied",
  "resolved_by_user",
]);

/** Plain words for every status. */
export const statusText = (v: ChangeView): string => {
  const why = v.statusReason ? ` ${v.statusReason}` : "";
  switch (v.status) {
    case "proposed":
      return `Waiting for a person to approve it (expires ${v.expiresAt}). Nothing was sent.`;
    case "approved":
      return "Approved by a person; not sent yet. Call apply_change to send it.";
    case "applying":
      return "Being sent to Google Ads right now.";
    case "applied":
      return "Google accepted it; the read-back has not confirmed it yet.";
    case "partially_applied":
      return `Only part of it was applied.${why}`;
    case "verified":
      return v.landed
        ? `Partly applied and confirmed: ${v.landed.ok} of ${v.landed.total} items landed and Google Ads shows them; Google refused the rest (not changed).`
        : "Applied and confirmed: Google Ads shows the new values.";
    case "verify_failed":
      return `Sent, but reading it back did NOT show the expected values. Check it in Google Ads. It will not be sent again.${why}`;
    case "failed":
      return `Not applied.${why}`;
    case "in_doubt":
      return `Unclear whether it landed (no clear answer from Google). It will not be sent again; get_change re-checks by reading the account.${why}`;
    case "stale":
      return `Not sent: the account changed after approval.${why || " Propose it again."}`;
    case "expired":
      return "Expired before it was approved and applied. Propose it again.";
    case "rejected":
      return "Rejected by a person. Nothing was sent.";
    case "resolved_by_user":
      return `Settled by a person.${why}`;
    case "abandoned":
      return `Given up on.${why}`;
  }
};

/** The change as tools return it: Google's and the AI's text wrapped as untrusted. */
const changeOut = (v: ChangeView) => ({
  changeId: v.id,
  status: v.status,
  statusText: statusText(v),
  type: v.type,
  account: {
    customerId: v.customerId,
    name: untrusted(v.accountName),
    currencyCode: v.currencyCode,
  },
  diff: v.diff,
  affected: v.affected.map((a) => ({
    kind: a.kind,
    id: a.id,
    name: a.name === null ? null : untrusted(a.name),
    status: a.status,
  })),
  warnings: v.warnings,
  reason: v.reason === null ? null : untrustedText(v.reason),
  riskTier: v.riskTier,
  undo: v.undo,
  landed: v.landed,
  undoOf: v.undoOf,
  expiresAt: v.expiresAt,
  createdAt: v.createdAt,
  /** A version id of this exact change. Not an approval. */
  versionId: v.version,
  approval: v.approvedAt ? { by: v.approvedBy, via: v.approvedVia, at: v.approvedAt } : null,
  appliedAt: v.appliedAt,
  googleRequestIds: v.googleRequestIds,
  error: v.error
    ? {
        message: v.error.message,
        googleSaid: v.error.googleSaid === null ? null : untrustedText(v.error.googleSaid),
      }
    : null,
});

/** list_changes page cap: full entries ran past 50 KB at 100. */
const MAX_LISTED_CHANGES = 25;

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 3)}...`;

/** One list_changes entry: short on purpose; get_change has the full change. */
const briefOut = (v: ChangeView) => ({
  changeId: v.id,
  type: v.type,
  status: v.status,
  statusText: clip(statusText(v), 200),
  account: { customerId: v.customerId, name: untrusted(v.accountName) },
  summary:
    v.diff.length === 0
      ? null
      : clip(v.diff[0] ?? "", 160) + (v.diff.length > 1 ? ` (+${v.diff.length - 1} more)` : ""),
  createdAt: v.createdAt,
  appliedAt: v.appliedAt,
  undoOf: v.undoOf,
});

const ok = (summary: string, structured: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: textMirror(summary, structured) }],
  structuredContent: structured,
});

const fail = (text: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});

/** Form elicitation the client declared, for the era this request is served on. */
const canElicitForm = (server: McpServer, ctx: ServerContext): boolean => {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const caps = (envelope?.[CLIENT_CAPABILITIES_META_KEY] ??
    server.server.getClientCapabilities()) as
    { elicitation?: { form?: unknown; url?: unknown } } | undefined;
  const e = caps?.elicitation;
  if (!e || typeof e !== "object") return false;
  // An empty elicitation object means form (backwards compatibility).
  return e.form !== undefined || e.url === undefined;
};

const isModern = (ctx: ServerContext): boolean =>
  (ctx.mcpReq.envelope as Record<string, unknown> | undefined)?.[
    "io.modelcontextprotocol/protocolVersion"
  ] !== undefined;

export const registerChangeTools = (
  server: McpServer,
  rt: Runtime,
  timing: ChangeToolTiming = DEFAULT_CHANGE_TIMING,
): void => {
  const errorResult = (err: unknown): CallToolResult => {
    rt.noteError(err);
    return fail(errorText(err, rt.secrets()));
  };

  /**
   * After a change (or undo) was sent or settled, the account's kept snapshots describe it as
   * it was: delete them so build_snapshot reads fresh. Never fails the change result.
   */
  const dropSnapshots = (v: ChangeView): void => {
    if (!SENT_STATUSES.has(v.status)) return;
    try {
      clearSnapshots(v.customerId, { configDir: rt.configDir.dir });
    } catch {
      rt.logger.warn("could not delete the account's kept snapshots after a change");
    }
  };

  const mustGet = (id: string): ChangeView => {
    const v = rt.engine().get(id);
    if (!v) throw new ChangeError("not_found", "No change with that id. See list_changes.");
    return v;
  };

  /**
   * Test-account flag from the live account list (cached 10 min); null when unknown.
   * Bounded by accountLookupMs on the runtime clock: a stalled Google never holds the call.
   * Callers look it up once per call.
   */
  const testFlag = async (customerId: string): Promise<boolean | null> => {
    const deadlineAt = rt.now() + timing.accountLookupMs;
    const stop = new AbortController();
    // Ticks on the runtime clock (rt.sleep), so a test clock drives it without real time.
    const timeUp = (async () => {
      while (!stop.signal.aborted && rt.now() < deadlineAt) {
        await rt.sleep(Math.min(50, timing.accountLookupMs), stop.signal);
      }
      return null;
    })();
    try {
      return await Promise.race([
        rt.resolveAccount(customerId, { forChanges: true }).then(
          (a) => a.isTestAccount,
          () => null,
        ),
        timeUp,
      ]);
    } finally {
      stop.abort();
    }
  };

  /** Sends an approved change, unless too little of this call's time is left. */
  const applyNow = async (view: ChangeView, started: number): Promise<CallToolResult> => {
    if (rt.now() - started + timing.applyDeadlineMs > timing.applyCallBudgetMs) {
      return ok(
        `Approved. Call apply_change again with ${view.id} to send it (not enough time left in this call).`,
        { change: changeOut(view), applied: false },
      );
    }
    try {
      const after = await rt.engine().apply(view.id, AGENT);
      dropSnapshots(after);
      return ok(`${after.id}: ${statusText(after)}`, { change: changeOut(after), applied: true });
    } catch (err) {
      if (err instanceof ChangeError) {
        const now = rt.engine().get(view.id) ?? view;
        dropSnapshots(now);
        return ok(`Not sent: ${errorText(err, rt.secrets())}`, {
          change: changeOut(now),
          applied: false,
          refused: { code: err.code, message: errorText(err, rt.secrets()) },
        });
      }
      throw err;
    }
  };

  /** Asks the client's form for the code shown on the page (MRTR, or elicitation/create via the SDK shim). */
  const askForCode = async (
    tool: string,
    view: ChangeView,
    sessionId: string,
    started: number,
    kind: SessionKind,
    note: string | null,
  ): Promise<CallToolResult | InputRequiredResult> => {
    const store = rt.store();
    const nonce = setStateNonce(store, sessionId, rt.now());
    const session = getSession(store, sessionId, rt.now());
    if (!nonce || !session) {
      return ok("This approval was closed. Call the tool again to open a new approval page.", {
        change: changeOut(view),
        approved: false,
      });
    }
    const state: ApprovalState = {
      tool,
      c: view.id,
      v: view.version,
      s: sessionId,
      n: nonce,
      e: Date.parse(session.expiresAt),
      t: started,
    };
    const policyLines = kind === "approve" ? rt.approvals().policyLines(view) : [];
    const message = [
      approvalSummaryText(view, kind, session.outcome, session.note, policyLines),
      note,
    ]
      .filter(Boolean)
      .join("\n\n");
    return inputRequired({
      inputRequests: {
        [ELICIT_KEY]: inputRequired.elicit({
          message,
          requestedSchema: {
            type: "object",
            properties: {
              code: {
                type: "string",
                title: "Approval code",
                description: "The 6-character code on the approval page in your browser",
                minLength: 6,
                maxLength: 12,
              },
            },
            required: ["code"],
          },
        }),
      },
      requestState: await rt.approvals().codec().mint(state),
    });
  };

  /**
   * The round after the form was answered. The request state was verified (HMAC, expiry)
   * by the SDK hook; here it must belong to this tool, this change and version, a session
   * still open, and a nonce not used before.
   */
  const codeRound = async (
    tool: string,
    view: ChangeView,
    state: ApprovalState,
    ctx: ServerContext,
    roundStart: number,
    onApproved: (v: ChangeView, started: number) => Promise<CallToolResult>,
  ): Promise<CallToolResult | InputRequiredResult> => {
    const store = rt.store();
    const refused = (why: string) =>
      fail(`${why} Nothing was approved. Call ${tool} again to open a new approval page.`);
    if (
      !state ||
      typeof state !== "object" ||
      state.tool !== tool ||
      state.c !== view.id ||
      state.v !== view.version ||
      !(rt.now() < state.e)
    ) {
      return refused("This approval step does not belong to this change, or it expired.");
    }
    const session = getSession(store, state.s, rt.now());
    if (!session || session.changeId !== view.id || session.version !== view.version) {
      return refused("This approval step does not belong to this change.");
    }
    if (!takeStateNonce(store, state.s, state.n, rt.now())) {
      return refused("This approval step was already used.");
    }
    const kind = session.kind;
    const raw = (ctx.mcpReq.inputResponses?.[ELICIT_KEY] ?? {}) as { action?: unknown };
    const answer = acceptedContent(ctx.mcpReq.inputResponses, ELICIT_KEY, CodeAnswer);
    if (raw.action !== "accept" || !answer?.code?.trim()) {
      return ok(
        "Not approved: no code was typed. The approval page stays open in your browser: approve there, or call the tool again.",
        { change: changeOut(view), approved: false },
      );
    }
    const result = await rt.approvals().completeWithCode(session.id, answer.code, "elicitation");
    if (result.ok) {
      const started = isModern(ctx) ? roundStart : state.t;
      return onApproved(result.change, started);
    }
    if (result.reason === "wrong") {
      return askForCode(
        tool,
        view,
        session.id,
        state.t,
        kind,
        `That code was wrong. ${result.attemptsLeft} tr${result.attemptsLeft === 1 ? "y" : "ies"} left.`,
      );
    }
    const words = {
      burned: "Too many wrong codes: this approval was closed.",
      expired: "This approval expired.",
      not_open: "This approval was already finished or closed.",
      refused: result.reason === "refused" ? result.message : "",
    };
    return refused(words[result.reason]);
  };

  /** Shared by apply_change and resolve_change: open the page, then form or wait. */
  const getApproval = async (
    tool: string,
    view: ChangeView,
    kind: SessionKind,
    ctx: ServerContext,
    started: number,
    extra: { outcome?: ResolveOutcome; note?: string; testAccount: boolean | null },
    onApproved: (v: ChangeView, started: number) => Promise<CallToolResult>,
    stillWaiting: (v: ChangeView) => boolean,
  ): Promise<CallToolResult | InputRequiredResult> => {
    const forms = canElicitForm(server, ctx);
    const approvals = rt.approvals();
    const { session, reused, elsewhere } = await approvals.open(view, kind, {
      ...extra,
      clientHasForms: forms,
    });
    // open_browser false: the code is typed only in the service user's terminal, never a form.
    if (forms && approvals.opensBrowser) {
      return askForCode(tool, view, session.id, started, kind, null);
    }
    // Never past the call budget: the wait ends by then even if Google was slow before it.
    const deadlineAt = Math.min(
      rt.now() + timing.approvalWaitMs,
      started + timing.applyCallBudgetMs,
    );
    await approvals.waitFor(() => !stillWaiting(mustGet(view.id)), deadlineAt, ctx.mcpReq.signal);
    const now = mustGet(view.id);
    if (!stillWaiting(now)) return onApproved(now, started);
    const opened = elsewhere
      ? "An approval page for this change is already open (for example from `approvals open` in a terminal)."
      : reused
        ? "The approval page is already open in your browser."
        : "The approval page opened in your browser.";
    const how = elsewhere
      ? `Waiting for the person to type its code where that page was opened, then call ${tool} again. If that terminal was closed, run \`${howToRun(`approvals open ${view.id}`)}\` again (as the OS user this server runs as).`
      : approvals.mode === "code_only"
        ? `Waiting for your approval: type the code from the page in a terminal, as the OS user this server runs as (\`${howToRun(`approve ${view.id}`)}\`), then call ${tool} again.`
        : `Waiting for your approval in the browser - call ${tool} again after approving.`;
    return ok(`${opened} ${how} Nothing was sent.`, {
      change: changeOut(now),
      approved: false,
      waitingForApproval: true,
    });
  };

  server.registerTool(
    "propose_change",
    {
      title: "Propose a change",
      description:
        "Builds one change, checks it with Google (validate only), never applies. params schema per type: schema://changes/{type}. Returns diff, risk, change_id; then apply_change.",
      inputSchema: z.object({
        customer_id: z.string().describe("10-digit account id"),
        type: z.enum(TYPE_NAMES),
        params: z.record(z.string(), z.unknown()),
        reason: z.string().max(500).optional().describe("Why, for the person approving"),
      }),
      annotations: {
        title: "Propose a change",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ customer_id, type, params, reason }) => {
      try {
        const work = async () => {
          // A new proposal reads like any read: it keeps to the ops reserve.
          const account = await rt.resolveAccount(customer_id);
          return rt.engine().propose({
            customerId: account.customerId,
            loginCustomerId: account.loginCustomerId,
            type,
            input: params,
            ...AGENT,
            reason,
          });
        };
        const v = await withDeadline(work(), TOOL_DEADLINE_MS);
        return ok(
          v.riskTier === "auto"
            ? `Proposed ${v.id} (${v.type}) on ${v.customerId}. Not applied. The policy lets this low-risk change apply without a person: call apply_change with this change_id.`
            : `Proposed ${v.id} (${v.type}) on ${v.customerId}. Not applied. Call apply_change with this change_id: a person approves it on a local page in their browser.`,
          { change: changeOut(v), untrustedNote: UNTRUSTED_NOTE },
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "apply_change",
    {
      title: "Apply an approved change",
      description:
        "Sends a proposed change once a person approves it: opens an approval page in the user's browser (approve there, or type its code when asked), sends once, reads back.",
      inputSchema: z.object({ change_id: changeId }),
      annotations: {
        title: "Apply an approved change",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ change_id }, ctx) => {
      const started = rt.now();
      try {
        const view = mustGet(change_id);
        const state = ctx.mcpReq.requestState<ApprovalState>();
        if (state !== undefined) {
          if (view.status !== "proposed") {
            return view.status === "approved"
              ? applyNow(view, started)
              : ok(`${view.id}: ${statusText(view)}`, { change: changeOut(view) });
          }
          return await codeRound("apply_change", view, state, ctx, started, applyNow);
        }
        if (view.status === "approved") return await applyNow(view, started);
        if (view.status !== "proposed") {
          return ok(`${view.id}: ${statusText(view)}`, { change: changeOut(view) });
        }
        // Before any page opens: the policy (kill switch, accounts.write, blocked tier) ...
        await rt.rootsReady();
        const gate = rt.policy().gate(view.customerId, view.type);
        if (!gate.allowed) {
          return ok(`Not sent: ${gate.reason}`, {
            change: changeOut(view),
            applied: false,
            refused: { code: "policy_refused", message: gate.reason },
          });
        }
        // ... and a live (not test) account only when the policy lists it under accounts.write.
        const testAccount = await testFlag(view.customerId); // once per call
        if (testAccount === false && rt.policy().liveWrites?.(view.customerId) !== true) {
          return ok(`Not sent: ${NOT_TEST_ACCOUNT_MESSAGE}`, {
            change: changeOut(view),
            applied: false,
            refused: { code: "not_test_account", message: NOT_TEST_ACCOUNT_MESSAGE },
          });
        }
        if (view.riskTier === "auto") {
          // The policy's own approval (low-risk types only); else a person approves as usual.
          try {
            const approved = rt.engine().autoApprove(view.id, AGENT);
            return await applyNow(approved, started);
          } catch (err) {
            if (!(err instanceof ChangeError && err.code === "policy_refused")) throw err;
          }
        }
        return await getApproval(
          "apply_change",
          view,
          "approve",
          ctx,
          started,
          { testAccount },
          async (v, s) =>
            v.status === "approved"
              ? applyNow(v, s)
              : ok(`${v.id}: ${statusText(v)}`, { change: changeOut(v), applied: false }),
          (v) => v.status === "proposed",
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "undo_change",
    {
      title: "Propose an undo",
      description:
        "Proposes a change restoring the values from before an applied change. Needs its own approval via apply_change.",
      inputSchema: z.object({ change_id: changeId }),
      annotations: {
        title: "Propose an undo",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ change_id }) => {
      try {
        const v = await withDeadline(rt.engine().proposeUndo(change_id, AGENT), TOOL_DEADLINE_MS);
        return ok(
          `Undo proposed as ${v.id}. Not applied. Call apply_change with ${v.id}: it needs its own approval.`,
          { change: changeOut(v), untrustedNote: UNTRUSTED_NOTE },
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_change",
    {
      title: "Get a change",
      description:
        "One change: status in plain words, diff, approval, result. An in_doubt change is re-checked by reading.",
      inputSchema: z.object({ change_id: changeId }),
      annotations: {
        title: "Get a change",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ change_id }) => {
      try {
        let v = mustGet(change_id);
        if (v.status === "in_doubt") {
          try {
            v = await withDeadline(rt.engine().resolveInDoubt(change_id), TOOL_DEADLINE_MS);
          } catch {
            v = mustGet(change_id); // still unclear; shown as it is
          }
        }
        return ok(`${v.id}: ${statusText(v)}`, {
          change: changeOut(v),
          untrustedNote: UNTRUSTED_NOTE,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_changes",
    {
      title: "List changes",
      description:
        "Recent changes, newest first: id, type, status in plain words, account, a one-line summary and times. get_change shows one change in full.",
      inputSchema: z.object({
        customer_id: z.string().optional(),
        status: z.string().max(30).optional().describe("e.g. proposed, verified, in_doubt"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LISTED_CHANGES)
          .optional()
          .describe(`Default 20, max ${MAX_LISTED_CHANGES}`),
      }),
      annotations: {
        title: "List changes",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ customer_id, status, limit }) => {
      try {
        let customerId: string | undefined;
        if (customer_id !== undefined) {
          customerId = customer_id.replace(/-/g, "");
          if (!/^\d{10}$/.test(customerId)) {
            throw new ToolInputError("customer_id must be a 10-digit Google Ads account id.");
          }
        }
        if (status !== undefined && !isChangeStatus(status)) {
          throw new ToolInputError(`Unknown status. Known: ${CHANGE_STATUSES.join(", ")}.`);
        }
        const views = rt.engine().list({
          ...(customerId ? { customerId } : {}),
          ...(status ? { status } : {}),
          limit: limit ?? 20,
        });
        const more =
          views.length === (limit ?? 20)
            ? " Newest first; older ones may exist (filter by account or status)."
            : "";
        return ok(`${views.length} change${views.length === 1 ? "" : "s"}.${more}`, {
          total: views.length,
          changes: views.map(briefOut),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "resolve_change",
    {
      title: "Settle an unclear change",
      description:
        "Settles an in_doubt change after the user checked Google Ads (outcome + note). A person confirms on the approval page or types its code. Sends nothing.",
      inputSchema: z.object({
        change_id: changeId,
        outcome: z.enum(["applied", "failed", "unknown"]),
        note: z.string().min(1).max(500),
      }),
      annotations: {
        title: "Settle an unclear change",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ change_id, outcome, note }, ctx) => {
      const started = rt.now();
      try {
        const view = mustGet(change_id);
        const done = async (v: ChangeView): Promise<CallToolResult> => {
          dropSnapshots(v);
          return ok(`${v.id}: ${statusText(v)}`, {
            change: changeOut(v),
            settled: v.status === "resolved_by_user",
          });
        };
        const state = ctx.mcpReq.requestState<ApprovalState>();
        if (state !== undefined) {
          if (view.status !== "in_doubt") return done(view);
          return await codeRound("resolve_change", view, state, ctx, started, done);
        }
        if (view.status !== "in_doubt") {
          return fail(
            `Change ${view.id} is ${view.status}; only unclear (in_doubt) changes can be settled.`,
          );
        }
        const sent = rt
          .store()
          .db.prepare("SELECT last_sent_at, applying_at FROM changes WHERE id = ?")
          .get(view.id) as { last_sent_at: string | null; applying_at: string | null } | undefined;
        const sentAt = Date.parse(sent?.last_sent_at ?? sent?.applying_at ?? "");
        if (Number.isFinite(sentAt) && rt.now() - sentAt < ITEM_LOCK_MS) {
          return fail(
            `Wait until ${new Date(sentAt + ITEM_LOCK_MS).toISOString()}: the first send could still land. Check the account after that.`,
          );
        }
        return await getApproval(
          "resolve_change",
          view,
          "resolve",
          ctx,
          started,
          { outcome, note, testAccount: await testFlag(view.customerId) },
          async (v) => done(v),
          (v) => v.status === "in_doubt",
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerResource(
    "change-log",
    "changes://log",
    {
      title: "Change audit log",
      description: "Audit log, newest first (50 events). Older: changes://log/before/{seq}.",
      mimeType: "application/json",
    },
    (uri) => logPage(uri.href, undefined),
  );

  server.registerResource(
    "change-log-page",
    new ResourceTemplate("changes://log/before/{seq}", { list: undefined }),
    {
      title: "Change audit log (older)",
      description: "Audit log events with seq below {seq}, newest first.",
      mimeType: "application/json",
    },
    (uri, variables) => {
      const seq = Number(variables.seq);
      if (!Number.isInteger(seq) || seq < 1)
        throw new Error("seq must be a positive whole number.");
      return logPage(uri.href, seq);
    },
  );

  server.registerResource(
    "policy-current",
    "policy://current",
    {
      title: "Change policy in force",
      description:
        "The change policy (policy.yaml in the settings folder) as the server reads it now: status, version hash, values and a plain summary. Read-only: no tool can edit it.",
      mimeType: "application/json",
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(policyResource(rt.policyFile.state())),
        },
      ],
    }),
  );

  const logPage = (href: string, beforeSeq: number | undefined) => {
    const events = listRecentEvents(rt.store(), { ...(beforeSeq ? { beforeSeq } : {}), limit: 50 });
    const last = events.at(-1);
    const body = {
      events: events.map((e) => ({
        seq: e.seq,
        at: e.at,
        changeId: e.changeId,
        event: e.event,
        actor: e.actor,
        via: e.via,
        data: wrapUntrusted(e.data),
        hash: e.hash,
      })),
      next: last && last.seq > 1 ? `changes://log/before/${last.seq}` : null,
      untrustedNote: UNTRUSTED_NOTE,
    };
    return { contents: [{ uri: href, mimeType: "application/json", text: JSON.stringify(body) }] };
  };

  server.registerResource(
    "change",
    new ResourceTemplate("changes://{id}", { list: undefined }),
    {
      title: "One change",
      description: "A change by id (same as get_change).",
      mimeType: "application/json",
    },
    (uri, variables) => {
      const v = mustGet(String(variables.id ?? ""));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ change: changeOut(v), untrustedNote: UNTRUSTED_NOTE }),
          },
        ],
      };
    },
  );

  const typeSchemas = Object.fromEntries(
    V1_ACTION_TYPES.map((t) => [
      t.type,
      { summary: t.summary, ...z.toJSONSchema(t.input, { io: "input", unrepresentable: "any" }) },
    ]),
  );

  server.registerResource(
    "change-type-schemas",
    new ResourceTemplate("schema://changes/{type}", {
      list: () => ({
        resources: TYPE_NAMES.map((n) => ({
          uri: `schema://changes/${n}`,
          name: `${n} params`,
          mimeType: "application/schema+json",
        })),
      }),
    }),
    {
      title: "propose_change params per type",
      description: "JSON Schema of propose_change params for each change type.",
      mimeType: "application/schema+json",
    },
    (uri, variables) => {
      const name = String(variables.type ?? "");
      const schema = Object.hasOwn(typeSchemas, name) ? typeSchemas[name] : undefined;
      if (!schema) throw new Error(`No change type "${name.slice(0, 40)}".`);
      return {
        contents: [
          { uri: uri.href, mimeType: "application/schema+json", text: JSON.stringify(schema) },
        ],
      };
    },
  );
};

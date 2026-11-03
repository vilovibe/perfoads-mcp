// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// One per runtime: the approval pages this process has open, and the three ways a person
// completes an approval (page button - only where the mode allows it -, code typed into
// the AI app's form, code typed into the terminal; the terminal runs in another process
// and goes through the store).

import { createRequestStateCodec, type RequestStateCodec } from "@modelcontextprotocol/server";
import type { Logger } from "@perfoads/ads-client";
import {
  appendEvent,
  ChangeError,
  type ApprovalVia,
  type ChangeEngine,
  type ChangeView,
  type ResolveOutcome,
} from "@perfoads/changes";
import { approvalHmacKey, howToRun, type Store } from "@perfoads/store";
import { startApprovalPage, type ApprovalPage, type PageAction } from "./page.js";
import {
  checkCode,
  createSession,
  endSession,
  finishSession,
  getSession,
  markServed,
  openSessionFor,
  openSessionsFor,
  sameApproval,
  type ApprovalSession,
  type CodeCheck,
  type SessionKind,
} from "./sessions.js";
import { approvalPageHtml, resultPageHtml } from "./view.js";

/**
 * auto: the page has an Approve button only for AI apps without forms; with forms it is
 * code-only. code_only: never an Approve button (apps without forms: approve in a terminal).
 */
export type ApprovalMode = "auto" | "code_only";

/** Signed elicitation state (MRTR requestState): which tool, change, version, session, once. */
export interface ApprovalState {
  tool: string;
  /** change id */
  c: string;
  /** change version (diff hash) */
  v: string;
  /** approval session id */
  s: string;
  /** single-use nonce, also held by the session row */
  n: string;
  /** expiry (epoch ms) */
  e: number;
  /** when the first round started (epoch ms) */
  t: number;
}

export interface ApprovalServiceOptions {
  store: () => Store;
  engine: () => ChangeEngine;
  now: () => number;
  /** Opens the page URL in the person's browser. False when it could not. */
  openUrl: (url: string) => boolean | Promise<boolean>;
  user: () => string;
  logger: Logger;
  mode: ApprovalMode;
  /** false (config open_browser): never start a browser opener; `approvals open` instead. */
  openBrowser?: boolean;
  pollMs?: number;
  /** Policy lines for the approval view (never throws; [] when unknown). */
  policyLines?: (change: ChangeView) => string[];
  /** Waits ms on the `now` clock (default a real timer); ends early when the signal aborts. */
  sleep?: Sleep;
}

/** Waits ms on the runtime clock; resolves early (never rejects) when the signal aborts. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** The production Sleep: a real timer, cleared on abort. */
export const timerSleep: Sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done);
  });

interface LivePage {
  page: ApprovalPage;
  session: ApprovalSession;
  approveButton: boolean;
}

export type CodeResult =
  | { ok: true; change: ChangeView }
  | Exclude<CodeCheck, { ok: true }>
  | { ok: false; reason: "refused"; message: string };

export const browserOpenFailed = (changeId: string): string =>
  `Couldn't open a browser; open this machine's approval page by running \`${howToRun(`approvals open ${changeId}`)}\` in a terminal, as the OS user this server runs as. Nothing was approved.`;

/** open_browser is false: the server never opens the page; a person does, in a terminal. */
export const approvalsOpenNeeded = (changeId: string): string =>
  `This server doesn't open approval pages itself (open_browser is false in its config.json). Ask the person to run \`${howToRun(`approvals open ${changeId}`)}\` in a terminal, as the OS user this server runs as (hardened setup: for example with \`sudo -u <service user>\`). It shows the page and asks for its code there. Then call this tool again. Nothing was approved.`;

export const createApprovalService = (o: ApprovalServiceOptions) => {
  const pages = new Map<string, LivePage>();
  const waiters = new Set<() => void>();
  const pollMs = o.pollMs ?? 500;
  const sleep = o.sleep ?? timerSleep;
  let codec: RequestStateCodec<ApprovalState> | undefined;

  const lines = (change: ChangeView): string[] => {
    try {
      return o.policyLines?.(change) ?? [];
    } catch {
      return [];
    }
  };

  const notify = (): void => {
    for (const w of [...waiters]) w();
  };

  const closePage = (changeId: string): void => {
    const live = pages.get(changeId);
    if (!live) return;
    pages.delete(changeId);
    live.page.close();
  };

  const sessionOpen = (id: string): boolean =>
    getSession(o.store(), id, o.now())?.status === "open";

  const pageDecision = async (
    session: ApprovalSession,
    action: PageAction,
  ): Promise<{ status: number; html: string }> => {
    const store = o.store();
    const engine = o.engine();
    const by = o.user();
    const finished = {
      status: 409,
      html: resultPageHtml("Already finished", "Nothing was changed here."),
    };
    try {
      if (action === "reject") {
        if (!endSession(store, session.id, "closed", o.now())) return finished;
        if (session.kind === "approve") {
          engine.markRejected(session.changeId, { actor: by, via: "browser" });
          return {
            status: 200,
            html: resultPageHtml(
              "Rejected",
              "The change was rejected. Nothing was sent to Google Ads.",
            ),
          };
        }
        return { status: 200, html: resultPageHtml("Cancelled", "Nothing was settled.") };
      }
      if (!endSession(store, session.id, "used", o.now())) return finished;
      finishSession(store, engine, session.id, "browser", by, o.now());
      return session.kind === "approve"
        ? {
            status: 200,
            html: resultPageHtml(
              "Approved",
              "Approved. The AI app can now send it to Google Ads (apply_change).",
            ),
          }
        : {
            status: 200,
            html: resultPageHtml("Settled", "The change was settled as you confirmed."),
          };
    } catch (err) {
      const message =
        err instanceof ChangeError ? err.message : "Something went wrong. Nothing was approved.";
      return { status: 409, html: resultPageHtml("Not approved", message) };
    } finally {
      notify();
    }
  };

  /** The opened link was used twice: burn the session (its code stops working) and log it. */
  const openedTwice = (session: ApprovalSession): void => {
    const store = o.store();
    try {
      endSession(store, session.id, "burned", o.now());
      store.immediate(() =>
        appendEvent(
          store,
          {
            changeId: session.changeId,
            event: "approval_page_closed",
            actor: "server",
            via: "browser",
            data: { reason: "opened_twice", session: session.id },
          },
          new Date(o.now()).toISOString(),
        ),
      );
    } catch {
      // A busy store: the page is closed anyway; the session expires with it.
    }
    o.logger.warn("approval page opened twice: closed and its code burned", {
      changeId: session.changeId,
    });
    if (pages.get(session.changeId)?.session.id === session.id) pages.delete(session.changeId);
    notify();
  };

  /** Starts a page for a session (code shown only there). */
  const serve = (
    change: ChangeView,
    session: ApprovalSession,
    code: string,
    approveButton: boolean,
    testAccount: boolean | null,
  ): Promise<ApprovalPage> => {
    const policyLines = session.kind === "approve" ? lines(change) : [];
    return startApprovalPage({
      html: (csrf) =>
        approvalPageHtml({
          change,
          kind: session.kind,
          code,
          csrf,
          testAccount,
          approveButton,
          pageExpiresAt: session.expiresAt,
          outcome: session.outcome,
          note: session.note,
          policyLines,
        }),
      decide: (action) => pageDecision(session, action),
      approveAllowed: approveButton,
      onOpenedTwice: () => openedTwice(session),
      expiresAt: Date.parse(session.expiresAt),
      now: o.now,
      isLive: () => {
        try {
          return sessionOpen(session.id);
        } catch {
          return true; // busy store: keep the page; the decision path checks again
        }
      },
    });
  };

  /**
   * Opens (or reuses) the approval page for a change in the person's browser. Throws a
   * plain error when the page can't be served or no browser could be started (then the
   * session stays, without a page, for `approvals open <id>` in a terminal).
   */
  const open = async (
    change: ChangeView,
    kind: SessionKind,
    extra: {
      testAccount: boolean | null;
      /** The AI app can show a form (then the page is code-only in auto mode). */
      clientHasForms: boolean;
      outcome?: ResolveOutcome;
      note?: string;
    },
  ): Promise<{ session: ApprovalSession; reused: boolean; elsewhere: boolean }> => {
    const approveButton = o.mode === "auto" && !extra.clientHasForms;
    const store = o.store();
    const same = (s: ApprovalSession) =>
      sameApproval(s, change, kind, extra.outcome ?? null, extra.note ?? null);
    const live = pages.get(change.id);
    // The newest page showing a code for the same change, version and kind, in any process.
    const newest = openSessionsFor(store, change.id, o.now()).find((x) => x.served && same(x));
    if (
      newest &&
      live?.session.id === newest.id &&
      live.page.isOpen() &&
      live.approveButton === approveButton
    ) {
      return { session: live.session, reused: true, elsewhere: false };
    }
    // Another process shows it (e.g. a person's `approvals open` in a terminal): reuse it,
    // never close it - its code is the one the person has.
    if (newest && newest.id !== live?.session.id) {
      return { session: newest, reused: true, elsewhere: true };
    }
    // Our own page (if any) is replaced: its session ends with it.
    if (live) {
      closePage(change.id);
      endSession(store, live.session.id, "closed", o.now());
    }
    const { session, code } = await createSession(store, {
      change,
      kind,
      now: o.now(),
      ...(extra.outcome ? { outcome: extra.outcome } : {}),
      ...(extra.note ? { note: extra.note } : {}),
    });
    if (o.openBrowser === false) {
      // No page and no opener (its command line would show the link to other processes):
      // the session stays open for `approvals open <id>` in a terminal.
      throw new ChangeError("not_allowed", approvalsOpenNeeded(change.id));
    }
    let page: ApprovalPage;
    try {
      page = await serve(change, session, code, approveButton, extra.testAccount);
    } catch {
      endSession(store, session.id, "closed", o.now());
      throw new ChangeError(
        "not_allowed",
        "Couldn't start the local approval page on 127.0.0.1. Nothing was approved. Run the doctor tool.",
      );
    }
    let opened = false;
    try {
      opened = await o.openUrl(page.url);
    } catch {
      opened = false;
    }
    if (!opened) {
      // The session stays open (no page): `approvals open <id>` in a terminal takes it over.
      page.close();
      throw new ChangeError("not_allowed", browserOpenFailed(change.id));
    }
    markServed(store, session.id, o.now());
    pages.set(change.id, { page, session, approveButton });
    void page.closed.then(() => {
      if (pages.get(change.id)?.page === page) pages.delete(change.id);
      notify();
    });
    o.logger.info("approval page opened", { changeId: change.id, kind });
    return { session: { ...session, served: true }, reused: false, elsewhere: false };
  };

  /**
   * For `approvals open <id>` in a terminal: a fresh code-only page for the change's open
   * session (or a new approve session), served by this process. Returns its URL for the
   * TTY only.
   */
  const openForTerminal = async (
    change: ChangeView,
  ): Promise<{ session: ApprovalSession; page: ApprovalPage }> => {
    const store = o.store();
    const previous = openSessionFor(store, change.id, o.now());
    const kind: SessionKind =
      previous?.kind ?? (change.status === "in_doubt" ? "resolve" : "approve");
    if (kind === "approve" && change.status !== "proposed") {
      throw new ChangeError(
        "wrong_state",
        `Change ${change.id} is ${change.status}: nothing to approve.`,
      );
    }
    if (kind === "resolve" && (!previous || change.status !== "in_doubt")) {
      throw new ChangeError(
        "wrong_state",
        `Nothing to settle for ${change.id}: ask the AI to call resolve_change first.`,
      );
    }
    closePage(change.id);
    const { session, code } = await createSession(store, {
      change,
      kind,
      now: o.now(),
      ...(previous?.outcome ? { outcome: previous.outcome } : {}),
      ...(previous?.note ? { note: previous.note } : {}),
    });
    const page = await serve(change, session, code, false, null);
    markServed(store, session.id, o.now());
    pages.set(change.id, { page, session: { ...session, served: true }, approveButton: false });
    return { session, page };
  };

  /** A person typed the code (elicitation form or terminal). */
  const completeWithCode = async (
    sessionId: string,
    typed: unknown,
    via: Exclude<ApprovalVia, "browser">,
  ): Promise<CodeResult> => {
    const store = o.store();
    const result = await checkCode(store, sessionId, typed, o.now());
    if (!result.ok) {
      if (result.reason !== "wrong") {
        const s = getSession(store, sessionId, o.now());
        if (s) closePage(s.changeId);
      }
      notify();
      return result;
    }
    closePage(result.session.changeId);
    try {
      return {
        ok: true,
        change: finishSession(store, o.engine(), sessionId, via, o.user(), o.now()),
      };
    } catch (err) {
      if (err instanceof ChangeError) return { ok: false, reason: "refused", message: err.message };
      throw err;
    } finally {
      notify();
    }
  };

  /** Closes every open session (and page) of a change, e.g. after a reject in the terminal. */
  const closeSessionsFor = (changeId: string): void => {
    closePage(changeId);
    for (const s of openSessionsFor(o.store(), changeId, o.now())) {
      endSession(o.store(), s.id, "closed", o.now());
    }
  };

  /**
   * Waits until `done()` is true (checked on every page decision and every pollMs), the
   * clock reaches `deadlineAt`, or the signal aborts.
   */
  const waitFor = (done: () => boolean, deadlineAt: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      let finished = false;
      const stop = new AbortController();
      const check = () => {
        let yes = false;
        try {
          yes = done();
        } catch {
          yes = false; // busy store: look again on the next tick
        }
        if (yes || o.now() >= deadlineAt) finish();
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        stop.abort();
        waiters.delete(check);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      waiters.add(check);
      signal?.addEventListener("abort", finish);
      check();
      // Polls on the runtime clock (sleep), so a test clock drives it without real time.
      void (async () => {
        while (!finished) {
          await sleep(Math.max(1, Math.min(pollMs, deadlineAt - o.now())), stop.signal);
          if (!finished) check();
        }
      })();
    });

  return {
    open,
    openForTerminal,
    /** Policy lines for the form / terminal summary (same as on the page). */
    policyLines: lines,
    completeWithCode,
    closeSessionsFor,
    waitFor,
    mode: o.mode,
    /** false: the server never opens pages; approval is typed in a terminal (no form). */
    opensBrowser: o.openBrowser !== false,
    /** HMAC codec for elicitation request state; key from the store. */
    codec: (): RequestStateCodec<ApprovalState> =>
      (codec ??= createRequestStateCodec<ApprovalState>({
        key: approvalHmacKey(o.store()),
        ttlSeconds: 30 * 60,
      })),
    hasPage: (changeId: string): boolean => pages.get(changeId)?.page.isOpen() === true,
    /**
     * The page of this session goes away for good (the terminal command ended, the server
     * stops): its session closes too, so no other process reuses a code nobody can see.
     */
    release: (sessionId: string): void => {
      for (const [changeId, live] of pages) {
        if (live.session.id === sessionId) closePage(changeId);
      }
      try {
        endSession(o.store(), sessionId, "closed", o.now());
      } catch {
        // A busy or closing store: the session expires on its own.
      }
    },
    closeAll: (): void => {
      for (const [id, live] of [...pages]) {
        closePage(id);
        try {
          endSession(o.store(), live.session.id, "closed", o.now());
        } catch {
          // A busy or closing store: the session expires on its own.
        }
      }
    },
  };
};

export type ApprovalService = ReturnType<typeof createApprovalService>;

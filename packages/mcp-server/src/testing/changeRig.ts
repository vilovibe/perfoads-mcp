// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Test wiring for the change tools: the change engine's fake Google account behind the
// runtime's fake fetch, a captured browser opener, a small HTTP helper for the approval
// page, and an MCP client on either protocol era (2025-11-25 or 2026-07-28 MRTR).

import { request } from "node:http";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  createFakeGoogle,
  fakeWorld,
  permissiveTestPolicy,
  type FakeGoogleHooks,
  type FakeWorld,
} from "@perfoads/changes/testing";
import type { PolicyCheck } from "@perfoads/changes";
import { createMcpServer } from "../server.js";
import type { ChangeToolTiming } from "../changeTools.js";
import type { Sleep } from "../approvals/service.js";
import { envCredentials, googleRouter, testRuntime, FAKE_DIRECT, type Router } from "./fakes.js";

export const ACCOUNT = FAKE_DIRECT;

/** Routes the account's search / mutate calls to the change engine's fake Google. */
export const adaptFakeGoogle =
  (fake: ReturnType<typeof createFakeGoogle>): Router =>
  (call) => {
    if (!new RegExp(`customers/${ACCOUNT}/googleAds:(search|mutate)$`).test(call.url)) {
      return undefined;
    }
    const reply = fake.router({
      url: call.url,
      method: call.method,
      headers: call.headers,
      body: call.body ? (JSON.parse(call.body) as unknown) : undefined,
      signal: call.signal,
    });
    if ("networkError" in reply || "hang" in reply) throw new Error("not supported in this rig");
    return { status: reply.status ?? 200, body: reply.body ?? {} };
  };

export interface PageReply {
  status: number;
  body: string;
  location?: string | undefined;
  /** name=value of a Set-Cookie header, if any. */
  cookie?: string | undefined;
}

/** One raw HTTP request (any Host / Origin header), for the approval page. */
export const pageRequest = (
  url: string,
  o: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<PageReply> =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method: o.method ?? "GET",
        headers: { host: u.host, ...o.headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            location: typeof res.headers.location === "string" ? res.headers.location : undefined,
            cookie: res.headers["set-cookie"]?.[0]?.split(";")[0],
          }),
        );
      },
    );
    req.on("error", reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });

/** Opened URL -> the fresh URL the page moved to on its first GET (303) + its cookie. */
const rotated = new Map<string, { url: string; cookie: string }>();

/** The page's current URL (after its first GET it lives at a fresh token path). */
export const currentUrl = (url: string): string => rotated.get(url)?.url ?? url;

/** The cookie the page set for this browser (the rig acts as that browser). */
export const cookieFor = (url: string): Record<string, string> => {
  const c = rotated.get(url)?.cookie;
  return c ? { cookie: c } : {};
};

/** GETs the page (following its one-time 303) and reads the code and the CSRF token. */
export const readPage = async (opened: string) => {
  const url = currentUrl(opened);
  let r = await pageRequest(url, { headers: cookieFor(opened) });
  let final = url;
  const location = /^\/a\/[A-Za-z0-9_-]+$/.test(r.location ?? "") ? r.location : undefined;
  if (r.status === 303 && location) {
    final = `${new URL(url).origin}${location}`;
    rotated.set(opened, { url: final, cookie: r.cookie ?? "" });
    r = await pageRequest(final, { headers: cookieFor(opened) });
  }
  const code = /class="code">([A-Z0-9 ]+)</.exec(r.body)?.[1]?.replace(/ /g, "");
  const csrf = /name="csrf" value="([^"]+)"/.exec(r.body)?.[1];
  return { ...r, url: final, code: code ?? "", csrf: csrf ?? "" };
};

/** POSTs a decision the way the page's own form does. */
export const postDecision = (
  url: string,
  csrf: string,
  action: "approve" | "reject",
  headers: Record<string, string> = {},
) =>
  pageRequest(currentUrl(url), {
    method: "POST",
    headers: {
      origin: new URL(url).origin,
      "content-type": "application/x-www-form-urlencoded",
      ...cookieFor(url),
      ...headers,
    },
    body: new URLSearchParams({ csrf, action }).toString(),
  });

export const TEST_TIMING: ChangeToolTiming = {
  approvalWaitMs: 400,
  accountLookupMs: 5_000,
  applyCallBudgetMs: 230_000,
  applyDeadlineMs: 200_000,
};

export type Era = "legacy" | "modern";

export const changeRig = (
  o: {
    world?: FakeWorld;
    hooks?: FakeGoogleHooks;
    /** null = no policy (the default read-only one). */
    policy?: PolicyCheck | null;
    timing?: Partial<ChangeToolTiming>;
    openUrl?: (url: string) => boolean | Promise<boolean>;
    approvalMode?: "auto" | "code_only";
    /** config open_browser (default: the file's, i.e. true). */
    openBrowser?: boolean;
    /** Answers first (e.g. a stalled account list). */
    extraRouter?: Router;
    /**
     * The clock stands still and moves only by test code (clock.now += ms, clock.runUntil);
     * the server's waits (rt.sleep) end when it reaches them. No real time is spent waiting.
     */
    manualClock?: boolean;
    /** How often a waiting apply_change polls (default 20 ms; 1 s with manualClock). */
    approvalPollMs?: number;
    /** The server's waits (default real timers; manualClock replaces it). */
    sleep?: Sleep;
  } = {},
) => {
  const world = o.world ?? fakeWorld();
  const fake = createFakeGoogle(world, o.hooks ?? {});
  const opened: string[] = [];
  // Runs with real time unless manualClock; tests may jump it forward (clock.now += ms).
  let offset = 0;
  let manualNow = Date.now();
  const sleepers: { at: number; wake: () => void }[] = [];
  const wakeDue = () => {
    for (const s of sleepers.filter((x) => x.at <= manualNow)) s.wake();
  };
  const clock = {
    get now(): number {
      return o.manualClock ? manualNow : Date.now() + offset;
    },
    set now(value: number) {
      if (!o.manualClock) {
        offset = value - Date.now();
        return;
      }
      manualNow = value;
      wakeDue();
    },
    /**
     * manualClock only: lets pending work run, then moves the clock to the next server wait,
     * until `done()` (or the clock passes `limitMs` from the start, a guard against a hang).
     * It advances fake time whenever any wait is pending, without knowing what else is in
     * flight: never run it alongside real network work (e.g. a page request) during a wait,
     * or the clock races past that wait's deadline. Do such steps between runUntil calls.
     */
    runUntil: async (done: () => boolean, limitMs = 30 * 60 * 1000): Promise<void> => {
      if (!o.manualClock) throw new Error("runUntil needs manualClock");
      const end = manualNow + limitMs;
      for (;;) {
        await new Promise<void>((x) => setImmediate(x));
        if (done()) return;
        if (manualNow > end) throw new Error("runUntil: clock limit reached");
        const next = Math.min(...sleepers.map((x) => x.at));
        if (Number.isFinite(next)) clock.now = Math.max(next, manualNow);
      }
    },
  };
  const manualSleep: Sleep = (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const s = {
        at: manualNow + ms,
        wake: () => {
          const i = sleepers.indexOf(s);
          if (i < 0) return;
          sleepers.splice(i, 1);
          signal?.removeEventListener("abort", s.wake);
          resolve();
        },
      };
      sleepers.push(s);
      signal?.addEventListener("abort", s.wake);
    });
  const policy = o.policy === null ? undefined : (o.policy ?? permissiveTestPolicy());
  const t = testRuntime({
    env: envCredentials,
    router: googleRouter(
      async (call) => (await o.extraRouter?.(call)) ?? adaptFakeGoogle(fake)(call),
    ),
    now: () => clock.now,
    runtime: {
      ...(policy ? { policy } : {}),
      openUrl:
        o.openUrl ??
        ((url) => {
          opened.push(url);
          return true;
        }),
      approvalUser: "test-person",
      ...(o.approvalMode ? { approvalMode: o.approvalMode } : {}),
      ...(o.openBrowser === undefined ? {} : { openBrowser: o.openBrowser }),
      // Manual clock: fewer polls to step through (a page decision still ends the wait at once).
      approvalPollMs: o.approvalPollMs ?? (o.manualClock ? 1_000 : 20),
      engineTiming: { sleep: async () => undefined },
      ...(o.manualClock ? { sleep: manualSleep } : o.sleep ? { sleep: o.sleep } : {}),
    },
  });
  const timing = { ...TEST_TIMING, ...o.timing };
  const closers: (() => Promise<void>)[] = [];

  /** An MCP client. `elicit` answers elicitation/create (omit it: the client has no forms). */
  const connect = async (
    era: Era = "legacy",
    elicit?: (params: { message: string }) => Promise<Record<string, unknown>>,
  ) => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const sent: Record<string, unknown>[] = [];
    const send = clientSide.send.bind(clientSide);
    clientSide.send = async (m, opts) => {
      sent.push(JSON.parse(JSON.stringify(m)) as Record<string, unknown>);
      return send(m, opts);
    };
    const handle = serveStdio(() => createMcpServer(t.rt, { changeTiming: timing }), {
      transport: serverSide,
    });
    const client = new Client(
      { name: "test-client", version: "0.0.0" },
      {
        capabilities: elicit ? { elicitation: { form: {} } } : {},
        ...(era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {}),
      },
    );
    const messages: string[] = [];
    if (elicit) {
      client.setRequestHandler("elicitation/create", async (req) => {
        const params = req.params as { message: string };
        messages.push(params.message);
        return (await elicit(params)) as never;
      });
    }
    await client.connect(clientSide);
    closers.push(async () => {
      await client.close();
      await handle.close();
    });
    /** Sends a raw JSON-RPC request on the client's transport and waits for its answer. */
    const raw = async (message: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const id = `raw-${Math.random().toString(36).slice(2)}`;
      const original = clientSide.onmessage;
      if (!original) throw new Error("client not connected");
      return new Promise((resolve) => {
        clientSide.onmessage = (m, extra) => {
          if ((m as { id?: unknown }).id === id) {
            clientSide.onmessage = original;
            resolve(m as Record<string, unknown>);
          } else original(m, extra);
        };
        void send({ ...message, id } as never);
      });
    };
    return { client, sent, messages, raw };
  };

  return {
    rt: t.rt,
    fake,
    world,
    opened,
    clock,
    logLines: t.logLines,
    calls: t.calls,
    connect,
    cleanup: async () => {
      for (const c of closers.splice(0).reverse()) await c();
      t.cleanup();
    },
  };
};

export type ChangeRig = ReturnType<typeof changeRig>;

export const textOf = (res: { content?: unknown }): string =>
  ((res.content as { type: string; text?: string }[] | undefined) ?? [])
    .map((c) => c.text ?? "")
    .join("\n");

export const budgetParams = (amount = "12.50") => ({ budget_id: "222", daily_amount: amount });

/** The token in a page URL (the path segment after /a/). */
export const tokenOf = (url: string): string => url.split("/a/")[1] ?? "";

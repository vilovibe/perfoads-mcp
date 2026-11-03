// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { request } from "node:http";
import { networkInterfaces } from "node:os";
import type { ChangeView } from "@perfoads/changes";
import { afterEach, describe, expect, it } from "vitest";
import {
  cookieFor,
  currentUrl,
  pageRequest,
  postDecision,
  readPage,
} from "../testing/changeRig.js";
import {
  openerCommand,
  openLocalPage,
  startApprovalPage,
  type ApprovalPage,
  type PageAction,
} from "./page.js";
import { approvalPageHtml, approvalSummaryText } from "./view.js";

const pages: ApprovalPage[] = [];
afterEach(() => {
  for (const p of pages.splice(0)) p.close();
});

const start = async (
  o: {
    expiresAt?: number;
    now?: () => number;
    isLive?: () => boolean;
    slow?: Promise<void>;
    approveAllowed?: boolean;
  } = {},
) => {
  const decisions: PageAction[] = [];
  const page = await startApprovalPage({
    html: (csrf) => `<p class="code">ABC234</p><input type="hidden" name="csrf" value="${csrf}">`,
    decide: async (action) => {
      decisions.push(action);
      await o.slow;
      return { status: 200, html: "done" };
    },
    expiresAt: o.expiresAt ?? Date.now() + 60_000,
    approveAllowed: o.approveAllowed ?? true,
    ...(o.now ? { now: o.now } : {}),
    ...(o.isLive ? { isLive: o.isLive } : {}),
  });
  pages.push(page);
  return { page, decisions };
};

describe("approval page", () => {
  it("binds 127.0.0.1 only, on a random port, with a long one-time token in the path", async () => {
    const { page } = await start();
    expect(page.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/a\/[A-Za-z0-9_-]{32}$/);
    const other = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal);
    const targets = [
      `http://[::1]:${page.port}/`,
      ...(other ? [`http://${other.address}:${page.port}/`] : []),
    ];
    for (const t of targets) await expect(pageRequest(t)).rejects.toThrow();
    expect((await readPage(page.url)).status).toBe(200);
  });

  it("wrong Host header (DNS rebinding) -> 403; wrong path -> 404", async () => {
    const { page } = await start();
    for (const host of [
      "evil.example:80",
      `localhost:${page.port}`,
      "127.0.0.1",
      `127.0.0.1:${page.port + 1}`,
    ]) {
      expect((await pageRequest(page.url, { headers: { host } })).status).toBe(403);
    }
    expect((await pageRequest(page.url.replace(/\/a\/.+$/, "/a/wrong"))).status).toBe(404);
  });

  it("wrong Origin or a cross-site fetch -> 403; a POST without Origin -> 403", async () => {
    const { page, decisions } = await start();
    const { csrf, url } = await readPage(page.url);
    expect((await pageRequest(url, { headers: { origin: "http://evil.example" } })).status).toBe(
      403,
    );
    expect((await pageRequest(url, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(
      403,
    );
    expect(
      (await postDecision(page.url, csrf, "approve", { origin: "http://evil.example" })).status,
    ).toBe(403);
    const noOrigin = await pageRequest(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...cookieFor(page.url) },
      body: new URLSearchParams({ csrf, action: "approve" }).toString(),
    });
    expect(noOrigin.status).toBe(403);
    expect(decisions).toEqual([]);
  });

  it("GET never decides", async () => {
    const { page, decisions } = await start();
    for (let i = 0; i < 3; i++) expect((await readPage(page.url)).status).toBe(200);
    expect(
      (
        await pageRequest(`${currentUrl(page.url)}?action=approve`, {
          headers: cookieFor(page.url),
        })
      ).status,
    ).toBe(200);
    expect(decisions).toEqual([]);
    expect(page.isOpen()).toBe(true);
  });

  it("POST without or with a wrong CSRF token is refused", async () => {
    const { page, decisions } = await start();
    await readPage(page.url);
    expect((await postDecision(page.url, "", "approve")).status).toBe(403);
    expect((await postDecision(page.url, "x".repeat(32), "approve")).status).toBe(403);
    expect(decisions).toEqual([]);
  });

  it("is single use: a second POST, even sent while the first is being handled, is refused", async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<void>((r) => (release = r));
    const { page, decisions } = await start({ slow });
    const { csrf } = await readPage(page.url);
    const first = postDecision(page.url, csrf, "approve");
    while (decisions.length === 0) await new Promise((r) => setTimeout(r, 5));
    const second = await postDecision(page.url, csrf, "approve");
    expect(second.status).toBe(410);
    release();
    expect((await first).status).toBe(200);
    expect(decisions).toEqual(["approve"]);
    await page.closed;
    await expect(readPage(page.url)).rejects.toThrow();
  });

  it("expired, or finished elsewhere -> 410 and closed; nothing decided", async () => {
    const clock = { now: 1_000 };
    const expired = await start({ expiresAt: 2_000, now: () => clock.now });
    const { csrf } = await readPage(expired.page.url);
    clock.now = 2_000;
    expect((await postDecision(expired.page.url, csrf, "approve")).status).toBe(410);
    expect(expired.decisions).toEqual([]);
    await expired.page.closed;
    const done = await start({ isLive: () => false });
    expect((await readPage(done.page.url)).status).toBe(410);
  });

  it("the opened URL works once: 303 to a fresh path + an HttpOnly SameSite=Strict cookie scoped to it", async () => {
    const { page } = await start();
    const first = await pageRequest(page.url);
    expect(first.status).toBe(303);
    expect(first.location).toMatch(/^\/a\/[A-Za-z0-9_-]{32}$/);
    expect(first.location).not.toBe(new URL(page.url).pathname);
    expect(first.body).toBe("");
    const fresh = `${new URL(page.url).origin}${first.location ?? ""}`;
    const cookie = first.cookie ?? "";
    expect(cookie).toMatch(/^perfoads_approval=[A-Za-z0-9_-]{32}$/);
    // Replaying the fresh URL without the cookie (another browser, curl) fails.
    expect((await pageRequest(fresh)).status).toBe(404);
    expect(
      (await pageRequest(fresh, { headers: { cookie: "perfoads_approval=nope" } })).status,
    ).toBe(404);
    expect((await pageRequest(fresh, { headers: { cookie } })).status).toBe(200);
    expect((await pageRequest(fresh, { headers: { cookie } })).status).toBe(200);
    // Before the first GET nothing but GET works.
    const other = await start();
    expect((await pageRequest(other.page.url, { method: "POST" })).status).toBe(404);
  });

  it("the cookie's attributes: HttpOnly, SameSite=Strict, Path = the fresh path", async () => {
    const { page } = await start();
    const raw = await new Promise<string>((resolve, reject) => {
      const u = new URL(page.url);
      const req = request({ host: u.hostname, port: u.port, path: u.pathname }, (res) => {
        resolve(String(res.headers["set-cookie"]?.[0] ?? ""));
        res.resume();
      });
      req.on("error", reject);
      req.end();
    });
    expect(raw).toMatch(/; HttpOnly/);
    expect(raw).toMatch(/; SameSite=Strict/);
    expect(raw).toMatch(/; Path=\/a\/[A-Za-z0-9_-]{32}/);
  });

  it("the opened URL used again after the move (someone else has it): closed at once, nothing decided", async () => {
    let twice = 0;
    const decisions: PageAction[] = [];
    const page = await startApprovalPage({
      html: (csrf) => `<input type="hidden" name="csrf" value="${csrf}">`,
      decide: async (a) => {
        decisions.push(a);
        return { status: 200, html: "done" };
      },
      approveAllowed: true,
      expiresAt: Date.now() + 60_000,
      onOpenedTwice: () => twice++,
    });
    pages.push(page);
    const { csrf } = await readPage(page.url);
    const again = await pageRequest(page.url);
    expect(again.status).toBe(410);
    expect(again.body).toContain(
      "This approval page was already opened somewhere else, so it has been closed for safety. Ask your AI to apply again.",
    );
    expect(twice).toBe(1);
    await page.closed;
    await expect(postDecision(page.url, csrf, "approve")).rejects.toThrow();
    expect(decisions).toEqual([]);
  });

  it("a code-only page refuses an approve POST (reject still works)", async () => {
    const { page, decisions } = await start({ approveAllowed: false });
    const { csrf } = await readPage(page.url);
    expect((await postDecision(page.url, csrf, "approve")).status).toBe(403);
    expect(decisions).toEqual([]);
    expect((await postDecision(page.url, csrf, "reject")).status).toBe(200);
    expect(decisions).toEqual(["reject"]);
  });

  it("the opener only accepts approval page URLs", async () => {
    expect(await openLocalPage("https://evil.example/a/xxxxxxxxxxxxxxxxxxxxxxxx")).toBe(false);
    expect(await openLocalPage("http://127.0.0.1:1/a/x; rm -rf ~")).toBe(false);
  });

  it("the opener runs by absolute path without BROWSER or secrets, and reports only after it started (or failed)", async () => {
    const { EventEmitter } = await import("node:events");
    const seen: { command: string; env: Record<string, unknown> }[] = [];
    const fakeSpawn = (outcome: "spawn" | "error") =>
      ((command: string, _args: string[], o: { env: Record<string, unknown> }) => {
        seen.push({ command, env: o.env });
        const child = Object.assign(new EventEmitter(), { unref: () => undefined });
        setTimeout(() => child.emit(outcome, new Error("ENOENT")), 5);
        return child;
      }) as unknown as typeof import("node:child_process").spawn;
    process.env.BROWSER = "/tmp/evil-browser";
    process.env.PERFOADS_MCP_REFRESH_TOKEN = "fake-refresh-token";
    process.env.PERFOADS_MCP_CLIENT_SECRET = "fake-client-secret";
    try {
      const url = `http://127.0.0.1:1234/a/${"x".repeat(32)}`;
      const exists = (f: string) => f === "/usr/bin/xdg-open";
      expect(await openLocalPage(url, "linux", { spawn: fakeSpawn("spawn"), exists })).toBe(true);
      expect(await openLocalPage(url, "linux", { spawn: fakeSpawn("error"), exists })).toBe(false);
      expect(seen[0]?.command).toBe("/usr/bin/xdg-open");
      expect(seen[0]?.env.BROWSER).toBeUndefined();
      expect(Object.keys(seen[0]?.env ?? {}).some((k) => k.startsWith("PERFOADS_MCP_"))).toBe(
        false,
      );
      expect(JSON.stringify(seen[0]?.env)).not.toContain("fake-");
      expect(seen[0]?.env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
    } finally {
      delete process.env.BROWSER;
      delete process.env.PERFOADS_MCP_REFRESH_TOKEN;
      delete process.env.PERFOADS_MCP_CLIENT_SECRET;
    }
  });

  it("the opener is an absolute system path, never looked up in PATH", () => {
    const only =
      (...files: string[]) =>
      (f: string) =>
        files.includes(f);
    expect(openerCommand("darwin", only("/usr/bin/open"))?.command).toBe("/usr/bin/open");
    expect(openerCommand("darwin", only())).toBeUndefined();
    expect(openerCommand("linux", only("/bin/xdg-open"))?.command).toBe("/bin/xdg-open");
    expect(openerCommand("linux", only("/home/me/bin/xdg-open", "/tmp/xdg-open"))).toBeUndefined();
    const win = openerCommand("win32", () => true, { SystemRoot: "C:\\Windows" });
    expect(win?.command).toBe("C:\\Windows\\System32\\rundll32.exe");
    expect(openerCommand("win32", () => true, { SystemRoot: "evil;cmd" })?.command).toBe(
      "C:\\Windows\\System32\\rundll32.exe",
    );
  });
});

const change = (over: Partial<ChangeView> = {}): ChangeView => ({
  id: "chg_test",
  status: "proposed",
  statusReason: null,
  type: "update_budget",
  customerId: "1234567890",
  loginCustomerId: null,
  accountName: "Shop <script>alert(1)</script>",
  currencyCode: "EUR",
  payload: {},
  diff: ["Budget 222: 10.00 -> 12.50 EUR per day."],
  version: "a".repeat(64),
  affected: [
    { kind: "campaign", id: "333", name: '<img src=x onerror="alert(2)">', status: "PAUSED" },
  ],
  facts: { affectedCampaignIds: ["333"] },
  warnings: [],
  reason: "</section><script>steal()</script>",
  riskTier: "confirm",
  undo: { supported: true, why: null, level: "full" },
  modelTexts: [],
  landed: null,
  undoOf: null,
  expiresAt: "2026-10-25T10:30:00.000Z",
  createdAt: "2026-10-25T10:00:00.000Z",
  approvedBy: null,
  approvedVia: null,
  approvedAt: null,
  appliedAt: null,
  googleRequestIds: [],
  readback: null,
  error: null,
  ...over,
});

describe("approval view", () => {
  it("escapes Google and AI text; account name, id and currency come first", () => {
    const html = approvalPageHtml({
      change: change(),
      kind: "approve",
      code: "ABC234",
      csrf: "tok",
      testAccount: true,
      approveButton: true,
      pageExpiresAt: "2026-10-25T10:10:00.000Z",
    });
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<script>steal");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("Shop &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(2)&quot;&gt;");
    const body = html.slice(html.indexOf("<body>"));
    expect(body.indexOf("Shop &lt;script")).toBeLessThan(body.indexOf("What will change"));
    expect(body.indexOf("123-456-7890")).toBeLessThan(body.indexOf("What will change"));
    expect(body.indexOf("EUR")).toBeLessThan(body.indexOf("What will change"));
    expect(html).toContain("Google Ads TEST account");
    expect(html.indexOf("&lt;/section&gt;&lt;script&gt;steal()")).toBeGreaterThan(
      html.indexOf("From the AI / from Google (unverified)"),
    );
    expect(html).toContain("ABC 234");
  });

  it("create_campaign: Google's location / language names in the from-Google box; undo only while unused", () => {
    const html = approvalPageHtml({
      change: change({
        type: "create_campaign",
        facts: {
          affectedCampaignIds: [],
          googleNames: [
            { label: "Locations (id: Google's name)", items: ["2840: United <b>States</b>"] },
            { label: "Languages (id: Google's name)", items: ["1000: English"] },
          ],
        },
        undo: {
          supported: true,
          why: "Undo removes the new campaign only while it has not run.",
          level: "full_while_unused",
        },
      }),
      kind: "approve",
      code: "ABC234",
      csrf: "tok",
      testAccount: true,
      approveButton: true,
      pageExpiresAt: "2026-10-25T10:10:00.000Z",
    });
    expect(html).toContain("Locations (id: Google&#39;s name) (names from Google, unverified, 1):");
    expect(html).toContain("2840: United &lt;b&gt;States&lt;/b&gt;");
    expect(html).toContain("1000: English");
    expect(html.indexOf("1000: English")).toBeGreaterThan(
      html.indexOf("From the AI / from Google (unverified)"),
    );
    expect(html).toContain(
      "Can be undone fully only while it has not run: Undo removes the new campaign only while it has not run.",
    );
  });

  it("the form summary never holds the code", () => {
    const text = approvalSummaryText(change(), "approve");
    expect(text).toMatch(/Approve change chg_test on account 123-456-7890 \(EUR\)/);
    expect(text).not.toMatch(/ABC/);
  });

  it("the AI's reason / note are shown before the code, labelled as written by the AI", () => {
    const text = approvalSummaryText(change({ reason: "save\u202emoney\nnow" }), "approve");
    expect(text).toContain('Reason (written by the AI, unverified): "savemoney now"');
    const resolve = approvalSummaryText(change(), "resolve", "failed", "I checked it");
    expect(resolve).toContain('Note (written by the AI, unverified): "I checked it"');
    expect(text.indexOf("Reason")).toBeLessThan(text.indexOf("type the code"));
  });

  it("names are isolated in <bdi> with bidi controls removed", () => {
    const html = approvalPageHtml({
      change: change({
        accountName: "Shop\u202e\u2066reversed\u2069",
        affected: [{ kind: "campaign", id: "333", name: "C\u202dX", status: null }],
      }),
      kind: "approve",
      code: "ABC234",
      csrf: "tok",
      testAccount: true,
      approveButton: false,
      pageExpiresAt: "2026-10-25T10:10:00.000Z",
    });
    expect(/[\u202a-\u202e\u2066-\u2069]/.test(html)).toBe(false);
    expect(html).toContain("<bdi>Shopreversed</bdi>");
    expect(html).toContain("<bdi>CX</bdi>");
  });

  it("code-only page: no Approve button, the code and the terminal command instead; Reject stays", () => {
    const html = approvalPageHtml({
      change: change(),
      kind: "approve",
      code: "ABC234",
      csrf: "tok",
      testAccount: true,
      approveButton: false,
      pageExpiresAt: "2026-10-25T10:10:00.000Z",
    });
    expect(html).not.toContain('value="approve"');
    expect(html).toContain('value="reject"');
    expect(html).toContain("ABC 234");
    expect(html).toContain("<code>perfoads-mcp approve chg_test</code>");
  });
});

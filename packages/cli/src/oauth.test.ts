// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { request } from "node:http";
import { GOOGLE_AUTH_URL } from "@perfoads/mcp-server";
import { routedFetch } from "@perfoads/mcp-server/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthUrl,
  createPkce,
  openBrowser,
  pkceChallenge,
  runAuthFlow,
  startLoopback,
  type Loopback,
} from "./oauth.js";

const FAKE_CLIENT_ID = "fake-client.apps.googleusercontent.com";
const FAKE_CLIENT_SECRET = "fake-client-secret-0001";
const FAKE_REFRESH = "fake-refresh-token-0001";
const FAKE_ACCESS = "fake-access-token-0001";
const FAKE_CODE = "fake-auth-code-0001";

const open: Loopback[] = [];
afterEach(async () => {
  for (const l of open.splice(0)) await l.close();
  vi.restoreAllMocks();
});

const loopback = async () => {
  const l = await startLoopback();
  open.push(l);
  return l;
};

/** GET with a chosen Host header (fetch does not allow setting it). */
const rawGet = (port: number, pathAndQuery: string, host = `127.0.0.1:${port}`) =>
  new Promise<number>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: pathAndQuery, headers: { host } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });

describe("PKCE and the sign-in URL", () => {
  it("matches the RFC 7636 example", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("makes a fresh 43-character verifier each time", () => {
    const a = createPkce();
    const b = createPkce();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).toBe(pkceChallenge(a.verifier));
  });

  it("asks for offline Google Ads access with S256, state and consent", () => {
    const url = new URL(
      buildAuthUrl({
        clientId: FAKE_CLIENT_ID,
        redirectUri: "http://127.0.0.1:5000/",
        state: "st",
        challenge: "ch",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: FAKE_CLIENT_ID,
      scope: "https://www.googleapis.com/auth/adwords",
      access_type: "offline",
      prompt: "consent",
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: "ch",
      state: "st",
    });
  });
});

describe("Merchant Center access (opt-in)", () => {
  it("is asked for only with --merchant-center; a plain sign-in asks for Google Ads alone", () => {
    const scopeOf = (merchantCenter?: boolean) =>
      new URL(
        buildAuthUrl({
          clientId: FAKE_CLIENT_ID,
          redirectUri: "http://127.0.0.1:5000/",
          state: "st",
          challenge: "ch",
          ...(merchantCenter === undefined ? {} : { merchantCenter }),
        }),
      ).searchParams.get("scope");
    expect(scopeOf()).toBe("https://www.googleapis.com/auth/adwords");
    expect(scopeOf(false)).toBe("https://www.googleapis.com/auth/adwords");
    expect(scopeOf(true)).toBe(
      "https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/content",
    );
    // a plain sign-in keeps a Merchant Center permission granted before
    const url = new URL(
      buildAuthUrl({
        clientId: FAKE_CLIENT_ID,
        redirectUri: "http://127.0.0.1:5000/",
        state: "st",
        challenge: "ch",
      }),
    );
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
  });
});

describe("loopback server", () => {
  it("binds 127.0.0.1 only and closes after one callback", async () => {
    const l = await loopback();
    expect(l.boundAddress).toBe("127.0.0.1");
    expect(l.redirectUri).toBe(`http://127.0.0.1:${l.port}/`);
    const code = l.waitForCode("good-state", 5000);
    expect(await rawGet(l.port, `/?state=good-state&code=${FAKE_CODE}`)).toBe(200);
    await expect(code).resolves.toBe(FAKE_CODE);
    await new Promise((r) => setTimeout(r, 20));
    await expect(rawGet(l.port, "/?state=good-state&code=again")).rejects.toThrow();
  });

  it("rejects a state mismatch and still closes", async () => {
    const l = await loopback();
    const code = l.waitForCode("good-state", 5000);
    const caught = code.catch((e: unknown) => e);
    expect(await rawGet(l.port, `/?state=evil-state&code=${FAKE_CODE}`)).toBe(400);
    const err = await caught;
    expect(err).toMatchObject({ code: "state_mismatch" });
    await new Promise((r) => setTimeout(r, 20));
    await expect(rawGet(l.port, "/?state=good-state&code=x")).rejects.toThrow();
  });

  it("ignores other paths and wrong Host headers without using up the callback", async () => {
    const l = await loopback();
    const code = l.waitForCode("s1", 5000);
    expect(await rawGet(l.port, "/favicon.ico")).toBe(404);
    expect(await rawGet(l.port, "/?state=s1&code=x", "evil.example:80")).toBe(400);
    expect(await rawGet(l.port, `/?state=s1&code=${FAKE_CODE}`)).toBe(200);
    await expect(code).resolves.toBe(FAKE_CODE);
  });

  it("reports a cancelled sign-in in plain English", async () => {
    const l = await loopback();
    const code = l.waitForCode("s1", 5000).catch((e: unknown) => e);
    await rawGet(l.port, "/?state=s1&error=access_denied");
    expect(await code).toMatchObject({
      code: "access_denied",
      message: expect.stringMatching(/cancelled/),
    });
  });
});

describe("runAuthFlow", () => {
  /** Plays the browser: follows the sign-in URL's redirect back to the loopback with a code. */
  const fakeBrowser = (url: string) => {
    const u = new URL(url);
    const back = new URL(u.searchParams.get("redirect_uri") ?? "");
    back.searchParams.set("state", u.searchParams.get("state") ?? "");
    back.searchParams.set("code", FAKE_CODE);
    void rawGet(Number(back.port), `${back.pathname}${back.search}`);
  };

  const tokenFetch = (extra: Record<string, unknown> = {}) =>
    routedFetch((call) =>
      call.url === "https://oauth2.googleapis.com/token"
        ? {
            body: {
              access_token: FAKE_ACCESS,
              expires_in: 3599,
              refresh_token: FAKE_REFRESH,
              scope: "https://www.googleapis.com/auth/adwords",
              token_type: "Bearer",
              ...extra,
            },
          }
        : undefined,
    );

  it("exchanges the code with the PKCE verifier and detects Testing mode", async () => {
    const { fetch, calls } = tokenFetch({ refresh_token_expires_in: 604799 });
    let shownUrl = "";
    const result = await runAuthFlow({
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
      fetch,
      print: (line) => {
        if (line.startsWith("https://")) shownUrl = line;
      },
      open: fakeBrowser,
      now: () => Date.parse("2026-10-24T00:00:00Z"),
    });
    expect(result.testingMode).toBe(true);
    expect(result.refreshTokenExpiresAt).toBe("2026-10-30T23:59:59.000Z");
    expect(result.refreshToken).toBe(FAKE_REFRESH);
    const form = new URLSearchParams(calls[0]?.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe(FAKE_CODE);
    expect(pkceChallenge(form.get("code_verifier") ?? "")).toBe(
      new URL(shownUrl).searchParams.get("code_challenge"),
    );
  });

  it("production app: no expiry; nothing secret is printed or logged", async () => {
    const out = vi.spyOn(process.stdout, "write");
    const err = vi.spyOn(process.stderr, "write");
    const log = vi.spyOn(console, "log");
    const printed: string[] = [];
    const { fetch } = tokenFetch();
    const result = await runAuthFlow({
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
      fetch,
      print: (line) => printed.push(line),
      open: fakeBrowser,
    });
    expect(result.testingMode).toBe(false);
    expect(result.refreshTokenExpiresAt).toBeUndefined();
    const everything = [
      ...printed,
      ...out.mock.calls.map((c) => String(c[0])),
      ...err.mock.calls.map((c) => String(c[0])),
      ...log.mock.calls.map((c) => c.join(" ")),
    ].join("\n");
    for (const s of [FAKE_CLIENT_SECRET, FAKE_REFRESH, FAKE_ACCESS, FAKE_CODE]) {
      expect(everything).not.toContain(s);
    }
  });

  it("fails clearly without a refresh token or without the Ads scope", async () => {
    const noRefresh = tokenFetch({ refresh_token: undefined });
    await expect(
      runAuthFlow({
        clientId: FAKE_CLIENT_ID,
        clientSecret: FAKE_CLIENT_SECRET,
        fetch: noRefresh.fetch,
        print: () => {},
        open: fakeBrowser,
      }),
    ).rejects.toMatchObject({ code: "no_refresh_token" });
    const noScope = tokenFetch({ scope: "openid" });
    await expect(
      runAuthFlow({
        clientId: FAKE_CLIENT_ID,
        clientSecret: FAKE_CLIENT_SECRET,
        fetch: noScope.fetch,
        print: () => {},
        open: fakeBrowser,
      }),
    ).rejects.toMatchObject({ code: "scope_missing" });
  });

  it("a Google refusal never echoes the code or the secret", async () => {
    const { fetch } = routedFetch(() => ({
      status: 400,
      body: { error: "invalid_client", error_description: `bad ${FAKE_CLIENT_SECRET}` },
    }));
    const err = (await runAuthFlow({
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
      fetch,
      print: () => {},
      open: fakeBrowser,
    }).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/client id or secret/);
    expect(err.message).not.toContain(FAKE_CLIENT_SECRET);
    expect(err.message).not.toContain(FAKE_CODE);
  });
});

describe("openBrowser", () => {
  it("runs the opener by absolute path with no secrets in its environment", () => {
    const seen: { command: string; env: Record<string, string> }[] = [];
    const fakeSpawn = ((command: string, _args: string[], o: { env: Record<string, string> }) => {
      seen.push({ command, env: o.env });
      return { on: () => undefined, unref: () => undefined };
    }) as unknown as typeof import("node:child_process").spawn;
    process.env.PERFOADS_MCP_CLIENT_SECRET = "fake-client-secret";
    process.env.BROWSER = "/tmp/evil-browser";
    try {
      const url = `${GOOGLE_AUTH_URL}?client_id=x`;
      openBrowser(url, "linux", { spawn: fakeSpawn, exists: (f) => f === "/usr/bin/xdg-open" });
      openBrowser(url, "linux", { spawn: fakeSpawn, exists: (f) => f === "/home/me/bin/xdg-open" });
      openBrowser("https://evil.example/", "darwin", { spawn: fakeSpawn, exists: () => true });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.command).toBe("/usr/bin/xdg-open");
      expect(seen[0]?.env.BROWSER).toBeUndefined();
      expect(JSON.stringify(seen[0]?.env)).not.toContain("fake-client-secret");
    } finally {
      delete process.env.PERFOADS_MCP_CLIENT_SECRET;
      delete process.env.BROWSER;
    }
  });
});

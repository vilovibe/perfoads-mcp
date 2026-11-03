// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { describe, expect, it } from "vitest";
import { createRefreshTokenProvider } from "./tokens.js";

const credentials = {
  clientId: "fake-client.apps.googleusercontent.com",
  clientSecret: "fake-client-secret-0001",
  refreshToken: "fake-refresh-token-0001",
};

const reply = (scope?: string) => async () =>
  new Response(
    JSON.stringify({
      access_token: "fake-access-token-0001",
      expires_in: 3600,
      ...(scope ? { scope } : {}),
    }),
    { status: 200 },
  );

describe("granted scopes (opt-in Merchant Center access)", () => {
  it("are what Google said on the last refresh; one refresh serves the token and the scopes", async () => {
    let calls = 0;
    const p = createRefreshTokenProvider({
      credentials,
      fetch: async () => {
        calls++;
        return reply(
          "https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/content",
        )();
      },
    });
    expect(await p.grantedScopes?.()).toEqual([
      "https://www.googleapis.com/auth/adwords",
      "https://www.googleapis.com/auth/content",
    ]);
    await p.getAccessToken();
    expect(calls).toBe(1);
  });

  it("Google Ads only, or Google did not say", async () => {
    const adsOnly = createRefreshTokenProvider({
      credentials,
      fetch: reply("https://www.googleapis.com/auth/adwords"),
    });
    expect(await adsOnly.grantedScopes?.()).toEqual(["https://www.googleapis.com/auth/adwords"]);
    const unsaid = createRefreshTokenProvider({ credentials, fetch: reply() });
    expect(await unsaid.grantedScopes?.()).toBeUndefined();
  });
});

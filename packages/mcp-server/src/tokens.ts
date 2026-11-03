// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { redactString, type FetchFn, type TokenProvider } from "@perfoads/ads-client";
import { type OAuthCredentials, howToRun } from "@perfoads/store";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const ADWORDS_SCOPE = "https://www.googleapis.com/auth/adwords";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/**
 * Asks Google to revoke a refresh token (and the access it granted). Best effort: true
 * only when Google confirmed. Never throws; the token is never logged or returned.
 */
export const revokeRefreshToken = async (doFetch: FetchFn, token: string): Promise<boolean> => {
  try {
    const res = await doFetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
};

const TOKEN_TIMEOUT_MS = 30_000;
/** Refresh this long before Google's expiry, so a token never dies mid-request. */
const EXPIRY_MARGIN_MS = 60_000;

/** Google's sign-in service refused or failed. The message is plain English and holds no secret. */
export class OAuthError extends Error {
  constructor(
    message: string,
    /** Google's short error code (e.g. "invalid_grant"), or "network" / "bad_reply". */
    readonly code: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

const plainByCode = (): Readonly<Record<string, string>> => ({
  invalid_grant: `Google refused the saved sign-in: it expired or was revoked. Run \`${howToRun("auth")}\` in a terminal; a running server picks the new sign-in up automatically. If your OAuth app is in Testing mode, sign-ins expire after 7 days: publish the app to production in Google Cloud Console.`,
  invalid_client: `Google did not accept the OAuth client id or secret. Check them in Google Cloud Console (APIs & Services > Credentials) and run \`${howToRun("init")}\` again.`,
  unauthorized_client: `This OAuth client is not allowed to do this. Create a Desktop app OAuth client in Google Cloud Console and run \`${howToRun("init")}\` again.`,
  invalid_scope: `Google refused the Google Ads permission (scope). Run \`${howToRun("auth")}\` again.`,
});

export interface TokenReply {
  accessToken: string;
  expiresInSec: number;
  refreshToken: string | undefined;
  /** Only sent for OAuth apps in Testing mode: the refresh token then dies after about 7 days. */
  refreshTokenExpiresInSec: number | undefined;
  scope: string | undefined;
}

const numberOrUndefined = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * POSTs a form to Google's token endpoint. Errors never contain the request, the reply body
 * or any of `secrets`: only Google's short error code mapped to plain English.
 */
export const postTokenRequest = async (
  doFetch: FetchFn,
  form: Record<string, string>,
  secrets: readonly string[],
): Promise<TokenReply> => {
  let res: Response;
  let body: unknown;
  try {
    res = await doFetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    body = await res.json().catch(() => undefined);
  } catch {
    throw new OAuthError(
      "Could not reach Google's sign-in service. Check the internet connection and try again.",
      "network",
    );
  }
  const json = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (!res.ok) {
    const raw = typeof json.error === "string" ? json.error : "";
    const code = /^[a-z_]{1,40}$/.test(raw) ? raw : "unknown_error";
    const plain =
      plainByCode()[code] ??
      `Google's sign-in service refused the request (HTTP ${res.status}, error "${code}").`;
    throw new OAuthError(redactString(plain, secrets), code);
  }
  const accessToken = typeof json.access_token === "string" ? json.access_token : undefined;
  if (!accessToken) {
    throw new OAuthError(
      "Google's sign-in service sent a reply without an access token.",
      "bad_reply",
    );
  }
  return {
    accessToken,
    expiresInSec: numberOrUndefined(json.expires_in) ?? 3600,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
    refreshTokenExpiresInSec: numberOrUndefined(json.refresh_token_expires_in),
    scope: typeof json.scope === "string" ? json.scope : undefined,
  };
};

/**
 * Access tokens from a refresh token, cached until shortly before expiry.
 * Plugs into the ads-client as its TokenProvider; `issued` feeds log redaction.
 */
export const createRefreshTokenProvider = (options: {
  credentials: OAuthCredentials;
  fetch?: FetchFn;
  now?: () => number;
  onIssued?: (accessToken: string) => void;
}): TokenProvider => {
  const doFetch: FetchFn = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const { clientId, clientSecret, refreshToken } = options.credentials;
  let cached: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;
  /** What Google said it granted on the last refresh (undefined = it did not say). */
  let scopes: readonly string[] | undefined;

  const refresh = async (): Promise<string> => {
    const reply = await postTokenRequest(
      doFetch,
      {
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      },
      [clientSecret, refreshToken],
    );
    cached = { token: reply.accessToken, expiresAt: now() + reply.expiresInSec * 1000 };
    scopes = reply.scope === undefined ? undefined : reply.scope.split(/\s+/).filter(Boolean);
    options.onIssued?.(reply.accessToken);
    return reply.accessToken;
  };

  return {
    getAccessToken: async (o) => {
      if (!o?.forceRefresh && cached && cached.expiresAt - EXPIRY_MARGIN_MS > now()) {
        return cached.token;
      }
      // One refresh at a time: parallel tool calls share it.
      inflight ??= refresh().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
    grantedScopes: async () => {
      if (!cached) {
        inflight ??= refresh().finally(() => {
          inflight = undefined;
        });
        await inflight;
      }
      return scopes;
    },
  };
};

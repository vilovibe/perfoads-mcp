// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { MERCHANT_SCOPE, type FetchFn } from "@perfoads/ads-client";
import {
  ADWORDS_SCOPE,
  GOOGLE_AUTH_URL,
  OAuthError,
  openerCommand,
  postTokenRequest,
  PRODUCT_NAME,
} from "@perfoads/mcp-server";
import { childEnv } from "@perfoads/store";

export const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_WAIT_MS = 5 * 60 * 1000;

const base64url = (buf: Buffer): string => buf.toString("base64url");

/** PKCE S256 (RFC 7636): a 43-character random verifier and its SHA-256 challenge. */
export const createPkce = (): { verifier: string; challenge: string } => {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: pkceChallenge(verifier) };
};

export const pkceChallenge = (verifier: string): string =>
  base64url(createHash("sha256").update(verifier, "ascii").digest());

export const createState = (): string => base64url(randomBytes(24));

export const buildAuthUrl = (p: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  /** Also ask for Merchant Center (opt-in, for tag_exclude). Default: Google Ads only. */
  merchantCenter?: boolean;
}): string => {
  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: p.merchantCenter ? `${ADWORDS_SCOPE} ${MERCHANT_SCOPE}` : ADWORDS_SCOPE,
    access_type: "offline",
    // a plain sign-in keeps what was granted before (Merchant Center stays on if it was)
    include_granted_scopes: "true",
    prompt: "consent",
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
};

const sameString = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const page = (res: ServerResponse, status: number, message: string): void => {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${PRODUCT_NAME}</title><body style="font-family:sans-serif;max-width:32rem;margin:4rem auto"><p>${message}</p></body>`,
  );
};

export interface Loopback {
  /** http://127.0.0.1:<port>/ */
  redirectUri: string;
  port: number;
  /** The address the server listens on: always 127.0.0.1. */
  boundAddress: string;
  /** Resolves with the authorization code from the first callback; the server is closed after it. */
  waitForCode(expectedState: string, timeoutMs?: number): Promise<string>;
  close(): Promise<void>;
}

/**
 * One-shot loopback server for the installed-app OAuth flow. Binds 127.0.0.1 only, on a
 * random free port, and closes after the first real callback, whatever its outcome.
 */
export const startLoopback = async (): Promise<Loopback> => {
  let onCallback: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
  const server = createServer((req, res) => {
    const host = req.headers.host ?? "";
    const addr = server.address() as AddressInfo | null;
    // Only answer requests addressed to our own host:port (no DNS-rebinding tricks).
    if (!addr || host !== `${LOOPBACK_HOST}:${addr.port}`) return page(res, 400, "Wrong address.");
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (req.method !== "GET" || url.pathname !== "/") return page(res, 404, "Not found.");
    if (!onCallback) return page(res, 409, "This sign-in link is no longer active.");
    onCallback(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => resolve());
  });
  const { port, address: boundAddress } = server.address() as AddressInfo;
  let closed = false;
  const close = (): Promise<void> => {
    if (closed) return Promise.resolve();
    closed = true;
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  };

  const waitForCode = (expectedState: string, timeoutMs = DEFAULT_WAIT_MS): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        onCallback = undefined;
        void close();
        reject(
          new OAuthError(
            "No answer from the browser within 5 minutes. Run the command again.",
            "timeout",
          ),
        );
      }, timeoutMs);
      onCallback = (req, res) => {
        onCallback = undefined;
        clearTimeout(timer);
        const params = new URL(req.url ?? "/", "http://localhost").searchParams;
        const finish = (err: OAuthError | undefined, code?: string) => {
          // Answer the browser first, then shut the server.
          res.once("finish", () => void close());
          if (err) {
            page(res, 400, "Sign-in did not finish. Go back to the terminal for details.");
            reject(err);
          } else {
            page(res, 200, "Signed in. You can close this tab and go back to the terminal.");
            resolve(code ?? "");
          }
        };
        const state = params.get("state") ?? "";
        if (!sameString(state, expectedState)) {
          return finish(
            new OAuthError(
              "The sign-in answer did not match this request (state check failed). Run the command again.",
              "state_mismatch",
            ),
          );
        }
        const error = params.get("error");
        if (error) {
          const code = /^[a-z_]{1,40}$/.test(error) ? error : "unknown_error";
          return finish(
            new OAuthError(
              code === "access_denied"
                ? "Sign-in was cancelled in the browser. Run the command again and allow access to Google Ads."
                : `Google did not finish the sign-in (error "${code}").`,
              code,
            ),
          );
        }
        const code = params.get("code");
        if (!code)
          return finish(
            new OAuthError(
              "Google's answer had no sign-in code. Run the command again.",
              "no_code",
            ),
          );
        finish(undefined, code);
      };
    });

  return {
    redirectUri: `http://${LOOPBACK_HOST}:${port}/`,
    port,
    boundAddress,
    waitForCode,
    close,
  };
};

/**
 * Opens the URL in the default browser. Program + arguments only, never a shell string;
 * the opener is an absolute system path (never PATH) and gets the small child environment
 * (no PERFOADS_MCP_*, no BROWSER).
 */
export const openBrowser = (
  url: string,
  platform: NodeJS.Platform = process.platform,
  deps: { spawn?: typeof spawn; exists?: (file: string) => boolean } = {},
): void => {
  if (!url.startsWith(`${GOOGLE_AUTH_URL}?`)) return;
  const opener = openerCommand(platform, deps.exists);
  if (!opener) return; // No browser opener: the URL is printed for copy and paste.
  try {
    const child = (deps.spawn ?? spawn)(opener.command, opener.args(url), {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: childEnv(platform),
    });
    child.on("error", () => {
      // Same as above.
    });
    child.unref();
  } catch {
    // Same as above.
  }
};

export interface AuthResult {
  refreshToken: string;
  /** Present only for OAuth apps in Testing mode. */
  refreshTokenExpiresAt: string | undefined;
  testingMode: boolean;
  /** Merchant Center was asked for: did Google grant it (undefined = not asked, or not said). */
  merchantCenter?: boolean | undefined;
}

/**
 * Installed-app OAuth with PKCE + state, redirect to a one-shot 127.0.0.1 server.
 * `print` shows the sign-in URL (it holds no secret); tokens are never printed or logged.
 */
export const runAuthFlow = async (options: {
  clientId: string;
  clientSecret: string;
  fetch?: FetchFn;
  print: (line: string) => void;
  open?: (url: string) => void;
  now?: () => number;
  timeoutMs?: number;
  /** Also ask for Merchant Center (opt-in). */
  merchantCenter?: boolean;
}): Promise<AuthResult> => {
  const doFetch: FetchFn = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const { verifier, challenge } = createPkce();
  const state = createState();
  const loopback = await startLoopback();
  try {
    const url = buildAuthUrl({
      clientId: options.clientId,
      redirectUri: loopback.redirectUri,
      state,
      challenge,
      ...(options.merchantCenter ? { merchantCenter: true } : {}),
    });
    options.print(
      "Opening your browser to sign in with Google. If it does not open, copy this link into it:",
    );
    options.print(url);
    (options.open ?? openBrowser)(url);
    const code = await loopback.waitForCode(state, options.timeoutMs);
    const reply = await postTokenRequest(
      doFetch,
      {
        grant_type: "authorization_code",
        code,
        client_id: options.clientId,
        client_secret: options.clientSecret,
        redirect_uri: loopback.redirectUri,
        code_verifier: verifier,
      },
      [options.clientSecret, code],
    );
    if (reply.scope !== undefined && !reply.scope.split(/\s+/).includes(ADWORDS_SCOPE)) {
      throw new OAuthError(
        "Google Ads access was not granted. Run the command again and tick the Google Ads box on Google's screen.",
        "scope_missing",
      );
    }
    if (!reply.refreshToken) {
      throw new OAuthError(
        "Google did not send a long-lived sign-in. Remove this app at myaccount.google.com/permissions, then run the command again.",
        "no_refresh_token",
      );
    }
    const expiresIn = reply.refreshTokenExpiresInSec;
    return {
      refreshToken: reply.refreshToken,
      refreshTokenExpiresAt:
        expiresIn === undefined ? undefined : new Date(now() + expiresIn * 1000).toISOString(),
      testingMode: expiresIn !== undefined,
      ...(options.merchantCenter
        ? {
            merchantCenter:
              reply.scope === undefined
                ? undefined
                : reply.scope.split(/\s+/).includes(MERCHANT_SCOPE),
          }
        : {}),
    };
  } finally {
    await loopback.close();
  }
};

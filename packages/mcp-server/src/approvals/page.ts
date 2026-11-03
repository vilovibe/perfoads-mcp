// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// The local approval page (plan 6.2, 9.7): 127.0.0.1 only, a random port, a one-time
// unguessable token in the path, Host + Origin checked (DNS rebinding, cross-site posts),
// GET only shows, a decision is a POST with a CSRF token, used once, closed after use or
// at expiry. The URL (with its token) goes only to the OS browser opener (or a TTY): never
// into a tool result, a log line or an error. The first GET swaps the token for a fresh
// one (303) and sets an HttpOnly, SameSite=Strict cookie scoped to that path; the fresh
// path only works with the cookie. So the opened URL - visible for a moment in `ps`, kept
// in browser history - is dead once the person has opened the page, and the fresh one
// works only in that browser. The opened URL coming back after that means a second
// opener: the page closes and its code is burned.

import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { childEnv, systemCommand } from "@perfoads/store";

export const PAGE_HOST = "127.0.0.1";
const MAX_BODY_BYTES = 4096;
const WATCH_MS = 1000;

export type PageAction = "approve" | "reject";

export interface PageOptions {
  /** The page for this CSRF token. */
  html: (csrf: string) => string;
  /** Runs once, for the first valid POST. Returns the page shown afterwards. */
  decide: (action: PageAction) => Promise<{ status: number; html: string }>;
  /** Whether "approve" may be posted at all (false = code-only page; reject still works). */
  approveAllowed: boolean;
  /**
   * The opened URL was used again after the page moved: someone else has it. The page
   * closes itself; this burns the session and logs it.
   */
  onOpenedTwice?: () => void;
  expiresAt: number;
  now?: () => number;
  /** Checked on every request and every second: false closes the page (finished elsewhere). */
  isLive?: () => boolean;
}

export interface ApprovalPage {
  /** Only for the browser opener. Holds the one-time token. */
  readonly url: string;
  readonly port: number;
  readonly closed: Promise<void>;
  isOpen(): boolean;
  close(): void;
}

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

const send = (res: ServerResponse, status: number, body: string, type = "text/html"): void => {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": `${type}; charset=utf-8`,
    Connection: "close",
  });
  res.end(body);
};

const readBody = (req: IncomingMessage): Promise<string | undefined> =>
  new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        resolve(undefined);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(undefined));
  });

const COOKIE_NAME = "perfoads_approval";

const OPENED_TWICE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Approval page closed</title></head><body><h1>Approval page closed</h1><p>This approval page was already opened somewhere else, so it has been closed for safety. Ask your AI to apply again.</p></body></html>`;

const cookieOf = (req: IncomingMessage, name: string): string | undefined => {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
};

/** Starts one approval page on 127.0.0.1 and a random port. */
export const startApprovalPage = async (o: PageOptions): Promise<ApprovalPage> => {
  const now = o.now ?? Date.now;
  const newPath = () => `/a/${randomBytes(24).toString("base64url")}`;
  const csrf = randomBytes(24).toString("base64url");
  const firstPath = newPath();
  let pagePath = firstPath;
  let rotated = false;
  /** Set with the 303 (HttpOnly, SameSite=Strict, path-scoped): only that browser can follow. */
  const cookie = randomBytes(24).toString("base64url");
  let used = false;
  let open = true;
  let port = 0;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((r) => (resolveClosed = r));

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, "Something went wrong.", "text/plain");
    });
  });

  const close = (): void => {
    if (!open) return;
    open = false;
    clearInterval(watch);
    server.close(() => resolveClosed());
    server.closeAllConnections();
  };

  const live = (): boolean => open && now() < o.expiresAt && (o.isLive?.() ?? true);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // DNS rebinding: only the exact address the browser was sent to.
    if (req.headers.host !== `${PAGE_HOST}:${port}`)
      return send(res, 403, "Forbidden.", "text/plain");
    const origin = req.headers.origin;
    const self = `http://${PAGE_HOST}:${port}`;
    if (origin !== undefined && origin !== self) return send(res, 403, "Forbidden.", "text/plain");
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none") {
      return send(res, 403, "Forbidden.", "text/plain");
    }
    const url = (req.url ?? "").split("?")[0] ?? "";
    if (rotated && same(url, firstPath)) {
      // The opened link came back after the page moved: it was opened somewhere else too.
      send(res, 410, OPENED_TWICE_HTML);
      if (open) o.onOpenedTwice?.();
      close();
      return;
    }
    if (!same(url, pagePath)) return send(res, 404, "Not found.", "text/plain");
    if (!live()) {
      send(res, 410, "This approval page has expired or was already used.", "text/plain");
      close();
      return;
    }
    if (!rotated) {
      if (req.method !== "GET") return send(res, 404, "Not found.", "text/plain");
      // The opened URL is used once: from now on only the fresh path, with the cookie, works.
      rotated = true;
      pagePath = newPath();
      res.writeHead(303, {
        ...SECURITY_HEADERS,
        Location: pagePath,
        "Set-Cookie": `${COOKIE_NAME}=${cookie}; HttpOnly; SameSite=Strict; Path=${pagePath}; Max-Age=900`,
        Connection: "close",
      });
      res.end();
      return;
    }
    if (!same(cookieOf(req, COOKIE_NAME) ?? "", cookie)) {
      return send(res, 404, "Not found.", "text/plain");
    }
    if (req.method === "GET") return send(res, 200, o.html(csrf));
    if (req.method !== "POST") return send(res, 405, "Method not allowed.", "text/plain");
    // A browser always sends Origin on a form POST; no Origin = not our page.
    if (origin !== self) return send(res, 403, "Forbidden.", "text/plain");
    const type = String(req.headers["content-type"] ?? "")
      .split(";")[0]
      ?.trim();
    if (type !== "application/x-www-form-urlencoded") {
      return send(res, 415, "Unsupported.", "text/plain");
    }
    const body = await readBody(req);
    if (body === undefined) return send(res, 413, "Too large.", "text/plain");
    const form = new URLSearchParams(body);
    const action = form.get("action");
    if (!same(form.get("csrf") ?? "", csrf)) return send(res, 403, "Forbidden.", "text/plain");
    if (action !== "approve" && action !== "reject") {
      return send(res, 400, "Unknown action.", "text/plain");
    }
    if (action === "approve" && !o.approveAllowed) {
      return send(res, 403, "This page approves only with the code.", "text/plain");
    }
    if (used) return send(res, 410, "This approval page was already used.", "text/plain");
    used = true;
    try {
      const out = await o.decide(action);
      send(res, out.status, out.html);
    } finally {
      close();
    }
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, PAGE_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
  const watch = setInterval(() => {
    if (!live()) close();
  }, WATCH_MS);
  watch.unref();
  server.unref();

  return {
    url: `http://${PAGE_HOST}:${port}${firstPath}`,
    port,
    closed,
    isOpen: () => open,
    close,
  };
};

/** Can this machine serve the approval page? (doctor) */
export const canBindPage = (): Promise<{ ok: true } | { ok: false; message: string }> =>
  new Promise((resolve) => {
    const s = createServer();
    s.once("error", (err: NodeJS.ErrnoException) =>
      resolve({ ok: false, message: err.code ?? "listen failed" }),
    );
    s.listen(0, PAGE_HOST, () => s.close(() => resolve({ ok: true })));
  });

const PAGE_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/a\/[A-Za-z0-9_-]{20,}$/;

/**
 * The browser opener: an absolute path, never looked up in PATH (an agent could put its
 * own `open` first in PATH). Undefined when not found.
 */
export const openerCommand = (
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = existsSync,
  env: Readonly<Record<string, string | undefined>> = process.env,
): { command: string; args: (url: string) => string[] } | undefined => {
  if (platform === "darwin") {
    return exists("/usr/bin/open") ? { command: "/usr/bin/open", args: (u) => [u] } : undefined;
  }
  if (platform === "win32") {
    const rundll = systemCommand("rundll32", "win32", exists, env);
    return rundll
      ? { command: rundll, args: (u) => ["url.dll,FileProtocolHandler", u] }
      : undefined;
  }
  const xdg = systemCommand("xdg-open", platform, exists, env);
  return xdg ? { command: xdg, args: (u) => [u] } : undefined;
};

/**
 * Opens an approval page in the default browser. Program + arguments only, never a shell;
 * the opener gets the small child environment (no BROWSER, no PERFOADS_MCP_*, safe PATH). Resolves once the opener started
 * (true) or failed to start (false).
 */
export const openLocalPage = (
  url: string,
  platform: NodeJS.Platform = process.platform,
  deps: { spawn?: typeof spawn; exists?: (file: string) => boolean } = {},
): Promise<boolean> => {
  if (!PAGE_URL.test(url)) return Promise.resolve(false);
  const opener = openerCommand(platform, deps.exists);
  if (!opener) return Promise.resolve(false);
  const env = childEnv(platform);
  const run = deps.spawn ?? spawn;
  return new Promise((resolve) => {
    try {
      const child = run(opener.command, opener.args(url), {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env,
      });
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
      child.once("error", () => resolve(false));
    } catch {
      resolve(false);
    }
  });
};

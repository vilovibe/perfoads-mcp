// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import {
  AdsInDoubtError,
  AdsDailyLimitError,
  AdsNotSentError,
  BUSY_ERROR_CODES,
  GoogleAdsBusyError,
  AdsNetworkError,
  AdsNotAllowedError,
  GoogleAdsApiError,
  humanWait,
  isDailyQuotaExhausted,
  isProjectDailyLimit,
  toGoogleAdsApiError,
} from "./errors.js";
import { createRedactingLogger, createStderrLogger } from "./logger.js";
import type { FetchFn, Logger, OpsCounter, OpsKind, OpsPool, TokenProvider } from "./types.js";
import { apiUrl } from "./version.js";

/** Retry policy for reads. Writes are never retried after an ambiguous failure. */
export interface RetryPolicy {
  /** Attempts in total, including the first. */
  maxAttempts: number;
  backoff5xxMs: readonly number[];
  backoff429Ms: readonly number[];
  backoffNetworkMs: readonly number[];
  /** A Google-requested wait longer than this is not waited for: the call fails instead. */
  maxRetryAfterMs: number;
  /** Extra random wait, as a share of the backoff step (0.25 = up to +25%). */
  jitterRatio: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  backoff5xxMs: [1000, 3000, 9000],
  backoff429Ms: [5000, 15000, 45000],
  backoffNetworkMs: [500, 2000],
  maxRetryAfterMs: 60_000,
  jitterRatio: 0.25,
};

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_READ_DEADLINE_MS = 90_000;

/** Access tokens remembered for log redaction (all issued in this process, oldest dropped). */
const MAX_TRACKED_TOKENS = 32;

/**
 * Auth is the OAuth bearer token only. API access and its level come from the
 * Google Cloud project that owns the OAuth client.
 */
export interface AdsClientConfig {
  tokens: TokenProvider;
  fetch?: FetchFn;
  /** Default: warnings and errors to stderr (stdout is reserved for the MCP stdio channel). */
  logger?: Logger;
  opsCounter?: OpsCounter;
  /**
   * Which ops pool a request's account counts against (its customer id from the path;
   * undefined for calls without one). undefined back = not known yet: counted as production,
   * but a saved daily-limit wait is neither applied to it nor saved from it (it may be a
   * test account). Default: production for everything with a customer id.
   */
  opsPool?: (customerId: string | undefined) => OpsPool | undefined;
  /** Per request, including reading the body. Default 60 s. */
  timeoutMs?: number;
  /** Whole read call, all retries and waits included. Default 90 s. */
  deadlineMs?: number;
  retry?: Partial<RetryPolicy>;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  /**
   * Another Google API on the same sign-in (Merchant Center): requests go to
   * `${host}/${path}` instead of the Google Ads API. Default: the Google Ads API.
   */
  host?: string;
}

export interface AdsRequest {
  /** PATCH and DELETE: Merchant Center only (the Google Ads API uses GET and POST). */
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Path after the version, e.g. "customers/1234567890/googleAds:search". */
  path: string;
  body?: unknown;
  loginCustomerId?: string | undefined;
  /** Google Ads operations this request costs (pages, mutate operations). */
  opsCost: number;
  opsKind: OpsKind;
  /** Reads only: aborting stops the request in flight and any retry. Never set on writes. */
  signal?: AbortSignal | undefined;
  /** Reads only: a shorter deadline (all retries included) than the client default. */
  deadlineMs?: number | undefined;
}

export interface AdsResponse {
  status: number;
  json: unknown;
  googleRequestId: string | undefined;
}

export interface Transport {
  /** Safe to repeat: retried on 5xx, 429 and network trouble. */
  read(req: AdsRequest): Promise<AdsResponse>;
  /** Changes things: sent once. Ambiguous failures throw AdsInDoubtError. */
  write(req: AdsRequest): Promise<AdsResponse>;
}

/** Failure before a reply arrived (fetch threw, or the body could not be read). */
interface TransportFailure {
  error: unknown;
  timedOut: boolean;
  /** false only when the request certainly never left (DNS failure, refused). */
  maybeSent: boolean;
}

const NOT_SENT_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"]);

const errorCodeOf = (err: unknown): string | undefined => {
  for (let e: unknown = err, i = 0; e && i < 3; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
};

/** Failed before anything was sent (ops budget, ops counter, sign-in). */
class PreSendFailure {
  constructor(readonly error: unknown) {}
}

const isTransportFailure = (value: unknown): value is TransportFailure =>
  typeof value === "object" && value !== null && "maybeSent" in value && "timedOut" in value;

const parseRetryAfter = (value: string | null, now: number): number | undefined => {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
};

/** Google's quota errors that mean "a limit was hit" (not "this access is not allowed"). */
const RATE_LIMIT_CODES: ReadonlySet<string> = new Set([
  "RESOURCE_EXHAUSTED",
  "RESOURCE_TEMPORARILY_EXHAUSTED",
  "EXCESSIVE_SHORT_TERM_QUERY_RESOURCE_CONSUMPTION",
  "EXCESSIVE_LONG_TERM_QUERY_RESOURCE_CONSUMPTION",
]);

/** Google refused the request for a daily or rate limit (HTTP 429, RESOURCE_EXHAUSTED). */
const isRateRefusal = (err: GoogleAdsApiError): boolean =>
  err.httpStatus === 429 ||
  err.googleStatus === "RESOURCE_EXHAUSTED" ||
  err.details.some(
    (d) => d.errorCode?.type === "quotaError" && RATE_LIMIT_CODES.has(d.errorCode.value),
  );

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const CUSTOMER_ID = /^\d{10}$/;
/** "customers/1234567890/googleAds:search" or "customers/1234567890:generateKeywordIdeas". */
const PATH_CUSTOMER = /^customers\/(\d{10})(?=[/:]|$)/;

/** "123-456-7890" -> "1234567890". Anything that is not 10 digits throws (keeps paths safe). */
export const normalizeCustomerId = (id: string): string => {
  const clean = id.replace(/-/g, "").trim();
  if (!CUSTOMER_ID.test(clean)) throw new TypeError(`not a Google Ads customer id: "${id}"`);
  return clean;
};

export const createTransport = (config: AdsClientConfig): Transport => {
  const doFetch: FetchFn = config.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadlineMs = config.deadlineMs ?? DEFAULT_READ_DEADLINE_MS;
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...config.retry };
  const sleep = config.sleep ?? defaultSleep;
  const random = config.random ?? Math.random;
  const now = config.now ?? Date.now;
  const ops = config.opsCounter;
  /** known: false for calls without a customer id, or an account whose pool is not known. */
  const poolOf = (req: AdsRequest): { pool: OpsPool; known: boolean } => {
    const id = PATH_CUSTOMER.exec(req.path)?.[1];
    try {
      const pool = config.opsPool ? config.opsPool(id) : "production";
      return { pool: pool ?? "production", known: id !== undefined && pool !== undefined };
    } catch {
      return { pool: "production", known: false }; // not known: the stricter pool
    }
  };
  const issuedTokens: string[] = [];
  const log = createRedactingLogger(config.logger ?? createStderrLogger(), () => issuedTokens);

  const rememberToken = (token: string): void => {
    if (issuedTokens.includes(token)) return;
    issuedTokens.push(token);
    if (issuedTokens.length > MAX_TRACKED_TOKENS) issuedTokens.shift();
  };

  /** "14:05 UTC" (with the date when it is not today's in UTC). */
  const clockOf = (at: number): string => {
    const iso = new Date(at).toISOString();
    const sameDay = iso.slice(0, 10) === new Date(now()).toISOString().slice(0, 10);
    return `${sameDay ? "" : `${iso.slice(0, 10)} `}${iso.slice(11, 16)} UTC`;
  };

  /**
   * Our own 24-hour count is an estimate (it can't see other computers or when Google
   * refills), so past the full limit it never stops a read: Google's refusal and its saved
   * wait do. Writes still stop at the count, and plain reads are held in the share the
   * policy keeps for changes until the count reaches the full limit. Returns true when Google
   * taking this request would show it has refilled (our count said it would refuse it).
   */
  const checkOpsBudget = (
    req: AdsRequest,
    pool: OpsPool,
    known: boolean,
    isWrite: boolean,
  ): boolean => {
    // a pool's saved wait never stops a call whose pool is not known (it may be a test account)
    const until = known ? ops?.limitUntil?.(pool) : null;
    if (until !== null && until !== undefined && until > now())
      throw new AdsDailyLimitError(until - now());
    const refusal = ops?.admit?.(req.opsCost, req.opsKind, pool);
    const left = ops?.remaining(pool);
    const spent = left !== null && left !== undefined && left < req.opsCost;
    // inside the kept share Google takes reads whether our count is right or stale, so a
    // read there would prove nothing and only eat what is kept for changes: held
    if (refusal && (isWrite || !spent)) throw new AdsNotAllowedError(refusal, "ops_budget");
    if (isWrite && spent) {
      const at = ops?.freesAt?.(req.opsCost, pool);
      const frees = at === null || at === undefined ? "" : `; frees up from about ${clockOf(at)}`;
      throw new AdsNotAllowedError(
        `Not sent: this needs ${req.opsCost} Google Ads operations and only ${left} are left for ${pool === "test" ? "test" : "live"} accounts, by our count of the last 24 hours${frees}.`,
        "ops_budget",
      );
    }
    return known && spent;
  };

  /**
   * One HTTP exchange. Resolves with any HTTP reply; rejects with a TransportFailure.
   * Checks the ops budget first and counts the request only if it may have left.
   */
  const exchange = async (
    req: AdsRequest,
    forceRefresh: boolean,
    attemptTimeoutMs: number,
    isWrite: boolean,
  ): Promise<AdsResponse> => {
    let accessToken: string;
    const { pool, known } = poolOf(req);
    let showsRefill = false;
    try {
      showsRefill = checkOpsBudget(req, pool, known, isWrite);
      accessToken = await config.tokens.getAccessToken(forceRefresh ? { forceRefresh } : {});
    } catch (err) {
      // Nothing left this process. Reads get the original error; writes say "not sent".
      throw new PreSendFailure(err);
    }
    rememberToken(accessToken);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };
    if (req.loginCustomerId)
      headers["login-customer-id"] = normalizeCustomerId(req.loginCustomerId);

    if (req.signal?.aborted) {
      throw new AdsNetworkError("The read was stopped before it was sent.", true, false, undefined);
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, attemptTimeoutMs);
    const onAbort = () => {
      timedOut = true;
      controller.abort();
    };
    req.signal?.addEventListener("abort", onAbort, { once: true });
    let gotReply = false;
    let counted = false;
    const count = (): void => {
      counted = true;
      ops?.record(req.opsCost, req.opsKind, pool);
    };
    const sentAt = now();
    try {
      const init: RequestInit = { method: req.method, headers, signal: controller.signal };
      if (req.body !== undefined) init.body = JSON.stringify(req.body);
      const response = await doFetch(
        config.host ? `${config.host}/${req.path}` : apiUrl(req.path),
        init,
      );
      gotReply = true;
      const text = await response.text();
      let json: unknown = undefined;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = { rawBody: text.slice(0, 2000) };
          if (response.ok) throw new Error("reply was not JSON");
        }
      }
      const googleRequestId = response.headers.get("request-id") ?? undefined;
      log.debug("google ads reply", {
        method: req.method,
        path: req.path,
        status: response.status,
        googleRequestId,
      });
      if (!response.ok) {
        const err = toGoogleAdsApiError(
          json,
          response.status,
          googleRequestId,
          parseRetryAfter(response.headers.get("retry-after"), now()),
        );
        // a request Google refused for a limit did no work, so it is not counted
        if (!isRateRefusal(err)) count();
        // the daily limit is spent until Google's stated time: nothing is sent before then
        // (kept only for a known pool: a call without an account, or an unknown one, says
        // nothing sure about which pool is spent)
        if (known && isProjectDailyLimit(err.details) && err.retryAfterMs !== undefined)
          ops?.limitReached?.(now() + err.retryAfterMs, pool);
        throw err;
      }
      // Google took what our count said it would refuse: it has refilled, older counts are stale
      if (showsRefill) ops?.refilled?.(sentAt - 1, pool);
      count();
      return { status: response.status, json, googleRequestId };
    } catch (error) {
      if (error instanceof GoogleAdsApiError) throw error;
      const code = errorCodeOf(error);
      const failure: TransportFailure = {
        error,
        timedOut,
        maybeSent: gotReply || timedOut || code === undefined || !NOT_SENT_CODES.has(code),
      };
      // A request that may have reached Google counts; one that never left does not.
      if (failure.maybeSent && !counted) count();
      throw failure;
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
    }
  };

  /** Exchange; on 401 refresh the token once and resend (401 = rejected before processing). */
  const exchangeWithAuth = async (
    req: AdsRequest,
    attemptTimeoutMs: () => number,
    isWrite: boolean,
  ) => {
    try {
      return await exchange(req, false, attemptTimeoutMs(), isWrite);
    } catch (err) {
      if (err instanceof GoogleAdsApiError && err.httpStatus === 401) {
        log.info("google ads answered 401, refreshing the access token once", { path: req.path });
        return exchange(req, true, attemptTimeoutMs(), isWrite);
      }
      throw err;
    }
  };

  const toNetworkError = (f: TransportFailure): AdsNetworkError =>
    new AdsNetworkError(
      f.timedOut ? "Google Ads did not answer in time." : "Could not reach the Google Ads API.",
      f.timedOut,
      f.maybeSent,
      f.error,
    );

  const read = async (req: AdsRequest): Promise<AdsResponse> => {
    try {
      return await readWithRetry(req);
    } catch (err) {
      throw err instanceof PreSendFailure ? err.error : err;
    }
  };

  const readWithRetry = async (req: AdsRequest): Promise<AdsResponse> => {
    const deadline = now() + Math.min(deadlineMs, req.deadlineMs ?? deadlineMs);
    const attemptTimeout = () => Math.max(1, Math.min(timeoutMs, deadline - now()));
    for (let attempt = 1; ; attempt++) {
      try {
        return await exchangeWithAuth(req, attemptTimeout, false);
      } catch (err) {
        let schedule: readonly number[];
        let serverWaitMs: number | undefined;
        if (err instanceof GoogleAdsApiError) {
          if (isDailyQuotaExhausted(err.details)) throw err; // retrying cannot help
          if (err.httpStatus === 429) schedule = policy.backoff429Ms;
          else if (err.httpStatus >= 500) schedule = policy.backoff5xxMs;
          else throw err;
          serverWaitMs = err.retryAfterMs;
        } else if (isTransportFailure(err)) {
          if (req.signal?.aborted) throw toNetworkError(err); // stopped on purpose: no retry
          schedule = policy.backoffNetworkMs;
        } else {
          throw err;
        }
        const fail = (why?: string): never => {
          if (why) log.warn(`google ads read not retried: ${why}`, { path: req.path });
          throw isTransportFailure(err) ? toNetworkError(err) : err;
        };
        const retryIndex = attempt - 1;
        if (attempt >= policy.maxAttempts || retryIndex >= schedule.length) fail();
        if (serverWaitMs !== undefined && serverWaitMs > policy.maxRetryAfterMs) {
          fail(`Google asked to wait ${humanWait(serverWaitMs)}, longer than the retry cap`);
        }
        const step = schedule[retryIndex] ?? 0;
        const waitMs = serverWaitMs ?? Math.round(step * (1 + random() * policy.jitterRatio));
        if (now() + waitMs >= deadline) fail("the wait would pass the call's deadline");
        log.warn("google ads read failed, retrying", {
          path: req.path,
          attempt,
          waitMs,
          reason: err instanceof GoogleAdsApiError ? err.httpStatus : "network",
          message: err instanceof GoogleAdsApiError ? err.message : String(err.error),
        });
        await sleep(waitMs);
      }
    }
  };

  /**
   * A clear "busy" refusal: Google answered 4xx, so it refused the WHOLE request and
   * changed nothing (partial-failure refusals answer 200). The daily quota is not "busy".
   */
  const asBusy = (err: GoogleAdsApiError): GoogleAdsBusyError | undefined => {
    if (err.httpStatus >= 500 || isDailyQuotaExhausted(err.details)) return undefined;
    const busy =
      err.httpStatus === 429 ||
      err.details.some((d) => BUSY_ERROR_CODES.has(d.errorCode?.value ?? ""));
    if (!busy) return undefined;
    return new GoogleAdsBusyError(
      err.plainMessage,
      err.httpStatus,
      err.details,
      err.googleRequestId,
      err.googleStatus,
      err.retryAfterMs,
      err.serverLine,
      err.googleSaid,
    );
  };

  /** Sent at most once (a 401 resend happens before Google processed anything). */
  const write = async (req: AdsRequest): Promise<AdsResponse> => {
    try {
      return await exchangeWithAuth(req, () => timeoutMs, true);
    } catch (err) {
      if (err instanceof GoogleAdsApiError && err.httpStatus < 500) throw asBusy(err) ?? err;
      if (err instanceof PreSendFailure) {
        if (err.error instanceof AdsNotAllowedError) throw err.error;
        const why = err.error instanceof Error ? err.error.message : String(err.error);
        throw new AdsNotSentError(`Not sent: ${why}`, err.error);
      }
      throw writeFailure(req, err);
    }
  };

  /** The error a failed write ends in: a 5xx or a maybe-sent network failure is in_doubt. */
  const writeFailure = (req: AdsRequest, err: unknown): unknown => {
    if (err instanceof GoogleAdsApiError) {
      log.error("google ads write got a server error: outcome unknown", {
        path: req.path,
        status: err.httpStatus,
        googleRequestId: err.googleRequestId,
      });
      return new AdsInDoubtError(
        "Google had a server error while making this change, so it may or may not have been applied. Check the account before trying again.",
        err.googleRequestId,
        err,
      );
    }
    if (isTransportFailure(err)) {
      if (!err.maybeSent) return toNetworkError(err);
      log.error("google ads write outcome unknown", { path: req.path, timedOut: err.timedOut });
      return new AdsInDoubtError(
        err.timedOut
          ? "Google did not answer in time, so this change may or may not have been applied. Check the account before trying again."
          : "The connection broke while sending this change, so it may or may not have been applied. Check the account before trying again.",
        undefined,
        err.error,
      );
    }
    return err;
  };

  return { read, write };
};

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { asArray, asObject, asString, isObject } from "./json.js";

/** One error from a GoogleAdsFailure, flattened. */
export interface GoogleAdsErrorDetail {
  /** e.g. { type: "mutateError", value: "RESOURCE_NOT_FOUND" } */
  errorCode: { type: string; value: string } | null;
  message: string;
  /** e.g. "operations[0].create.name" */
  fieldPath: string;
  /** Index of the operation this error belongs to, when Google says so. */
  operationIndex: number | null;
  /** Wait Google asks for on quota errors (details.quotaErrorDetails.retryDelay). */
  retryDelayMs?: number;
  /**
   * Whose limit a quota error is about (details.quotaErrorDetails.rateScope, QuotaRateScope
   * in Google's errors.proto): "DEVELOPER" = the whole project, "ACCOUNT" = one account.
   */
  rateScope?: string;
}

export interface ParsedGoogleFailure {
  message: string;
  status: string | undefined;
  details: GoogleAdsErrorDetail[];
  googleRequestId: string | undefined;
  /** Longest wait Google asked for in the body: google.rpc.RetryInfo or quotaErrorDetails. */
  retryDelayMs: number | undefined;
}

/** Google answered and refused the request. Nothing was changed. */
export class GoogleAdsApiError extends Error {
  readonly kind = "google";
  constructor(
    readonly plainMessage: string,
    readonly httpStatus: number,
    readonly details: GoogleAdsErrorDetail[],
    readonly googleRequestId: string | undefined,
    readonly googleStatus: string | undefined,
    /** Delay Google asked for (Retry-After header or RetryInfo), if any. */
    readonly retryAfterMs: number | undefined,
    /** The server's own sentence (no Google text). Set when built from Google's reply. */
    readonly serverLine?: string | undefined,
    /** Google's own words (+ field path), or "" when Google sent none. Untrusted text. */
    readonly googleSaid?: string | undefined,
  ) {
    super(plainMessage);
    this.name = "GoogleAdsApiError";
  }
}

/**
 * Google refused a write as busy (429, RESOURCE_TEMPORARILY_EXHAUSTED, CONCURRENT_MODIFICATION).
 * A 4xx means the WHOLE request was refused: nothing was applied. The transport never
 * sends it again; the change engine decides (after re-reading the account).
 */
export class GoogleAdsBusyError extends GoogleAdsApiError {
  readonly busy = true;
}

/** Codes that mean "busy, try again", never "this change is wrong". */
export const BUSY_ERROR_CODES: ReadonlySet<string> = new Set([
  "RESOURCE_TEMPORARILY_EXHAUSTED",
  "CONCURRENT_MODIFICATION",
]);

/** The request was stopped in this process before it was sent (token, ops counter, store). */
export class AdsNotSentError extends Error {
  readonly kind = "not_sent";
  constructor(
    message: string,
    override readonly cause: unknown,
  ) {
    super(message);
    this.name = "AdsNotSentError";
  }
}

/**
 * A write left this process and its outcome is unknown (timeout, connection reset,
 * Google 5xx, unreadable reply). It may or may not have been applied. Never resend it:
 * read the resource (and change history) to find out what happened.
 */
export class AdsInDoubtError extends Error {
  readonly kind = "in_doubt";
  constructor(
    message: string,
    readonly googleRequestId: string | undefined,
    override readonly cause: unknown,
  ) {
    super(message);
    this.name = "AdsInDoubtError";
  }
}

/** Could not talk to Google. `sent: false` means the request never left (DNS, refused). */
export class AdsNetworkError extends Error {
  readonly kind = "network";
  constructor(
    message: string,
    readonly timedOut: boolean,
    readonly sent: boolean,
    override readonly cause: unknown,
  ) {
    super(message);
    this.name = "AdsNetworkError";
  }
}

/** Refused locally before sending: access level does not allow it, or the ops budget is spent. */
export class AdsNotAllowedError extends Error {
  readonly kind = "not_allowed";
  constructor(
    message: string,
    readonly reason: "access_level" | "ops_budget",
  ) {
    super(message);
    this.name = "AdsNotAllowedError";
  }
}

/**
 * Refused locally: Google already said today's request limit is spent and when it refills,
 * so nothing is sent before then (each refused call would count for nothing).
 */
export class AdsDailyLimitError extends AdsNotAllowedError {
  /** tail: what was (not) sent; "No account data was read." when the account list was. */
  constructor(
    readonly waitMs: number,
    tail = "Nothing was sent to Google.",
  ) {
    super(`${dailyLimitLine(waitMs)} ${tail}`, "ops_budget");
    this.name = "AdsDailyLimitError";
  }
}

const OPERATION_FIELDS = new Set(["operations", "mutate_operations", "mutateOperations"]);

const parseDuration = (value: unknown): number | undefined => {
  const match = typeof value === "string" ? /^(\d+(?:\.\d+)?)s$/.exec(value) : null;
  return match?.[1] ? Math.round(Number(match[1]) * 1000) : undefined;
};

const parseDetail = (raw: unknown): GoogleAdsErrorDetail => {
  const e = asObject(raw);
  const code = Object.entries(asObject(e.errorCode)).find(([, v]) => typeof v === "string");
  const elements = asArray(asObject(e.location).fieldPathElements).map(asObject);
  const fieldPath = elements
    .map((el) => {
      const name = asString(el.fieldName) ?? "?";
      return typeof el.index === "number" ? `${name}[${el.index}]` : name;
    })
    .join(".");
  const first = elements[0];
  const operationIndex =
    first &&
    OPERATION_FIELDS.has(asString(first.fieldName) ?? "") &&
    typeof first.index === "number"
      ? first.index
      : null;
  const quota = asObject(asObject(e.details).quotaErrorDetails);
  const retryDelayMs = parseDuration(quota.retryDelay);
  const rateScope = asString(quota.rateScope);
  return {
    errorCode: code ? { type: code[0], value: String(code[1]) } : null,
    message: asString(e.message) ?? "",
    fieldPath,
    operationIndex,
    ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
    ...(rateScope !== undefined ? { rateScope } : {}),
  };
};

const maxDefined = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.max(a, b);

/**
 * Reads Google's error body: `{ error: {...} }`, or the array form SearchStream uses
 * (`[{ error: {...} }]`), or a bare `partialFailureError` status object.
 */
export const parseGoogleFailure = (body: unknown): ParsedGoogleFailure => {
  const first = Array.isArray(body) ? body.find((b) => isObject(b) && "error" in b) : body;
  const root = asObject(first);
  const status = isObject(root.error) ? root.error : root;
  const details: GoogleAdsErrorDetail[] = [];
  let googleRequestId: string | undefined;
  let retryDelayMs: number | undefined;
  for (const d of asArray(status.details).map(asObject)) {
    const type = asString(d["@type"]) ?? "";
    if (type.includes("GoogleAdsFailure")) {
      const parsed = asArray(d.errors).map(parseDetail);
      details.push(...parsed);
      googleRequestId ??= asString(d.requestId);
      for (const p of parsed) retryDelayMs = maxDefined(retryDelayMs, p.retryDelayMs);
    } else if (type.includes("RetryInfo")) {
      retryDelayMs = maxDefined(retryDelayMs, parseDuration(d.retryDelay));
    }
  }
  return {
    message: asString(status.message) ?? "",
    status: asString(status.status),
    details,
    googleRequestId,
    retryDelayMs,
  };
};

/** Plain-English explanations for the error codes people hit most. Keyed by code value. */
const PLAIN_BY_CODE: Readonly<Record<string, string>> = {
  OAUTH_TOKEN_EXPIRED: "The Google sign-in has expired. Sign in again.",
  OAUTH_TOKEN_INVALID: "The Google sign-in is not valid any more. Sign in again.",
  OAUTH_TOKEN_REVOKED: "Access to Google Ads was removed for this sign-in. Sign in again.",
  NOT_ADS_USER: "The signed-in Google user has no Google Ads access.",
  CUSTOMER_NOT_FOUND: "No Google Ads account with this id exists.",
  USER_PERMISSION_DENIED:
    "The signed-in user can't reach this account. If it sits under a manager account, use that manager as the login account.",
  CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION:
    "Your Google Cloud project only has Test access, so it can only reach test accounts. Apply for Explorer access in the Cloud Console.",
  MISSING_TOS:
    "Your Google Cloud project has not accepted the Google Ads API terms of service. Accept them in the Cloud Console.",
  PROJECT_DISABLED: "The Google Ads API is turned off for your Google Cloud project.",
  CLOUD_PROJECT_NOT_UNDER_ORGANIZATION:
    "Your Google Cloud project needs to belong to an organization for this access level.",
  CUSTOMER_NOT_ENABLED:
    "This Google Ads account is not active (cancelled or never finished setup).",
  ACTION_NOT_PERMITTED: "Your Google Cloud project's API access level does not allow this action.",
  INVALID_LOGIN_CUSTOMER_ID: "The login (manager) account id is not valid for this account.",
  RESOURCE_EXHAUSTED:
    "The daily request limit for your Google Cloud project's API access level is used up.",
  RESOURCE_TEMPORARILY_EXHAUSTED: "Too many requests in a short time. Wait a moment and retry.",
  RESOURCE_NOT_FOUND: "The item no longer exists in Google Ads.",
  DUPLICATE_NAME: "Something with this name already exists.",
  REQUIRED: "A required field is missing.",
  TOO_LOW: "A value is below the allowed minimum.",
  TOO_HIGH: "A value is above the allowed maximum.",
  INTERNAL_ERROR: "Google had an internal problem.",
  TRANSIENT_ERROR: "Google had a temporary problem.",
};

const PLAIN_BY_TYPE: Readonly<Record<string, string>> = {
  queryError: "The GAQL query is not valid.",
  policyFindingError: "Google's ad policies would block this.",
  policyViolationError: "Google's ad policies would block this.",
  authenticationError: "Google could not confirm the sign-in.",
  authorizationError: "This sign-in is not allowed to do that.",
  quotaError: "A Google Ads API limit was hit.",
};

const plainByStatus = (httpStatus: number): string => {
  if (httpStatus === 401) return "Google could not confirm the sign-in.";
  if (httpStatus === 403) return "This sign-in is not allowed to do that.";
  if (httpStatus === 404) return "Google could not find what was asked for.";
  if (httpStatus === 429) return "A Google Ads API limit was hit.";
  if (httpStatus >= 500) return "Google had a problem answering.";
  return "Google refused the request.";
};

/** 7000 -> "7 seconds", 5400000 -> "90 minutes", 86400000 -> "24 hours" (rounded up). */
export const humanWait = (ms: number): string => {
  const s = Math.ceil(ms / 1000);
  if (s < 120) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.ceil(s / 60);
  if (m < 120) return `${m} minutes`;
  return `${Math.ceil(m / 60)} hours`;
};

/** quotaError RESOURCE_EXHAUSTED: the daily operations quota is spent. Retrying cannot help. */
export const isDailyQuotaExhausted = (details: readonly GoogleAdsErrorDetail[]): boolean =>
  details.some(
    (d) => d.errorCode?.type === "quotaError" && d.errorCode.value === "RESOURCE_EXHAUSTED",
  );

/**
 * The daily limit spent is the whole project's (rateScope DEVELOPER, or not said), so every
 * account in the pool waits; one account's own limit (ACCOUNT, or another scope) is not.
 */
export const isProjectDailyLimit = (details: readonly GoogleAdsErrorDetail[]): boolean =>
  details.some(
    (d) =>
      d.errorCode?.type === "quotaError" &&
      d.errorCode.value === "RESOURCE_EXHAUSTED" &&
      (d.rateScope === undefined || d.rateScope === "DEVELOPER"),
  );

/** "Google's daily request limit for this project is used up; it refills in about 8 hours." */
export const dailyLimitLine = (waitMs: number | undefined): string =>
  `Google's daily request limit for this project is used up${
    waitMs !== undefined && waitMs > 0 ? `; it refills in about ${humanWait(waitMs)}` : ""
  }.`;

/**
 * The wait Google asked for when an error says the daily request limit is spent
 * (waitMs undefined when it named none); null for any other error. project: the whole
 * project's limit (isProjectDailyLimit; a wait kept locally is only ever that one), not
 * one account's own.
 */
export const dailyLimitOf = (
  err: unknown,
): { waitMs: number | undefined; project: boolean } | null => {
  if (err instanceof AdsDailyLimitError) return { waitMs: err.waitMs, project: true };
  if (err instanceof AdsNotSentError) return dailyLimitOf(err.cause);
  return err instanceof GoogleAdsApiError && isDailyQuotaExhausted(err.details)
    ? { waitMs: err.retryAfterMs, project: isProjectDailyLimit(err.details) }
    : null;
};

/**
 * One line a non-developer can read, plus Google's own words and the field, e.g.
 * `Something with this name already exists. Google said: "Duplicate name." (field: operations[0].create.name)`.
 */
/** The server's own sentence for a failure: no text from Google in it. */
export const serverLineOf = (
  failure: ParsedGoogleFailure,
  httpStatus: number,
  waitMs: number | undefined = failure.retryDelayMs,
): string => {
  const code = failure.details[0]?.errorCode;
  const plain =
    (code && (PLAIN_BY_CODE[code.value] ?? PLAIN_BY_TYPE[code.type])) ?? plainByStatus(httpStatus);
  return waitMs !== undefined && (httpStatus === 429 || code?.type === "quotaError")
    ? `${plain} Google asks to wait ${humanWait(waitMs)}.`
    : plain;
};

/** Google's own words for a failure (+ field path, count of more errors); "" when none. */
export const googleSaidOf = (failure: ParsedGoogleFailure): string => {
  const first = failure.details[0];
  const said = first?.message || failure.message;
  const parts: string[] = [];
  if (said) parts.push(said.slice(0, 300));
  if (first?.fieldPath) parts.push(`(field: ${first.fieldPath})`);
  if (failure.details.length > 1) parts.push(`(+${failure.details.length - 1} more)`);
  return parts.join(" ");
};

export const plainEnglish = (
  failure: ParsedGoogleFailure,
  httpStatus: number,
  waitMs: number | undefined = failure.retryDelayMs,
): string => {
  const first = failure.details[0];
  const said = first?.message || failure.message;
  const parts = [serverLineOf(failure, httpStatus, waitMs)];
  if (said) parts.push(`Google said: "${said.slice(0, 300)}"`);
  if (first?.fieldPath) parts.push(`(field: ${first.fieldPath})`);
  if (failure.details.length > 1) parts.push(`(+${failure.details.length - 1} more)`);
  return parts.join(" ");
};

export const toGoogleAdsApiError = (
  body: unknown,
  httpStatus: number,
  headerRequestId: string | undefined,
  retryAfterHeaderMs: number | undefined,
): GoogleAdsApiError => {
  const failure = parseGoogleFailure(body);
  const waitMs = maxDefined(retryAfterHeaderMs, failure.retryDelayMs);
  return new GoogleAdsApiError(
    plainEnglish(failure, httpStatus, waitMs),
    httpStatus,
    failure.details,
    headerRequestId ?? failure.googleRequestId,
    failure.status,
    waitMs,
    serverLineOf(failure, httpStatus, waitMs),
    googleSaidOf(failure),
  );
};

export type AccessIssue =
  | "test_access_only"
  | "terms_not_accepted"
  | "api_disabled"
  | "project_not_in_organization"
  | "access_level_too_low"
  | "no_account_access";

/** Error code -> access issue. ACTION_NOT_PERMITTED is what v24 and earlier sent for Test-only. */
const ACCESS_ISSUES: Readonly<Record<string, AccessIssue>> = {
  CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION: "test_access_only",
  MISSING_TOS: "terms_not_accepted",
  PROJECT_DISABLED: "api_disabled",
  CLOUD_PROJECT_NOT_UNDER_ORGANIZATION: "project_not_in_organization",
  ACTION_NOT_PERMITTED: "access_level_too_low",
  USER_PERMISSION_DENIED: "no_account_access",
};

/**
 * Tells whether an error is about API access (Cloud project level, terms, account reach)
 * rather than the request itself. Google has no endpoint that reports the access level,
 * so this is how it is detected. Returns null for every other error.
 */
export const classifyAccessError = (
  err: unknown,
): { issue: AccessIssue; message: string } | null => {
  if (!(err instanceof GoogleAdsApiError)) return null;
  for (const d of err.details) {
    const issue = d.errorCode ? ACCESS_ISSUES[d.errorCode.value] : undefined;
    if (issue) return { issue, message: err.plainMessage };
  }
  return null;
};

/** Exact code match on any error code type. Never a substring match. */
export const hasErrorCode = (details: readonly GoogleAdsErrorDetail[], value: string): boolean =>
  details.some((d) => d.errorCode?.value === value);

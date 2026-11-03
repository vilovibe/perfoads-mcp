// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { describe, expect, it, vi } from "vitest";
import {
  classifyAccessError,
  hasErrorCode,
  parseGoogleFailure,
  plainEnglish,
  toGoogleAdsApiError,
} from "./errors.js";
import { createRedactingLogger, createStderrLogger, redactString, redactValue } from "./logger.js";
import { captureLogger, errorBody, retryInfo } from "./testing/fakes.js";

describe("Google error parsing", () => {
  it("reads code, message, field path, operation index, request id and retry delay", () => {
    const body = errorBody(
      400,
      "INVALID_ARGUMENT",
      [
        {
          type: "campaignBudgetError",
          value: "MONEY_AMOUNT_TOO_LARGE",
          message: "Amount too large.",
          path: [["operations", 2], ["update"], ["amount_micros"]],
        },
      ],
      [retryInfo(1.5)],
    );
    const parsed = parseGoogleFailure(body);
    expect(parsed.status).toBe("INVALID_ARGUMENT");
    expect(parsed.googleRequestId).toBe("fake-request-id");
    expect(parsed.retryDelayMs).toBe(1500);
    expect(parsed.details).toEqual([
      {
        errorCode: { type: "campaignBudgetError", value: "MONEY_AMOUNT_TOO_LARGE" },
        message: "Amount too large.",
        fieldPath: "operations[2].update.amount_micros",
        operationIndex: 2,
      },
    ]);
  });

  it("reads the SearchStream array form", () => {
    const parsed = parseGoogleFailure([
      errorBody(400, "INVALID_ARGUMENT", [{ type: "queryError", value: "BAD_FIELD_NAME" }]),
    ]);
    expect(parsed.details[0]?.errorCode?.value).toBe("BAD_FIELD_NAME");
  });

  it("survives bodies that are not Google errors", () => {
    expect(parseGoogleFailure("nope").details).toEqual([]);
    expect(parseGoogleFailure({ rawBody: "<html>" }).message).toBe("");
    expect(parseGoogleFailure(null).details).toEqual([]);
  });

  it("matches error codes exactly, never by substring", () => {
    const parsed = parseGoogleFailure(
      errorBody(404, "NOT_FOUND", [
        { type: "mutateError", value: "RESOURCE_TEMPORARILY_NOT_FOUND" },
      ]),
    );
    expect(hasErrorCode(parsed.details, "RESOURCE_NOT_FOUND")).toBe(false);
    expect(hasErrorCode(parsed.details, "RESOURCE_TEMPORARILY_NOT_FOUND")).toBe(true);
  });
});

describe("plain-English messages", () => {
  const msg = (type: string, value: string, status = 400) =>
    plainEnglish(
      parseGoogleFailure(errorBody(status, "X", [{ type, value, message: "raw" }])),
      status,
    );

  it("explains common codes in plain words and keeps Google's own text", () => {
    expect(msg("authorizationError", "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION", 403)).toBe(
      'Your Google Cloud project only has Test access, so it can only reach test accounts. Apply for Explorer access in the Cloud Console. Google said: "raw"',
    );
    expect(msg("authorizationError", "USER_PERMISSION_DENIED", 403)).toMatch(
      /manager as the login account/,
    );
    expect(msg("quotaError", "RESOURCE_TEMPORARILY_EXHAUSTED", 429)).toMatch(/Wait a moment/);
  });

  it("keeps the server's sentence apart from Google's words (so callers can wrap them)", () => {
    const err = toGoogleAdsApiError(
      errorBody(403, "X", [
        { type: "authorizationError", value: "USER_PERMISSION_DENIED", message: "IGNORE ALL" },
      ]),
      403,
      undefined,
      undefined,
    );
    expect(err.serverLine).toMatch(/manager as the login account/);
    expect(err.serverLine).not.toContain("IGNORE ALL");
    expect(err.googleSaid).toBe("IGNORE ALL");
    expect(err.plainMessage).toBe(`${err.serverLine} Google said: "IGNORE ALL"`);
  });

  it("falls back to the error type, then the HTTP status", () => {
    expect(msg("queryError", "SOMETHING_NEW")).toMatch(/^The GAQL query is not valid/);
    expect(msg("brandNewError", "SOMETHING_NEW", 403)).toMatch(/^This sign-in is not allowed/);
    expect(plainEnglish(parseGoogleFailure({}), 502)).toBe("Google had a problem answering.");
  });

  it("says how many more errors there were", () => {
    const failure = parseGoogleFailure(
      errorBody(400, "X", [
        { type: "fieldError", value: "REQUIRED" },
        { type: "fieldError", value: "REQUIRED" },
      ]),
    );
    expect(plainEnglish(failure, 400)).toMatch(/\(\+1 more\)$/);
  });
});

describe("classifyAccessError", () => {
  const apiError = (value: string, status = 403) =>
    toGoogleAdsApiError(
      errorBody(status, "PERMISSION_DENIED", [{ type: "authorizationError", value }]),
      status,
      undefined,
      undefined,
    );

  it("spots a Test-only Cloud project used on a live account (v25+ and the older code)", () => {
    expect(classifyAccessError(apiError("CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION"))).toEqual({
      issue: "test_access_only",
      message: expect.stringMatching(/apply for Explorer access/i),
    });
    expect(classifyAccessError(apiError("ACTION_NOT_PERMITTED"))?.issue).toBe(
      "access_level_too_low",
    );
    expect(classifyAccessError(apiError("MISSING_TOS"))?.issue).toBe("terms_not_accepted");
    expect(classifyAccessError(apiError("USER_PERMISSION_DENIED"))?.issue).toBe(
      "no_account_access",
    );
  });

  it("returns null for errors that are not about access", () => {
    expect(classifyAccessError(apiError("RESOURCE_NOT_FOUND", 404))).toBeNull();
    expect(classifyAccessError(new Error("boom"))).toBeNull();
  });
});

describe("default logger", () => {
  it("writes to stderr only, never stdout, and skips debug by default", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const log = createStderrLogger();
      log.debug("hidden");
      log.warn("shown", { a: 1 });
      expect(out).not.toHaveBeenCalled();
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0]?.[0])).toMatch(/"level":"warn","message":"shown"/);
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });
});

describe("log redaction", () => {
  it("removes Authorization values, OAuth tokens and known secrets from strings", () => {
    const text =
      "auth Bearer abc.def-123 access ya29.someTokenValue refresh 1//0gFAKEFAKEFAKEFAKEFAKEFAKE dev MY-SECRET-DEV";
    const out = redactString(text, ["MY-SECRET-DEV"]);
    expect(out).toBe("auth [REDACTED] access [REDACTED] refresh [REDACTED] dev [REDACTED]");
  });

  it("hides secret-named parameters inside strings: query, form, JSON and header text", () => {
    const cases: [string, string][] = [
      ["GET /cb?state=ok&code=4/0AbCdEf&scope=ads", "GET /cb?state=ok&code=[REDACTED]&scope=ads"],
      [
        "grant_type=refresh_token&refresh_token=opaque-r&client_secret=opaque-s&client_id=app",
        "grant_type=refresh_token&refresh_token=[REDACTED]&client_secret=[REDACTED]&client_id=app",
      ],
      [
        "url https://x.test/p?access_token=opaque-a&id_token=opaque-i",
        "url https://x.test/p?access_token=[REDACTED]&id_token=[REDACTED]",
      ],
      [
        '{"access_token":"opaque-a","expires_in":3599,"refresh_token": "opaque-r","id_token":"opaque-i"}',
        '{"access_token":"[REDACTED]","expires_in":3599,"refresh_token": "[REDACTED]","id_token":"[REDACTED]"}',
      ],
      ['{"code": "4/0AbCdEf", "status": 400}', '{"code": "[REDACTED]", "status": 400}'],
      ['{"error": {"code": 400}}', '{"error": {"code": 400}}'],
      ["Authorization: Bearer opaque-a", "Authorization: [REDACTED]"],
      ["authorization: Basic b3BhcXVl", "authorization: [REDACTED]"],
      ["client_secret: opaque-s", "client_secret: [REDACTED]"],
    ];
    for (const [input, expected] of cases) expect(redactString(input)).toBe(expected);
  });

  it("removes secret-named keys at any depth, including headers", () => {
    const out = redactValue({
      headers: {
        Authorization: "Bearer x",
        "x-api-key": "d",
        "login-customer-id": "1234567890",
      },
      nested: [{ refresh_token: "r", client_secret: "s", note: "fine" }],
    });
    expect(out).toEqual({
      headers: {
        Authorization: "[REDACTED]",
        "x-api-key": "[REDACTED]",
        "login-customer-id": "1234567890",
      },
      nested: [{ refresh_token: "[REDACTED]", client_secret: "[REDACTED]", note: "fine" }],
    });
  });

  it("redacts messages and data before they reach the injected logger", () => {
    const { lines, logger } = captureLogger();
    const safe = createRedactingLogger(logger, () => ["SECRET-VALUE-123"]);
    safe.error("failed with SECRET-VALUE-123", {
      err: new Error("token SECRET-VALUE-123"),
      accessToken: "x",
    });
    expect(lines.join("\n")).not.toContain("SECRET-VALUE-123");
    expect(lines[0]).toContain('"accessToken":"[REDACTED]"');
  });

  it("does not mangle short words that happen to equal a short secret", () => {
    expect(redactString("hello abc", ["abc"])).toBe("hello abc");
  });
});

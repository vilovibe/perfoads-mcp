// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { AdsNotAllowedError } from "@perfoads/ads-client";
import { asObject, asString } from "./json.js";
import { ChangeError } from "./errors.js";
import type { AccountFacts, EngineAds, Target } from "./facts.js";

const ACCOUNT_QUERY =
  "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.test_account, customer.manager FROM customer LIMIT 1";

/** Reads the account live. Its test_account flag is what the apply guard trusts. */
export const readAccount = async (
  ads: EngineAds,
  target: Target,
  deadlineMs?: number,
): Promise<AccountFacts> => {
  let rows;
  try {
    ({ rows } = await ads.searchAll({
      ...target,
      query: ACCOUNT_QUERY,
      maxRows: 1,
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
    }));
  } catch (err) {
    throw readFailed("the account", err);
  }
  const c = asObject(rows[0]?.customer);
  const currencyCode = asString(c.currencyCode);
  if (!currencyCode || !/^[A-Z]{3}$/.test(currencyCode)) {
    throw new ChangeError("read_failed", "Couldn't read the account's currency from Google Ads.");
  }
  return {
    customerId: target.customerId,
    name: asString(c.descriptiveName) ?? "",
    currencyCode,
    timeZone: asString(c.timeZone) ?? null,
    testAccount: c.testAccount === true,
    manager: c.manager === true,
  };
};

/** A read failed: the server's sentence plus Google's words apart. */
export const readFailed = (what: string, err: unknown): ChangeError => {
  if (err instanceof ChangeError) return err;
  // Refused before sending (the ops budget or the operations kept for changes): say why.
  if (err instanceof AdsNotAllowedError && err.reason === "ops_budget") {
    return new ChangeError("read_failed", `Couldn't read ${what} from Google Ads. ${err.message}`);
  }
  const e = err as { serverLine?: unknown; googleSaid?: unknown; message?: unknown };
  const line = typeof e?.serverLine === "string" ? e.serverLine : "";
  const said = typeof e?.googleSaid === "string" && e.googleSaid ? e.googleSaid : undefined;
  return new ChangeError(
    "read_failed",
    `Couldn't read ${what} from Google Ads, so nothing was changed.${line ? ` ${line}` : ""}`,
    said,
  );
};

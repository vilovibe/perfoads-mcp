// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { dailyLimitOf } from "./errors.js";
import { asArray, asObject, asString } from "./json.js";
import { searchAll } from "./search.js";
import { normalizeCustomerId, type Transport } from "./transport.js";

export interface AdsAccount {
  customerId: string;
  name: string;
  currencyCode: string | undefined;
  timeZone: string | undefined;
  isManager: boolean;
  isTestAccount: boolean;
  status: string | undefined;
  /** The id to send as login-customer-id when working on this account. */
  loginCustomerId: string;
  /** 0 = the signed-in user has direct access; 1+ = depth under that manager. */
  level: number;
}

export interface DiscoverResult {
  accounts: AdsAccount[];
  /** Accounts that could not be read, with Google's reason. Never silently dropped. */
  failures: DiscoverFailure[];
}

export interface DiscoverFailure {
  customerId: string;
  message: string;
  /**
   * Set when the read failed because the daily request limit is spent: not a reach problem.
   * project: the whole project's limit, not this account's own.
   */
  dailyLimit?: { waitMs: number | undefined; project: boolean };
}

/** CustomerService.ListAccessibleCustomers: accounts the user can reach directly. 1 operation. */
export const listAccessibleCustomers = async (t: Transport): Promise<string[]> => {
  const res = await t.read({
    method: "GET",
    path: "customers:listAccessibleCustomers",
    opsCost: 1,
    opsKind: "other",
  });
  return asArray(asObject(res.json).resourceNames)
    .map((rn) => asString(rn)?.replace(/^customers\//, ""))
    .filter((id): id is string => id !== undefined && /^\d{10}$/.test(id));
};

const CUSTOMER_QUERY = `SELECT customer.id, customer.descriptive_name, customer.currency_code,
  customer.time_zone, customer.manager, customer.test_account, customer.status
FROM customer LIMIT 1`;

const CLIENT_QUERY = `SELECT customer_client.client_customer, customer_client.descriptive_name,
  customer_client.currency_code, customer_client.time_zone, customer_client.manager,
  customer_client.test_account, customer_client.status, customer_client.level,
  customer_client.hidden
FROM customer_client
WHERE customer_client.hidden = FALSE AND customer_client.level > 0`;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const failureOf = (customerId: string, err: unknown): DiscoverFailure => {
  const limit = dailyLimitOf(err);
  return { customerId, message: messageOf(err), ...(limit ? { dailyLimit: limit } : {}) };
};

/**
 * Finds every account the user can work on, with the login-customer-id each needs:
 * direct accounts log in as themselves, accounts under a manager log in as that manager.
 */
export const discoverAccounts = async (t: Transport): Promise<DiscoverResult> => {
  const direct = await listAccessibleCustomers(t);
  const byId = new Map<string, AdsAccount>();
  const failures: DiscoverResult["failures"] = [];
  const managers: string[] = [];

  for (const id of direct) {
    try {
      const { rows } = await searchAll(t, {
        customerId: id,
        loginCustomerId: id,
        query: CUSTOMER_QUERY,
      });
      const c = asObject(rows[0]?.customer);
      const account: AdsAccount = {
        customerId: id,
        name: asString(c.descriptiveName) ?? "",
        currencyCode: asString(c.currencyCode),
        timeZone: asString(c.timeZone),
        isManager: c.manager === true,
        isTestAccount: c.testAccount === true,
        status: asString(c.status),
        loginCustomerId: id,
        level: 0,
      };
      byId.set(id, account);
      if (account.isManager) managers.push(id);
    } catch (err) {
      failures.push(failureOf(id, err));
    }
  }

  for (const managerId of managers) {
    try {
      const { rows } = await searchAll(t, {
        customerId: managerId,
        loginCustomerId: managerId,
        query: CLIENT_QUERY,
      });
      for (const row of rows) {
        const c = asObject(row.customerClient);
        const raw = asString(c.clientCustomer)?.replace(/^customers\//, "");
        if (!raw || !/^\d{10}$/.test(raw) || byId.has(raw)) continue;
        byId.set(raw, {
          customerId: normalizeCustomerId(raw),
          name: asString(c.descriptiveName) ?? "",
          currencyCode: asString(c.currencyCode),
          timeZone: asString(c.timeZone),
          isManager: c.manager === true,
          isTestAccount: c.testAccount === true,
          status: asString(c.status),
          loginCustomerId: managerId,
          level: Number(c.level ?? 1),
        });
      }
    } catch (err) {
      failures.push(failureOf(managerId, err));
    }
  }

  return { accounts: [...byId.values()], failures };
};

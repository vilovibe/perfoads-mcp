// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { Store } from "./db.js";

export interface StoredAccount {
  customerId: string;
  name: string;
  currencyCode: string | undefined;
  timeZone: string | undefined;
  isManager: boolean;
  isTestAccount: boolean;
  status: string | undefined;
  loginCustomerId: string;
  level: number;
}

/** Replaces the saved account list with what Google returned just now. */
export const saveAccounts = (store: Store, accounts: readonly StoredAccount[]): void => {
  const at = new Date().toISOString();
  store.immediate(() => {
    store.db.prepare("DELETE FROM accounts").run();
    const insert = store.db.prepare(
      `INSERT INTO accounts (customer_id, name, currency_code, time_zone, is_manager,
         is_test_account, status, login_customer_id, level, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const a of accounts) {
      insert.run(
        a.customerId,
        a.name,
        a.currencyCode ?? null,
        a.timeZone ?? null,
        a.isManager ? 1 : 0,
        a.isTestAccount ? 1 : 0,
        a.status ?? null,
        a.loginCustomerId,
        a.level,
        at,
      );
    }
  });
};

interface AccountRow {
  customer_id: string;
  name: string;
  currency_code: string | null;
  time_zone: string | null;
  is_manager: number;
  is_test_account: number;
  status: string | null;
  login_customer_id: string;
  level: number;
}

export const listSavedAccounts = (store: Store): StoredAccount[] =>
  (
    store.db
      .prepare("SELECT * FROM accounts ORDER BY level, customer_id")
      .all() as unknown as AccountRow[]
  ).map((r) => ({
    customerId: r.customer_id,
    name: r.name,
    currencyCode: r.currency_code ?? undefined,
    timeZone: r.time_zone ?? undefined,
    isManager: r.is_manager === 1,
    isTestAccount: r.is_test_account === 1,
    status: r.status ?? undefined,
    loginCustomerId: r.login_customer_id,
    level: r.level,
  }));

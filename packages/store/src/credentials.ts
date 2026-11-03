// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { decryptValue, encryptValue } from "./crypto.js";
import { busyAsStoreError, type Store } from "./db.js";

export type CredentialPurpose = "oauth_client_id" | "oauth_client_secret" | "refresh_token";

export const CREDENTIAL_PURPOSES: readonly CredentialPurpose[] = [
  "oauth_client_id",
  "oauth_client_secret",
  "refresh_token",
];

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface CredentialsInfo {
  /** Purposes that have a saved value (nothing is decrypted to answer this). */
  saved: CredentialPurpose[];
  /** Testing-mode OAuth apps: when the refresh token stops working. undefined = no expiry known. */
  refreshTokenExpiresAt: string | undefined;
  /** Latest change to any saved credential: tells a running server that `auth` ran again. */
  updatedAt: string | undefined;
}

const nowIso = () => new Date().toISOString();

export const saveCredential = (
  store: Store,
  key: Buffer,
  purpose: CredentialPurpose,
  value: string,
  expiresAt: string | null = null,
): void => {
  const ciphertext = encryptValue(key, value, purpose);
  const at = nowIso();
  busyAsStoreError(store, () =>
    store.db
      .prepare(
        `INSERT INTO credentials (purpose, ciphertext, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(purpose) DO UPDATE SET ciphertext = excluded.ciphertext,
         expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      )
      .run(purpose, ciphertext, expiresAt, at, at),
  );
};

export const loadCredential = (
  store: Store,
  key: Buffer,
  purpose: CredentialPurpose,
): string | undefined => {
  const row = store.db
    .prepare("SELECT ciphertext FROM credentials WHERE purpose = ?")
    .get(purpose) as { ciphertext: string } | undefined;
  return row ? decryptValue(key, row.ciphertext, purpose) : undefined;
};

export const credentialsInfo = (store: Store): CredentialsInfo => {
  const rows = store.db
    .prepare("SELECT purpose, expires_at, updated_at FROM credentials")
    .all() as {
    purpose: string;
    expires_at: string | null;
    updated_at: string;
  }[];
  const saved = CREDENTIAL_PURPOSES.filter((p) => rows.some((r) => r.purpose === p));
  const refresh = rows.find((r) => r.purpose === "refresh_token");
  const updatedAt = rows.reduce<string | undefined>(
    (max, r) => (max === undefined || r.updated_at > max ? r.updated_at : max),
    undefined,
  );
  return { saved, refreshTokenExpiresAt: refresh?.expires_at ?? undefined, updatedAt };
};

export const loadOAuthCredentials = (store: Store, key: Buffer): OAuthCredentials | undefined => {
  const clientId = loadCredential(store, key, "oauth_client_id");
  const clientSecret = loadCredential(store, key, "oauth_client_secret");
  const refreshToken = loadCredential(store, key, "refresh_token");
  return clientId && clientSecret && refreshToken
    ? { clientId, clientSecret, refreshToken }
    : undefined;
};

/** Removes every saved credential (disconnect). The Google-side grant is revoked separately. */
export const deleteCredentials = (store: Store): void => {
  busyAsStoreError(store, () => store.db.prepare("DELETE FROM credentials").run());
};

export const ENV_CREDENTIALS = {
  clientId: "PERFOADS_MCP_CLIENT_ID",
  clientSecret: "PERFOADS_MCP_CLIENT_SECRET",
  refreshToken: "PERFOADS_MCP_REFRESH_TOKEN",
} as const;

/**
 * Credentials from environment variables: a weaker, documented option (the values sit in
 * plain text in the MCP client's config file). "partial" = some but not all are set.
 */
export const readEnvCredentials = (
  env: Readonly<Record<string, string | undefined>>,
): OAuthCredentials | "partial" | undefined => {
  const clientId = env[ENV_CREDENTIALS.clientId]?.trim();
  const clientSecret = env[ENV_CREDENTIALS.clientSecret]?.trim();
  const refreshToken = env[ENV_CREDENTIALS.refreshToken]?.trim();
  if (clientId && clientSecret && refreshToken) return { clientId, clientSecret, refreshToken };
  return clientId || clientSecret || refreshToken ? "partial" : undefined;
};

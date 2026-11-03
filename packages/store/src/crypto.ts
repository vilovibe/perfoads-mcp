// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { howToRun } from "./invocation.js";

export const DATA_KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit IV, the GCM standard
const TAG_BYTES = 16;
const FORMAT = "v1";

/** Thrown when a value cannot be decrypted: wrong key, wrong purpose, or tampered data. */
export class DecryptError extends Error {
  constructor() {
    super(
      `The saved Google sign-in could not be decrypted: it was saved with a different encryption key, or the file was changed. Run \`${howToRun("auth")}\` in a terminal to delete it and sign in again.`,
    );
    this.name = "DecryptError";
  }
}

const aad = (purpose: string): Buffer => Buffer.from(`perfoads-mcp:credential:${purpose}`, "utf8");

const checkKey = (key: Buffer): void => {
  if (key.length !== DATA_KEY_BYTES) throw new TypeError("data key must be 32 bytes");
};

/**
 * AES-256-GCM with a fresh random IV per value. The purpose (e.g. "refresh_token") is bound
 * as additional authenticated data, so a ciphertext copied to another row will not decrypt.
 * Output: "v1.<base64 iv|tag|ciphertext>".
 */
export const encryptValue = (key: Buffer, plaintext: string, purpose: string): string => {
  checkKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(purpose));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${FORMAT}.${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64")}`;
};

export const decryptValue = (key: Buffer, stored: string, purpose: string): string => {
  checkKey(key);
  const [format, body, extra] = stored.split(".");
  if (format !== FORMAT || body === undefined || extra !== undefined) throw new DecryptError();
  const raw = Buffer.from(body, "base64");
  if (raw.length < IV_BYTES + TAG_BYTES) throw new DecryptError();
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(aad(purpose));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new DecryptError();
  }
};

export const newDataKey = (): Buffer => randomBytes(DATA_KEY_BYTES);

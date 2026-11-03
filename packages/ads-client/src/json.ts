// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Small guards for reading untyped JSON from Google without `any`.

export type JsonObject = Record<string, unknown>;

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const asObject = (value: unknown): JsonObject => (isObject(value) ? value : {});

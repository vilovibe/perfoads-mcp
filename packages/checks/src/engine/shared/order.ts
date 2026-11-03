// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Plain code-unit string comparison. Unlike `localeCompare` it gives the same
 * order on every machine and locale, so sorted output is reproducible.
 */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

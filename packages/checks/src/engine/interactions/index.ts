// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Interaction matrix (confounder resolution) — audit v3 evidence engine,
 * spec §3.2 / §8.3 / §8.4 rule 7, build sheet §B confounder columns.
 */
export * from "./types.js";
export {
  INTERACTION_MATRIX,
  confoundersFor,
  checksWithConfounders,
  resolverKeys,
  locate,
  type Located,
} from "./matrix.js";
export { resolveConfounders, confidenceCeiling, resolveAndJudge } from "./resolve.js";

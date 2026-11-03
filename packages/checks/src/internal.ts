// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * UNSTABLE. Not public API, not documented, not covered by semver: names and
 * shapes here change without notice. It exists so a separate package can
 * supply the `RemedyProvider` / `WriterHints` that `runChecks` accepts with
 * the same helpers the checks use. Do not import it from anything else.
 */
export type {
  CheckCtx,
  CheckFinding,
  EvidenceRow,
  Remediation,
  RemedyFn,
  RemedyProvider,
  WriterHints,
} from "./engine/checks/types.js";
export type { AlwaysOnDeclaration } from "./engine/checks/clientContextGate.js";
export { SLICE_KEY_SEPARATOR } from "./engine/model/nodes/Slice.js";

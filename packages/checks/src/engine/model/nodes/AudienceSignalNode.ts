// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { BaseNode } from "../types.js";

export interface AudienceSignalAttrs {
  assetGroupId: string | null;
  campaignId: string | null;
  /** Demand Gen signals attach per ad group (Phase 1b columns). */
  adGroupId: string | null;
  audienceResource: string;
  audienceId: string | null;
  /** from audiences (id join on the resource suffix); null when the audience row was not synced. */
  audienceName: string | null;
  audienceStatus: string | null;
  approvalStatus: string | null;
  disapprovalReasons: unknown[];
  /**
   * Round 2 Y7: the customer / remarketing lists (user list ids) this signal
   * attaches. PMax: parsed from the audience's synced `dimensions_json`; Demand
   * Gen: the criterion's own list, or its audience's lists. [] = attaches no
   * list; null/absent = could not tell (audience row not synced, combined
   * audience) — never read as "no list".
   */
  userListIds?: string[] | null | undefined;
}

/** Round 2 Y7: every `userLists/<id>` named in an audience definition (the synced JSON). */
export function userListIdsIn(dimensionsJson: unknown): string[] | null {
  if (dimensionsJson == null) return null;
  const text = typeof dimensionsJson === "string" ? dimensionsJson : JSON.stringify(dimensionsJson);
  if (text.trim() === "") return null;
  return [...new Set([...text.matchAll(/userLists\/(\d+)/g)].map((m) => m[1]!))];
}

export interface AudienceSignalNode extends BaseNode<"audienceSignal"> {
  attrs: AudienceSignalAttrs;
}

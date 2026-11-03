// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * The one double-count rule MI03 and its confounder (interactions/matrix.ts)
 * share, so a clean MI03 never sits next to a confounder saying "may be counted
 * twice". Pure, no IO.
 */
import type { ConversionActionNode } from "../model/nodes/ConversionActionNode.js";

export type DoubleCount =
  /** 2+ enabled primary actions of one family recorded conversions in the window. */
  | { state: "fires"; actions: ConversionActionNode[]; categories: string[] }
  /** a double count cannot be ruled out on what was read. */
  | { state: "unknown"; reason: string }
  | { state: "clean"; live: number };

/**
 * Categories that record the same event. A form sent, a qualified lead and a
 * converted lead are one lead counted at three steps, and PURCHASE_ONLINE is
 * a purchase; a sign-up is its own event, never a purchase.
 */
const FAMILY: Readonly<Record<string, string>> = {
  PURCHASE: "purchase",
  PURCHASE_ONLINE: "purchase",
  SUBMIT_LEAD_FORM: "lead",
  QUALIFIED_LEAD: "lead",
  CONVERTED_LEAD: "lead",
};
const familyOf = (category: string): string => FAMILY[category] ?? category;
const categoryOf = (a: ConversionActionNode): string =>
  String(a.attrs.category ?? "").toUpperCase();

/** Conversions an action recorded in the window: its total, else the sum of its daily rows; null = not read. */
function recordedConversions(a: ConversionActionNode): number | null {
  const daily = a.attrs.daily;
  const fromDaily = daily && daily.length > 0 ? daily.reduce((n, r) => n + r.conv, 0) : null;
  return a.attrs.totalConversions ?? fromDaily;
}

/** Google's named action statuses; anything else (null, UNKNOWN, UNSPECIFIED) is not read. */
const KNOWN_STATUS = new Set(["ENABLED", "HIDDEN", "REMOVED"]);

/**
 * `primaries` = the PRIMARY actions of the purchase set. Only an ENABLED action
 * still counts (a HIDDEN or REMOVED one records nothing new), only one that
 * recorded conversions can double count, and only next to another of the same
 * family (FAMILY): a purchase and a sign-up are two different events.
 * An action whose status was not read may be enabled: it is never counted out.
 */
export function doubleCountOf(primaries: readonly ConversionActionNode[]): DoubleCount {
  const statusOf = (a: ConversionActionNode) => String(a.attrs.status ?? "").toUpperCase();
  const live = primaries.filter((a) => statusOf(a) === "ENABLED");
  const unknownStatus = primaries.filter((a) => !KNOWN_STATUS.has(statusOf(a)));
  type Group = { recorded: ConversionActionNode[]; unread: number; noStatus: number };
  const byKind = new Map<string, Group>();
  const groupOf = (a: ConversionActionNode): Group => {
    const kind = familyOf(categoryOf(a));
    const g = byKind.get(kind) ?? { recorded: [], unread: 0, noStatus: 0 };
    byKind.set(kind, g);
    return g;
  };
  for (const a of live) {
    const g = groupOf(a);
    const conv = recordedConversions(a);
    if (conv == null) g.unread += 1;
    else if (conv > 0) g.recorded.push(a);
  }
  // one that recorded nothing cannot double count, whatever its status
  for (const a of unknownStatus) if (recordedConversions(a) !== 0) groupOf(a).noStatus += 1;
  const groups = [...byKind.values()];
  const recorded = groups.filter((g) => g.recorded.length >= 2).flatMap((g) => g.recorded);
  if (recorded.length >= 2)
    return {
      state: "fires",
      actions: recorded,
      // every category of a duplicated family: a campaign bidding on any of them is touched
      categories: [...new Set([...Object.keys(FAMILY), ...recorded.map(categoryOf)])].filter((c) =>
        recorded.some((a) => familyOf(categoryOf(a)) === familyOf(c)),
      ),
    };
  // never clean on a count or a status we could not read
  const open = groups.filter((g) => g.recorded.length + g.unread + g.noStatus >= 2);
  const unread = open.reduce((n, g) => n + g.unread, 0);
  const noStatus = open.reduce((n, g) => n + g.noStatus, 0);
  if (unread + noStatus > 0)
    return {
      state: "unknown",
      reason: [
        unread > 0
          ? `${unread} enabled primary purchase action(s) have no conversion count read for the window`
          : "",
        noStatus > 0
          ? `${noStatus} primary purchase action(s) have no status read (enabled, hidden or removed)`
          : "",
      ]
        .filter((t) => t !== "")
        .join(" and ")
        .concat(", so a double count cannot be ruled out"),
    };
  return { state: "clean", live: live.length };
}

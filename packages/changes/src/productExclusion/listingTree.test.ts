// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Product exclusion tree builder (ported with its tests from the PerfoAds app): mocked Google rows in, mutate ops out.
 * Covers a root-only tree, a tree already split by custom label, a Shopping
 * tree (bid copied to "everything else"), already-excluded IDs, the
 * exclude-everything refusal and the undo (restore) ops.
 */

import { describe, expect, it } from "vitest";
import {
  buildRestoreTreeOps,
  normalizeItemIds,
  parsePmaxFilterRows,
  parseShoppingCriterionRows,
  planProductExclusion,
  tempIdCounter,
  treeFingerprint,
  ProductExclusionError,
} from "./listingTree.js";

const CID = "1234567890";
const AG = "111";
const ADG = "222";
const f = (id: string) => `customers/${CID}/assetGroupListingGroupFilters/${AG}~${id}`;
const c = (id: string) => `customers/${CID}/adGroupCriteria/${ADG}~${id}`;

/** One asset_group_listing_group_filter row as REST searchStream returns it. */
function pmaxRow(id: string, type: string, parent: string | null, caseValue?: Record<string, any>) {
  return {
    assetGroupListingGroupFilter: {
      resourceName: f(id),
      assetGroup: `customers/${CID}/assetGroups/${AG}`,
      type,
      listingSource: "SHOPPING",
      ...(parent ? { parentListingGroupFilter: f(parent) } : {}),
      ...(caseValue ? { caseValue } : {}),
    },
  };
}

function shoppingRow(
  id: string,
  type: string,
  parent: string | null,
  extra: Record<string, any> = {},
  caseValue?: Record<string, any>,
) {
  return {
    adGroup: { id: ADG },
    adGroupCriterion: {
      resourceName: c(id),
      status: "ENABLED",
      negative: false,
      ...extra,
      listingGroup: {
        type,
        ...(parent ? { parentAdGroupCriterion: c(parent) } : {}),
        ...(caseValue ? { caseValue } : {}),
      },
    },
  };
}

const creates = (ops: any[]) =>
  ops
    .map((o) => (o.assetGroupListingGroupFilterOperation || o.adGroupCriterionOperation).create)
    .filter(Boolean);
const removes = (ops: any[]) =>
  ops
    .map((o) => (o.assetGroupListingGroupFilterOperation || o.adGroupCriterionOperation).remove)
    .filter(Boolean);

describe("normalizeItemIds", () => {
  it("trims, lowercases and dedupes", () => {
    expect(normalizeItemIds([" SKU-1 ", "sku-1", "Sku-2"])).toEqual(["sku-1", "sku-2"]);
  });
  it("refuses more than 200 ids", () => {
    const ids = Array.from({ length: 201 }, (_, i) => `id${i}`);
    expect(() => normalizeItemIds(ids)).toThrow(expect.objectContaining({ code: "TOO_MANY_IDS" }));
  });
  it("refuses an empty list", () => {
    expect(() => normalizeItemIds([])).toThrow(ProductExclusionError);
  });
});

describe("PMax: root-only tree", () => {
  it("replaces the root unit with a SUBDIVISION on item id + excluded units + everything else", () => {
    const trees = parsePmaxFilterRows([pmaxRow("1", "UNIT_INCLUDED", null)]);
    const plan = planProductExclusion("PMAX", CID, trees, ["sku1", "sku2"]);

    expect(removes(plan.operations)).toEqual([f("1")]);
    // Removes come before creates (one atomic request).
    expect(plan.operations[0]!.assetGroupListingGroupFilterOperation.remove).toBe(f("1"));
    const cr = creates(plan.operations);
    expect(cr[0]).toEqual({
      resourceName: f("-1"),
      assetGroup: `customers/${CID}/assetGroups/${AG}`,
      type: "SUBDIVISION",
      listingSource: "SHOPPING",
    });
    expect(cr.slice(1)).toEqual([
      {
        resourceName: f("-2"),
        assetGroup: `customers/${CID}/assetGroups/${AG}`,
        type: "UNIT_EXCLUDED",
        listingSource: "SHOPPING",
        parentListingGroupFilter: f("-1"),
        caseValue: { productItemId: { value: "sku1" } },
      },
      {
        resourceName: f("-3"),
        assetGroup: `customers/${CID}/assetGroups/${AG}`,
        type: "UNIT_EXCLUDED",
        listingSource: "SHOPPING",
        parentListingGroupFilter: f("-1"),
        caseValue: { productItemId: { value: "sku2" } },
      },
      {
        resourceName: f("-4"),
        assetGroup: `customers/${CID}/assetGroups/${AG}`,
        type: "UNIT_INCLUDED",
        listingSource: "SHOPPING",
        parentListingGroupFilter: f("-1"),
        caseValue: { productItemId: {} },
      },
    ]);
    expect(plan.excludedIds).toEqual(["sku1", "sku2"]);
    expect(plan.skippedIds).toEqual([]);
    expect(plan.groups[0]).toMatchObject({
      removedNodes: 1,
      createdNodes: 4,
      includedUnitsAfter: 1,
    });
  });
});

describe("PMax: tree already split by custom label", () => {
  const rows = [
    pmaxRow("1", "SUBDIVISION", null),
    pmaxRow("2", "UNIT_INCLUDED", "1", {
      productCustomAttribute: { index: "INDEX0", value: "best" },
    }),
    pmaxRow("3", "UNIT_EXCLUDED", "1", {
      productCustomAttribute: { index: "INDEX0", value: "clearance" },
    }),
    // "Everything else": the API can return it without a case value.
    pmaxRow("4", "UNIT_INCLUDED", "1"),
  ];

  it("subdivides every included unit, keeps its case value, leaves excluded units alone", () => {
    const plan = planProductExclusion("PMAX", CID, parsePmaxFilterRows(rows), ["sku9"]);
    expect(removes(plan.operations)).toEqual([f("2"), f("4")]);
    const subs = creates(plan.operations).filter((x) => x.type === "SUBDIVISION");
    expect(subs.map((s) => [s.parentListingGroupFilter, s.caseValue])).toEqual([
      [f("1"), { productCustomAttribute: { index: "INDEX0", value: "best" } }],
      // everything else rebuilt on the sibling's dimension + slot
      [f("1"), { productCustomAttribute: { index: "INDEX0" } }],
    ]);
    const excluded = creates(plan.operations).filter((x) => x.type === "UNIT_EXCLUDED");
    expect(excluded.map((x) => x.parentListingGroupFilter)).toEqual(
      subs.map((s) => s.resourceName),
    );
    expect(excluded.every((x) => x.caseValue.productItemId.value === "sku9")).toBe(true);
    // Node 3 (clearance, excluded) is untouched.
    expect(JSON.stringify(plan.operations)).not.toContain(f("3"));
    expect(plan.groups[0]!.includedUnitsAfter).toBe(2);
  });

  it("refuses a tree it cannot place (orphan node)", () => {
    expect(() =>
      parsePmaxFilterRows([pmaxRow("1", "SUBDIVISION", null), pmaxRow("2", "UNIT_INCLUDED", "99")]),
    ).toThrow(expect.objectContaining({ code: "TREE_UNREADABLE" }));
  });
});

describe("Shopping tree", () => {
  it("uses negative units and copies the unit bid onto everything else", () => {
    const rows = [
      shoppingRow("10", "SUBDIVISION", null),
      shoppingRow(
        "11",
        "UNIT",
        "10",
        { cpcBidMicros: "500000" },
        { productBrand: { value: "acme" } },
      ),
      shoppingRow("12", "UNIT", "10", { cpcBidMicros: "300000" }, { productBrand: {} }),
    ];
    const plan = planProductExclusion(
      "SHOPPING",
      CID,
      parseShoppingCriterionRows(rows, { [ADG]: "All" }),
      ["SKU1".toLowerCase()],
    );
    expect(removes(plan.operations)).toEqual([c("11"), c("12")]);
    const cr = creates(plan.operations);
    const sub11 = cr.find(
      (x) =>
        x.listingGroup.type === "SUBDIVISION" &&
        x.listingGroup.caseValue.productBrand.value === "acme",
    );
    expect(sub11).toMatchObject({
      adGroup: `customers/${CID}/adGroups/${ADG}`,
      status: "ENABLED",
      listingGroup: { parentAdGroupCriterion: c("10") },
    });
    expect(sub11.cpcBidMicros).toBeUndefined();
    const under11 = cr.filter((x) => x.listingGroup.parentAdGroupCriterion === sub11.resourceName);
    expect(under11).toEqual([
      expect.objectContaining({
        negative: true,
        listingGroup: expect.objectContaining({
          type: "UNIT",
          caseValue: { productItemId: { value: "sku1" } },
        }),
      }),
      expect.objectContaining({
        cpcBidMicros: "500000",
        listingGroup: expect.objectContaining({ type: "UNIT", caseValue: { productItemId: {} } }),
      }),
    ]);
    expect(under11[0].cpcBidMicros).toBeUndefined();
    const sub12 = cr.find(
      (x) =>
        x.listingGroup.type === "SUBDIVISION" &&
        x.listingGroup.caseValue.productBrand.value === undefined,
    );
    const else12 = cr.find(
      (x) => x.listingGroup.parentAdGroupCriterion === sub12.resourceName && !x.negative,
    );
    expect(else12.cpcBidMicros).toBe("300000");
    expect(plan.groups[0]!.groupName).toBe("All");
  });
});

describe("already-excluded IDs", () => {
  const rows = [
    pmaxRow("1", "SUBDIVISION", null),
    pmaxRow("2", "UNIT_EXCLUDED", "1", { productItemId: { value: "sku1" } }),
    pmaxRow("3", "UNIT_INCLUDED", "1", { productItemId: {} }),
  ];

  it("adds only the missing ids as siblings of an existing item-id split", () => {
    const plan = planProductExclusion(
      "PMAX",
      CID,
      parsePmaxFilterRows(rows),
      normalizeItemIds(["SKU1", "sku2"]),
    );
    expect(removes(plan.operations)).toEqual([]);
    expect(creates(plan.operations)).toEqual([
      expect.objectContaining({
        type: "UNIT_EXCLUDED",
        parentListingGroupFilter: f("1"),
        caseValue: { productItemId: { value: "sku2" } },
      }),
    ]);
    expect(plan.excludedIds).toEqual(["sku2"]);
    expect(plan.skippedIds).toEqual(["sku1"]);
    expect(plan.groups[0]!.alreadyExcludedIds).toEqual(["sku1"]);
  });

  it("refuses when every id is already excluded", () => {
    expect(() => planProductExclusion("PMAX", CID, parsePmaxFilterRows(rows), ["sku1"])).toThrow(
      expect.objectContaining({ code: "NOTHING_TO_CHANGE" }),
    );
  });

  it("flips an included unit for one of the ids to excluded", () => {
    const t = parsePmaxFilterRows([
      pmaxRow("1", "SUBDIVISION", null),
      pmaxRow("2", "UNIT_INCLUDED", "1", { productItemId: { value: "a" } }),
      pmaxRow("3", "UNIT_INCLUDED", "1", { productItemId: { value: "b" } }),
      pmaxRow("4", "UNIT_EXCLUDED", "1", { productItemId: {} }),
    ]);
    const plan = planProductExclusion("PMAX", CID, t, ["a"]);
    expect(removes(plan.operations)).toEqual([f("2")]);
    expect(creates(plan.operations)).toEqual([
      expect.objectContaining({
        type: "UNIT_EXCLUDED",
        parentListingGroupFilter: f("1"),
        caseValue: { productItemId: { value: "a" } },
      }),
    ]);
    expect(plan.groups[0]!.includedUnitsAfter).toBe(1);
  });
});

describe("existing item-id split higher up the path", () => {
  it("adds the exclusion at the existing split, never a second item-id split", () => {
    const t = parsePmaxFilterRows([
      pmaxRow("1", "SUBDIVISION", null),
      pmaxRow("2", "UNIT_INCLUDED", "1", { productItemId: { value: "x" } }),
      pmaxRow("3", "SUBDIVISION", "1", { productItemId: {} }),
      pmaxRow("4", "UNIT_INCLUDED", "3", {
        productCustomAttribute: { index: "INDEX0", value: "best" },
      }),
      pmaxRow("5", "UNIT_INCLUDED", "3", { productCustomAttribute: { index: "INDEX0" } }),
    ]);
    const plan = planProductExclusion("PMAX", CID, t, ["sku1"]);
    expect(removes(plan.operations)).toEqual([]);
    expect(creates(plan.operations)).toEqual([
      expect.objectContaining({
        type: "UNIT_EXCLUDED",
        parentListingGroupFilter: f("1"),
        caseValue: { productItemId: { value: "sku1" } },
      }),
    ]);
  });

  it("flips every included unit under a split-out product", () => {
    const t = parsePmaxFilterRows([
      pmaxRow("1", "SUBDIVISION", null),
      pmaxRow("2", "SUBDIVISION", "1", { productItemId: { value: "sku1" } }),
      pmaxRow("3", "UNIT_INCLUDED", "2", {
        productCustomAttribute: { index: "INDEX0", value: "best" },
      }),
      pmaxRow("4", "UNIT_INCLUDED", "2", { productCustomAttribute: { index: "INDEX0" } }),
      pmaxRow("5", "UNIT_INCLUDED", "1", { productItemId: {} }),
    ]);
    const plan = planProductExclusion("PMAX", CID, t, ["sku1"]);
    expect(removes(plan.operations)).toEqual([f("3"), f("4")]);
    const cr = creates(plan.operations);
    expect(cr).toHaveLength(2);
    expect(
      cr.every((x) => x.type === "UNIT_EXCLUDED" && x.parentListingGroupFilter === f("2")),
    ).toBe(true);
    expect(JSON.stringify(plan.operations)).not.toContain("SUBDIVISION");
  });
});

describe("allow-list tree (real shop shape: item ids INCLUDED, everything else EXCLUDED, label INDEX0 split above)", () => {
  // root -> INDEX0 subdivision (mugs) -> item-id allow-list; INDEX0/INDEX1 everything else excluded.
  const rows = [
    pmaxRow("1", "SUBDIVISION", null),
    pmaxRow("2", "SUBDIVISION", "1", {
      productCustomAttribute: { index: "INDEX0", value: "mugs" },
    }),
    pmaxRow("3", "UNIT_EXCLUDED", "1", { productCustomAttribute: { index: "INDEX0" } }),
    pmaxRow("4", "UNIT_INCLUDED", "2", {
      productItemId: { value: "shopify_us_7000000000011_8000000000011" },
    }),
    pmaxRow("5", "UNIT_INCLUDED", "2", {
      productItemId: { value: "shopify_us_7000000000012_8000000000012" },
    }),
    pmaxRow("6", "UNIT_EXCLUDED", "2", { productItemId: {} }),
  ];

  it("flips the included item node to excluded, no second item-id split, nothing else touched", () => {
    const tree = parsePmaxFilterRows(rows)[0]!;
    const plan = planProductExclusion(
      "PMAX",
      CID,
      [tree],
      normalizeItemIds(["shopify_US_7000000000012_8000000000012"]),
    );
    expect(removes(plan.operations)).toEqual([f("5")]);
    const made = creates(plan.operations);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({
      type: "UNIT_EXCLUDED",
      parentListingGroupFilter: f("2"),
      caseValue: { productItemId: { value: "shopify_us_7000000000012_8000000000012" } },
    });
    expect(made.some((m: any) => m.type === "SUBDIVISION")).toBe(false);
    expect(plan.excludedIds).toEqual(["shopify_us_7000000000012_8000000000012"]);
  });

  it("an id not on the allow-list is already not served: skipped, nothing to change", () => {
    const tree = parsePmaxFilterRows(rows)[0]!;
    expect(() => planProductExclusion("PMAX", CID, [tree], ["shopify_us_1_1"])).toThrow(
      expect.objectContaining({ code: "NOTHING_TO_CHANGE" }),
    );
  });

  it("refuses to exclude the whole allow-list", () => {
    const tree = parsePmaxFilterRows(rows)[0]!;
    expect(() =>
      planProductExclusion(
        "PMAX",
        CID,
        [tree],
        ["shopify_us_7000000000011_8000000000011", "shopify_us_7000000000012_8000000000012"],
      ),
    ).toThrow(expect.objectContaining({ code: "WOULD_EXCLUDE_EVERYTHING" }));
  });
});

describe("exclude-everything refusal", () => {
  it("ignores an untouched group that already serves nothing", () => {
    const a = parsePmaxFilterRows([pmaxRow("1", "UNIT_INCLUDED", null)])[0]!;
    const b = {
      groupId: "999",
      groupName: "Paused",
      nodes: [
        {
          resourceName: `customers/${CID}/assetGroupListingGroupFilters/999~1`,
          parent: null,
          kind: "EXCLUDED" as const,
          caseValue: null,
        },
      ],
    };
    const plan = planProductExclusion("PMAX", CID, [a, b], ["sku1"]);
    expect(plan.changedGroupIds).toEqual([AG]);
  });

  it("refuses when the tree would have no included unit left", () => {
    const t = parsePmaxFilterRows([
      pmaxRow("1", "SUBDIVISION", null),
      pmaxRow("2", "UNIT_INCLUDED", "1", { productItemId: { value: "a" } }),
      pmaxRow("3", "UNIT_EXCLUDED", "1", { productItemId: {} }),
    ]);
    expect(() => planProductExclusion("PMAX", CID, t, ["a"])).toThrow(
      expect.objectContaining({ code: "WOULD_EXCLUDE_EVERYTHING" }),
    );
  });

  it("refuses a campaign with no tree at all", () => {
    expect(() => planProductExclusion("PMAX", CID, [], ["a"])).toThrow(
      expect.objectContaining({ code: "NO_TREE" }),
    );
  });
});

describe("after-fingerprint", () => {
  it("matches the tree Google returns after the mutate (real ids, no case value on everything else)", () => {
    const plan = planProductExclusion(
      "SHOPPING",
      CID,
      parseShoppingCriterionRows([shoppingRow("10", "UNIT", null, { cpcBidMicros: "700000" })]),
      ["sku1"],
    );
    const readBack = parseShoppingCriterionRows([
      shoppingRow("30", "SUBDIVISION", null),
      shoppingRow("31", "UNIT", "30", { negative: true }, { productItemId: { value: "sku1" } }),
      shoppingRow("32", "UNIT", "30", { cpcBidMicros: "700000" }),
    ])[0]!;
    expect(treeFingerprint("SHOPPING", readBack.nodes)).toBe(plan.afterFingerprints[ADG]);
    const bidChanged = parseShoppingCriterionRows([
      shoppingRow("30", "SUBDIVISION", null),
      shoppingRow("31", "UNIT", "30", { negative: true }, { productItemId: { value: "sku1" } }),
      shoppingRow("32", "UNIT", "30", { cpcBidMicros: "900000" }),
    ])[0]!;
    expect(treeFingerprint("SHOPPING", bidChanged.nodes)).not.toBe(plan.afterFingerprints[ADG]);
    const paused = parseShoppingCriterionRows([
      shoppingRow("30", "SUBDIVISION", null),
      shoppingRow("31", "UNIT", "30", { negative: true }, { productItemId: { value: "sku1" } }),
      shoppingRow("32", "UNIT", "30", { cpcBidMicros: "700000", status: "PAUSED" }),
    ])[0]!;
    expect(treeFingerprint("SHOPPING", paused.nodes)).not.toBe(plan.afterFingerprints[ADG]);
  });
});

describe("after-fingerprint: Shopping tree (subdivisions PAUSED, units ENABLED)", () => {
  const HERO_ID = "shopify_us_7000000000009_8000000000009-demo1";
  const label = (index: string, value?: string) => ({
    productCustomAttribute: value ? { index, value } : { index },
  });
  // Before: root > classic_line (label 0) > hero (label 2) unit at $2.50; subdivisions read back PAUSED.
  const before = parseShoppingCriterionRows([
    shoppingRow("1", "SUBDIVISION", null, { status: "PAUSED" }),
    shoppingRow("2", "SUBDIVISION", "1", { status: "PAUSED" }, label("INDEX0", "classic_line")),
    shoppingRow("3", "UNIT", "1", { negative: true }, label("INDEX0")),
    shoppingRow("4", "UNIT", "2", { cpcBidMicros: "2500000" }, label("INDEX2", "hero")),
    shoppingRow("5", "UNIT", "2", { negative: true }, label("INDEX2")),
  ]);
  const plan = planProductExclusion("SHOPPING", CID, before, [HERO_ID]);
  /** hero split by item id, as Google reads it back; `over` tweaks the new nodes. */
  const liveRead = (
    over: {
      sub?: Record<string, any>;
      excl?: Record<string, any>;
      id?: string;
      rest?: Record<string, any>;
      restCase?: boolean;
    } = {},
  ) =>
    parseShoppingCriterionRows([
      shoppingRow("1", "SUBDIVISION", null, { status: "PAUSED" }),
      shoppingRow("2", "SUBDIVISION", "1", { status: "PAUSED" }, label("INDEX0", "classic_line")),
      shoppingRow("3", "UNIT", "1", { negative: true }, label("INDEX0")),
      shoppingRow("5", "UNIT", "2", { negative: true }, label("INDEX2")),
      shoppingRow("40", "SUBDIVISION", "2", { ...over.sub }, label("INDEX2", "hero")),
      shoppingRow(
        "41",
        "UNIT",
        "40",
        { negative: true, ...over.excl },
        { productItemId: { value: over.id ?? HERO_ID } },
      ),
      shoppingRow(
        "42",
        "UNIT",
        "40",
        { cpcBidMicros: "2500000", ...over.rest },
        over.restCase ? { productItemId: {} } : undefined,
      ),
    ])[0]!.nodes;

  it("the planned tree and the live read of the same tree fingerprint the same", () => {
    expect(treeFingerprint("SHOPPING", liveRead())).toBe(plan.afterFingerprints[ADG]);
    // Google reads the new subdivision back PAUSED like the others: still the same tree.
    expect(treeFingerprint("SHOPPING", liveRead({ sub: { status: "PAUSED" } }))).toBe(
      plan.afterFingerprints[ADG],
    );
    // Excluded unit status / bid, item id case, explicit empty "everything else": no serving difference.
    expect(
      treeFingerprint("SHOPPING", liveRead({ excl: { status: "PAUSED", cpcBidMicros: "10000" } })),
    ).toBe(plan.afterFingerprints[ADG]);
    expect(treeFingerprint("SHOPPING", liveRead({ id: HERO_ID.toUpperCase() }))).toBe(
      plan.afterFingerprints[ADG],
    );
    expect(treeFingerprint("SHOPPING", liveRead({ restCase: true }))).toBe(
      plan.afterFingerprints[ADG],
    );
  });

  it("a real change still does not match", () => {
    expect(treeFingerprint("SHOPPING", liveRead({ rest: { cpcBidMicros: "3000000" } }))).not.toBe(
      plan.afterFingerprints[ADG],
    );
    expect(treeFingerprint("SHOPPING", liveRead({ rest: { status: "PAUSED" } }))).not.toBe(
      plan.afterFingerprints[ADG],
    );
    expect(treeFingerprint("SHOPPING", liveRead({ excl: { negative: false } }))).not.toBe(
      plan.afterFingerprints[ADG],
    );
    expect(treeFingerprint("SHOPPING", liveRead({ id: "other-id" }))).not.toBe(
      plan.afterFingerprints[ADG],
    );
  });
});

describe("label method (one label-exclusion node per included unit)", () => {
  const label = { index: "INDEX4" as const, value: "pa_exclude" };

  it("root-only tree: splits on the label slot, not on item id", () => {
    const plan = planProductExclusion(
      "PMAX",
      CID,
      parsePmaxFilterRows([pmaxRow("1", "UNIT_INCLUDED", null)]),
      ["pa_exclude"],
      { label },
    );
    expect(creates(plan.operations).map((x) => [x.type, x.caseValue ?? null])).toEqual([
      ["SUBDIVISION", null],
      ["UNIT_EXCLUDED", { productCustomAttribute: { index: "INDEX4", value: "pa_exclude" } }],
      ["UNIT_INCLUDED", { productCustomAttribute: { index: "INDEX4" } }],
    ]);
  });

  it("a tree already split on the same slot gets one sibling, a split on another slot is subdivided", () => {
    const t = parsePmaxFilterRows([
      pmaxRow("1", "SUBDIVISION", null),
      pmaxRow("2", "UNIT_INCLUDED", "1", {
        productCustomAttribute: { index: "INDEX4", value: "sale" },
      }),
      pmaxRow("3", "SUBDIVISION", "1", { productCustomAttribute: { index: "INDEX4" } }),
      pmaxRow("4", "UNIT_INCLUDED", "3", {
        productCustomAttribute: { index: "INDEX0", value: "best" },
      }),
      pmaxRow("5", "UNIT_INCLUDED", "3", { productCustomAttribute: { index: "INDEX0" } }),
    ]);
    const plan = planProductExclusion("PMAX", CID, t, ["pa_exclude"], { label });
    // unit 2 (INDEX4 = sale) cannot carry pa_exclude: untouched. The else-branch gets ONE sibling at the INDEX4 split.
    expect(removes(plan.operations)).toEqual([]);
    expect(creates(plan.operations)).toEqual([
      expect.objectContaining({
        type: "UNIT_EXCLUDED",
        parentListingGroupFilter: f("1"),
        caseValue: { productCustomAttribute: { index: "INDEX4", value: "pa_exclude" } },
      }),
    ]);
  });

  it("refuses when the label is already excluded", () => {
    const t = parsePmaxFilterRows([
      pmaxRow("1", "SUBDIVISION", null),
      pmaxRow("2", "UNIT_EXCLUDED", "1", {
        productCustomAttribute: { index: "INDEX4", value: "pa_exclude" },
      }),
      pmaxRow("3", "UNIT_INCLUDED", "1", { productCustomAttribute: { index: "INDEX4" } }),
    ]);
    expect(() => planProductExclusion("PMAX", CID, t, ["pa_exclude"], { label })).toThrow(
      expect.objectContaining({ code: "NOTHING_TO_CHANGE" }),
    );
  });
});

describe("restore (undo) ops", () => {
  it("PMax: removes the live tree leaves-first, then re-creates the snapshot parent-first", () => {
    const snapshot = parsePmaxFilterRows([
      pmaxRow("1", "SUBDIVISION", null),
      pmaxRow("2", "UNIT_INCLUDED", "1", {
        productCustomAttribute: { index: "INDEX0", value: "best" },
      }),
      pmaxRow("3", "UNIT_INCLUDED", "1"),
    ])[0]!;
    const live = parsePmaxFilterRows([
      pmaxRow("1", "SUBDIVISION", null),
      pmaxRow("20", "SUBDIVISION", "1", {
        productCustomAttribute: { index: "INDEX0", value: "best" },
      }),
      pmaxRow("21", "UNIT_EXCLUDED", "20", { productItemId: { value: "sku1" } }),
      pmaxRow("22", "UNIT_INCLUDED", "20", { productItemId: {} }),
      pmaxRow("3", "UNIT_INCLUDED", "1"),
    ])[0]!;
    const ops = buildRestoreTreeOps("PMAX", CID, AG, live.nodes, snapshot.nodes, tempIdCounter());
    const rm = removes(ops);
    expect(rm).toHaveLength(5);
    // children before parents; the root last
    expect(rm.indexOf(f("21"))).toBeLessThan(rm.indexOf(f("20")));
    expect(rm[rm.length - 1]).toBe(f("1"));
    const cr = creates(ops);
    expect(cr).toEqual([
      {
        resourceName: f("-1"),
        assetGroup: `customers/${CID}/assetGroups/${AG}`,
        type: "SUBDIVISION",
        listingSource: "SHOPPING",
      },
      {
        resourceName: f("-2"),
        assetGroup: `customers/${CID}/assetGroups/${AG}`,
        type: "UNIT_INCLUDED",
        listingSource: "SHOPPING",
        parentListingGroupFilter: f("-1"),
        caseValue: { productCustomAttribute: { index: "INDEX0", value: "best" } },
      },
      {
        resourceName: f("-3"),
        assetGroup: `customers/${CID}/assetGroups/${AG}`,
        type: "UNIT_INCLUDED",
        listingSource: "SHOPPING",
        parentListingGroupFilter: f("-1"),
        caseValue: { productCustomAttribute: { index: "INDEX0" } },
      },
    ]);
  });

  it("Shopping: removes only the live root (Google drops the subtree) and restores bids", () => {
    const snapshot = parseShoppingCriterionRows([
      shoppingRow("10", "UNIT", null, { cpcBidMicros: "700000" }),
    ])[0]!;
    const live = parseShoppingCriterionRows([
      shoppingRow("30", "SUBDIVISION", null),
      shoppingRow("31", "UNIT", "30", { negative: true }, { productItemId: { value: "sku1" } }),
      shoppingRow("32", "UNIT", "30", { cpcBidMicros: "700000" }, { productItemId: {} }),
    ])[0]!;
    const ops = buildRestoreTreeOps(
      "SHOPPING",
      CID,
      ADG,
      live.nodes,
      snapshot.nodes,
      tempIdCounter(),
    );
    expect(removes(ops)).toEqual([c("30")]);
    expect(creates(ops)).toEqual([
      {
        resourceName: c("-1"),
        adGroup: `customers/${CID}/adGroups/${ADG}`,
        status: "ENABLED",
        listingGroup: { type: "UNIT" },
        cpcBidMicros: "700000",
      },
    ]);
  });
});

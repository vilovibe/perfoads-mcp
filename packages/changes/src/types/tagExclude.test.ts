// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// tag_exclude end to end through the change engine (propose -> approve -> apply -> read
// back -> undo) on a fake shop: Google Ads and Merchant Center both mocked, nothing live.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AdsInDoubtError } from "@perfoads/ads-client";
import { openStore, storePath, type Store } from "@perfoads/store";
import { afterEach, describe, expect, it } from "vitest";
import { createChangeEngine } from "../engine.js";
import { ChangeError } from "../errors.js";
import { must, permissiveTestPolicy } from "../testing/index.js";
import {
  CID,
  HAND_MADE,
  MID,
  OURS,
  fakeAds,
  fakeMerchant,
  flush,
  googleRefusal,
  restIdOf,
  shopSources,
  shopWorld,
  type ShopWorld,
} from "../testing/tagExcludeWorld.js";

const AGENT = { actor: "agent", via: "mcp" } as const;
const PAT = { actor: "Pat", via: "cli" } as const;

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const rig = (w: ShopWorld, o: { ownSource?: boolean } = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "perfoads-tag-exclude-"));
  const store: Store = openStore(storePath(dir));
  if (o.ownSource !== false) store.setMeta(`merchant_source:${MID}:US:en`, OURS);
  const engine = createChangeEngine({
    store,
    ads: fakeAds(w),
    merchant: fakeMerchant(w),
    policy: permissiveTestPolicy(),
    now: () => Date.parse("2026-11-03T10:00:00.000Z"),
    sleep: async () => {},
  });
  cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { engine, store };
};

const propose = (r: ReturnType<typeof rig>, input: Record<string, unknown>) =>
  r.engine.propose({ customerId: CID, type: "tag_exclude", input, ...AGENT });

const applyIt = async (r: ReturnType<typeof rig>, id: string, version: string) => {
  r.engine.markApproved(id, version, "cli", "Pat");
  return r.engine.apply(id, PAT);
};

const opsOf = (r: ReturnType<typeof rig>, id: string): Record<string, unknown>[] =>
  JSON.parse(
    (r.store.db.prepare("SELECT ops FROM changes WHERE id = ?").get(id) as { ops: string }).ops,
  ) as Record<string, unknown>[];

const shown = (w: ShopWorld, offerId: string, slot = 0): string | null | undefined => {
  const p = must(w.products.find((x) => x.offerId === offerId));
  return w.ours[restIdOf(offerId)]?.[slot] ?? p.base[slot];
};

const errOf = async (p: Promise<unknown>): Promise<ChangeError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ChangeError) return e;
    throw e;
  }
  throw new Error("no error");
};

const JACKETS = {
  merchant_id: MID,
  item_ids: ["demo_US_1_1", "demo_US_2_1"],
  campaign_ids: ["102"],
};

describe("tag_exclude: label only", () => {
  it("every product group already leaves custom_label_0 = exclude out: only the label is written, no campaign change", async () => {
    const w = shopWorld();
    const r = rig(w);
    const c = await propose(r, JACKETS);
    expect(c.status).toBe("proposed");
    const ops = opsOf(r, c.id);
    expect(ops.every((o) => "merchantSetLabel" in o)).toBe(true);
    expect(ops).toHaveLength(2);
    expect(c.diff[0]).toBe(
      `Merchant Center ${MID}: writes custom_label_0 = exclude on 2 products, in PerfoAds' own source only (your main feed and your other sources are not changed).`,
    );
    expect(c.diff[1]).toMatch(/^Campaign 102: the label alone takes them out/);
    // custom_label_0 holds other values: every running campaign was checked (the paused one is not)
    expect(c.warnings.join(" ")).toContain("each one leaves custom_label_0 = exclude out");

    const done = await applyIt(r, c.id, c.version);
    expect(done.status).toBe("verified");
    expect(w.writes.map((x) => [x.op, x.restId, x.dataSource])).toEqual([
      ["set", restIdOf("demo_US_1_1"), OURS],
      ["set", restIdOf("demo_US_2_1"), OURS],
    ]);
    expect(w.mutates).toHaveLength(0);
    expect(shown(w, "demo_US_1_1")).toBe("exclude");
    expect(shown(w, "demo_US_5_1")).toBe("bestseller");
  });

  it("Merchant Center's delay: applied (not failed) with a plain note, nothing sent again", async () => {
    const w = shopWorld({ lag: true });
    flush(w);
    const r = rig(w);
    const c = await propose(r, JACKETS);
    const done = await applyIt(r, c.id, c.version);
    expect(done.status).toBe("applied");
    expect(done.statusReason).toMatch(/passes a new label on in a few minutes to a few hours/);
    expect(w.writes).toHaveLength(2);
    // undo before Merchant Center shows it: refused plainly, not "changed again"
    const e = await errOf(r.engine.proposeUndo(c.id, PAT));
    expect(e.code).toBe("undo_unavailable");
    expect(e.message).toMatch(/has not passed the label on to 2 of these products yet/);
  });
});

describe("tag_exclude: fallback to item ids", () => {
  it("a campaign whose custom_label_0 'everything else' still serves: no label anywhere, the products go one by one", async () => {
    const w = shopWorld();
    w.trees["6502"] = must(w.trees["6502"]).map((n) =>
      n[0] === "7" ? [n[0], n[1], "UNIT_INCLUDED", n[3]] : n,
    );
    const r = rig(w);
    const c = await propose(r, JACKETS);
    const ops = opsOf(r, c.id);
    expect(ops.some((o) => "merchantSetLabel" in o)).toBe(false);
    expect(ops.every((o) => "assetGroupListingGroupFilterOperation" in o)).toBe(true);
    expect(c.diff[0]).toMatch(
      /^Campaign 102: excludes 2 products one by one in 1 product group \(every custom label is in use/,
    );
    const done = await applyIt(r, c.id, c.version);
    expect(done.status).toBe("verified");
    expect(w.writes).toHaveLength(0);
    const excluded = must(w.trees["6502"])
      .filter((n) => n[2] === "UNIT_EXCLUDED")
      .map((n) => JSON.stringify(n[3]));
    expect(excluded).toContain(JSON.stringify({ productItemId: { value: "demo_us_1_1" } }));
    expect(excluded).toContain(JSON.stringify({ productItemId: { value: "demo_us_2_1" } }));
  });

  it("a free slot with a group that still shows them: the label plus ONE label exclusion in that campaign", async () => {
    const w = shopWorld();
    for (const p of w.products) p.base[2] = null; // custom_label_2 free
    w.trees["6502"] = must(w.trees["6502"]).map((n) =>
      n[0] === "7" ? [n[0], n[1], "UNIT_INCLUDED", n[3]] : n,
    );
    const r = rig(w);
    const c = await propose(r, JACKETS);
    const ops = opsOf(r, c.id);
    expect(ops.filter((o) => "merchantSetLabel" in o)).toHaveLength(2);
    expect(c.diff[1]).toMatch(
      /^Campaign 102: adds an exclusion of custom_label_2 = exclude to 1 product group/,
    );
    const done = await applyIt(r, c.id, c.version);
    expect(done.status).toBe("verified");
    expect(
      must(w.trees["6502"]).some(
        (n) =>
          n[2] === "UNIT_EXCLUDED" &&
          JSON.stringify(n[3]) ===
            JSON.stringify({ productCustomAttribute: { index: "INDEX2", value: "exclude" } }),
      ),
    ).toBe(true);
  });

  it("a product group PerfoAds can't follow (condition split): unknown is unsafe, item ids", async () => {
    const w = shopWorld();
    w.trees["6502"] = [
      ["1", null, "SUBDIVISION"],
      ["2", "1", "UNIT_INCLUDED", { productCondition: { condition: "NEW" } }],
      ["3", "1", "UNIT_EXCLUDED", { productCondition: {} }],
    ];
    const r = rig(w);
    const c = await propose(r, JACKETS);
    expect(opsOf(r, c.id).some((o) => "merchantSetLabel" in o)).toBe(false);
    expect(c.diff[0]).toMatch(/one by one/);
  });
});

describe("tag_exclude: only PerfoAds' own source is ever written", () => {
  it("a hand-made source named PerfoAds is attached but never written: PerfoAds makes its own (empty) and excludes by item ids this time", async () => {
    const w = shopWorld({ sources: shopSources({ ours: false, handMade: true }) });
    const r = rig(w, { ownSource: false });
    const c = await propose(r, JACKETS);
    const ops = opsOf(r, c.id);
    expect(ops[0]).toMatchObject({
      merchantCreateSource: {
        merchantId: MID,
        feedLabel: "US",
        contentLanguage: "en",
        displayName: "PerfoAds connector labels",
      },
    });
    expect(ops.some((o) => "merchantSetLabel" in o)).toBe(false);
    expect(JSON.stringify(ops)).not.toContain(HAND_MADE);
    expect(c.undo.level).toBe("partial");
    const done = await applyIt(r, c.id, c.version);
    expect(done.status).toBe("verified");
    expect(w.writes).toHaveLength(0);
    expect(w.created).toHaveLength(1);
    expect(r.store.getMeta(`merchant_source:${MID}:US:en`)).toBe(
      `accounts/${MID}/dataSources/9000`,
    );
  });

  it("its own source not yet read by the main feed: said how to add it, item ids meanwhile", async () => {
    const w = shopWorld({ sources: shopSources({ attached: false }) });
    const r = rig(w);
    const c = await propose(r, JACKETS);
    expect(opsOf(r, c.id).some((o) => "merchantSetLabel" in o || "merchantCreateSource" in o)).toBe(
      false,
    );
    expect(c.diff[0]).toMatch(
      /does not read PerfoAds' label source "PerfoAds connector labels" yet/,
    );
  });
});

describe("tag_exclude: undo", () => {
  it("puts the previous label back on exactly what it wrote (takes PerfoAds' value out of its own source)", async () => {
    const w = shopWorld();
    const r = rig(w);
    const c = await propose(r, JACKETS);
    await applyIt(r, c.id, c.version);
    expect(shown(w, "demo_US_2_1")).toBe("exclude");
    const u = await r.engine.proposeUndo(c.id, PAT);
    expect(opsOf(r, u.id).map((o) => Object.keys(o)[0])).toEqual([
      "merchantClearLabel",
      "merchantClearLabel",
    ]);
    const undone = await applyIt(r, u.id, u.version);
    expect(undone.status).toBe("verified");
    expect(shown(w, "demo_US_1_1")).toBe("bestseller");
    expect(shown(w, "demo_US_2_1")).toBe("no_data");
    expect(w.writes.slice(2).every((x) => x.op === "clear" && x.dataSource === OURS)).toBe(true);
  });

  it("undo of an item-id fallback puts the product groups back as they were", async () => {
    const w = shopWorld();
    w.trees["6502"] = must(w.trees["6502"]).map((n) =>
      n[0] === "7" ? [n[0], n[1], "UNIT_INCLUDED", n[3]] : n,
    );
    const before = JSON.stringify(
      must(w.trees["6502"])
        .map((n) => [n[1] === null, n[2], n[3] ?? null])
        .sort(),
    );
    const r = rig(w);
    const c = await propose(r, JACKETS);
    await applyIt(r, c.id, c.version);
    const u = await r.engine.proposeUndo(c.id, PAT);
    const undone = await applyIt(r, u.id, u.version);
    expect(undone.status).toBe("verified");
    expect(
      JSON.stringify(
        must(w.trees["6502"])
          .map((n) => [n[1] === null, n[2], n[3] ?? null])
          .sort(),
      ),
    ).toBe(before);
  });

  it("never under another applied exclusion with the same label: refused until that one is undone", async () => {
    const w = shopWorld();
    const r = rig(w);
    const a = await propose(r, JACKETS);
    await applyIt(r, a.id, a.version);
    // B: product 2 already carries the label (A wrote it), so B writes only product 3, and keeps 2 out too
    const b = await propose(r, {
      merchant_id: MID,
      item_ids: ["demo_US_2_1", "demo_US_3_1"],
      campaign_ids: ["101"],
    });
    expect(opsOf(r, b.id)).toHaveLength(1);
    expect(b.warnings.join(" ")).toContain(
      "1 of these products already carries custom_label_0 = exclude",
    );
    await applyIt(r, b.id, b.version);
    const e = await errOf(r.engine.proposeUndo(a.id, PAT));
    expect(e.code).toBe("undo_unavailable");
    expect(e.message).toContain(`that change ${b.id} also keeps out`);
    const ub = await r.engine.proposeUndo(b.id, PAT);
    await applyIt(r, ub.id, ub.version);
    expect(shown(w, "demo_US_3_1")).toBe("seller_2026");
    expect(shown(w, "demo_US_2_1")).toBe("exclude");
    const ua = await r.engine.proposeUndo(a.id, PAT);
    expect((await applyIt(r, ua.id, ua.version)).status).toBe("verified");
    expect(shown(w, "demo_US_2_1")).toBe("no_data");
  });
});

describe("tag_exclude: labels another applied change wrote count while Merchant Center lags", () => {
  const openJackets = (w: ShopWorld) => {
    w.trees["6502"] = must(w.trees["6502"]).map((n) =>
      n[0] === "7" ? [n[0], n[1], "UNIT_INCLUDED", n[3]] : n,
    );
  };

  it("A then B on the same product before Merchant Center shows it: B does not write it again; undo B then A", async () => {
    const w = shopWorld({ lag: true });
    flush(w);
    const r = rig(w);
    const a = await propose(r, JACKETS);
    await applyIt(r, a.id, a.version);
    expect(shown(w, "demo_US_2_1")).toBe("exclude"); // written, not shown yet (lag)
    const b = await propose(r, {
      merchant_id: MID,
      item_ids: ["demo_US_2_1", "demo_US_3_1"],
      campaign_ids: ["101"],
    });
    expect(opsOf(r, b.id).map((o) => JSON.stringify(o))).toEqual([
      expect.stringContaining(restIdOf("demo_US_3_1")),
    ]);
    await applyIt(r, b.id, b.version);
    flush(w);
    expect((await errOf(r.engine.proposeUndo(a.id, PAT))).message).toContain(
      `that change ${b.id} also keeps out`,
    );
    const ub = await r.engine.proposeUndo(b.id, PAT);
    await applyIt(r, ub.id, ub.version);
    flush(w);
    const ua = await r.engine.proposeUndo(a.id, PAT);
    await applyIt(r, ua.id, ua.version);
    flush(w);
    expect(shown(w, "demo_US_2_1")).toBe("no_data");
    expect(shown(w, "demo_US_3_1")).toBe("seller_2026");
  });

  it("a label exclusion in another campaign counts A's not-yet-shown products as carriers", async () => {
    const w = shopWorld({ lag: true });
    for (const p of w.products) p.base[2] = null;
    openJackets(w);
    flush(w);
    const r = rig(w);
    const label = { slot: 2, value: "exclude" };
    const a = await propose(r, { ...JACKETS, label });
    expect(a.diff.join(" ")).toContain("adds an exclusion of custom_label_2 = exclude");
    await applyIt(r, a.id, a.version);
    const b = await propose(r, {
      merchant_id: MID,
      item_ids: ["demo_US_3_1"],
      campaign_ids: ["101"],
      label,
    });
    const ops = JSON.stringify(opsOf(r, b.id));
    expect(ops).not.toContain("merchantSetLabel");
    expect(ops).not.toContain("INDEX2");
  });
});

describe("tag_exclude: undo never removes a label exclusion another change relies on", () => {
  it("B relies on A's label node in a campaign: undo A refused until B is undone", async () => {
    const w = shopWorld();
    for (const p of w.products) p.base[2] = null;
    w.trees["6502"] = must(w.trees["6502"]).map((n) =>
      n[0] === "7" ? [n[0], n[1], "UNIT_INCLUDED", n[3]] : n,
    );
    must(w.campaigns[0]).status = "PAUSED";
    const r = rig(w);
    const label = { slot: 2, value: "exclude" };
    const a = await propose(r, { ...JACKETS, label });
    await applyIt(r, a.id, a.version);
    const b = await propose(r, {
      merchant_id: MID,
      item_ids: ["demo_US_3_1"],
      campaign_ids: ["102"],
      label,
    });
    expect(b.diff.join(" ")).toContain("Campaign 102: the label alone takes them out");
    await applyIt(r, b.id, b.version);
    const e = await errOf(r.engine.proposeUndo(a.id, PAT));
    expect(e.code).toBe("undo_unavailable");
    expect(e.message).toContain(`change ${b.id} relies on it`);
    const ub = await r.engine.proposeUndo(b.id, PAT);
    expect((await applyIt(r, ub.id, ub.version)).status).toBe("verified");
    const ua = await r.engine.proposeUndo(a.id, PAT);
    expect((await applyIt(r, ua.id, ua.version)).status).toBe("verified");
  });
});

describe("tag_exclude: a write that fails part-way is taken back", () => {
  it("Merchant Center refuses the 2nd product: the 1st is taken back, nothing stays labelled, the change failed", async () => {
    const w = shopWorld({
      failWrite: (n, op) =>
        n === 1 && op === "set" ? googleRefusal(400, "Invalid value") : undefined,
    });
    const r = rig(w);
    const c = await propose(r, JACKETS);
    const done = await applyIt(r, c.id, c.version);
    expect(done.status).toBe("failed");
    expect(done.statusReason).toBe("Google refused the change. Nothing was changed.");
    expect(w.writes.map((x) => x.op)).toEqual(["set", "clear"]);
    expect(shown(w, "demo_US_1_1")).toBe("bestseller");
    expect(shown(w, "demo_US_2_1")).toBe("no_data");
  });

  it("an unclear Merchant Center answer: that write is taken back too, never left half done", async () => {
    const w = shopWorld({
      failWrite: (n) => (n === 1 ? new AdsInDoubtError("timeout", undefined, null) : undefined),
    });
    const r = rig(w);
    const c = await propose(r, JACKETS);
    const done = await applyIt(r, c.id, c.version);
    expect(done.status).toBe("failed");
    expect(done.statusReason).toMatch(/took the label back off the products it had written/);
    expect(w.writes.map((x) => [x.op, x.restId])).toEqual([
      ["set", restIdOf("demo_US_1_1")],
      ["clear", restIdOf("demo_US_2_1")],
      ["clear", restIdOf("demo_US_1_1")],
    ]);
    expect(shown(w, "demo_US_1_1")).toBe("bestseller");
  });

  it("Google Ads refuses the product groups after the labels landed: the labels are taken back", async () => {
    const w = shopWorld({ failMutate: () => googleRefusal(400, "Bad tree") });
    for (const p of w.products) p.base[2] = null;
    w.trees["6502"] = must(w.trees["6502"]).map((n) =>
      n[0] === "7" ? [n[0], n[1], "UNIT_INCLUDED", n[3]] : n,
    );
    const r = rig(w);
    const c = await propose(r, JACKETS);
    const done = await applyIt(r, c.id, c.version);
    expect(done.status).toBe("failed");
    expect(w.writes.map((x) => x.op)).toEqual(["set", "set", "clear", "clear"]);
    expect(shown(w, "demo_US_1_1", 2)).toBeNull();
  });
});

describe("tag_exclude: Merchant Center permission", () => {
  it("not granted on this sign-in: a plain refusal that says how to turn it on, nothing read or written", async () => {
    const w = shopWorld({ scope: false });
    const r = rig(w);
    const e = await errOf(propose(r, JACKETS));
    expect(e.code).toBe("not_allowed");
    expect(e.message).toMatch(/^Merchant Center access is not turned on for this sign-in/);
    expect(e.message).toContain("auth --merchant-center");
    expect(e.message).toContain("Nothing was changed.");
    expect(w.writes).toHaveLength(0);
  });

  it("Google says the scope is missing (sign-in without it): the same plain refusal", async () => {
    const w = shopWorld({
      scope: undefined,
      failRead: () => googleRefusal(403, "Request had insufficient authentication scopes."),
    });
    const r = rig(w);
    const e = await errOf(propose(r, JACKETS));
    expect(e.code).toBe("not_allowed");
    expect(e.message).toContain("auth --merchant-center");
  });

  it("no Merchant Center connection on the server: refused", async () => {
    const w = shopWorld();
    const dir = mkdtempSync(path.join(tmpdir(), "perfoads-tag-exclude-"));
    const store = openStore(storePath(dir));
    cleanup = () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    };
    const engine = createChangeEngine({ store, ads: fakeAds(w), policy: permissiveTestPolicy() });
    const e = await errOf(
      engine.propose({ customerId: CID, type: "tag_exclude", input: JACKETS, ...AGENT }),
    );
    expect(e.code).toBe("not_allowed");
  });
});

describe("tag_exclude: input", () => {
  it("a campaign another Merchant Center feeds is refused", async () => {
    const w = shopWorld();
    must(w.campaigns[1]).merchantId = "5550002";
    const r = rig(w);
    const e = await errOf(propose(r, JACKETS));
    expect(e.message).toBe(
      `Campaign 102 does not show products from Merchant Center ${MID}. Nothing was changed.`,
    );
  });

  it("the undo shape can't be proposed directly", async () => {
    const r = rig(shopWorld());
    const e = await errOf(
      propose(r, {
        undo: {
          merchant_id: MID,
          slot: 0,
          value: "exclude",
          source: OURS,
          products: [],
          trees: [],
        },
      }),
    );
    expect(e.code).toBe("invalid_input");
  });
});

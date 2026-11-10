// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Change types 4-10 through the real engine on a fake account: input checks, what is read,
// the exact operations (temporary ids), the diff, policy facts, read-back, partial failure,
// undo, negatives safety and the per-item locks.

import { partialFailureError } from "@perfoads/ads-client/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeError } from "./errors.js";
import { getRow } from "./repo.js";
import {
  fakeWorld,
  moreWorld,
  must,
  permissiveTestPolicy,
  type FakeWorld,
} from "./testing/index.js";
import { AGENT, makeRig, type Rig } from "./testing/setup.js";
import type { PolicyDefaults } from "./types/actionType.js";

let rig: Rig | undefined;
afterEach(() => {
  rig?.close();
  rig = undefined;
});

const PAT = { actor: "Pat", via: "cli" } as const;
const C = "1234567890";

const world6 = (): FakeWorld & { more: ReturnType<typeof moreWorld> } => {
  const w = fakeWorld();
  return { ...w, customer: { ...w.customer, name: "Northwind" }, more: moreWorld() };
};

const req = (type: string, input: Record<string, unknown>) => ({
  customerId: C,
  type,
  input,
  ...AGENT,
});

const errOf = async (p: Promise<unknown>): Promise<ChangeError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ChangeError) return e;
    throw e;
  }
  throw new Error("expected a ChangeError");
};

type Body = {
  mutateOperations?: Record<string, unknown>[];
  partialFailure?: boolean;
  validateOnly?: boolean;
};
const writesSent = (r: Rig): Body[] =>
  r.calls
    .filter((c) => c.url.endsWith(":mutate") && (c.body as Body).validateOnly !== true)
    .map((c) => c.body as Body);
const lastValidate = (r: Rig): Body | undefined =>
  r.calls.filter((c) => c.url.endsWith(":mutate") && (c.body as Body).validateOnly === true).at(-1)
    ?.body as Body | undefined;

const approveApply = async (r: Rig, id: string) => {
  const v = must(r.engine.get(id));
  r.engine.markApproved(id, v.version, "cli", "Pat");
  return r.engine.apply(id, PAT);
};

const proposeApply = async (r: Rig, type: string, input: Record<string, unknown>) => {
  const c = await r.engine.propose(req(type, input));
  return approveApply(r, c.id);
};

const undo = async (r: Rig, id: string) => {
  const u = await r.engine.proposeUndo(id, PAT);
  return approveApply(r, u.id);
};

const withDefaults = (d: Partial<PolicyDefaults>) => permissiveTestPolicy({ defaults: d });

describe("add_campaign_negatives", () => {
  it("builds one create per campaign x negative, checks it with Google, shows texts apart", async () => {
    const w = world6();
    w.campaigns["334"] = { ...must(w.campaigns["333"]), id: "334", name: "Boots" };
    rig = makeRig({ world: w });
    const c = await rig.engine.propose(
      req("add_campaign_negatives", {
        campaign_ids: ["333", "334"],
        negatives: [
          { text: "  free   shipping ", match_type: "PHRASE" },
          { text: "jobs", match_type: "BROAD" },
        ],
      }),
    );
    const neg = (id: string, text: string, matchType: string) => ({
      campaignCriterionOperation: {
        create: {
          campaign: `customers/${C}/campaigns/${id}`,
          negative: true,
          keyword: { text, matchType },
        },
      },
    });
    expect(lastValidate(rig)?.mutateOperations).toEqual([
      neg("333", "free shipping", "PHRASE"),
      neg("333", "jobs", "BROAD"),
      neg("334", "free shipping", "PHRASE"),
      neg("334", "jobs", "BROAD"),
    ]);
    expect(c.diff[0]).toBe("Campaign 333: adds 2 negative keywords.");
    expect(c.diff[1]).toBe("Campaign 334: adds 2 negative keywords.");
    expect(c.diff.join(" ")).not.toContain("free shipping"); // model text only in the AI box
    expect(c.modelTexts).toEqual([
      {
        label: "Negative keywords (match type: text)",
        items: ["PHRASE: free shipping", "BROAD: jobs"],
      },
    ]);
    expect(c.facts.items).toEqual([
      { kind: "campaign_negative_keyword", created: 4, updated: 0, removed: 0 },
    ]);
    expect(c.affected.map((a) => `${a.kind}:${a.id}`)).toEqual(["campaign:333", "campaign:334"]);
    expect(c.undo).toEqual({ supported: true, why: null, level: "full" });
    expect(JSON.parse(must(getRow(rig.store, c.id)).target_keys)).toEqual([
      `${C}:campaigns/333/negatives`,
      `${C}:campaigns/334/negatives`,
    ]);
  });

  it("applies with partial failure allowed, reads back, and undo removes them", async () => {
    rig = makeRig({ world: world6() });
    const done = await proposeApply(rig, "add_campaign_negatives", {
      campaign_ids: ["333"],
      negatives: [{ text: "jobs", match_type: "BROAD" }],
    });
    expect(done.status).toBe("verified");
    expect(writesSent(rig)[0]?.partialFailure).toBe(true);
    const more = must(rig.fake.world.more);
    expect(more.campaignNegatives.map((n) => [n.text, n.status])).toEqual([["jobs", "ENABLED"]]);
    const u = await undo(rig, done.id);
    expect(u.status).toBe("verified");
    expect(writesSent(rig)[1]?.mutateOperations).toEqual([
      {
        campaignCriterionOperation: {
          remove: `customers/${C}/campaignCriteria/333~${more.campaignNegatives[0]?.criterionId}`,
        },
      },
    ]);
    expect(more.campaignNegatives[0]?.status).toBe("REMOVED");
    expect(u.undo.supported).toBe(false); // an undo is not undone again
  });

  it("skips negatives already there; all there -> nothing to change", async () => {
    const w = world6();
    w.more.campaignNegatives.push({
      campaignId: "333",
      criterionId: "1",
      text: "Jobs",
      matchType: "BROAD",
      status: "ENABLED",
    });
    rig = makeRig({ world: w });
    const e = await errOf(
      rig.engine.propose(
        req("add_campaign_negatives", {
          campaign_ids: ["333"],
          negatives: [{ text: "jobs", match_type: "BROAD" }],
        }),
      ),
    );
    expect(e.code).toBe("nothing_to_change");
    const c = await rig.engine.propose(
      req("add_campaign_negatives", {
        campaign_ids: ["333"],
        negatives: [
          { text: "jobs", match_type: "BROAD" },
          { text: "jobs", match_type: "EXACT" },
        ],
      }),
    );
    expect(c.diff[0]).toBe("Campaign 333: adds 1 negative keyword (1 already there, skipped).");
  });

  it("input checks: brackets, bad characters, too many words, duplicates, unknown keys", async () => {
    rig = makeRig({ world: world6() });
    const bad = async (negatives: unknown[], extra: Record<string, unknown> = {}) =>
      (
        await errOf(
          must(rig).engine.propose(
            req("add_campaign_negatives", { campaign_ids: ["333"], negatives, ...extra }),
          ),
        )
      ).message;
    expect(await bad([{ text: "[jobs]", match_type: "EXACT" }])).toContain(
      "set match_type instead",
    );
    expect(await bad([{ text: "jobs!", match_type: "EXACT" }])).toContain(
      "characters Google does not take",
    );
    expect(await bad([{ text: "a b c d e f g h i j k", match_type: "PHRASE" }])).toContain(
      "over 10 words",
    );
    expect(
      await bad([
        { text: "jobs", match_type: "BROAD" },
        { text: "JOBS", match_type: "BROAD" },
      ]),
    ).toContain("listed twice");
    expect(await bad([{ text: "jobs", match_type: "BROAD" }], { campaign_id: "333" })).toContain(
      "Unrecognized key",
    );
    expect(rig.fake.validations()).toBe(0);
  });
});

describe("negatives safety (through the engine)", () => {
  it("refuses a negative that would block a search with conversions; nothing stored, nothing checked with Google", async () => {
    const w = world6();
    w.more.searchTerms.push({ text: "running shoes sale", campaignId: "333", conversions: 2 });
    rig = makeRig({ world: w });
    const e = await errOf(
      rig.engine.propose(
        req("add_campaign_negatives", {
          campaign_ids: ["333"],
          negatives: [{ text: "sale", match_type: "BROAD" }],
        }),
      ),
    );
    expect(e.code).toBe("not_allowed");
    expect(e.message).toContain('"sale" (BROAD) would block the search "running shoes sale"');
    expect(e.message).toContain("override_blocked_conversions");
    expect(rig.fake.validations()).toBe(0);
    expect(rig.engine.list()).toHaveLength(0);
  });

  it("refuses a negative that would block a keyword with conversions", async () => {
    const w = world6();
    w.more.convertingKeywords.push({ text: "trail shoes", campaignId: "333", conversions: 1 });
    rig = makeRig({ world: w });
    const e = await errOf(
      rig.engine.propose(
        req("add_campaign_negatives", {
          campaign_ids: ["333"],
          negatives: [{ text: "trail", match_type: "PHRASE" }],
        }),
      ),
    );
    expect(e.message).toContain('would block the keyword "trail shoes"');
  });

  it("override: proposed, but the facts carry the count + examples and the first warning says OVERRIDE", async () => {
    const w = world6();
    w.more.pmaxTerms.push({ text: "sale shoes", campaignId: "777", conversions: 5 });
    rig = makeRig({ world: w });
    const c = await rig.engine.propose(
      req("add_campaign_negatives", {
        campaign_ids: ["333"],
        negatives: [{ text: "sale", match_type: "BROAD" }],
        override_blocked_conversions: true,
      }),
    );
    expect(c.warnings[0]).toMatch(/^OVERRIDE: 1 negative blocks searches or keywords/);
    expect(c.facts.blockedConversions).toMatchObject({
      count: 1,
      blockedTexts: 1,
      examples: [{ negative: "sale", matchType: "BROAD", kind: "search", blocks: "sale shoes" }],
    });
    expect(c.facts.blockedConversions?.setHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("override: the blocked set is compared as a set before sending (a new blocked search -> stale)", async () => {
    const w = world6();
    w.more.searchTerms.push({ text: "sale shoes", campaignId: "333", conversions: 5 });
    rig = makeRig({ world: w });
    const c = await rig.engine.propose(
      req("add_campaign_negatives", {
        campaign_ids: ["333"],
        negatives: [{ text: "sale", match_type: "BROAD" }],
        override_blocked_conversions: true,
      }),
    );
    // Same first example, one more search blocked by the same negative.
    w.more.searchTerms.push({ text: "zz sale boots", campaignId: "333", conversions: 1 });
    const v = await approveApply(rig, c.id);
    expect(v.status).toBe("stale");
    expect(rig.fake.writes()).toBe(0);
  });

  it("secondary conversions count: all_conversions > 0 with conversions 0 still blocks", async () => {
    const w = world6();
    w.more.searchTerms.push({
      text: "gift card",
      campaignId: "333",
      conversions: 0,
      allConversions: 2,
    });
    rig = makeRig({ world: w });
    const e = await errOf(
      rig.engine.propose(
        req("add_campaign_negatives", {
          campaign_ids: ["333"],
          negatives: [{ text: "gift", match_type: "BROAD" }],
        }),
      ),
    );
    expect(e.message).toContain('would block the search "gift card" (2 conversions');
    const q = rig.calls
      .map((x) => String((x.body as { query?: string }).query ?? ""))
      .find((x) => x.includes("FROM search_term_view"));
    expect(q).toContain("metrics.conversions, metrics.all_conversions");
    expect(q).toContain("metrics.all_conversions > 0");
  });

  it("brand terms are never negated, not even with the override (policy, input, or the account name)", async () => {
    const w = world6();
    rig = makeRig({ world: w, policy: withDefaults({ brandTerms: ["Contoso"] }) });
    const viaPolicy = await errOf(
      rig.engine.propose(
        req("add_campaign_negatives", {
          campaign_ids: ["333"],
          negatives: [{ text: "contoso outlet", match_type: "PHRASE" }],
          override_blocked_conversions: true,
        }),
      ),
    );
    expect(viaPolicy.message).toContain("names your brand");
    const viaInput = await errOf(
      rig.engine.propose(
        req("add_campaign_negatives", {
          campaign_ids: ["333"],
          negatives: [{ text: "fabrikam", match_type: "EXACT" }],
          brand_terms: ["Fabrikam"],
        }),
      ),
    );
    expect(viaInput.message).toContain('the brand "Fabrikam"');
    rig.close();
    // No brand terms anywhere: the account name stands in, and a warning says so.
    rig = makeRig({ world: world6() });
    const viaName = await errOf(
      rig.engine.propose(
        req("add_campaign_negatives", {
          campaign_ids: ["333"],
          negatives: [{ text: "northwind", match_type: "BROAD" }],
        }),
      ),
    );
    expect(viaName.message).toContain("names your brand");
    const ok = await rig.engine.propose(
      req("add_campaign_negatives", {
        campaign_ids: ["333"],
        negatives: [{ text: "jobs", match_type: "BROAD" }],
      }),
    );
    expect(ok.warnings).toContain(
      "No brand_terms in the policy for this account. Brand protection uses: the account name.",
    );
  });

  it("input brand_terms only ADD: to the policy terms, or to the account name when the policy sets none (Northwind probe)", async () => {
    const refused = async (r: Rig, text: string) =>
      (
        await errOf(
          r.engine.propose(
            req("add_campaign_negatives", {
              campaign_ids: ["333"],
              negatives: [{ text, match_type: "BROAD" }],
              brand_terms: ["Fabrikam"],
            }),
          ),
        )
      ).message;
    rig = makeRig({ world: world6(), policy: withDefaults({ brandTerms: ["Contoso"] }) });
    for (const text of ["contoso", "fabrikam"]) {
      expect(await refused(rig, text), text).toContain("names your brand");
    }
    rig.close();
    rig = makeRig({ world: world6() });
    for (const text of ["northwind", "fabrikam"]) {
      expect(await refused(rig, text), text).toContain("names your brand");
    }
  });

  it("policy brand_terms replace the account-name fallback (Best Shoes Direct)", async () => {
    const w = world6();
    w.customer.name = "Best Shoes Direct";
    const propose = (r: Rig, text: string) =>
      r.engine.propose(
        req("add_campaign_negatives", {
          campaign_ids: ["333"],
          negatives: [{ text, match_type: "PHRASE" }],
        }),
      );
    rig = makeRig({ world: w, policy: withDefaults({ brandTerms: ["Contoso"] }) });
    const ok = await propose(rig, "best price");
    expect(ok.status).toBe("proposed");
    expect(ok.warnings.join(" ")).not.toContain("account name");
    expect((await errOf(propose(rig, "contoso"))).message).toContain("names your brand");
    rig.close();
    rig = makeRig({ world: w });
    expect((await errOf(propose(rig, "best shoes"))).message).toContain("names your brand");
  });

  it("short brand terms (H&M, 3M, LG, QX US) match as whole words; plurals of short words too", async () => {
    rig = makeRig({
      world: world6(),
      policy: withDefaults({ brandTerms: ["H&M", "3M", "LG", "QX US"] }),
    });
    const refused = async (text: string) =>
      (
        await errOf(
          must(rig).engine.propose(
            req("add_campaign_negatives", {
              campaign_ids: ["333"],
              negatives: [{ text, match_type: "PHRASE" }],
            }),
          ),
        )
      ).message;
    // "qx" PHRASE would block the brand search "qx us" itself.
    for (const text of ["h&m jeans", "h and m", "3m tape", "lg tv", "lgs", "qx us mugs", "qx"]) {
      expect(await refused(text), text).toContain("names your brand");
    }
    // Not the brand: the short words alone or inside other words.
    const ok = await rig.engine.propose(
      req("add_campaign_negatives", {
        campaign_ids: ["333"],
        negatives: [
          { text: "ham", match_type: "PHRASE" },
          { text: "slg", match_type: "PHRASE" },
          { text: "qx", match_type: "EXACT" },
        ],
      }),
    );
    expect(ok.status).toBe("proposed");
  });

  it("a brand term with nothing to match is refused, never skipped; the account name too is reported truthfully", async () => {
    const w = world6();
    w.customer.name = "---";
    rig = makeRig({ world: w, policy: withDefaults({ brandTerms: ["&&"] }) });
    // "&" folds to the word "and": "&&" is matchable. "--" is not.
    rig.close();
    rig = makeRig({ world: w, policy: withDefaults({ brandTerms: ["--"] }) });
    const e = await errOf(
      rig.engine.propose(
        req("add_campaign_negatives", {
          campaign_ids: ["333"],
          negatives: [{ text: "jobs", match_type: "BROAD" }],
        }),
      ),
    );
    expect(e.message).toContain('brand term "--" has no letter or digit');
    rig.close();
    rig = makeRig({ world: w });
    const input = await errOf(
      rig.engine.propose(
        req("add_campaign_negatives", {
          campaign_ids: ["333"],
          negatives: [{ text: "jobs", match_type: "BROAD" }],
          brand_terms: ["!!"],
        }),
      ),
    );
    expect(input.message).toContain("a brand term needs a letter or digit");
    const c = await rig.engine.propose(
      req("add_campaign_negatives", {
        campaign_ids: ["333"],
        negatives: [{ text: "jobs", match_type: "BROAD" }],
      }),
    );
    expect(c.warnings).toContain(
      "The account name has no letter or digit to match, so it does not protect brand searches.",
    );
    expect(c.warnings).toContain(
      "No brand terms are set and the account name can't be matched, so brand searches could not be protected.",
    );
  });

  it("re-checked right before sending: a search that converts after approval stops it (stale, nothing sent)", async () => {
    const w = world6();
    rig = makeRig({ world: w });
    const c = await rig.engine.propose(
      req("add_campaign_negatives", {
        campaign_ids: ["333"],
        negatives: [{ text: "cheap", match_type: "BROAD" }],
      }),
    );
    w.more.searchTerms.push({ text: "cheap shoes", campaignId: "333", conversions: 1 });
    const v = await approveApply(rig, c.id);
    expect(v.status).toBe("stale");
    expect(rig.fake.writes()).toBe(0);
  });

  it("more converting searches than one read holds (10,000) -> refused: the check would be a sample", async () => {
    const w = world6();
    for (let i = 0; i < 10_000; i++) {
      w.more.searchTerms.push({ text: `term ${i}`, campaignId: "333", conversions: 1 });
    }
    rig = makeRig({ world: w });
    const e = await errOf(
      rig.engine.propose(
        req("add_campaign_negatives", {
          campaign_ids: ["333"],
          negatives: [{ text: "jobs", match_type: "BROAD" }],
        }),
      ),
    );
    expect(e.code).toBe("not_allowed");
    expect(e.message).toContain("More than 10,000 searches had conversions");
  });

  it("PMax search terms unreadable + the change reaches a Performance Max campaign -> refused (no warning-only path)", async () => {
    const w = world6();
    w.more.pmaxViewFails = true;
    w.campaigns["777"] = {
      ...must(w.campaigns["333"]),
      id: "777",
      name: "PMax",
      advertisingChannelType: "PERFORMANCE_MAX",
    };
    rig = makeRig({ world: w });
    const direct = await errOf(
      rig.engine.propose(
        req("add_campaign_negatives", {
          campaign_ids: ["333", "777"],
          negatives: [{ text: "jobs", match_type: "BROAD" }],
        }),
      ),
    );
    expect(direct.message).toContain("Couldn't check Performance Max searches");
    w.more.sharedSets.push({ id: "88", name: "L", type: "NEGATIVE_KEYWORDS", status: "ENABLED" });
    w.more.campaignSharedSets.push({ campaignId: "777", setId: "88", status: "ENABLED" });
    const viaList = await errOf(
      rig.engine.propose(
        req("add_shared_negatives", {
          shared_set_id: "88",
          negatives: [{ text: "jobs", match_type: "BROAD" }],
        }),
      ),
    );
    expect(viaList.message).toContain("Couldn't check Performance Max searches");
    const link = await errOf(
      rig.engine.propose(
        req("add_shared_negatives", {
          new_list_name: "N",
          negatives: [{ text: "jobs", match_type: "BROAD" }],
          link_campaign_ids: ["777"],
        }),
      ),
    );
    expect(link.message).toContain("Couldn't check Performance Max searches");
    expect(rig.fake.validations()).toBe(0);
  });

  it("the PMax search terms view is best effort only when no Performance Max campaign is reached: a warning", async () => {
    const w = world6();
    w.more.pmaxViewFails = true;
    rig = makeRig({ world: w });
    const c = await rig.engine.propose(
      req("add_campaign_negatives", {
        campaign_ids: ["333"],
        negatives: [{ text: "jobs", match_type: "BROAD" }],
      }),
    );
    expect(c.warnings).toContain(
      "Campaign-level search terms (Performance Max) couldn't be read, so they were not checked.",
    );
  });
});

describe("partial failure (independent items)", () => {
  it("add_campaign_negatives: one refused -> partially_applied -> verified on what landed; undo removes only that", async () => {
    rig = makeRig({
      world: world6(),
      hooks: {
        failOps: (i, op) =>
          JSON.stringify(op).includes('"bad words"')
            ? { type: "criterionError", value: "KEYWORD_HAS_INVALID_CHARS" }
            : undefined,
      },
    });
    const v = await proposeApply(rig, "add_campaign_negatives", {
      campaign_ids: ["333"],
      negatives: [
        { text: "jobs", match_type: "BROAD" },
        { text: "bad words", match_type: "PHRASE" },
      ],
    });
    expect(v.status).toBe("verified");
    expect(v.landed).toEqual({ ok: 1, total: 2 });
    expect(v.statusReason).toBe(
      "Partly applied: 1 of 2 items landed; Google refused the others (they were not changed).",
    );
    const row = must(getRow(rig.store, v.id));
    expect(JSON.parse(must(row.per_op_results))[1]).toMatchObject({
      ok: false,
      errors: ["criterionError: KEYWORD_HAS_INVALID_CHARS"],
    });
    delete rig.fake.hooks.failOps;
    const u = await undo(rig, v.id);
    expect(u.status).toBe("verified");
    expect(writesSent(rig).at(-1)?.mutateOperations).toHaveLength(1);
    expect(u.diff[0]).toBe("Campaign 333: removes 1 negative keyword (undo).");
  });

  it("an item Google said it refused but that reads new anyway -> verify_failed", async () => {
    rig = makeRig({
      world: world6(),
      hooks: {
        onWrite: (call, fake) => {
          const responses = fake.applyMutate(call.body as Record<string, unknown>); // both land
          responses[1] = {};
          return {
            body: {
              mutateOperationResponses: responses,
              partialFailureError: partialFailureError([
                { type: "criterionError", value: "INVALID", path: [["mutate_operations", 1]] },
              ]),
            },
          };
        },
      },
    });
    const v = await proposeApply(rig, "add_campaign_negatives", {
      campaign_ids: ["333"],
      negatives: [
        { text: "jobs", match_type: "BROAD" },
        { text: "free", match_type: "BROAD" },
      ],
    });
    expect(v.status).toBe("verify_failed");
    expect(v.statusReason).toContain("Partly applied: 1 of 2 items landed");
  });

  it("every item refused -> failed, nothing changed", async () => {
    rig = makeRig({
      world: world6(),
      hooks: { failOps: () => ({ type: "criterionError", value: "INVALID" }) },
    });
    const v = await proposeApply(rig, "add_campaign_negatives", {
      campaign_ids: ["333"],
      negatives: [{ text: "jobs", match_type: "BROAD" }],
    });
    expect(v.status).toBe("failed");
    expect(v.statusReason).toBe("Google refused every item, so nothing was changed.");
  });

  it("an unclear answer with part of it in the account -> partially_applied (read, never re-sent)", async () => {
    rig = makeRig({
      world: world6(),
      hooks: {
        onWrite: (call, fake) => {
          fake.applyMutate({ ...(call.body as Record<string, unknown>) }, new Set([1]));
          return { status: 503, body: {} };
        },
      },
    });
    const v = await proposeApply(rig, "add_keywords", {
      ad_group_id: "444",
      keywords: [
        { text: "red shoes", match_type: "EXACT" },
        { text: "blue shoes", match_type: "EXACT" },
      ],
    });
    expect(v.status).toBe("verified");
    expect(v.landed).toEqual({ ok: 1, total: 2 });
    expect(rig.fake.writes()).toBe(1);
  });

  it("an unclear send with nothing landed: after 10 minutes and no change history for the campaign -> failed", async () => {
    rig = makeRig({ world: world6(), hooks: { onWrite: () => ({ status: 503, body: {} }) } });
    const v = await proposeApply(rig, "add_campaign_negatives", {
      campaign_ids: ["333"],
      negatives: [{ text: "jobs", match_type: "BROAD" }],
    });
    expect(v.status).toBe("in_doubt");
    rig.clock.now += 11 * 60 * 1000;
    const r = await rig.engine.resolveInDoubt(v.id);
    expect(r.status).toBe("failed");
    const q = rig.calls
      .map((c) => String((c.body as { query?: string }).query ?? ""))
      .find((x) => x.includes("change_event"));
    expect(q).toContain(
      `change_event.change_resource_type = 'CAMPAIGN_CRITERION' AND change_event.campaign IN ('customers/${C}/campaigns/333')`,
    );
  });
});

describe("remove_campaign_negatives", () => {
  it("removes by text + match type; undo puts them back with the text as sent", async () => {
    const w = world6();
    w.more.campaignNegatives.push({
      campaignId: "333",
      criterionId: "71",
      text: "free",
      matchType: "PHRASE",
      status: "ENABLED",
    });
    rig = makeRig({ world: w });
    const v = await proposeApply(rig, "remove_campaign_negatives", {
      campaign_id: "333",
      negatives: [{ text: "Free", match_type: "PHRASE" }],
    });
    expect(v.status).toBe("verified");
    expect(writesSent(rig)[0]).toEqual({
      mutateOperations: [
        { campaignCriterionOperation: { remove: `customers/${C}/campaignCriteria/333~71` } },
      ],
      responseContentType: "MUTABLE_RESOURCE",
    });
    const u = await undo(rig, v.id);
    expect(u.status).toBe("verified");
    expect(writesSent(rig)[1]?.mutateOperations?.[0]).toMatchObject({
      campaignCriterionOperation: { create: { keyword: { text: "Free", matchType: "PHRASE" } } },
    });
  });

  it("nothing to remove -> nothing to change", async () => {
    rig = makeRig({ world: world6() });
    const e = await errOf(
      rig.engine.propose(
        req("remove_campaign_negatives", {
          campaign_id: "333",
          negatives: [{ text: "x", match_type: "EXACT" }],
        }),
      ),
    );
    expect(e.code).toBe("nothing_to_change");
  });
});

describe("add_shared_negatives", () => {
  it("a new list + words + a campaign link: ONE atomic Mutate with temporary id -1", async () => {
    rig = makeRig({ world: world6() });
    const c = await rig.engine.propose(
      req("add_shared_negatives", {
        new_list_name: "Never sells",
        negatives: [{ text: "jobs", match_type: "BROAD" }],
        link_campaign_ids: ["333"],
      }),
    );
    const set = `customers/${C}/sharedSets/-1`;
    expect(lastValidate(rig)?.mutateOperations).toEqual([
      {
        sharedSetOperation: {
          create: { resourceName: set, name: "Never sells", type: "NEGATIVE_KEYWORDS" },
        },
      },
      {
        sharedCriterionOperation: {
          create: { sharedSet: set, keyword: { text: "jobs", matchType: "BROAD" } },
        },
      },
      {
        campaignSharedSetOperation: {
          create: { campaign: `customers/${C}/campaigns/333`, sharedSet: set },
        },
      },
    ]);
    expect(c.modelTexts[0]).toEqual({ label: "New list name", items: ["Never sells"] });
    const v = await approveApply(rig, c.id);
    expect(v.status).toBe("verified");
    expect(writesSent(rig)[0]?.partialFailure).toBeUndefined();
    const u = await undo(rig, v.id);
    expect(u.status).toBe("verified");
    // Google refuses removing a list a campaign uses (seen live): the link goes first.
    const setId = must(rig.fake.world.more).sharedSets[0]?.id;
    expect(writesSent(rig)[1]?.mutateOperations).toEqual([
      { campaignSharedSetOperation: { remove: `customers/${C}/campaignSharedSets/333~${setId}` } },
      { sharedSetOperation: { remove: `customers/${C}/sharedSets/${setId}` } },
    ]);
  });

  it("an existing list: every campaign it is on is listed; a new link also checks the words already in it", async () => {
    const w = world6();
    w.campaigns["334"] = { ...must(w.campaigns["333"]), id: "334", name: "Boots" };
    w.more.sharedSets.push({
      id: "88",
      name: "Old list",
      type: "NEGATIVE_KEYWORDS",
      status: "ENABLED",
    });
    w.more.sharedCriteria.push({
      setId: "88",
      criterionId: "1",
      text: "boots",
      matchType: "BROAD",
    });
    w.more.campaignSharedSets.push({ campaignId: "333", setId: "88", status: "ENABLED" });
    w.more.searchTerms.push({ text: "winter boots", campaignId: "334", conversions: 4 });
    rig = makeRig({ world: w });
    const add = await rig.engine.propose(
      req("add_shared_negatives", {
        shared_set_id: "88",
        negatives: [{ text: "jobs", match_type: "BROAD" }],
      }),
    );
    expect(add.affected.map((a) => `${a.kind}:${a.id}`)).toEqual(["shared_set:88", "campaign:333"]);
    expect(add.diff).toContain(
      "The list is on 1 campaign: every one of them gets the new negatives.",
    );
    const link = await errOf(
      rig.engine.propose(
        req("add_shared_negatives", { shared_set_id: "88", link_campaign_ids: ["334"] }),
      ),
    );
    expect(link.message).toContain('"boots" (BROAD) would block the search "winter boots"');
  });

  it("refuses a new list whose name exists; undo of a list changed since is stale", async () => {
    const w = world6();
    w.more.sharedSets.push({
      id: "88",
      name: "Taken",
      type: "NEGATIVE_KEYWORDS",
      status: "ENABLED",
    });
    rig = makeRig({ world: w });
    const e = await errOf(
      rig.engine.propose(
        req("add_shared_negatives", {
          new_list_name: "Taken",
          negatives: [{ text: "jobs", match_type: "BROAD" }],
        }),
      ),
    );
    expect(e.message).toContain("already exists");
    const v = await proposeApply(rig, "add_shared_negatives", {
      new_list_name: "Fresh",
      negatives: [{ text: "jobs", match_type: "BROAD" }],
    });
    const id = must(w.more.sharedSets.find((s) => s.name === "Fresh")).id;
    w.more.sharedCriteria.push({
      setId: id,
      criterionId: "5",
      text: "added by hand",
      matchType: "PHRASE",
    });
    const u = await errOf(rig.engine.proposeUndo(v.id, PAT));
    expect(u.code).toBe("undo_stale");
  });
});

describe("add_keywords", () => {
  it("new keywords are PAUSED by default (policy defaults), with server counts and the texts apart", async () => {
    rig = makeRig({ world: world6() });
    const c = await rig.engine.propose(
      req("add_keywords", {
        ad_group_id: "444",
        keywords: [
          { text: "red shoes", match_type: "EXACT", cpc_bid: "0.456" },
          { text: "blue shoes", match_type: "PHRASE" },
        ],
      }),
    );
    expect(lastValidate(rig)?.mutateOperations?.[0]).toEqual({
      adGroupCriterionOperation: {
        create: {
          adGroup: `customers/${C}/adGroups/444`,
          status: "PAUSED",
          keyword: { text: "red shoes", matchType: "EXACT" },
          cpcBidMicros: "460000",
        },
      },
    });
    expect(c.diff[0]).toBe("Ad group 444 (campaign 333): adds 2 keywords (1 EXACT, 1 PHRASE).");
    expect(c.diff[1]).toContain("created PAUSED");
    expect(c.facts.createdEnabled).toBe(0);
    expect(c.warnings).toContain(
      "This campaign uses smart bidding: Google ignores keyword max CPC bids there.",
    );
    const v = await approveApply(rig, c.id);
    expect(v.status).toBe("verified");
    expect(writesSent(rig)[0]?.partialFailure).toBe(true);
    const u = await undo(rig, v.id);
    expect(u.status).toBe("verified");
    expect(must(rig.fake.world.more).keywords.every((k) => k.status === "REMOVED")).toBe(true);
  });

  it("created ENABLED only when the policy says new_entities_paused: false (facts count them)", async () => {
    rig = makeRig({ world: world6(), policy: withDefaults({ newEntitiesPaused: false }) });
    const c = await rig.engine.propose(
      req("add_keywords", {
        ad_group_id: "444",
        keywords: [{ text: "red shoes", match_type: "EXACT" }],
      }),
    );
    expect(c.facts.createdEnabled).toBe(1);
    expect(c.diff[1]).toContain("created ENABLED");
  });

  it("BROAD is refused without smart bidding (policy default), allowed when the policy turns it off", async () => {
    const w = world6();
    const camp = must(w.campaigns["333"]);
    camp.biddingStrategyType = "MANUAL_CPC";
    rig = makeRig({ world: w });
    const e = await errOf(
      rig.engine.propose(
        req("add_keywords", {
          ad_group_id: "444",
          keywords: [{ text: "shoes", match_type: "BROAD" }],
        }),
      ),
    );
    expect(e.code).toBe("not_allowed");
    expect(e.message).toContain("defaults.broad_match_requires_smart_bidding");
    rig.close();
    rig = makeRig({ world: w, policy: withDefaults({ broadMatchRequiresSmartBidding: false }) });
    const c = await rig.engine.propose(
      req("add_keywords", {
        ad_group_id: "444",
        keywords: [{ text: "shoes", match_type: "BROAD" }],
      }),
    );
    expect(c.facts.broadWithoutSmartBidding).toBe(1);
  });

  it("partial failure: per-op results stored, undo removes only the keyword that landed", async () => {
    rig = makeRig({
      world: world6(),
      hooks: {
        failOps: (_i, op) =>
          JSON.stringify(op).includes("blue")
            ? { type: "criterionError", value: "KEYWORD_TEXT_TOO_LONG" }
            : undefined,
      },
    });
    const v = await proposeApply(rig, "add_keywords", {
      ad_group_id: "444",
      keywords: [
        { text: "red shoes", match_type: "EXACT" },
        { text: "blue shoes", match_type: "EXACT" },
      ],
    });
    expect(v.status).toBe("verified");
    expect(v.landed).toEqual({ ok: 1, total: 2 });
    const u = await rig.engine.proposeUndo(v.id, PAT);
    expect(u.payload).toEqual({
      ad_group_id: "444",
      undo_remove: [{ text: "red shoes", match_type: "EXACT" }],
    });
  });

  it("refuses non-Search campaigns and unknown ad groups", async () => {
    const w = world6();
    must(w.campaigns["333"]).advertisingChannelType = "DISPLAY";
    rig = makeRig({ world: w });
    expect(
      (
        await errOf(
          rig.engine.propose(
            req("add_keywords", {
              ad_group_id: "444",
              keywords: [{ text: "x", match_type: "EXACT" }],
            }),
          ),
        )
      ).code,
    ).toBe("not_allowed");
    expect(
      (
        await errOf(
          rig.engine.propose(
            req("add_keywords", {
              ad_group_id: "999",
              keywords: [{ text: "x", match_type: "EXACT" }],
            }),
          ),
        )
      ).code,
    ).toBe("not_found");
  });
});

describe("pause_keyword", () => {
  it("pauses, reads back, and undo enables again", async () => {
    const w = world6();
    w.more.keywords.push({
      adGroupId: "444",
      criterionId: "31",
      text: "red shoes",
      matchType: "EXACT",
      status: "ENABLED",
    });
    rig = makeRig({ world: w });
    const v = await proposeApply(rig, "pause_keyword", {
      keywords: [{ ad_group_id: "444", criterion_id: "31" }],
    });
    expect(v.status).toBe("verified");
    expect(writesSent(rig)[0]?.mutateOperations).toEqual([
      {
        adGroupCriterionOperation: {
          update: { resourceName: `customers/${C}/adGroupCriteria/444~31`, status: "PAUSED" },
          updateMask: "status",
        },
      },
    ]);
    const u = await undo(rig, v.id);
    expect(u.status).toBe("verified");
    expect(w.more.keywords[0]?.status).toBe("ENABLED");
  });
});

describe("update_rsa_text", () => {
  const texts = {
    ad_group_id: "444",
    ad_id: "555",
    headlines: [
      { text: "Red shoes", pin: 1 },
      { text: "Fast delivery" },
      { text: "Free returns" },
      { text: "Since 1990" },
    ],
    descriptions: [{ text: "Shop red shoes online." }, { text: "Sizes 35-48." }],
    path1: "red",
  };

  it("Google's limits: 30/90/15 (wide characters count 2), 3-15 headlines, 2-4 descriptions, pins, emoji, duplicates", async () => {
    rig = makeRig({ world: world6() });
    const bad = async (over: Record<string, unknown>) =>
      (await errOf(must(rig).engine.propose(req("update_rsa_text", { ...texts, ...over }))))
        .message;
    expect(
      await bad({ headlines: [{ text: "x".repeat(31) }, { text: "b" }, { text: "c" }] }),
    ).toContain("at most 30");
    const wide = String.fromCodePoint(...Array.from({ length: 16 }, () => 0x9774));
    expect(await bad({ headlines: [{ text: wide }, { text: "b" }, { text: "c" }] })).toContain(
      "is 32 characters; at most 30",
    );
    expect(await bad({ headlines: [{ text: "a" }, { text: "b" }] })).toContain("headlines");
    expect(await bad({ descriptions: [{ text: "d".repeat(91) }, { text: "e" }] })).toContain(
      "at most 90",
    );
    expect(await bad({ path1: "p".repeat(16) })).toContain("at most 15");
    expect(
      await bad({ headlines: [{ text: "a", pin: 4 }, { text: "b" }, { text: "c" }] }),
    ).toContain("headlines.0.pin");
    expect(
      await bad({
        headlines: [
          { text: "a", pin: 1 },
          { text: "b", pin: 1 },
          { text: "c", pin: 1 },
        ],
      }),
    ).toContain("pins leave");
    expect(
      await bad({
        headlines: [
          { text: "Shoes " + String.fromCodePoint(0x1f45f) },
          { text: "b" },
          { text: "c" },
        ],
      }),
    ).toContain("emoji");
    expect(await bad({ headlines: [{ text: "Same" }, { text: "same" }, { text: "c" }] })).toContain(
      "the same text twice",
    );
    expect(await bad({ path1: "", path2: "x" })).toContain("path2 needs a path1");
    expect(rig.fake.validations()).toBe(0);
  });

  it("one ad update with a field mask; read-back passes while Google re-reviews (under review); undo restores texts + pins", async () => {
    const w = world6();
    rig = makeRig({ world: w });
    const c = await rig.engine.propose(req("update_rsa_text", texts));
    expect(lastValidate(rig)?.mutateOperations).toEqual([
      {
        adOperation: {
          update: {
            resourceName: `customers/${C}/ads/555`,
            responsiveSearchAd: {
              headlines: [
                { text: "Red shoes", pinnedField: "HEADLINE_1" },
                { text: "Fast delivery" },
                { text: "Free returns" },
                { text: "Since 1990" },
              ],
              descriptions: [{ text: "Shop red shoes online." }, { text: "Sizes 35-48." }],
              path1: "red",
            },
          },
          updateMask:
            "responsive_search_ad.headlines,responsive_search_ad.descriptions,responsive_search_ad.path1",
        },
      },
    ]);
    expect(c.diff[1]).toContain("Headlines 3 -> 4, descriptions 2 -> 2, paths set");
    expect(c.modelTexts[0]).toEqual({
      label: "Headlines (in order)",
      items: ["Red shoes", "Fast delivery", "Free returns", "Since 1990"],
    });
    const v = await approveApply(rig, c.id);
    expect(must(w.more.ads[0]).reviewStatus).toBe("REVIEW_IN_PROGRESS");
    expect(v.status).toBe("verified");
    const u = await undo(rig, v.id);
    expect(u.status).toBe("verified");
    expect(w.more.ads[0]?.headlines).toEqual([
      { text: "Shoes", pinnedField: "HEADLINE_1" },
      { text: "Fast delivery" },
      { text: "Free returns" },
    ]);
    expect(w.more.ads[0]?.path1).toBe("shoes");
  });

  it("refuses ads that are not responsive search ads", async () => {
    const w = world6();
    must(w.more.ads[0]).type = "EXPANDED_TEXT_AD";
    rig = makeRig({ world: w });
    expect((await errOf(rig.engine.propose(req("update_rsa_text", texts)))).code).toBe(
      "not_allowed",
    );
  });
});

describe("add_sitelinks / add_callouts", () => {
  it("assets + links in ONE atomic Mutate with temporary ids; undo unlinks only (declared partial)", async () => {
    const w = world6();
    // A sitelink that was there before: undo must leave it alone.
    w.more.assets.push({
      id: "70",
      sitelink: { linkText: "Old" },
      finalUrls: ["https://e.com/old"],
    });
    w.more.campaignAssets.push({
      campaignId: "333",
      assetId: "70",
      fieldType: "SITELINK",
      status: "ENABLED",
    });
    rig = makeRig({ world: w });
    const c = await rig.engine.propose(
      req("add_sitelinks", {
        campaign_id: "333",
        sitelinks: [
          { link_text: "Sale", final_url: "https://example.com/sale" },
          {
            link_text: "Boots",
            description1: "Warm boots",
            description2: "For winter",
            final_url: "https://example.com/boots",
          },
        ],
      }),
    );
    const a1 = `customers/${C}/assets/-1`;
    const a2 = `customers/${C}/assets/-2`;
    expect(lastValidate(rig)?.mutateOperations).toEqual([
      {
        assetOperation: {
          create: {
            resourceName: a1,
            finalUrls: ["https://example.com/sale"],
            sitelinkAsset: { linkText: "Sale" },
          },
        },
      },
      {
        campaignAssetOperation: {
          create: { campaign: `customers/${C}/campaigns/333`, asset: a1, fieldType: "SITELINK" },
        },
      },
      {
        assetOperation: {
          create: {
            resourceName: a2,
            finalUrls: ["https://example.com/boots"],
            sitelinkAsset: {
              linkText: "Boots",
              description1: "Warm boots",
              description2: "For winter",
            },
          },
        },
      },
      {
        campaignAssetOperation: {
          create: { campaign: `customers/${C}/campaigns/333`, asset: a2, fieldType: "SITELINK" },
        },
      },
    ]);
    expect(c.undo).toEqual({
      supported: true,
      level: "partial",
      why: "Undo takes the new links off the campaign; the assets themselves stay in the account's asset library (Google does not delete assets).",
    });
    const v = await approveApply(rig, c.id);
    expect(v.status).toBe("verified");
    const u = await undo(rig, v.id);
    expect(u.status).toBe("verified");
    // Unlinked by the resource names in Google's reply, not by text.
    const names = w.more.campaignAssets
      .filter((l) => l.assetId !== "70")
      .map((l) => `customers/${C}/campaignAssets/333~${l.assetId}~SITELINK`);
    expect(u.payload).toEqual({ campaign_id: "333", undo_unlink: names });
    expect(writesSent(rig).at(-1)?.mutateOperations).toEqual(
      names.map((n) => ({ campaignAssetOperation: { remove: n } })),
    );
    expect(w.more.campaignAssets.map((l) => l.status)).toEqual(["ENABLED", "REMOVED", "REMOVED"]);
    expect(w.more.assets).toHaveLength(3); // still in the library
  });

  it("undo refused when another link with the same text was added since (read-back would be ambiguous)", async () => {
    const w = world6();
    rig = makeRig({ world: w });
    const v = await proposeApply(rig, "add_sitelinks", {
      campaign_id: "333",
      sitelinks: [{ link_text: "Sale", final_url: "https://e.com/sale" }],
    });
    expect(v.status).toBe("verified");
    w.more.assets.push({
      id: "71",
      sitelink: { linkText: "sale" },
      finalUrls: ["https://e.com/x"],
    });
    w.more.campaignAssets.push({
      campaignId: "333",
      assetId: "71",
      fieldType: "SITELINK",
      status: "ENABLED",
    });
    const e = await errOf(rig.engine.proposeUndo(v.id, PAT));
    expect(e.code).toBe("undo_stale");
    expect(e.message).toContain("Another link with the same text");
    expect(w.more.campaignAssets.every((l) => l.status === "ENABLED")).toBe(true);
  });

  it("already there = same text AND URL (+ descriptions); same text, other URL -> refused", async () => {
    const w = world6();
    w.more.assets.push({
      id: "70",
      sitelink: { linkText: "Sale" },
      finalUrls: ["https://e.com/sale"],
    });
    w.more.campaignAssets.push({
      campaignId: "333",
      assetId: "70",
      fieldType: "SITELINK",
      status: "ENABLED",
    });
    rig = makeRig({ world: w });
    const same = await errOf(
      rig.engine.propose(
        req("add_sitelinks", {
          campaign_id: "333",
          sitelinks: [{ link_text: "Sale", final_url: "https://e.com/sale" }],
        }),
      ),
    );
    expect(same.code).toBe("nothing_to_change");
    const other = await errOf(
      rig.engine.propose(
        req("add_sitelinks", {
          campaign_id: "333",
          sitelinks: [{ link_text: "Sale", final_url: "https://e.com/other" }],
        }),
      ),
    );
    expect(other.code).toBe("not_allowed");
    expect(other.message).toContain(
      'A sitelink with the text "Sale" already exists on campaign 333 with a different URL',
    );
    const desc = await errOf(
      rig.engine.propose(
        req("add_sitelinks", {
          campaign_id: "333",
          sitelinks: [
            {
              link_text: "Sale",
              description1: "a",
              description2: "b",
              final_url: "https://e.com/sale",
            },
          ],
        }),
      ),
    );
    expect(desc.code).toBe("not_allowed");
  });

  it("read-back checks the URL too; undo is refused when Google's reply (link names) was not recorded", async () => {
    const w = world6();
    rig = makeRig({
      world: w,
      hooks: {
        onWrite: (call, fake) => {
          fake.applyMutate(call.body as Record<string, unknown>);
          return { status: 503, body: {} };
        },
      },
    });
    const v = await proposeApply(rig, "add_sitelinks", {
      campaign_id: "333",
      sitelinks: [{ link_text: "Sale", final_url: "https://e.com/sale" }],
    });
    expect(v.status).toBe("verified"); // settled by reading: landed
    expect((await errOf(rig.engine.proposeUndo(v.id, PAT))).code).toBe("undo_unavailable");
    rig.close();
    const w2 = world6();
    rig = makeRig({
      world: w2,
      hooks: {
        onWrite: (call, fake) => {
          const r = fake.applyMutate(call.body as Record<string, unknown>);
          const a = w2.more.assets.at(-1);
          if (a) a.finalUrls = ["https://e.com/wrong"];
          return { body: { mutateOperationResponses: r } };
        },
      },
    });
    const bad = await proposeApply(rig, "add_sitelinks", {
      campaign_id: "333",
      sitelinks: [{ link_text: "Sale", final_url: "https://e.com/sale" }],
    });
    expect(bad.status).toBe("verify_failed");
  });

  it("refuses bad URLs, long texts, half descriptions and going past 20", async () => {
    const w = world6();
    for (let i = 0; i < 20; i++) {
      w.more.assets.push({ id: String(100 + i), callout: { calloutText: `C${i}` } });
      w.more.campaignAssets.push({
        campaignId: "333",
        assetId: String(100 + i),
        fieldType: "CALLOUT",
        status: "ENABLED",
      });
    }
    rig = makeRig({ world: w });
    const msg = async (type: string, input: Record<string, unknown>) =>
      (await errOf(must(rig).engine.propose(req(type, { campaign_id: "333", ...input })))).message;
    expect(
      await msg("add_sitelinks", {
        sitelinks: [{ link_text: "x", final_url: "javascript:alert(1)" }],
      }),
    ).toContain("https://");
    expect(
      await msg("add_sitelinks", {
        sitelinks: [{ link_text: "x".repeat(26), final_url: "https://e.com" }],
      }),
    ).toContain("at most 25");
    expect(
      await msg("add_sitelinks", {
        sitelinks: [{ link_text: "x", description1: "d", final_url: "https://e.com" }],
      }),
    ).toContain("both descriptions");
    expect(await msg("add_callouts", { callouts: [{ text: "New one" }] })).toContain("limit of 20");
  });

  it("callouts: verified, undo unlinks", async () => {
    rig = makeRig({ world: world6() });
    const v = await proposeApply(rig, "add_callouts", {
      campaign_id: "333",
      callouts: [{ text: "Free returns" }],
    });
    expect(v.status).toBe("verified");
    expect(v.modelTexts).toEqual([{ label: "Callouts", items: ["Free returns"] }]);
    expect((await undo(rig, v.id)).status).toBe("verified");
  });
});

describe("add_audience_exclusions", () => {
  it("excludes a user list (negative campaign criterion); undo removes it", async () => {
    const w = world6();
    rig = makeRig({ world: w });
    const c = await rig.engine.propose(
      req("add_audience_exclusions", { campaign_id: "333", user_list_ids: ["666"] }),
    );
    expect(lastValidate(rig)?.mutateOperations).toEqual([
      {
        campaignCriterionOperation: {
          create: {
            campaign: `customers/${C}/campaigns/333`,
            negative: true,
            userList: { userList: `customers/${C}/userLists/666` },
          },
        },
      },
    ]);
    expect(c.affected.map((a) => `${a.kind}:${a.id}`)).toEqual(["campaign:333", "user_list:666"]);
    const v = await approveApply(rig, c.id);
    expect(v.status).toBe("verified");
    expect((await undo(rig, v.id)).status).toBe("verified");
    expect(w.more.exclusions[0]?.status).toBe("REMOVED");
  });

  it("unknown lists are refused", async () => {
    rig = makeRig({ world: world6() });
    expect(
      (
        await errOf(
          rig.engine.propose(
            req("add_audience_exclusions", { campaign_id: "333", user_list_ids: ["7"] }),
          ),
        )
      ).code,
    ).toBe("not_found");
  });
});

describe("per-item locks (target keys)", () => {
  it("an unclear negatives change on campaign 333 blocks another on 333 for 10 minutes, not one on 334", async () => {
    const w = world6();
    w.campaigns["334"] = { ...must(w.campaigns["333"]), id: "334", name: "Boots" };
    rig = makeRig({ world: w, hooks: { onWrite: () => ({ status: 503, body: {} }) } });
    const first = await proposeApply(rig, "add_campaign_negatives", {
      campaign_ids: ["333"],
      negatives: [{ text: "jobs", match_type: "BROAD" }],
    });
    expect(first.status).toBe("in_doubt");
    delete rig.fake.hooks.onWrite;
    const same = await rig.engine.propose(
      req("add_campaign_negatives", {
        campaign_ids: ["333"],
        negatives: [{ text: "free", match_type: "BROAD" }],
      }),
    );
    rig.engine.markApproved(same.id, same.version, "cli", "Pat");
    const busy = await errOf(rig.engine.apply(same.id, PAT));
    expect(busy.code).toBe("item_busy");
    const other = await proposeApply(rig, "add_campaign_negatives", {
      campaign_ids: ["334"],
      negatives: [{ text: "free", match_type: "BROAD" }],
    });
    expect(other.status).toBe("verified");
    // A keyword change on the same campaign is a different item: not blocked.
    const kw = await proposeApply(rig, "add_keywords", {
      ad_group_id: "444",
      keywords: [{ text: "red shoes", match_type: "EXACT" }],
    });
    expect(kw.status).toBe("verified");
  });

  it("keys per type", async () => {
    const w = world6();
    w.more.keywords.push({
      adGroupId: "444",
      criterionId: "31",
      text: "x",
      matchType: "EXACT",
      status: "ENABLED",
    });
    rig = makeRig({ world: w });
    const keys = async (type: string, input: Record<string, unknown>) =>
      JSON.parse(
        must(getRow(must(rig).store, (await must(rig).engine.propose(req(type, input))).id))
          .target_keys,
      ) as string[];
    expect(
      await keys("add_keywords", {
        ad_group_id: "444",
        keywords: [{ text: "y", match_type: "EXACT" }],
      }),
    ).toEqual([`${C}:adGroups/444/keywords`]);
    expect(
      await keys("pause_keyword", { keywords: [{ ad_group_id: "444", criterion_id: "31" }] }),
    ).toEqual([`${C}:adGroupCriteria/444~31`]);
    expect(await keys("update_rsa_text", { ad_group_id: "444", ad_id: "555", path1: "x" })).toEqual(
      [`${C}:ads/555`],
    );
    expect(await keys("add_callouts", { campaign_id: "333", callouts: [{ text: "Hi" }] })).toEqual([
      `${C}:campaigns/333/assets/CALLOUT`,
    ]);
    expect(
      await keys("add_audience_exclusions", { campaign_id: "333", user_list_ids: ["666"] }),
    ).toEqual([`${C}:campaigns/333/audienceExclusions`]);
    expect(
      await keys("add_shared_negatives", {
        new_list_name: "L",
        negatives: [{ text: "jobs", match_type: "BROAD" }],
        link_campaign_ids: ["333"],
      }),
    ).toEqual([`${C}:campaigns/333/sharedSets`, `${C}:sharedSets/new:L`]);
  });
});

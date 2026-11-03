// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Change types 4-10 through the MCP server: every type's params schema is served as a
// resource (not in tools/list), the policy file's defaults and brand terms reach the types,
// and the approval page shows the AI's texts exactly as sent, the OVERRIDE banner and what
// undo can do. Fake Google account, fake ids only.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { V1_ACTION_TYPES, type ChangeView } from "@perfoads/changes";
import { fakeWorld, moreWorld } from "@perfoads/changes/testing";
import { afterEach, describe, expect, it } from "vitest";
import { approvalPageHtml, approvalSummaryText } from "./approvals/view.js";
import { openSessionFor } from "./approvals/sessions.js";
import { ACCOUNT, changeRig, readPage, textOf, type ChangeRig } from "./testing/changeRig.js";

const rigs: ChangeRig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});

const world6 = () => ({ ...fakeWorld(), more: moreWorld() });

/** The server reads policy.yaml from its settings folder (no injected policy). */
const rig = () => {
  const r = changeRig({ policy: null, world: world6() });
  rigs.push(r);
  return r;
};

const POLICY = (extra = "") => `version: 1
accounts: { allow: ["${ACCOUNT}"], write: ["${ACCOUNT}"] }
limits: { max_new_daily_spend: { "${ACCOUNT}": 100 } }
brand_terms: { "${ACCOUNT}": ["Contoso"] }
${extra}`;

const writePolicy = (r: ChangeRig, text: string): void => {
  mkdirSync(r.rt.configDir.dir, { recursive: true });
  writeFileSync(path.join(r.rt.configDir.dir, "policy.yaml"), text);
};

type Structured = {
  change?: { changeId: string; status: string; undo?: { level: string }; warnings?: string[] };
};
const sc = (res: { structuredContent?: unknown }) => (res.structuredContent ?? {}) as Structured;

describe("served schemas and the tool list", () => {
  it("every v1 type (1-10 + create_campaign + tag_exclude, 14 names) has a JSON Schema at schema://changes/{type}; propose_change lists them", async () => {
    const r = rig();
    const { client } = await r.connect();
    const names = V1_ACTION_TYPES.map((t) => t.type);
    expect(names).toEqual([
      "update_budget",
      "update_campaign_status",
      "update_bidding",
      "add_campaign_negatives",
      "remove_campaign_negatives",
      "add_shared_negatives",
      "add_keywords",
      "pause_keyword",
      "update_rsa_text",
      "add_sitelinks",
      "add_callouts",
      "add_audience_exclusions",
      "create_campaign",
      "tag_exclude",
    ]);
    for (const n of names) {
      const res = await client.readResource({ uri: `schema://changes/${n}` });
      const first = res.contents[0];
      const json = JSON.parse(first && "text" in first ? first.text : "{}") as {
        summary?: string;
        type?: string;
        properties?: Record<string, unknown>;
      };
      expect(json.summary, n).toBeTruthy();
      expect(json.type, n).toBe("object");
      expect(Object.keys(json.properties ?? {}).length, n).toBeGreaterThan(0);
    }
    const { tools } = await client.listTools();
    const propose = tools.find((t) => t.name === "propose_change");
    const typeEnum = (propose?.inputSchema.properties?.type as { enum?: string[] } | undefined)
      ?.enum;
    expect(typeEnum).toEqual(names);
    // Per-type schemas live in resources, never in tools/list.
    expect(JSON.stringify(propose)).not.toContain("override_blocked_conversions");
    const total = JSON.stringify({ tools }).length;
    expect(total).toBeLessThan(30_000);
    for (const t of tools) expect(JSON.stringify(t).length, t.name).toBeLessThanOrEqual(2_200);
    console.log(
      `tools/list ${total} bytes, ${tools.length} tools, propose_change ${JSON.stringify(propose).length}`,
    );
  });
});

describe("policy file -> types", () => {
  it("brand_terms from policy.yaml refuse a brand negative; defaults reach add_keywords", async () => {
    const r = rig();
    writePolicy(r, POLICY("defaults: { new_entities_paused: true }\n"));
    const { client } = await r.connect();
    const brand = await client.callTool({
      name: "propose_change",
      arguments: {
        customer_id: ACCOUNT,
        type: "add_campaign_negatives",
        params: { campaign_ids: ["333"], negatives: [{ text: "contoso", match_type: "BROAD" }] },
      },
    });
    expect(brand.isError).toBe(true);
    expect(textOf(brand)).toMatch(/names your brand/);
    const kw = await client.callTool({
      name: "propose_change",
      arguments: {
        customer_id: ACCOUNT,
        type: "add_keywords",
        params: { ad_group_id: "444", keywords: [{ text: "red shoes", match_type: "EXACT" }] },
      },
    });
    expect(kw.isError, textOf(kw)).toBeFalsy();
    expect(textOf(kw)).toMatch(/created PAUSED/);
  });

  it("override: the page shows the OVERRIDE banner, the AI's texts as sent, and undo; approve with the code -> verified", async () => {
    const r = rig();
    r.fake.world.more?.searchTerms.push({ text: "cheap shoes", campaignId: "333", conversions: 2 });
    writePolicy(r, POLICY());
    const { client } = await r.connect();
    const res = await client.callTool({
      name: "propose_change",
      arguments: {
        customer_id: ACCOUNT,
        type: "add_campaign_negatives",
        params: {
          campaign_ids: ["333"],
          negatives: [{ text: "cheap <b>x</b>", match_type: "BROAD" }],
          override_blocked_conversions: true,
        },
      },
    });
    // "<" is not a keyword character: refused, the model gets the reason.
    expect(res.isError).toBe(true);
    const ok = await client.callTool({
      name: "propose_change",
      arguments: {
        customer_id: ACCOUNT,
        type: "add_campaign_negatives",
        params: {
          campaign_ids: ["333"],
          negatives: [{ text: "cheap", match_type: "BROAD" }],
          override_blocked_conversions: true,
        },
      },
    });
    const id = sc(ok).change?.changeId ?? "";
    expect(sc(ok).change?.undo?.level).toBe("full");
    expect(sc(ok).change?.warnings?.[0]).toMatch(/^OVERRIDE/);
    const first = await client.callTool({ name: "apply_change", arguments: { change_id: id } });
    expect(textOf(first)).toMatch(/Waiting for your approval/);
    const page = await readPage(r.opened.at(-1) ?? "");
    expect(page.body).toContain(
      'class="override">OVERRIDE: 1 negative keyword in this change blocks',
    );
    expect(page.body).toContain("<bdi>&quot;BROAD: cheap&quot;</bdi>");
    expect(page.body).toContain("blocks the search <bdi>&quot;cheap shoes&quot;</bdi>");
    expect(page.body).toContain("Can be undone fully");
    expect(page.body.indexOf("OVERRIDE")).toBeLessThan(page.body.indexOf("What will change"));
    const session = openSessionFor(r.rt.store(), id, r.rt.now());
    const approved = await r.rt.approvals().completeWithCode(session?.id ?? "", page.code, "cli");
    expect(approved.ok).toBe(true);
    const applied = await client.callTool({ name: "apply_change", arguments: { change_id: id } });
    expect(sc(applied).change?.status).toBe("verified");
  });
});

describe("approval view for types 4-10", () => {
  const base: ChangeView = {
    id: "chg_t6",
    status: "proposed",
    statusReason: null,
    type: "add_sitelinks",
    customerId: ACCOUNT,
    loginCustomerId: null,
    accountName: "Shop",
    currencyCode: "EUR",
    payload: {},
    diff: ["Campaign 333: makes 1 new sitelink asset and links it to the campaign."],
    version: "b".repeat(64),
    affected: [{ kind: "campaign", id: "333", name: "Search", status: "ENABLED" }],
    facts: { affectedCampaignIds: ["333"] },
    warnings: [],
    reason: null,
    modelTexts: [{ label: "Sitelinks", items: ["Sale  | <script>x</script> | https://e.com"] }],
    riskTier: "confirm",
    undo: { supported: true, why: "The asset stays in the library.", level: "partial" },
    landed: null,
    undoOf: null,
    expiresAt: "2026-10-25T10:30:00.000Z",
    createdAt: "2026-10-25T10:00:00.000Z",
    approvedBy: null,
    approvedVia: null,
    approvedAt: null,
    appliedAt: null,
    googleRequestIds: [],
    readback: null,
    error: null,
  };
  const page = (c: ChangeView) =>
    approvalPageHtml({
      change: c,
      kind: "approve",
      code: "ABC234",
      csrf: "tok",
      testAccount: true,
      approveButton: false,
      pageExpiresAt: "2026-10-25T10:10:00.000Z",
    });

  it("AI texts: escaped, JSON-quoted (double spaces visible), in the unverified box; partial undo said", () => {
    const html = page(base);
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&quot;Sale  | &lt;script&gt;x&lt;/script&gt; | https://e.com&quot;");
    expect(html.indexOf("Sitelinks (written by the AI, sent exactly as shown, 1)")).toBeGreaterThan(
      html.indexOf("From the AI / from Google (unverified)"),
    );
    expect(html).toContain("Can be undone only in part: The asset stays in the library.");
  });

  it("no undo: the page and the summary say it can't be undone", () => {
    const none: ChangeView = {
      ...base,
      modelTexts: [],
      undo: {
        supported: false,
        why: "This change can't be undone.",
        level: "none",
      },
    };
    expect(page(none)).toContain("Can&#39;t be undone: This change can&#39;t be undone.");
    expect(approvalSummaryText(none, "approve")).toContain("Undo: Can't be undone");
  });

  it("the summary for forms and the terminal names the override and the AI texts count", () => {
    const text = approvalSummaryText(
      {
        ...base,
        facts: { affectedCampaignIds: ["333"], blockedConversions: { count: 2, examples: [] } },
      },
      "approve",
    );
    expect(text.split("\n")[1]).toBe(
      "OVERRIDE: 2 negative keywords block searches or keywords that had conversions.",
    );
    expect(text).toContain("1 text written by the AI: read them on the page before approving.");
  });
});

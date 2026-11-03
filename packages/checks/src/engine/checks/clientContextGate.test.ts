// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * The owner's context reaches the checks.
 *
 * The rule every test below turns on: A SUGGESTION IS NOT THE OWNER'S WORD.
 * `source: 'ai'` (a suggestion nobody confirmed) is a normal path, not an edge
 * case.
 *
 * Four cases:
 *   1. an OWNER-typed target becomes the bar BB07 judges against;
 *   2. a suggested target does NOT: the verdict stays on the account average
 *      and the refusal is recorded rather than hidden;
 *   3. no target at all: unchanged behaviour, plus the sentence that says the
 *      bar was relative;
 *   4. an always-on constraint meeting a pause recommendation: the finding
 *      SURVIVES and its ask moves (a constraint never deletes a finding).
 */
import { describe, expect, it } from "vitest";
import { bb07 } from "./budgetBidding.js";
import { businessTypeVerdict } from "./businessTypeGate.js";
import {
  ACCOUNT_AVERAGE_BAR_NOTE,
  ALWAYS_ON_PATTERNS,
  ALWAYS_ON_CHECKS,
  aiTargetIgnoredNote,
  alwaysOnDeclaration,
  applyClientConstraintGate,
  guardWriterHints,
  declaredTargetFor,
  postLeadOutcomeRider,
  targetBar,
  tracksPostLeadOutcomes,
} from "./clientContextGate.js";
import type { CheckCtx, CheckFinding, CheckResult, WriterHints } from "./types.js";
import type {
  CampaignClientContext,
  ClientContext,
  ContextSource,
} from "../shared/clientContext.js";
import { parseDeclaredTarget, toClientContext } from "../shared/clientContext.js";
import { DEFAULT_SETTINGS } from "../settings.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const CAMPAIGN_ID = "111";
const CAMPAIGN_NAME = "Generic search";

/**
 * One campaign's context row, exactly as `loadClientContext` builds it.
 *
 * `declaredTarget` is derived through the real `parseDeclaredTarget` and the
 * real source rule, so this fixture cannot drift away from the loader: an AI
 * row gets `value: null` here for the same reason it does in production.
 */
function campaignContext(opts: {
  source: ContextSource extends never ? never : "client" | "ai";
  target?: string | null;
  constraints?: string | null;
  purpose?: string | null;
}): CampaignClientContext {
  const { source, target = null, constraints = null, purpose = null } = opts;
  const p = <T>(value: T) => ({ value, source });
  const parsed =
    source === "client"
      ? parseDeclaredTarget(target)
      : { value: null, reason: "suggested target, not an owner declaration" };
  return {
    campaignId: CAMPAIGN_ID,
    source,
    purpose: p(purpose),
    objective: p(null),
    conversion: p(null),
    target: p(target),
    constraints: p(constraints),
    declaredTarget: { value: parsed.value, source, reason: parsed.reason },
  };
}

function clientContext(
  campaign: CampaignClientContext | null,
  account?: Partial<Record<"tracksPostLeadOutcomes", string>>,
): ClientContext {
  const p = <T>(value: T) => ({ value, source: "client" as const });
  return {
    account: {
      businessType: p(null),
      tracksPostLeadOutcomes: p(account?.tracksPostLeadOutcomes ?? null),
      grossMarginPct: p(null),
    },
    campaigns: campaign ? { [campaign.campaignId]: campaign } : {},
  };
}

/**
 * The smallest ctx BB07 can run on, gates and all.
 *
 * One ENABLED campaign that spent, so the activity gate passes it through; no
 * `dataQuality.tables`, so `populationOf` reports 0 rows and the three markers
 * below are what make `gateOnData` open. This exists to move ONE input (the
 * owner's declared target) and watch the verdict's bar move.
 */
function ctxFor(opts: {
  roas30: number;
  cpa30: number;
  accountRoas: number;
  accountCpa: number;
  context?: ClientContext | null;
}): CheckCtx {
  const { roas30, cpa30, accountRoas, accountCpa, context = null } = opts;
  const campaign = {
    id: CAMPAIGN_ID,
    name: CAMPAIGN_NAME,
    status: "ENABLED",
    attrs: { status: "ENABLED", isBrand: false },
    windows: { m90: { cost: 5_000 } },
  };
  const ok = (id: string, value: unknown, unit: string) => ({
    id,
    value,
    unit,
    level: "campaign",
    entityId: CAMPAIGN_ID,
    window: null,
    source: { table: "campaigns" },
    maturity: { rule: "N/A", settledStrict: true, settledPractical: true },
    markerState: "ok",
    sample: { truncated: false },
  });
  const marker = (table: string) =>
    [
      table,
      {
        table,
        key: null,
        status: "ok",
        rowCount: 10,
        source: "status",
        message: null,
        rowsSeen: 10,
        cap: null,
        truncated: false,
      },
    ] as const;
  return {
    model: {
      id: "acc-1",
      name: "Test account",
      attrs: { profile: null, currencyCode: "USD", businessType: "ecommerce" },
      children: { campaigns: [campaign] },
      dataQuality: { tables: {}, orphanRows: {} },
    },
    metrics: {
      markers: new Map([
        marker("campaigns"),
        marker("impressionShare"),
        marker("campaignDailyMetrics"),
      ]),
      index: {
        campaignsById: new Map([[CAMPAIGN_ID, campaign]]),
        adGroupsById: new Map(),
        keywordsById: new Map(),
        adsById: new Map(),
      },
    },
    get: (id: string) => {
      switch (id) {
        // 0.98 utilisation and 40% of impressions lost to budget: BB07's two structural gates.
        case "C.budget_util90":
          return ok(id, 0.98, "ratio");
        case "C.lost_is_budget_pct":
          return ok(id, 40, "percent");
        case "C.window(w)":
          return ok(
            id,
            { cost: 3_000, conv: 60, value: roas30 * 3_000, roas: roas30, cpa: cpa30 },
            "bundle",
          );
        case "A.roas":
          return ok(id, accountRoas, "ratio");
        case "A.cpa":
          return ok(id, accountCpa, "usd");
        default:
          return { id, reason: "not_checkable", detail: "not part of this fixture" };
      }
    },
    window: { label: "90d" },
    currency: { known: true, factor: 1, code: "USD" },
    businessType: "ecommerce",
    clientContext: context,
    settings: DEFAULT_SETTINGS,
  } as unknown as CheckCtx;
}

/** The gate tests' check list, and a writer-hints stub standing in for the caller's text. */
const TEST_RULES = ["TR06"];
const STUB_HINTS: WriterHints = {
  clientConstraint: (checkId, d) => `stub ${checkId} ${d.source} ${d.field}: ${d.text}`,
};
const hinted = (ctx: CheckCtx): CheckCtx => ({ ...ctx, writerHints: STUB_HINTS });

const firesOne = (r: CheckResult): CheckFinding => {
  if (r.state !== "fires") throw new Error(`expected fires, got ${r.state}: ${JSON.stringify(r)}`);
  expect(r.findings).toHaveLength(1);
  return r.findings[0]!;
};

// ---------------------------------------------------------------------------
// 1 — the declared target
// ---------------------------------------------------------------------------

describe("§3b step 1 · only the client can declare a target", () => {
  it("a client-typed target is read, with the demanding end of a range as the bar", () => {
    const ctx = ctxFor({
      roas30: 3,
      cpa30: 40,
      accountRoas: 2,
      accountCpa: 50,
      context: clientContext(
        campaignContext({ source: "client", target: "Target ROAS 3:1 or better" }),
      ),
    });
    const d = declaredTargetFor(ctx, CAMPAIGN_ID);
    expect(d).not.toBeNull();
    expect(d!.target.kind).toBe("roas");
    expect(targetBar(d!.target)).toBe(3);
  });

  it("an AI-suggested target is refused even when it parses perfectly", () => {
    const ai = campaignContext({ source: "ai", target: "Target ROAS 3:1 or better" });
    // the loader itself already refuses to parse it — this asserts the fixture is honest
    expect(ai.declaredTarget.value).toBeNull();
    const ctx = ctxFor({
      roas30: 3,
      cpa30: 40,
      accountRoas: 2,
      accountCpa: 50,
      context: clientContext(ai),
    });
    expect(declaredTargetFor(ctx, CAMPAIGN_ID)).toBeNull();
    // and the refusal is recorded, not hidden: the question WAS asked
    expect(aiTargetIgnoredNote(ctx, CAMPAIGN_ID)).toContain("NOT used as a bar");
  });

  it("a client row whose target text names no metric yields no bar, never a guess", () => {
    const ctx = ctxFor({
      roas30: 3,
      cpa30: 40,
      accountRoas: 2,
      accountCpa: 50,
      context: clientContext(
        campaignContext({ source: "client", target: "as high as we can get it" }),
      ),
    });
    expect(declaredTargetFor(ctx, CAMPAIGN_ID)).toBeNull();
  });

  it("no context at all reads exactly as it did before this existed", () => {
    const ctx = ctxFor({ roas30: 3, cpa30: 40, accountRoas: 2, accountCpa: 50 });
    expect(declaredTargetFor(ctx, CAMPAIGN_ID)).toBeNull();
    expect(aiTargetIgnoredNote(ctx, CAMPAIGN_ID)).toBeNull();
  });
});

describe("§3b step 1 · BB07 judges against the bar the client named", () => {
  // 2.6x is a WINNER against a 2:1 declared target and a LOSER against a 3:1 one.
  it("a campaign over the declared target fires, and names the client bar", () => {
    const ctx = ctxFor({
      roas30: 2.6,
      cpa30: 90,
      accountRoas: 4,
      accountCpa: 10,
      context: clientContext(campaignContext({ source: "client", target: "ROAS 2:1" })),
    });
    const f = firesOne(bb07.run(ctx));
    expect(f.facts.target_source).toBe("client_declared");
    expect(f.facts.declared_target_roas).toBe(2);
    expect(f.note).toContain("you set a return target of 2:1");
    // the account average is still cited: it is true
    expect(f.facts.account_roas).toBe(4);
  });

  it("a campaign under the declared target does NOT fire, even though it beats the account average", () => {
    // 2.6x against a 4:1 declaration. The account average (2.0) would have
    // called this profitable; the client's own bar says it is not.
    const ctx = ctxFor({
      roas30: 2.6,
      cpa30: 90,
      accountRoas: 2,
      accountCpa: 200,
      context: clientContext(campaignContext({ source: "client", target: "target ROAS 4:1" })),
    });
    expect(bb07.run(ctx).state).toBe("none_found");
  });

  it("a declared CPA target is judged the right way round (lower is better)", () => {
    const ctx = ctxFor({
      roas30: 0.1,
      cpa30: 25,
      accountRoas: 5,
      accountCpa: 10,
      context: clientContext(campaignContext({ source: "client", target: "CPA $12-30" })),
    });
    const f = firesOne(bb07.run(ctx));
    expect(f.facts.target_source).toBe("client_declared");
    expect(f.facts.declared_target_cpa).toBe(30);
  });

  it("an AI-guessed target does not harden the verdict — the account average stays the bar", () => {
    // Identical numbers to the "under the declared target" case above. With a
    // CLIENT 4:1 the campaign does not fire; with the SAME text pre-filled by a
    // model it must fall back to the account average and fire.
    const ctx = ctxFor({
      roas30: 2.6,
      cpa30: 90,
      accountRoas: 2,
      accountCpa: 200,
      context: clientContext(campaignContext({ source: "ai", target: "target ROAS 4:1" })),
    });
    const f = firesOne(bb07.run(ctx));
    expect(f.facts.target_source).toBe("account_average");
    expect(f.facts.declared_target_roas).toBeUndefined();
    // the model's words are never presented as the client's
    expect(f.note).not.toContain("you set");
    expect(f.note).toContain("was NOT used as a bar");
  });

  it("with no target the account average stays the bar and the finding SAYS the bar is relative", () => {
    const ctx = ctxFor({ roas30: 2.6, cpa30: 90, accountRoas: 2, accountCpa: 200 });
    const f = firesOne(bb07.run(ctx));
    expect(f.facts.target_source).toBe("account_average");
    expect(f.note).toBe(ACCOUNT_AVERAGE_BAR_NOTE);
    expect(f.note).toContain("this account's own average, not an absolute bar");
  });

  it("no client context leaves BB07 byte-identical to its behaviour without context", () => {
    const withNone = bb07.run(ctxFor({ roas30: 2.6, cpa30: 90, accountRoas: 2, accountCpa: 200 }));
    const withEmpty = bb07.run(
      ctxFor({
        roas30: 2.6,
        cpa30: 90,
        accountRoas: 2,
        accountCpa: 200,
        context: clientContext(null),
      }),
    );
    expect(withNone.state).toBe("fires");
    expect(JSON.stringify(withEmpty)).toBe(JSON.stringify(withNone));
  });
});

// ---------------------------------------------------------------------------
// 2 — purpose and constraints
// ---------------------------------------------------------------------------

describe("§3b step 2 · an always-on constraint moves the ask, it never deletes the finding", () => {
  const declaring = (
    source: "client" | "ai",
    text: string,
    field: "constraints" | "purpose" = "constraints",
  ) =>
    ctxFor({
      roas30: 1,
      cpa30: 100,
      accountRoas: 1,
      accountCpa: 100,
      context: clientContext(campaignContext({ source, [field]: text } as never)),
    });

  const fired = (): CheckResult => ({
    state: "fires",
    findings: [
      {
        claimKey: "trend.zero_conversions",
        scope: { type: "campaign", id: CAMPAIGN_ID, name: CAMPAIGN_NAME },
        evidence: [],
        facts: { spend_90d: 4_210 },
        sample: { truncated: false, population: 4 },
        settled: { strict: true, practical: true },
        markerState: "ok",
      },
    ],
  });

  it("only the shipped checks read against an always-on declaration are in the list", () => {
    expect([...ALWAYS_ON_CHECKS].sort()).toEqual(["TR01", "TR06"]);
  });

  it("without writer hints the gate stamps the facts only, no instruction", () => {
    const r = applyClientConstraintGate(
      "TR06",
      declaring("client", "Brand defence, always-on, never pause"),
      fired(),
      TEST_RULES,
    );
    const f = firesOne(r);
    expect(f.scope.clientConstraint).toBeUndefined();
    expect(f.facts.client_constraint).toBe("always_on");
    expect(f.facts.client_constraint_source).toBe("client");
    // D8: the finding and its money are untouched
    expect(f.facts.spend_90d).toBe(4_210);
    expect(f.sample.population).toBe(4);
  });

  it("with writer hints the caller's text becomes the scope's instruction and joins the note", () => {
    const f = firesOne(
      applyClientConstraintGate(
        "TR06",
        hinted(declaring("ai", "This campaign is always-on brand defence.")),
        fired(),
        TEST_RULES,
      ),
    );
    expect(f.scope.clientConstraint).toBe(
      "stub TR06 ai constraints: This campaign is always-on brand defence.",
    );
    expect(f.note).toContain("stub TR06 ai constraints");
    expect(f.facts.client_constraint_source).toBe("ai");
  });

  it("a throwing or non-string hint is ignored: the TR06 finding is still reported, unchanged but for the facts", () => {
    for (const bad of [
      () => {
        throw new Error("boom");
      },
      () => 42 as unknown as string,
      () => "",
    ]) {
      const ctx: CheckCtx = {
        ...declaring("client", "Brand defence, always-on, never pause"),
        writerHints: { clientConstraint: bad },
      };
      const before = fired();
      const f = firesOne(applyClientConstraintGate("TR06", ctx, before, TEST_RULES));
      const original = firesOne(before);
      expect(f.scope.clientConstraint).toBeUndefined();
      expect(f.note).toBe(original.note);
      expect(f.evidence).toEqual(original.evidence);
      expect(f.facts.spend_90d).toBe(4_210);
      expect(f.facts.client_constraint).toBe("always_on");
    }
  });

  it("the engine's guarded hint turns a throw or a non-string into null and one warning per check", () => {
    const warnings: string[] = [];
    let n = 0;
    const guarded = guardWriterHints(
      {
        clientConstraint: () => {
          n += 1;
          if (n % 2) throw new Error("boom");
          return 7 as unknown as string;
        },
      },
      (m) => warnings.push(m),
    );
    const d = { text: "always-on", field: "constraints", source: "client" } as const;
    expect(guarded.clientConstraint?.("TR06", d)).toBeNull();
    expect(guarded.clientConstraint?.("TR06", d)).toBeNull();
    expect(guarded.clientConstraint?.("TR01", d)).toBeNull();
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("TR06 threw");
    expect(warnings[1]).toContain("TR01 threw");
  });

  it("an always-on answer given under purpose is found too, and the field is recorded", () => {
    const ctx = declaring("client", "Always-on brand protection", "purpose");
    expect(alwaysOnDeclaration(ctx, CAMPAIGN_ID)).toEqual({
      text: "Always-on brand protection",
      field: "purpose",
      source: "client",
    });
    expect(
      firesOne(applyClientConstraintGate("TR06", ctx, fired(), TEST_RULES)).facts
        .client_constraint_field,
    ).toBe("purpose");
  });

  it("a constraint that does not say always-on changes nothing", () => {
    const ctx = declaring("client", "Keep the budget under $50 a day");
    expect(alwaysOnDeclaration(ctx, CAMPAIGN_ID)).toBeNull();
    const r = fired();
    expect(applyClientConstraintGate("TR06", ctx, r, TEST_RULES)).toBe(r);
  });

  it("a check outside the table is untouched even under an always-on constraint", () => {
    const r = fired();
    expect(applyClientConstraintGate("BB07", declaring("client", "always-on"), r, TEST_RULES)).toBe(
      r,
    );
  });

  it("the patterns match how people actually write it, and not how they do not", () => {
    for (const text of [
      "always on",
      "always-on",
      "must stay running",
      "never pause this",
      "do not pause",
      "it cannot be paused",
      "run it 24/7",
    ]) {
      expect(ALWAYS_ON_PATTERNS.some((re) => re.test(text))).toBe(true);
    }
    for (const text of [
      "our main campaign",
      "paused last month",
      "we pause it in July",
      "always our best performer",
    ]) {
      expect(ALWAYS_ON_PATTERNS.some((re) => re.test(text))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 3 — tracksPostLeadOutcomes
// ---------------------------------------------------------------------------

describe('§3b step 3 · "your tracking is broken" versus "you track revenue only"', () => {
  const ctxWith = (answer?: string) =>
    ctxFor({
      roas30: 1,
      cpa30: 1,
      accountRoas: 1,
      accountCpa: 1,
      context: clientContext(null, answer ? { tracksPostLeadOutcomes: answer } : undefined),
    });

  it("reads the three states, and refuses to read an answer it does not recognise", () => {
    expect(tracksPostLeadOutcomes(ctxWith("No — we only see form fills"))).toBe("no");
    expect(tracksPostLeadOutcomes(ctxWith("Yes, closed-won revenue goes back via CRM"))).toBe(
      "yes",
    );
    expect(tracksPostLeadOutcomes(ctxWith("sometimes, depends on the team"))).toBeNull();
    expect(tracksPostLeadOutcomes(ctxWith())).toBeNull();
  });

  it('a "no" turns an abstention into an abstention that says what is hidden', () => {
    const ctx = ctxWith("No");
    (ctx as { businessType: string }).businessType = "lead_gen";
    const v = businessTypeVerdict("BB14", ctx);
    expect(v?.state).toBe("not_checkable");
    expect(v!.reason).toContain("not e-commerce");
    expect(v!.reason).toContain("stops at the form fill");
  });

  it("an account that skipped the question reads exactly as it did before", () => {
    const ctx = ctxWith();
    (ctx as { businessType: string }).businessType = "lead_gen";
    expect(postLeadOutcomeRider(ctx)).toBeNull();
    expect(businessTypeVerdict("BB14", ctx)!.reason).not.toContain("form fill");
  });

  it("nothing it prints claims the answer is current", () => {
    for (const text of [
      postLeadOutcomeRider(ctxWith("No")),
      postLeadOutcomeRider(ctxWith("Yes")),
    ]) {
      expect(text).not.toMatch(/\bcurrently\b|\bas of\b|\bstill\b|\brecently\b|\d{4}-\d{2}-\d{2}/i);
    }
  });
});

// ---------------------------------------------------------------------------
// the public input shape
// ---------------------------------------------------------------------------

describe("toClientContext · the caller input in the gate shape", () => {
  it("maps owner answers to client and suggestions to ai, and parses owner targets only", () => {
    const ctx = toClientContext({
      source: "owner",
      account: { tracksPostLeadOutcomes: "no", grossMarginPct: "30%" },
      campaigns: {
        "111": { target: "ROAS 3:1" },
        "222": { target: "ROAS 3:1", source: "suggested" },
      },
    });
    expect(ctx?.campaigns["111"]?.source).toBe("client");
    expect(ctx?.campaigns["111"]?.declaredTarget.value).toEqual({
      kind: "roas",
      low: 3,
      high: 3,
      openEnded: false,
    });
    expect(ctx?.campaigns["222"]?.source).toBe("ai");
    expect(ctx?.campaigns["222"]?.declaredTarget.value).toBeNull();
    expect(ctx?.account.grossMarginPct.value).toBe(30);
  });

  it("absent input is null, never an empty declaration", () => {
    expect(toClientContext(null)).toBeNull();
    expect(toClientContext(undefined)).toBeNull();
  });

  it("parses the declared-target grammar and refuses a bare number", () => {
    expect(parseDeclaredTarget("CPA $12-30").value).toEqual({
      kind: "cpa",
      low: 12,
      high: 30,
      openEnded: false,
    });
    expect(parseDeclaredTarget("6:1+").value).toEqual({
      kind: "roas",
      low: 6,
      high: 6,
      openEnded: true,
    });
    expect(parseDeclaredTarget("40").value).toBeNull();
    expect(parseDeclaredTarget("CPA $12-30; ROAS 6:1+").reason).toMatch(
      /first labelled metric kept/,
    );
  });
});

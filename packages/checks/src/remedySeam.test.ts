// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * The checks say what is wrong; fix guidance comes only from a caller's
 * `RemedyProvider`. Two halves:
 *   - the seam: no provider = no `remediation` on any result; a provider fills it;
 *   - the guard: none of the fix texts that used to live in the checks is back in
 *     any package's source or build. Only their sha256 is stored here, never the text.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listChecks, runChecks, type EvidenceInput, type RemedyProvider } from "./index.js";
import type { Candidate } from "./engine/runEvidenceEngine.js";
import { RUN_DATE, adGroup, buildInput, keyword, searchTerm } from "./testing/account.js";
import { buildSyntheticSnapshot } from "./testing/syntheticSnapshot.js";
import {
  ALL_MOVED_HASHES,
  literalChunks,
  MOVED_ACTION_HASHES,
  sha256,
} from "./testing/movedTexts.js";

function syntheticInput(): EvidenceInput {
  const snap = buildSyntheticSnapshot(5);
  return {
    data: snap.data,
    tables: snap.dbTables,
    runDate: RUN_DATE,
    assumeComplete: true,
    clock: () => 0,
  };
}

function searchInput(): EvidenceInput {
  return buildInput({
    campaigns: [
      {
        id: "11",
        name: "Generic search",
        strategy: "TARGET_ROAS",
        targetRoas: 2,
        budget: 100,
        cost: 100,
        is: { lostBudget: 0.2, lostRank: 0.35 },
      },
      {
        id: "12",
        name: "Brand search",
        strategy: "MAXIMIZE_CONVERSIONS",
        budget: 50,
        cost: 30,
        clicks: 20,
      },
    ],
    data: {
      adGroups: [adGroup({ id: "21", campaignId: "11" }), adGroup({ id: "22", campaignId: "12" })],
      keywords: [
        keyword({
          id: "31",
          campaignId: "11",
          adGroupId: "21",
          text: "running shoes",
          match: "BROAD",
          cost: 900,
          clicks: 300,
        }),
      ],
      searchTerms: [
        searchTerm({
          campaignId: "11",
          adGroupId: "21",
          term: "cheap running shoes",
          cost: 400,
          conv: 0,
        }),
        searchTerm({
          campaignId: "11",
          adGroupId: "21",
          term: "trail running shoes",
          cost: 300,
          conv: 4,
        }),
      ],
    },
  });
}

const FIXTURES: Record<string, () => EvidenceInput> = {
  synthetic: syntheticInput,
  search: searchInput,
};

const all = (r: ReturnType<typeof runChecks>): Candidate[] => [...r.findings, ...r.info];

describe("remedy seam", () => {
  for (const [name, input] of Object.entries(FIXTURES)) {
    it(`${name}: without a provider no result carries a remediation`, () => {
      const r = runChecks(input());
      expect(r.findings.length).toBeGreaterThan(0);
      for (const c of all(r)) expect("remediation" in c).toBe(false);
    });

    it(`${name}: a provider's decision lands on the findings of the checks it covers`, () => {
      const stub: RemedyProvider = Object.fromEntries(
        listChecks().map((c) => [
          c.id,
          (f) => ({
            action: `stub ${c.id}`,
            entity: { id: f.scope.id, name: f.scope.name },
            because: "stub",
          }),
        ]),
      );
      const r = runChecks(input(), { remedies: stub });
      expect(r.findings.length).toBeGreaterThan(0);
      for (const c of all(r)) expect(c.remediation?.action).toBe(`stub ${c.checkId}`);
    });
  }

  it("a provider that throws or declines never loses the finding", () => {
    const ids = listChecks().map((c) => c.id);
    const plain = runChecks(syntheticInput());
    const throwing = runChecks(syntheticInput(), {
      remedies: Object.fromEntries(
        ids.map((id) => [
          id,
          () => {
            throw new Error("boom");
          },
        ]),
      ),
    });
    const declining = runChecks(syntheticInput(), {
      remedies: Object.fromEntries(ids.map((id) => [id, () => null])),
    });
    for (const r of [throwing, declining]) {
      expect(r.findings.map((c) => c.checkId)).toEqual(plain.findings.map((c) => c.checkId));
      for (const c of all(r)) expect("remediation" in c).toBe(false);
    }
  });
});

describe("a remedy's answer is copied to a plain object", () => {
  it("a getter that throws, a proxy or a function loses that decision only, never the run", () => {
    const ids = listChecks().map((c) => c.id);
    const plain = runChecks(syntheticInput());
    const odd = [
      () =>
        Object.defineProperty({ because: "b" }, "action", {
          enumerable: true,
          get: () => {
            throw new Error("getter");
          },
        }),
      () => new Proxy({ action: "a", because: "b" }, {}),
      () => ({ action: "a", because: "b", entity: { id: "1", name: () => "fn" } }),
    ];
    for (const make of odd) {
      const r = runChecks(syntheticInput(), {
        remedies: Object.fromEntries(ids.map((id) => [id, make as never])),
      });
      expect(r.findings.map((c) => c.checkId)).toEqual(plain.findings.map((c) => c.checkId));
      for (const c of all(r)) expect("remediation" in c).toBe(false);
      expect(() => JSON.stringify(r)).not.toThrow();
    }
    // a plain answer is a copy: changing the original later changes nothing
    const kept = { action: "a", because: "b" };
    const r = runChecks(syntheticInput(), {
      remedies: Object.fromEntries(ids.map((id) => [id, () => kept])),
    });
    kept.action = "changed";
    expect(all(r).every((c) => c.remediation?.action === "a")).toBe(true);
  });
});

describe("remedy inputs are frozen copies", () => {
  it("a remedy that writes to the finding or the ctx changes nothing", () => {
    const plain = runChecks(syntheticInput());
    const seen: { finding: boolean; ctx: boolean }[] = [];
    const meddling = runChecks(syntheticInput(), {
      remedies: Object.fromEntries(
        listChecks().map((c) => [
          c.id,
          (f, ctx) => {
            seen.push({ finding: Object.isFrozen(f.facts), ctx: Object.isFrozen(ctx) });
            (f.facts as Record<string, unknown>).meddled = true;
            return null;
          },
        ]),
      ),
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.finding && s.ctx)).toBe(true);
    expect(JSON.stringify(meddling.findings)).toBe(JSON.stringify(plain.findings));
  });
});

// ---------------------------------------------------------------------------
// guard: the moved fix texts stay out of the public packages
// ---------------------------------------------------------------------------

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function filesUnder(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) filesUnder(p, out);
    else if (/\.(ts|js|mjs|cjs|json|md)$/.test(e.name) && p !== fileURLToPath(import.meta.url))
      out.push(p);
  }
  return out;
}

describe("moved fix texts", () => {
  it("the scanner reads the strings a check source holds", () => {
    const src = readFileSync(
      join(PACKAGES, "checks", "src", "engine", "checks", "search.ts"),
      "utf8",
    );
    expect(literalChunks(src).has("No generic queries are leaking into the brand campaign.")).toBe(
      true,
    );
    expect(MOVED_ACTION_HASHES.size).toBeGreaterThanOrEqual(83);
    expect(ALL_MOVED_HASHES.size).toBeGreaterThan(MOVED_ACTION_HASHES.size + 300);
  });

  it("appear in no package source or build", () => {
    expect(existsSync(join(PACKAGES, "checks", "dist", "index.js"))).toBe(true);
    const hits: string[] = [];
    let scanned = 0;
    for (const pkg of readdirSync(PACKAGES)) {
      for (const sub of ["src", "dist"]) {
        for (const file of filesUnder(join(PACKAGES, pkg, sub))) {
          scanned += 1;
          for (const chunk of literalChunks(readFileSync(file, "utf8")))
            if (ALL_MOVED_HASHES.has(sha256(chunk))) hits.push(`${file}: ${chunk.slice(0, 60)}`);
        }
      }
    }
    expect(scanned).toBeGreaterThan(100);
    expect(hits).toEqual([]);
  });
});

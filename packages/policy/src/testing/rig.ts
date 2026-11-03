// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Test wiring for the policy against the real change engine: a temp settings folder with
// policy.yaml, a temp store, the fake Google account behind the real ads-client, a fixed
// clock, and a barrier that holds apply's live account read until N appliers arrived
// (so parallel claims really race). Fake ids only.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeClient } from "@perfoads/ads-client/testing";
import {
  createChangeEngine,
  listEvents,
  type ChangeView,
  type EngineAds,
  type PolicyCheck,
} from "@perfoads/changes";
import {
  createFakeGoogle,
  fakeWorld,
  FAKE_CUSTOMER,
  type FakeWorld,
} from "@perfoads/changes/testing";
import { openStore, storePath, type Store } from "@perfoads/store";
import { createFilePolicy, type FilePolicy } from "../check.js";
import { createPolicySource } from "../source.js";

export const T0 = Date.parse("2026-10-25T10:00:00.000Z");
export const ACCOUNT = FAKE_CUSTOMER;
export const AGENT = { actor: "agent", via: "mcp" } as const;

export const policyYaml = (
  o: {
    write?: boolean;
    pct?: number;
    abs?: number | null;
    cap?: number | null;
    capFor?: string;
    targetPct?: number;
    tiers?: string;
    kill?: boolean;
    perDay?: number;
    perMinute?: number;
    proposalsPerMinute?: number;
    proposalsPerDay?: number;
    undoPerDay?: number;
  } = {},
): string => {
  const capId = o.capFor ?? ACCOUNT;
  const ids = [...new Set([ACCOUNT, capId])].map((id) => `"${id}"`).join(", ");
  return `version: 1
accounts: { allow: [${ids}], write: [${o.write === false ? "" : `"${ACCOUNT}"`}] }
limits:
  max_budget_change_pct: ${o.pct ?? 30}
  max_budget_change_abs: { ${o.abs ? `"${ACCOUNT}": ${o.abs}` : ""} }
  max_new_daily_spend: { ${o.cap === null ? "" : `"${capId}": ${o.cap ?? 10}`} }
  max_target_change_pct: ${o.targetPct ?? 20}
  writes_per_day: ${o.perDay ?? 50}
  writes_per_minute: ${o.perMinute ?? 10}
  proposals_per_minute: ${o.proposalsPerMinute ?? 20}
  proposals_per_day: ${o.proposalsPerDay ?? 200}
  undo_per_day: ${o.undoPerDay ?? 50}
tiers: { ${o.tiers ?? '"remove_*": blocked'} }
kill_switch: ${o.kill ?? false}
`;
};

export interface PolicyRig {
  root: string;
  configDir: string;
  project: string;
  store: Store;
  fake: ReturnType<typeof createFakeGoogle>;
  clock: { now: number };
  engine: ReturnType<typeof createChangeEngine>;
  file: FilePolicy;
  writePolicy: (text: string) => void;
  /** Holds the next N live account reads (apply's pre-check) until all N arrived. */
  holdAccountReads: (n: number) => void;
  /** propose + approve (as a person via the CLI path). */
  proposeApproved: (type: string, input: Record<string, unknown>) => Promise<ChangeView>;
  /** A second engine on its own connection (another server process). */
  second: () => { engine: ReturnType<typeof createChangeEngine>; store: Store };
  refusals: () => Record<string, unknown>[];
  close: () => void;
}

export const makePolicyRig = (
  o: {
    world?: FakeWorld;
    policy?: string;
    wrapPolicy?: (file: FilePolicy, rig: () => PolicyRig) => PolicyCheck;
  } = {},
): PolicyRig => {
  const root = mkdtempSync(path.join(tmpdir(), "perfoads-policy-rig-"));
  const configDir = path.join(root, "config");
  const project = path.join(root, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  const writePolicy = (text: string) => writeFileSync(path.join(configDir, "policy.yaml"), text);
  if (o.policy !== undefined) writePolicy(o.policy);
  const store = openStore(storePath(configDir));
  const fake = createFakeGoogle(o.world ?? fakeWorld());
  const clock = { now: T0 };
  const barrier = { need: 0, waiting: [] as (() => void)[] };
  const extra: Store[] = [];
  const ref: { rig?: PolicyRig } = {};

  const build = (s: Store) => {
    const source = createPolicySource({
      configDir,
      cwd: project,
      store: () => s,
      now: () => clock.now,
    });
    const file = createFilePolicy(source);
    const policy = o.wrapPolicy ? o.wrapPolicy(file, () => ref.rig as PolicyRig) : file;
    const { client } = makeClient(fake.router, { now: () => clock.now });
    const ads: EngineAds = {
      searchAll: async (p) => {
        if (barrier.need > 0 && /FROM customer\b/.test(p.query)) {
          await new Promise<void>((resolve) => {
            barrier.waiting.push(resolve);
            if (barrier.waiting.length >= barrier.need) {
              barrier.need = 0;
              for (const r of barrier.waiting.splice(0)) r();
            }
          });
        }
        return client.searchAll(p);
      },
      mutateAll: (ops, w) => client.mutateAll(ops, w),
    };
    const engine = createChangeEngine({
      store: s,
      ads,
      policy,
      now: () => clock.now,
      sleep: async () => {},
    });
    return { engine, file };
  };

  const main = build(store);
  const self: PolicyRig = {
    root,
    configDir,
    project,
    store,
    fake,
    clock,
    engine: main.engine,
    file: main.file,
    writePolicy,
    holdAccountReads: (n) => {
      barrier.need = n;
    },
    proposeApproved: async (type, input) => {
      const v = await main.engine.propose({ customerId: ACCOUNT, type, input, ...AGENT });
      return main.engine.markApproved(v.id, v.version, "cli", "tester");
    },
    second: () => {
      const s = openStore(storePath(configDir));
      extra.push(s);
      return { store: s, engine: build(s).engine };
    },
    refusals: () =>
      listEvents(store)
        .filter((e) => e.event === "refused")
        .map((e) => ({ changeId: e.changeId, ...e.data })),
    close: () => {
      for (const s of extra) s.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  ref.rig = self;
  return self;
};

export { fakeWorld };

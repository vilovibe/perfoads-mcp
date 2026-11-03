// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Shared test wiring: a temp store, a fake Google account behind the real ads-client
// (fake fetch), a fixed clock and no real waits.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeClient, type Call } from "@perfoads/ads-client/testing";
import type { AdsClientConfig } from "@perfoads/ads-client";
import { openStore, storePath, type Store } from "@perfoads/store";
import { createChangeEngine, type EngineOptions } from "../engine.js";
import type { EngineAds } from "../facts.js";
import type { PolicyCheck } from "../policy.js";
import {
  createFakeGoogle,
  fakeWorld,
  permissiveTestPolicy,
  type FakeGoogleHooks,
  type FakeWorld,
} from "./index.js";

export const T0 = Date.parse("2026-10-25T10:00:00.000Z");

export interface Rig {
  dir: string;
  store: Store;
  fake: ReturnType<typeof createFakeGoogle>;
  calls: Call[];
  sleeps: number[];
  clock: { now: number };
  engine: ReturnType<typeof createChangeEngine>;
  policy: PolicyCheck | undefined;
  /** Another engine on a second connection to the same store file (another server). */
  second: () => { store: Store; engine: ReturnType<typeof createChangeEngine>; calls: Call[] };
  close: () => void;
}

export const makeRig = (
  o: {
    world?: FakeWorld;
    hooks?: FakeGoogleHooks;
    policy?: PolicyCheck | null;
    client?: Partial<AdsClientConfig>;
    engine?: Partial<EngineOptions>;
    /** Waits move the fake clock forward (for deadline tests). */
    clockSleeps?: boolean;
    /** Wrap the real (fake-fetch) client, e.g. to make calls take fake time. */
    wrapAds?: (ads: EngineAds, clock: { now: number }) => EngineAds;
  } = {},
): Rig => {
  const dir = mkdtempSync(path.join(tmpdir(), "perfoads-changes-"));
  const store = openStore(storePath(dir));
  const fake = createFakeGoogle(o.world ?? fakeWorld(), o.hooks ?? {});
  const clock = { now: T0 };
  const sleeps: number[] = [];
  const policy = o.policy === null ? undefined : (o.policy ?? permissiveTestPolicy());
  const build = (s: Store) => {
    const { client, calls } = makeClient(fake.router, { now: () => clock.now, ...o.client });
    const engine = createChangeEngine({
      store: s,
      ads: o.wrapAds ? o.wrapAds(client, clock) : client,
      ...(policy ? { policy } : {}),
      now: () => clock.now,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (o.clockSleeps) clock.now += ms;
      },
      ...o.engine,
    });
    return { engine, calls };
  };
  const main = build(store);
  const extra: Store[] = [];
  return {
    dir,
    store,
    fake,
    calls: main.calls,
    sleeps,
    clock,
    engine: main.engine,
    policy,
    second: () => {
      const s = openStore(storePath(dir));
      extra.push(s);
      return { store: s, ...build(s) };
    },
    close: () => {
      for (const s of extra) s.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

export const AGENT = { actor: "agent", via: "mcp" } as const;

export const budgetChange = (
  amount: string | number = "12.50",
  extra: Record<string, unknown> = {},
) => ({
  customerId: "1234567890",
  type: "update_budget",
  input: { budget_id: "222", daily_amount: amount, ...extra },
  ...AGENT,
});

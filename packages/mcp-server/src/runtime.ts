// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  classifyAccessError,
  createAdsClient,
  createMemoryOpsCounter,
  createMerchantClient,
  createRedactingLogger,
  createStderrLogger,
  DAILY_OPS_LIMITS,
  dailyLimitLine,
  dailyLimitOf,
  MERCHANT_SCOPE,
  normalizeCustomerId,
  type AccessIssue,
  type AccessLevel,
  type AdsAccount,
  type AdsClient,
  type DiscoverResult,
  type FetchFn,
  type Logger,
  type MerchantClient,
  type OpsCounter,
  type OpsKind,
  type OpsLimits,
  type OpsPool,
  type TokenProvider,
} from "@perfoads/ads-client";
import {
  type CommandRunner,
  type ConfigDir,
  createStoreOpsCounter,
  credentialsInfo,
  describeKeyLocation,
  getDataKey,
  howToRun,
  type KeyBackend,
  keyBackendOf,
  listSavedAccounts,
  loadOAuthCredentials,
  type OAuthCredentials,
  openStore,
  readEnvCredentials,
  resolveConfigDir,
  runCommand,
  saveAccounts,
  type Store,
  StoreBusyError,
  StoreOpenError,
  storePath,
  StoreVersionError,
} from "@perfoads/store";
import {
  createChangeEngine,
  DEFAULT_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  pruneOldRecords,
  type ChangeEngine,
  type EngineAds,
  type EngineMerchant,
  type EngineOptions,
  type PolicyCheck,
  type PolicyDecision,
} from "@perfoads/changes";
import { createFilePolicy, createPolicySource, type FilePolicy } from "@perfoads/policy";
import {
  createApprovalService,
  timerSleep,
  type ApprovalMode,
  type ApprovalService,
  type Sleep,
} from "./approvals/service.js";
import { localUser } from "./approvals/sessions.js";
import { openLocalPage } from "./approvals/page.js";
import { createRefreshTokenProvider, OAuthError } from "./tokens.js";
import { cleanupSnapshots } from "@perfoads/snapshot";
import { loadPlugin, type PluginState } from "./plugin.js";

/** Every tool answers inside this time (Claude Desktop stops waiting at 240 s). */
export const TOOL_DEADLINE_MS = 120_000;
/** Per Google Ads read call, all retries included. Leaves room inside the tool deadline. */
export const ADS_READ_DEADLINE_MS = 90_000;
/** Longest a policy-dependent call waits for the AI app's workspace folders (roots). */
export const ROOTS_WAIT_MS = 3_000;
const ACCOUNTS_TTL_MS = 10 * 60 * 1000;

export type CredentialState =
  | {
      status: "ready";
      credentials: OAuthCredentials;
      source: "store" | "env";
      keyBackend: KeyBackend | undefined;
      keyLocation: string | undefined;
      /** Set when the OAuth app is in Testing mode (Google sent refresh_token_expires_in). */
      refreshTokenExpiresAt: string | undefined;
      /** credentials.updated_at when loaded: a newer value means `auth` ran again. */
      updatedAt: string | undefined;
    }
  | { status: "missing"; partialEnv: boolean }
  | { status: "error"; message: string };

export class NotSignedInError extends Error {
  constructor() {
    super(
      `No Google sign-in is saved yet. Run \`${howToRun("init")}\` in a terminal, then restart the AI app.`,
    );
    this.name = "NotSignedInError";
  }
}

export class AccountNotAllowedError extends Error {
  /** `policyReason`: the policy's own sentence (allowlist, broken policy file). */
  constructor(customerId: string, policyReason?: string) {
    super(
      policyReason ??
        `Account ${customerId} is not one this Google sign-in can reach. Run list_accounts to see the accounts you can use.`,
    );
    this.name = "AccountNotAllowedError";
  }
}

/**
 * The account list could not be read because Google's daily request limit is spent, so
 * whether this sign-in reaches the account is unknown: never "not reachable".
 */
export class AccountNotCheckedError extends Error {
  constructor(customerId: string, waitMs: number | undefined) {
    super(`Could not check account ${customerId}: ${dailyLimitLine(waitMs)} Try again then.`);
    this.name = "AccountNotCheckedError";
  }
}

/** The runtime was closed (server shutting down): the store is not opened again. */
export class RuntimeClosedError extends Error {
  constructor() {
    super("The server is shutting down. Start it again from your AI app.");
    this.name = "RuntimeClosedError";
  }
}

const NO_POLICY_DECISION: PolicyDecision = {
  allowed: false,
  tier: "blocked",
  reason:
    "Writes are off: no policy file allows writes for this account, so this server only reads. See the docs on the change policy file.",
  policy: "read-only (no policy file)",
};

/** Read-only everywhere (what the policy file gives when there is none). For tests and embedding. */
export const NO_POLICY_FILE: PolicyCheck = Object.freeze({
  name: "read-only (no policy file)",
  gate: () => NO_POLICY_DECISION,
  check: () => NO_POLICY_DECISION,
});

export const CONFIG_FILE = "config.json";

export interface ApprovalSettings {
  mode: ApprovalMode;
  /** false: the server never starts a browser opener; a person runs `approvals open <id>`. */
  openBrowser: boolean;
  problem: string | undefined;
}

/**
 * Reads config.json in the settings folder: approval_mode ("auto" | "code_only", missing =
 * auto) and open_browser (true | false, missing = true). Anything unreadable or out of range
 * = the stricter setting (code_only, no browser opener).
 */
export const readApprovalMode = (dir: string): ApprovalSettings => {
  const file = path.join(dir, CONFIG_FILE);
  if (!existsSync(file)) return { mode: "auto", openBrowser: true, problem: undefined };
  let parsed: { approval_mode?: unknown; open_browser?: unknown };
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as typeof parsed;
  } catch {
    return { mode: "code_only", openBrowser: false, problem: `${file} is not valid JSON` };
  }
  const problems: string[] = [];
  const m = parsed?.approval_mode;
  const mode: ApprovalMode =
    m === undefined ? "auto" : m === "auto" || m === "code_only" ? m : "code_only";
  if (m !== undefined && mode !== m) problems.push(`approval_mode must be "auto" or "code_only"`);
  const ob = parsed?.open_browser;
  const openBrowser = ob === undefined ? true : ob === true;
  if (ob !== undefined && typeof ob !== "boolean")
    problems.push("open_browser must be true or false");
  return {
    mode,
    openBrowser,
    problem: problems.length ? `${problems.join("; ")} in ${file}` : undefined,
  };
};

export interface RetentionSettings {
  /** Final records older than this many days leave the store at server start. */
  days: number;
  problem: string | undefined;
}

/**
 * Reads retention_days from config.json (default 180, allowed 30 to 3650). Not a whole
 * number: the default; out of range: the nearest allowed value. Both are reported.
 */
export const readRetentionDays = (dir: string): RetentionSettings => {
  const file = path.join(dir, CONFIG_FILE);
  const fallback = { days: DEFAULT_RETENTION_DAYS, problem: undefined };
  if (!existsSync(file)) return fallback;
  let value: unknown;
  try {
    value = (JSON.parse(readFileSync(file, "utf8")) as { retention_days?: unknown })
      ?.retention_days;
  } catch {
    return { days: DEFAULT_RETENTION_DAYS, problem: `${file} is not valid JSON` };
  }
  if (value === undefined) return fallback;
  const range = `${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS}`;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return {
      days: DEFAULT_RETENTION_DAYS,
      problem: `retention_days must be a whole number of days (${range}) in ${file}`,
    };
  }
  const days = Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, value));
  return days === value
    ? { days, problem: undefined }
    : { days, problem: `retention_days must be ${range} in ${file}; using ${days}` };
};

export interface RuntimeOptions {
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  cwd?: string;
  home?: string;
  fetch?: FetchFn;
  logger?: Logger;
  run?: CommandRunner;
  now?: () => number;
  /** Waits on the `now` clock (default a real timer). Tests with a manual clock move it. */
  sleep?: Sleep;
  /** How long to wait for another process's store lock before giving up (default 5000). */
  storeBusyTimeoutMs?: number;
  /**
   * Change policy. Default: policy.yaml in the settings folder (none = read-only). Tests
   * inject one; reads, the ops reserve and doctor still follow the file.
   */
  policy?: PolicyCheck;
  /** Opens the local approval page in a browser (default: the OS opener). Tests capture it. */
  openUrl?: (url: string) => boolean | Promise<boolean>;
  /** Overrides the config file's approval_mode (tests). */
  approvalMode?: ApprovalMode;
  /** Overrides the config file's open_browser (tests). */
  openBrowser?: boolean;
  /** Name recorded for approvals (default: the OS user name). */
  approvalUser?: string;
  /** How often a waiting apply_change looks for a decision (default 500 ms). */
  approvalPollMs?: number;
  /** cli: CLI commands (no start-folder rule; only valid policy loads are logged). Default server. */
  policyMode?: "server" | "cli";
  /** Engine timing seams for tests (waits). Never the store, the client or the policy. */
  engineTiming?: Pick<EngineOptions, "sleep" | "readBackDelaysMs">;
}

const ACCESS_LEVELS: readonly AccessLevel[] = ["test", "explorer", "basic", "standard", "unknown"];

const asAccessLevel = (value: string | undefined): AccessLevel | undefined => {
  const v = value?.trim().toLowerCase();
  return ACCESS_LEVELS.find((l) => l === v);
};

export const createRuntime = (options: RuntimeOptions = {}) => {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const doFetch: FetchFn = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? timerSleep;
  const run = options.run ?? runCommand;
  const configDir: ConfigDir = resolveConfigDir({ env, platform, home });
  const issuedTokens: string[] = [];
  let knownSecrets: string[] = [];
  const secrets = (): string[] => [...knownSecrets, ...issuedTokens];
  const logger = createRedactingLogger(options.logger ?? createStderrLogger(), secrets);

  let store: Store | undefined;
  let closed = false;
  let credentialState: CredentialState | undefined;
  let tokenProvider: TokenProvider | undefined;
  let ads: AdsClient | undefined;
  let accountsCache: { at: number; result: DiscoverResult } | undefined;
  let lastAccessIssue: { issue: AccessIssue; message: string } | undefined;

  const getStore = (): Store => {
    if (closed) throw new RuntimeClosedError();
    store ??= openStore(storePath(configDir.dir), {
      ...(options.storeBusyTimeoutMs === undefined
        ? {}
        : { busyTimeoutMs: options.storeBusyTimeoutMs }),
      ownerOnly: { platform, run, env },
      warn: (m) => logger.warn(m),
    });
    return store;
  };

  const accessLevel = (): { level: AccessLevel; source: "env" | "store" | "default" } => {
    const fromEnv = asAccessLevel(env.PERFOADS_MCP_ACCESS_LEVEL);
    if (fromEnv) return { level: fromEnv, source: "env" };
    try {
      const fromStore = asAccessLevel(getStore().getMeta("access_level"));
      if (fromStore) return { level: fromStore, source: "store" };
    } catch {
      // The store problem is reported by doctor; the level just stays unknown.
    }
    return { level: "unknown", source: "default" };
  };

  /** Daily limits per pool (test accounts, production accounts) for the configured level. */
  const opsLimits: OpsLimits = DAILY_OPS_LIMITS[accessLevel().level];
  /**
   * Which Google Cloud project (its OAuth client) and access level a saved daily-limit wait
   * is for: a new sign-in client or level does not inherit the old wait.
   */
  const limitScope = (): string => {
    let clientId = "";
    try {
      const state = credentials();
      if (state.status === "ready") clientId = state.credentials.clientId;
    } catch {
      // no readable sign-in: a scope of its own
    }
    return createHash("sha256")
      .update(`${clientId}\n${accessLevel().level}`)
      .digest("hex")
      .slice(0, 16);
  };
  const limitOptions = { limits: opsLimits, now, scope: limitScope };
  /**
   * customer.test_account per customer id: from account discovery, first seeded from the
   * saved account list. An account not known yet counts as production (the stricter pool).
   */
  const testAccounts = new Map<string, boolean>();
  let testAccountsSeeded = false;
  /** undefined = not known yet (counted as production; no saved daily-limit wait applies). */
  const opsPool = (customerId: string | undefined): OpsPool | undefined => {
    if (customerId === undefined) return undefined;
    if (!testAccountsSeeded) {
      try {
        for (const a of listSavedAccounts(getStore())) {
          if (!testAccounts.has(a.customerId)) testAccounts.set(a.customerId, a.isTestAccount);
        }
        testAccountsSeeded = true;
      } catch {
        // Store not readable now: tried again with the next request.
      }
    }
    const isTest = testAccounts.get(customerId);
    return isTest === undefined ? undefined : isTest ? "test" : "production";
  };
  let storeOps: OpsCounter | undefined;
  let memoryOps: OpsCounter | undefined;
  /**
   * The store's ops counter: shared by every server process on this store, for reads and
   * writes. Only when the store can't be opened at all (reads still work then, writes
   * don't) is the count kept in memory. A busy store is not a reason to switch.
   */
  const opsBackend = (): OpsCounter => {
    if (storeOps) return storeOps;
    try {
      storeOps = createStoreOpsCounter(getStore(), limitOptions);
      return storeOps;
    } catch (err) {
      if (!(err instanceof StoreOpenError || err instanceof StoreVersionError)) throw err;
      if (!memoryOps)
        logger.warn("store unavailable: Google Ads operations counted in memory only");
      memoryOps ??= createMemoryOpsCounter(limitOptions);
      return memoryOps;
    }
  };
  /** Counts that could not reach the store yet (busy at the first count); saved with the next one. */
  const pending: { n: number; kind: OpsKind; pool: OpsPool }[] = [];
  const pendingSum = (pool: OpsPool): number =>
    pending.filter((p) => p.pool === pool).reduce((sum, p) => sum + p.n, 0);
  /** One count per pool (no pool = production), each against its own daily limit. */
  const opsCounter: OpsCounter = {
    record: (n, kind, pool = "production") => {
      if (!Number.isInteger(n) || n <= 0) return;
      try {
        const backend = opsBackend();
        for (const p of pending.splice(0)) backend.record(p.n, p.kind, p.pool);
        backend.record(n, kind, pool);
      } catch {
        // Never throws after Google answered: kept and saved with the next count.
        pending.push({ n, kind, pool });
      }
    },
    used: (pool = "production") => opsBackend().used(pool) + pendingSum(pool),
    remaining: (pool = "production") => {
      const left = opsBackend().remaining(pool);
      return left === null ? null : Math.max(0, left - pendingSum(pool));
    },
    limitReached: (untilMs, pool = "production") => {
      try {
        opsBackend().limitReached?.(untilMs, pool);
      } catch {
        // never throws after Google answered
      }
    },
    limitUntil: (pool = "production") => opsBackend().limitUntil?.(pool) ?? null,
    // counts not saved yet are the newest: they leave last, so they only add to n
    freesAt: (n, pool = "production") => opsBackend().freesAt?.(n + pendingSum(pool), pool) ?? null,
    refilled: (atMs, pool = "production") => {
      try {
        opsBackend().refilled?.(atMs, pool);
      } catch {
        // never throws after Google answered
      }
    },
  };

  const keyDeps = { configDir: configDir.dir, platform, env, run };

  /** Workspace folders the AI app shared (roots): a policy file inside one is ignored. */
  let workspaceRoots: readonly string[] = [];
  /** The first roots/list answer (bounded); policy-dependent calls wait for it once. */
  let rootsPending: Promise<unknown> | undefined;
  const rootsReady = async (): Promise<void> => {
    const pending = rootsPending;
    if (!pending) return;
    // Waits on the runtime clock (sleep), so a test clock drives it without real time.
    const stop = new AbortController();
    await Promise.race([pending.catch(() => undefined), sleep(ROOTS_WAIT_MS, stop.signal)]);
    stop.abort();
    if (rootsPending === pending) rootsPending = undefined;
  };
  const policySource = createPolicySource({
    configDir: configDir.dir,
    cwd,
    home,
    platform,
    mode: options.policyMode ?? "server",
    roots: () => workspaceRoots,
    store: getStore,
    now,
    warn: (m) => logger.warn(m),
    info: (m) => logger.info(m),
  });
  /** policy.yaml from the settings folder, re-read on every check. */
  const filePolicy: FilePolicy = createFilePolicy(policySource);
  const policy: PolicyCheck = options.policy ?? filePolicy;
  /**
   * Reads (tool client, new proposals) stop before the operations the policy keeps for
   * changes, in each pool against that pool's own limit.
   */
  const reserveCounter = (share: "read" | "undo"): OpsCounter => ({
    record: (n, kind, pool) => opsCounter.record(n, kind, pool),
    used: (pool) => opsCounter.used(pool),
    remaining: (pool) => opsCounter.remaining(pool),
    limitReached: (untilMs, pool) => opsCounter.limitReached?.(untilMs, pool),
    limitUntil: (pool) => opsCounter.limitUntil?.(pool) ?? null,
    freesAt: (n, pool) => opsCounter.freesAt?.(n, pool) ?? null,
    refilled: (atMs, pool) => opsCounter.refilled?.(atMs, pool),
    admit: (n, _kind, pool = "production") =>
      filePolicy.readRefusal(opsCounter.used(pool), n, opsLimits[pool], share, pool),
  });
  const readOpsCounter = reserveCounter("read");
  /** Undo proposals may use the whole reserve (undoing must work when reads have stopped). */
  const undoOpsCounter = reserveCounter("undo");

  /** approval_mode from config.json in the settings folder, read once at start. */
  const fromFile = readApprovalMode(configDir.dir);
  const approvalSettings: ApprovalSettings = {
    mode: options.approvalMode ?? fromFile.mode,
    openBrowser: options.openBrowser ?? fromFile.openBrowser,
    problem: options.approvalMode === undefined ? fromFile.problem : undefined,
  };

  /** Reads credentials (env first, then the encrypted store). Never throws. */
  const credentials = (): CredentialState => {
    if (credentialState?.status === "ready") return credentialState;
    const fromEnv = readEnvCredentials(env);
    if (fromEnv && fromEnv !== "partial") {
      credentialState = {
        status: "ready",
        credentials: fromEnv,
        source: "env",
        keyBackend: undefined,
        keyLocation: undefined,
        refreshTokenExpiresAt: undefined,
        updatedAt: undefined,
      };
    } else {
      try {
        const s = getStore();
        const info = credentialsInfo(s);
        if (info.saved.length < 3) {
          credentialState = { status: "missing", partialEnv: fromEnv === "partial" };
        } else {
          const dataKey = getDataKey(keyDeps, s, { create: false });
          const backend = keyBackendOf(s);
          const creds = dataKey ? loadOAuthCredentials(s, dataKey.key) : undefined;
          credentialState = creds
            ? {
                status: "ready",
                credentials: creds,
                source: "store",
                keyBackend: backend,
                keyLocation: backend ? describeKeyLocation(backend, configDir.dir) : undefined,
                refreshTokenExpiresAt: info.refreshTokenExpiresAt,
                updatedAt: info.updatedAt,
              }
            : { status: "missing", partialEnv: fromEnv === "partial" };
        }
      } catch (err) {
        const state: CredentialState = {
          status: "error",
          message:
            err instanceof Error
              ? err.message
              : `The local store at ${storePath(configDir.dir)} could not be read.`,
        };
        // Busy passes once the other process lets go: read again next time.
        if (err instanceof StoreBusyError) return state;
        credentialState = state;
      }
    }
    if (credentialState.status === "ready") {
      const c = credentialState.credentials;
      knownSecrets = [...new Set([...knownSecrets, c.clientSecret, c.refreshToken])];
    }
    return credentialState;
  };

  /** Forgets loaded credentials so the next call reads them again (after `auth` or `reset`). */
  const reloadCredentials = (): void => {
    credentialState = undefined;
    tokenProvider = undefined;
    accountsCache = undefined;
  };

  /** updated_at of the saved credentials now, for spotting a new sign-in. */
  const savedStamp = (): string | undefined => {
    try {
      return credentialsInfo(getStore()).updatedAt;
    } catch {
      return undefined;
    }
  };

  const innerProvider = (): TokenProvider => {
    if (tokenProvider) return tokenProvider;
    const state = credentials();
    if (state.status === "error") throw new Error(state.message);
    if (state.status !== "ready") throw new NotSignedInError();
    tokenProvider = createRefreshTokenProvider({
      credentials: state.credentials,
      fetch: doFetch,
      now,
      onIssued: (t) => {
        issuedTokens.push(t);
        if (issuedTokens.length > 32) issuedTokens.shift();
      },
    });
    return tokenProvider;
  };

  /**
   * The provider the ads client keeps for the life of the server. It notices a new sign-in
   * (`auth` run in a terminal) without a restart: when the saved credentials changed, and
   * once more when Google refuses the refresh token (invalid_grant).
   */
  const stableProvider: TokenProvider = {
    getAccessToken: async (o) => {
      const state = credentialState;
      if (
        state?.status === "ready" &&
        state.source === "store" &&
        savedStamp() !== state.updatedAt
      ) {
        reloadCredentials();
      }
      try {
        return await innerProvider().getAccessToken(o);
      } catch (err) {
        if (!(err instanceof OAuthError && err.code === "invalid_grant")) throw err;
        const before =
          credentialState?.status === "ready" ? credentialState.credentials : undefined;
        reloadCredentials();
        const after = credentials();
        if (after.status !== "ready" || after.credentials.refreshToken === before?.refreshToken) {
          throw err;
        }
        return innerProvider().getAccessToken(o);
      }
    },
    grantedScopes: async () => {
      await stableProvider.getAccessToken();
      return innerProvider().grantedScopes?.();
    },
  };

  const tokens = (): TokenProvider => {
    innerProvider(); // throws a plain error when there is no usable sign-in
    return stableProvider;
  };

  const adsClient = (): AdsClient => {
    ads ??= createAdsClient({
      tokens: tokens(),
      fetch: doFetch,
      logger,
      opsCounter: readOpsCounter,
      opsPool,
      deadlineMs: ADS_READ_DEADLINE_MS,
      now,
    });
    return ads;
  };

  let undoAdsClient: AdsClient | undefined;
  const undoClient = (): AdsClient => {
    undoAdsClient ??= createAdsClient({
      tokens: tokens(),
      fetch: doFetch,
      logger,
      opsCounter: undoOpsCounter,
      opsPool,
      deadlineMs: ADS_READ_DEADLINE_MS,
      now,
    });
    return undoAdsClient;
  };

  /** The change engine's client: may use the operations kept for changes (its reads too). */
  let engineAdsClient: AdsClient | undefined;
  const changeAdsClient = (): AdsClient => {
    engineAdsClient ??= createAdsClient({
      tokens: tokens(),
      fetch: doFetch,
      logger,
      opsCounter,
      opsPool,
      deadlineMs: ADS_READ_DEADLINE_MS,
      now,
    });
    return engineAdsClient;
  };

  /** Remembers access problems Google reports: that is how the access level shows itself. */
  const noteError = (err: unknown): void => {
    const access = classifyAccessError(err);
    if (access) lastAccessIssue = access;
  };

  /** forChanges: for the change tools (may use the operations the policy keeps for changes). */
  const accounts = async (
    opts: { refresh?: boolean; forChanges?: boolean } = {},
  ): Promise<DiscoverResult> => {
    if (!opts.refresh && accountsCache && now() - accountsCache.at < ACCOUNTS_TTL_MS) {
      return accountsCache.result;
    }
    let result: DiscoverResult;
    try {
      result = await (opts.forChanges ? changeAdsClient() : adsClient()).discoverAccounts();
    } catch (err) {
      noteError(err);
      throw err;
    }
    for (const a of result.accounts) testAccounts.set(a.customerId, a.isTestAccount);
    // a list cut short by the project's daily limit is neither kept nor saved: it would hide
    // accounts after the refill. One account's own limit only keeps the list from being saved
    // (kept, so each call does not read every account again); the saved list is what
    // resolveAccount falls back on meanwhile
    if (result.failures.some((f) => f.dailyLimit?.project)) return result;
    accountsCache = { at: now(), result };
    if (result.failures.some((f) => f.dailyLimit)) return result;
    try {
      saveAccounts(getStore(), result.accounts);
    } catch {
      logger.warn("could not save the account list to the local store");
    }
    return result;
  };

  /**
   * The account a tool may work on, with the login-customer-id it needs.
   * Any account this sign-in reaches (directly or under a manager); with a valid policy
   * file only those in accounts.allow or accounts.write.
   */
  const resolveAccount = async (
    customerId: string,
    opts: { forChanges?: boolean } = {},
  ): Promise<AdsAccount> => {
    const id = normalizeCustomerId(customerId);
    await rootsReady();
    const denial = filePolicy.readDenial(id);
    if (denial) throw new AccountNotAllowedError(id, denial);
    /**
     * The daily limit stopped the account list: the account as last saved, if it was there
     * (a test account has a limit of its own, so a spent live one must not lock it out).
     * hiddenBy: the ids whose read the limit stopped; undefined = the whole list was stopped.
     * A saved account whose own read and manager's read both went through is out of reach.
     */
    const savedOrUnchecked = (
      waitMs: number | undefined,
      hiddenBy?: ReadonlySet<string>,
    ): AdsAccount => {
      let saved: AdsAccount | undefined;
      try {
        saved = listSavedAccounts(getStore()).find((a) => a.customerId === id);
      } catch {
        // store not readable now: not checked
      }
      if (!saved) throw new AccountNotCheckedError(id, waitMs);
      if (hiddenBy && !hiddenBy.has(saved.customerId) && !hiddenBy.has(saved.loginCustomerId)) {
        throw new AccountNotAllowedError(id);
      }
      testAccounts.set(saved.customerId, saved.isTestAccount);
      return saved;
    };
    let list: DiscoverResult;
    try {
      list = await accounts(opts);
    } catch (err) {
      const limit = dailyLimitOf(err);
      if (limit) return savedOrUnchecked(limit.waitMs);
      throw err;
    }
    const found = list.accounts.find((a) => a.customerId === id);
    if (found) return found;
    // a failed account read because the limit is spent says nothing about the accounts it
    // would have shown (the account itself, or those under a manager)
    const limited = list.failures.filter((f) => f.dailyLimit);
    if (limited.length > 0) {
      return savedOrUnchecked(
        limited[0]?.dailyLimit?.waitMs,
        new Set(limited.map((f) => f.customerId)),
      );
    }
    throw new AccountNotAllowedError(id);
  };

  /** The engine reaches Google only when a change needs it, so `approve` works signed out. */
  const lazyAds: EngineAds = {
    searchAll: (p) => changeAdsClient().searchAll(p),
    mutateAll: (ops, o) => changeAdsClient().mutateAll(ops, o),
  };
  /** New proposals read (and validate) through the reserve-aware client, like any read. */
  const proposeAds: EngineAds = {
    searchAll: (p) => adsClient().searchAll(p),
    mutateAll: (ops, o) => adsClient().mutateAll(ops, o),
  };
  /** Merchant Center on the same sign-in (tag_exclude); its access is opt-in (scope). */
  let merchantClient: MerchantClient | undefined;
  const merchantFor = (): MerchantClient =>
    (merchantClient ??= createMerchantClient({
      tokens: tokens(),
      fetch: doFetch,
      logger,
      deadlineMs: ADS_READ_DEADLINE_MS,
      now,
    }));
  const lazyMerchant: EngineMerchant = {
    scopeGranted: async () => {
      const scopes = await tokens().grantedScopes?.();
      return scopes === undefined ? undefined : scopes.includes(MERCHANT_SCOPE);
    },
    listDataSources: (m) => merchantFor().listDataSources(m),
    listProducts: (m, o) => merchantFor().listProducts(m, o),
    createSupplementalSource: (m, p) => merchantFor().createSupplementalSource(m, p),
    setCustomLabel: (m, p, slot, value, source) =>
      merchantFor().setCustomLabel(m, p, slot, value, source),
    clearCustomLabel: (m, p, slot, source) => merchantFor().clearCustomLabel(m, p, slot, source),
  };
  let engine: ChangeEngine | undefined;
  const changeEngine = (): ChangeEngine =>
    (engine ??= createChangeEngine({
      store: getStore(),
      ads: lazyAds,
      merchant: lazyMerchant,
      proposeAds,
      undoAds: {
        searchAll: (p) => undoClient().searchAll(p),
        mutateAll: (ops, o) => undoClient().mutateAll(ops, o),
      },
      policy,
      now,
      logger,
      ...options.engineTiming,
    }));

  let approvalService: ApprovalService | undefined;
  const approvals = (): ApprovalService =>
    (approvalService ??= createApprovalService({
      store: getStore,
      engine: changeEngine,
      now,
      openUrl: options.openUrl ?? ((url) => openLocalPage(url, platform)),
      user: () => options.approvalUser ?? localUser(),
      logger,
      mode: approvalSettings.mode,
      openBrowser: approvalSettings.openBrowser,
      policyLines: (change) => changeEngine().policyLines(change.id),
      sleep,
      ...(options.approvalPollMs === undefined ? {} : { pollMs: options.approvalPollMs }),
    }));

  /**
   * At server start: changes left `applying` by a stopped server become in_doubt and every
   * in_doubt change is re-checked by reading (never sent again). Never throws.
   */
  const reconcileChanges = async (): Promise<void> => {
    try {
      const open = getStore()
        .db.prepare("SELECT 1 FROM changes WHERE status IN ('applying', 'in_doubt') LIMIT 1")
        .get();
      if (!open) return;
      await changeEngine().reconcile();
    } catch {
      logger.warn("could not re-check unfinished changes at start; they are re-checked later");
    }
  };

  const retention = readRetentionDays(configDir.dir);

  /**
   * At server start: final records older than retention_days leave the store (logged in
   * the audit log first), and temp files of unfinished snapshot saves go. Never throws.
   */
  const pruneAtStart = (): void => {
    try {
      cleanupSnapshots({ configDir: configDir.dir, cwd, now, platform });
    } catch {
      logger.warn("could not clean up old snapshot files");
    }
    try {
      const result = pruneOldRecords(getStore(), { now: now(), retentionDays: retention.days });
      const n = Object.values(result.counts).reduce((a, b) => a + b, 0);
      if (n > 0) {
        logger.info("removed records older than retention_days", {
          retentionDays: retention.days,
          ...result.counts,
        });
      }
    } catch {
      logger.warn("could not remove records older than retention_days; tried again next start");
    }
  };

  /** At server start: loads (and logs) the policy; says so on stderr when writes are off for a reason. */
  const loadPolicy = (): void => {
    const state = filePolicy.state();
    if (state.status === "invalid") {
      logger.warn("policy file is not valid: the server is read-only. Run `policy check`.");
    } else if (state.status === "ignored") {
      logger.warn(
        "policy file is inside a folder the AI works in: ignored, the server is read-only",
      );
    }
  };

  /** The plugin config.json names (pro_plugin): loaded once, its outcome logged once. */
  let pluginLoad: Promise<PluginState> | undefined;
  let pluginState: PluginState | undefined;
  const loadPluginOnce = (): Promise<PluginState> => {
    pluginLoad ??= loadPlugin(configDir.dir, { platform }).then((state) => {
      pluginState = state;
      if (state.status === "failed")
        logger.warn(`pro plugin not loaded (${state.reason}); running without it`);
      else if (state.status === "loaded")
        logger.info(`pro plugin loaded: ${state.plugin.name} ${state.plugin.version}`);
      return state;
    });
    return pluginLoad;
  };

  return {
    configDir,
    env,
    platform,
    home,
    cwd,
    fetch: doFetch,
    now,
    sleep,
    run,
    logger,
    opsCounter,
    /** Today's limits per pool (test accounts, production accounts); null = none. */
    opsLimits,
    keyDeps,
    store: getStore,
    accessLevel,
    credentials,
    tokens,
    ads: adsClient,
    accounts,
    resolveAccount,
    noteError,
    reloadCredentials,
    lastAccessIssue: () => lastAccessIssue,
    secrets,
    engine: changeEngine,
    policy: () => policy,
    policyFile: filePolicy,
    loadPolicy,
    /** Loads the plugin once (later calls get the same answer). Never rejects. */
    loadPlugin: loadPluginOnce,
    /** The plugin's state once loadPlugin finished; undefined before (= no plugin). */
    plugin: (): PluginState | undefined => pluginState,
    setWorkspaceRoots: (roots: readonly string[]) => {
      workspaceRoots = [...roots];
    },
    /** A roots/list request in flight: policy-dependent calls wait for it (up to 3 s). */
    setRootsPending: (p: Promise<unknown>) => {
      rootsPending = p;
    },
    rootsReady,
    approvals,
    reconcileChanges,
    pruneAtStart,
    retentionSettings: () => retention,
    approvalUser: () => options.approvalUser ?? localUser(),
    approvalSettings: () => approvalSettings,
    close: () => {
      approvalService?.closeAll();
      closed = true;
      store?.close();
      store = undefined;
    },
  };
};

export type Runtime = ReturnType<typeof createRuntime>;

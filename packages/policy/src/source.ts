// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Where the policy comes from: policy.yaml in the settings folder only (PERFOADS_MCP_HOME,
// %APPDATA%\perfoads-mcp, $XDG_CONFIG_HOME/perfoads-mcp or ~/.config/perfoads-mcp). The
// file is read again on every check (it is small) and parsed again whenever its hash
// changes, so an edit - the kill switch too - counts from the next check on. Each new
// version is logged (policy_loaded, with the file name and its hash) and kept by hash in
// the store, so a change proposed under one version can be judged by it again at apply.
//
// Ignored (= read-only, and no wider reads than the last valid version allowed): a file
// inside a workspace folder the AI app shares (roots), a file inside the server's start
// folder when that folder sits strictly below the user's home (a project), and a file
// with more than one hard link. A start folder that is home itself, above it or a
// filesystem root only gives a doctor warning. CLI commands don't apply the start-folder
// rule; they say when the server would ignore the file.

import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { appendEvent, canonicalJson } from "@perfoads/changes";
import { isInside, type Store } from "@perfoads/store";
import {
  parsePolicyText,
  POLICY_FILE,
  POLICY_MAX_BYTES,
  PolicySchema,
  type PolicyV1,
} from "./schema.js";

/** A plain note about where the file sits (doctor warning, or "would be ignored" for the CLI). */
interface Noted {
  note?: string | undefined;
}

export type PolicyState =
  | ({ status: "none"; file: string } & Noted)
  | ({ status: "invalid"; file: string; hash: string | null; problems: string[] } & Noted)
  | ({
      status: "ignored";
      file: string;
      reason: string;
      folder: string;
      /** The ignored file's own content when it parses (used only to narrow reads). */
      parsed?: PolicyV1 | undefined;
    } & Noted)
  | ({ status: "valid"; file: string; hash: string; policy: PolicyV1 } & Noted);

export interface PolicySourceOptions {
  /** The settings folder (resolveConfigDir). */
  configDir: string;
  /** The server's start folder: a policy inside it is ignored when it is a project (below home). */
  cwd: string;
  /** The user's home folder (default: os.homedir()). */
  home?: string;
  /** server (default) or cli: the CLI skips the start-folder rule and logs only valid loads. */
  mode?: "server" | "cli";
  /** Workspace folders the AI app shared (roots): a policy inside one is ignored. */
  roots?: () => readonly string[];
  platform?: NodeJS.Platform;
  /** For the policy_loaded log and the policy_versions table. Errors are tolerated. */
  store?: () => Store;
  now?: () => number;
  warn?: (message: string) => void;
  /** Local stderr log (gets the full path; the audit log only gets the file name). */
  info?: (message: string) => void;
}

const isFilesystemRoot = (p: string, platform: NodeJS.Platform): boolean => {
  const api = platform === "win32" ? path.win32 : path.posix;
  const r = api.resolve(p);
  return api.parse(r).root === r;
};

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** `file` sits in `folder` (symlinks count: both are also compared resolved). */
const holds = (folder: string, file: string, platform: NodeJS.Platform): boolean => {
  const api = platform === "win32" ? path.win32 : path.posix;
  const files = [file, real(file), api.join(real(api.dirname(file)), api.basename(file))];
  return [folder, real(folder)].some((f) => files.some((x) => isInside(x, f, platform)));
};

/** The workspace roots (AI app folders) that contain `file`. Strict: any of them = ignored. */
export const workspaceFoldersHolding = (
  file: string,
  roots: readonly string[],
  platform: NodeJS.Platform,
): string[] => roots.filter((folder) => holds(folder, file, platform));

/** True when `folder` is strictly below `home` (a project folder, not home itself or above). */
export const isBelowHome = (folder: string, home: string, platform: NodeJS.Platform): boolean => {
  const api = platform === "win32" ? path.win32 : path.posix;
  const norm = (p: string) => {
    const r = api.resolve(p);
    return platform === "win32" || platform === "darwin" ? r.toLowerCase() : r;
  };
  return norm(folder) !== norm(home) && isInside(folder, home, platform);
};

export type StartFolderVerdict = "ignore" | "warn" | "none";

/**
 * The start-folder rule: the file inside the start folder -> "ignore" when that folder is
 * strictly below home (a project), "warn" when it is home itself or above it, "none" when
 * the file is not inside it or the folder is a filesystem root.
 */
export const startFolderVerdict = (
  file: string,
  cwd: string,
  home: string,
  platform: NodeJS.Platform,
): StartFolderVerdict => {
  if (isFilesystemRoot(cwd, platform) || !holds(cwd, file, platform)) return "none";
  return isBelowHome(cwd, home, platform) || isBelowHome(real(cwd), real(home), platform)
    ? "ignore"
    : "warn";
};

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Reads at most POLICY_MAX_BYTES + 1 bytes (+ its hard-link count). undefined when missing. */
const readSmall = (file: string): { bytes: Buffer; links: number } | undefined => {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error("not a regular file");
    const buf = Buffer.alloc(POLICY_MAX_BYTES + 1);
    let n = 0;
    for (;;) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0 || n + got >= buf.length) {
        n += got;
        break;
      }
      n += got;
    }
    return { bytes: buf.subarray(0, n), links: st.nlink };
  } finally {
    closeSync(fd);
  }
};

/** Reads and parses one policy file (no workspace check). For `policy check <file>`. */
export const readPolicyFile = (file: string): PolicyState & { links?: number } => {
  let got: { bytes: Buffer; links: number } | undefined;
  try {
    got = readSmall(file);
  } catch (err) {
    return {
      status: "invalid",
      file,
      hash: null,
      problems: [`the file can't be read (${err instanceof Error ? err.message : "error"})`],
    };
  }
  if (got === undefined) return { status: "none", file };
  const { bytes, links } = got;
  const hash = sha256(bytes);
  if (bytes.length > POLICY_MAX_BYTES) {
    return { status: "invalid", file, hash, problems: ["the file is larger than 64 KB"] };
  }
  const text = bytes.toString("utf8");
  if (text.includes("�")) {
    return { status: "invalid", file, hash, problems: ["the file is not UTF-8 text"] };
  }
  const parsed = parsePolicyText(text);
  return parsed.ok
    ? { status: "valid", file, hash, policy: parsed.policy, links }
    : { status: "invalid", file, hash, problems: parsed.problems, links };
};

export const policyPath = (configDir: string): string => path.join(configDir, POLICY_FILE);

export interface PolicySource {
  /** The policy in force right now (re-reads the file; never throws). */
  current(): PolicyState;
  /** A policy version seen before, by hash (memory, then the store). */
  byHash(hash: string): PolicyV1 | undefined;
  /** The last valid version loaded (this process, else the audit log), if any. */
  lastValid(): { hash: string; policy: PolicyV1 } | undefined;
  readonly file: string;
}

export const createPolicySource = (o: PolicySourceOptions): PolicySource => {
  const platform = o.platform ?? process.platform;
  const mode = o.mode ?? "server";
  const home = o.home ?? homedir();
  const file = policyPath(o.configDir);
  const now = o.now ?? Date.now;
  const known = new Map<string, PolicyV1>();
  let cached: { key: string; state: PolicyState } | undefined;
  let lastValidSeen: { hash: string; policy: PolicyV1 } | undefined;
  let lastLogged: string | undefined;

  const record = (state: PolicyState): void => {
    const key =
      state.status === "valid" || state.status === "invalid"
        ? `${state.status}:${state.hash ?? ""}`
        : state.status;
    if (key === lastLogged || !o.store) return;
    // The CLI only records a valid version it read (never a misleading "ignored").
    if (mode === "cli" && state.status !== "valid") return;
    try {
      const store = o.store();
      // Inside another transaction (a claim) the event could be rolled back with it:
      // record it on the next check outside one (the hash stays known in memory).
      if (store.inTransaction()) return;
      const at = new Date(now()).toISOString();
      store.immediate(() => {
        if (state.status === "valid") {
          store.db
            .prepare(
              "INSERT OR IGNORE INTO policy_versions (hash, body, first_loaded_at) VALUES (?, ?, ?)",
            )
            .run(state.hash, canonicalJson(state.policy), at);
        }
        appendEvent(
          store,
          {
            changeId: null,
            event: "policy_loaded",
            actor: mode,
            via: "policy",
            data: {
              status: state.status,
              hash: state.status === "valid" || state.status === "invalid" ? state.hash : null,
              file: POLICY_FILE,
              ...(state.status === "invalid" ? { problems: state.problems } : {}),
              ...(state.status === "ignored" ? { reason: state.reason } : {}),
            },
          },
          at,
        );
      });
      lastLogged = key;
      o.info?.(`policy ${state.status} (${state.file})`);
    } catch {
      o.warn?.("could not record the policy version in the local store");
    }
  };

  const ignored = (reason: string, folder: string, parsed?: PolicyV1): PolicyState => {
    const content =
      parsed ??
      (() => {
        const r = readPolicyFile(file);
        return r.status === "valid" ? r.policy : undefined;
      })();
    return { status: "ignored", file, reason, folder, ...(content ? { parsed: content } : {}) };
  };

  const current = (): PolicyState => {
    const inRoot = workspaceFoldersHolding(file, o.roots?.() ?? [], platform);
    const start = startFolderVerdict(file, o.cwd, home, platform);
    let state: PolicyState;
    if (inRoot.length > 0) {
      state = ignored(
        "the policy file is inside a workspace folder your AI app shares, so it is ignored and this server is read-only. Keep the settings folder outside your projects.",
        inRoot[0] ?? "",
      );
    } else if (start === "ignore" && mode === "server") {
      state = ignored(
        "the policy file is inside the project folder the server was started in, so it is ignored and this server is read-only. Keep the settings folder outside your projects.",
        o.cwd,
      );
    } else {
      const read = readPolicyFile(file);
      const key =
        read.status === "valid" || read.status === "invalid"
          ? `${read.status}:${read.hash ?? ""}`
          : read.status;
      if ((read.status === "valid" || read.status === "invalid") && (read.links ?? 1) > 1) {
        state = ignored(
          "the policy file has more than one hard link, so another copy of it could sit in a project folder; it is ignored and this server is read-only. Make it a single file: copy it, delete the original, rename the copy.",
          "",
          read.status === "valid" ? read.policy : undefined,
        );
      } else {
        // Same bytes as last time: keep the parsed object (stable identity for callers).
        state = cached?.key === key ? cached.state : read;
        cached = { key, state };
      }
    }
    if (start === "ignore" && mode === "cli") {
      state = {
        ...state,
        note: `It would be ignored if your AI app works in ${o.cwd} (the settings folder is inside it).`,
      };
    } else if (start === "warn") {
      state = {
        ...state,
        note: `The settings folder is inside ${o.cwd} (your home folder or above). If your AI app works there, it can edit the policy.`,
      };
    }
    if (state.status === "valid") {
      known.set(state.hash, state.policy);
      lastValidSeen = { hash: state.hash, policy: state.policy };
    }
    record(state);
    return state;
  };

  const byHash = (hash: string): PolicyV1 | undefined => {
    const hit = known.get(hash);
    if (hit) return hit;
    if (!o.store) return undefined;
    try {
      const row = o
        .store()
        .db.prepare("SELECT body FROM policy_versions WHERE hash = ?")
        .get(hash) as { body: string } | undefined;
      if (!row) return undefined;
      const parsed = PolicySchema.safeParse(JSON.parse(row.body));
      if (!parsed.success) return undefined;
      known.set(hash, parsed.data);
      return parsed.data;
    } catch {
      return undefined;
    }
  };

  const lastValid = (): { hash: string; policy: PolicyV1 } | undefined => {
    if (lastValidSeen) return lastValidSeen;
    if (!o.store) return undefined;
    try {
      const rows = o
        .store()
        .db.prepare(
          "SELECT data FROM audit_log WHERE event = 'policy_loaded' ORDER BY seq DESC LIMIT 500",
        )
        .all() as { data: string }[];
      for (const r of rows) {
        const d = JSON.parse(r.data) as { status?: unknown; hash?: unknown };
        if (d.status !== "valid" || typeof d.hash !== "string") continue;
        const policy = byHash(d.hash);
        if (policy) return { hash: d.hash, policy };
      }
    } catch {
      // Unknown: callers treat it as "never valid".
    }
    return undefined;
  };

  return { current, byHash, lastValid, file };
};

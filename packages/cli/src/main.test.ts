// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { googleRouter, noKeychain, routedFetch } from "@perfoads/mcp-server/testing";
import {
  credentialsInfo,
  getInvocation,
  howToRun,
  keyFilePath,
  MIGRATIONS,
  openStore,
  setInvocation,
  storePath,
} from "@perfoads/store";
import { holdStoreLock } from "@perfoads/store/testing";
import {
  budgetParams,
  changeRig,
  readPage,
  type ChangeRig,
} from "@perfoads/mcp-server/testing/changes";
import { afterEach, describe, expect, it } from "vitest";
import { CLI_PUBLISHED, CLI_VERSION } from "./version.js";
import { configSnippets } from "./commands.js";
import { main, stableNodePath, type MainOptions } from "./main.js";
import type { runAuthFlow } from "./oauth.js";
import { PromptEnded, terminalPrompter, type Prompter } from "./prompt.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const setup = (answers: string[] = []) => {
  const root = mkdtempSync(path.join(tmpdir(), "perfoads-cli-"));
  roots.push(root);
  const configDir = path.join(root, "config");
  const lines: string[] = [];
  const errors: string[] = [];
  const queue = [...answers];
  const prompter: Prompter = {
    ask: async () => queue.shift() ?? "",
    askHidden: async () => queue.shift() ?? "",
  };
  const fakeFlow: typeof runAuthFlow = async (o) => {
    o.print("https://accounts.google.com/o/oauth2/v2/auth?fake=1");
    return {
      refreshToken: "fake-refresh-token-0001",
      refreshTokenExpiresAt: "2026-10-31T00:00:00.000Z",
      testingMode: true,
    };
  };
  const options: MainOptions = {
    runtime: {
      env: { PERFOADS_MCP_HOME: configDir, PERFOADS_MCP_KEY_BACKEND: "file" },
      home: path.join(root, "home"),
      cwd: path.join(root, "project"),
      fetch: routedFetch(googleRouter()).fetch,
      run: noKeychain,
    },
    io: { out: (l) => lines.push(l), err: (l) => errors.push(l), prompter, authFlow: fakeFlow },
    stdinIsTty: true,
  };
  const answer = (...more: string[]) => queue.push(...more);
  return { options, lines, errors, configDir, answer };
};

describe("cli main", () => {
  it("--help and --version", async () => {
    const t = setup();
    expect(await main(["--help"], t.options)).toBe(0);
    expect(t.lines.join("\n")).toMatch(/Commands:[\s\S]*init[\s\S]*doctor[\s\S]*serve/);
    expect(await main(["--version"], t.options)).toBe(0);
    expect(t.lines.at(-1)).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("no arguments in a terminal shows help", async () => {
    const t = setup();
    expect(await main([], t.options)).toBe(0);
    expect(t.lines.join("\n")).toMatch(/Usage:/);
  });

  it("unknown command or option exits 2", async () => {
    const t = setup();
    expect(await main(["launch"], t.options)).toBe(2);
    expect(await main(["--nope"], t.options)).toBe(2);
    expect(t.errors.join("\n")).toMatch(/Unknown/);
  });

  it("doctor with nothing set up: fails on the sign-in with a fix, does not crash", async () => {
    const t = setup();
    expect(await main(["doctor"], t.options)).toBe(1);
    const text = t.lines.join("\n");
    expect(text).toMatch(/FAIL {2}Saved Google sign-in: No Google sign-in is saved yet\./);
    expect(text).toContain("Fix: Run the setup in a terminal.");
    // The terminal shows the exact command under the plain line.
    expect(text).toContain(`Details: Setup: \`${howToRun("init")}\``);
  });

  it("auth without a terminal says it needs one", async () => {
    const t = setup();
    expect(
      await main(["auth"], {
        ...t.options,
        io: { ...t.options.io, prompter: undefined },
        stdinIsTty: false,
      }),
    ).toBe(1);
    expect(t.errors.join("\n")).toMatch(/needs a terminal/);
  });

  it("init: saves the client and sign-in encrypted, warns about Testing mode, prints config", async () => {
    const t = setup([
      "fake-client.apps.googleusercontent.com",
      "fake-client-secret-0001",
      "explorer",
    ]);
    const code = await main(["init"], t.options);
    const text = t.lines.join("\n");
    expect(code).toBe(0);
    expect(text).toMatch(/No developer token is needed/);
    expect(text).toMatch(/Testing mode, so this sign-in expires in 7 days/);
    expect(text).toMatch(/OK {4}Google Ads accounts reachable/);
    if (CLI_PUBLISHED) {
      // Published: every command and the config start the exact npm version with npx.
      const pkg = `perfoads-mcp@${CLI_VERSION}`;
      expect(howToRun("init")).toBe(`npx ${pkg} init`);
      expect(text).toContain("claude mcp add --scope user perfoads-mcp -e ");
      expect(text).toContain(` -- npx -y ${pkg} serve`);
      expect(text).toContain(`"command": "npx"`);
    } else {
      // Not published: the config starts this very install (Node + entry file by full path).
      const entry = realpathSync(fileURLToPath(new URL("../bin/perfoads-mcp.js", import.meta.url)));
      const q = (a: string) => (/^[\w@./:-]+$/.test(a) ? a : JSON.stringify(a));
      const node = stableNodePath(process.execPath).node;
      expect(howToRun("init")).toBe(`"${node}" "${entry}" init`);
      expect(text).toContain("claude mcp add --scope user perfoads-mcp -e ");
      expect(text).toContain(` -- ${q(node)} ${q(entry)} serve`);
      expect(text).toContain(`"command": ${JSON.stringify(node)}`);
      expect(text).toContain(
        `"args": [\n        ${JSON.stringify(entry)},\n        "serve"\n      ]`,
      );
      expect(text).not.toMatch(/npx/);
    }
    expect(text).not.toContain("fake-client-secret-0001");
    expect(text).not.toContain("fake-refresh-token-0001");
    const store = openStore(storePath(t.configDir));
    try {
      expect(credentialsInfo(store).saved).toHaveLength(3);
      expect(store.getMeta("access_level")).toBe("explorer");
      const raw = JSON.stringify(store.db.prepare("SELECT ciphertext FROM credentials").all());
      expect(raw).not.toContain("fake-client-secret-0001");
    } finally {
      store.close();
    }

    // auth again reuses the saved OAuth client: no questions asked.
    const again = setup();
    if (t.options.runtime) again.options.runtime = t.options.runtime;
    expect(await main(["auth"], again.options)).toBe(0);
    expect(again.lines.join("\n")).toMatch(/Signed in/);
  });
});

const CLIENT = ["fake-client.apps.googleusercontent.com", "fake-client-secret-0001"];

/** Runs init so a sign-in is saved, then hands back the same setup for the next command. */
const signedIn = async () => {
  const t = setup([...CLIENT, "explorer"]);
  expect(await main(["init"], t.options)).toBe(0);
  t.lines.length = 0;
  t.errors.length = 0;
  return t;
};

const withStore = <T>(configDir: string, fn: (s: ReturnType<typeof openStore>) => T): T => {
  const s = openStore(storePath(configDir));
  try {
    return fn(s);
  } finally {
    s.close();
  }
};

const noTty = (t: ReturnType<typeof setup>): MainOptions => ({
  ...t.options,
  io: { ...t.options.io, prompter: undefined },
  stdinIsTty: false,
});

describe("lost or wrong encryption key", () => {
  it("key unavailable: auth explains, asks, wipes on yes and signs in fresh", async () => {
    const t = await signedIn();
    // The store says the key is in the macOS Keychain, which this machine cannot read.
    withStore(t.configDir, (s) => s.setMeta("key_backend", "macos-keychain"));
    t.answer("y", ...CLIENT);
    expect(await main(["auth"], t.options)).toBe(0);
    expect(t.errors.join("\n")).toMatch(/encryption key is missing or locked/);
    expect(t.lines.join("\n")).toMatch(/Signed in/);
    withStore(t.configDir, (s) => {
      expect(credentialsInfo(s).saved).toHaveLength(3);
      expect(s.getMeta("key_backend")).toBe("file");
    });
  });

  it("wrong key (decrypt fails): without a terminal, refuses and names the reset command", async () => {
    const t = await signedIn();
    writeFileSync(keyFilePath(t.configDir), `${"ab".repeat(32)}\n`);
    expect(await main(["auth"], noTty(t))).toBe(1);
    expect(t.errors.join("\n")).toMatch(/another encryption key/);
    expect(t.errors.join("\n")).toContain(howToRun("reset"));
    withStore(t.configDir, (s) => expect(credentialsInfo(s).saved).toHaveLength(3));
  });

  it("wrong key: answering no changes nothing", async () => {
    const t = await signedIn();
    writeFileSync(keyFilePath(t.configDir), `${"ab".repeat(32)}\n`);
    t.answer("n");
    expect(await main(["auth"], t.options)).toBe(1);
    expect(t.errors.join("\n")).toMatch(/Nothing was changed/);
    withStore(t.configDir, (s) => expect(credentialsInfo(s).saved).toHaveLength(3));
  });

  it("doctor points at auth/reset when the sign-in cannot be decrypted", async () => {
    const t = await signedIn();
    writeFileSync(keyFilePath(t.configDir), `${"ab".repeat(32)}\n`);
    expect(await main(["doctor"], t.options)).toBe(1);
    expect(t.lines.join("\n")).toMatch(
      /FAIL {2}Saved Google sign-in: The saved Google sign-in could not be decrypted/,
    );
    expect(t.lines.join("\n")).toContain(howToRun("reset"));
  });
});

describe("stable Node path for the config", () => {
  const CELLAR = "/opt/homebrew/Cellar/node/26.12.1/bin/node";
  it("a Homebrew Cellar path becomes the stable link when it resolves to the same binary", () => {
    const links: Record<string, string> = { "/opt/homebrew/bin/node": CELLAR, [CELLAR]: CELLAR };
    const realpath = (p: string) => {
      const r = links[p];
      if (!r) throw new Error("ENOENT");
      return r;
    };
    expect(stableNodePath(CELLAR, realpath)).toEqual({ node: "/opt/homebrew/bin/node" });
    // node@22 (keg-only): the formula's opt link.
    const keg = "/usr/local/Cellar/node@22/22.13.1/bin/node";
    const kegLinks: Record<string, string> = {
      [keg]: keg,
      "/usr/local/opt/node@22/bin/node": keg,
    };
    expect(stableNodePath(keg, (p) => kegLinks[p] ?? `${p}-other`)).toEqual({
      node: "/usr/local/opt/node@22/bin/node",
    });
  });

  it("no matching link: keeps the Cellar path and says why; other paths unchanged", () => {
    const other = (p: string) =>
      p === CELLAR ? CELLAR : "/opt/homebrew/Cellar/node/27.0.0/bin/node";
    const r = stableNodePath(CELLAR, other);
    expect(r.node).toBe(CELLAR);
    expect(r.note).toMatch(/Homebrew version folder.*brew upgrade.*init again/);
    expect(stableNodePath("/usr/local/bin/node", () => "/x")).toEqual({
      node: "/usr/local/bin/node",
    });
    expect(stableNodePath("C:\\Program Files\\nodejs\\node.exe")).toEqual({
      node: "C:\\Program Files\\nodejs\\node.exe",
    });
  });

  it("the config snippet carries the note when Node stays in a Homebrew version folder", () => {
    const before = getInvocation();
    try {
      const inv = {
        node: "/opt/homebrew/Cellar/node/26.12.1/bin/node",
        script: "/opt/x/bin/perfoads-mcp.js",
        version: "0.0.0",
        published: false,
        nodeNote: "Note: Node.js runs from a Homebrew version folder",
      };
      setInvocation(inv);
      expect(configSnippets({})).toMatch(/\n\nNote: Node\.js runs from a Homebrew version folder$/);
      setInvocation({ ...inv, published: true });
      expect(configSnippets({})).not.toMatch(/Homebrew/);
    } finally {
      setInvocation(before);
    }
  });
});

describe("terminal prompter", () => {
  it("EOF before an answer rejects with PromptEnded instead of hanging", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const p = terminalPrompter(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
    );
    const answer = p.ask("Continue? [y/N] ");
    input.end();
    await expect(answer).rejects.toBeInstanceOf(PromptEnded);
    const typed = new PassThrough();
    const yes = terminalPrompter(
      typed as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
    ).ask("Continue? [y/N] ");
    typed.write(" y \n");
    expect(await yes).toBe("y");
  });
});

describe("reset", () => {
  it("after a typed yes, deletes the credentials, the key file and the key record", async () => {
    const t = await signedIn();
    t.answer("y");
    expect(await main(["reset"], t.options)).toBe(0);
    expect(existsSync(keyFilePath(t.configDir))).toBe(false);
    withStore(t.configDir, (s) => {
      expect(credentialsInfo(s).saved).toHaveLength(0);
      expect(s.getMeta("key_backend")).toBeUndefined();
    });
    expect(t.lines.join("\n")).toContain(howToRun("init"));
  });

  it("asks Google to revoke the saved refresh token first (best effort) and says how it went", async () => {
    const t = await signedIn();
    const google = routedFetch(
      googleRouter((call) =>
        call.url === "https://oauth2.googleapis.com/revoke" ? { body: {} } : undefined,
      ),
    );
    t.answer("y");
    expect(
      await main(["reset"], {
        ...t.options,
        runtime: { ...t.options.runtime, fetch: google.fetch },
      }),
    ).toBe(0);
    const revoke = google.calls.filter((c) => c.url === "https://oauth2.googleapis.com/revoke");
    expect(revoke).toHaveLength(1);
    expect(revoke[0]?.method).toBe("POST");
    expect(new URLSearchParams(revoke[0]?.body).get("token")).toBe("fake-refresh-token-0001");
    const text = t.lines.join("\n");
    expect(text).toMatch(/Google confirmed that the sign-in is revoked/);
    expect(text).not.toContain("fake-refresh-token-0001");

    // Google unreachable: the local wipe still happens, and it says to check by hand.
    const u = await signedIn();
    u.answer("y");
    const down = routedFetch(
      googleRouter((call) =>
        call.url === "https://oauth2.googleapis.com/revoke" ? { status: 503 } : undefined,
      ),
    );
    expect(
      await main(["reset"], { ...u.options, runtime: { ...u.options.runtime, fetch: down.fetch } }),
    ).toBe(0);
    expect(u.lines.join("\n")).toMatch(
      /did not confirm revoking.*myaccount\.google\.com\/permissions/,
    );
    withStore(u.configDir, (s) => expect(credentialsInfo(s).saved).toHaveLength(0));
  });

  it("anything but yes keeps everything; no terminal refuses", async () => {
    const t = await signedIn();
    t.answer("");
    expect(await main(["reset"], t.options)).toBe(1);
    expect(await main(["reset"], noTty(t))).toBe(1);
    expect(t.errors.join("\n")).toMatch(/needs a terminal/);
    withStore(t.configDir, (s) => expect(credentialsInfo(s).saved).toHaveLength(3));
  });

  it("the input ends at the prompt (EOF): a plain no-answer message, exit 1, nothing deleted", async () => {
    const t = await signedIn();
    const ended: Prompter = {
      ask: () => Promise.reject(new PromptEnded()),
      askHidden: () => Promise.reject(new PromptEnded()),
    };
    expect(await main(["reset"], { ...t.options, io: { ...t.options.io, prompter: ended } })).toBe(
      1,
    );
    expect(t.lines.join("\n")).toContain("No answer - nothing was changed.");
    withStore(t.configDir, (s) => expect(credentialsInfo(s).saved).toHaveLength(3));
  });

  it("init: the store locked by another process mid-way gives the plain busy message", async () => {
    const t = setup([...CLIENT, "explorer"]);
    let release: (() => void) | undefined;
    const flow = t.options.io?.authFlow;
    if (!flow) throw new Error("setup() always passes an auth flow");
    const options: MainOptions = {
      ...t.options,
      runtime: { ...t.options.runtime, storeBusyTimeoutMs: 0 },
      io: {
        ...t.options.io,
        // Another process takes the write lock while the user signs in in the browser.
        authFlow: async (o) => {
          release = holdStoreLock(storePath(t.configDir));
          return flow(o);
        },
      },
    };
    try {
      expect(await main(["init"], options)).toBe(1);
    } finally {
      release?.();
    }
    const errors = t.errors.join("\n");
    expect(errors).toMatch(/in use by another perfoads-mcp process/);
    expect(errors).not.toMatch(/database is locked/);
    withStore(t.configDir, (s) => expect(credentialsInfo(s).saved).toHaveLength(0));
  });

  it("a store busy in another process: reset moves and deletes nothing", async () => {
    const t = await signedIn();
    const options: MainOptions = {
      ...t.options,
      runtime: { ...t.options.runtime, storeBusyTimeoutMs: 0 },
    };
    const release = holdStoreLock(storePath(t.configDir));
    try {
      t.answer("y");
      expect(await main(["reset"], options)).toBe(1);
    } finally {
      release();
    }
    expect(t.errors.join("\n")).toMatch(
      /in use by another perfoads-mcp process[\s\S]*Nothing was changed/,
    );
    expect(readdirSync(t.configDir).some((f) => f.includes(".broken-"))).toBe(false);
    expect(existsSync(keyFilePath(t.configDir))).toBe(true);
    withStore(t.configDir, (s) => expect(credentialsInfo(s).saved).toHaveLength(3));
  });

  it("a damaged store: doctor names the file and the way out; reset moves it aside", async () => {
    const t = setup(["y"]);
    const file = storePath(t.configDir);
    await main(["doctor"], t.options); // creates the folder and a good store
    writeFileSync(file, "not a database ".repeat(300));
    t.lines.length = 0;
    expect(await main(["doctor"], t.options)).toBe(1);
    const report = t.lines.join("\n");
    expect(report).toContain(file);
    expect(report).toMatch(/Move the store file aside[\s\S]*reset/);
    expect(report).not.toMatch(/Run the doctor tool/);
    expect(await main(["reset"], t.options)).toBe(0);
    expect(readdirSync(t.configDir).some((f) => f.startsWith("store.sqlite.broken-"))).toBe(true);
    withStore(t.configDir, (s) => expect(s.schemaVersion()).toBe(MIGRATIONS.length));
  });
});

describe("approve / reject (terminal only)", () => {
  const rigs: ChangeRig[] = [];
  afterEach(async () => {
    for (const r of rigs.splice(0)) await r.cleanup();
  });

  /** A proposed change with its approval page open (as apply_change leaves it). */
  const pending = async () => {
    const rig = changeRig();
    rigs.push(rig);
    const change = await rig.rt.engine().propose({
      customerId: "1234567890",
      type: "update_budget",
      input: budgetParams(),
      actor: "agent",
      via: "mcp",
      reason: "Budget runs out by noon",
    });
    await rig.rt.approvals().open(change, "approve", { testAccount: true, clientHasForms: true });
    const { code } = await readPage(rig.opened[0] ?? "");
    return { rig, change, code };
  };

  const cli = (rig: ChangeRig, answers: string[], tty: { stdin: boolean; stdout: boolean }) => {
    const lines: string[] = [];
    const errors: string[] = [];
    const queue = [...answers];
    const options: MainOptions = {
      runtime: {
        env: { PERFOADS_MCP_HOME: rig.rt.configDir.dir, PERFOADS_MCP_KEY_BACKEND: "file" },
        run: noKeychain,
        approvalUser: "terminal-person",
      },
      io: {
        out: (l) => lines.push(l),
        err: (l) => errors.push(l),
        prompter: { ask: async () => queue.shift() ?? "", askHidden: async () => "" },
      },
      stdinIsTty: tty.stdin,
      stdoutIsTty: tty.stdout,
    };
    return { options, lines, errors };
  };

  it("refuses without a real terminal (stdin or stdout not a TTY), even with the right code", async () => {
    const { rig, change, code } = await pending();
    for (const tty of [
      { stdin: false, stdout: false },
      { stdin: true, stdout: false },
      { stdin: false, stdout: true },
    ]) {
      const t = cli(rig, [code], tty);
      expect(await main(["approve", change.id], t.options)).toBe(1);
      expect(t.errors.join("\n")).toMatch(
        /not a guard against an AI with a shell on your user account/,
      );
      const r = cli(rig, ["y"], tty);
      expect(await main(["reject", change.id], r.options)).toBe(1);
    }
    expect(rig.rt.engine().get(change.id)?.status).toBe("proposed");
  });

  it("in a terminal, the code from the page approves (via cli); a wrong code first counts a try", async () => {
    const { rig, change, code } = await pending();
    const t = cli(rig, ["ZZZZZZ", code], { stdin: true, stdout: true });
    expect(await main(["approve", change.id], t.options)).toBe(0);
    expect(t.errors.join("\n")).toMatch(/Wrong code\. 4 tries left/);
    expect(t.lines.join("\n")).toMatch(/Account: 123-456-7890, currency EUR/);
    expect(t.lines.join("\n")).toContain(
      'Reason (written by the AI, unverified): "Budget runs out by noon"',
    );
    expect(t.lines.join("\n")).toMatch(/Approved chg_/);
    expect(t.lines.join("\n")).not.toContain(code);
    const v = rig.rt.engine().get(change.id);
    expect(v?.status).toBe("approved");
    expect(v?.approvedVia).toBe("cli");
    expect(v?.approvedBy).toBe("terminal-person");
    // The open page closes once the session is used elsewhere.
    for (let i = 0; i < 100 && rig.rt.approvals().hasPage(change.id); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(rig.rt.approvals().hasPage(change.id)).toBe(false);
  });

  it("no open approval page: nothing to type the code for", async () => {
    const rig = changeRig();
    rigs.push(rig);
    const change = await rig.rt.engine().propose({
      customerId: "1234567890",
      type: "update_budget",
      input: budgetParams(),
      actor: "agent",
      via: "mcp",
    });
    const t = cli(rig, ["ABCDEF"], { stdin: true, stdout: true });
    expect(await main(["approve", change.id], t.options)).toBe(1);
    expect(t.errors.join("\n")).toMatch(/No approval is waiting/);
  });

  it("reject in a terminal rejects the change", async () => {
    const { rig, change } = await pending();
    const t = cli(rig, ["y"], { stdin: true, stdout: true });
    expect(await main(["reject", change.id], t.options)).toBe(0);
    expect(rig.rt.engine().get(change.id)?.status).toBe("rejected");
    expect(await main(["approve"], t.options)).toBe(2);
  });

  it("approvals open <id>: TTY only; serves a code-only page from the terminal and approves with its code", async () => {
    const { rig, change } = await pending();
    const refused = cli(rig, [], { stdin: false, stdout: false });
    expect(await main(["approvals", "open", change.id], refused.options)).toBe(1);
    expect(refused.lines.join("\n")).not.toMatch(/http:\/\/127/);
    const t = cli(rig, [], { stdin: true, stdout: true });
    const prompter = {
      ask: async () => {
        const url = /http:\/\/127\.0\.0\.1:\d+\/a\/\S+/.exec(t.lines.join("\n"))?.[0] ?? "";
        const page = await readPage(url);
        expect(page.body).not.toContain('value="approve"');
        return page.code;
      },
      askHidden: async () => "",
    };
    t.options.io = { ...t.options.io, prompter };
    expect(await main(["approvals", "open", change.id], t.options)).toBe(0);
    expect(rig.rt.engine().get(change.id)?.approvedVia).toBe("cli");
    expect(await main(["approvals", "list"], t.options)).toBe(2);
  });
});

describe("change policy (init, policy check, policy show)", () => {
  it("init writes a read-only starter policy for the chosen account, never over an existing one", async () => {
    const t = setup([...CLIENT, "explorer", "123-456-7890"]);
    expect(await main(["init"], t.options)).toBe(0);
    const file = path.join(t.configDir, "policy.yaml");
    const text = readFileSync(file, "utf8");
    expect(text).toMatch(/allow: \["123-456-7890"\]/);
    expect(text).toMatch(/write: \[\]/);
    expect(text).toMatch(/Hardened setup/);
    expect(t.lines.join("\n")).toMatch(/Change policy written: .*read-only/);
    writeFileSync(file, "# mine\n");
    t.answer(...CLIENT, "explorer");
    expect(await main(["init"], t.options)).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("# mine\n");
    expect(t.lines.join("\n")).toMatch(/already exists, left as it is/);
  });

  it("policy check: plain words and exit 0 for a valid file, the problems and exit 1 otherwise", async () => {
    const t = await signedIn();
    expect(await main(["policy", "check"], t.options)).toBe(0);
    const out = t.lines.join("\n");
    expect(out).toMatch(/Valid policy \(version [0-9a-f]{12}\)/);
    expect(out).toMatch(/Accounts that may be changed \(after approval\): none/);
    const other = path.join(t.configDir, "..", "draft.yaml");
    writeFileSync(other, 'version: 1\naccounts: { allow: ["1234567890"] }\nkill_swich: true\n');
    t.lines.length = 0;
    expect(await main(["policy", "check", other], t.options)).toBe(1);
    expect(t.lines.join("\n")).toMatch(
      /NOT valid[\s\S]*unknown key kill_swich[\s\S]*the server only reads/,
    );
  });

  it("policy show: what the server uses now; unknown sub-commands exit 2", async () => {
    const t = await signedIn();
    expect(await main(["policy", "show"], t.options)).toBe(0);
    expect(t.lines.join("\n")).toMatch(
      /Policy file: .*policy\.yaml[\s\S]*Version hash: [0-9a-f]{64}/,
    );
    expect(await main(["policy"], t.options)).toBe(2);
    expect(await main(["policy", "edit"], t.options)).toBe(2);
  });
});

describe("CLI and the start-folder rule", () => {
  it("settings inside the repo the command runs in: still read, with a 'would be ignored' note; no ignored event", async () => {
    const t = setup();
    const runtime = t.options.runtime ?? {};
    const home = runtime.home ?? "";
    const repo = path.join(home, "code", "repo");
    const dir = path.join(repo, ".perfoads");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "policy.yaml"),
      'version: 1\naccounts: { allow: ["1234567890"], write: [] }\n',
    );
    const options: MainOptions = {
      ...t.options,
      runtime: { ...runtime, cwd: repo, env: { ...runtime.env, PERFOADS_MCP_HOME: dir } },
    };
    expect(await main(["policy", "show"], options)).toBe(0);
    const out = t.lines.join("\n");
    expect(out).toMatch(/Valid policy/);
    expect(out).toContain(
      `Note: It would be ignored if your AI app works in ${repo} (the settings folder is inside it).`,
    );
    withStore(dir, (s) => {
      const events = s.db
        .prepare("SELECT actor, data FROM audit_log WHERE event = 'policy_loaded'")
        .all() as { actor: string; data: string }[];
      expect(events.map((e) => [e.actor, JSON.parse(e.data).status])).toEqual([["cli", "valid"]]);
    });
  });
});

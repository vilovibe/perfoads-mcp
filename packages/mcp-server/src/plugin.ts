// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// An optional plugin, named by `pro_plugin` in config.json in the settings folder (never an
// environment variable, never a tool input). It can add a decision per check id (the
// `RemedyProvider` runChecks accepts), writer hints, prompts and tools. Loaded once at start;
// anything wrong with it (missing, throws, wrong shape) is one warning on stderr and the
// server runs without it. A plugin is code that runs with the server's own rights.

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RemedyFn, RemedyProvider, WriterHints } from "@perfoads/checks";
import { isInside } from "@perfoads/store";
import { CONFIG_FILE } from "./runtime.js";

/** The config.json key: an absolute path to the built plugin package (or file), or a package name. */
export const PLUGIN_CONFIG_KEY = "pro_plugin";

/** How long the plugin's module may take to load before it is given up. */
export const PLUGIN_LOAD_MS = 10_000;

/** A prompt the plugin adds. Its arguments are strings (name -> description). */
export interface PluginPrompt {
  name: string;
  title: string;
  description: string;
  args?: Readonly<Record<string, string>>;
  /** The user message the prompt sends. */
  text: (args: Readonly<Record<string, string>>) => string;
}

/** A read-only tool the plugin adds. Its arguments are strings (name -> description). */
export interface PluginTool {
  name: string;
  title: string;
  description: string;
  args?: Readonly<Record<string, string>>;
  run: (args: Readonly<Record<string, string>>) => string | Promise<string>;
}

/** What a plugin module exports (as its default export, or as its named exports). */
export interface ServerPlugin {
  name: string;
  version: string;
  remedies: RemedyProvider;
  writerHints: WriterHints;
  prompts?: readonly PluginPrompt[];
  tools?: readonly PluginTool[];
}

export type PluginState =
  | { status: "not_configured" }
  | { status: "loaded"; plugin: ServerPlugin }
  | { status: "failed"; reason: string };

export const NO_PLUGIN: PluginState = Object.freeze({ status: "not_configured" });

/** The loaded plugin, or undefined for every other state. */
export const loadedPlugin = (state: PluginState | undefined): ServerPlugin | undefined =>
  state?.status === "loaded" ? state.plugin : undefined;

const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const CHECK_ID = /^[A-Z][A-Z0-9_]{1,15}$/;
const ITEM_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const ARG_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const shortText = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max;

/** Reads `pro_plugin` from config.json. Absent or empty = not configured. */
export const readPluginSetting = (dir: string): { spec?: string; problem?: string } => {
  const file = path.join(dir, CONFIG_FILE);
  if (!existsSync(file)) return {};
  let value: unknown;
  try {
    value = (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> | null)?.[
      PLUGIN_CONFIG_KEY
    ];
  } catch {
    return { problem: `${file} is not valid JSON` };
  }
  if (value === undefined || value === null || value === "") return {};
  if (typeof value !== "string") return { problem: `${PLUGIN_CONFIG_KEY} must be a string` };
  return { spec: value };
};

/** The file to import for a package folder: exports["."] (import / default), then main, then index.js. */
const entryOf = (dir: string): string => {
  const pj = path.join(dir, "package.json");
  let entry = "index.js";
  if (existsSync(pj)) {
    const pkg = JSON.parse(readFileSync(pj, "utf8")) as { exports?: unknown; main?: unknown };
    let e: unknown = pkg.exports;
    if (isObject(e) && "." in e) e = e["."];
    while (isObject(e)) e = e.import ?? e.default;
    if (typeof e === "string") entry = e;
    else if (typeof pkg.main === "string") entry = pkg.main;
  }
  const file = path.resolve(dir, entry);
  if (path.relative(dir, file).startsWith("..")) throw new Error("its entry point is outside it");
  return file;
};

/** The nearest folder at or above `dir` with a package.json (the file's own folder if none). */
const packageDirOf = (file: string): string => {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    if (path.dirname(dir) === dir) return path.dirname(file);
  }
};

/** The plugin's entry file and its package folder. Throws with a plain reason. */
const locate = (spec: string): { file: string; dir: string } => {
  if (path.isAbsolute(spec)) {
    if (!existsSync(spec)) throw new Error(`${spec} does not exist`);
    const isDir = statSync(spec).isDirectory();
    const file = isDir ? entryOf(spec) : spec;
    if (!existsSync(file)) throw new Error(`${file} does not exist (is it built?)`);
    return { file, dir: isDir ? spec : path.dirname(file) };
  }
  if (!PACKAGE_NAME.test(spec))
    throw new Error(`${PLUGIN_CONFIG_KEY} must be an absolute path or a package name`);
  let file: string;
  try {
    file = fileURLToPath(import.meta.resolve(spec));
  } catch {
    throw new Error(`no installed package ${spec} was found`);
  }
  return { file, dir: packageDirOf(file) };
};

/** Files and folders the file check looks at, at most; past it the plugin is refused. */
export const PLUGIN_MAX_FILES = 50_000;

export interface PluginFileCheck {
  platform?: NodeJS.Platform;
  /** The user the server runs as (default process.getuid()). */
  uid?: number;
  /** The settings folder: on Windows the plugin must sit inside it. */
  configDir: string;
}

/**
 * Why the plugin's files are not safe to load, or undefined. Only the user running the server
 * (or root) may be able to change them: the entry file, its package folder and everything in
 * it (links followed, so a link to another checkout is checked too, with the folder a
 * dependency's link sits in), and every folder above each of those up to the root. POSIX:
 * owner is this user or root, and no group or other write bit (a root-owned sticky folder
 * like /tmp is allowed above). Windows: everything (links resolved) must be inside the
 * settings folder, which the server keeps owner-only.
 */
export const pluginFilesProblem = (
  file: string,
  dir: string,
  check: PluginFileCheck,
): string | undefined => {
  const platform = check.platform ?? process.platform;
  const win = platform === "win32";
  const uid = check.uid ?? process.getuid?.();
  if (!win && uid === undefined) return "the user running the server is unknown";
  const configReal = (() => {
    try {
      return realpathSync(check.configDir);
    } catch {
      return check.configDir;
    }
  })();
  const seen = new Set<string>();
  let count = 0;
  /** One real path (no link): its owner and write bits; `above` = a folder over the plugin. */
  const node = (real: string, above: boolean): string | undefined => {
    if (win)
      return isInside(real, configReal, platform)
        ? undefined
        : `${real} is outside the settings folder (on Windows a plugin must sit inside it)`;
    const st = lstatSync(real);
    if (st.uid !== uid && st.uid !== 0) return `${real} is owned by another user`;
    const sticky = (st.mode & 0o1000) !== 0;
    if ((st.mode & 0o022) !== 0 && !(above && st.isDirectory() && sticky && st.uid === 0))
      return `${real} can be changed by other users`;
    return undefined;
  };
  const ancestors = (real: string): string | undefined => {
    if (win) return undefined;
    for (let d = path.dirname(real); ; d = path.dirname(d)) {
      if (seen.has(`^${d}`)) return undefined;
      seen.add(`^${d}`);
      const p = node(d, true);
      if (p) return p;
      if (path.dirname(d) === d) return undefined;
    }
  };
  const walk = (start: string): string | undefined => {
    let real: string;
    try {
      real = realpathSync(start);
    } catch {
      return undefined; // a broken link loads nothing
    }
    if (seen.has(real)) return undefined;
    seen.add(real);
    if (++count > PLUGIN_MAX_FILES) return `it has more than ${PLUGIN_MAX_FILES} files to check`;
    const own = node(real, false) ?? ancestors(real);
    if (own) return own;
    // a dependency's link target: the node_modules folder it sits in holds its own deps
    const parent = path.dirname(real);
    const grand = path.dirname(parent);
    for (const nm of [parent, grand])
      if (path.basename(nm) === "node_modules" && real !== start) {
        const p = walk(nm);
        if (p) return p;
      }
    if (!statSync(real).isDirectory()) return undefined;
    for (const e of readdirSync(real)) {
      const p = walk(path.join(real, e));
      if (p) return p;
    }
    return undefined;
  };
  return walk(file) ?? walk(dir);
};

const stringArgs = (v: unknown, what: string): Readonly<Record<string, string>> => {
  if (v === undefined) return {};
  if (!isObject(v)) throw new Error(`${what}: args must be an object`);
  const out: Record<string, string> = {};
  for (const [k, d] of Object.entries(v)) {
    if (!ARG_NAME.test(k) || !shortText(d, 300))
      throw new Error(`${what}: argument "${k.slice(0, 40)}" needs a short description`);
    out[k] = d;
  }
  return Object.freeze(out);
};

const itemsOf = <T>(
  v: unknown,
  kind: "prompt" | "tool",
  fn: "text" | "run",
  make: (o: Record<string, unknown>, args: Readonly<Record<string, string>>) => T,
): readonly T[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error(`${kind}s must be a list`);
  const seen = new Set<string>();
  return Object.freeze(
    v.map((o: unknown) => {
      if (!isObject(o)) throw new Error(`each ${kind} must be an object`);
      const name = o.name;
      if (typeof name !== "string" || !ITEM_NAME.test(name) || seen.has(name))
        throw new Error(`a ${kind} has a missing, repeated or unusable name`);
      seen.add(name);
      if (!shortText(o.title, 100) || !shortText(o.description, 1000))
        throw new Error(`${kind} ${name} needs a title and a description`);
      if (typeof o[fn] !== "function") throw new Error(`${kind} ${name} has no ${fn} function`);
      return make(o, stringArgs(o.args, `${kind} ${name}`));
    }),
  );
};

/**
 * Checks a plugin module's shape and returns a frozen copy (functions are copied, so later
 * changes to the module's objects change nothing). Throws with a plain reason.
 */
export const validatePlugin = (mod: unknown): ServerPlugin => {
  if (!isObject(mod)) throw new Error("the module exports nothing");
  const p = isObject(mod.default) ? mod.default : mod;
  if (!shortText(p.name, 80)) throw new Error("it has no name");
  if (typeof p.version !== "string" || !VERSION.test(p.version))
    throw new Error("it has no version");
  if (!isObject(p.remedies)) throw new Error("it has no remedies object");
  const remedies: Record<string, RemedyFn> = {};
  for (const [id, fn] of Object.entries(p.remedies)) {
    if (!CHECK_ID.test(id) || typeof fn !== "function")
      throw new Error(`remedies.${id.slice(0, 20)} is not a function for a check id`);
    remedies[id] = fn as RemedyFn;
  }
  if (!isObject(p.writerHints)) throw new Error("it has no writerHints object");
  const cc = p.writerHints.clientConstraint;
  if (cc !== undefined && typeof cc !== "function")
    throw new Error("writerHints.clientConstraint is not a function");
  const prompts = itemsOf<PluginPrompt>(p.prompts, "prompt", "text", (o, args) =>
    Object.freeze({
      name: o.name as string,
      title: o.title as string,
      description: o.description as string,
      args,
      text: o.text as PluginPrompt["text"],
    }),
  );
  const tools = itemsOf<PluginTool>(p.tools, "tool", "run", (o, args) =>
    Object.freeze({
      name: o.name as string,
      title: o.title as string,
      description: o.description as string,
      args,
      run: o.run as PluginTool["run"],
    }),
  );
  return Object.freeze({
    name: p.name,
    version: p.version,
    remedies: Object.freeze(remedies),
    writerHints: Object.freeze(
      cc === undefined ? {} : { clientConstraint: cc as WriterHints["clientConstraint"] },
    ),
    prompts,
    tools,
  });
};

const errorMessage = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).split("\n")[0]?.slice(0, 300) ?? "";

/** Imports a module (a seam for tests). */
export type Importer = (specifier: string) => Promise<unknown>;
const nativeImport: Importer = (specifier) => import(specifier);

/**
 * Loads the plugin config.json names. Never throws: any problem is a `failed` state with a
 * plain reason (the caller logs it once and runs without the plugin).
 */
export const loadPlugin = async (
  configDir: string,
  options: {
    importer?: Importer;
    timeoutMs?: number;
    platform?: NodeJS.Platform;
    uid?: number;
  } = {},
): Promise<PluginState> => {
  const setting = readPluginSetting(configDir);
  if (setting.problem) return { status: "failed", reason: setting.problem };
  if (setting.spec === undefined) return NO_PLUGIN;
  try {
    const { file, dir } = locate(setting.spec);
    const unsafe = pluginFilesProblem(file, dir, {
      configDir,
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.uid === undefined ? {} : { uid: options.uid }),
    });
    if (unsafe) return { status: "failed", reason: `not loaded for safety: ${unsafe}` };
    const specifier = pathToFileURL(file).href;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("it took too long to load")),
        options.timeoutMs ?? PLUGIN_LOAD_MS,
      );
      timer.unref();
    });
    try {
      const mod = await Promise.race([(options.importer ?? nativeImport)(specifier), late]);
      return { status: "loaded", plugin: validatePlugin(mod) };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { status: "failed", reason: errorMessage(err) || "it could not be loaded" };
  }
};

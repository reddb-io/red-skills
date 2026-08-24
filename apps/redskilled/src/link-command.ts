import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const REDSKILLED_LINK_BUNDLE_ASSET = "redskilled-link.bundle.min.mjs";
export const REDSKILLED_LINK_BIN_ENV = "REDSKILLED_LINK_BIN";

export interface RedskilledLinkCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly entry: string;
}

export interface RedskilledLinkCommandLookup {
  readonly callerEntry?: string;
  readonly rootDir?: string;
  readonly execPath?: string;
  readonly execArgv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly exists?: (path: string) => boolean;
}

export function resolveRedskilledLinkCommand(
  lookup: RedskilledLinkCommandLookup = {},
): RedskilledLinkCommand {
  const env = lookup.env ?? process.env;
  const exists = lookup.exists ?? existsSync;
  const execPath = lookup.execPath ?? process.execPath;
  const execArgv = lookup.execArgv ?? process.execArgv;
  const callerEntry = lookup.callerEntry === undefined ? process.argv[1] : lookup.callerEntry;
  const pinned = env[REDSKILLED_LINK_BIN_ENV]?.trim();
  if (pinned) return { command: pinned, args: [], entry: pinned };

  const searched: string[] = [];
  for (const candidate of linkEntryCandidates(callerEntry, lookup.rootDir, env)) {
    const entry = resolve(candidate);
    if (searched.includes(entry)) continue;
    searched.push(entry);
    if (exists(entry)) return { command: execPath, args: [...execArgv, entry], entry };
  }
  throw new Error(
    `redskilled-link companion is not installed; expected ${REDSKILLED_LINK_BUNDLE_ASSET} beside redskilled` +
    `\nsearched:\n${searched.map((path) => `  ${path}`).join("\n")}`,
  );
}

export function runRedskilledLinkCommand(
  args: readonly string[],
  options: RedskilledLinkCommandLookup & {
    readonly run?: (command: string, argv: readonly string[]) => { readonly status: number | null; readonly error?: Error };
  } = {},
): number {
  const entry = resolveRedskilledLinkCommand(options);
  const result = (options.run ?? defaultRun)(entry.command, [...entry.args, "onboard", ...args]);
  if (result.error != null) throw result.error;
  if (result.status == null) throw new Error("redskilled-link companion exited without a status");
  return result.status;
}

function* linkEntryCandidates(
  callerEntry: string | undefined,
  rootDir: string | undefined,
  env: NodeJS.ProcessEnv,
): Generator<string> {
  if (callerEntry) {
    const caller = resolve(callerEntry);
    const directory = dirname(caller);
    yield join(directory, REDSKILLED_LINK_BUNDLE_ASSET);
    const version = /^redskilled-(?!link(?:-|\.))(.+)\.bundle\.min\.mjs$/.exec(basename(caller))?.[1];
    if (version) yield join(directory, `redskilled-link-${version}.bundle.min.mjs`);
    yield join(directory, "..", "dist", REDSKILLED_LINK_BUNDLE_ASSET);
  }
  for (const variable of ["RED_SKILLS_DEV_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT", "CODEX_PLUGIN_ROOT", "OPENCODE_PLUGIN_ROOT"]) {
    const pluginRoot = env[variable];
    if (pluginRoot) yield join(pluginRoot, "dist", REDSKILLED_LINK_BUNDLE_ASSET);
  }
  if (rootDir) yield join(rootDir, "dist", REDSKILLED_LINK_BUNDLE_ASSET);
  const home = env.HOME?.trim() || homedir();
  yield join(home, ".red", "skills", "current", "dist", REDSKILLED_LINK_BUNDLE_ASSET);
  const cache = env.RED_SKILLS_CACHE_DIR ?? join(env.XDG_CACHE_HOME?.trim() || join(home, ".cache"), "red-skills", "bundles");
  yield join(cache, REDSKILLED_LINK_BUNDLE_ASSET);
}

function defaultRun(command: string, args: readonly string[]) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  return { status: result.status, ...(result.error == null ? {} : { error: result.error }) };
}

// resident-self-update.ts — the session-long bundle self-update belt (#3178).
//
// SessionStart warms the cache once, but a long-lived session needs a long-lived
// owner. The redskilled MCP resident already owns periodic maintenance, so this belt
// performs one immediate registry check and one cheap check every five minutes.
// A successful update atomically advances the stable pointer through the shared
// self-update implementation; the next Worker therefore starts on that bundle
// without a restart or human action.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { readBuildInfo } from "@reddb-io/build-info";
import {
  createEnginePaths,
  createSingletonLeaseStore,
  type SingletonLeaseOwner,
  type SingletonLeaseStore,
} from "@reddb-io/red-castle/engine";
import { NPM_PACKAGE } from "@reddb-io/shared/bundle-fetch.js";
import { resolveChannel, type ReleaseChannel } from "@reddb-io/shared/channel.js";
import { resolveRepoRoot } from "@reddb-io/shared/repo-root.js";
import {
  backgroundSelfUpdateWithRetry,
  type SelfUpdateInput,
  type SelfUpdateIO,
  type SelfUpdateResult,
} from "@reddb-io/shared/self-update.js";
import { getConfig, loadConfig } from "./core/config.js";
import { redSkillsCacheDir } from "./core/bundle-version.js";
import { readPidStartTime } from "./core/state.js";

export const RESIDENT_SELF_UPDATE_INTERVAL_MS = 5 * 60 * 1000;
export const SELF_UPDATE_SINGLETON = "self-update";

export interface ResidentSelfUpdateTimers {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(timer: unknown): void;
}

export interface ResidentSelfUpdateOptions {
  readonly root?: string;
  readonly installedVersion?: string;
  readonly cacheDir?: string;
  readonly channel?: ReleaseChannel;
  readonly update?: (input: SelfUpdateInput) => Promise<SelfUpdateResult>;
  readonly leases?: SingletonLeaseStore;
  readonly owner?: SingletonLeaseOwner;
  readonly intervalMs?: number;
  readonly timers?: ResidentSelfUpdateTimers;
  readonly notice?: (message: string) => void;
}

export interface ResidentSelfUpdate {
  check(): Promise<SelfUpdateResult | undefined>;
  stop(): Promise<void>;
}

const execFileAsync = promisify(execFile);

const nodeSelfUpdateIO: SelfUpdateIO = {
  async materialize(spec, stagingDir) {
    await mkdir(stagingDir, { recursive: true });
    await execFileAsync(
      "npm",
      [
        "install",
        spec,
        "--prefix",
        stagingDir,
        "--no-save",
        "--no-audit",
        "--no-fund",
        "--ignore-scripts",
        "--loglevel=error",
      ],
      { encoding: "utf8" },
    );
    return join(stagingDir, "node_modules", ...NPM_PACKAGE.split("/"));
  },
  async readFile(path) {
    return new Uint8Array(await readFile(path));
  },
  async writeFile(path, bytes) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  },
  async exists(path) {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
  },
  async fetchText(url) {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
    return response.text();
  },
  readdir,
  rename,
};

function defaultTimers(): ResidentSelfUpdateTimers {
  return {
    setInterval(callback, intervalMs) {
      const timer = setInterval(callback, intervalMs);
      timer.unref();
      return timer;
    },
    clearInterval(timer) {
      clearInterval(timer as NodeJS.Timeout);
    },
  };
}

function configuredChannel(root: string): ReleaseChannel {
  const config = loadConfig(join(root, ".red", "config.yaml"));
  return resolveChannel({
    env: process.env,
    configValue: getConfig(config, "afk.release.channel"),
  });
}

async function runNodeSelfUpdate(input: SelfUpdateInput): Promise<SelfUpdateResult> {
  return backgroundSelfUpdateWithRetry(nodeSelfUpdateIO, input);
}

/** Start the resident's repo-scoped self-update belt. The first check is
 * detached from MCP startup, and concurrent ticks share one in-flight check. */
export async function startResidentSelfUpdate(
  options: ResidentSelfUpdateOptions = {},
): Promise<ResidentSelfUpdate | null> {
  const root = resolveRepoRoot(options.root ?? process.cwd());
  const leases =
    options.leases ?? createSingletonLeaseStore(createEnginePaths(join(root, ".red")));
  const owner = options.owner ?? {
    pid: process.pid,
    startTime: readPidStartTime(process.pid) ?? `pid-${process.pid}`,
  };
  const acquired = await leases.acquire(SELF_UPDATE_SINGLETON, owner);
  if (!acquired.acquired) return null;

  const notice = options.notice ?? (() => undefined);
  const update = options.update ?? runNodeSelfUpdate;
  const timers = options.timers ?? defaultTimers();
  const input: SelfUpdateInput = {
    plugin: "dev",
    installedVersion: options.installedVersion ?? readBuildInfo("dev").version,
    repo: "reddb-io/red-skills",
    cacheDir: options.cacheDir ?? redSkillsCacheDir(),
    channel: options.channel ?? configuredChannel(root),
  };
  let running: Promise<SelfUpdateResult | undefined> | undefined;
  let timer: unknown;

  const check = (): Promise<SelfUpdateResult | undefined> => {
    if (running) return running;
    running = update(input)
      .then((result) => {
        if (result.status === "error") {
          notice(`self-update check failed: ${result.error ?? "unknown error"}`);
        }
        return result;
      })
      .catch((error): undefined => {
        notice(
          `self-update check failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };

  timer = timers.setInterval(
    () => void check(),
    options.intervalMs ?? RESIDENT_SELF_UPDATE_INTERVAL_MS,
  );
  void check();

  return {
    check,
    async stop() {
      if (timer !== undefined) {
        timers.clearInterval(timer);
        timer = undefined;
      }
      await running;
      await leases.release(SELF_UPDATE_SINGLETON, owner);
    },
  };
}

/**
 * self-replace — how a daemon on a superseded bundle becomes one on the current.
 *
 * Nothing in the daemon used to resolve the published version or replace itself,
 * so publishing a release left the singleton serving the old code indefinitely.
 * That is not a hypothetical cost: a long-running supervisor on a superseded
 * bundle killed 21 Workers in 20 minutes, every one halting at boot on version
 * skew, and the only cure was a hand-written pinned dispatch repeated three times
 * (#2808 fixed the same defect one layer up, for the launch). A host-scoped
 * singleton reproduces that failure across every project on the machine at once.
 *
 * Three rules decide this module.
 *
 * **A replacement is a restart, not an evacuation.** Workers are init-system
 * units (ADR 0130 rule 5), so they outlive the daemon that asked for them and the
 * successor re-attaches by unit name through the event lane. Nothing is stopped,
 * drained or re-queued.
 *
 * **The version a daemon reports is the version it runs, always.** The published
 * answer is carried as its own observation next to the running one, never folded
 * into it — substituting the resolved version for the running one is exactly how
 * a stale process reports a healthy zero skew while every Worker boot-halts
 * (#2809). This module therefore *decides*; it never renames what is running.
 *
 * **A local build replaces itself with nothing.** A source checkout is not a
 * point on the published lane, so comparing it to a release is meaningless and
 * acting on the comparison would take a developer's own daemon away mid-session.
 *
 * PURE apart from the injected spawn, exit and existence lookups.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fetchNewestSameMajor } from "@reddb-io/shared/bundle-fetch.js";
import { compareSemver, parseSemver } from "@reddb-io/shared/self-update.js";
import {
  redskilledBundleCacheRoot,
  redskilledServeArgv,
  type RedskilledServeTarget,
} from "./daemon-entry.js";
import { REDSKILLED_SUPERVISED_ENV } from "./supervision.js";

/**
 * The exit code a self-replacing daemon leaves under a supervisor.
 *
 * NON-ZERO on purpose: the unit carries `Restart=on-failure`, so being revived is
 * what this exit asks for. A clean exit would be read as "it had nothing to do"
 * and the machine would stay on the old bundle with no daemon at all.
 */
export const REDSKILLED_REPLACE_EXIT_CODE = 75;

/** How long the daemon waits between published-version checks. */
export const DEFAULT_REDSKILLED_REPLACE_CHECK_MS = 900_000;

/** The named diagnostic a replacement emits when the new bundle is unreachable. */
export const REDSKILLED_REPLACEMENT_ENTRY_UNRESOLVED = "redskilled-replacement-entry-unresolved";

/** Env var that turns the registry read off, leaving local evidence only. */
export const REDSKILLED_NO_REGISTRY_PROBE_ENV = "REDSKILLED_NO_REGISTRY_PROBE";

/** Answers "what version is published?" — null when it cannot be resolved. */
export type RedskilledPublishedVersionProbe = (running: string) => Promise<string | null>;

/** Who carries out the swap: the supervisor that will revive us, or ourselves. */
export type RedskilledReplacementVia = "supervisor-exit" | "self-spawn";

export type RedskilledReplacementHoldReason =
  | "published-unknown"
  | "no-newer-version"
  | "local-build";

export type RedskilledReplacementDecision =
  | { readonly act: "hold"; readonly reason: RedskilledReplacementHoldReason }
  | { readonly act: "replace"; readonly to: string; readonly via: RedskilledReplacementVia };

export interface PlanRedskilledReplacementInput {
  /** The version this process is RUNNING — never the one it resolved. */
  readonly running: string;
  readonly published: string | null;
  /** True when a unit will revive this process, so exiting is enough. */
  readonly supervised: boolean;
}

/** Decide whether to replace, and who does it. PURE. */
export function planRedskilledReplacement(
  input: PlanRedskilledReplacementInput,
): RedskilledReplacementDecision {
  const running = input.running.trim();
  if (isLocalRedskilledBuild(running)) return { act: "hold", reason: "local-build" };
  const published = input.published?.trim() ?? "";
  if (!published || parseSemver(published) === null) return { act: "hold", reason: "published-unknown" };
  if (compareSemver(published, running) <= 0) return { act: "hold", reason: "no-newer-version" };
  return { act: "replace", to: published, via: input.supervised ? "supervisor-exit" : "self-spawn" };
}

/**
 * A prerelease, a build-metadata version or anything unparseable is a local
 * build: it is the intended runtime for whoever started it, and no release
 * supersedes it.
 */
export function isLocalRedskilledBuild(version: string): boolean {
  const trimmed = version.trim();
  if (parseSemver(trimmed) === null) return true;
  return /^\d+\.\d+\.\d+[-+]/.test(trimmed);
}

/** True when a unit is supervising this process, so a bare exit is a restart. */
export function isRedskilledSupervised(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[REDSKILLED_SUPERVISED_ENV] === "1";
}

/** Which candidate produced the successor — carried for diagnosis, never for logic. */
export type RedskilledReplacementEntrySource =
  | "bundle-cache"
  | "caller-sibling-bundle"
  | "pinned-dispatch";

export interface ResolvedRedskilledReplacementEntry {
  readonly command: string;
  readonly args: readonly string[];
  readonly version: string;
  readonly source: RedskilledReplacementEntrySource;
  readonly searched: readonly string[];
}

export interface RedskilledReplacementLookup {
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
  /** This process's own entry, used only to probe the directory it shipped in. */
  readonly callerEntry?: string;
  readonly exists?: (path: string) => boolean;
}

/** Thrown when the published bundle exists on no reachable path. */
export class RedskilledReplacementEntryError extends Error {
  readonly code = REDSKILLED_REPLACEMENT_ENTRY_UNRESOLVED;
  readonly searched: readonly string[];

  constructor(version: string, searched: readonly string[]) {
    super(
      `${REDSKILLED_REPLACEMENT_ENTRY_UNRESOLVED}: the published redskilled bundle ${version} exists on no ` +
        `reachable path and the version-pinned dispatch is disabled\nsearched:\n${
          searched.map((path) => `  ${path}`).join("\n")
        }`,
    );
    this.name = "RedskilledReplacementEntryError";
    this.searched = [...searched];
  }
}

/**
 * Find something that runs EXACTLY `version`.
 *
 * Deliberately not the ordinary entry resolver: that one answers "what is the
 * newest daemon on this host", which is the right question for a first start and
 * the wrong one here — a replacement that landed on any other version would
 * report a version it had not resolved and the skew would survive the restart.
 * The version-pinned dispatch is last and is the escape an operator otherwise
 * writes by hand; `RED_SKILLS_NO_PINNED_DISPATCH=1` removes it and turns an
 * unreachable bundle into a loud refusal.
 */
export function requireRedskilledReplacementEntry(
  version: string,
  lookup: RedskilledReplacementLookup = {},
): ResolvedRedskilledReplacementEntry {
  const env = lookup.env ?? process.env;
  const exists = lookup.exists ?? existsSync;
  const execPath = lookup.execPath ?? process.execPath;
  const callerEntry = lookup.callerEntry === undefined ? process.argv[1] : lookup.callerEntry;
  const bundle = `redskilled-${version}.bundle.min.mjs`;

  const searched: string[] = [];
  const candidates: Array<[string, RedskilledReplacementEntrySource]> = [
    [join(redskilledBundleCacheRoot(env), bundle), "bundle-cache"],
  ];
  if (callerEntry) candidates.push([join(dirname(resolve(callerEntry)), bundle), "caller-sibling-bundle"]);
  for (const [path, source] of candidates) {
    searched.push(path);
    if (exists(path)) return { command: execPath, args: [path], version, source, searched };
  }
  if (env.RED_SKILLS_NO_PINNED_DISPATCH === "1") throw new RedskilledReplacementEntryError(version, searched);
  return {
    command: env.RED_SKILLS_NPX || "npx",
    args: ["-y", "-p", `@reddb-io/red-skills@${version}`, "red-skills-redskilled"],
    version,
    source: "pinned-dispatch",
    searched,
  };
}

export interface RedskilledReplacementIO {
  /** Resolves what runs the new version; the version-pinned resolver by default. */
  readonly resolveEntry?: (version: string) => ResolvedRedskilledReplacementEntry;
  /** Starts the successor, detached; a real spawn by default. */
  readonly spawnSuccessor?: (entry: ResolvedRedskilledReplacementEntry, argv: readonly string[]) => void;
  /** Ends this process so its supervisor revives it; `process.exit` by default. */
  readonly exit?: (code: number) => void;
  readonly env?: NodeJS.ProcessEnv;
}

/** A replacement with its successor already found — nothing has moved yet. */
export interface PreparedRedskilledReplacement {
  readonly via: RedskilledReplacementVia;
  readonly to: string;
  /** What will run the new version; absent when a supervisor starts it. */
  readonly entry?: ResolvedRedskilledReplacementEntry;
}

export interface RedskilledReplacementOutcome extends PreparedRedskilledReplacement {
  readonly exitCode?: number;
}

/**
 * Find the successor BEFORE anything is given up.
 *
 * Preparation is its own step precisely so an unreachable published bundle costs
 * the upgrade and not the machine: a daemon that released the socket first and
 * only then discovered it had nothing to hand over to would have turned a version
 * skew into an outage.
 */
export function prepareRedskilledReplacement(
  decision: Extract<RedskilledReplacementDecision, { act: "replace" }>,
  io: RedskilledReplacementIO = {},
): PreparedRedskilledReplacement {
  if (decision.via === "supervisor-exit") return { via: decision.via, to: decision.to };
  const resolve = io.resolveEntry ??
    ((version: string) => requireRedskilledReplacementEntry(version, io.env == null ? {} : { env: io.env }));
  return { via: decision.via, to: decision.to, entry: resolve(decision.to) };
}

/**
 * Complete one replacement, on a daemon that has ALREADY let go of the session.
 *
 * The order is not negotiable: the old process releases the socket and the lease
 * first, and only then is a successor started — a successor racing a live holder
 * would lose the exclusive bind and die, leaving the machine on the old bundle
 * with a daemon that believed it had handed over.
 */
export function completeRedskilledReplacement(
  prepared: PreparedRedskilledReplacement,
  target: RedskilledServeTarget,
  options: { readonly idleMs?: number; readonly io?: RedskilledReplacementIO } = {},
): RedskilledReplacementOutcome {
  const io = options.io ?? {};
  if (prepared.via === "supervisor-exit" || prepared.entry == null) {
    (io.exit ?? defaultExit)(REDSKILLED_REPLACE_EXIT_CODE);
    return { ...prepared, exitCode: REDSKILLED_REPLACE_EXIT_CODE };
  }
  const argv = [
    ...prepared.entry.args,
    ...redskilledServeArgv(target, options.idleMs == null ? {} : { idleMs: options.idleMs }),
  ];
  (io.spawnSuccessor ?? defaultSpawnSuccessor(io.env))(prepared.entry, argv);
  return prepared;
}

function defaultSpawnSuccessor(env: NodeJS.ProcessEnv | undefined) {
  return (entry: ResolvedRedskilledReplacementEntry, argv: readonly string[]): void => {
    const child = spawn(entry.command, [...argv], {
      detached: true,
      stdio: "ignore",
      env: { ...(env ?? process.env), REDSKILLED_DAEMON: "1" },
    });
    child.on("error", () => undefined);
    child.unref();
  };
}

function defaultExit(code: number): void {
  process.exitCode = code;
  process.exit(code);
}

/**
 * The default published-version probe: the registry, with the bundle cache as
 * weaker evidence.
 *
 * A cached bundle proves a version was published once and nothing more, so it is
 * only consulted when the registry could not be read at all. Never substitutes
 * the running version for the published one — an unresolvable answer stays null,
 * because a manufactured match is what makes a stale daemon look current.
 */
export async function probePublishedRedskilledVersion(
  running: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchText: (url: string) => Promise<string> = defaultFetchText,
): Promise<string | null> {
  const cached = newestCachedRedskilledVersion(env);
  if (env[REDSKILLED_NO_REGISTRY_PROBE_ENV] === "1") return cached;
  const floor = parseSemver(running) === null ? "0.0.0" : running;
  try {
    const newest = await fetchNewestSameMajor({ fetchText }, floor);
    return newest ?? cached;
  } catch {
    return cached;
  }
}

/** The newest version this host already holds a redskilled bundle for. */
export function newestCachedRedskilledVersion(
  env: NodeJS.ProcessEnv = process.env,
  listDir: (path: string) => readonly string[] = listDirSafe,
): string | null {
  let best: string | null = null;
  for (const name of listDir(redskilledBundleCacheRoot(env))) {
    const version = /^redskilled-(.+)\.bundle\.min\.mjs$/.exec(name)?.[1];
    if (!version || parseSemver(version) === null) continue;
    if (best === null || compareSemver(version, best) > 0) best = version;
  }
  return best;
}

function listDirSafe(path: string): readonly string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

async function defaultFetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`registry read failed with HTTP ${response.status}`);
  return await response.text();
}

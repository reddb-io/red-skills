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
 * **A major boundary is held, and the hold is SAID.** A breaking change must not
 * arrive on a machine because a background timer noticed it, so the resolver only
 * ever adopts inside the running major — but a silent hold is indistinguishable
 * from being current, and an operator who updated the plugin to a new major and
 * saw nothing change had no surface that would tell them why (#2926). The daemon
 * therefore reports the newest published version *whatever its major*, states
 * that not adopting it is deliberate, and names the step that crosses it. A
 * refusal that is stated is a decision; a refusal that is silent is a bug.
 *
 * PURE apart from the injected spawn, exit and existence lookups.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalInvocation } from "@reddb-io/shared/canonical-invocation.js";
import { fetchPublishedVersionHorizon } from "@reddb-io/shared/bundle-fetch.js";
import { compareSemver, parseSemver } from "@reddb-io/shared/self-update.js";
import {
  redskilledBundleCacheRoot,
  redskilledServeArgv,
  type RedskilledServeTarget,
} from "./daemon-entry.js";
import {
  REDSKILLED_SUPERVISED_ENV,
  repointRedskilledUnitForReplacement,
} from "./supervision.js";

/**
 * The exit code a self-replacing daemon leaves under a supervisor.
 *
 * NON-ZERO remains useful as an observable replacement signal. The unit carries
 * `Restart=always`, so both this self-replacement and an unrelated clean internal
 * shutdown return control to the supervisor.
 */
export const REDSKILLED_REPLACE_EXIT_CODE = 75;

/**
 * How long the daemon waits between published-version checks.
 *
 * **This is the BUSY daemon's check, and it is deliberately longer than the idle
 * window** (`DEFAULT_REDSKILLED_IDLE_MS`, five minutes, in `daemon.ts`). A probe
 * costs a read of a registry every project on the host shares, so paying it every
 * few minutes on a quiet machine buys nothing — but a daemon that leaves at five
 * minutes reaches a fifteen-minute timer never, and shipped alone this interval
 * made self-replacement unreachable on exactly the hosts where nobody would
 * notice (#2968). The two numbers are coupled by `leaveIdleSession` in
 * `daemon.ts`, which asks once at the idle boundary, and not by their ratio:
 * whoever moves either one changes how often a LIVE daemon looks, never whether
 * an idle one looks at all.
 *
 * **It is not the only look a live daemon gets, and must not be made to carry
 * that alone.** A daemon holding a registration never reaches the idle boundary
 * — the registration is what keeps it alive — so on those hosts this interval
 * and the boot look (`DEFAULT_REDSKILLED_REPLACE_BOOT_CHECK_MS`) are the whole
 * upgrade path, and a first look one interval after start left the opening
 * fifteen minutes blind (#2975).
 */
export const DEFAULT_REDSKILLED_REPLACE_CHECK_MS = 900_000;

/** The named diagnostic a replacement emits when the new bundle is unreachable. */
export const REDSKILLED_REPLACEMENT_ENTRY_UNRESOLVED = "redskilled-replacement-entry-unresolved";

/** Env var that turns the registry read off, leaving local evidence only. */
export const REDSKILLED_NO_REGISTRY_PROBE_ENV = "REDSKILLED_NO_REGISTRY_PROBE";

/**
 * Env var a successor is born with, marking it as one.
 *
 * Carried so the new process can tell "a replacement started me" from "a client
 * started me", which is the difference between a boot check that closes the
 * window after a publish and one that could restart a mis-resolving daemon in a
 * tight loop. A successor born this way waits for the ordinary interval instead.
 */
export const REDSKILLED_BORN_BY_REPLACEMENT_ENV = "REDSKILLED_BORN_BY_REPLACEMENT";

/** True when a replacement started this process, so its boot check is not owed. */
export function isRedskilledBornByReplacement(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[REDSKILLED_BORN_BY_REPLACEMENT_ENV] === "1";
}

/**
 * What one probe resolved about the published world.
 *
 * Two numbers rather than one: `version` is the newest release this daemon may
 * ADOPT — same major, by construction — while `newest` is the newest release
 * that EXISTS. Folding them together would either adopt a major on a timer or
 * hide one, and both are the failure this module reports its way out of.
 */
export interface RedskilledPublishedObservation {
  /** The newest in-major version; null when it could not be resolved. */
  readonly version: string | null;
  /** The newest version published at all; null when it could not be resolved. */
  readonly newest?: string | null;
}

/**
 * Answers "what is published?" — an unresolvable answer is null, never a match.
 *
 * A bare version is accepted and read as the in-major answer alone: a probe that
 * only ever knew one number leaves the major horizon UNKNOWN rather than having
 * its single answer promoted into a claim about every major.
 */
export type RedskilledPublishedVersionProbe = (
  running: string,
) => Promise<string | null | RedskilledPublishedObservation>;

/** Read a probe's answer as an observation. PURE. */
export function readPublishedObservation(
  answer: string | null | RedskilledPublishedObservation,
): RedskilledPublishedObservation {
  if (answer === null || typeof answer === "string") return { version: answer, newest: null };
  return { version: answer.version, newest: answer.newest ?? null };
}

/**
 * A published major this daemon deliberately will not adopt, and the way across.
 *
 * `reason` and `action` are sentences rather than codes because this block exists
 * to be READ: the operator it is written for has already updated something and
 * watched nothing happen, and a surface that answered them with `major_held: 1`
 * would leave them exactly where the silent hold did.
 */
export interface RedskilledMajorHold {
  /** The newest published version, which lives beyond the running major. */
  readonly version: string;
  readonly running_major: number;
  readonly held_major: number;
  /** Why this daemon is not on it — stated so it does not read as a fault. */
  readonly reason: string;
  /** The manual step that crosses the boundary. */
  readonly action: string;
}

export interface PlanRedskilledMajorHoldInput {
  /** The version this process is RUNNING — never the one it resolved. */
  readonly running: string;
  /** The newest version published at all; null or unknown holds nothing. */
  readonly newest: string | null | undefined;
  /** True when a unit will revive this process — it decides the operator's step. */
  readonly supervised: boolean;
}

/**
 * Decide whether a major is being held, and say so. PURE.
 *
 * Null is "nothing is being withheld", and it is the answer for a daemon that is
 * current, one merely behind inside its major, and one whose probe resolved
 * nothing — a hold reported off an answer that was never read would make an
 * unreachable registry look like a pending breaking change.
 */
export function planRedskilledMajorHold(input: PlanRedskilledMajorHoldInput): RedskilledMajorHold | null {
  const running = input.running.trim();
  if (isLocalRedskilledBuild(running)) return null;
  const newest = input.newest?.trim() ?? "";
  const held = parseSemver(newest);
  const now = parseSemver(running);
  if (held === null || now === null || held.major <= now.major) return null;
  return {
    version: newest,
    running_major: now.major,
    held_major: held.major,
    reason:
      `redskilled ${newest} is published and this daemon runs ${running}; a major version is ` +
      `deliberately never adopted by the background check, because a breaking change must not ` +
      `arrive on a machine that is holding Workers`,
    action: majorHoldAction(held.major, input.supervised),
  };
}

/**
 * The step, addressed to whoever would revive this daemon.
 *
 * Under a unit the `ExecStart` is what has to move — a bare restart would revive
 * the same argv and the same major — so re-installing it is named first. With no
 * unit nothing revives this process at all, and stopping it is the whole step:
 * the next client start resolves the bundle the machine now holds.
 */
function majorHoldAction(heldMajor: number, supervised: boolean): string {
  const install = `install the ${heldMajor}.x bundle (update this machine's plugin pin), then `;
  return supervised
    ? `${install}re-point the unit and restart it: ${canonicalInvocation("red-skills-redskilled", ["unit", "install"])}` +
      " && systemctl --user restart redskilled.service"
    : `${install}stop this daemon — the next client start resolves the newly installed bundle`;
}

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
        `reachable path and the version-pinned dispatch is disabled or resolves no absolute npx\nsearched:\n${
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
  // The command must be ABSOLUTE: this entry is also what a supervised
  // replacement writes into the unit's ExecStart, and systemd resolves that
  // binary with the MANAGER's PATH — system directories only on hosts whose
  // node comes from a version manager, where a bare `npx` is 203/EXEC on every
  // start until a human runs `reset-failed` (#3554). An unresolvable npx costs
  // the upgrade, never the machine.
  const npx = resolveAbsoluteNpx(env, exists, execPath, searched);
  if (npx == null) throw new RedskilledReplacementEntryError(version, searched);
  return {
    command: npx,
    args: ["-y", "-p", `@reddb-io/red-skills@${version}`, "red-skills-redskilled"],
    version,
    source: "pinned-dispatch",
    searched,
  };
}

/**
 * An absolute path to `npx`, or null when the host offers none.
 *
 * An absolute `RED_SKILLS_NPX` is honored as stated; a relative one names the
 * binary to find rather than where it is. The search is the resolving
 * process's own view — the directory beside its node first, because every node
 * install ships an `npx` sibling, then its PATH — and every miss lands in
 * `searched` so the refusal names where it looked.
 */
function resolveAbsoluteNpx(
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
  execPath: string,
  searched: string[],
): string | null {
  const stated = env.RED_SKILLS_NPX?.trim();
  if (stated && isAbsolute(stated)) return stated;
  const names = process.platform === "win32"
    ? [stated || "npx.cmd", "npx.cmd", "npx.exe", "npx"]
    : [stated || "npx"];
  const directories = [dirname(execPath), ...(env.PATH ?? "").split(delimiter).filter((dir) => dir.length > 0)];
  for (const name of new Set(names)) {
    for (const directory of directories) {
      const candidate = join(directory, name);
      searched.push(candidate);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

export interface RedskilledReplacementIO {
  /** Resolves what runs the new version; the version-pinned resolver by default. */
  readonly resolveEntry?: (version: string) => ResolvedRedskilledReplacementEntry;
  /** Starts the successor, detached; a real spawn by default. */
  readonly spawnSuccessor?: (entry: ResolvedRedskilledReplacementEntry, argv: readonly string[]) => void;
  /** Repoints a supervising unit before the old daemon releases its socket. */
  readonly repointSupervisor?: (
    entry: ResolvedRedskilledReplacementEntry,
    target: RedskilledServeTarget,
    idleMs?: number,
  ) => void;
  /** Ends this process so its supervisor revives it; `process.exit` by default. */
  readonly exit?: (code: number) => void;
  readonly env?: NodeJS.ProcessEnv;
}

/** A replacement with its successor already found — nothing has moved yet. */
export interface PreparedRedskilledReplacement {
  readonly via: RedskilledReplacementVia;
  readonly to: string;
  /** What will run the new version, resolved before the old daemon lets go. */
  readonly entry: ResolvedRedskilledReplacementEntry;
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
  target?: RedskilledServeTarget,
  idleMs?: number,
): PreparedRedskilledReplacement {
  const resolve = io.resolveEntry ??
    ((version: string) => requireRedskilledReplacementEntry(version, io.env == null ? {} : { env: io.env }));
  const entry = resolve(decision.to);
  if (decision.via === "supervisor-exit") {
    const repoint = io.repointSupervisor ?? ((resolved: ResolvedRedskilledReplacementEntry, serve: RedskilledServeTarget, ms?: number) =>
      repointRedskilledUnitForReplacement(resolved, serve, {
        ...(io.env == null ? {} : { env: io.env }),
        ...(ms == null ? {} : { idleMs: ms }),
      }));
    if (target == null) throw new Error("a supervised redskilled replacement needs its serve target before exit");
    repoint(entry, target, idleMs);
  }
  return { via: decision.via, to: decision.to, entry };
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
  if (prepared.via === "supervisor-exit") {
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
      env: {
        ...(env ?? process.env),
        REDSKILLED_DAEMON: "1",
        [REDSKILLED_BORN_BY_REPLACEMENT_ENV]: "1",
      },
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
 *
 * The adoptable answer is capped at the running major on EVERY path, the cache
 * included: a host that happens to hold a next-major bundle must not cross the
 * boundary just because the registry was unreachable that minute — that is the
 * timer-driven breaking change the hold exists to refuse. The cached bundle still
 * counts towards `newest`, so the gap is reported rather than acted on.
 */
export async function probePublishedRedskilledVersion(
  running: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchText: (url: string) => Promise<string> = defaultFetchText,
): Promise<RedskilledPublishedObservation> {
  const cachedNewest = newestCachedRedskilledVersion(env);
  const cachedInMajor = newestCachedRedskilledVersionInMajor(running, env);
  if (env[REDSKILLED_NO_REGISTRY_PROBE_ENV] === "1") return { version: cachedInMajor, newest: cachedNewest };
  const floor = parseSemver(running) === null ? "0.0.0" : running;
  try {
    const horizon = await fetchPublishedVersionHorizon({ fetchText }, floor);
    return { version: horizon.sameMajor ?? cachedInMajor, newest: horizon.newest ?? cachedNewest };
  } catch {
    return { version: cachedInMajor, newest: cachedNewest };
  }
}

/**
 * What this host can say about the published world WITHOUT asking anybody.
 *
 * The same weaker evidence `probePublishedRedskilledVersion` falls back to when
 * the registry throws, lifted out so the caller that gives up on a slow read can
 * reach it too. A read that runs out of time and a read that fails are the same
 * fact — nothing was resolved from the registry — and answering one of them with
 * the cached bundle while answering the other with `null` is how a host that
 * already HELD the newer bundle went on serving the older one (#2975).
 *
 * PURE apart from the directory listing.
 */
export function localRedskilledPublishedEvidence(
  running: string,
  env: NodeJS.ProcessEnv = process.env,
  listDir?: (path: string) => readonly string[],
): RedskilledPublishedObservation {
  const list = listDir ?? listDirSafe;
  return {
    version: newestCachedRedskilledVersionInMajor(running, env, list),
    newest: newestCachedRedskilledVersion(env, list),
  };
}

/** The newest version this host already holds a redskilled bundle for. */
export function newestCachedRedskilledVersion(
  env: NodeJS.ProcessEnv = process.env,
  listDir: (path: string) => readonly string[] = listDirSafe,
): string | null {
  return newestCached(cachedRedskilledVersions(env, listDir));
}

/** The newest cached bundle inside `running`'s major — the only one adoptable. */
export function newestCachedRedskilledVersionInMajor(
  running: string,
  env: NodeJS.ProcessEnv = process.env,
  listDir: (path: string) => readonly string[] = listDirSafe,
): string | null {
  const major = parseSemver(running.trim())?.major;
  if (major === undefined) return null;
  return newestCached(cachedRedskilledVersions(env, listDir).filter((v) => parseSemver(v)?.major === major));
}

/** Every version this host holds a redskilled bundle for, unordered. */
function cachedRedskilledVersions(
  env: NodeJS.ProcessEnv,
  listDir: (path: string) => readonly string[],
): readonly string[] {
  const versions: string[] = [];
  for (const name of listDir(redskilledBundleCacheRoot(env))) {
    const version = /^redskilled-(.+)\.bundle\.min\.mjs$/.exec(name)?.[1];
    if (!version || parseSemver(version) === null) continue;
    versions.push(version);
  }
  return versions;
}

function newestCached(versions: readonly string[]): string | null {
  let best: string | null = null;
  for (const version of versions) {
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

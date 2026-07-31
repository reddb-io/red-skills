/**
 * supervisor-entry — which bundle a fleet launch actually starts.
 *
 * The launch used to build the supervisor's argv out of `process.argv[1]`, so the
 * supervisor inherited whatever bundle the launching process happened to run. A
 * fleet stranded by a release therefore could not be repaired by relaunching it:
 * the MCP server's own plugin-cache bundle was older still, so the prescribed fix
 * ("restart the fleet from the current bundle") produced a WIDER skew and every
 * worker kept boot-halting (#2808, same defect class as #2736/#2677 — never infer
 * the executable from the caller's argv).
 *
 * This module resolves the entry from the published version instead: the launch
 * asks {@link resolvePublishedDevBundleVersion} and then finds an entry that
 * runs THAT version. The reporting surfaces resolve the same fact through
 * `published-version.ts` (#2809), which records the answer so a reader replays
 * it instead of deriving its own; both paths must agree on what "published"
 * means, and a disagreement between them is the bug class, not a detail. When
 * the published version cannot be resolved it says so, loudly
 * ({@link SupervisorEntryError}), because silently falling back to the caller's
 * bundle is what turned a detectable skew into a wider one.
 */
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { readBuildInfo } from "@reddb-io/build-info";
import { compareSemver, redSkillsCacheDir, resolvePublishedDevBundleVersion, semverParts } from "../core/bundle-version.js";

/** No published version could be resolved — the launch refuses instead of guessing. */
export const PUBLISHED_VERSION_UNRESOLVED = "dev-published-version-unresolved";
/** The published version is known but no entry on this host runs it. */
export const SUPERVISOR_ENTRY_UNRESOLVED = "dev-supervisor-entry-unresolved";

/** Which candidate produced the entry — carried for diagnosis, never for logic. */
export type SupervisorEntrySource =
  | "local-build"
  | "caller-entry"
  | "bundle-cache"
  | "caller-sibling-bundle"
  | "pinned-dispatch";

export interface ResolvedSupervisorEntry {
  readonly command: string;
  /** argv up to but excluding the dev subcommand (`__supervise` and its passthrough). */
  readonly args: string[];
  /** The version this entry runs: the published version, or a local build's own. */
  readonly version: string;
  readonly source: SupervisorEntrySource;
}

/** Injected environment. Every field defaults to this process, so tests can pose as a stale host. */
export interface SupervisorEntryLookup {
  /** The launching process's own entrypoint (`process.argv[1]` by default). */
  callerEntry?: string;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  /** The launching process's own bundle version (build info by default). */
  installedVersion?: string;
  /** Published-version resolver; defaults to the one the boot probe reads. */
  resolvePublished?: (installed: string, env: NodeJS.ProcessEnv) => string | undefined;
}

/** Thrown by the launch path so an unresolvable published bundle is a named, loud failure. */
export class SupervisorEntryError extends Error {
  readonly code: string;
  /** Every path that was probed, in order — the message a human needs. */
  readonly searched: string[];

  constructor(code: string, message: string, searched: readonly string[] = []) {
    super(message);
    this.name = "SupervisorEntryError";
    this.code = code;
    this.searched = [...searched];
  }
}

const DEV_BUNDLE = "dev.bundle.min.mjs";

/**
 * Resolve the dev CLI bundle path from argv[1]. In MCP context argv[1] is the
 * castle-mcp bundle, which has no `__supervise` entry point; the sibling dev
 * bundle does. Falls back to argv1 unchanged so the CLI path (argv[1] already
 * is the dev bundle or a shim) is unaffected.
 */
export function resolveDevScriptPath(argv1: string): string {
  const file = basename(argv1);
  if (file === "castle-mcp.bundle.min.mjs") {
    return join(dirname(argv1), DEV_BUNDLE);
  }
  if (file.startsWith("castle-mcp-") && file.endsWith(".bundle.min.mjs")) {
    return join(dirname(argv1), file.replace(/^castle-mcp-/, "dev-"));
  }
  return argv1;
}

/**
 * A source checkout or unreleased build (`0.0.0-dev`, any prerelease) is not a
 * point on the published lane, so it never redirects: the developer's own bundle
 * is the intended runtime, and comparing it to a cached release is meaningless.
 */
export function isLocalDevBuild(version: string): boolean {
  return /^\d+\.\d+\.\d+[-+]/.test(version.trim());
}

/**
 * The command that runs `__supervise` at the published version.
 *
 * Order is published-first: a local build runs itself, a launcher already AT the
 * published version runs its own entry, and a launcher BEHIND it is redirected to
 * the published bundle — cached bundle, then the bundle shipped beside the caller,
 * then a version-pinned npx dispatch. Nothing in that list is the caller's own
 * stale bundle.
 */
/**
 * The published bundle as a bare argv head — `[command, …args]`.
 *
 * A registration states what to RUN rather than what to spawn (ADR 0130
 * Amendment 4), so it needs the same resolution a launch does and none of the
 * launch: same published-first order, same loud failure when the published
 * bundle cannot be resolved. Sharing the resolver is the point — a registration
 * that named the caller's own stale bundle is how a release strands a project
 * without ever spawning anything (#2808).
 */
export function publishedBundleArgv(lookup: SupervisorEntryLookup = {}): readonly string[] {
  const entry = resolveSupervisorEntry(lookup);
  return [entry.command, ...entry.args];
}

export function resolveSupervisorEntry(lookup: SupervisorEntryLookup = {}): ResolvedSupervisorEntry {
  const env = lookup.env ?? process.env;
  const exists = lookup.exists ?? existsSync;
  const execPath = lookup.execPath ?? process.execPath;
  const callerEntry = lookup.callerEntry === undefined ? process.argv[1] ?? "" : lookup.callerEntry;
  const installed = (lookup.installedVersion ?? readBuildInfo("dev").version).trim();
  const node = (entry: string, version: string, source: SupervisorEntrySource): ResolvedSupervisorEntry =>
    // Only the script: the supervisor is a detached long-lived process, so it must
    // not inherit the launching process's node flags.
    ({ command: execPath, args: [entry], version, source });

  if (isLocalDevBuild(installed)) {
    return node(resolveDevScriptPath(callerEntry), installed, "local-build");
  }

  const published = (lookup.resolvePublished ?? resolvePublishedDevBundleVersion)(installed, env);
  if (!published || semverParts(published) === null) {
    throw new SupervisorEntryError(
      PUBLISHED_VERSION_UNRESOLVED,
      `${PUBLISHED_VERSION_UNRESOLVED}: cannot resolve the published dev bundle version ` +
        `(launching bundle: ${installed || "<none>"}); refusing to launch a supervisor from the caller's bundle ` +
        `because a silent fallback is how a release strands a fleet (#2808)`,
    );
  }
  if (compareSemver(published, installed) === 0) {
    return node(resolveDevScriptPath(callerEntry), published, "caller-entry");
  }

  const searched: string[] = [];
  for (const [path, source] of publishedCandidates(published, callerEntry, env)) {
    searched.push(path);
    if (exists(path)) return node(path, published, source);
  }
  const dispatch = pinnedDispatch(published, env);
  if (dispatch) return { ...dispatch, version: published, source: "pinned-dispatch" };
  throw new SupervisorEntryError(
    SUPERVISOR_ENTRY_UNRESOLVED,
    `${SUPERVISOR_ENTRY_UNRESOLVED}: the published dev bundle ${published} exists on no reachable path ` +
      `and the version-pinned dispatch is disabled (launching bundle: ${installed})`,
    searched,
  );
}

/**
 * The version a supervisor spawned right now would report. Never throws — a
 * heartbeat stamp that cannot resolve the published version still records the
 * launching bundle, because an absent version reads as unknown, not as skewed.
 */
export function supervisorLaunchVersion(lookup: SupervisorEntryLookup = {}): string {
  try {
    return resolveSupervisorEntry(lookup).version;
  } catch {
    return lookup.installedVersion ?? readBuildInfo("dev").version;
  }
}

function* publishedCandidates(
  published: string,
  callerEntry: string,
  env: NodeJS.ProcessEnv,
): Generator<[string, SupervisorEntrySource]> {
  const bundle = `dev-${published}.bundle.min.mjs`;
  yield [join(redSkillsCacheDir(env), bundle), "bundle-cache"];
  if (callerEntry) {
    // Host bundles are published side by side as cache-keyed `<plugin>-<version>`.
    yield [join(dirname(resolve(callerEntry)), bundle), "caller-sibling-bundle"];
  }
}

/**
 * The version-pinned dispatch — the escape that operators had to write by hand
 * three times in one session (#2808). `RED_SKILLS_NO_PINNED_DISPATCH=1` removes
 * it, which turns an unreachable published bundle into a loud refusal.
 */
function pinnedDispatch(
  published: string,
  env: NodeJS.ProcessEnv,
): { command: string; args: string[] } | null {
  if (env.RED_SKILLS_NO_PINNED_DISPATCH === "1") return null;
  return {
    command: env.RED_SKILLS_NPX || "npx",
    args: ["-y", "-p", `@reddb-io/red-skills@${published}`, "red-skills-dev"],
  };
}

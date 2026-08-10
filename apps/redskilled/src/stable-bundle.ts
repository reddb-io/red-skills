/**
 * stable-bundle — the ExecStart target nothing on the host prunes.
 *
 * The #3554 fix made every unit writer emit an ABSOLUTE command, which closed
 * the 203/EXEC hole but left the target's durability to whoever owns the
 * directory it lives in: the npx cache is GC'd, a mise toolchain directory
 * vanishes on `mise prune`, and a repo checkout moves. An absolute path into a
 * pruned cache is the same dead unit wearing a longer name — systemd starts
 * nothing, the boot self-heal never runs because there is no boot, and the
 * host is back to hand surgery.
 *
 * The closure is a copy the daemon owns: `~/.red/redskilled/bundles/`, inside
 * the host-scoped home that outlives every cache on the machine. Every writer
 * that is about to put a `node <bundle>` pair into an `ExecStart` first
 * stabilizes the bundle into that directory and points the unit at the copy.
 * Node itself stays the irreducible dependency — a host that deletes its node
 * has nothing any path can save.
 *
 * **Version attribution must be certain before a copy is named.** A stable file
 * claims its version in its filename, and a resolver later probes it BY that
 * name — a copy filed under a version it is not would serve wrong code with a
 * straight face. So stabilization happens only when the attribution is
 * authoritative: a replacement entry resolved FOR a version, a running daemon
 * copying its own entry under its own reported version, or a source file whose
 * basename already carries its version. Local builds are never stabilized —
 * `0.0.0-dev` is one name for many different bytes.
 *
 * **The home is never created here** (ADR 0130 Amendment 2: the provisioner and
 * the canonical log writer are the creators). A host without the home keeps
 * the entry it resolved — stabilization is an upgrade to durability, not a
 * precondition, and it must never break the upgrade it decorates: every
 * filesystem failure returns the original entry untouched.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { redskilledHomeDir } from "@reddb-io/shared/redskilled-home.js";
import { parseSemver } from "@reddb-io/shared/self-update.js";

/** Where stable copies live, under the daemon's host-scoped home. PURE. */
export function redskilledStableBundleDir(homeDir: string = homedir()): string {
  return join(redskilledHomeDir(homeDir), "bundles");
}

/** The stable file name for one version. One spelling, shared with the probes. */
export function redskilledStableBundleName(version: string): string {
  return `redskilled-${version}.bundle.min.mjs`;
}

const VERSIONED_BASENAME = /^redskilled-(.+)\.bundle\.min\.mjs$/;

export interface StabilizableRedskilledEntry {
  readonly command: string;
  readonly args: readonly string[];
  /** The bundle file the command runs, when the entry is a `node <file>` pair. */
  readonly entry?: string;
}

export interface StabilizeRedskilledEntryOptions {
  /**
   * The version the entry is KNOWN to run, from an authoritative source. Absent,
   * only a source whose basename already carries its version is stabilized.
   */
  readonly version?: string;
  /**
   * The operator home the stable directory hangs off. `undefined` (an env that
   * names no home) disables stabilization; `homedir()` when omitted entirely.
   */
  readonly homeDir?: string | undefined;
  readonly exists?: (path: string) => boolean;
}

/**
 * Point an entry at its stable copy, creating the copy when absent.
 *
 * Returns the entry unchanged whenever stabilization is not safely possible:
 * no entry file (an npx dispatch), no certain version, a local build, a host
 * without the daemon home, or any filesystem refusal. The caller never has to
 * distinguish — the returned entry is always runnable.
 */
export function stabilizeRedskilledEntry<T extends StabilizableRedskilledEntry>(
  entry: T,
  options: StabilizeRedskilledEntryOptions = {},
): T {
  const source = entry.entry;
  if (source == null) return entry;
  // Only the BUNDLE is copyable: the packaged shim resolves its bundle relative
  // to itself, so a copy of the shim alone is a file that runs nothing.
  if (!/^redskilled(-.+)?\.bundle\.min\.mjs$/.test(basename(source))) return entry;
  const named = VERSIONED_BASENAME.exec(basename(source))?.[1];
  const version = options.version ?? named;
  // Same boundary as `isLocalRedskilledBuild`: a prerelease or build-stamped
  // version is one name for many different bytes, so it is never filed.
  if (version == null || parseSemver(version) === null || /[-+]/.test(version)) return entry;
  // A stated-but-undefined home (an env that names none) disables stabilization
  // outright; only a caller that says nothing at all gets the process default.
  const homeDir = "homeDir" in options ? options.homeDir : homedir();
  if (homeDir == null) return entry;
  const exists = options.exists ?? existsSync;
  const stableDir = redskilledStableBundleDir(homeDir);
  const target = join(stableDir, redskilledStableBundleName(version));
  if (resolve(source) === resolve(target)) return entry;
  try {
    // Amendment 2: the home has its two creators, and this is neither — a host
    // without one keeps the resolved entry and loses nothing but durability.
    if (!statSync(redskilledHomeDir(homeDir)).isDirectory()) return entry;
    if (!exists(target)) {
      mkdirSync(stableDir, { recursive: true, mode: 0o700 });
      const temporary = `${target}.${process.pid}.tmp`;
      writeFileSync(temporary, readFileSync(source), { mode: 0o755 });
      renameSync(temporary, target);
    }
  } catch {
    return entry;
  }
  return {
    ...entry,
    entry: target,
    args: entry.args.map((arg) => (resolve(arg) === resolve(source) ? target : arg)),
  };
}

/**
 * The operator home an env describes — and ONLY what it describes.
 *
 * Deliberately no `homedir()` fallback: resolution scoped by an injected env
 * (every test, some clients) must never reach the REAL operator's home through
 * a default — a test that stabilized a fake bundle into the live
 * `~/.red/redskilled/bundles/` would poison the very directory upgrades trust
 * (the #3554 heal grew its identity gate for the same reason). A production
 * process resolves under `process.env`, where HOME is set.
 */
export function stableBundleHomeOf(env: NodeJS.ProcessEnv): string | undefined {
  return env.HOME?.trim() || undefined;
}

/** Re-exported pattern so probes and tests share one idea of a versioned name. */
export function stableBundleVersionOf(path: string): string | undefined {
  return VERSIONED_BASENAME.exec(basename(path))?.[1] ?? undefined;
}

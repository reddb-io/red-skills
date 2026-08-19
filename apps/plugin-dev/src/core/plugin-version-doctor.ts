// plugin-version-doctor — is the plugin that answers actually current? (#3147)
//
// **Two update lanes exist and only one was watched.** The BUNDLE lane
// self-updates and works: `dev-stable.current` tracks the published version, the
// status file says `up-to-date`, and a registration's argv correctly names the
// newest cached bundle. The PLUGIN lane — the host's own install, which carries
// the MCP server and the skills — is updated by the agent host's plugin manager,
// and nothing here ever looked at its version.
//
// It sat eight releases behind while every surface read green. `red-doctor`
// reported `marketplace findings: 0`, and `mcp-load-doctor` asked only whether
// servers loaded, never which bundle answered them.
//
// **The skew is invisible from the outside, which is why it needs a probe.** The
// MCP server is what COMPOSES a project registration; an old adapter registers
// with an empty launch environment and writes the CURRENT bundle path into the
// argv. So a fresh Worker runs new code, born from a registration composed by
// old code, and every version number on screen is true about something else.
// That cost a full session of debugging a fix that had already shipped.
//
// PURE: the caller reads the filesystem and the registry; this decides.

/** Where a version came from, so a report can name it. */
export type PluginVersionSource = "installed-plugin" | "published";

export interface PluginVersionFacts {
  /** Newest version present in the host's plugin cache; `null` when none is. */
  readonly installed: string | null;
  /** What the registry publishes; `null` when it could not be asked. */
  readonly published: string | null;
  /** Every version the plugin cache holds, newest last. For the report only. */
  readonly cached?: readonly string[];
}

export type PluginVersionVerdict =
  | "current"
  /** Behind by less than the bound — worth saying, not worth shouting. */
  | "behind"
  /** Behind by the bound or more: the machine is running something else. */
  | "stale"
  /** Nothing installed at all. */
  | "absent"
  /**
   * The registry could not be asked.
   *
   * **Unknown is not current.** Reporting an unaskable registry as up-to-date is
   * the same confusion — an inconclusive result read as a negative one — that
   * this repo has now hit in four organs, so it gets its own verdict.
   */
  | "unknown";

export interface PluginVersionReport {
  readonly verdict: PluginVersionVerdict;
  readonly installed: string | null;
  readonly published: string | null;
  /** How many patch releases behind, when both versions parse; `null` otherwise. */
  readonly behindBy: number | null;
  /** One sentence naming both numbers, for an operator who reads nothing else. */
  readonly detail: string;
  /** The command that closes the gap, or `null` when nothing is to be done. */
  readonly fix: string | null;
}

/**
 * How far behind is loud rather than merely noted.
 *
 * Two, because one release behind is the ordinary state of a machine between a
 * publish and its next restart, and three is where the adapter that composes a
 * registration starts predating fixes the bundle already carries.
 */
export const PLUGIN_VERSION_STALE_AFTER = 2;

/** Parse a dotted version into comparable parts; `null` when it is not one. */
function parts(version: string | null): readonly number[] | null {
  if (version == null) return null;
  const matched = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return matched === null ? null : [Number(matched[1]), Number(matched[2]), Number(matched[3])];
}

/** Negative when `a` is older, 0 when equal, positive when newer. PURE. */
export function compareVersions(a: string | null, b: string | null): number | null {
  const left = parts(a);
  const right = parts(b);
  if (left === null || right === null) return null;
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The recipe that closes the gap.
 *
 * Names the marketplace rather than a package: the plugin lane is installed by
 * the agent host, and telling an operator to run npm would repair the lane that
 * was never broken.
 */
export function pluginUpdateRecipe(marketplace = "red-skills"): string {
  return `update the ${marketplace} plugin from its marketplace, then restart the session ` +
    `(an MCP server registers at plugin load and keeps whatever bundle it started with)`;
}

/** Decide whether the plugin answering is the one that shipped. PURE. */
export function judgePluginVersion(facts: PluginVersionFacts): PluginVersionReport {
  const { installed, published } = facts;
  const base = { installed, published };

  if (installed == null) {
    return {
      ...base,
      verdict: "absent",
      behindBy: null,
      detail: "no red-skills plugin is installed for this host, so nothing of ours answers here",
      fix: pluginUpdateRecipe(),
    };
  }
  if (published == null) {
    return {
      ...base,
      verdict: "unknown",
      behindBy: null,
      detail:
        `the registry could not be asked, so whether the installed plugin ${installed} is current is unknown — ` +
        "and unknown is not current",
      fix: null,
    };
  }

  const order = compareVersions(installed, published);
  if (order === null) {
    return {
      ...base,
      verdict: "unknown",
      behindBy: null,
      detail:
        `installed ${JSON.stringify(installed)} or published ${JSON.stringify(published)} is not a version this ` +
        "probe can compare, so the gap is unknown",
      fix: null,
    };
  }
  if (order >= 0) {
    return {
      ...base,
      verdict: "current",
      behindBy: 0,
      detail: `the installed plugin ${installed} is the published one`,
      fix: null,
    };
  }

  const behindBy = patchDistance(installed, published);
  const stale = behindBy == null || behindBy >= PLUGIN_VERSION_STALE_AFTER;
  return {
    ...base,
    verdict: stale ? "stale" : "behind",
    behindBy,
    detail:
      `the installed plugin is ${installed} and ${published} is published` +
      (behindBy == null ? "" : ` — ${behindBy} release${behindBy === 1 ? "" : "s"} behind`) +
      (stale
        ? ". The MCP server this plugin carries is what COMPOSES a project registration, so an old one registers " +
          "with an empty launch environment while writing the CURRENT bundle path into the argv — a fresh Worker " +
          "running new code, born from a registration composed by old code."
        : "."),
    fix: pluginUpdateRecipe(),
  };
}

/** Patch releases between two versions on the same minor; `null` across minors. */
function patchDistance(installed: string, published: string): number | null {
  const left = parts(installed);
  const right = parts(published);
  if (left === null || right === null) return null;
  if (left[0] !== right[0] || left[1] !== right[1]) return null;
  return (right[2] ?? 0) - (left[2] ?? 0);
}

/**
 * Read the host's plugin cache and the registry. IO — the only impure thing here.
 *
 * The cache directory is the agent host's, not ours, so a missing one is an
 * ordinary machine rather than a fault: it yields `installed: null` and the
 * judgement calls that `absent`.
 */
export async function readInstalledPluginVersions(io: {
  readonly homedir?: () => string;
  readonly readdir?: (path: string) => Promise<readonly string[]>;
  readonly publishedVersion?: () => Promise<string | null>;
} = {}): Promise<PluginVersionFacts> {
  const home = (io.homedir ?? (() => process.env.HOME ?? ""))();
  const dir = `${home}/.claude/plugins/cache/red-skills/dev`;
  let cached: string[] = [];
  try {
    const readdir = io.readdir ?? (async (path: string) => {
      const { readdir: read } = await import("node:fs/promises");
      return await read(path);
    });
    cached = [...(await readdir(dir))]
      .filter((name) => /^\d+\.\d+\.\d+/.test(name))
      .sort((a, b) => compareVersions(a, b) ?? 0);
  } catch {
    cached = [];
  }
  const published = await (io.publishedVersion ?? readPublishedVersion)();
  return {
    installed: cached.length === 0 ? null : cached[cached.length - 1]!,
    published,
    cached,
  };
}

/** What the registry publishes; `null` when it cannot be asked. */
async function readPublishedVersion(): Promise<string | null> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const { stdout } = await run("npm", ["view", "@reddb-io/red-skills", "version"], { timeout: 15_000 });
    const version = stdout.trim();
    return /^\d+\.\d+\.\d+/.test(version) ? version : null;
  } catch {
    // Offline, no npm, a private registry that refused: all the same answer.
    // `null` becomes `unknown`, never `current`.
    return null;
  }
}

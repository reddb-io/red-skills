// warm-path-doctor — does the fetcher on THIS host know what it must warm? (#3153)
//
// **A fix that ships in the bundle lane cannot repair the lane that fetches
// bundles.** The bundle lane self-updates: a host runs the newest cached `dev`
// bundle within minutes of a publish. The warm path does not — it is
// `hooks/red-fetch.mjs` inside the INSTALLED plugin, and it runs at whatever
// vintage the agent host's plugin manager last put there. On the reporting host
// that was nine releases back, so `companionBundlePlugins` still answered
// `["rsp"]` and the daemon bundle was warmed by nothing.
//
// The gap is silent by construction. Every version number on screen is correct
// about the bundle lane; the fetcher that never advanced is not a version
// anything prints. #3148 gave the plugin lane a number — this asks the narrower
// and more actionable question: does the fetcher this host will actually run
// name each companion, or is there a bundle nothing will ever fetch here?
//
// PURE: the caller reads the filesystem; this decides.

/** A companion and whether the installed fetcher knows to warm it. */
export interface WarmPathCompanionFact {
  readonly plugin: string;
  readonly warmed: boolean;
}

export interface WarmPathFacts {
  /** Version directory the fetcher was read from; `null` when none was found. */
  readonly fetcherVersion: string | null;
  /** Absent when no installed plugin carries a fetcher at all. */
  readonly companions: readonly WarmPathCompanionFact[];
}

export type WarmPathVerdict =
  /** Every companion is named: whatever this host warms, it warms completely. */
  | "complete"
  /** A companion the current code declares is one the installed fetcher forgets. */
  | "companion-gap"
  /**
   * No installed fetcher was found.
   *
   * **Unreadable is not complete.** Certifying a host whose warm path could not
   * even be located is the confusion this repo keeps paying for.
   */
  | "unknown";

export interface WarmPathReport {
  readonly verdict: WarmPathVerdict;
  readonly fetcherVersion: string | null;
  /** Companions the installed fetcher does not name. */
  readonly unwarmed: readonly string[];
  readonly detail: string;
  /** What closes the gap, or `null` when nothing is to be done. */
  readonly fix: string | null;
}

/**
 * The recipe that closes it.
 *
 * Names the marketplace, not npm: the warm path lives in the PLUGIN lane, and
 * telling an operator to update a bundle would repair the lane that works.
 */
export function warmPathUpdateRecipe(marketplace = "red-skills"): string {
  return `update the ${marketplace} plugin from its marketplace so the SessionStart fetcher advances ` +
    "(the bundle lane cannot carry this fix — it is the lane that fetches bundles)";
}

/** Decide whether this host's warm path can reach every companion. PURE. */
export function judgeWarmPath(facts: WarmPathFacts): WarmPathReport {
  const { fetcherVersion, companions } = facts;

  if (companions.length === 0) {
    return {
      verdict: "unknown",
      fetcherVersion,
      unwarmed: [],
      detail:
        "no installed SessionStart fetcher could be read, so whether this host warms every companion " +
        "bundle is unknown — and unknown is not complete",
      fix: null,
    };
  }

  const unwarmed = companions.filter((c) => !c.warmed).map((c) => c.plugin);
  if (unwarmed.length === 0) {
    return {
      verdict: "complete",
      fetcherVersion,
      unwarmed: [],
      detail:
        `the installed fetcher${fetcherVersion === null ? "" : ` (${fetcherVersion})`} names every ` +
        `companion it must warm: ${companions.map((c) => c.plugin).join(", ")}`,
      fix: null,
    };
  }

  return {
    verdict: "companion-gap",
    fetcherVersion,
    unwarmed,
    detail:
      `the installed fetcher${fetcherVersion === null ? "" : ` (${fetcherVersion})`} does not know to warm ` +
      `${unwarmed.join(", ")}, so ${unwarmed.length === 1 ? "that bundle is" : "those bundles are"} ` +
      "fetched by nothing on this host. A missing `redskilled` bundle births no Worker at all, and the " +
      "self-healing rung that used to cover for it is what wrote the unversioned cache entry (#3153).",
    fix: warmPathUpdateRecipe(),
  };
}

/**
 * Read the installed plugin's fetcher and ask it about each companion. IO.
 *
 * The probe is a substring test over the shipped bytes rather than a call into
 * the module: the point is what the OTHER, older copy believes, and importing
 * it would answer with what THIS process believes instead — which is exactly
 * the substitution that let the gap hide.
 */
export async function readWarmPathFacts(io: {
  readonly homedir?: () => string;
  readonly readdir?: (path: string) => Promise<readonly string[]>;
  readonly readFile?: (path: string) => Promise<string>;
  readonly companions?: readonly string[];
} = {}): Promise<WarmPathFacts> {
  const { DEV_WARM_BUNDLE, companionBundlePlugins } = await import("@reddb-io/shared/bundle-fetch.js");
  // The anchor is asked about too: after ADR 0147 it is the daemon bundle, and a
  // fetcher old enough to still name `dev` warms nothing this host can run.
  const companions =
    io.companions ?? [DEV_WARM_BUNDLE, ...companionBundlePlugins(DEV_WARM_BUNDLE)];
  const home = (io.homedir ?? (() => process.env.HOME ?? ""))();
  const root = `${home}/.claude/plugins/cache/red-skills/dev`;

  const readdir =
    io.readdir ??
    (async (path: string) => {
      const { readdir: read } = await import("node:fs/promises");
      return await read(path);
    });
  const readFile =
    io.readFile ??
    (async (path: string) => {
      const { readFile: read } = await import("node:fs/promises");
      return await read(path, "utf8");
    });

  let versions: string[] = [];
  try {
    versions = [...(await readdir(root))]
      .filter((name) => /^\d+\.\d+\.\d+/.test(name))
      .sort(compareVersionDirs);
  } catch {
    versions = [];
  }

  // Newest first: an operator running several installed versions runs the one
  // the host picked, and the host picks the newest.
  for (const version of [...versions].reverse()) {
    let text: string;
    try {
      text = await readFile(`${root}/${version}/hooks/red-fetch.mjs`);
    } catch {
      continue;
    }
    return {
      fetcherVersion: version,
      companions: companions.map((plugin) => ({ plugin, warmed: text.includes(plugin) })),
    };
  }
  return { fetcherVersion: null, companions: [] };
}

function compareVersionDirs(a: string, b: string): number {
  const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(a);
  const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(b);
  if (!pa || !pb) return a.localeCompare(b);
  return (
    Number(pa[1]) - Number(pb[1]) || Number(pa[2]) - Number(pb[2]) || Number(pa[3]) - Number(pb[3])
  );
}

// app-coverage — the learned answer to "does the App stand in this repository?".
//
// The router's question costs one request, and the client that needs the answer
// is built synchronously in every Worker process. Asking on each construction
// would spend the budget the App exists to protect, and asking asynchronously
// would make the identity unknowable at the moment the transport is created.
//
// So coverage is LEARNED and remembered on disk: a synchronous read decides the
// identity, and a miss costs one request on the personal token plus one write
// that answers for every process afterwards. An installation's repository set
// changes at human speed, so a day-old answer is a good answer.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { decode, encode, type JsonValue } from "@reddb-io/toon";

/** One learned answer, with the instant it was learned. */
export interface GithubCoverageEntry {
  readonly repository: string;
  readonly covered: boolean;
  readonly learned_at: string;
}

export interface GithubCoverageCache {
  /** The remembered answer, or `undefined` when this repository is unknown. */
  covered(owner: string, repo: string): boolean | undefined;
  /** Remember one answer. Never called for an UNKNOWN outcome — silence is not a verdict. */
  remember(owner: string, repo: string, covered: boolean): void;
}

export function githubCoveragePath(hostStateRoot: string, installationId: string): string {
  return join(hostStateRoot, "github", `app-coverage-${installationId}.toon`);
}

const key = (owner: string, repo: string): string => `${owner}/${repo}`.toLowerCase();

/**
 * Open the coverage cache at `path`.
 *
 * A cache that cannot be read is an EMPTY cache, never an error: the answer it
 * holds is an optimisation, and refusing to build a client because a cache file
 * is corrupt would turn a saved request into an outage.
 */
export function openGithubCoverageCache(
  path: string,
  maxAgeMs = 24 * 60 * 60 * 1000,
  now: () => number = Date.now,
): GithubCoverageCache {
  const entries = new Map<string, GithubCoverageEntry>();
  try {
    const parsed = decode(readFileSync(path, "utf8")) as { entries?: GithubCoverageEntry[] };
    for (const entry of parsed.entries ?? []) {
      if (typeof entry?.repository === "string") entries.set(entry.repository.toLowerCase(), entry);
    }
  } catch {
    // An unreadable cache is an empty cache.
  }

  return {
    covered(owner, repo) {
      const entry = entries.get(key(owner, repo));
      if (entry === undefined) return undefined;
      const age = now() - Date.parse(entry.learned_at);
      return Number.isFinite(age) && age <= maxAgeMs ? entry.covered : undefined;
    },
    remember(owner, repo, covered) {
      entries.set(key(owner, repo), {
        repository: key(owner, repo),
        covered,
        learned_at: new Date(now()).toISOString(),
      });
      const document = { version: 1, entries: [...entries.values()] };
      try {
        mkdirSync(dirname(path), { recursive: true });
        const temporary = `${path}.writing-${process.pid}`;
        writeFileSync(temporary, encode(document as unknown as JsonValue), "utf8");
        renameSync(temporary, path);
      } catch {
        // A cache that cannot be written still answered this process.
      }
    },
  };
}

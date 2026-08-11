import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createGithubAttributionLedger, createGithubBalanceStore, createGithubClient } from "@reddb-io/github";
import { stateDir } from "@reddb-io/shared/red-paths.js";
import { redskilledHomeDir } from "@reddb-io/shared/redskilled-home.js";

import { createGithubMergeRead, type GithubMergeRead } from "../core/github-merge-read.js";

export interface CreateDevGithubMergeReadOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly readTrackerToken?: () => string | null;
}

function readTrackerToken(): string | null {
  try {
    const stdout = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Create one process-lifetime merge reader. Authentication is the intentional
 * bootstrap exemption: the routed client cannot ask GitHub until the tracker
 * credential has been resolved. Every read after that point crosses the shared
 * conditional client and its durable attribution ledger.
 */
export function createDevGithubMergeRead(
  root: string,
  actor: string,
  options: CreateDevGithubMergeReadOptions = {},
): GithubMergeRead {
  const env = options.env ?? process.env;
  const attribution = createGithubAttributionLedger({
    path: join(stateDir(root), "github", "spend.toonl"),
  });
  const balance = createGithubBalanceStore({
    path: join(redskilledHomeDir(homedir()), "state", "github", "balance.toon"),
  });

  // The credential is resolved PER READ, not at construction. Wiring the deps is
  // not a GitHub operation: demanding a token to build the port made every
  // wiring test require a real credential, which passed on a developer machine
  // with `gh` logged in and failed in CI where that context has none. Auth is a
  // precondition of reading, so the refusal belongs at the read.
  const client = () => {
    const token = (
      env.REDSKILLED_HOST_TOKEN ??
      env.GITHUB_TOKEN ??
      env.GH_TOKEN ??
      options.readTrackerToken?.() ??
      readTrackerToken() ??
      ""
    ).trim();
    if (token === "") {
      throw new Error("GitHub merge reads require an authenticated tracker credential");
    }
    return createGithubClient({ token, attribution, balance: () => balance.read() });
  };

  const routed = (): GithubMergeRead => createGithubMergeRead(client(), actor);
  return {
    reviewChecks: (repo, pr) => routed().reviewChecks(repo, pr),
    mergeState: (repo, pr) => routed().mergeState(repo, pr),
    driverPr: (repo, pr) => routed().driverPr(repo, pr),
    requiredCheckContexts: (repo, branch) => routed().requiredCheckContexts(repo, branch),
  };
}

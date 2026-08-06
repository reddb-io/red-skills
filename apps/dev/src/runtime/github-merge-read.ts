import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createGithubAttributionLedger, createGithubClient } from "@reddb-io/github";
import { stateDir } from "@reddb-io/shared/red-paths.js";

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
  const attribution = createGithubAttributionLedger({
    path: join(stateDir(root), "github", "spend.toonl"),
  });
  return createGithubMergeRead(createGithubClient({ token, attribution }), actor);
}

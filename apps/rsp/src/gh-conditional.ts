import { execFileSync } from "node:child_process";
import type { RspOverheadCeiling } from "./overhead-budget.js";
import { resolveRspConfig } from "./config.js";
import { residentElisionStore } from "./resident-store.js";
import type {
  RspResidentGithubRead,
  RspResidentGithubResult,
} from "./resident-github.js";

// Kept as compatibility exports for `rsp sweep`; live reads are resident-owned
// and no longer consult the old per-process disk cache.
export { readGhEtagCache, sweepGhEtagCache } from "./gh-etag-cache.js";

export interface GhConditionalRequest {
  path: string;
  params?: Record<string, string | number | boolean | undefined>;
  cwd?: string;
  telemetryRoot?: string;
  env?: NodeJS.ProcessEnv;
  command?: string;
  /** Explicit classified argv; inferred from the REST path for legacy callers. */
  args?: readonly string[];
  signal?: AbortSignal;
  overheadCeiling?: RspOverheadCeiling;
  cacheMaxBytes?: number;
  /** Test seam; production always sends the request to the resident. */
  residentRead?: (input: RspResidentGithubRead) => Promise<RspResidentGithubResult>;
}

export interface GhConditionalResult {
  status: number;
  stdout: string;
  stderr: string;
  etag?: string;
  quotaFree: boolean;
}

/**
 * Send one classified read to the resident-owned budget-aware GitHub client.
 *
 * No raw-gh fail-open exists here. A cold resident, missing credential, or
 * budget refusal returns a structured repair with exit 75; silently spawning gh
 * would recreate the unattributed pool drain this boundary exists to close.
 */
export async function readGhConditionalJson(request: GhConditionalRequest): Promise<GhConditionalResult> {
  if (request.signal?.aborted) {
    return { status: 1, stdout: "", stderr: "gh call cancelled", quotaFree: false };
  }
  const cwd = request.cwd ?? process.cwd();
  const env = request.env ?? process.env;
  const repo = repositoryIdentity(cwd);
  const params = {
    ...(repo ? { owner: repo.owner, repo: repo.repo } : {}),
    ...(request.params ?? {}),
  };
  const input: RspResidentGithubRead = {
    args: request.args ?? inferGithubArgs(request.path),
    path: request.path,
    actor: githubActor(env),
    ...(Object.keys(params).length > 0 ? { params } : {}),
  };

  try {
    let result: RspResidentGithubResult;
    if (request.residentRead) {
      result = await request.residentRead(input);
    } else {
      const config = resolveRspConfig(cwd, env);
      const resident = residentElisionStore(cwd, config);
      try {
        result = await resident.githubRead(input);
      } finally {
        await resident.close();
      }
    }
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      quotaFree: result.quotaFree,
    };
  } catch (error) {
    return {
      status: 75,
      stdout: "",
      stderr: JSON.stringify({
        refused: true,
        reason: "rsp-github-resident-unavailable",
        repair: "restore the rsp resident and GitHub credential, then retry",
        detail: error instanceof Error ? error.message : String(error),
      }),
      quotaFree: false,
    };
  }
}

function githubActor(env: NodeJS.ProcessEnv): string {
  const worker = (env.RED_AFK_GH_ACTOR ?? "").trim();
  return worker === "" ? "session" : `proxied-agent:${worker}`;
}

function inferGithubArgs(path: string): readonly string[] {
  if (/\/pulls\/[^/]+\/?$/.test(path)) return ["pr", "view"];
  if (/\/pulls\/?$/.test(path)) return ["pr", "list"];
  if (/\/issues\/[^/]+\/?$/.test(path)) return ["issue", "view"];
  if (/\/issues\/?$/.test(path)) return ["issue", "list"];
  if (/\/actions\/runs\/[^/]+\/?$/.test(path)) return ["run", "view"];
  if (/\/actions\/runs\/?$/.test(path)) return ["run", "list"];
  return ["api", path];
}

function repositoryIdentity(cwd: string): { owner: string; repo: string } | null {
  let remote = "";
  try {
    remote = String(execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })).trim();
  } catch {
    return null;
  }
  const normalized = remote
    .replace(/^git@[^:]+:/, "")
    .replace(/^ssh:\/\/git@[^/]+\//, "")
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/\.git$/, "")
    .replace(/^\/+|\/+$/g, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return { owner: parts[parts.length - 2]!, repo: parts[parts.length - 1]! };
}

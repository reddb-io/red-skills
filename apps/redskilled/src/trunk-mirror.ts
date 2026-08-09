/** Daemon-owned refresh of one project's trunk mirror (ADR 0138). */
import { execFile } from "node:child_process";
import type { RedskilledAdmissionVerdict } from "./admission.js";
import type { RedskilledTrunk } from "./project-registration.js";

export const REDSKILLED_TRUNK_MIRROR_REF = "refs/heads/red-trunk";

export interface RedskilledTrunkRefreshInput {
  readonly workspace_path: string;
  readonly trunk: RedskilledTrunk;
}

export type RedskilledTrunkRefresh = (input: RedskilledTrunkRefreshInput) => Promise<string>;

export function redskilledTrunkRefreshKey(input: RedskilledTrunkRefreshInput): string {
  return `${input.workspace_path}\0${input.trunk.remote}\0${input.trunk.branch}`;
}

export function unreachableTrunkAdmission(
  admission: RedskilledAdmissionVerdict,
  input: RedskilledTrunkRefreshInput,
  error: unknown,
): RedskilledAdmissionVerdict {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    ...admission,
    admitted: false,
    verdict: "refused-unreachable-trunk-remote",
    reason:
      `refused-unreachable-trunk-remote: redskilled refused this Worker because trunk remote ` +
      `${JSON.stringify(input.trunk.remote)} could not refresh branch ${JSON.stringify(input.trunk.branch)}: ${detail}`,
  };
}

export interface RedskilledBaseMovementInput {
  readonly workspace_path: string;
  readonly fork_sha: string;
  readonly head_sha: string;
}

export type RedskilledBaseMovementCounter = (input: RedskilledBaseMovementInput) => Promise<number>;

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd }, (error, stdout, stderr) => {
      if (error != null) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/** Fetch, pin the fetched commit, then advance the project's host-owned mirror. */
export async function refreshRedskilledTrunk(input: RedskilledTrunkRefreshInput): Promise<string> {
  await git(input.workspace_path, ["fetch", input.trunk.remote, input.trunk.branch]);
  const sha = await git(input.workspace_path, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
  if (sha === "") throw new Error("the fetched trunk did not resolve to a commit");
  await git(input.workspace_path, ["update-ref", REDSKILLED_TRUNK_MIRROR_REF, sha]);
  return sha;
}

/** Count the refreshed trunk commits a live Worker's granted fork does not contain. */
export async function countRedskilledBaseMovement(input: RedskilledBaseMovementInput): Promise<number> {
  const raw = await git(input.workspace_path, ["rev-list", "--count", `${input.fork_sha}..${input.head_sha}`]);
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 0) throw new Error(`git returned an invalid base movement count: ${raw}`);
  return count;
}

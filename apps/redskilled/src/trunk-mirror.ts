/** Daemon-owned refresh of one project's trunk mirror (ADR 0138). */
import { execFile } from "node:child_process";
import type { RedskilledTrunk } from "./project-registration.js";

export const REDSKILLED_TRUNK_MIRROR_REF = "refs/heads/red-trunk";

export interface RedskilledTrunkRefreshInput {
  readonly workspace_path: string;
  readonly trunk: RedskilledTrunk;
}

export type RedskilledTrunkRefresh = (input: RedskilledTrunkRefreshInput) => Promise<string>;

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

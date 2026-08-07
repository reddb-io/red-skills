import type { GithubMergeRead } from "../../src/core/github-merge-read.js";
import type { Exec } from "../../src/core/merge.js";

/** Adapt existing argv fixtures to the routed merge-read port. Tests only. */
export function githubMergeReadFromExec(exec: Exec): GithubMergeRead {
  const stdout = async (args: string[]): Promise<string> => {
    const result = await exec(args);
    if (result.code !== 0) throw new Error(result.stderr || `fixture GitHub read exited ${result.code}`);
    return result.stdout;
  };
  return {
    reviewChecks: (repo, pr) => stdout(["gh", "-R", repo, "pr", "checks", String(pr), "--json", "name,state"]),
    mergeState: (repo, pr) => stdout([
      "gh", "-R", repo, "pr", "view", String(pr), "--json",
      "mergeStateStatus,mergeable,baseRefOid,headRefOid,statusCheckRollup",
    ]),
    driverPr: (repo, pr) => stdout([
      "gh", "-R", repo, "pr", "view", String(pr), "--json", "state,mergeStateStatus,statusCheckRollup",
    ]),
    requiredCheckContexts: (repo, branch) => stdout([
      "gh", "api", `repos/${repo}/branches/${encodeURIComponent(branch)}/protection/required_status_checks/contexts`,
    ]),
  };
}

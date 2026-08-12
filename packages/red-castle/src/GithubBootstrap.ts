import { execFileSync } from "node:child_process";
import { planGithubWrite } from "@reddb-io/github";
import { resolveRepoSlugForDir } from "@reddb-io/shared/project-identity-resolve.js";

export function createSandcastleLabel(cwd: string): void {
  const repo = resolveRepoSlugForDir(cwd);
  const plan = planGithubWrite([
    "gh", "label", "create", "Sandcastle",
    "--description", "Issues for Sandcastle to work on", "--color", "F9A825",
    ...(repo ? ["--repo", repo] : []),
  ]);
  execFileSync(plan.args[0]!, plan.args.slice(1), { cwd, stdio: "ignore" });
}

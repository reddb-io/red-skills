import { describe, expect, it } from "vitest";

import {
  evaluateWorkerTerminalRequest,
  shellSegments,
  workerTerminalDenialMessage,
  workerTerminalDenialMeta,
  type WorkerTerminalDenial,
} from "./terminal-policy.js";

function deny(command: string, ...args: string[]): WorkerTerminalDenial {
  const decision = evaluateWorkerTerminalRequest({ command, args });
  if (decision.decision !== "deny") throw new Error(`expected \`${command}\` to be refused`);
  return decision;
}

function allows(command: string, ...args: string[]): boolean {
  return evaluateWorkerTerminalRequest({ command, args }).decision === "allow";
}

describe("the Worker's terminal policy", () => {
  it("refuses publication and names the authority that owns it", () => {
    expect(deny("git", "push", "origin", "HEAD").reason).toBe("publication-is-parent-owned");
    expect(deny("git", "push").remedy).toContain("publish the branch and commit");
  });

  it("refuses every forge CLI", () => {
    expect(deny("gh", "pr", "create", "--fill").reason).toBe("forge-cli-is-parent-owned");
    expect(deny("gh", "api", "repos/reddb-io/red-skills").reason).toBe("forge-cli-is-parent-owned");
    expect(deny("glab", "mr", "create").reason).toBe("forge-cli-is-parent-owned");
  });

  it("refuses the other authenticated remote reaches", () => {
    expect(deny("git", "fetch", "origin").reason).toBe("credentialed-remote-is-parent-owned");
    expect(deny("git", "credential", "fill").reason).toBe("credentialed-remote-is-parent-owned");
    expect(deny("ssh", "git@github.com").reason).toBe("credentialed-remote-is-parent-owned");
  });

  // The inner agent's whole job is edits and commits, so a policy that refused
  // `git` would refuse the work rather than the authority.
  it("allows the ordinary work of a turn", () => {
    expect(allows("pnpm", "test")).toBe(true);
    expect(allows("pnpm", "-C", "apps/plugin-dev", "test:invariants")).toBe(true);
    expect(allows("git", "add", "--", "src/index.ts")).toBe(true);
    expect(allows("git", "commit", "-m", "Refs #4016")).toBe(true);
    expect(allows("git", "status", "--short")).toBe(true);
    expect(allows("git", "log", "--oneline", "origin/main..HEAD")).toBe(true);
  });

  it("reads the same command through a shell, an absolute path and an env prefix", () => {
    expect(deny("bash", "-lc", "git push origin HEAD").reason).toBe("publication-is-parent-owned");
    expect(deny("sh", "-c", "pnpm build && gh release create").reason).toBe("forge-cli-is-parent-owned");
    expect(deny("/usr/bin/git", "push").reason).toBe("publication-is-parent-owned");
    expect(deny("env", "GIT_TERMINAL_PROMPT=0", "git", "push").reason).toBe("publication-is-parent-owned");
    expect(deny("git", "-C", "/worktree", "push").reason).toBe("publication-is-parent-owned");
    expect(deny("bash", "-lc", "echo start; gh pr view 1").reason).toBe("forge-cli-is-parent-owned");
    expect(deny("bash", "-lc", "echo $(gh pr view 1)").reason).toBe("forge-cli-is-parent-owned");
  });

  // A refusal nobody predicted is a rule the agent stops believing, so a commit
  // message that merely MENTIONS a refused command stays ordinary work.
  it("does not refuse a quoted mention of a refused command", () => {
    expect(allows("git", "commit", "-m", "prepare for git push")).toBe(true);
    expect(allows("bash", "-lc", 'git commit -m "ready to gh pr create && push"')).toBe(true);
    expect(allows("bash", "-lc", "echo 'git push is the parent\\'s'")).toBe(true);
  });

  it("splits a shell script on its operators and not inside its quotes", () => {
    expect(shellSegments('git commit -m "a && b"; pnpm test'))
      .toEqual(["git commit -m a && b", " pnpm test"]);
  });

  it("carries the reason, the command and the route in the payload the agent reads", () => {
    const denial = deny("gh", "pr", "create");

    expect(workerTerminalDenialMeta(denial)).toEqual({
      redskills: {
        terminalPolicy: {
          decision: "deny",
          reason: "forge-cli-is-parent-owned",
          command: "gh pr create",
          what: "a GitHub CLI call",
          remedy: denial.remedy,
        },
      },
    });
    expect(workerTerminalDenialMessage(denial)).toContain("forge-cli-is-parent-owned");
    expect(workerTerminalDenialMessage(denial)).toContain("gh pr create");
  });
});

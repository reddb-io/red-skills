import { join } from "node:path";

import {
  healGeneratedDrift,
  type MechanicalRegenerator,
} from "../../../core/generated-surfaces.js";
import { execTool, type ExecFn, type ExecOutput } from "../../../runtime/exec.js";

function evidence(result: ExecOutput): string {
  return (result.stderr || result.stdout).trim() || `exit ${result.code}`;
}

function statusPaths(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3))
    .map((path) => path.includes(" -> ") ? path.slice(path.lastIndexOf(" -> ") + 4) : path)
    .filter(Boolean);
}

/** Bind the pure mechanical sequence to the active Worker's real worktree. */
export function makeMechanicalRegenerator(
  attemptDir: () => string,
  exec?: ExecFn,
): MechanicalRegenerator {
  const run = exec ?? execTool;
  return async (input) => {
    const worktree = join(attemptDir(), "worktree");
    return healGeneratedDrift({
      mergeBase: async () => {
        const clean = await run("git", ["status", "--porcelain"], { cwd: worktree });
        if (clean.code !== 0) return { ok: false, evidence: evidence(clean) };
        if (clean.stdout.trim() !== "") return { ok: false, evidence: "worker worktree is dirty before base merge" };
        const merged = await run(
          "git",
          ["merge", "--no-edit", "--no-verify", input.baseRef],
          { cwd: worktree },
        );
        return merged.code === 0 ? { ok: true } : { ok: false, evidence: evidence(merged) };
      },
      runCommand: async (command) => {
        const generated = await run("bash", ["-lc", command], { cwd: worktree });
        return generated.code === 0 ? { ok: true } : { ok: false, evidence: evidence(generated) };
      },
      changedFiles: async () => {
        const status = await run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: worktree });
        if (status.code !== 0) throw new Error(`generated-surface status failed: ${evidence(status)}`);
        return statusPaths(status.stdout);
      },
      commitAndPublish: async (paths) => {
        if (paths.length > 0) {
          const added = await run("git", ["add", "--", ...paths], { cwd: worktree });
          if (added.code !== 0) return { ok: false, evidence: evidence(added) };
          const committed = await run(
            "git",
            [
              "commit",
              "--no-verify",
              "-m",
              "chore(afk): regenerate generated surfaces",
              "-m",
              `Refs #${input.issue}`,
            ],
            { cwd: worktree },
          );
          if (committed.code !== 0) return { ok: false, evidence: evidence(committed) };
        }
        const pushed = await run(
          "git",
          ["push", input.remote, `HEAD:refs/heads/${input.branch}`],
          { cwd: worktree },
        );
        return pushed.code === 0 ? { ok: true } : { ok: false, evidence: evidence(pushed) };
      },
    }, {
      paths: [...input.paths],
      command: input.command,
    }).catch((error: unknown) => ({
      ok: false,
      evidence: error instanceof Error ? error.message : String(error),
    }));
  };
}

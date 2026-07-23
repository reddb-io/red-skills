import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CASTLE_HOOK_NAMES,
  dispatchCastleHook,
  resolveCastleHooks,
  type CastleHookExec,
} from "./lifecycle-hooks.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "castle-hooks-"));
}

function touch(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n", "utf8");
  return path;
}

describe("castle lifecycle hooks", () => {
  it("publishes the ratified supervisor, worker, and issue lifecycle set", () => {
    expect(CASTLE_HOOK_NAMES).toEqual([
      "supervisor_start",
      "supervisor_exit",
      "fleet_scaled",
      "worker_start",
      "worker_exit",
      "worker_steered",
      "worker_escalated",
      "post_claim",
      "pre_worktree",
      "post_issue",
      "pre_requeue",
      "pre_merge",
      "post_merge",
    ]);
  });

  it("discovers skin hook bodies with project shadows and pre_worktree defaults", () => {
    const root = tempDir();
    const projectRoot = join(root, "project");
    const libraryHooksDir = join(root, "plugin", "hooks");
    const projectHooksDir = join(root, ".red", "hooks");
    touch(join(projectRoot, "Cargo.toml"));
    touch(join(projectRoot, "build.gradle.kts"));
    const cargo = touch(join(projectHooksDir, "red-cargo"));
    touch(join(libraryHooksDir, "red-cargo"));
    const gradle = touch(join(libraryHooksDir, "red-gradle"));
    const libWorkerStart = touch(join(libraryHooksDir, "worker_start"));
    const projectWorkerStart = touch(join(projectHooksDir, "worker_start"));
    const projectPostIssue = touch(join(projectHooksDir, "post_issue"));
    const libPreMerge = touch(join(libraryHooksDir, "pre_merge", "20-lib.sh"));
    const projectPreMerge = touch(
      join(projectHooksDir, "pre_merge", "10-project.sh"),
    );
    touch(join(projectHooksDir, "pre_merge", "20-lib.sh"));

    const resolved = resolveCastleHooks(
      {
        "afk.hooks.worker_exit": "echo inline-worker-exit",
        "plugins.dev.afk.hooks.post_merge.0": "echo post-merge-a",
        "plugins.dev.afk.hooks.post_merge.1": "echo post-merge-b",
      },
      {
        libraryHooksDir,
        projectHooksDir,
        projectRoot,
      },
    );

    expect(resolved.pre_worktree).toEqual([cargo, gradle]);
    expect(resolved.worker_start).toEqual([projectWorkerStart]);
    expect(resolved.worker_start).not.toContain(libWorkerStart);
    expect(resolved.post_issue).toEqual([projectPostIssue]);
    expect(resolved.pre_merge).toEqual([
      join(projectHooksDir, "pre_merge", "10-project.sh"),
      join(projectHooksDir, "pre_merge", "20-lib.sh"),
    ]);
    expect(resolved.pre_merge).not.toContain(libPreMerge);
    expect(resolved.worker_exit).toEqual(["echo inline-worker-exit"]);
    expect(resolved.post_merge).toEqual([
      "echo post-merge-a",
      "echo post-merge-b",
    ]);
  });

  it("resolves no build hook commands for a project with no matching build files", () => {
    const root = tempDir();
    const libraryHooksDir = join(root, "plugin", "hooks");
    touch(join(libraryHooksDir, "red-cargo"));
    touch(join(libraryHooksDir, "red-gradle"));

    const resolved = resolveCastleHooks(
      {},
      { libraryHooksDir, projectRoot: join(root, "project") },
    );

    expect(resolved.pre_worktree).toEqual([]);
  });

  it("does not resolve a matching build hook when config disables that default", () => {
    const root = tempDir();
    const projectRoot = join(root, "project");
    const libraryHooksDir = join(root, "plugin", "hooks");
    touch(join(projectRoot, "Cargo.toml"));
    touch(join(projectRoot, "build.gradle"));
    touch(join(libraryHooksDir, "red-cargo"));
    const gradle = touch(join(libraryHooksDir, "red-gradle"));

    const resolved = resolveCastleHooks(
      { "afk.hooks.defaults.cargo": "false" },
      { libraryHooksDir, projectRoot },
    );

    expect(resolved.pre_worktree).toEqual([gradle]);
  });

  it("invokes bodies with the frozen RED_AFK env contract and mutable stdin JSON", async () => {
    const seen: Array<{
      command: string;
      env: Record<string, string>;
      stdinJson: string;
    }> = [];
    const exec: CastleHookExec = async (command, env, stdinJson) => {
      seen.push({ command, env, stdinJson });
      if (command === "mutate")
        return {
          code: 0,
          stdout: JSON.stringify({
            issue: { number: 1914 },
            decision: "retry",
          }),
        };
      return { code: 0, stdout: "" };
    };

    const result = await dispatchCastleHook(
      "pre_requeue",
      ["mutate", "observe"],
      {
        issue: { number: 1914 },
        workspace: "worktree",
        runner: "codex",
        worker_id: "w1",
        supervisor_id: "s1",
        result: { status: "blocked", outcome: "needs-human" },
        merge_commit: { sha: "abcdef", short: "abcdef" },
        attempt_n: 7,
      },
      exec,
      { env: { RED_AFK_ROOT: ".red" } },
    );

    expect(result.aborted).toBe(false);
    expect(result.context).toEqual({
      issue: { number: 1914 },
      decision: "retry",
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.env).toMatchObject({
      RED_AFK_ROOT: ".red",
      RED_AFK_ISSUE: "1914",
      RED_AFK_WORKSPACE: "worktree",
      RED_AFK_RUNNER: "codex",
      RED_AFK_WORKER_ID: "w1",
      RED_AFK_SUPERVISOR_ID: "s1",
      RED_AFK_RESULT_STATUS: "blocked",
      RED_AFK_RESULT_OUTCOME: "needs-human",
      RED_AFK_MERGE_COMMIT: "abcdef",
      RED_AFK_MERGE_SHA: "abcdef",
    });
    expect(seen[0]?.env.RED_AFK_ATTEMPT_N).toBeUndefined();
    expect(JSON.parse(seen[1]!.stdinJson)).toEqual({
      issue: { number: 1914 },
      decision: "retry",
    });
  });

  it("lets pre_requeue veto the annotation path with an abort-policy rc", async () => {
    const result = await dispatchCastleHook(
      "pre_requeue",
      ["veto", "never"],
      { issue: { number: 1914 } },
      async (command) => ({ code: command === "veto" ? 42 : 0, stdout: "" }),
    );

    expect(result).toMatchObject({
      aborted: true,
      vetoed: true,
      rc: 42,
      executions: [{ name: "pre_requeue", command: "veto", rc: 42 }],
    });
  });
});

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSensitiveMcpDependencies } from "../src/mcp-sensitive-adapter.js";
import { isAncestor, listWorktrees } from "../src/runtime/git.js";
import type { GitContext } from "../src/runtime/git.js";
import type { ExecFn, ExecOutput } from "../src/runtime/exec.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "dev-afk-mcp-sensitive-"));
  roots.push(value);
  return value;
}

function fakeExec(responder: (args: readonly string[]) => ExecOutput): ExecFn {
  return async (_cmd, args) => responder(args);
}

describe("dev:afk MCP sensitive-op adapter", () => {
  it("enumerates the disposable worktree lanes under .red/tmp/worktrees", async () => {
    const cwd = await root();
    await mkdir(join(cwd, ".red/tmp/worktrees/manual/slice-a"), { recursive: true });
    await mkdir(join(cwd, ".red/tmp/worktrees/landing/main-2307"), { recursive: true });

    const listed = (await createSensitiveMcpDependencies(cwd).worktreeList()) as {
      root: string;
      worktrees: Array<{ lane: string; name: string; registered: boolean }>;
    };

    expect(listed.root).toBe(join(".red", "tmp", "worktrees"));
    expect(listed.worktrees).toEqual([
      expect.objectContaining({ lane: "manual", name: "slice-a", registered: false }),
      expect.objectContaining({ lane: "landing", name: "main-2307", registered: false }),
    ]);
  });

  it("refuses to remove a worktree outside the disposable lanes", async () => {
    const cwd = await root();
    const deps = createSensitiveMcpDependencies(cwd);

    await expect(deps.worktreeRemove({ path: "src" })).rejects.toThrow(
      /outside \.red\/tmp\/worktrees/,
    );
    await expect(deps.worktreeRemove({ path: "../escape" })).rejects.toThrow(
      /outside \.red\/tmp\/worktrees/,
    );
    await expect(
      deps.worktreeRemove({ path: ".red/tmp/worktrees" }),
    ).rejects.toThrow(/outside \.red\/tmp\/worktrees/);
  });

  it("removes a worktree that lives inside a lane", async () => {
    const cwd = await root();
    await mkdir(join(cwd, ".red/tmp/worktrees/feedback/branch-a"), { recursive: true });

    await expect(
      createSensitiveMcpDependencies(cwd).worktreeRemove({
        path: ".red/tmp/worktrees/feedback/branch-a",
      }),
    ).resolves.toEqual({
      path: join(".red", "tmp", "worktrees", "feedback", "branch-a"),
      status: "removed",
    });
  });
});

describe("worktree + ancestry git primitives", () => {
  const ctx = (exec: ExecFn): GitContext => ({ cwd: "/repo", exec });

  it("parses git worktree list --porcelain into entries", async () => {
    const stdout = [
      "worktree /repo",
      "HEAD aaaa",
      "branch refs/heads/main",
      "",
      "worktree /repo/.red/tmp/worktrees/landing/main-2307",
      "HEAD bbbb",
      "detached",
      "",
    ].join("\n");

    await expect(
      listWorktrees(ctx(fakeExec(() => ({ code: 0, stdout, stderr: "" })))),
    ).resolves.toEqual([
      { path: "/repo", head: "aaaa", branch: "main", detached: false },
      {
        path: "/repo/.red/tmp/worktrees/landing/main-2307",
        head: "bbbb",
        detached: true,
      },
    ]);
  });

  it("reports an unknown ancestry when an object is missing locally", async () => {
    const missing = fakeExec((args) =>
      args[0] === "rev-parse" ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: "", stderr: "" },
    );
    await expect(isAncestor(ctx(missing), "aaaa", "bbbb")).resolves.toBeUndefined();

    const present = fakeExec((args) =>
      args[0] === "rev-parse"
        ? { code: 0, stdout: "aaaa\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "" },
    );
    await expect(isAncestor(ctx(present), "aaaa", "bbbb")).resolves.toBe(false);
  });
});

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createEnginePaths } from "./paths.js";

describe("EnginePaths", () => {
  it("resolves castle state and tmp lanes from the injected .red root", () => {
    const redRoot = resolve("fixture", ".red");
    const paths = createEnginePaths(redRoot);

    expect(paths.redRoot).toBe(redRoot);
    expect(paths.stateRoot).toBe(resolve(redRoot, "state"));
    expect(paths.castleStateRoot).toBe(resolve(redRoot, "state", "castle"));
    expect(paths.castleHistory).toBe(
      resolve(redRoot, "state", "castle", "history.toonl"),
    );
    expect(paths.castleValidation).toBe(
      resolve(redRoot, "state", "castle", "validation.toonl"),
    );
    expect(paths.tmpRoot).toBe(resolve(redRoot, "tmp"));
    expect(paths.supervisorsRoot).toBe(resolve(redRoot, "tmp", "supervisors"));
    expect(paths.supervisor("s1")).toBe(
      resolve(redRoot, "tmp", "supervisors", "s1"),
    );
    expect(paths.workersRoot).toBe(resolve(redRoot, "tmp", "workers"));
    expect(paths.worker("wAB12")).toBe(
      resolve(redRoot, "tmp", "workers", "wAB12"),
    );
    expect(paths.monitorsRoot).toBe(resolve(redRoot, "tmp", "monitors"));
    expect(paths.monitor("m1")).toBe(resolve(redRoot, "tmp", "monitors", "m1"));
  });

  it("resolves every ratified worktree sub-lane (worker worktrees live under the worker's own workspace, not here)", () => {
    const redRoot = resolve("other", ".red");
    const paths = createEnginePaths(redRoot);

    expect(paths.worktreesRoot).toBe(resolve(redRoot, "tmp", "worktrees"));
    expect(paths.worktreeLane("manual")).toBe(
      resolve(redRoot, "tmp", "worktrees", "manual"),
    );
    expect(paths.worktreeLane("feedback")).toBe(
      resolve(redRoot, "tmp", "worktrees", "feedback"),
    );
    expect(paths.worktreeLane("landing")).toBe(
      resolve(redRoot, "tmp", "worktrees", "landing"),
    );
    expect(paths.worktreeLane("rebase")).toBe(
      resolve(redRoot, "tmp", "worktrees", "rebase"),
    );
    expect(paths.worktreeLane("cascade")).toBe(
      resolve(redRoot, "tmp", "worktrees", "cascade"),
    );
    expect(paths.worktreeLane("adopt")).toBe(
      resolve(redRoot, "tmp", "worktrees", "adopt"),
    );
    expect(paths.worktreeLane("reconcile")).toBe(
      resolve(redRoot, "tmp", "worktrees", "reconcile"),
    );
    expect(paths.worktreeLane("docs")).toBe(
      resolve(redRoot, "tmp", "worktrees", "docs"),
    );
  });
});

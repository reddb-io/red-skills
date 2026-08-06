import { describe, expect, it } from "vitest";
import {
  BRAIN_ROOT_ENV,
  LEGACY_SHARED_STORE_REL,
  MEMORY_ROOT_ENV,
  ROOT_OVERRIDE_ENV_VARS,
  SHARED_STORE_REL,
  isLegacySharedStorePath,
  legacySharedStorePath,
  resolveSharedStorePath,
  WORKERS_NAMESPACE_ENV,
  WORKER_NAMESPACES,
  activeWorkersDir,
  adoptWorktreesDir,
  afkStateDir,
  brainDir,
  branchLockFile,
  cascadeWorktreesDir,
  castleStateDir,
  claimsDir,
  classifyLegacyWorktreeName,
  configFile,
  hooksDir,
  diagnosticsDir,
  docsWorktreesDir,
  feedbackWorktreesDir,
  goWorkersDir,
  landingWorktreesDir,
  legacyAfkStateDir,
  manualWorktreesDir,
  MANAGER_ROOT_ENV,
  managerDir,
  managerEffortFile,
  managerCheckpointFile,
  managerCheckpointsDir,
  managerEffortsDir,
  managerLeaseFile,
  managerLeasesDir,
  memoryDir,
  rebaseWorktreesDir,
  resolveManagerRoot,
  reconcileWorktreesDir,
  redDir,
  researchesDir,
  resolveRedRoot,
  rspStateDir,
  scoutWorkersDir,
  scratchDir,
  sharedStorePath,
  stateDir,
  statuslineStateDir,
  tmpDir,
  waitsDir,
  wikiDir,
  workersDir,
  workersSegment,
  worktreesDir,
} from "./red-paths.js";

const ROOT = "/repo";

describe("tier directories", () => {
  it("derives the four lifecycle tiers plus researches from a repo root", () => {
    expect(redDir(ROOT)).toBe("/repo/.red");
    expect(stateDir(ROOT)).toBe("/repo/.red/state");
    expect(tmpDir(ROOT)).toBe("/repo/.red/tmp");
    expect(researchesDir(ROOT)).toBe("/repo/.red/researches");
    expect(configFile(ROOT)).toBe("/repo/.red/config.yaml");
    expect(hooksDir(ROOT)).toBe("/repo/.red/hooks");
  });

  it("normalizes a trailing slash on the root", () => {
    expect(redDir("/repo/")).toBe("/repo/.red");
    expect(stateDir("/repo/")).toBe("/repo/.red/state");
  });

  it("derives plugin store homes", () => {
    expect(memoryDir(ROOT)).toBe("/repo/.red/memory");
    expect(brainDir(ROOT)).toBe("/repo/.red/brain");
    expect(wikiDir(ROOT)).toBe("/repo/.red/wiki");
  });
});

describe("manager portfolio store", () => {
  it("derives the operator-scoped effort lane from a home root", () => {
    expect(managerDir("/home/op")).toBe("/home/op/.red/manager");
    expect(managerEffortsDir("/home/op")).toBe("/home/op/.red/manager/efforts");
    expect(managerEffortFile("/home/op", "eff_abc")).toBe(
      "/home/op/.red/manager/efforts/eff_abc.toonl",
    );
  });

  it("derives the operator-scoped lease lane from a home root", () => {
    expect(managerLeasesDir("/home/op")).toBe("/home/op/.red/manager/leases");
    expect(managerLeaseFile("/home/op", "eff_abc")).toBe(
      "/home/op/.red/manager/leases/eff_abc.toonl",
    );
  });

  it("derives the operator-scoped checkpoint lane from a home root", () => {
    expect(managerCheckpointsDir("/home/op")).toBe("/home/op/.red/manager/checkpoints");
    expect(managerCheckpointFile("/home/op", "20260721T000000Z")).toBe(
      "/home/op/.red/manager/checkpoints/20260721T000000Z.toonl",
    );
  });

  it("rejects an empty effort id instead of writing the lane directory itself", () => {
    expect(() => managerEffortFile("/home/op", "")).toThrow(/effortId is required/);
    expect(() => managerLeaseFile("/home/op", "")).toThrow(/effortId is required/);
    expect(() => managerCheckpointFile("/home/op", "")).toThrow(/stamp is required/);
  });

  it("defaults the manager root to the operator home and honors the override", () => {
    expect(resolveManagerRoot({ homeDir: "/home/op", env: {} })).toBe("/home/op");
    expect(
      resolveManagerRoot({ homeDir: "/home/op", env: { [MANAGER_ROOT_ENV]: "/tmp/portfolio" } }),
    ).toBe("/tmp/portfolio");
    expect(
      resolveManagerRoot({ homeDir: "/home/op", env: { [MANAGER_ROOT_ENV]: "profiles/two" } }),
    ).toBe("/home/op/profiles/two");
  });
});

describe("state tier lanes", () => {
  it("derives every durable state lane from the registry", () => {
    expect(castleStateDir(ROOT)).toBe("/repo/.red/state/castle");
    expect(afkStateDir(ROOT)).toBe("/repo/.red/state/castle");
    expect(legacyAfkStateDir(ROOT)).toBe("/repo/.red/state/afk");
    expect(rspStateDir(ROOT)).toBe("/repo/.red/state/rsp");
    expect(statuslineStateDir(ROOT)).toBe("/repo/.red/state/statusline");
    expect(branchLockFile(ROOT)).toBe("/repo/.red/state/branch-lock.yaml");
  });

  it("exports the shared RedDB store as a single constant in the state tier", () => {
    expect(SHARED_STORE_REL).toBe(".red/state/red-skills.rdb");
    expect(sharedStorePath(ROOT)).toBe("/repo/.red/state/red-skills.rdb");
  });

  it("keeps the shared store under the state tier, never tmp", () => {
    expect(sharedStorePath(ROOT).startsWith(stateDir(ROOT))).toBe(true);
    expect(sharedStorePath(ROOT).startsWith(tmpDir(ROOT))).toBe(false);
  });

  it("names the legacy tmp-tier shared store as a single constant", () => {
    expect(LEGACY_SHARED_STORE_REL).toBe(".red/tmp/red-skills.rdb");
    expect(legacySharedStorePath(ROOT)).toBe("/repo/.red/tmp/red-skills.rdb");
  });
});

describe("resolveSharedStorePath (transition-window fallback)", () => {
  it("prefers the state-tier store when it exists", () => {
    const resolved = resolveSharedStorePath(ROOT, (p) => p === sharedStorePath(ROOT));
    expect(resolved).toBe(sharedStorePath(ROOT));
  });

  it("fails clearly when only the legacy tmp store exists", () => {
    expect(() => resolveSharedStorePath(ROOT, (p) => p === legacySharedStorePath(ROOT))).toThrow(
      "Run `rsp setup` to migrate it to .red/state/red-skills.rdb",
    );
  });

  it("defaults to the state-tier store when neither exists", () => {
    expect(resolveSharedStorePath(ROOT, () => false)).toBe(sharedStorePath(ROOT));
  });

  it("prefers state over legacy when both exist", () => {
    expect(resolveSharedStorePath(ROOT, () => true)).toBe(sharedStorePath(ROOT));
  });

  it("recognizes explicit legacy shared-store paths for contract checks", () => {
    expect(isLegacySharedStorePath(ROOT, ".red/tmp/red-skills.rdb")).toBe(true);
    expect(isLegacySharedStorePath(ROOT, "/repo/.red/tmp/red-skills.rdb")).toBe(true);
    expect(isLegacySharedStorePath(ROOT, ".red/state/red-skills.rdb")).toBe(false);
  });
});

describe("tmp tier lanes", () => {
  it("derives the flat scratch lanes", () => {
    expect(claimsDir(ROOT)).toBe("/repo/.red/tmp/claims");
    expect(waitsDir(ROOT)).toBe("/repo/.red/tmp/waits");
    expect(scratchDir(ROOT)).toBe("/repo/.red/tmp/scratch");
    expect(diagnosticsDir(ROOT)).toBe("/repo/.red/tmp/diagnostics");
  });

  it("derives the fixed worker lanes", () => {
    expect(workersDir(ROOT)).toBe("/repo/.red/tmp/workers");
    expect(goWorkersDir(ROOT)).toBe("/repo/.red/tmp/go-workers");
    expect(scoutWorkersDir(ROOT)).toBe("/repo/.red/tmp/scout-workers");
    expect(WORKER_NAMESPACES).toEqual(["workers", "go-workers", "scout-workers"]);
  });

  it("derives the worktrees sub-lanes", () => {
    expect(worktreesDir(ROOT)).toBe("/repo/.red/tmp/worktrees");
    expect(manualWorktreesDir(ROOT)).toBe("/repo/.red/tmp/worktrees/manual");
    expect(feedbackWorktreesDir(ROOT)).toBe("/repo/.red/tmp/worktrees/feedback");
    expect(landingWorktreesDir(ROOT)).toBe("/repo/.red/tmp/worktrees/landing");
    expect(rebaseWorktreesDir(ROOT)).toBe("/repo/.red/tmp/worktrees/rebase");
    expect(cascadeWorktreesDir(ROOT)).toBe("/repo/.red/tmp/worktrees/cascade");
    expect(adoptWorktreesDir(ROOT)).toBe("/repo/.red/tmp/worktrees/adopt");
    expect(reconcileWorktreesDir(ROOT)).toBe("/repo/.red/tmp/worktrees/reconcile");
    expect(docsWorktreesDir(ROOT)).toBe("/repo/.red/tmp/worktrees/docs");
  });
});

describe("workers namespace override", () => {
  it("defaults the active workers segment to workers", () => {
    expect(workersSegment({})).toBe("workers");
    expect(activeWorkersDir(ROOT, {})).toBe("/repo/.red/tmp/workers");
  });

  it("honors RED_AFK_WORKERS_NAMESPACE for the active workers lane", () => {
    const env = { [WORKERS_NAMESPACE_ENV]: "go-workers" };
    expect(workersSegment(env)).toBe("go-workers");
    expect(activeWorkersDir(ROOT, env)).toBe("/repo/.red/tmp/go-workers");
  });

  it("rejects an invalid namespace and falls back to workers", () => {
    expect(workersSegment({ [WORKERS_NAMESPACE_ENV]: "../escape" })).toBe("workers");
    expect(workersSegment({ [WORKERS_NAMESPACE_ENV]: "" })).toBe("workers");
  });
});

describe("root resolution (env overrides honored)", () => {
  it("walks up to the directory that contains a .red child", () => {
    expect(resolveRedRoot({ startDir: ROOT, env: {}, exists: (p) => p === "/repo/.red" })).toBe(
      "/repo",
    );
    expect(
      resolveRedRoot({
        startDir: "/repo/a/b",
        env: {},
        exists: (p) => p === "/repo/.red",
      }),
    ).toBe("/repo");
  });

  it("falls back to startDir when no .red is found", () => {
    expect(resolveRedRoot({ startDir: "/nope", env: {}, exists: () => false })).toBe("/nope");
  });

  it("honors MEMORY_ROOT as a root override resolved against startDir", () => {
    expect(
      resolveRedRoot({ startDir: "/repo", env: { [MEMORY_ROOT_ENV]: "/other" }, exists: () => false }),
    ).toBe("/other");
    expect(
      resolveRedRoot({ startDir: "/repo", env: { [MEMORY_ROOT_ENV]: "sub" }, exists: () => false }),
    ).toBe("/repo/sub");
  });

  it("honors RED_BRAIN_ROOT as a root override", () => {
    expect(
      resolveRedRoot({ startDir: "/repo", env: { [BRAIN_ROOT_ENV]: "/brainroot" }, exists: () => false }),
    ).toBe("/brainroot");
  });

  it("exposes the ordered override env var list", () => {
    expect(ROOT_OVERRIDE_ENV_VARS).toEqual([MEMORY_ROOT_ENV, BRAIN_ROOT_ENV]);
  });
});

describe("legacy worktree classification", () => {
  it("classifies a digit-suffixed relic worktree", () => {
    expect(classifyLegacyWorktreeName("work-1684")).toBe("relic");
    expect(classifyLegacyWorktreeName("work-1")).toBe("relic");
  });

  it("classifies a maintainer slug worktree", () => {
    expect(classifyLegacyWorktreeName("work-afk-first-doctrine")).toBe("maintainer");
    expect(classifyLegacyWorktreeName("work-fix-bug")).toBe("maintainer");
  });

  it("classifies anything without the work- prefix as unknown", () => {
    expect(classifyLegacyWorktreeName("workers")).toBe("unknown");
    expect(classifyLegacyWorktreeName("1684-a1")).toBe("unknown");
    expect(classifyLegacyWorktreeName("work-")).toBe("unknown");
  });

  it("does not treat a leading-zero suffix as a relic (not a valid issue number)", () => {
    expect(classifyLegacyWorktreeName("work-007")).toBe("maintainer");
  });
});

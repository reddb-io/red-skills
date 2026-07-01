import { describe, expect, it } from "vitest";
import {
  decideRecovery,
  detectOrphans,
  ensureProvisioned,
  namespacedWorktreePath,
  planProvisioning,
  pruneOrphans,
  recoverWorktree,
  sanitizeSegment,
  worktreeNamespace,
  type LeaseRecord,
  type OrphanPruneDeps,
  type ProvisionDeps,
  type ProvisionState,
  type RecoveryDeps,
} from "../src/core/worktree-manager.js";

const ALIVE = (_pid: number) => true;
const DEAD = (_pid: number) => false;

function lease(over: Partial<LeaseRecord> = {}): LeaseRecord {
  return { owner: "w1", pid: 4242, branch: "afk/x", acquiredAt: 1_000_000, ...over };
}

// ---------------------------------------------------------------------------
// Namespaced isolation — distinct workers/issues never collide on a path.
// ---------------------------------------------------------------------------
describe("namespacing", () => {
  it("sanitizes a segment to a filesystem-safe token", () => {
    expect(sanitizeSegment("afk/wPSM4:933")).toBe("afk-wPSM4-933");
    expect(sanitizeSegment("///")).toBe("x"); // never empty
  });

  it("derives a stable namespace for the same (worker, ref)", () => {
    expect(worktreeNamespace("wPSM4", "933")).toBe(worktreeNamespace("wPSM4", "933"));
  });

  it("gives two different workers two different paths (no collision)", () => {
    const a = namespacedWorktreePath("/pool", "wPSM4", "933");
    const b = namespacedWorktreePath("/pool", "wOTHER", "933");
    expect(a).not.toBe(b);
    expect(a.startsWith("/pool/")).toBe(true);
  });

  it("gives the same worker on two different issues two different paths", () => {
    const a = namespacedWorktreePath("/pool", "wPSM4", "933");
    const b = namespacedWorktreePath("/pool", "wPSM4", "934");
    expect(a).not.toBe(b);
  });

  it("never collides even when distinct raw inputs sanitize to the same token", () => {
    // "a/b" and "a-b" both sanitize to "a-b"; the namespace hash keeps them apart.
    const a = namespacedWorktreePath("/pool", "a/b", "933");
    const b = namespacedWorktreePath("/pool", "a-b", "933");
    expect(a).not.toBe(b);
  });

  it("is deterministic (same inputs → identical path)", () => {
    expect(namespacedWorktreePath("/pool", "wPSM4", "933")).toBe(
      namespacedWorktreePath("/pool", "wPSM4", "933"),
    );
  });
});

// ---------------------------------------------------------------------------
// Orphan detection — registered-but-missing vs untracked-present.
// ---------------------------------------------------------------------------
describe("detectOrphans", () => {
  it("flags a git-registered worktree whose dir is gone as registered-missing", () => {
    const orphans = detectOrphans({ registered: ["/p/a", "/p/b"], present: ["/p/b"] });
    expect(orphans).toEqual([{ path: "/p/a", kind: "registered-missing" }]);
  });

  it("flags a present dir git does not track as untracked-present", () => {
    const orphans = detectOrphans({ registered: ["/p/a"], present: ["/p/a", "/p/c"] });
    expect(orphans).toEqual([{ path: "/p/c", kind: "untracked-present" }]);
  });

  it("does not flag a healthy worktree (registered AND present)", () => {
    const orphans = detectOrphans({ registered: ["/p/a"], present: ["/p/a"] });
    expect(orphans).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Orphan prune — safe, process-in-use aware.
// ---------------------------------------------------------------------------
function pruneDeps(over: Partial<OrphanPruneDeps> = {}): {
  deps: OrphanPruneDeps;
  registryPruned: boolean[];
  removed: string[];
} {
  const registryPruned: boolean[] = [];
  const removed: string[] = [];
  const deps: OrphanPruneDeps = {
    pruneRegistry: async () => {
      registryPruned.push(true);
    },
    removeDir: async (path) => {
      removed.push(path);
    },
    leaseFor: () => undefined,
    isAlive: DEAD,
    ...over,
  };
  return { deps, registryPruned, removed };
}

describe("pruneOrphans", () => {
  it("prunes the git registry once when any registered-missing orphan exists", async () => {
    const p = pruneDeps();
    const res = await pruneOrphans({ registered: ["/p/a"], present: [] }, p.deps);
    expect(p.registryPruned).toEqual([true]);
    expect(res.registryPruned).toBe(true);
    expect(res.pruned).toContain("/p/a");
  });

  it("removes an untracked dir with no live holder", async () => {
    const p = pruneDeps();
    const res = await pruneOrphans({ registered: [], present: ["/p/c"] }, p.deps);
    expect(p.removed).toEqual(["/p/c"]);
    expect(res.pruned).toContain("/p/c");
  });

  it("keeps an untracked dir whose lease holder is still alive (in-use aware)", async () => {
    const p = pruneDeps({ leaseFor: () => lease({ pid: 7 }), isAlive: ALIVE });
    const res = await pruneOrphans({ registered: [], present: ["/p/c"] }, p.deps);
    expect(p.removed).toEqual([]);
    expect(res.kept).toEqual([{ path: "/p/c", reason: "in-use" }]);
  });

  it("does nothing when there are no orphans", async () => {
    const p = pruneDeps();
    const res = await pruneOrphans({ registered: ["/p/a"], present: ["/p/a"] }, p.deps);
    expect(p.registryPruned).toEqual([]);
    expect(p.removed).toEqual([]);
    expect(res.pruned).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Recovery — a worktree deleted mid-run is re-materialised cold.
// ---------------------------------------------------------------------------
describe("decideRecovery", () => {
  it("keeps an intact worktree", () => {
    expect(decideRecovery(true)).toBe("intact");
  });
  it("re-materialises a vanished worktree (deps lost with the dir)", () => {
    expect(decideRecovery(false)).toBe("rematerialize");
  });
});

describe("recoverWorktree", () => {
  it("re-materialises cold when the leased dir vanished mid-run", async () => {
    const calls: string[] = [];
    const deps: RecoveryDeps = {
      exists: async () => false,
      materializeCold: async (path, branch, base) => {
        calls.push(`cold:${path}:${branch}:${base}`);
      },
    };
    const decision = await recoverWorktree(deps, "/p/a", "afk/x", "main");
    expect(decision).toBe("rematerialize");
    expect(calls).toEqual(["cold:/p/a:afk/x:main"]);
  });

  it("leaves an intact worktree untouched", async () => {
    const calls: string[] = [];
    const deps: RecoveryDeps = {
      exists: async () => true,
      materializeCold: async (path) => {
        calls.push(path);
      },
    };
    const decision = await recoverWorktree(deps, "/p/a", "afk/x", "main");
    expect(decision).toBe("intact");
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Provisioning guarantee — submodule-init + node_modules linking.
// ---------------------------------------------------------------------------
describe("planProvisioning", () => {
  it("plans nothing when fully provisioned", () => {
    expect(planProvisioning({ submoduleInitialized: true, nodeModulesPresent: true })).toEqual([]);
  });
  it("plans a submodule init when the submodule is missing", () => {
    expect(planProvisioning({ submoduleInitialized: false, nodeModulesPresent: true })).toEqual([
      "submodule-init",
    ]);
  });
  it("plans a node_modules link when deps are missing", () => {
    expect(planProvisioning({ submoduleInitialized: true, nodeModulesPresent: false })).toEqual([
      "link-node-modules",
    ]);
  });
  it("plans both when both are missing", () => {
    expect(planProvisioning({ submoduleInitialized: false, nodeModulesPresent: false })).toEqual([
      "submodule-init",
      "link-node-modules",
    ]);
  });
});

describe("ensureProvisioned", () => {
  function provisionDeps(state: ProvisionState): { deps: ProvisionDeps; calls: string[] } {
    const calls: string[] = [];
    const deps: ProvisionDeps = {
      inspect: async () => state,
      initSubmodule: async (path) => {
        calls.push(`submodule:${path}`);
      },
      linkNodeModules: async (path) => {
        calls.push(`link:${path}`);
      },
    };
    return { deps, calls };
  }

  it("runs no remediation on a fully provisioned worktree", async () => {
    const p = provisionDeps({ submoduleInitialized: true, nodeModulesPresent: true });
    const steps = await ensureProvisioned(p.deps, "/p/a");
    expect(steps).toEqual([]);
    expect(p.calls).toEqual([]);
  });

  it("guarantees submodule init + node_modules on a bare worktree", async () => {
    const p = provisionDeps({ submoduleInitialized: false, nodeModulesPresent: false });
    const steps = await ensureProvisioned(p.deps, "/p/a");
    expect(steps).toEqual(["submodule-init", "link-node-modules"]);
    expect(p.calls).toEqual(["submodule:/p/a", "link:/p/a"]);
  });
});

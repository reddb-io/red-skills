// deadend-heal.test.ts — pins for gated per-class healing (#2429).
//
// Acceptance criteria:
//   AC1. Default-empty allowlist performs ZERO mutations (mutation-recorder fake).
//   AC2. Each allowlisted class pins its exact sanctioned-core call sequence + audit comment.
//   AC3. Unknown class names in config are rejected loudly at load.
//   AC4. Non-mechanical findings are never healable regardless of config.

import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_HEAL_CONFIG,
  healDeadendFinding,
  isHealable,
  parseDeadendHealConfig,
  UnknownHealClassError,
  type DeadendHealDeps,
} from "../src/core/deadend-heal.js";
import type { DeadendFinding } from "../src/core/deadend-audit.js";

function makeDeps(): {
  deps: DeadendHealDeps;
  callOrder: string[];
} {
  const callOrder: string[] = [];
  const deps: DeadendHealDeps = {
    hitlResolve: vi.fn(async () => {
      callOrder.push("hitlResolve");
    }),
    requeue: vi.fn(async () => {
      callOrder.push("requeue");
    }),
    concede: vi.fn(async () => {
      callOrder.push("concede");
    }),
    comment: vi.fn(async () => {
      callOrder.push("comment");
    }),
  };
  return { deps, callOrder };
}

// ─── AC1: Default-empty allowlist → zero mutations ───────────────────────────

describe("AC1: empty allowlist performs zero mutations", () => {
  it("parseDeadendHealConfig empty/whitespace returns EMPTY_HEAL_CONFIG", () => {
    expect(parseDeadendHealConfig("")).toEqual(EMPTY_HEAL_CONFIG);
    expect(parseDeadendHealConfig("   ")).toEqual(EMPTY_HEAL_CONFIG);
  });

  it("EMPTY_HEAL_CONFIG fires no core call for any healable finding", async () => {
    const { deps } = makeDeps();
    const findings: DeadendFinding[] = [
      {
        deadendClass: "dangling_claim",
        cure: "claim_release",
        subject: "#100",
        detail: "claim held by dead worker wDEAD",
        healTarget: 100,
      },
      {
        deadendClass: "red_pr_dead_owner",
        cure: "retake",
        subject: "PR #5",
        detail: "failing checks with dead owner wDEAD",
        healTarget: 200,
      },
      {
        deadendClass: "superseded_pr",
        cure: "close_superseded_pr",
        subject: "PR #10",
        detail: "superseded by PR #12 on Ticket #200",
        healTarget: 10,
      },
      {
        deadendClass: "active_current_blocker",
        cure: "quarantine",
        subject: "#300",
        detail: "ready-for-agent Ticket carries an active Current blocker",
        healTarget: 300,
      },
      {
        deadendClass: "dependency_all_closed",
        cure: "unblock_sweep",
        subject: "#400",
        detail: "blocked:dependency with all req targets closed (#10, #11)",
        healTarget: 400,
      },
    ];

    for (const finding of findings) {
      await healDeadendFinding(deps, finding, EMPTY_HEAL_CONFIG);
    }

    expect(deps.hitlResolve).not.toHaveBeenCalled();
    expect(deps.requeue).not.toHaveBeenCalled();
    expect(deps.concede).not.toHaveBeenCalled();
    expect(deps.comment).not.toHaveBeenCalled();
  });
});

// ─── AC2: Per-class pinned call sequences ────────────────────────────────────

describe("AC2: each allowlisted class pins its exact sanctioned-core call sequence", () => {
  it("dangling_claim: concede(issue) THEN comment(issue, body-containing-class)", async () => {
    const { deps, callOrder } = makeDeps();
    const finding: DeadendFinding = {
      deadendClass: "dangling_claim",
      cure: "claim_release",
      subject: "#100",
      detail: "claim held by dead worker wDEAD",
      healTarget: 100,
    };
    await healDeadendFinding(deps, finding, parseDeadendHealConfig("dangling_claim"));

    expect(deps.concede).toHaveBeenCalledTimes(1);
    expect(deps.concede).toHaveBeenCalledWith(100);
    expect(deps.comment).toHaveBeenCalledTimes(1);
    expect(deps.comment).toHaveBeenCalledWith(100, expect.stringContaining("dangling_claim"));
    // Audit comment must reference the detail so the reader has context
    expect(String((deps.comment as ReturnType<typeof vi.fn>).mock.calls[0]![1])).toContain(
      "wDEAD",
    );
    // Order: concede fires before comment
    expect(callOrder).toEqual(["concede", "comment"]);
    expect(deps.hitlResolve).not.toHaveBeenCalled();
    expect(deps.requeue).not.toHaveBeenCalled();
  });

  it("red_pr_dead_owner: hitlResolve(ticket, 'requeue', body) — no other cores", async () => {
    const { deps } = makeDeps();
    const finding: DeadendFinding = {
      deadendClass: "red_pr_dead_owner",
      cure: "retake",
      subject: "PR #5",
      detail: "failing checks with dead owner wDEAD",
      healTarget: 200, // Ticket #200, not the PR
    };
    await healDeadendFinding(deps, finding, parseDeadendHealConfig("red_pr_dead_owner"));

    expect(deps.hitlResolve).toHaveBeenCalledTimes(1);
    expect(deps.hitlResolve).toHaveBeenCalledWith(
      200,
      "requeue",
      expect.stringContaining("red_pr_dead_owner"),
    );
    expect(deps.concede).not.toHaveBeenCalled();
    expect(deps.requeue).not.toHaveBeenCalled();
    expect(deps.comment).not.toHaveBeenCalled();
  });

  it("red_pr_dead_owner with no linked Ticket (healTarget absent): no-op", async () => {
    const { deps } = makeDeps();
    const finding: DeadendFinding = {
      deadendClass: "red_pr_dead_owner",
      cure: "retake",
      subject: "PR #7",
      detail: "failing checks with dead owner wDEAD",
      // healTarget absent — PR has no linked Ticket
    };
    await healDeadendFinding(deps, finding, parseDeadendHealConfig("red_pr_dead_owner"));

    expect(deps.hitlResolve).not.toHaveBeenCalled();
  });

  it("superseded_pr: hitlResolve(prNumber, 'close', body) — no other cores", async () => {
    const { deps } = makeDeps();
    const finding: DeadendFinding = {
      deadendClass: "superseded_pr",
      cure: "close_superseded_pr",
      subject: "PR #10",
      detail: "superseded by PR #12 on Ticket #200",
      healTarget: 10,
    };
    await healDeadendFinding(deps, finding, parseDeadendHealConfig("superseded_pr"));

    expect(deps.hitlResolve).toHaveBeenCalledTimes(1);
    expect(deps.hitlResolve).toHaveBeenCalledWith(
      10,
      "close",
      expect.stringContaining("superseded_pr"),
    );
    expect(deps.concede).not.toHaveBeenCalled();
    expect(deps.requeue).not.toHaveBeenCalled();
    expect(deps.comment).not.toHaveBeenCalled();
  });

  it("active_current_blocker: hitlResolve(issue, 'park', body) — no other cores", async () => {
    const { deps } = makeDeps();
    const finding: DeadendFinding = {
      deadendClass: "active_current_blocker",
      cure: "quarantine",
      subject: "#300",
      detail: "ready-for-agent Ticket carries an active Current blocker",
      healTarget: 300,
    };
    await healDeadendFinding(deps, finding, parseDeadendHealConfig("active_current_blocker"));

    expect(deps.hitlResolve).toHaveBeenCalledTimes(1);
    expect(deps.hitlResolve).toHaveBeenCalledWith(
      300,
      "park",
      expect.stringContaining("active_current_blocker"),
    );
    expect(deps.concede).not.toHaveBeenCalled();
    expect(deps.requeue).not.toHaveBeenCalled();
    expect(deps.comment).not.toHaveBeenCalled();
  });

  it("dependency_all_closed: requeue(issue, guidance-containing-class) — no other cores", async () => {
    const { deps } = makeDeps();
    const finding: DeadendFinding = {
      deadendClass: "dependency_all_closed",
      cure: "unblock_sweep",
      subject: "#400",
      detail: "blocked:dependency with all req targets closed (#10, #11)",
      healTarget: 400,
    };
    await healDeadendFinding(deps, finding, parseDeadendHealConfig("dependency_all_closed"));

    expect(deps.requeue).toHaveBeenCalledTimes(1);
    expect(deps.requeue).toHaveBeenCalledWith(400, expect.stringContaining("dependency_all_closed"));
    expect(deps.hitlResolve).not.toHaveBeenCalled();
    expect(deps.concede).not.toHaveBeenCalled();
    expect(deps.comment).not.toHaveBeenCalled();
  });

  it("only the allowlisted class fires; others are skipped", async () => {
    const { deps } = makeDeps();
    const config = parseDeadendHealConfig("superseded_pr");

    const superseded: DeadendFinding = {
      deadendClass: "superseded_pr",
      cure: "close_superseded_pr",
      subject: "PR #10",
      detail: "superseded by PR #12 on Ticket #200",
      healTarget: 10,
    };
    const dangling: DeadendFinding = {
      deadendClass: "dangling_claim",
      cure: "claim_release",
      subject: "#100",
      detail: "claim held by dead worker wDEAD",
      healTarget: 100,
    };

    await healDeadendFinding(deps, superseded, config);
    await healDeadendFinding(deps, dangling, config);

    expect(deps.hitlResolve).toHaveBeenCalledTimes(1);
    expect(deps.concede).not.toHaveBeenCalled();
  });
});

// ─── AC3: Unknown class names rejected at load ────────────────────────────────

describe("AC3: unknown class names rejected loudly at load", () => {
  it("throws UnknownHealClassError for an unrecognized name", () => {
    expect(() => parseDeadendHealConfig("unknown_class")).toThrow(UnknownHealClassError);
    expect(() => parseDeadendHealConfig("unknown_class")).toThrow("unknown_class");
  });

  it("non-mechanical class names are also rejected (not in HEALABLE_CLASSES)", () => {
    expect(() => parseDeadendHealConfig("human_queue_age_outlier")).toThrow(UnknownHealClassError);
    expect(() => parseDeadendHealConfig("stale_worktree")).toThrow(UnknownHealClassError);
  });

  it("rejects on the first invalid name in a multi-class list", () => {
    expect(() => parseDeadendHealConfig("dangling_claim,invalid,superseded_pr")).toThrow(
      UnknownHealClassError,
    );
  });

  it("accepts all valid healable class names in one list", () => {
    expect(() =>
      parseDeadendHealConfig(
        "dangling_claim,red_pr_dead_owner,superseded_pr,active_current_blocker,dependency_all_closed",
      ),
    ).not.toThrow();
  });
});

// ─── AC4: Non-mechanical findings never healable ──────────────────────────────

describe("AC4: non-mechanical findings never healable regardless of config", () => {
  it("isHealable returns false for non-mechanical classes", () => {
    expect(isHealable("human_queue_age_outlier")).toBe(false);
    expect(isHealable("stale_worktree")).toBe(false);
  });

  it("isHealable returns true for every mechanical class", () => {
    expect(isHealable("dangling_claim")).toBe(true);
    expect(isHealable("red_pr_dead_owner")).toBe(true);
    expect(isHealable("superseded_pr")).toBe(true);
    expect(isHealable("active_current_blocker")).toBe(true);
    expect(isHealable("dependency_all_closed")).toBe(true);
  });

  it("human_queue_age_outlier: no-op even when config is forced to include it", async () => {
    const { deps } = makeDeps();
    const finding: DeadendFinding = {
      deadendClass: "human_queue_age_outlier",
      cure: "hitl_review",
      subject: "#500",
      detail: "ready-for-human for 72h, past the age threshold",
    };
    // Bypass parseDeadendHealConfig to test the runtime non-mechanical guard
    const forcedConfig = {
      allowedClasses: new Set(["human_queue_age_outlier"]) as unknown as ReadonlySet<
        "dangling_claim"
      >,
    };
    await healDeadendFinding(deps, finding, forcedConfig);

    expect(deps.hitlResolve).not.toHaveBeenCalled();
    expect(deps.requeue).not.toHaveBeenCalled();
    expect(deps.concede).not.toHaveBeenCalled();
    expect(deps.comment).not.toHaveBeenCalled();
  });

  it("stale_worktree: no-op even when config is forced to include it", async () => {
    const { deps } = makeDeps();
    const finding: DeadendFinding = {
      deadendClass: "stale_worktree",
      cure: "worktree_remove",
      subject: ".red/tmp/worktrees/feedback/dead",
      detail: "stale feedback worktree with no live owner",
    };
    const forcedConfig = {
      allowedClasses: new Set(["stale_worktree"]) as unknown as ReadonlySet<"dangling_claim">,
    };
    await healDeadendFinding(deps, finding, forcedConfig);

    expect(deps.hitlResolve).not.toHaveBeenCalled();
    expect(deps.requeue).not.toHaveBeenCalled();
    expect(deps.concede).not.toHaveBeenCalled();
    expect(deps.comment).not.toHaveBeenCalled();
  });
});

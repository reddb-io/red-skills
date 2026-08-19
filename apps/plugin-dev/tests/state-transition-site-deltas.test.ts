// state-transition-site-deltas.test.ts — the per-site label-delta table (#2663,
// ADR 0122 rule 5, Spec #2657).
//
// Slice 2 of the state-transition contract migrated eight raw state-role
// writers onto `planTransition`. Each of those writers used to compute its own
// (remove, add) pair by hand — a `parkDropLabels` filter, a `dispose()` label
// set, a lifecycle wrapper, a `gh issue edit` argv. This table PINS the delta
// every one of them emits, so the migration is provably delta-preserving and a
// future planner change that silently re-shapes one of these sites fails here
// instead of in production.
//
// Read a row as: "at SITE, an issue carrying CURRENT takes TRANSITION, and the
// planner must emit exactly REMOVE / ADD". Order is asserted, not just set
// membership: the emitted argv order is what a reviewer diffs against the gh
// audit log.

import { describe, expect, it } from "vitest";
import { planTransition, isRefused, parkOrHuman, transitionLabels } from "../src/core/state-transition.js";
import { planTriageTransition } from "../src/core/auto-triage.js";
import { lifecycleTransitionFor } from "../src/core/process-issue/recovery.js";
import { dispose } from "../src/core/disposition.js";
import type { StateTransition } from "../src/core/state-transition.js";
import {
  LABEL_CI,
  LABEL_CRASHED,
  LABEL_DEPENDENCY,
  LABEL_HUMAN,
  LABEL_INFRA,
  LABEL_MERGE_CONFLICT,
  LABEL_NEEDS_INFO,
  LABEL_NEEDS_TRIAGE,
  LABEL_READY,
  LABEL_RUNNING,
  LABEL_SPEC,
  LABEL_STALLED,
  LABEL_VALIDATION,
  LABEL_VALIDATION_INFRA,
} from "../src/core/triage-labels.js";

interface SiteDelta {
  /** `file:function` — the migrated writer this row pins. */
  site: string;
  /** The issue's labels as the CALL SITE knows them. */
  current: string[];
  transition: StateTransition;
  remove: string[];
  add: string[];
}

const SITES: SiteDelta[] = [
  // ---------- core/reconcile.ts ----------
  {
    site: "core/reconcile.ts:park (feedback-failed)",
    current: [LABEL_RUNNING, LABEL_READY],
    transition: parkOrHuman(LABEL_VALIDATION),
    remove: [LABEL_READY, LABEL_RUNNING],
    add: [LABEL_HUMAN, LABEL_VALIDATION],
  },
  {
    site: "core/reconcile.ts:parkInfraRetry (retry → clean re-queue)",
    current: [LABEL_RUNNING, LABEL_VALIDATION_INFRA],
    transition: { kind: "queue" },
    remove: [LABEL_RUNNING, LABEL_VALIDATION_INFRA],
    add: [LABEL_READY],
  },
  {
    site: "core/reconcile.ts:parkInfraRetry (escalate)",
    current: [LABEL_RUNNING, LABEL_READY],
    transition: parkOrHuman(LABEL_VALIDATION_INFRA),
    remove: [LABEL_READY, LABEL_RUNNING],
    add: [LABEL_HUMAN, LABEL_VALIDATION_INFRA],
  },
  {
    site: "core/reconcile.ts:parkInfraLanding",
    current: [LABEL_RUNNING],
    transition: parkOrHuman(LABEL_INFRA),
    remove: [LABEL_RUNNING],
    add: [LABEL_HUMAN, LABEL_INFRA],
  },
  {
    // #2864: the merge-conflict park is now ONE route of parkLandingRefusal —
    // the one a genuinely conflicting branch reaches.
    site: "core/reconcile.ts:parkLandingRefusal (merge-conflict)",
    current: [LABEL_RUNNING],
    transition: parkOrHuman(LABEL_MERGE_CONFLICT),
    remove: [LABEL_RUNNING],
    add: [LABEL_HUMAN, LABEL_MERGE_CONFLICT],
  },
  {
    site: "core/reconcile.ts:parkLandingRefusal (ci-failed — a rejected merge on a mergeable PR)",
    current: [LABEL_RUNNING],
    transition: parkOrHuman(LABEL_CI),
    remove: [LABEL_RUNNING],
    add: [LABEL_HUMAN, LABEL_CI],
  },
  {
    site: "core/reconcile.ts:runCloseCascade (mirror of the DONE-path promote)",
    current: [LABEL_DEPENDENCY, "req:11", "req:10"],
    transition: { kind: "promote" },
    remove: [LABEL_DEPENDENCY, "req:10", "req:11"],
    add: [LABEL_READY],
  },

  // ---------- core/process-issue/terminal.ts ----------
  // Both handoffs are UNTYPED (`blockedLabelFor` returns null for a handoff),
  // so they park on the plain human gate — exactly what editLabelsTagged did.
  {
    site: "core/process-issue/terminal.ts:handoffForReview",
    current: [LABEL_RUNNING],
    transition: parkOrHuman(null),
    remove: [LABEL_RUNNING],
    add: [LABEL_HUMAN],
  },

  // ---------- core/process-issue/recovery.ts ----------
  {
    site: "core/process-issue/recovery.ts:routeRecovery (escalate)",
    current: [LABEL_RUNNING],
    transition: parkOrHuman(LABEL_CRASHED),
    remove: [LABEL_RUNNING],
    add: [LABEL_HUMAN, LABEL_CRASHED],
  },
  {
    site: "core/process-issue/recovery.ts:routeRecovery (retry)",
    current: [LABEL_RUNNING],
    transition: { kind: "queue" },
    remove: [LABEL_RUNNING],
    add: [LABEL_READY],
  },
  {
    site: "core/process-issue/recovery.ts:preflight-blocked",
    current: [LABEL_READY],
    transition: parkOrHuman(LABEL_SPEC),
    remove: [LABEL_READY],
    add: [LABEL_HUMAN, LABEL_SPEC],
  },

  // ---------- core/supervisor/reaper.ts ----------
  {
    site: "core/supervisor/reaper.ts:reapSlot (clean re-queue)",
    current: [LABEL_RUNNING],
    transition: { kind: "queue" },
    remove: [LABEL_RUNNING],
    add: [LABEL_READY],
  },
  {
    site: "core/supervisor/reaper.ts:reapSlot (escalate — also sheds stale ready)",
    current: [LABEL_RUNNING, LABEL_READY],
    transition: parkOrHuman(LABEL_STALLED),
    remove: [LABEL_READY, LABEL_RUNNING],
    add: [LABEL_HUMAN, LABEL_STALLED],
  },

  // ---------- core/supervisor/envelopes.ts ----------
  {
    site: "core/supervisor/envelopes.ts:death-sweep (retry, labels unknown)",
    current: [LABEL_RUNNING],
    transition: { kind: "queue" },
    remove: [LABEL_RUNNING],
    add: [LABEL_READY],
  },
  {
    site: "core/supervisor/envelopes.ts:death-sweep (escalate, labels unknown)",
    current: [LABEL_RUNNING, LABEL_READY],
    transition: parkOrHuman(LABEL_CRASHED),
    remove: [LABEL_READY, LABEL_RUNNING],
    add: [LABEL_HUMAN, LABEL_CRASHED],
  },
  {
    site: "core/supervisor/envelopes.ts:death-sweep (quarantine, labels known)",
    current: [LABEL_READY, LABEL_RUNNING],
    transition: { kind: "quarantine", diagnosis: "" },
    remove: [LABEL_READY, LABEL_RUNNING],
    add: ["quarantine"],
  },

  // ---------- runtime/companion-io.ts ----------
  {
    site: "runtime/companion-io.ts:correct",
    current: [LABEL_RUNNING],
    transition: { kind: "queue" },
    remove: [LABEL_RUNNING],
    add: [LABEL_READY],
  },
  {
    site: "runtime/companion-io.ts:escalate",
    current: [LABEL_READY],
    transition: { kind: "human" },
    remove: [LABEL_READY],
    add: [LABEL_HUMAN],
  },

  // ---------- commands/triage.ts ----------
  {
    site: "commands/triage.ts:acceptance-lint bounce",
    current: [LABEL_READY],
    transition: { kind: "triage" },
    remove: [LABEL_READY],
    add: [LABEL_NEEDS_TRIAGE],
  },

  // ---------- commands/hitl-card.ts ----------
  {
    site: "commands/hitl-card.ts:executeRequeue",
    current: [LABEL_HUMAN, LABEL_VALIDATION],
    transition: { kind: "queue" },
    remove: [LABEL_HUMAN, LABEL_VALIDATION],
    add: [LABEL_READY],
  },
];

describe("per-site label deltas (#2663)", () => {
  it.each(SITES)("$site", ({ current, transition, remove, add }) => {
    const plan = planTransition(current, transition);
    expect(isRefused(plan) ? plan.reason : null).toBeNull();
    if (isRefused(plan)) return;
    expect([...plan.remove]).toEqual(remove);
    expect([...plan.add]).toEqual(add);
  });

  it("covers every migrated file", () => {
    const files = new Set(SITES.map((s) => s.site.split(":")[0]!));
    expect([...files].sort()).toEqual([
      "commands/hitl-card.ts",
      "commands/triage.ts",
      "core/process-issue/recovery.ts",
      "core/process-issue/terminal.ts",
      "core/reconcile.ts",
      "core/supervisor/envelopes.ts",
      "core/supervisor/reaper.ts",
      "runtime/companion-io.ts",
    ]);
  });
});

describe("the disposition composer's label sets still match the planned deltas (#2663)", () => {
  // The reaper and the death-sweep used to APPLY `dispose()`'s sets directly.
  // They now plan instead, so this pins the equivalence that made the swap safe:
  // the planner reproduces dispose's delta from dispose's own shed set.
  it("retry: dispose(remove/add) === planTransition(queue)", () => {
    const disp = dispose("stalled", 1, { RED_AFK_STALLED_RETRIES: "3" });
    expect(disp.decision).toBe("retry");
    const plan = planTransition(disp.removeLabels, { kind: "queue" });
    expect(isRefused(plan)).toBe(false);
    if (isRefused(plan)) return;
    expect([...plan.remove]).toEqual(disp.removeLabels);
    expect([...plan.add]).toEqual(disp.addLabels);
  });

  it("escalate: dispose(remove/add) === planTransition(park) over the same shed set", () => {
    const disp = dispose("stalled", 99, { RED_AFK_STALLED_RETRIES: "1" });
    expect(disp.decision).toBe("escalate");
    const plan = planTransition(disp.removeLabels, parkOrHuman(disp.typedLabel));
    expect(isRefused(plan)).toBe(false);
    if (isRefused(plan)) return;
    expect([...plan.remove]).toEqual(disp.removeLabels);
    expect([...plan.add]).toEqual(disp.addLabels);
  });
});

describe("planTriageTransition delegates to the shared planner (#2663)", () => {
  // The pre-#2663 static table, reproduced verbatim: the delegating wrapper must
  // emit exactly this when the caller does not supply the issue's labels.
  const LEGACY: Record<string, { remove: string[]; add: string[]; close: boolean }> = {
    "ready-for-agent": { remove: [LABEL_NEEDS_TRIAGE], add: [LABEL_READY], close: false },
    "needs-info": { remove: [LABEL_NEEDS_TRIAGE], add: [LABEL_NEEDS_INFO], close: false },
    "ready-for-human": { remove: [LABEL_NEEDS_TRIAGE], add: [LABEL_HUMAN], close: false },
    wontfix: { remove: [LABEL_NEEDS_TRIAGE], add: ["wontfix"], close: true },
  };

  it.each(Object.keys(LEGACY))("%s keeps the historical delta", (decision) => {
    expect(planTriageTransition(decision as never)).toEqual(LEGACY[decision]);
  });

  it("sheds the real state role when the caller supplies the issue's labels", () => {
    expect(planTriageTransition("ready-for-agent", [LABEL_NEEDS_TRIAGE, LABEL_HUMAN, LABEL_VALIDATION])).toEqual({
      remove: [LABEL_HUMAN, LABEL_NEEDS_TRIAGE, LABEL_VALIDATION],
      add: [LABEL_READY],
      close: false,
    });
  });

  it("falls back to the static delta when the planner refuses", () => {
    // A `queue` is refused while `req:*` edges survive — the maintainer's
    // decision must still be recorded.
    expect(planTriageTransition("ready-for-agent", [LABEL_NEEDS_TRIAGE, "req:7"])).toEqual(
      LEGACY["ready-for-agent"],
    );
  });
});

describe("lifecycle edge → transition mapping (#2663)", () => {
  it("maps the state-role edges", () => {
    expect(lifecycleTransitionFor([LABEL_READY])).toEqual({ kind: "queue" });
    expect(lifecycleTransitionFor([LABEL_HUMAN])).toEqual({ kind: "human" });
    expect(lifecycleTransitionFor([LABEL_HUMAN, LABEL_SPEC])).toEqual({ kind: "park", reason: LABEL_SPEC });
  });

  it("leaves the claim swap alone — `running` is a projection, not a state role", () => {
    expect(lifecycleTransitionFor([LABEL_RUNNING])).toBeNull();
  });
});

describe("transitionLabels — the shared port adapter (#2663)", () => {
  it("applies the planned pair and reports the plan", async () => {
    const calls: Array<{ remove: string[]; add: string[] }> = [];
    const result = await transitionLabels(
      async (remove, add) => {
        calls.push({ remove, add });
        return true;
      },
      [LABEL_RUNNING],
      { kind: "queue" },
    );
    expect(calls).toEqual([{ remove: [LABEL_RUNNING], add: [LABEL_READY] }]);
    expect(result.applied).toBe(true);
  });

  it("performs NO edit when the plan is refused", async () => {
    let called = false;
    const result = await transitionLabels(
      async () => {
        called = true;
        return true;
      },
      [LABEL_DEPENDENCY, "req:9"],
      { kind: "queue" },
    );
    expect(called).toBe(false);
    expect(result.applied).toBe(false);
    if (result.applied) return;
    expect(result.reason).toMatch(/dependency edges remain/);
  });
});

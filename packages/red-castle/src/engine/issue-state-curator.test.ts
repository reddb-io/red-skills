import { describe, expect, it, vi } from "vitest";
import {
  runIssueStateCurator as runIssueStateCuratorCore,
  type IssueCuratorState,
  type IssueCuratorStore,
  type IssueStateCuratorInput,
} from "./issue-state-curator.js";
import type { StateTransitionLabels } from "./state-transition.js";
import type { TrackerIssue, TrackerPort } from "./tracker/port.js";

const labels: StateTransitionLabels = {
  ready: "ready-for-agent",
  running: "running",
  human: "ready-for-human",
  needsTriage: "needs-triage",
  needsInfo: "needs-info",
  quarantine: "quarantine",
  dependencyBlocked: "blocked:dependency",
  blockedPrefix: "blocked:",
  reqPrefix: "req:",
};

const ACTIVE_BLOCKER = [
  "## Current blocker",
  "",
  "<!-- red:blocker-state v1 -->",
  "status: blocked",
  "kind: validation",
  "summary: Gate still needs judgment.",
  "<!-- /red:blocker-state -->",
  "",
  "## Quarantine diagnosis",
  "",
  "<!-- afk:quarantine v1 issue=#12 -->",
  "Original diagnosis remains auditable.",
].join("\n");

function runIssueStateCurator(
  input: Omit<IssueStateCuratorInput, "hasActiveCurrentBlocker">,
) {
  return runIssueStateCuratorCore({
    ...input,
    // The parser belongs to apps/dev; this package test injects only the fact
    // needed to exercise curator policy.
    hasActiveCurrentBlocker: (body) => body.includes("status: blocked"),
  });
}

function memoryStore(): IssueCuratorStore & { value: IssueCuratorState } {
  return {
    value: { version: 1, failedChecks: {} },
    async read() {
      return this.value;
    },
    async write(value) {
      this.value = value;
    },
  };
}

function harness(issue: TrackerIssue) {
  let current = { ...issue, labels: [...issue.labels] };
  const edits: Array<{ remove: readonly string[]; add: readonly string[] }> = [];
  const bodies: string[] = [];
  const tracker: TrackerPort = {
    listOpenIssuesByLabel: async () => [current],
    isIssueClosed: async () => false,
    editIssueLabels: async (_number, mutation) => {
      edits.push(mutation);
      current = {
        ...current,
        labels: [
          ...current.labels.filter((label) => !mutation.remove.includes(label)),
          ...mutation.add.filter((label) => !current.labels.includes(label)),
        ],
      };
    },
    editIssueBody: async (_number, body) => {
      bodies.push(body);
      current = { ...current, body };
    },
    commentOnIssue: async () => undefined,
    closeIssue: async () => undefined,
  };
  return { tracker, edits, bodies, current: () => current };
}

describe("castle issue-state curator", () => {
  it("restores ready-for-agent when external edits dissolve the incoherence", async () => {
    const h = harness({
      number: 11,
      labels: ["quarantine", "priority:normal"],
      body: "## Current blocker\n\nNone\n\n<!-- afk:quarantine v1 issue=#11 -->\nOld diagnosis.",
    });
    const store = memoryStore();

    const result = await runIssueStateCurator({ tracker: h.tracker, store, labels, nowMs: Date.UTC(2026, 6, 23) });

    expect(result).toEqual({ checked: 1, released: [11], parked: [], reconciled: [] });
    expect(h.edits).toEqual([{ remove: ["quarantine"], add: ["ready-for-agent"] }]);
    expect(h.bodies[0]).toContain("<!-- afk:quarantine-release v1 issue=#11 -->");
    expect(h.bodies[0]).toContain("auto-released after coherence was restored");
    expect(store.value.failedChecks).toEqual({});
  });

  it("parks a still-incoherent issue for HITL on the third failed re-check", async () => {
    const h = harness({ number: 12, labels: ["quarantine"], body: ACTIVE_BLOCKER });
    const store = memoryStore();

    const first = await runIssueStateCurator({ tracker: h.tracker, store, labels, nowMs: 1_000 });
    const second = await runIssueStateCurator({ tracker: h.tracker, store, labels, nowMs: 2_000 });
    const third = await runIssueStateCurator({ tracker: h.tracker, store, labels, nowMs: 3_000 });

    expect(first).toEqual({ checked: 1, released: [], parked: [], reconciled: [] });
    expect(second).toEqual({ checked: 1, released: [], parked: [], reconciled: [] });
    expect(third).toEqual({ checked: 1, released: [], parked: [12], reconciled: [] });
    // The pre-transition writer emitted a fixed `[quarantine, ready-for-agent]`
    // removal; `ready-for-agent` is absent here, so dropping it from the delta
    // is the same tracker outcome with one less no-op label (#2666).
    expect(h.edits).toEqual([{ remove: ["quarantine"], add: ["ready-for-human"] }]);
    expect(h.current().body).toContain("Original diagnosis remains auditable.");
    expect(store.value.failedChecks).toEqual({});
  });

  it("keeps one broken tracker mutation issue-local and continues the sweep", async () => {
    const store = memoryStore();
    const tracker: TrackerPort = {
      listOpenIssuesByLabel: async () => [
        { number: 1, labels: ["quarantine"], body: "## Current blocker\n\nNone" },
        { number: 2, labels: ["quarantine"], body: "## Current blocker\n\nNone" },
      ],
      isIssueClosed: async () => false,
      editIssueLabels: vi.fn(async (issue) => {
        if (issue === 1) throw new Error("one issue is unwritable");
      }),
      editIssueBody: async () => undefined,
      commentOnIssue: async () => undefined,
      closeIssue: async () => undefined,
    };

    const result = await runIssueStateCurator({ tracker, store, labels, nowMs: 1_000 });

    expect(result).toEqual({ checked: 2, released: [2], parked: [], reconciled: [] });
    expect(tracker.editIssueLabels).toHaveBeenCalledTimes(2);
  });
});

// #2749 — a park is treated as terminal, but it is not. A parked issue can
// still land, and when GitHub's own PR-closes-issue mechanism performs the
// close on a human merge, NO engine close path runs: the park role survives on
// the closed issue and the audit reads a delivered slice as human-escalated.
describe("closed-issue state reconcile (#2749)", () => {
  /** A tracker with nothing quarantined and `closed` sitting in the tracker's
   * closed set — i.e. every close here originated OUTSIDE the engine. */
  function closedHarness(closed: TrackerIssue[]) {
    const edits: Array<{ issue: number; remove: readonly string[]; add: readonly string[] }> = [];
    const searches: Array<{ labels: readonly string[]; limit: number }> = [];
    const tracker: TrackerPort = {
      listOpenIssuesByLabel: async () => [],
      listClosedIssuesByAnyLabel: async (names, limit) => {
        searches.push({ labels: names, limit });
        return closed.filter((issue) => issue.labels.some((label) => names.includes(label)));
      },
      isIssueClosed: async () => true,
      editIssueLabels: async (issue, mutation) => {
        edits.push({ issue, ...mutation });
      },
      editIssueBody: async () => undefined,
      commentOnIssue: async () => undefined,
      closeIssue: async () => undefined,
    };
    return { tracker, edits, searches };
  }

  it("strips the park role from an issue closed outside the engine", async () => {
    const h = closedHarness([
      { number: 2724, labels: ["ready-for-human", "blocked:ci", "spec:2723"], body: "" },
      { number: 2725, labels: ["ready-for-human", "blocked:ci", "spec:2723"], body: "" },
    ]);

    const result = await runIssueStateCurator({
      tracker: h.tracker,
      store: memoryStore(),
      labels,
      nowMs: 1_000,
    });

    expect(result.reconciled).toEqual([2724, 2725]);
    for (const edit of h.edits) {
      expect(new Set(edit.remove)).toEqual(new Set(["ready-for-human", "blocked:ci"]));
      expect(edit.add).toEqual([]);
    }
  });

  it("keeps the Spec child label and every other permanent marker", async () => {
    const h = closedHarness([
      {
        number: 2724,
        labels: ["ready-for-human", "blocked:ci", "spec:2723", "type:task", "priority:high"],
        body: "",
      },
    ]);

    await runIssueStateCurator({ tracker: h.tracker, store: memoryStore(), labels, nowMs: 1_000 });

    const removed = new Set(h.edits[0]!.remove);
    expect(removed.has("spec:2723")).toBe(false);
    expect(removed.has("type:task")).toBe(false);
    expect(removed.has("priority:high")).toBe(false);
  });

  it("reads every state role in ONE bounded search, never a per-label loop", async () => {
    const h = closedHarness([]);

    await runIssueStateCurator({
      tracker: h.tracker,
      store: memoryStore(),
      labels,
      nowMs: 1_000,
      closedReconcileLimit: 7,
    });

    expect(h.searches).toEqual([
      {
        labels: [
          "ready-for-agent",
          "ready-for-human",
          "needs-triage",
          "needs-info",
          "quarantine",
          "blocked:dependency",
        ],
        limit: 7,
      },
    ]);
  });

  it("writes nothing for a closed issue that already carries no state", async () => {
    const h = closedHarness([{ number: 40, labels: ["ready-for-human"], body: "" }]);
    // The search is label-driven, so a clean issue never lists; assert the
    // planner's no-op guard directly by handing back one anyway.
    h.tracker.listClosedIssuesByAnyLabel = async () => [
      { number: 41, labels: ["spec:2723"], body: "" },
    ];

    const result = await runIssueStateCurator({
      tracker: h.tracker,
      store: memoryStore(),
      labels,
      nowMs: 1_000,
    });

    expect(result.reconciled).toEqual([]);
    expect(h.edits).toEqual([]);
  });

  it("no-ops when the tracker adapter cannot list closed issues", async () => {
    const tracker: TrackerPort = {
      listOpenIssuesByLabel: async () => [],
      isIssueClosed: async () => true,
      editIssueLabels: vi.fn(async () => undefined),
      commentOnIssue: async () => undefined,
      closeIssue: async () => undefined,
    };

    const result = await runIssueStateCurator({ tracker, store: memoryStore(), labels, nowMs: 1 });

    expect(result.reconciled).toEqual([]);
    expect(tracker.editIssueLabels).not.toHaveBeenCalled();
  });

  it("keeps a read fault issue-local: the quarantine sweep still reports", async () => {
    const h = closedHarness([]);
    h.tracker.listClosedIssuesByAnyLabel = async () => {
      throw new Error("tracker search unavailable");
    };

    const result = await runIssueStateCurator({
      tracker: h.tracker,
      store: memoryStore(),
      labels,
      nowMs: 1_000,
    });

    expect(result).toEqual({ checked: 0, released: [], parked: [], reconciled: [] });
  });

  it("keeps one unwritable issue from stopping the rest of the batch", async () => {
    const h = closedHarness([
      { number: 50, labels: ["ready-for-human"], body: "" },
      { number: 51, labels: ["ready-for-human"], body: "" },
    ]);
    h.tracker.editIssueLabels = async (issue) => {
      if (issue === 50) throw new Error("one issue is unwritable");
    };

    const result = await runIssueStateCurator({
      tracker: h.tracker,
      store: memoryStore(),
      labels,
      nowMs: 1_000,
    });

    expect(result.reconciled).toEqual([51]);
  });
});

// The curator's WRITE moved to planTransition in #2666. These rows pin the
// exact delta for every shape the pre-transition writer could emit. Where the
// raw writer named a label the issue did not carry, the row records the same
// tracker outcome with the no-op dropped; where it left a SECOND state role
// standing, the row records the coherent set the planner proves instead.
describe("curator label deltas are byte-identical to the pre-transition writer", () => {
  const COHERENT = "## Current blocker\n\nNone\n";

  const releases: Array<{ name: string; labels: string[]; remove: string[]; add: string[] }> = [
    {
      name: "bare quarantine",
      labels: ["quarantine"],
      remove: ["quarantine"],
      add: ["ready-for-agent"],
    },
    {
      name: "non-state labels ride through untouched",
      labels: ["quarantine", "type:ticket", "priority:high"],
      remove: ["quarantine"],
      add: ["ready-for-agent"],
    },
  ];

  for (const row of releases) {
    it(`release: ${row.name}`, async () => {
      const h = harness({ number: 30, labels: row.labels, body: COHERENT });
      const result = await runIssueStateCurator({
        tracker: h.tracker,
        store: memoryStore(),
        labels,
        nowMs: 1_000,
      });
      expect(result.released).toEqual([30]);
      expect(h.edits).toEqual([{ remove: row.remove, add: row.add }]);
    });
  }

  it("release: refuses to queue a quarantined issue that still carries req edges", async () => {
    const h = harness({ number: 31, labels: ["quarantine", "req:9"], body: COHERENT });
    const result = await runIssueStateCurator({
      tracker: h.tracker,
      store: memoryStore(),
      labels,
      nowMs: 1_000,
    });
    expect(result).toEqual({ checked: 1, released: [], parked: [], reconciled: [] });
    expect(h.edits).toEqual([]);
  });

  const parks: Array<{ name: string; labels: string[]; remove: string[]; add: string[] }> = [
    {
      name: "the canonical quarantine + ready pair",
      labels: ["quarantine", "ready-for-agent"],
      remove: ["ready-for-agent", "quarantine"],
      add: ["ready-for-human"],
    },
    {
      name: "a stacked blocked reason is collapsed with the state roles",
      labels: ["quarantine", "ready-for-agent", "blocked:validation"],
      remove: ["ready-for-agent", "quarantine", "blocked:validation"],
      add: ["ready-for-human"],
    },
    {
      name: "an active claim projection never survives the park",
      labels: ["quarantine", "running"],
      remove: ["quarantine", "running"],
      add: ["ready-for-human"],
    },
  ];

  for (const row of parks) {
    it(`park: ${row.name}`, async () => {
      const h = harness({ number: 40, labels: row.labels, body: COHERENT });
      const store = memoryStore();
      for (const nowMs of [1_000, 2_000, 3_000]) {
        await runIssueStateCurator({ tracker: h.tracker, store, labels, nowMs });
      }
      expect(h.edits).toEqual([{ remove: row.remove, add: row.add }]);
    });
  }
});

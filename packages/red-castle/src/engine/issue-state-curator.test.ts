import { describe, expect, it, vi } from "vitest";
import {
  runIssueStateCurator,
  type IssueCuratorState,
  type IssueCuratorStore,
} from "./issue-state-curator.js";
import type { TrackerIssue, TrackerPort } from "./tracker/port.js";

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

    const result = await runIssueStateCurator({ tracker: h.tracker, store, nowMs: Date.UTC(2026, 6, 23) });

    expect(result).toEqual({ checked: 1, released: [11], parked: [] });
    expect(h.edits).toEqual([{ remove: ["quarantine"], add: ["ready-for-agent"] }]);
    expect(h.bodies[0]).toContain("<!-- afk:quarantine-release v1 issue=#11 -->");
    expect(h.bodies[0]).toContain("auto-released after coherence was restored");
    expect(store.value.failedChecks).toEqual({});
  });

  it("parks a still-incoherent issue for HITL on the third failed re-check", async () => {
    const h = harness({ number: 12, labels: ["quarantine"], body: ACTIVE_BLOCKER });
    const store = memoryStore();

    const first = await runIssueStateCurator({ tracker: h.tracker, store, nowMs: 1_000 });
    const second = await runIssueStateCurator({ tracker: h.tracker, store, nowMs: 2_000 });
    const third = await runIssueStateCurator({ tracker: h.tracker, store, nowMs: 3_000 });

    expect(first).toEqual({ checked: 1, released: [], parked: [] });
    expect(second).toEqual({ checked: 1, released: [], parked: [] });
    expect(third).toEqual({ checked: 1, released: [], parked: [12] });
    expect(h.edits).toEqual([
      { remove: ["quarantine", "ready-for-agent"], add: ["ready-for-human"] },
    ]);
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

    const result = await runIssueStateCurator({ tracker, store, nowMs: 1_000 });

    expect(result).toEqual({ checked: 2, released: [2], parked: [] });
    expect(tracker.editIssueLabels).toHaveBeenCalledTimes(2);
  });
});

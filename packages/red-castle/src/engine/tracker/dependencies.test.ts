import { describe, expect, it } from "vitest";
import {
  executeCloseCascade,
  executeUnblockSweep,
  labelForDependency,
  parseDependencyLabels,
  type TrackerPort,
} from "./dependencies.js";
import type { EngineLabelVocabulary } from "../config.js";

const labels: EngineLabelVocabulary = {
  ready: "queue:agent",
  running: "state:running",
  human: "queue:human",
  needsTriage: "needs-triage",
  needsInfo: "needs-info",
  quarantine: "quarantine",
  dependencyBlocked: "wait:dependency",
  blockedPrefix: "blocked:",
  reqPrefix: "depends-on:",
};

function fakeTracker(state: {
  issues: Map<
    number,
    {
      body: string;
      labels: string[];
      closed: boolean;
      title?: string;
      url?: string;
    }
  >;
  labelIndex: Map<string, number[]>;
}): TrackerPort & {
  edits: Array<{ issue: number; remove: string[]; add: string[] }>;
  comments: Array<{ issue: number; body: string }>;
} {
  const edits: Array<{ issue: number; remove: string[]; add: string[] }> = [];
  const comments: Array<{ issue: number; body: string }> = [];
  return {
    edits,
    comments,
    async listOpenIssuesByLabel(label) {
      return (state.labelIndex.get(label) ?? []).map((number) => {
        const issue = state.issues.get(number);
        if (!issue) throw new Error(`missing fixture issue ${number}`);
        return { number, body: issue.body, labels: issue.labels };
      });
    },
    async isIssueClosed(issue) {
      return state.issues.get(issue)?.closed ?? false;
    },
    async editIssueLabels(issue, mutation) {
      edits.push({
        issue,
        remove: [...mutation.remove],
        add: [...mutation.add],
      });
    },
    async commentOnIssue(issue, body) {
      comments.push({ issue, body });
    },
    async closeIssue(issue) {
      const row = state.issues.get(issue);
      if (row) row.closed = true;
    },
    async issueReference(issue) {
      const row = state.issues.get(issue);
      return row
        ? { number: issue, title: row.title, url: row.url }
        : undefined;
    },
  };
}

describe("tracker dependency labels", () => {
  it("parses configured req labels only", () => {
    expect(
      parseDependencyLabels(
        ["depends-on:10", "req:99", "depends-on:2"],
        labels,
      ),
    ).toEqual([2, 10]);
    expect(labelForDependency(42, labels)).toBe("depends-on:42");
  });
});

describe("tracker close cascade", () => {
  it("promotes a dependency-blocked issue through the tracker port with configured labels", async () => {
    const tracker = fakeTracker({
      issues: new Map([
        [
          7,
          {
            body: "",
            labels: [],
            closed: true,
            title: "Foundation",
            url: "https://example.invalid/7",
          },
        ],
        [
          20,
          {
            body: "",
            labels: ["wait:dependency", "depends-on:7"],
            closed: false,
          },
        ],
      ]),
      labelIndex: new Map([["depends-on:7", [20]]]),
    });

    const promoted = await executeCloseCascade({
      closedIssue: 7,
      tracker,
      labels,
    });

    expect(promoted).toEqual([20]);
    expect(tracker.edits).toEqual([
      {
        issue: 20,
        remove: ["wait:dependency", "depends-on:7"],
        add: ["queue:agent"],
      },
    ]);
    expect(tracker.comments).toEqual([
      {
        issue: 20,
        body: "🤖 /afk unblocked: all dependencies closed ([Foundation (#7)](https://example.invalid/7)).",
      },
    ]);
  });

  it("leaves a dependent blocked while any configured dependency remains open", async () => {
    const tracker = fakeTracker({
      issues: new Map([
        [7, { body: "", labels: [], closed: true }],
        [8, { body: "", labels: [], closed: false }],
        [
          20,
          {
            body: "",
            labels: ["wait:dependency", "depends-on:7", "depends-on:8"],
            closed: false,
          },
        ],
      ]),
      labelIndex: new Map([["depends-on:7", [20]]]),
    });

    await expect(
      executeCloseCascade({ closedIssue: 7, tracker, labels }),
    ).resolves.toEqual([]);
    expect(tracker.edits).toEqual([]);
  });
});

describe("tracker unblock sweep", () => {
  it("promotes all-closed dependency-blocked candidates discovered through the port", async () => {
    const tracker = fakeTracker({
      issues: new Map([
        [7, { body: "", labels: [], closed: true }],
        [
          20,
          {
            body: "",
            labels: ["wait:dependency", "depends-on:7"],
            closed: false,
          },
        ],
      ]),
      labelIndex: new Map([["wait:dependency", [20]]]),
    });

    await expect(executeUnblockSweep({ tracker, labels })).resolves.toEqual([
      20,
    ]);
    expect(tracker.edits).toEqual([
      {
        issue: 20,
        remove: ["wait:dependency", "depends-on:7"],
        add: ["queue:agent"],
      },
    ]);
  });

  it("routes a dependent carrying a declared HUMAN-ONLY type to the human lane", async () => {
    const tracker = fakeTracker({
      issues: new Map([
        [7, { body: "", labels: [], closed: true }],
        [
          20,
          {
            body: "",
            labels: ["wait:dependency", "depends-on:7", "wayfinder:grilling"],
            closed: false,
          },
        ],
      ]),
      labelIndex: new Map([["wait:dependency", [20]]]),
    });

    await expect(
      executeUnblockSweep({
        tracker,
        labels: { ...labels, hitlTypes: ["wayfinder:grilling"] },
      }),
    ).resolves.toEqual([20]);
    expect(tracker.edits).toEqual([
      {
        issue: 20,
        remove: ["wait:dependency", "depends-on:7"],
        add: ["queue:human"],
      },
    ]);
  });
});

// The promotion WRITE moved to planTransition in #2666. These rows pin the
// exact mutation the raw writer emitted before the migration, so a delta that
// drifts by a single label fails here.
describe("promotion label deltas are byte-identical to the pre-transition writer", () => {
  const rows: Array<{
    name: string;
    body: string;
    candidateLabels: string[];
    remove: string[];
    add: string[];
  }> = [
    {
      name: "single edge label",
      body: "",
      candidateLabels: ["wait:dependency", "depends-on:7"],
      remove: ["wait:dependency", "depends-on:7"],
      add: ["queue:agent"],
    },
    {
      name: "several edge labels are consumed in numeric order",
      body: "",
      candidateLabels: ["wait:dependency", "depends-on:12", "depends-on:7", "depends-on:3"],
      remove: ["wait:dependency", "depends-on:3", "depends-on:7", "depends-on:12"],
      add: ["queue:agent"],
    },
    {
      name: "body-derived dependencies leave no edge label to consume",
      body: "## Blocked by\n\n- #7\n",
      candidateLabels: ["wait:dependency"],
      remove: ["wait:dependency"],
      add: ["queue:agent"],
    },
    {
      name: "non-state labels are untouched",
      body: "",
      candidateLabels: ["wait:dependency", "depends-on:7", "type:ticket", "priority:high"],
      remove: ["wait:dependency", "depends-on:7"],
      add: ["queue:agent"],
    },
  ];

  for (const row of rows) {
    it(row.name, async () => {
      const tracker = fakeTracker({
        issues: new Map([
          [7, { body: "", labels: [], closed: true }],
          [3, { body: "", labels: [], closed: true }],
          [12, { body: "", labels: [], closed: true }],
          [20, { body: row.body, labels: row.candidateLabels, closed: false }],
        ]),
        labelIndex: new Map([["wait:dependency", [20]]]),
      });

      await expect(executeUnblockSweep({ tracker, labels })).resolves.toEqual([20]);
      expect(tracker.edits).toEqual([{ issue: 20, remove: row.remove, add: row.add }]);
    });
  }
});

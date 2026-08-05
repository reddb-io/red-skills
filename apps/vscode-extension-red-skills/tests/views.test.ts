import { describe, expect, it } from "vitest";
import {
  buildEventsTree,
  buildPullRequestsTree,
  buildWorkersTree,
  type ViewNode,
} from "../src/model/nodes.js";
import { EMPTY_FOLLOW, followTail, longestOverlap } from "../src/model/log-follow.js";
import { formatBytes, formatDuration, formatPercent } from "../src/model/format.js";
import { readSettings, MIN_POLL_INTERVAL_MS } from "../src/config.js";
import type { HostSnapshot } from "../src/model/snapshot.js";
import type { RedskilledHostEvent } from "../src/redskilled/event-lane.js";
import { statuslinePayload, hostState, worker } from "./fixtures.js";

function snapshotOf(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    reachable: true,
    socketPath: "/tmp/rsk/d.sock",
    source: "derived from XDG_RUNTIME_DIR",
    payload: statuslinePayload(),
    hostState: hostState(),
    dashboard: null,
    lane: { path: "/tmp/rsk/lane.toonl", exists: true, truncated: false, events: [] },
    error: null,
    readAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

function labels(nodes: readonly ViewNode[]): string[] {
  return nodes.map((node) => node.label);
}

describe("the Workers tree", () => {
  it("puts the host summary first, so an idle host never reads as an absent one", () => {
    const nodes = buildWorkersTree(snapshotOf({ payload: statuslinePayload({ workers: [] }) }));
    expect(nodes[0]!.kind).toBe("host");
    expect(nodes[0]!.label).toContain("0 Workers");
    expect(nodes[1]!.label).toBe("no Worker is running");
    expect(nodes[1]!.tone).toBe("normal");
  });

  it("renders one row per Worker with its vitals nested underneath", () => {
    const nodes = buildWorkersTree(snapshotOf());
    const row = nodes[1]!;
    expect(row.kind).toBe("worker");
    expect(row.label).toBe("wA1B2");
    expect(row.description).toContain("reddb-io/red-skills");
    expect(row.description).toContain("512M");
    expect(labels(row.children)[0]).toContain("512M of 2G");
    expect(row.workspacePath).toContain(".red/tmp/workers/wA1B2/2998");
    expect(row.logPath).toBe("/tmp/wA1B2.log");
  });

  it("reddens a Worker at its ceiling and warns about one with no unit of its own", () => {
    const hot = buildWorkersTree(snapshotOf({
      payload: statuslinePayload({ workers: [worker({ used_fraction: 0.97 })] }),
    }))[1]!;
    expect(hot.tone).toBe("error");

    const unisolated = buildWorkersTree(snapshotOf({
      payload: statuslinePayload({ workers: [worker({ isolated: false, used_fraction: 0.1 })] }),
    }))[1]!;
    expect(unisolated.tone).toBe("warning");
    expect(labels(unisolated.children)).toContain("no unit of its own");
  });

  it("shows one unreachable row rather than an empty tree", () => {
    const nodes = buildWorkersTree(snapshotOf({
      reachable: false,
      payload: null,
      error: { name: "RedskilledUnreachableError", message: "nothing answered" },
    }));
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.tone).toBe("error");
    expect(nodes[0]!.tooltip).toContain("/tmp/rsk/d.sock");
    // The socket derivation is in the tooltip, because it is asked for exactly here.
    expect(nodes[0]!.tooltip).toContain("derived from XDG_RUNTIME_DIR");
  });
});

describe("the host event view", () => {
  const event = (overrides: Partial<RedskilledHostEvent>): RedskilledHostEvent => ({
    version: 1,
    ts: "2026-08-01T09:00:00.000Z",
    kind: overrides.kind ?? overrides.event ?? "worker-birth",
    event: overrides.event ?? overrides.kind ?? "worker-birth",
    worker_id: "wA1B2",
    project_label: "reddb-io/red-skills",
    pid: 4242,
    workspace_path: "/workspaces",
    log_path: null,
    isolated: true,
    unit: null,
    memory_high: null,
    memory_max: null,
    cpu_weight: null,
    admission_verdict: null,
    phase: null,
    step: null,
    base_head_sha: null,
    base_commits_ahead: null,
    heal_kind: null,
    detail: null,
    reason: null,
    exit_code: null,
    signal: null,
    ...overrides,
  });

  it("reads newest first, because a panel is read from the top", () => {
    const nodes = buildEventsTree(snapshotOf({
      lane: {
        path: "/tmp/rsk/lane.toonl",
        exists: true,
        truncated: false,
        events: [
          event({ ts: "2026-08-01T09:00:00.000Z" }),
          event({ ts: "2026-08-01T09:05:00.000Z", event: "worker-death", exit_code: 1 }),
        ],
      },
    }));
    expect(nodes[0]!.label).toContain("worker-death");
    expect(nodes[0]!.description).toContain("exit 1");
    expect(nodes[0]!.tone).toBe("warning");
  });

  it("says out loud that older events were not read", () => {
    const nodes = buildEventsTree(snapshotOf({
      lane: { path: "/tmp/rsk/lane.toonl", exists: true, truncated: true, events: [event({})] },
    }));
    expect(nodes.at(-1)!.label).toContain("older events were not read");
  });

  it("tells an absent lane from an empty one", () => {
    const absent = buildEventsTree(snapshotOf({
      lane: { path: "/tmp/rsk/lane.toonl", exists: false, truncated: false, events: [] },
    }));
    expect(absent[0]!.label).toBe("no event lane on this host");

    const empty = buildEventsTree(snapshotOf());
    expect(empty[0]!.label).toBe("the event lane is empty");
  });
});

describe("the pull-request view", () => {
  it("shows each registered project's counts as the host polled them", () => {
    const nodes = buildPullRequestsTree(snapshotOf());
    expect(nodes[0]!.label).toBe("reddb-io/red-skills");
    expect(nodes[0]!.description).toContain("12 PR");
    expect(nodes[0]!.description).toContain("37 issues");
  });

  it("warns rather than reporting a zero when the tracker could not be reached", () => {
    const nodes = buildPullRequestsTree(snapshotOf({ payload: statuslinePayload({ openPullRequests: null }) }));
    expect(nodes[0]!.tone).toBe("warning");
    expect(nodes[0]!.description).toBe("unreachable");
  });
});

describe("following one Worker's log", () => {
  it("prints only what is new when the same tail comes back", () => {
    const first = followTail(EMPTY_FOLLOW, "wA1B2", ["a", "b"]);
    expect(first.reset).toBe(true);
    expect(first.append).toEqual(["a", "b"]);

    const second = followTail(first.state, "wA1B2", ["a", "b", "c"]);
    expect(second.reset).toBe(false);
    expect(second.append).toEqual(["c"]);
  });

  it("resets when the log rotated out from under it, instead of replaying a dead history", () => {
    const first = followTail(EMPTY_FOLLOW, "wA1B2", ["old-1", "old-2"]);
    const rotated = followTail(first.state, "wA1B2", ["brand-new-1"]);
    expect(rotated.reset).toBe(true);
    expect(rotated.append).toEqual(["brand-new-1"]);
  });

  it("resets on a switch to another Worker", () => {
    const first = followTail(EMPTY_FOLLOW, "wA1B2", ["a"]);
    const switched = followTail(first.state, "wZZZZ", ["x"]);
    expect(switched.reset).toBe(true);
    expect(switched.state.workerId).toBe("wZZZZ");
  });

  it("finds the boundary between what was printed and what arrived", () => {
    expect(longestOverlap(["a", "b", "c"], ["b", "c", "d"])).toBe(2);
    expect(longestOverlap(["a"], ["z"])).toBe(0);
    expect(longestOverlap([], ["a"])).toBe(0);
  });
});

describe("the settings block", () => {
  it("clamps a poll interval an operator set below the floor", () => {
    const settings = readSettings({
      get: <T,>(key: string, fallback: T): T => (key === "pollIntervalMs" ? (1 as unknown as T) : fallback),
    });
    expect(settings.pollIntervalMs).toBe(MIN_POLL_INTERVAL_MS);
  });

  it("clamps a pressure threshold outside 0..1 rather than never firing", () => {
    const settings = readSettings({
      get: <T,>(key: string, fallback: T): T =>
        (key === "notifications.budgetPressureAt" ? (7 as unknown as T) : fallback),
    });
    expect(settings.notifications.budgetPressureAt).toBe(1);
  });

  it("keeps worker-birth off by default — a busy host would be the loudest thing here", () => {
    const settings = readSettings({ get: <T,>(_key: string, fallback: T): T => fallback });
    expect(settings.notifications.workerBirth).toBe(false);
    expect(settings.notifications.workerDeath).toBe(true);
  });
});

describe("the numbers a row shows", () => {
  it("renders bytes, durations and fractions the same way everywhere", () => {
    // Two significant places below 10, none above: "1.4G" and "512M" both read
    // at a glance, and "512.0M" spends a column on a digit nobody acts on.
    expect(formatBytes(512 * 1024 ** 2)).toBe("512M");
    expect(formatBytes(1.4 * 1024 ** 3)).toBe("1.4G");
    expect(formatBytes(900)).toBe("900B");
    expect(formatBytes(null)).toBe("—");
    expect(formatDuration(1_800_000)).toBe("30m");
    expect(formatDuration(null)).toBe("—");
    expect(formatPercent(0.945)).toBe("95%");
    expect(formatPercent(null)).toBe("—");
  });
});

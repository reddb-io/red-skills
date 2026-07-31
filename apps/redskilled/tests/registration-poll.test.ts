// "Why is nothing happening here?" answered from one read (#2908).
//
// A registration the daemon holds and a queue it polled are two facts that only
// mean something together: a project with a record and no poll is one nothing has
// counted, and a project with a poll of zero is one that has finished. Reporting
// the poll ON the registration is what lets an operator — and the canary that
// walks the shipped lane — tell those apart without reading a log.
//
// The request count rides with it because ADR 0130 Amendment 3's whole claim is
// that N projects cost ONE aliased request. A reader that saw depths but not cost
// could not tell the batched shape from the per-project one it replaced.
import { describe, expect, it } from "vitest";
import { buildHostState, isRedskilledHostState } from "../src/host-state.js";
import { buildProjectRegistration } from "../src/project-registration.js";
import type { RedskilledQueueDiscovery } from "../src/queue-discovery.js";

const T0 = "2026-07-31T12:00:00.000Z";

function registration(project_label: string, selector = "{}") {
  return buildProjectRegistration(
    { project_label, selector, argv: ["node", "dev.mjs", "run"], workspace_path: `/w/${project_label}`, target: 1 },
    { now: T0 },
  );
}

function queue(overrides: Partial<RedskilledQueueDiscovery> = {}): RedskilledQueueDiscovery {
  return {
    version: 1,
    fetched_at: "2026-07-31T12:00:05.000Z",
    request_count: 1,
    project_count: 2,
    batch_size: 50,
    rate_limit: { remaining: 4_999, reset_at: null, exhausted: false },
    projects: [
      { project_label: "alpha", outcome: "counted", depth: 7, detail: "alpha has 7 item(s)" },
      { project_label: "beta", outcome: "rate-limited", depth: null, detail: "the quota was spent" },
    ],
    ...overrides,
  };
}

function state(input: { queue?: RedskilledQueueDiscovery | null; labels?: readonly string[] } = {}) {
  return buildHostState({
    daemonVersion: "3.0.4",
    machineIdHash: "m",
    sessionKeyHash: "s",
    pid: 1,
    startedAt: T0,
    now: T0,
    registrations: (input.labels ?? ["alpha", "beta"]).map((label) => registration(label)),
    ...(input.queue === undefined ? {} : { queue: input.queue }),
  });
}

describe("host state reports the last poll per registration", () => {
  it("carries the poll's instant, outcome, depth and what the whole interval cost", () => {
    const polled = state({ queue: queue() }).registrations ?? [];

    expect(polled.find((entry) => entry.project_label === "alpha")?.last_poll).toEqual({
      at: "2026-07-31T12:00:05.000Z",
      outcome: "counted",
      depth: 7,
      request_count: 1,
      detail: "alpha has 7 item(s)",
    });
  });

  it("keeps a spent quota distinguishable from a drained queue", () => {
    // The failure the whole amendment was written about: exhaustion read as "no
    // work". Only `counted` carries a depth, and a rate-limited project carries
    // null — never the zero that would retire a project which still has work.
    const beta = (state({ queue: queue() }).registrations ?? []).find(
      (entry) => entry.project_label === "beta",
    );

    expect(beta?.last_poll?.outcome).toBe("rate-limited");
    expect(beta?.last_poll?.depth).toBeNull();
  });

  it("leaves a project no poll covered without a block at all", () => {
    // Absent is an answer: nobody has counted this yet. A zero here would say the
    // opposite — that it was counted and had nothing — and send an operator to
    // the wrong question entirely.
    const registrations = state({ queue: queue(), labels: ["alpha", "gamma"] }).registrations ?? [];

    expect(registrations.find((entry) => entry.project_label === "gamma")?.last_poll).toBeUndefined();
    expect(registrations.find((entry) => entry.project_label === "alpha")?.last_poll).toBeDefined();
  });

  it("reports every registration unpolled when no poll has run", () => {
    const registrations = state().registrations ?? [];

    expect(registrations).toHaveLength(2);
    expect(registrations.every((entry) => entry.last_poll === undefined)).toBe(true);
  });

  it("stays a well-formed host state for a client that never heard of polls", () => {
    // One daemon serves checkouts pinned to different bundle versions, so the
    // block has to be additive: an older client's validator must still accept it.
    expect(isRedskilledHostState(state({ queue: queue() }))).toBe(true);
  });

  it("states the cost of the interval, not of the project", () => {
    // Two projects, one request. A count above one here is the per-project
    // poller walking back in, and it is visible without counting sockets.
    const registrations = state({ queue: queue({ request_count: 2, project_count: 2 }) }).registrations ?? [];

    expect(registrations.map((entry) => entry.last_poll?.request_count)).toEqual([2, 2]);
  });
});

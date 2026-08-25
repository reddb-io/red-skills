// The cross-host view: every card judged on its own evidence, every Worker
// row still naming the Host that owns it, pending receipts reconciled per
// Host — one dead machine reads unreachable on its own card while the rest
// stay honest.
import { describe, expect, it } from "vitest";

import { fleetHostViews, fleetWorkerRows, type HostRuntime } from "../src/domain/host-fleet";
import type { MobileWorker } from "../src/domain/ticket-dispatch";

const now = Date.parse("2026-08-24T12:00:30.000Z");
const hosts = [
  { host_id: "h1", host_name: "laptop" },
  { host_id: "h2", host_name: "desktop" },
];

function answered(workers: readonly MobileWorker[]): HostRuntime {
  return {
    snapshot: { workers, daemonVersion: "4.2.6", generatedAt: null, staleness: null },
    lastAnsweredAtMs: now - 1_000,
    failure: null,
  };
}

describe("the fleet view", () => {
  it("judges each Host on its own evidence — one outage never colors the rest", () => {
    const views = fleetHostViews(hosts, {
      h1: answered([]),
      h2: { snapshot: null, lastAnsweredAtMs: now - 60_000, failure: "relay refused" },
    }, now);

    expect(views[0]).toMatchObject({ hostId: "h1", status: "online", daemonVersion: "4.2.6" });
    expect(views[1]).toMatchObject({ hostId: "h2", status: "unreachable", failure: "relay refused" });
  });

  it("a Host never polled reads connecting, not online", () => {
    const views = fleetHostViews(hosts, {}, now);
    expect(views.map((view) => view.status)).toEqual(["connecting", "connecting"]);
  });

  it("labels every Worker row with its owning Host and reconciles pending per Host", () => {
    const published = {
      workerId: "W1",
      repository: "reddb-io/red-skills",
      startedAt: "2026-08-24T12:00:00.000Z",
      phase: "coding",
      heartbeatAgeMs: 3_000,
    };
    const pendingRow = {
      workerId: "W9",
      repository: "acme/widgets",
      startedAt: "2026-08-24T12:00:25.000Z",
      pending: true as const,
      hostId: "h2",
      hostName: "desktop",
    };

    const rows = fleetWorkerRows(hosts, { h1: answered([published]) }, [pendingRow], now);

    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.workerId === "W1")).toMatchObject({ hostId: "h1", hostName: "laptop" });
    // h2 never answered: its dispatch receipt is the only evidence there is.
    expect(rows.find((row) => row.workerId === "W9")).toMatchObject({ hostId: "h2", pending: true });
  });

  it("the Host's answer retires its own pending receipt and no other Host's", () => {
    const receiptOnH1 = {
      workerId: "W1",
      repository: "reddb-io/red-skills",
      startedAt: "2026-08-24T12:00:25.000Z",
      pending: true as const,
      hostId: "h1",
      hostName: "laptop",
    };
    const published = { workerId: "W1", repository: "reddb-io/red-skills", startedAt: "2026-08-24T12:00:26.000Z" };

    const rows = fleetWorkerRows(hosts, { h1: answered([published]) }, [receiptOnH1], now);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workerId: "W1", hostId: "h1" });
    expect(rows[0]?.pending).toBeUndefined();
  });
});

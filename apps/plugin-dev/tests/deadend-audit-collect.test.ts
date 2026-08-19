import { describe, expect, it, vi } from "vitest";
import {
  collectDeadendAudit,
  DEFAULT_HUMAN_QUEUE_MAX_AGE_MS,
  type DeadendAuditReader,
} from "../src/core/deadend-audit-collect.js";
import type { IssueState } from "../src/core/deadend-audit.js";

const NOW = Date.parse("2026-07-23T12:00:00Z");

/**
 * A fake gateway that satisfies the read-only reader AND carries a mutation
 * surface. The collector only ever calls reads, so `mutations` must stay empty
 * — this fake is the mutation recorder the "zero mutations" acceptance pins.
 */
class RecordingGateway implements DeadendAuditReader {
  readonly mutations: string[] = [];
  readonly readCounts: Record<string, number> = {};

  private count(name: string): void {
    this.readCounts[name] = (this.readCounts[name] ?? 0) + 1;
  }

  now(): number {
    return NOW;
  }
  async liveWorkers() {
    this.count("liveWorkers");
    return ["wLIVE"];
  }
  async openIssues() {
    this.count("openIssues");
    return [
      { number: 400, labels: ["blocked:dependency", "req:10"], body: "" },
    ];
  }
  async openPrs() {
    this.count("openPrs");
    return [];
  }
  async claims() {
    this.count("claims");
    return [{ issue: 100, worker: "wDEAD" }];
  }
  async worktrees() {
    this.count("worktrees");
    return [{ lane: "feedback", path: "p", live: false }];
  }
  async issueStates(): Promise<ReadonlyMap<number, IssueState>> {
    this.count("issueStates");
    return new Map<number, IssueState>([[10, "CLOSED"]]);
  }

  // Mutation surface — present so the recorder can prove none fire.
  async comment(issue: number, body: string) {
    this.mutations.push(`comment(${issue},${body})`);
  }
  async editLabels(issue: number) {
    this.mutations.push(`editLabels(${issue})`);
  }
  async closeIssue(issue: number) {
    this.mutations.push(`closeIssue(${issue})`);
  }
  async releaseClaim(issue: number) {
    this.mutations.push(`releaseClaim(${issue})`);
  }
  async removeWorktree(path: string) {
    this.mutations.push(`removeWorktree(${path})`);
  }
}

describe("collectDeadendAudit", () => {
  it("composes reads into the pure audit report", async () => {
    const gateway = new RecordingGateway();
    const report = await collectDeadendAudit(gateway);

    expect(report.total).toBe(3); // dangling claim + all-req-closed dep + stale worktree
    expect(report.generatedAtMs).toBe(NOW);
    const dangling = report.classes.find((c) => c.deadendClass === "dangling_claim")!;
    expect(dangling.findings).toHaveLength(1);
    const dep = report.classes.find((c) => c.deadendClass === "dependency_all_closed")!;
    expect(dep.findings).toHaveLength(1);
  });

  it("mutates nothing — the recorder stays empty", async () => {
    const gateway = new RecordingGateway();
    await collectDeadendAudit(gateway);
    expect(gateway.mutations).toEqual([]);
  });

  it("reads each source exactly once", async () => {
    const gateway = new RecordingGateway();
    await collectDeadendAudit(gateway);
    for (const source of [
      "liveWorkers",
      "openIssues",
      "openPrs",
      "claims",
      "worktrees",
      "issueStates",
    ]) {
      expect(gateway.readCounts[source]).toBe(1);
    }
  });

  it("honors a custom human-queue age threshold", async () => {
    const reader: DeadendAuditReader = {
      now: () => NOW,
      liveWorkers: vi.fn(async () => []),
      openIssues: vi.fn(async () => [
        {
          number: 500,
          labels: ["ready-for-human"],
          body: "",
          updatedAt: new Date(NOW - 60 * 60 * 1000).toISOString(), // 1h old
        },
      ]),
      openPrs: vi.fn(async () => []),
      claims: vi.fn(async () => []),
      worktrees: vi.fn(async () => []),
      issueStates: vi.fn(async () => new Map()),
    };
    const strict = await collectDeadendAudit(reader, { humanQueueMaxAgeMs: 30 * 60 * 1000 });
    expect(strict.classes.find((c) => c.deadendClass === "human_queue_age_outlier")!.count).toBe(1);
    const lenient = await collectDeadendAudit(reader);
    expect(lenient.classes.find((c) => c.deadendClass === "human_queue_age_outlier")!.count).toBe(0);
    expect(DEFAULT_HUMAN_QUEUE_MAX_AGE_MS).toBe(2 * 24 * 60 * 60 * 1000);
  });
});

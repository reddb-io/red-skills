import { describe, expect, it, vi } from "vitest";
import {
  createCastleMcpTools,
  type CastleMcpDependencies,
  type ClaimIssueInput,
} from "@reddb-io/red-castle/mcp-server";
import {
  parseClaimRecords,
  renderClaimComment,
  type ClaimRecord,
} from "../src/core/claim.js";
import {
  hostFingerprintPrefix,
  workerIdentity,
} from "../src/core/host-identity.js";

const claims = vi.hoisted(() => [] as Array<{ id: number; body: string }>);
const deadWorkerIds = vi.hoisted(() => ["wDEAD"] as string[]);

function latestClaimPerWorker(records: readonly ClaimRecord[]): Map<string, ClaimRecord> {
  const latest = new Map<string, ClaimRecord>();
  for (const record of records) {
    const seen = latest.get(record.worker);
    if (seen === undefined || record.commentId > seen.commentId) latest.set(record.worker, record);
  }
  return latest;
}

function claimCompatibilityDependencies(): CastleMcpDependencies {
  return {
    async claimStatus(input: ClaimIssueInput) {
      const records = parseClaimRecords(claims);
      const latest = latestClaimPerWorker(records);
      const holders = [...latest.values()].filter((record) => record.kind === "claim");
      const prefix = hostFingerprintPrefix();
      const daemonRecordedDead = (worker: string) =>
        worker.startsWith(prefix) && deadWorkerIds.includes(worker.slice(prefix.length));
      return {
        issue: input.issue,
        daemon_recorded_dead: holders
          .filter((record) => daemonRecordedDead(record.worker))
          .map((record) => record.worker),
        holders: holders.map((record) => ({
          worker: record.worker,
          daemon_liveness: daemonRecordedDead(record.worker) ? "dead" : "unknown",
        })),
      };
    },
    claimRelease: vi.fn(),
  } as unknown as CastleMcpDependencies;
}

describe("claim_status daemon liveness", () => {
  it("names a current holder whose death the daemon recorded", async () => {
    const dead = workerIdentity("wDEAD");
    const alive = workerIdentity("wLIVE");
    claims.splice(
      0,
      claims.length,
      { id: 1, body: renderClaimComment({ worker: dead, runner: "codex" }, "claim") },
      { id: 2, body: renderClaimComment({ worker: alive, runner: "claude" }, "claim") },
    );

    const tool = createCastleMcpTools(claimCompatibilityDependencies())
      .find((candidate) => candidate.name === "claim_status")!;

    await expect(tool.invoke({ issue: 3774 }))
      .resolves.toMatchObject({
        issue: 3774,
        daemon_recorded_dead: [dead],
        holders: expect.arrayContaining([
          expect.objectContaining({ worker: dead, daemon_liveness: "dead" }),
          expect.objectContaining({ worker: alive, daemon_liveness: "unknown" }),
        ]),
      });
  });
});

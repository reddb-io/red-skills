import { describe, expect, it, vi } from "vitest";

const claims = vi.hoisted(() => [] as Array<{ id: number; body: string }>);
const deadWorkerIds = vi.hoisted(() => ["wDEAD"] as string[]);

vi.mock("../src/runtime/gh.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/runtime/gh.js")>(),
  listClaimComments: vi.fn(async () => claims),
}));

vi.mock("../src/runtime/wire.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/runtime/wire.js")>(),
  resolveRepoContext: vi.fn(async (root: string) => ({ root, repo: "acme/widgets" })),
}));

vi.mock("../src/runtime/redskilled-birth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/runtime/redskilled-birth.js")>(),
  createRedskilledBirthPort: vi.fn(() => ({
    recordedDeadWorkerIds: async () => deadWorkerIds,
  })),
}));

import { createDefaultDevAfkMcpOperations } from "../src/mcp-adapter.js";
import { renderClaimComment } from "../src/core/claim.js";
import { workerIdentity } from "../src/core/host-identity.js";

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

    await expect(createDefaultDevAfkMcpOperations("project").claimStatus({ issue: 3774 }))
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

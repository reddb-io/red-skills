import { describe, expect, it } from "vitest";
import { GithubBackpressureError } from "@reddb-io/github";
import {
  createRedskilledGithubGateway,
  type RedskilledGithubProjectAuthority,
} from "../src/github-gateway.js";

const PROJECT: RedskilledGithubProjectAuthority = {
  projectId: "github:101",
  projectLabel: "acme/widgets",
  workspacePath: "/project-workspaces/widgets",
  credentialProfile: "engineering",
};

describe("ACP credential-budget projections", () => {
  it("projects one Project's bound profile with authoritative freshness and daemon presentation policy", async () => {
    let now = "2026-08-15T18:00:00.000Z";
    const gateway = createRedskilledGithubGateway({
      configuredProfiles: ["engineering", "release"],
      clock: () => now,
      upstream: async () => ({
        value: { state: "OPEN" },
        budget: { pool: "rest", remaining: 400, limit: 5_000, reset_at: "2026-08-15T19:00:00.000Z" },
      }),
    });
    await gateway.forProject(PROJECT, { secret: "never-publish-this-token" })
      .read({ kind: "rest", path: "issues/17" });
    now = "2026-08-15T18:00:05.000Z";

    const projection = gateway.projectBudget(PROJECT);
    expect(projection).toMatchObject({
      version: 1,
      scope: "project",
      project_id: "github:101",
      credential_profile: "engineering",
    });
    expect(projection.pools.find((pool) => pool.pool === "rest")).toMatchObject({
      remaining: 400,
      used: 4_600,
      limit: 5_000,
      evidence: { state: "authoritative", authority: "github", age_ms: 5_000, fresh: true },
      presentation: { warning: "critical", density: "expanded" },
    });
    expect(JSON.stringify(projection)).not.toContain("never-publish-this-token");
    expect(JSON.stringify(projection)).not.toContain("release");
  });

  it("separates cached, unavailable, and actively backpressured evidence", async () => {
    let mode: "ok" | "backpressure" | "unavailable" = "ok";
    const gateway = createRedskilledGithubGateway({
      clock: () => "2026-08-15T18:00:00.000Z",
      upstream: async (input) => {
        const pool = input.read.kind === "graphql" ? "graphql" : "rest";
        if (mode === "backpressure") throw new GithubBackpressureError({
          kind: "primary-rest-exhausted",
          pool: "rest",
          retry_at: "2026-08-15T19:00:00.000Z",
          evidence: "balance",
          message: "spent",
        });
        if (mode === "unavailable") throw new Error("offline");
        return { value: {}, budget: { pool, remaining: 4_900, limit: 5_000, reset_at: null } };
      },
    });
    const reader = gateway.forProject(PROJECT, { secret: "fixture" });
    await reader.read({ kind: "rest", path: "issues/1" });
    await reader.read({ kind: "rest", path: "issues/1" });
    mode = "backpressure";
    await reader.read({ kind: "rest", path: "issues/2" }).catch(() => undefined);
    mode = "unavailable";
    await reader.read({ kind: "graphql", selection: "id" }).catch(() => undefined);

    const pools = gateway.projectBudget(PROJECT).pools;
    expect(pools.find((pool) => pool.pool === "rest")?.evidence.state).toBe("backpressured");
    expect(pools.find((pool) => pool.pool === "graphql")?.evidence.state).toBe("unavailable");
    expect(pools.find((pool) => pool.pool === "search")?.evidence.state).toBe("unknown");
  });

  it("gives host administration every configured profile and known Project attribution without secrets", async () => {
    const gateway = createRedskilledGithubGateway({
      configuredProfiles: ["engineering", "release"],
      upstream: async () => ({ value: {}, budget: null }),
    });
    gateway.forProject(PROJECT, { secret: "engineering-secret" });
    gateway.forProject({ ...PROJECT, projectId: "github:202", projectLabel: "acme/release", credentialProfile: "release" }, {
      secret: "release-secret",
    });

    const projection = gateway.hostBudget();
    expect(projection.scope).toBe("host-administration");
    expect(projection.profiles.map((profile) => profile.credential_profile)).toEqual(["engineering", "release"]);
    expect(projection.profiles[0]?.project_ids).toEqual(["github:101"]);
    const publicBytes = JSON.stringify(projection);
    expect(publicBytes).not.toContain("engineering-secret");
    expect(publicBytes).not.toContain("release-secret");
  });
});

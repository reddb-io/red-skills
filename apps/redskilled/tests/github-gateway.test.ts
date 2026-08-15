import { describe, expect, it } from "vitest";
import {
  RedskilledGithubAuthorityError,
  createRedskilledGithubGateway,
  type RedskilledGithubProjectAuthority,
  type RedskilledGithubUpstream,
} from "../src/github-gateway.js";

const PROJECT: RedskilledGithubProjectAuthority = {
  projectId: "github:101",
  projectLabel: "acme/widgets",
  workspacePath: "/project-workspaces/widgets",
  credentialProfile: "engineering",
};

describe("the Project-scoped redskilled GitHub gateway", () => {
  it.each([
    { kind: "rest" as const, path: "issues/17" },
    { kind: "graphql" as const, selection: "issue(number: 17) { id state }" },
    { kind: "repository-fetch" as const, ref: "refs/heads/main" },
  ])("coalesces concurrent equivalent $kind reads into one upstream request", async (request) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const seen: Parameters<RedskilledGithubUpstream>[0][] = [];
    const gateway = createRedskilledGithubGateway({
      clock: () => "2026-08-15T18:00:00.000Z",
      upstream: async (input) => {
        seen.push(input);
        await held;
        return {
          value: { state: "OPEN" },
          budget: { pool: input.read.kind === "graphql" ? "graphql" : "rest", remaining: 4_900, reset_at: null },
        };
      },
    });
    const reader = gateway.forProject(PROJECT, { secret: "fixture credential" });

    const first = reader.read(request);
    const second = reader.read({ ...request });
    await Promise.resolve();
    expect(seen).toHaveLength(1);
    release();

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { source: "upstream", cache: { age_ms: 0 }, credential_profile: "engineering" },
      { source: "upstream", cache: { age_ms: 0 }, credential_profile: "engineering" },
    ]);
    expect(seen[0]).toMatchObject({
      project: PROJECT,
      credential: { secret: "fixture credential" },
      read: request,
    });
  });

  it("returns age and budget facts while isolating cache entries by Project and credential profile", async () => {
    let now = "2026-08-15T18:00:00.000Z";
    let calls = 0;
    const gateway = createRedskilledGithubGateway({
      clock: () => now,
      upstream: async () => ({
        value: { sequence: ++calls },
        budget: { pool: "rest", remaining: 4_800, reset_at: "2026-08-15T19:00:00.000Z" },
      }),
    });
    const first = gateway.forProject(PROJECT, { secret: "first credential" });
    expect(await first.read({ kind: "rest", path: "issues/17" })).toMatchObject({
      source: "upstream",
      project_id: "github:101",
      credential_profile: "engineering",
      cache: { age_ms: 0, fetched_at: now, outcome: "fresh" },
      budget: { pool: "rest", remaining: 4_800 },
      value: { sequence: 1 },
    });

    now = "2026-08-15T18:00:07.000Z";
    expect(await first.read({ kind: "rest", path: "/issues/17" })).toMatchObject({
      source: "cache",
      credential_profile: "engineering",
      cache: { age_ms: 7_000, outcome: "fresh" },
      value: { sequence: 1 },
    });

    const otherProfile = gateway.forProject(
      { ...PROJECT, credentialProfile: "release" },
      { secret: "second credential" },
    );
    const otherProject = gateway.forProject(
      { ...PROJECT, projectId: "github:202", projectLabel: "acme/other" },
      { secret: "first credential" },
    );
    expect((await otherProfile.read({ kind: "rest", path: "issues/17" })).value).toEqual({ sequence: 2 });
    expect((await otherProject.read({ kind: "rest", path: "issues/17" })).value).toEqual({ sequence: 3 });
    expect(calls).toBe(3);

    const publicAnswer = JSON.stringify(await first.read({ kind: "rest", path: "issues/17" }));
    expect(publicAnswer).not.toContain("first credential");
    expect(publicAnswer).not.toContain("second credential");
  });

  it("cannot address another Project or turn Project authority into host administration", async () => {
    const gateway = createRedskilledGithubGateway({
      upstream: async () => ({ value: {}, budget: null }),
    });
    const reader = gateway.forProject(PROJECT, { secret: "fixture credential" });

    await expect(reader.read({ kind: "rest", path: "repos/acme/other/issues/1" }))
      .rejects.toBeInstanceOf(RedskilledGithubAuthorityError);
    await expect(reader.read({ kind: "rest", path: "/user" }))
      .rejects.toBeInstanceOf(RedskilledGithubAuthorityError);
    await expect(reader.read({ kind: "graphql", selection: "repository(owner: \"other\", name: \"repo\") { id }" }))
      .rejects.toBeInstanceOf(RedskilledGithubAuthorityError);
    await expect(reader.read({ kind: "graphql", selection: "viewer { login }" }))
      .rejects.toBeInstanceOf(RedskilledGithubAuthorityError);
    await expect(reader.read({ kind: "repository-fetch", ref: "--upload-pack=admin" }))
      .rejects.toBeInstanceOf(RedskilledGithubAuthorityError);
  });
});

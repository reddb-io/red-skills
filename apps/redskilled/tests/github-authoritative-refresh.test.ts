import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRedskilledGithubGateway,
  createRedskilledGithubUpstream,
  type RedskilledGithubProjectAuthority,
  type RedskilledGithubUpdate,
} from "../src/github-gateway.js";

const PROJECT: RedskilledGithubProjectAuthority = {
  projectId: "github:101",
  projectLabel: "acme/widgets",
  workspacePath: "/project-workspaces/widgets",
  credentialProfile: "engineering",
};

afterEach(() => vi.useRealTimers());

describe("redskilled authoritative GitHub cache refresh", () => {
  it("revalidates with ETag and Last-Modified, retaining the value on 304 and publishing changed state", async () => {
    let version = 1;
    const requests: Headers[] = [];
    const upstream = createRedskilledGithubUpstream({
      fetchImpl: async (_url, init) => {
        const headers = new Headers(init?.headers);
        requests.push(headers);
        if (headers.get("if-none-match") === `\"v${version}\"`) {
          return new Response(null, {
            status: 304,
            headers: { etag: `\"v${version}\"`, "last-modified": `version-${version}` },
          });
        }
        return new Response(JSON.stringify({ version }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            etag: `\"v${version}\"`,
            "last-modified": `version-${version}`,
          },
        });
      },
    });
    const gateway = createRedskilledGithubGateway({ upstream, freshMs: 0 });
    const reader = gateway.forProject(PROJECT, { secret: "daemon-only" });
    const updates: RedskilledGithubUpdate[] = [];
    reader.subscribe((update) => updates.push(update));

    await expect(reader.read({ kind: "rest", path: "issues/17" })).resolves.toMatchObject({
      value: { version: 1 },
    });
    await expect(reader.refresh()).resolves.toBe(1);
    expect(requests[1]!.get("if-none-match")).toBe('"v1"');
    expect(requests[1]!.get("if-modified-since")).toBe("version-1");
    expect(updates.map((update) => update.sequence)).toEqual([1]);

    version = 2;
    await expect(reader.refresh()).resolves.toBe(1);
    expect(updates).toMatchObject([
      { sequence: 1, project_id: "github:101", credential_profile: "engineering", value: { version: 1 } },
      { sequence: 2, project_id: "github:101", credential_profile: "engineering", value: { version: 2 } },
    ]);
    expect(JSON.stringify(updates)).not.toContain("daemon-only");
  });

  it("converges by polling after a lost wake and treats duplicate or reordered wakes only as scoped refresh hints", async () => {
    vi.useFakeTimers();
    let version = 1;
    let calls = 0;
    const gateway = createRedskilledGithubGateway({
      refreshMs: 100,
      upstream: async (input) => {
        calls += 1;
        return { value: { version, kind: input.read.kind }, budget: null };
      },
    });
    const engineering = gateway.forProject(PROJECT, { secret: "engineering-secret" });
    const release = gateway.forProject(
      { ...PROJECT, credentialProfile: "release" },
      { secret: "release-secret" },
    );
    const engineeringUpdates: RedskilledGithubUpdate[] = [];
    const releaseUpdates: RedskilledGithubUpdate[] = [];
    engineering.subscribe((update) => engineeringUpdates.push(update));
    release.subscribe((update) => releaseUpdates.push(update));

    await engineering.read({ kind: "graphql", selection: "issues(first: 10) { totalCount }" });
    version = 2; // no webhook arrives
    await vi.advanceTimersByTimeAsync(100);
    expect(engineeringUpdates.at(-1)).toMatchObject({ sequence: 2, value: { version: 2 } });

    version = 3;
    await expect(engineering.wake({ deliveryId: "later-delivery" })).resolves.toBe(1);
    await expect(engineering.wake({ deliveryId: "later-delivery" })).resolves.toBe(0); // duplicate
    await expect(engineering.wake({ deliveryId: "earlier-delivery" })).resolves.toBe(1); // reordered
    expect(engineeringUpdates.map((update) => update.sequence)).toEqual([1, 2, 3]);
    expect(releaseUpdates).toEqual([]);
    expect(calls).toBe(4);
    gateway.close();
  });
});

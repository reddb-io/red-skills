import { RequestError } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { bindAcpProjectGithubRead } from "../src/acp-github.js";
import { RedskilledGithubCredentialProfileError } from "../src/github-credential-profiles.js";
import { createRedskilledGithubGateway, createRedskilledGithubUpstream } from "../src/github-gateway.js";

const PROJECT = {
  projectId: "github:101",
  projectLabel: "acme/widgets",
  checkoutRoot: "/client/widgets",
  workspacePath: "/daemon/widgets",
};

describe("ACP GitHub credential refusals", () => {
  it("carries a missing profile as typed secret-free ACP error data", async () => {
    const read = bindAcpProjectGithubRead({
      gateway: createRedskilledGithubGateway({
        upstream: async () => ({ value: {}, budget: null }),
      }),
      credentialForProject: async () => {
        throw new RedskilledGithubCredentialProfileError("missing-credentials", "engineering");
      },
    }, () => PROJECT);

    const error = await read({ params: { read: { kind: "rest", path: "issues/1" } } })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).data).toEqual({
      version: 1,
      kind: "github-credential-profile",
      reason: "missing-credentials",
      credential_profile: "engineering",
    });
    expect(JSON.stringify((error as RequestError).data)).not.toMatch(/token|secret|private.key/i);
  });

  it("turns an upstream scope mismatch into the same typed refusal without fallback", async () => {
    let upstreamCalls = 0;
    const read = bindAcpProjectGithubRead({
      gateway: createRedskilledGithubGateway({
        upstream: createRedskilledGithubUpstream({
          fetchImpl: async () => {
            upstreamCalls += 1;
            return new Response("forbidden", { status: 403 });
          },
        }),
      }),
      credentialForProject: async () => ({
        profile: "engineering",
        credential: { secret: "installation-secret" },
      }),
    }, () => PROJECT);

    const error = await read({ params: { read: { kind: "rest", path: "issues/1" } } })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).data).toEqual({
      version: 1,
      kind: "github-credential-profile",
      reason: "scope-incompatible",
      credential_profile: "engineering",
    });
    expect(upstreamCalls).toBe(1);
    expect(JSON.stringify(error)).not.toContain("installation-secret");
  });
});

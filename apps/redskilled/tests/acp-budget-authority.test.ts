import { RequestError } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import {
  bindAcpHostGithubBudget,
  bindAcpProjectGithubBudget,
} from "../src/acp-budget.js";
import { createRedskilledGithubGateway } from "../src/github-gateway.js";

const project = {
  projectId: "github:101",
  projectLabel: "acme/widgets",
  checkoutRoot: "/client-checkouts/widgets",
  workspacePath: "/project-workspaces/widgets",
};

describe("ACP credential-budget authority", () => {
  it("binds Project reads to the daemon-selected profile and ignores unrelated profiles", async () => {
    const budgets = createRedskilledGithubGateway({
      configuredProfiles: ["engineering", "release"],
      upstream: async () => ({ value: {}, budget: null }),
    });
    const registration = {
      gateway: budgets,
      credentialForProject: () => ({ profile: "engineering", credential: { secret: "private-token" } }),
    };
    const answer = await bindAcpProjectGithubBudget(registration, () => project)({ params: {} });

    expect(answer.scope).toBe("project");
    expect(answer.credential_profile).toBe("engineering");
    expect(JSON.stringify(answer)).not.toContain("release");
    expect(JSON.stringify(answer)).not.toContain("private-token");
  });

  it("refuses host projection without explicit administrative authority", async () => {
    const budgets = createRedskilledGithubGateway({
      configuredProfiles: ["engineering", "release"],
      upstream: async () => ({ value: {}, budget: null }),
    });
    const projectHandler = bindAcpHostGithubBudget({
      gateway: budgets,
      credentialForProject: () => null,
    }, false);
    const error = await projectHandler({ params: {} }).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(RequestError);

    const administrative = await bindAcpHostGithubBudget({
      gateway: budgets,
      credentialForProject: () => null,
    }, true)({ params: {} });
    expect(administrative.scope).toBe("host-administration");
    expect(administrative.profiles.map((entry) => entry.credential_profile)).toEqual(["engineering", "release"]);
  });
});

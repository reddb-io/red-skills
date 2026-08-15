import { describe, expect, it } from "vitest";

import {
  REDSKILLED_GITHUB_UPDATE_METHOD,
  bindAcpProjectGithubUpdates,
} from "../src/acp-github.js";
import {
  createRedskilledGithubGateway,
  type RedskilledGithubUpdate,
} from "../src/github-gateway.js";

describe("ACP GitHub refresh updates", () => {
  it("fans out scoped gateway state in sequence without exposing credential material", async () => {
    let value = 1;
    const gateway = createRedskilledGithubGateway({
      upstream: async () => ({ value: { value }, budget: null }),
    });
    const notices: Array<{ method: string; update: RedskilledGithubUpdate }> = [];
    const observer = await bindAcpProjectGithubUpdates({
      gateway,
      credentialForProject: () => ({ profile: "engineering", credential: { secret: "daemon-secret" } }),
    }, {
      projectId: "github:101",
      projectLabel: "acme/widgets",
      checkoutRoot: "/client-checkouts/widgets",
      workspacePath: "/project-workspaces/widgets",
    }, async (method, update) => {
      notices.push({ method, update });
    });

    const reader = gateway.forProject({
      projectId: "github:101",
      projectLabel: "acme/widgets",
      workspacePath: "/project-workspaces/widgets",
      credentialProfile: "engineering",
    }, { secret: "daemon-secret" });
    await reader.read({ kind: "rest", path: "issues/17" });
    value = 2;
    await reader.refresh();
    await observer.settled();

    expect(notices).toMatchObject([
      { method: REDSKILLED_GITHUB_UPDATE_METHOD, update: { sequence: 1, value: { value: 1 } } },
      { method: REDSKILLED_GITHUB_UPDATE_METHOD, update: { sequence: 2, value: { value: 2 } } },
    ]);
    expect(JSON.stringify(notices)).not.toContain("daemon-secret");
    observer.close();
    gateway.close();
  });
});

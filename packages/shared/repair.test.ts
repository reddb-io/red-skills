import { describe, expect, it } from "vitest";
import {
  composeRepair,
  externalApprovalRepair,
  noRepair,
  registrationRepair,
} from "./repair.js";

describe("castle repair composer", () => {
  it("composes the human sentence and callable registration repair from one source", () => {
    const composed = composeRepair({
      state: "project unknown — acme/widgets was never registered on this host",
      repair: registrationRepair(),
    });

    expect(composed).toEqual({
      prose:
        "project unknown — acme/widgets was never registered on this host; repair: call `project_start` with " +
        "`{\"runner\":\"claude\",\"target\":1}` because register this project with the host so its queue can drain",
      repair: {
        tool: "project_start",
        args: { runner: "claude", target: 1 },
        why: "register this project with the host so its queue can drain",
      },
    });
  });

  it("carries the complete external-approval cure and never invents triage:summon", () => {
    const composed = composeRepair({
      state: "untrusted author",
      repair: externalApprovalRepair(),
    });

    expect(composed.repair).toEqual({
      tool: "github_issue",
      args: {
        add_label: "origin:external",
        comment: "/approve-external",
        comment_author: "maintainer",
      },
      why: "mark the issue as external and record explicit approval from a maintainer with write access",
    });
    expect(composed.prose).toContain("origin:external");
    expect(composed.prose).toContain("/approve-external");
    expect(composed.prose).not.toContain("triage:summon");
  });

  it("argues an explicit none when no callable cure is safe", () => {
    expect(
      composeRepair({
        state: "registration state is unknown",
        repair: noRepair("the daemon must answer before registration can be changed safely"),
      }),
    ).toEqual({
      prose:
        "registration state is unknown; repair: none because the daemon must answer before registration can be changed safely",
      repair: "none",
      repair_reason: "the daemon must answer before registration can be changed safely",
    });
  });
});

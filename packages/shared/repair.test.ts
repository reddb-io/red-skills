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
      repair: externalApprovalRepair(2062),
    });

    expect(composed.repair).toEqual({
      tool: "gh",
      args: {
        commands: [
          ["issue", "edit", "2062", "--add-label", "origin:external"],
          ["issue", "comment", "2062", "--body", "/approve-external"],
        ],
        required_actor: "maintainer",
      },
      why: "mark the issue as external and record explicit approval from a maintainer with write access",
    });
    expect(composed.prose).toContain("origin:external");
    expect(composed.prose).toContain("/approve-external");
    expect(composed.prose).not.toContain("triage:summon");
  });

  it("normalizes and freezes args before rendering or returning them", () => {
    const args = { issue: 2062, labels: ["origin:external"] };
    const composed = composeRepair({
      state: "held",
      repair: { tool: "gh", args, why: "approve external work" },
    });

    args.issue = 9999;
    args.labels.push("triage:summon");

    expect(composed).toEqual({
      prose:
        "held; repair: call `gh` with `{" +
        "\"issue\":2062,\"labels\":[\"origin:external\"]}` because approve external work",
      repair: {
        tool: "gh",
        args: { issue: 2062, labels: ["origin:external"] },
        why: "approve external work",
      },
    });
    expect(Object.isFrozen(composed.repair)).toBe(true);
    expect(composed.repair === "none" || Object.isFrozen(composed.repair.args)).toBe(true);
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

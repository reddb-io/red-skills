import { describe, expect, it } from "vitest";

import {
  buildContainerRegistration,
  buildRegistrationPollPlan,
  buildRegistrationQuery,
  CONTAINER_WORKER_PROMPT,
} from "../src/registration.mjs";

const base = {
  repo: "reddb-io/red-skills",
  workspacePath: "/home/afk/work/clone",
  argv: ["red-skills-redskilled", "acp-worker", "--child-agent", "claude"],
  target: 2,
};

describe("the registration a container drain carries", () => {
  it("states a tracker query the daemon can hand over verbatim", () => {
    expect(buildRegistrationQuery(base))
      .toBe('repo:reddb-io/red-skills is:issue is:open label:"ready-for-agent"');
  });

  it("narrows by lane and by an extra label in both the query and the poll plan", () => {
    const input = { ...base, lane: "go", label: "type:ticket" };

    expect(buildRegistrationQuery(input)).toBe(
      'repo:reddb-io/red-skills is:issue is:open label:"ready-for-agent" label:"lane:go" label:"type:ticket"',
    );
    expect(buildRegistrationPollPlan(input).labels).toEqual(["ready-for-agent", "lane:go", "type:ticket"]);
  });

  it("carries both counter labels so the daemon can count without reading", () => {
    expect(buildRegistrationPollPlan(base)).toEqual({
      owner: "reddb-io",
      repo: "red-skills",
      labels: ["ready-for-agent"],
      counter_labels: { ready: "ready-for-agent", human: "ready-for-human" },
    });
  });

  it("refuses a repository it cannot turn into a query", () => {
    expect(() => buildRegistrationQuery({ repo: "red-skills" })).toThrow(/owner\/name/);
  });

  it("carries the work, the launch, the trunk and the prompt", () => {
    const registration = buildContainerRegistration({ ...base, trunkBranch: "develop" });

    expect(registration.argv).toEqual(base.argv);
    expect(registration.workspace_path).toBe("/home/afk/work/clone");
    expect(registration.trunk).toEqual({ remote: "origin", branch: "develop" });
    expect(registration.prompt).toBe(CONTAINER_WORKER_PROMPT);
    expect(registration.target).toBe(2);
    expect(registration.validation_commands).toBeUndefined();
  });

  it("defaults the trunk to main and the target to one", () => {
    const registration = buildContainerRegistration({ ...base, target: undefined });

    expect(registration.trunk.branch).toBe("main");
    expect(registration.target).toBe(1);
  });

  it("passes a declared gate through as opaque commands", () => {
    expect(buildContainerRegistration({ ...base, validationCommands: ["pnpm typecheck"] }).validation_commands)
      .toEqual(["pnpm typecheck"]);
  });
});

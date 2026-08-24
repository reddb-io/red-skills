// The socket ops flush the registration intent store before answering; the ACP
// drain path answered first and persisted fire-and-forget with a swallowed
// catch. A daemon that died between the answer and the write forgot the
// registration — and the operator had been told the drain was on. These tests
// pin the ACP path to the socket ops' durability contract: the daemon-side
// register/release hooks may be async, and the drain answer waits for them.
import { describe, expect, it } from "vitest";

import { bindProjectControl, type ProjectControlState } from "../src/project-control.js";

const project = {
  projectId: "github:1",
  projectLabel: "reddb-io/red-skills",
  workspacePath: "/tmp/workspace",
} as never;

const hostState = () => ({ workers: [], registrations: [] }) as never;

describe("an ACP registration is durable before the drain answers", () => {
  it("the drain answer resolves only after the async register hook resolved", async () => {
    const order: string[] = [];
    const { mutateProjectControl } = bindProjectControl({
      scopedProject: () => project,
      projectControls: new Map<string, ProjectControlState>(),
      persistProjectControls: async () => {},
      hostState,
      clock: () => "2026-08-24T20:00:00.000Z",
      readGithubCustody: async () => null,
      registerProject: async (request) => {
        expect(request.project_label).toBe("reddb-io/red-skills");
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("registered-and-flushed");
      },
    });

    const answer = mutateProjectControl("drain", { registration: { selector: "is:issue" } })
      .then((value) => {
        order.push("drain-answered");
        return value;
      });

    await answer;
    expect(order).toEqual(["registered-and-flushed", "drain-answered"]);
  });

  it("a stop waits for the async release hook the same way", async () => {
    const order: string[] = [];
    const { mutateProjectControl } = bindProjectControl({
      scopedProject: () => project,
      projectControls: new Map<string, ProjectControlState>(),
      persistProjectControls: async () => {},
      hostState,
      clock: () => "2026-08-24T20:00:00.000Z",
      readGithubCustody: async () => null,
      releaseProject: async (label) => {
        expect(label).toBe("reddb-io/red-skills");
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("released-and-flushed");
      },
    });

    await mutateProjectControl("stop", {}).then(() => order.push("stop-answered"));
    expect(order).toEqual(["released-and-flushed", "stop-answered"]);
  });

  it("an async register hook that rejects still fails the drain loudly", async () => {
    const { mutateProjectControl } = bindProjectControl({
      scopedProject: () => project,
      projectControls: new Map<string, ProjectControlState>(),
      persistProjectControls: async () => {},
      hostState,
      clock: () => "2026-08-24T20:00:00.000Z",
      readGithubCustody: async () => null,
      registerProject: async () => {
        throw new Error("the intent store is unwritable");
      },
    });

    await expect(mutateProjectControl("drain", { registration: { selector: "is:issue" } }))
      .rejects.toThrow(/the intent store is unwritable/);
  });
});

import { describe, expect, it } from "vitest";

import {
  bindProjectControl,
  projectIsRegistered,
  projectStatusSnapshot,
  UNREGISTERED_DRAIN_WARNING,
  type ProjectControlState,
} from "../src/project-control.js";

/**
 * A drain that cannot drain has to say so.
 *
 * Drain intent lives on the control record; the demand loop births only for a
 * REGISTRATION, which names the work query and the argv a Worker is launched
 * with. A project draining without one polls nothing and births nothing — and
 * said so as "the daemon has not observed this Project queue", which reads like
 * a freshness lag that clears on its own. It never clears.
 */
const project = {
  projectId: "github:1",
  projectLabel: "reddb-io/red-skills",
  workspacePath: "/tmp/workspace",
} as never;

const hostState = (registered: boolean) => ({
  workers: [],
  registrations: registered ? [{ project_label: "reddb-io/red-skills", target: 2 }] : [],
} as never);

describe("an unregistered drain is a dead end that announces itself", () => {
  it("warns on the drain answer itself, not only to whoever reads status later", async () => {
    const controls = new Map<string, ProjectControlState>();
    const { mutateProjectControl } = bindProjectControl({
      scopedProject: () => project,
      projectControls: controls,
      persistProjectControls: async () => {},
      hostState: () => hostState(false),
      clock: () => "2026-08-19T20:00:00.000Z",
      readGithubCustody: async () => null,
    });

    const answer = await mutateProjectControl("drain", { target: 2 });

    expect(answer).toMatchObject({ drain_intent: "draining", warning: UNREGISTERED_DRAIN_WARNING });
  });

  it("says nothing of the sort once a registration is held", async () => {
    const controls = new Map<string, ProjectControlState>();
    const { mutateProjectControl } = bindProjectControl({
      scopedProject: () => project,
      projectControls: controls,
      persistProjectControls: async () => {},
      hostState: () => hostState(true),
      clock: () => "2026-08-19T20:00:00.000Z",
      readGithubCustody: async () => null,
    });

    expect(await mutateProjectControl("drain", {})).not.toHaveProperty("warning");
  });

  it("reports the dead end in status instead of a freshness lag that never clears", () => {
    const controls = new Map<string, ProjectControlState>([
      ["github:1", { drainIntent: "draining", revision: 1, updates: [] }],
    ]);

    const status = projectStatusSnapshot(project, controls, hostState(false), "2026-08-19T20:00:00.000Z");

    expect(status.context.queue.registered).toBe(false);
    expect(status.context.queue.detail).toBe(UNREGISTERED_DRAIN_WARNING);
  });

  it("keeps the old wording for a project that is simply not draining", () => {
    const status = projectStatusSnapshot(project, new Map(), hostState(false), "2026-08-19T20:00:00.000Z");

    expect(status.context.queue.detail).toBe("the daemon has not observed this Project queue");
    expect(status.context.queue.registered).toBe(false);
  });

  it("answers the registration question off the host's own record", () => {
    expect(projectIsRegistered(hostState(true), project)).toBe(true);
    expect(projectIsRegistered(hostState(false), project)).toBe(false);
  });
});

describe("a drain registers the project it drains", () => {
  const bind = (registered: boolean, registerProject?: (request: Readonly<Record<string, unknown>>) => unknown) =>
    bindProjectControl({
      scopedProject: () => project,
      projectControls: new Map<string, ProjectControlState>(),
      persistProjectControls: async () => {},
      hostState: () => hostState(registered),
      clock: () => "2026-08-19T20:00:00.000Z",
      readGithubCustody: async () => null,
      ...(registerProject == null ? {} : { registerProject }),
    });

  it("registers the work the caller carried, under the project it is bound to", async () => {
    const registered: Array<Readonly<Record<string, unknown>>> = [];

    await bind(true, (request) => registered.push(request)).mutateProjectControl("drain", {
      target: 2,
      registration: { selector: "is:issue label:ready-for-agent", argv: ["redskilled", "acp-worker"], target: 2 },
    });

    expect(registered).toEqual([
      expect.objectContaining({
        // The authority key, not the display label: Workers are labelled by
        // projectId, and a registration keyed any other way is one whose
        // planner never counts its own children.
        project_label: "github:1",
        selector: "is:issue label:ready-for-agent",
        target: 2,
      }),
    ]);
  });

  it("names the project itself, so a caller cannot register work under another one", async () => {
    const registered: Array<Readonly<Record<string, unknown>>> = [];

    await bind(true, (request) => registered.push(request)).mutateProjectControl("drain", {
      registration: { project_label: "someone/else", selector: "is:issue", argv: ["x"], target: 1 },
    });

    expect(registered[0]).toMatchObject({ project_label: "github:1" });
  });

  it("refuses when the endpoint was handed no registration path, rather than recording a drain nothing polls", async () => {
    await expect(bind(false).mutateProjectControl("drain", { registration: { selector: "is:issue" } }))
      .rejects.toThrow(/cannot register a project/);
  });

  it("leaves a drain that carries no work exactly as it was", async () => {
    const registered: unknown[] = [];

    const answer = await bind(false, (request) => registered.push(request)).mutateProjectControl("drain", {});

    expect(registered).toEqual([]);
    expect(answer).toMatchObject({ drain_intent: "draining", warning: UNREGISTERED_DRAIN_WARNING });
  });
});

describe("a drain says the same thing twice without failing", () => {
  it("keeps the record it already holds instead of refusing the second drain", async () => {
    const already = new Error("already holds a registration");
    already.name = "RedskilledProjectRegisteredError";
    let calls = 0;

    const { mutateProjectControl } = bindProjectControl({
      scopedProject: () => project,
      projectControls: new Map<string, ProjectControlState>(),
      persistProjectControls: async () => {},
      hostState: () => hostState(true),
      clock: () => "2026-08-19T20:00:00.000Z",
      readGithubCustody: async () => null,
      registerProject: () => {
        calls += 1;
        throw already;
      },
    });

    await expect(mutateProjectControl("drain", { registration: { selector: "is:issue" } })).resolves.toMatchObject({
      drain_intent: "draining",
    });
    expect(calls).toBe(1);
  });

  it("still surfaces a registration that failed for any other reason", async () => {
    const { mutateProjectControl } = bindProjectControl({
      scopedProject: () => project,
      projectControls: new Map<string, ProjectControlState>(),
      persistProjectControls: async () => {},
      hostState: () => hostState(false),
      clock: () => "2026-08-19T20:00:00.000Z",
      readGithubCustody: async () => null,
      registerProject: () => {
        throw new Error("the selector was empty");
      },
    });

    await expect(mutateProjectControl("drain", { registration: { selector: "" } }))
      .rejects.toThrow(/the selector was empty/);
  });
});

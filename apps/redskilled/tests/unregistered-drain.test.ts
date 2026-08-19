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

import { describe, expect, it } from "vitest";

import {
  applyProjectControl,
  coreProjectInvocation,
  projectControlRequest,
  type ProjectControlState,
} from "../src/project-control.js";

/**
 * A verb and its arguments arrive on ONE line, and both halves of the wire must
 * read the same line.
 *
 * The client renders every parameterised control call as `/<verb> {json}`. The
 * daemon's matcher demanded a bare verb, so `/drain {"target":2}` matched
 * nothing, fell through to "execute this prompt in a Worker", and answered with
 * narration and no payload — which reads exactly like a Worker that failed.
 */
const promptOf = (text: string) => [{ type: "text", text }];

const project = {
  projectId: "github:1",
  projectLabel: "reddb-io/red-skills",
  workspacePath: "/tmp/workspace",
} as never;

function detailOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    const data = (error as { data?: unknown }).data;
    return typeof data === "string" ? data : JSON.stringify(data ?? (error as Error).message);
  }
  return "";
}

describe("a control verb carries its arguments", () => {
  it("reads the verb the client actually sends, argument object included", () => {
    expect(coreProjectInvocation(promptOf('/drain {"target":2}'))).toEqual({ operation: "drain", target: 2 });
    expect(coreProjectInvocation(promptOf('/status {"scope":"project"}'))).toEqual({ operation: "status" });
    expect(coreProjectInvocation(promptOf('/project_drain {"runner":"redcode","target":5}'))).toEqual({
      operation: "drain",
      runner: "redcode",
      target: 5,
    });
  });

  it("still reads a bare verb, and still refuses a prompt that is not one", () => {
    expect(coreProjectInvocation(promptOf("drain"))?.operation).toBe("drain");
    expect(coreProjectInvocation(promptOf("/stop"))?.operation).toBe("stop");
    expect(coreProjectInvocation(promptOf("please drain the project"))).toBeUndefined();
    expect(coreProjectInvocation(promptOf("/gate_run"))).toBeUndefined();
  });

  it("keeps a malformed argument object from swallowing the verb", () => {
    expect(coreProjectInvocation(promptOf("/drain {not json"))).toEqual({ operation: "drain" });
  });

  it("carries the requested width into the stored control state and echoes it back", async () => {
    const controls = new Map<string, ProjectControlState>();
    const persisted: ProjectControlState[] = [];

    const answer = await applyProjectControl(
      project,
      "drain",
      controls,
      async (next) => void persisted.push(next.get("github:1")!),
      { target: 3, runner: "redcode" },
    );

    expect(answer.requested_target).toBe(3);
    expect(answer.requested_runner).toBe("redcode");
    expect(controls.get("github:1")?.target).toBe(3);
    expect(persisted.at(-1)?.runner).toBe("redcode");
  });

  it("treats a restated width as a new revision, not as already-draining", async () => {
    const controls = new Map<string, ProjectControlState>();
    const persist = async () => {};

    const first = await applyProjectControl(project, "drain", controls, persist, { target: 1 });
    const widened = await applyProjectControl(project, "drain", controls, persist, { target: 4 });
    const repeated = await applyProjectControl(project, "drain", controls, persist, { target: 4 });

    expect(first.revision).toBe(1);
    expect(widened.revision).toBe(2);
    expect(widened.requested_target).toBe(4);
    expect(repeated).toMatchObject({ status: "already-draining", revision: 2 });
  });

  it("refuses a width no caller could have meant, instead of carrying it", () => {
    expect(projectControlRequest({ target: 2, runner: "redcode" })).toEqual({ target: 2, runner: "redcode" });
    expect(projectControlRequest({})).toEqual({});
    // The refusal is an ACP invalid-params error: the reason travels in `data`,
    // where a client can read it, rather than in a generic message.
    expect(() => projectControlRequest({ target: -1 })).toThrow();
    expect(detailOf(() => projectControlRequest({ target: -1 }))).toMatch(/non-negative integer/);
    expect(detailOf(() => projectControlRequest({ target: 1.5 }))).toMatch(/non-negative integer/);
    expect(detailOf(() => projectControlRequest({ runner: "" }))).toMatch(/non-empty string/);
  });
});

import { describe, expect, it } from "vitest";
import { nativeWorkerSpec } from "../src/acp-worker-admission.js";
import type { AcpProjectWorkspace } from "../src/project-workspace.js";
import type { MaterializedWorkerWorkspace } from "../src/worker-workspace.js";

// The registration store, the demand loop's live count (daemon/lifecycle.ts),
// and queue discovery all key a project by the registration's project_label.
// Recording the admitted Worker under projectId split that identity: the
// demand loop read live=0 forever, birthed a Worker every tick, and the host
// ceiling filled with connected Workers no ticket route could find. This pins
// the one identity every consumer agrees on.
describe("native Worker project identity", () => {
  it("records the admitted Worker under the project label, never the project id", () => {
    const project: AcpProjectWorkspace = {
      projectId: "remote:reddb-io/red-skills",
      projectLabel: "reddb-io/red-skills",
      checkoutRoot: "/tmp/checkout",
      workspacePath: "/tmp/project-workspace",
    };
    const workspace: MaterializedWorkerWorkspace = {
      workerId: "VStest01",
      root: "/tmp/workers",
      workspacePath: "/tmp/workers/VStest01",
      worktreePath: "/tmp/workers/VStest01/worktree",
    } as MaterializedWorkerWorkspace;

    const spec = nativeWorkerSpec(project, workspace, "/tmp/sock/x.sock", "/tmp/runtime", "afk");

    expect(spec.project_label).toBe(project.projectLabel);
    expect(spec.project_label).not.toBe(project.projectId);
  });

  it("gives a redcode child its own database inside the Worker's workspace (redcode#58)", () => {
    const project: AcpProjectWorkspace = {
      projectId: "remote:reddb-io/red-skills",
      projectLabel: "reddb-io/red-skills",
      checkoutRoot: "/tmp/checkout",
      workspacePath: "/tmp/project-workspace",
    };
    const workspace: MaterializedWorkerWorkspace = {
      workerId: "VStest02",
      root: "/tmp/workers",
      workspacePath: "/tmp/workers/VStest02",
      worktreePath: "/tmp/workers/VStest02/worktree",
    } as MaterializedWorkerWorkspace;

    const spec = nativeWorkerSpec(project, workspace, "/tmp/sock/x.sock", "/tmp/runtime", "afk");

    // Concurrent redcode instances sharing one opencode.db die on "database is
    // locked" mid-turn; the DB lives beside (not inside) the worktree, so it
    // never dirties the git tree and dies with the disposable workspace.
    expect(spec.env?.OPENCODE_DB).toBe("/tmp/workers/VStest02/redcode.db");
  });
});

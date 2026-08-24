import { describe, expect, it, vi } from "vitest";
import { REDSKILLS_ACP_METHODS } from "@reddb-io/protocol-acp";

import {
  mobileOperatorMethodDomain,
  projectOperatorState,
} from "../src/acp-mobile-operator.js";

function hostState() {
  return {
    daemon_version: "4.2.0",
    workers: [{
      worker_id: "W1",
      project_label: "reddb-io/red-skills",
      started_at: "2026-08-23T12:00:00.000Z",
      pid: 1,
      workspace_path: "/secret/worktree",
      isolated: true,
      warnings: [],
    }],
  } as never;
}

describe("the Mobile operator ACP domain", () => {
  it("publishes exactly the allowlisted state/dispatch/stop surface", () => {
    const domain = mobileOperatorMethodDomain({
      hostAdministration: true,
      hostState,
      dispatch: vi.fn(),
      stop: vi.fn(),
    });

    expect(domain.bindings.map((binding) => binding.method)).toEqual([
      REDSKILLS_ACP_METHODS.operatorState,
      REDSKILLS_ACP_METHODS.ticketDispatch,
      REDSKILLS_ACP_METHODS.workerStop,
    ]);
    expect(domain.capability).toEqual({
      mobileOperator: {
        version: 1,
        methods: [
          REDSKILLS_ACP_METHODS.operatorState,
          REDSKILLS_ACP_METHODS.ticketDispatch,
          REDSKILLS_ACP_METHODS.workerStop,
        ],
      },
    });
  });

  it("refuses every operation without explicit host administration", async () => {
    const domain = mobileOperatorMethodDomain({
      hostAdministration: false,
      hostState,
      dispatch: vi.fn(),
      stop: vi.fn(),
    });

    expect(domain.capability).toBeUndefined();
    for (const binding of domain.bindings) {
      const params = binding.method === REDSKILLS_ACP_METHODS.ticketDispatch
        ? { issue_url: "https://github.com/reddb-io/red-skills/issues/1" }
        : binding.method === REDSKILLS_ACP_METHODS.workerStop ? { worker_id: "W1" } : {};
      await expect(binding.handle({ params, client: undefined })).rejects.toThrow("Invalid request");
    }
  });

  it("projects no host path, pid, credential or policy into the app state", () => {
    expect(projectOperatorState(hostState())).toEqual({
      version: 1,
      daemon_version: "4.2.0",
      workers: [{
        worker_id: "W1",
        project_label: "reddb-io/red-skills",
        started_at: "2026-08-23T12:00:00.000Z",
      }],
    });
  });
});

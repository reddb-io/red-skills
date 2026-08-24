import { describe, expect, it, vi } from "vitest";
import { REDSKILLS_ACP_METHODS } from "@reddb-io/protocol-acp";

import {
  mobileOperatorMethodDomain,
  projectOperatorState,
} from "../src/acp-mobile-operator.js";

function hostState() {
  return {
    daemon_version: "4.2.0",
    started_at: "2026-08-23T08:00:00.000Z",
    ceiling: { worker_count: 4 },
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

function statusline() {
  return {
    generated_at: "2026-08-23T12:10:00.000Z",
    staleness: {
      stale: false,
      age_ms: 5_000,
      threshold_ms: 30_000,
      reason: "measured 5s ago",
    },
    workers: [{
      worker_id: "W1",
      log: {
        last_line: "coding: touched /secret/worktree/src/index.ts",
        published_at: "2026-08-23T12:09:30.000Z",
      },
      display: { phase: "coding", issue: "4321" },
    }],
    repository_activity: {
      projects: [{ project_label: "reddb-io/red-skills", repository: "reddb-io/red-skills" }],
    },
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
        version: 2,
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

  it("projects no host path, pid, credential, vitals or log line into the app state", () => {
    const answer = projectOperatorState(hostState(), { statusline: statusline() });

    expect(JSON.stringify(answer)).not.toContain("/secret/worktree");
    expect(JSON.stringify(answer)).not.toContain("pid");
    expect(answer).toEqual({
      version: 2,
      daemon_version: "4.2.0",
      workers: [{
        worker_id: "W1",
        project_label: "reddb-io/red-skills",
        started_at: "2026-08-23T12:00:00.000Z",
        phase: "coding",
        heartbeat_age_ms: 30_000,
        repository: "reddb-io/red-skills",
        ticket: "4321",
      }],
      host: {
        daemon_version: "4.2.0",
        started_at: "2026-08-23T08:00:00.000Z",
        worker_ceiling: 4,
        staleness: { stale: false, age_ms: 5_000, threshold_ms: 30_000, reason: "measured 5s ago" },
        generated_at: "2026-08-23T12:10:00.000Z",
      },
    });
  });

  it("a Worker the statusline read does not cover renders null extras, never a guess", () => {
    const answer = projectOperatorState(hostState(), {
      statusline: { ...(statusline() as object), workers: [], repository_activity: { projects: [] } } as never,
    });

    expect(answer.workers[0]).toEqual({
      worker_id: "W1",
      project_label: "reddb-io/red-skills",
      started_at: "2026-08-23T12:00:00.000Z",
      phase: null,
      heartbeat_age_ms: null,
      repository: null,
      ticket: null,
    });
  });

  it("without a statusline read beside it the host block says so instead of inventing a verdict", () => {
    const answer = projectOperatorState(hostState(), { now: "2026-08-23T12:11:00.000Z" });

    expect(answer.host.staleness).toBeNull();
    expect(answer.host.generated_at).toBe("2026-08-23T12:11:00.000Z");
    expect(answer.workers[0]?.phase).toBeNull();
  });
});

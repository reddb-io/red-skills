/**
 * The host daemon owns Worker attribution after the Project coordinator
 * contraction. This compatibility fixture now poses the same partition to the
 * daemon-owned status payload instead of rebuilding it in a Project adapter.
 */
import { describe, expect, it } from "vitest";
import type { RedskilledWorkerView } from "@reddb-io/redskilled/host-state";
import { buildStatuslinePayload } from "@reddb-io/redskilled/statusline-payload";

const UNBOUNDED_HOST_CEILING = {
  memory_bytes: null,
  worker_count: null,
  source: "declared" as const,
};

function worker(
  workerId: string,
  projectLabel: string,
  pid: number,
): RedskilledWorkerView {
  return {
    worker_id: workerId,
    project_label: projectLabel,
    pid,
    started_at: "2026-07-21T12:00:00.000Z",
    workspace_path: `/tmp/${workerId}`,
    isolated: false,
    warnings: [],
  };
}

function hostStateOf(workers: readonly RedskilledWorkerView[]) {
  return {
    version: 1 as const,
    protocol_version: 1,
    daemon_version: "0.0.0-test",
    machine_id_hash: "machine",
    session_key_hash: "session",
    pid: 999,
    started_at: "2026-07-21T11:00:00.000Z",
    workers,
    projects: [...new Set(workers.map((candidate) => candidate.project_label))]
      .sort()
      .map((project_label) => ({
        project_label,
        worker_count: workers.filter((candidate) => candidate.project_label === project_label).length,
      })),
    budget_accounting: {
      version: 1 as const,
      worker_count: workers.length,
      memory_high_bytes: 0,
      memory_max_bytes: 0,
      cpu_weight_total: 0,
      unaccounted_workers: [],
      unisolated_workers: workers.map((candidate) => candidate.worker_id),
    },
    upgrade: {
      running_version: "0.0.0-test",
      published_version: null,
      published_unknown: 1,
      newer_published: 0,
      replacement: "none" as const,
      checked_at: null,
      checks: 0,
      hold_reason: null,
      newest_published_version: null,
      major_held: 0,
      major_hold: null,
    },
  };
}

describe("daemon-owned Worker partition", () => {
  it("attributes every live Worker from the host's one state document", () => {
    const workers = [
      worker("w_mine", "acme/widgets", 1001),
      worker("w_foreign", "acme/gadgets", 2001),
    ];
    const payload = buildStatuslinePayload({
      hostState: hostStateOf(workers),
      ceiling: UNBOUNDED_HOST_CEILING,
      rss: {},
      sampledAt: null,
      now: "2026-07-21T12:00:00.000Z",
    });

    expect(payload.workers.map((candidate) => [
      candidate.worker_id,
      candidate.project_label,
    ])).toEqual([
      ["w_mine", "acme/widgets"],
      ["w_foreign", "acme/gadgets"],
    ]);
    expect(payload.projects).toEqual([
      {
        project_label: "acme/gadgets",
        worker_count: 1,
        declared_memory_bytes: 0,
        observed_rss_bytes: 0,
        measured_worker_count: 0,
      },
      {
        project_label: "acme/widgets",
        worker_count: 1,
        declared_memory_bytes: 0,
        observed_rss_bytes: 0,
        measured_worker_count: 0,
      },
    ]);
  });
});

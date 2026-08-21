import { describe, expect, it } from "vitest";
import {
  REDSKILLED_PUBLIC_HOST_EVENT_KINDS,
  buildHostEvent,
  toWorkerView,
  type RecordWorkerEventInput,
  type RedskilledPublicHostEventKind,
} from "../src/event-lane.js";
import type { RedskilledWorkerView } from "../src/host-state.js";

const PUBLIC_HOST_EVENT_FIELDS = [
  "admission_verdict",
  "base_commits_ahead",
  "base_head_sha",
  "confidence",
  "cpu_weight",
  "detail",
  "event",
  "exit_code",
  "fork_sha",
  "heal_kind",
  "isolated",
  "journal_tail",
  "kind",
  "log_path",
  "memory_high",
  "memory_max",
  "memory_peak_bytes",
  "memory_swap_peak_bytes",
  "model",
  "pgid",
  "phase",
  "pid",
  "pids_peak",
  "proc_start_time",
  "project_label",
  "reason",
  "runner",
  "sender_class",
  "signal",
  "step",
  "systemd_result",
  "tokens",
  "tools",
  "ts",
  "unit",
  "version",
  "worker_id",
  "workspace_path",
] as const;

const worker: RedskilledWorkerView = {
  worker_id: "wPUB1",
  project_label: "acme/widgets",
  pid: 4242,
  pgid: 4242,
  proc_start_time: "987654",
  started_at: "2026-08-08T12:00:00.000Z",
  workspace_path: "/tmp/worker",
  fork_sha: "aaaa1111",
  log_path: "/tmp/worker/worker.log.toonl",
  isolated: true,
  unit: "red-worker-wPUB1.service",
  budget: {
    memory_high: "4G",
    memory_max: "6G",
    cpu_weight: 100,
  },
  warnings: [],
};

const publicInputs = {
  "worker-birth": {
    kind: "worker-birth",
    worker,
    ts: "2026-08-08T12:00:00.000Z",
    admissionVerdict: "admitted",
  },
  "worker-death": {
    kind: "worker-death",
    worker,
    ts: "2026-08-08T12:01:00.000Z",
    detail: "exited cleanly",
    exitCode: 0,
  },
  "worker-budget-kill": {
    kind: "worker-budget-kill",
    worker,
    ts: "2026-08-08T12:02:00.000Z",
    detail: "memory ceiling exceeded",
    signal: "SIGKILL",
  },
} satisfies Record<RedskilledPublicHostEventKind, RecordWorkerEventInput>;

describe("public host-event contract", () => {
  it("declares only lifecycle notifications and freezes each emitted field set", () => {
    expect(REDSKILLED_PUBLIC_HOST_EVENT_KINDS).toEqual([
      "worker-birth",
      "worker-death",
      "worker-budget-kill",
    ]);

    for (const kind of REDSKILLED_PUBLIC_HOST_EVENT_KINDS) {
      const event = buildHostEvent(publicInputs[kind]);
      expect(
        Object.keys(event).sort(),
        `${kind} public host-event field set`,
      ).toEqual(PUBLIC_HOST_EVENT_FIELDS);
      expect(event).toMatchObject({ pgid: 4242, proc_start_time: "987654" });
    }
  });

  it("rehydrates a legacy event that has no process identity fields", () => {
    const event = buildHostEvent(publicInputs["worker-birth"]);
    const { pgid: _pgid, proc_start_time: _procStartTime, ...legacy } = event;

    expect(toWorkerView(legacy)).toMatchObject({
      worker_id: "wPUB1",
      pid: 4242,
    });
  });
});

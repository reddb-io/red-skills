import { describe, expect, it } from "vitest";
import {
  REDSKILLED_PUBLIC_HOST_EVENT_KINDS,
  buildHostEvent,
  type RecordWorkerEventInput,
  type RedskilledPublicHostEventKind,
} from "../src/event-lane.js";
import type { RedskilledWorkerView } from "../src/host-state.js";

const PUBLIC_HOST_EVENT_FIELDS = [
  "admission_verdict",
  "base_commits_ahead",
  "base_head_sha",
  "cpu_weight",
  "detail",
  "event",
  "exit_code",
  "fork_sha",
  "heal_kind",
  "isolated",
  "kind",
  "log_path",
  "memory_high",
  "memory_max",
  "model",
  "phase",
  "pid",
  "project_label",
  "reason",
  "runner",
  "signal",
  "step",
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
    }
  });
});

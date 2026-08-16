// Interactive capacity remains a host admission policy after the Demand
// producer's retirement. These fixtures pin that policy at its new owner.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTERACTIVE_RESERVATION,
  evaluateWorkerAdmission,
  resolveHostCeiling,
  type RedskilledHostCeiling,
} from "../src/admission.js";
import type { RedskilledWorkerView } from "../src/host-state.js";

function worker(workerId: string): RedskilledWorkerView {
  return {
    worker_id: workerId,
    project_label: "acme/widgets",
    pid: 1_000,
    started_at: "2026-08-16T20:00:00.000Z",
    workspace_path: `/tmp/${workerId}`,
    isolated: true,
    warnings: [],
  };
}

const CEILING: RedskilledHostCeiling = {
  memory_bytes: null,
  worker_count: 3,
  interactive_reservation: 1,
  source: "declared",
};

describe("host-owned interactive reservation", () => {
  it("declares one stable reserved slot by default", () => {
    const first = resolveHostCeiling({}, 16 * 1024 ** 3, { availableParallelism: 8 });
    const repeated = resolveHostCeiling({}, 16 * 1024 ** 3, { availableParallelism: 8 });

    expect(first.interactive_reservation).toBe(DEFAULT_INTERACTIVE_RESERVATION);
    expect(repeated.interactive_reservation).toBe(first.interactive_reservation);
  });

  it("withholds capacity from autonomous work while serving an interactive dispatch", () => {
    const saturated = [worker("afk-1"), worker("afk-2"), worker("afk-3")];
    const autonomous = evaluateWorkerAdmission({ ceiling: CEILING, workers: saturated });
    const interactive = evaluateWorkerAdmission({
      ceiling: CEILING,
      workers: saturated,
      reservation: "interactive",
    });

    expect(autonomous).toMatchObject({ admitted: false, verdict: "refused-over-worker-ceiling" });
    expect(autonomous.reason).toContain("reserved for interactive dispatches");
    expect(interactive).toMatchObject({ admitted: true, verdict: "admitted-interactive-reservation" });
    expect(interactive.reason).toContain("reserved interactive slot 1/1");
  });

  it("bounds the reservation and makes it available again after the interactive Worker lapses", () => {
    const saturated = [worker("afk-1"), worker("afk-2"), worker("afk-3")];
    const withInteractive = [...saturated, worker("go-1")];

    expect(evaluateWorkerAdmission({
      ceiling: CEILING,
      workers: withInteractive,
      reservation: "interactive",
    }).verdict).toBe("refused-over-interactive-reservation");

    // Once the daemon's live set no longer contains the abandoned Worker, the
    // same capacity claim succeeds without a private hold to release.
    expect(evaluateWorkerAdmission({
      ceiling: CEILING,
      workers: saturated,
      reservation: "interactive",
    }).verdict).toBe("admitted-interactive-reservation");
  });

  it("does not mutate or terminate a live Worker to make room", () => {
    const saturated = [worker("afk-1"), worker("afk-2"), worker("afk-3")];
    const before = structuredClone(saturated);

    evaluateWorkerAdmission({ ceiling: CEILING, workers: saturated, reservation: "interactive" });

    expect(saturated).toEqual(before);
    const admissionSource = readFileSync(new URL("../src/admission.ts", import.meta.url), "utf8")
      .replace(/\/\*\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(admissionSource).not.toMatch(/stopWorker|killWorker|terminateWorker|SIGTERM|SIGKILL|process\.kill/);
  });
});

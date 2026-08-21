import { describe, expect, it } from "vitest";

import { observedWorkerDeath } from "../src/daemon/tunables.js";
import { classifyUnitDeath, resolveUnitDeath } from "../src/daemon/unit-death.js";
import { buildHostEvent } from "../src/event-lane.js";
import { decodeHostEventRow } from "../src/event-lane-decode.js";
import type { RedskilledWorkerView } from "../src/host-state.js";
import type { RedskilledUnitExitFacts } from "../src/reattach.js";

const worker: RedskilledWorkerView = {
  worker_id: "wD34TH",
  project_label: "acme/widgets",
  pid: 4242,
  started_at: "2026-08-20T12:00:00.000Z",
  workspace_path: "/tmp/worker",
  isolated: true,
  unit: "red-worker-wD34TH.service",
  budget: { memory_high: "4G", memory_max: "6G", cpu_weight: 100 },
  warnings: [],
};

function receipt(overrides: Partial<RedskilledUnitExitFacts> = {}): RedskilledUnitExitFacts {
  return {
    systemd_result: null,
    exit_code: null,
    signal: null,
    memory_peak_bytes: null,
    memory_swap_peak_bytes: null,
    journal_tail: null,
    ...overrides,
  };
}

/** One death record, exactly as the lane writer builds it from an injected receipt. */
async function deathRecord(facts: RedskilledUnitExitFacts) {
  const death = await resolveUnitDeath(worker, () => facts, {
    detail: "the host no longer confirms this Worker",
    facts: {},
  });
  return buildHostEvent({ kind: "worker-death", worker, ts: "2026-08-20T12:30:00.000Z", ...death.facts, detail: death.detail });
}

describe("the daemon reads the unit receipt as facts, not as prose", () => {
  it("turns a cgroup OOM into a classified record carrying the peak that named the bump", async () => {
    const record = await deathRecord(receipt({
      systemd_result: "oom-kill",
      signal: "SIGKILL",
      memory_peak_bytes: 3_221_225_472,
      memory_swap_peak_bytes: 1_073_741_824,
      journal_tail: "Main process exited, code=killed, status=9/KILL",
    }));

    expect(record).toMatchObject({
      worker_id: "wD34TH",
      sender_class: "oomd",
      confidence: "high",
      exit_code: null,
      signal: "SIGKILL",
      memory_peak_bytes: 3_221_225_472,
    });
  });

  it("reads a plain SIGTERM as a requested stop and a stop timeout as the manager's teardown", async () => {
    const requested = await deathRecord(receipt({ systemd_result: "success", signal: "SIGTERM" }));
    expect(requested).toMatchObject({ sender_class: "user-signal", confidence: "high", signal: "SIGTERM" });

    const managed = await deathRecord(receipt({ systemd_result: "timeout", signal: "SIGTERM" }));
    expect(managed).toMatchObject({ sender_class: "teardown", confidence: "high", signal: "SIGTERM" });
  });

  it("refuses to name a sender for a SIGKILL systemd did not attribute", async () => {
    const record = await deathRecord(receipt({ systemd_result: "signal", signal: "SIGKILL" }));

    // The case ADR 0155 exists for wears this shape on a host with no oomd
    // integration, so `user-signal` here would blame a person for the kernel.
    expect(record).toMatchObject({ sender_class: "unknown", confidence: "low" });
  });

  it("names no sender at all for a Worker that reached an exit code under its own power", async () => {
    const record = await deathRecord(receipt({ systemd_result: "exit-code", exit_code: 70 }));

    expect(record).toMatchObject({ sender_class: "unknown", confidence: "none", exit_code: 70 });
  });

  it("classifies the fallback path too, so a record's reader never asks which path wrote it", async () => {
    const unisolated: RedskilledWorkerView = { ...worker, unit: undefined };
    const death = await resolveUnitDeath(unisolated, () => receipt(), {
      detail: "exit code=null signal=SIGTERM",
      facts: { exitCode: null, signal: "SIGTERM" },
    });

    expect(death.facts).toMatchObject({ senderClass: "user-signal", confidence: "high" });
  });

  it("says unknown out loud when nothing was gathered", () => {
    expect(classifyUnitDeath({})).toEqual({ senderClass: "unknown", confidence: "none" });
  });

  it("keys the evidence by worker id alone — the join is the checkout's", async () => {
    const record = await deathRecord(receipt({ systemd_result: "oom-kill", signal: "SIGKILL" }));

    expect(record.worker_id).toBe("wD34TH");
    expect(Object.keys(record)).not.toContain("issue");
  });
});

describe("the classified death survives the lane", () => {
  it("round-trips through the TOONL row decoder", async () => {
    const record = await deathRecord(receipt({
      systemd_result: "oom-kill",
      signal: "SIGKILL",
      memory_peak_bytes: 3_221_225_472,
    }));

    const decoded = decodeHostEventRow({ ...record } as Record<string, string | number | boolean | null>);

    expect(decoded).toMatchObject({ sender_class: "oomd", confidence: "high", memory_peak_bytes: 3_221_225_472 });
  });

  it("reads a row written before the classification existed as unclassified, never as confident", () => {
    const decoded = decodeHostEventRow({
      version: 1,
      ts: "2026-07-01T00:00:00.000Z",
      kind: "worker-death",
      worker_id: "wOLD01",
      pid: 11,
      exit_code: 1,
    });

    expect(decoded).toMatchObject({ sender_class: null, confidence: null });
  });

  it("refuses a word this vocabulary does not contain rather than passing it on", () => {
    const decoded = decodeHostEventRow({
      version: 1,
      ts: "2026-07-01T00:00:00.000Z",
      kind: "worker-death",
      worker_id: "wOLD02",
      pid: 12,
      sender_class: "gremlins",
      confidence: "certain",
    });

    expect(decoded).toMatchObject({ sender_class: null, confidence: null });
  });
});

describe("the surfaces read the carried verdict rather than deriving a second one", () => {
  it("shows the classification the receipt produced", async () => {
    const record = await deathRecord(receipt({
      systemd_result: "oom-kill",
      signal: "SIGKILL",
      memory_peak_bytes: 3_221_225_472,
    }));

    expect(observedWorkerDeath(record)).toMatchObject({
      id: "wD34TH",
      sender_class: "oomd",
      confidence: "high",
      signal: "SIGKILL",
    });
  });

  it("keeps the daemon's own act and a boot refusal local, because only this surface knows them", async () => {
    const record = await deathRecord(receipt({ systemd_result: "success", signal: "SIGTERM" }));

    const killed = observedWorkerDeath({ ...record, kind: "worker-budget-kill", event: "worker-budget-kill" });
    expect(killed).toMatchObject({ sender_class: "teardown", confidence: "high" });

    const refused = observedWorkerDeath(record, { refusal: "trunk freshness: dirt-collision" });
    expect(refused).toMatchObject({ sender_class: "boot-refused", last_phase: "boot-refused" });
  });

  it("falls back to its own reading for a lane row that carries no classification", async () => {
    const record = await deathRecord(receipt({ systemd_result: "signal", signal: "SIGSEGV" }));

    expect(observedWorkerDeath({ ...record, sender_class: null, confidence: null })).toMatchObject({
      sender_class: "user-signal",
      confidence: "high",
    });
  });

  it("says nothing at all about a Worker that exited cleanly", async () => {
    const record = await deathRecord(receipt({ systemd_result: "success", exit_code: 0 }));

    expect(observedWorkerDeath(record)).toBeNull();
  });
});

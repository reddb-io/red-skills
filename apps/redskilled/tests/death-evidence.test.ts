import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LANE_RETENTION_REGISTRY } from "@reddb-io/shared/lane-retention.js";
import { describe, expect, it } from "vitest";

import { observedWorkerDeath } from "../src/daemon/tunables.js";
import { classifyUnitDeath, resolveUnitDeath } from "../src/daemon/unit-death.js";
import {
  appendSyntheticPostmortem,
  classifySilentDeath,
  deathWasSilent,
  planSyntheticPostmortem,
  renderLastEvidence,
  SILENT_DEATH_FAILURE_MODES,
} from "../src/daemon/synthetic-postmortem.js";
import {
  buildHostEvent,
  createRedskilledEventLane,
  REDSKILLED_EVENT_LANE_FILE,
  type RecordWorkerEventInput,
} from "../src/event-lane.js";
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

// #4176: a death that explains nothing leaves a synthetic postmortem beside it.
// The rows the checkout can ACT on already carry their own account; what is left
// is exactly the set the sweep defers, and that set's failure story would
// otherwise live only in whoever happened to be watching.

const silentWorker: RedskilledWorkerView = {
  ...worker,
  log_path: "/tmp/worker/worker.log.toonl",
  memory_ceiling: "6G",
  cpu: { cpu_seconds: 812.35, sampled_at: "2026-08-20T12:29:00.000Z" },
  warnings: ["placement downgraded to unisolated"],
};

function death(facts: Partial<RecordWorkerEventInput> = {}): RecordWorkerEventInput {
  return {
    kind: "worker-death",
    worker: silentWorker,
    ts: "2026-08-20T12:30:00.000Z",
    detail: "the host no longer confirms this Worker",
    ...facts,
  };
}

describe("a silent death leaves the account the Worker never wrote", () => {
  it("names the failure mode and the last evidence on a Worker the host stopped confirming", () => {
    const postmortem = planSyntheticPostmortem(death());

    expect(postmortem).not.toBeNull();
    expect(postmortem!.kind).toBe("worker-postmortem");
    expect(postmortem!.failureMode).toBe("host-vanished");
    expect(postmortem!.detail).toContain("failure-mode=host-vanished");
    expect(postmortem!.detail).toContain("born=2026-08-20T12:00:00.000Z");
    expect(postmortem!.detail).toContain("cpu=812.4s at 2026-08-20T12:29:00.000Z");
    expect(postmortem!.detail).toContain("ceiling=6G");
    expect(postmortem!.detail).toContain("placement downgraded to unisolated");
    expect(postmortem!.detail).toContain("log=/tmp/worker/worker.log.toonl");
  });

  it("reads an unattributed SIGKILL as a kill nobody signed, and quotes the journal", () => {
    const postmortem = planSyntheticPostmortem(death({
      signal: "SIGKILL",
      senderClass: "unknown",
      confidence: "low",
      journalTail: "Started red-worker-wD34TH.service.\nMain process exited, code=killed, status=9/KILL",
    }));

    expect(postmortem!.failureMode).toBe("unattributed-kill");
    expect(postmortem!.detail).toContain("signal=SIGKILL");
    expect(postmortem!.detail).toContain("journal: Main process exited, code=killed, status=9/KILL");
    // Every fact the death record carried rides the postmortem too, so a reader
    // never has to join the two rows back together.
    expect(postmortem!.senderClass).toBe("unknown");
  });

  it("stays silent for a death that already explains itself", () => {
    expect(planSyntheticPostmortem(death({ exitCode: 0 }))).toBeNull();
    expect(
      planSyntheticPostmortem(death({ signal: "SIGTERM", senderClass: "user-signal", confidence: "high" })),
    ).toBeNull();
    expect(planSyntheticPostmortem({ ...death(), kind: "worker-birth" })).toBeNull();
  });

  it("classifies the modes a host can name, and admits when it cannot", () => {
    expect(classifySilentDeath({ systemdResult: "oom-kill" })).toBe("oom");
    expect(classifySilentDeath({ senderClass: "oomd" })).toBe("oom");
    expect(classifySilentDeath({ systemdResult: "timeout" })).toBe("cap-hit");
    expect(classifySilentDeath({ systemdResult: "watchdog" })).toBe("cap-hit");
    expect(classifySilentDeath({ signal: "SIGKILL" })).toBe("unattributed-kill");
    expect(classifySilentDeath({})).toBe("host-vanished");
    expect(classifySilentDeath({ systemdResult: "exit-code", exitCode: 3 })).toBe("unknown");
    expect(deathWasSilent({ exitCode: 0 })).toBe(false);
    expect(deathWasSilent({ senderClass: "oomd", confidence: "high" })).toBe(false);
    expect(deathWasSilent({})).toBe(true);
    for (const mode of SILENT_DEATH_FAILURE_MODES) expect(typeof mode).toBe("string");
    expect(renderLastEvidence(worker, {})).toContain("log=unrecorded");
    const appended: RecordWorkerEventInput[] = [];
    appendSyntheticPostmortem((row) => appended.push(row), death());
    appendSyntheticPostmortem((row) => appended.push(row), death({ exitCode: 0 }));
    expect(appended.map((row) => row.kind)).toEqual(["worker-postmortem"]);
  });

  it("rides the daemon's own registered lane, structured field and all", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-postmortem-"));
    const path = join(root, REDSKILLED_EVENT_LANE_FILE);
    try {
      const lane = createRedskilledEventLane(path);
      await lane.recordWorker(death());
      await lane.recordWorker(planSyntheticPostmortem(death())!);
      const rows = await createRedskilledEventLane(path).read();

      expect(rows.map((row) => row.kind)).toEqual(["worker-death", "worker-postmortem"]);
      expect(rows[1]).toMatchObject({ worker_id: "wD34TH", failure_mode: "host-vanished" });
      expect(rows[1]!.detail).toContain("failure-mode=host-vanished");
      expect(LANE_RETENTION_REGISTRY["redskilled-events"].maxBytes).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the decoded field honest for a row written before the mode existed", () => {
    const legacy = decodeHostEventRow({ ts: "2026-08-20T12:30:00.000Z", kind: "worker-death", worker_id: "wD34TH" });

    expect(legacy.failure_mode).toBeNull();
  });
});

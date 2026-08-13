import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decode } from "@reddb-io/toon";
import { runResourceIncidents } from "../src/cli.js";
import {
  ResourceIncidentTracker,
  createResourceIncidentStore,
  readCgroupResourceSample,
  type RedskilledResourceSample,
} from "../src/resource-incidents.js";

function write(dir: string, name: string, value: string): void {
  writeFileSync(join(dir, name), value, "utf8");
}

function sample(
  at: string,
  memoryCurrent: number,
  over: Partial<RedskilledResourceSample> = {},
): RedskilledResourceSample {
  return {
    schema: "red.redskilled.resource_sample.v1",
    sampled_at: at,
    target: { kind: "worker", id: "w-1", project_label: "project" },
    source: "cgroup-v2",
    memory: { current_bytes: memoryCurrent, peak_bytes: memoryCurrent, max_bytes: 1_000 },
    cpu: { usage_usec: 0, user_usec: 0, system_usec: 0, nr_periods: 0, nr_throttled: 0, throttled_usec: 0 },
    pressure: {},
    pids: { current: 1, peak: 1, max: 10 },
    ...over,
  };
}

describe("redskilled resource incidents", () => {
  it("reads the cgroup-v2 counters needed for forensic attribution", () => {
    const dir = mkdtempSync(join(tmpdir(), "redskilled-cgroup-"));
    write(dir, "memory.current", "800\n");
    write(dir, "memory.peak", "900\n");
    write(dir, "memory.max", "1000\n");
    write(dir, "memory.swap.current", "25\n");
    write(dir, "memory.swap.peak", "30\n");
    write(dir, "memory.swap.max", "max\n");
    write(dir, "memory.events", "low 1\nhigh 2\nmax 3\noom 4\noom_kill 5\n");
    write(dir, "memory.events.local", "low 0\nhigh 1\nmax 2\noom 3\noom_kill 4\n");
    write(dir, "cpu.stat", "usage_usec 100\nuser_usec 70\nsystem_usec 30\nnr_periods 20\nnr_throttled 4\nthrottled_usec 9\n");
    write(dir, "cpu.pressure", "some avg10=25.50 avg60=10.00 avg300=2.00 total=500\nfull avg10=1.00 avg60=0.50 avg300=0.10 total=20\n");
    write(dir, "memory.pressure", "some avg10=2.00 avg60=1.00 avg300=0.50 total=100\nfull avg10=1.25 avg60=0.50 avg300=0.10 total=40\n");
    write(dir, "io.pressure", "some avg10=3.00 avg60=2.00 avg300=1.00 total=200\nfull avg10=0.25 avg60=0.10 avg300=0.05 total=10\n");
    write(dir, "pids.current", "8\n");
    write(dir, "pids.peak", "9\n");
    write(dir, "pids.max", "10\n");
    write(dir, "pids.events", "max 2\n");

    expect(readCgroupResourceSample(dir, {
      sampledAt: "2026-08-13T00:00:00.000Z",
      target: { kind: "worker", id: "w-1", project_label: "project" },
    })).toEqual({
      schema: "red.redskilled.resource_sample.v1",
      sampled_at: "2026-08-13T00:00:00.000Z",
      target: { kind: "worker", id: "w-1", project_label: "project" },
      source: "cgroup-v2",
      memory: {
        current_bytes: 800,
        peak_bytes: 900,
        max_bytes: 1000,
        swap_current_bytes: 25,
        swap_peak_bytes: 30,
        swap_max_bytes: null,
        events: { low: 1, high: 2, max: 3, oom: 4, oom_kill: 5 },
        events_local: { low: 0, high: 1, max: 2, oom: 3, oom_kill: 4 },
      },
      cpu: {
        usage_usec: 100,
        user_usec: 70,
        system_usec: 30,
        nr_periods: 20,
        nr_throttled: 4,
        throttled_usec: 9,
      },
      pressure: {
        cpu: {
          some: { avg10: 25.5, avg60: 10, avg300: 2, total_usec: 500 },
          full: { avg10: 1, avg60: 0.5, avg300: 0.1, total_usec: 20 },
        },
        memory: {
          some: { avg10: 2, avg60: 1, avg300: 0.5, total_usec: 100 },
          full: { avg10: 1.25, avg60: 0.5, avg300: 0.1, total_usec: 40 },
        },
        io: {
          some: { avg10: 3, avg60: 2, avg300: 1, total_usec: 200 },
          full: { avg10: 0.25, avg60: 0.1, avg300: 0.05, total_usec: 10 },
        },
      },
      pids: { current: 8, peak: 9, max: 10, events: { max: 2 } },
    });
  });

  it("keeps pre-incident evidence, applies hysteresis, and closes after the post tail", () => {
    const tracker = new ResourceIncidentTracker();
    const start = Date.parse("2026-08-13T00:00:00.000Z");
    for (let i = 0; i < 40; i += 1) {
      tracker.ingest(sample(new Date(start + i * 15_000).toISOString(), 500));
    }
    expect(tracker.ingest(sample(new Date(start + 40 * 15_000).toISOString(), 850)).kind).toBe("buffered");
    const opened = tracker.ingest(sample(new Date(start + 41 * 15_000).toISOString(), 850));
    expect(opened.kind).toBe("opened");
    if (opened.kind !== "opened") throw new Error("incident did not open");
    expect(opened.incident.samples[0]?.sampled_at).toBe(new Date(start).toISOString());
    expect(opened.incident.triggers).toContain("memory-ratio");
    expect(tracker.recommendedCadenceMs("w-1")).toBe(2_000);

    tracker.ingest(sample(new Date(start + 42 * 15_000).toISOString(), 650));
    const recovered = tracker.ingest(sample(new Date(start + 42 * 15_000 + 120_000).toISOString(), 650));
    expect(recovered.kind).toBe("recovering");
    const finalized = tracker.ingest(sample(new Date(start + 42 * 15_000 + 240_000).toISOString(), 650));
    expect(finalized.kind).toBe("finalized");
    expect(tracker.recommendedCadenceMs("w-1")).toBe(15_000);
  });

  it("persists redacted incidents and enforces host retention", async () => {
    const root = mkdtempSync(join(tmpdir(), "redskilled-incidents-"));
    const store = createResourceIncidentStore({ root, maxIncidents: 2, maxHostBytes: 12_000, maxIncidentBytes: 8_000 });
    const base = Date.parse("2026-08-13T00:00:00.000Z");
    for (let i = 0; i < 3; i += 1) {
      const one = {
        schema: "red.redskilled.resource_incident.v1" as const,
        incident_id: `incident-${i}`,
        target: { kind: "worker" as const, id: `w-${i}`, project_label: "project" },
        opened_at: new Date(base + i * 1_000).toISOString(),
        closed_at: new Date(base + i * 1_000 + 500).toISOString(),
        state: "completed" as const,
        triggers: ["memory-events-max"],
        samples: [sample(new Date(base + i * 1_000).toISOString(), 900)],
      };
      await store.save(one);
    }
    expect((await store.list()).map((row) => row.incident_id)).toEqual(["incident-2", "incident-1"]);
    expect((await store.read("incident-2"))?.samples).toHaveLength(1);
    expect(readFileSync(join(root, "incident-2", "summary.toon"), "utf8")).not.toMatch(/argv|prompt|environment|stdout|stderr/i);
    await expect(store.save({
      schema: "red.redskilled.resource_incident.v1",
      incident_id: "unsafe",
      target: { kind: "worker", id: "w-unsafe" },
      opened_at: new Date(base).toISOString(),
      closed_at: new Date(base + 1).toISOString(),
      state: "completed",
      triggers: ["memory-ratio"],
      samples: [{ ...sample(new Date(base).toISOString(), 900), raw_argv: ["secret"] } as never],
    })).rejects.toThrow(/forbidden diagnostic field/i);
    expect(() => mkdirSync(join(root, "active"))).not.toThrow();

    let output = "";
    expect(await runResourceIncidents(["list", "--worker", "w-2"], {
      store,
      write: (text) => { output += text; },
    })).toBe(0);
    expect(decode(output.trim())).toMatchObject([{ incident_id: "incident-2" }]);
    output = "";
    expect(await runResourceIncidents(["show", "incident-2"], {
      store,
      write: (text) => { output += text; },
    })).toBe(0);
    expect(decode(output.trim())).toMatchObject({ incident_id: "incident-2", samples: [{ source: "cgroup-v2" }] });
  });
});

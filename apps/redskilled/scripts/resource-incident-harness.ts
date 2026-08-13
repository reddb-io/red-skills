#!/usr/bin/env node
import { setTimeout as wait } from "node:timers/promises";
import { encode } from "@reddb-io/toon";
import {
  ResourceIncidentTracker,
  sampleCurrentProcessResources,
} from "../src/resource-incidents.js";

const numericArgs = process.argv.slice(2).map(Number).filter(Number.isFinite);
const count = Math.max(1, Math.min(120, numericArgs[0] ?? 12));
const intervalMs = Math.max(250, Math.min(15_000, numericArgs[1] ?? 1_000));
const tracker = new ResourceIncidentTracker({ normalCadenceMs: intervalMs });
const observations = [];

for (let index = 0; index < count; index += 1) {
  const sample = sampleCurrentProcessResources({ kind: "worker", id: "local-diagnostic" });
  const result = tracker.ingest(sample);
  observations.push({
    sampled_at: sample.sampled_at,
    source: sample.source,
    memory_current_bytes: sample.memory.current_bytes,
    memory_peak_bytes: sample.memory.peak_bytes,
    cpu_usage_usec: sample.cpu.usage_usec,
    pids_current: sample.pids.current,
    incident_state: result.kind,
  });
  if (index + 1 < count) await wait(intervalMs);
}

process.stdout.write(`${encode({
  schema: "red.redskilled.resource_harness.v1",
  note: "Numeric-only local probe; no command line, environment, prompt or child output is collected.",
  observations,
})}\n`);

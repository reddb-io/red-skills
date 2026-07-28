import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeSnapshotToon } from "@reddb-io/shared/toon-migration.js";
import type { JsonObject } from "@reddb-io/toon";
import type { RspRuntimeConfig } from "../config.js";
import { overheadHealth, type RspOverheadHealth } from "../overhead-budget.js";
import type { RspResidentPaths } from "../resident-client.js";
import { structuredErrorPayload } from "../structured-error.js";
import type { RspTelemetryStats } from "../telemetry.js";
import { firstLine } from "./passthrough.js";
import { readStatsSnapshot } from "./stats.js";

type DoctorProbeName =
  | "config_gate_resolution"
  | "hook_wiring"
  | "proxy_mode"
  | "resident_liveness"
  | "store_provisioning"
  | "recent_degradation_rate"
  | "overhead_budget";

type DoctorError = JsonObject;

interface DoctorProbe {
  name: DoctorProbeName;
  pass: boolean;
  finding: string;
  fix_command?: string;
  error?: DoctorError;
}

interface DoctorStatus {
  schema_version: "red.rsp.doctor.v1";
  status: "pass" | "fail" | "disabled";
  exitCode: 0 | 1;
  window_days: number;
  probes: DoctorProbe[];
  errors: DoctorError[];
}

interface ResidentRegistryStateLike {
  state: string;
}

export async function runDoctor(
  config: RspRuntimeConfig,
  residentPaths: RspResidentPaths,
  windowDays: number,
): Promise<DoctorStatus> {
  const probes: DoctorProbe[] = [];
  const disabled = !config.enabled;
  probes.push(disabled
    ? passProbe("config_gate_resolution", "rsp disabled in this directory; run /red-setup to opt in")
    : passProbe("config_gate_resolution", "rsp.enabled resolved true for this directory"));

  if (disabled) {
    probes.push(
      passProbe("hook_wiring", "skipped because rsp is disabled"),
      passProbe("proxy_mode", "skipped because rsp is disabled"),
      passProbe("resident_liveness", "skipped because rsp is disabled"),
      passProbe("store_provisioning", "skipped because rsp is disabled"),
      passProbe("recent_degradation_rate", "skipped because rsp is disabled"),
      passProbe("overhead_budget", "skipped because rsp is disabled"),
    );
    return doctorStatus("disabled", probes, windowDays);
  }

  probes.push(await doctorHookProbe(config));
  probes.push(config.proxyEnabled
    ? passProbe("proxy_mode", "proxy routing enabled for pre-exec rewrites")
    : failProbe(
      "proxy_mode",
      "proxy routing is explicitly disabled; hook falls back to fixed wrapper capabilities",
      "rsp setup",
    ));

  const { residentRegistryStatus } = await import("../resident-client.js");
  probes.push(residentProbe(await residentRegistryStatus(residentPaths)));
  probes.push(storeProbe(config));

  if (storeExists(config)) {
    const { telemetry } = await readStatsSnapshot(config, windowDays);
    probes.push(degradationProbe(telemetry, windowDays));
  } else {
    probes.push(passProbe("recent_degradation_rate", "no telemetry store available yet; no recent degradation spike detected"));
  }

  probes.push(overheadProbe(overheadHealth(process.cwd(), config.overhead)));

  return doctorStatus(probes.some((probe) => !probe.pass) ? "fail" : "pass", probes, windowDays);
}

export function renderDoctor(status: DoctorStatus): string {
  const { exitCode: _exitCode, ...payload } = status;
  return `${encodeSnapshotToon({
    ...payload,
    exit_code: status.exitCode,
    probes: status.probes as unknown as JsonObject[],
    errors: status.errors,
  })}\n`;
}

async function doctorHookProbe(config: RspRuntimeConfig): Promise<DoctorProbe> {
  try {
    if (config.proxyEnabled) return passProbe("hook_wiring", "pre-exec hook would rewrite git status through rsp proxy");
    const { rewriteCommand } = await import("../intercept.js");
    const decision = rewriteCommand("git status");
    if (decision.kind === "rewrite") return passProbe("hook_wiring", `pre-exec hook would rewrite git status through ${decision.capabilityId}`);
    return failProbe("hook_wiring", `pre-exec hook passed git status through: ${decision.reason ?? "unsupported-command"}`, "rsp setup");
  } catch (err) {
    return failProbe("hook_wiring", `pre-exec hook probe failed: ${err instanceof Error ? firstLine(err.message) : "unknown error"}`, "rsp setup");
  }
}

function residentProbe(status: ResidentRegistryStateLike): DoctorProbe {
  if (status.state === "registered-alive-socket-healthy") {
    return passProbe("resident_liveness", "resident registry points at a healthy socket");
  }
  return failProbe("resident_liveness", `resident registry state is ${status.state}`, "rsp warm-resident");
}

function storeProbe(config: RspRuntimeConfig): DoctorProbe {
  if (!config.storeUri.startsWith("file://")) {
    return passProbe("store_provisioning", "non-file store URI configured; provisioning is delegated to that backend");
  }
  if (storeExists(config)) return passProbe("store_provisioning", "rsp store exists for this directory");
  return failProbe("store_provisioning", "rsp store is not provisioned", "rsp setup");
}

function degradationProbe(telemetry: RspTelemetryStats, windowDays: number): DoctorProbe {
  const dominant = telemetry.health.by_reason[0];
  if (telemetry.health.degradations === 0) {
    return passProbe("recent_degradation_rate", `0 degradations in the recent ${windowDays}d window`);
  }
  const count = telemetry.health.degradations;
  const reason = dominant?.reason ?? telemetry.health.most_recent?.reason ?? "unknown";
  const reasonCount = dominant?.count ?? count;
  return failProbe(
    "recent_degradation_rate",
    `${count} degradation(s) in the recent ${windowDays}d window; dominant reason ${reason} (${reasonCount})`,
    degradationFixCommand(reason, windowDays),
  );
}

/**
 * The cost half of the ledger (#2746): rsp taxing every command is a defect,
 * and the doctor fails on it exactly as it fails on a degradation spike.
 */
function overheadProbe(health: RspOverheadHealth): DoctorProbe {
  if (health.verdict === "green") return passProbe("overhead_budget", health.summary);
  return failProbe("overhead_budget", health.summary, "rsp status");
}

function degradationFixCommand(reason: string, windowDays: number): string {
  if (/unavailable|not provisioned|missing/i.test(reason)) return "rsp setup";
  if (/resident|socket|registry/i.test(reason)) return "rsp warm-resident";
  return `rsp stats --since ${windowDays}d --full`;
}

function storeExists(config: RspRuntimeConfig): boolean {
  if (!config.storeUri.startsWith("file://")) return true;
  try {
    return existsSync(fileURLToPath(config.storeUri));
  } catch {
    return false;
  }
}

function passProbe(name: DoctorProbeName, finding: string): DoctorProbe {
  return { name, pass: true, finding };
}

function failProbe(name: DoctorProbeName, finding: string, fixCommand: string): DoctorProbe {
  return {
    name,
    pass: false,
    finding,
    fix_command: fixCommand,
    error: structuredErrorPayload({
      command: `rsp doctor:${name}`,
      category: "real-error",
      error: finding,
      help: fixCommand,
    }),
  };
}

function doctorStatus(status: DoctorStatus["status"], probes: DoctorProbe[], windowDays: number): DoctorStatus {
  return {
    schema_version: "red.rsp.doctor.v1",
    status,
    exitCode: status === "fail" ? 1 : 0,
    window_days: windowDays,
    probes,
    errors: probes.map((probe) => probe.error).filter((error): error is DoctorError => Boolean(error)),
  };
}

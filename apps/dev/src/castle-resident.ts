#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readBuildInfo } from "@reddb-io/build-info";
import {
  createCastleMcpTools,
  type CastleMcpTool,
} from "@reddb-io/red-castle/mcp-server";
import {
  CASTLE_RESIDENT_PROTOCOL_VERSION,
  resolveCastleResidentPaths,
  startCastleResident,
} from "@reddb-io/red-castle/resident";
import {
  ResourceIncidentTracker,
  createResourceIncidentStore,
  sampleCurrentProcessResources,
  type RedskilledResourceSample,
} from "@reddb-io/redskilled/resource-incidents";
import { resolveRedskilledPaths } from "@reddb-io/redskilled/paths";
import { resolveProjectIdentityForDir } from "@reddb-io/shared/project-identity-resolve.js";
import { buildProjectBootSweeps } from "./commands/boot-sweeps.js";
import { loadConfig, readStandingDrain } from "./core/config.js";
import { createCastleMcpDependencies } from "./mcp-adapter.js";
import { createResidentJanitor } from "./resident-cron.js";
import { startResidentSelfUpdate } from "./resident-self-update.js";
import { startResidentUnblockSweep } from "./resident-unblock.js";
import { createResidentWebhook } from "./resident-webhook.js";
import {
  startResidentIssueCurator,
  startResidentRegistrationDelivery,
} from "./resident-authority.js";
import { resolveRepoSlug } from "./runtime/wire.js";

const buildInfo = readBuildInfo("castle-resident");
const RESOURCE_SAMPLE_MS = 15_000;

/** Run every Castle workflow concern inside the project's one resident PID. */
export async function runCastleResident(root = process.cwd()): Promise<void> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const identity = resolveProjectIdentityForDir(root);
  const tools = new Map<string, CastleMcpTool>(
    createCastleMcpTools(createCastleMcpDependencies(root)).map((tool) => [tool.name, tool]),
  );
  const registration = startResidentRegistrationDelivery(root);
  const unblock = await startResidentUnblockSweep({ root });
  const selfUpdate = await startResidentSelfUpdate({
    root,
    notice: (line) => process.stderr.write(`Castle resident: ${line}\n`),
  });
  await startResidentIssueCurator(root);

  let bootSweeps: (() => Promise<void>) | undefined;
  const janitor = createResidentJanitor({
    root,
    sweep: async () => {
      if (bootSweeps === undefined) {
        const repo = await resolveRepoSlug(root).catch(() => "");
        bootSweeps = buildProjectBootSweeps(root, repo, (line) =>
          process.stderr.write(`Castle resident: ${line}\n`),
        );
      }
      await bootSweeps();
    },
    notice: (line) => process.stderr.write(`Castle resident: ${line}\n`),
  });
  const webhook = createResidentWebhook({ root });
  await Promise.all([janitor.start(), webhook.start()]);

  const incidentSampler = startCastleResourceEvidence(identity.slug, identity.name);
  let server!: Awaited<ReturnType<typeof startCastleResident>>;
  server = await startCastleResident({
    paths: resolveCastleResidentPaths(root),
    residentVersion: buildInfo.version,
    invoke: async (method, input) => {
      const tool = tools.get(method);
      if (tool === undefined) throw new Error(`unknown Castle method ${JSON.stringify(method)}`);
      const result = await tool.invoke(input);
      return attachResidentProjectStatus(method, input, result, {
        activity: server.activity.snapshot(),
        startedAt,
        startedAtMs,
        resources: incidentSampler.latest(),
      });
    },
    notify: (topic, value) => applyActivityNotification(server.activity, topic, value),
  });

  if (readStandingDrain(loadConfig(join(root, ".red", "config.yaml"), { warn: () => undefined })) !== undefined) {
    server.activity.armObligation("standing-drain");
  }
  const close = () => { void server.close(); };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    await server.closed;
  } finally {
    process.removeListener("SIGINT", close);
    process.removeListener("SIGTERM", close);
    incidentSampler.stop();
    registration.stop();
    await Promise.all([
      unblock?.stop() ?? Promise.resolve(),
      selfUpdate?.stop() ?? Promise.resolve(),
      janitor.stop(),
      webhook.stop(),
    ]);
  }
}

function applyActivityNotification(
  activity: import("@reddb-io/shared/resident-lifecycle.js").ResidentActivity,
  topic: string,
  value: unknown,
): void {
  const id = typeof value === "string" ? value : "";
  if (id === "") return;
  if (topic === "worker-started") activity.addWorker(id);
  else if (topic === "worker-stopped") activity.removeWorker(id);
  else if (topic === "obligation-armed") activity.armObligation(id);
  else if (topic === "obligation-disarmed") activity.disarmObligation(id);
}

function startCastleResourceEvidence(
  projectId: string,
  projectLabel: string,
): { stop(): void; latest(): RedskilledResourceSample } {
  const tracker = new ResourceIncidentTracker({ normalCadenceMs: RESOURCE_SAMPLE_MS });
  const hostPaths = resolveRedskilledPaths();
  const store = createResourceIncidentStore({
    root: join(dirname(hostPaths.eventLanePath), "state", "incidents"),
  });
  let latest = sampleCurrentProcessResources({
    kind: "castle-resident",
    id: projectId,
    project_label: projectLabel,
  });
  const tick = async () => {
    const sample = sampleCurrentProcessResources({
      kind: "castle-resident",
      id: projectId,
      project_label: projectLabel,
    });
    latest = sample;
    const result = tracker.ingest(sample);
    if (result.kind !== "buffered") await store.save(result.incident).catch(() => undefined);
  };
  void tick();
  const timer = setInterval(() => void tick(), RESOURCE_SAMPLE_MS);
  timer.unref();
  return { stop: () => clearInterval(timer), latest: () => latest };
}

function attachResidentProjectStatus(
  method: string,
  input: Record<string, unknown>,
  result: unknown,
  context: {
    activity: { clients: number; draining: boolean };
    startedAt: string;
    startedAtMs: number;
    resources: RedskilledResourceSample;
  },
): unknown {
  if (method !== "project_status" && !(method === "status" && input.scope === "project")) {
    return result;
  }
  const project = method === "project_status" && isRecord(result) && isRecord(result.result)
    ? result.result
    : result;
  if (!isRecord(project)) return result;
  const sample = context.resources;
  const resident = {
    health: "ready" as const,
    version: buildInfo.version,
    protocol: CASTLE_RESIDENT_PROTOCOL_VERSION,
    pid: process.pid,
    started_at: context.startedAt,
    uptime_ms: Math.max(0, Date.now() - context.startedAtMs),
    client_count: context.activity.clients,
    handover: context.activity.draining ? "draining" as const : "serving" as const,
    resources: {
      sampled_at: sample.sampled_at,
      source: sample.source,
      memory_current_bytes: sample.memory.current_bytes,
      memory_peak_bytes: sample.memory.peak_bytes,
      cpu_usage_usec: sample.cpu.usage_usec,
      pids_current: sample.pids.current,
    },
  };
  if (method === "project_status") return { ...(result as Record<string, unknown>), result: { ...project, resident } };
  return { ...project, resident };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  void runCastleResident().catch((error) => {
    process.stderr.write(`Castle resident fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

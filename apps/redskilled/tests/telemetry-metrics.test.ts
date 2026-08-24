import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { RequestError } from "@agentclientprotocol/sdk";
import { REDSKILLS_ACP_METHODS } from "@reddb-io/protocol-acp";

import { telemetryMethodDomain } from "../src/acp-telemetry.js";
import { createRedskilledEventLane } from "../src/event-lane.js";
import type { RedskilledWorkerView } from "../src/host-state.js";
import {
  REDSKILLED_METRIC_NAMES,
  createRedskilledMetrics,
  meteredRedskilledEventLane,
  redskilledMetrics,
  resetRedskilledMetrics,
  type RedskilledMetricSeries,
  type RedskilledMetricsSnapshot,
} from "../src/telemetry-metrics.js";
import {
  DEFAULT_REDSKILLED_OTLP_INTERVAL_MS,
  otlpMetricsRequest,
  redskilledOtlpMetricsUrl,
  resolveRedskilledOtlpPolicy,
  startRedskilledHostOtlpExport,
  startRedskilledOtlpMetricsExport,
} from "../src/telemetry-otlp.js";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  resetRedskilledMetrics();
});

function worker(overrides: Partial<RedskilledWorkerView> = {}): RedskilledWorkerView {
  return {
    worker_id: "wTELE",
    project_label: "acme/widgets",
    pid: 4242,
    started_at: "2026-08-19T09:00:00.000Z",
    workspace_path: "/tmp/workspace",
    isolated: true,
    unit: "red-worker-wTELE.service",
    warnings: [],
    ...overrides,
  };
}

/** A real lane on disk, wrapped in the meter the daemon wraps it in. */
async function meteredLane(metrics = createRedskilledMetrics({ clock: () => "2026-08-19T09:00:00.000Z" })) {
  const root = await mkdtemp(join(tmpdir(), "redskilled-telemetry-"));
  roots.push(root);
  return { metrics, lane: meteredRedskilledEventLane(createRedskilledEventLane(join(root, "lane.toonl")), metrics) };
}

function seriesFor(snapshot: RedskilledMetricsSnapshot, name: string): RedskilledMetricSeries[] {
  return snapshot.series.filter((entry) => entry.name === name);
}

/** Answer `_redskills/metrics` the way the composed control plane would. */
function readMetrics(
  hostAdministration: boolean,
  snapshot: () => RedskilledMetricsSnapshot,
): RedskilledMetricsSnapshot {
  const domain = telemetryMethodDomain({ hostAdministration, snapshot });
  const binding = domain.bindings.find((entry) => entry.method === REDSKILLS_ACP_METHODS.metrics);
  if (binding == null) throw new Error("the telemetry domain binds no metrics method");
  return binding.handle({ params: binding.params({}), client: undefined }) as RedskilledMetricsSnapshot;
}

describe("_redskills/metrics", () => {
  it("returns the Worker counters after a birth and a death", async () => {
    const { metrics, lane } = await meteredLane();

    await lane.recordWorker({ kind: "worker-birth", worker: worker(), ts: "2026-08-19T09:00:00.000Z" });
    await lane.recordWorker({
      kind: "worker-death",
      worker: worker(),
      ts: "2026-08-19T09:05:00.000Z",
      exitCode: 0,
    });

    const answer = readMetrics(true, metrics.snapshot);
    expect(seriesFor(answer, REDSKILLED_METRIC_NAMES.workerBirths)).toEqual([
      expect.objectContaining({ attributes: { project_label: "acme/widgets" }, value: 1 }),
    ]);
    expect(seriesFor(answer, REDSKILLED_METRIC_NAMES.workerDeaths)).toEqual([
      expect.objectContaining({
        attributes: { project_label: "acme/widgets", kind: "worker-death" },
        value: 1,
      }),
    ]);
  });

  it("counts a budget kill as its own death series, and every daemon record as a decision", async () => {
    const { metrics, lane } = await meteredLane();

    await lane.recordWorker({
      kind: "worker-budget-kill",
      worker: worker(),
      ts: "2026-08-19T09:06:00.000Z",
      detail: "MemoryMax budget exceeded",
    });
    await lane.recordDemandRefusal({
      ts: "2026-08-19T09:07:00.000Z",
      projectLabel: "acme/widgets",
      detail: "no headroom",
    });
    await lane.recordDaemonStop({
      ts: "2026-08-19T09:08:00.000Z",
      pid: 11,
      socketPath: "/run/redskilled.sock",
      reason: "requested",
      detail: "asked to leave",
    });

    const answer = metrics.snapshot();
    expect(seriesFor(answer, REDSKILLED_METRIC_NAMES.workerDeaths)).toEqual([
      expect.objectContaining({
        attributes: { project_label: "acme/widgets", kind: "worker-budget-kill" },
        value: 1,
      }),
    ]);
    expect(seriesFor(answer, REDSKILLED_METRIC_NAMES.daemonDecisions).map((entry) => entry.attributes))
      .toEqual([{ decision: "daemon-stop" }, { decision: "demand-refusal" }]);
  });

  it("leaves the lane's internal telemetry kinds off the wire entirely", async () => {
    const { metrics, lane } = await meteredLane();

    await lane.recordWorker({
      kind: "worker-metrics",
      worker: worker(),
      ts: "2026-08-19T09:00:00.000Z",
      tokens: 42_000,
      tools: 31,
    });
    await lane.recordWorker({
      kind: "worker-activity",
      worker: worker(),
      ts: "2026-08-19T09:01:00.000Z",
      phase: "coding",
    });

    expect(metrics.snapshot().series).toEqual([]);
  });

  it("adds repeated births of one project into one series rather than one per Worker", async () => {
    const { metrics, lane } = await meteredLane();

    for (const workerId of ["w1", "w2", "w3"]) {
      await lane.recordWorker({
        kind: "worker-birth",
        worker: worker({ worker_id: workerId }),
        ts: "2026-08-19T09:00:00.000Z",
      });
    }
    await lane.recordWorker({
      kind: "worker-birth",
      worker: worker({ project_label: "acme/other" }),
      ts: "2026-08-19T09:00:00.000Z",
    });

    expect(seriesFor(metrics.snapshot(), REDSKILLED_METRIC_NAMES.workerBirths))
      .toEqual([
        expect.objectContaining({ attributes: { project_label: "acme/other" }, value: 1 }),
        expect.objectContaining({ attributes: { project_label: "acme/widgets" }, value: 3 }),
      ]);
  });

  it("counts a public Workflow turn by its outcome", () => {
    const metrics = createRedskilledMetrics({ clock: () => "2026-08-19T09:00:00.000Z" });

    metrics.observeTurn("completed");
    metrics.observeTurn("completed");
    metrics.observeTurn("refused");

    expect(seriesFor(metrics.snapshot(), REDSKILLED_METRIC_NAMES.workerTurns).map((entry) => ({
      attributes: entry.attributes,
      value: entry.value,
    }))).toEqual([
      { attributes: { outcome: "completed" }, value: 2 },
      { attributes: { outcome: "refused" }, value: 1 },
    ]);
  });

  it("still records the count when the lane's own append fails", async () => {
    const metrics = createRedskilledMetrics({ clock: () => "2026-08-19T09:00:00.000Z" });
    const broken = meteredRedskilledEventLane(
      {
        path: "/nowhere",
        record: () => Promise.reject(new Error("disk full")),
        recordWorker: () => Promise.reject(new Error("disk full")),
        recordDemandRefusal: () => Promise.reject(new Error("disk full")),
        recordAcpFailure: () => Promise.reject(new Error("disk full")),
        recordDaemonStart: () => Promise.reject(new Error("disk full")),
        recordDaemonDeath: () => Promise.reject(new Error("disk full")),
        recordDaemonTakeoverFailed: () => Promise.reject(new Error("disk full")),
        recordDaemonStop: () => Promise.reject(new Error("disk full")),
        read: () => Promise.resolve([]),
        flush: () => Promise.resolve(),
      },
      metrics,
    );

    await expect(broken.recordWorker({ kind: "worker-birth", worker: worker(), ts: "2026-08-19T09:00:00.000Z" }))
      .rejects.toThrow("disk full");

    expect(seriesFor(metrics.snapshot(), REDSKILLED_METRIC_NAMES.workerBirths)).toHaveLength(1);
  });

  it("refuses a project-scoped connection, which never sees the capability either", () => {
    const metrics = createRedskilledMetrics({ clock: () => "2026-08-19T09:00:00.000Z" });

    const refusal = (() => {
      try {
        readMetrics(false, metrics.snapshot);
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(refusal).toBeInstanceOf(RequestError);
    expect(JSON.stringify((refusal as RequestError).data))
      .toContain("no host-administrative authority");
    expect(telemetryMethodDomain({ hostAdministration: false }).capability).toBeUndefined();
    expect(telemetryMethodDomain({ hostAdministration: true }).capability)
      .toEqual({ metrics: { version: 1, methods: [REDSKILLS_ACP_METHODS.metrics] } });
  });

  it("names no caller-controlled scope", () => {
    const domain = telemetryMethodDomain({ hostAdministration: true });
    const binding = domain.bindings[0]!;

    expect(() => binding.params({ project_label: "acme/widgets" })).toThrow();
    expect(binding.params({})).toEqual({});
  });

  it("feeds the daemon's process-scoped registry, which a reset starts over", () => {
    resetRedskilledMetrics({ clock: () => "2026-08-19T09:00:00.000Z" });
    redskilledMetrics().observeTurn("completed");

    expect(seriesFor(redskilledMetrics().snapshot(), REDSKILLED_METRIC_NAMES.workerTurns)).toHaveLength(1);

    resetRedskilledMetrics({ clock: () => "2026-08-19T09:00:00.000Z" });

    expect(redskilledMetrics().snapshot().series).toEqual([]);
  });
});

/** An OTLP/HTTP receiver that holds what it was posted, and nothing else. */
async function inMemoryOtlpReceiver(): Promise<{ endpoint: string; received: unknown[] }> {
  const received: unknown[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        url: request.url,
        contentType: request.headers["content-type"],
        authorization: request.headers.authorization,
        document: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${port}`, received };
}

describe("the OTLP metrics exporter", () => {
  it("exports nothing, and starts nothing, when host policy names no receiver", () => {
    expect(resolveRedskilledOtlpPolicy(undefined)).toBeNull();
    expect(resolveRedskilledOtlpPolicy({})).toBeNull();
    expect(resolveRedskilledOtlpPolicy({ otlp: {} })).toBeNull();
    expect(resolveRedskilledOtlpPolicy({ otlp: { endpoint: "   " } })).toBeNull();
    // A cadence and headers for nowhere is still nowhere.
    expect(resolveRedskilledOtlpPolicy({ otlp: { intervalMs: 1_000, headers: { a: "b" } } })).toBeNull();
    expect(startRedskilledHostOtlpExport(undefined)).toBeNull();
    expect(startRedskilledOtlpMetricsExport({ policy: null, snapshot: () => emptySnapshot() })).toBeNull();
  });

  it("takes its endpoint, cadence and headers from host policy", () => {
    expect(resolveRedskilledOtlpPolicy({ otlp: { endpoint: "http://collector:4318" } }))
      .toEqual({
        endpoint: "http://collector:4318",
        intervalMs: DEFAULT_REDSKILLED_OTLP_INTERVAL_MS,
        headers: {},
      });
    expect(resolveRedskilledOtlpPolicy({
      otlp: { endpoint: "http://collector:4318", intervalMs: 5_000, headers: { authorization: "Bearer t" } },
    })).toEqual({
      endpoint: "http://collector:4318",
      intervalMs: 5_000,
      headers: { authorization: "Bearer t" },
    });
    expect(redskilledOtlpMetricsUrl("http://collector:4318/")).toBe("http://collector:4318/v1/metrics");
    expect(redskilledOtlpMetricsUrl("http://collector:4318/v1/metrics"))
      .toBe("http://collector:4318/v1/metrics");
  });

  it("delivers the same series to a receiver that host policy enabled", async () => {
    const receiver = await inMemoryOtlpReceiver();
    const { metrics, lane } = await meteredLane();
    await lane.recordWorker({ kind: "worker-birth", worker: worker(), ts: "2026-08-19T09:00:00.000Z" });
    await lane.recordWorker({ kind: "worker-death", worker: worker(), ts: "2026-08-19T09:05:00.000Z" });
    metrics.observeTurn("completed");

    const exporter = startRedskilledHostOtlpExport(
      { otlp: { endpoint: receiver.endpoint, headers: { authorization: "Bearer t" } } },
      { snapshot: metrics.snapshot },
    );
    expect(exporter).not.toBeNull();
    await exporter!.push();
    await exporter!.close();

    expect(receiver.received).toHaveLength(1);
    const delivered = receiver.received[0] as {
      url: string;
      contentType: string;
      authorization: string;
      document: { resourceMetrics: { scopeMetrics: { metrics: unknown[] }[] }[] };
    };
    expect(delivered.url).toBe("/v1/metrics");
    expect(delivered.contentType).toBe("application/json");
    expect(delivered.authorization).toBe("Bearer t");
    // The same series `_redskills/metrics` answers, in the encoding OTLP spells.
    expect(delivered.document).toEqual(otlpMetricsRequest(readMetrics(true, metrics.snapshot)));
  });

  it("shapes each counter as a cumulative monotonic sum with its attributes", () => {
    const metrics = createRedskilledMetrics({ clock: () => "2026-08-19T09:00:00.000Z" });
    metrics.observeTurn("completed");
    metrics.observeTurn("refused");

    const request = otlpMetricsRequest(metrics.snapshot(), { "host.name": "builder" });

    const scope = request.resourceMetrics[0]!.scopeMetrics[0]!;
    expect(request.resourceMetrics[0]!.resource.attributes).toEqual([
      { key: "host.name", value: { stringValue: "builder" } },
      { key: "service.name", value: { stringValue: "redskilled" } },
    ]);
    expect(scope.metrics).toEqual([
      {
        name: REDSKILLED_METRIC_NAMES.workerTurns,
        description: expect.any(String),
        unit: "1",
        sum: {
          aggregationTemporality: 2,
          isMonotonic: true,
          dataPoints: [
            {
              attributes: [{ key: "outcome", value: { stringValue: "completed" } }],
              startTimeUnixNano: `${Date.parse("2026-08-19T09:00:00.000Z")}000000`,
              timeUnixNano: `${Date.parse("2026-08-19T09:00:00.000Z")}000000`,
              asInt: "1",
            },
            {
              attributes: [{ key: "outcome", value: { stringValue: "refused" } }],
              startTimeUnixNano: `${Date.parse("2026-08-19T09:00:00.000Z")}000000`,
              timeUnixNano: `${Date.parse("2026-08-19T09:00:00.000Z")}000000`,
              asInt: "1",
            },
          ],
        },
      },
    ]);
  });

  it("reports a refused export without letting it become the daemon's problem", async () => {
    const errors: unknown[] = [];
    const exporter = startRedskilledOtlpMetricsExport({
      policy: { endpoint: "http://collector:4318", intervalMs: 60_000, headers: {} },
      snapshot: () => emptySnapshot(),
      send: () => Promise.reject(new Error("collector is down")),
      onError: (error) => errors.push(error),
    });

    await expect(exporter!.push()).resolves.toBeUndefined();
    await exporter!.close();

    expect((errors[0] as Error).message).toBe("collector is down");
  });

  it("pushes on the cadence policy declared, and stops on close", async () => {
    const pushes: string[] = [];
    const exporter = startRedskilledOtlpMetricsExport({
      policy: { endpoint: "http://collector:4318", intervalMs: 10, headers: {} },
      snapshot: () => emptySnapshot(),
      send: async (request) => {
        pushes.push(request.url);
      },
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    await exporter!.close();
    const afterClose = pushes.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 40));

    expect(afterClose).toBeGreaterThan(0);
    expect(pushes.length).toBe(afterClose);
  });
});

function emptySnapshot(): RedskilledMetricsSnapshot {
  return { version: 1, since: "2026-08-19T09:00:00.000Z", ts: "2026-08-19T09:00:00.000Z", series: [] };
}

// telemetry-otlp — the daemon's counters, pushed to an OTLP receiver the OPERATOR named.
//
// **Exporting is off until host policy turns it on.** No endpoint in
// `~/.red/config.yaml` means no exporter, no timer and no socket: a daemon that
// dialed a collector nobody asked for would be sending a machine's Worker
// history somewhere its operator never chose. `resolveRedskilledOtlpPolicy`
// answers `null` for absence, and `startRedskilledOtlpMetricsExport` answers
// `null` for a `null` policy, so "off" is a shape rather than a flag somebody
// has to remember to check.
//
// **The push is a notification, never a veto** — the same doctrine ADR 0140
// Amendment 1 states for host hooks. A collector that is down, slow or hostile
// changes nothing about the Workers this daemon is running: the interval timer
// is `unref`'d so it can never hold the process open, and a failed export is
// handed to `onError` and forgotten rather than retried into a queue nobody
// bounded.
//
// **The wire is OTLP/HTTP JSON because the receiver is foreign.** Every other
// byte this daemon writes is TOON; this one is the encoding an OpenTelemetry
// collector will actually accept, which is the whole point of speaking a
// standard at a boundary.
import {
  redskilledMetricsSnapshot,
  type RedskilledMetricSeries,
  type RedskilledMetricsSnapshot,
} from "./telemetry-metrics.js";

/** Where the counters go, how often, and under what headers. */
export interface RedskilledOtlpMetricsPolicy {
  /** Collector base URL, or the metrics endpoint itself. */
  readonly endpoint: string;
  readonly intervalMs: number;
  readonly headers: Readonly<Record<string, string>>;
}

/** The host-policy block, as `host-config.ts` parsed it. */
export interface RedskilledTelemetryConfig {
  readonly otlp?: {
    readonly endpoint?: string;
    readonly intervalMs?: number;
    readonly headers?: Readonly<Record<string, string>>;
  };
}

/** Push cadence when policy names none. One minute: a counter, not a trace. */
export const DEFAULT_REDSKILLED_OTLP_INTERVAL_MS = 60_000;

/** The OTLP/HTTP path metrics are posted to, appended to a base endpoint. */
export const REDSKILLED_OTLP_METRICS_PATH = "/v1/metrics";

/**
 * The exporter host policy asks for, or `null` for the default: none.
 *
 * An endpoint is the ONLY thing that turns exporting on. A block that sets an
 * interval or headers and no endpoint has named a cadence for nowhere, so it
 * stays off rather than guessing a collector.
 */
export function resolveRedskilledOtlpPolicy(
  telemetry: RedskilledTelemetryConfig | undefined,
): RedskilledOtlpMetricsPolicy | null {
  const endpoint = telemetry?.otlp?.endpoint?.trim();
  if (endpoint == null || endpoint === "") return null;
  const declared = telemetry?.otlp?.intervalMs;
  const intervalMs = Number.isSafeInteger(declared) && (declared as number) > 0
    ? declared as number
    : DEFAULT_REDSKILLED_OTLP_INTERVAL_MS;
  return { endpoint, intervalMs, headers: { ...(telemetry?.otlp?.headers ?? {}) } };
}

/** The absolute URL one export is posted to. PURE. */
export function redskilledOtlpMetricsUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  return trimmed.endsWith(REDSKILLED_OTLP_METRICS_PATH)
    ? trimmed
    : `${trimmed}${REDSKILLED_OTLP_METRICS_PATH}`;
}

/** One OTLP attribute, in the encoding the protocol spells. */
interface OtlpAttribute {
  readonly key: string;
  readonly value: { readonly stringValue: string };
}

interface OtlpDataPoint {
  readonly attributes: readonly OtlpAttribute[];
  readonly startTimeUnixNano: string;
  readonly timeUnixNano: string;
  readonly asInt: string;
}

interface OtlpMetric {
  readonly name: string;
  readonly description: string;
  readonly unit: string;
  readonly sum: {
    readonly aggregationTemporality: 2;
    readonly isMonotonic: true;
    readonly dataPoints: readonly OtlpDataPoint[];
  };
}

/** The document one export posts. */
export interface OtlpMetricsRequest {
  readonly resourceMetrics: readonly {
    readonly resource: { readonly attributes: readonly OtlpAttribute[] };
    readonly scopeMetrics: readonly {
      readonly scope: { readonly name: string };
      readonly metrics: readonly OtlpMetric[];
    }[];
  }[];
}

/** The instrumentation scope every series this daemon exports belongs to. */
export const REDSKILLED_OTLP_SCOPE = "redskilled";

/**
 * One snapshot as an OTLP metrics request. PURE.
 *
 * Every series is a CUMULATIVE monotonic sum (`aggregationTemporality: 2`)
 * starting at the snapshot's `since`, which is what the daemon actually holds:
 * counts since this process started. Reporting them as deltas would make a
 * missed export lose the events it covered rather than merely delay them.
 */
export function otlpMetricsRequest(
  snapshot: RedskilledMetricsSnapshot,
  resource: Readonly<Record<string, string>> = {},
): OtlpMetricsRequest {
  const startTimeUnixNano = unixNano(snapshot.since);
  const timeUnixNano = unixNano(snapshot.ts);
  const byName = new Map<string, RedskilledMetricSeries[]>();
  for (const series of snapshot.series) {
    const held = byName.get(series.name);
    if (held == null) byName.set(series.name, [series]);
    else held.push(series);
  }
  const metrics: OtlpMetric[] = [...byName.values()].map((group) => ({
    name: group[0]!.name,
    description: group[0]!.description,
    unit: group[0]!.unit,
    sum: {
      aggregationTemporality: 2,
      isMonotonic: true,
      dataPoints: group.map((series) => ({
        attributes: otlpAttributes(series.attributes),
        startTimeUnixNano,
        timeUnixNano,
        asInt: String(series.value),
      })),
    },
  }));
  return {
    resourceMetrics: [{
      resource: { attributes: otlpAttributes({ "service.name": REDSKILLED_OTLP_SCOPE, ...resource }) },
      scopeMetrics: [{ scope: { name: REDSKILLED_OTLP_SCOPE }, metrics }],
    }],
  };
}

function otlpAttributes(attributes: Readonly<Record<string, string>>): OtlpAttribute[] {
  return Object.entries(attributes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({ key, value: { stringValue: value } }));
}

/** Nanoseconds since the epoch, as OTLP spells them: a decimal string. */
function unixNano(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? `${ms}000000` : "0";
}

/** What actually puts one export on the wire. Injected so a test owns the receiver. */
export type RedskilledOtlpSend = (request: {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}) => Promise<void>;

export interface RedskilledOtlpMetricsExporter {
  readonly policy: RedskilledOtlpMetricsPolicy;
  /** Export the counters once, now. Resolves whether or not the receiver liked it. */
  push(): Promise<void>;
  /** Stop the timer and settle whatever export is in flight. */
  close(): Promise<void>;
}

export interface StartRedskilledOtlpMetricsExportOptions {
  /** Absent or `null` means exporting is off, which is the default. */
  readonly policy: RedskilledOtlpMetricsPolicy | null | undefined;
  readonly snapshot: () => RedskilledMetricsSnapshot;
  readonly send?: RedskilledOtlpSend;
  /** Resource attributes merged into the exported document. */
  readonly resource?: Readonly<Record<string, string>>;
  /** Told about a refused export; absent swallows it, because a push is never a veto. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Start pushing the counters, or answer `null` because policy named no receiver.
 *
 * `null` is the load-bearing answer here: the caller wires the exporter into the
 * daemon unconditionally and gets nothing when the operator asked for nothing.
 */
export function startRedskilledOtlpMetricsExport(
  options: StartRedskilledOtlpMetricsExportOptions,
): RedskilledOtlpMetricsExporter | null {
  const policy = options.policy;
  if (policy == null) return null;
  const send = options.send ?? postOtlpMetrics;
  const url = redskilledOtlpMetricsUrl(policy.endpoint);
  let inFlight: Promise<void> = Promise.resolve();
  let closed = false;

  const push = (): Promise<void> => {
    if (closed) return inFlight;
    const exported = send({
      url,
      headers: { "content-type": "application/json", ...policy.headers },
      body: encodeOtlpMetrics(otlpMetricsRequest(options.snapshot(), options.resource)),
    }).catch((error: unknown) => {
      options.onError?.(error);
    });
    inFlight = inFlight.then(() => exported);
    return exported;
  };

  // `unref` is the difference between a telemetry exporter and a reason the
  // daemon cannot exit: an idle host must still be allowed to go home.
  const timer = setInterval(() => void push(), policy.intervalMs);
  timer.unref();

  return {
    policy,
    push,
    async close() {
      closed = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}

/**
 * Start this HOST's export from its operator policy, or start nothing.
 *
 * The daemon's one call: policy resolution, the process-scoped counters and the
 * `null`-for-off answer are all behind this name, so a serve path that gains a
 * telemetry line does not also gain a decision about what "off" means. The
 * handle is returned for a caller that wants to push or close on demand; the
 * daemon keeps none, because the interval timer is `unref`'d and a best-effort
 * exporter has nothing worth holding a shutdown open for.
 */
export function startRedskilledHostOtlpExport(
  telemetry: RedskilledTelemetryConfig | undefined,
  overrides: Partial<StartRedskilledOtlpMetricsExportOptions> = {},
): RedskilledOtlpMetricsExporter | null {
  return startRedskilledOtlpMetricsExport({
    policy: resolveRedskilledOtlpPolicy(telemetry),
    snapshot: redskilledMetricsSnapshot,
    ...overrides,
  });
}

/** The default wire: one JSON POST, with the receiver's verdict read and dropped. */
async function postOtlpMetrics(request: {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}): Promise<void> {
  const response = await fetch(request.url, {
    method: "POST",
    headers: { ...request.headers },
    body: request.body,
  });
  // The body is drained so the connection can be reused; its contents are a
  // partial-success report this daemon has nothing to do with.
  await response.text().catch(() => "");
  if (!response.ok) throw new Error(`OTLP metrics export refused with HTTP ${response.status}`);
}

/** The OTLP document as the bytes a collector parses. */
function encodeOtlpMetrics(request: OtlpMetricsRequest): string {
  return JSON.stringify(request);
}

export type OperationalProbeVerdict = "ok" | "red";

export interface RemoteUrlFact {
  readonly name?: string;
  readonly url: string;
}

export interface OperationalProbeContext {
  readonly remoteUrls: readonly (string | RemoteUrlFact)[];
  readonly allowHttpsRemote?: boolean;
  readonly queueVisibility?: QueueVisibilityProbeInput;
}

export type QueueVisibilityTransportSurface = "graphql" | "rest" | "rest-cache" | "unknown";

export interface QueueVisibilityTransportFailure {
  readonly surface?: QueueVisibilityTransportSurface;
  readonly code?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly message?: string;
}

export interface QueueVisibilityProbeInput {
  readonly label?: string;
  readonly listEngineCandidates: () => Promise<number>;
  readonly countRestQueue: () => Promise<number>;
}

export interface OperationalProbeFix {
  readonly gate: "confirm";
  readonly description: string;
}

export interface OperationalProbeResult {
  readonly id: string;
  readonly name: string;
  readonly verdict: OperationalProbeVerdict;
  readonly evidence: string;
  readonly canonicalFix: string;
  readonly fix?: OperationalProbeFix;
  readonly data?: unknown;
}

export interface OperationalProbeFixDeps {
  confirm(finding: OperationalProbeResult): Promise<boolean>;
  setRemoteUrl?(name: string, url: string): Promise<void>;
}

export type OperationalProbeFixStatus = "applied" | "declined" | "noop";

export interface OperationalProbeFixResult {
  readonly probeId: string;
  readonly status: OperationalProbeFixStatus;
  readonly evidence: string;
}

export interface OperationalProbe {
  readonly id: string;
  readonly name: string;
  readonly canonicalFix: string;
  run(context: OperationalProbeContext): OperationalProbeResult | Promise<OperationalProbeResult>;
  applyFix?(finding: OperationalProbeResult, deps: OperationalProbeFixDeps): Promise<OperationalProbeFixResult>;
}

export interface OperationalProbeReport {
  readonly probes: OperationalProbeResult[];
  readonly findings: OperationalProbeResult[];
}

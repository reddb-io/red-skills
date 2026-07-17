export type OperationalProbeVerdict = "ok" | "red";

export interface RemoteUrlFact {
  readonly name?: string;
  readonly url: string;
}

export interface OperationalProbeContext {
  readonly remoteUrls: readonly (string | RemoteUrlFact)[];
  readonly allowHttpsRemote?: boolean;
  readonly queueVisibility?: QueueVisibilityProbeInput;
  readonly focalBranch?: FocalBranchProbeInput;
  readonly configNamespacing?: ConfigNamespacingProbeInput;
  readonly fleetTruth?: FleetTruthProbeInput;
  readonly claimHygiene?: ClaimHygieneProbeInput;
  readonly labelBodyCoherence?: LabelBodyCoherenceProbeInput;
}

export interface ConfigNamespacingProbeInput {
  readonly rootDevKeys: readonly string[];
}

export type FocalBranchSource = "lock" | "pin" | "trunk";

export interface FocalBranchProbeInput {
  readonly resolved: {
    readonly branch: string;
    readonly source: FocalBranchSource;
  };
  readonly configuredTrunk: string;
  readonly lock?: {
    readonly raw: string;
    readonly branch?: string;
    readonly targetExists?: boolean;
    readonly heldByLiveSession?: boolean;
  };
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

export interface FleetTruthProbeInput {
  readonly supervisorPid?: number | null;
  readonly supervisorPidLive: boolean;
  readonly supervisorPidMtimeMs?: number;
  readonly stateMtimeMs?: number;
  readonly heartbeatEpochMs?: number;
  readonly nowMs: number;
  readonly heartbeatStaleMs: number;
  readonly bundleVersion?: string;
  readonly latestBundleVersion?: string;
  readonly runner?: string;
  readonly target?: number;
  readonly relaunchArgs?: readonly string[];
}

export type ClaimHygieneWorkerPidState = "live" | "dead" | "foreign" | "unknown";

export interface ClaimHygieneCommentInput {
  readonly id: number;
  readonly body: string;
  readonly createdAt?: string;
}

export interface ClaimHygieneIssueInput {
  readonly number: number;
  readonly comments: readonly ClaimHygieneCommentInput[];
}

export interface ClaimHygieneProbeInput {
  readonly ownNamespace?: string;
  readonly ownWorkerPrefix: string;
  readonly listOpenQueueIssues: () => Promise<readonly ClaimHygieneIssueInput[]>;
  readonly workerPidState: (worker: string) => ClaimHygieneWorkerPidState;
}

export interface LabelBodyCoherenceIssueInput {
  readonly number: number;
  readonly title?: string;
  readonly labels: readonly string[];
  readonly body: string;
}

export interface LabelBodyCoherenceProbeInput {
  readonly listOpenReadyIssues: () => Promise<readonly LabelBodyCoherenceIssueInput[]>;
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
  confirmRelaunch?(finding: OperationalProbeResult): Promise<boolean>;
  setRemoteUrl?(name: string, url: string): Promise<void>;
  removeBranchLock?(): Promise<void>;
  writeBranchLock?(branch: string): Promise<void>;
  terminateSupervisor?(pid: number): Promise<boolean>;
  concedeClaim?(issue: number, body: string): Promise<void>;
  updateIssueBody?(issue: number, body: string): Promise<void>;
  relaunchFleet?(request: {
    readonly target?: number;
    readonly runner?: string;
    readonly args?: readonly string[];
  }): Promise<{ readonly status: string; readonly pid?: number | null }>;
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

import type { FastForwardLocalTargetGuardResult, FastForwardLocalTargetResult } from "../merge.js";

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
  readonly configCoherence?: ConfigCoherenceProbeInput;
  readonly fleetTruth?: FleetTruthProbeInput;
  readonly bundleCoherence?: BundleCoherenceProbeInput;
  readonly claimHygiene?: ClaimHygieneProbeInput;
  readonly labelBodyCoherence?: LabelBodyCoherenceProbeInput;
  readonly baseFreshness?: BaseFreshnessProbeInput;
  readonly hostPrerequisites?: HostPrerequisiteProbeInput;
}

export type HostPrerequisiteCommand = "bash" | "git" | "jq" | "gh" | "node" | "timeout" | "ps";

export interface HostPrerequisiteProbeInput {
  readonly commands: Readonly<Record<HostPrerequisiteCommand, boolean>>;
  /** The PATH the availability lookup searched, so a red verdict names WHERE it looked (#3064). */
  readonly searchedPath?: string;
  /** The node the engine itself runs on (`process.execPath`) — node's expected fallback (#3064). */
  readonly engineNodePath?: string;
  readonly bashVersion?: string;
  readonly bashVersionExitCode?: number;
  readonly bashVersionError?: string;
}

export interface ConfigCoherenceProbeInput {
  readonly path: string;
  readonly displayPath: string;
  readonly fileLoaded: boolean;
  readonly discarded: boolean;
  readonly parseFailure?: {
    readonly message: string;
    readonly line?: number;
    readonly construct?: string;
  };
  readonly rootAccessorCollisions: readonly {
    readonly key: string;
    readonly canonicalKey: string;
  }[];
  readonly resolved: {
    readonly trunk: string;
    readonly gate: string;
    readonly lock: string;
  };
  readonly sourceText?: string;
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
  readonly listEngineCandidates: () => Promise<readonly number[]>;
  readonly listRestQueue: () => Promise<readonly number[]>;
  readonly resampleDelayMs?: number;
}

export interface FleetTruthProbeInput {
  readonly supervisorPid?: number | null;
  readonly ownSupervisorPid?: number;
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

export interface BundleCoherenceProbeInput {
  readonly installedVersion?: string;
  readonly pointerVersion?: string;
  readonly laneNewestVersion?: string;
  readonly npmNewestVersion?: string;
  readonly npmError?: string;
  readonly lastFailureAgeMs?: number;
  readonly lastError?: string;
}

/** `expired` is not a pid observation: it marks an unknown-pid own-namespace
 * marker whose latest timestamp aged past the ADR 0066 claim-TTL window, so it
 * is concedable without ever proving the pid (#2525). */
export type ClaimHygieneWorkerPidState = "live" | "dead" | "foreign" | "unknown" | "expired";

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
  /** Injected clock (epoch seconds) enabling the claim-TTL classification of
   * unknown-pid own-namespace markers (#2525). Absent → TTL check skipped. */
  readonly nowS?: number;
  /** Claim staleness policy; defaults to the ADR 0066 window. */
  readonly staleness?: import("../claim-staleness.js").ClaimStalenessConfig;
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

export interface BaseFreshnessProbeInput {
  readonly trunk: string;
  readonly remote: string;
  readonly localSha?: string;
  readonly remoteSha?: string;
  readonly ahead?: number;
  readonly behind?: number;
  readonly remoteReachable: boolean;
  readonly guard: FastForwardLocalTargetGuardResult;
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
  removeBranchLock?(): Promise<void>;
  writeBranchLock?(branch: string): Promise<void>;
  terminateSupervisor?(pid: number): Promise<boolean>;
  fastForwardLocalBase?(request: {
    readonly remote: string;
    readonly target: string;
  }): Promise<FastForwardLocalTargetResult>;
  concedeClaim?(issue: number, body: string): Promise<void>;
  updateIssueBody?(issue: number, body: string): Promise<void>;
  readText?(path: string): Promise<string | null>;
  writeText?(path: string, text: string): Promise<void>;
  showDiffPreview?(finding: OperationalProbeResult, diff: string): Promise<void>;
}

export type OperationalProbeFixStatus = "applied" | "declined" | "noop";

export interface OperationalProbeFixResult {
  readonly probeId: string;
  readonly status: OperationalProbeFixStatus;
  readonly evidence: string;
  /**
   * The finding restated so its evidence agrees with what the fix actually did
   * (#3155). Present only when the fix could NOT apply and the original evidence
   * would otherwise stand as a passing verdict beside a repair that errored out;
   * every reporter must prefer this over the finding it was handed.
   */
  readonly reconciled?: OperationalProbeResult;
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

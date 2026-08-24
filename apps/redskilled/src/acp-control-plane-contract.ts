import type { NewSessionRequest } from "@agentclientprotocol/sdk";
import type {
  MobileTicketDispatchAnswer,
  MobileTicketDispatchParams,
  MobileWorkerStopAnswer,
  MobileWorkerStopParams,
} from "@reddb-io/protocol-acp";

import type { AcpSessionJournal } from "./acp-dispatch-intent.js";
import type { DemandTurnRecord, DemandTurnResult } from "./acp-demand-turn.js";
import type { HostBrainStore } from "./brain-store.js";
import type { RedskilledGithubGatewayRegistration } from "./github-gateway.js";
import type { RedskilledHostState } from "./host-state.js";
import type { ProjectMemoryStore } from "./memory-store.js";
import type { RedskilledPaths } from "./paths.js";
import type { AcpProjectWorkspace } from "./project-workspace.js";
import type { RedskilledProjectRegistrationRequest } from "./project-registration.js";
import type { StandingOrdersStore } from "./standing-orders.js";
import type { LaunchedWorker, RedskilledWorkerSpec } from "./worker-launch.js";

export interface PublicSession {
  readonly request: NewSessionRequest;
  readonly project: AcpProjectWorkspace;
  readonly dispatchJournal: AcpSessionJournal;
}

export interface DemandBirthTurn {
  readonly workspacePath: string;
  readonly prompt: string;
  readonly workItem?: string;
  readonly runner?: string;
  readonly ticket?: Readonly<Record<string, unknown>>;
  readonly workerId?: string;
  readonly onBorn?: (workerId: string) => void;
}

export interface RedskillsAcpControlPlane {
  readonly socketPath: string;
  runDemandTurn(request: DemandBirthTurn): Promise<DemandTurnResult>;
  close(): Promise<void>;
}

export interface StartRedskillsAcpControlPlaneOptions {
  readonly paths: RedskilledPaths;
  readonly startWorker: (spec: RedskilledWorkerSpec) => LaunchedWorker;
  readonly hostState: () => RedskilledHostState;
  readonly githubGateway?: RedskilledGithubGatewayRegistration;
  readonly hostAdministration?: boolean;
  readonly mobileTicketDispatch?: (
    params: MobileTicketDispatchParams,
  ) => Promise<MobileTicketDispatchAnswer>;
  readonly mobileWorkerStop?: (
    params: MobileWorkerStopParams,
  ) => Promise<MobileWorkerStopAnswer>;
  readonly evidenceRoot?: string;
  readonly evidenceTtlMs?: number;
  readonly clock?: () => string;
  readonly brainStore?: HostBrainStore;
  readonly memoryStore?: ProjectMemoryStore;
  readonly recordDemandTurn?: (record: DemandTurnRecord) => void;
  readonly registerProject?: (request: RedskilledProjectRegistrationRequest) => unknown;
  readonly releaseProject?: (projectLabel: string) => unknown;
  readonly workerPulse?: (pulse: { workerId: string; line?: string; issue?: string }) => void;
  readonly standingOrdersStore?: StandingOrdersStore;
  /**
   * Durable sink for failures the ACP surface would otherwise discard.
   *
   * The surface always answers its client (a refusal-shaped update, or a
   * destroyed socket); this hook is the daemon-side record of the same fact.
   * Optional so tests and thin embeddings run without an event lane.
   */
  readonly recordAcpFailure?: (failure: {
    readonly projectLabel: string;
    readonly detail: string;
    readonly surface: "connection" | "turn";
  }) => void;
}

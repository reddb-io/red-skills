import type { HostLinkStatus } from "./host-status";

export interface PairedHost {
  readonly id: string;
  readonly name: string;
  /** Derived from the last answered state read, never from the pairing record. */
  readonly status: HostLinkStatus;
}

export interface TicketDispatchRequest {
  readonly hostId: string;
  readonly issueUrl: string;
}

export interface TicketDispatchReceipt {
  readonly version: 1;
  readonly hostId: string;
  readonly repository: string;
  readonly ticket: number;
  readonly workerId: string;
  readonly sessionId?: string;
}

/**
 * The app-facing boundary for the Remote link protocol.
 *
 * Its production implementation will encode owned frames as TOON. Keeping the
 * interface transport-neutral prevents the preview from becoming a temporary
 * JSON wire that later clients accidentally depend on.
 */
export interface TicketDispatchGateway {
  dispatch(request: TicketDispatchRequest): Promise<TicketDispatchReceipt>;
}

export interface MobileWorker {
  readonly workerId: string;
  readonly repository: string;
  readonly ticket?: number | string;
  readonly startedAt: string;
  /** The phase the Host's project published; `null` when it published none. */
  readonly phase?: string | null;
  /** Age of the last published heartbeat at the snapshot instant. */
  readonly heartbeatAgeMs?: number | null;
  /** A dispatch receipt awaiting its first state read; reconciled, never kept. */
  readonly pending?: boolean;
}

/** One state read: the Worker rows plus the host facts they are dated by. */
export interface MobileHostSnapshot {
  readonly workers: readonly MobileWorker[];
  readonly daemonVersion: string | null;
  readonly generatedAt: string | null;
  /** The Host's own staleness verdict; `null` when the answer carried none. */
  readonly staleness: {
    readonly stale: boolean;
    readonly ageMs: number | null;
    readonly reason: string;
  } | null;
}

export interface MobileOperatorGateway extends TicketDispatchGateway {
  state(): Promise<MobileHostSnapshot>;
  stop(workerId: string): Promise<boolean>;
}

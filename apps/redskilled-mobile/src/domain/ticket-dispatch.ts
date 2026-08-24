export interface PairedHost {
  readonly id: string;
  readonly name: string;
  readonly status: "online" | "offline";
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
  readonly ticket?: number;
  readonly startedAt: string;
}

export interface MobileOperatorGateway extends TicketDispatchGateway {
  state(): Promise<readonly MobileWorker[]>;
  stop(workerId: string): Promise<boolean>;
}

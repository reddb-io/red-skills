// mobile-operator — the capability-scoped local ACP surface used by redskilled-link.
//
// The Remote link never forwards caller-named ACP methods. It projects these
// three typed operations and nothing else: observe the host, dispatch one
// existing GitHub Issue, and stop one Worker. Credentials, paths, shell input,
// runner selection and policy remain daemon verdicts (ADRs 0158, 0165, 0166).
import { RequestError } from "@agentclientprotocol/sdk";

import { REDSKILLS_ACP_METHODS } from "./methods.js";

export interface MobileTicketDispatchParams {
  readonly issue_url: string;
}

export interface MobileTicketDispatchAnswer {
  readonly version: 1;
  readonly repository: string;
  readonly ticket: number;
  readonly worker_id: string;
}

export interface MobileWorkerStopParams {
  readonly worker_id: string;
}

export interface MobileWorkerStopAnswer {
  readonly version: 1;
  readonly worker_id: string;
  readonly applied: boolean;
  readonly detail: string;
}

export interface MobileOperatorWorker {
  readonly worker_id: string;
  readonly project_label: string;
  readonly started_at: string;
}

export interface MobileOperatorStateAnswer {
  readonly version: 1;
  readonly daemon_version: string;
  readonly workers: readonly MobileOperatorWorker[];
}

export const MOBILE_OPERATOR_SCHEMA = {
  version: 1,
  methods: [
    REDSKILLS_ACP_METHODS.operatorState,
    REDSKILLS_ACP_METHODS.ticketDispatch,
    REDSKILLS_ACP_METHODS.workerStop,
  ],
} as const;

export function mobileTicketDispatchParams(value: unknown): MobileTicketDispatchParams {
  const record = exactRecord(value, ["issue_url"], "ticket_dispatch requires exactly one Issue URL");
  const issueUrl = typeof record.issue_url === "string" ? record.issue_url.trim() : "";
  if (issueUrl === "" || issueUrl.length > 2_048) {
    throw RequestError.invalidParams({}, "ticket_dispatch requires one bounded GitHub Issue URL");
  }
  return { issue_url: issueUrl };
}

export function mobileWorkerStopParams(value: unknown): MobileWorkerStopParams {
  const record = exactRecord(value, ["worker_id"], "worker_stop requires exactly one Worker id");
  const workerId = typeof record.worker_id === "string" ? record.worker_id.trim() : "";
  if (workerId === "" || workerId.length > 128) {
    throw RequestError.invalidParams({}, "worker_stop requires one bounded Worker id");
  }
  return { worker_id: workerId };
}

export function mobileOperatorStateParams(value: unknown): Record<string, never> {
  exactRecord(value, [], "operator_state accepts no caller-named scope");
  return {};
}

function exactRecord(
  value: unknown,
  allowed: readonly string[],
  detail: string,
): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw RequestError.invalidParams({}, detail);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0 || allowed.some((key) => !(key in value))) {
    throw RequestError.invalidParams({ unknown_fields: unknown }, detail);
  }
  return value as Record<string, unknown>;
}

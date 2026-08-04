// help.ts — the castle's one live source of operating choreography (ADR 0134).
//
// The answer is deliberately assembled from the same two socket-local reads an
// operator already has: project_status and host_state. It never asks the issue
// tracker for a fresher queue. The daemon's last registration poll and demand
// refusal are the live facts, and every next action is rendered through the
// shared repair composer so the prose cannot name a different mechanism.

import {
  composeRepair,
  type RepairAction,
} from "@reddb-io/shared/repair.js";
import type { ProjectStatusOutput } from "./contracts.js";
import type { CastleMcpTool } from "./tool.js";

export interface HelpDependencies {
  projectStatus(): Promise<ProjectStatusOutput>;
  hostState(): Promise<unknown>;
}

export interface HelpIntent {
  readonly name: string;
  readonly title: string;
}

export interface HelpIntentGroup {
  readonly intent: string;
  readonly tools: readonly HelpIntent[];
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** The daemon's most recent demand refusal, when one still stands. PURE. */
function lastRefusal(hostState: unknown): string | null {
  const host = record(hostState);
  if (host === null) return null;
  const demand = record(host.demand);
  return text(demand?.refusal) ?? text(host.latest_refusal);
}

function inspectAgain(why: string): RepairAction {
  return {
    tool: "project_status",
    args: {},
    why,
  };
}

function daemonRepair(): RepairAction {
  return {
    tool: "host_provision_check",
    args: {},
    why: "diagnose why the host daemon does not answer before changing registration",
  };
}

function nextAction(
  status: ProjectStatusOutput,
  refusal: string | null,
): RepairAction {
  const registration = status.registration;
  if (!registration.daemon_reachable) return daemonRepair();
  if (!registration.held && registration.repair !== undefined && registration.repair !== "none") {
    return registration.repair;
  }
  if (status.live_workers.length > 0 && refusal === null) {
    return {
      tool: "worker_vitals",
      args: {},
      why: "observe the Workers already draining this project's queue",
    };
  }
  if (refusal !== null) {
    return inspectAgain("observe when the daemon's refusal clears and capacity begins draining again");
  }
  return inspectAgain("observe the next socket-local queue poll and Worker birth");
}

function location(status: ProjectStatusOutput): string {
  const registration = status.registration;
  if (!registration.daemon_reachable) {
    return "daemon unreachable: this project cannot read or change its host registration";
  }
  if (!registration.held) {
    return "unregistered: the daemon is reachable but holds no registration for this project";
  }
  const depth = registration.last_poll?.depth;
  const queue = depth === null || depth === undefined ? "an unknown queue" : `${depth} queued`;
  return `draining: ${status.slots.busy} of ${status.slots.total} Worker slots are busy with ${queue}`;
}

/**
 * The intent map is a projection of the live table, never a second list.
 *
 * Keeping one compact group preserves the table's published order and makes a
 * newly added or renamed tool appear automatically. Titles carry the intent;
 * names are the pasteable calls.
 */
function intentMap(tools: readonly CastleMcpTool[]): readonly HelpIntentGroup[] {
  return [{
    intent: "choose the capability that matches your intent",
    tools: tools.map(({ name, title }) => ({ name, title })),
  }];
}

export function createHelpTools(
  deps: HelpDependencies,
  toolTable: () => readonly CastleMcpTool[],
): CastleMcpTool[] {
  return [{
    name: "help",
    title: "Find the next castle action",
    description:
      "Read live daemon, registration, queue, Worker, and refusal state; return the pasteable next call and a generated intent map. Makes no GitHub request.",
    inputSchema: {},
    invoke: async () => {
      const [status, host] = await Promise.all([
        deps.projectStatus(),
        deps.hostState().catch(() => null),
      ]);
      const here = location(status);
      const refusal = lastRefusal(host);
      const next = nextAction(status, refusal);
      const composed = composeRepair({ state: `you are ${here}`, repair: next });
      if (composed.repair === "none") throw new Error("help produced no callable next action");

      return {
        here,
        state: {
          daemon: {
            reachable: status.registration.daemon_reachable,
            version: text(record(host)?.daemon_version) ?? "",
          },
          registration: {
            held: status.registration.held,
            project: status.registration.project,
            renewal: status.registration.renewal,
            target: status.registration.target,
          },
          queue: status.registration.last_poll == null
            ? null
            : {
                at: status.registration.last_poll.at,
                outcome: status.registration.last_poll.outcome,
                depth: status.registration.last_poll.depth,
                detail: status.registration.last_poll.detail,
              },
          workers: {
            busy: status.slots.busy,
            free: status.slots.free,
            live: status.live_workers.length,
            target: status.slots.total,
          },
          last_refusal: refusal,
          warnings: status.warnings ?? [],
        },
        guidance: composed.prose,
        next: composed.repair,
        intent_map: intentMap(toolTable()),
      };
    },
  }];
}

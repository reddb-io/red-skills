/**
 * status-report — one screen answering "is the whole link chain alive".
 *
 * Three authorities, each quoted rather than merged: the HOST's redskilled
 * (asked over the operator ACP surface, probe-only — a status read must never
 * provision the daemon it reports on), systemd for the Host companion unit,
 * and the published `status.json` for what the link has done. An absence in
 * any of the three is stated with its reason, never blended into a calm line.
 */
import type { RedskillsOperatorAcpClient } from "@reddb-io/redskilled/acp-operator-client";

import type { RedskilledLinkPublicStatus } from "./state.js";
import type { RedskilledLinkUnitStatus } from "./supervision.js";

/** The v2 operator answer, named through the client that serves it so this
 * app keeps exactly one dependency edge onto the daemon. */
type MobileOperatorStateAnswer = Awaited<ReturnType<RedskillsOperatorAcpClient["state"]>>;

export interface LinkStatusReportInput {
  readonly daemon:
    | { readonly reachable: true; readonly state: MobileOperatorStateAnswer }
    | { readonly reachable: false; readonly reason: string };
  readonly unit: RedskilledLinkUnitStatus;
  readonly published: RedskilledLinkPublicStatus | null;
  readonly publishedPath: string;
}

/** Render the report. PURE — every fact arrives as an argument. */
export function renderLinkStatusReport(input: LinkStatusReportInput): string {
  const lines: string[] = [];

  if (!input.daemon.reachable) {
    lines.push(`Host daemon: unreachable — ${input.daemon.reason}`);
  } else {
    const state = input.daemon.state;
    const staleness = state.host.staleness;
    const freshness = staleness == null
      ? "freshness unmeasured"
      : staleness.stale
        ? `STALE (${staleness.reason})`
        : staleness.reason;
    lines.push(
      `Host daemon: v${state.host.daemon_version} · ${state.workers.length} Worker(s)` +
        ` · ceiling ${state.host.worker_ceiling ?? "∞"} · ${freshness}`,
    );
    for (const worker of state.workers) {
      const heartbeat = worker.heartbeat_age_ms == null
        ? "no heartbeat published"
        : `hb ${Math.round(worker.heartbeat_age_ms / 1000)}s ago`;
      lines.push(
        `  ${worker.worker_id} ${worker.repository ?? worker.project_label}` +
          `${worker.ticket == null ? "" : ` #${worker.ticket}`}` +
          ` ${worker.phase ?? "unpublished"} (${heartbeat})`,
      );
    }
  }

  lines.push(
    `Link unit: ${input.unit.active ?? "unknown (systemd did not answer)"}` +
      ` (${input.unit.enabled ?? "enablement unknown"})`,
  );

  lines.push(
    input.published == null
      ? `Paired devices: none published at ${input.publishedPath} (the companion has not written a status yet)`
      : `Paired devices: ${input.published.active_paired_device_count}`,
  );

  return `${lines.join("\n")}\n`;
}

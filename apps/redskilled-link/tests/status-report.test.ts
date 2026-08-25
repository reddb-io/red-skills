// One screen, three authorities, absences stated: the report quotes the HOST's
// redskilled (probe-only), systemd's words for the companion unit, and the
// published status.json — and an absence in any of the three carries its
// reason instead of blending into a calm line.
import { describe, expect, it } from "vitest";

import { renderLinkStatusReport } from "../src/status-report.js";
import { REDSKILLED_LINK_UNIT_NAME } from "../src/supervision.js";

const unit = { unitName: REDSKILLED_LINK_UNIT_NAME, active: "active", enabled: "enabled" } as const;

describe("the link status report", () => {
  it("quotes the daemon's v2 answer: version, workers with phase and heartbeat, freshness", () => {
    const report = renderLinkStatusReport({
      daemon: {
        reachable: true,
        state: {
          version: 2,
          daemon_version: "4.2.6",
          workers: [{
            worker_id: "W1",
            project_label: "reddb-io/red-skills",
            started_at: "2026-08-24T12:00:00.000Z",
            phase: "coding",
            heartbeat_age_ms: 3_000,
            repository: "reddb-io/red-skills",
            ticket: "4321",
          }],
          host: {
            daemon_version: "4.2.6",
            started_at: "2026-08-24T08:00:00.000Z",
            worker_ceiling: 4,
            staleness: { stale: false, age_ms: 5_000, threshold_ms: 30_000, reason: "measured 5s ago" },
            generated_at: "2026-08-24T12:00:05.000Z",
          },
        },
      },
      unit,
      published: { version: 1, active_paired_device_count: 2 },
      publishedPath: "/home/x/.red/redskilled/link/status.json",
    });

    expect(report).toContain("Host daemon: v4.2.6 · 1 Worker(s) · ceiling 4 · measured 5s ago");
    expect(report).toContain("W1 reddb-io/red-skills #4321 coding (hb 3s ago)");
    expect(report).toContain("Link unit: active (enabled)");
    expect(report).toContain("Paired devices: 2");
  });

  it("an unreachable daemon is an outage with its reason, never a calm blank", () => {
    const report = renderLinkStatusReport({
      daemon: { reachable: false, reason: "connect ENOENT /run/redskilled/acp.sock" },
      unit: { unitName: REDSKILLED_LINK_UNIT_NAME, active: null, enabled: null },
      published: null,
      publishedPath: "/home/x/.red/redskilled/link/status.json",
    });

    expect(report).toContain("Host daemon: unreachable — connect ENOENT");
    expect(report).toContain("unknown (systemd did not answer)");
    expect(report).toContain("none published at /home/x/.red/redskilled/link/status.json");
  });

  it("a worker the project never published renders unpublished, not invented", () => {
    const report = renderLinkStatusReport({
      daemon: {
        reachable: true,
        state: {
          version: 2,
          daemon_version: "4.2.6",
          workers: [{
            worker_id: "W2",
            project_label: "acme/widgets",
            started_at: "2026-08-24T12:00:00.000Z",
            phase: null,
            heartbeat_age_ms: null,
            repository: null,
            ticket: null,
          }],
          host: {
            daemon_version: "4.2.6",
            started_at: "2026-08-24T08:00:00.000Z",
            worker_ceiling: null,
            staleness: null,
            generated_at: "2026-08-24T12:00:05.000Z",
          },
        },
      },
      unit,
      published: { version: 1, active_paired_device_count: 0 },
      publishedPath: "/x/status.json",
    });

    expect(report).toContain("ceiling ∞ · freshness unmeasured");
    expect(report).toContain("W2 acme/widgets unpublished (no heartbeat published)");
    expect(report).toContain("Paired devices: 0");
  });
});

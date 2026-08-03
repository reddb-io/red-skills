import { describe, expect, it } from "vitest";
import type { CompactWorker } from "../src/core/monitor.js";
import { renderWorkerCompactLine } from "../src/core/monitor.js";
import { renderWorkerLine } from "../src/core/statusline-style.js";
import { workerDisplayFromState } from "../src/core/worker-display-record.js";
import { AfkStateSchema } from "../src/types/state.js";

const NOW_S = 2_000_000;
const NOW_MS = NOW_S * 1000;
const WAIT_STARTED_AT = new Date(NOW_MS - 192_000).toISOString();

function state(waiting: boolean) {
  return AfkStateSchema.parse({
    worker_id: "wGATE",
    pid: 4242,
    runner: "codex",
    started_at: new Date(NOW_MS - 3_600_000).toISOString(),
    total: 1,
    current: {
      number: 3182,
      title: "show gate liveness",
      activity: "review",
      phase: "validating",
      started_at: new Date(NOW_MS - 3_600_000).toISOString(),
      ...(waiting
        ? {
            wait_kind: "gate",
            wait_subject: "pnpm test",
            wait_pid: 9001,
            wait_started_at: WAIT_STARTED_AT,
            wait_deadline: "process exit",
            wait_escalation: "fail the validation stage",
          }
        : {}),
    },
  });
}

function worker(waiting: boolean): CompactWorker {
  return {
    state: state(waiting),
    live: true,
    pidLive: true,
    livenessVerdict: {
      status: "alive",
      laneFresh: false,
      laneAgeMs: 7 * 60_000,
      liveDescendants: true,
      crossCheckArmed: true,
      reason: "agent lane idle but gate child is live",
    },
  };
}

describe("gate child declared-wait display (#3182)", () => {
  it("publishes the child command, pid, start, deadline, and escalation", () => {
    expect(workerDisplayFromState(state(true), { etaSeconds: null, nowMs: NOW_MS })).toMatchObject({
      wait_kind: "gate",
      wait_subject: "pnpm test",
      wait_pid: 9001,
      wait_started_at: WAIT_STARTED_AT,
      wait_deadline: "process exit",
      wait_escalation: "fail the validation stage",
    });
  });

  it("renders an explained gate wait from the child's own start instead of stale agent heartbeat", () => {
    const statusline = renderWorkerLine(worker(true), NOW_S).replace(/\x1b\[[0-9;]*m/g, "");
    const monitor = renderWorkerCompactLine(worker(true), NOW_S);

    expect(statusline).toContain("gate=pnpm test 3m12s");
    expect(statusline).not.toContain("hb=~7m+");
    expect(monitor).toContain("[wait]");
    expect(monitor).toContain("gate=pnpm test 3m12s");
    expect(monitor).not.toContain("[quiet]");
  });

  it("keeps an unexplained silence visually alarming", () => {
    const statusline = renderWorkerLine(worker(false), NOW_S).replace(/\x1b\[[0-9;]*m/g, "");
    const monitor = renderWorkerCompactLine(worker(false), NOW_S);

    expect(statusline).toContain("hb=~7m+");
    expect(monitor).toContain("[quiet]");
    expect(statusline).not.toContain("gate=");
    expect(monitor).not.toContain("gate=");
  });
});

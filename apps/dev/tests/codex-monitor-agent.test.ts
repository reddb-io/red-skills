import { describe, expect, it } from "vitest";
import { codexMonitorAgentCommand } from "../src/commands/codex-monitor-agent.js";
import {
  decideCodexMonitorAgent,
  renderCodexMonitorAgentPrompt,
} from "../src/core/codex-monitor-agent.js";

function sink(): { stream: NodeJS.WritableStream; text: () => string } {
  let buf = "";
  const stream = {
    write(chunk: string | Uint8Array): boolean {
      buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { stream, text: () => buf };
}

describe("codex monitor agent decision", () => {
  it("spawns for Codex run/fleet launches when a subagent primitive exists", () => {
    expect(decideCodexMonitorAgent({
      runner: "codex",
      command: "run",
      subagentAvailable: true,
    })).toEqual({ spawn: true, reason: "spawn" });
    expect(decideCodexMonitorAgent({
      runner: "CODEX",
      command: "fleet",
      subagentAvailable: true,
    })).toEqual({ spawn: true, reason: "spawn" });
  });

  it("does not spawn for supervised, dry-run, non-Codex, or non-launch commands", () => {
    expect(decideCodexMonitorAgent({
      runner: "claude",
      command: "run",
      subagentAvailable: true,
    }).reason).toBe("not-codex-runner");
    expect(decideCodexMonitorAgent({
      runner: "codex",
      command: "run",
      subagentAvailable: false,
    }).reason).toBe("subagent-unavailable");
    expect(decideCodexMonitorAgent({
      runner: "codex",
      command: "run",
      subagentAvailable: true,
      once: true,
    }).reason).toBe("single-supervised-run");
    expect(decideCodexMonitorAgent({
      runner: "codex",
      command: "run",
      subagentAvailable: true,
      bootOnly: true,
    }).reason).toBe("boot-only");
    expect(decideCodexMonitorAgent({
      runner: "codex",
      command: "monitor",
      subagentAvailable: true,
    }).reason).toBe("command-does-not-launch-worker");
  });
});

describe("codex monitor agent prompt", () => {
  it("renders a read-only monitor contract for the spawned presentation agent", () => {
    const prompt = renderCodexMonitorAgentPrompt({
      projectRoot: "/repo",
      mode: "fleet",
      intervalSeconds: 10,
    });
    expect(prompt).toContain("Project root: /repo");
    expect(prompt).toContain("AFK launch mode: fleet");
    expect(prompt).toContain("Every 10 seconds");
    expect(prompt).toContain("redskilled `status` tool");
    expect(prompt).toContain("`scope: worker`");
    expect(prompt).not.toContain("redskilled `monitor` tool");
    expect(prompt).not.toContain("`worker_vitals`");
    expect(prompt).toContain("no-MCP fallback");
    expect(prompt).toContain("env RED_AFK_RUNNER=codex red-skills-dev monitor --once");
    expect(prompt).not.toContain(`${"r"}${"t"}${"k"} `);
    expect(prompt).toContain("red-skills-dev monitor --once");
    expect(prompt).toContain("monitor --once");
    expect(prompt).toContain("Do not edit files.");
    expect(prompt).toContain("Do not run /dev:afk run");
    expect(prompt).toContain("Do not repair state. Only observe and report.");
    expect(prompt).toContain("Exit once there is no live .red/tmp/supervisors/default/afk-supervisor.pid");
    expect(prompt).toContain("no [live] or [quiet] workers");
  });

  it("prints prompt JSON for host-layer spawn tooling", async () => {
    const out = sink();
    await codexMonitorAgentCommand([
      "--project-root",
      "/repo",
      "--mode",
      "run",
      "--interval-seconds",
      "15",
      "--json",
    ], out.stream);
    const payload = JSON.parse(out.text()) as {
      projectRoot: string;
      mode: string;
      intervalSeconds: number;
      prompt: string;
    };
    expect(payload.projectRoot).toBe("/repo");
    expect(payload.mode).toBe("run");
    expect(payload.intervalSeconds).toBe(15);
    expect(payload.prompt).toContain("read-only Codex AFK monitor agent");
  });
});

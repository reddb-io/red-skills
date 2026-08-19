import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { RequestError } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import { createWorkerTerminalHost } from "./terminal-host.js";
import type { WorkerTerminalDenial } from "./terminal-policy.js";

interface RecordedSpawn {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly env: NodeJS.ProcessEnv;
}

function recordingHost(env: NodeJS.ProcessEnv = { PATH: "/usr/bin" }) {
  const spawns: RecordedSpawn[] = [];
  const denials: WorkerTerminalDenial[] = [];
  const spawn = ((command: string, args: readonly string[], options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  }) => {
    spawns.push({ command, args, cwd: options.cwd, env: options.env ?? {} });
    return {
      stdout: null,
      stderr: null,
      once: () => undefined,
      kill: () => true,
    } as unknown as ChildProcess;
  }) as unknown as typeof nodeSpawn;
  const host = createWorkerTerminalHost({
    cwd: "/worktree",
    env,
    spawn,
    onDenial: (denial) => denials.push(denial),
  });
  return { host, spawns, denials };
}

describe("the Worker's terminal host", () => {
  it("runs an ordinary command in the Worktree", () => {
    const { host, spawns, denials } = recordingHost();

    const created = host.create({ sessionId: "s", command: "pnpm", args: ["test"] });

    expect(created.terminalId).toBeTruthy();
    expect(spawns).toEqual([
      { command: "pnpm", args: ["test"], cwd: "/worktree", env: { PATH: "/usr/bin" } },
    ]);
    expect(denials).toEqual([]);
  });

  it("refuses git push and gh, and starts no process for either", () => {
    const { host, spawns, denials } = recordingHost();

    for (const request of [
      { sessionId: "s", command: "git", args: ["push", "origin", "HEAD"] },
      { sessionId: "s", command: "gh", args: ["pr", "create", "--fill"] },
    ]) {
      expect(() => host.create(request)).toThrow(RequestError);
    }

    expect(spawns).toEqual([]);
    expect(denials.map((denial) => denial.reason))
      .toEqual(["publication-is-parent-owned", "forge-cli-is-parent-owned"]);
  });

  it("hands the refusal back as a typed payload rather than as prose", () => {
    const { host } = recordingHost();

    let thrown: unknown;
    try {
      host.create({ sessionId: "s", command: "git", args: ["push"] });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RequestError);
    expect((thrown as RequestError).data).toMatchObject({
      redskills: { terminalPolicy: { decision: "deny", reason: "publication-is-parent-owned" } },
    });
    expect((thrown as RequestError).message).toContain("publication-is-parent-owned");
  });

  // The braces behind the policy's belt: even a request that names a credential
  // outright cannot put one into a process the Worker starts.
  it("drops a credential name the request declares for itself", () => {
    const { host, spawns } = recordingHost({ PATH: "/usr/bin" });

    host.create({
      sessionId: "s",
      command: "pnpm",
      args: ["test"],
      env: [
        { name: "GITHUB_TOKEN", value: "smuggled" },
        { name: "RED_MODE", value: "spec-driven" },
      ],
    });

    expect(spawns[0]!.env).toEqual({ PATH: "/usr/bin", RED_MODE: "spec-driven" });
  });

  it("refuses to answer for a terminal it never minted", () => {
    const { host } = recordingHost();

    expect(() => host.output({ sessionId: "s", terminalId: "invented" })).toThrow(RequestError);
  });
});

describe("the Worker's terminal host, running real commands", () => {
  it("returns the output and the exit status of a command it allowed", async () => {
    const host = createWorkerTerminalHost({ cwd: process.cwd(), env: process.env });

    const created = host.create({
      sessionId: "s",
      command: process.execPath,
      args: ["-e", "process.stdout.write('worktree-ok'); process.exit(3)"],
    });
    const exit = await host.waitForExit({ sessionId: "s", terminalId: created.terminalId });

    expect(exit.exitCode).toBe(3);
    expect(host.output({ sessionId: "s", terminalId: created.terminalId })).toMatchObject({
      output: "worktree-ok",
      truncated: false,
      exitStatus: { exitCode: 3 },
    });
    host.release({ sessionId: "s", terminalId: created.terminalId });
  });

  it("keeps the tail when the output passes the caller's byte limit", async () => {
    const host = createWorkerTerminalHost({ cwd: process.cwd(), env: process.env });

    const created = host.create({
      sessionId: "s",
      command: process.execPath,
      args: ["-e", "process.stdout.write('a'.repeat(64) + 'TAIL')"],
      outputByteLimit: 8,
    });
    await host.waitForExit({ sessionId: "s", terminalId: created.terminalId });

    const output = host.output({ sessionId: "s", terminalId: created.terminalId });
    expect(output.truncated).toBe(true);
    expect(output.output.endsWith("TAIL")).toBe(true);
    expect(output.output.length).toBeLessThanOrEqual(8);
    host.release({ sessionId: "s", terminalId: created.terminalId });
  });
});

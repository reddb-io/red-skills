import { describe, expect, it } from "vitest";
import { runOperationalProbes } from "../src/core/operational-probes.js";
import type { ExecFn } from "../src/runtime/exec.js";
import { collectHostPrerequisiteProbeInput } from "../src/runtime/wire/boot.js";
import { facts, makeDeps, options, runBoot } from "./boot.helpers.js";

describe("AFK host prerequisite boot probe", () => {
  it("is the first registered operational probe", async () => {
    const report = await runOperationalProbes({
      remoteUrls: [],
      hostPrerequisites: {
        commands: {
          bash: true,
          git: true,
          jq: true,
          gh: true,
          node: true,
          timeout: true,
          ps: true,
        },
        bashVersion: "GNU bash, version 5.2.15(1)-release",
      },
    });

    expect(report.probes[0]).toMatchObject({
      id: "afk.host-prerequisites",
      verdict: "ok",
      evidence: "all required host tools are available",
    });
  });

  it("collects command availability and the bash version through the process boundary", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const exec: ExecFn = async (command, args) => {
      calls.push({ command, args });
      if (command === "bash") {
        return { code: 0, stdout: "GNU bash, version 5.2.15(1)-release\n", stderr: "" };
      }
      const tool = args[3];
      return { code: tool === "jq" ? 127 : 0, stdout: "", stderr: "" };
    };

    await expect(collectHostPrerequisiteProbeInput(exec)).resolves.toEqual({
      commands: {
        bash: true,
        git: true,
        jq: false,
        gh: true,
        node: true,
        timeout: true,
        ps: true,
      },
      bashVersion: "GNU bash, version 5.2.15(1)-release\n",
    });
    expect(calls).toEqual([
      { command: "sh", args: ["-c", 'command -v "$1" >/dev/null 2>&1', "host-prereq", "bash"] },
      { command: "sh", args: ["-c", 'command -v "$1" >/dev/null 2>&1', "host-prereq", "git"] },
      { command: "sh", args: ["-c", 'command -v "$1" >/dev/null 2>&1', "host-prereq", "jq"] },
      { command: "sh", args: ["-c", 'command -v "$1" >/dev/null 2>&1', "host-prereq", "gh"] },
      { command: "sh", args: ["-c", 'command -v "$1" >/dev/null 2>&1', "host-prereq", "node"] },
      { command: "sh", args: ["-c", 'command -v "$1" >/dev/null 2>&1', "host-prereq", "timeout"] },
      { command: "sh", args: ["-c", 'command -v "$1" >/dev/null 2>&1', "host-prereq", "ps"] },
      { command: "bash", args: ["--version"] },
    ]);
  });

  it("halts before bootstrap with an actionable fix when jq is missing", async () => {
    const { deps, calls } = makeDeps();

    await expect(
      runBoot(
        deps,
        options({
          precheck: facts({
            hostPrerequisites: {
              commands: {
                bash: true,
                git: true,
                jq: false,
                gh: true,
                node: true,
                timeout: true,
                ps: true,
              },
              bashVersion: "GNU bash, version 5.2.15(1)-release",
            },
          }),
        }),
      ),
    ).rejects.toMatchObject({
      phase: "host-prereq",
      probe: {
        id: "afk.host-prerequisites",
        evidence: "missing required host tools: jq",
        canonicalFix: expect.stringMatching(/command -v jq$/),
      },
    });
    expect(calls).toEqual([]);
  });

  it("halts before bootstrap when bash is older than the hook baseline", async () => {
    const { deps, calls } = makeDeps();

    await expect(
      runBoot(
        deps,
        options({
          precheck: facts({
            hostPrerequisites: {
              commands: {
                bash: true,
                git: true,
                jq: true,
                gh: true,
                node: true,
                timeout: true,
                ps: true,
              },
              bashVersion: "GNU bash, version 3.1.23(1)-release",
            },
          }),
        }),
      ),
    ).rejects.toMatchObject({
      phase: "host-prereq",
      probe: {
        evidence: "bash 3.1.23 is older than required 3.2.0",
        canonicalFix: expect.stringMatching(/bash --version$/),
      },
    });
    expect(calls).toEqual([]);
  });
});

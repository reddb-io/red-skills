import { describe, expect, it } from "vitest";
import { runOperationalProbes } from "../src/core/operational-probes.js";
import {
  HOST_PREREQUISITE_COMMANDS,
  runHostPrerequisiteProbe,
} from "../src/core/operational-probes/host-prerequisites.js";
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

    await expect(
      collectHostPrerequisiteProbeInput(exec, {
        env: { PATH: "/usr/bin:/bin" },
        execPath: "/opt/node/bin/node",
        exists: () => true,
      }),
    ).resolves.toEqual({
      commands: {
        bash: true,
        git: true,
        jq: false,
        gh: true,
        node: true,
        timeout: true,
        ps: true,
      },
      searchedPath: "/usr/bin:/bin",
      engineNodePath: "/opt/node/bin/node",
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

  it("preserves a failed bash version command for the operational diagnostic", async () => {
    const exec: ExecFn = async (command) => {
      if (command === "bash") {
        return { code: 2, stdout: "", stderr: "bash: cannot execute" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    await expect(collectHostPrerequisiteProbeInput(exec)).resolves.toMatchObject({
      bashVersion: "",
      bashVersionExitCode: 2,
      bashVersionError: "bash: cannot execute",
    });
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
              searchedPath: "/usr/bin:/bin",
              bashVersion: "GNU bash, version 5.2.15(1)-release",
            },
          }),
        }),
      ),
    ).rejects.toMatchObject({
      phase: "host-prereq",
      probe: {
        id: "afk.host-prerequisites",
        evidence: "missing required host tools: jq (searched PATH: /usr/bin, /bin)",
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

  it("halts before bootstrap when the bash version cannot be determined", async () => {
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
              bashVersion: "",
              bashVersionExitCode: 2,
              bashVersionError: "bash: cannot execute",
            },
          }),
        }),
      ),
    ).rejects.toMatchObject({
      phase: "host-prereq",
      probe: {
        evidence: "bash --version exited 2: bash: cannot execute",
        canonicalFix: expect.stringMatching(/bash --version$/),
      },
    });
    expect(calls).toEqual([]);
  });

  it("fires before claim acquisition or any boot sweep when a prerequisite is missing", async () => {
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
                node: false,
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
        evidence: expect.stringContaining("node"),
        canonicalFix: expect.stringContaining("command -v node"),
      },
    });
    // Probe is step 0 of runBoot — no fs, gh, or git IO ran.
    // Structurally, the session loop (claim acquisition, snapshots, hooks)
    // only starts after runBoot returns successfully, so it is unreachable
    // when the probe halts here.
    expect(calls).toEqual([]);
  });

  it("all-present: boot continues past the host-prereq step without halting", async () => {
    const { deps } = makeDeps();

    // When all prerequisites are present the probe returns ok and runBoot
    // proceeds to the precheck/bootstrap steps (it does not throw BootHaltError).
    const result = await runBoot(
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
            bashVersion: "GNU bash, version 5.2.15(1)-release",
          },
        }),
      }),
    );

    expect(result.precheck?.ok).toBe(true);
  });
});

describe("each missing host tool produces a named halt with its fix string", () => {
  type Cmd = (typeof HOST_PREREQUISITE_COMMANDS)[number];
  const allPresent: Record<Cmd, boolean> = {
    bash: true,
    git: true,
    jq: true,
    gh: true,
    node: true,
    timeout: true,
    ps: true,
  };

  for (const tool of HOST_PREREQUISITE_COMMANDS) {
    it(`${tool} missing → halt names "${tool}" with command-v fix`, () => {
      const result = runHostPrerequisiteProbe({
        remoteUrls: [],
        hostPrerequisites: {
          commands: { ...allPresent, [tool]: false },
          bashVersion: "GNU bash, version 5.2.15(1)-release",
        },
      });

      expect(result.verdict).toBe("red");
      expect(result.evidence).toContain(tool);
      expect(result.canonicalFix).toContain(`command -v ${tool}`);
    });
  }
});

describe("the engine's own node is the node the probe resolves (#3064)", () => {
  const versionManagerHost = {
    // The operator's node lives ONLY under the version manager's install root,
    // which the Worker's sanitized PATH does not carry.
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    execPath: "/home/posed/.local/share/mise/installs/node/lts/bin/node",
  };
  const pathOnlyExec: ExecFn = async (command, args) => {
    if (command === "bash") return { code: 0, stdout: "GNU bash, version 5.2.15(1)-release\n", stderr: "" };
    return { code: args[3] === "node" ? 127 : 0, stdout: "", stderr: "" };
  };

  it("boots green when node exists only outside the sanitized PATH", async () => {
    const input = await collectHostPrerequisiteProbeInput(pathOnlyExec, {
      ...versionManagerHost,
      exists: (path) => path === versionManagerHost.execPath,
    });

    expect(input.commands.node).toBe(true);
    expect(runHostPrerequisiteProbe({ remoteUrls: [], hostPrerequisites: input })).toMatchObject({
      verdict: "ok",
      evidence: "all required host tools are available",
    });
  });

  it("still fails when the engine's own interpreter is gone too, naming where it looked", async () => {
    const input = await collectHostPrerequisiteProbeInput(pathOnlyExec, {
      ...versionManagerHost,
      exists: () => false,
    });

    const result = runHostPrerequisiteProbe({ remoteUrls: [], hostPrerequisites: input });
    expect(result.verdict).toBe("red");
    expect(result.evidence).toContain("missing required host tools: node");
    expect(result.evidence).toContain("searched PATH: /usr/local/bin, /usr/bin, /bin");
    expect(result.evidence).toContain(versionManagerHost.execPath);
    expect(result.data).toMatchObject({
      missing: ["node"],
      searchedDirectories: ["/usr/local/bin", "/usr/bin", "/bin"],
      engineNodePath: versionManagerHost.execPath,
    });
  });

  it("names the searched directories for a tool that is genuinely missing", () => {
    const result = runHostPrerequisiteProbe({
      remoteUrls: [],
      hostPrerequisites: {
        commands: { bash: true, git: true, jq: false, gh: true, node: true, timeout: true, ps: true },
        searchedPath: "/usr/bin:/bin",
        engineNodePath: "/opt/node/bin/node",
        bashVersion: "GNU bash, version 5.2.15(1)-release",
      },
    });

    expect(result.verdict).toBe("red");
    expect(result.evidence).toBe("missing required host tools: jq (searched PATH: /usr/bin, /bin)");
    // jq is not node: the engine's interpreter is no fallback for it.
    expect(result.evidence).not.toContain("/opt/node/bin/node");
  });

  it("says the PATH was empty rather than naming nothing", () => {
    const result = runHostPrerequisiteProbe({
      remoteUrls: [],
      hostPrerequisites: {
        commands: { bash: true, git: true, jq: true, gh: true, node: false, timeout: true, ps: true },
        searchedPath: "",
        bashVersion: "GNU bash, version 5.2.15(1)-release",
      },
    });

    expect(result.evidence).toContain("PATH was empty");
  });
});

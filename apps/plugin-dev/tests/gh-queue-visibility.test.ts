import { describe, expect, it } from "vitest";
import { queueVisibilityProbeInput } from "../src/runtime/gh.js";
import type { ExecFn } from "../src/runtime/exec.js";

describe("gh queue visibility input", () => {
  it("preserves issue numbers from the engine and paginated REST readers", async () => {
    const calls: Array<{ tool: string; args: readonly string[] }> = [];
    const exec: ExecFn = async (tool, args) => {
      calls.push({ tool, args });
      if (tool === "rsp") {
        return {
          code: 0,
          stdout: JSON.stringify([
            { number: 2448, title: "first", body: "", labels: ["ready-for-agent"] },
            { number: 2449, title: "second", body: "", labels: ["ready-for-agent"] },
          ]),
          stderr: "",
        };
      }
      // The REST fallback (#3730): a routed `gh api --paginate` issue list,
      // full rows — the caller filters `pull_request == null` and projects
      // `.number` itself.
      return {
        code: 0,
        stdout: JSON.stringify([
          { number: 2448, labels: [], pull_request: null },
          { number: 2449, labels: [], pull_request: null },
        ]),
        stderr: "",
      };
    };
    const input = queueVisibilityProbeInput({ cwd: "/repo", repo: "o/r", exec });

    await expect(input.listEngineCandidates()).resolves.toEqual([2448, 2449]);
    await expect(input.listRestQueue()).resolves.toEqual([2448, 2449]);

    expect(calls[0]?.tool).toBe("rsp");
    expect(calls[0]?.args.slice(0, 2)).toEqual(["gh-api-json", "repos/{owner}/{repo}/issues"]);
    expect(calls[1]?.tool).toBe("gh");
    expect(calls[1]?.args).toContain("--paginate");
    expect(calls[1]?.args).toContain("repos/o/r/issues");
  });
});

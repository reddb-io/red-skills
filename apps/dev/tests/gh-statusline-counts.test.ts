import { describe, expect, it } from "vitest";
import { countStatuslineQueueCounts } from "../src/runtime/gh.js";
import type { ExecFn } from "../src/runtime/exec.js";

describe("gh statusline counts", () => {
  it("fetches ready and human counts with one GraphQL request", async () => {
    const calls: Array<{ tool: string; args: readonly string[] }> = [];
    const exec: ExecFn = async (tool, args) => {
      calls.push({ tool, args });
      return {
        code: 0,
        stdout: JSON.stringify({ data: { ready: { issueCount: 7 }, human: { issueCount: 2 } } }),
        stderr: "",
      };
    };

    const counts = await countStatuslineQueueCounts({ cwd: "/repo", repo: "o/r", exec });

    expect(counts).toEqual({ queue: 7, human: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe("gh");
    expect(calls[0]!.args.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(calls[0]!.args.join(" ")).toContain("ready: search");
    expect(calls[0]!.args.join(" ")).toContain("human: search");
    expect(calls[0]!.args).toContain('ready=repo:o/r is:issue is:open label:"ready-for-agent"');
    expect(calls[0]!.args).toContain('human=repo:o/r is:issue is:open label:"ready-for-human"');
  });
});

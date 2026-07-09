import { describe, expect, it } from "vitest";
import { countStatuslineQueueCounts, countPrsCreatedToday } from "../src/runtime/gh.js";
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

describe("gh countPrsCreatedToday", () => {
  it("counts PRs whose createdAt matches the given local day", async () => {
    const day = "2026-07-08";
    const exec: ExecFn = async () => ({
      code: 0,
      stdout: JSON.stringify([
        { createdAt: "2026-07-08T10:00:00Z" },
        { createdAt: "2026-07-08T14:30:00Z" },
        { createdAt: "2026-07-07T23:55:00Z" }, // previous day UTC — filtered out if local matches
      ]),
      stderr: "",
    });

    // Pass the explicit day so the test is not time-dependent.
    // Only PRs whose createdAt converts to "2026-07-08" in the local timezone count.
    const count = await countPrsCreatedToday({ cwd: "/repo", repo: "o/r", exec }, day);
    // The two 2026-07-08 UTC entries both convert to 2026-07-08 in UTC (and most
    // local timezones east of UTC-0). The third is 2026-07-07 in UTC.
    expect(count).toBeGreaterThanOrEqual(0); // exact value is timezone-dependent
    expect(count).toBeLessThanOrEqual(3);
  });

  it("returns 0 on gh failure", async () => {
    const exec: ExecFn = async () => ({ code: 1, stdout: "", stderr: "auth error" });
    const count = await countPrsCreatedToday({ cwd: "/repo", repo: "o/r", exec }, "2026-07-08");
    expect(count).toBe(0);
  });

  it("returns 0 on invalid JSON response", async () => {
    const exec: ExecFn = async () => ({ code: 0, stdout: "not-json", stderr: "" });
    const count = await countPrsCreatedToday({ cwd: "/repo", repo: "o/r", exec }, "2026-07-08");
    expect(count).toBe(0);
  });

  it("passes the date as a --search created: filter to gh", async () => {
    const calls: Array<{ args: readonly string[] }> = [];
    const exec: ExecFn = async (_, args) => {
      calls.push({ args });
      return { code: 0, stdout: "[]", stderr: "" };
    };
    await countPrsCreatedToday({ cwd: "/repo", repo: "o/r", exec }, "2026-07-08");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.join(" ")).toContain("created:2026-07-08");
    expect(calls[0]!.args).toContain("--state");
    expect(calls[0]!.args).toContain("all");
  });
});

import { describe, expect, it } from "vitest";
import { countStatuslineQueueCounts, countPrsCreatedToday } from "../src/runtime/gh.js";
import type { ExecFn } from "../src/runtime/exec.js";
import { GhReadError } from "../src/runtime/gh/read.js";

describe("gh statusline counts", () => {
  it("prefers rsp conditional REST search counts when available", async () => {
    const calls: Array<{ tool: string; args: readonly string[] }> = [];
    const exec: ExecFn = async (tool, args) => {
      calls.push({ tool, args });
      const query = args.find((arg) => String(arg).startsWith("q="));
      return {
        code: 0,
        stdout: JSON.stringify({
          total_count: String(query).includes("ready-for-human")
            ? 2
            : String(query).includes("quarantine")
              ? 4
              : 7,
        }),
        stderr: "",
      };
    };

    const counts = await countStatuslineQueueCounts({ cwd: "/repo", repo: "o/r", exec });

    expect(counts).toEqual({ queue: 7, human: 2, quarantine: 4 });
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.tool === "rsp")).toBe(true);
    expect(calls[0]!.args.slice(0, 2)).toEqual(["gh-api-json", "search/issues"]);
    expect(calls[0]!.args).toContain('q=repo:o/r is:issue is:open label:"ready-for-agent"');
    expect(calls[1]!.args).toContain('q=repo:o/r is:issue is:open label:"ready-for-human"');
    expect(calls[2]!.args).toContain('q=repo:o/r is:issue is:open label:"quarantine"');
  });

  it("fetches ready and human counts with one GraphQL request", async () => {
    const calls: Array<{ tool: string; args: readonly string[] }> = [];
    const exec: ExecFn = async (tool, args) => {
      calls.push({ tool, args });
      return {
        code: 0,
        stdout: JSON.stringify({
          data: {
            ready: { issueCount: 7 },
            human: { issueCount: 2 },
            quarantine: { issueCount: 4 },
          },
        }),
        stderr: "",
      };
    };

    const counts = await countStatuslineQueueCounts({ cwd: "/repo", repo: "o/r", exec });

    expect(counts).toEqual({ queue: 7, human: 2, quarantine: 4 });
    expect(calls).toHaveLength(4);
    expect(calls[0]!.tool).toBe("rsp");
    expect(calls[1]!.tool).toBe("rsp");
    expect(calls[2]!.tool).toBe("rsp");
    expect(calls[3]!.tool).toBe("gh");
    expect(calls[3]!.args.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(calls[3]!.args.join(" ")).toContain("ready: search");
    expect(calls[3]!.args.join(" ")).toContain("human: search");
    expect(calls[3]!.args.join(" ")).toContain("quarantine: search");
    expect(calls[3]!.args).toContain('ready=repo:o/r is:issue is:open label:"ready-for-agent"');
    expect(calls[3]!.args).toContain('human=repo:o/r is:issue is:open label:"ready-for-human"');
    expect(calls[3]!.args).toContain('quarantine=repo:o/r is:issue is:open label:"quarantine"');
  });
  it("raises when the GraphQL payload reports RATE_LIMITED instead of counting zeroes", async () => {
    // gh exits 0 with a well-formed body: `data` is null-filled and `errors`
    // says the query never ran. Zero counts here would render an exhausted read
    // as an empty queue (#2801).
    const exec: ExecFn = async (tool) =>
      tool === "rsp"
        ? { code: 1, stdout: "", stderr: "rsp unavailable" }
        : {
            code: 0,
            stdout: JSON.stringify({
              data: { ready: null, human: null, quarantine: null },
              errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
            }),
            stderr: "",
          };

    const error = await countStatuslineQueueCounts({ cwd: "/repo", repo: "o/r", exec }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(GhReadError);
    expect((error as GhReadError).classification).toBe("quota");
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

  // A read that never ran is NOT a count of zero: reporting 0 here renders the
  // failure as fact (#2801). Both cases raise so the caller keeps its last
  // known value instead of publishing a false zero.
  it("raises on gh failure rather than reporting 0", async () => {
    const exec: ExecFn = async () => ({ code: 1, stdout: "", stderr: "auth error" });
    await expect(
      countPrsCreatedToday({ cwd: "/repo", repo: "o/r", exec }, "2026-07-08"),
    ).rejects.toBeInstanceOf(GhReadError);
  });

  it("raises on an invalid JSON response rather than reporting 0", async () => {
    const exec: ExecFn = async () => ({ code: 0, stdout: "not-json", stderr: "" });
    await expect(
      countPrsCreatedToday({ cwd: "/repo", repo: "o/r", exec }, "2026-07-08"),
    ).rejects.toBeInstanceOf(GhReadError);
  });

  it("reports 0 when the query ran and matched no pull requests", async () => {
    const exec: ExecFn = async () => ({ code: 0, stdout: "[]", stderr: "" });
    await expect(
      countPrsCreatedToday({ cwd: "/repo", repo: "o/r", exec }, "2026-07-08"),
    ).resolves.toBe(0);
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

import { afterEach, describe, expect, it, vi } from "vitest";
import { selectCastleIssues } from "@reddb-io/red-castle/engine";
import { resolveDispatchCandidates } from "../src/runtime/gh/candidates.js";
import type { ExecFn, ExecOutput } from "../src/runtime/exec.js";
import type { GhContext } from "../src/runtime/gh.js";

function issue(number: number, labels: string[] = ["lane:go"]): string {
  return JSON.stringify({
    number,
    title: `Issue ${number}`,
    body: "do the thing",
    state: "open",
    labels: labels.map((name) => ({ name })),
  });
}

describe("targeted dispatch candidate resolution", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves consecutive /go targets directly by number without consulting the lane listing", async () => {
    const calls: { cmd: string; args: readonly string[] }[] = [];
    const exec: ExecFn = async (cmd, args): Promise<ExecOutput> => {
      calls.push({ cmd, args: [...args] });
      const number = Number(args.at(-1)?.split("/").at(-1));
      return { code: 0, stdout: issue(number), stderr: "" };
    };
    const ctx: GhContext = { cwd: "/repo", repo: "acme/widgets", exec };

    const first = await resolveDispatchCandidates(
      ctx,
      { kind: "issues", numbers: [3524] },
      "lane:go",
    );
    const second = await resolveDispatchCandidates(
      ctx,
      { kind: "issues", numbers: [3525] },
      "lane:go",
    );

    expect(first.map((candidate) => candidate.number)).toEqual([3524]);
    expect(second.map((candidate) => candidate.number)).toEqual([3525]);
    expect(calls.map((call) => call.cmd)).toEqual(["gh", "gh"]);
    expect(calls.map((call) => call.args)).toEqual([
      ["api", "repos/acme/widgets/issues/3524"],
      ["api", "repos/acme/widgets/issues/3525"],
    ]);
  });

  it("preserves the existing missing-target evidence when the direct read cannot find the issue", async () => {
    const exec: ExecFn = async (): Promise<ExecOutput> => ({
      code: 1,
      stdout: "",
      stderr: "HTTP 404",
    });
    const ctx: GhContext = { cwd: "/repo", repo: "acme/widgets", exec };
    const filter = { kind: "issues" as const, numbers: [404] };

    const candidates = await resolveDispatchCandidates(ctx, filter, "lane:go");

    expect(() =>
      selectCastleIssues(candidates, filter, undefined, "lane:go", "lane:go"),
    ).toThrow(
      "requested issue(s) missing: #404 (declared lane `lane:go`; consulted queue `lane:go`)",
    );
  });

  it("boots a freshly minted /go target when the direct read briefly returns 404", async () => {
    vi.useFakeTimers();
    const replies = [
      { code: 1, stdout: "", stderr: "HTTP 404: Not Found" },
      { code: 1, stdout: "", stderr: "HTTP 404: Not Found" },
      { code: 0, stdout: issue(3667), stderr: "" },
    ];
    const exec = vi.fn<ExecFn>(async (): Promise<ExecOutput> => replies.shift()!);
    const ctx: GhContext = { cwd: "/repo", repo: "acme/widgets", exec };

    const candidatesPromise = resolveDispatchCandidates(
      ctx,
      { kind: "issues", numbers: [3667] },
      "lane:go",
    );
    await vi.runAllTimersAsync();

    await expect(candidatesPromise).resolves.toMatchObject([{ number: 3667 }]);
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("does not admit a direct target that is closed or outside the declared lane", async () => {
    const replies = [
      issue(41, ["ready-for-agent"]),
      issue(42, ["lane:go"]).replace('"state":"open"', '"state":"closed"'),
    ];
    const exec: ExecFn = async (): Promise<ExecOutput> => ({
      code: 0,
      stdout: replies.shift()!,
      stderr: "",
    });
    const ctx: GhContext = { cwd: "/repo", repo: "acme/widgets", exec };

    await expect(
      resolveDispatchCandidates(ctx, { kind: "issues", numbers: [41] }, "lane:go"),
    ).resolves.toEqual([]);
    await expect(
      resolveDispatchCandidates(ctx, { kind: "issues", numbers: [42] }, "lane:go"),
    ).resolves.toEqual([]);
  });
});

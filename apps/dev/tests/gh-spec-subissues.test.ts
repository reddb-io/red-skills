import { describe, expect, it } from "vitest";
import type { GithubClient, GithubConditionalRestRequest } from "@reddb-io/github";
import {
  attachSubIssue,
  listSpecSubIssueCandidates,
  type GhContext,
} from "../src/runtime/gh.js";
import type { ExecFn, ExecOutput } from "../src/runtime/exec.js";

interface Recorder {
  exec: ExecFn;
  calls: { cmd: string; args: string[] }[];
}

function makeRecorder(respond: (args: readonly string[]) => ExecOutput): Recorder {
  const calls: { cmd: string; args: string[] }[] = [];
  const exec: ExecFn = (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    return Promise.resolve(respond(args));
  };
  return { exec, calls };
}

function routedClient(input: {
  paginate: (request: GithubConditionalRestRequest) => Promise<readonly unknown[]> | readonly unknown[];
  graphql: (query: string, variables: Readonly<Record<string, unknown>>) => Promise<unknown> | unknown;
}): GithubClient {
  return {
    conditionalPaginate: async (request) => ({
      data: await input.paginate(request), headers: {}, quotaFree: false, requestCount: 1,
    }),
    graphql: input.graphql,
    conditionalRest: async () => { throw new Error("unexpected conditionalRest"); },
    singleObject: async () => { throw new Error("unexpected singleObject"); },
  } as GithubClient;
}

describe("listSpecSubIssueCandidates", () => {
  it("walks open and recently closed Specs, label children, and native sub-issues", async () => {
    const github = routedClient({
      paginate: (request) => {
        if (request.parameters?.labels === "type:spec") {
          return [
            { number: 42, state: "OPEN", closedAt: null, labels: [{ name: "type:spec" }, { name: "needs-slicing" }] },
            { number: 43, state: "CLOSED", closedAt: "2026-01-01T00:00:00Z", labels: [{ name: "type:spec" }] },
          ];
        }
        if (request.parameters?.labels === "spec:42") return [{ number: 7, labels: [{ name: "spec:42" }] }];
        if (request.parameters?.labels === "spec:43") return [];
        throw new Error("unexpected paginate");
      },
      graphql: () => ({ repository: {
            i0: { number: 42, subIssues: { nodes: [{ number: 8 }] } },
            i1: { number: 43, subIssues: { nodes: [] } },
          } }),
    });

    const ctx: GhContext = { cwd: "/r", repo: "acme/widgets", github };
    const candidates = await listSpecSubIssueCandidates(ctx, Date.parse("2026-01-15T00:00:00Z") / 1000);

    expect(candidates).toEqual([
      { number: 42, labels: ["type:spec", "needs-slicing"], labelChildren: [7], nativeSubIssues: [8] },
      { number: 43, labels: ["type:spec"], labelChildren: [], nativeSubIssues: [] },
    ]);
  });

  it("retries alias failures through bounded REST without caching empty relationships", async () => {
    const calls: GithubConditionalRestRequest[] = [];
    let activeFallbacks = 0;
    let maxFallbacks = 0;
    const specs = Array.from({ length: 9 }, (_, index) => index + 40);
    const github = routedClient({
      paginate: async (request) => {
        calls.push(request);
        if (request.parameters?.labels === "type:spec") {
          return specs.map((number) => ({ number, state: "OPEN", closedAt: null, labels: [{ name: "type:spec" }] }));
        }
        if (String(request.parameters?.labels ?? "").startsWith("spec:")) return [];
        if (request.route.includes("/sub_issues")) {
        activeFallbacks += 1;
        maxFallbacks = Math.max(maxFallbacks, activeFallbacks);
        await new Promise((resolve) => setTimeout(resolve, 2));
        activeFallbacks -= 1;
          const spec = Number(request.parameters?.issue_number);
          return [{ number: spec + 100 }];
        }
        throw new Error("unexpected paginate");
      },
      graphql: () => {
        throw new Error("alias failure");
      }
    });

    const candidates = await listSpecSubIssueCandidates({ cwd: "/r", repo: "acme/widgets", github });

    expect(candidates.map((candidate) => candidate.nativeSubIssues)).toEqual(specs.map((spec) => [spec + 100]));
    expect(calls.filter((call) => call.route.includes("/sub_issues"))).toHaveLength(9);
    expect(maxFallbacks).toBeGreaterThan(1);
    expect(maxFallbacks).toBeLessThanOrEqual(4);
  });
});

describe("attachSubIssue", () => {
  it("resolves the child database id and posts the native sub-issue edge", async () => {
    const rec = makeRecorder((args) => {
      const joined = args.join(" ");
      if (joined.includes("issues/7")) {
        return { code: 0, stdout: JSON.stringify({ id: 12345 }), stderr: "" };
      }
      if (joined.includes("issues/42/sub_issues")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    });
    const ctx: GhContext = { cwd: "/r", repo: "acme/widgets", exec: rec.exec };

    await attachSubIssue(ctx, 42, 7);

    expect(rec.calls).toEqual([
      {
        cmd: "gh",
        args: ["api", "repos/acme/widgets/issues/7"],
      },
      {
        cmd: "gh",
        args: ["api", "-X", "POST", "repos/acme/widgets/issues/42/sub_issues", "-F", "sub_issue_id=12345"],
      },
    ]);
  });
});

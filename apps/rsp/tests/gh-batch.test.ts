import { decode } from "@reddb-io/toon";
import { describe, expect, it } from "vitest";
import { runGhBatchCommand, type GhBatchExec } from "../src/gh-batch.js";

function response(stdout: unknown, code = 0, stderr = "") {
  return { code, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr };
}

describe("rsp gh batch", () => {
  it("reads N issues with one GraphQL call, preserves input order, and isolates bad ids", async () => {
    const calls: string[][] = [];
    const exec: GhBatchExec = async (args) => {
      calls.push([...args]);
      return response({
        data: { repository: {
          i0: { id: "I_9", number: 9, title: "nine", state: "OPEN", body: "body 9", labels: { nodes: [{ name: "one" }] } },
          i1: { id: "I_2", number: 2, title: "two", state: "CLOSED", body: "body 2", labels: { nodes: [] } },
          i2: null,
        } },
        errors: [{ message: "issue not found", path: ["repository", "i2"] }],
      });
    };

    const result = await runGhBatchCommand(["gh", "issues", "9", "2", "404", "--repo", "acme/widgets"], { exec });
    const payload = decode(result.stdout.toString()) as Record<string, unknown> & { order: number[]; issues: Record<string, unknown> };

    expect(result.status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(payload.order).toEqual([9, 2, 404]);
    expect(payload.issues["9"]).toMatchObject({ title: "nine", state: "open", labels: ["one"] });
    expect(payload.issues["404"]).toEqual({ error: "issue not found" });
  });

  it("reads PR mergeability and check rollups through one aliased query", async () => {
    const calls: string[][] = [];
    const exec: GhBatchExec = async (args) => {
      calls.push([...args]);
      return response({ data: { repository: {
        p0: {
          id: "P_12", number: 12, title: "batch", state: "OPEN", mergeable: "MERGEABLE",
          commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [] } } } }] },
        },
      } } });
    };

    const result = await runGhBatchCommand(["gh", "prs", "12", "--repo", "acme/widgets"], { exec });
    const payload = decode(result.stdout.toString()) as { prs: Record<string, unknown> };

    expect(calls).toHaveLength(1);
    expect(calls[0]!.join(" ")).toContain("pullRequest(number: 12)");
    expect(payload.prs["12"]).toMatchObject({ mergeable: "mergeable", checks: { state: "success" } });
  });

  it("batches label mutations after one aliased id lookup", async () => {
    const calls: string[][] = [];
    const exec: GhBatchExec = async (args) => {
      calls.push([...args]);
      if (calls.length === 1) {
        return response({ data: { repository: {
          i0: { id: "I_7", number: 7 },
          i1: { id: "I_8", number: 8 },
          labels: { nodes: [{ id: "L_add", name: "ready" }, { id: "L_remove", name: "crashed" }] },
        } } });
      }
      return response({ data: {
        add0: { clientMutationId: "7" }, remove0: { clientMutationId: "7" },
        add1: { clientMutationId: "8" }, remove1: { clientMutationId: "8" },
      } });
    };

    const result = await runGhBatchCommand([
      "gh", "edit-labels", "--add", "ready", "--remove", "crashed", "7", "8", "--repo", "acme/widgets",
    ], { exec });
    const payload = decode(result.stdout.toString()) as { transport: string; issues: Record<string, unknown> };

    expect(calls).toHaveLength(2);
    expect(calls[0]!.join(" ")).toContain("i0: issue(number: 7)");
    expect(calls[1]!.join(" ")).toContain("add0: addLabelsToLabelable");
    expect(calls[1]!.join(" ")).toContain("remove1: removeLabelsFromLabelable");
    expect(payload.transport).toBe("graphql");
    expect(payload.issues).toEqual({ "7": { ok: true }, "8": { ok: true } });
  });

  it("batches sub-issue links after one aliased id lookup", async () => {
    const calls: string[][] = [];
    const exec: GhBatchExec = async (args) => {
      calls.push([...args]);
      if (calls.length === 1) {
        return response({ data: { repository: {
          i0: { id: "I_parent", number: 42 }, i1: { id: "I_7", number: 7 }, i2: { id: "I_8", number: 8 },
        } } });
      }
      return response({ data: { link0: { clientMutationId: "7" }, link1: { clientMutationId: "8" } } });
    };

    const result = await runGhBatchCommand(["gh", "link-sub-issues", "42", "7", "8", "--repo", "acme/widgets"], { exec });
    const payload = decode(result.stdout.toString()) as { issues: Record<string, unknown> };

    expect(calls).toHaveLength(2);
    expect(calls[1]!.join(" ")).toContain("link0: addSubIssue");
    expect(calls[1]!.join(" ")).toContain("link1: addSubIssue");
    expect(payload.issues).toEqual({ "7": { ok: true }, "8": { ok: true } });
  });

  it("surfaces GraphQL quota degradation and uses bounded REST concurrency", async () => {
    let active = 0;
    let maxActive = 0;
    const exec: GhBatchExec = async (args) => {
      if (args[0] === "api" && args[1] === "graphql") return response("", 1, "GraphQL: API rate limit exceeded");
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      const number = Number(args[2]);
      return response({ number, title: `issue ${number}`, state: "OPEN", body: "", labels: [] });
    };

    const ids = Array.from({ length: 9 }, (_, i) => String(i + 1));
    const result = await runGhBatchCommand(["gh", "issues", ...ids, "--repo", "acme/widgets"], { exec, restConcurrency: 3 });
    const payload = decode(result.stdout.toString()) as { transport: string; degraded: string; concurrency: number };

    expect(result.status).toBe(0);
    expect(payload).toMatchObject({ transport: "rest-fallback", degraded: "graphql-quota", concurrency: 3 });
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActive).toBeGreaterThan(1);
  });
});

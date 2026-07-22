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

  it("chunks reads at 100 nodes while preserving global input order", async () => {
    const calls: string[][] = [];
    const exec: GhBatchExec = async (args) => {
      calls.push([...args]);
      const query = args.find((arg) => arg.startsWith("query=")) ?? "";
      const repository = Object.fromEntries(
        [...query.matchAll(/(i\d+): issue\(number: (\d+)\)/g)].map((match) => [
          match[1],
          { id: `I_${match[2]}`, number: Number(match[2]), title: `issue ${match[2]}`, state: "OPEN" },
        ]),
      );
      return response({ data: { repository } });
    };
    const numbers = Array.from({ length: 101 }, (_, index) => String(200 - index));

    const result = await runGhBatchCommand(["gh", "issues", ...numbers, "--json", "title", "--repo", "acme/widgets"], { exec });
    const payload = decode(result.stdout.toString()) as { order: number[]; issues: Record<string, unknown> };

    expect(calls).toHaveLength(2);
    expect(calls.every((args) => args.slice(0, 2).join(" ") === "api graphql")).toBe(true);
    expect(payload.order).toEqual(numbers.map(Number));
    expect(payload.order.map((number) => payload.issues[String(number)])).toEqual(
      numbers.map((number) => ({ number: Number(number), title: `issue ${number}` })),
    );
  });

  it("preserves the requested PR rollup field name", async () => {
    const exec: GhBatchExec = async () => response({ data: { repository: {
      p0: {
        id: "P_12", number: 12,
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [] } } } }] },
      },
    } } });

    const result = await runGhBatchCommand([
      "gh", "prs", "12", "--json", "statusCheckRollup", "--repo", "acme/widgets",
    ], { exec });
    const payload = decode(result.stdout.toString()) as { prs: Record<string, Record<string, unknown>> };

    expect(payload.prs["12"]).toHaveProperty("statusCheckRollup", { state: "success", contexts: [] });
    expect(payload.prs["12"]).not.toHaveProperty("checks");
  });

  it("edits all labels with one aliased GraphQL mutation", async () => {
    const calls: string[][] = [];
    const exec: GhBatchExec = async (args) => {
      calls.push([...args]);
      if (args[1]?.includes("/issues/")) {
        const number = Number(args[1].match(/issues\/(\d+)$/)?.[1]);
        return response({ number, node_id: `I_${number}` });
      }
      if (args[1]?.includes("/labels/")) {
        const name = decodeURIComponent(args[1].split("/").at(-1) ?? "");
        return response({ name, node_id: name === "ready" ? "L_add" : "L_remove" });
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

    const graphqlCalls = calls.filter((args) => args.slice(0, 2).join(" ") === "api graphql");
    expect(graphqlCalls).toHaveLength(1);
    expect(graphqlCalls[0]!.join(" ")).toContain("add0: addLabelsToLabelable");
    expect(graphqlCalls[0]!.join(" ")).toContain("remove1: removeLabelsFromLabelable");
    expect(payload.transport).toBe("graphql");
    expect(payload.issues).toEqual({ "7": { ok: true }, "8": { ok: true } });
  });

  it("links all sub-issues with one aliased GraphQL mutation", async () => {
    const calls: string[][] = [];
    const exec: GhBatchExec = async (args) => {
      calls.push([...args]);
      if (args[1]?.includes("/issues/")) {
        const number = Number(args[1].match(/issues\/(\d+)$/)?.[1]);
        return response({ id: number * 100, number, node_id: number === 42 ? "I_parent" : `I_${number}` });
      }
      return response({ data: { link0: { clientMutationId: "7" }, link1: { clientMutationId: "8" } } });
    };

    const result = await runGhBatchCommand(["gh", "link-sub-issues", "42", "7", "8", "--repo", "acme/widgets"], { exec });
    const payload = decode(result.stdout.toString()) as { issues: Record<string, unknown> };

    const graphqlCalls = calls.filter((args) => args.slice(0, 2).join(" ") === "api graphql");
    expect(graphqlCalls).toHaveLength(1);
    expect(graphqlCalls[0]!.join(" ")).toContain("link0: addSubIssue");
    expect(graphqlCalls[0]!.join(" ")).toContain("link1: addSubIssue");
    expect(payload.issues).toEqual({ "7": { ok: true }, "8": { ok: true } });
  });

  it("falls back from label mutation quota to bounded REST add/remove endpoints", async () => {
    const calls: string[][] = [];
    const exec: GhBatchExec = async (args) => {
      calls.push([...args]);
      if (args[1]?.includes("/issues/") && args.length === 2) {
        const number = Number(args[1].match(/issues\/(\d+)$/)?.[1]);
        return response({ number, node_id: `I_${number}` });
      }
      if (args[1]?.includes("/labels/")) return response({ node_id: "L_any" });
      if (args.slice(0, 2).join(" ") === "api graphql") return response("", 1, "GraphQL quota exhausted");
      return response({ ok: true });
    };

    const result = await runGhBatchCommand([
      "gh", "edit-labels", "--add", "ready", "--remove", "crashed", "7", "8", "--repo", "acme/widgets",
    ], { exec, restConcurrency: 2 });
    const payload = decode(result.stdout.toString()) as { transport: string; degraded: string; issues: Record<string, unknown> };

    expect(payload).toMatchObject({ transport: "rest-fallback", degraded: "graphql-quota" });
    expect(payload.issues).toEqual({ "7": { ok: true }, "8": { ok: true } });
    expect(calls.some((args) => args[0] === "api" && args[1] === "-X" && args[2] === "DELETE"
      && args[3] === "repos/acme/widgets/issues/7/labels/crashed")).toBe(true);
    expect(calls.some((args) => args[0] === "api" && args[1] === "-X" && args[2] === "POST"
      && args[3] === "repos/acme/widgets/issues/7/labels" && args.includes("labels[]=ready"))).toBe(true);
    expect(calls.some((args) => args[0] === "issue" && args[1] === "edit")).toBe(false);
  });

  it("surfaces GraphQL quota degradation and uses bounded REST concurrency", async () => {
    let active = 0;
    let maxActive = 0;
    const calls: string[][] = [];
    const exec: GhBatchExec = async (args) => {
      calls.push([...args]);
      if (args[0] === "api" && args[1] === "graphql") return response("", 1, "GraphQL: API rate limit exceeded");
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      const number = Number(args[1]?.match(/issues\/(\d+)$/)?.[1]);
      return response({ number, title: `issue ${number}`, state: "open", body: "", labels: [] });
    };

    const ids = Array.from({ length: 9 }, (_, i) => String(i + 1));
    const result = await runGhBatchCommand(["gh", "issues", ...ids, "--repo", "acme/widgets"], { exec, restConcurrency: 3 });
    const payload = decode(result.stdout.toString()) as { transport: string; degraded: string; concurrency: number };

    expect(result.status).toBe(0);
    expect(payload).toMatchObject({ transport: "rest-fallback", degraded: "graphql-quota", concurrency: 3 });
    expect(calls.slice(1).every((args) => args[0] === "api" && args[1]?.startsWith("repos/acme/widgets/issues/"))).toBe(true);
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActive).toBeGreaterThan(1);
  });
});

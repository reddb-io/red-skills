/**
 * Every published `rs_dev` tool states what answers it, and the table is real
 * (#4113).
 *
 * 51 of 55 tools fell through to `session.prompt("/<tool> {…}")` and came back
 * as a healthy-looking EMPTY envelope, having birthed and killed a Worker to
 * produce it. Nothing in the repo said so — the routing lived as an untested
 * five-row `Map` and a fallthrough. This ratchet pins the declared table
 * against BOTH live sources in both directions, so the state of the surface is
 * a fact somebody wrote down rather than a discovery each operator makes alone.
 */
import { describe, expect, it, vi } from "vitest";
import { REDSKILLS_ACP_METHOD_NAMES, REDSKILLS_ACP_METHODS } from "@reddb-io/protocol-acp";
import type { RedskillsProjectAcpSession } from "@reddb-io/redskilled/acp-client";

import {
  MCP_TOOL_ROUTING,
  UNSERVED_MCP_TOOL_BASELINE,
  auditMcpToolRouting,
  mcpControlRoutes,
  mcpToolRoute,
  renderUnservedToolRefusal,
  servedControlToolNames,
} from "../src/core/mcp-tool-routing.js";
import { createCastleMcpTools, type CastleMcpDependencies } from "../src/mcp-tools/index.js";
import { invokeProjectMcp } from "../src/project-acp-adapter.js";
import { REPO_INVARIANT_SUITES } from "../src/core/repo-invariants.js";

const PUBLISHED = createCastleMcpTools({} as CastleMcpDependencies).map((tool) => tool.name);

function session(): RedskillsProjectAcpSession & {
  prompt: ReturnType<typeof vi.fn>;
  control: ReturnType<typeof vi.fn>;
} {
  return {
    prompt: vi.fn(async () => ({ stopReason: "end_turn", updates: [] })),
    control: vi.fn(async () => ({ ok: true })),
    cancel: vi.fn(),
    permission: vi.fn(),
    close: vi.fn(),
  } as unknown as RedskillsProjectAcpSession & {
    prompt: ReturnType<typeof vi.fn>;
    control: ReturnType<typeof vi.fn>;
  };
}

describe("the rs_dev routing table matches the live surfaces (#4113)", () => {
  it("sweeps a registry that actually publishes tools", () => {
    expect(PUBLISHED.length).toBeGreaterThan(50);
  });

  it("agrees with the live MCP registry and the live daemon methods in both directions", () => {
    const findings = auditMcpToolRouting({
      published: PUBLISHED,
      methods: REDSKILLS_ACP_METHOD_NAMES,
    });
    expect(findings.map((finding) => `${finding.tool}: ${finding.reason}`)).toEqual([]);
  });

  it("declares each published tool exactly once", () => {
    const tools = MCP_TOOL_ROUTING.map((route) => route.tool);
    expect(new Set(tools).size).toBe(tools.length);
    expect(new Set(tools)).toEqual(new Set(PUBLISHED));
  });

  it("keeps the unserved list shrink-only", () => {
    const unserved = MCP_TOOL_ROUTING.filter((route) => route.kind === "unserved");
    expect(unserved.length).toBeLessThanOrEqual(UNSERVED_MCP_TOOL_BASELINE);
  });

  it("names the four control verbs that work today", () => {
    expect(servedControlToolNames()).toEqual([
      "drain",
      "project_status",
      "project_stop",
      "status",
    ]);
    expect(mcpControlRoutes()).toEqual([
      ["status", "status"],
      ["project_status", "status"],
      ["drain", "drain"],
      ["project_stop", "stop"],
    ]);
  });

  it("serves nothing through a daemon method yet, so slice 2 has a landing pad", () => {
    expect(MCP_TOOL_ROUTING.filter((route) => route.kind === "served")).toEqual([]);
  });

  it("resolves one route by name and misses an undeclared one", () => {
    expect(mcpToolRoute("queue_status")?.kind).toBe("unserved");
    expect(mcpToolRoute("private_worker_birth")).toBeUndefined();
  });
});

describe("the audit refuses a table that drifted from a live source", () => {
  it("fails a served row naming a method the daemon does not serve", () => {
    const findings = auditMcpToolRouting(
      { published: ["queue_status"], methods: REDSKILLS_ACP_METHOD_NAMES },
      [{ tool: "queue_status", kind: "served", method: "_redskills/queue_status" as never }],
    );
    expect(findings).toEqual([{
      tool: "queue_status",
      reason: 'served route names "_redskills/queue_status", which the daemon does not serve',
    }]);
  });

  it("accepts a served row naming a method the daemon does serve", () => {
    expect(auditMcpToolRouting(
      { published: ["go"], methods: REDSKILLS_ACP_METHOD_NAMES },
      [{ tool: "go", kind: "served", method: REDSKILLS_ACP_METHODS.goDispatch }],
    )).toEqual([]);
  });

  it("fails a published tool nobody routed", () => {
    expect(auditMcpToolRouting({ published: ["brand_new"], methods: [] }, []))
      .toEqual([{
        tool: "brand_new",
        reason:
          "published by the MCP registry with no declared route; add a control, served or unserved row",
      }]);
  });

  it("fails a declared row the registry no longer publishes", () => {
    const findings = auditMcpToolRouting({ published: [], methods: [] }, [
      { tool: "renamed_away", kind: "unserved", reason: "x".repeat(41) },
    ]);
    expect(findings).toEqual([{
      tool: "renamed_away",
      reason: "declared here but the MCP registry publishes no such tool",
    }]);
  });

  it("fails an unserved row with no reason, a control row with no operation, and a duplicate", () => {
    expect(auditMcpToolRouting({ published: ["a", "b", "c"], methods: [] }, [
      { tool: "a", kind: "unserved", reason: "too short" },
      { tool: "b", kind: "control" },
      { tool: "c", kind: "served" },
      { tool: "a", kind: "unserved", reason: "y".repeat(41) },
    ]).map((finding) => finding.reason)).toEqual([
      "unserved route states no reason a reader can act on",
      "control route names no control operation",
      "served route names no _redskills/* method",
      "declared twice; one row per tool",
    ]);
  });
});

describe("the adapter refuses an unserved verb instead of prompting a Worker", () => {
  it.each(["queue_status", "project_activation", "worker_dispatch", "logs"])(
    "refuses %s by name, naming what does work, without reaching prompt",
    async (tool) => {
      const client = session();
      await expect(invokeProjectMcp(client, tool, {})).rejects.toThrow(
        new RegExp(`rs_dev tool "${tool}" is not served`),
      );
      await expect(invokeProjectMcp(client, tool, {})).rejects.toThrow(
        /serves only: drain, project_status, project_stop, status/,
      );
      expect(client.prompt).not.toHaveBeenCalled();
      expect(client.control).not.toHaveBeenCalled();
    },
  );

  it("still refuses a name nobody published", async () => {
    const client = session();
    await expect(invokeProjectMcp(client, "private_worker_birth", {}))
      .rejects.toThrow(/unsupported ACP Project capability/);
    expect(client.prompt).not.toHaveBeenCalled();
  });

  it("routes every control verb to session.control, unchanged", async () => {
    for (const [tool, operation] of [
      ["drain", "drain"],
      ["project_stop", "stop"],
      ["project_status", "status"],
      ["status", "status"],
      ["project_drain", "drain"],
    ] as const) {
      const client = session();
      await invokeProjectMcp(client, tool, {});
      expect(client.control).toHaveBeenCalledTimes(1);
      expect(client.control.mock.calls[0]?.[0]).toBe(operation);
      expect(client.prompt).not.toHaveBeenCalled();
    }
  });

  it("carries the tool, the reason and the repair in one refusal", () => {
    const route = mcpToolRoute("queue_status")!;
    const message = renderUnservedToolRefusal(route);
    expect(message).toContain('"queue_status"');
    expect(message).toContain("#4113");
    expect(message).toContain(route.reason!);
    expect(message).toContain("drain, project_status, project_stop, status");
  });
});

describe("the declaration runs in every gate run", () => {
  it("is a declared repo invariant", () => {
    const suite = REPO_INVARIANT_SUITES.find((entry) => entry.name === "invariants:mcp-tool-routing");
    expect(suite).toBeDefined();
    expect(suite?.scope).toBe("apps/plugin-dev");
    expect(suite?.script).toBe("test:invariants");
  });
});

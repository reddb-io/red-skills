import { describe, expect, it } from "vitest";
import {
  auditMcpLoad,
  MCP_RELOAD_CURE,
  MCP_SESSION_FLAG,
  parseSessionMcpServers,
  renderMcpLoadReportToon,
  sessionServerSlug,
  type McpLoadFacts,
} from "../src/core/mcp-load-doctor.js";

const DEV_SERVERS = ["navigator", "castle", "rsp"] as const;

function facts(overrides: Partial<McpLoadFacts> = {}): McpLoadFacts {
  return {
    plugin: "dev",
    declared: [...DEV_SERVERS],
    declarationSource: "plugins/dev/.mcp.json",
    sessionServers: [...DEV_SERVERS],
    ...overrides,
  };
}

describe("sessionServerSlug", () => {
  it("reads the server out of a host-prefixed tool name", () => {
    expect(sessionServerSlug("mcp__plugin_dev_castle__project_status")).toBe("plugin_dev_castle");
    expect(sessionServerSlug("mcp__plugin_dev_navigator")).toBe("plugin_dev_navigator");
  });

  it("leaves a bare server name alone", () => {
    expect(sessionServerSlug("  castle ")).toBe("castle");
  });
});

describe("parseSessionMcpServers", () => {
  it("reads a comma- or space-separated list", () => {
    expect(parseSessionMcpServers("castle, navigator rsp")).toEqual(["castle", "navigator", "rsp"]);
  });

  // The whole point of the check is an operator who can say "I see NONE", and
  // an empty string is exactly what a shell hands over for that.
  it("reads an explicit emptiness as an observed empty session", () => {
    expect(parseSessionMcpServers("")).toEqual([]);
    expect(parseSessionMcpServers("none")).toEqual([]);
  });
});

describe("auditMcpLoad", () => {
  it("passes a session that sees every declared server", () => {
    const report = auditMcpLoad([facts()]);

    expect(report.findings).toEqual([]);
    expect(report.rows[0]).toMatchObject({ plugin: "dev", verdict: "ok", missing: [] });
  });

  it("matches host-prefixed tool names against the declared bare server names", () => {
    const report = auditMcpLoad([
      facts({
        sessionServers: [
          "mcp__plugin_dev_castle__project_status",
          "mcp__plugin_dev_navigator__hover",
          "mcp__plugin_dev_rsp__rsp_status",
        ],
      }),
    ]);

    expect(report.findings).toEqual([]);
    expect(report.rows[0]?.loaded).toEqual(["navigator", "castle", "rsp"]);
  });

  // The observed incident: the plugin was installed mid-session, so the
  // declaration is on disk and the process was never started.
  it("flags a declared-but-unloaded plugin with the reload cure verbatim", () => {
    const report = auditMcpLoad([facts({ sessionServers: [] })]);

    expect(report.rows[0]?.verdict).toBe("error");
    expect(report.findings).toHaveLength(1);
    const [finding] = report.findings;
    expect(finding?.kind).toBe("declared-unloaded");
    expect(finding?.verdict).toBe("error");
    expect(finding?.missing).toEqual(["navigator", "castle", "rsp"]);
    expect(finding?.remediation).toBe(MCP_RELOAD_CURE);
    expect(finding?.remediation).toContain("/reload-plugins");
    expect(finding?.remediation).toContain("restart the session");
    expect(finding?.reason).toContain("installed or updated mid-session");
  });

  it("warns rather than reds when only some declared servers loaded", () => {
    const report = auditMcpLoad([facts({ sessionServers: ["castle"] })]);

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      kind: "partially-loaded",
      verdict: "warn",
      missing: ["navigator", "rsp"],
      remediation: MCP_RELOAD_CURE,
    });
  });

  // An unobserved session is not a clean one: reporting ✅ here would be the
  // exact silence this check exists to end.
  it("warns and names the flag when the session was never observed", () => {
    const report = auditMcpLoad([facts({ sessionServers: null })]);

    expect(report.rows[0]?.verdict).toBe("warn");
    expect(report.findings[0]?.kind).toBe("session-unobserved");
    expect(report.findings[0]?.remediation).toContain(MCP_SESSION_FLAG);
  });

  it("never flags a plugin that declares no MCP server", () => {
    const report = auditMcpLoad([facts({ declared: [], sessionServers: [] })]);

    expect(report.findings).toEqual([]);
    expect(report.rows[0]?.verdict).toBe("ok");
  });

  it("renders the report as TOON", () => {
    const toon = renderMcpLoadReportToon(auditMcpLoad([facts({ sessionServers: [] })]));

    expect(toon).toContain("dev");
    expect(toon).toContain("declared-unloaded");
  });
});

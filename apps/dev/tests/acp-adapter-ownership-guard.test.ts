import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ADAPTERS = [
  "src/mcp-server.ts",
  "src/project-acp-adapter.ts",
  "../redskilled/src/acp-client.ts",
] as const;

const FORBIDDEN = [
  { pattern: /red-castle\/resident/, owner: "adapter-owned resident protocol" },
  { pattern: /from ["']node:fs(?:\/promises)?["']/, owner: "adapter-owned state-file read" },
  { pattern: /\.red\/state|registrationIntentPath|eventLanePath/, owner: "adapter-owned daemon state" },
  { pattern: /runtime\/gh(?:\.js)?["']/, owner: "adapter-owned GitHub client" },
  { pattern: /@reddb-io\/github|\bgh api\b|GITHUB_TOKEN|GH_TOKEN/, owner: "adapter-owned GitHub read" },
  { pattern: /mcp-worker-birth/, owner: "adapter-owned Worker birth" },
  { pattern: /\bmcp__|\.callTool\(|tools\/call/, owner: "adapter-owned operational MCP read" },
  { pattern: /sendRedskilledRequest/, owner: "private daemon protocol" },
  { pattern: /\.(?:socketPath|leasePath|machineClaimPath)\b/, owner: "private daemon endpoint" },
  { pattern: /createProjectControlStore/, owner: "adapter-owned durable Project state" },
] as const;

describe("ACP adapter ownership guard", () => {
  it("keeps public adapters as stateless ACP clients", () => {
    const violations: string[] = [];
    for (const relative of ADAPTERS) {
      const source = readFileSync(resolve(__dirname, "..", relative), "utf8");
      for (const rule of FORBIDDEN) {
        if (rule.pattern.test(source)) violations.push(`${relative}: ${rule.owner}`);
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("allows only the public ACP endpoint at the adapter socket boundary", () => {
    const source = readFileSync(resolve(__dirname, "../../redskilled/src/acp-client.ts"), "utf8");
    expect(source).toContain("endpoint.acpSocketPath");
    expect(source).not.toMatch(/endpoint\.(?:socketPath|leasePath|eventLanePath|machineClaimPath)/);
    expect(source).not.toMatch(/from ["'].+protocol\.js["']/);
  });
});

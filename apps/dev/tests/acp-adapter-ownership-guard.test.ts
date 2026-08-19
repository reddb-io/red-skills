import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { REDSKILLS_ACP_METHOD_NAMES } from "@reddb-io/protocol-acp";

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

// The shared wire is ONE package (ADR 0148, issue #4008). A private copy of ACP
// compat, the wire major, the socket transport or a `_redskills/*` method name
// does not fail to compile — it fails at run time, on the far side of a socket,
// against a peer that read the other copy. So the copies are refused by grep.
const WIRE_PACKAGE = resolve(__dirname, "..", "..", "..", "packages", "protocol-acp");

/** Every source tree that must IMPORT the shared wire rather than restate it. */
const WIRE_CONSUMERS = [
  resolve(__dirname, "..", "src"),
  resolve(__dirname, "..", "..", "redskilled", "src"),
] as const;

/**
 * A re-grown copy, paired with the export that already answers it.
 *
 * Each pattern matches a DEFINITION, never a use: `REDSKILLS_WIRE_MAJOR` may be
 * read anywhere, and only `REDSKILLS_WIRE_MAJOR =` declares a second one.
 */
const WIRE_COPIES = [
  { pattern: /\bACP_PROTOCOL_VERSION\s*=/, owner: "compat.ts ACP_PROTOCOL_VERSION" },
  { pattern: /\bACP_V2_DRAFT_REVISION\s*=\s*["'`]/, owner: "compat.ts ACP_V2_DRAFT_REVISION" },
  { pattern: /\bREDSKILLS_WIRE_MAJOR\s*=\s*\d/, owner: "compat.ts REDSKILLS_WIRE_MAJOR" },
  { pattern: /function\s+requireCompatibleWireMajor\b/, owner: "compat.ts requireCompatibleWireMajor" },
  { pattern: /function\s+requireSupportedV2Revision\b/, owner: "compat.ts requireSupportedV2Revision" },
  { pattern: /function\s+translateV1SessionUpdateToV2\b/, owner: "compat.ts translateV1SessionUpdateToV2" },
  { pattern: /function\s+socketStream\b/, owner: "transport.ts socketStream" },
  { pattern: /function\s+bindWorkerRendezvous\b/, owner: "transport.ts bindWorkerRendezvous" },
  { pattern: /function\s+connectWithDeadline\b/, owner: "transport.ts connectWithDeadline" },
  { pattern: /function\s+removeAcpEndpoint\b/, owner: "transport.ts removeAcpEndpoint" },
] as const;

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

describe("shared ACP wire ownership guard (#4008)", () => {
  it("keeps ACP compat, the wire major and the socket transport in @reddb-io/protocol-acp", () => {
    const violations: string[] = [];
    for (const root of WIRE_CONSUMERS) {
      for (const path of sourceFiles(root)) {
        const source = readFileSync(path, "utf8");
        for (const rule of WIRE_COPIES) {
          if (rule.pattern.test(source)) {
            violations.push(`${path.slice(path.indexOf("apps/"))}: private copy of ${rule.owner}`);
          }
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("spells every `_redskills/*` method name only in the shared registry", () => {
    const literal = /["'`]_redskills\/[a-z_]+["'`]/;
    const violations: string[] = [];
    for (const root of WIRE_CONSUMERS) {
      for (const path of sourceFiles(root)) {
        if (literal.test(readFileSync(path, "utf8"))) {
          violations.push(`${path.slice(path.indexOf("apps/"))}: _redskills/* literal outside the registry`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
    expect(REDSKILLS_ACP_METHOD_NAMES.length).toBeGreaterThan(0);
  });

  it("serves the daemon and the adapters from one copy of the wire", () => {
    for (const module of ["compat.ts", "methods.ts", "transport.ts"]) {
      expect(readFileSync(join(WIRE_PACKAGE, module), "utf8").length).toBeGreaterThan(0);
    }
    const controlPlane = readFileSync(
      resolve(__dirname, "..", "..", "redskilled", "src", "acp-control-plane.ts"),
      "utf8",
    );
    expect(controlPlane).toContain('from "@reddb-io/protocol-acp"');
  });
});

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { REDSKILLS_ACP_METHOD_NAMES } from "@reddb-io/protocol-acp";

const ADAPTERS = [
  "src/mcp-server.ts",
  "src/project-acp-adapter.ts",
  "../redskilled/src/acp-client.ts",
] as const;

/**
 * The tool schemas `rs_dev` publishes, moved out of the Worker package by
 * issue #4023. They travel with the ADAPTERS above: a schema module that
 * reached the engine would put an engine in every session that mounts the
 * Plugin MCP, which is the cost ADR 0147 rule 2 was written to remove.
 */
const ADAPTER_TOOL_TREE = resolve(__dirname, "..", "src", "mcp-tools");

/**
 * `rs_github`, the cross-plugin GitHub MCP (#4025, ADR 0147 rule 2).
 *
 * It publishes ONE forge-shaped passthrough and forwards it. The credential
 * profile that answers, the age-stamped cache that may serve it, and the
 * coalescing that makes two concurrent identical reads cost one upstream call
 * all belong to the daemon. A token or a cache HERE would be one per session
 * per plugin — the cost ADR 0147 rule 2 removed, wearing a different name.
 */
const RS_GITHUB_TREE = resolve(__dirname, "..", "src", "mcp-github");

/**
 * `rs_brain`, the brain plugin's own MCP (#4026, ADR 0152).
 *
 * The daemon holds ONE brain for the whole host at `~/.red/brain`, so the
 * adapter publishes schemas and forwards; a RedDB, a connection string, a root
 * resolution or a channel bridge HERE would be the per-session, per-checkout
 * store the daemon took over. The MCP ENTRY is swept alongside the tree because
 * a bundle is exactly the transitive closure of its entry's imports.
 */
const RS_BRAIN_TREE = resolve(__dirname, "..", "..", "plugin-brain", "src", "rs-brain");
const RS_BRAIN_ENTRY = resolve(__dirname, "..", "..", "plugin-brain", "src", "mcp-server.ts");

const RS_BRAIN_FORBIDDEN = [
  { pattern: /brain-store\/(?:store|config|auto-linker)\.js/, owner: "a daemon-owned brain store" },
  { pattern: /brain-store\/(?:brain-act|channel-bridge)\.js/, owner: "a daemon-owned channel bridge" },
  { pattern: /@reddb-io\/sdk|\bBrainStore\b|withBrainRuntime/, owner: "a session-opened RedDB" },
] as const;

/**
 * `rs_memory`, the memory plugin's own MCP (#4027, ADR 0152).
 *
 * The daemon holds ONE store per Project at `~/.red/memory/<project-id>`, so
 * the adapter publishes the core schemas and forwards; a RedDB, a graph store,
 * a root resolution or a config read HERE would be the per-session,
 * per-checkout store the daemon took over. The MCP ENTRY is swept alongside the
 * tree because a bundle is exactly the transitive closure of its entry's
 * imports — and the tokenizer ranks ride that closure, which is why the entry
 * must reach neither `token-count` nor `js-tiktoken`.
 */
const RS_MEMORY_TREE = resolve(__dirname, "..", "..", "plugin-memory", "src", "rs-memory");
const RS_MEMORY_ENTRY = resolve(__dirname, "..", "..", "plugin-memory", "src", "mcp-server.ts");

const RS_MEMORY_FORBIDDEN = [
  { pattern: /\bMemoryStore\b|graph-store|HistoricalMemoryStore/, owner: "a daemon-owned graph store" },
  { pattern: /@reddb-io\/sdk|resolveStoreUri|readConfig|RED_MEMORY_URI/, owner: "a session-opened RedDB" },
  { pattern: /mcp-server\/serve\.js|\.\.\/engine|\.\.\/operations|governed-write/, owner: "the memory tool body" },
  { pattern: /js-tiktoken|token-count|countCl100kTokens/, owner: "the tokenizer, loaded only when tokenising" },
] as const;

const FORBIDDEN = [
  // Both spellings: the wire was `@reddb-io/red-castle/resident` before #4013
  // renamed the package, and a reintroduction would reach for the new name.
  { pattern: /(?:red-castle|worker)\/resident/, owner: "adapter-owned resident protocol" },
  { pattern: /from ["']node:fs(?:\/promises)?["']/, owner: "adapter-owned state-file read" },
  { pattern: /\.red\/state|registrationIntentPath|eventLanePath/, owner: "adapter-owned daemon state" },
  { pattern: /runtime\/gh(?:\.js)?["']/, owner: "adapter-owned GitHub client" },
  { pattern: /@reddb-io\/github|\bgh api\b|GITHUB_TOKEN|GH_TOKEN/, owner: "adapter-owned GitHub read" },
  { pattern: /mcp-worker-birth/, owner: "adapter-owned Worker birth" },
  { pattern: /\bmcp__|\.callTool\(|tools\/call/, owner: "adapter-owned operational MCP read" },
  { pattern: /sendRedskilledRequest/, owner: "private daemon protocol" },
  { pattern: /\.(?:socketPath|leasePath|machineClaimPath)\b/, owner: "private daemon endpoint" },
  { pattern: /createProjectControlStore/, owner: "adapter-owned durable Project state" },
  // ADR 0148's cut: the Worker BODY is a package the daemon embeds, never a
  // dependency of the stateless client a host starts once per session.
  { pattern: /@reddb-io\/worker/, owner: "the Worker body" },
] as const;

/**
 * What `rs_github` specifically may not hold, beyond the shared list above.
 *
 * Each pattern names an IDENTIFIER rather than a word, because the tool's own
 * description has to say "cache" and "credential profile" out loud — telling a
 * caller what the daemon does for it is the opposite of doing it here.
 */
const RS_GITHUB_FORBIDDEN = [
  { pattern: /\bsecret\b|\bBearer\b|Authorization|process\.env/, owner: "a daemon-owned credential" },
  { pattern: /createGithubCache|\bcacheKey\b|\bnew Map\b|\bnew Set\b|\binFlight\b/, owner: "a daemon-owned cache" },
  { pattern: /\bfetch\s*\(|node:https?|api\.github\.com/, owner: "a direct upstream call" },
] as const;

/** Prose describing what the adapter does NOT hold is documentation, not a hold. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

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

  // The schemas are the adapter's, so they answer to the adapter's rules (#4023).
  it("keeps the `rs_dev` tool schemas free of the engine they used to live in", () => {
    const violations: string[] = [];
    for (const path of sourceFiles(ADAPTER_TOOL_TREE)) {
      const source = readFileSync(path, "utf8");
      for (const rule of FORBIDDEN) {
        if (rule.pattern.test(source)) {
          violations.push(`${path.slice(path.indexOf("apps/"))}: ${rule.owner}`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  // Acceptance criterion of #4025: the MCP holds no token and no cache.
  it("keeps `rs_github` a forwarder — no credential, no cache, no upstream call", () => {
    const swept = sourceFiles(RS_GITHUB_TREE);
    expect(swept.length, "swept no rs_github source — a walker that reaches nothing is green by accident")
      .toBeGreaterThan(0);

    const violations: string[] = [];
    for (const path of swept) {
      const source = readFileSync(path, "utf8");
      for (const rule of FORBIDDEN) {
        if (rule.pattern.test(source)) violations.push(`${path.slice(path.indexOf("apps/"))}: ${rule.owner}`);
      }
      for (const rule of RS_GITHUB_FORBIDDEN) {
        if (rule.pattern.test(code(source))) {
          violations.push(`${path.slice(path.indexOf("apps/"))}: ${rule.owner}`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  // Acceptance criterion of #4026: the brain plugin's bundle carries no store.
  it("keeps `rs_brain` a forwarder — no RedDB, no root resolution, no bridge", () => {
    const swept = [RS_BRAIN_ENTRY, ...sourceFiles(RS_BRAIN_TREE)];
    expect(swept.length, "swept no rs_brain source — a walker that reaches nothing is green by accident")
      .toBeGreaterThan(1);

    const violations: string[] = [];
    for (const path of swept) {
      const source = readFileSync(path, "utf8");
      for (const rule of FORBIDDEN) {
        if (rule.pattern.test(source)) violations.push(`${path.slice(path.indexOf("apps/"))}: ${rule.owner}`);
      }
      for (const rule of RS_BRAIN_FORBIDDEN) {
        if (rule.pattern.test(code(source))) {
          violations.push(`${path.slice(path.indexOf("apps/"))}: ${rule.owner}`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  // Acceptance criterion of #4027: the memory plugin's adapter carries no store,
  // and the tokenizer asset is not in the surface a session mounts.
  it("keeps `rs_memory` a forwarder — no RedDB, no root resolution, no tokenizer", () => {
    const swept = [RS_MEMORY_ENTRY, ...sourceFiles(RS_MEMORY_TREE)];
    expect(swept.length, "swept no rs_memory source — a walker that reaches nothing is green by accident")
      .toBeGreaterThan(1);

    const violations: string[] = [];
    for (const path of swept) {
      const source = readFileSync(path, "utf8");
      for (const rule of FORBIDDEN) {
        if (rule.pattern.test(source)) violations.push(`${path.slice(path.indexOf("apps/"))}: ${rule.owner}`);
      }
      for (const rule of RS_MEMORY_FORBIDDEN) {
        if (rule.pattern.test(code(source))) {
          violations.push(`${path.slice(path.indexOf("apps/"))}: ${rule.owner}`);
        }
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

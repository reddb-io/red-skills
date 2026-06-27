/**
 * Tests for `mcp-passthrough.ts` — the pure planner that rewrites
 * Claude/Codex `.mcp.json` entries into opencode's `mcp:` block
 * shape (ADR 0079).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  planPluginMcp,
  readMcpJson,
  resolveScriptPath,
  rewriteServer,
} from "../src/mcp-passthrough.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oc-host-mcp-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeFile(rel: string, body: string): void {
  const abs = join(root, rel);
  const dir = abs.substring(0, abs.lastIndexOf("/"));
  require("node:fs").mkdirSync(dir, { recursive: true });
  writeFileSync(abs, body, "utf8");
}

const REPO = new URL("../../..", import.meta.url).pathname;
const REAL_PLUGINS = `${REPO}plugins`;

describe("readMcpJson", () => {
  it("returns null when the file is absent", () => {
    expect(readMcpJson(root, "dev")).toBeNull();
  });
  it("parses a Claude/Codex-shaped .mcp.json", () => {
    writeFile("dev/.mcp.json", JSON.stringify({
      mcpServers: {
        "code-nav": { command: "sh", args: ["-c", "echo hi"] },
      },
    }));
    const raw = readMcpJson(root, "dev");
    expect(raw).toBeDefined();
    expect(raw!.mcpServers!["code-nav"]!.command).toBe("sh");
  });
});

describe("resolveScriptPath (Slice 3 search order)", () => {
  it("returns the first existing candidate", () => {
    writeFile("dev/scripts/bootstrap.mjs", "console.log(1)");
    const r = resolveScriptPath(root, "dev", "scripts/bootstrap.mjs");
    expect(r.path).toContain("dev/scripts/bootstrap.mjs");
  });
  it("returns null when no candidate exists", () => {
    const r = resolveScriptPath(root, "dev", "scripts/nonexistent.mjs");
    expect(r.path).toBeNull();
  });
  it("falls back to the hooks/ layout when the scripts/ path is absent", () => {
    writeFile("dev/hooks/red-fetch.mjs", "console.log(1)");
    const r = resolveScriptPath(root, "dev", "hooks/red-fetch.mjs");
    expect(r.path).toContain("dev/hooks/red-fetch.mjs");
  });
});

describe("rewriteServer (Claude/Codex → opencode)", () => {
  it("rewrites `sh -c '...${CODEX_PLUGIN_ROOT}/scripts/bootstrap.mjs mcp'` to a node command array", () => {
    writeFile("memory/scripts/bootstrap.mjs", "console.log(1)");
    const { entry, warnings } = rewriteServer(root, "memory", "red-memory", {
      command: "sh",
      args: [
        "-c",
        "root=\"${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}\"; exec node \"$root/scripts/bootstrap.mjs\" mcp",
      ],
    });
    expect(warnings).toEqual([]);
    expect(entry.type).toBe("local");
    expect(entry.command[0]).toBe("node");
    expect(entry.command[1]).toContain("memory/scripts/bootstrap.mjs");
    expect(entry.command[2]).toBe("mcp");
    expect(entry.cwd).toBe(root);
  });

  it("rewrites `sh -c '...${CODEX_PLUGIN_ROOT}/hooks/code-nav-mcp.sh'` to a bash command array", () => {
    writeFile("dev/hooks/code-nav-mcp.sh", "echo hi");
    const { entry, warnings } = rewriteServer(root, "dev", "code-nav", {
      command: "sh",
      args: [
        "-c",
        "root=\"${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}\"; exec sh \"$root/hooks/code-nav-mcp.sh\"",
      ],
    });
    expect(warnings).toEqual([]);
    expect(entry.command[0]).toBe("bash");
    expect(entry.command[1]).toContain("dev/hooks/code-nav-mcp.sh");
  });

  it("passes through `npx -y @reddb-io/ui@latest` (red-ui) verbatim with `type: local`", () => {
    const { entry, warnings } = rewriteServer(root, "memory", "red-ui", {
      command: "npx",
      args: ["-y", "@reddb-io/ui@latest", "mcp", "--stdio"],
      env: { RED_UI_APP_URL: "https://ui.reddb.io" },
    });
    expect(warnings).toEqual([]);
    expect(entry.type).toBe("local");
    expect(entry.command).toEqual(["npx", "-y", "@reddb-io/ui@latest", "mcp", "--stdio"]);
    expect(entry.environment).toEqual({ RED_UI_APP_URL: "https://ui.reddb.io" });
  });

  it("warns and falls back to a `sh -c` wrapper when no script path resolves", () => {
    const { entry, warnings } = rewriteServer(root, "memory", "red-memory", {
      command: "sh",
      args: [
        "-c",
        "root=\"${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}\"; exec node \"$root/scripts/bootstrap.mjs\" mcp",
      ],
    });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/could not resolve/);
    // Fallback: sh -c with the source body
    expect(entry.command[0]).toBe("sh");
    expect(entry.command[1]).toBe("-c");
  });

  it("renames `env:` to `environment:` (opencode shape)", () => {
    const { entry } = rewriteServer(root, "memory", "red-ui", {
      command: "npx",
      args: ["-y", "@reddb-io/ui@latest", "mcp"],
      env: { RED_UI_APP_URL: "https://x" },
    });
    expect(entry.environment).toEqual({ RED_UI_APP_URL: "https://x" });
    expect((entry as { env?: unknown }).env).toBeUndefined();
  });
});

describe("planPluginMcp against the real source tree", () => {
  it("plans the dev plugin's code-nav MCP", () => {
    const plans = planPluginMcp(REAL_PLUGINS, "dev");
    expect(plans.length).toBeGreaterThanOrEqual(1);
    const codeNav = plans.find((p) => p.name === "code-nav");
    expect(codeNav).toBeDefined();
    expect(codeNav!.entry.type).toBe("local");
    // The source dev checkout ships the launcher; the resolved
    // command must point at the absolute script path.
    expect(codeNav!.entry.command[1]).toMatch(/code-nav-mcp\.sh$/);
  });

  it("plans the memory plugin's red-memory and red-ui MCPs", () => {
    const plans = planPluginMcp(REAL_PLUGINS, "memory");
    const names = plans.map((p) => p.name);
    expect(names).toContain("red-memory");
    expect(names).toContain("red-ui");
    const redMemory = plans.find((p) => p.name === "red-memory")!;
    expect(redMemory.entry.command[0]).toBe("node");
    expect(redMemory.entry.command[1]).toMatch(/bootstrap\.mjs$/);
    expect(redMemory.entry.command[2]).toBe("mcp");
  });

  it("plans the brain plugin's brain and red-ui MCPs", () => {
    const plans = planPluginMcp(REAL_PLUGINS, "brain");
    const names = plans.map((p) => p.name);
    expect(names).toContain("brain");
    expect(names).toContain("red-ui");
  });

  it("returns an empty list when the plugin has no .mcp.json", () => {
    expect(planPluginMcp(REAL_PLUGINS, "nonexistent-plugin")).toEqual([]);
  });
});

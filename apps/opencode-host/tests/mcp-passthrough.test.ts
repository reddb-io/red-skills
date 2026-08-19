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
  resolveHomeScriptPath,
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

describe("resolveHomeScriptPath", () => {
  it("resolves a launcher installed under the user's home", () => {
    writeFile("home/.red-skills/current/bin/rsp.mjs", "console.log(1)");
    const body =
      'if [ -f "$HOME/.red-skills/current/bin/rsp.mjs" ]; then exec node "$HOME/.red-skills/current/bin/rsp.mjs" mcp; fi';

    expect(resolveHomeScriptPath(body, join(root, "home"))).toBe(
      join(root, "home/.red-skills/current/bin/rsp.mjs"),
    );
  });

  it("keeps the mcp argument before a shell command separator", () => {
    writeFile("home/.red-skills/current/bin/rsp.mjs", "console.log(1)");
    const launcher = join(root, "home/.red-skills/current/bin/rsp.mjs");
    const previousHome = process.env.HOME;
    process.env.HOME = join(root, "home");
    try {
      const { entry, warnings } = rewriteServer(root, "dev", "rsp", {
        command: "sh",
        args: [
          "-c",
          'if [ -f "$HOME/.red-skills/current/bin/rsp.mjs" ]; then exec node "$HOME/.red-skills/current/bin/rsp.mjs" mcp; fi',
        ],
      });
      expect(warnings).toEqual([]);
      expect(entry.command).toEqual(["node", launcher, "mcp"]);
    } finally {
      process.env.HOME = previousHome;
    }
  });
});

describe("rewriteServer prefers the tree it generates from", () => {
  it("resolves against the plugin root before an explicit $HOME launcher elsewhere", () => {
    // Both exist: the plugin's own launcher and a stale Codex marketplace
    // cache the source chain names as a last resort. The emitted command must
    // point at the plugin root — the cache is the fallback, not the answer.
    writeFile("dev/hooks/redskilled-mcp.sh", "echo hi");
    writeFile("home/.codex/.tmp/marketplaces/red-skills/plugins/dev/hooks/redskilled-mcp.sh", "echo stale");
    const previousHome = process.env.HOME;
    process.env.HOME = join(root, "home");
    try {
      const { entry, warnings } = rewriteServer(root, "dev", "redskilled", {
        command: "sh",
        args: [
          "-c",
          'root="${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"; for launcher in "$root/hooks/redskilled-mcp.sh" "$HOME/.codex/.tmp/marketplaces/red-skills/plugins/dev/hooks/redskilled-mcp.sh"; do if [ -f "$launcher" ]; then exec bash "$launcher"; fi; done; exit 1',
        ],
      });
      expect(warnings).toEqual([]);
      expect(entry.command).toEqual(["bash", join(root, "dev/hooks/redskilled-mcp.sh")]);
    } finally {
      process.env.HOME = previousHome;
    }
  });

  it("resolves a repo-root bundle ($root/dist/…) against the tree that owns plugins/", () => {
    // In the materialised package set the rsp bundle sits beside plugins/, not
    // inside the dev plugin; the plugin-root candidate misses and the tree
    // root must be tried before any $HOME or Codex-cache fallback.
    writeFile("tree/dist/rsp.bundle.min.mjs", "console.log(1)");
    writeFile("tree/plugins/dev/.mcp.json", "{}");
    const previousHome = process.env.HOME;
    process.env.HOME = join(root, "home");
    try {
      const { entry, warnings } = rewriteServer(join(root, "tree/plugins"), "dev", "rsp", {
        command: "sh",
        args: [
          "-c",
          'root="${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"; for bundle in "$PWD/dist/rsp.bundle.min.mjs" "$root/dist/rsp.bundle.min.mjs" "$HOME/.red-skills/current/bin/rsp.mjs"; do if [ -f "$bundle" ]; then exec node "$bundle" mcp; fi; done; exit 1',
        ],
      });
      expect(warnings).toEqual([]);
      expect(entry.command).toEqual(["node", join(root, "tree/dist/rsp.bundle.min.mjs"), "mcp"]);
    } finally {
      process.env.HOME = previousHome;
    }
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
  // ADR 0147 §4 left each plugin declaring the one server it owns: navigator,
  // rsp and the default red-ui are switched off at the declaration, so what the
  // passthrough plans from the shipped tree is exactly that remainder.
  // ADR 0147 §2 renamed the dev plugin's adapter to `rs_dev` (#4023). The
  // launcher script keeps its own name — it is the same on-demand entry the
  // passthrough has always resolved — so only the SERVER name moved.
  it("plans the dev plugin's rs_dev MCP and nothing beside it", () => {
    const plans = planPluginMcp(REAL_PLUGINS, "dev");
    expect(plans.map((p) => p.name)).toEqual(["rs_dev"]);
    const rsDev = plans[0]!;
    expect(rsDev.entry.type).toBe("local");
    // The source dev checkout ships the launcher; the resolved
    // command must point at the absolute script path.
    expect(rsDev.entry.command[1]).toMatch(/redskilled-mcp\.sh$/);
  });

  it("keeps the installed RedSkills launcher in the runtime fallback chain", () => {
    const raw = readMcpJson(REAL_PLUGINS, "dev")!;
    const body = raw.mcpServers!.rs_dev!.args![1]!;
    expect(body).toContain("$HOME/.codex/.tmp/marketplaces/red-skills");
  });

  it("plans the memory plugin's red-memory MCP, with no default red-ui", () => {
    const plans = planPluginMcp(REAL_PLUGINS, "memory");
    expect(plans.map((p) => p.name)).toEqual(["red-memory"]);
    const redMemory = plans[0]!;
    expect(redMemory.entry.command[0]).toBe("node");
    expect(redMemory.entry.command[1]).toMatch(/bootstrap\.mjs$/);
    expect(redMemory.entry.command[2]).toBe("mcp");
  });

  // ADR 0147 §2 / #4026: the brain adapter ships as `rs_brain`.
  it("plans the brain plugin's rs_brain MCP, with no default red-ui", () => {
    expect(planPluginMcp(REAL_PLUGINS, "brain").map((p) => p.name)).toEqual(["rs_brain"]);
  });

  it("returns an empty list when the plugin has no .mcp.json", () => {
    expect(planPluginMcp(REAL_PLUGINS, "nonexistent-plugin")).toEqual([]);
  });
});

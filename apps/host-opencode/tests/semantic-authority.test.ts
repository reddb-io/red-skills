/**
 * Tests for the native-LSP deferral (issue #3972).
 *
 * Three claims are under test:
 *   1. The rule itself: navigator is dropped when — and only when — the host
 *      answers navigation natively.
 *   2. The generated fixtures: a `--host redcode` tree omits navigator while a
 *      `--host opencode` tree still publishes it.
 *   3. Process birth: nothing in the RedCode composition names a command that
 *      would spawn a language server, so the deferral is not one flag away
 *      from the duplicate stack it exists to prevent.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applySemanticAuthority,
  defersNavigation,
  isHostTarget,
  isNavigatorMcp,
  resolveSemanticAuthority,
} from "../src/semantic-authority.js";
import { planEmit } from "../src/emit.js";
import type { McpPlan } from "../src/mcp-passthrough.js";

/**
 * A plugins tree that still DECLARES navigator.
 *
 * ADR 0147 §4 switched navigator off in the shipped `plugins/` tree, and the
 * deferral rule is precisely about what happens when a host is handed one — so
 * reading the shipped tree here would make every assertion below pass for the
 * wrong reason (nothing to defer is not the same as deferring). The fixture is
 * the pre-0147 shape, kept because the rule outlives the switch-off: navigator
 * returns once the daemon has a memory ceiling of its own.
 */
function navigatorPluginsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "semantic-authority-plugins-"));
  const declare = (plugin: string, servers: Record<string, unknown>): void => {
    mkdirSync(join(root, plugin, "hooks"), { recursive: true });
    writeFileSync(
      join(root, plugin, ".mcp.json"),
      JSON.stringify({ mcpServers: servers }, null, 2) + "\n",
      "utf8",
    );
  };
  const shC = (body: string) => ({ command: "sh", args: ["-c", body] });
  declare("dev", {
    navigator: shC('root="${CODEX_PLUGIN_ROOT:-}"; exec bash "$root/hooks/code-nav-mcp.sh"'),
    redskilled: shC('root="${CODEX_PLUGIN_ROOT:-}"; exec bash "$root/hooks/redskilled-mcp.sh"'),
  });
  writeFileSync(join(root, "dev/hooks/code-nav-mcp.sh"), "#!/usr/bin/env bash\n", "utf8");
  writeFileSync(join(root, "dev/hooks/redskilled-mcp.sh"), "#!/usr/bin/env bash\n", "utf8");
  declare("memory", { "red-memory": shC('exec node "$root/scripts/bootstrap.mjs" mcp') });
  declare("brain", { brain: shC('exec node "$root/scripts/bootstrap.mjs" mcp') });
  return root;
}

const FIXTURE_PLUGINS = navigatorPluginsRoot();

/** The language servers the navigator spawns (apps/mcp-navigator/src/config.ts). */
const LANGUAGE_SERVER_COMMANDS = [
  "typescript-language-server",
  "gopls",
  "rust-analyzer",
  "pyright-langserver",
];

function plan(name: string, command: string[]): McpPlan {
  return { name, entry: { type: "local", command, enabled: true }, warnings: [] };
}

describe("semantic authority (the rule)", () => {
  it("gives redcode native LSP and a bare opencode none", () => {
    expect(resolveSemanticAuthority("redcode").nativeLsp).toBe(true);
    expect(resolveSemanticAuthority("opencode").nativeLsp).toBe(false);
  });

  it("obeys an explicit override in both directions", () => {
    expect(resolveSemanticAuthority("redcode", false).nativeLsp).toBe(false);
    expect(resolveSemanticAuthority("opencode", true).nativeLsp).toBe(true);
  });

  it("defers navigation only when native authority is available", () => {
    expect(defersNavigation(resolveSemanticAuthority("redcode"))).toBe(true);
    expect(defersNavigation(resolveSemanticAuthority("redcode", false))).toBe(false);
    expect(defersNavigation(resolveSemanticAuthority("opencode"))).toBe(false);
  });

  it("names the navigator MCP and nothing else", () => {
    expect(isNavigatorMcp("navigator")).toBe(true);
    expect(isNavigatorMcp("redskilled")).toBe(false);
    expect(isNavigatorMcp("rsp")).toBe(false);
  });

  it("rejects a host it does not know how to emit for", () => {
    expect(isHostTarget("opencode")).toBe(true);
    expect(isHostTarget("redcode")).toBe(true);
    expect(isHostTarget("vscode")).toBe(false);
  });

  it("drops only the navigator plan, keeping every other MCP", () => {
    const plans = [
      plan("navigator", ["bash", "/x/code-nav-mcp.sh"]),
      plan("redskilled", ["bash", "/x/redskilled-mcp.sh"]),
      plan("rsp", ["node", "/x/rsp.mjs", "mcp"]),
    ];
    const applied = applySemanticAuthority(plans, resolveSemanticAuthority("redcode"));
    expect(applied.plans.map((p) => p.name)).toEqual(["redskilled", "rsp"]);
    expect(applied.deferred).toEqual(["navigator"]);
  });

  it("keeps every plan when the host has no LSP of its own", () => {
    const plans = [plan("navigator", ["bash", "/x/code-nav-mcp.sh"])];
    const applied = applySemanticAuthority(plans, resolveSemanticAuthority("opencode"));
    expect(applied.plans.map((p) => p.name)).toEqual(["navigator"]);
    expect(applied.deferred).toEqual([]);
  });
});

describe("host generation fixtures (the emitted tree)", () => {
  const CONFIG = "plugins:\n  dev:\n    enabled: true\n";

  function emit(host: "opencode" | "redcode", nativeLsp?: boolean): Record<string, unknown> {
    const outRoot = mkdtempSync(join(tmpdir(), "semantic-authority-"));
    try {
      const emitPlan = planEmit({
        pluginsRoot: FIXTURE_PLUGINS,
        plugins: ["dev"],
        configText: CONFIG,
        env: {},
        semanticAuthority: resolveSemanticAuthority(host, nativeLsp),
      });
      mkdirSync(outRoot, { recursive: true });
      // Only the opencode.json matters here; write it from the plan directly
      // so the fixture stays about the MCP block, not symlink portability.
      const dev = emitPlan.byPlugin.find((p) => p.plugin === "dev")!;
      const json: Record<string, unknown> = { ...dev.provider };
      if (dev.mcp.length > 0) {
        json.mcp = Object.fromEntries(dev.mcp.map((m) => [m.name, m.entry]));
      }
      const path = join(outRoot, "opencode.json");
      writeFileSync(path, JSON.stringify(json, null, 2) + "\n", "utf8");
      return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } finally {
      rmSync(outRoot, { recursive: true, force: true });
    }
  }

  it("omits navigator from the redcode composition", () => {
    const mcp = emit("redcode").mcp as Record<string, unknown>;
    expect(Object.keys(mcp)).not.toContain("navigator");
    // The deferral is scoped: RedCode still receives the MCPs it has no
    // native answer for.
    expect(Object.keys(mcp)).toContain("redskilled");
  });

  it("publishes navigator to a non-redcode host", () => {
    const mcp = emit("opencode").mcp as Record<string, unknown>;
    expect(Object.keys(mcp)).toContain("navigator");
    expect(Object.keys(mcp)).toContain("redskilled");
  });

  it("publishes navigator to redcode when its native LSP is switched off", () => {
    const mcp = emit("redcode", false).mcp as Record<string, unknown>;
    expect(Object.keys(mcp)).toContain("navigator");
  });

  it("records what it deferred, so a missing MCP is explained", () => {
    const emitPlan = planEmit({
      pluginsRoot: FIXTURE_PLUGINS,
      plugins: ["dev"],
      configText: CONFIG,
      env: {},
      semanticAuthority: resolveSemanticAuthority("redcode"),
    });
    expect(emitPlan.semanticAuthority).toEqual({ host: "redcode", nativeLsp: true });
    expect(emitPlan.byPlugin[0]!.deferredMcp).toEqual(["navigator"]);
  });

  it("defaults to a bare opencode host when no authority is passed", () => {
    const emitPlan = planEmit({
      pluginsRoot: FIXTURE_PLUGINS,
      plugins: ["dev"],
      configText: CONFIG,
      env: {},
    });
    expect(emitPlan.semanticAuthority).toEqual({ host: "opencode", nativeLsp: false });
    expect(emitPlan.byPlugin[0]!.mcp.map((m) => m.name)).toContain("navigator");
  });
});

describe("process birth (nothing spawns a second language server)", () => {
  const CONFIG = "plugins:\n  dev:\n    enabled: true\n";

  function commandsFor(host: "opencode" | "redcode"): string[] {
    const emitPlan = planEmit({
      pluginsRoot: FIXTURE_PLUGINS,
      plugins: ["dev", "memory", "brain"],
      configText: CONFIG,
      env: {},
      semanticAuthority: resolveSemanticAuthority(host),
    });
    return emitPlan.byPlugin.flatMap((p) => p.mcp.flatMap((m) => m.entry.command));
  }

  it("names no navigator launcher in the redcode composition", () => {
    const commands = commandsFor("redcode");
    expect(commands.length).toBeGreaterThan(0);
    for (const token of commands) {
      expect(token).not.toMatch(/code-nav/);
      expect(token).not.toMatch(/red-skills-code-nav/);
    }
  });

  it("names no language-server binary in the redcode composition", () => {
    const commands = commandsFor("redcode");
    for (const token of commands) {
      for (const server of LANGUAGE_SERVER_COMMANDS) {
        expect(token).not.toContain(server);
      }
    }
  });

  it("does name the navigator launcher for a host without native LSP", () => {
    // The negative above is only evidence if the positive holds: a projection
    // that dropped navigator everywhere would pass the redcode assertions for
    // the wrong reason.
    const commands = commandsFor("opencode");
    expect(commands.some((token) => /code-nav/.test(token))).toBe(true);
  });
});

// plugin-structural-smoke — the shipped plugin tree declares only what ADR 0147
// §4 left switched ON (issue #4010).
//
// `rsp` and `navigator` woke one heavy process per session per plugin, and
// `red-ui` woke a third-party one for memory and brain whether or not the
// project ever opened a graph. ADR 0147 §4 switches all three OFF at the
// DECLARATION — the code under `apps/rsp` and `apps/code-nav` stays for the
// fold-in — so what has to be pinned is an ABSENCE, and an absence is exactly
// what nobody notices coming back. A generated manifest, a merge that restores
// a stanza, a copy-paste from an older marketplace checkout: each puts the
// entry back silently, and the cost lands on the operator's machine as three
// processes nobody asked for.
//
// The sweep is structural on purpose: it reads the shipped files rather than a
// runtime, so it holds on a host that never starts an MCP at all.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** The MCP servers one plugin's `.mcp.json` declares, in declaration order. */
function declaredServers(plugin: string): string[] {
  const raw = readFileSync(join(ROOT, "plugins", plugin, ".mcp.json"), "utf8");
  const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
  return Object.keys(parsed.mcpServers ?? {});
}

/** Every `command` string anywhere in a hook manifest, args appended. */
function manifestCommands(relativePath: string): string[] {
  const commands: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.command === "string") {
      const args = Array.isArray(record.args)
        ? record.args.filter((a): a is string => typeof a === "string")
        : [];
      commands.push([record.command, ...args].join(" "));
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(JSON.parse(readFileSync(join(ROOT, relativePath), "utf8")));
  return commands;
}

/** Every hook manifest the three shipped plugins install on a host. */
const HOOK_MANIFESTS = [
  "plugins/dev/hooks/claude.hooks.json",
  "plugins/dev/hooks/codex.hooks.json",
  "plugins/memory/hooks/claude.hooks.json",
  "plugins/memory/hooks/codex.hooks.json",
  "plugins/brain/hooks/claude.hooks.json",
  "plugins/brain/hooks/codex.hooks.json",
] as const;

describe("the dev MCP declaration carries neither rsp nor navigator (ADR 0147 §4)", () => {
  it("declares the daemon client and nothing else", () => {
    expect(declaredServers("dev")).toEqual(["rs_dev"]);
  });

  it("names rsp and navigator nowhere in the file", () => {
    const raw = readFileSync(join(ROOT, "plugins/dev/.mcp.json"), "utf8");
    expect(raw).not.toMatch(/\brsp\b/);
    expect(raw).not.toMatch(/\bnavigator\b/);
    expect(raw).not.toMatch(/code-nav/);
  });
});

describe("memory and brain declare no default red-ui", () => {
  it("leaves memory with its own local data server only", () => {
    expect(declaredServers("memory")).toEqual(["red-memory"]);
  });

  // #4026: the brain adapter is `rs_brain` (ADR 0147 §2), still the one server
  // the plugin declares.
  it("leaves brain with its own local data server only", () => {
    expect(declaredServers("brain")).toEqual(["rs_brain"]);
  });

  it("keeps the viewer out of both declarations, opt-in or not", () => {
    // The opt-in path is the generator (`optedInMcpServers`), never a stanza
    // that ships enabled and is switched off afterwards.
    for (const plugin of ["memory", "brain"]) {
      expect(declaredServers(plugin)).not.toContain("red-ui");
    }
  });
});

describe("the hook manifests carry no rsp hook and no rsp-instructions injection", () => {
  for (const manifest of HOOK_MANIFESTS) {
    it(`${manifest} invokes no rsp hook`, () => {
      const offenders = manifestCommands(manifest).filter((command) =>
        command.includes("rsp-hook.sh") || /\brsp\.bundle\b/.test(command),
      );
      expect(offenders, `${manifest} still wires the rsp prime/pre-exec/post-exec hook`).toEqual([]);
    });

    it(`${manifest} injects no rsp instructions at session start`, () => {
      const offenders = manifestCommands(manifest).filter((command) =>
        command.includes("rsp-instructions"),
      );
      expect(offenders, `${manifest} still injects the rsp ambient skill`).toEqual([]);
    });
  }

  it("leaves behind no hook group that fires nothing", () => {
    // A matcher whose `hooks` array emptied out when its only entry left is a
    // manifest that still declares interest in a tool and then does nothing
    // with it — the host pays the dispatch, the operator reads a live wiring.
    for (const manifest of HOOK_MANIFESTS) {
      const parsed = JSON.parse(readFileSync(join(ROOT, manifest), "utf8")) as {
        hooks?: Record<string, Array<{ hooks?: unknown[] }>>;
      };
      for (const [event, groups] of Object.entries(parsed.hooks ?? {})) {
        for (const group of groups) {
          expect(group.hooks?.length ?? 0, `${manifest}: an empty ${event} group survives`)
            .toBeGreaterThan(0);
        }
      }
    }
  });
});

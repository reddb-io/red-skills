// An MCP server is declared once and started from EVERY directory the operator
// works in — which is almost never this repo. A launcher chain that can only
// resolve through `$CODEX_PLUGIN_ROOT` or `$PWD` therefore works where it was
// developed and nowhere else, and the host reports the miss as a transport
// failure ("Broken pipe when send initialize request"), not as a missing file.
//
// This shipped in `plugins/dev/.mcp.json` with THREE servers and three different
// resolution strategies: `navigator` carried the installed-marketplace fallback
// and worked; the daemon client and `rsp`, declared three lines away, did not and failed
// in every repo but this one. The difference was invisible because each server's
// chain reads plausibly on its own. Two of the three left with ADR 0147 §4; the
// contract outlives them, because the next server declared here inherits it.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** A command that resolves its own program needs no path — npm/npx fetch it. */
const SELF_RESOLVING = ["npx", "npm", "pnpm", "bunx"];

/**
 * A candidate that survives a foreign cwd with no plugin-root env var.
 *
 * `$HOME`-anchored is the whole test: `$root` is unset outside a plugin host and
 * `$PWD` is the operator's repo, so a chain built only from those two resolves
 * nothing. An absolute path under the user's home is the one candidate that is
 * true wherever the agent was started.
 */
const HOME_ANCHORED = /"\$HOME\//;

interface Declaration {
  readonly file: string;
  readonly server: string;
  readonly command: string;
  readonly script: string;
}

async function declarations(): Promise<Declaration[]> {
  const found: Declaration[] = [];
  for (const plugin of await readdir(join(ROOT, "plugins"))) {
    const path = join(ROOT, "plugins", plugin, ".mcp.json");
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue; // a plugin may ship no MCP servers at all
    }
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, { command?: string; args?: string[] }> };
    for (const [server, config] of Object.entries(parsed.mcpServers ?? {})) {
      found.push({
        file: `plugins/${plugin}/.mcp.json`,
        server,
        command: config.command ?? "",
        script: (config.args ?? []).join(" "),
      });
    }
  }
  return found;
}

describe("every MCP server resolves from a directory that is not this repo (#3186-adjacent)", () => {
  it("gives each file-resolving launcher a $HOME-anchored candidate", async () => {
    const all = await declarations();
    expect(all.length, "found no MCP declarations — a walker that reaches nothing is green by accident")
      .toBeGreaterThan(0);

    const unreachable = all
      .filter((d) => !SELF_RESOLVING.includes(d.command))
      .filter((d) => !HOME_ANCHORED.test(d.script))
      .map((d) => `${d.file}: "${d.server}" resolves only through $CODEX_PLUGIN_ROOT/$PWD`);

    expect(
      unreachable,
      `these servers start only from this repo, and the host reports the miss as a broken transport:\n` +
        `${unreachable.join("\n")}\n\n` +
        `Add the installed-marketplace path to the candidate loop, the way \`rs_dev\` already does.`,
    ).toEqual([]);
  });

  it("keeps every dev server on the SAME reachability contract", async () => {
    // Stated separately because this is the shape that shipped: siblings in one
    // file, one of them correct, and nothing comparing them. ADR 0147 §4 left
    // one sibling standing; the comparison holds as the set changes because it
    // reads the file rather than a list somebody remembered to update.
    const dev = (await declarations()).filter((d) => d.file === "plugins/dev/.mcp.json");
    expect(dev.map((d) => d.server).sort()).toEqual(["rs_dev"]);
    for (const server of dev) {
      expect(HOME_ANCHORED.test(server.script), `${server.server} lost its $HOME-anchored candidate`).toBe(true);
    }
  });

  it("forwards host project-directory variables through the rs_dev npm launcher", async () => {
    const launcher = await readFile(join(ROOT, "plugins/dev/hooks/redskilled-mcp.sh"), "utf8");
    expect(launcher).toContain("RED_SKILLS_PROJECT_ROOT");
    expect(launcher).toContain("CLAUDE_PROJECT_DIR");
    expect(launcher).toContain("CODEX_PROJECT_DIR");
    expect(launcher).toContain("OPENCODE_PROJECT_DIR");
    expect(launcher).toContain('export RED_SKILLS_PROJECT_ROOT="$project_root"');
  });
});

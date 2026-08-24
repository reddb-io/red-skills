import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const PLUGINS = ["dev", "memory", "brain"] as const;

async function writeLauncher(root: string, plugin: (typeof PLUGINS)[number], identity: string): Promise<void> {
  if (plugin === "dev") {
    await mkdir(join(root, "hooks"), { recursive: true });
    await writeFile(join(root, "hooks/redskilled-mcp.sh"), `#!/usr/bin/env bash\nprintf '${identity}\\n'\n`);
    return;
  }

  await mkdir(join(root, ".claude-plugin"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, ".claude-plugin/plugin.json"), '{"version":"test"}\n');
  await writeFile(join(root, "scripts/bootstrap.mjs"), `process.stdout.write("${identity}\\n");\n`);
}

describe("Plugin MCP launchers prefer red-dev's verified current package set", () => {
  for (const plugin of PLUGINS) {
    it(`does not let a stale ${plugin} source checkout shadow the installed set`, async () => {
      const sandbox = await mkdtemp(join(tmpdir(), `rs-${plugin}-installed-set-`));
      const home = join(sandbox, "home");
      const cwd = join(sandbox, "stale-checkout");
      const installed = join(home, ".red/skills/current/plugins", plugin);
      const stale = join(cwd, "plugins", plugin);
      await writeLauncher(installed, plugin, `current-${plugin}`);
      await writeLauncher(stale, plugin, `stale-${plugin}`);

      const manifest = JSON.parse(
        await readFile(join(ROOT, "plugins", plugin, ".mcp.json"), "utf8"),
      ) as { mcpServers: Record<string, { command: string; args: string[] }> };
      const declaration = Object.values(manifest.mcpServers)[0];
      const launched = spawnSync(declaration.command, declaration.args, {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: "",
          CODEX_PLUGIN_ROOT: "",
          HOME: home,
        },
      });
      await rm(sandbox, { force: true, recursive: true });

      expect(launched.status, launched.stderr).toBe(0);
      expect(launched.stdout).toBe(`current-${plugin}\n`);
    });
  }
});

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@reddb-io/toon";
import { describe, expect, it } from "vitest";
import { prepareImplementerEnvironment } from "../src/runtime/implementer-environment.js";

function skill(
  root: string,
  plugin: string,
  bucket: string,
  name: string,
): void {
  const dir = join(root, plugin, "skills", bucket, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    dir + "/SKILL.md",
    `---\nname: ${name}\ndescription: ${name} workflow\n---\n\n# ${name}\n`,
  );
}

function plugin(
  root: string,
  name: "dev" | "memory" | "brain",
  skills: string[],
): string {
  const dir = join(root, name);
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(dir, ".codex-plugin"), { recursive: true });
  const manifest = JSON.stringify({ name, version: "1.0.0", skills }, null, 2);
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), manifest);
  writeFileSync(join(dir, ".codex-plugin", "plugin.json"), manifest);
  // The transports the projection reads, which live in their own file beside the
  // manifests exactly as they do in this repository. `dev` is the plugin that
  // owns `navigator` and `rsp`, so a fixture without them projects an MCP it
  // cannot describe.
  writeFileSync(
    join(dir, ".mcp.json"),
    JSON.stringify({
      mcpServers: Object.fromEntries(
        // The servers each plugin really owns, mirroring this repository's own
        // `.mcp.json` files: dev has navigator and rsp, memory has red-memory,
        // brain has brain, and both carry red-ui.
        ({
          dev: ["navigator", "rsp"],
          memory: ["red-memory", "red-ui"],
          brain: ["brain", "red-ui"],
        })[name].map((server) => [server, { command: "sh", args: ["-c", "true"] }]),
      ),
    }, null, 2),
  );
  return dir;
}

describe("prepareImplementerEnvironment", () => {
  it("materialises runner-native projections and a dashboard-readable metrics artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "implementer-env-"));
    const plugins = join(root, "plugins");
    skill(plugins, "dev", "engineering", "tdd");
    skill(plugins, "dev", "engineering", "triage");
    mkdirSync(
      join(plugins, "dev", "skills", "engineering", "triage", "scripts"),
    );
    writeFileSync(
      join(
        plugins,
        "dev",
        "skills",
        "engineering",
        "triage",
        "scripts",
        "runtime.sh",
      ),
      "#!/bin/sh\n",
    );
    skill(plugins, "memory", "core", "recall");
    skill(plugins, "brain", "core", "search");
    const pluginRoots = {
      dev: plugin(plugins, "dev", [
        "./skills/engineering/tdd",
        "./skills/engineering/triage",
      ]),
      memory: plugin(plugins, "memory", ["./skills/core/recall"]),
      brain: plugin(plugins, "brain", ["./skills/core/search"]),
    };
    const ticks = [0, 8, 10, 13];
    const attemptDir = join(root, "attempt");
    mkdirSync(attemptDir);

    const prepared = prepareImplementerEnvironment({
      attemptDir,
      configText:
        "plugins:\n  dev:\n    enabled: true\n  memory:\n    enabled: true\n",
      pluginRoots,
      historicalRunnerStartupMs: 840,
      nowMs: () => ticks.shift() ?? 13,
    });
    prepared.recordRunnerStartup(510);

    expect(prepared.runtime.claudePluginDirs).toEqual([
      join(attemptDir, "implementer", "plugins", "dev"),
      join(attemptDir, "implementer", "plugins", "memory"),
    ]);
    // Ambient plugins are refused wholesale rather than disabled one name at a
    // time (#3801): an empty map cannot be outvoted by a plugin this projection
    // has never heard of, which naming each one always could.
    expect(prepared.runtime.codexConfigOverrides).toContain("features.plugins=false");
    expect(prepared.runtime.codexConfigOverrides).toContain("plugins={}");
    expect(prepared.runtime.codexConfigOverrides).toContain("marketplaces={}");
    expect(prepared.runtime.codexConfigOverrides).toContain(
      `skills.config=[{path=${JSON.stringify(
        join(
          attemptDir,
          "implementer/plugins/dev/skills/engineering/tdd/SKILL.md",
        ),
      )},enabled=true},{path=${JSON.stringify(
        join(
          attemptDir,
          "implementer/plugins/memory/skills/core/recall/SKILL.md",
        ),
      )},enabled=true}]`,
    );
    expect(prepared.runtime.codexConfigOverrides.join("\n")).not.toContain(
      "triage/SKILL.md",
    );
    expect(prepared.runtime.opencodeConfigDir).toBe(
      join(attemptDir, "implementer", "opencode"),
    );

    const devManifest = JSON.parse(
      readFileSync(
        join(attemptDir, "implementer/plugins/dev/.claude-plugin/plugin.json"),
        "utf8",
      ),
    ) as { skills: string[] };
    expect(devManifest.skills).toEqual(["./skills/engineering/tdd"]);
    expect(
      existsSync(
        join(
          attemptDir,
          "implementer/plugins/dev/skills/engineering/triage/SKILL.md",
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(
          attemptDir,
          "implementer/plugins/dev/skills/engineering/triage/scripts/runtime.sh",
        ),
      ),
    ).toBe(true);

    const artifact = decode(readFileSync(prepared.artifactPath, "utf8")) as {
      projection_setup_time_ms: {
        before: number;
        after: number;
        delta: number;
      };
      runner_startup_ms: { before: number; after: number; delta: number };
      skill_manifest_bytes: { before: number; after: number; delta: number };
      skills: string[];
    };
    expect(artifact.projection_setup_time_ms).toEqual({
      before: 8,
      after: 3,
      delta: -5,
    });
    expect(artifact.runner_startup_ms).toEqual({
      before: 840,
      after: 510,
      delta: -330,
    });
    const exactBeforeBytes = Object.values(pluginRoots).reduce(
      (total, root) =>
        total + statSync(join(root, ".codex-plugin/plugin.json")).size,
      0,
    );
    const exactAfterBytes = prepared.runtime.claudePluginDirs.reduce(
      (total, root) =>
        total + statSync(join(root, ".codex-plugin/plugin.json")).size,
      0,
    );
    expect(artifact.skill_manifest_bytes).toEqual({
      before: exactBeforeBytes,
      after: exactAfterBytes,
      delta: exactAfterBytes - exactBeforeBytes,
    });
    expect(artifact.skills).toEqual(["dev:tdd", "memory:recall"]);
  });
});

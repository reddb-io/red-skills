import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
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
      nowMs: () => ticks.shift() ?? 13,
    });

    expect(prepared.runtime.claudePluginDirs).toEqual([
      join(attemptDir, "implementer", "plugins", "dev"),
      join(attemptDir, "implementer", "plugins", "memory"),
    ]);
    expect(prepared.runtime.codexConfigOverrides).toContain(
      'plugins."brain@red-skills".enabled=false',
    );
    expect(prepared.runtime.codexConfigOverrides.join("\n")).toContain(
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
      boot_time_ms: { before: number; after: number; delta: number };
      payload_bytes: { before: number; after: number; delta: number };
      skills: string[];
    };
    expect(artifact.boot_time_ms).toEqual({ before: 8, after: 3, delta: -5 });
    expect(artifact.payload_bytes.after).toBeLessThan(
      artifact.payload_bytes.before,
    );
    expect(artifact.skills).toEqual(["dev:tdd", "memory:recall"]);
  });
});

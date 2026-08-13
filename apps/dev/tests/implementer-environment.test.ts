import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_IMPLEMENTER_DEV_SKILLS,
  buildImplementerMetrics,
  resolveImplementerProjection,
  type ImplementerSkill,
} from "../src/core/implementer-environment.js";
import { buildAgent, type AgentFactories } from "../src/core/execution.js";
import { prepareImplementerEnvironment } from "../src/runtime/implementer-environment.js";

const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function pluginFixture(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `implementer-${name}-`));
  scratchRoots.push(root);
  for (const host of ["claude", "codex"]) {
    mkdirSync(join(root, `.${host}-plugin`), { recursive: true });
    writeFileSync(join(root, `.${host}-plugin`, "plugin.json"), JSON.stringify({ name, skills: ["./skills"] }));
  }
  mkdirSync(join(root, "skills", "tdd"), { recursive: true });
  writeFileSync(join(root, "skills", "tdd", "SKILL.md"), "---\nname: tdd\ndescription: test first\n---\n");
  return root;
}

const catalog: ImplementerSkill[] = [
  {
    plugin: "dev",
    name: "tdd",
    path: "/plugins/dev/skills/engineering/tdd",
  },
  {
    plugin: "dev",
    name: "diagnose",
    path: "/plugins/dev/skills/engineering/diagnose",
  },
  {
    plugin: "dev",
    name: "triage",
    path: "/plugins/dev/skills/engineering/triage",
  },
  {
    plugin: "dev",
    name: "daily-review",
    path: "/plugins/dev/skills/engineering/daily-review",
  },
  {
    plugin: "memory",
    name: "recall",
    path: "/plugins/memory/skills/core/recall",
  },
  {
    plugin: "memory",
    name: "store",
    path: "/plugins/memory/skills/core/store",
  },
  {
    plugin: "brain",
    name: "search",
    path: "/plugins/brain/skills/core/search",
  },
];

function config(extra = ""): string {
  return `plugins:\n  dev:\n    enabled: true\n${extra}`;
}

describe("resolveImplementerProjection", () => {
  it("documents the canonical namespaced allowlist YAML shape", () => {
    const docs = readFileSync(
      new URL(
        "../../../plugins/dev/skills/engineering/afk/docs/CONFIG.md",
        import.meta.url,
      ),
      "utf8",
    );

    expect(docs).toContain("`plugins.dev.afk.implementer.skills`");
    expect(docs).toContain(
      "plugins:\n  dev:\n    afk:\n      implementer:\n        skills: dev:tdd, dev:diagnose",
    );
    expect(docs).not.toContain(
      "afk:\n  implementer:\n    skills: dev:tdd, dev:diagnose",
    );
  });

  it("loads only the implementer-trimmed dev surface when only dev is enabled", () => {
    expect(DEFAULT_IMPLEMENTER_DEV_SKILLS).toContain("tdd");
    expect(DEFAULT_IMPLEMENTER_DEV_SKILLS).toContain("diagnose");
    expect(DEFAULT_IMPLEMENTER_DEV_SKILLS).not.toContain("triage");

    const projection = resolveImplementerProjection(config(), catalog);

    expect(projection.enabledPlugins).toEqual(["dev"]);
    expect(
      projection.skills.map((skill) => `${skill.plugin}:${skill.name}`),
    ).toEqual(["dev:tdd", "dev:diagnose"]);
    expect(
      projection.excluded.map((skill) => `${skill.plugin}:${skill.name}`),
    ).toEqual([
      "dev:triage",
      "dev:daily-review",
      "memory:recall",
      "memory:store",
      "brain:search",
    ]);
  });

  it("restores memory and brain surfaces when their activation gates are enabled", () => {
    const projection = resolveImplementerProjection(
      config("  memory:\n    enabled: true\n  brain:\n    enabled: true\n"),
      catalog,
    );

    expect(projection.enabledPlugins).toEqual(["dev", "memory", "brain"]);
    expect(
      projection.skills.map((skill) => `${skill.plugin}:${skill.name}`),
    ).toEqual([
      "dev:tdd",
      "dev:diagnose",
      "memory:recall",
      "memory:store",
      "brain:search",
    ]);
  });

  it("uses an explicit allowlist as a widening override within enabled plugins", () => {
    const projection = resolveImplementerProjection(
      config(
        "    afk:\n      implementer:\n        skills: dev:tdd, dev:triage\n",
      ),
      catalog,
    );

    expect(projection.source).toBe("operator-allowlist");
    expect(
      projection.skills.map((skill) => `${skill.plugin}:${skill.name}`),
    ).toEqual(["dev:tdd", "dev:triage"]);
  });

  it("uses an explicit allowlist as a narrowing override and never bypasses plugin activation", () => {
    const projection = resolveImplementerProjection(
      config(
        "    afk:\n      implementer:\n        skills: dev:tdd, memory:recall\n",
      ),
      catalog,
    );

    expect(
      projection.skills.map((skill) => `${skill.plugin}:${skill.name}`),
    ).toEqual(["dev:tdd"]);
  });
});

describe("prepared Codex implementer projection", () => {
  it("materializes only navigator when user and project fixtures contain unknown MCPs", () => {
    const dev = pluginFixture("dev");
    writeFileSync(join(dev, ".mcp.json"), JSON.stringify({ mcpServers: {
      navigator: { command: "node", args: ["navigator.mjs"] },
      "project-unknown": { command: "node", args: ["unknown.mjs"] },
    } }));
    const attemptDir = mkdtempSync(join(tmpdir(), "implementer-attempt-"));
    scratchRoots.push(attemptDir);
    const prepared = prepareImplementerEnvironment({ attemptDir, configText: config(), pluginRoots: { dev } });
    const overrides = prepared.runtime.codexConfigOverrides.join("\n");

    expect(overrides).toContain("features.plugins=false");
    expect(overrides).toContain("features.apps=false");
    expect(overrides).toContain("features.hooks=false");
    expect(overrides).toContain("mcp_servers={navigator=");
    expect(overrides).not.toContain("project-unknown");
    expect(overrides).not.toContain("user-unknown");
    expect(overrides).toContain("skills.config=[");
  });

  it("materializes every optional MCP exactly when project configuration enables it", () => {
    const dev = pluginFixture("dev");
    const memory = pluginFixture("memory");
    const brain = pluginFixture("brain");
    writeFileSync(join(dev, ".mcp.json"), JSON.stringify({ mcpServers: {
      navigator: { command: "node", args: ["navigator.mjs"] },
      rsp: { command: "node", args: ["rsp.mjs"] },
      redskilled: { command: "node", args: ["redskilled.mjs"] },
    } }));
    writeFileSync(join(memory, ".mcp.json"), JSON.stringify({ mcpServers: {
      "red-memory": { command: "node", args: ["memory.mjs"] },
      "red-ui": { command: "node", args: ["ui.mjs"] },
    } }));
    writeFileSync(join(brain, ".mcp.json"), JSON.stringify({ mcpServers: {
      brain: { command: "node", args: ["brain.mjs"] },
    } }));
    const attemptDir = mkdtempSync(join(tmpdir(), "implementer-attempt-"));
    scratchRoots.push(attemptDir);
    const prepared = prepareImplementerEnvironment({
      attemptDir,
      configText: config("  memory:\n    enabled: true\n  brain:\n    enabled: true\n  red-ui:\n    enabled: true\n") + "rsp:\n  enabled: true\n",
      pluginRoots: { dev, memory, brain },
    });
    const mcp = prepared.runtime.codexConfigOverrides.find((override) => override.startsWith("mcp_servers="));

    expect(mcp).toContain("navigator=");
    expect(mcp).toContain("red-memory=");
    expect(mcp).toContain("brain=");
    expect(mcp).toContain("red-ui=");
    expect(mcp).toContain("rsp=");
    expect(mcp).not.toContain("redskilled=");
  });
});

describe("buildImplementerMetrics", () => {
  it("captures runner-startup and exact manifest before/after deltas for run artifacts", () => {
    const projection = resolveImplementerProjection(config(), catalog);
    const metrics = buildImplementerMetrics(projection, {
      legacyProjectionSetupMs: 42,
      projectedProjectionSetupMs: 17,
      historicalRunnerStartupMs: 840,
      projectedRunnerStartupMs: 510,
      legacySkillManifestBytes: 1_540,
      projectedSkillManifestBytes: 420,
    });

    expect(metrics.projection_setup_time_ms).toEqual({
      before: 42,
      after: 17,
      delta: -25,
    });
    expect(metrics.runner_startup_ms).toEqual({
      before: 840,
      after: 510,
      delta: -330,
    });
    expect(metrics.skill_manifest_bytes).toEqual({
      before: 1_540,
      after: 420,
      delta: -1_120,
    });
    expect(metrics.skill_count).toEqual({ before: 7, after: 2, delta: -5 });
  });
});

describe("buildAgent implementer projection", () => {
  it("maps one projection onto each runner's native isolation options", () => {
    const calls: Record<string, unknown[]> = {
      claude: [],
      codex: [],
      opencode: [],
    };
    const agent = {
      name: "fake",
      env: {},
      captureSessions: false,
      buildPrintCommand: () => ({ command: "fake" }),
      buildInteractiveArgs: () => [],
      parseStreamLine: () => [],
    };
    const factories: AgentFactories = {
      claudeCode: (_model, options) => (calls.claude.push(options), agent),
      codex: (_model, options) => (calls.codex.push(options), agent),
      opencode: (_model, options) => (calls.opencode.push(options), agent),
    };
    const implementer = {
      claudePluginDirs: ["/runtime/dev"],
      codexConfigOverrides: ['plugins."memory@red-skills".enabled=false'],
      opencodeConfigDir: "/runtime/opencode",
    };

    buildAgent(factories, "claude", "model", { implementer }, {});
    buildAgent(factories, "codex", "model", { implementer }, {});
    buildAgent(factories, "opencode", "provider/model", { implementer }, {});

    expect(calls.claude).toEqual([
      {
        settingSources: ["project", "local"],
        pluginDirs: ["/runtime/dev"],
      },
    ]);
    expect(calls.codex).toEqual([
      {
        ignoreUserConfig: true,
        ignoreRules: true,
        configOverrides: ['plugins."memory@red-skills".enabled=false'],
      },
    ]);
    expect(calls.opencode).toEqual([
      {
        env: { OPENCODE_CONFIG_DIR: "/runtime/opencode" },
      },
    ]);
  });
});

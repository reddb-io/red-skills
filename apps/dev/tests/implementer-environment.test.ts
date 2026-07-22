import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMPLEMENTER_DEV_SKILLS,
  buildImplementerMetrics,
  resolveImplementerProjection,
  type ImplementerSkill,
} from "../src/core/implementer-environment.js";
import { buildAgent, type AgentFactories } from "../src/core/execution.js";

const catalog: ImplementerSkill[] = [
  {
    plugin: "dev",
    name: "tdd",
    path: "/plugins/dev/skills/engineering/tdd",
    payloadBytes: 120,
  },
  {
    plugin: "dev",
    name: "diagnose",
    path: "/plugins/dev/skills/engineering/diagnose",
    payloadBytes: 140,
  },
  {
    plugin: "dev",
    name: "triage",
    path: "/plugins/dev/skills/engineering/triage",
    payloadBytes: 160,
  },
  {
    plugin: "dev",
    name: "daily-review",
    path: "/plugins/dev/skills/engineering/daily-review",
    payloadBytes: 180,
  },
  {
    plugin: "memory",
    name: "recall",
    path: "/plugins/memory/skills/core/recall",
    payloadBytes: 200,
  },
  {
    plugin: "memory",
    name: "store",
    path: "/plugins/memory/skills/core/store",
    payloadBytes: 220,
  },
  {
    plugin: "brain",
    name: "search",
    path: "/plugins/brain/skills/core/search",
    payloadBytes: 240,
  },
];

function config(extra = ""): string {
  return `plugins:\n  dev:\n    enabled: true\n${extra}`;
}

describe("resolveImplementerProjection", () => {
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

describe("buildImplementerMetrics", () => {
  it("captures boot-time and catalog-payload before/after deltas for run artifacts", () => {
    const projection = resolveImplementerProjection(config(), catalog);
    const metrics = buildImplementerMetrics(projection, {
      legacyBootMs: 42,
      projectedBootMs: 17,
    });

    expect(metrics.boot_time_ms).toEqual({ before: 42, after: 17, delta: -25 });
    expect(metrics.payload_bytes).toEqual({
      before: 1_260,
      after: 260,
      delta: -1_000,
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

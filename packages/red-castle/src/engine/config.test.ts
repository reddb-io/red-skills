import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadEngineConfig,
  parseEngineConfigYaml,
  readEngineHitlTypeLabels,
  readEngineLabelVocabulary,
  readEngineBackpressure,
} from "./config.js";

function redRootWithConfig(text?: string): string {
  const root = mkdtempSync(join(tmpdir(), "castle-config-"));
  const redRoot = join(root, ".red");
  mkdirSync(redRoot, { recursive: true });
  if (text !== undefined)
    writeFileSync(join(redRoot, "config.yaml"), text, "utf8");
  return redRoot;
}

describe("engine config reader", () => {
  it("keeps the ADR 0067 gate closed without plugins.dev.enabled: true", () => {
    const redRoot = redRootWithConfig(
      "plugins:\n  dev:\n    afk:\n      sandbox: docker\n",
    );

    const cfg = loadEngineConfig(redRoot, { env: {} });

    expect(cfg.enabled).toBe(false);
    expect(cfg.get("afk.sandbox")).toBe("none");
  });

  it("folds frozen plugins.dev.afk names over legacy afk names", () => {
    const redRoot = redRootWithConfig(
      [
        "plugins:",
        "  dev:",
        "    enabled: true",
        "    afk:",
        "      sandbox: podman",
        "      default_runner: codex",
        "      backpressure:",
        "        - pnpm test",
        "        - pnpm lint",
        "afk:",
        "  sandbox: docker",
        "  default_runner: claude",
        "  backpressure:",
        "    - npm test",
        "",
      ].join("\n"),
    );

    const cfg = loadEngineConfig(redRoot, { env: {} });

    expect(cfg.enabled).toBe(true);
    expect(cfg.get("afk.sandbox")).toBe("podman");
    expect(cfg.get("afk.default_runner")).toBe("codex");
    expect(readEngineBackpressure(cfg)).toEqual(["pnpm test", "pnpm lint"]);
  });

  it("honors frozen RED_AFK overrides without mutating the parsed key names", () => {
    const redRoot = redRootWithConfig(
      [
        "plugins:",
        "  dev:",
        "    enabled: true",
        "afk:",
        "  sandbox: docker",
        "  max_iterations: 4",
        "  statusline_cache_ttl: 42",
        "",
      ].join("\n"),
    );

    const cfg = loadEngineConfig(redRoot, {
      env: {
        RED_AFK_SANDBOX: "podman",
        RED_AFK_RUNNER: "codex",
        RED_AFK_MAX_ITERATIONS: "8",
        RED_AFK_STATUSLINE_CACHE_TTL_S: "77",
      },
    });

    expect(cfg.get("afk.sandbox")).toBe("podman");
    expect(cfg.get("afk.default_runner")).toBe("codex");
    expect(cfg.get("afk.max_iterations")).toBe("8");
    expect(cfg.get("afk.statusline_cache_ttl")).toBe("77");
    expect(cfg.values["RED_AFK_SANDBOX"]).toBeUndefined();
  });

  it("ignores deleted attempt-era timeout knobs", () => {
    const redRoot = redRootWithConfig(
      [
        "plugins:",
        "  dev:",
        "    enabled: true",
        "afk:",
        "  attempt_timeout: 99",
        "",
      ].join("\n"),
    );

    const cfg = loadEngineConfig(redRoot, {
      env: {
        RED_AFK_ATTEMPT_TIMEOUT_S: "123",
      },
    });

    expect(cfg.get("afk.attempt_timeout")).toBe("");
    expect(cfg.values.RED_AFK_ATTEMPT_TIMEOUT_S).toBeUndefined();
  });

  it("parses list values into indexed dotted keys", () => {
    expect(
      parseEngineConfigYaml(
        "afk:\n  backpressure:\n    - pnpm test\n    - 'pnpm lint' # comment\n",
      ),
    ).toMatchObject({
      "afk.backpressure.0": "pnpm test",
      "afk.backpressure.1": "pnpm lint",
    });
  });

  it("reads tracker label vocabulary from config instead of engine constants", () => {
    const redRoot = redRootWithConfig(
      [
        "plugins:",
        "  dev:",
        "    enabled: true",
        "    afk:",
        "      labels:",
        "        ready: queue:agent",
        "        running: state:running",
        "        human: queue:human",
        "        dependency_blocked: wait:dependency",
        "        req_prefix: depends-on:",
        "",
      ].join("\n"),
    );

    const cfg = loadEngineConfig(redRoot, { env: {} });

    expect(readEngineLabelVocabulary(cfg)).toEqual({
      ready: "queue:agent",
      running: "state:running",
      human: "queue:human",
      needsTriage: "needs-triage",
      needsInfo: "needs-info",
      quarantine: "quarantine",
      dependencyBlocked: "wait:dependency",
      blockedPrefix: "blocked:",
      reqPrefix: "depends-on:",
      hitlTypes: [],
    });
  });

  it("reads the declared HUMAN-ONLY type labels as a list", () => {
    const redRoot = redRootWithConfig(
      [
        "plugins:",
        "  dev:",
        "    enabled: true",
        "    afk:",
        "      labels:",
        "        hitl_types:",
        "          - wayfinder:grilling",
        "          - wayfinder:prototype",
        "",
      ].join("\n"),
    );

    const cfg = loadEngineConfig(redRoot, { env: {} });

    expect(readEngineHitlTypeLabels(cfg)).toEqual([
      "wayfinder:grilling",
      "wayfinder:prototype",
    ]);
    expect(readEngineLabelVocabulary(cfg).hitlTypes).toEqual([
      "wayfinder:grilling",
      "wayfinder:prototype",
    ]);
  });

  it("accepts a single HUMAN-ONLY type written as a scalar", () => {
    const redRoot = redRootWithConfig(
      [
        "plugins:",
        "  dev:",
        "    enabled: true",
        "    afk:",
        "      labels:",
        "        hitl_types: wayfinder:grilling",
        "",
      ].join("\n"),
    );

    expect(readEngineHitlTypeLabels(loadEngineConfig(redRoot, { env: {} }))).toEqual([
      "wayfinder:grilling",
    ]);
  });

  it("declares no HUMAN-ONLY type when the repo never opted in", () => {
    const redRoot = redRootWithConfig("plugins:\n  dev:\n    enabled: true\n");

    expect(readEngineHitlTypeLabels(loadEngineConfig(redRoot, { env: {} }))).toEqual([]);
  });
});

import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  auditConfigLoad,
  CONFIG_DEFAULTS,
  DELETED_CONFIG_KEYS,
  getConfig,
  loadConfig,
  MalformedConfigError,
  parseConfigYaml,
  readValidationMoments,
  readSetupCommands,
  readHitlTypeLabels,
  readValidationResourceBudget,
  downgradeAfkModelTier,
  resolveTier,
  resolveCiTimeoutSeconds,
  DEFAULT_MERGE_CI_TIMEOUT_S,
  rootDevConfigCollisionsFromText,
  SANCTIONED_ROOT_CONFIG_KEYS,
} from "../src/core/config.js";
import { PROJECT_NAME_CONFIG_KEY } from "@reddb-io/shared/project-identity.js";
import {
  DEFAULT_FLEET_WIDTH_CONFIG,
  FLEET_WIDTH_CONFIG_KEY,
} from "@reddb-io/shared/default-fleet-width.js";
import {
  aggregateAdversarialReviewFindings,
  decideAdversarialReview,
  resolveAdversarialReviewer,
  resolveAdversarialReviewConfig,
} from "../src/core/adversarial-review.js";

async function writeConfig(yaml: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "afk-config-"));
  const path = join(dir, ".red", "config.yaml");
  await mkdir(join(dir, ".red"), { recursive: true });
  await writeFile(path, yaml, "utf8");
  return path;
}

// The loader is FAIL-CLOSED (ADR 0116): a config that never sets
// `plugins.dev.enabled: true` yields the defaults and none of its own settings.
// The parse/fold cases below are about the GRAMMAR and the ADR 0042 namespace
// fold, not about activation, so they pass `ignoreActivationGate: true` and read
// the file as data. The gate itself is covered by its own describe block, with
// realistic opted-in and opted-out fixtures.

describe("config — activation gate (ADR 0116)", () => {
  const OPTED_IN = "plugins:\n  dev:\n    enabled: true\n    afk:\n      default_runner: codex\n";
  const OPTED_OUT = "plugins:\n  dev:\n    afk:\n      default_runner: codex\n";

  it("an opted-in directory reads its own settings", () => {
    const audit = auditConfigLoad("/x/.red/config.yaml", { read: () => OPTED_IN, warn: () => {} });
    expect(audit.pluginEnabled).toBe(true);
    expect(audit.gateClosed).toBe(false);
    expect(getConfig(audit.values, "afk.default_runner")).toBe("codex");
  });

  it("a directory without the explicit opt-in sees the defaults, not its own settings", () => {
    const audit = auditConfigLoad("/x/.red/config.yaml", { read: () => OPTED_OUT, warn: () => {} });
    expect(audit.pluginEnabled).toBe(false);
    expect(audit.gateClosed).toBe(true);
    expect(audit.discarded).toBe(false); // gate-closed is NOT malformed
    expect(getConfig(audit.values, "afk.default_runner")).toBe("claude");
  });

  it("`enabled: false` is as closed as an absent key", () => {
    const text = "plugins:\n  dev:\n    enabled: false\n    afk:\n      default_runner: codex\n";
    const values = loadConfig("/x/.red/config.yaml", { read: () => text, warn: () => {} });
    expect(getConfig(values, "afk.default_runner")).toBe("claude");
  });

  it("the gate closes on the legacy top-level block too — opting in is the only key that opens it", () => {
    const values = loadConfig("/x/.red/config.yaml", {
      read: () => "afk:\n  default_runner: codex\n",
      warn: () => {},
    });
    expect(getConfig(values, "afk.default_runner")).toBe("claude");
  });

  it("ignoreActivationGate reads a closed directory's settings as data", () => {
    const values = loadConfig("/x/.red/config.yaml", {
      read: () => OPTED_OUT,
      warn: () => {},
      ignoreActivationGate: true,
    });
    expect(getConfig(values, "afk.default_runner")).toBe("codex");
  });

  it("a missing file is closed but not gate-closed — there is nothing to discard", () => {
    const audit = auditConfigLoad("/nonexistent/.red/config.yaml", { warn: () => {} });
    expect(audit.fileLoaded).toBe(false);
    expect(audit.pluginEnabled).toBe(false);
    expect(audit.gateClosed).toBe(false);
  });

  it("still reports root-accessor collisions in a gate-closed directory", () => {
    const audit = auditConfigLoad("/x/.red/config.yaml", {
      read: () => "dev:\n  trunk: develop\n",
      warn: () => {},
    });
    expect(audit.gateClosed).toBe(true);
    expect(audit.rootAccessorCollisions.map((c) => c.key)).toContain("dev.trunk");
  });
});

describe("config — host-scoped redskilled policy", () => {
  it("warns and discards machine limits found in a project file", () => {
    const warnings: string[] = [];
    const text = [
      "plugins:",
      "  dev:",
      "    enabled: true",
      "    redskilled:",
      "      worker_ceiling: 99",
      "",
    ].join("\n");
    const values = loadConfig("/repo/.red/config.yaml", { read: () => text, warn: (message) => warnings.push(message) });

    expect(values["dev.redskilled.worker_ceiling"]).toBeUndefined();
    expect(warnings.join("\n")).toContain("host-scoped");
    expect(warnings.join("\n")).toContain("~/.red/config.yaml");
  });
});

describe("config — retired-key tombstone (ADR 0117)", () => {
  const RETIRED = "plugins:\n  dev:\n    enabled: true\n    afk:\n      attempt_timeout: 99\n";

  it("names the retired key, warns, and never reads it back", () => {
    const warnings: string[] = [];
    const audit = auditConfigLoad("/x/.red/config.yaml", {
      read: () => RETIRED,
      warn: (m) => warnings.push(m),
    });
    expect(audit.retiredKeys).toEqual(["plugins.dev.afk.attempt_timeout"]);
    expect(warnings.join("\n")).toContain("RETIRED");
    expect(getConfig(audit.values, "afk.attempt_timeout")).toBe("");
    expect(getConfig(audit.values, "plugins.dev.afk.attempt_timeout")).toBe("");
  });

  it("tombstones the legacy top-level spelling too", () => {
    const audit = auditConfigLoad("/x/.red/config.yaml", {
      read: () => "plugins:\n  dev:\n    enabled: true\nafk:\n  attempt_timeout: 99\n",
      warn: () => {},
    });
    expect(audit.retiredKeys).toEqual(["afk.attempt_timeout"]);
    expect(getConfig(audit.values, "afk.attempt_timeout")).toBe("");
  });

  it("reports a retired key even when the activation gate closed", () => {
    const warnings: string[] = [];
    const audit = auditConfigLoad("/x/.red/config.yaml", {
      read: () => "afk:\n  attempt_timeout: 99\n",
      warn: (m) => warnings.push(m),
    });
    expect(audit.gateClosed).toBe(true);
    expect(audit.retiredKeys).toEqual(["afk.attempt_timeout"]);
    expect(warnings.join("\n")).toContain("RETIRED");
  });

  it("an unknown forward-compat key is NOT a retired one — it parses silently", () => {
    const warnings: string[] = [];
    const audit = auditConfigLoad("/x/.red/config.yaml", {
      read: () => "plugins:\n  dev:\n    enabled: true\n    afk:\n      not_a_key_yet: 1\n",
      warn: (m) => warnings.push(m),
    });
    expect(audit.retiredKeys).toEqual([]);
    expect(warnings.join("\n")).not.toContain("RETIRED");
    expect(getConfig(audit.values, "afk.not_a_key_yet")).toBe("1");
  });

  it("every tombstone is genuinely retired — none of them has a live default", () => {
    for (const key of DELETED_CONFIG_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, key)).toBe(false);
    }
  });
});

describe("config — sanctioned root keys", () => {
  const OPT_IN = "plugins:\n  dev:\n    enabled: true\n";

  it("`project.name` at the root is sanctioned — no off-contract warning", () => {
    const warnings: string[] = [];
    const audit = auditConfigLoad("/x/.red/config.yaml", {
      read: () => `project:\n  name: Red Skills\n${OPT_IN}`,
      warn: (m) => warnings.push(m),
    });
    expect(audit.rootAccessorCollisions).toEqual([]);
    expect(warnings.join("\n")).not.toContain("off-contract");
    expect(getConfig(audit.values, "project.name")).toBe("Red Skills");
  });

  it("an unsanctioned root key is still off-contract", () => {
    const warnings: string[] = [];
    const audit = auditConfigLoad("/x/.red/config.yaml", {
      read: () => `dev:\n  trunk: main\n${OPT_IN}`,
      warn: (m) => warnings.push(m),
    });
    expect(audit.rootAccessorCollisions.map((c) => c.key)).toEqual(["dev.trunk"]);
    expect(warnings.join("\n")).toContain("off-contract");
  });

  it("the sanction is per-key, not per-namespace — `project.other` is not sanctioned into existence", () => {
    expect(SANCTIONED_ROOT_CONFIG_KEYS.has("project.name")).toBe(true);
    expect(SANCTIONED_ROOT_CONFIG_KEYS.has("project.other")).toBe(false);
  });

  it("the sanctioned key matches the shared reader's key", () => {
    expect(SANCTIONED_ROOT_CONFIG_KEYS.has(PROJECT_NAME_CONFIG_KEY)).toBe(true);
  });
});

describe("config", () => {
  it("missing file → all defaults, no warning", async () => {
    const warnings: string[] = [];
    const values = loadConfig(join(tmpdir(), "nope", ".red", "config.yaml"), { ignoreActivationGate: true,
      warn: (m) => warnings.push(m),
    });
    expect(getConfig(values, "afk.default_runner")).toBe("claude");
    expect(getConfig(values, FLEET_WIDTH_CONFIG_KEY)).toBe(DEFAULT_FLEET_WIDTH_CONFIG);
    expect(getConfig(values, "afk.hooks.defaults.cargo")).toBe("true");
    expect(getConfig(values, "afk.hooks.defaults.gradle")).toBe("true");
    expect(getConfig(values, "dev.lock.primary-branch")).toBe("false");
    expect(warnings).toHaveLength(0);
  });

  it("partial override only touches the specified key", async () => {
    const path = await writeConfig(`afk:\n  default_runner: codex\n`);
    const values = loadConfig(path, { ignoreActivationGate: true });
    expect(getConfig(values, "afk.default_runner")).toBe("codex");
    expect(getConfig(values, FLEET_WIDTH_CONFIG_KEY)).toBe(DEFAULT_FLEET_WIDTH_CONFIG);
    expect(getConfig(values, "afk.hooks.defaults.cargo")).toBe("true");
    expect(getConfig(values, "afk.hooks.defaults.gradle")).toBe("true");
  });

  it("unknown top-level key is ignored without warning", async () => {
    const warnings: string[] = [];
    const path = await writeConfig(`zzz: foo\nafk:\n  default_runner: codex\n`);
    const values = loadConfig(path, { ignoreActivationGate: true, warn: (m) => warnings.push(m) });
    expect(getConfig(values, FLEET_WIDTH_CONFIG_KEY)).toBe(DEFAULT_FLEET_WIDTH_CONFIG);
    expect(getConfig(values, "afk.default_runner")).toBe("codex");
    expect(getConfig(values, "zzz")).toBe("foo");
    expect(warnings).toHaveLength(0);
  });

  it("unknown nested key is ignored silently", async () => {
    const warnings: string[] = [];
    const path = await writeConfig(`afk:\n  default_runner: codex\n  unknown_thing: 42\n`);
    const values = loadConfig(path, { ignoreActivationGate: true, warn: (m) => warnings.push(m) });
    expect(getConfig(values, "afk.default_runner")).toBe("codex");
    expect(getConfig(values, FLEET_WIDTH_CONFIG_KEY)).toBe(DEFAULT_FLEET_WIDTH_CONFIG);
    expect(warnings).toHaveLength(0);
  });

  it("malformed YAML (unclosed quote) → one warning, all defaults", async () => {
    const warnings: string[] = [];
    const path = await writeConfig(`afk:\n  default_runner: "codex\n`);
    const values = loadConfig(path, { ignoreActivationGate: true, warn: (m) => warnings.push(m) });
    expect(getConfig(values, "afk.default_runner")).toBe("claude");
    expect(getConfig(values, FLEET_WIDTH_CONFIG_KEY)).toBe(DEFAULT_FLEET_WIDTH_CONFIG);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("config.yaml");
  });

  it("malformed YAML (odd indentation) → one warning, all defaults", async () => {
    const warnings: string[] = [];
    const path = await writeConfig(`afk:\n   default_runner: codex\n`);
    const values = loadConfig(path, { ignoreActivationGate: true, warn: (m) => warnings.push(m) });
    expect(getConfig(values, "afk.default_runner")).toBe("claude");
    expect(warnings).toHaveLength(1);
  });

  it("every documented v1 key has a default", () => {
    const values = loadConfig("/nonexistent/.red/config.yaml", { ignoreActivationGate: true, warn: () => {} });
    for (const key of Object.keys(CONFIG_DEFAULTS)) {
      expect(getConfig(values, key)).not.toBe("");
    }
  });

  it("reads afk.release.channel and defaults it to stable (ADR 0058)", () => {
    const defaults = loadConfig("/nonexistent/.red/config.yaml", { ignoreActivationGate: true, warn: () => {} });
    expect(getConfig(defaults, "afk.release.channel")).toBe("stable");

    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true,
      read: () => "plugins:\n  dev:\n    afk:\n      release:\n        channel: canary\n",
    });
    expect(getConfig(values, "afk.release.channel")).toBe("canary");
  });

  it("reads dev.lock.primary-branch and defaults it off", () => {
    const defaults = loadConfig("/nonexistent/.red/config.yaml", { ignoreActivationGate: true, warn: () => {} });
    expect(getConfig(defaults, "dev.lock.primary-branch")).toBe("false");

    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true,
      read: () => "dev:\n  lock:\n    primary-branch: true\n",
    });
    expect(getConfig(values, "dev.lock.primary-branch")).toBe("true");
  });

  it("reads afk.review_gate.* and defaults the gate off at the complex threshold (#749)", () => {
    const defaults = loadConfig("/nonexistent/.red/config.yaml", { ignoreActivationGate: true, warn: () => {} });
    expect(getConfig(defaults, "afk.review_gate.enabled")).toBe("false");
    expect(getConfig(defaults, "afk.review_gate.threshold")).toBe("complex");

    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true,
      read: () =>
        "plugins:\n  dev:\n    afk:\n      review_gate:\n        enabled: true\n        threshold: simple\n",
    });
    expect(getConfig(values, "afk.review_gate.enabled")).toBe("true");
    expect(getConfig(values, "afk.review_gate.threshold")).toBe("simple");
  });

  it("folds plugins.dev.review.* to dev.review.* like every other dev accessor (#2207, #2244)", () => {
    const defaults = loadConfig("/nonexistent/.red/config.yaml", { ignoreActivationGate: true, warn: () => {} });
    expect(getConfig(defaults, "dev.review.enabled")).toBe("false");
    expect(getConfig(defaults, "dev.review.max_iterations")).toBe("1");
    expect(getConfig(defaults, "dev.review.reviewer_count")).toBe("1");
    expect(getConfig(defaults, "dev.review.quorum")).toBe("any");
    expect(resolveAdversarialReviewConfig((key) => getConfig(defaults, key))).toEqual({
      enabled: false,
      maxIterations: 1,
      reviewerCount: 1,
      quorum: "any",
    });

    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true,
      read: () =>
        "plugins:\n  dev:\n    review:\n      enabled: true\n      max_iterations: 3\n",
    });
    expect(getConfig(values, "dev.review.enabled")).toBe("true");
    expect(getConfig(values, "dev.review.max_iterations")).toBe("3");
    expect(resolveAdversarialReviewConfig((key) => getConfig(values, key))).toEqual({
      enabled: true,
      maxIterations: 3,
      reviewerCount: 1,
      quorum: "any",
    });
  });

  it("resolves adversarial reviewer count/quorum and reviewer runner overrides (#2210)", () => {
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true,
      read: () =>
        [
          "plugins:",
          "  dev:",
          "    review:",
          "      enabled: true",
          "      reviewer_count: 3",
          "      quorum: 2",
          "      runner: codex",
          "      model: gpt-review",
          "      effort: medium",
          "",
        ].join("\n"),
    });
    const config = resolveAdversarialReviewConfig((key) => getConfig(values, key));
    expect(config).toEqual({
      enabled: true,
      maxIterations: 1,
      reviewerCount: 3,
      quorum: 2,
      runner: "codex",
      model: "gpt-review",
      effort: "medium",
    });
    expect(
      resolveAdversarialReviewer({
        config,
        implementer: { runner: "claude", model: "claude-opus-4-8", effort: "high" },
        taskClass: "complex",
        resolveTier: () => ({ model: "gpt-tier", effort: "low" }),
      }),
    ).toEqual({ runner: "codex", model: "gpt-review", effort: "medium" });
  });

  it("defaults the adversarial reviewer to the implementer's resolved runner/model/effort (#2210)", () => {
    const config = resolveAdversarialReviewConfig((key) => getConfig(loadConfig("/missing", { ignoreActivationGate: true, warn: () => {} }), key));
    expect(
      resolveAdversarialReviewer({
        config,
        implementer: { runner: "claude", model: "claude-opus-4-8", effort: "high" },
        taskClass: "simple",
        resolveTier: () => ({ model: "unused", effort: "low" }),
      }),
    ).toEqual({ runner: "claude", model: "claude-opus-4-8", effort: "high" });
  });

  it("uses the model-tier table when only review.runner is overridden (#2210)", () => {
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true,
      read: () => "plugins:\n  dev:\n    review:\n      runner: codex\n",
    });
    const config = resolveAdversarialReviewConfig((key) => getConfig(values, key));
    expect(
      resolveAdversarialReviewer({
        config,
        implementer: { runner: "claude", model: "claude-opus-4-8", effort: "high" },
        taskClass: "validate",
        resolveTier: (runner, tier) => {
          expect(runner).toBe("codex");
          expect(tier).toBe("validate");
          return { model: "gpt-validate", effort: "low" };
        },
      }),
    ).toEqual({ runner: "codex", model: "gpt-validate", effort: "low" });
  });

  it("keeps a configured reviewer model the runner CAN dispatch (#2352)", () => {
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true,
      read: () => "plugins:\n  dev:\n    review:\n      runner: codex\n      model: gpt-5.6-sol\n      effort: high\n",
    });
    const config = resolveAdversarialReviewConfig((key) => getConfig(values, key));
    expect(
      resolveAdversarialReviewer({
        config,
        implementer: { runner: "claude", model: "claude-opus-4-8", effort: "high" },
        taskClass: "complex",
        resolveTier: () => ({ model: "gpt-5.5", effort: "medium" }),
      }),
    ).toEqual({ runner: "codex", model: "gpt-5.6-sol", effort: "high" });
  });

  it("substitutes a cross-runner model pin with the runner's review-tier default (#2352)", () => {
    // The #2352 outage: a codex model pinned repo-wide, run through the claude CLI.
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true,
      read: () => "plugins:\n  dev:\n    review:\n      enabled: true\n      model: gpt-5.6-sol\n      effort: medium\n",
    });
    const config = resolveAdversarialReviewConfig((key) => getConfig(values, key));
    const resolved = resolveAdversarialReviewer({
      config,
      implementer: { runner: "claude", model: "claude-opus-4-8", effort: "high" },
      taskClass: "complex",
      resolveTier: () => ({ model: "claude-opus-4-8", effort: "medium" }),
    });
    expect(resolved).toMatchObject({ runner: "claude", model: "claude-opus-4-8", effort: "medium" });
    expect(resolved.notices?.[0]).toContain("cannot run model 'gpt-5.6-sol'");
    expect(resolved.notices?.[0]).toContain("claude-opus-4-8");
  });

  it("falls back to the shipped tier table when no tier resolver can supply a runnable model (#2352)", () => {
    const resolved = resolveAdversarialReviewer({
      config: { enabled: true, maxIterations: 1, reviewerCount: 1, quorum: "any", runner: "codex" },
      implementer: { runner: "claude", model: "claude-opus-4-8", effort: "max" },
      taskClass: "complex",
    });
    // codex can run neither the implementer's claude model nor its `max` effort.
    expect(resolved).toMatchObject({ runner: "codex", model: "gpt-5.5", effort: "medium" });
    expect(resolved.notices).toHaveLength(2);
    expect(resolved.notices?.[1]).toContain("does not accept effort 'max'");
  });

  it("aggregates adversarial blocking findings by quorum (#2210)", () => {
    const one = {
      summary: "one",
      findings: [
        { path: "src/a.ts", line: 7, body: "real bug", blocking: true },
        { path: "src/a.ts", line: 8, body: "solo bug", blocking: true },
      ],
    };
    const two = {
      summary: "two",
      findings: [
        { path: "src/a.ts", line: 7, body: "real bug", blocking: true },
        { path: "src/a.ts", line: 9, body: "nit", blocking: false },
      ],
    };
    const aggregated = aggregateAdversarialReviewFindings([one, two], 2);
    expect(aggregated.findings.filter((finding) => finding.body === "real bug").every((finding) => finding.blocking)).toBe(true);
    expect(aggregated.findings.find((finding) => finding.body === "solo bug")?.blocking).toBe(false);
    expect(aggregated.findings.find((finding) => finding.body === "nit")?.blocking).toBe(false);
  });

  it("reduces the review verdict to blocking / not-blocking, with no cap branch (#2730)", () => {
    // The retired third value encoded "blocking, but the cap says land anyway" —
    // the branch that let the documented default budget merge code carrying a
    // known blocking finding. There is nowhere left for a cap to enter: the
    // budget lives in the Re-seed budget, which parks uniformly.
    expect(
      decideAdversarialReview({
        summary: "blocking issue found",
        findings: [{ path: "src/a.ts", line: 1, body: "bug", blocking: true }],
      }),
    ).toBe("blocking");
    expect(
      decideAdversarialReview({
        summary: "nit only",
        findings: [{ path: "src/a.ts", line: 1, body: "style", blocking: false }],
      }),
    ).toBe("not-blocking");
    expect(decideAdversarialReview({ summary: "clean", findings: [] })).toBe("not-blocking");
  });

  it("folds the namespaced `plugins.dev.lock.primary-branch` onto `dev.lock.primary-branch`", () => {
    // The root-sacred convention: dev-plugin keys nest under `plugins.dev.*` and
    // fold to the `dev.*` accessor (afk keeps its bare `afk.*` accessor).
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true,
      read: () => "plugins:\n  dev:\n    lock:\n      primary-branch: true\n",
    });
    expect(getConfig(values, "dev.lock.primary-branch")).toBe("true");
  });

  it("folds `plugins.dev` dev-keys and afk-keys to their distinct accessors at once", () => {
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true,
      read: () =>
        "plugins:\n  dev:\n    lock:\n      primary-branch: true\n    afk:\n      default_runner: codex\n",
    });
    expect(getConfig(values, "dev.lock.primary-branch")).toBe("true");
    expect(getConfig(values, "afk.default_runner")).toBe("codex");
  });

  it("nested override leaves siblings untouched", async () => {
    const path = await writeConfig(
      `afk:\n  hooks:\n    defaults:\n      cargo: false\n`,
    );
    const values = loadConfig(path, { ignoreActivationGate: true });
    expect(getConfig(values, "afk.hooks.defaults.cargo")).toBe("false");
    expect(getConfig(values, "afk.hooks.defaults.gradle")).toBe("true");
    expect(getConfig(values, FLEET_WIDTH_CONFIG_KEY)).toBe(DEFAULT_FLEET_WIDTH_CONFIG);
  });

  it("integer values round-trip as strings", async () => {
    const path = await writeConfig(`afk:\n  fleet:\n    target: 5\n`);
    const values = loadConfig(path, { ignoreActivationGate: true });
    expect(getConfig(values, "afk.fleet.target")).toBe("5");
  });

  it("comments and blank lines are ignored", async () => {
    const warnings: string[] = [];
    const yaml = [
      "# top-level comment",
      "afk:",
      "  # inner comment",
      "  default_runner: codex",
      "",
      "  fleet:",
      "    target: 3   # inline comment",
      "",
    ].join("\n");
    const path = await writeConfig(yaml);
    const values = loadConfig(path, { ignoreActivationGate: true, warn: (m) => warnings.push(m) });
    expect(getConfig(values, "afk.default_runner")).toBe("codex");
    expect(getConfig(values, "afk.fleet.target")).toBe("3");
    expect(warnings).toHaveLength(0);
  });

  it("skips full-line comments even when they contain quoted strings", () => {
    const text = [
      "plugins:",
      "  dev:",
      "    enabled: true",
      "    trunk: develop",
      "    lock:",
      "      primary-branch: true",
      "      branch: release/train",
      "# command guard examples:",
      "#     - \"rm -Rf /*\"",
      "#     - 'git stash'",
      "",
    ].join("\n");
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true, read: () => text });
    expect(getConfig(values, "plugins.dev.enabled")).toBe("true");
    expect(getConfig(values, "dev.trunk")).toBe("develop");
    expect(getConfig(values, "dev.lock.primary-branch")).toBe("true");
    expect(getConfig(values, "dev.lock.branch")).toBe("release/train");
  });

  it("strips inline comments outside quotes while preserving # inside quoted values", () => {
    expect(parseConfigYaml([
      "afk:",
      "  default_runner: codex # unquoted comment",
      "  model: \"model#tag\" # quoted scalar comment",
      "  backpressure:",
      "    - \"npm run test # focused\" # sequence comment",
      "",
    ].join("\n"))).toEqual({
      "afk.default_runner": "codex",
      "afk.model": "model#tag",
      "afk.backpressure.0": "npm run test # focused",
    });
  });

  it("malformed fallback warning names the first offending line", async () => {
    const warnings: string[] = [];
    const path = await writeConfig("afk:\n  default_runner: codex\n   fleet:\n    target: 3\n");
    loadConfig(path, { ignoreActivationGate: true, warn: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("line 3");
  });

  it("loads the shipped setup config template after activation lines are uncommented", () => {
    const template = readFileSync(
      new URL("../../../plugins/dev/skills/engineering/red-setup/config-template.yaml", import.meta.url),
      "utf8",
    );
    const activated = template
      .replace("  #   trunk: main", "    trunk: develop")
      .replace("  #   lock:", "    lock:")
      .replace("  #     primary-branch: true", "      primary-branch: true")
      .replace("  #     branch: my-branch", "      branch: release/train");
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true, read: () => activated });

    expect(getConfig(values, "plugins.dev.enabled")).toBe("true");
    expect(getConfig(values, "dev.trunk")).toBe("develop");
    expect(getConfig(values, "dev.lock.primary-branch")).toBe("true");
    expect(getConfig(values, "dev.lock.branch")).toBe("release/train");
    expect(getConfig(values, "rsp.enabled")).toBe("true");
  });

  it("getConfig returns empty string for unset keys", () => {
    const values = loadConfig("/nonexistent/.red/config.yaml", { ignoreActivationGate: true, warn: () => {} });
    expect(getConfig(values, "afk.does.not.exist")).toBe("");
  });

  it("parseConfigYaml is pure and throws MalformedConfigError on bad input", () => {
    expect(parseConfigYaml("afk:\n  default_runner: codex\n")).toEqual({
      "afk.default_runner": "codex",
    });
    expect(() => parseConfigYaml("afk:\n  default_runner: 'codex\n")).toThrow(
      MalformedConfigError,
    );
    expect(() => parseConfigYaml("- not a mapping\n")).toThrow(MalformedConfigError);
  });

  it("inline comment after double-quoted scalar parses without throwing", () => {
    const text = 'afk:\n  default_runner: "codex" # preferred runner\n';
    expect(parseConfigYaml(text)).toEqual({ "afk.default_runner": "codex" });
  });

  it("inline comment after single-quoted scalar parses without throwing", () => {
    const text = "afk:\n  default_runner: 'codex' # preferred runner\n";
    expect(parseConfigYaml(text)).toEqual({ "afk.default_runner": "codex" });
  });

  it("block-sequence config does not disable the primary-branch guard", () => {
    const text =
      'dev:\n  lock:\n    primary-branch: true\nafk:\n  backpressure:\n    - "npm run test" # full suite\n    - npm run lint\n';
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true, read: () => text });
    expect(getConfig(values, "dev.lock.primary-branch")).toBe("true");
  });

  it("injectable reader bypasses the filesystem", () => {
    const values = loadConfig("virtual.yaml", { ignoreActivationGate: true,
      read: () => "afk:\n  fleet:\n    target: 9\n",
    });
    expect(getConfig(values, "afk.fleet.target")).toBe("9");
  });
});

describe("config — plugins.dev namespace (ADR 0042)", () => {
  it("folds plugins.dev.afk.* down to the bare afk.* accessor keys", () => {
    const text = "plugins:\n  dev:\n    afk:\n      default_runner: codex\n      fleet:\n        target: 4\n";
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true, read: () => text });
    expect(getConfig(values, "afk.default_runner")).toBe("codex");
    expect(getConfig(values, "afk.fleet.target")).toBe("4");
  });

  it("still reads the legacy top-level afk.* block (back-compat)", () => {
    const text = "afk:\n  default_runner: codex\n";
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true, read: () => text });
    expect(getConfig(values, "afk.default_runner")).toBe("codex");
  });

  it("lets the namespaced location win over a legacy top-level key", () => {
    const text = "afk:\n  default_runner: claude\nplugins:\n  dev:\n    afk:\n      default_runner: codex\n";
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true, read: () => text });
    expect(getConfig(values, "afk.default_runner")).toBe("codex");
  });

  it("defaults the external-PR triage request surface off and reads the namespaced toggle", () => {
    const defaults = loadConfig("/nonexistent/.red/config.yaml", { ignoreActivationGate: true, warn: () => {} });
    expect(getConfig(defaults, "dev.triage.external_pr_surface.enabled")).toBe("false");

    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true,
      read: () =>
        "plugins:\n  dev:\n    triage:\n      external_pr_surface:\n        enabled: true\n",
    });
    expect(getConfig(values, "dev.triage.external_pr_surface.enabled")).toBe("true");
  });

  it("defaults AFK output shaping off and reads the namespaced terse-steering toggle", () => {
    const defaults = loadConfig("/nonexistent/.red/config.yaml", { ignoreActivationGate: true, warn: () => {} });
    expect(getConfig(defaults, "afk.output_shaping.terse_steering")).toBe("false");

    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true,
      read: () =>
        "plugins:\n  dev:\n    afk:\n      output_shaping:\n        terse_steering: true\n",
    });
    expect(getConfig(values, "afk.output_shaping.terse_steering")).toBe("true");
  });

  it("defaults and reads AFK validation resource budgets (#1758)", () => {
    const defaults = loadConfig("/nonexistent/.red/config.yaml", { ignoreActivationGate: true, warn: () => {} });
    expect(readValidationResourceBudget(defaults)).toEqual({
      nodeMaxOldSpaceMb: 2048,
      vitestMaxWorkers: 1,
      heavyAvailableMemoryMb: 4096,
    });

    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true,
      read: () =>
        "plugins:\n  dev:\n    afk:\n      validation:\n        node_max_old_space_mb: 1536\n        vitest_max_workers: 2\n        heavy_available_memory_mb: 3072\n",
    });
    expect(readValidationResourceBudget(values)).toEqual({
      nodeMaxOldSpaceMb: 1536,
      vitestMaxWorkers: 2,
      heavyAvailableMemoryMb: 3072,
    });
  });
});

describe("config — the Trunk (`plugins.dev.trunk`, ADR 0083)", () => {
  it("defaults dev.trunk to main when unset", () => {
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true, read: () => undefined });
    expect(getConfig(values, "dev.trunk")).toBe("main");
  });

  it("folds plugins.dev.trunk onto the dev.trunk accessor", () => {
    const text = "plugins:\n  dev:\n    trunk: develop\n";
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true, read: () => text });
    expect(getConfig(values, "dev.trunk")).toBe("develop");
  });

  it("warns when root-level dev.trunk is used, while preserving the current folded accessor behavior", () => {
    const warnings: string[] = [];
    const text = "dev:\n  trunk: develop\n";
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true,
      read: () => text,
      warn: (message) => warnings.push(message),
    });

    expect(getConfig(values, "dev.trunk")).toBe("develop");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("dev.trunk");
    expect(warnings[0]).toContain("plugins.dev.trunk");
  });

  it("keeps canonical plugins.dev.trunk ahead of accidental root-level dev.trunk", () => {
    const warnings: string[] = [];
    const text = "dev:\n  trunk: wrong\nplugins:\n  dev:\n    trunk: develop\n";
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true,
      read: () => text,
      warn: (message) => warnings.push(message),
    });

    expect(getConfig(values, "dev.trunk")).toBe("develop");
    expect(warnings).toHaveLength(1);
    expect(rootDevConfigCollisionsFromText(text)).toEqual([
      { key: "dev.trunk", canonicalKey: "plugins.dev.trunk" },
    ]);
  });

  it("does not warn for the legacy-supported top-level afk.* block", () => {
    const warnings: string[] = [];
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true,
      read: () => "afk:\n  default_runner: codex\n",
      warn: (message) => warnings.push(message),
    });

    expect(getConfig(values, "afk.default_runner")).toBe("codex");
    expect(warnings).toEqual([]);
  });

  it("accepts a namespaced branch value (e.g. workspace/<user>)", () => {
    const text = "plugins:\n  dev:\n    trunk: workspace/forattini\n";
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true, read: () => text });
    expect(getConfig(values, "dev.trunk")).toBe("workspace/forattini");
  });
});

describe("config — block sequences (#430)", () => {
  it("parses a `- item` sequence into ordered indexed keys", () => {
    const text = "afk:\n  validation:\n    post_done:\n      - npm run test\n      - npm run lint\n";
    expect(parseConfigYaml(text)).toEqual({
      "afk.validation.post_done.0": "npm run test",
      "afk.validation.post_done.1": "npm run lint",
    });
  });

  it("keeps a sibling scalar key alongside a sequence", () => {
    const text = "afk:\n  default_runner: codex\n  setup:\n    - npm install\n";
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true, read: () => text });
    expect(getConfig(values, "afk.default_runner")).toBe("codex");
    expect(readSetupCommands(values)).toEqual(["npm install"]);
  });

  it("strips quotes from sequence items", () => {
    const text = 'afk:\n  validation:\n    post_done:\n      - "npm run test -- --reporter=dot"\n';
    expect(parseConfigYaml(text)).toEqual({
      "afk.validation.post_done.0": "npm run test -- --reporter=dot",
    });
  });

  it("strips inline comment after closing quote on a sequence item", () => {
    const text = 'afk:\n  validation:\n    post_done:\n      - "npm run test" # full suite\n';
    expect(parseConfigYaml(text)).toEqual({ "afk.validation.post_done.0": "npm run test" });
  });

  it("throws on a top-level sequence with no enclosing mapping", () => {
    expect(() => parseConfigYaml("- npm test\n")).toThrow(MalformedConfigError);
  });

  it("readHitlTypeLabels reads the declared HUMAN-ONLY types in order", () => {
    const text =
      "plugins:\n  dev:\n    afk:\n      labels:\n        hitl_types:\n          - wayfinder:grilling\n          - wayfinder:prototype\n";
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true, read: () => text });
    expect(readHitlTypeLabels(values)).toEqual(["wayfinder:grilling", "wayfinder:prototype"]);
  });

  it("readHitlTypeLabels accepts a single-line scalar as a one-label list", () => {
    const text = "afk:\n  labels:\n    hitl_types: wayfinder:grilling\n";
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true, read: () => text });
    expect(readHitlTypeLabels(values)).toEqual(["wayfinder:grilling"]);
  });

  it("readHitlTypeLabels returns [] when the repo declares no HUMAN-ONLY type", () => {
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true, read: () => "afk:\n  default_runner: codex\n" });
    expect(readHitlTypeLabels(values)).toEqual([]);
  });
});

describe("config — validation moments (ADR 0135, #3284)", () => {
  it("reads the generated-surface cure beside the Validation moments", () => {
    const values = loadConfig("/x/.red/config.yaml", {
      read: () => [
        "plugins:",
        "  dev:",
        "    enabled: true",
        "    afk:",
        "      validation:",
        "        generated:",
        "          paths:",
        "            - packaging/pi/**",
        "            - plugins/*/package.json",
        "          command: pnpm generate-manifests && pnpm pi:packages:build",
        "        post_done:",
        "          - pnpm test",
        "",
      ].join("\n"),
    });

    expect(readValidationMoments(values)).toEqual({
      generated: {
        paths: ["packaging/pi/**", "plugins/*/package.json"],
        command: "pnpm generate-manifests && pnpm pi:packages:build",
      },
      post_done: ["pnpm test"],
    });
  });

  it("rejects incomplete generated-surface declarations", () => {
    expect(() => parseConfigYaml(
      "plugins:\n  dev:\n    afk:\n      validation:\n        generated:\n          paths:\n            - packaging/pi/**\n",
    )).toThrow(/afk\.validation\.generated\.command.*non-empty string/);
    expect(() => parseConfigYaml(
      "plugins:\n  dev:\n    afk:\n      validation:\n        generated:\n          command: pnpm generate-manifests\n",
    )).toThrow(/afk\.validation\.generated\.paths.*non-empty ordered list/);
  });

  it("reads the declared sub-second branch-fault escape beside the moments", () => {
    const values = loadConfig("/x/.red/config.yaml", {
      read: () => [
        "plugins:",
        "  dev:",
        "    enabled: true",
        "    afk:",
        "      validation:",
        "        subsecond_failures_are_branch_fault: true",
        "        post_done:",
        "          - pnpm test",
        "",
      ].join("\n"),
    });

    expect(readValidationMoments(values)).toEqual({
      subsecondFailuresAreBranchFault: true,
      post_done: ["pnpm test"],
    });
  });

  it("rejects a non-boolean sub-second declaration", () => {
    expect(() => parseConfigYaml(
      "plugins:\n  dev:\n    afk:\n      validation:\n        subsecond_failures_are_branch_fault: sometimes\n",
    )).toThrow(/subsecond_failures_are_branch_fault.*boolean/);
  });

  it("reads every declared moment in command order", () => {
    const text = [
      "plugins:",
      "  dev:",
      "    enabled: true",
      "    afk:",
      "      validation:",
      "        iteration:",
      "          - pnpm --filter @reddb-io/dev test -- config.test.ts",
      "          - pnpm --filter @reddb-io/dev typecheck",
      "        post_done:",
      "          - pnpm --filter @reddb-io/dev test",
      "        landing:",
      "          - pnpm --filter @reddb-io/dev build",
      "",
    ].join("\n");
    const values = loadConfig("/x/.red/config.yaml", { read: () => text });

    expect(readValidationMoments(values)).toEqual({
      iteration: [
        "pnpm --filter @reddb-io/dev test -- config.test.ts",
        "pnpm --filter @reddb-io/dev typecheck",
      ],
      post_done: ["pnpm --filter @reddb-io/dev test"],
      landing: ["pnpm --filter @reddb-io/dev build"],
    });
  });

  it("rejects a non-list moment and names the offending key", () => {
    expect(() =>
      parseConfigYaml(
        "plugins:\n  dev:\n    afk:\n      validation:\n        iteration: pnpm test\n",
      ),
    ).toThrow(/afk\.validation\.iteration.*ordered list/);
    expect(() =>
      parseConfigYaml(
        "plugins:\n  dev:\n    afk:\n      validation:\n        iteration:\n",
      ),
    ).toThrow(/afk\.validation\.iteration.*ordered list/);
  });

  it("preserves every declared command string verbatim", () => {
    const values = loadConfig("/x/.red/config.yaml", {
      ignoreActivationGate: true,
      read: () => 'afk:\n  validation:\n    iteration:\n      - "   "\n      - echo ok\n',
    });

    expect(readValidationMoments(values)).toEqual({ iteration: ["   ", "echo ok"] });
  });

  it("names both retired legacy knobs as RETIRED and reads them into no moment", () => {
    const warnings: string[] = [];
    const text = [
      "plugins:",
      "  dev:",
      "    enabled: true",
      "    afk:",
      "      feedback:",
      "        commands:",
      "          - pnpm test",
      "      backpressure:",
      "        - pnpm lint",
      "",
    ].join("\n");
    const values = loadConfig("/x/.red/config.yaml", {
      read: () => text,
      warn: (warning) => warnings.push(warning),
    });

    expect(readValidationMoments(values)).toEqual({});
    const joined = warnings.join("\n");
    expect(joined).toContain("RETIRED");
    expect(joined).toContain("afk.feedback.commands");
    expect(joined).toContain("afk.backpressure");
  });

});

describe("config — declared AFK worktree setup (#3268)", () => {
  it("reads namespaced setup commands in declaration order", () => {
    const text =
      "plugins:\n  dev:\n    enabled: true\n    afk:\n      setup:\n        - corepack enable\n        - LEFTHOOK=0 pnpm install --frozen-lockfile\n";
    const values = loadConfig("/x/.red/config.yaml", { read: () => text });

    expect(readSetupCommands(values)).toEqual([
      "corepack enable",
      "LEFTHOOK=0 pnpm install --frozen-lockfile",
    ]);
  });

  it("keeps the legacy scalar fallback and treats absence as undeclared", () => {
    const legacy = loadConfig("/x/.red/config.yaml", {
      ignoreActivationGate: true,
      read: () => "afk:\n  setup: bun install\n",
    });

    expect(readSetupCommands(legacy)).toEqual(["bun install"]);
    expect(readSetupCommands(loadConfig("/missing", { read: () => undefined }))).toEqual([]);
  });
});

describe("config — literal block scalars (#1998)", () => {
  it("honors `|` and `|-` newline semantics on mapping values", () => {
    const text = [
      "afk:",
      "  keep: |",
      "    first",
      "    second",
      "  strip: |-",
      "    third",
      "    fourth",
      "",
    ].join("\n");
    expect(parseConfigYaml(text)).toEqual({
      "afk.keep": "first\nsecond\n",
      "afk.strip": "third\nfourth",
    });
  });

  it("parses literal block sequence items without dropping siblings or following keys", () => {
    const text = [
      "dev:",
      "  trunk: develop",
      "plugins:",
      "  dev:",
      "    enabled: true",
      "    afk:",
      "      validation:",
      "        post_done:",
      "          - |",
      "            set -euo pipefail",
      "            pnpm --filter @reddb-io/dev test -- config.test.ts",
      "",
      "            if [ -f package.json ]; then",
      "              pnpm --filter @reddb-io/dev typecheck",
      "            fi",
      "          - |-",
      "            pnpm --filter @reddb-io/dev build",
      "      merge:",
      "        wait_for_review: true",
      "rsp:",
      "  enabled: true",
      "",
    ].join("\n");
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true, read: () => text });
    expect(getConfig(values, "dev.trunk")).toBe("develop");
    expect(getConfig(values, "plugins.dev.enabled")).toBe("true");
    expect(readValidationMoments(values).post_done).toEqual([
      [
        "set -euo pipefail",
        "pnpm --filter @reddb-io/dev test -- config.test.ts",
        "",
        "if [ -f package.json ]; then",
        "  pnpm --filter @reddb-io/dev typecheck",
        "fi",
        "",
      ].join("\n"),
      "pnpm --filter @reddb-io/dev build",
    ]);
    expect(getConfig(values, "afk.merge.wait_for_review")).toBe("true");
    expect(getConfig(values, "rsp.enabled")).toBe("true");
  });

  it("fails loudly on unsupported folded block scalars", () => {
    expect(() => parseConfigYaml("afk:\n  script: >\n    echo nope\n")).toThrow(
      /line 2: unsupported folded block scalar/,
    );
    expect(() => parseConfigYaml("afk:\n  setup:\n    - >\n      echo nope\n")).toThrow(
      /line 3: unsupported folded block scalar/,
    );
  });

  it("loader warning names the unsupported folded block scalar construct", () => {
    const warnings: string[] = [];
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true,
      read: () => "afk:\n  script: >\n    echo nope\n",
      warn: (m) => warnings.push(m),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("line 2");
    expect(warnings[0]).toContain("unsupported folded block scalar");
    expect(getConfig(values, "afk.default_runner")).toBe("claude");
  });
});

describe("config — afk.merge.wait_for_review (ADR 0048)", () => {
  it("defaults to false (merge-without-advice) with CodeRabbit as the review check", () => {
    const values = loadConfig("/nonexistent/.red/config.yaml", { ignoreActivationGate: true, warn: () => {} });
    expect(getConfig(values, "afk.merge.wait_for_review")).toBe("false");
    expect(getConfig(values, "afk.merge.review_check")).toBe("CodeRabbit");
  });

  it("reads the namespaced plugins.dev.afk.merge.* block", () => {
    const text =
      "plugins:\n  dev:\n    afk:\n      merge:\n        wait_for_review: true\n        review_check: my-reviewer\n";
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true, read: () => text });
    expect(getConfig(values, "afk.merge.wait_for_review")).toBe("true");
    expect(getConfig(values, "afk.merge.review_check")).toBe("my-reviewer");
  });

  it("reads the legacy top-level afk.merge.* block (back-compat)", () => {
    const text = "afk:\n  merge:\n    wait_for_review: true\n";
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true, read: () => text });
    expect(getConfig(values, "afk.merge.wait_for_review")).toBe("true");
    // review_check keeps its default when unset.
    expect(getConfig(values, "afk.merge.review_check")).toBe("CodeRabbit");
  });
});

describe("config — resolveCiTimeoutSeconds (RED_AFK_MERGE_CI_TIMEOUT_S, #812)", () => {
  it("defaults to 1800s when the env var is unset", () => {
    expect(resolveCiTimeoutSeconds({})).toBe(DEFAULT_MERGE_CI_TIMEOUT_S);
    expect(DEFAULT_MERGE_CI_TIMEOUT_S).toBe(1800);
  });

  it("reads a positive integer override", () => {
    expect(resolveCiTimeoutSeconds({ RED_AFK_MERGE_CI_TIMEOUT_S: "300" })).toBe(300);
  });

  it("falls back to the default on a non-positive / unparseable value", () => {
    expect(resolveCiTimeoutSeconds({ RED_AFK_MERGE_CI_TIMEOUT_S: "0" })).toBe(DEFAULT_MERGE_CI_TIMEOUT_S);
    expect(resolveCiTimeoutSeconds({ RED_AFK_MERGE_CI_TIMEOUT_S: "-5" })).toBe(DEFAULT_MERGE_CI_TIMEOUT_S);
    expect(resolveCiTimeoutSeconds({ RED_AFK_MERGE_CI_TIMEOUT_S: "abc" })).toBe(DEFAULT_MERGE_CI_TIMEOUT_S);
  });
});

describe("config — afk.merge.ci_aware (#812)", () => {
  it("defaults to false (admin-merge immediately)", () => {
    const values = loadConfig("/nonexistent/.red/config.yaml", { ignoreActivationGate: true, warn: () => {} });
    expect(getConfig(values, "afk.merge.ci_aware")).toBe("false");
  });

  it("reads the namespaced plugins.dev.afk.merge.ci_aware block", () => {
    const text = "plugins:\n  dev:\n    afk:\n      merge:\n        ci_aware: true\n";
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true, read: () => text });
    expect(getConfig(values, "afk.merge.ci_aware")).toBe("true");
  });
});

describe("config — afk.landing.wait (#2427)", () => {
  it("defaults to merge so existing landing semantics do not move", () => {
    const values = loadConfig("/missing/config.yaml", { read: () => undefined });
    expect(getConfig(values, "afk.landing.wait")).toBe("merge");
  });

  it.each(["merge", "ci", "none"])(
    "reads the namespaced landing wait value %s",
    (wait) => {
      const text =
        "plugins:\n  dev:\n    enabled: true\n    afk:\n      landing:\n" +
        `        wait: ${wait}\n`;
      const values = loadConfig("/repo/.red/config.yaml", { read: () => text });
      expect(getConfig(values, "afk.landing.wait")).toBe(wait);
    },
  );
});

describe("config — afk.worktree_launches_pull_request (ADR 0030 amended, #842)", () => {
  it("defaults to true (admin-PR landing) when unset", () => {
    const values = loadConfig("/nonexistent/.red/config.yaml", { ignoreActivationGate: true, warn: () => {} });
    expect(getConfig(values, "afk.worktree_launches_pull_request")).toBe("true");
  });

  it("reads the namespaced plugins.dev.afk.* block", () => {
    const text = "plugins:\n  dev:\n    afk:\n      worktree_launches_pull_request: false\n";
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true, read: () => text });
    expect(getConfig(values, "afk.worktree_launches_pull_request")).toBe("false");
  });

  it("reads the legacy top-level afk.* block (back-compat)", () => {
    const text = "afk:\n  worktree_launches_pull_request: false\n";
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true, read: () => text });
    expect(getConfig(values, "afk.worktree_launches_pull_request")).toBe("false");
  });

  it("lets the namespaced location win over a legacy top-level key", () => {
    const text =
      "afk:\n  worktree_launches_pull_request: false\n" +
      "plugins:\n  dev:\n    afk:\n      worktree_launches_pull_request: true\n";
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true, read: () => text });
    expect(getConfig(values, "afk.worktree_launches_pull_request")).toBe("true");
  });
});

describe("config — AFK model tier table (ADR 0049)", () => {
  it("defaults the unclassified AFK tier to think per runner", () => {
    const values = loadConfig("/nonexistent/.red/config.yaml", { ignoreActivationGate: true, warn: () => {} });
    expect(resolveTier(values, "claude")).toEqual({ model: "claude-opus-4-8", effort: "high" });
    expect(resolveTier(values, "codex")).toEqual({ model: "gpt-5.5", effort: "high" });
  });

  it("lets RED_AFK_MODEL / RED_AFK_EFFORT override every tier (flag pre-sets the env)", () => {
    const values = loadConfig("/nonexistent/.red/config.yaml", { ignoreActivationGate: true, warn: () => {} });
    // Override flattens all tiers onto one slug, beating the config/default table.
    expect(resolveTier(values, "opencode", "simple", { RED_AFK_MODEL: "minimax/MiniMax-M2" })).toEqual({
      model: "minimax/MiniMax-M2",
      effort: "high",
    });
    expect(
      resolveTier(values, "opencode", "validate", { RED_AFK_MODEL: "minimax/MiniMax-M2", RED_AFK_EFFORT: "high" }),
    ).toEqual({ model: "minimax/MiniMax-M2", effort: "high" });
    // An empty override is treated as unset — config/default stays in charge.
    expect(resolveTier(values, "opencode", "simple", { RED_AFK_MODEL: "" })).toEqual({
      model: "openrouter/anthropic/claude-sonnet-4",
      effort: "high",
    });
    // No env arg (e.g. the interactive model-tier route) → never overridden.
    expect(resolveTier(values, "opencode", "simple")).toEqual({
      model: "openrouter/anthropic/claude-sonnet-4",
      effort: "high",
    });
  });

  it("downgrades one model-policy tier when RED_AFK_TASK_TIER_DOWNGRADE is set", () => {
    const values = loadConfig("/nonexistent/.red/config.yaml", { ignoreActivationGate: true, warn: () => {} });
    expect(downgradeAfkModelTier("think")).toBe("complex");
    expect(downgradeAfkModelTier("complex")).toBe("simple");
    expect(downgradeAfkModelTier("simple")).toBe("validate");
    expect(downgradeAfkModelTier("validate")).toBe("validate");
    expect(resolveTier(values, "claude", "think", { RED_AFK_TASK_TIER_DOWNGRADE: "1" })).toEqual({
      model: "claude-opus-4-8",
      effort: "medium",
    });
    expect(resolveTier(values, "claude", "simple", { RED_AFK_TASK_TIER_DOWNGRADE: "1" })).toEqual({
      model: "claude-haiku-4-5",
      effort: "low",
    });
  });

  it("resolves every Claude tier from the default table", () => {
    const values = loadConfig("/nonexistent/.red/config.yaml", { ignoreActivationGate: true, warn: () => {} });
    expect(resolveTier(values, "claude", "validate")).toEqual({ model: "claude-haiku-4-5", effort: "low" });
    expect(resolveTier(values, "claude", "simple")).toEqual({ model: "claude-sonnet-4-6", effort: "high" });
    expect(resolveTier(values, "claude", "complex")).toEqual({ model: "claude-opus-4-8", effort: "medium" });
    expect(resolveTier(values, "claude", "think")).toEqual({ model: "claude-opus-4-8", effort: "high" });
  });

  it("resolves every Codex tier from the default gpt-5.x table", () => {
    const values = loadConfig("/nonexistent/.red/config.yaml", { ignoreActivationGate: true, warn: () => {} });
    expect(resolveTier(values, "codex", "validate")).toEqual({ model: "gpt-5.5", effort: "low" });
    expect(resolveTier(values, "codex", "simple")).toEqual({ model: "gpt-5.5", effort: "high" });
    expect(resolveTier(values, "codex", "complex")).toEqual({ model: "gpt-5.5", effort: "medium" });
    expect(resolveTier(values, "codex", "think")).toEqual({ model: "gpt-5.5", effort: "high" });
  });

  it("resolves every OpenCode tier from the default openrouter table (ADR 0059)", () => {
    const values = loadConfig("/nonexistent/.red/config.yaml", { ignoreActivationGate: true, warn: () => {} });
    expect(resolveTier(values, "opencode", "validate")).toEqual({
      model: "openrouter/anthropic/claude-3.5-haiku",
      effort: "low",
    });
    expect(resolveTier(values, "opencode", "simple")).toEqual({
      model: "openrouter/anthropic/claude-sonnet-4",
      effort: "high",
    });
    expect(resolveTier(values, "opencode", "complex")).toEqual({
      model: "openrouter/anthropic/claude-opus-4",
      effort: "medium",
    });
    expect(resolveTier(values, "opencode", "think")).toEqual({
      model: "openrouter/anthropic/claude-opus-4",
      effort: "high",
    });
  });

  it("resolves every claude-minimax tier to MiniMax-M3/low from the default table (#792)", () => {
    const values = loadConfig("/nonexistent/.red/config.yaml", { ignoreActivationGate: true, warn: () => {} });
    expect(resolveTier(values, "claude-minimax", "validate")).toEqual({ model: "MiniMax-M3", effort: "low" });
    expect(resolveTier(values, "claude-minimax", "simple")).toEqual({ model: "MiniMax-M3", effort: "low" });
    expect(resolveTier(values, "claude-minimax", "complex")).toEqual({ model: "MiniMax-M3", effort: "low" });
    expect(resolveTier(values, "claude-minimax", "think")).toEqual({ model: "MiniMax-M3", effort: "low" });
  });

  it("RED_AFK_MODEL still overrides the claude-minimax tier table (#792)", () => {
    const values = loadConfig("/nonexistent/.red/config.yaml", { ignoreActivationGate: true, warn: () => {} });
    expect(resolveTier(values, "claude-minimax", "think", { RED_AFK_MODEL: "MiniMax-M3-Custom" })).toEqual({
      model: "MiniMax-M3-Custom",
      effort: "low",
    });
  });

  it("claude-minimax does not bleed into the claude table — runners stay isolated (#792)", () => {
    const values = loadConfig("/nonexistent/.red/config.yaml", { ignoreActivationGate: true, warn: () => {} });
    expect(resolveTier(values, "claude", "simple")).toEqual({ model: "claude-sonnet-4-6", effort: "high" });
    expect(resolveTier(values, "claude-minimax", "simple")).toEqual({ model: "MiniMax-M3", effort: "low" });
  });

  it("honours an overridden opencode tier under plugins.dev.afk.models.opencode.*", () => {
    const text =
      "plugins:\n  dev:\n    afk:\n      models:\n        opencode:\n          simple:\n            model: openrouter/openai/gpt-4o-mini\n            effort: medium\n";
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true, read: () => text });
    expect(resolveTier(values, "opencode", "simple")).toEqual({
      model: "openrouter/openai/gpt-4o-mini",
      effort: "medium",
    });
  });

  it("auto-populates every tier from `base`, with a specialized tier overriding it", () => {
    const text =
      "plugins:\n  dev:\n    afk:\n      models:\n        opencode:\n          base:\n            model: minimax/MiniMax-M2\n            effort: medium\n          think:\n            model: minimax/MiniMax-M2-thinking\n";
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true, read: () => text });
    // base flows to every un-specialized tier (model AND effort)
    expect(resolveTier(values, "opencode", "validate")).toEqual({ model: "minimax/MiniMax-M2", effort: "medium" });
    expect(resolveTier(values, "opencode", "simple")).toEqual({ model: "minimax/MiniMax-M2", effort: "medium" });
    expect(resolveTier(values, "opencode", "complex")).toEqual({ model: "minimax/MiniMax-M2", effort: "medium" });
    // a specialized tier overrides the base model; its effort still inherits from base
    expect(resolveTier(values, "opencode", "think")).toEqual({ model: "minimax/MiniMax-M2-thinking", effort: "medium" });
    // base does not leak across runners — claude keeps its own table
    expect(resolveTier(values, "claude", "simple")).toEqual({ model: "claude-sonnet-4-6", effort: "high" });
  });

  it("`base.model` alone uniformly sets the model but leaves each tier's default effort", () => {
    const text =
      "plugins:\n  dev:\n    afk:\n      models:\n        opencode:\n          base:\n            model: minimax/MiniMax-M2\n";
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true, read: () => text });
    // model is uniform from base; effort stays at each tier's table default (low/high/medium/high)
    expect(resolveTier(values, "opencode", "validate")).toEqual({ model: "minimax/MiniMax-M2", effort: "low" });
    expect(resolveTier(values, "opencode", "complex")).toEqual({ model: "minimax/MiniMax-M2", effort: "medium" });
    expect(resolveTier(values, "opencode", "think")).toEqual({ model: "minimax/MiniMax-M2", effort: "high" });
  });

  it("lets explicit tier entries override legacy scalar model keys", () => {
    const text =
      "afk:\n  model: shared-model\n  models:\n    claude:\n      think:\n        model: claude-tier-model\n        effort: max\n";
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true, read: () => text });
    expect(resolveTier(values, "claude", "think")).toEqual({ model: "claude-tier-model", effort: "max" });
  });

  it("an explicit tier pin equal to the default beats a stale legacy scalar (bug #583)", () => {
    // simple tier default = claude-sonnet-4-6; legacy afk.model = custom-model.
    // An explicit simple.model = claude-sonnet-4-6 (same as the default) must
    // still win — the old tierModel !== defaultModel guard silently dropped it.
    const text = "afk:\n  model: custom-model\n  models:\n    claude:\n      simple:\n        model: claude-sonnet-4-6\n";
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true, read: () => text });
    expect(resolveTier(values, "claude", "simple")).toEqual({ model: "claude-sonnet-4-6", effort: "high" });
  });

  it("an explicit tier effort pin equal to the default beats a base effort override (bug #583)", () => {
    // validate tier default effort = low; base effort = medium.
    // An explicit validate.effort = low (same as the default) must still win.
    const text =
      "plugins:\n  dev:\n    afk:\n      models:\n        claude:\n          base:\n            effort: medium\n          validate:\n            effort: low\n";
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true, read: () => text });
    expect(resolveTier(values, "claude", "validate")).toEqual({ model: "claude-haiku-4-5", effort: "low" });
  });

  it("falls back to legacy per-runner and global scalar model keys", () => {
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true,
      read: () => "afk:\n  model: shared-model\n  models:\n    codex: gpt-custom\n",
    });
    expect(resolveTier(values, "codex", "think")).toEqual({ model: "gpt-custom", effort: "high" });
    expect(resolveTier(values, "claude", "think")).toEqual({ model: "shared-model", effort: "high" });
  });

  it("lets the namespaced plugins.dev tier table win over the legacy top-level table", () => {
    const text =
      "afk:\n  models:\n    claude:\n      think:\n        model: legacy-tier\n        effort: low\nplugins:\n  dev:\n    afk:\n      models:\n        claude:\n          think:\n            model: namespaced-tier\n            effort: high\n";
    const values = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true, read: () => text });
    expect(resolveTier(values, "claude", "think")).toEqual({ model: "namespaced-tier", effort: "high" });
  });
});

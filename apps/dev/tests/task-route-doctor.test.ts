import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { effectiveTaskRoutesForDoctor } from "../src/commands/red-doctor.js";

describe("red-doctor effective task routes", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("reports effective origins and file values shadowed by runtime overrides", () => {
    const root = mkdtempSync(join(tmpdir(), "task-route-doctor-"));
    roots.push(root);
    mkdirSync(join(root, ".red"));
    writeFileSync(join(root, ".red", "config.yaml"), [
      "plugins:",
      "  dev:",
      "    enabled: true",
      "    afk:",
      "      routes:",
      "        validate:",
      "          runner: codex",
      "          model: file-model",
      "          effort: medium",
      "",
    ].join("\n"));

    const routes = effectiveTaskRoutesForDoctor(root, {
      RED_AFK_RUNNER: "claude",
      RED_AFK_MODEL: "runtime-model",
      RED_AFK_EFFORT: "high",
    });

    expect(routes[0]).toMatchObject({
      route: {
        taskClass: "validate",
        runner: "claude",
        model: "runtime-model",
        effort: "high",
        origins: { runner: "env", model: "env", effort: "env" },
      },
      overriddenFileKeys: [
        "afk.routes.validate.runner",
        "afk.routes.validate.model",
        "afk.routes.validate.effort",
      ],
    });
  });
});

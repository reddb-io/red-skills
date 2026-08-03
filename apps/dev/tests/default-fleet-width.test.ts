// Every surface announces the same default width (#3100, ADR 0132 decision 7).
//
// The value is not the decision; the EQUALITY is. Before this test the number
// lived in three places that disagreed — the MCP `project_start` schema said
// `2`, `CONFIG_DEFAULTS` said `"2"`, the configuration docs had no width row at
// all, and the maintainer's intent was `1`. Three surfaces announcing different
// numbers are three defaults, and the drift stays invisible until somebody
// counts running Workers.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FLEET_WIDTH,
  DEFAULT_FLEET_WIDTH_CONFIG,
  FLEET_WIDTH_CONFIG_KEY,
} from "@reddb-io/shared/default-fleet-width.js";
import { CONFIG_DEFAULTS } from "../src/core/config.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

describe("the default fleet width", () => {
  it("is one", () => {
    expect(DEFAULT_FLEET_WIDTH).toBe(1);
  });

  it("reaches CONFIG_DEFAULTS from the namer, not from a second literal", () => {
    expect(CONFIG_DEFAULTS[FLEET_WIDTH_CONFIG_KEY as keyof typeof CONFIG_DEFAULTS])
      .toBe(DEFAULT_FLEET_WIDTH_CONFIG);
  });

  it("is the MCP project_start schema default", () => {
    // Read as source rather than invoked: the assertion is that the schema
    // names the shared constant, which is what stops it drifting — a runtime
    // check would pass just as well against a hardcoded 1 that later becomes 2.
    const schema = readFileSync(
      join(REPO_ROOT, "packages/red-castle/src/mcp/project.ts"),
      "utf8",
    );
    expect(schema).toContain("default(DEFAULT_FLEET_WIDTH)");
    expect(schema).not.toMatch(/target:\s*z\.number\(\)[^\n]*\.default\(\d+\)/);
  });

  it("is documented where an operator looks", () => {
    const docs = readFileSync(
      join(REPO_ROOT, "plugins/dev/skills/engineering/afk/docs/CONFIG.md"),
      "utf8",
    );
    expect(docs).toContain(`\`${FLEET_WIDTH_CONFIG_KEY}\``);
    // The documented value must be the real one, not a number someone typed.
    const row = docs.split("\n").find((l) => l.includes(`\`${FLEET_WIDTH_CONFIG_KEY}\``));
    expect(row).toContain(`\`${DEFAULT_FLEET_WIDTH}\``);
  });

  it("keeps the published mirror in step", () => {
    const mirror = readFileSync(
      join(REPO_ROOT, "packaging/pi/dev/skills/engineering/afk/docs/CONFIG.md"),
      "utf8",
    );
    expect(mirror).toContain(`\`${FLEET_WIDTH_CONFIG_KEY}\``);
  });
});

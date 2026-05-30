import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import fg from "fast-glob";
import { describe, expect, test } from "vitest";
import { INTEGRATION_TESTS } from "../vitest.suites.js";

// #242: the plugins/memory suite is split into a fast, deterministic default
// `test` gate (the AFK feedback loop) and a heavier `test:integration` project
// for the process-spawning / latency-budget tests that flake under CPU load.
// This guard enforces the contract behind that split.

const pkgRoot = resolve(__dirname, "..");

async function packageScripts(): Promise<Record<string, string>> {
  const raw = await readFile(resolve(pkgRoot, "package.json"), "utf8");
  return (JSON.parse(raw).scripts ?? {}) as Record<string, string>;
}

async function allTestFiles(): Promise<string[]> {
  const entries = await fg("tests/**/*.test.ts", { cwd: pkgRoot });
  return entries.map((e) => e.replace(/^tests\//, "")).sort();
}

describe("plugins/memory suite split (#242)", () => {
  test("both test and test:integration scripts exist", async () => {
    const scripts = await packageScripts();
    expect(scripts.test, "default `test` gate").toBeTruthy();
    expect(scripts["test:integration"], "heavy integration suite").toBeTruthy();
  });

  test("the default gate does not run the integration project", async () => {
    const scripts = await packageScripts();
    // The default `test` must use the default vitest config, never the
    // integration config — otherwise the load-sensitive suite is back in the
    // AFK gate.
    expect(scripts.test).not.toContain("vitest.integration.config");
    expect(scripts["test:integration"]).toContain("vitest.integration.config");
  });

  test("integration list and default project partition every test file", async () => {
    const files = await allTestFiles();
    const integration = new Set(INTEGRATION_TESTS);

    // No loss of coverage: every listed integration file must actually exist.
    for (const name of INTEGRATION_TESTS) {
      expect(files, `integration entry ${name} must exist on disk`).toContain(name);
    }

    // Disjoint + exhaustive: every test file lands in exactly one bucket.
    const unit = files.filter((f) => !integration.has(f));
    expect(unit.length + integration.size).toBe(files.length);
    // This guard itself is a fast in-process test → belongs to the default gate.
    expect(integration.has("suite-split.test.ts")).toBe(false);
  });

  test("no duplicate entries in the integration list", () => {
    expect(new Set(INTEGRATION_TESTS).size).toBe(INTEGRATION_TESTS.length);
  });
});

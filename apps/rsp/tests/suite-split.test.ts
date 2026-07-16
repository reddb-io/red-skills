import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { INTEGRATION_TESTS } from "../vitest.suites.js";

const pkgRoot = resolve(__dirname, "..");

async function packageScripts(): Promise<Record<string, string>> {
  const raw = await readFile(resolve(pkgRoot, "package.json"), "utf8");
  return (JSON.parse(raw).scripts ?? {}) as Record<string, string>;
}

async function allTestFiles(): Promise<string[]> {
  const entries = await readdir(resolve(pkgRoot, "tests"), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => entry.name)
    .sort();
}

describe("apps/rsp suite split (#1873)", () => {
  test("both test and test:integration scripts exist", async () => {
    const scripts = await packageScripts();
    expect(scripts.test, "default `test` gate").toBeTruthy();
    expect(scripts["test:integration"], "heavy integration suite").toBeTruthy();
  });

  test("the default gate does not run the integration project", async () => {
    const scripts = await packageScripts();
    expect(scripts.test).not.toContain("vitest.integration.config");
    expect(scripts["test:integration"]).toContain("vitest.integration.config");
  });

  test("integration list and default project partition every test file", async () => {
    const files = await allTestFiles();
    const integration = new Set(INTEGRATION_TESTS);

    for (const name of INTEGRATION_TESTS) {
      expect(files, `integration entry ${name} must exist on disk`).toContain(name);
    }

    const unit = files.filter((file) => !integration.has(file));
    expect(unit.length + integration.size).toBe(files.length);
    expect(integration.has("suite-split.test.ts")).toBe(false);
  });

  test("no duplicate entries in the integration list", () => {
    expect(new Set(INTEGRATION_TESTS).size).toBe(INTEGRATION_TESTS.length);
  });
});

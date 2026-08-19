import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveRedskilledPaths } from "../src/paths.js";
import { workerEvidenceRoot } from "../src/worker-evidence.js";
import { assertIsolatedHostIdentity } from "./support/test-host-isolation.js";

const SETUP_FILE = "./tests/support/test-host-isolation.ts";

describe("the redskilled test host", () => {
  it("is wired for every test file rather than relying on individual fixtures", () => {
    const config = readFileSync(join(import.meta.dirname, "..", "vitest.config.ts"), "utf8");

    expect(config).toContain(SETUP_FILE);
  });

  it("resolves every ambient host-owned path inside the sandbox", () => {
    const paths = resolveRedskilledPaths();

    expect(process.env.REDSKILLED_TEST_HOST_ROOT).toBeTruthy();
    const root = process.env.REDSKILLED_TEST_HOST_ROOT!;
    expect(homedir().startsWith(root)).toBe(true);
    expect(paths.runtimeDir.startsWith(root)).toBe(true);
    expect(paths.machineClaimPath.startsWith(root)).toBe(true);
    expect(paths.eventLanePath.startsWith(root)).toBe(true);
    expect(paths.registrationIntentPath.startsWith(root)).toBe(true);
    // The evidence lane is ambient too: admission defaults it from `homedir()`,
    // so a Worker dying inside a test must not write into the operator's own.
    expect(workerEvidenceRoot(homedir()).startsWith(root)).toBe(true);
  });

  it("refuses a test that restores host identity before making a mutation", () => {
    expect(() => assertIsolatedHostIdentity({ ...process.env, HOME: "/outside-the-test-sandbox" }))
      .toThrow(/HOME must remain pinned/);
  });
});
